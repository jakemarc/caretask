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
// 2026-11-06 DEPLOY-41 (Concur-style expense upgrade): the
// envelope lifecycle is RESTORED for new chain-model reports
// (expense_reports.model = 'chain'): top-level expense lines,
// receipt attachments (BYTEA, expense_receipts), a dated
// mileage-rate table, a receipt-policy singleton, report
// create that links unlinked legs/lines in period, status
// transitions with an events timeline, a self-approval block
// (a manager/admin cannot approve/reject/pay their OWN
// report), and line locking while a linked report is
// submitted/approved/paid. Legacy envelopes (model='legacy')
// keep the old driven-minus-commute math in reads.
//
// Access: the caller must resolve to an active users row.
// Legs are owner-written; managers/admins may READ another
// clinician's log and generated reports (user_id parameter).
// Event log: 'expense_change' events carry ids only — never
// addresses, amounts, notes, or file content.
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
    agency_id: r.agency_id === null || r.agency_id === undefined ? null : Number(r.agency_id),
    approved_by: r.approved_by === null || r.approved_by === undefined ? null : Number(r.approved_by),
    period_start: dateOnly(r.period_start),
    period_end: dateOnly(r.period_end),
    model: r.model || 'legacy',
  };
}

function normalizeEntry(e) {
  if (!e) return e;
  return {
    ...e,
    id: Number(e.id),
    expense_report_id: e.expense_report_id === null || e.expense_report_id === undefined ? null : Number(e.expense_report_id),
    user_id: e.user_id === null || e.user_id === undefined ? null : Number(e.user_id),
    agency_id: e.agency_id === null || e.agency_id === undefined ? null : Number(e.agency_id),
    appointment_id: e.appointment_id === null || e.appointment_id === undefined ? null : Number(e.appointment_id),
    entry_date: dateOnly(e.entry_date),
    start_lat: e.start_lat === null || e.start_lat === undefined ? null : Number(e.start_lat),
    start_lng: e.start_lng === null || e.start_lng === undefined ? null : Number(e.start_lng),
    end_lat: e.end_lat === null || e.end_lat === undefined ? null : Number(e.end_lat),
    end_lng: e.end_lng === null || e.end_lng === undefined ? null : Number(e.end_lng),
    miles_toll: e.miles_toll === null || e.miles_toll === undefined ? null : Number(e.miles_toll),
    miles_no_toll: e.miles_no_toll === null || e.miles_no_toll === undefined ? null : Number(e.miles_no_toll),
    business_miles: Number(e.business_miles),
    rate_per_mile: e.rate_per_mile === null || e.rate_per_mile === undefined ? null : Number(e.rate_per_mile),
    receipt_count: e.receipt_count === null || e.receipt_count === undefined ? 0 : Number(e.receipt_count),
  };
}

function normalizeExpense(x) {
  if (!x) return x;
  return {
    ...x,
    id: Number(x.id),
    report_id: x.report_id === null || x.report_id === undefined ? null : Number(x.report_id),
    user_id: Number(x.user_id),
    agency_id: x.agency_id === null || x.agency_id === undefined ? null : Number(x.agency_id),
    expense_date: dateOnly(x.expense_date),
    amount_cents: Number(x.amount_cents),
    receipt_count: x.receipt_count === null || x.receipt_count === undefined ? 0 : Number(x.receipt_count),
  };
}

function normalizeReceiptMeta(r) {
  if (!r) return r;
  return {
    id: Number(r.id),
    mileage_entry_id: r.mileage_entry_id === null || r.mileage_entry_id === undefined ? null : Number(r.mileage_entry_id),
    expense_id: r.expense_id === null || r.expense_id === undefined ? null : Number(r.expense_id),
    filename: r.filename ?? null,
    mime_type: r.mime_type,
    size_bytes: Number(r.size_bytes),
    created_at: r.created_at,
  };
}

function normalizeRate(r) {
  if (!r) return r;
  return {
    ...r,
    id: Number(r.id),
    rate: Number(r.rate),
    effective_from: dateOnly(r.effective_from),
    effective_to: dateOnly(r.effective_to),
    created_by: r.created_by === null || r.created_by === undefined ? null : Number(r.created_by),
  };
}

function normalizeReportEvent(r) {
  if (!r) return r;
  return {
    id: Number(r.id),
    report_id: Number(r.report_id),
    actor_id: Number(r.actor_id),
    actor_name: r.actor_name ?? undefined,
    from_status: r.from_status ?? null,
    to_status: r.to_status,
    note: r.note ?? null,
    created_at: r.created_at,
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

const LEG_RECEIPT_COUNT = `(SELECT COUNT(*)::int FROM expense_receipts rc WHERE rc.mileage_entry_id = mileage_entries.id AND rc.deleted_at IS NULL)`;
const LEG_RECEIPT_COUNT_ME = `(SELECT COUNT(*)::int FROM expense_receipts rc WHERE rc.mileage_entry_id = me.id AND rc.deleted_at IS NULL)`;
const EXP_RECEIPT_COUNT = `(SELECT COUNT(*)::int FROM expense_receipts rc WHERE rc.expense_id = expenses.id AND rc.deleted_at IS NULL)`;
const EXP_RECEIPT_COUNT_E = `(SELECT COUNT(*)::int FROM expense_receipts rc WHERE rc.expense_id = e.id AND rc.deleted_at IS NULL)`;

async function fetchLegs(userId, { from, to, agencyId }) {
  const clauses = ['me.user_id = $1', 'me.deleted_at IS NULL'];
  const vals = [userId];
  if (from) { vals.push(from); clauses.push(`me.entry_date >= $${vals.length}`); }
  if (to) { vals.push(to); clauses.push(`me.entry_date <= $${vals.length}`); }
  if (agencyId) { vals.push(agencyId); clauses.push(`me.agency_id = $${vals.length}`); }
  const r = await pool.query(
    `SELECT me.*, ${LEG_RECEIPT_COUNT_ME} AS receipt_count FROM mileage_entries me
      WHERE ${clauses.join(' AND ')}
      ORDER BY me.entry_date, me.seq, me.id`,
    vals,
  );
  return r.rows.map(normalizeEntry);
}

async function fetchLegById(id) {
  const r = await pool.query(
    `SELECT *, ${LEG_RECEIPT_COUNT} AS receipt_count FROM mileage_entries WHERE id = $1`,
    [id],
  );
  return r.rows.length ? normalizeEntry(r.rows[0]) : null;
}

async function fetchExpensesForUser(userId, { from, to, agencyId }) {
  const clauses = ['e.user_id = $1', 'e.deleted_at IS NULL'];
  const vals = [userId];
  if (from) { vals.push(from); clauses.push(`e.expense_date >= $${vals.length}`); }
  if (to) { vals.push(to); clauses.push(`e.expense_date <= $${vals.length}`); }
  if (agencyId) { vals.push(agencyId); clauses.push(`e.agency_id = $${vals.length}`); }
  const r = await pool.query(
    `SELECT e.*, ${EXP_RECEIPT_COUNT_E} AS receipt_count FROM expenses e
      WHERE ${clauses.join(' AND ')}
      ORDER BY e.expense_date, e.id`,
    vals,
  );
  return r.rows.map(normalizeExpense);
}

async function fetchExpenseById(id) {
  const r = await pool.query(
    `SELECT *, ${EXP_RECEIPT_COUNT} AS receipt_count FROM expenses WHERE id = $1`,
    [id],
  );
  return r.rows.length ? normalizeExpense(r.rows[0]) : null;
}

async function fetchLinkedLegs(reportId) {
  const r = await pool.query(
    `SELECT *, ${LEG_RECEIPT_COUNT} AS receipt_count FROM mileage_entries
      WHERE expense_report_id = $1 AND deleted_at IS NULL
      ORDER BY entry_date, seq, id`,
    [reportId],
  );
  return r.rows.map(normalizeEntry);
}

async function fetchLinkedExpenses(reportId) {
  const r = await pool.query(
    `SELECT *, ${EXP_RECEIPT_COUNT} AS receipt_count FROM expenses
      WHERE report_id = $1 AND deleted_at IS NULL
      ORDER BY expense_date, id`,
    [reportId],
  );
  return r.rows.map(normalizeExpense);
}

// ---------------- policy + locking (deploy-41) ----------------

async function getPolicy(db = pool) {
  const r = await db.query('SELECT * FROM expense_settings WHERE id = 1');
  if (!r.rows.length) return { require_receipts: false, receipt_threshold_cents: null };
  return {
    require_receipts: Boolean(r.rows[0].require_receipts),
    receipt_threshold_cents: r.rows[0].receipt_threshold_cents === null ? null : Number(r.rows[0].receipt_threshold_cents),
  };
}

// Shared by the submit gate and the generated report. A line
// violates when it has no receipt and its value is at/above
// the threshold (NULL threshold = all lines). Only BUSINESS
// legs count — commute legs never require receipts.
function computeViolations(legs, expenses, policy) {
  if (!policy || !policy.require_receipts) return [];
  const threshold = policy.receipt_threshold_cents;
  const out = [];
  for (const e of legs || []) {
    if (e.entry_kind === 'commute') continue;
    if (Number(e.receipt_count || 0) !== 0) continue;
    const value = e.rate_per_mile === null || e.rate_per_mile === undefined
      ? 0
      : Math.round(e.business_miles * e.rate_per_mile * 100);
    if (threshold === null || value >= threshold) {
      out.push({ kind: 'mileage', id: Number(e.id), date: e.entry_date });
    }
  }
  for (const x of expenses || []) {
    if (Number(x.receipt_count || 0) !== 0) continue;
    const value = Number(x.amount_cents);
    if (threshold === null || value >= threshold) {
      out.push({ kind: 'expense', id: Number(x.id), date: x.expense_date });
    }
  }
  return out;
}

async function assertLineUnlocked(lineReportId, db = pool) {
  if (lineReportId === null || lineReportId === undefined) return;
  const r = await db.query('SELECT status FROM expense_reports WHERE id = $1', [lineReportId]);
  if (r.rows.length && ['submitted', 'approved', 'paid'].includes(r.rows[0].status)) {
    throw httpError(409, 'line is locked by a submitted expense report', 'REPORT_LOCKED');
  }
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
  const leg = await fetchLegById(req.params.id);
  if (!leg || leg.deleted_at) {
    throw httpError(404, 'mileage entry not found', 'ENTRY_NOT_FOUND');
  }
  if (Number(leg.user_id) !== Number(me.id)) {
    throw httpError(403, 'only the owner can change this entry', 'FORBIDDEN');
  }
  return leg;
}

router.put('/mileage/:id', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const existing = await loadOwnedLeg(req, me);
    await assertLineUnlocked(existing.expense_report_id);
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
    const fresh = await fetchLegById(r.rows[0].id);
    res.json({ entry: fresh || normalizeEntry(r.rows[0]) });
  } catch (err) {
    sendErr(res, next, err);
  }
});

router.delete('/mileage/:id', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const existing = await loadOwnedLeg(req, me);
    await assertLineUnlocked(existing.expense_report_id);
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
    const expenses = await fetchExpensesForUser(userId, range);
    const policy = await getPolicy(pool);
    const summary = summarizeLegs(legs);
    const expensesAmount = expenses.reduce((s, x) => s + x.amount_cents, 0);
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
      ...summary,
      expenses,
      expenses_amount_cents: expensesAmount,
      grand_total_amount_cents: summary.total_amount_cents + expensesAmount,
      policy,
      receipt_violations: computeViolations(legs, expenses, policy),
    });
  } catch (err) {
    sendErr(res, next, err);
  }
});

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

// ---------------- receipts (deploy-41) ----------------

const RECEIPT_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const RECEIPT_MAX_BYTES = 8 * 1024 * 1024;

function receiptMagicOk(buf, mime) {
  if (!buf || buf.length < 4) return false;
  if (mime === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === 'image/png') return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (mime === 'application/pdf') return buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
  if (mime === 'image/webp') {
    return buf.length >= 12
      && buf.toString('ascii', 0, 4) === 'RIFF'
      && buf.toString('ascii', 8, 12) === 'WEBP';
  }
  return false;
}

function parseReceiptBody(body) {
  const b = body || {};
  const mime = b.mime_type;
  if (!RECEIPT_MIMES.has(mime)) {
    throw httpError(400, 'receipt type must be jpeg, png, webp or pdf', 'RECEIPT_TYPE_INVALID');
  }
  if (typeof b.data_base64 !== 'string' || !b.data_base64) {
    throw httpError(400, 'receipt data is required', 'RECEIPT_TYPE_INVALID');
  }
  const buf = Buffer.from(b.data_base64, 'base64');
  if (buf.length > RECEIPT_MAX_BYTES) {
    throw httpError(400, 'receipt exceeds 8 MiB', 'RECEIPT_TOO_LARGE');
  }
  if (!receiptMagicOk(buf, mime)) {
    throw httpError(400, 'receipt bytes do not match the declared type', 'RECEIPT_TYPE_INVALID');
  }
  return { filename: b.filename ?? null, mime_type: mime, buf };
}

async function loadLegForReceiptPost(id) {
  const leg = await fetchLegById(id);
  if (!leg || leg.deleted_at) throw httpError(404, 'mileage entry not found', 'ENTRY_NOT_FOUND');
  return leg;
}

async function loadExpenseForReceiptPost(id) {
  const x = await fetchExpenseById(id);
  if (!x || x.deleted_at) throw httpError(404, 'expense not found', 'EXPENSE_NOT_FOUND');
  return x;
}

router.post('/mileage/:id/receipts', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const leg = await loadLegForReceiptPost(req.params.id);
    if (Number(leg.user_id) !== Number(me.id)) {
      throw httpError(403, 'only the owner can add a receipt to this entry', 'FORBIDDEN');
    }
    await assertLineUnlocked(leg.expense_report_id);
    const v = parseReceiptBody(req.body);
    const r = await pool.query(
      `INSERT INTO expense_receipts (mileage_entry_id, expense_id, user_id, filename, mime_type, size_bytes, data)
       VALUES ($1, NULL, $2, $3, $4, $5, $6)
       RETURNING id, mileage_entry_id, expense_id, filename, mime_type, size_bytes, created_at`,
      [leg.id, me.id, v.filename, v.mime_type, v.buf.length, v.buf],
    );
    await insertEvent(pool, {
      actor: req.user, event: 'expense_change',
      details: { action: 'receipt_add', receipt_id: Number(r.rows[0].id), entry_id: leg.id },
      ip: req.ip,
    });
    res.status(201).json({ receipt: normalizeReceiptMeta(r.rows[0]) });
  } catch (err) { sendErr(res, next, err); }
});

router.post('/expenses/:id/receipts', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const x = await loadExpenseForReceiptPost(req.params.id);
    if (Number(x.user_id) !== Number(me.id)) {
      throw httpError(403, 'only the owner can add a receipt to this expense', 'FORBIDDEN');
    }
    await assertLineUnlocked(x.report_id);
    const v = parseReceiptBody(req.body);
    const r = await pool.query(
      `INSERT INTO expense_receipts (mileage_entry_id, expense_id, user_id, filename, mime_type, size_bytes, data)
       VALUES (NULL, $1, $2, $3, $4, $5, $6)
       RETURNING id, mileage_entry_id, expense_id, filename, mime_type, size_bytes, created_at`,
      [x.id, me.id, v.filename, v.mime_type, v.buf.length, v.buf],
    );
    await insertEvent(pool, {
      actor: req.user, event: 'expense_change',
      details: { action: 'receipt_add', receipt_id: Number(r.rows[0].id), expense_id: x.id },
      ip: req.ip,
    });
    res.status(201).json({ receipt: normalizeReceiptMeta(r.rows[0]) });
  } catch (err) { sendErr(res, next, err); }
});

router.get('/mileage/:id/receipts', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const leg = await fetchLegById(req.params.id);
    if (!leg || leg.deleted_at) throw httpError(404, 'mileage entry not found', 'ENTRY_NOT_FOUND');
    if (Number(leg.user_id) !== Number(me.id) && !isManagerRole(me)) {
      throw httpError(404, 'mileage entry not found', 'ENTRY_NOT_FOUND');
    }
    const r = await pool.query(
      `SELECT id, mileage_entry_id, expense_id, filename, mime_type, size_bytes, created_at
         FROM expense_receipts WHERE mileage_entry_id = $1 AND deleted_at IS NULL ORDER BY created_at, id`,
      [leg.id],
    );
    res.json({ receipts: r.rows.map(normalizeReceiptMeta) });
  } catch (err) { sendErr(res, next, err); }
});

router.get('/expenses/:id/receipts', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const x = await fetchExpenseById(req.params.id);
    if (!x || x.deleted_at) throw httpError(404, 'expense not found', 'EXPENSE_NOT_FOUND');
    if (Number(x.user_id) !== Number(me.id) && !isManagerRole(me)) {
      throw httpError(404, 'expense not found', 'EXPENSE_NOT_FOUND');
    }
    const r = await pool.query(
      `SELECT id, mileage_entry_id, expense_id, filename, mime_type, size_bytes, created_at
         FROM expense_receipts WHERE expense_id = $1 AND deleted_at IS NULL ORDER BY created_at, id`,
      [x.id],
    );
    res.json({ receipts: r.rows.map(normalizeReceiptMeta) });
  } catch (err) { sendErr(res, next, err); }
});

router.get('/expense-receipts/:id/content', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const r = await pool.query('SELECT * FROM expense_receipts WHERE id = $1', [req.params.id]);
    if (!r.rows.length || r.rows[0].deleted_at) {
      throw httpError(404, 'receipt not found', 'RECEIPT_NOT_FOUND');
    }
    const rec = r.rows[0];
    if (Number(rec.user_id) !== Number(me.id) && !isManagerRole(me)) {
      throw httpError(404, 'receipt not found', 'RECEIPT_NOT_FOUND');
    }
    const safeName = String(rec.filename || 'receipt').replace(/"/g, '');
    res.setHeader('Content-Type', rec.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.send(rec.data);
  } catch (err) { sendErr(res, next, err); }
});

router.delete('/expense-receipts/:id', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const r = await pool.query('SELECT * FROM expense_receipts WHERE id = $1', [req.params.id]);
    if (!r.rows.length || r.rows[0].deleted_at) {
      throw httpError(404, 'receipt not found', 'RECEIPT_NOT_FOUND');
    }
    const rec = r.rows[0];
    if (Number(rec.user_id) !== Number(me.id)) {
      throw httpError(403, 'only the owner can delete this receipt', 'FORBIDDEN');
    }
    if (rec.mileage_entry_id !== null) {
      const parent = await fetchLegById(rec.mileage_entry_id);
      if (parent) await assertLineUnlocked(parent.expense_report_id);
    } else if (rec.expense_id !== null) {
      const parent = await fetchExpenseById(rec.expense_id);
      if (parent) await assertLineUnlocked(parent.report_id);
    }
    await pool.query('UPDATE expense_receipts SET deleted_at = now() WHERE id = $1', [rec.id]);
    await insertEvent(pool, {
      actor: req.user, event: 'expense_change',
      details: { action: 'receipt_delete', receipt_id: Number(rec.id) },
      ip: req.ip,
    });
    res.json({ receipt: { ...normalizeReceiptMeta(rec), deleted_at: new Date().toISOString() } });
  } catch (err) { sendErr(res, next, err); }
});

// ---------------- mileage rates (deploy-41) ----------------

router.get('/mileage-rates', async (req, res, next) => {
  try {
    await resolveMe(pool, req);
    const r = await pool.query('SELECT * FROM mileage_rates ORDER BY effective_from DESC, id DESC');
    res.json({ rates: r.rows.map(normalizeRate) });
  } catch (err) { sendErr(res, next, err); }
});

router.get('/mileage-rates/resolve', async (req, res, next) => {
  try {
    await resolveMe(pool, req);
    const date = req.query.date;
    if (!isDateStr(date)) throw httpError(400, 'date must be a YYYY-MM-DD date', 'RATE_DATE_INVALID');
    const r = await pool.query(
      `SELECT * FROM mileage_rates WHERE effective_from <= $1
        ORDER BY effective_from DESC, id DESC LIMIT 1`,
      [date],
    );
    if (!r.rows.length) return res.json({ date, rate: null, rate_id: null });
    return res.json({ date, rate: Number(r.rows[0].rate), rate_id: Number(r.rows[0].id) });
  } catch (err) { return sendErr(res, next, err); }
});

router.post('/mileage-rates', async (req, res, next) => {
  let client;
  try {
    const me = await resolveMe(pool, req);
    if (!isManagerRole(me)) throw httpError(403, 'manager or admin role required', 'ROLE_REQUIRED');
    const b = req.body || {};
    const rate = b.rate === undefined || b.rate === null || b.rate === '' ? NaN : Number(b.rate);
    if (!Number.isFinite(rate) || rate < 0) throw httpError(400, 'rate must be a number ≥ 0', 'RATE_INVALID');
    if (!isDateStr(b.effective_from)) throw httpError(400, 'effective_from must be a YYYY-MM-DD date', 'RATE_DATE_INVALID');
    const dup = await pool.query('SELECT id FROM mileage_rates WHERE effective_from = $1', [b.effective_from]);
    if (dup.rows.length) {
      throw httpError(409, 'a rate already exists for this effective_from date; pick the next day to supersede', 'RATE_DATE_EXISTS');
    }
    client = await pool.connect();
    await client.query('BEGIN');
    const ins = await client.query(
      'INSERT INTO mileage_rates (rate, effective_from, created_by) VALUES ($1, $2, $3) RETURNING *',
      [rate, b.effective_from, me.id],
    );
    await client.query(
      `WITH ordered AS (
         SELECT id, LEAD(effective_from) OVER (ORDER BY effective_from, id) AS next_from FROM mileage_rates
       )
       UPDATE mileage_rates mr
          SET effective_to = CASE WHEN o.next_from IS NULL THEN NULL ELSE (o.next_from - 1) END
         FROM ordered o WHERE o.id = mr.id`,
    );
    const fresh = await client.query('SELECT * FROM mileage_rates WHERE id = $1', [ins.rows[0].id]);
    await client.query('COMMIT');
    res.status(201).json({ rate: normalizeRate(fresh.rows[0]) });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
    sendErr(res, next, err);
  } finally {
    if (client) client.release();
  }
});

// ---------------- expense policy (deploy-41) ----------------

router.get('/expense-policy', async (req, res, next) => {
  try {
    await resolveMe(pool, req);
    const p = await getPolicy(pool);
    res.json(p);
  } catch (err) { sendErr(res, next, err); }
});

router.put('/expense-policy', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    if (!isManagerRole(me)) throw httpError(403, 'manager or admin role required', 'ROLE_REQUIRED');
    const b = req.body || {};
    if (typeof b.require_receipts !== 'boolean') {
      throw httpError(400, 'require_receipts must be a boolean', 'POLICY_INVALID');
    }
    let threshold = null;
    if (b.receipt_threshold_cents !== undefined && b.receipt_threshold_cents !== null) {
      if (!Number.isInteger(b.receipt_threshold_cents) || b.receipt_threshold_cents < 0) {
        throw httpError(400, 'receipt_threshold_cents must be a non-negative integer or null', 'POLICY_INVALID');
      }
      threshold = b.receipt_threshold_cents;
    }
    await pool.query(
      `INSERT INTO expense_settings (id, require_receipts, receipt_threshold_cents, updated_by, updated_at)
       VALUES (1, $1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE SET require_receipts = EXCLUDED.require_receipts,
         receipt_threshold_cents = EXCLUDED.receipt_threshold_cents,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [b.require_receipts, threshold, me.id],
    );
    await insertEvent(pool, {
      actor: req.user, event: 'expense_change',
      details: { action: 'expense_policy_update' },
      ip: req.ip,
    });
    const p = await getPolicy(pool);
    res.json(p);
  } catch (err) { sendErr(res, next, err); }
});

// ---------------- expense lines (deploy-41) ----------------

const EXPENSE_CATEGORIES = ['mileage', 'parking', 'tolls', 'medical_supplies', 'office_supplies', 'meals', 'travel', 'lodging', 'phone_internet', 'training', 'licenses', 'other', 'supplies'];
const EXPENSE_PAYMENT_METHODS = ['personal_card', 'company_card', 'cash', 'other'];
const EXPENSE_COLS = ['expense_date', 'category', 'description', 'vendor_name', 'amount_cents', 'currency', 'payment_method', 'agency_id', 'notes'];

function expenseFromBody(b, existing) {
  const e = existing || {};
  const pick = (key, cur) => (b[key] !== undefined ? b[key] : cur);
  const out = {
    expense_date: pick('expense_date', e.expense_date),
    category: pick('category', e.category),
    description: pick('description', e.description ?? null),
    vendor_name: pick('vendor_name', e.vendor_name ?? null),
    amount_cents: pick('amount_cents', e.amount_cents),
    currency: pick('currency', e.currency ?? 'USD'),
    payment_method: pick('payment_method', e.payment_method ?? null),
    agency_id: numOrNull(pick('agency_id', e.agency_id ?? null)),
    notes: pick('notes', e.notes ?? null),
  };
  if (!isDateStr(out.expense_date)) {
    throw httpError(400, 'expense_date must be a YYYY-MM-DD date', 'EXPENSE_DATE_INVALID');
  }
  if (!EXPENSE_CATEGORIES.includes(out.category)) {
    throw httpError(400, 'category is not a valid expense category', 'EXPENSE_CATEGORY_INVALID');
  }
  if (!Number.isInteger(out.amount_cents) || out.amount_cents < 0) {
    throw httpError(400, 'amount_cents must be an integer ≥ 0', 'EXPENSE_AMOUNT_INVALID');
  }
  if (out.payment_method !== null && !EXPENSE_PAYMENT_METHODS.includes(out.payment_method)) {
    throw httpError(400, 'payment_method is not valid', 'EXPENSE_PAYMENT_METHOD_INVALID');
  }
  return out;
}

async function validateExpenseAgency(v) {
  if (v.agency_id !== null && v.agency_id !== undefined) {
    const r = await pool.query('SELECT id FROM agencies WHERE id = $1', [v.agency_id]);
    if (!r.rows.length) throw httpError(400, 'agency not found', 'AGENCY_NOT_FOUND');
  }
}

router.get('/expenses', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const userId = await scopeUserId(req, me);
    const expenses = await fetchExpensesForUser(userId, rangeAndAgency(req));
    res.json({ expenses });
  } catch (err) { sendErr(res, next, err); }
});

router.post('/expenses', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const v = expenseFromBody(req.body || {});
    await validateExpenseAgency(v);
    const cols = ['report_id', 'user_id', ...EXPENSE_COLS];
    const vals = [null, me.id, ...EXPENSE_COLS.map((c) => v[c])];
    const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
    const r = await pool.query(
      `INSERT INTO expenses (${cols.join(', ')}) VALUES (${ph}) RETURNING *`,
      vals,
    );
    await insertEvent(pool, {
      actor: req.user, event: 'expense_change',
      details: { action: 'expense_create', expense_id: Number(r.rows[0].id) },
      ip: req.ip,
    });
    res.status(201).json({ expense: normalizeExpense(r.rows[0]) });
  } catch (err) { sendErr(res, next, err); }
});

async function loadOwnedExpense(req, me) {
  const x = await fetchExpenseById(req.params.id);
  if (!x || x.deleted_at) throw httpError(404, 'expense not found', 'EXPENSE_NOT_FOUND');
  if (Number(x.user_id) !== Number(me.id)) {
    throw httpError(403, 'only the owner can change this expense', 'FORBIDDEN');
  }
  return x;
}

router.put('/expenses/:id', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const existing = await loadOwnedExpense(req, me);
    await assertLineUnlocked(existing.report_id);
    const v = expenseFromBody(req.body || {}, existing);
    await validateExpenseAgency(v);
    const sets = EXPENSE_COLS.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const r = await pool.query(
      `UPDATE expenses SET ${sets} WHERE id = $1 RETURNING *`,
      [existing.id, ...EXPENSE_COLS.map((c) => v[c])],
    );
    await insertEvent(pool, {
      actor: req.user, event: 'expense_change',
      details: { action: 'expense_update', expense_id: existing.id },
      ip: req.ip,
    });
    const fresh = await fetchExpenseById(r.rows[0].id);
    res.json({ expense: fresh || normalizeExpense(r.rows[0]) });
  } catch (err) { sendErr(res, next, err); }
});

router.delete('/expenses/:id', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const existing = await loadOwnedExpense(req, me);
    await assertLineUnlocked(existing.report_id);
    await pool.query('UPDATE expenses SET deleted_at = now() WHERE id = $1', [existing.id]);
    await insertEvent(pool, {
      actor: req.user, event: 'expense_change',
      details: { action: 'expense_delete', expense_id: existing.id },
      ip: req.ip,
    });
    res.json({ expense: { ...existing, deleted_at: new Date().toISOString() } });
  } catch (err) { sendErr(res, next, err); }
});

// ---------------- legacy envelope reads + deploy-41 reports ----------------

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

async function fetchReportEvents(reportId) {
  const r = await pool.query(
    `SELECT ev.*, (u.lname || ', ' || u.fname) AS actor_name
       FROM expense_report_events ev
       JOIN users u ON u.id = ev.actor_id
      WHERE ev.report_id = $1
      ORDER BY ev.created_at ASC, ev.id ASC`,
    [reportId],
  );
  return r.rows.map(normalizeReportEvent);
}

async function summarize(db, reportId) {
  const [entriesR, expensesR] = await Promise.all([
    db.query(
      `SELECT *, ${LEG_RECEIPT_COUNT} AS receipt_count FROM mileage_entries
        WHERE expense_report_id = $1 AND deleted_at IS NULL
        ORDER BY entry_date, seq, id`,
      [reportId],
    ),
    db.query(
      `SELECT *, ${EXP_RECEIPT_COUNT} AS receipt_count FROM expenses
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

router.post('/expense-reports', async (req, res, next) => {
  let client;
  try {
    const me = await resolveMe(pool, req);
    const b = req.body || {};
    const periodStart = b.period_start;
    const periodEnd = b.period_end;
    if (!isDateStr(periodStart) || !isDateStr(periodEnd) || periodEnd < periodStart) {
      throw httpError(400, 'period_start and period_end must be valid dates with end ≥ start', 'PERIOD_INVALID');
    }
    const agencyId = numOrNull(b.agency_id ?? null);
    if (agencyId !== null) {
      if (!Number.isInteger(agencyId)) throw httpError(400, 'agency_id must be an integer', 'AGENCY_ID_INVALID');
      const ar = await pool.query('SELECT id FROM agencies WHERE id = $1', [agencyId]);
      if (!ar.rows.length) throw httpError(400, 'agency not found', 'AGENCY_NOT_FOUND');
    }
    client = await pool.connect();
    await client.query('BEGIN');
    const dup = await client.query(
      `SELECT id FROM expense_reports
        WHERE user_id = $1 AND period_start = $2 AND period_end = $3
          AND agency_id IS NOT DISTINCT FROM $4
          AND deleted_at IS NULL AND status = 'draft'`,
      [me.id, periodStart, periodEnd, agencyId],
    );
    if (dup.rows.length) {
      await client.query('ROLLBACK');
      client.release(); client = undefined;
      return res.status(409).json({
        error: 'a draft report already exists for this period',
        code: 'REPORT_EXISTS',
        existing_id: Number(dup.rows[0].id),
      });
    }
    const ins = await client.query(
      `INSERT INTO expense_reports (user_id, agency_id, title, period_start, period_end, status, model, notes)
       VALUES ($1, $2, $3, $4, $5, 'draft', 'chain', $6) RETURNING *`,
      [me.id, agencyId, b.title ?? null, periodStart, periodEnd, b.notes ?? null],
    );
    const report = normalizeReport(ins.rows[0]);
    const linkLegs = await client.query(
      `UPDATE mileage_entries SET expense_report_id = $1
        WHERE user_id = $2 AND expense_report_id IS NULL AND deleted_at IS NULL
          AND entry_date >= $3 AND entry_date <= $4
          AND ($5::bigint IS NULL OR agency_id = $5)
        RETURNING id`,
      [report.id, me.id, periodStart, periodEnd, agencyId],
    );
    const linkExp = await client.query(
      `UPDATE expenses SET report_id = $1
        WHERE user_id = $2 AND report_id IS NULL AND deleted_at IS NULL
          AND expense_date >= $3 AND expense_date <= $4
          AND ($5::bigint IS NULL OR agency_id = $5)
        RETURNING id`,
      [report.id, me.id, periodStart, periodEnd, agencyId],
    );
    const totalLinked = linkLegs.rows.length + linkExp.rows.length;
    if (totalLinked === 0) {
      await client.query('ROLLBACK');
      client.release(); client = undefined;
      return res.status(400).json({ error: 'no unlinked legs or expenses in this period', code: 'REPORT_EMPTY' });
    }
    await client.query(
      `INSERT INTO expense_report_events (report_id, actor_id, from_status, to_status, note)
       VALUES ($1, $2, NULL, 'draft', 'Report created')`,
      [report.id, me.id],
    );
    await insertEvent(client, {
      actor: req.user, event: 'expense_change',
      details: { action: 'report_create', report_id: report.id },
      ip: req.ip,
    });
    await client.query('COMMIT');
    return res.status(201).json({ report });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
    return sendErr(res, next, err);
  } finally {
    if (client) client.release();
  }
});

const TRANSITION_MAP = {
  draft: ['submitted'],
  submitted: ['approved', 'rejected'],
  rejected: ['draft'],
  approved: ['paid'],
  paid: [],
};

router.post('/expense-reports/:id/transition', async (req, res, next) => {
  let client;
  try {
    const me = await resolveMe(pool, req);
    const report = await fetchReport(pool, req.params.id);
    if (!report || report.deleted_at) {
      throw httpError(404, 'expense report not found', 'REPORT_NOT_FOUND');
    }
    const isOwner = Number(report.user_id) === Number(me.id);
    if (!isOwner && !isManagerRole(me)) {
      throw httpError(404, 'expense report not found', 'REPORT_NOT_FOUND');
    }
    const b = req.body || {};
    const to = b.to;
    const allowed = TRANSITION_MAP[report.status] || [];
    if (!allowed.includes(to)) {
      throw httpError(409, `cannot transition from ${report.status} to ${to}`, 'TRANSITION_INVALID');
    }
    if (to === 'submitted' || to === 'draft') {
      if (!isOwner) throw httpError(403, 'only the owner can do this transition', 'FORBIDDEN');
    }
    if (to === 'approved' || to === 'rejected' || to === 'paid') {
      if (!isManagerRole(me)) throw httpError(403, 'manager or admin role required', 'ROLE_REQUIRED');
      if (Number(report.user_id) === Number(me.id)) {
        throw httpError(403, 'you cannot process your own expense report', 'SELF_APPROVAL');
      }
    }
    if (to === 'submitted') {
      const legs = await fetchLinkedLegs(report.id);
      const exps = await fetchLinkedExpenses(report.id);
      const policy = await getPolicy(pool);
      const violations = computeViolations(legs, exps, policy);
      if (violations.length) {
        return res.status(422).json({
          error: 'receipts are required before submitting',
          code: 'RECEIPTS_REQUIRED',
          violations,
        });
      }
    }
    const sets = ['status = $2'];
    const vals = [report.id, to];
    if (to === 'submitted') sets.push('submitted_at = now()');
    if (to === 'approved') {
      vals.push(me.id);
      sets.push(`approved_by = $${vals.length}`, 'approved_at = now()');
    }
    if (to === 'paid') {
      sets.push('paid_at = now()');
      if (b.payment_ref !== undefined) {
        vals.push(b.payment_ref);
        sets.push(`payment_ref = $${vals.length}`);
      }
    }
    client = await pool.connect();
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE expense_reports SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      vals,
    );
    const ev = await client.query(
      `INSERT INTO expense_report_events (report_id, actor_id, from_status, to_status, note)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [report.id, me.id, report.status, to, b.note ?? null],
    );
    await insertEvent(client, {
      actor: req.user, event: 'expense_change',
      details: { action: 'report_transition', report_id: report.id, to },
      ip: req.ip,
    });
    await client.query('COMMIT');
    const eventRow = { ...ev.rows[0], actor_name: `${me.lname}, ${me.fname}` };
    return res.json({ report: normalizeReport(upd.rows[0]), event: normalizeReportEvent(eventRow) });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
    return sendErr(res, next, err);
  } finally {
    if (client) client.release();
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
    const events = await fetchReportEvents(report.id);
    if (report.model === 'chain') {
      const legs = await fetchLinkedLegs(report.id);
      const expenses = await fetchLinkedExpenses(report.id);
      const summary = summarizeLegs(legs);
      const expensesAmount = expenses.reduce((s, x) => s + x.amount_cents, 0);
      return res.json({
        report,
        model: 'chain',
        days: summary.days,
        expenses,
        total_billable_miles: summary.total_billable_miles,
        total_personal_miles: summary.total_personal_miles,
        total_driven_miles: summary.total_driven_miles,
        mileage_amount_cents: summary.total_amount_cents,
        expenses_amount_cents: expensesAmount,
        total_amount_cents: summary.total_amount_cents + expensesAmount,
        events,
      });
    }
    const summary = await summarize(pool, report.id);
    return res.json({ report, model: report.model || 'legacy', ...summary, events });
  } catch (err) {
    return sendErr(res, next, err);
  }
});

module.exports = router;
