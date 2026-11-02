// End-to-end tests for the clinician tasks API — LOCAL TEST ONLY,
// same conventions as e2e-test.js. Against a real Postgres (full
// schema chain incl. schema-tasks.sql), this proves: create +
// validation → owner-only visibility (someone else's task reads as
// not-found) → patient linking and filtering → done/reopen →
// soft delete → task_change events carry ids only.
//
// Stub auth: an x-test-user header picks the seeded staff member
// (owner / other / ghost — ghost has no staff record).
//
// Run: PGDATABASE=caretask_demo E2E_PORT=3114 node e2e-tasks-test.js
const express = require('express');
const pool = require('./db');
const tasksRouter = require('./routes/tasks');

const PORT = Number(process.env.E2E_PORT || 3114);
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
  owner: { uid: 'task-owner-uid', email: 'taskowner@example.com' },
  other: { uid: 'task-other-uid', email: 'taskother@example.com' },
  ghost: { uid: 'task-ghost-uid', email: 'taskghost@example.com' },
};

function stubAuth(req, res, next) {
  const who = USERS[req.headers['x-test-user']] || USERS.owner;
  req.user = { uid: who.uid, email: who.email };
  next();
}

async function call(method, path, { as = 'owner', body } = {}) {
  const headers = { 'Content-Type': 'application/json', 'x-test-user': as };
  const res = await fetch(`${BASE}${path}`, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { res, json: await res.json().catch(() => null) };
}

async function main() {
  await pool.query(
    `INSERT INTO users (firebase_uid, email, role, fname, lname, active)
     VALUES ($1, $2, 'clinician', 'Tessa', 'Owner', true),
            ($3, $4, 'clinician', 'Otto', 'Other', true)
     ON CONFLICT (email) DO NOTHING`,
    [USERS.owner.uid, USERS.owner.email, USERS.other.uid, USERS.other.email]
  );
  const patientId = (await pool.query(
    `INSERT INTO patients (fname, lname) VALUES ('Task', 'Patient')
     RETURNING id`
  )).rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/tasks', stubAuth, tasksRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: 'internal' }));
  const server = app.listen(PORT);
  try {
    console.log('create + validation:');
    let r = await call('POST', '/tasks', { body: { title: '  ' } });
    check('blank title refused', r.res.status === 400 && r.json.error === 'TITLE_REQUIRED');
    r = await call('POST', '/tasks', {
      body: { title: 'Bad patient link', patient_id: '123e4567-e89b-12d3-a456-426614174000' },
    });
    check('unknown patient refused', r.res.status === 400 && r.json.error === 'PATIENT_NOT_FOUND');
    r = await call('POST', '/tasks', {
      body: { title: 'Bad due', due_at: 'next tuesday-ish' },
    });
    check('garbage due_at refused', r.res.status === 400 && r.json.error === 'DUE_INVALID');
    r = await call('POST', '/tasks', { as: 'ghost', body: { title: 'Boo' } });
    check('no staff record → 403', r.res.status === 403 && r.json.error === 'NO_STAFF_RECORD',
      `got ${r.res.status} ${JSON.stringify(r.json)}`);

    r = await call('POST', '/tasks', {
      body: { title: 'Call the clinic about the referral', due_at: '2026-11-02T15:00:00Z' },
    });
    check('general task created', r.res.status === 201 && r.json.task.done === false,
      `got ${r.res.status}`);
    const generalId = r.json.task.id;
    r = await call('POST', '/tasks', {
      body: { title: 'Re-check wound at next visit', patient_id: patientId },
    });
    check('patient task created with name',
      r.res.status === 201 && r.json.task.patient_name === 'Task Patient',
      JSON.stringify(r.json));
    const patientTaskId = r.json.task.id;

    console.log('list + isolation:');
    r = await call('GET', '/tasks');
    check('owner sees both open tasks', r.json.tasks.length === 2, `got ${r.json.tasks.length}`);
    r = await call('GET', '/tasks', { as: 'other' });
    check('other clinician sees none', r.json.tasks.length === 0);
    r = await call('GET', `/tasks?patient_id=${patientId}`);
    check('patient filter narrows to the linked task',
      r.json.tasks.length === 1 && r.json.tasks[0].id === patientTaskId);
    r = await call('GET', '/tasks?scope=done');
    check('done scope starts empty', r.json.tasks.length === 0);

    console.log('update + done:');
    r = await call('PUT', `/tasks/${generalId}`, { as: 'other', body: { done: true } });
    check("another clinician's task is not-found",
      r.res.status === 404 && r.json.error === 'TASK_NOT_FOUND', `got ${r.res.status}`);
    r = await call('PUT', `/tasks/${generalId}`, { body: { done: true } });
    check('done toggle sets done', r.res.status === 200 && r.json.task.done === true);
    r = await call('GET', '/tasks');
    check('open list drops the done task', r.json.tasks.length === 1);
    r = await call('GET', '/tasks?scope=done');
    check('done scope shows it', r.json.tasks.length === 1);
    r = await call('PUT', `/tasks/${generalId}`, {
      body: { done: false, title: 'Call the clinic about the referral (updated)', due_at: null },
    });
    check('reopen + edit + clear due',
      r.res.status === 200 && r.json.task.done === false &&
      r.json.task.title.endsWith('(updated)') && r.json.task.due_at === null);
    r = await call('PUT', `/tasks/${patientTaskId}`, { body: { patient_id: null } });
    check('patient link can be cleared',
      r.res.status === 200 && r.json.task.patient_id === null);

    console.log('delete:');
    r = await call('DELETE', `/tasks/${generalId}`, { as: 'other' });
    check("another clinician cannot delete it", r.res.status === 404);
    r = await call('DELETE', `/tasks/${generalId}`);
    check('owner delete is 204', r.res.status === 204, `got ${r.res.status}`);
    r = await call('GET', '/tasks?scope=all');
    check('deleted task is gone from all scopes', r.json.tasks.length === 1);
    r = await call('DELETE', `/tasks/${generalId}`);
    check('second delete 404s', r.res.status === 404);

    const ev = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM event_log WHERE event = 'task_change'`
    )).rows[0].n;
    check('task_change events recorded', ev >= 5, `got ${ev}`);
    const leak = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM event_log
        WHERE event = 'task_change' AND details::text ILIKE '%referral%'`
    )).rows[0].n;
    check('event details carry no task titles', leak === 0, `got ${leak}`);
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
