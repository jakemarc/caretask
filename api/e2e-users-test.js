// End-to-end test harness for the users table + the ROLE gates
// that replaced the manager PIN on 2026-11-02 (CareTask demo API) —
// LOCAL TEST ONLY.
//
// What it proves, against a REAL Postgres (schema.sql,
// schema-events.sql, schema-patients-v2.sql, AND schema-users.sql
// applied):
//   users directory endpoints (list / me / clinicians) never expose
//   pin_hash; the role and lowercase-email CHECKs reject bad rows at
//   the database level; patient PUT is NOT gated (clinicians edit
//   their own patients; a stray PIN header is ignored) while DELETE
//   / restore require the CALLER to be an active manager/admin —
//   no staff row → 403 NO_STAFF_RECORD, clinician → 403
//   ROLE_REQUIRED, manager → the write succeeds; each patient
//   update writes an admin_action event naming the editing actor;
//   POST /users/verify-pin is retired (404); the scrypt hash/verify
//   roundtrip in lib/pin.js (still used by the seed script) works
//   and rejects a wrong PIN.
//
// Same stub-auth caveat as e2e-test.js: req.user is injected, the real
// Firebase path is a deploy-time check.
//
// Run:  PGDATABASE=caretask_demo node e2e-users-test.js
const express = require('express');
const pool = require('./db');
const patientsRouter = require('./routes/patients');
const usersRouter = require('./routes/users');
const eventsRouter = require('./routes/events');
const { hashPin, verifyPin } = require('./lib/pin');

const PORT = Number(process.env.E2E_PORT || 3103);
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

const MANAGER_PIN = '2468';
const ADMIN_PIN = '9753';
const INACTIVE_PIN = '5555';

async function upsertUser({ email, role, authorized, fname, lname, pin, active = true }) {
  const pinHash = pin ? await hashPin(pin) : null;
  await pool.query(
    `INSERT INTO users (email, role, authorized, active, fname, lname, pin_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (email) DO UPDATE SET
       role = EXCLUDED.role, authorized = EXCLUDED.authorized,
       active = EXCLUDED.active, pin_hash = EXCLUDED.pin_hash`,
    [email, role, authorized, active, fname, lname, pinHash],
  );
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/patients', stubAuth, patientsRouter);
  app.use('/users', stubAuth, usersRouter);
  app.use('/events', stubAuth, eventsRouter);

  const server = await new Promise((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    // Setup staff. Other suites share this database and may have
    // left a tester@example.com row; this suite's actor must start
    // with NO staff row.
    await pool.query("DELETE FROM users WHERE email = 'tester@example.com'");
    await upsertUser({ email: 'mgr@example.com', role: 'manager', authorized: false, fname: 'Manny', lname: 'Manager', pin: MANAGER_PIN });
    await upsertUser({ email: 'adm@example.com', role: 'admin', authorized: true, fname: 'Ada', lname: 'Admin', pin: ADMIN_PIN });
    await upsertUser({ email: 'gone@example.com', role: 'manager', authorized: false, fname: 'Ina', lname: 'Ctive', pin: INACTIVE_PIN, active: false });
    await upsertUser({ email: 'clin@example.com', role: 'clinician', authorized: true, fname: 'Clara', lname: 'Clinician' });
    await upsertUser({ email: 'desk@example.com', role: 'front_office', authorized: false, fname: 'Fran', lname: 'Frontdesk' });

    // 1. PIN hash roundtrip (unit-level).
    console.log('1. pin hashing');
    const h = await hashPin('4321');
    check('hash is not the plaintext', h !== '4321' && h.startsWith('scrypt$'));
    check('verify accepts the right PIN', await verifyPin('4321', h));
    check('verify rejects a wrong PIN', !(await verifyPin('0000', h)));

    // 2. Directory endpoints.
    console.log('2. users endpoints');
    let res = await fetch(`${BASE}/users`);
    const users = await res.json();
    check('GET /users returns seeded staff', res.status === 200 && users.length >= 5, `got ${res.status}/${users.length}`);
    check('GET /users never exposes pin_hash', users.every((u) => !('pin_hash' in u)));
    const mgr = users.find((u) => u.email === 'mgr@example.com');
    check('manager row carries has_pin=true', mgr && mgr.has_pin === true);
    const clin = users.find((u) => u.email === 'clin@example.com');
    check('clinician row carries has_pin=false', clin && clin.has_pin === false);
    res = await fetch(`${BASE}/users/me`);
    const me = await res.json();
    check('GET /users/me is null for a user with no row', me === null);
    res = await fetch(`${BASE}/users/clinicians`);
    const clinicians = await res.json();
    check(
      'GET /users/clinicians lists authorized+active only',
      clinicians.some((u) => u.email === 'clin@example.com') &&
        clinicians.some((u) => u.email === 'adm@example.com') &&
        !clinicians.some((u) => u.email === 'desk@example.com') &&
        !clinicians.some((u) => u.email === 'gone@example.com'),
    );

    // 3. Schema CHECKs.
    console.log('3. users schema checks');
    let threw = false;
    try {
      await pool.query(
        `INSERT INTO users (email, role, fname, lname) VALUES ('bad@example.com', 'superuser', 'Bad', 'Role')`,
      );
    } catch { threw = true; }
    check('invalid role rejected by CHECK', threw);
    threw = false;
    try {
      await pool.query(
        `INSERT INTO users (email, role, fname, lname) VALUES ('UPPER@example.com', 'clinician', 'Up', 'Per')`,
      );
    } catch { threw = true; }
    check('uppercase email rejected by CHECK', threw);

    // 4. A patient to operate on.
    res = await fetch(`${BASE}/patients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fname: 'Pin', lname: 'Gate',
        date_of_birth: '1962-09-19', sex: 'Male',
      }),
    });
    const patient = await res.json();
    check('patient created (create is not gated)', res.status === 201, `got ${res.status}`);
    const id = patient.id;

    // 5. PUT is NOT gated (the PIN was retired on 2026-11-02;
    // clinicians manage their own patients).
    console.log('4. PUT /patients/:id (ungated)');
    const put = (headers) =>
      fetch(`${BASE}/patients/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ notes: 'clinician edit' }),
      });
    res = await put({});
    check('PUT with no staff row succeeds', res.status === 200, `got ${res.status}`);
    res = await put({ 'X-Manager-Pin': '0000' });
    check('PUT ignores a stray PIN header', res.status === 200, `got ${res.status}`);

    // 6. Attribution in the event log.
    console.log('5. update attribution');
    res = await fetch(`${BASE}/events?event=admin_action&patient_id=${id}`);
    const events = await res.json();
    const updates = events.filter((e) => e.details?.action === 'patient_update');
    check('two patient_update admin_action events logged', updates.length === 2, `got ${updates.length}`);
    check(
      'events name the editing actor',
      updates.every((e) => e.details.manager_email === 'tester@example.com'),
    );

    // 7. verify-pin endpoint is retired with the PIN.
    console.log('6. POST /users/verify-pin (retired)');
    res = await fetch(`${BASE}/users/verify-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: MANAGER_PIN }),
    });
    check('verify-pin is gone (404)', res.status === 404, `got ${res.status}`);

    // 8. DELETE + restore are gated by the CALLER's role.
    console.log('7. DELETE / restore role gates');
    let body;
    res = await fetch(`${BASE}/patients/${id}`, { method: 'DELETE' });
    body = await res.json();
    check('DELETE with no staff row is 403 NO_STAFF_RECORD', res.status === 403 && body.code === 'NO_STAFF_RECORD', `got ${res.status}/${body.code}`);
    await upsertUser({ email: 'tester@example.com', role: 'clinician', authorized: true, fname: 'Test', lname: 'Caller' });
    res = await fetch(`${BASE}/patients/${id}`, { method: 'DELETE' });
    body = await res.json();
    check('DELETE as clinician is 403 ROLE_REQUIRED', res.status === 403 && body.code === 'ROLE_REQUIRED', `got ${res.status}/${body.code}`);
    await upsertUser({ email: 'tester@example.com', role: 'manager', authorized: false, fname: 'Test', lname: 'Caller' });
    res = await fetch(`${BASE}/patients/${id}`, { method: 'DELETE' });
    check('DELETE as manager is 204', res.status === 204, `got ${res.status}`);
    await upsertUser({ email: 'tester@example.com', role: 'clinician', authorized: true, fname: 'Test', lname: 'Caller' });
    res = await fetch(`${BASE}/patients/${id}/restore`, { method: 'POST' });
    body = await res.json();
    check('restore as clinician is 403 ROLE_REQUIRED', res.status === 403 && body.code === 'ROLE_REQUIRED', `got ${res.status}/${body.code}`);
    await upsertUser({ email: 'tester@example.com', role: 'admin', authorized: true, fname: 'Test', lname: 'Caller' });
    res = await fetch(`${BASE}/patients/${id}/restore`, { method: 'POST' });
    check('restore as admin is 200', res.status === 200, `got ${res.status}`);
  } finally {
    server.close();
    await pool.end();
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('harness error:', err);
  process.exit(1);
});
