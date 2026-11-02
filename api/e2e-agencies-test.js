// End-to-end test for the agency directory (schema-agencies.sql,
// routes/agencies.js, lib/agencySync.js). Runs against a scratch
// Postgres — same env contract as the other suites (all schemas
// applied in the documented order, schema-agencies.sql LAST, and
// applied TWICE in setup to prove migration idempotency).
//
// Firebase auth is stubbed: req.user is injected. PIN gating uses
// a seeded manager row (lib/pin hashPin), same as users-mgmt.
//
// The IDPH network is never touched: syncs run from fixture
// payloads (lib sampleRows) and from a fake fetchImpl that stands
// in for the Socrata metadata + resource endpoints. Run this
// suite LAST on a fresh DB: like the events suite, it TRUNCATEs
// event_log at start so sync-skip state is deterministic.
const express = require('express');
const { Pool } = require('pg');

const pool = new Pool();
const agenciesRouter = require('./routes/agencies');
const eventsRouter = require('./routes/events');
const { hashPin } = require('./lib/pin');
const { syncAgencies } = require('./lib/agencySync');

const PORT = Number(process.env.E2E_PORT || 3108);
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

const CALLER = 'agency-tester@example.com';
const MANAGER_PIN = '2468';

async function call(method, path, body, pin) {
  return fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(pin ? { 'X-Manager-Pin': pin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function srow(license, name, extra = {}) {
  return {
    license_number: license,
    facility_name: name,
    address: '100 Example Street',
    city: 'Springfield',
    county: 'Sangamon',
    zip: '62704',
    contact_name: 'Test Contact',
    phone: '(555) 010-1000',
    exp_date: '2028-03-31T00:00:00.000',
    ...extra,
  };
}

const S1 = '2099-01-01T00:00:00.000Z';
const S2 = '2099-02-01T00:00:00.000Z';
const S3 = '2099-03-01T00:00:00.000Z';

const FIXTURE_V1 = [
  srow('TEST-001', 'Test Alpha Home Health, LLC'),
  srow('TEST-002', 'Test Beta Care, Inc. - DBA Beta Home Health'),
  srow('TEST-003', 'Test Gamma Home Health, LLC'),
];
// TEST-001 changed phone, TEST-002 same source row, TEST-003 gone,
// TEST-004 new.
const FIXTURE_V2 = [
  srow('TEST-001', 'Test Alpha Home Health, LLC', { phone: '(555) 010-9999' }),
  srow('TEST-002', 'Test Beta Care, Inc. - DBA Beta Home Health'),
  srow('TEST-004', 'Test Delta Home Health, LLC'),
];

async function cleanup() {
  await pool.query("DELETE FROM agencies WHERE license_number LIKE 'TEST-%'");
  await pool.query('DELETE FROM users WHERE email = $1', [CALLER]);
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { uid: 'test-uid', email: CALLER };
    next();
  });
  app.use('/agencies', agenciesRouter);
  app.use('/events', eventsRouter);
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'boom' });
  });
  const server = app.listen(PORT);
  try {
    await pool.query('TRUNCATE event_log');
    await cleanup();
    const pinHash = await hashPin(MANAGER_PIN);
    await pool.query(
      `INSERT INTO users (email, role, authorized, active, fname, lname, pin_hash)
       VALUES ($1, 'manager', false, true, 'Agency', 'Tester', $2)`,
      [CALLER, pinHash],
    );

    // --- schema facts
    const idx = await pool.query(
      "SELECT 1 FROM pg_indexes WHERE indexname = 'agencies_one_primary_idx'",
    );
    check('agencies table + one-primary partial index exist', idx.rows.length === 1);

    // --- sync v1 (fixture)
    let sum = await syncAgencies(pool, {
      sampleRows: FIXTURE_V1, sampleSourceUpdatedAt: S1,
      actor: { uid: 'test', email: CALLER }, trigger: 'test',
    });
    check('v1 sync: 3 fetched / 3 inserted / 0 updated / 0 deactivated',
      sum.fetched === 3 && sum.inserted === 3 && sum.updated === 0 && sum.deactivated === 0,
      JSON.stringify(sum));
    let r = await pool.query(
      "SELECT * FROM agencies WHERE license_number = 'TEST-002'",
    );
    check('DBA parsed out of facility_name',
      r.rows[0].dba === 'Beta Home Health' && r.rows[0].name.includes('Test Beta Care'));
    const exp = await pool.query(
      "SELECT to_char(license_expiration_date, 'YYYY-MM-DD') AS d FROM agencies WHERE license_number = 'TEST-002'",
    );
    check('exp_date stored as DATE, state defaults IL, source idph',
      exp.rows[0].d === '2028-03-31'
        && r.rows[0].state === 'IL' && r.rows[0].source === 'idph');

    // --- sync again, same stamp → skip
    sum = await syncAgencies(pool, {
      sampleRows: FIXTURE_V1, sampleSourceUpdatedAt: S1,
      actor: { uid: 'test', email: CALLER }, trigger: 'test',
    });
    check('same rowsUpdatedAt → skipped_no_change = 1, no writes',
      sum.skipped_no_change === 1 && sum.fetched === 0 && sum.inserted === 0,
      JSON.stringify(sum));

    // --- API reads
    let res = await call('GET', '/agencies');
    let list = await res.json();
    check('GET /agencies lists 3 active agencies',
      res.status === 200 && Array.isArray(list) && list.length === 3);
    res = await call('GET', '/agencies?q=alpha');
    list = await res.json();
    check('search ?q=alpha → 1 row', list.length === 1 && list[0].license_number === 'TEST-001');
    const alphaId = list[0].id;
    res = await call('GET', '/agencies?q=springfield');
    check('search ?q= by city works', (await res.json()).length === 3);
    res = await call('GET', '/agencies');
    list = await res.json();
    const byLicense = Object.fromEntries(list.map((a) => [a.license_number, a]));
    check('display_name: first-two-words fallback (TEST-001)',
      byLicense['TEST-001'].display_name === 'Test Alpha',
      `got ${byLicense['TEST-001'].display_name}`);
    check('display_name: embedded DBA beats two-words (TEST-002)',
      byLicense['TEST-002'].display_name === 'Beta Home Health',
      `got ${byLicense['TEST-002'].display_name}`);
    res = await call('GET', '/agencies?q=beta home');
    list = await res.json();
    check('search matches the DBA / display name too',
      list.length === 1 && list[0].license_number === 'TEST-002');
    res = await call('GET', `/agencies/${alphaId}`);
    check('GET /agencies/:id returns the row',
      res.status === 200 && (await res.json()).license_number === 'TEST-001');
    res = await call('GET', '/agencies/999999');
    check('unknown id → 404', res.status === 404);
    res = await call('GET', '/agencies/primary');
    check('primary is null before any is set', (await res.json()) === null);

    // --- role gating (manager PIN retired 2026-11-02)
    await pool.query("UPDATE users SET role = 'clinician' WHERE email = $1", [CALLER]);
    res = await call('PUT', `/agencies/${alphaId}`, { notes: 'x' });
    let body = await res.json();
    check('PUT as clinician → 403 ROLE_REQUIRED',
      res.status === 403 && body.code === 'ROLE_REQUIRED', `got ${res.status}/${body.code}`);
    res = await call('POST', '/agencies/sync', {});
    check('POST /sync as clinician → 403 ROLE_REQUIRED',
      res.status === 403 && (await res.json()).code === 'ROLE_REQUIRED');
    await pool.query("UPDATE users SET role = 'manager' WHERE email = $1", [CALLER]);

    // --- local fields via API (set primary + notes on TEST-002)
    const beta = await pool.query(
      "SELECT id FROM agencies WHERE license_number = 'TEST-002'",
    );
    const betaId = beta.rows[0].id;
    res = await call('PUT', `/agencies/${betaId}`,
      { is_primary: true, notes: 'Preferred partner' }, MANAGER_PIN);
    body = await res.json();
    check('PUT local fields with PIN → 200, values saved',
      res.status === 200 && body.is_primary === true && body.notes === 'Preferred partner',
      `got ${res.status}`);
    res = await call('GET', '/agencies/primary');
    check('GET /primary returns TEST-002',
      (await res.json()).license_number === 'TEST-002');
    res = await call('PUT', `/agencies/${alphaId}`,
      { short_name: 'AlphaCare' }, MANAGER_PIN);
    body = await res.json();
    check('PUT short_name → display_name uses it first',
      res.status === 200 && body.short_name === 'AlphaCare' && body.display_name === 'AlphaCare',
      `got ${res.status} ${JSON.stringify(body.display_name)}`);

    // --- sync v2: update + insert + deactivate; locals survive
    sum = await syncAgencies(pool, {
      sampleRows: FIXTURE_V2, sampleSourceUpdatedAt: S2,
      actor: { uid: 'test', email: CALLER }, trigger: 'test',
    });
    check('v2 sync: 1 inserted / 2 updated / 1 deactivated',
      sum.inserted === 1 && sum.updated === 2 && sum.deactivated === 1,
      JSON.stringify(sum));
    r = await pool.query(
      "SELECT * FROM agencies WHERE license_number = 'TEST-003'",
    );
    check('absent agency deactivated, not deleted',
      r.rows.length === 1 && r.rows[0].active === false);
    r = await pool.query(
      "SELECT * FROM agencies WHERE license_number = 'TEST-002'",
    );
    check('local notes + is_primary survive a re-sync',
      r.rows[0].notes === 'Preferred partner' && r.rows[0].is_primary === true);
    r = await pool.query(
      "SELECT phone FROM agencies WHERE license_number = 'TEST-001'",
    );
    check('source-field change applied by v2', r.rows[0].phone === '(555) 010-9999');
    r = await pool.query(
      "SELECT short_name FROM agencies WHERE license_number = 'TEST-001'",
    );
    check('local short_name survives a re-sync', r.rows[0].short_name === 'AlphaCare');
    res = await call('GET', `/agencies/${alphaId}`);
    check('display_name still the short_name after re-sync',
      (await res.json()).display_name === 'AlphaCare');
    res = await call('GET', '/agencies?active=false');
    list = await res.json();
    check('?active=false shows the deactivated row',
      list.length === 1 && list[0].license_number === 'TEST-003');

    // --- sync status endpoint reflects the v2 run
    res = await call('GET', '/agencies/sync-status');
    body = await res.json();
    check('sync-status shows last full sync counts',
      body && body.skipped_no_change === 0 && body.inserted === 1
        && body.source_updated_at === S2 && !!body.last_run_at,
      JSON.stringify(body));

    // --- primary exclusivity through the API
    res = await call('PUT', `/agencies/${alphaId}`, { is_primary: true }, MANAGER_PIN);
    check('setting primary on TEST-001 → 200', res.status === 200);
    r = await pool.query('SELECT license_number FROM agencies WHERE is_primary = true');
    check('exactly one primary, now TEST-001',
      r.rows.length === 1 && r.rows[0].license_number === 'TEST-001');

    // --- source fields are read-only through the API
    res = await call('PUT', `/agencies/${alphaId}`, { name: 'Hacked Name' }, MANAGER_PIN);
    check('PUT with only a source field → 400 VALIDATION', res.status === 400);
    res = await call('PUT', `/agencies/${alphaId}`, { notes: 'ok', name: 'Hacked Name' }, MANAGER_PIN);
    body = await res.json();
    check('PUT notes + source field → notes saved, name untouched',
      res.status === 200 && body.notes === 'ok' && body.name !== 'Hacked Name');
    res = await call('PUT', `/agencies/${alphaId}`, { is_primary: 'yes' }, MANAGER_PIN);
    check('non-boolean is_primary → 400', res.status === 400);

    // --- fake fetchImpl: live-path code (metadata + paging) w/o network
    const S3_EPOCH = Math.floor(Date.parse(S3) / 1000);
    const ALL_FIVE = [...FIXTURE_V2, srow('TEST-003', 'Test Gamma Home Health, LLC'), srow('TEST-005', 'Test Epsilon Home Health, LLC')];
    const fakeFetch = async (url) => {
      if (url.includes('/api/views/')) {
        return { ok: true, status: 200, json: async () => ({ rowsUpdatedAt: S3_EPOCH }) };
      }
      if (url.includes('/resource/')) {
        return { ok: true, status: 200, json: async () => ALL_FIVE };
      }
      throw new Error(`unexpected url ${url}`);
    };
    sum = await syncAgencies(pool, {
      fetchImpl: fakeFetch,
      actor: { uid: 'test', email: CALLER }, trigger: 'test',
    });
    check('fake-fetch sync: TEST-005 inserted, absent none deactivated',
      sum.inserted === 1 && sum.deactivated === 0 && sum.fetched === 5,
      JSON.stringify(sum));
    r = await pool.query(
      "SELECT active FROM agencies WHERE license_number = 'TEST-003'",
    );
    check('reappearing agency is reactivated', r.rows[0].active === true);
    sum = await syncAgencies(pool, {
      fetchImpl: fakeFetch,
      actor: { uid: 'test', email: CALLER }, trigger: 'test',
    });
    check('fake-fetch re-run with same stamp → skip', sum.skipped_no_change === 1);

    // --- CMS enrichment pass (schema-agencies-cms.sql)
    const S4 = '2099-04-01T00:00:00.000Z';
    const ALL_FIVE_ROWS = ALL_FIVE;
    function crow(ccn, name, phone, zip, extra = {}) {
      return {
        state: 'IL',
        cms_certification_number_ccn: ccn,
        provider_name: name,
        address: '1 CMS Way',
        citytown: 'Springfield',
        zip_code: zip,
        telephone_number: phone,
        type_of_ownership: 'PROPRIETARY',
        offers_nursing_care_services: 'Yes',
        offers_physical_therapy_services: 'Yes',
        offers_occupational_therapy_services: 'No',
        offers_speech_pathology_services: 'No',
        offers_medical_social_services: 'Yes',
        offers_home_health_aide_services: 'Yes',
        certification_date: '03/15/2010',
        quality_of_patient_care_star_rating: '4.5',
        footnote_for_quality_of_patient_care_star_rating: '-',
        ...extra,
      };
    }
    // A: phone+zip → TEST-001 (its v2 phone is (555) 010-9999).
    // B: DBA name+zip → TEST-002 (phone deliberately different).
    // C: phone (555) 010-1000 + zip 62704 is shared by TEST-002/
    //    003/004/005 → ambiguous, must be skipped, never guessed.
    // D: nothing matches → unmatched.
    const CMS_ROWS = [
      crow('149001', 'SOME OTHER NAME', '5550109999', '62704'),
      crow('149002', 'BETA HOME HEALTH', '5550107777', '62704', {
        quality_of_patient_care_star_rating: '-',
        offers_medical_social_services: 'No',
        certification_date: '07/01/2015',
      }),
      crow('149003', 'AMBIGUOUS CARE', '5550101000', '62704'),
      crow('149004', 'NO SUCH AGENCY', '5550100000', '60601'),
    ];
    sum = await syncAgencies(pool, {
      sampleRows: ALL_FIVE_ROWS, sampleSourceUpdatedAt: S4,
      sampleCmsRows: CMS_ROWS,
      actor: { uid: 'test', email: CALLER }, trigger: 'test',
    });
    check('CMS pass: 4 rows / 2 matched / 2 unmatched (ambiguous + no-match)',
      sum.cms_rows === 4 && sum.cms_matched === 2 && sum.cms_unmatched === 2,
      JSON.stringify(sum));
    r = await pool.query(
      "SELECT * FROM agencies WHERE license_number = 'TEST-001'",
    );
    const cert = await pool.query(
      "SELECT to_char(cms_cert_date, 'YYYY-MM-DD') AS d FROM agencies WHERE license_number = 'TEST-001'",
    );
    check('phone+zip match stored: ccn, rating 4.5, services, cert date',
      r.rows[0].ccn === '149001'
        && r.rows[0].star_rating === '4.5'
        && r.rows[0].offers_pt === true && r.rows[0].offers_ot === false
        && r.rows[0].offers_msw === true
        && cert.rows[0].d === '2010-03-15'
        && r.rows[0].cms_matched_at !== null,
      JSON.stringify(r.rows[0]));
    check('local fields survive the CMS pass',
      r.rows[0].short_name === 'AlphaCare' && r.rows[0].notes === 'ok'
        && r.rows[0].is_primary === true);
    r = await pool.query(
      "SELECT * FROM agencies WHERE license_number = 'TEST-002'",
    );
    check('DBA name+zip match stored; "-" rating → NULL star_rating',
      r.rows[0].ccn === '149002' && r.rows[0].star_rating === null
        && r.rows[0].offers_msw === false);
    r = await pool.query("SELECT COUNT(*)::int AS n FROM agencies WHERE ccn = '149003'");
    check('ambiguous CMS row attached to nobody', r.rows[0].n === 0);

    // --- API filters over the CMS fields
    res = await call('GET', '/agencies?service=pt');
    list = await res.json();
    check('?service=pt → both CMS-matched agencies',
      list.length === 2
        && list.every((a) => a.offers_pt === true),
      `got ${list.length}`);
    res = await call('GET', '/agencies?service=msw');
    list = await res.json();
    check('?service=msw → only TEST-001',
      list.length === 1 && list[0].license_number === 'TEST-001');
    res = await call('GET', '/agencies?service=pt,ot');
    list = await res.json();
    check('?service=pt,ot → ALL required, so none (both lack OT)',
      list.length === 0, `got ${list.length}`);
    res = await call('GET', '/agencies?service=bogus');
    check('unknown service → 400 VALIDATION',
      res.status === 400 && (await res.json()).code === 'VALIDATION');
    res = await call('GET', '/agencies?min_rating=4');
    list = await res.json();
    check('?min_rating=4 → only the 4.5 agency (unrated excluded)',
      list.length === 1 && list[0].license_number === 'TEST-001'
        && list[0].star_rating === '4.5');
    res = await call('GET', '/agencies?min_rating=5');
    list = await res.json();
    check('?min_rating=5 → none', list.length === 0);
    res = await call('GET', '/agencies?min_rating=abc');
    check('non-numeric min_rating → 400', res.status === 400);

    // --- CMS pass is idempotent (IDPH skips on same stamp,
    // CMS re-runs and lands on the same values)
    sum = await syncAgencies(pool, {
      sampleRows: ALL_FIVE_ROWS, sampleSourceUpdatedAt: S4,
      sampleCmsRows: CMS_ROWS,
      actor: { uid: 'test', email: CALLER }, trigger: 'test',
    });
    check('re-run: IDPH skipped, CMS matched counts identical',
      sum.skipped_no_change === 1 && sum.cms_matched === 2 && sum.cms_unmatched === 2,
      JSON.stringify(sum));
    r = await pool.query(
      "SELECT ccn, star_rating FROM agencies WHERE license_number = 'TEST-001'",
    );
    check('values unchanged after re-run',
      r.rows[0].ccn === '149001' && r.rows[0].star_rating === '4.5');

    // --- events: one per run, counts only
    res = await call('GET', '/events?event=agency_sync&limit=100', undefined);
    const syncEvents = await res.json();
    check('exactly 7 agency_sync events (v1, skip, v2, fake, fake-skip, cms, cms-rerun)',
      Array.isArray(syncEvents) && syncEvents.length === 7,
      `got ${Array.isArray(syncEvents) ? syncEvents.length : 'n/a'}`);
    check('latest sync event carries the CMS counts',
      syncEvents[0].details.cms_rows === 4
        && syncEvents[0].details.cms_matched === 2
        && syncEvents[0].details.cms_unmatched === 2,
      JSON.stringify(syncEvents[0]?.details));
    check('sync event details carry counts only, no agency names',
      syncEvents.every((e) => !JSON.stringify(e.details).includes('Test Alpha')
        && typeof e.details.fetched === 'number'));
    res = await call('GET', '/events?event=admin_action&limit=100', undefined);
    const actions = await res.json();
    // The authorizing manager is whoever's PIN matched — on a
    // shared test DB another suite's leftover manager can hold
    // the same demo PIN (documented cross-suite contamination),
    // so assert the event names A manager, not necessarily ours.
    check('agency_update admin_action events name the manager',
      actions.some((e) => e.details?.action === 'agency_update'
        && typeof e.details?.manager_email === 'string'
        && e.details.manager_email.length > 0
        && Number.isInteger(Number(e.details?.agency_id))));
  } finally {
    await cleanup();
    server.close();
    await pool.end();
  }
  console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILURES`} (${passed} passed)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
