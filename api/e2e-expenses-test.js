// End-to-end tests for the mileage API — LOCAL TEST ONLY,
// same conventions as e2e-test.js.
//
// Rewritten 2026-11-02 for the day-chain simplification
// (Jake): no approval process. Against a real Postgres (full
// schema chain incl. schema-mileage-chains.sql), this proves:
// top-level day-log legs (create + validation) → list scoping
// and range/agency filters → GENERATED report day math
// (billable = business legs, personal = commute bookends,
// dollars only from rated business legs) → cross-user
// isolation with manager read access → owner-only writes →
// legacy envelope reads still honoring the old math → the
// retired lifecycle/write endpoints are gone.
//
// The routing LIB's response parser is unit-checked without
// network; the live Valhalla call is environment-dependent
// and NOT asserted (the route endpoint is checked for its
// coordinate validation only — miles are always
// hand-enterable when routing is unavailable, by design).
//
// Stub auth: an x-test-user header picks which seeded staff
// member the request acts as (owner / other / mgr).
//
// Run: PGDATABASE=caretask_demo E2E_PORT=3111 node e2e-expenses-test.js
const express = require('express');
const pool = require('./db');
const expensesRouter = require('./routes/expenses');
const { parseValhallaMiles } = require('./lib/routing');

const PORT = Number(process.env.E2E_PORT || 3111);
const BASE = `http://127.0.0.1:${PORT}`;

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

async function call(method, path, { as = 'owner', body } = {}) {
  const headers = { 'Content-Type': 'application/json', 'x-test-user': as };
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

  // --- seed staff, agency, patient ---
  await pool.query(
    `INSERT INTO users (firebase_uid, email, role, fname, lname, active)
     VALUES ($1, $2, 'clinician', 'Olivia', 'Owner', true),
            ($3, $4, 'clinician', 'Oscar', 'Other', true),
            ($5, $6, 'manager', 'Marge', 'Manager', true)
     ON CONFLICT (email) DO NOTHING`,
    [USERS.owner.uid, USERS.owner.email, USERS.other.uid, USERS.other.email, USERS.mgr.uid, USERS.mgr.email],
  );
  const ownerId = Number((await pool.query('SELECT id FROM users WHERE email = $1', [USERS.owner.email])).rows[0].id);
  const agencyId = Number((await pool.query(
    `INSERT INTO agencies (license_number, name) VALUES ('TEST-LIC-CHAIN', 'Chain Test Agency')
     ON CONFLICT (license_number) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
  )).rows[0].id);
  const patientId = (await pool.query(
    `INSERT INTO patients (fname, lname) VALUES ('Chain', 'Patient') RETURNING id`,
  )).rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/', stubAuth, expensesRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: 'internal' }));
  const server = await new Promise((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    console.log('leg create + validation:');
    const leg = await call('POST', '/mileage', {
      body: {
        entry_date: '2026-08-15', seq: 1, entry_kind: 'business',
        start_label: 'Office', end_label: 'Patient, Chain',
        end_address: '1 Test Way', patient_id: patientId, agency_id: agencyId,
        miles_toll: 5.9, miles_no_toll: 6.7, used_tollway: true,
        business_miles: 5.9, rate_per_mile: 0.7,
      },
    });
    check('business leg → 201', leg.res.status === 201, JSON.stringify(leg.json));
    check('leg owned by caller', leg.json.entry.user_id === ownerId, `got ${leg.json.entry.user_id}`);
    check('leg has no envelope', leg.json.entry.expense_report_id === null);
    check('leg agency is a number', leg.json.entry.agency_id === agencyId);
    const legId = leg.json.entry.id;

    const commute = await call('POST', '/mileage', {
      body: { entry_date: '2026-08-15', seq: 0, entry_kind: 'commute', business_miles: 11.6 },
    });
    check('commute leg → 201', commute.res.status === 201, JSON.stringify(commute.json));

    const badDate = await call('POST', '/mileage', { body: { entry_date: '15/08/2026', business_miles: 1 } });
    check('bad date → 400', badDate.res.status === 400 && badDate.json.code === 'ENTRY_DATE_INVALID');
    const badKind = await call('POST', '/mileage', { body: { entry_date: '2026-08-15', entry_kind: 'sideways', business_miles: 1 } });
    check('bad entry_kind → 400', badKind.res.status === 400);
    const neg = await call('POST', '/mileage', { body: { entry_date: '2026-08-15', business_miles: -2 } });
    check('negative miles → 400', neg.res.status === 400);
    const badAgency = await call('POST', '/mileage', { body: { entry_date: '2026-08-15', business_miles: 1, agency_id: 999999 } });
    check('unknown agency → 400 AGENCY_NOT_FOUND', badAgency.res.status === 400 && badAgency.json.code === 'AGENCY_NOT_FOUND');
    const badPatient = await call('POST', '/mileage', { body: { entry_date: '2026-08-15', business_miles: 1, patient_id: '00000000-0000-0000-0000-000000000000' } });
    check('unknown patient → 400 PATIENT_NOT_FOUND', badPatient.res.status === 400 && badPatient.json.code === 'PATIENT_NOT_FOUND');
    const badCoord = await call('POST', '/mileage', { body: { entry_date: '2026-08-15', business_miles: 1, start_lat: 91 } });
    check('lat out of range → 400', badCoord.res.status === 400);
    const noCoords = await call('POST', '/mileage/route', { body: {} });
    check('route without coords → 400', noCoords.res.status === 400 && noCoords.json.code === 'ROUTE_COORDS_REQUIRED');

    console.log('list + filters:');
    const mine = await call('GET', '/mileage?from=2026-08-01&to=2026-08-31');
    check('own list has the 2 legs', mine.res.status === 200 && mine.json.entries.length === 2, `got ${mine.json?.entries?.length}`);
    const sept = await call('POST', '/mileage', { body: { entry_date: '2026-09-10', business_miles: 3 } });
    check('september leg → 201', sept.res.status === 201);
    const augOnly = await call('GET', '/mileage?from=2026-08-01&to=2026-08-31');
    check('range filter excludes september', augOnly.json.entries.length === 2);
    const agencyOnly = await call('GET', `/mileage?agency_id=${agencyId}`);
    check('agency filter → only tagged legs', agencyOnly.json.entries.length === 1 && agencyOnly.json.entries[0].id === legId);

    console.log('generated report (chain math):');
    // Day 1 (Oct 5): business 20 + 22.5 @0.70, commute 18 → billable 42.5, personal 18, $29.75
    await call('POST', '/mileage', { body: { entry_date: '2026-10-05', seq: 0, entry_kind: 'commute', business_miles: 18, agency_id: agencyId } });
    await call('POST', '/mileage', { body: { entry_date: '2026-10-05', seq: 1, business_miles: 20, rate_per_mile: 0.7, agency_id: agencyId } });
    await call('POST', '/mileage', { body: { entry_date: '2026-10-05', seq: 2, business_miles: 22.5, rate_per_mile: 0.7, agency_id: agencyId } });
    // Day 2 (Oct 6): business 10 unrated → billable 10, $0
    await call('POST', '/mileage', { body: { entry_date: '2026-10-06', seq: 1, business_miles: 10, agency_id: agencyId } });
    // Same range, NO agency (must fall out of the agency-filtered report)
    await call('POST', '/mileage', { body: { entry_date: '2026-10-06', seq: 2, business_miles: 99 } });

    const rep = await call('GET', `/mileage/report?from=2026-10-01&to=2026-10-31&agency_id=${agencyId}`);
    check('report → 200', rep.res.status === 200, JSON.stringify(rep.json));
    check('two days grouped', rep.json.days.length === 2, `got ${rep.json.days.length}`);
    const d1 = rep.json.days[0];
    const d2 = rep.json.days[1];
    check('day1 billable 42.5', d1.billable_miles === 42.5, `got ${d1.billable_miles}`);
    check('day1 personal 18', d1.personal_miles === 18, `got ${d1.personal_miles}`);
    check('day1 amount 2975¢', d1.amount_cents === 2975, `got ${d1.amount_cents}`);
    check('day2 billable 10 (unrated)', d2.billable_miles === 10 && d2.amount_cents === 0);
    check('total billable 52.5', rep.json.total_billable_miles === 52.5, `got ${rep.json.total_billable_miles}`);
    check('total personal 18', rep.json.total_personal_miles === 18);
    check('total amount 2975¢', rep.json.total_amount_cents === 2975, `got ${rep.json.total_amount_cents}`);
    const repAll = await call('GET', '/mileage/report?from=2026-10-01&to=2026-10-31');
    check('unfiltered report includes the 99-mi leg', repAll.json.total_billable_miles === 151.5, `got ${repAll.json.total_billable_miles}`);
    const noRange = await call('GET', '/mileage/report');
    check('report without range → 400', noRange.res.status === 400 && noRange.json.code === 'RANGE_REQUIRED');

    console.log('isolation:');
    const otherList = await call('GET', '/mileage?from=2026-08-01&to=2026-08-31', { as: 'other' });
    check("other clinician's own list is empty", otherList.res.status === 200 && otherList.json.entries.length === 0);
    const otherPeek = await call('GET', `/mileage?user_id=${ownerId}`, { as: 'other' });
    check('non-manager user_id → 403', otherPeek.res.status === 403, `got ${otherPeek.res.status}`);
    const mgrPeek = await call('GET', `/mileage?user_id=${ownerId}&from=2026-08-01&to=2026-08-31`, { as: 'mgr' });
    check('manager user_id → 200 with legs', mgrPeek.res.status === 200 && mgrPeek.json.entries.length === 2);
    const otherPut = await call('PUT', `/mileage/${legId}`, { as: 'other', body: { business_miles: 1 } });
    check('other PUT → 403', otherPut.res.status === 403, `got ${otherPut.res.status}`);
    const otherDel = await call('DELETE', `/mileage/${legId}`, { as: 'other' });
    check('other DELETE → 403', otherDel.res.status === 403, `got ${otherDel.res.status}`);

    console.log('update + delete:');
    const upd = await call('PUT', `/mileage/${legId}`, { body: { business_miles: 6.1, used_tollway: false } });
    check('owner PUT → 200 updated', upd.res.status === 200 && upd.json.entry.business_miles === 6.1 && upd.json.entry.used_tollway === false, JSON.stringify(upd.json));
    const del = await call('DELETE', `/mileage/${legId}`);
    check('owner DELETE → 200', del.res.status === 200);
    const afterDel = await call('GET', '/mileage?from=2026-08-01&to=2026-08-31');
    check('deleted leg leaves the list', afterDel.json.entries.length === 1);
    const delAgain = await call('DELETE', `/mileage/${legId}`);
    check('delete again → 404', delAgain.res.status === 404);

    console.log('legacy envelope read + retired endpoints:');
    const legacy = await pool.query(
      `INSERT INTO expense_reports (user_id, period_start, period_end, status)
       VALUES ($1, '2026-10-01', '2026-10-31', 'paid') RETURNING id`,
      [ownerId],
    );
    const legacyId = Number(legacy.rows[0].id);
    await pool.query(
      `INSERT INTO mileage_entries (expense_report_id, entry_date, seq, entry_kind, business_miles, rate_per_mile)
       VALUES ($1, '2026-10-05', 1, 'business', 42.5, 0.7), ($1, '2026-10-05', 0, 'commute', 18, 0.7)`,
      [legacyId],
    );
    const legacyGet = await call('GET', `/expense-reports/${legacyId}`);
    check('legacy report → 200', legacyGet.res.status === 200, JSON.stringify(legacyGet.json).slice(0, 200));
    check('legacy math: reimbursable 24.5', legacyGet.json.total_reimbursable_miles === 24.5, `got ${legacyGet.json.total_reimbursable_miles}`);
    check('legacy math: amount 1715¢', legacyGet.json.mileage_amount_cents === 1715, `got ${legacyGet.json.mileage_amount_cents}`);
    const legacyListOther = await call('GET', '/expense-reports', { as: 'other' });
    check("legacy list hides others' reports", legacyListOther.json.reports.every((r) => r.id !== legacyId));
    const createGone = await call('POST', '/expense-reports', { body: { period_start: '2026-11-01', period_end: '2026-11-30' } });
    check('POST /expense-reports retired → 404', createGone.res.status === 404, `got ${createGone.res.status}`);
    const submitGone = await call('POST', `/expense-reports/${legacyId}/submit`, { body: {} });
    check('submit retired → 404', submitGone.res.status === 404, `got ${submitGone.res.status}`);
    const approveGone = await call('POST', `/expense-reports/${legacyId}/approve`, { as: 'mgr', body: {} });
    check('approve retired → 404', approveGone.res.status === 404, `got ${approveGone.res.status}`);
  } finally {
    server.close();
    await pool.end();
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
