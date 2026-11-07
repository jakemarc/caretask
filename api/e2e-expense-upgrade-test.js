// End-to-end tests for the deploy-41 Concur-style expense
// upgrade — LOCAL TEST ONLY, same conventions as
// e2e-expenses-test.js.
//
// Against a real Postgres (full schema chain incl. the five
// deploy-41 files), this proves: mileage rates (manager-only
// create, effective_to chain recompute incl. backdated
// inserts, resolve, duplicate-date rejection) → expense
// policy (manager-only write) → receipts (magic-byte / mime /
// size validation, counts, content download, owner rules) →
// top-level expense lines (CRUD + 'supplies') → generated
// report expense totals → chain-model report create (linking,
// duplicates, empty) → lifecycle transitions incl. the
// SELF_APPROVAL block → line locking → the receipt-policy
// submit gate (commute legs never violate).
//
// Stub auth: an x-test-user header picks which seeded staff
// member the request acts as (owner / other / mgr / mgr2).
//
// Run: PGDATABASE=caretask_demo E2E_PORT=3112 node e2e-expense-upgrade-test.js
const express = require('express');
const pool = require('./db');
const expensesRouter = require('./routes/expenses');

const PORT = Number(process.env.E2E_PORT || 3112);
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
  owner: { uid: 'upg-owner-uid', email: 'upg-owner@example.com' },
  other: { uid: 'upg-other-uid', email: 'upg-other@example.com' },
  mgr: { uid: 'upg-mgr-uid', email: 'upg-mgr@example.com' },
  mgr2: { uid: 'upg-mgr2-uid', email: 'upg-mgr2@example.com' },
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

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const pngBody = (filename = 'receipt.png') => ({
  filename, mime_type: 'image/png', data_base64: PNG_BYTES.toString('base64'),
});

async function main() {
  await pool.query(
    `INSERT INTO users (firebase_uid, email, role, fname, lname, active)
     VALUES ($1, $2, 'clinician', 'Olivia', 'Owner', true),
            ($3, $4, 'clinician', 'Oscar', 'Other', true),
            ($5, $6, 'manager', 'Marge', 'Manager', true),
            ($7, $8, 'manager', 'Martin', 'ManagerTwo', true)
     ON CONFLICT (email) DO NOTHING`,
    [USERS.owner.uid, USERS.owner.email, USERS.other.uid, USERS.other.email,
     USERS.mgr.uid, USERS.mgr.email, USERS.mgr2.uid, USERS.mgr2.email],
  );
  const ownerId = Number((await pool.query('SELECT id FROM users WHERE email = $1', [USERS.owner.email])).rows[0].id);
  const mgrId = Number((await pool.query('SELECT id FROM users WHERE email = $1', [USERS.mgr.email])).rows[0].id);
  const mgr2Id = Number((await pool.query('SELECT id FROM users WHERE email = $1', [USERS.mgr2.email])).rows[0].id);
  const agencyId = Number((await pool.query(
    `INSERT INTO agencies (license_number, name) VALUES ('TEST-LIC-UPG', 'Upgrade Test Agency')
     ON CONFLICT (license_number) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
  )).rows[0].id);

  const app = express();
  app.use(['/mileage', '/expenses', '/expense-receipts'], express.json({ limit: '12mb' }));
  app.use(express.json());
  app.use('/', stubAuth, expensesRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: 'internal' }));
  const server = await new Promise((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    console.log('mileage rates:');
    const rateAsClin = await call('POST', '/mileage-rates', { body: { rate: 0.65, effective_from: '2026-01-01' } });
    check('rate create as clinician → 403 ROLE_REQUIRED', rateAsClin.res.status === 403 && rateAsClin.json.code === 'ROLE_REQUIRED', `got ${rateAsClin.res.status}`);
    const r1 = await call('POST', '/mileage-rates', { as: 'mgr', body: { rate: 0.65, effective_from: '2026-01-01' } });
    check('rate create as mgr → 201', r1.res.status === 201, JSON.stringify(r1.json));
    const r2 = await call('POST', '/mileage-rates', { as: 'mgr', body: { rate: 0.7, effective_from: '2026-07-01' } });
    check('second rate → 201', r2.res.status === 201, JSON.stringify(r2.json));
    const rBack = await call('POST', '/mileage-rates', { as: 'mgr', body: { rate: 0.67, effective_from: '2026-04-01' } });
    check('backdated rate → 201', rBack.res.status === 201, JSON.stringify(rBack.json));
    check('backdated rate effective_to = day before next', rBack.json.rate.effective_to === '2026-06-30', `got ${rBack.json.rate.effective_to}`);
    const rateList = await call('GET', '/mileage-rates');
    check('rates list → 3 rows DESC', rateList.res.status === 200 && rateList.json.rates.length === 3 && rateList.json.rates[0].effective_from === '2026-07-01', JSON.stringify(rateList.json).slice(0, 200));
    const byFrom = Object.fromEntries(rateList.json.rates.map((r) => [r.effective_from, r]));
    check('chain: latest effective_to null', byFrom['2026-07-01'].effective_to === null);
    check('chain: Jan rate ends Mar 31', byFrom['2026-01-01'].effective_to === '2026-03-31', `got ${byFrom['2026-01-01'].effective_to}`);
    check('chain: Apr rate ends Jun 30', byFrom['2026-04-01'].effective_to === '2026-06-30');
    const resBefore = await call('GET', '/mileage-rates/resolve?date=2025-12-31');
    check('resolve before coverage → null', resBefore.res.status === 200 && resBefore.json.rate === null && resBefore.json.rate_id === null, JSON.stringify(resBefore.json));
    const resMid = await call('GET', '/mileage-rates/resolve?date=2026-02-15');
    check('resolve Feb → 0.65', resMid.json.rate === 0.65, JSON.stringify(resMid.json));
    const resMid2 = await call('GET', '/mileage-rates/resolve?date=2026-05-01');
    check('resolve May → 0.67', resMid2.json.rate === 0.67, JSON.stringify(resMid2.json));
    const resAfter = await call('GET', '/mileage-rates/resolve?date=2026-12-01');
    check('resolve Dec → 0.70', resAfter.json.rate === 0.7, JSON.stringify(resAfter.json));
    const resBad = await call('GET', '/mileage-rates/resolve?date=not-a-date');
    check('resolve bad date → 400 RATE_DATE_INVALID', resBad.res.status === 400 && resBad.json.code === 'RATE_DATE_INVALID');
    const rateDup = await call('POST', '/mileage-rates', { as: 'mgr', body: { rate: 0.71, effective_from: '2026-07-01' } });
    check('duplicate effective_from → 409 RATE_DATE_EXISTS', rateDup.res.status === 409 && rateDup.json.code === 'RATE_DATE_EXISTS', `got ${rateDup.res.status}`);
    const rateBad = await call('POST', '/mileage-rates', { as: 'mgr', body: { rate: -1, effective_from: '2026-08-01' } });
    check('negative rate → 400 RATE_INVALID', rateBad.res.status === 400 && rateBad.json.code === 'RATE_INVALID');

    console.log('expense policy:');
    const polGet = await call('GET', '/expense-policy');
    check('policy default off', polGet.res.status === 200 && polGet.json.require_receipts === false && polGet.json.receipt_threshold_cents === null, JSON.stringify(polGet.json));
    const polAsClin = await call('PUT', '/expense-policy', { body: { require_receipts: true, receipt_threshold_cents: null } });
    check('policy PUT as clinician → 403 ROLE_REQUIRED', polAsClin.res.status === 403 && polAsClin.json.code === 'ROLE_REQUIRED');
    const polBad = await call('PUT', '/expense-policy', { as: 'mgr', body: { require_receipts: 'yes', receipt_threshold_cents: null } });
    check('policy PUT bad type → 400 POLICY_INVALID', polBad.res.status === 400 && polBad.json.code === 'POLICY_INVALID');
    const polOff = await call('PUT', '/expense-policy', { as: 'mgr', body: { require_receipts: false, receipt_threshold_cents: null } });
    check('policy PUT as mgr → 200 off', polOff.res.status === 200 && polOff.json.require_receipts === false, JSON.stringify(polOff.json));

    console.log('receipts:');
    const legA = await call('POST', '/mileage', { body: { entry_date: '2026-08-10', seq: 1, business_miles: 10, rate_per_mile: 0.7 } });
    check('receipt-test leg → 201', legA.res.status === 201, JSON.stringify(legA.json));
    const legAId = legA.json.entry.id;
    check('new leg receipt_count 0', legA.json.entry.receipt_count === 0, `got ${legA.json.entry.receipt_count}`);
    const recOther = await call('POST', `/mileage/${legAId}/receipts`, { as: 'other', body: pngBody() });
    check('receipt POST by other → 403', recOther.res.status === 403 && recOther.json.code === 'FORBIDDEN', `got ${recOther.res.status}`);
    const recBadMime = await call('POST', `/mileage/${legAId}/receipts`, { body: { filename: 'x.txt', mime_type: 'text/plain', data_base64: PNG_BYTES.toString('base64') } });
    check('bad mime → 400 RECEIPT_TYPE_INVALID', recBadMime.res.status === 400 && recBadMime.json.code === 'RECEIPT_TYPE_INVALID');
    const recBadMagic = await call('POST', `/mileage/${legAId}/receipts`, { body: { filename: 'x.png', mime_type: 'image/png', data_base64: Buffer.from('this is not a png file').toString('base64') } });
    check('wrong magic → 400 RECEIPT_TYPE_INVALID', recBadMagic.res.status === 400 && recBadMagic.json.code === 'RECEIPT_TYPE_INVALID');
    const bigBuf = Buffer.alloc(8 * 1024 * 1024 + 1);
    PNG_BYTES.copy(bigBuf, 0);
    const recBig = await call('POST', `/mileage/${legAId}/receipts`, { body: { filename: 'big.png', mime_type: 'image/png', data_base64: bigBuf.toString('base64') } });
    check('oversize → 400 RECEIPT_TOO_LARGE', recBig.res.status === 400 && recBig.json.code === 'RECEIPT_TOO_LARGE', `got ${recBig.res.status} ${JSON.stringify(recBig.json)}`);
    const recOk = await call('POST', `/mileage/${legAId}/receipts`, { body: pngBody() });
    check('valid PNG receipt → 201', recOk.res.status === 201, JSON.stringify(recOk.json));
    check('receipt metadata has no data field', recOk.json.receipt && !('data' in recOk.json.receipt) && !('data_base64' in recOk.json.receipt));
    check('receipt metadata fields', recOk.json.receipt.mileage_entry_id === legAId && recOk.json.receipt.expense_id === null && recOk.json.receipt.mime_type === 'image/png' && recOk.json.receipt.size_bytes === PNG_BYTES.length);
    const receiptId = recOk.json.receipt.id;
    const listAfterRec = await call('GET', '/mileage?from=2026-08-01&to=2026-08-31');
    const legInList = listAfterRec.json.entries.find((e) => e.id === legAId);
    check('leg receipt_count 1 after add', legInList && legInList.receipt_count === 1, `got ${legInList?.receipt_count}`);
    const recList = await call('GET', `/mileage/${legAId}/receipts`);
    check('receipt list → 1 metadata row', recList.res.status === 200 && recList.json.receipts.length === 1 && !('data' in recList.json.receipts[0]));
    const recListOther = await call('GET', `/mileage/${legAId}/receipts`, { as: 'other' });
    check('receipt list by other → 404', recListOther.res.status === 404, `got ${recListOther.res.status}`);
    const recListMgr = await call('GET', `/mileage/${legAId}/receipts`, { as: 'mgr' });
    check('receipt list by mgr → 200', recListMgr.res.status === 200 && recListMgr.json.receipts.length === 1);
    const contentRes = await fetch(`${BASE}/expense-receipts/${receiptId}/content`, { headers: { 'x-test-user': 'owner' } });
    const contentBuf = Buffer.from(await contentRes.arrayBuffer());
    check('content download → 200 + png type', contentRes.status === 200 && (contentRes.headers.get('content-type') || '').includes('image/png'), `got ${contentRes.status} ${contentRes.headers.get('content-type')}`);
    check('content bytes round-trip', contentBuf.equals(PNG_BYTES));
    const recDelOther = await call('DELETE', `/expense-receipts/${receiptId}`, { as: 'other' });
    check('receipt DELETE by other → 403', recDelOther.res.status === 403, `got ${recDelOther.res.status}`);
    const recDel = await call('DELETE', `/expense-receipts/${receiptId}`);
    check('receipt DELETE by owner → 200', recDel.res.status === 200, JSON.stringify(recDel.json));
    const listAfterDel = await call('GET', '/mileage?from=2026-08-01&to=2026-08-31');
    check('receipt_count drops to 0 after delete', listAfterDel.json.entries.find((e) => e.id === legAId)?.receipt_count === 0);

    console.log('expense lines:');
    const exp1 = await call('POST', '/expenses', {
      body: { expense_date: '2026-10-05', category: 'supplies', description: 'Gloves', vendor_name: 'MedSupply', amount_cents: 1250, agency_id: agencyId, payment_method: 'personal_card' },
    });
    check("'supplies' line → 201 unlinked", exp1.res.status === 201 && exp1.json.expense.report_id === null, JSON.stringify(exp1.json));
    check('line fields (Concur-relevant)', exp1.json.expense.category === 'supplies' && exp1.json.expense.vendor_name === 'MedSupply' && exp1.json.expense.amount_cents === 1250 && exp1.json.expense.payment_method === 'personal_card' && exp1.json.expense.receipt_count === 0);
    const exp1Id = exp1.json.expense.id;
    const expBadCat = await call('POST', '/expenses', { body: { expense_date: '2026-10-05', category: 'bogus', amount_cents: 100 } });
    check('bad category → 400 EXPENSE_CATEGORY_INVALID', expBadCat.res.status === 400 && expBadCat.json.code === 'EXPENSE_CATEGORY_INVALID');
    const expBadAmt = await call('POST', '/expenses', { body: { expense_date: '2026-10-05', category: 'parking', amount_cents: 10.5 } });
    check('fractional amount → 400 EXPENSE_AMOUNT_INVALID', expBadAmt.res.status === 400 && expBadAmt.json.code === 'EXPENSE_AMOUNT_INVALID');
    const expBadDate = await call('POST', '/expenses', { body: { expense_date: '10/05/2026', category: 'parking', amount_cents: 100 } });
    check('bad date → 400 EXPENSE_DATE_INVALID', expBadDate.res.status === 400 && expBadDate.json.code === 'EXPENSE_DATE_INVALID');
    const expBadAgency = await call('POST', '/expenses', { body: { expense_date: '2026-10-05', category: 'parking', amount_cents: 100, agency_id: 999999 } });
    check('unknown agency → 400 AGENCY_NOT_FOUND', expBadAgency.res.status === 400 && expBadAgency.json.code === 'AGENCY_NOT_FOUND');
    const exp2 = await call('POST', '/expenses', { body: { expense_date: '2026-10-06', category: 'parking', amount_cents: 500 } });
    check('parking line → 201', exp2.res.status === 201, JSON.stringify(exp2.json));
    const exp2Id = exp2.json.expense.id;
    const expUpd = await call('PUT', `/expenses/${exp1Id}`, { body: { amount_cents: 1500 } });
    check('owner PUT line → 200 amount 1500', expUpd.res.status === 200 && expUpd.json.expense.amount_cents === 1500, JSON.stringify(expUpd.json));
    const expUpdOther = await call('PUT', `/expenses/${exp1Id}`, { as: 'other', body: { amount_cents: 1 } });
    check('other PUT line → 403', expUpdOther.res.status === 403);
    const expRec = await call('POST', `/expenses/${exp1Id}/receipts`, { body: pngBody('line.png') });
    check('receipt on expense line → 201', expRec.res.status === 201 && expRec.json.receipt.expense_id === exp1Id, JSON.stringify(expRec.json));
    const expList = await call('GET', '/expenses?from=2026-10-01&to=2026-10-31');
    check('GET /expenses → 2 lines', expList.res.status === 200 && expList.json.expenses.length === 2, `got ${expList.json?.expenses?.length}`);
    check('line receipt_count 1', expList.json.expenses.find((x) => x.id === exp1Id)?.receipt_count === 1);
    const expTemp = await call('POST', '/expenses', { body: { expense_date: '2026-11-15', category: 'tolls', amount_cents: 300 } });
    const expTempDel = await call('DELETE', `/expenses/${expTemp.json.expense.id}`);
    check('owner DELETE line → 200', expTempDel.res.status === 200);
    const expListNov = await call('GET', '/expenses?from=2026-11-01&to=2026-11-30');
    check('deleted line leaves list', expListNov.json.expenses.length === 0);

    console.log('generated report with expenses:');
    await call('POST', '/mileage', { body: { entry_date: '2026-10-05', seq: 0, entry_kind: 'commute', business_miles: 18 } });
    const octBiz1 = await call('POST', '/mileage', { body: { entry_date: '2026-10-05', seq: 1, business_miles: 20, rate_per_mile: 0.7 } });
    await call('POST', '/mileage', { body: { entry_date: '2026-10-05', seq: 2, business_miles: 22.5, rate_per_mile: 0.7 } });
    const octBiz1Id = octBiz1.json.entry.id;
    const gen = await call('GET', '/mileage/report?from=2026-10-01&to=2026-10-31');
    check('generated report → 200', gen.res.status === 200, JSON.stringify(gen.json).slice(0, 200));
    check('generated total_amount stays mileage-only 2975', gen.json.total_amount_cents === 2975, `got ${gen.json.total_amount_cents}`);
    check('generated expenses_amount 2000', gen.json.expenses_amount_cents === 2000, `got ${gen.json.expenses_amount_cents}`);
    check('generated grand total 4975', gen.json.grand_total_amount_cents === 4975, `got ${gen.json.grand_total_amount_cents}`);
    check('generated expenses array has 2 lines', Array.isArray(gen.json.expenses) && gen.json.expenses.length === 2);
    check('generated policy present + violations [] when off', gen.json.policy && gen.json.policy.require_receipts === false && Array.isArray(gen.json.receipt_violations) && gen.json.receipt_violations.length === 0, JSON.stringify(gen.json.policy));

    console.log('report create + transitions:');
    const repCreate = await call('POST', '/expense-reports', { body: { period_start: '2026-10-01', period_end: '2026-10-31', title: 'October' } });
    check('report create → 201 chain draft', repCreate.res.status === 201 && repCreate.json.report.model === 'chain' && repCreate.json.report.status === 'draft', JSON.stringify(repCreate.json));
    const reportId = repCreate.json.report.id;
    const legsOct = await call('GET', '/mileage?from=2026-10-01&to=2026-10-31');
    check('create linked the legs', legsOct.json.entries.length === 3 && legsOct.json.entries.every((e) => e.expense_report_id === reportId), JSON.stringify(legsOct.json.entries.map((e) => e.expense_report_id)));
    const repDup = await call('POST', '/expense-reports', { body: { period_start: '2026-10-01', period_end: '2026-10-31' } });
    check('second create same period → 409 REPORT_EXISTS', repDup.res.status === 409 && repDup.json.code === 'REPORT_EXISTS' && repDup.json.existing_id === reportId, `got ${repDup.res.status} ${JSON.stringify(repDup.json)}`);
    const repEmpty = await call('POST', '/expense-reports', { body: { period_start: '2027-02-01', period_end: '2027-02-28' } });
    check('create empty range → 400 REPORT_EMPTY', repEmpty.res.status === 400 && repEmpty.json.code === 'REPORT_EMPTY');
    const repBadPeriod = await call('POST', '/expense-reports', { body: { period_start: '2026-10-31', period_end: '2026-10-01' } });
    check('end before start → 400 PERIOD_INVALID', repBadPeriod.res.status === 400 && repBadPeriod.json.code === 'PERIOD_INVALID');
    const detail1 = await call('GET', `/expense-reports/${reportId}`);
    check('chain detail → 200 model chain', detail1.res.status === 200 && detail1.json.model === 'chain', JSON.stringify(detail1.json).slice(0, 200));
    check('chain math: billable 42.5 (NOT driven-commute 24.5)', detail1.json.total_billable_miles === 42.5, `got ${detail1.json.total_billable_miles}`);
    check('chain math: personal 18, driven 60.5', detail1.json.total_personal_miles === 18 && detail1.json.total_driven_miles === 60.5, `got ${detail1.json.total_personal_miles}/${detail1.json.total_driven_miles}`);
    check('chain math: mileage 2975 + expenses 2000 = 4975', detail1.json.mileage_amount_cents === 2975 && detail1.json.expenses_amount_cents === 2000 && detail1.json.total_amount_cents === 4975, `got ${detail1.json.mileage_amount_cents}/${detail1.json.expenses_amount_cents}/${detail1.json.total_amount_cents}`);
    check('chain detail expenses carry receipt_count', detail1.json.expenses.length === 2 && detail1.json.expenses.find((x) => x.id === exp1Id)?.receipt_count === 1);
    check('creation event in timeline', detail1.json.events.length === 1 && detail1.json.events[0].to_status === 'draft' && detail1.json.events[0].from_status === null && detail1.json.events[0].actor_id === ownerId, JSON.stringify(detail1.json.events));
    const listReports = await call('GET', '/expense-reports');
    check('list includes model chain', listReports.json.reports.find((r) => r.id === reportId)?.model === 'chain');
    const invalidTrans = await call('POST', `/expense-reports/${reportId}/transition`, { as: 'mgr', body: { to: 'approved' } });
    check('draft→approved → 409 TRANSITION_INVALID', invalidTrans.res.status === 409 && invalidTrans.json.code === 'TRANSITION_INVALID', `got ${invalidTrans.res.status}`);
    const putDraft = await call('PUT', `/mileage/${octBiz1Id}`, { body: { business_miles: 20 } });
    check('leg PUT while draft → 200 (not locked)', putDraft.res.status === 200, `got ${putDraft.res.status} ${JSON.stringify(putDraft.json)}`);
    const submit = await call('POST', `/expense-reports/${reportId}/transition`, { body: { to: 'submitted' } });
    check('owner submit → 200 submitted', submit.res.status === 200 && submit.json.report.status === 'submitted' && !!submit.json.report.submitted_at, JSON.stringify(submit.json).slice(0, 200));
    const putLocked = await call('PUT', `/mileage/${octBiz1Id}`, { body: { business_miles: 21 } });
    check('leg PUT while submitted → 409 REPORT_LOCKED', putLocked.res.status === 409 && putLocked.json.code === 'REPORT_LOCKED', `got ${putLocked.res.status}`);
    const delExpLocked = await call('DELETE', `/expenses/${exp2Id}`);
    check('expense DELETE while submitted → 409 REPORT_LOCKED', delExpLocked.res.status === 409 && delExpLocked.json.code === 'REPORT_LOCKED', `got ${delExpLocked.res.status}`);
    const recLocked = await call('POST', `/mileage/${octBiz1Id}/receipts`, { body: pngBody() });
    check('receipt POST while submitted → 409 REPORT_LOCKED', recLocked.res.status === 409 && recLocked.json.code === 'REPORT_LOCKED', `got ${recLocked.res.status}`);
    const approveAsOwner = await call('POST', `/expense-reports/${reportId}/transition`, { body: { to: 'approved' } });
    check('approve as clinician owner → 403 ROLE_REQUIRED', approveAsOwner.res.status === 403 && approveAsOwner.json.code === 'ROLE_REQUIRED', `got ${approveAsOwner.res.status} ${JSON.stringify(approveAsOwner.json)}`);
    const approve = await call('POST', `/expense-reports/${reportId}/transition`, { as: 'mgr', body: { to: 'approved' } });
    check('approve as mgr → 200', approve.res.status === 200 && approve.json.report.status === 'approved' && approve.json.report.approved_by === mgrId, JSON.stringify(approve.json).slice(0, 200));
    const pay = await call('POST', `/expense-reports/${reportId}/transition`, { as: 'mgr', body: { to: 'paid', payment_ref: 'CHK-123' } });
    check('pay as mgr → 200 with payment_ref', pay.res.status === 200 && pay.json.report.status === 'paid' && pay.json.report.payment_ref === 'CHK-123' && !!pay.json.report.paid_at, JSON.stringify(pay.json).slice(0, 200));
    const detailPaid = await call('GET', `/expense-reports/${reportId}`);
    check('timeline order draft→submitted→approved→paid', detailPaid.json.events.map((e) => e.to_status).join(',') === 'draft,submitted,approved,paid', JSON.stringify(detailPaid.json.events.map((e) => e.to_status)));
    check('timeline actors', detailPaid.json.events[1].actor_id === ownerId && detailPaid.json.events[2].actor_id === mgrId && !!detailPaid.json.events[2].actor_name);

    console.log('reject path:');
    const novLeg = await call('POST', '/mileage', { body: { entry_date: '2026-11-10', seq: 1, business_miles: 10, rate_per_mile: 0.7 } });
    const novLegId = novLeg.json.entry.id;
    const rep2 = await call('POST', '/expense-reports', { body: { period_start: '2026-11-01', period_end: '2026-11-30' } });
    check('nov report → 201', rep2.res.status === 201, JSON.stringify(rep2.json));
    const report2Id = rep2.json.report.id;
    await call('POST', `/expense-reports/${report2Id}/transition`, { body: { to: 'submitted' } });
    const reject = await call('POST', `/expense-reports/${report2Id}/transition`, { as: 'mgr', body: { to: 'rejected', note: 'Fix the date' } });
    check('mgr reject → 200 rejected', reject.res.status === 200 && reject.json.report.status === 'rejected', JSON.stringify(reject.json).slice(0, 200));
    const backDraft = await call('POST', `/expense-reports/${report2Id}/transition`, { body: { to: 'draft' } });
    check('owner rejected→draft → 200', backDraft.res.status === 200 && backDraft.json.report.status === 'draft', JSON.stringify(backDraft.json).slice(0, 200));
    const detail2 = await call('GET', `/expense-reports/${report2Id}`);
    check('reject timeline draft,submitted,rejected,draft', detail2.json.events.map((e) => e.to_status).join(',') === 'draft,submitted,rejected,draft', JSON.stringify(detail2.json.events.map((e) => e.to_status)));
    check('reject timeline actors mgr then owner', detail2.json.events[2].actor_id === mgrId && detail2.json.events[3].actor_id === ownerId);
    const putAfterDraft = await call('PUT', `/mileage/${novLegId}`, { body: { business_miles: 11 } });
    check('leg PUT works again after reject→draft', putAfterDraft.res.status === 200 && putAfterDraft.json.entry.business_miles === 11, `got ${putAfterDraft.res.status}`);

    console.log('policy submit gate:');
    const polOn = await call('PUT', '/expense-policy', { as: 'mgr', body: { require_receipts: true, receipt_threshold_cents: null } });
    check('policy ON as mgr → 200', polOn.res.status === 200 && polOn.json.require_receipts === true);
    const decBiz = await call('POST', '/mileage', { body: { entry_date: '2026-12-05', seq: 1, business_miles: 10, rate_per_mile: 0.7 } });
    const decBizId = decBiz.json.entry.id;
    await call('POST', '/mileage', { body: { entry_date: '2026-12-05', seq: 0, entry_kind: 'commute', business_miles: 12, rate_per_mile: 0.7 } });
    const rep3 = await call('POST', '/expense-reports', { body: { period_start: '2026-12-01', period_end: '2026-12-31' } });
    check('dec report → 201', rep3.res.status === 201, JSON.stringify(rep3.json));
    const report3Id = rep3.json.report.id;
    const gated = await call('POST', `/expense-reports/${report3Id}/transition`, { body: { to: 'submitted' } });
    check('submit without receipt → 422 RECEIPTS_REQUIRED', gated.res.status === 422 && gated.json.code === 'RECEIPTS_REQUIRED', `got ${gated.res.status} ${JSON.stringify(gated.json)}`);
    check('violation names the business leg only (commute never violates)', Array.isArray(gated.json.violations) && gated.json.violations.length === 1 && gated.json.violations[0].kind === 'mileage' && gated.json.violations[0].id === decBizId && gated.json.violations[0].date === '2026-12-05', JSON.stringify(gated.json.violations));
    const genDec = await call('GET', '/mileage/report?from=2026-12-01&to=2026-12-31');
    check('generated report shows the violation', Array.isArray(genDec.json.receipt_violations) && genDec.json.receipt_violations.length === 1 && genDec.json.receipt_violations[0].id === decBizId, JSON.stringify(genDec.json.receipt_violations));
    const decRec = await call('POST', `/mileage/${decBizId}/receipts`, { body: pngBody('dec.png') });
    check('attach receipt while draft → 201', decRec.res.status === 201, JSON.stringify(decRec.json));
    const submit2 = await call('POST', `/expense-reports/${report3Id}/transition`, { body: { to: 'submitted' } });
    check('submit after receipt → 200', submit2.res.status === 200 && submit2.json.report.status === 'submitted', `got ${submit2.res.status} ${JSON.stringify(submit2.json)}`);
    const polOff2 = await call('PUT', '/expense-policy', { as: 'mgr', body: { require_receipts: false, receipt_threshold_cents: null } });
    check('policy OFF again → 200', polOff2.res.status === 200 && polOff2.json.require_receipts === false);

    console.log('self-approval block:');
    const mgrLeg = await call('POST', '/mileage', { as: 'mgr', body: { entry_date: '2027-03-05', seq: 1, business_miles: 5 } });
    check('mgr own leg → 201', mgrLeg.res.status === 201, JSON.stringify(mgrLeg.json));
    const repMgr = await call('POST', '/expense-reports', { as: 'mgr', body: { period_start: '2027-03-01', period_end: '2027-03-31' } });
    check('mgr own report → 201', repMgr.res.status === 201, JSON.stringify(repMgr.json));
    const reportMgrId = repMgr.json.report.id;
    const mgrSubmit = await call('POST', `/expense-reports/${reportMgrId}/transition`, { as: 'mgr', body: { to: 'submitted' } });
    check('mgr submit own → 200 (owner action, not blocked)', mgrSubmit.res.status === 200 && mgrSubmit.json.report.status === 'submitted', `got ${mgrSubmit.res.status} ${JSON.stringify(mgrSubmit.json)}`);
    const mgrApproveOwn = await call('POST', `/expense-reports/${reportMgrId}/transition`, { as: 'mgr', body: { to: 'approved' } });
    check('mgr approve own → 403 SELF_APPROVAL', mgrApproveOwn.res.status === 403 && mgrApproveOwn.json.code === 'SELF_APPROVAL', `got ${mgrApproveOwn.res.status} ${JSON.stringify(mgrApproveOwn.json)}`);
    const mgrRejectOwn = await call('POST', `/expense-reports/${reportMgrId}/transition`, { as: 'mgr', body: { to: 'rejected' } });
    check('mgr reject own → 403 SELF_APPROVAL', mgrRejectOwn.res.status === 403 && mgrRejectOwn.json.code === 'SELF_APPROVAL', `got ${mgrRejectOwn.res.status}`);
    const mgr2Approve = await call('POST', `/expense-reports/${reportMgrId}/transition`, { as: 'mgr2', body: { to: 'approved' } });
    check('mgr2 approve → 200', mgr2Approve.res.status === 200 && mgr2Approve.json.report.status === 'approved' && mgr2Approve.json.report.approved_by === mgr2Id, `got ${mgr2Approve.res.status} ${JSON.stringify(mgr2Approve.json)}`);
    const mgrPayOwn = await call('POST', `/expense-reports/${reportMgrId}/transition`, { as: 'mgr', body: { to: 'paid' } });
    check('mgr pay own → 403 SELF_APPROVAL', mgrPayOwn.res.status === 403 && mgrPayOwn.json.code === 'SELF_APPROVAL', `got ${mgrPayOwn.res.status}`);
    const mgr2Pay = await call('POST', `/expense-reports/${reportMgrId}/transition`, { as: 'mgr2', body: { to: 'paid', payment_ref: 'ACH-9' } });
    check('mgr2 pay → 200', mgr2Pay.res.status === 200 && mgr2Pay.json.report.status === 'paid', `got ${mgr2Pay.res.status}`);
    check('seeded ids sane', ownerId > 0 && mgrId > 0 && mgr2Id > 0 && mgrId !== mgr2Id);
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
