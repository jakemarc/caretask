// E2E suite for the phone contacts sync (CardDAV) — spec:
// carddav-contacts-sync-spec.md. Runs against a REAL local
// Radicale (scratch venv) + a FRESH database (full schema chain
// + schema-platform.sql + schema-contact-sync.sql; the suite
// inserts everything it needs). Mounts the real routers with a
// stub auth keyed by the x-test-user header.
//
//   PGHOST=/tmp/pgtest PGPORT=54399 PGUSER=postgres \
//   PGDATABASE=caretask_demo \
//   CARDDAV_BASE_URL=http://127.0.0.1:52329 \
//   CARDDAV_SYNC_USER=ctsync CARDDAV_SYNC_PASSWORD=test-sync-pass \
//   CARDDAV_HTPASSWD_PATH=/tmp/radicale-test/htpasswd \
//   CARDDAV_PUBLIC_URL=https://contacts.example.test \
//   node e2e-contact-sync-test.js
const express = require('express');
const fs = require('fs');
const pool = require('./db');
const { requireStaff } = require('./lib/platform');
const { buildVCard, contentHash } = require('./lib/vcard');
const contactSyncRouter = require('./routes/contactSync');
const patientsRouter = require('./routes/patients');

const PORT = 3121;
const BASE = `http://127.0.0.1:${PORT}`;
const DAV = process.env.CARDDAV_BASE_URL;

const USERS = {
  cspt: { uid: 'cs-pt-uid', email: 'cspt@example.com' },
  csother: { uid: 'cs-other-uid', email: 'csother@example.com' },
  ghost: { uid: 'cs-ghost-uid', email: 'csghost@example.com' },
};

function stubAuth(req, res, next) {
  const who = USERS[req.headers['x-test-user']] || USERS.cspt;
  req.user = { uid: who.uid, email: who.email };
  next();
}

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
  if (ok) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? ` :: ${JSON.stringify(extra)}` : ''}`); }
}

async function call(method, path, { as = 'cspt', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': as },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { res, json: await res.json().catch(() => null) };
}

async function dav(method, p, user, pass, body) {
  const res = await fetch(DAV + p, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body,
  });
  return { status: res.status, text: await res.text() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ids = {};
let davUser = null;
let davPass = null;
let bookPath = null;

async function setup() {
  for (const [key, role] of [['cspt', 'clinician'], ['csother', 'clinician']]) {
    const r = await pool.query(
      `INSERT INTO users (firebase_uid, email, role, fname, lname, authorized, active)
       VALUES ($1, $2, $3, 'Test', 'User', true, true) RETURNING id`,
      [USERS[key].uid, USERS[key].email, role],
    );
    ids[key] = r.rows[0].id;
  }
  const mk = async (fname, lname, fields) => {
    const r = await pool.query(
      `INSERT INTO patients (fname, lname, phone_cell, phone_home, email, street, city, state, postal_code, country_code, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [fname, lname, fields.cell || null, fields.home || null, fields.email || null,
       fields.street || null, fields.city || null, fields.state || null,
       fields.zip || null, fields.country || null, fields.notes || null],
    );
    return r.rows[0].id;
  };
  ids.p1 = await mk('Synced', 'One', { cell: '312-555-0101', home: '312-555-0102', email: 'one@example.com', street: '1 Main St', city: 'Chicago', state: 'IL', zip: '60601', country: 'US', notes: 'clinical note — must never sync' });
  ids.p2 = await mk('Synced', 'Two', { cell: '312-555-0201' });
  ids.p3 = await mk('Held', 'Three', { cell: '312-555-0301' });
  ids.p4 = await mk('Others', 'Four', { cell: '312-555-0401' });
  const link = (u, p, s) => pool.query(
    'INSERT INTO patient_links (user_id, patient_id, list_status) VALUES ($1, $2, $3)', [u, p, s]);
  await link(ids.cspt, ids.p1, 'active');
  await link(ids.cspt, ids.p2, 'active');
  await link(ids.cspt, ids.p3, 'hold');
  await link(ids.csother, ids.p4, 'active');
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use(stubAuth);
  app.use(requireStaff);
  app.use('/contact-sync', contactSyncRouter);
  app.use('/patients', patientsRouter);
  const server = app.listen(PORT);
  try {
    await setup();

    console.log('— vCard unit checks');
    const probe = { id: 'x', fname: 'A, B', lname: 'C; D', phone_cell: '111', notes: 'n1' };
    const card = buildVCard(probe, '2026-01-01T00:00:00.000Z');
    check('vCard escapes commas/semicolons in names', card.includes('A\\, B') && card.includes('C\\; D'), card);
    check('vCard omits empty fields (no EMAIL/ADR)', !card.includes('EMAIL') && !card.includes('ADR'));
    const h1 = contentHash(probe);
    check('hash stable across note changes', contentHash({ ...probe, notes: 'different' }) === h1);
    check('hash changes when a synced field changes', contentHash({ ...probe, phone_cell: '222' }) !== h1);

    console.log('— status + enable');
    let r = await call('GET', '/contact-sync/me');
    check('me: configured, not enabled', r.json.configured === true && r.json.enabled === false, r.json);
    r = await call('GET', '/contact-sync/me', { as: 'ghost' });
    check('no staff record -> 403', r.res.status === 403, r.res.status);
    r = await call('POST', '/contact-sync/me/enable');
    check('enable -> 201 with one-time password', r.res.status === 201 && Boolean(r.json.password), r.json);
    davPass = r.json.password;
    davUser = r.json.dav_username;
    bookPath = `/${davUser}/caretask/`;
    check('dav username is opaque u<id>', davUser === `u${ids.cspt}`, davUser);
    r = await call('POST', '/contact-sync/me/enable');
    check('second enable -> 409', r.res.status === 409, r.res.status);
    r = await call('GET', '/contact-sync/me');
    check('me: enabled, 2 contacts (actives only)', r.json.enabled === true && r.json.contact_count === 2, r.json);

    console.log('— server state');
    let d = await dav('PROPFIND', bookPath, 'ctsync', 'test-sync-pass');
    check('book lists p1+p2 vcfs', d.text.includes(`${ids.p1}.vcf`) && d.text.includes(`${ids.p2}.vcf`), d.status);
    check('book excludes on-hold p3 and other clinician p4', !d.text.includes(`${ids.p3}.vcf`) && !d.text.includes(`${ids.p4}.vcf`));
    d = await dav('GET', `${bookPath}${ids.p1}.vcf`, davUser, davPass);
    check('clinician can READ own contact', d.status === 200 && d.text.includes('Synced') && d.text.includes('312-555-0101'), d.status);
    check('synced card has email + address', d.text.includes('one@example.com') && d.text.includes('1 Main St'));
    check('clinical note NEVER syncs', !d.text.includes('clinical note'));
    d = await dav('PUT', `${bookPath}${ids.p1}.vcf`, davUser, davPass, 'BEGIN:VCARD\r\nVERSION:3.0\r\nEND:VCARD\r\n');
    check('clinician write is refused (read-only)', d.status === 403, d.status);
    d = await dav('DELETE', `${bookPath}${ids.p1}.vcf`, davUser, davPass);
    check('clinician delete is refused (read-only)', d.status === 403, d.status);
    d = await dav('GET', `${bookPath}${ids.p1}.vcf`, davUser, 'wrong-password');
    check('wrong password -> 401', d.status === 401, d.status);
    d = await dav('PROPFIND', `/u${ids.csother}/caretask/`, davUser, davPass);
    check("clinician cannot read another's book", d.status === 403 || d.status === 404, d.status);

    console.log('— updates flow through');
    await pool.query('UPDATE patients SET phone_cell = $2 WHERE id = $1', [ids.p1, '312-555-9999']);
    r = await call('POST', '/contact-sync/me/sync-now');
    check('sync-now ok', r.json.sync && !r.json.sync.error, r.json);
    d = await dav('GET', `${bookPath}${ids.p1}.vcf`, 'ctsync', 'test-sync-pass');
    check('phone change synced', d.text.includes('312-555-9999'), d.status);
    r = await call('PUT', `/patients/${ids.p3}/link`, { body: { list_status: 'active' } });
    check('link status -> active accepted', r.res.status === 200, r.res.status);
    await call('POST', '/contact-sync/me/sync-now');
    await sleep(2000); // let the debounced poke land too — state must agree
    r = await call('GET', '/contact-sync/me');
    check('p3 joined the book (3 contacts)', r.json.contact_count === 3, r.json);
    r = await call('PUT', `/patients/${ids.p3}/link`, { body: { list_status: 'discharged' } });
    await call('POST', '/contact-sync/me/sync-now');
    await sleep(2000);
    r = await call('GET', '/contact-sync/me');
    check('p3 left the book on discharge (2 contacts)', r.json.contact_count === 2, r.json);
    r = await call('POST', '/patients', { body: { fname: 'Fresh', lname: 'Five', phone_cell: '312-555-0501' } });
    check('create patient -> 201', r.res.status === 201, r.res.status);
    const p5 = r.json.id;
    await call('POST', '/contact-sync/me/sync-now');
    await sleep(2000);
    d = await dav('PROPFIND', bookPath, 'ctsync', 'test-sync-pass');
    check('new patient synced', d.text.includes(`${p5}.vcf`), d.status);

    console.log('— regenerate + disable');
    r = await call('POST', '/contact-sync/me/regenerate-password');
    const newPass = r.json.password;
    check('regenerate returns a new password', r.res.status === 200 && newPass && newPass !== davPass, r.res.status);
    d = await dav('GET', `${bookPath}${ids.p1}.vcf`, davUser, davPass);
    check('old password stops working', d.status === 401, d.status);
    d = await dav('GET', `${bookPath}${ids.p1}.vcf`, davUser, newPass);
    check('new password works immediately', d.status === 200, d.status);
    r = await call('DELETE', '/contact-sync/me');
    check('disable -> 200', r.res.status === 200, r.json);
    d = await dav('PROPFIND', bookPath, 'ctsync', 'test-sync-pass');
    check('book removed server-side', d.status === 404, d.status);
    const ht = fs.readFileSync(process.env.CARDDAV_HTPASSWD_PATH, 'utf8');
    check('htpasswd entry removed', !ht.includes(`${davUser}:`));
    r = await call('GET', '/contact-sync/me');
    check('me: disabled again', r.json.enabled === false, r.json);
    r = await call('POST', '/contact-sync/me/enable');
    check('re-enable after disable works', r.res.status === 201, r.res.status);
    r = await call('DELETE', '/contact-sync/me');
    check('cleanup disable', r.res.status === 200, r.res.status);
  } finally {
    server.close();
    await pool.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => { console.error(e); process.exit(1); });
