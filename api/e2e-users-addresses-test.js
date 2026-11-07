// End-to-end test harness for PUT /users/me/addresses (deploy-40)
// — LOCAL TEST ONLY.
//
// What it proves, against a REAL Postgres (schema chain through
// schema-users-office.sql applied):
//   the self-service address write round-trips BOTH blocks (home
//   on street/city/state/zip, office on office_*); GET /users/me
//   carries the office_* columns; values are trimmed and a blank
//   string or explicit null clears to NULL; a non-string value is
//   a 400; an empty body is a 400; unknown body fields are ignored
//   by the whitelist (a smuggled role change does not land); a
//   caller with no staff row gets 403 NO_STAFF_RECORD; the write
//   is me-scoped — another clinician's row is untouched; the
//   admin_action event names the touched field names but never an
//   address value; and the manager-gated PUT /users/:id can also
//   set office_* (WRITABLE whitelist).
//
// Stub auth keyed by the x-test-user header, same as the platform
// suite: req.user is injected; the real Firebase path is a
// deploy-time check.
//
// Run:  PGDATABASE=caretask_test node e2e-users-addresses-test.js
const express = require('express');
const pool = require('./db');
const usersRouter = require('./routes/users');
const eventsRouter = require('./routes/events');

const PORT = 3119;
const BASE = `http://127.0.0.1:${PORT}`;

const USERS = {
  a: { uid: 'addr-uid-a', email: 'addr-a@example.com' },
  b: { uid: 'addr-uid-b', email: 'addr-b@example.com' },
  mgr: { uid: 'addr-uid-mgr', email: 'addr-mgr@example.com' },
  ghost: { uid: 'addr-uid-ghost', email: 'addr-ghost@example.com' },
};

function stubAuth(req, res, next) {
  const who = USERS[req.headers['x-test-user']] || USERS.a;
  req.user = { uid: who.uid, email: who.email };
  next();
}

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
  if (ok) {
    passed += 1;
    console.log(`  ok - ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL - ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

async function api(method, path, as, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': as },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave null */
  }
  return { status: res.status, json };
}

async function seedUser({ email, uid, role }) {
  await pool.query(
    `INSERT INTO users (email, firebase_uid, role, authorized, active, fname, lname)
     VALUES ($1, $2, $3, true, true, 'Test', 'Person')
     ON CONFLICT (email) DO UPDATE SET
       firebase_uid = EXCLUDED.firebase_uid, role = EXCLUDED.role,
       active = true, street = NULL, city = NULL, state = NULL, zip = NULL,
       office_street = NULL, office_city = NULL, office_state = NULL,
       office_zip = NULL`,
    [email, uid, role],
  );
}

async function cleanup() {
  await pool.query(
    "DELETE FROM users WHERE email LIKE 'addr-%@example.com'",
  );
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/users', stubAuth, usersRouter);
  app.use('/events', stubAuth, eventsRouter);

  const server = await new Promise((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    await cleanup();
    await seedUser({ email: USERS.a.email, uid: USERS.a.uid, role: 'clinician' });
    await seedUser({ email: USERS.b.email, uid: USERS.b.uid, role: 'clinician' });
    await seedUser({ email: USERS.mgr.email, uid: USERS.mgr.uid, role: 'manager' });

    console.log('1. home block round-trip');
    const home = {
      street: '  1200 W Example Ave  ',
      city: 'Chicago',
      state: 'IL',
      zip: '60601',
    };
    const r1 = await api('PUT', '/users/me/addresses', 'a', home);
    check('PUT home returns 200', r1.status === 200, `got ${r1.status}`);
    check('street stored trimmed', r1.json?.street === '1200 W Example Ave', r1.json?.street);
    check('city/state/zip stored', r1.json?.city === 'Chicago' && r1.json?.state === 'IL' && r1.json?.zip === '60601');
    check('office still null', r1.json?.office_street === null && r1.json?.office_city === null);
    check('response is the caller row', r1.json?.email === USERS.a.email);
    check('no pin_hash in response', r1.json && !('pin_hash' in r1.json));

    const me1 = await api('GET', '/users/me', 'a');
    check('GET /users/me carries home', me1.json?.street === '1200 W Example Ave');
    check('GET /users/me carries office_* keys', me1.json && 'office_street' in me1.json && 'office_zip' in me1.json);

    console.log('2. office block round-trip');
    const office = {
      office_street: '4500 S Office Blvd',
      office_city: 'Oak Lawn',
      office_state: 'IL',
      office_zip: '60453',
    };
    const r2 = await api('PUT', '/users/me/addresses', 'a', office);
    check('PUT office returns 200', r2.status === 200, `got ${r2.status}`);
    check('office stored', r2.json?.office_street === '4500 S Office Blvd' && r2.json?.office_city === 'Oak Lawn' && r2.json?.office_state === 'IL' && r2.json?.office_zip === '60453');
    check('home untouched by office write', r2.json?.street === '1200 W Example Ave');

    console.log('3. clearing: blank string and explicit null');
    const r3 = await api('PUT', '/users/me/addresses', 'a', { office_zip: '   ' });
    check('blank string clears to null', r3.status === 200 && r3.json?.office_zip === null);
    const r4 = await api('PUT', '/users/me/addresses', 'a', { office_city: null });
    check('explicit null clears', r4.status === 200 && r4.json?.office_city === null);
    check('other office fields survive a partial clear', r4.json?.office_street === '4500 S Office Blvd');

    console.log('4. validation');
    const r5 = await api('PUT', '/users/me/addresses', 'a', { zip: 60601 });
    check('non-string value -> 400 VALIDATION', r5.status === 400 && r5.json?.code === 'VALIDATION', `got ${r5.status}`);
    const r6 = await api('PUT', '/users/me/addresses', 'a', {});
    check('empty body -> 400 VALIDATION', r6.status === 400 && r6.json?.code === 'VALIDATION', `got ${r6.status}`);
    const r7 = await api('PUT', '/users/me/addresses', 'a', { role: 'admin', street: '1 Smuggle Way' });
    check('unknown fields ignored (role unchanged)', r7.status === 200 && r7.json?.role === 'clinician' && r7.json?.street === '1 Smuggle Way', `role=${r7.json?.role}`);

    console.log('5. auth + me-scoping');
    const r8 = await api('PUT', '/users/me/addresses', 'ghost', { street: '9 Nowhere Ln' });
    check('no staff record -> 403 NO_STAFF_RECORD', r8.status === 403 && r8.json?.code === 'NO_STAFF_RECORD', `got ${r8.status}`);
    const brow = await pool.query(
      'SELECT street, office_street FROM users WHERE email = $1',
      [USERS.b.email],
    );
    check("another clinician's row untouched", brow.rows[0]?.street === null && brow.rows[0]?.office_street === null);
    const meB = await api('GET', '/users/me', 'b');
    check("B's /users/me still has null addresses", meB.json?.street === null && meB.json?.office_street === null);

    console.log('6. event logging carries field names, never values');
    const ev = await pool.query(
      `SELECT details FROM event_log
        WHERE event = 'admin_action' AND actor_email = $1
        ORDER BY seq DESC LIMIT 1`,
      [USERS.a.email],
    );
    const details = ev.rows[0]?.details ?? {};
    check('admin_action user_update event exists', details.action === 'user_update');
    check('event names the touched fields', Array.isArray(details.fields) && details.fields.includes('street'));
    check('event carries no address value', !JSON.stringify(details).includes('Smuggle') && !JSON.stringify(details).includes('Office Blvd'));

    console.log('7. manager-gated PUT /users/:id accepts office_* (WRITABLE)');
    const bRow = await pool.query('SELECT id FROM users WHERE email = $1', [USERS.b.email]);
    const r9 = await api('PUT', `/users/${bRow.rows[0].id}`, 'mgr', { office_city: 'Tinley Park' });
    check('manager PUT returns 200', r9.status === 200, `got ${r9.status}`);
    check('office_city written via WRITABLE', r9.json?.office_city === 'Tinley Park');
  } finally {
    await cleanup();
    server.close();
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await cleanup();
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
