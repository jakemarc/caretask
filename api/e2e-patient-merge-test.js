// End-to-end tests for the patient merge API — LOCAL TEST ONLY,
// same conventions as e2e-test.js. Against a real Postgres (full
// schema chain incl. schema-patient-merge.sql), this proves:
// mark → review queue → role gate on merge → the merge itself
// (linked rows re-point across appointments/documents/messages/
// mileage, survivor gap-filled without overwriting its own data,
// loser soft-deleted, marks closed, merge recorded with the moved
// ids) → undo restores exactly what moved → dismiss, same-patient
// and deleted-patient guards.
//
// Stub auth: an x-test-user header picks the seeded staff member
// (clin = clinician, mgr = manager).
//
// Run: PGDATABASE=caretask_demo E2E_PORT=3113 node e2e-patient-merge-test.js
const express = require('express');
const pool = require('./db');
const patientMergeRouter = require('./routes/patientMerge');
const patientsRouter = require('./routes/patients');

const PORT = Number(process.env.E2E_PORT || 3113);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  PASS ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const USERS = {
  clin: { uid: 'merge-clin-uid', email: 'clin@example.com' },
  mgr: { uid: 'merge-mgr-uid', email: 'mgr@example.com' },
};

function stubAuth(req, res, next) {
  const who = USERS[req.headers['x-test-user']] || USERS.clin;
  req.user = { uid: who.uid, email: who.email };
  next();
}

async function call(method, path, { as = 'clin', body } = {}) {
  const headers = { 'Content-Type': 'application/json', 'x-test-user': as };
  const res = await fetch(`${BASE}${path}`, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { res, json: await res.json().catch(() => null) };
}

async function main() {
  // --- seed staff ---
  await pool.query(
    `INSERT INTO users (firebase_uid, email, role, fname, lname, active)
     VALUES ($1, $2, 'clinician', 'Clara', 'Clinician', true),
            ($3, $4, 'manager', 'Marge', 'Manager', true)
     ON CONFLICT (email) DO NOTHING`,
    [USERS.clin.uid, USERS.clin.email, USERS.mgr.uid, USERS.mgr.email]
  );
  const clinId = (await pool.query(
    `SELECT id FROM users WHERE email = $1`, [USERS.clin.email]
  )).rows[0].id;
  const agencyId = (await pool.query(
    `INSERT INTO agencies (license_number, name)
     VALUES ('TEST-LIC-MERGE', 'Merge Test Agency')
     ON CONFLICT (license_number) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`
  )).rows[0].id;

  // --- seed the duplicate pair + a third patient ---
  // Survivor: sparse (its own cell must WIN over the loser's).
  const survivorId = (await pool.query(
    `INSERT INTO patients (fname, lname, phone_cell)
     VALUES ('Rosa', 'Reyes', '7085550100') RETURNING id`
  )).rows[0].id;
  // Loser: rich record (DOB, address, email, agency text, notes).
  const loserId = (await pool.query(
    `INSERT INTO patients (fname, lname, date_of_birth, email, street,
        city, state, postal_code, phone_home, agency_name_text, notes)
     VALUES ('Rosa', 'Reyes', '1945-03-04', 'rosa@example.com',
        '7841 S Archer Ave', 'Summit', 'IL', '60501', '7085550142',
        'CenterWell Home Health', 'Prefers morning visits.')
     RETURNING id`
  )).rows[0].id;
  const thirdId = (await pool.query(
    `INSERT INTO patients (fname, lname) VALUES ('Third', 'Patient')
     RETURNING id`
  )).rows[0].id;

  // Linked rows on the LOSER: one of each kind.
  await pool.query(
    `INSERT INTO appointment_statuses (code, label, color, is_checkin, is_checkout, sort_order)
     VALUES ('booked', 'Booked', '#64748b', false, false, 1)
     ON CONFLICT (code) DO NOTHING`
  );
  const catId = (await pool.query(
    `INSERT INTO appointment_categories (name, color, cattype, default_duration_min)
     VALUES ('Merge Test Visit', '#0d9488', 'appointment', 45)
     ON CONFLICT (name) DO UPDATE SET color = EXCLUDED.color
     RETURNING id`
  )).rows[0].id;
  const apptId = (await pool.query(
    `INSERT INTO appointments (patient_id, category_id, starts_at, ends_at)
     VALUES ($1, $2, '2026-11-03T15:00:00Z', '2026-11-03T15:45:00Z')
     RETURNING id`,
    [loserId, catId]
  )).rows[0].id;
  await pool.query(
    `INSERT INTO documents (patient_id, author_id, doc_type)
     VALUES ($1, $2, 'evaluation')`,
    [loserId, clinId]
  );
  await pool.query(
    `INSERT INTO messages (sender_id, patient_id, body)
     VALUES ($1, $2, 'Chart note for the duplicate record.')`,
    [clinId, loserId]
  );
  await pool.query(
    `INSERT INTO mileage_entries (user_id, agency_id, patient_id,
        entry_date, seq, entry_kind, business_miles)
     VALUES ($1, $2, $3, '2026-11-02', 1, 'business', 5.00)`,
    [clinId, agencyId, loserId]
  );

  const app = express();
  app.use(express.json());
  app.use('/patients', stubAuth, patientsRouter);
  app.use('/patient-merge', stubAuth, patientMergeRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: 'internal' }));
  const server = app.listen(PORT);
  try {
    // --- marking ---
    console.log('marks:');
    let r = await call('POST', '/patient-merge/mark', {
      body: { patient_id: survivorId, other_id: loserId },
    });
    check('clinician can mark a pair', r.res.status === 201, `got ${r.res.status}`);
    r = await call('POST', '/patient-merge/mark', {
      body: { patient_id: loserId, other_id: survivorId },
    });
    check('re-mark reversed is accepted', r.res.status === 201, `got ${r.res.status}`);
    r = await call('GET', '/patient-merge/marks');
    check('queue holds exactly one open mark', r.json.marks.length === 1,
      `got ${r.json.marks.length}`);
    const mark = r.json.marks[0];
    check('mark carries both summaries',
      [mark.patient_a.id, mark.patient_b.id].includes(survivorId) &&
      [mark.patient_a.id, mark.patient_b.id].includes(loserId));
    r = await call('POST', '/patient-merge/mark', {
      body: { patient_id: survivorId, other_id: survivorId },
    });
    check('self-mark refused', r.res.status === 400 && r.json.error === 'SAME_PATIENT');

    // --- the role gate ---
    console.log('role gate:');
    r = await call('POST', '/patient-merge', {
      as: 'clin', body: { survivor_id: survivorId, loser_id: loserId },
    });
    check('clinician merge refused', r.res.status === 403 && r.json.code === 'ROLE_REQUIRED',
      `got ${r.res.status} ${JSON.stringify(r.json)}`);

    // --- the merge ---
    console.log('merge:');
    r = await call('POST', '/patient-merge', {
      as: 'mgr', body: { survivor_id: survivorId, loser_id: loserId },
    });
    check('manager merge succeeds', r.res.status === 201, `got ${r.res.status}`);
    const merge = r.json.merge;
    check('moved counts are 1/1/1/1',
      merge.moved.appointments === 1 && merge.moved.documents === 1 &&
      merge.moved.messages === 1 && merge.moved.mileage_entries === 1,
      JSON.stringify(merge.moved));

    const apptOwner = (await pool.query(
      `SELECT patient_id FROM appointments WHERE id = $1`, [apptId]
    )).rows[0].patient_id;
    check('appointment re-pointed to survivor', apptOwner === survivorId);
    const surv = (await pool.query(
      `SELECT * FROM patients WHERE id = $1`, [survivorId]
    )).rows[0];
    check('survivor gap-filled: email', surv.email === 'rosa@example.com');
    check('survivor gap-filled: address',
      surv.street === '7841 S Archer Ave' && surv.postal_code === '60501');
    check('survivor gap-filled: agency text',
      surv.agency_name_text === 'CenterWell Home Health');
    check('survivor keeps its own cell', surv.phone_cell === '7085550100');
    check('survivor notes take the loser notes',
      surv.notes === 'Prefers morning visits.');
    const loser = (await pool.query(
      `SELECT deleted_at FROM patients WHERE id = $1`, [loserId]
    )).rows[0];
    check('loser soft-deleted', loser.deleted_at != null);
    r = await call('GET', '/patient-merge/marks');
    check('merge closed the pair mark', r.json.marks.length === 0);
    r = await call('GET', '/patient-merge', { as: 'mgr' });
    check('merge listed with counts',
      r.json.merges.length === 1 && r.json.merges[0].moved.appointments === 1 &&
      r.json.merges[0].undone_at === null);

    // --- undo ---
    console.log('undo:');
    r = await call('POST', `/patient-merge/${merge.id}/undo`, { as: 'clin' });
    check('clinician undo refused', r.res.status === 403, `got ${r.res.status}`);
    r = await call('POST', `/patient-merge/${merge.id}/undo`, { as: 'mgr' });
    check('manager undo succeeds', r.res.status === 200, `got ${r.res.status}`);
    const apptOwner2 = (await pool.query(
      `SELECT patient_id FROM appointments WHERE id = $1`, [apptId]
    )).rows[0].patient_id;
    check('appointment re-pointed back to the loser', apptOwner2 === loserId);
    const loser2 = (await pool.query(
      `SELECT deleted_at FROM patients WHERE id = $1`, [loserId]
    )).rows[0];
    check('loser restored', loser2.deleted_at == null);
    r = await call('POST', `/patient-merge/${merge.id}/undo`, { as: 'mgr' });
    check('second undo refused', r.res.status === 409 && r.json.error === 'ALREADY_UNDONE');

    // --- dismiss + guards ---
    console.log('dismiss + guards:');
    await call('POST', '/patient-merge/mark', {
      body: { patient_id: survivorId, other_id: thirdId },
    });
    r = await call('POST', '/patient-merge/mark/dismiss', {
      body: { patient_id: thirdId, other_id: survivorId },
    });
    check('dismiss works (either order)', r.res.status === 200, `got ${r.res.status}`);
    r = await call('GET', '/patient-merge/marks');
    check('queue empty after dismiss', r.json.marks.length === 0);
    r = await call('POST', '/patient-merge/mark/dismiss', {
      body: { patient_id: thirdId, other_id: survivorId },
    });
    check('dismiss of nothing 404s', r.res.status === 404 && r.json.error === 'MARK_NOT_FOUND');
    r = await call('POST', '/patient-merge', {
      as: 'mgr', body: { survivor_id: survivorId, loser_id: survivorId },
    });
    check('merge into itself refused', r.res.status === 400 && r.json.error === 'SAME_PATIENT');
    await call('DELETE', `/patients/${thirdId}`, { as: 'mgr' });
    r = await call('POST', '/patient-merge/mark', {
      body: { patient_id: survivorId, other_id: thirdId },
    });
    check('marking a deleted patient refused',
      r.res.status === 409 && r.json.error === 'PATIENT_DELETED', `got ${r.res.status}`);

    // --- events ---
    const ev = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM event_log WHERE event = 'patient_merge'`
    )).rows[0].n;
    check('patient_merge events recorded (mark/merge/undo/dismiss)', ev >= 4, `got ${ev}`);
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
