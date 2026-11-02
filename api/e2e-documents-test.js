// End-to-end test for the document routes (clinical
// documentation v1, OpenEMR encounter-forms pattern).
// Runs against a scratch Postgres — same env contract as the
// other suites:
//   PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE must point at a db
//   where schema.sql, schema-events.sql, schema-patients-v2.sql,
//   schema-users.sql, schema-appointments.sql, schema-messages.sql,
//   schema-documents.sql were applied IN ORDER.
// Firebase auth is stubbed: the caller's email comes from the
// x-test-email header, so tests can act as different staff.
// The manager PIN ('1234' for doc-manager@example.com, hashed
// with lib/pin.js hashPin) travels in the x-manager-pin header.
const express = require('express');
const { Pool } = require('pg');

process.env.PORT = '3107';
const pool = new Pool();
const documentsRouter = require('./routes/documents');
const eventsRouter = require('./routes/events');
const { hashPin } = require('./lib/pin');

const BASE = 'http://127.0.0.1:3107';
let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

async function call(method, path, as, body, pin) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-test-email': as,
      ...(pin !== undefined ? { 'x-manager-pin': pin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
}

const AUTHOR = 'doc-author@example.com';
const OTHER = 'doc-other@example.com';
const MANAGER = 'doc-manager@example.com';
const NOBODY = 'doc-nobody@example.com';

async function cleanup() {
  // FK order: documents first (they reference patients, users and
  // appointments), then the test appointments, then their
  // category, then the test patients and users.
  await pool.query('DELETE FROM documents');
  await pool.query("DELETE FROM appointments WHERE title = 'DocTest visit'");
  await pool.query("DELETE FROM appointment_categories WHERE name = 'DocTest Category'");
  await pool.query(
    "DELETE FROM patients WHERE fname LIKE 'DocTest%'",
  );
  await pool.query(
    'DELETE FROM users WHERE email IN ($1, $2, $3)',
    [AUTHOR, OTHER, MANAGER],
  );
  // Note: document_* rows stay in event_log — patient_id there is
  // informational only (no FK, see schema-events.sql) and the
  // table is append-only by design, even for tests.
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { uid: 'test-uid', email: req.headers['x-test-email'] || AUTHOR };
    next();
  });
  app.use('/documents', documentsRouter);
  app.use('/events', eventsRouter);
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'boom' });
  });
  const server = app.listen(3107);
  try {
    await cleanup();
    const a = await pool.query(
      `INSERT INTO users (email, role, authorized, active, fname, lname)
       VALUES ($1, 'clinician', true, true, 'Doc', 'Author') RETURNING id`,
      [AUTHOR],
    );
    const authorId = Number(a.rows[0].id);
    await pool.query(
      `INSERT INTO users (email, role, authorized, active, fname, lname)
       VALUES ($1, 'clinician', true, true, 'Doc', 'Other')`,
      [OTHER],
    );
    await pool.query(
      `INSERT INTO users (email, role, authorized, active, fname, lname, pin_hash)
       VALUES ($1, 'manager', true, true, 'Doc', 'Manager', $2)`,
      [MANAGER, await hashPin('1234')],
    );
    const liveP = await pool.query(
      `INSERT INTO patients (fname, lname) VALUES ('DocTest', 'Live') RETURNING id`,
    );
    const livePatient = liveP.rows[0].id;
    const deadP = await pool.query(
      `INSERT INTO patients (fname, lname, deleted_at)
       VALUES ('DocTest', 'Gone', now()) RETURNING id`,
    );
    const deadPatient = deadP.rows[0].id;
    const otherP = await pool.query(
      `INSERT INTO patients (fname, lname) VALUES ('DocTest', 'Other') RETURNING id`,
    );
    const otherPatient = otherP.rows[0].id;

    // Appointments need a category and the default 'booked'
    // status row (FK from appointments.status).
    await pool.query(
      `INSERT INTO appointment_categories (name, cattype)
       VALUES ('DocTest Category', 'appointment')
       ON CONFLICT (name) DO NOTHING`,
    );
    const cat = await pool.query(
      'SELECT id FROM appointment_categories WHERE name = $1',
      ['DocTest Category'],
    );
    const catId = cat.rows[0].id;
    await pool.query(
      `INSERT INTO appointment_statuses (code, label)
       VALUES ('booked', 'Booked')
       ON CONFLICT (code) DO NOTHING`,
    );
    const apptLive = await pool.query(
      `INSERT INTO appointments (patient_id, category_id, title, starts_at, ends_at)
       VALUES ($1, $2, 'DocTest visit', now(), now() + interval '1 hour') RETURNING id`,
      [livePatient, catId],
    );
    const liveApptId = Number(apptLive.rows[0].id);
    const apptOther = await pool.query(
      `INSERT INTO appointments (patient_id, category_id, title, starts_at, ends_at)
       VALUES ($1, $2, 'DocTest visit', now(), now() + interval '1 hour') RETURNING id`,
      [otherPatient, catId],
    );
    const otherApptId = Number(apptOther.rows[0].id);

    // --- identity: caller must resolve to an active staff row
    let r = await call('POST', '/documents', NOBODY, {
      patient_id: livePatient, doc_type: 'evaluation',
    });
    check('unknown caller POST → 403 NO_STAFF_RECORD',
      r.status === 403 && (await r.json()).code === 'NO_STAFF_RECORD', `got ${r.status}`);
    r = await call('GET', `/documents?patient_id=${livePatient}`, NOBODY);
    check('unknown caller GET list → 403 NO_STAFF_RECORD',
      r.status === 403 && (await r.json()).code === 'NO_STAFF_RECORD', `got ${r.status}`);

    // --- create: defaults from the template
    r = await call('POST', '/documents', AUTHOR, {
      patient_id: livePatient, doc_type: 'evaluation',
    });
    const docA = (await r.json()).document;
    check('create evaluation with no sections → 201, draft',
      r.status === 201 && docA && docA.status === 'draft', `got ${r.status}`);
    check('sections contain all 4 template keys as empty strings',
      docA && ['subjective', 'objective', 'assessment', 'plan_of_care']
        .every((k) => docA.sections[k] === ''));
    check('author is the caller',
      docA && Number(docA.author_id) === authorId && docA.author_email === AUTHOR);
    check('title defaults to "Physical Therapy Evaluation"',
      docA && docA.title === 'Physical Therapy Evaluation');

    // --- create: supplied sections are stored
    r = await call('POST', '/documents', AUTHOR, {
      patient_id: livePatient,
      doc_type: 'evaluation',
      sections: { subjective: 'SECRET-SECTION-TEXT knee pain' },
    });
    const docB = (await r.json()).document;
    check('create with sections → 201, section stored and returned',
      r.status === 201 && docB && docB.sections.subjective === 'SECRET-SECTION-TEXT knee pain',
      `got ${r.status}`);

    // --- create: validation
    r = await call('POST', '/documents', AUTHOR, {
      patient_id: livePatient, doc_type: 'progress_note',
    });
    check('invalid doc_type → 400', r.status === 400, `got ${r.status}`);
    r = await call('POST', '/documents', AUTHOR, {
      patient_id: livePatient, doc_type: 'evaluation', sections: { not_a_section: 'x' },
    });
    check('unknown section key → 400 VALIDATION',
      r.status === 400 && (await r.json()).code === 'VALIDATION', `got ${r.status}`);
    r = await call('POST', '/documents', AUTHOR, {
      patient_id: livePatient, doc_type: 'evaluation', sections: { subjective: 42 },
    });
    check('non-string section value → 400 VALIDATION',
      r.status === 400 && (await r.json()).code === 'VALIDATION', `got ${r.status}`);
    r = await call('POST', '/documents', AUTHOR, {
      patient_id: deadPatient, doc_type: 'evaluation',
    });
    check('soft-deleted patient → 400 PATIENT_NOT_FOUND',
      r.status === 400 && (await r.json()).code === 'PATIENT_NOT_FOUND', `got ${r.status}`);
    r = await call('POST', '/documents', AUTHOR, {
      patient_id: 'not-a-uuid', doc_type: 'evaluation',
    });
    check('malformed patient_id → 400', r.status === 400, `got ${r.status}`);
    r = await call('POST', '/documents', AUTHOR, {
      patient_id: livePatient, doc_type: 'evaluation', appointment_id: otherApptId,
    });
    check("another patient's appointment → 400 APPOINTMENT_PATIENT_MISMATCH",
      r.status === 400 && (await r.json()).code === 'APPOINTMENT_PATIENT_MISMATCH',
      `got ${r.status}`);
    r = await call('POST', '/documents', AUTHOR, {
      patient_id: livePatient, doc_type: 'evaluation', appointment_id: 999999,
    });
    check('unknown appointment → 400 APPOINTMENT_NOT_FOUND',
      r.status === 400 && (await r.json()).code === 'APPOINTMENT_NOT_FOUND', `got ${r.status}`);
    r = await call('POST', '/documents', AUTHOR, {
      patient_id: livePatient, doc_type: 'reassessment', appointment_id: liveApptId,
    });
    const docC = (await r.json()).document;
    check("patient's own appointment → 201 and appointment_id set",
      r.status === 201 && docC && Number(docC.appointment_id) === liveApptId,
      `got ${r.status}`);

    // A document on the other patient, for the list-exclusion checks.
    r = await call('POST', '/documents', OTHER, {
      patient_id: otherPatient, doc_type: 'discharge',
    });
    const docOther = (await r.json()).document;
    check('create discharge for other patient → 201',
      r.status === 201 && docOther && docOther.doc_type === 'discharge', `got ${r.status}`);

    // --- list
    r = await call('GET', `/documents?patient_id=${livePatient}`, AUTHOR);
    const list = (await r.json()).documents;
    check('list returns the patient\'s docs newest first',
      Array.isArray(list) && list.length === 3
        && Number(list[0].id) === Number(docC.id)
        && Number(list[1].id) === Number(docB.id)
        && Number(list[2].id) === Number(docA.id));
    check('list excludes other patient\'s docs',
      Array.isArray(list) && !list.some((d) => Number(d.id) === Number(docOther.id)));
    r = await call('GET', '/documents', AUTHOR);
    check('list without patient_id → 400 VALIDATION',
      r.status === 400 && (await r.json()).code === 'VALIDATION', `got ${r.status}`);

    // --- get one
    r = await call('GET', `/documents/${docA.id}`, OTHER);
    const got = (await r.json()).document;
    check('GET /:id returns the doc (any staff)',
      r.status === 200 && got && Number(got.id) === Number(docA.id), `got ${r.status}`);
    r = await call('GET', '/documents/999999', AUTHOR);
    check('GET unknown id → 404', r.status === 404, `got ${r.status}`);

    // --- edit a draft (not PIN-gated)
    r = await call('PUT', `/documents/${docA.id}`, AUTHOR, {
      title: 'Eval — updated',
      sections: { assessment: 'Improving gait.' },
    });
    const edited = (await r.json()).document;
    check('PUT draft edits title + a section → 200',
      r.status === 200 && edited && edited.title === 'Eval — updated'
        && edited.sections.assessment === 'Improving gait.'
        && edited.sections.subjective === '',
      `got ${r.status}`);
    r = await call('GET', `/documents/${docA.id}`, AUTHOR);
    check('PUT edits persisted',
      (await r.json()).document?.sections?.assessment === 'Improving gait.');

    // --- finalize (not PIN-gated), then the lock bites
    r = await call('POST', `/documents/${docA.id}/finalize`, AUTHOR);
    const fin = (await r.json()).document;
    check('finalize without PIN → 200, finalized_at/finalized_by set',
      r.status === 200 && fin && fin.status === 'finalized'
        && fin.finalized_at !== null && Number(fin.finalized_by) === authorId,
      `got ${r.status}`);
    r = await call('PUT', `/documents/${docA.id}`, AUTHOR, { title: 'too late' });
    check('PUT after finalize → 409 DOCUMENT_FINALIZED',
      r.status === 409 && (await r.json()).code === 'DOCUMENT_FINALIZED', `got ${r.status}`);
    r = await call('POST', `/documents/${docA.id}/finalize`, AUTHOR);
    check('finalize again → 409 DOCUMENT_FINALIZED',
      r.status === 409 && (await r.json()).code === 'DOCUMENT_FINALIZED', `got ${r.status}`);

    // --- delete / restore (manager ROLE; the PIN and its borrowed
    // authority were retired on 2026-11-02)
    r = await call('DELETE', `/documents/${docB.id}`, AUTHOR);
    check('DELETE as clinician → 403 ROLE_REQUIRED',
      r.status === 403 && (await r.json()).code === 'ROLE_REQUIRED', `got ${r.status}`);
    r = await call('DELETE', `/documents/${docB.id}`, MANAGER);
    const deleted = (await r.json()).document;
    check('DELETE as manager → 200 and deleted_at set',
      r.status === 200 && deleted && deleted.deleted_at !== null, `got ${r.status}`);
    r = await call('GET', `/documents/${docB.id}`, AUTHOR);
    check('GET after delete → 404', r.status === 404, `got ${r.status}`);
    r = await call('GET', `/documents?patient_id=${livePatient}`, AUTHOR);
    check('list excludes the deleted doc',
      !(await r.json()).documents.some((d) => Number(d.id) === Number(docB.id)));
    r = await call('POST', `/documents/${docB.id}/restore`, MANAGER);
    const restored = (await r.json()).document;
    check('restore as manager → 200, deleted_at null',
      r.status === 200 && restored && restored.deleted_at === null, `got ${r.status}`);
    r = await call('GET', `/documents/${docB.id}`, AUTHOR);
    check('GET works again after restore', r.status === 200, `got ${r.status}`);
    r = await call('POST', `/documents/${docB.id}/restore`, MANAGER);
    check('restore when not deleted → 409 NOT_DELETED',
      r.status === 409 && (await r.json()).code === 'NOT_DELETED', `got ${r.status}`);

    // --- events: create / update / finalize, metadata only
    r = await call('GET', '/events?event=document_create&limit=100', AUTHOR);
    const creates = await r.json();
    check('document_create events logged for the created doc',
      creates.some((e) => e.details?.document_id === Number(docA.id)
        && e.details?.doc_type === 'evaluation'
        && e.details?.author_id === authorId));
    r = await call('GET', '/events?event=document_update&limit=100', AUTHOR);
    const updates = await r.json();
    check('document_update events logged (edit + delete + restore)',
      updates.some((e) => e.details?.document_id === Number(docA.id))
        && updates.some((e) => e.details?.document_id === Number(docB.id)
          && e.details?.action === 'document_delete')
        && updates.some((e) => e.details?.document_id === Number(docB.id)
          && e.details?.action === 'document_restore'));
    r = await call('GET', '/events?event=document_finalize&limit=100', AUTHOR);
    const finalizes = await r.json();
    check('document_finalize event logged for the finalized doc',
      finalizes.some((e) => e.details?.document_id === Number(docA.id)
        && e.details?.doc_type === 'evaluation'));
    check('event details never contain section content',
      [...creates, ...updates, ...finalizes]
        .every((e) => !JSON.stringify(e.details).includes('SECRET-SECTION-TEXT')));
  } finally {
    await cleanup();
    server.close();
    await pool.end();
  }
  console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILURES`} (${passed} passed)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
