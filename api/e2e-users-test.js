// End-to-end test harness for the users table + manager PIN override
// (CareTask demo API) — LOCAL TEST ONLY.
//
// What it proves, against a REAL Postgres (schema.sql,
// schema-events.sql, schema-patients-v2.sql, AND schema-users.sql
// applied):
//   users directory endpoints (list / me / clinicians) never expose
//   pin_hash; the role and lowercase-email CHECKs reject bad rows at
//   the database level; patient PUT / DELETE / restore are gated by a
//   manager PIN checked SERVER-side — missing PIN → 403 PIN_REQUIRED,
//   wrong PIN → 403 PIN_INVALID, a PIN belonging to an INACTIVE
//   manager → 403, a valid manager OR admin PIN → the write succeeds;
//   each successful override writes an admin_action event naming the
//   manager whose PIN was used; POST /users/verify-pin agrees with
//   the gate; the scrypt hash/verify roundtrip works and rejects a
//   wrong PIN.
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
    // Setup staff.
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
    check('patient created (create is not PIN gated)', res.status === 201, `got ${res.status}`);
    const id = patient.id;

    // 5. PUT gate.
    console.log('4. PUT /patients/:id PIN gate');
    const put = (headers) =>
      fetch(`${BASE}/patients/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ notes: 'via override' }),
      });
    res = await put({});
    let body = await res.json();
    check('PUT without PIN is 403 PIN_REQUIRED', res.status === 403 && body.code === 'PIN_REQUIRED', `got ${res.status}/${body.code}`);
    res = await put({ 'X-Manager-Pin': '0000' });
    body = await res.json();
    check('PUT with wrong PIN is 403 PIN_INVALID', res.status === 403 && body.code === 'PIN_INVALID', `got ${res.status}/${body.code}`);
    res = await put({ 'X-Manager-Pin': INACTIVE_PIN });
    body = await res.json();
    check('PUT with inactive manager PIN is 403 PIN_INVALID', res.status === 403 && body.code === 'PIN_INVALID', `got ${res.status}/${body.code}`);
    res = await put({ 'X-Manager-Pin': MANAGER_PIN });
    check('PUT with manager PIN succeeds', res.status === 200, `got ${res.status}`);
    res = await put({ 'X-Manager-Pin': ADMIN_PIN });
    check('PUT with admin PIN succeeds', res.status === 200, `got ${res.status}`);

    // 6. Override attribution in the event log.
    console.log('5. override attribution');
    res = await fetch(`${BASE}/events?event=admin_action&patient_id=${id}`);
    const events = await res.json();
    const updates = events.filter((e) => e.details?.action === 'patient_update');
    check('two patient_update admin_action events logged', updates.length === 2, `got ${updates.length}`);
    check(
      'events name the authorizing managers',
      updates.some((e) => e.details.manager_email === 'mgr@example.com') &&
        updates.some((e) => e.details.manager_email === 'adm@example.com'),
    );

    // 7. verify-pin endpoint agrees with the gate.
    console.log('6. POST /users/verify-pin');
    res = await fetch(`${BASE}/users/verify-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: MANAGER_PIN }),
    });
    body = await res.json();
    check('verify-pin accepts manager PIN + names the manager', res.status === 200 && body.ok === true && body.manager?.name === 'Manny Manager', `got ${res.status}`);
    res = await fetch(`${BASE}/users/verify-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '0000' }),
    });
    check('verify-pin rejects wrong PIN', res.status === 403, `got ${res.status}`);

    // 8. DELETE + restore gates.
    console.log('7. DELETE / restore PIN gates');
    res = await fetch(`${BASE}/patients/${id}`, { method: 'DELETE' });
    check('DELETE without PIN is 403', res.status === 403, `got ${res.status}`);
    res = await fetch(`${BASE}/patients/${id}`, { method: 'DELETE', headers: { 'X-Manager-Pin': MANAGER_PIN } });
    check('DELETE with manager PIN is 204', res.status === 204, `got ${res.status}`);
    res = await fetch(`${BASE}/patients/${id}/restore`, { method: 'POST' });
    check('restore without PIN is 403', res.status === 403, `got ${res.status}`);
    res = await fetch(`${BASE}/patients/${id}/restore`, { method: 'POST', headers: { 'X-Manager-Pin': ADMIN_PIN } });
    check('restore with admin PIN is 200', res.status === 200, `got ${res.status}`);
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
