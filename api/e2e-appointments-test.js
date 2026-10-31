// End-to-end test harness for the appointments (calendar) routes —
// LOCAL TEST ONLY. Model correlated with OpenEMR (see
// schema-appointments.sql).
//
// What it proves, against a REAL Postgres (all schemas incl.
// schema-appointments.sql applied):
//   categories/statuses endpoints serve the seeded reference lists;
//   POST creates without a PIN and validates the OpenEMR rules —
//   appointment category without a patient → PATIENT_REQUIRED,
//   unknown patient → PATIENT_NOT_FOUND, unknown category →
//   CATEGORY_NOT_FOUND, unknown provider → PROVIDER_NOT_FOUND, bad
//   status → 400, ends<=starts → 400; a PROVIDER category (Lunch)
//   creates with no patient and patient_name null. GET list honors
//   the [from, to) window and patient/provider filters and joins
//   names. POST /:id/status is NOT PIN-gated (flow board) and logs
//   from/to. PUT/DELETE/restore are PIN-gated (PIN_REQUIRED /
//   PIN_INVALID), delete is soft, second restore → 409, and gated
//   writes name the manager in their appointment_change events.
//
// Run:  PGDATABASE=caretask_demo node e2e-appointments-test.js
const express = require('express');
const pool = require('./db');
const appointmentsRouter = require('./routes/appointments');
const eventsRouter = require('./routes/events');
const { hashPin } = require('./lib/pin');

const PORT = Number(process.env.E2E_PORT || 3105);
const BASE = `http://127.0.0.1:${PORT}`;
const MANAGER_PIN = '2468';

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

const call = (method, path, body, pin) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(pin ? { 'X-Manager-Pin': pin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const iso = (d) => d.toISOString();
const day = (offset, h, m = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(h, m, 0, 0);
  return d;
};

let patientId;
let gonePatientId;
let providerId;
let followupCatId;
let lunchCatId;

async function setup() {
  await pool.query(
    `INSERT INTO users (email, role, authorized, active, fname, lname, pin_hash)
     VALUES ('appt-mgr@example.com', 'manager', true, true, 'Appt', 'Manager', $1)
     ON CONFLICT (email) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, active = true`,
    [await hashPin(MANAGER_PIN)],
  );
  const prov = await pool.query(
    `INSERT INTO users (email, role, authorized, active, fname, lname)
     VALUES ('appt-prov@example.com', 'clinician', true, true, 'Pat', 'Provider')
     ON CONFLICT (email) DO UPDATE SET active = true RETURNING id`,
  );
  providerId = prov.rows[0].id;
  const c1 = await pool.query(
    `INSERT INTO appointment_categories (name, color, cattype, default_duration_min)
     VALUES ('Test Follow-up', '#2563eb', 'appointment', 45)
     ON CONFLICT (name) DO UPDATE SET active = true RETURNING id`,
  );
  followupCatId = c1.rows[0].id;
  const c2 = await pool.query(
    `INSERT INTO appointment_categories (name, color, cattype, default_duration_min)
     VALUES ('Test Lunch', '#f59e0b', 'provider', 60)
     ON CONFLICT (name) DO UPDATE SET active = true RETURNING id`,
  );
  lunchCatId = c2.rows[0].id;
  for (const [code, label, ci, co, ord] of [
    ['booked', 'Booked', false, false, 1],
    ['arrived', 'Arrived', true, false, 2],
    ['checked_out', 'Checked Out', false, true, 3],
  ]) {
    await pool.query(
      `INSERT INTO appointment_statuses (code, label, color, is_checkin, is_checkout, sort_order)
       VALUES ($1, $2, '#64748b', $3, $4, $5) ON CONFLICT (code) DO NOTHING`,
      [code, label, ci, co, ord],
    );
  }
  const p1 = await pool.query(
    `INSERT INTO patients (fname, lname) VALUES ('Appt', 'Testperson') RETURNING id`,
  );
  patientId = p1.rows[0].id;
  const p2 = await pool.query(
    `INSERT INTO patients (fname, lname, deleted_at) VALUES ('Appt', 'Goneperson', now()) RETURNING id`,
  );
  gonePatientId = p2.rows[0].id;
}

async function cleanup() {
  await pool.query('DELETE FROM appointments WHERE patient_id IN ($1, $2) OR provider_id = $3',
    [patientId, gonePatientId, providerId]);
  await pool.query('DELETE FROM appointments WHERE category_id IN ($1, $2)', [followupCatId, lunchCatId]);
  await pool.query('DELETE FROM patients WHERE id IN ($1, $2)', [patientId, gonePatientId]);
  await pool.query("DELETE FROM users WHERE email IN ('appt-mgr@example.com', 'appt-prov@example.com')");
  await pool.query("DELETE FROM appointment_categories WHERE name IN ('Test Follow-up', 'Test Lunch')");
  // Note: appointment_change rows stay in event_log — it is
  // append-only by design, even for tests (local sandbox only).
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
    const start = day(1, 10);
    const end = day(1, 10, 45);

    // --- reference lists
    let r = await call('GET', '/appointments/categories');
    check('categories list serves seeded rows',
      (await r.json()).categories.some((c) => c.id === followupCatId));
    r = await call('GET', '/appointments/statuses');
    const statuses = (await r.json()).statuses;
    check('statuses list has check-in flag on arrived',
      statuses.find((s) => s.code === 'arrived')?.is_checkin === true);

    // --- create validation
    r = await call('POST', '/appointments', {
      category_id: followupCatId, starts_at: iso(start), ends_at: iso(end),
    });
    check('appointment category without patient → PATIENT_REQUIRED',
      r.status === 400 && (await r.json()).code === 'PATIENT_REQUIRED', `got ${r.status}`);
    r = await call('POST', '/appointments', {
      patient_id: '123e4567-e89b-42d3-a456-426614174000', category_id: followupCatId, starts_at: iso(start), ends_at: iso(end),
    });
    check('unknown patient → PATIENT_NOT_FOUND',
      r.status === 400 && (await r.json()).code === 'PATIENT_NOT_FOUND', `got ${r.status}`);
    r = await call('POST', '/appointments', {
      patient_id: gonePatientId, category_id: followupCatId, starts_at: iso(start), ends_at: iso(end),
    });
    check('soft-deleted patient → 400', r.status === 400, `got ${r.status}`);
    r = await call('POST', '/appointments', {
      patient_id: patientId, category_id: 999999, starts_at: iso(start), ends_at: iso(end),
    });
    check('unknown category → CATEGORY_NOT_FOUND',
      r.status === 400 && (await r.json()).code === 'CATEGORY_NOT_FOUND', `got ${r.status}`);
    r = await call('POST', '/appointments', {
      patient_id: patientId, provider_id: 999999, category_id: followupCatId,
      starts_at: iso(start), ends_at: iso(end),
    });
    check('unknown provider → PROVIDER_NOT_FOUND',
      r.status === 400 && (await r.json()).code === 'PROVIDER_NOT_FOUND', `got ${r.status}`);
    r = await call('POST', '/appointments', {
      patient_id: patientId, category_id: followupCatId,
      starts_at: iso(end), ends_at: iso(start),
    });
    check('ends<=starts → 400', r.status === 400, `got ${r.status}`);
    r = await call('POST', '/appointments', {
      patient_id: patientId, category_id: followupCatId,
      starts_at: iso(start), ends_at: iso(end), status: 'bogus',
    });
    check('bad status → 400', r.status === 400, `got ${r.status}`);

    // --- provider event (no patient)
    r = await call('POST', '/appointments', {
      category_id: lunchCatId, provider_id: providerId,
      starts_at: iso(day(1, 12)), ends_at: iso(day(1, 13)),
    });
    const lunch = (await r.json()).appointment;
    check('provider category creates without patient → 201',
      r.status === 201 && lunch?.patient_name === null, `got ${r.status}`);

    // --- create ok (no PIN)
    r = await call('POST', '/appointments', {
      patient_id: patientId, provider_id: providerId, category_id: followupCatId,
      starts_at: iso(start), ends_at: iso(end), room: 'Room 2',
    });
    const created = (await r.json()).appointment;
    check('create → 201', r.status === 201, `got ${r.status}`);
    check('joins patient + provider + category names',
      created?.patient_name === 'Appt Testperson'
        && created?.provider_name === 'Pat Provider'
        && created?.category_name === 'Test Follow-up',
      JSON.stringify(created));
    check('default title = category name', created?.title === 'Test Follow-up');
    const apptId = created.id;

    // --- list windows + filters
    r = await call('GET',
      `/appointments?from=${encodeURIComponent(iso(day(1, 0)))}&to=${encodeURIComponent(iso(day(2, 0)))}`);
    let list = (await r.json()).appointments;
    check('list in-window includes it', list.some((a) => a.id === apptId));
    r = await call('GET', `/appointments?provider_id=${providerId}`);
    list = (await r.json()).appointments;
    check('list provider filter', list.some((a) => a.id === apptId) && list.every((a) => a.provider_id === providerId));

    // --- status flow (NOT gated)
    r = await call('POST', `/appointments/${apptId}/status`, { status: 'bogus' });
    check('status bad value → 400', r.status === 400, `got ${r.status}`);
    r = await call('POST', `/appointments/${apptId}/status`, { status: 'arrived' });
    check('status change without PIN → 200 arrived',
      r.status === 200 && (await r.json()).appointment?.status === 'arrived', `got ${r.status}`);

    // --- update gate + behavior
    r = await call('PUT', `/appointments/${apptId}`, { title: 'Changed' });
    check('update no PIN → 403 PIN_REQUIRED',
      r.status === 403 && (await r.json()).code === 'PIN_REQUIRED', `got ${r.status}`);
    r = await call('PUT', `/appointments/${apptId}`, { title: 'Changed' }, '9999');
    check('update wrong PIN → 403 PIN_INVALID',
      r.status === 403 && (await r.json()).code === 'PIN_INVALID', `got ${r.status}`);
    r = await call('PUT', `/appointments/${apptId}`,
      { starts_at: iso(day(1, 12)), ends_at: iso(day(1, 11)) }, MANAGER_PIN);
    check('update merged range invalid → 400', r.status === 400, `got ${r.status}`);
    r = await call('PUT', `/appointments/${apptId}`, { title: 'Changed' }, MANAGER_PIN);
    check('update with PIN → 200 + applied',
      r.status === 200 && (await r.json()).appointment?.title === 'Changed', `got ${r.status}`);

    // --- events
    r = await call('GET', '/events?event=appointment_change&limit=100');
    const events = await r.json();
    const mine = events.filter((e) => Number(e.details?.appointment_id) === Number(apptId));
    check('appointment_change events written', mine.length >= 3, `found ${mine.length}`);
    check('status event carries from/to',
      mine.some((e) => e.details?.action === 'appointment_status'
        && e.details?.from_status === 'booked' && e.details?.to_status === 'arrived'));
    check('update event names the manager',
      mine.some((e) => e.details?.action === 'appointment_update'
        && e.details?.manager_email === 'appt-mgr@example.com'));

    // --- category management (Settings)
    r = await call('POST', '/appointments/categories', {
      name: 'Test Category X', default_duration_min: 25,
    });
    check('category create no PIN → 403 PIN_REQUIRED',
      r.status === 403 && (await r.json()).code === 'PIN_REQUIRED', `got ${r.status}`);
    r = await call('POST', '/appointments/categories', {
      name: 'Test Category X', default_duration_min: 25,
    }, '9999');
    check('category create wrong PIN → 403 PIN_INVALID',
      r.status === 403 && (await r.json()).code === 'PIN_INVALID', `got ${r.status}`);
    r = await call('POST', '/appointments/categories', {
      name: 'Test Category X', default_duration_min: 0,
    }, MANAGER_PIN);
    check('category create bad duration → 400', r.status === 400, `got ${r.status}`);
    r = await call('POST', '/appointments/categories', {
      name: 'Test Category X', cattype: 'bogus',
    }, MANAGER_PIN);
    check('category create bad cattype → 400', r.status === 400, `got ${r.status}`);
    r = await call('POST', '/appointments/categories', {
      name: 'Test Category X', color: 'red',
    }, MANAGER_PIN);
    check('category create bad color → 400', r.status === 400, `got ${r.status}`);
    r = await call('POST', '/appointments/categories', {
      name: 'Test Category X', color: '#123456', default_duration_min: 25,
    }, MANAGER_PIN);
    const newCat = (await r.json()).category;
    check('category create with PIN → 201', r.status === 201 && newCat?.name === 'Test Category X',
      `got ${r.status}`);
    r = await call('POST', '/appointments/categories', {
      name: 'test category x',
    }, MANAGER_PIN);
    check('category duplicate name (case-insensitive) → 409 CATEGORY_EXISTS',
      r.status === 409 && (await r.json()).code === 'CATEGORY_EXISTS', `got ${r.status}`);
    r = await call('PUT', `/appointments/categories/${newCat.id}`, {
      default_duration_min: 35,
    }, MANAGER_PIN);
    check('category update duration → 200 + applied',
      r.status === 200 && (await r.json()).category?.default_duration_min === 35,
      `got ${r.status}`);
    r = await call('DELETE', `/appointments/categories/${newCat.id}`, undefined, MANAGER_PIN);
    check('category deactivate → 200', r.status === 200, `got ${r.status}`);
    r = await call('GET', '/appointments/categories');
    check('deactivated category leaves the active list',
      !(await r.json()).categories.some((c) => String(c.id) === String(newCat.id)));
    r = await call('GET', '/appointments/categories?all=1');
    check('?all=1 still shows it, inactive',
      (await r.json()).categories.some(
        (c) => String(c.id) === String(newCat.id) && c.active === false));
    r = await call('DELETE', `/appointments/categories/${newCat.id}`, undefined, MANAGER_PIN);
    check('second deactivate → 404', r.status === 404, `got ${r.status}`);
    r = await call('POST', `/appointments/categories/${newCat.id}/restore`, undefined, MANAGER_PIN);
    check('category restore → 200 active',
      r.status === 200 && (await r.json()).category?.active === true, `got ${r.status}`);
    r = await call('POST', `/appointments/categories/${newCat.id}/restore`, undefined, MANAGER_PIN);
    check('second restore → 409', r.status === 409, `got ${r.status}`);
    r = await call('GET', '/events?event=admin_action&limit=100');
    const adminEvents = await r.json();
    check('category writes logged as admin_action naming the manager',
      adminEvents.some((e) => e.details?.action === 'category_create'
        && e.details?.category_name === 'Test Category X'
        && e.details?.manager_email === 'appt-mgr@example.com'));
    await pool.query("DELETE FROM appointment_categories WHERE name = 'Test Category X'");

    // --- delete + restore
    r = await call('DELETE', `/appointments/${apptId}`);
    check('delete no PIN → 403', r.status === 403, `got ${r.status}`);
    r = await call('DELETE', `/appointments/${apptId}`, undefined, MANAGER_PIN);
    check('delete with PIN → 200', r.status === 200, `got ${r.status}`);
    r = await call('GET', `/appointments/${apptId}`);
    check('deleted appointment GET → 404', r.status === 404, `got ${r.status}`);
    r = await call('POST', `/appointments/${apptId}/restore`, undefined, MANAGER_PIN);
    check('restore with PIN → 200', r.status === 200, `got ${r.status}`);
    r = await call('POST', `/appointments/${apptId}/restore`, undefined, MANAGER_PIN);
    check('second restore → 409', r.status === 409, `got ${r.status}`);
  } finally {
    await cleanup();
    server.close();
    await pool.end();
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
