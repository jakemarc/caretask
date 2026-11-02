// Expense reports API (2026-11-01, Jake's spec).
//
// Model: one expense report per clinician per period
// (usually a month). During the month the owner adds mileage
// entries (drives between patient homes) and non-mileage
// expense lines; the home↔home-office commute is entered as
// 'commute' mileage entries and deducted per day — daily
// reimbursable miles = max(0, driven that day − commute that
// day). The report stays editable while draft; the owner
// submits it for payment; a manager approves and marks it
// paid with the manager PIN (the override is attributed to
// the PIN's owner, same model as the staff/patient gates).
//
// Access: the caller must resolve to an active users row.
// Owners see and edit their own reports; manager/admin roles
// can list and read all reports (they run approval/payment).
// Writes to a report's contents are owner-only and
// draft-only. Event log: 'expense_change' events carry ids
// and status only — never addresses, amounts, or notes.
const express = require('express');
const pool = require('../db');
const { insertEvent } = require('../lib/eventLog');
const requireManagerPin = require('../lib/requireManagerPin');
const { routeLeg } = require('../lib/routing');

const router = express.Router();

function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

function sendErr(res, next, err) {
  if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
  return next(err);
}

async function resolveMe(db, req) {
  const r = await db.query(
    `SELECT * FROM users
      WHERE active = true
        AND (firebase_uid = $1 OR lower(email) = lower($2))
      ORDER BY (firebase_uid = $1) DESC
      LIMIT 1`,
    [req.user.uid, req.user.email],
  );
  if (!r.rows.length) {
    throw httpError(403, 'no active staff record for this sign-in', 'NO_STAFF_RECORD');
  }
  return r.rows[0];
}

const isManagerRole = (me) => me.role === 'manager' || me.role === 'admin';

// pg returns DATE columns as JS Date objects (UTC midnight);
// the dashboard speaks 'YYYY-MM-DD' strings.
function dateOnly(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function isDateStr(v) {
  return (
    typeof v === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    !Number.isNaN(Date.parse(v))
  );
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeReport(r) {
  if (!r) return r;
  return {
    ...r,
    id: Number(r.id),
    user_id: Number(r.user_id),
    agency_id: r.agency_id === null ? null : Number(r.agency_id),
    approved_by: r.approved_by === null ? null : Number(r.approved_by),
    period_start: dateOnly(r.period_start),
    period_end: dateOnly(r.period_end),
  };
}

function normalizeEntry(e) {
  if (!e) return e;
  return {
    ...e,
    id: Number(e.id),
    expense_report_id: Number(e.expense_report_id),
    appointment_id: e.appointment_id === null ? null : Number(e.appointment_id),
    entry_date: dateOnly(e.entry_date),
    miles_toll: e.miles_toll === null ? null : Number(e.miles_toll),
    miles_no_toll: e.miles_no_toll === null ? null : Number(e.miles_no_toll),
    business_miles: Number(e.business_miles),
    rate_per_mile: e.rate_per_mile === null ? null : Number(e.rate_per_mile),
  };
}

function normalizeExpense(x) {
  if (!x) return x;
  return {
    ...x,
    id: Number(x.id),
    report_id: Number(x.report_id),
    user_id: Number(x.user_id),
    agency_id: x.agency_id === null ? null : Number(x.agency_id),
    expense_date: dateOnly(x.expense_date),
  };
}

async function fetchReport(db, id) {
  const r = await db.query(
    `SELECT er.*, (u.lname || ', ' || u.fname) AS owner_name
       FROM expense_reports er
       JOIN users u ON u.id = er.user_id
      WHERE er.id = $1`,
    [id],
  );
  return r.rows.length ? normalizeReport(r.rows[0]) : null;
}

// Totals for one report: entries grouped by day with the
// commute deduction applied per day (floor zero), plus the
// non-mileage lines. Mileage dollars come only from entries
// carrying a rate snapshot; miles are always complete.
async function summarize(db, reportId) {
  const [entriesR, expensesR] = await Promise.all([
    db.query(
      `SELECT * FROM mileage_entries
        WHERE expense_report_id = $1 AND deleted_at IS NULL
        ORDER BY entry_date, seq, id`,
      [reportId],
    ),
    db.query(
      `SELECT * FROM expenses
        WHERE report_id = $1 AND deleted_at IS NULL
        ORDER BY expense_date, id`,
      [reportId],
    ),
  ]);
  const entries = entriesR.rows.map(normalizeEntry);
  const expenses = expensesR.rows.map(normalizeExpense);

  const byDate = new Map();
  for (const e of entries) {
    const day = byDate.get(e.entry_date) || {
      date: e.entry_date,
      driven_miles: 0,
      commute_miles: 0,
      entries: [],
    };
    if (e.entry_kind === 'commute') day.commute_miles += e.business_miles;
    else day.driven_miles += e.business_miles;
    day.entries.push(e);
    byDate.set(e.entry_date, day);
  }
  const days = [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((d) => ({
      ...d,
      driven_miles: Math.round(d.driven_miles * 100) / 100,
      commute_miles: Math.round(d.commute_miles * 100) / 100,
      reimbursable_miles:
        Math.round(Math.max(0, d.driven_miles - d.commute_miles) * 100) / 100,
    }));

  let mileageAmountCents = 0;
  for (const e of entries) {
    if (e.rate_per_mile === null) continue;
    if (e.entry_kind === 'commute') {
      mileageAmountCents -= Math.round(e.business_miles * e.rate_per_mile * 100);
    } else {
      mileageAmountCents += Math.round(e.business_miles * e.rate_per_mile * 100);
    }
  }
  // A day whose commute exceeds its driving can't claim
  // negative dollars either: recompute the amount floor per
  // day when every entry that day is rated (the common case
  // of one rate all month makes this exact).
  const allRated = entries.every((e) => e.rate_per_mile !== null);
  if (allRated && entries.length) {
    mileageAmountCents = 0;
    for (const d of days) {
      const rate = d.entries.find((e) => e.rate_per_mile !== null)?.rate_per_mile ?? 0;
      mileageAmountCents += Math.round(d.reimbursable_miles * rate * 100);
    }
  }

  const expensesCents = expenses.reduce((s, x) => s + x.amount_cents, 0);
  return {
    days,
    expenses,
    total_driven_miles: Math.round(days.reduce((s, d) => s + d.driven_miles, 0) * 100) / 100,
    total_commute_miles: Math.round(days.reduce((s, d) => s + d.commute_miles, 0) * 100) / 100,
    total_reimbursable_miles: Math.round(days.reduce((s, d) => s + d.reimbursable_miles, 0) * 100) / 100,
    mileage_amount_cents: mileageAmountCents,
    expenses_amount_cents: expensesCents,
    total_amount_cents: mileageAmountCents + expensesCents,
  };
}

async function loadOwnedDraft(req, res, next, { forWrite }) {
  const me = await resolveMe(pool, req);
  const report = await fetchReport(pool, req.params.id);
  if (!report || report.deleted_at) {
    throw httpError(404, 'expense report not found', 'REPORT_NOT_FOUND');
  }
  if (Number(report.user_id) !== Number(me.id)) {
    throw httpError(403, 'only the report owner can change it', 'FORBIDDEN');
  }
  if (forWrite && report.status !== 'draft') {
    throw httpError(409, 'this report is no longer a draft', 'REPORT_LOCKED');
  }
  return { me, report };
}

// ---------------- reports ----------------

router.get('/expense-reports', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const r = isManagerRole(me)
      ? await pool.query(
          `SELECT er.*, (u.lname || ', ' || u.fname) AS owner_name
             FROM expense_reports er JOIN users u ON u.id = er.user_id
            WHERE er.deleted_at IS NULL
            ORDER BY er.period_start DESC, er.id DESC`,
        )
      : await pool.query(
          `SELECT er.*, (u.lname || ', ' || u.fname) AS owner_name
             FROM expense_reports er JOIN users u ON u.id = er.user_id
            WHERE er.deleted_at IS NULL AND er.user_id = $1
            ORDER BY er.period_start DESC, er.id DESC`,
          [me.id],
        );
    res.json(r.rows.map(normalizeReport));
  } catch (err) {
    sendErr(res, next, err);
  }
});

router.post('/expense-reports', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const b = req.body || {};
    if (!isDateStr(b.period_start) || !isDateStr(b.period_end)) {
      throw httpError(400, 'period_start and period_end must be YYYY-MM-DD dates', 'PERIOD_REQUIRED');
    }
    if (b.period_end < b.period_start) {
      throw httpError(400, 'period_end is before period_start', 'PERIOD_INVALID');
    }
    const agencyId = numOrNull(b.agency_id);
    const r = await pool.query(
      `INSERT INTO expense_reports (user_id, agency_id, title, period_start, period_end, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [me.id, agencyId, b.title || null, b.period_start, b.period_end, b.notes || null],
    );
    const report = await fetchReport(pool, r.rows[0].id);
    await insertEvent(pool, {
      actor: req.user,
      event: 'expense_change',
      details: { action: 'report_create', report_id: report.id },
      ip: req.ip,
    });
    res.status(201).json({ report });
  } catch (err) {
    sendErr(res, next, err);
  }
});

router.get('/expense-reports/:id', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const report = await fetchReport(pool, req.params.id);
    if (!report || report.deleted_at) {
      throw httpError(404, 'expense report not found', 'REPORT_NOT_FOUND');
    }
    if (Number(report.user_id) !== Number(me.id) && !isManagerRole(me)) {
      throw httpError(404, 'expense report not found', 'REPORT_NOT_FOUND');
    }
    const summary = await summarize(pool, report.id);
    res.json({ report, ...summary });
  } catch (err) {
    sendErr(res, next, err);
  }
});

router.put('/expense-reports/:id', async (req, res, next) => {
  try {
    const { report } = await loadOwnedDraft(req, res, next, { forWrite: true });
    const b = req.body || {};
    const updates = {};
    if (b.title !== undefined) updates.title = b.title || null;
    if (b.notes !== undefined) updates.notes = b.notes || null;
    if (b.agency_id !== undefined) updates.agency_id = numOrNull(b.agency_id);
    if (b.period_start !== undefined || b.period_end !== undefined) {
      const start = b.period_start ?? report.period_start;
      const end = b.period_end ?? report.period_end;
      if (!isDateStr(start) || !isDateStr(end) || end < start) {
        throw httpError(400, 'invalid report period', 'PERIOD_INVALID');
      }
      updates.period_start = start;
      updates.period_end = end;
    }
    const keys = Object.keys(updates);
    if (keys.length) {
      const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      await pool.query(
        `UPDATE expense_reports SET ${sets} WHERE id = $1`,
        [report.id, ...keys.map((k) => updates[k])],
      );
    }
    res.json({ report: await fetchReport(pool, report.id) });
  } catch (err) {
    sendErr(res, next, err);
  }
});

router.delete('/expense-reports/:id', async (req, res, next) => {
  try {
    const { report } = await loadOwnedDraft(req, res, next, { forWrite: true });
    await pool.query('UPDATE expense_reports SET deleted_at = now() WHERE id = $1', [report.id]);
    await insertEvent(pool, {
      actor: req.user,
      event: 'expense_change',
      details: { action: 'report_delete', report_id: report.id },
      ip: req.ip,
    });
    res.json({ report: await fetchReport(pool, report.id) });
  } catch (err) {
    sendErr(res, next, err);
  }
});

// Owner submits a finished draft for payment.
router.post('/expense-reports/:id/submit', async (req, res, next) => {
  try {
    const { report } = await loadOwnedDraft(req, res, next, { forWrite: true });
    await pool.query(
      `UPDATE expense_reports SET status = 'submitted', submitted_at = now() WHERE id = $1`,
      [report.id],
    );
    await insertEvent(pool, {
      actor: req.user,
      event: 'expense_change',
      details: { action: 'report_submit', report_id: report.id },
      ip: req.ip,
    });
    res.json({ report: await fetchReport(pool, report.id) });
  } catch (err) {
    sendErr(res, next, err);
  }
});

// Manager steps — PIN-gated; the PIN owner is recorded.
router.post('/expense-reports/:id/approve', requireManagerPin, async (req, res, next) => {
  try {
    await resolveMe(pool, req);
    const report = await fetchReport(pool, req.params.id);
    if (!report || report.deleted_at) {
      throw httpError(404, 'expense report not found', 'REPORT_NOT_FOUND');
    }
    if (report.status !== 'submitted') {
      throw httpError(409, 'only a submitted report can be approved', 'REPORT_NOT_SUBMITTED');
    }
    await pool.query(
      `UPDATE expense_reports SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
      [report.id, req.manager.id],
    );
    await insertEvent(pool, {
      actor: req.user,
      event: 'expense_change',
      details: { action: 'report_approve', report_id: report.id, manager_id: req.manager.id },
      ip: req.ip,
    });
    res.json({ report: await fetchReport(pool, report.id) });
  } catch (err) {
    sendErr(res, next, err);
  }
});

router.post('/expense-reports/:id/reject', requireManagerPin, async (req, res, next) => {
  try {
    await resolveMe(pool, req);
    const report = await fetchReport(pool, req.params.id);
    if (!report || report.deleted_at) {
      throw httpError(404, 'expense report not found', 'REPORT_NOT_FOUND');
    }
    if (report.status !== 'submitted') {
      throw httpError(409, 'only a submitted report can be rejected', 'REPORT_NOT_SUBMITTED');
    }
    // Rejection returns the report to draft so the owner can fix it.
    await pool.query(
      `UPDATE expense_reports SET status = 'draft', submitted_at = NULL WHERE id = $1`,
      [report.id],
    );
    await insertEvent(pool, {
      actor: req.user,
      event: 'expense_change',
      details: { action: 'report_reject', report_id: report.id, manager_id: req.manager.id },
      ip: req.ip,
    });
    res.json({ report: await fetchReport(pool, report.id) });
  } catch (err) {
    sendErr(res, next, err);
  }
});

router.post('/expense-reports/:id/pay', requireManagerPin, async (req, res, next) => {
  try {
    await resolveMe(pool, req);
    const report = await fetchReport(pool, req.params.id);
    if (!report || report.deleted_at) {
      throw httpError(404, 'expense report not found', 'REPORT_NOT_FOUND');
    }
    if (report.status !== 'approved') {
      throw httpError(409, 'only an approved report can be marked paid', 'REPORT_NOT_APPROVED');
    }
    await pool.query(
      `UPDATE expense_reports SET status = 'paid', paid_at = now(), payment_ref = $2 WHERE id = $1`,
      [report.id, (req.body && req.body.payment_ref) || null],
    );
    await insertEvent(pool, {
      actor: req.user,
      event: 'expense_change',
      details: { action: 'report_pay', report_id: report.id, manager_id: req.manager.id },
      ip: req.ip,
    });
    res.json({ report: await fetchReport(pool, report.id) });
  } catch (err) {
    sendErr(res, next, err);
  }
});

// ---------------- mileage entries ----------------

function entryFromBody(b, existing) {
  const e = existing || {};
  const pick = (key, cur) => (b[key] !== undefined ? b[key] : cur);
  const out = {
    entry_date: pick('entry_date', e.entry_date),
    seq: pick('seq', e.seq ?? 0),
    entry_kind: pick('entry_kind', e.entry_kind ?? 'business'),
    start_address: pick('start_address', e.start_address ?? null),
    end_address: pick('end_address', e.end_address ?? null),
    start_lat: numOrNull(pick('start_lat', e.start_lat ?? null)),
    start_lng: numOrNull(pick('start_lng', e.start_lng ?? null)),
    end_lat: numOrNull(pick('end_lat', e.end_lat ?? null)),
    end_lng: numOrNull(pick('end_lng', e.end_lng ?? null)),
    appointment_id: numOrNull(pick('appointment_id', e.appointment_id ?? null)),
    miles_toll: numOrNull(pick('miles_toll', e.miles_toll ?? null)),
    miles_no_toll: numOrNull(pick('miles_no_toll', e.miles_no_toll ?? null)),
    used_tollway: Boolean(pick('used_tollway', e.used_tollway ?? false)),
    round_trip: Boolean(pick('round_trip', e.round_trip ?? false)),
    business_miles: numOrNull(pick('business_miles', e.business_miles)),
    rate_per_mile: numOrNull(pick('rate_per_mile', e.rate_per_mile ?? null)),
    vehicle: pick('vehicle', e.vehicle ?? null),
    notes: pick('notes', e.notes ?? null),
  };
  if (!isDateStr(out.entry_date)) {
    throw httpError(400, 'entry_date must be a YYYY-MM-DD date', 'ENTRY_DATE_INVALID');
  }
  if (out.entry_kind !== 'business' && out.entry_kind !== 'commute') {
    throw httpError(400, 'entry_kind must be business or commute', 'ENTRY_KIND_INVALID');
  }
  if (out.business_miles === null || out.business_miles < 0) {
    throw httpError(400, 'business_miles must be a number ≥ 0', 'ENTRY_MILES_INVALID');
  }
  return out;
}

const ENTRY_COLS = [
  'entry_date', 'seq', 'entry_kind', 'start_address', 'end_address',
  'start_lat', 'start_lng', 'end_lat', 'end_lng', 'appointment_id',
  'miles_toll', 'miles_no_toll', 'used_tollway', 'round_trip',
  'business_miles', 'rate_per_mile', 'vehicle', 'notes',
];

router.post('/expense-reports/:id/mileage', async (req, res, next) => {
  try {
    const { report } = await loadOwnedDraft(req, res, next, { forWrite: true });
    const v = entryFromBody(req.body || {});
    const cols = ['expense_report_id', ...ENTRY_COLS];
    const vals = [report.id, ...ENTRY_COLS.map((c) => v[c])];
    const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
    const r = await pool.query(
      `INSERT INTO mileage_entries (${cols.join(', ')}) VALUES (${ph}) RETURNING *`,
      vals,
    );
    await insertEvent(pool, {
      actor: req.user,
      event: 'expense_change',
      details: { action: 'mileage_add', report_id: report.id, entry_id: Number(r.rows[0].id) },
      ip: req.ip,
    });
    res.status(201).json({ entry: normalizeEntry(r.rows[0]) });
  } catch (err) {
    sendErr(res, next, err);
  }
});

async function loadEntry(req) {
  const r = await pool.query(
    'SELECT * FROM mileage_entries WHERE id = $1',
    [req.params.entryId],
  );
  if (!r.rows.length || r.rows[0].deleted_at) {
    throw httpError(404, 'mileage entry not found', 'ENTRY_NOT_FOUND');
  }
  return normalizeEntry(r.rows[0]);
}

router.put('/expense-reports/:id/mileage/:entryId', async (req, res, next) => {
  try {
    const { report } = await loadOwnedDraft(req, res, next, { forWrite: true });
    const existing = await loadEntry(req);
    if (Number(existing.expense_report_id) !== report.id) {
      throw httpError(404, 'mileage entry not found', 'ENTRY_NOT_FOUND');
    }
    const v = entryFromBody(req.body || {}, existing);
    const sets = ENTRY_COLS.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const r = await pool.query(
      `UPDATE mileage_entries SET ${sets} WHERE id = $1 RETURNING *`,
      [existing.id, ...ENTRY_COLS.map((c) => v[c])],
    );
    res.json({ entry: normalizeEntry(r.rows[0]) });
  } catch (err) {
    sendErr(res, next, err);
  }
});

router.delete('/expense-reports/:id/mileage/:entryId', async (req, res, next) => {
  try {
    const { report } = await loadOwnedDraft(req, res, next, { forWrite: true });
    const existing = await loadEntry(req);
    if (Number(existing.expense_report_id) !== report.id) {
      throw httpError(404, 'mileage entry not found', 'ENTRY_NOT_FOUND');
    }
    await pool.query('UPDATE mileage_entries SET deleted_at = now() WHERE id = $1', [existing.id]);
    await insertEvent(pool, {
      actor: req.user,
      event: 'expense_change',
      details: { action: 'mileage_delete', report_id: report.id, entry_id: existing.id },
      ip: req.ip,
    });
    res.json({ entry: { ...existing, deleted_at: new Date().toISOString() } });
  } catch (err) {
    sendErr(res, next, err);
  }
});

// ---------------- non-mileage expense lines ----------------

const CATEGORIES = [
  'mileage', 'parking', 'tolls', 'medical_supplies', 'office_supplies',
  'meals', 'travel', 'lodging', 'phone_internet', 'training',
  'licenses', 'other',
];

function expenseFromBody(b, existing) {
  const e = existing || {};
  const pick = (key, cur) => (b[key] !== undefined ? b[key] : cur);
  const out = {
    expense_date: pick('expense_date', e.expense_date),
    category: pick('category', e.category),
    description: pick('description', e.description ?? null),
    vendor_name: pick('vendor_name', e.vendor_name ?? null),
    amount_cents: pick('amount_cents', e.amount_cents),
    payment_method: pick('payment_method', e.payment_method ?? null),
    receipt_url: pick('receipt_url', e.receipt_url ?? null),
    agency_id: numOrNull(pick('agency_id', e.agency_id ?? null)),
    notes: pick('notes', e.notes ?? null),
  };
  if (!isDateStr(out.expense_date)) {
    throw httpError(400, 'expense_date must be a YYYY-MM-DD date', 'EXPENSE_DATE_INVALID');
  }
  if (!CATEGORIES.includes(out.category)) {
    throw httpError(400, 'unknown expense category', 'EXPENSE_CATEGORY_INVALID');
  }
  if (!Number.isInteger(out.amount_cents) || out.amount_cents < 0) {
    throw httpError(400, 'amount_cents must be an integer ≥ 0', 'EXPENSE_AMOUNT_INVALID');
  }
  return out;
}

const EXPENSE_COLS = [
  'expense_date', 'category', 'description', 'vendor_name',
  'amount_cents', 'payment_method', 'receipt_url', 'agency_id', 'notes',
];

router.post('/expense-reports/:id/expenses', async (req, res, next) => {
  try {
    const { me, report } = await loadOwnedDraft(req, res, next, { forWrite: true });
    const v = expenseFromBody(req.body || {});
    const cols = ['report_id', 'user_id', ...EXPENSE_COLS];
    const vals = [report.id, me.id, ...EXPENSE_COLS.map((c) => v[c])];
    const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
    const r = await pool.query(
      `INSERT INTO expenses (${cols.join(', ')}) VALUES (${ph}) RETURNING *`,
      vals,
    );
    res.status(201).json({ expense: normalizeExpense(r.rows[0]) });
  } catch (err) {
    sendErr(res, next, err);
  }
});

async function loadExpenseLine(req) {
  const r = await pool.query('SELECT * FROM expenses WHERE id = $1', [req.params.expenseId]);
  if (!r.rows.length || r.rows[0].deleted_at) {
    throw httpError(404, 'expense line not found', 'EXPENSE_NOT_FOUND');
  }
  return normalizeExpense(r.rows[0]);
}

router.put('/expense-reports/:id/expenses/:expenseId', async (req, res, next) => {
  try {
    const { report } = await loadOwnedDraft(req, res, next, { forWrite: true });
    const existing = await loadExpenseLine(req);
    if (Number(existing.report_id) !== report.id) {
      throw httpError(404, 'expense line not found', 'EXPENSE_NOT_FOUND');
    }
    const v = expenseFromBody(req.body || {}, existing);
    const sets = EXPENSE_COLS.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const r = await pool.query(
      `UPDATE expenses SET ${sets} WHERE id = $1 RETURNING *`,
      [existing.id, ...EXPENSE_COLS.map((c) => v[c])],
    );
    res.json({ expense: normalizeExpense(r.rows[0]) });
  } catch (err) {
    sendErr(res, next, err);
  }
});

router.delete('/expense-reports/:id/expenses/:expenseId', async (req, res, next) => {
  try {
    const { report } = await loadOwnedDraft(req, res, next, { forWrite: true });
    const existing = await loadExpenseLine(req);
    if (Number(existing.report_id) !== report.id) {
      throw httpError(404, 'expense line not found', 'EXPENSE_NOT_FOUND');
    }
    await pool.query('UPDATE expenses SET deleted_at = now() WHERE id = $1', [existing.id]);
    res.json({ expense: { ...existing, deleted_at: new Date().toISOString() } });
  } catch (err) {
    sendErr(res, next, err);
  }
});

// ---------------- routing ----------------

// POST /mileage/route { start_lat, start_lng, end_lat, end_lng }
// → { miles_toll, miles_no_toll } (either may be null when
// only one variant routed). Coordinates only — address text
// is geocoded by the client (autocomplete / GPS picks carry
// coordinates in this app).
router.post('/mileage/route', async (req, res, next) => {
  try {
    await resolveMe(pool, req);
    const b = req.body || {};
    const from = { lat: numOrNull(b.start_lat), lng: numOrNull(b.start_lng) };
    const to = { lat: numOrNull(b.end_lat), lng: numOrNull(b.end_lng) };
    if (from.lat === null || from.lng === null || to.lat === null || to.lng === null) {
      throw httpError(400, 'start and end coordinates are required', 'ROUTE_COORDS_REQUIRED');
    }
    const { milesToll, milesNoToll } = await routeLeg(from, to);
    res.json({
      miles_toll: milesToll === null ? null : Math.round(milesToll * 100) / 100,
      miles_no_toll: milesNoToll === null ? null : Math.round(milesNoToll * 100) / 100,
    });
  } catch (err) {
    if (err.code === 'ROUTE_FAILED') {
      return res.status(502).json({ error: err.message, code: err.code });
    }
    return sendErr(res, next, err);
  }
});

module.exports = router;
