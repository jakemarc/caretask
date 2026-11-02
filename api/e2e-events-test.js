// End-to-end test harness for the CareTask audit core — LOCAL TEST ONLY.
//
// What it proves, against a REAL Postgres (schema.sql,
// schema-events.sql, AND schema-patients-v2.sql applied):
//   event_log inserts + retrieval, hash-chain verification passing,
//   tamper detection on COPIES of the tables (the real tables are
//   never weakened — their append-only triggers stay in force),
//   legacy (pre-chain) row handling, /events filters + pagination,
//   client-event validation, request logging (api_request +
//   auth_failure), and fail-closed auth for missing/invalid tokens.
//
// What it does NOT prove (stated plainly, not faked):
// - The real Firebase auth path or the 403 branch (valid token,
//   non-allowlisted email): same limitation as e2e-test.js — minting
//   a real ID token needs the Marc Innotech Firebase project and a
//   signed-in user. The harness mounts routers behind a STUB auth
//   middleware; the production server.js still uses the real
//   requireAuth, and the deploy-time checks in the README cover the
//   real token path.
// - The dashboard UI: the dashboard build (tsc + vite) is run
//   separately; browser rendering of the Audit Log view is a
//   deploy-time check.
//
// Run:  PGHOST=/var/run/postgresql PGUSER=root PGDATABASE=caretask_demo node e2e-events-test.js
// (db.js reads the PG* env vars; the harness binds 127.0.0.1 only.)
// The harness TRUNCATEs event_log, audit_log, and patients at start
// AND end — TEST DATABASE ONLY. After the run, `npm run seed`
// restores the 8 fictional demo patients.
const express = require('express');
const pool = require('./db');
const patientsRouter = require('./routes/patients');
const eventsRouter = require('./routes/events');
const requestLogger = require('./lib/requestLog');
const realRequireAuth = require('./auth');
const { verifyTable } = require('./lib/verifyChain');
const { hashPin } = require('./lib/pin');

const PORT = Number(process.env.E2E_EVENTS_PORT || 3103);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  PASS ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function stubAuth(req, res, next) {
  req.user = { uid: 'test-uid-1', email: 'tester@example.com' };
  next();
}

// Patient update / soft-delete are manager-PIN gated
// (lib/requireManagerPin.js). The harness upserts a test manager with
// this PIN and sends it on the gated calls.
const TEST_PIN = '1357';
const PIN_HEADERS = { 'X-Manager-Pin': TEST_PIN };

async function countEvents(where, params) {
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM event_log ${where}`, params);
  return r.rows[0].n;
}

// Request-log rows are written fire-and-forget on response finish, so
// a fetch that just resolved does NOT guarantee the row has landed
// yet. Poll for the expected row instead of asserting immediately.
async function waitFor(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

// Event count that is stable across two reads 250 ms apart — used
// before "this call added no row" assertions, so an in-flight row
// from an earlier call cannot be mistaken for the new call's row.
async function settledCount() {
  let prev = await countEvents('', []);
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    const next = await countEvents('', []);
    if (next === prev) return next;
    prev = next;
  }
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use(requestLogger(pool));
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/patients', stubAuth, patientsRouter);
  app.use('/events', stubAuth, eventsRouter);

  const authApp = express();
  authApp.use(express.json());
  authApp.use(requestLogger(pool));
  authApp.use('/patients', realRequireAuth, patientsRouter);
  authApp.use('/events', realRequireAuth, eventsRouter);

  const server = await new Promise((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });
  const authServer = await new Promise((resolve) => {
    const s = authApp.listen(PORT + 1, '127.0.0.1', () => resolve(s));
  });
  const AUTH_BASE = `http://127.0.0.1:${PORT + 1}`;

  try {
    await pool.query('TRUNCATE event_log, audit_log, patients CASCADE');

    // Manager PIN gate setup: an active manager whose PIN is TEST_PIN.
    const testPinHash = await hashPin(TEST_PIN);
    await pool.query(
      `INSERT INTO users (email, role, authorized, fname, lname, pin_hash)
       VALUES ('tester@example.com', 'manager', false, 'Test', 'Manager', $1)
       ON CONFLICT (email) DO UPDATE
         SET pin_hash = EXCLUDED.pin_hash, role = 'manager', active = true`,
      [testPinHash],
    );

    // 1. CREATE a patient with multibyte + punctuation content, so the
    //    hash canonicalization is exercised on non-ASCII text.
    console.log('1. create patient (genesis audit row)');
    let res = await fetch(`${BASE}/patients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fname: 'Chain',
        lname: 'Test Person',
        date_of_birth: '1958-04-11',
        sex: 'Female',
        zone: 'yellow',
        notes: 'Zoë test — café note with "quotes" and an emoji-free tail',
        clinician: 'Test Clinician',
        phone_home: '555-0198',
        email: 'chain.test@example.com',
        ss: '900-99-9998',
        status: 'active',
      }),
    });
    const created = await res.json();
    check('create returns 201', res.status === 201, `got ${res.status}`);
    const id = created.id;
    let rows = await pool.query('SELECT * FROM audit_log ORDER BY seq ASC');
    check('one audit row', rows.rows.length === 1, `got ${rows.rows.length}`);
    check(
      'genesis row has a hash and NULL prev_hash',
      rows.rows[0].row_hash !== null && rows.rows[0].prev_hash === null,
    );
    const apiRow = await waitFor(async () => {
      const r = await pool.query(
        `SELECT * FROM event_log WHERE event = 'api_request' AND details->>'path' = '/patients' AND details->>'method' = 'POST'`,
      );
      return r.rows.length === 1 ? r.rows[0] : null;
    });
    check('request logger wrote an api_request row for the create', apiRow !== null);
    check(
      'api_request details hold only method/path/status',
      apiRow !== null &&
        JSON.stringify(Object.keys(apiRow.details).sort()) === '["method","path","status"]' &&
        apiRow.details.status === 201 &&
        apiRow.details.path === '/patients',
    );

    // 2. PATIENT VIEW
    console.log('2. patient view event');
    res = await fetch(`${BASE}/patients/${id}`);
    check('profile returns 200', res.status === 200, `got ${res.status}`);
    rows = await pool.query(
      `SELECT * FROM event_log WHERE event = 'patient_view' AND patient_id = $1`,
      [id],
    );
    check('patient_view row with patient_id + stub actor', rows.rows.length === 1 && rows.rows[0].actor_email === 'tester@example.com', `got ${rows.rows.length}`);

    // 3. POST /events: sign_in, and no double row from request logging.
    console.log('3. client-reported sign_in');
    res = await fetch(`${BASE}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'sign_in', details: { method: 'password' } }),
    });
    const signIn = await res.json();
    check('sign_in returns 201', res.status === 201, `got ${res.status}`);
    check('sign_in row carries the stub actor', signIn.actor_email === 'tester@example.com');
    check(
      'exactly one sign_in row (no request-logger double)',
      (await countEvents(`WHERE event = 'sign_in'`, [])) === 1,
    );

    // 4. POST /events validation.
    console.log('4. POST /events validation');
    res = await fetch(`${BASE}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'patient_view' }),
    });
    check('server event patient_view rejected with 400', res.status === 400, `got ${res.status}`);
    res = await fetch(`${BASE}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'bogus' }),
    });
    check('unknown event rejected with 400', res.status === 400, `got ${res.status}`);
    res = await fetch(`${BASE}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'sign_in', details: ['not', 'an', 'object'] }),
    });
    check('array details rejected with 400', res.status === 400, `got ${res.status}`);
    res = await fetch(`${BASE}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'sign_in', patient_id: 'not-a-uuid' }),
    });
    check('non-UUID patient_id rejected with 400', res.status === 400, `got ${res.status}`);

    // 5. GET /events filters + pagination.
    console.log('5. GET /events filters + pagination');
    res = await fetch(`${BASE}/events?event=patient_view`);
    let list = await res.json();
    check('event filter returns only patient_view rows', list.length >= 1 && list.every((e) => e.event === 'patient_view'), `got ${list.length}`);
    res = await fetch(`${BASE}/events?actor_email=tester`);
    list = await res.json();
    check('actor_email partial match works', list.length >= 1 && list.every((e) => e.actor_email.includes('tester')), `got ${list.length}`);
    res = await fetch(`${BASE}/events?patient_id=${id}`);
    list = await res.json();
    check('patient_id filter returns only that patient', list.length >= 1 && list.every((e) => e.patient_id === id), `got ${list.length}`);
    const today = new Date().toISOString().slice(0, 10);
    res = await fetch(`${BASE}/events?from=${today}`);
    list = await res.json();
    check('from-date filter returns rows', list.length >= 1, `got ${list.length}`);
    res = await fetch(`${BASE}/events?from=2999-01-01`);
    list = await res.json();
    check('future from-date returns empty', list.length === 0, `got ${list.length}`);
    res = await fetch(`${BASE}/events?limit=1`);
    list = await res.json();
    check('limit=1 returns exactly one row', list.length === 1, `got ${list.length}`);
    const firstPageId = list[0].id;
    res = await fetch(`${BASE}/events?limit=1&offset=1`);
    list = await res.json();
    check('offset moves the page', list.length === 1 && list[0].id !== firstPageId, `got ${list.length}`);
    res = await fetch(`${BASE}/events?event=bogus`);
    check('unknown event filter is 400', res.status === 400, `got ${res.status}`);
    res = await fetch(`${BASE}/events?from=not-a-date`);
    check('bad from-date is 400', res.status === 400, `got ${res.status}`);
    res = await fetch(`${BASE}/events`);
    list = await res.json();
    check('unfiltered list is newest first', list.length >= 2 && list[0].seq > list[1].seq, `got ${list.length}`);

    // 6. VERIFY endpoint: both chains valid.
    console.log('6. chain verification endpoint');
    res = await fetch(`${BASE}/events/verify`);
    const verify = await res.json();
    check('verify returns valid audit_log', verify.audit_log && verify.audit_log.valid === true, JSON.stringify(verify.audit_log));
    check('verify returns valid event_log', verify.event_log && verify.event_log.valid === true, JSON.stringify(verify.event_log));
    check('audit_log checked count matches rows', verify.audit_log.checked === 1, `got ${verify.audit_log.checked}`);

    // 7. More mutations deepen the chain; verification still passes.
    console.log('7. chain survives update + soft delete');
    res = await fetch(`${BASE}/patients/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...PIN_HEADERS },
      body: JSON.stringify({ zone: 'red' }),
    });
    check('update returns 200', res.status === 200, `got ${res.status}`);
    res = await fetch(`${BASE}/patients/${id}`, { method: 'DELETE', headers: PIN_HEADERS });
    check('delete returns 204', res.status === 204, `got ${res.status}`);
    res = await fetch(`${BASE}/events/verify`);
    const verify2 = await res.json();
    check('chain valid after 3 audit rows', verify2.audit_log.valid === true && verify2.audit_log.checked === 3, JSON.stringify(verify2.audit_log));
    check('event chain still valid', verify2.event_log.valid === true, JSON.stringify(verify2.event_log));

    // 8. TAMPER DETECTION ON COPIES (never on the real tables).
    console.log('8. tamper detection on copies');
    await pool.query('DROP TABLE IF EXISTS audit_log_copy');
    await pool.query('DROP TABLE IF EXISTS event_log_copy');
    await pool.query('DROP TABLE IF EXISTS audit_log_legacy');
    await pool.query('CREATE TABLE audit_log_copy AS SELECT * FROM audit_log');
    await pool.query('CREATE TABLE event_log_copy AS SELECT * FROM event_log');
    let copyCheck = await verifyTable(pool, 'audit_log_copy', 'audit_log');
    check('untampered audit copy verifies valid', copyCheck.valid === true, JSON.stringify(copyCheck));
    copyCheck = await verifyTable(pool, 'event_log_copy', 'event_log');
    check('untampered event copy verifies valid', copyCheck.valid === true, JSON.stringify(copyCheck));
    // Tamper with a middle row's business field. The middle row is
    // the test-7 update, whose action is ALREADY 'update' — so the
    // tamper must change it to a different value ('restore'), or the
    // UPDATE is a no-op and the hash correctly still verifies.
    await pool.query(
      `UPDATE audit_log_copy SET action = 'restore' WHERE seq = (SELECT MIN(seq) + 1 FROM audit_log_copy)`,
    );
    copyCheck = await verifyTable(pool, 'audit_log_copy', 'audit_log');
    check(
      'edited audit row detected as row_hash mismatch',
      copyCheck.valid === false && copyCheck.first_break && copyCheck.first_break.reason === 'row_hash mismatch',
      JSON.stringify(copyCheck.first_break),
    );
    // Delete the genesis row: the next row's prev_hash no longer matches.
    await pool.query(`DELETE FROM audit_log_copy WHERE seq = (SELECT MIN(seq) FROM audit_log_copy)`);
    copyCheck = await verifyTable(pool, 'audit_log_copy', 'audit_log');
    check(
      'deleted genesis row detected as prev_hash mismatch',
      copyCheck.valid === false && copyCheck.first_break && copyCheck.first_break.reason === 'prev_hash mismatch',
      JSON.stringify(copyCheck.first_break),
    );
    // Event copy: tamper with a details payload.
    await pool.query(
      `UPDATE event_log_copy SET details = '{"method":"GET","path":"/tampered","status":200}' WHERE seq = (SELECT MIN(seq) FROM event_log_copy)`,
    );
    copyCheck = await verifyTable(pool, 'event_log_copy', 'event_log');
    check(
      'edited event row detected as row_hash mismatch',
      copyCheck.valid === false && copyCheck.first_break && copyCheck.first_break.reason === 'row_hash mismatch',
      JSON.stringify(copyCheck.first_break),
    );
    // Legacy handling, simulated the way it really arises: rows that
    // predate chaining (NULL hashes) followed by a first chained row
    // whose prev_hash is NULL — exactly what the trigger produces when
    // every prior row is legacy. The chained row's hash is computed
    // from the row as read back, so the JSONB text is the normalized
    // form the verifier will also see.
    await pool.query('DROP TABLE audit_log_copy');
    await pool.query('CREATE TABLE audit_log_legacy AS SELECT * FROM audit_log WHERE false');
    await pool.query(
      `INSERT INTO audit_log_legacy
         (id, seq, prev_hash, row_hash, patient_id, actor_uid, actor_email, action, changed, created_at)
       VALUES (gen_random_uuid(), 1, NULL, NULL, $1, 'legacy-uid', 'legacy@example.com', 'create', '{"before":null,"after":null}', now()),
              (gen_random_uuid(), 2, NULL, NULL, $1, 'legacy-uid', 'legacy@example.com', 'update', '{"before":null,"after":null}', now())`,
      [id],
    );
    await pool.query(
      `INSERT INTO audit_log_legacy
         (id, seq, prev_hash, row_hash, patient_id, actor_uid, actor_email, action, changed, created_at)
       VALUES (gen_random_uuid(), 3, NULL, NULL, $1, 'test-uid-1', 'tester@example.com', 'update', '{"before":null,"after":null}', now())`,
      [id],
    );
    const chained = await pool.query('SELECT * FROM audit_log_legacy WHERE seq = 3');
    const { canonicalAuditRow, sha256Hex } = require('./lib/hashChain');
    const chainedHash = sha256Hex(canonicalAuditRow(chained.rows[0]));
    await pool.query('UPDATE audit_log_legacy SET row_hash = $1 WHERE seq = 3', [chainedHash]);
    copyCheck = await verifyTable(pool, 'audit_log_legacy', 'audit_log');
    check(
      'legacy prefix skipped, chain valid from first hashed row',
      copyCheck.valid === true && copyCheck.legacy === 2 && copyCheck.checked === 1,
      JSON.stringify(copyCheck),
    );
    await pool.query('DROP TABLE audit_log_legacy');
    await pool.query('DROP TABLE event_log_copy');

    // 9. REAL auth fails closed; auth_failure rows are logged.
    console.log('9. real auth 401 + auth_failure logging');
    res = await fetch(`${AUTH_BASE}/events`);
    check('no-token /events is 401', res.status === 401, `got ${res.status}`);
    res = await fetch(`${AUTH_BASE}/events`, {
      headers: { Authorization: 'Bearer this-is-not-a-real-token' },
    });
    check('garbage-token /events is 401', res.status === 401, `got ${res.status}`);
    const authRow = await waitFor(async () => {
      const r = await pool.query(
        `SELECT * FROM event_log WHERE event = 'auth_failure' ORDER BY seq DESC LIMIT 1`,
      );
      return r.rows.length === 1 ? r.rows[0] : null;
    });
    check(
      'auth_failure row logged with anonymous actor + 401 status',
      authRow !== null &&
        authRow.actor_email === 'anonymous' &&
        authRow.details.status === 401,
      JSON.stringify(authRow && authRow.details),
    );

    // 10. /health is not logged; api_request details stay minimal.
    console.log('10. health exclusion + minimal request details');
    const before = await settledCount();
    res = await fetch(`${BASE}/health`);
    check('health returns 200', res.status === 200, `got ${res.status}`);
    const after = await settledCount();
    check('health call added no event row', after === before, `before=${before} after=${after}`);
    rows = await pool.query(
      `SELECT details FROM event_log WHERE event = 'api_request' ORDER BY seq DESC LIMIT 1`,
    );
    check(
      'no token or body material in api_request details',
      rows.rows.length === 1 &&
        !JSON.stringify(rows.rows[0].details).toLowerCase().includes('bearer') &&
        JSON.stringify(Object.keys(rows.rows[0].details).sort()) === '["method","path","status"]',
    );

    // 11. Append-only triggers still guard event_log too.
    console.log('11. event_log append-only triggers');
    let blocked = false;
    try {
      await pool.query(`UPDATE event_log SET event = 'sign_in' WHERE event = 'api_request'`);
    } catch (err) {
      blocked = /append-only/.test(err.message);
    }
    check('UPDATE event_log is rejected', blocked);
    blocked = false;
    try {
      await pool.query(`DELETE FROM event_log WHERE event = 'api_request'`);
    } catch (err) {
      blocked = /append-only/.test(err.message);
    }
    check('DELETE FROM event_log is rejected', blocked);

    console.log(failures === 0 ? '\nALL EVENTS E2E CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  } finally {
    await pool.query('DROP TABLE IF EXISTS audit_log_copy').catch(() => {});
    await pool.query('DROP TABLE IF EXISTS event_log_copy').catch(() => {});
    await pool.query('DROP TABLE IF EXISTS audit_log_legacy').catch(() => {});
    await pool.query('TRUNCATE event_log, audit_log, patients CASCADE').catch(() => {});
    server.close();
    authServer.close();
    await pool.end();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('events e2e harness error:', err);
  process.exit(1);
});
