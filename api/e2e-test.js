// End-to-end test harness for the demo patient API (patients v2)
// — LOCAL TEST ONLY.
//
// What it proves, against a REAL Postgres (schema.sql,
// schema-events.sql, schema-patients-v2.sql, AND
// schema-patients-map.sql applied):
//   add (split name/address/phone + v2 fields) → list → search →
//   profile → update → validation 400s (zone, status, strict
//   booleans, pharmacy_id, required names) → soft-delete (gone from
//   list, row kept) → restore → audit trail (snapshots carry the v2
//   fields), plus append-only enforcement on audit_log and
//   fail-closed auth for missing/invalid tokens.
//
// What it does NOT prove (stated plainly, not faked):
// - The real Firebase auth path. Minting a real ID token needs the
//   Marc Innotech Firebase project and a signed-in user, so this
//   harness mounts the router behind a STUB auth middleware that
//   injects req.user = { uid: 'test-uid-1', email: 'tester@example.com' }.
//   The production server.js still uses the real requireAuth, and the
//   deploy-time checks in the README cover the real token path.
// - The 403 branch (valid token, non-allowlisted email): also needs a
//   real token, so it is a deploy-time check too.
//
// Run:  PGDATABASE=caretask_demo node e2e-test.js
// (db.js reads the PG* env vars; the harness binds 127.0.0.1 only.)
// After the run, `npm run seed` resets the demo tables to the 8
// fictional patients — the harness leaves its test patient soft-deleted.
const express = require('express');
const pool = require('./db');
const patientsRouter = require('./routes/patients');
const realRequireAuth = require('./auth');
const { hashPin } = require('./lib/pin');

const PORT = Number(process.env.E2E_PORT || 3101);
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

// Patient soft-delete / restore are ROLE-gated (manager/admin;
// lib/requireRole.js) since the PIN was retired on 2026-11-02.
// The harness upserts the stub actor itself as a manager; update
// is ungated. PIN_HEADERS below are legacy and ignored.
const TEST_PIN = '1357';
const PIN_HEADERS = { 'X-Manager-Pin': TEST_PIN };

async function postPatient(body) {
  const res = await fetch(`${BASE}/patients`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { res, json: await res.json().catch(() => null) };
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/patients', stubAuth, patientsRouter);
  // Real auth, mounted separately, to prove fail-closed behavior.
  const authApp = express();
  authApp.use(express.json());
  authApp.use('/patients', realRequireAuth, patientsRouter);

  const server = await new Promise((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });
  const authServer = await new Promise((resolve) => {
    const s = authApp.listen(PORT + 1, '127.0.0.1', () => resolve(s));
  });
  const AUTH_BASE = `http://127.0.0.1:${PORT + 1}`;

  try {
    // Manager PIN gate setup: an active manager whose PIN is TEST_PIN.
    const testPinHash = await hashPin(TEST_PIN);
    await pool.query(
      `INSERT INTO users (email, role, authorized, fname, lname, pin_hash)
       VALUES ('tester@example.com', 'manager', false, 'Test', 'Manager', $1)
       ON CONFLICT (email) DO UPDATE
         SET pin_hash = EXCLUDED.pin_hash, role = 'manager', active = true`,
      [testPinHash],
    );

    // 1. CREATE with the full v2 field set (split name/address/phone,
    //    demographics, care/other, billing, pharmacy). The ss value
    //    is in the never-issued 900 range and the license is marked
    //    EXAMPLE — obviously fictional, like the seed.
    console.log('1. create (v2 fields)');
    let res = await fetch(`${BASE}/patients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Mx.',
        fname: 'E2E',
        mname: 'Test',
        lname: 'Person',
        suffix: 'Jr.',
        preferred_name: 'E2E',
        date_of_birth: '1961-07-22',
        sex: 'Male',
        race: 'White',
        ethnicity: 'Not Hispanic or Latino',
        language: 'English',
        street: '99 Example Street',
        street_line_2: 'Apt 9',
        city: 'Springfield',
        state: 'IL',
        postal_code: '62704',
        country_code: 'US',
        latitude: 39.7817,
        longitude: -89.6501,
        phone_home: '555-0199',
        phone_cell: '555-0198',
        email: 'e2e.test@example.com',
        zone: 'yellow',
        flags: ['e2e flag'],
        notes: 'created by the local e2e harness',
        clinician: 'Test Clinician',
        occupation: 'Test occupation',
        interpreter_needed: true,
        hipaa_allowsms: true,
        hipaa_allowemail: false,
        referrer: 'Test Referrer',
        status: 'active',
        emergency_contact_name: 'Emergency Example',
        emergency_contact_relationship: 'Friend',
        emergency_contact_phone: '555-0197',
        ss: '900-99-9999',
        drivers_license: 'EXAMPLE-DL-9999',
        billing_note: 'e2e billing note — fictional',
        pricelevel: 'standard',
        financial: 'e2e financial — fictional',
        pharmacy_id: 7,
      }),
    });
    const created = await res.json();
    check('create returns 201', res.status === 201, `got ${res.status}`);
    check('create returns an id', typeof created.id === 'string');
    check(
      'create echoes split name + preferred name',
      created.fname === 'E2E' && created.lname === 'Person' && created.preferred_name === 'E2E',
    );
    check(
      'create echoes split address + phones',
      created.street === '99 Example Street' && created.postal_code === '62704' && created.phone_cell === '555-0198',
    );
    check(
      'create echoes v2 care/billing/pharmacy fields',
      created.interpreter_needed === true &&
        created.hipaa_allowsms === true &&
        created.status === 'active' &&
        created.pharmacy_id === 7 &&
        created.ss === '900-99-9999',
    );
    check(
      'create echoes map coordinates',
      created.latitude === 39.7817 && created.longitude === -89.6501,
      `got ${created.latitude}, ${created.longitude}`,
    );
    check(
      'dropped v1 columns are absent',
      !('name' in created) && !('address' in created) && !('phone' in created) && !('age_band' in created),
    );
    const id = created.id;

    // 2. LIST contains it; search matches fname / preferred_name.
    console.log('2. list + search');
    res = await fetch(`${BASE}/patients?limit=200`);
    const list = await res.json();
    check(
      'list contains the new patient',
      list.some((p) => p.id === id),
      `list had ${list.length} rows`,
    );
    res = await fetch(`${BASE}/patients?q=Person&limit=200`);
    const searched = await res.json();
    check(
      'search by lname finds the patient',
      searched.some((p) => p.id === id),
      `search had ${searched.length} rows`,
    );
    res = await fetch(`${BASE}/patients?status=active&limit=200`);
    const byStatus = await res.json();
    check(
      'status filter includes the patient',
      byStatus.some((p) => p.id === id),
    );

    // 3. PROFILE
    console.log('3. profile');
    res = await fetch(`${BASE}/patients/${id}`);
    const profile = await res.json();
    check(
      'profile returns 200 + split name',
      res.status === 200 && profile.fname === 'E2E' && profile.lname === 'Person',
    );
    check(
      'profile carries emergency contact + demographics',
      profile.emergency_contact_name === 'Emergency Example' &&
        profile.sex === 'Male' &&
        profile.language === 'English',
    );

    // 4. UPDATE
    console.log('4. update');
    res = await fetch(`${BASE}/patients/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...PIN_HEADERS },
      body: JSON.stringify({
        zone: 'red',
        status: 'hold',
        notes: 'updated by the harness',
        latitude: 41.8781,
        longitude: -87.6298,
      }),
    });
    const updated = await res.json();
    check('update returns zone red', res.status === 200 && updated.zone === 'red');
    check(
      'update returns new coordinates',
      updated.latitude === 41.8781 && updated.longitude === -87.6298,
      `got ${updated.latitude}, ${updated.longitude}`,
    );
    check('update returns status hold', updated.status === 'hold');
    check('update returns new notes', updated.notes === 'updated by the harness');

    // 5. VALIDATION 400s
    console.log('5. validation');
    let bad = await postPatient({ fname: 'NoZone', lname: 'Test', zone: 'purple' });
    check('bad zone is 400', bad.res.status === 400, `got ${bad.res.status}`);
    bad = await postPatient({ fname: 'NoStatus', lname: 'Test', status: 'archived' });
    check('bad status is 400', bad.res.status === 400, `got ${bad.res.status}`);
    bad = await postPatient({ lname: 'Test' });
    check('missing fname is 400', bad.res.status === 400, `got ${bad.res.status}`);
    bad = await postPatient({ fname: 'Test' });
    check('missing lname is 400', bad.res.status === 400, `got ${bad.res.status}`);
    bad = await postPatient({ fname: 'Bool', lname: 'Test', interpreter_needed: 'yes' });
    check('string boolean is 400 (no silent coercion)', bad.res.status === 400, `got ${bad.res.status}`);
    bad = await postPatient({ fname: 'Bool', lname: 'Test', hipaa_allowsms: 1 });
    check('numeric boolean is 400 (no silent coercion)', bad.res.status === 400, `got ${bad.res.status}`);
    bad = await postPatient({ fname: 'Pharm', lname: 'Test', pharmacy_id: 'seven' });
    check('string pharmacy_id is 400', bad.res.status === 400, `got ${bad.res.status}`);
    bad = await postPatient({ fname: 'Pharm', lname: 'Test', pharmacy_id: 7.5 });
    check('fractional pharmacy_id is 400', bad.res.status === 400, `got ${bad.res.status}`);
    bad = await postPatient({ fname: 'Geo', lname: 'Test', latitude: '41.8781' });
    check('string latitude is 400 (no silent coercion)', bad.res.status === 400, `got ${bad.res.status}`);
    bad = await postPatient({ fname: 'Geo', lname: 'Test', latitude: 91 });
    check('out-of-range latitude is 400', bad.res.status === 400, `got ${bad.res.status}`);
    bad = await postPatient({ fname: 'Geo', lname: 'Test', longitude: -181 });
    check('out-of-range longitude is 400', bad.res.status === 400, `got ${bad.res.status}`);
    bad = await postPatient({
      fname: 'Geo', lname: 'Test', latitude: null, longitude: null,
      date_of_birth: '1960-01-15', sex: 'Female',
    });
    check('null coordinates are accepted', bad.res.status === 201, `got ${bad.res.status}`);
    if (bad.json && bad.json.id) {
      // Clean up the null-coords probe so the audit count below is
      // unaffected (audit section counts entries for `id` only, and
      // this is a different patient — just soft-delete for tidiness).
      await fetch(`${BASE}/patients/${bad.json.id}`, {
        method: 'DELETE',
        headers: { ...PIN_HEADERS },
      });
    }
    res = await fetch(`${BASE}/patients/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...PIN_HEADERS },
      body: JSON.stringify({ fname: '   ' }),
    });
    check('blanking fname via update is 400', res.status === 400, `got ${res.status}`);

    // 6. AUDIT after create + update
    console.log('6. audit trail (create + update)');
    res = await fetch(`${BASE}/patients/${id}/audit`);
    let trail = await res.json();
    check('audit has 2 entries', trail.length === 2, `got ${trail.length}`);
    const actions = trail.map((e) => e.action).sort();
    check('audit actions are create + update', JSON.stringify(actions) === '["create","update"]');
    const updateEntry = trail.find((e) => e.action === 'update');
    check(
      'update entry snapshots before/after',
      updateEntry &&
        updateEntry.changed.before.zone === 'yellow' &&
        updateEntry.changed.after.zone === 'red',
    );
    const createEntry = trail.find((e) => e.action === 'create');
    check(
      'create snapshot carries the v2 fields',
      createEntry &&
        createEntry.changed.after.fname === 'E2E' &&
        createEntry.changed.after.lname === 'Person' &&
        createEntry.changed.after.street === '99 Example Street' &&
        createEntry.changed.after.interpreter_needed === true &&
        createEntry.changed.after.pharmacy_id === 7,
    );
    check(
      'snapshot includes ss verbatim (redaction warning is real)',
      createEntry && createEntry.changed.after.ss === '900-99-9999',
    );
    check(
      'update snapshot carries the new status',
      updateEntry && updateEntry.changed.after.status === 'hold',
    );
    check(
      'audit actor is the stub user',
      trail.every(
        (e) => e.actor_uid === 'test-uid-1' && e.actor_email === 'tester@example.com',
      ),
    );

    // 7. SOFT DELETE
    console.log('7. soft delete');
    res = await fetch(`${BASE}/patients/${id}`, { method: 'DELETE', headers: PIN_HEADERS });
    check('delete returns 204', res.status === 204, `got ${res.status}`);
    res = await fetch(`${BASE}/patients?limit=200`);
    const listAfterDelete = await res.json();
    check(
      'deleted patient absent from list',
      !listAfterDelete.some((p) => p.id === id),
    );
    res = await fetch(`${BASE}/patients/${id}`);
    check('deleted patient profile is 404', res.status === 404, `got ${res.status}`);
    const row = await pool.query('SELECT id, deleted_at FROM patients WHERE id = $1', [id]);
    check(
      'row still exists with deleted_at set (soft, not hard, delete)',
      row.rows.length === 1 && row.rows[0].deleted_at !== null,
    );

    // 8. AUDIT survives soft delete
    console.log('8. audit trail after soft delete');
    res = await fetch(`${BASE}/patients/${id}/audit`);
    trail = await res.json();
    check('audit has 3 entries incl. soft_delete', trail.length === 3 && trail.some((e) => e.action === 'soft_delete'));

    // 9. RESTORE
    console.log('9. restore');
    res = await fetch(`${BASE}/patients/${id}/restore`, { method: 'POST', headers: PIN_HEADERS });
    const restored = await res.json();
    check('restore returns 200', res.status === 200, `got ${res.status}`);
    check('restored row has deleted_at null', restored.deleted_at === null);
    res = await fetch(`${BASE}/patients?limit=200`);
    const listAfterRestore = await res.json();
    check('restored patient back in list', listAfterRestore.some((p) => p.id === id));
    res = await fetch(`${BASE}/patients/${id}/audit`);
    trail = await res.json();
    check('audit has 4 entries incl. restore', trail.length === 4 && trail.some((e) => e.action === 'restore'));

    // 10. RESTORE again -> 409; DELETE -> 204; DELETE again -> 404
    console.log('10. restore/delete edge cases');
    res = await fetch(`${BASE}/patients/${id}/restore`, { method: 'POST', headers: PIN_HEADERS });
    check('restore of active patient is 409', res.status === 409, `got ${res.status}`);
    res = await fetch(`${BASE}/patients/${id}`, { method: 'DELETE', headers: PIN_HEADERS });
    check('second delete returns 204', res.status === 204, `got ${res.status}`);
    res = await fetch(`${BASE}/patients/${id}`, { method: 'DELETE', headers: PIN_HEADERS });
    check('delete of deleted patient is 404', res.status === 404, `got ${res.status}`);

    // 11. APPEND-ONLY enforcement, at the database level
    console.log('11. audit_log append-only triggers');
    let blocked = false;
    try {
      await pool.query('UPDATE audit_log SET action = $1 WHERE patient_id = $2', ['update', id]);
    } catch (err) {
      blocked = /append-only/.test(err.message);
    }
    check('UPDATE audit_log is rejected', blocked);
    blocked = false;
    try {
      await pool.query('DELETE FROM audit_log WHERE patient_id = $1', [id]);
    } catch (err) {
      blocked = /append-only/.test(err.message);
    }
    check('DELETE FROM audit_log is rejected', blocked);

    // 11b. AGENCY TAG (schema-patients-agency.sql): directory
    // link, free-text fallback, never both, AGENCY_NOT_FOUND.
    console.log('11b. agency tag');
    const agRow = await pool.query(
      `INSERT INTO agencies (license_number, name, dba, city, postal_code, phone)
       VALUES ('E2E-AG-1', 'E2E Agency Care, Inc. - DBA E2E Home Health', 'E2E Home Health', 'Springfield', '62704', '(555) 010-2000')
       ON CONFLICT (license_number) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
    );
    const agencyId = Number(agRow.rows[0].id);
    let r2 = await postPatient({
      fname: 'Agency', lname: 'Linked', date_of_birth: '1955-03-04', sex: 'Female', agency_id: agencyId,
    });
    check('create with agency_id returns 201', r2.res.status === 201, `got ${r2.res.status}`);
    check('agency_id round-trips (int8 as string ok)',
      Number(r2.json.agency_id) === agencyId, JSON.stringify(r2.json.agency_id));
    check('agency_name resolves to the agency display_name (DBA)',
      r2.json.agency_name === 'E2E Home Health', `got ${r2.json.agency_name}`);
    check('agency_name_text stored NULL when id is set',
      r2.json.agency_name_text === null);
    const linkedId = r2.json.id;
    res = await fetch(`${BASE}/patients/${linkedId}`);
    const fetchedLinked = await res.json();
    check('GET one resolves agency_name too',
      fetchedLinked.agency_name === 'E2E Home Health');
    res = await fetch(`${BASE}/patients?q=Linked`);
    const listLinked = await res.json();
    check('list rows resolve agency_name',
      listLinked.some((p) => p.id === linkedId && p.agency_name === 'E2E Home Health'));

    r2 = await postPatient({
      fname: 'Agency', lname: 'Bogus', date_of_birth: '1955-03-04', sex: 'Female', agency_id: 999999001,
    });
    check('bogus agency_id is 400 AGENCY_NOT_FOUND',
      r2.res.status === 400 && r2.json.code === 'AGENCY_NOT_FOUND',
      `got ${r2.res.status}/${r2.json && r2.json.code}`);
    r2 = await postPatient({
      fname: 'Agency', lname: 'BadType', date_of_birth: '1955-03-04', sex: 'Female', agency_id: 'abc',
    });
    check('non-integer agency_id is 400', r2.res.status === 400, `got ${r2.res.status}`);

    r2 = await postPatient({
      fname: 'Agency', lname: 'FreeText', date_of_birth: '1955-03-04', sex: 'Female', agency_name_text: '  Small Town Care LLC  ',
    });
    check('free-text agency round-trips (trimmed)',
      r2.res.status === 201 && r2.json.agency_name_text === 'Small Town Care LLC'
        && r2.json.agency_name === 'Small Town Care LLC' && r2.json.agency_id === null,
      JSON.stringify(r2.json));
    const freeId = r2.json.id;

    r2 = await postPatient({
      fname: 'Agency', lname: 'BothSent', date_of_birth: '1955-03-04', sex: 'Female', agency_id: agencyId, agency_name_text: 'Text Loses',
    });
    check('both sent → agency_id wins, text stored NULL',
      r2.res.status === 201 && Number(r2.json.agency_id) === agencyId
        && r2.json.agency_name_text === null && r2.json.agency_name === 'E2E Home Health');

    // Updates through the PIN gate.
    async function putPatient(pid, body) {
      const r = await fetch(`${BASE}/patients/${pid}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...PIN_HEADERS },
        body: JSON.stringify(body),
      });
      return { res: r, json: await r.json().catch(() => null) };
    }
    r2 = await putPatient(freeId, { agency_id: agencyId, agency_name_text: null });
    check('update: free-text → directory link',
      r2.res.status === 200 && Number(r2.json.agency_id) === agencyId
        && r2.json.agency_name === 'E2E Home Health');
    r2 = await putPatient(freeId, { agency_name_text: 'Switched Agency' });
    check('update: text-only switches mode and clears the link',
      r2.res.status === 200 && r2.json.agency_id === null
        && r2.json.agency_name_text === 'Switched Agency'
        && r2.json.agency_name === 'Switched Agency');
    r2 = await putPatient(freeId, { notes: 'no agency change' });
    check('update omitting agency fields leaves them unchanged',
      r2.res.status === 200 && r2.json.agency_name_text === 'Switched Agency');
    r2 = await putPatient(freeId, { agency_id: null, agency_name_text: null });
    check('update clearing both → agency_name null',
      r2.res.status === 200 && r2.json.agency_id === null
        && r2.json.agency_name_text === null && r2.json.agency_name === null);
    r2 = await putPatient(freeId, { agency_id: 999999001 });
    check('update with bogus agency_id is 400 AGENCY_NOT_FOUND',
      r2.res.status === 400 && r2.json.code === 'AGENCY_NOT_FOUND');
    // audit_log FKs patients, so unlink instead of deleting.
    await pool.query('UPDATE patients SET agency_id = NULL WHERE agency_id = $1', [agencyId]);
    await pool.query("DELETE FROM agencies WHERE license_number = 'E2E-AG-1'");

    // 11c. DOB + SEX OPTIONAL ON CREATE + age fallback (Jake,
    // 2026-11-01 — reverses the 2026-10-30 required rule; the
    // CSV import must not block rows lacking a birthday/gender).
    console.log('11c. dob/sex optional on create; age fallback');
    let r3 = await postPatient({ fname: 'Req', lname: 'NoDob', sex: 'Female' });
    check('POST without DOB is 201 (DOB optional)',
      r3.res.status === 201 && r3.json.date_of_birth === null,
      `got ${r3.res.status}/${r3.json && r3.json.code}`);
    const reqId = r3.json.id;
    r3 = await postPatient({ fname: 'Req', lname: 'EmptyDob', date_of_birth: '', sex: 'Female' });
    check('POST with empty-string DOB is 201 and stores NULL',
      r3.res.status === 201 && r3.json.date_of_birth === null,
      `got ${r3.res.status}`);
    r3 = await postPatient({ fname: 'Req', lname: 'NoSex', date_of_birth: '1960-05-05' });
    check('POST without sex is 201 (sex optional)',
      r3.res.status === 201 && r3.json.sex === null,
      `got ${r3.res.status}/${r3.json && r3.json.code}`);
    r3 = await postPatient({ fname: 'Req', lname: 'AgeOnly', age: 74 });
    check('POST with age and no DOB/sex is 201 and returns age',
      r3.res.status === 201 && r3.json.age === 74,
      `got ${r3.res.status}/${r3.json && r3.json.age}`);
    r3 = await postPatient({ fname: 'Req', lname: 'BadAge', age: 200 });
    check('POST with age 200 is 400',
      r3.res.status === 400, `got ${r3.res.status}`);
    r3 = await postPatient({ fname: 'Req', lname: 'StringAge', age: '74' });
    check('POST with string age is 400',
      r3.res.status === 400, `got ${r3.res.status}`);
    // PUT round-trip: age is writable on edit; the NoDob
    // patient's DOB stays NULL and its sex is untouched.
    r3 = await putPatient(reqId, { age: 65, notes: 'edit without dob/sex' });
    check('PUT sets age; DOB stays null, sex untouched',
      r3.res.status === 200 && r3.json.age === 65
        && r3.json.date_of_birth === null && r3.json.sex === 'Female',
      `got ${r3.res.status}`);

    // 12. REAL auth fails closed without a token
    console.log('12. real auth, no token');
    res = await fetch(`${AUTH_BASE}/patients?limit=5`);
    check('no-token request is 401', res.status === 401, `got ${res.status}`);
    res = await fetch(`${AUTH_BASE}/patients`, {
      headers: { Authorization: 'Bearer this-is-not-a-real-token' },
    });
    check('garbage-token request is 401', res.status === 401, `got ${res.status}`);

    console.log(failures === 0 ? '\nALL E2E CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  } finally {
    server.close();
    authServer.close();
    await pool.end();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('e2e harness error:', err);
  process.exit(1);
});
