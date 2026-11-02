// End-to-end test harness for staff management writes on the users
// table (CareTask demo API) — LOCAL TEST ONLY.
//
// What it proves, against a REAL Postgres (schema.sql,
// schema-events.sql, schema-patients-v2.sql, AND schema-users.sql
// applied):
//   POST /users, PUT /users/:id, DELETE /users/:id (deactivate) and
//   POST /users/:id/restore are ALL gated by the CALLER's role
//   (manager/admin) since the manager PIN was retired on
//   2026-11-02 — a clinician caller → 403 ROLE_REQUIRED; create
//   validates required fields, lowercase email, the role list, and
//   strict booleans; duplicate email → 409 EMAIL_EXISTS (create AND
//   update); a pin field on a write is IGNORED (pin_hash never
//   exposed, has_pin stays false) and /users/verify-pin is retired
//   (404); deactivation removes the member from /users/clinicians
//   and a second deactivate is a 404; a user cannot deactivate their
//   own account (400 SELF_DEACTIVATE); restore reactivates and a
//   second restore is a 409; every successful write logs an
//   admin_action event naming the target and the acting manager.
//
// Same stub-auth caveat as the other harnesses: req.user is
// injected, the real Firebase path is a deploy-time check.
//
// Run:  PGDATABASE=caretask_demo node e2e-users-mgmt-test.js
const express = require('express');
const pool = require('./db');
const usersRouter = require('./routes/users');
const eventsRouter = require('./routes/events');
const { hashPin } = require('./lib/pin');

const PORT = Number(process.env.E2E_PORT || 3104);
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

const post = (path, body, pin) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(pin ? { 'X-Manager-Pin': pin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/users', stubAuth, usersRouter);
  app.use('/events', stubAuth, eventsRouter);

  const server = await new Promise((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    // Cleanup from any earlier run of this harness (the suites share
    // one local database; fixed test emails must not collide with a
    // previous pass, and the caller's own row must not leak into the
    // users suite's /users/me expectation).
    await pool.query(
      `DELETE FROM users WHERE email IN
       ('tester@example.com', 'mgmt-new@example.com', 'mgmt-boss@example.com')`,
    );

    // Setup: the authorizing manager, plus the caller's own row (for
    // the self-deactivation guard).
    await upsertUser({ email: 'mgr@example.com', role: 'manager', authorized: false, fname: 'Manny', lname: 'Manager', pin: MANAGER_PIN });
    await upsertUser({ email: 'tester@example.com', role: 'manager', authorized: false, fname: 'Test', lname: 'Caller', pin: '8642' });

    // 1. Create gate: the caller's role, not a PIN.
    console.log('1. POST /users role gate');
    await pool.query("UPDATE users SET role = 'clinician' WHERE email = 'tester@example.com'");
    let res = await post('/users', { email: 'mgmt-new@example.com', fname: 'New', lname: 'Person' });
    let body = await res.json();
    check('create as clinician is 403 ROLE_REQUIRED', res.status === 403 && body.code === 'ROLE_REQUIRED', `got ${res.status}/${body.code}`);
    await pool.query("UPDATE users SET role = 'manager' WHERE email = 'tester@example.com'");

    // 2. Create validation.
    console.log('2. POST /users validation');
    res = await post('/users', { email: 'mgmt-new@example.com', fname: 'New' }, MANAGER_PIN);
    check('create without lname is 400', res.status === 400, `got ${res.status}`);
    res = await post('/users', { email: 'UPPER@example.com', fname: 'Up', lname: 'Per' }, MANAGER_PIN);
    check('create with uppercase email is 400', res.status === 400, `got ${res.status}`);
    res = await post('/users', { email: 'mgmt-new@example.com', fname: 'New', lname: 'Person', role: 'superuser' }, MANAGER_PIN);
    check('create with bad role is 400', res.status === 400, `got ${res.status}`);
    res = await post('/users', { email: 'mgmt-new@example.com', fname: 'New', lname: 'Person', authorized: 'yes' }, MANAGER_PIN);
    check('create with non-boolean authorized is 400', res.status === 400, `got ${res.status}`);

    // 3. Create success + duplicate.
    console.log('3. POST /users success');
    res = await post('/users', { email: 'mgmt-new@example.com', fname: 'New', lname: 'Person', role: 'clinician', authorized: true, specialty: 'PT' }, MANAGER_PIN);
    body = await res.json();
    check('create as manager is 201', res.status === 201, `got ${res.status}`);
    check('created row hides pin_hash, has_pin=false', body && !('pin_hash' in body) && body.has_pin === false && body.active === true);
    const newId = body.id;
    res = await post('/users', { email: 'mgmt-new@example.com', fname: 'Dupe', lname: 'Person' }, MANAGER_PIN);
    body = await res.json();
    check('duplicate email is 409 EMAIL_EXISTS', res.status === 409 && body.code === 'EMAIL_EXISTS', `got ${res.status}/${body.code}`);

    // 4. A pin field at create is ignored; verify-pin is retired.
    console.log('4. pin field ignored');
    res = await post('/users', { email: 'mgmt-boss@example.com', fname: 'Bea', lname: 'Boss', role: 'manager', pin: '7777' }, MANAGER_PIN);
    body = await res.json();
    check('manager created with a pin field: has_pin stays false', res.status === 201 && body.has_pin === false, `got ${res.status}`);
    res = await post('/users/verify-pin', { pin: '7777' });
    check('verify-pin endpoint is retired (404)', res.status === 404, `got ${res.status}`);

    // 5. Update gate + success + PIN set at update.
    console.log('5. PUT /users/:id');
    await pool.query("UPDATE users SET role = 'clinician' WHERE email = 'tester@example.com'");
    res = await fetch(`${BASE}/users/${newId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ specialty: 'OT' }),
    });
    body = await res.json();
    check('update as clinician is 403 ROLE_REQUIRED', res.status === 403 && body.code === 'ROLE_REQUIRED', `got ${res.status}/${body.code}`);
    await pool.query("UPDATE users SET role = 'manager' WHERE email = 'tester@example.com'");
    res = await fetch(`${BASE}/users/${newId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ specialty: 'OT', pin: '3333' }),
    });
    body = await res.json();
    check('update as manager succeeds; pin field ignored', res.status === 200 && body.specialty === 'OT' && body.has_pin === false, `got ${res.status}`);
    res = await fetch(`${BASE}/users/${newId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Manager-Pin': MANAGER_PIN },
      body: JSON.stringify({ email: 'mgmt-boss@example.com' }),
    });
    body = await res.json();
    check('update to a taken email is 409 EMAIL_EXISTS', res.status === 409 && body.code === 'EMAIL_EXISTS', `got ${res.status}/${body.code}`);
    res = await fetch(`${BASE}/users/999999`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Manager-Pin': MANAGER_PIN },
      body: JSON.stringify({ specialty: 'PT' }),
    });
    check('update of missing member is 404', res.status === 404, `got ${res.status}`);

    // 6. Deactivate.
    console.log('6. DELETE /users/:id (deactivate)');
    await pool.query("UPDATE users SET role = 'clinician' WHERE email = 'tester@example.com'");
    res = await fetch(`${BASE}/users/${newId}`, { method: 'DELETE' });
    body = await res.json();
    check('deactivate as clinician is 403 ROLE_REQUIRED', res.status === 403 && body.code === 'ROLE_REQUIRED', `got ${res.status}/${body.code}`);
    await pool.query("UPDATE users SET role = 'manager' WHERE email = 'tester@example.com'");
    res = await fetch(`${BASE}/users/clinicians`);
    body = await res.json();
    check('clinicians list includes the new clinician before deactivate', body.some((u) => u.email === 'mgmt-new@example.com'));
    res = await fetch(`${BASE}/users/${newId}`, { method: 'DELETE' });
    check('deactivate as manager is 204', res.status === 204, `got ${res.status}`);
    res = await fetch(`${BASE}/users/clinicians`);
    body = await res.json();
    check('clinicians list excludes the deactivated clinician', !body.some((u) => u.email === 'mgmt-new@example.com'));
    res = await fetch(`${BASE}/users/${newId}`, { method: 'DELETE' });
    check('second deactivate is 404', res.status === 404, `got ${res.status}`);

    // 7. Self-deactivation guard.
    console.log('7. self-deactivation guard');
    res = await fetch(`${BASE}/users`);
    body = await res.json();
    const self = body.find((u) => u.email === 'tester@example.com');
    res = await fetch(`${BASE}/users/${self.id}`, { method: 'DELETE' });
    body = await res.json();
    check('deactivating your own account is 400 SELF_DEACTIVATE', res.status === 400 && body.code === 'SELF_DEACTIVATE', `got ${res.status}/${body.code}`);

    // 8. Restore.
    console.log('8. POST /users/:id/restore');
    await pool.query("UPDATE users SET role = 'clinician' WHERE email = 'tester@example.com'");
    res = await post(`/users/${newId}/restore`);
    body = await res.json();
    check('restore as clinician is 403 ROLE_REQUIRED', res.status === 403 && body.code === 'ROLE_REQUIRED', `got ${res.status}/${body.code}`);
    await pool.query("UPDATE users SET role = 'manager' WHERE email = 'tester@example.com'");
    res = await post(`/users/${newId}/restore`);
    body = await res.json();
    check('restore as manager reactivates', res.status === 200 && body.active === true, `got ${res.status}`);
    res = await post(`/users/${newId}/restore`);
    check('second restore is 409', res.status === 409, `got ${res.status}`);

    // 9. Attribution: one admin_action event per successful write.
    console.log('9. admin_action attribution');
    res = await fetch(`${BASE}/events?event=admin_action&limit=200`);
    body = await res.json();
    const mine = body.filter((e) => e.details?.target_email === 'mgmt-new@example.com');
    const actions = mine.map((e) => e.details.action);
    check(
      'user_create/update/deactivate/reactivate all logged',
      ['user_create', 'user_update', 'user_deactivate', 'user_reactivate'].every((a) => actions.includes(a)),
      `got ${actions.join(',')}`,
    );
    check(
      'events name the acting manager',
      mine.every((e) => e.details.manager_email === 'tester@example.com'),
    );
  } finally {
    // Leave the shared local DB as this harness found it: remove the
    // rows it created (event_log rows naming them stay — the log is
    // append-only by design and details are just JSON).
    await pool.query(
      `DELETE FROM users WHERE email IN
       ('tester@example.com', 'mgmt-new@example.com', 'mgmt-boss@example.com')`,
    ).catch(() => {});
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
