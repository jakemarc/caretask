// End-to-end tests for the expense reports API (2026-11-01)
// — LOCAL TEST ONLY, same conventions as e2e-test.js.
//
// Against a real Postgres (full schema chain incl.
// schema-expense-reports.sql + schema-expenses.sql), this
// proves: report create/validation → mileage entries with the
// per-day commute deduction (floor zero) and rate snapshots →
// non-mileage expense lines → totals → draft lock on submit →
// PIN-gated approve/reject/pay → cross-user isolation → soft
// delete. The routing LIB's response parser is unit-checked
// here without network; the live Valhalla call itself is
// environment-dependent and NOT asserted (the route endpoint
// is checked for its coordinate validation only — miles are
// always hand-enterable when routing is unavailable, by
// design).
//
// Stub auth: an x-test-user header picks which seeded staff
// member the request acts as (owner / other / mgr).
//
// Run: PGDATABASE=caretask_demo E2E_PORT=3111 node e2e-expenses-test.js
const express = require('express');
const pool = require('./db');
const expensesRouter = require('./routes/expenses');
const { hashPin } = require('./lib/pin');
const { parseValhallaMiles } = require('./lib/routing');

const PORT = Number(process.env.E2E_PORT || 3111);
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_PIN = '1357';

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  PASS ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const USERS = {
  owner: { uid: 'exp-owner-uid', email: 'owner@example.com' },
  other: { uid: 'exp-other-uid', email: 'other@example.com' },
  mgr: { uid: 'exp-mgr-uid', email: 'mgr@example.com' },
};

function stubAuth(req, res, next) {
  const who = USERS[req.headers['x-test-user']] || USERS.owner;
  req.user = { uid: who.uid, email: who.email };
  next();
}

async function call(method, path, { as = 'owner', body, pin } = {}) {
  const headers = { 'Content-Type': 'application/json', 'x-test-user': as };
  if (pin) headers['X-Manager-Pin'] = pin;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { res, json: await res.json().catch(() => null) };
}

async function main() {
  // --- unit: Valhalla response parser ---
  console.log('routing parser:');
  check('summary.length parses', parseValhallaMiles({ trip: { summary: { length: 12.34 } } }) === 12.34);
  check('garbage → null', parseValhallaMiles({}) === null && parseValhallaMiles(null) === null);

  // --- seed staff ---
  const pinHash = await hashPin(TEST_PIN);
  await pool.query(
    `INSERT INTO users (firebase_uid, email, role, fname, lname, pin_hash, active)
     VALUES ($1, $2, 'clinician', 'Olivia', 'Owner', NULL, true),
            ($3, $4, 'clinician', 'Oscar', 'Other', NULL, true),
            ($5, $6, 'manager', 'Marge', 'Manager', $7, true)
     ON CONFLICT (email) DO NOTHING`,
    [USERS.owner.uid, USERS.owner.email, USERS.other.uid, USERS.other.email, USERS.mgr.uid, USERS.mgr.email, pinHash],
  );

  const app = express();
  app.use(express.json());
  app.use('/', stubAuth, expensesRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: 'internal' }));
  const server = await new Promise((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    console.log('reports:');
    const badPeriod = await call('POST', '/expense-reports', { body: { period_start: '2026-10-31', period_end: '2026-10-01' } });
    check('end before start → 400', badPeriod.res.status === 400, `got ${badPeriod.res.status}`);
    const noPeriod = await call('POST', '/expense-reports', { body: {} });
    check('missing period → 400', noPeriod.res.status === 400);

    const created = await call('POST', '/expense-reports', {
      body: { period_start: '2026-10-01', period_end: '2026-10-31' },
    });
    check('create → 201 draft', created.res.status === 201 && created.json.report.status === 'draft', JSON.stringify(created.json));
    const rid = created.json.report.id;
    check('report id is a number', typeof rid === 'number');

    console.log('mileage entries + day math:');
    const e1 = await call('POST', `/expense-reports/${rid}/mileage`, {
      body: { entry_date: '2026-10-05', business_miles: 20, rate_per_mile: 0.7, start_address: 'Home A', end_address: 'Home B' },
    });
    check('business entry → 201', e1.res.status === 201, JSON.stringify(e1.json));
    await call('POST', `/expense-reports/${rid}/mileage`, {
      body: { entry_date: '2026-10-05', business_miles: 22.5, rate_per_mile: 0.7 },
    });
    const commute = await call('POST', `/expense-reports/${rid}/mileage`, {
      body: { entry_date: '2026-10-05', entry_kind: 'commute', business_miles: 18, rate_per_mile: 0.7, round_trip: true },
    });
    check('commute entry → 201', commute.res.status === 201);
    await call('POST', `/expense-reports/${rid}/mileage`, {
      body: { entry_date: '2026-10-06', business_miles: 10, rate_per_mile: 0.7 },
    });
    await call('POST', `/expense-reports/${rid}/mileage`, {
      body: { entry_date: '2026-10-06', entry_kind: 'commute', business_miles: 14, rate_per_mile: 0.7 },
    });
    const neg = await call('POST', `/expense-reports/${rid}/mileage`, {
      body: { entry_date: '2026-10-06', business_miles: -3 },
    });
    check('negative miles → 400', neg.res.status === 400);
    const badKind = await call('POST', `/expense-reports/${rid}/mileage`, {
      body: { entry_date: '2026-10-06', entry_kind: 'personal', business_miles: 3 },
    });
    check('bad entry_kind → 400', badKind.res.status === 400);

    console.log('expense lines:');
    const line = await call('POST', `/expense-reports/${rid}/expenses`, {
      body: { expense_date: '2026-10-05', category: 'parking', amount_cents: 1200, description: 'Hospital garage' },
    });
    check('parking line → 201', line.res.status === 201, JSON.stringify(line.json));
    const badLine = await call('POST', `/expense-reports/${rid}/expenses`, {
      body: { expense_date: '2026-10-05', category: 'yachts', amount_cents: 100 },
    });
    check('bad category → 400', badLine.res.status === 400);
    const negLine = await call('POST', `/expense-reports/${rid}/expenses`, {
      body: { expense_date: '2026-10-05', category: 'tolls', amount_cents: -50 },
    });
    check('negative amount → 400', negLine.res.status === 400);

    const detail = await call('GET', `/expense-reports/${rid}`);
    check('detail → 200', detail.res.status === 200);
    const d = detail.json;
    check('two days grouped', d.days.length === 2, `got ${d.days.length}`);
    const day1 = d.days.find((x) => x.date === '2026-10-05');
    const day2 = d.days.find((x) => x.date === '2026-10-06');
    check('day1 driven 42.5', day1.driven_miles === 42.5, `got ${day1.driven_miles}`);
    check('day1 commute 18', day1.commute_miles === 18);
    check('day1 reimbursable 24.5', day1.reimbursable_miles === 24.5, `got ${day1.reimbursable_miles}`);
    check('day2 reimbursable floors at 0', day2.reimbursable_miles === 0);
    check('total reimbursable 24.5', d.total_reimbursable_miles === 24.5, `got ${d.total_reimbursable_miles}`);
    check('mileage $ = 24.5 × 0.70 = 1715¢', d.mileage_amount_cents === 1715, `got ${d.mileage_amount_cents}`);
    check('expenses $ = 1200¢', d.expenses_amount_cents === 1200);
    check('grand total 2915¢', d.total_amount_cents === 2915, `got ${d.total_amount_cents}`);

    console.log('isolation:');
    const otherGet = await call('GET', `/expense-reports/${rid}`, { as: 'other' });
    check('other clinician GET → 404', otherGet.res.status === 404, `got ${otherGet.res.status}`);
    const mgrGet = await call('GET', `/expense-reports/${rid}`, { as: 'mgr' });
    check('manager GET → 200', mgrGet.res.status === 200);
    const otherAdd = await call('POST', `/expense-reports/${rid}/mileage`, {
      as: 'other',
      body: { entry_date: '2026-10-07', business_miles: 5 },
    });
    check('other clinician add entry → 403', otherAdd.res.status === 403, `got ${otherAdd.res.status}`);

    console.log('lifecycle:');
    const edit = await call('PUT', `/expense-reports/${rid}/mileage/${e1.json.entry.id}`, {
      body: { business_miles: 21 },
    });
    check('owner edits entry in draft → 200', edit.res.status === 200 && edit.json.entry.business_miles === 21);
    const submit = await call('POST', `/expense-reports/${rid}/submit`);
    check('submit → submitted', submit.res.status === 200 && submit.json.report.status === 'submitted');
    const lockedAdd = await call('POST', `/expense-reports/${rid}/mileage`, {
      body: { entry_date: '2026-10-08', business_miles: 5 },
    });
    check('add after submit → 409 REPORT_LOCKED', lockedAdd.res.status === 409 && lockedAdd.json.code === 'REPORT_LOCKED', `got ${lockedAdd.res.status}`);
    const noPin = await call('POST', `/expense-reports/${rid}/approve`, { as: 'mgr' });
    check('approve without PIN → 403 PIN_REQUIRED', noPin.res.status === 403 && noPin.json.code === 'PIN_REQUIRED', `got ${noPin.res.status} ${JSON.stringify(noPin.json)}`);
    const badPin = await call('POST', `/expense-reports/${rid}/approve`, { as: 'mgr', pin: '9999' });
    check('approve with wrong PIN → 403 PIN_INVALID', badPin.res.status === 403 && badPin.json.code === 'PIN_INVALID');
    const reject = await call('POST', `/expense-reports/${rid}/reject`, { as: 'mgr', pin: TEST_PIN });
    check('reject → back to draft', reject.res.status === 200 && reject.json.report.status === 'draft' && !reject.json.report.submitted_at);
    const resubmit = await call('POST', `/expense-reports/${rid}/submit`);
    check('resubmit ok', resubmit.json.report.status === 'submitted');
    const approve = await call('POST', `/expense-reports/${rid}/approve`, { as: 'mgr', pin: TEST_PIN });
    check('approve with PIN → approved', approve.res.status === 200 && approve.json.report.status === 'approved', JSON.stringify(approve.json));
    check('approved_by recorded', typeof approve.json.report.approved_by === 'number');
    const pay = await call('POST', `/expense-reports/${rid}/pay`, { as: 'mgr', pin: TEST_PIN, body: { payment_ref: 'ACH-1001' } });
    check('pay → paid + ref', pay.res.status === 200 && pay.json.report.status === 'paid' && pay.json.report.payment_ref === 'ACH-1001');

    console.log('unrated miles + soft delete:');
    const c2 = await call('POST', '/expense-reports', { body: { period_start: '2026-11-01', period_end: '2026-11-30', title: 'November mileage' } });
    const rid2 = c2.json.report.id;
    await call('POST', `/expense-reports/${rid2}/mileage`, { body: { entry_date: '2026-11-02', business_miles: 15 } });
    const d2 = await call('GET', `/expense-reports/${rid2}`);
    check('unrated: miles counted, $ 0', d2.json.total_reimbursable_miles === 15 && d2.json.mileage_amount_cents === 0, JSON.stringify({ m: d2.json.total_reimbursable_miles, c: d2.json.mileage_amount_cents }));
    const del = await call('DELETE', `/expense-reports/${rid2}`);
    check('delete draft → 200', del.res.status === 200);
    const gone = await call('GET', `/expense-reports/${rid2}`);
    check('deleted report → 404', gone.res.status === 404);
    const list = await call('GET', '/expense-reports');
    check('list excludes deleted', !list.json.some((r) => r.id === rid2) && list.json.some((r) => r.id === rid));

    console.log('routing endpoint validation:');
    const noCoords = await call('POST', '/mileage/route', { body: {} });
    check('route without coords → 400', noCoords.res.status === 400 && noCoords.json.code === 'ROUTE_COORDS_REQUIRED');
  } finally {
    server.close();
    await pool.end();
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
