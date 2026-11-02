// Appointment (calendar) routes for the CareTask demo API,
// correlated with OpenEMR's calendar model (see
// schema-appointments.sql): categories come from
// appointment_categories (color + default duration live there),
// the provider is a users row, statuses come from
// appointment_statuses (the apptstat list, with check-in/check-out
// flags), and room is a first-class field.
//
// Endpoints (mounted under /appointments by server.js, behind
// requireAuth):
//   GET    /appointments/categories   active category list (?all=1
//                                     includes inactive)
//   POST   /appointments/categories   create category (PIN required)
//   PUT    /appointments/categories/:id  update (PIN required)
//   DELETE /appointments/categories/:id  deactivate (PIN required)
//   POST   /appointments/categories/:id/restore  reactivate (PIN)
//   GET    /appointments/statuses     status list (flow order)
//   GET    /appointments?from=&to=&patient_id=&provider_id=
//   GET    /appointments/:id
//   POST   /appointments              create (NOT PIN-gated —
//                                     booking is a front-desk act)
//   PUT    /appointments/:id          update (MANAGER PIN required)
//   POST   /appointments/:id/status   status-only change (NOT gated
//                                     — the flow-board pattern:
//                                     check-in is one click)
//   DELETE /appointments/:id          SOFT delete (PIN required)
//   POST   /appointments/:id/restore  undo soft delete (PIN required)
//
// Every mutation writes an `appointment_change` event to event_log
// in the same transaction; gated writes name the authorizing
// manager. Category drives the patient rule: an 'appointment'
// category requires a live patient; a 'provider' category (In
// Office, Lunch, Vacation…) takes no patient.
const express = require('express');
const pool = require('../db');
const { insertEvent } = require('../lib/eventLog');
const { requireRole, attachManager } = require('../lib/requireRole');
const requireManagerRole = requireRole('manager', 'admin');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WRITABLE = [
  'patient_id',
  'provider_id',
  'category_id',
  'title',
  'starts_at',
  'ends_at',
  'room',
  'notes',
];

const SELECT = `
  SELECT a.id, a.patient_id,
         CASE WHEN p.id IS NULL THEN NULL ELSE (p.fname || ' ' || p.lname) END AS patient_name,
         a.provider_id,
         CASE WHEN u.id IS NULL THEN NULL ELSE (u.fname || ' ' || u.lname) END AS provider_name,
         a.category_id, c.name AS category_name, c.color AS category_color,
         c.cattype, c.default_duration_min,
         a.title, a.starts_at, a.ends_at, a.status, a.room, a.notes,
         a.created_at, a.updated_at, a.deleted_at
    FROM appointments a
    LEFT JOIN patients p ON p.id = a.patient_id
    LEFT JOIN users u ON u.id = a.provider_id
    JOIN appointment_categories c ON c.id = a.category_id`;

function parseTime(value) {
  if (typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

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

async function fetchOne(db, id) {
  const r = await db.query(`${SELECT} WHERE a.id = $1`, [id]);
  return r.rows[0] ?? null;
}

async function statusExists(db, code) {
  const r = await db.query('SELECT code FROM appointment_statuses WHERE code = $1', [code]);
  return r.rows.length > 0;
}

// Cross-field rules for a full (merged) appointment shape: category
// drives the patient rule; referenced rows must exist and be live.
async function checkRefs(db, v) {
  const cat = await db.query(
    'SELECT id, cattype FROM appointment_categories WHERE id = $1 AND active = true',
    [v.category_id],
  );
  if (!cat.rows.length) throw httpError(400, 'category not found', 'CATEGORY_NOT_FOUND');
  if (cat.rows[0].cattype === 'appointment') {
    if (!v.patient_id) {
      throw httpError(400, 'this category requires a patient', 'PATIENT_REQUIRED');
    }
    const p = await db.query(
      'SELECT id FROM patients WHERE id = $1 AND deleted_at IS NULL',
      [v.patient_id],
    );
    if (!p.rows.length) throw httpError(400, 'patient not found', 'PATIENT_NOT_FOUND');
  }
  if (v.provider_id) {
    const u = await db.query('SELECT id FROM users WHERE id = $1', [v.provider_id]);
    if (!u.rows.length) throw httpError(400, 'provider not found', 'PROVIDER_NOT_FOUND');
  }
  if (v.status && !(await statusExists(db, v.status))) {
    throw httpError(400, `unknown status: ${v.status}`, 'VALIDATION');
  }
  if (new Date(v.ends_at) <= new Date(v.starts_at)) {
    throw httpError(400, 'ends_at must be after starts_at', 'VALIDATION');
  }
}

// Validate + normalize raw input. partial=true (PUT): only present
// fields. Returns the normalized values object.
function validate(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  for (const k of ['provider_id', 'category_id']) {
    if (!partial || has(k)) {
      let v = body[k];
      // Postgres returns BIGINT ids as strings, so clients hand
      // them back as strings — accept integer-valued strings.
      if (typeof v === 'string' && /^\d+$/.test(v)) v = Number(v);
      if (v === null || v === undefined) {
        if (k === 'category_id' && !partial) {
          throw httpError(400, 'category_id is required', 'VALIDATION');
        }
        out[k] = null;
      } else if (!Number.isInteger(v)) {
        throw httpError(400, `${k} must be an integer`, 'VALIDATION');
      } else {
        out[k] = v;
      }
    }
  }
  // patient_id is a UUID (patients.id is a UUID PK, unlike users.id).
  if (!partial || has('patient_id')) {
    const v = body.patient_id;
    if (v === null || v === undefined) {
      out.patient_id = null;
    } else if (typeof v !== 'string' || !UUID_RE.test(v)) {
      throw httpError(400, 'patient_id must be a UUID', 'VALIDATION');
    } else {
      out.patient_id = v;
    }
  }
  for (const k of ['starts_at', 'ends_at']) {
    if (!partial || has(k)) {
      const d = parseTime(body[k]);
      if (!d) throw httpError(400, `${k} must be an ISO date-time`, 'VALIDATION');
      out[k] = d.toISOString();
    }
  }
  for (const k of ['title', 'room', 'notes']) {
    if (has(k)) {
      if (body[k] !== null && typeof body[k] !== 'string') {
        throw httpError(400, `${k} must be a string or null`, 'VALIDATION');
      }
      out[k] = body[k];
    }
  }
  if (!partial || has('status')) {
    out.status = body.status ?? 'booked';
    if (typeof out.status !== 'string') {
      throw httpError(400, 'status must be a string', 'VALIDATION');
    }
  }
  return out;
}

router.get('/categories', async (req, res, next) => {
  try {
    const all = req.query.all === '1';
    const r = await pool.query(
      `SELECT id, name, color, description, cattype, default_duration_min, active
         FROM appointment_categories ${all ? '' : 'WHERE active = true'}
        ORDER BY cattype, name`,
    );
    res.json({ categories: r.rows });
  } catch (err) {
    next(err);
  }
});

// --- Category management (Settings screen). Role-gated like staff
// writes: categories are practice configuration. Deactivate is a
// soft state (active=false), never a delete — appointments keep
// pointing at the category, and it leaves the booking pickers.

function validateCategory(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (!partial || has('name')) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw httpError(400, 'name is required', 'VALIDATION');
    }
    out.name = body.name.trim();
  }
  if (has('color')) {
    if (typeof body.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(body.color)) {
      throw httpError(400, 'color must be a #rrggbb hex value', 'VALIDATION');
    }
    out.color = body.color;
  }
  if (!partial || has('cattype')) {
    const v = body.cattype ?? 'appointment';
    if (!['appointment', 'provider'].includes(v)) {
      throw httpError(400, "cattype must be 'appointment' or 'provider'", 'VALIDATION');
    }
    out.cattype = v;
  }
  if (!partial || has('default_duration_min')) {
    let v = body.default_duration_min ?? 30;
    if (typeof v === 'string' && /^\d+$/.test(v)) v = Number(v);
    if (!Number.isInteger(v) || v <= 0 || v > 1440) {
      throw httpError(400, 'default_duration_min must be a positive integer (max 1440)', 'VALIDATION');
    }
    out.default_duration_min = v;
  }
  if (has('description')) {
    if (body.description !== null && typeof body.description !== 'string') {
      throw httpError(400, 'description must be a string or null', 'VALIDATION');
    }
    out.description = body.description;
  }
  if (has('active')) {
    if (typeof body.active !== 'boolean') {
      throw httpError(400, 'active must be a boolean', 'VALIDATION');
    }
    out.active = body.active;
  }
  return out;
}

async function categoryNameTaken(db, name, exceptId = null) {
  const r = await db.query(
    `SELECT id FROM appointment_categories
      WHERE lower(name) = lower($1) AND ($2::bigint IS NULL OR id <> $2)`,
    [name, exceptId],
  );
  return r.rows.length > 0;
}

async function logCategoryAction(client, req, action, row) {
  await insertEvent(client, {
    actor: req.user,
    event: 'admin_action',
    details: {
      action,
      category_id: Number(row.id),
      category_name: row.name,
      manager_user_id: req.manager.id,
      manager_email: req.manager.email,
      manager_role: req.manager.role,
    },
    ip: req.ip,
  });
}

router.post('/categories', requireManagerRole, async (req, res, next) => {
  try {
    const values = validateCategory(req.body ?? {});
    const created = await withTx(async (client) => {
      if (await categoryNameTaken(client, values.name)) {
        throw httpError(409, 'a category with that name already exists', 'CATEGORY_EXISTS');
      }
      const r = await client.query(
        `INSERT INTO appointment_categories (name, color, cattype, default_duration_min, description)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [
          values.name,
          values.color ?? '#3b82f6',
          values.cattype,
          values.default_duration_min,
          values.description ?? null,
        ],
      );
      await logCategoryAction(client, req, 'category_create', r.rows[0]);
      return r.rows[0];
    });
    res.status(201).json({ category: created });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

router.put('/categories/:id', requireManagerRole, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });
    const values = validateCategory(req.body ?? {}, { partial: true });
    const updated = await withTx(async (client) => {
      const cur = await client.query('SELECT * FROM appointment_categories WHERE id = $1', [id]);
      if (!cur.rows.length) return null;
      if (values.name && (await categoryNameTaken(client, values.name, id))) {
        throw httpError(409, 'a category with that name already exists', 'CATEGORY_EXISTS');
      }
      const keys = Object.keys(values);
      if (keys.length) {
        const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
        await client.query(`UPDATE appointment_categories SET ${sets} WHERE id = $1`, [
          id,
          ...keys.map((k) => values[k]),
        ]);
      }
      const row = (await client.query('SELECT * FROM appointment_categories WHERE id = $1', [id])).rows[0];
      await logCategoryAction(client, req, 'category_update', row);
      return row;
    });
    if (!updated) return res.status(404).json({ error: 'category not found' });
    res.json({ category: updated });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

router.delete('/categories/:id', requireManagerRole, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });
    const done = await withTx(async (client) => {
      const cur = await client.query(
        'SELECT * FROM appointment_categories WHERE id = $1 AND active = true',
        [id],
      );
      if (!cur.rows.length) return null;
      await client.query('UPDATE appointment_categories SET active = false WHERE id = $1', [id]);
      await logCategoryAction(client, req, 'category_deactivate', cur.rows[0]);
      return cur.rows[0];
    });
    if (!done) return res.status(404).json({ error: 'category not found or already inactive' });
    res.json({ category: { ...done, active: false } });
  } catch (err) {
    next(err);
  }
});

router.post('/categories/:id/restore', requireManagerRole, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });
    const done = await withTx(async (client) => {
      const cur = await client.query('SELECT * FROM appointment_categories WHERE id = $1', [id]);
      if (!cur.rows.length) return null;
      if (cur.rows[0].active) return 'already_active';
      await client.query('UPDATE appointment_categories SET active = true WHERE id = $1', [id]);
      await logCategoryAction(client, req, 'category_reactivate', cur.rows[0]);
      return cur.rows[0];
    });
    if (!done) return res.status(404).json({ error: 'category not found' });
    if (done === 'already_active') {
      return res.status(409).json({ error: 'category is already active', code: 'ALREADY_ACTIVE' });
    }
    res.json({ category: { ...done, active: true } });
  } catch (err) {
    next(err);
  }
});

router.get('/statuses', async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT code, label, color, is_checkin, is_checkout
         FROM appointment_statuses ORDER BY sort_order`,
    );
    res.json({ statuses: r.rows });
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const clauses = ['a.deleted_at IS NULL'];
    const params = [];
    if (req.query.from) {
      const d = parseTime(String(req.query.from));
      if (!d) return res.status(400).json({ error: 'from must be an ISO date-time', code: 'VALIDATION' });
      params.push(d.toISOString());
      clauses.push(`a.ends_at > $${params.length}`);
    }
    if (req.query.to) {
      const d = parseTime(String(req.query.to));
      if (!d) return res.status(400).json({ error: 'to must be an ISO date-time', code: 'VALIDATION' });
      params.push(d.toISOString());
      clauses.push(`a.starts_at < $${params.length}`);
    }
    for (const [param, col] of [['provider_id', 'a.provider_id']]) {
      if (req.query[param]) {
        const v = Number(req.query[param]);
        if (!Number.isInteger(v)) {
          return res.status(400).json({ error: `${param} must be an integer`, code: 'VALIDATION' });
        }
        params.push(v);
        clauses.push(`${col} = $${params.length}`);
      }
    }
    if (req.query.patient_id) {
      const v = String(req.query.patient_id);
      if (!UUID_RE.test(v)) {
        return res.status(400).json({ error: 'patient_id must be a UUID', code: 'VALIDATION' });
      }
      params.push(v);
      clauses.push(`a.patient_id = $${params.length}`);
    }
    const r = await pool.query(
      `${SELECT} WHERE ${clauses.join(' AND ')} ORDER BY a.starts_at ASC`,
      params,
    );
    res.json({ appointments: r.rows });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });
    const row = await fetchOne(pool, id);
    if (!row || row.deleted_at) return res.status(404).json({ error: 'appointment not found' });
    res.json({ appointment: row });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const values = validate(req.body ?? {});
    const created = await withTx(async (client) => {
      await checkRefs(client, values);
      const cat = await client.query(
        'SELECT name, cattype FROM appointment_categories WHERE id = $1',
        [values.category_id],
      );
      // Provider schedule events never carry a patient (OpenEMR's
      // Patient tab vs Provider tab split).
      if (cat.rows[0].cattype === 'provider') values.patient_id = null;
      const r = await client.query(
        `INSERT INTO appointments (patient_id, provider_id, category_id, title, starts_at, ends_at, status, room, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          values.patient_id,
          values.provider_id,
          values.category_id,
          values.title ?? cat.rows[0].name,
          values.starts_at,
          values.ends_at,
          values.status,
          values.room ?? null,
          values.notes ?? null,
        ],
      );
      const row = await fetchOne(client, r.rows[0].id);
      await insertEvent(client, {
        actor: req.user,
        event: 'appointment_change',
        patientId: values.patient_id,
        details: { action: 'appointment_create', appointment_id: Number(row.id) },
        ip: req.ip,
      });
      return row;
    });
    res.status(201).json({ appointment: created });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

router.put('/:id', attachManager, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });
    const values = validate(req.body ?? {}, { partial: true });
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'status')) {
      values.status = req.body.status;
    }
    const updated = await withTx(async (client) => {
      const cur = await fetchOne(client, id);
      if (!cur || cur.deleted_at) return null;
      const merged = {
        patient_id: cur.patient_id,
        provider_id: cur.provider_id,
        category_id: cur.category_id,
        starts_at: cur.starts_at,
        ends_at: cur.ends_at,
        status: cur.status,
        ...values,
      };
      await checkRefs(client, merged);
      const keys = Object.keys(values).filter((k) => [...WRITABLE, 'status'].includes(k));
      if (keys.length) {
        const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
        await client.query(`UPDATE appointments SET ${sets} WHERE id = $1`, [
          id,
          ...keys.map((k) => values[k]),
        ]);
      }
      const row = await fetchOne(client, id);
      await insertEvent(client, {
        actor: req.user,
        event: 'appointment_change',
        patientId: row.patient_id,
        details: {
          action: 'appointment_update',
          appointment_id: id,
          manager_user_id: req.manager.id,
          manager_email: req.manager.email,
          manager_role: req.manager.role,
        },
        ip: req.ip,
      });
      return row;
    });
    if (!updated) return res.status(404).json({ error: 'appointment not found' });
    res.json({ appointment: updated });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

// Flow-board status change: deliberately NOT PIN-gated (OpenEMR's
// flow board updates status in one click; a check-in desk can't stop
// for a manager override). Status-only — schedule/content edits go
// through the gated PUT above.
router.post('/:id/status', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });
    const { status } = req.body ?? {};
    if (typeof status !== 'string' || !(await statusExists(pool, status))) {
      return res.status(400).json({ error: `unknown status: ${status}`, code: 'VALIDATION' });
    }
    const updated = await withTx(async (client) => {
      const cur = await fetchOne(client, id);
      if (!cur || cur.deleted_at) return null;
      await client.query('UPDATE appointments SET status = $2 WHERE id = $1', [id, status]);
      await insertEvent(client, {
        actor: req.user,
        event: 'appointment_change',
        patientId: cur.patient_id,
        details: {
          action: 'appointment_status',
          appointment_id: id,
          from_status: cur.status,
          to_status: status,
        },
        ip: req.ip,
      });
      return fetchOne(client, id);
    });
    if (!updated) return res.status(404).json({ error: 'appointment not found' });
    res.json({ appointment: updated });
  } catch (err) {
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
      await client.query('UPDATE appointments SET deleted_at = now() WHERE id = $1', [id]);
      await insertEvent(client, {
        actor: req.user,
        event: 'appointment_change',
        patientId: cur.patient_id,
        details: {
          action: 'appointment_delete',
          appointment_id: id,
          manager_user_id: req.manager.id,
          manager_email: req.manager.email,
          manager_role: req.manager.role,
        },
        ip: req.ip,
      });
      return fetchOne(client, id);
    });
    if (!deleted) return res.status(404).json({ error: 'appointment not found' });
    res.json({ appointment: deleted });
  } catch (err) {
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
      await client.query('UPDATE appointments SET deleted_at = NULL WHERE id = $1', [id]);
      await insertEvent(client, {
        actor: req.user,
        event: 'appointment_change',
        patientId: cur.patient_id,
        details: {
          action: 'appointment_restore',
          appointment_id: id,
          manager_user_id: req.manager.id,
          manager_email: req.manager.email,
          manager_role: req.manager.role,
        },
        ip: req.ip,
      });
      return fetchOne(client, id);
    });
    if (!restored) return res.status(404).json({ error: 'appointment not found' });
    if (restored === 'not_deleted') {
      return res.status(409).json({ error: 'appointment is not deleted', code: 'NOT_DELETED' });
    }
    res.json({ appointment: restored });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
