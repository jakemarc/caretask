// End-to-end test for the message routes (Phase 1 messaging).
// Runs against a scratch Postgres — same env contract as the
// other suites:
//   PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE must point at a db
//   where schema.sql, schema-events.sql, schema-patients-v2.sql,
//   schema-users.sql, schema-messages.sql were applied IN ORDER.
// Firebase auth is stubbed: the caller's email comes from the
// x-test-email header, so tests can act as different staff.
const express = require('express');
const { Pool } = require('pg');

process.env.PORT = '3106';
const pool = new Pool();
const messagesRouter = require('./routes/messages');
const eventsRouter = require('./routes/events');

const BASE = 'http://127.0.0.1:3106';
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

async function call(method, path, as, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-test-email': as,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
}

const SENDER = 'msg-sender@example.com';
const RECIP = 'msg-recipient@example.com';
const THIRD = 'msg-third@example.com';
const NOBODY = 'msg-nobody@example.com';

async function cleanup() {
  await pool.query('DELETE FROM messages');
  await pool.query(
    "DELETE FROM users WHERE email IN ($1, $2, $3)",
    [SENDER, RECIP, THIRD],
  );
  await pool.query(
    "DELETE FROM patients WHERE fname LIKE 'MsgTest%'",
  );
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { uid: 'test-uid', email: req.headers['x-test-email'] || SENDER };
    next();
  });
  app.use('/messages', messagesRouter);
  app.use('/events', eventsRouter);
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'boom' });
  });
  const server = app.listen(3106);
  try {
    await cleanup();
    const s = await pool.query(
      `INSERT INTO users (email, role, authorized, active, fname, lname)
       VALUES ($1, 'clinician', true, true, 'Msg', 'Sender') RETURNING id`,
      [SENDER],
    );
    const senderId = Number(s.rows[0].id);
    const rc = await pool.query(
      `INSERT INTO users (email, role, authorized, active, fname, lname)
       VALUES ($1, 'clinician', true, true, 'Msg', 'Recipient') RETURNING id`,
      [RECIP],
    );
    const recipId = Number(rc.rows[0].id);
    await pool.query(
      `INSERT INTO users (email, role, authorized, active, fname, lname)
       VALUES ($1, 'front_office', false, true, 'Msg', 'Third')`,
      [THIRD],
    );
    const liveP = await pool.query(
      `INSERT INTO patients (fname, lname) VALUES ('MsgTest', 'Live') RETURNING id`,
    );
    const livePatient = liveP.rows[0].id;
    const deadP = await pool.query(
      `INSERT INTO patients (fname, lname, deleted_at)
       VALUES ('MsgTest', 'Gone', now()) RETURNING id`,
    );
    const deadPatient = deadP.rows[0].id;

    // --- identity
    let r = await call('GET', '/messages', NOBODY);
    check('unknown caller → 403 NO_STAFF_RECORD',
      r.status === 403 && (await r.json()).code === 'NO_STAFF_RECORD', `got ${r.status}`);

    // --- direct message flow
    r = await call('POST', '/messages', SENDER, {
      recipient_id: recipId, subject: 'Thursday coverage', body: 'Can you cover my 2pm revisit?',
    });
    const dm = (await r.json()).message;
    check('send DM → 201 + self thread', r.status === 201 && dm && Number(dm.thread_id) === Number(dm.id),
      `got ${r.status}`);
    r = await call('GET', '/messages', RECIP);
    let list = (await r.json()).messages;
    check('recipient inbox has the DM, unread',
      list.length === 1 && list[0].read_at === null
        && list[0].sender_name === 'Msg Sender');
    r = await call('GET', '/messages', SENDER);
    check('sender inbox empty', (await r.json()).messages.length === 0);
    r = await call('GET', '/messages?sent=1', SENDER);
    check('sender outbox has it', (await r.json()).messages.length === 1);
    r = await call('GET', '/messages', THIRD);
    check('third party inbox empty', (await r.json()).messages.length === 0);
    r = await call('GET', '/messages?unread=1', RECIP);
    check('unread filter shows it', (await r.json()).messages.length === 1);

    // --- read receipts
    r = await call('POST', `/messages/${dm.id}/read`, SENDER);
    check('sender cannot mark read → 403', r.status === 403, `got ${r.status}`);
    r = await call('POST', `/messages/${dm.id}/read`, THIRD);
    check('third party cannot mark read → 403', r.status === 403, `got ${r.status}`);
    r = await call('POST', `/messages/${dm.id}/read`, RECIP);
    const readRow = (await r.json()).message;
    check('recipient marks read → 200 + read_at set',
      r.status === 200 && readRow.read_at !== null, `got ${r.status}`);
    r = await call('POST', `/messages/${dm.id}/read`, RECIP);
    check('second mark-read is idempotent 200', r.status === 200, `got ${r.status}`);
    r = await call('GET', '/messages?unread=1', RECIP);
    check('unread filter now empty', (await r.json()).messages.length === 0);

    // --- chart messages
    r = await call('POST', '/messages', SENDER, {
      patient_id: livePatient, body: 'Family called about Thursday.',
    });
    const chartMsg = (await r.json()).message;
    check('chart message (no recipient) → 201',
      r.status === 201 && chartMsg.recipient_id === null, `got ${r.status}`);
    r = await call('GET', `/messages/patient/${livePatient}`, THIRD);
    check('chart is care-team readable (third staff can read)',
      (await r.json()).messages.length === 1);
    r = await call('GET', '/messages', RECIP);
    check('chart message does not land in an inbox',
      (await r.json()).messages.length === 1);
    r = await call('POST', '/messages', SENDER, {
      recipient_id: recipId, patient_id: livePatient, body: 'Revisit moved to 3pm.',
    });
    check('DM + patient link → 201', r.status === 201, `got ${r.status}`);
    r = await call('GET', `/messages/patient/${livePatient}`, RECIP);
    check('linked DM also appears on the chart',
      (await r.json()).messages.length === 2);

    // --- threads
    r = await call('POST', '/messages', RECIP, {
      recipient_id: senderId, thread_id: dm.thread_id, body: 'Covered — swapped with Dana.',
    });
    const reply = (await r.json()).message;
    check('reply joins the thread', r.status === 201 && Number(reply.thread_id) === Number(dm.thread_id),
      `got ${r.status}`);
    r = await call('GET', `/messages/threads/${dm.thread_id}`, THIRD);
    check('DM thread closed to third party → 403', r.status === 403, `got ${r.status}`);
    r = await call('GET', `/messages/threads/${dm.thread_id}`, SENDER);
    check('participant reads thread (2 msgs, oldest first)',
      (await r.json()).messages.length === 2);
    r = await call('GET', `/messages/threads/${chartMsg.thread_id}`, THIRD);
    check('chart thread readable by care team', r.status === 200, `got ${r.status}`);

    // --- validation
    r = await call('POST', '/messages', SENDER, { recipient_id: recipId, body: '   ' });
    check('empty body → 400', r.status === 400, `got ${r.status}`);
    r = await call('POST', '/messages', SENDER, { body: 'no target' });
    check('no recipient and no patient → 400 TARGET_REQUIRED',
      r.status === 400 && (await r.json()).code === 'TARGET_REQUIRED', `got ${r.status}`);
    r = await call('POST', '/messages', SENDER, { recipient_id: 999999, body: 'hi' });
    check('unknown recipient → 400 RECIPIENT_NOT_FOUND',
      r.status === 400 && (await r.json()).code === 'RECIPIENT_NOT_FOUND', `got ${r.status}`);
    r = await call('POST', '/messages', SENDER, { patient_id: deadPatient, body: 'hi' });
    check('soft-deleted patient → 400 PATIENT_NOT_FOUND',
      r.status === 400 && (await r.json()).code === 'PATIENT_NOT_FOUND', `got ${r.status}`);
    r = await call('POST', '/messages', SENDER, { patient_id: 'not-a-uuid', body: 'hi' });
    check('malformed patient id → 400', r.status === 400, `got ${r.status}`);

    // --- delete (sender only)
    r = await call('DELETE', `/messages/${reply.id}`, SENDER);
    check('non-sender delete → 403', r.status === 403, `got ${r.status}`);
    r = await call('DELETE', `/messages/${reply.id}`, RECIP);
    check('sender delete → 200', r.status === 200, `got ${r.status}`);
    r = await call('GET', `/messages/threads/${dm.thread_id}`, SENDER);
    check('deleted message leaves the thread',
      (await r.json()).messages.length === 1);

    // --- events: send + read, metadata only
    r = await call('GET', '/events?event=message_send&limit=100', SENDER);
    const sends = await r.json();
    check('message_send events logged',
      sends.some((e) => e.details?.message_id === Number(dm.id)
        && e.details?.recipient_id === recipId));
    check('event details never contain the body',
      sends.every((e) => !JSON.stringify(e.details).includes('cover my 2pm')));
    r = await call('GET', '/events?event=message_read&limit=100', SENDER);
    const reads = await r.json();
    check('exactly one message_read for the DM (idempotent re-read added none)',
      reads.filter((e) => e.details?.message_id === Number(dm.id)).length === 1);
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
