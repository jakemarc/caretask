// End-to-end test harness for appointment SERIES (Jake,
// 2026-11-02) — LOCAL TEST ONLY.
//
// What it proves, against a REAL Postgres (all schemas incl.
// schema-appointment-series.sql applied):
//   POST /appointments/series creates N rows in one act sharing
//   one series_id, ends = starts + duration_min, status
//   defaulting to 'scheduled'; empty visits → 400
//   SERIES_VISITS_REQUIRED; 61 visits → 400 SERIES_TOO_LARGE;
//   missing patient on an appointment category →
//   PATIENT_REQUIRED; bad duration → 400. GET list rows carry
//   series_id. PUT /series/:id applies field edits to every
//   live member (ungated) and 404s an unknown series. DELETE
//   /:id removes one member; DELETE /:id?scope=series removes
//   the rest and reports the count. Manager role required for
//   deletes (deploy-26 model).
//
// Run:  PGDATABASE=caretask_demo node e2e-series-test.js
const express = require('express');
const pool = require('./db');
const appointmentsRouter = require('./routes/appointments');
const eventsRouter = require('./routes/events');

const PORT = Number(process.env.E2E_PORT || 3117);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  PASS ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function stubAuth(req, res, next) {
  req.user = { uid: 'test-uid-1', email: 'tester@example.com' };
  next();
}

const call = (method, path, body) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const day = (offset, h, m = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(h, m, 0, 0);
  return d;
};

let patientId;
let providerId;
let catId;

async function setup() {
  await pool.query(
    `INSERT INTO users (email, role, authorized, active, fname, lname)
     VALUES ('tester@example.com', 'clinician', false, true, 'Test', 'Caller')
     ON CONFLICT (email) DO UPDATE SET role = 'clinician', active = true`,
  );
  const prov = await pool.query(
    `INSERT INTO users (email, role, authorized, active, fname, lname)
     VALUES ('series-prov@example.com', 'clinician', true, true, 'Pat', 'Provider')
     ON CONFLICT (email) DO UPDATE SET active = true RETURNING id`,
  );
  providerId = prov.rows[0].id;
  const c1 = await pool.query(
    `INSERT INTO appointment_categories (name, color, cattype, default_duration_min)
     VALUES ('Test Follow-up', '#2563eb', 'appointment', 45)
     ON CONFLICT (name) DO UPDATE SET active = true RETURNING id`,
  );
  catId = c1.rows[0].id;
  await pool.query(
    `INSERT INTO appointment_statuses (code, label, color, is_checkin, is_checkout, sort_order)
     VALUES ('scheduled', 'Scheduled', '#d97706', false, false, 1)
     ON CONFLICT (code) DO NOTHING`,
  );
  const p1 = await pool.query(
    `INSERT INTO patients (fname, lname) VALUES ('Series', 'Patient') RETURNING id`,
  );
  patientId = p1.rows[0].id;
  // Platform fixture (2026-11-03): bookings now require an active
  // episode whose team includes the provider. Give the patient an
  // episode at a test agency; provider is primary, caller a member.
  const ag = await pool.query(
    `INSERT INTO agencies (license_number, name) VALUES ('E2E-SERIES', 'Series Test Agency')
     ON CONFLICT (license_number) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
  );
  const tester = await pool.query(
    `SELECT id FROM users WHERE email = 'tester@example.com'`,
  );
  for (const uid of [providerId, tester.rows[0].id]) {
    await pool.query(
      `INSERT INTO user_agencies (user_id, agency_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [uid, ag.rows[0].id],
    );
  }
  const ep = await pool.query(
    `INSERT INTO patient_episodes (patient_id, agency_id, primary_user_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [patientId, ag.rows[0].id, providerId],
  );
  await pool.query(
    `INSERT INTO episode_members (episode_id, user_id, member_role, added_by)
     VALUES ($1, $2, 'primary', $2), ($1, $3, 'member', $2)
     ON CONFLICT DO NOTHING`,
    [ep.rows[0].id, providerId, tester.rows[0].id],
  );
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/appointments', stubAuth, appointmentsRouter);
  app.use('/events', stubAuth, eventsRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    await setup();
    const visits = [day(1, 11), day(3, 11), day(5, 11)].map((d) => d.toISOString());
    const base = {
      patient_id: patientId,
      provider_id: providerId,
      category_id: catId,
      duration_min: 45,
      visits,
    };

    // --- create
    let r = await call('POST', '/appointments/series', base);
    const created = await r.json();
    check('series create → 201', r.status === 201, `got ${r.status} ${JSON.stringify(created)}`);
    check('series_id is a uuid', /^[0-9a-f-]{36}$/i.test(created.series_id ?? ''));
    check('3 appointments created', created.appointments?.length === 3);
    check(
      'every member carries the series_id',
      created.appointments?.every((a) => a.series_id === created.series_id),
    );
    check(
      'ends = starts + 45m, status scheduled',
      created.appointments?.every(
        (a) =>
          +new Date(a.ends_at) - +new Date(a.starts_at) === 45 * 60000 &&
          a.status === 'scheduled',
      ),
    );
    const seriesId = created.series_id;
    const memberIds = created.appointments.map((a) => a.id);

    // --- validation
    r = await call('POST', '/appointments/series', { ...base, visits: [] });
    check('empty visits → 400 SERIES_VISITS_REQUIRED',
      r.status === 400 && (await r.json()).code === 'SERIES_VISITS_REQUIRED');
    r = await call('POST', '/appointments/series', {
      ...base,
      visits: Array.from({ length: 61 }, (_, i) => day(i + 1, 9).toISOString()),
    });
    check('61 visits → 400 SERIES_TOO_LARGE',
      r.status === 400 && (await r.json()).code === 'SERIES_TOO_LARGE');
    r = await call('POST', '/appointments/series', { ...base, patient_id: null });
    check('no patient → 400 PATIENT_REQUIRED',
      r.status === 400 && (await r.json()).code === 'PATIENT_REQUIRED');
    r = await call('POST', '/appointments/series', { ...base, duration_min: 0 });
    check('duration 0 → 400', r.status === 400);

    // --- list carries series_id
    const from = day(0, 0).toISOString();
    const to = day(7, 0).toISOString();
    r = await call('GET', `/appointments?from=${from}&to=${to}&patient_id=${patientId}`);
    const list = await r.json();
    check('list rows carry series_id',
      list.appointments?.filter((a) => a.series_id === seriesId).length === 3);

    // --- series field edit (ungated)
    r = await call('PUT', `/appointments/series/${seriesId}`, { notes: 'Series note' });
    const upd = await r.json();
    check('series PUT → 200 with 3 rows',
      r.status === 200 && upd.appointments?.length === 3, `got ${r.status}`);
    check('notes applied to all members',
      upd.appointments?.every((a) => a.notes === 'Series note'));
    r = await call('PUT', '/appointments/series/not-a-uuid', { notes: 'x' });
    check('series PUT bad id → 400', r.status === 400);
    r = await call('PUT', '/appointments/series/11111111-1111-1111-1111-111111111111', { notes: 'x' });
    check('series PUT unknown → 404', r.status === 404);

    // --- deletes need the manager role
    r = await call('DELETE', `/appointments/${memberIds[0]}`);
    check('delete as clinician → 403', r.status === 403, `got ${r.status}`);
    await pool.query("UPDATE users SET role = 'manager' WHERE email = 'tester@example.com'");
    r = await call('DELETE', `/appointments/${memberIds[0]}`);
    check('delete one member → 200', r.status === 200, `got ${r.status}`);
    r = await call('DELETE', `/appointments/${memberIds[1]}?scope=series`);
    const del = await r.json();
    check('delete with scope=series → 200, count 2',
      r.status === 200 && del.appointment?.series_deleted_count === 2,
      JSON.stringify(del));
    const left = await pool.query(
      'SELECT count(*)::int AS n FROM appointments WHERE series_id = $1 AND deleted_at IS NULL',
      [seriesId],
    );
    check('no live members remain', left.rows[0].n === 0);

    // --- events
    r = await call('GET', '/events?limit=50');
    const events = await r.json();
    const arr = Array.isArray(events) ? events : events.events;
    check('series update event logged',
      arr?.some((e) => e.details?.action === 'appointment_series_update' && e.details?.series_id === seriesId));
    check('series delete event logged',
      arr?.some((e) => e.details?.action === 'appointment_series_delete' && e.details?.series_id === seriesId));
  } finally {
    server.close();
    await pool.end();
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
