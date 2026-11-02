'use strict';

// CareTask clinician tasks — the todo/reminder list (Jake,
// 2026-11-02). Mounted at /tasks behind requireAuth (server.js).
//
// A task is owned by the clinician who created it: lists and
// writes are scoped to the caller, and someone else's task id
// reads as not-found (existence hiding, same as mileage owner
// scoping). A task is a general reminder or links to a patient —
// patient-linked tasks also surface on that patient's profile.
// In-app only: nothing here sends SMS/email (messaging Phase 3 is
// the separate, unapproved proposal). Events carry the task id and
// action only — never the title or notes.

const express = require('express');
const pool = require('../db');
const { insertEvent } = require('../lib/eventLog');

const router = express.Router();

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function sendErr(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  return res.status(status).json({
    error: err.code || 'INTERNAL',
    message: status >= 500 ? 'internal error' : err.message,
  });
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The caller's own ACTIVE staff record (tasks hang off it). Mirrors
// the messages router's gate: no staff record → 403 NO_STAFF_RECORD.
async function resolveMe(req) {
  const r = await pool.query(
    `SELECT id FROM users
      WHERE lower(email) = lower($1) AND active
      LIMIT 1`,
    [req.user.email]
  );
  if (!r.rows[0]) {
    throw httpError(
      403, 'NO_STAFF_RECORD',
      'Your account has no active staff record, so it cannot use tasks.'
    );
  }
  req.meId = Number(r.rows[0].id);
}

function normTask(r) {
  return {
    id: Number(r.id),
    patient_id: r.patient_id ?? null,
    patient_name: r.patient_name ?? null,
    title: r.title,
    notes: r.notes ?? null,
    due_at: r.due_at ?? null,
    done: r.done_at != null,
    done_at: r.done_at ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const TASK_SELECT = `
  SELECT t.*, (p.fname || ' ' || p.lname) AS patient_name
    FROM clinician_tasks t
    LEFT JOIN patients p ON p.id = t.patient_id`;

async function loadOwnTask(id, meId) {
  const r = await pool.query(
    `${TASK_SELECT}
      WHERE t.id = $1 AND t.user_id = $2 AND t.deleted_at IS NULL`,
    [id, meId]
  );
  return r.rows[0] || null;
}

function cleanTitle(v) {
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t) throw httpError(400, 'TITLE_REQUIRED', 'A task needs a title.');
  if (t.length > 300) {
    throw httpError(400, 'TITLE_TOO_LONG', 'Keep the title under 300 characters.');
  }
  return t;
}

function cleanDue(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw httpError(400, 'DUE_INVALID', 'due_at must be a date/time.');
  }
  return d.toISOString();
}

async function cleanPatientRef(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !UUID_RE.test(v)) {
    throw httpError(400, 'PATIENT_NOT_FOUND', 'That patient was not found.');
  }
  const r = await pool.query(
    `SELECT id FROM patients WHERE id = $1 AND deleted_at IS NULL`, [v]
  );
  if (!r.rows[0]) {
    throw httpError(400, 'PATIENT_NOT_FOUND', 'That patient was not found.');
  }
  return v;
}

// ── List (own tasks; ?scope=open|done|all, ?patient_id=) ─────────

router.get('/', async (req, res) => {
  try {
    await resolveMe(req);
    const scope = ['open', 'done', 'all'].includes(req.query.scope)
      ? req.query.scope
      : 'open';
    const params = [req.meId];
    let where = `t.user_id = $1 AND t.deleted_at IS NULL`;
    if (scope === 'open') where += ` AND t.done_at IS NULL`;
    if (scope === 'done') where += ` AND t.done_at IS NOT NULL`;
    if (req.query.patient_id) {
      const pid = await cleanPatientRef(String(req.query.patient_id));
      params.push(pid);
      where += ` AND t.patient_id = $${params.length}`;
    }
    const r = await pool.query(
      `${TASK_SELECT} WHERE ${where}
        ORDER BY (t.done_at IS NOT NULL), (t.due_at IS NULL), t.due_at,
                 t.created_at DESC`,
      params
    );
    return res.json({ tasks: r.rows.map(normTask) });
  } catch (err) {
    return sendErr(res, err);
  }
});

// ── Create ───────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  try {
    await resolveMe(req);
    const title = cleanTitle(req.body?.title);
    const notes =
      typeof req.body?.notes === 'string' && req.body.notes.trim()
        ? req.body.notes.trim()
        : null;
    const dueAt = cleanDue(req.body?.due_at);
    const patientId = await cleanPatientRef(req.body?.patient_id);
    const r = await pool.query(
      `INSERT INTO clinician_tasks (user_id, patient_id, title, notes, due_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.meId, patientId, title, notes, dueAt]
    );
    const task = await loadOwnTask(Number(r.rows[0].id), req.meId);
    await insertEvent(pool, {
      event: 'task_change', actor: req.user, patientId,
      details: { action: 'create', task_id: task.id },
    });
    return res.status(201).json({ task: normTask(task) });
  } catch (err) {
    return sendErr(res, err);
  }
});

// ── Update (fields + done toggle) ────────────────────────────────

router.put('/:id', async (req, res) => {
  try {
    await resolveMe(req);
    const id = Number(req.params.id);
    const existing = await loadOwnTask(id, req.meId);
    if (!existing) {
      throw httpError(404, 'TASK_NOT_FOUND', 'That task was not found.');
    }
    const b = req.body ?? {};
    const sets = [];
    const vals = [];
    const push = (col, v) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if ('title' in b) push('title', cleanTitle(b.title));
    if ('notes' in b) {
      push('notes',
        typeof b.notes === 'string' && b.notes.trim() ? b.notes.trim() : null);
    }
    if ('due_at' in b) push('due_at', cleanDue(b.due_at));
    if ('patient_id' in b) push('patient_id', await cleanPatientRef(b.patient_id));
    if ('done' in b) {
      vals.push(b.done ? new Date().toISOString() : null);
      sets.push(`done_at = $${vals.length}`);
    }
    if (sets.length === 0) return res.json({ task: normTask(existing) });
    vals.push(id, req.meId);
    await pool.query(
      `UPDATE clinician_tasks SET ${sets.join(', ')}
        WHERE id = $${vals.length - 1} AND user_id = $${vals.length}
          AND deleted_at IS NULL`,
      vals
    );
    const task = await loadOwnTask(id, req.meId);
    await insertEvent(pool, {
      event: 'task_change', actor: req.user,
      patientId: task.patient_id ?? null,
      details: { action: 'done' in b ? (b.done ? 'done' : 'reopen') : 'update', task_id: id },
    });
    return res.json({ task: normTask(task) });
  } catch (err) {
    return sendErr(res, err);
  }
});

// ── Delete (soft) ────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
  try {
    await resolveMe(req);
    const id = Number(req.params.id);
    const existing = await loadOwnTask(id, req.meId);
    if (!existing) {
      throw httpError(404, 'TASK_NOT_FOUND', 'That task was not found.');
    }
    await pool.query(
      `UPDATE clinician_tasks SET deleted_at = now()
        WHERE id = $1 AND user_id = $2`,
      [id, req.meId]
    );
    await insertEvent(pool, {
      event: 'task_change', actor: req.user,
      patientId: existing.patient_id ?? null,
      details: { action: 'delete', task_id: id },
    });
    return res.status(204).end();
  } catch (err) {
    return sendErr(res, err);
  }
});

module.exports = router;
