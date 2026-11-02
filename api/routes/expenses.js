// Mileage + expense reporting API.
//
// 2026-11-02 SIMPLIFICATION (Jake): no approval process.
// Mileage is a per-clinician DAY LOG of legs (a chain), not
// lines inside a monthly report envelope:
//
// - A day's legs in seq order: 'commute' legs are the fixed
//   home<->office bookends (personal miles, never billed);
//   'business' legs are the billable chain (office -> patient
//   -> patient -> ... -> office). business_miles is the leg's
//   FINAL miles for both kinds; miles_toll / miles_no_toll
//   keep both routed figures and used_tollway says which one
//   the clinician actually drove (default tollway).
// - Each leg is owned (user_id), agency-tagged (agency_id),
//   and may link the patient it ends at (patient_id) — labels
//   and addresses ride along for display.
// - Reports are GENERATED from the log: GET /mileage/report
//   over any date range, optionally filtered by agency.
//   Billable dollars = sum over business legs carrying a rate
//   snapshot of miles x rate; personal legs never pay.
//
// The pre-2026-11-02 envelope model (expense_reports with a
// draft -> submitted -> approved -> paid lifecycle, mileage
// and expense lines inside a report) is retired: no create /
// lifecycle / line endpoints remain. The tables stay, and the
// two envelope reads below stay as LEGACY read-only history
// (they keep the old driven-minus-commute math that matches
// how those entries were recorded). Non-mileage expense
// lines are parked with the envelopes (data kept, no API).
//
// Access: the caller must resolve to an active users row.
// Legs are owner-written; managers/admins may READ another
// clinician's log and generated reports (user_id parameter).
// Event log: 'expense_change' events carry ids only — never
// addresses, amounts, or notes.
const express = require('express');
const pool = require('../db');
const { insertEvent } = require('../lib/eventLog');
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

const round2 = (n) => Math.round(n * 100) / 100;

// ---------------- normalization ----------------

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
    expense_report_id: e.expense_report_id === null ? null : Number(e.expense_report_id),
    user_id: e.user_id === null ? null : Number(e.user_id),
    agency_id: e.agency_id === null ? null : Number(e.agency_id),
    appointment_id: e.appointment_id === null ? null : Number(e.appointment_id),
    entry_date: dateOnly(e.entry_date),
    start_lat: e.start_lat === null ? null : Number(e.start_lat),
    start_lng: e.start_lng === null ? null : Number(e.start_lng),
    end_lat: e.end_lat === null ? null : Number(e.end_lat),
    end_lng: e.end_lng === null ? null : Number(e.end_lng),
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

// ---------------- shared query scoping ----------------

// Whose log is being read: the caller's own, unless a manager
// asks for another clinician's via ?user_id=.
async function scopeUserId(req, me) {
  const raw = req.query.user_id;
  if (raw === undefined) return Number(me.id);
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw httpError(400, 'user_id must be an integer', 'USER_ID_INVALID');
  }
  if (n !== Number(me.id) && !isManagerRole(me)) {
    throw httpError(403, "only managers can view another clinician's mileage", 'FORBIDDEN');
  }
  return n;
}

function rangeAndAgency(req) {
  const from = req.query.from;
  const to = req.query.to;
  if (from !== undefined && !isDateStr(from)) {
    throw httpError(400, 'from must be a YYYY-MM-DD date', 'RANGE_INVALID');
  }
  if (to !== undefined && !isDateStr(to)) {
    throw httpError(400, 'to must be a YYYY-MM-DD date', 'RANGE_INVALID');
  }
  let agencyId = null;
  if (req.query.agency_id !== undefined) {
    agencyId = Number(req.query.agency_id);
    if (!Number.isInteger(agencyId) || agencyId < 1) {
      throw httpError(400, 'agency_id must be a positive integer', 'AGENCY_ID_INVALID');
    }
  }
  return { from: from || null, to: to || null, agencyId };
}

async function fetchLegs(userId, { from, to, agencyId }) {
  const clauses = ['user_id = $1', 'deleted_at IS NULL'];
  const vals = [userId];
  if (from) { vals.push(from); clauses.push(`entry_date >= $${vals.length}`); }
  if (to) { vals.push(to); clauses.push(`entry_date <= $${vals.length}`); }
  if (agencyId) { vals.push(agencyId); clauses.push(`agency_id = $${vals.length}`); }
  const r = await pool.query(
    `SELECT * FROM mileage_entries
      WHERE ${clauses.join(' AND ')}
      ORDER BY entry_date, seq, id`,
    vals,
  );
  return r.rows.map(normalizeEntry);
}

// ---------------- mileage legs ----------------

function entryFromBody(b, existing) {
  const e = existing || {};
  const pick = (key, cur) => (b[key] !== undefined ? b[key] : cur);
  const coord = (key, cur) => numOrNull(pick(key, cur));
  const out = {
    entry_date: pick('entry_date', e.entry_date),
    seq: pick('seq', e.seq ?? 0),
    entry_kind: pick('entry_kind', e.entry_kind ?? 'business'),
    start_label: pick('start_label', e.start_label ?? null),
    start_address: pick('start_address', e.start_address ?? null),
    end_label: pick('end_label', e.end_label ?? null),
    end_address: pick('end_address', e.end_address ?? null),
    start_lat: coord('start_lat', e.start_lat ?? null),
    start_lng: coord('start_lng', e.start_lng ?? null),
    end_lat: coord('end_lat', e.end_lat ?? null),
    end_lng: coord('end_lng', e.end_lng ?? null),
    appointment_id: numOrNull(pick('appointment_id', e.appointment_id ?? null)),
    patient_id: pick('patient_id', e.patient_id ?? null),
    agency_id: numOrNull(pick('agency_id', e.agency_id ?? null)),
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
  if (!Number.isInteger(out.seq) || out.seq < 0) {
    throw httpError(400, 'seq must be an integer ≥ 0', 'ENTRY_SEQ_INVALID');
  }
  if (out.business_miles === null || out.business_miles < 0) {
    throw httpError(400, 'business_miles must be a number ≥ 0', 'ENTRY_MILES_INVALID');
  }
  for (const [k, v, lim] of [
    ['start_lat', out.start_lat, 90], ['end_lat', out.end_lat, 90],
    ['start_lng', out.start_lng, 180], ['end_lng', out.end_lng, 180],
  ]) {
    if (v !== null && Math.abs(v) > lim) {
      throw httpError(400, `${k} is out of range`, 'ENTRY_COORDS_INVALID');
    }
  }
  if (out.miles_toll !== null && out.miles_toll < 0) {
    throw httpError(400, 'miles_toll must be ≥ 0', 'ENTRY_MILES_INVALID');
  }
  if (out.miles_no_toll !== null && out.miles_no_toll < 0) {
    throw httpError(400, 'miles_no_toll must be ≥ 0', 'ENTRY_MILES_INVALID');
  }
  if (out.rate_per_mile !== null && out.rate_per_mile < 0) {
    throw httpError(400, 'rate_per_mile must be ≥ 0', 'ENTRY_RATE_INVALID');
  }
  return out;
}

async function validateRefs(v) {
  if (v.agency_id !== null) {
    const r = await pool.query('SELECT id FROM agencies WHERE id = $1', [v.agency_id]);
    if (!r.rows.length) throw httpError(400, 'agency not found', 'AGENCY_NOT_FOUND');
  }
  if (v.patient_id !== null) {
    const r = await pool.query(
      'SELECT id FROM patients WHERE id = $1 AND deleted_at IS NULL',
      [v.patient_id],
    );
    if (!r.rows.length) throw httpError(400, 'patient not found', 'PATIENT_NOT_FOUND');
  }
}

const ENTRY_COLS = [
  'entry_date', 'seq', 'entry_kind', 'start_label', 'start_address',
  'end_label', 'end_address', 'start_lat', 'start_lng', 'end_lat',
  'end_lng', 'appointment_id', 'patient_id', 'agency_id',
  'miles_toll', 'miles_no_toll', 'used_tollway', 'round_trip',
  'business_miles', 'rate_per_mile', 'vehicle', 'notes',
];

router.get('/mileage', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const userId = await scopeUserId(req, me);
    const legs = await fetchLegs(userId, rangeAndAgency(req));
    res.json({ user_id: userId, entries: legs });
  } catch (err) {
    sendErr(res, next, err);
  }
});

router.post('/mileage', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const v = entryFromBody(req.body || {});
    await validateRefs(v);
    const cols = ['user_id', ...ENTRY_COLS];
    const vals = [me.id, ...ENTRY_COLS.map((c) => v[c])];
    const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
    const r = await pool.query(
      `INSERT INTO mileage_entries (${cols.join(', ')}) VALUES (${ph}) RETURNING *`,
      vals,
    );
    await insertEvent(pool, {
      actor: req.user,
      event: 'expense_change',
      details: { action: 'mileage_create', entry_id: Number(r.rows[0].id) },
      ip: req.ip,
    });
    res.status(201).json({ entry: normalizeEntry(r.rows[0]) });
  } catch (err) {
    sendErr(res, next, err);
  }
});

async function loadOwnedLeg(req, me) {
  const r = await pool.query('SELECT * FROM mileage_entries WHERE id = $1', [req.params.id]);
  if (!r.rows.length || r.rows[0].deleted_at) {
    throw httpError(404, 'mileage entry not found', 'ENTRY_NOT_FOUND');
  }
  const leg = normalizeEntry(r.rows[0]);
  if (Number(leg.user_id) !== Number(me.id)) {
    throw httpError(403, 'only the owner can change this entry', 'FORBIDDEN');
  }
  return leg;
}

router.put('/mileage/:id', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const existing = await loadOwnedLeg(req, me);
    const v = entryFromBody(req.body || {}, existing);
    await validateRefs(v);
    const sets = ENTRY_COLS.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const r = await pool.query(
      `UPDATE mileage_entries SET ${sets} WHERE id = $1 RETURNING *`,
      [existing.id, ...ENTRY_COLS.map((c) => v[c])],
    );
    await insertEvent(pool, {
      actor: req.user,
      event: 'expense_change',
      details: { action: 'mileage_update', entry_id: existing.id },
      ip: req.ip,
    });
    res.json({ entry: normalizeEntry(r.rows[0]) });
  } catch (err) {
    sendErr(res, next, err);
  }
});

router.delete('/mileage/:id', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const existing = await loadOwnedLeg(req, me);
    await pool.query('UPDATE mileage_entries SET deleted_at = now() WHERE id = $1', [existing.id]);
    await insertEvent(pool, {
      actor: req.user,
      event: 'expense_change',
      details: { action: 'mileage_delete', entry_id: existing.id },
      ip: req.ip,
    });
    res.json({ entry: { ...existing, deleted_at: new Date().toISOString() } });
  } catch (err) {
    sendErr(res, next, err);
  }
});

// ---------------- generated report ----------------

// Chain-model day math: billable = business legs; personal =
// commute legs; dollars only from rated business legs.
function summarizeLegs(entries) {
  const byDate = new Map();
  for (const e of entries) {
    const day = byDate.get(e.entry_date) || {
      date: e.entry_date,
      legs: [],
      billable_miles: 0,
      personal_miles: 0,
      amount_cents: 0,
    };
    if (e.entry_kind === 'commute') {
      day.personal_miles += e.business_miles;
    } else {
      day.billable_miles += e.business_miles;
      if (e.rate_per_mile !== null) {
        day.amount_cents += Math.round(e.business_miles * e.rate_per_mile * 100);
      }
    }
    day.legs.push(e);
    byDate.set(e.entry_date, day);
  }
  const days = [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((d) => ({
      ...d,
      billable_miles: round2(d.billable_miles),
      personal_miles: round2(d.personal_miles),
      driven_miles: round2(d.billable_miles + d.personal_miles),
    }));
  return {
    days,
    total_billable_miles: round2(days.reduce((s, d) => s + d.billable_miles, 0)),
    total_personal_miles: round2(days.reduce((s, d) => s + d.personal_miles, 0)),
    total_driven_miles: round2(days.reduce((s, d) => s + d.driven_miles, 0)),
    total_amount_cents: days.reduce((s, d) => s + d.amount_cents, 0),
  };
}

router.get('/mileage/report', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const userId = await scopeUserId(req, me);
    const range = rangeAndAgency(req);
    if (!range.from || !range.to) {
      throw httpError(400, 'from and to are required for a report', 'RANGE_REQUIRED');
    }
    const legs = await fetchLegs(userId, range);
    const u = await pool.query(
      `SELECT (lname || ', ' || fname) AS name FROM users WHERE id = $1`,
      [userId],
    );
    res.json({
      user_id: userId,
      clinician_name: u.rows.length ? u.rows[0].name : null,
      from: range.from,
      to: range.to,
      agency_id: range.agencyId,
      ...summarizeLegs(legs),
    });
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

// ---------------- legacy envelope reads (read-only) ----------------
// Pre-simplification monthly reports. Kept readable so the
// history (and its original driven-minus-commute math) stays
// reachable; nothing new is written through these routes.

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
      driven_miles: round2(d.driven_miles),
      commute_miles: round2(d.commute_miles),
      reimbursable_miles: round2(Math.max(0, d.driven_miles - d.commute_miles)),
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
    total_driven_miles: round2(days.reduce((s, d) => s + d.driven_miles, 0)),
    total_commute_miles: round2(days.reduce((s, d) => s + d.commute_miles, 0)),
    total_reimbursable_miles: round2(days.reduce((s, d) => s + d.reimbursable_miles, 0)),
    mileage_amount_cents: mileageAmountCents,
    expenses_amount_cents: expensesCents,
    total_amount_cents: mileageAmountCents + expensesCents,
  };
}

router.get('/expense-reports', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const clauses = ['er.deleted_at IS NULL'];
    const vals = [];
    if (!isManagerRole(me)) {
      vals.push(me.id);
      clauses.push(`er.user_id = $${vals.length}`);
    } else if (req.query.user_id !== undefined) {
      const n = Number(req.query.user_id);
      if (!Number.isInteger(n)) {
        throw httpError(400, 'user_id must be an integer', 'USER_ID_INVALID');
      }
      vals.push(n);
      clauses.push(`er.user_id = $${vals.length}`);
    }
    const r = await pool.query(
      `SELECT er.*, (u.lname || ', ' || u.fname) AS owner_name
         FROM expense_reports er
         JOIN users u ON u.id = er.user_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY er.period_start DESC, er.id DESC`,
      vals,
    );
    res.json({ reports: r.rows.map(normalizeReport) });
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

module.exports = router;
