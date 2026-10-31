// Message routes for the CareTask demo API — Phase 1 of the
// messaging scope (2026-10-30), modeled on OpenEMR's Messages
// center + patient-attached chart messages.
//
// Endpoints (mounted under /messages by server.js, behind
// requireAuth):
//   GET    /messages               my inbox (newest first);
//                                  ?sent=1 → my outbox;
//                                  ?unread=1 → unread only
//   GET    /messages/patient/:uuid chart messages for a patient
//                                  (care-team visible, oldest first)
//   GET    /messages/threads/:id   one conversation (oldest first)
//   POST   /messages               send (NOT PIN-gated — messaging
//                                  is a front-desk act, like
//                                  booking an appointment)
//   POST   /messages/:id/read      mark read (recipient only)
//   DELETE /messages/:id           SOFT delete (sender only)
//
// The caller must resolve to an ACTIVE users row (by firebase_uid
// or email — same matching as GET /users/me): messages are
// staff-internal, so there is no anonymous or patient sender.
// Sends and reads write message_send / message_read events in the
// same transaction; event details carry ids only, NEVER the body.
const express = require('express');
const pool = require('../db');
const { insertEvent } = require('../lib/eventLog');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT = `
  SELECT m.id, m.thread_id, m.sender_id,
         (s.fname || ' ' || s.lname) AS sender_name, s.email AS sender_email,
         m.recipient_id,
         CASE WHEN r.id IS NULL THEN NULL ELSE (r.fname || ' ' || r.lname) END AS recipient_name,
         m.patient_id,
         CASE WHEN p.id IS NULL THEN NULL ELSE (p.fname || ' ' || p.lname) END AS patient_name,
         m.subject, m.body, m.read_at, m.created_at, m.deleted_at
    FROM messages m
    JOIN users s ON s.id = m.sender_id
    LEFT JOIN users r ON r.id = m.recipient_id
    LEFT JOIN patients p ON p.id = m.patient_id`;

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

async function resolveMe(db, req) {
  const r = await db.query(
    `SELECT * FROM users
      WHERE active = true
        AND (firebase_uid = $1 OR lower(email) = lower($2))
      ORDER BY (firebase_uid = $1) DESC
      LIMIT 1`,
    [req.user.uid, req.user.email],
  );
  if (!r.rows.length) {
    throw httpError(403, 'no active staff record for this sign-in', 'NO_STAFF_RECORD');
  }
  return r.rows[0];
}

async function fetchOne(db, id) {
  const r = await db.query(`${SELECT} WHERE m.id = $1`, [id]);
  return r.rows[0] ?? null;
}

// Defined BEFORE /:id/read and /threads so literal segments win.
router.get('/patient/:uuid', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.uuid)) {
      return res.status(400).json({ error: 'patient id must be a UUID', code: 'VALIDATION' });
    }
    await resolveMe(pool, req);
    const r = await pool.query(
      `${SELECT} WHERE m.patient_id = $1 AND m.deleted_at IS NULL
        ORDER BY m.created_at ASC`,
      [req.params.uuid],
    );
    res.json({ messages: r.rows });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

router.get('/threads/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });
    const me = await resolveMe(pool, req);
    const r = await pool.query(
      `${SELECT} WHERE m.thread_id = $1 AND m.deleted_at IS NULL
        ORDER BY m.created_at ASC`,
      [id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'thread not found' });
    // Access: participants of the thread, or any staff when the
    // thread is attached to a patient (care-team chart access).
    const chartLinked = r.rows.some((m) => m.patient_id);
    const participant = r.rows.some(
      (m) => Number(m.sender_id) === Number(me.id) || Number(m.recipient_id) === Number(me.id),
    );
    if (!chartLinked && !participant) {
      return res.status(403).json({ error: 'not a participant of this thread', code: 'FORBIDDEN' });
    }
    res.json({ messages: r.rows });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const sent = req.query.sent === '1';
    const clauses = ['m.deleted_at IS NULL'];
    const params = [me.id];
    clauses.push(sent ? 'm.sender_id = $1' : 'm.recipient_id = $1');
    if (!sent && req.query.unread === '1') clauses.push('m.read_at IS NULL');
    const r = await pool.query(
      `${SELECT} WHERE ${clauses.join(' AND ')} ORDER BY m.created_at DESC LIMIT 200`,
      params,
    );
    res.json({ messages: r.rows, me_id: me.id });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const body = req.body ?? {};
    if (typeof body.body !== 'string' || !body.body.trim()) {
      return res.status(400).json({ error: 'body is required', code: 'VALIDATION' });
    }
    if (body.subject !== undefined && body.subject !== null && typeof body.subject !== 'string') {
      return res.status(400).json({ error: 'subject must be a string or null', code: 'VALIDATION' });
    }
    let recipientId = body.recipient_id ?? null;
    if (typeof recipientId === 'string' && /^\d+$/.test(recipientId)) recipientId = Number(recipientId);
    if (recipientId !== null && !Number.isInteger(recipientId)) {
      return res.status(400).json({ error: 'recipient_id must be an integer', code: 'VALIDATION' });
    }
    const patientId = body.patient_id ?? null;
    if (patientId !== null && (typeof patientId !== 'string' || !UUID_RE.test(patientId))) {
      return res.status(400).json({ error: 'patient_id must be a UUID', code: 'VALIDATION' });
    }
    if (recipientId === null && patientId === null) {
      return res.status(400).json({
        error: 'a message needs a recipient or a patient to attach to',
        code: 'TARGET_REQUIRED',
      });
    }
    let threadId = body.thread_id ?? null;
    if (typeof threadId === 'string' && /^\d+$/.test(threadId)) threadId = Number(threadId);
    if (threadId !== null && !Number.isInteger(threadId)) {
      return res.status(400).json({ error: 'thread_id must be an integer', code: 'VALIDATION' });
    }

    const created = await withTx(async (client) => {
      if (recipientId !== null) {
        const u = await client.query(
          'SELECT id FROM users WHERE id = $1 AND active = true',
          [recipientId],
        );
        if (!u.rows.length) throw httpError(400, 'recipient not found', 'RECIPIENT_NOT_FOUND');
      }
      if (patientId !== null) {
        const p = await client.query(
          'SELECT id FROM patients WHERE id = $1 AND deleted_at IS NULL',
          [patientId],
        );
        if (!p.rows.length) throw httpError(400, 'patient not found', 'PATIENT_NOT_FOUND');
      }
      if (threadId !== null) {
        const t = await client.query(
          'SELECT id FROM messages WHERE thread_id = $1 LIMIT 1',
          [threadId],
        );
        if (!t.rows.length) throw httpError(400, 'thread not found', 'THREAD_NOT_FOUND');
      }
      const r = await client.query(
        `INSERT INTO messages (thread_id, sender_id, recipient_id, patient_id, subject, body)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [threadId, me.id, recipientId, patientId, body.subject ?? null, body.body.trim()],
      );
      const id = r.rows[0].id;
      // A root message is its own thread.
      if (threadId === null) {
        await client.query('UPDATE messages SET thread_id = id WHERE id = $1', [id]);
      }
      const row = await fetchOne(client, id);
      await insertEvent(client, {
        actor: req.user,
        event: 'message_send',
        patientId,
        details: {
          message_id: Number(id),
          thread_id: Number(row.thread_id),
          recipient_id: recipientId,
        },
        ip: req.ip,
      });
      return row;
    });
    res.status(201).json({ message: created });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

router.post('/:id/read', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });
    const me = await resolveMe(pool, req);
    const done = await withTx(async (client) => {
      const cur = await fetchOne(client, id);
      if (!cur || cur.deleted_at) return null;
      if (Number(cur.recipient_id) !== Number(me.id)) return 'not_recipient';
      if (cur.read_at) return cur; // already read — idempotent, no new event
      await client.query('UPDATE messages SET read_at = now() WHERE id = $1', [id]);
      await insertEvent(client, {
        actor: req.user,
        event: 'message_read',
        patientId: cur.patient_id,
        details: { message_id: id, thread_id: Number(cur.thread_id) },
        ip: req.ip,
      });
      return fetchOne(client, id);
    });
    if (!done) return res.status(404).json({ error: 'message not found' });
    if (done === 'not_recipient') {
      return res.status(403).json({ error: 'only the recipient can mark a message read', code: 'FORBIDDEN' });
    }
    res.json({ message: done });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });
    const me = await resolveMe(pool, req);
    const done = await withTx(async (client) => {
      const cur = await fetchOne(client, id);
      if (!cur || cur.deleted_at) return null;
      if (Number(cur.sender_id) !== Number(me.id)) return 'not_sender';
      await client.query('UPDATE messages SET deleted_at = now() WHERE id = $1', [id]);
      return fetchOne(client, id);
    });
    if (!done) return res.status(404).json({ error: 'message not found' });
    if (done === 'not_sender') {
      return res.status(403).json({ error: 'only the sender can delete a message', code: 'FORBIDDEN' });
    }
    res.json({ message: done });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

module.exports = router;
