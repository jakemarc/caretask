// Document routes for the CareTask demo API — clinical
// documentation v1 (2026-10-30), modeled on OpenEMR's encounter
// forms: a document belongs to a patient (optionally to one of
// that patient's appointments), is authored by a staff user, and
// holds its content as sections JSONB whose keys come from the
// template for its doc_type (see lib/documentTemplates.js).
//
// Endpoints (mounted under /documents by server.js, behind
// requireAuth):
//   GET    /documents?patient_id=<uuid>  a patient's documents,
//                                  newest first (patient_id required)
//   GET    /documents/:id          one document
//   POST   /documents              create draft (NOT PIN-gated —
//                                  documenting is a clinician act)
//   PUT    /documents/:id          edit a draft (NOT PIN-gated);
//                                  a finalized document is locked
//                                  → 409 DOCUMENT_FINALIZED
//   POST   /documents/:id/finalize finalize (e-sign pattern: locks
//                                  the document, stamps
//                                  finalized_at / finalized_by)
//   DELETE /documents/:id          SOFT delete (MANAGER PIN required)
//   POST   /documents/:id/restore  undo soft delete (PIN required)
//
// The caller must resolve to an ACTIVE users row (by firebase_uid
// or email — same matching as GET /users/me): documents are
// staff-internal, so there is no anonymous author. Every mutation
// writes a document_create / document_update / document_finalize
// event in the same transaction; event details carry ids and
// doc_type only, NEVER section content or title text.
const express = require('express');
const pool = require('../db');
const { insertEvent } = require('../lib/eventLog');
const { requireRole, attachManager } = require('../lib/requireRole');
const requireManagerRole = requireRole('manager', 'admin');
const {
  DOCUMENT_TEMPLATES,
  DOC_TYPES,
  validateSections,
  emptySections,
} = require('../lib/documentTemplates');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT = `
  SELECT d.id, d.patient_id,
         CASE WHEN p.id IS NULL THEN NULL ELSE (p.fname || ' ' || p.lname) END AS patient_name,
         d.appointment_id, d.author_id,
         (a.fname || ' ' || a.lname) AS author_name, a.email AS author_email,
         d.doc_type, d.title, d.sections, d.status,
         d.finalized_at, d.finalized_by,
         d.created_at, d.updated_at, d.deleted_at
    FROM documents d
    JOIN users a ON a.id = d.author_id
    LEFT JOIN patients p ON p.id = d.patient_id`;

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
  const r = await db.query(`${SELECT} WHERE d.id = $1`, [id]);
  return r.rows[0] ?? null;
}

// Normalize an appointment_id input: integer or integer-string →
// Number, null/undefined → null. Anything else → 400 VALIDATION.
function parseAppointmentId(value) {
  if (value === null || value === undefined) return null;
  let v = value;
  if (typeof v === 'string' && /^\d+$/.test(v)) v = Number(v);
  if (!Number.isInteger(v)) {
    throw httpError(400, 'appointment_id must be an integer', 'VALIDATION');
  }
  return v;
}

// When an appointment is linked, it must exist, be live, and
// belong to the document's patient.
async function checkAppointment(db, appointmentId, patientId) {
  if (appointmentId === null) return;
  const r = await db.query(
    'SELECT id, patient_id FROM appointments WHERE id = $1 AND deleted_at IS NULL',
    [appointmentId],
  );
  if (!r.rows.length) {
    throw httpError(400, 'appointment not found', 'APPOINTMENT_NOT_FOUND');
  }
  if (r.rows[0].patient_id !== patientId) {
    throw httpError(
      400,
      'appointment belongs to a different patient',
      'APPOINTMENT_PATIENT_MISMATCH',
    );
  }
}

router.get('/', async (req, res, next) => {
  try {
    await resolveMe(pool, req);
    const patientId = req.query.patient_id;
    if (!patientId || typeof patientId !== 'string' || !UUID_RE.test(patientId)) {
      return res.status(400).json({ error: 'patient_id is required and must be a UUID', code: 'VALIDATION' });
    }
    const r = await pool.query(
      `${SELECT} WHERE d.patient_id = $1 AND d.deleted_at IS NULL
        ORDER BY d.created_at DESC, d.id DESC`,
      [patientId],
    );
    res.json({ documents: r.rows });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });
    await resolveMe(pool, req);
    const row = await fetchOne(pool, id);
    if (!row || row.deleted_at) return res.status(404).json({ error: 'document not found' });
    res.json({ document: row });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const me = await resolveMe(pool, req);
    const body = req.body ?? {};
    const patientId = body.patient_id ?? null;
    if (typeof patientId !== 'string' || !UUID_RE.test(patientId)) {
      return res.status(400).json({ error: 'patient_id must be a UUID', code: 'VALIDATION' });
    }
    const docType = body.doc_type;
    if (!DOC_TYPES.includes(docType)) {
      return res.status(400).json({ error: `doc_type must be one of: ${DOC_TYPES.join(', ')}`, code: 'VALIDATION' });
    }
    if (body.title !== undefined && body.title !== null && typeof body.title !== 'string') {
      return res.status(400).json({ error: 'title must be a string or null', code: 'VALIDATION' });
    }
    const title = body.title ?? DOCUMENT_TEMPLATES[docType].defaultTitle;
    const appointmentId = parseAppointmentId(body.appointment_id);
    // Throws 400 VALIDATION on an unknown key or non-string value.
    const supplied = validateSections(docType, body.sections);
    const sections = { ...emptySections(docType), ...supplied };

    const created = await withTx(async (client) => {
      const p = await client.query(
        'SELECT id FROM patients WHERE id = $1 AND deleted_at IS NULL',
        [patientId],
      );
      if (!p.rows.length) throw httpError(400, 'patient not found', 'PATIENT_NOT_FOUND');
      await checkAppointment(client, appointmentId, patientId);
      const r = await client.query(
        `INSERT INTO documents (patient_id, appointment_id, author_id, doc_type, title, sections, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'draft') RETURNING id`,
        [patientId, appointmentId, me.id, docType, title, JSON.stringify(sections)],
      );
      const row = await fetchOne(client, r.rows[0].id);
      await insertEvent(client, {
        actor: req.user,
        event: 'document_create',
        patientId,
        details: {
          document_id: Number(row.id),
          doc_type: docType,
          author_id: Number(me.id),
        },
        ip: req.ip,
      });
      return row;
    });
    res.status(201).json({ document: created });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });
    await resolveMe(pool, req);
    const body = req.body ?? {};
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

    const cur = await fetchOne(pool, id);
    if (!cur || cur.deleted_at) return res.status(404).json({ error: 'document not found' });
    if (cur.status === 'finalized') {
      return res.status(409).json({ error: 'document is finalized and locked', code: 'DOCUMENT_FINALIZED' });
    }

    const values = {};
    if (has('title')) {
      if (body.title !== null && typeof body.title !== 'string') {
        return res.status(400).json({ error: 'title must be a string or null', code: 'VALIDATION' });
      }
      values.title = body.title;
    }
    if (has('sections')) {
      // doc_type itself is NOT editable — sections are validated
      // against the document's existing type and replace-merged
      // over its existing keys.
      const supplied = validateSections(cur.doc_type, body.sections);
      values.sections = JSON.stringify({
        ...emptySections(cur.doc_type),
        ...(cur.sections ?? {}),
        ...supplied,
      });
    }
    if (has('appointment_id')) {
      values.appointment_id = parseAppointmentId(body.appointment_id);
    }

    const updated = await withTx(async (client) => {
      if (Object.prototype.hasOwnProperty.call(values, 'appointment_id')) {
        await checkAppointment(client, values.appointment_id, cur.patient_id);
      }
      const keys = Object.keys(values);
      if (keys.length) {
        const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
        await client.query(`UPDATE documents SET ${sets} WHERE id = $1`, [
          id,
          ...keys.map((k) => values[k]),
        ]);
      }
      const row = await fetchOne(client, id);
      await insertEvent(client, {
        actor: req.user,
        event: 'document_update',
        patientId: cur.patient_id,
        details: { document_id: id, doc_type: cur.doc_type },
        ip: req.ip,
      });
      return row;
    });
    res.json({ document: updated });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

router.post('/:id/finalize', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });
    const me = await resolveMe(pool, req);
    const done = await withTx(async (client) => {
      const cur = await fetchOne(client, id);
      if (!cur || cur.deleted_at) return null;
      if (cur.status === 'finalized') return 'already_finalized';
      await client.query(
        `UPDATE documents SET status = 'finalized', finalized_at = now(), finalized_by = $2
          WHERE id = $1`,
        [id, me.id],
      );
      await insertEvent(client, {
        actor: req.user,
        event: 'document_finalize',
        patientId: cur.patient_id,
        details: { document_id: id, doc_type: cur.doc_type },
        ip: req.ip,
      });
      return fetchOne(client, id);
    });
    if (!done) return res.status(404).json({ error: 'document not found' });
    if (done === 'already_finalized') {
      return res.status(409).json({ error: 'document is finalized and locked', code: 'DOCUMENT_FINALIZED' });
    }
    res.json({ document: done });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

router.delete('/:id', requireManagerRole, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });
    const deleted = await withTx(async (client) => {
      const cur = await fetchOne(client, id);
      if (!cur || cur.deleted_at) return null;
      await client.query('UPDATE documents SET deleted_at = now() WHERE id = $1', [id]);
      await insertEvent(client, {
        actor: req.user,
        event: 'document_update',
        patientId: cur.patient_id,
        details: {
          action: 'document_delete',
          document_id: id,
          doc_type: cur.doc_type,
          manager_user_id: req.manager.id,
          manager_email: req.manager.email,
          manager_role: req.manager.role,
        },
        ip: req.ip,
      });
      return fetchOne(client, id);
    });
    if (!deleted) return res.status(404).json({ error: 'document not found' });
    res.json({ document: deleted });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

router.post('/:id/restore', requireManagerRole, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });
    const restored = await withTx(async (client) => {
      const cur = await fetchOne(client, id);
      if (!cur) return null;
      if (!cur.deleted_at) return 'not_deleted';
      await client.query('UPDATE documents SET deleted_at = NULL WHERE id = $1', [id]);
      await insertEvent(client, {
        actor: req.user,
        event: 'document_update',
        patientId: cur.patient_id,
        details: {
          action: 'document_restore',
          document_id: id,
          doc_type: cur.doc_type,
          manager_user_id: req.manager.id,
          manager_email: req.manager.email,
          manager_role: req.manager.role,
        },
        ip: req.ip,
      });
      return fetchOne(client, id);
    });
    if (!restored) return res.status(404).json({ error: 'document not found' });
    if (restored === 'not_deleted') {
      return res.status(409).json({ error: 'document is not deleted', code: 'NOT_DELETED' });
    }
    res.json({ document: restored });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

module.exports = router;
