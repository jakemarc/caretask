// E2E suite for the admin site API (spec: admin-site-spec.md
// §4 + §7). This suite is the BUILD CONTRACT for
// routes/admin.js: it was written from the spec before the
// router exists, and the build is done when it passes.
//
// Exercises: the platform-admin gate matrix (no staff record
// / inactive record / clinician / manager -> 403; developer
// and admin -> 200), GET /admin/overview aggregates against
// exact fixtures (patients, users by role, links by status,
// episodes, appointments by day window, agencies, pending
// invites, contact-sync states, backup freshness), and
// GET /admin/users per-user aggregates (links by status,
// episode roles, appointment totals, sync state, last
// activity) including the never-leak-pin_hash rule.
//
// Build requirements this suite pins down:
// - routes/admin.js exports an Express router for /admin and
//   applies the admin gate INSIDE the router via
//   requireRole('admin', 'developer') (the invites-router
//   precedent), so it mounts behind plain auth like its
//   siblings.
// - The overview's backup check reads the directory named
//   by ADMIN_BACKUPS_DIR when set (production leaves it
//   unset and uses /home/jakemarc2/backups), reports the
//   newest file by mtime as { filename, size_bytes, mtime },
//   and reports latest: null when the directory is missing
//   or empty.
// - Overview day boundaries use the database's CURRENT_DATE
//   (appointments.today = starts_at on CURRENT_DATE;
//   next_7d = CURRENT_DATE .. CURRENT_DATE + 7 days).
// - /admin/overview contact_sync lists only users who have
//   a user_contact_sync row.
// - /admin/users contact_sync is null for users with no
//   sync row; last_event_at is the newest event_log row for
//   the user's email, or null.
//
// Like the other suites: SINGLE-RUN against a FRESH database
// (full schema chain + schema-platform.sql +
// schema-contact-sync.sql; the suite inserts everything it
// needs). Mounts the real routers with a stub auth keyed by
// the x-test-user header. (A missing/invalid Firebase token
// -> 401 is production auth's job and is covered by the
// live checks, not this harness.)
//
//   PGHOST=/tmp/pgtest PGPORT=54399 PGUSER=postgres \
//   PGDATABASE=caretask_demo node e2e-admin-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

// Set BEFORE the admin router is required, in case it reads
// configuration at load time.
const BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-test-backups-'));
process.env.ADMIN_BACKUPS_DIR = BACKUP_DIR;

let adminRouter;
if (!fs.existsSync(path.join(__dirname, 'routes', 'admin.js'))) {
  console.error('routes/admin.js is not built yet — this suite is its build contract (admin-site-spec.md §7).');
  process.exit(2);
}
adminRouter = require('./routes/admin');

const express = require('express');
const pool = require('./db');
const invitesRouter = require('./routes/invites');
const { insertEvent } = require('./lib/eventLog');

const PORT = 3122;
const BASE = `http://127.0.0.1:${PORT}`;

const USERS = {
  admin: { uid: 'ad-admin-uid', email: 'adadmin@example.com' },
  dev: { uid: 'ad-dev-uid', email: 'addev@example.com' },
  mgr: { uid: 'ad-mgr-uid', email: 'admgr@example.com' },
  pt: { uid: 'ad-pt-uid', email: 'adpt@example.com' },
  off: { uid: 'ad-off-uid', email: 'adoff@example.com' },
  ghost: { uid: 'ad-ghost-uid', email: 'adghost@example.com' },
};

function stubAuth(req, res, next) {
  const who = USERS[req.headers['x-test-user']] || USERS.pt;
  req.user = { uid: who.uid, email: who.email };
  next();
}

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
  if (ok) {
    passed++;
    console.log(`  ok - ${name}`);
  } else {
    failed++;
    console.log(`  FAIL - ${name}${extra ? ` :: ${JSON.stringify(extra)}` : ''}`);
  }
}

async function call(method, p, { as = 'admin', body } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': as },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { res, json: await res.json().catch(() => null) };
}

const ids = {};

async function setup() {
  const staff = [
    ['admin', 'admin', true],
    ['dev', 'developer', true],
    ['mgr', 'manager', true],
    ['pt', 'clinician', true],
    ['off', 'clinician', false],
  ];
  for (const [key, role, active] of staff) {
    const r = await pool.query(
      `INSERT INTO users (firebase_uid, email, role, fname, lname, authorized, active)
       VALUES ($1, $2, $3, 'Test', 'User', true, $4) RETURNING id`,
      [USERS[key].uid, USERS[key].email, role, active],
    );
    ids[key] = r.rows[0].id;
  }

  const ag = await pool.query(
    `INSERT INTO agencies (license_number, name, city) VALUES ('ADM-A', 'Admin Test Agency', 'Chicago') RETURNING id`,
  );
  ids.agency = ag.rows[0].id;

  for (const n of ['One', 'Two', 'Three', 'Four']) {
    const r = await pool.query(
      `INSERT INTO patients (fname, lname) VALUES ('Pat', $1) RETURNING id`,
      [n],
    );
    ids[`p${n === 'One' ? 1 : n === 'Two' ? 2 : n === 'Three' ? 3 : 4}`] = r.rows[0].id;
  }

  const link = async (userKey, patientKey, status) => {
    await pool.query(
      `INSERT INTO patient_links (user_id, patient_id, list_status) VALUES ($1, $2, $3)`,
      [ids[userKey], ids[patientKey], status],
    );
  };
  await link('admin', 'p1', 'active');
  await link('admin', 'p2', 'active');
  await link('admin', 'p3', 'discharged');
  await link('pt', 'p1', 'active');
  await link('pt', 'p4', 'hold');

  const ep = await pool.query(
    `INSERT INTO patient_episodes (patient_id, agency_id, primary_user_id, case_manager_user_id, status)
     VALUES ($1, $2, $3, $3, 'active') RETURNING id`,
    [ids.p1, ids.agency, ids.pt],
  );
  ids.episode = ep.rows[0].id;
  await pool.query(
    `INSERT INTO episode_members (episode_id, user_id, member_role) VALUES ($1, $2, 'primary')`,
    [ids.episode, ids.pt],
  );

  const cat = await pool.query(
    `INSERT INTO appointment_categories (name, color, cattype, default_duration_min)
     VALUES ('Revisit', '#2563eb', 'appointment', 45) RETURNING id`,
  );
  await pool.query(
    `INSERT INTO appointment_statuses (code, label, color, sort_order) VALUES ('scheduled', 'Scheduled', '#d97706', 1)
     ON CONFLICT (code) DO NOTHING`,
  );
  const book = async (dayOffset) => {
    await pool.query(
      `INSERT INTO appointments (patient_id, provider_id, category_id, starts_at, ends_at, status, episode_id)
       VALUES ($1, $2, $3,
               (CURRENT_DATE + ($4)::int + TIME '15:00'), (CURRENT_DATE + ($4)::int + TIME '15:45'),
               'scheduled', $5)`,
      [ids.p1, ids.pt, cat.rows[0].id, dayOffset, ids.episode],
    );
  };
  await book(0);
  await book(3);

  // Phone-sync state for pt only: enabled, two synced items.
  await pool.query(
    `INSERT INTO user_contact_sync (user_id, dav_username, enabled, book_path, last_sync_at, last_result)
     VALUES ($1, $2, true, $3, now(), 'ok')`,
    [ids.pt, `u${ids.pt}`, `/u${ids.pt}/caretask/`],
  );
  for (const pk of ['p1', 'p4']) {
    await pool.query(
      `INSERT INTO contact_sync_items (user_id, patient_id, dav_href, dav_etag, content_hash)
       VALUES ($1, $2, $3, 'etag-x', 'hash-x')`,
      [ids.pt, ids[pk], `/u${ids.pt}/caretask/${ids[pk]}.vcf`],
    );
  }

  // One event for pt so last_event_at has something to find.
  await insertEvent(pool, {
    actor: { uid: USERS.pt.uid, email: USERS.pt.email },
    event: 'contact_sync',
    details: { action: 'test_fixture' },
  });

  // Backup fixtures: the 1104 file is the newest by mtime.
  const older = path.join(BACKUP_DIR, 'caretask-20261103-000000.dump');
  const newer = path.join(BACKUP_DIR, 'caretask-20261104-000000.dump');
  fs.writeFileSync(older, 'x'.repeat(100));
  fs.writeFileSync(newer, 'x'.repeat(1234));
  fs.utimesSync(older, new Date('2026-11-03T08:15:00Z'), new Date('2026-11-03T08:15:00Z'));
  fs.utimesSync(newer, new Date('2026-11-04T08:15:00Z'), new Date('2026-11-04T08:15:00Z'));
}

async function main() {
  await setup();

  const app = express();
  app.use(express.json());
  app.use('/admin', stubAuth, adminRouter);
  app.use('/invites', stubAuth, invitesRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: 'internal', detail: String(err && err.message) }));
  const server = app.listen(PORT);

  try {
    console.log('— the admin gate');
    for (const p of ['/admin/overview', '/admin/users']) {
      let r = await call('GET', p, { as: 'ghost' });
      check(`${p}: no staff record -> 403 NO_STAFF_RECORD`, r.res.status === 403 && r.json?.code === 'NO_STAFF_RECORD', r.json);
      r = await call('GET', p, { as: 'off' });
      check(`${p}: inactive staff -> 403 NO_STAFF_RECORD`, r.res.status === 403 && r.json?.code === 'NO_STAFF_RECORD', r.json);
      r = await call('GET', p, { as: 'pt' });
      check(`${p}: clinician -> 403 ROLE_REQUIRED`, r.res.status === 403 && r.json?.code === 'ROLE_REQUIRED', r.json);
      r = await call('GET', p, { as: 'mgr' });
      check(`${p}: manager -> 403 ROLE_REQUIRED`, r.res.status === 403 && r.json?.code === 'ROLE_REQUIRED', r.json);
      r = await call('GET', p, { as: 'dev' });
      check(`${p}: developer -> 200`, r.res.status === 200, r.res.status);
      r = await call('GET', p, { as: 'admin' });
      check(`${p}: admin -> 200`, r.res.status === 200, r.res.status);
    }

    console.log('— overview aggregates');
    const ov = (await call('GET', '/admin/overview')).json;
    check('overview.generated_at is a timestamp string', typeof ov.generated_at === 'string' && !Number.isNaN(Date.parse(ov.generated_at)), ov.generated_at);
    check('patients.total = 4', ov.patients?.total === 4, ov.patients);
    check('patients.created_last_30d = 4', ov.patients?.created_last_30d === 4, ov.patients);
    check('users.total = 5, active = 4', ov.users?.total === 5 && ov.users?.active === 4, ov.users);
    check('users.by_role counts', ov.users?.by_role?.admin === 1 && ov.users?.by_role?.developer === 1 && ov.users?.by_role?.manager === 1 && ov.users?.by_role?.clinician === 2, ov.users?.by_role);
    check('links = 3 active / 1 hold / 1 discharged', ov.links?.active === 3 && ov.links?.hold === 1 && ov.links?.discharged === 1, ov.links);
    check('episodes = 1 active / 0 on hold', ov.episodes?.active === 1 && ov.episodes?.on_hold === 0, ov.episodes);
    check('appointments = 1 today / 2 next 7d / 2 total', ov.appointments?.today === 1 && ov.appointments?.next_7d === 2 && ov.appointments?.total === 2, ov.appointments);
    check('agencies.total = 1', ov.agencies?.total === 1, ov.agencies);
    check('invites.pending = 0 before any invite', ov.invites?.pending === 0, ov.invites);
    const syncRow = (ov.contact_sync || []).find((s) => s.user_id === Number(ids.pt) || s.email === USERS.pt.email);
    check('contact_sync lists only the pt row', Array.isArray(ov.contact_sync) && ov.contact_sync.length === 1 && Boolean(syncRow), ov.contact_sync);
    check('contact_sync row: enabled, 2 items, last_result ok', syncRow?.enabled === true && syncRow?.items === 2 && syncRow?.last_result === 'ok', syncRow);
    check('backups.latest = newest fixture file', ov.backups?.latest?.filename === 'caretask-20261104-000000.dump' && ov.backups?.latest?.size_bytes === 1234, ov.backups);
    check('auth_failures_24h is a number (0 in this harness)', typeof ov.auth_failures_24h === 'number' && ov.auth_failures_24h === 0, ov.auth_failures_24h);
    check('recent_errors is an array', Array.isArray(ov.recent_errors), ov.recent_errors);

    console.log('— invites flow through to the overview');
    const inv = await call('POST', '/invites', { as: 'admin', body: { email: 'invited@example.com', role: 'clinician' } });
    check('admin creates an invite (201)', inv.res.status === 201, inv.res.status);
    const ov2 = (await call('GET', '/admin/overview')).json;
    check('invites.pending = 1 after create', ov2.invites?.pending === 1, ov2.invites);

    console.log('— users aggregates');
    const list = (await call('GET', '/admin/users')).json;
    const rows = Array.isArray(list) ? list : list.users;
    check('users list returns all 5 staff rows', Array.isArray(rows) && rows.length === 5, rows?.length);
    check('no pin_hash anywhere in the payload', !JSON.stringify(list).includes('pin_hash'));
    const byEmail = (e) => rows.find((u) => u.email === e);
    const ptRow = byEmail(USERS.pt.email);
    check('pt links = 1 active / 1 hold / 0 discharged', ptRow?.links?.active === 1 && ptRow?.links?.hold === 1 && ptRow?.links?.discharged === 0, ptRow?.links);
    check('pt episodes_primary = 1, case_manager = 1', ptRow?.episodes_primary === 1 && ptRow?.episodes_case_manager === 1, ptRow);
    check('pt appointments_total = 2', ptRow?.appointments_total === 2, ptRow?.appointments_total);
    check('pt contact_sync = enabled, 2 items', ptRow?.contact_sync?.enabled === true && ptRow?.contact_sync?.items === 2, ptRow?.contact_sync);
    check('pt last_event_at is set', typeof ptRow?.last_event_at === 'string', ptRow?.last_event_at);
    const adminRow = byEmail(USERS.admin.email);
    check('admin links = 2 active / 0 hold / 1 discharged', adminRow?.links?.active === 2 && adminRow?.links?.hold === 0 && adminRow?.links?.discharged === 1, adminRow?.links);
    check('admin contact_sync is null (never enabled)', adminRow?.contact_sync === null, adminRow?.contact_sync);
    check('admin last_event_at set by the invite create', typeof adminRow?.last_event_at === 'string', adminRow?.last_event_at);
    const mgrRow = byEmail(USERS.mgr.email);
    check('mgr links all zero, last_event_at null', mgrRow?.links?.active === 0 && mgrRow?.links?.hold === 0 && mgrRow?.links?.discharged === 0 && mgrRow?.last_event_at === null, mgrRow);
    const offRow = byEmail(USERS.off.email);
    check('inactive staff still listed, active = false', offRow?.active === false, offRow?.active);
  } finally {
    server.close();
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
