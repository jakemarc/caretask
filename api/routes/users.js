// Staff directory routes (users table — see schema-users.sql).
//
// Endpoints (mounted under /users by server.js, behind requireAuth):
//   GET    /users            all staff (safe columns only)
//   GET    /users/me         the signed-in user's own row, or null
//   GET    /users/clinicians active users with authorized = true
//                          (the assignable-provider list)
//   POST   /users/verify-pin { pin } → { ok, manager } — UX check for
//                          the dashboard's PIN prompt. This is NOT the
//                          enforcement: gated writes re-check the PIN
//                          in lib/requireManagerPin.js.
//   POST   /users            create a staff member — MANAGER-GATED
//   PUT    /users/:id        update a staff member — MANAGER-GATED
//   DELETE /users/:id        deactivate (active = false) — MANAGER-GATED
//   POST   /users/:id/restore reactivate — MANAGER-GATED
//
// Staff writes are manager-gated like patient edit/delete: managing
// who is on the team is exactly the kind of change the override PIN
// exists for. "Delete" is a deactivate, never a hard delete — the
// row (and its audit history) stays, the person just stops being
// active/assignable, and restore undoes it. Every gated write logs
// an admin_action event naming the authorizing manager.
//
// pin_hash is NEVER returned by any endpoint. List responses carry a
// has_pin boolean instead, so the UI can show whether a manager has
// a PIN set without exposing anything about it. A write may carry a
// plaintext `pin` field to SET that staff member's PIN; it is hashed
// (lib/pin.js) before storage and never echoed back.
const express = require('express');
const pool = require('../db');
const { findManagerByPin, hashPin, isPinFormat } = require('../lib/pin');
const { insertEvent } = require('../lib/eventLog');
const requireManagerPin = require('../lib/requireManagerPin');

const router = express.Router();

const SAFE_COLUMNS = `
  id, firebase_uid, email, role, authorized, active,
  fname, mname, lname, suffix, title, position, valedictory,
  npi, taxonomy, specialty, physician_type, state_license_number,
  facility, facility_id, organization,
  street, city, state, zip, phone, phonecell, fax,
  info, notes, (pin_hash IS NOT NULL) AS has_pin,
  created_at, updated_at
`;

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${SAFE_COLUMNS} FROM users ORDER BY lname, fname`,
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/me', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${SAFE_COLUMNS} FROM users WHERE lower(email) = $1`,
      [req.user.email],
    );
    res.json(rows[0] ?? null);
  } catch (err) {
    next(err);
  }
});

router.get('/clinicians', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${SAFE_COLUMNS} FROM users
        WHERE authorized AND active ORDER BY lname, fname`,
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/verify-pin', async (req, res, next) => {
  try {
    const pin = req.body?.pin;
    const manager = typeof pin === 'string' ? await findManagerByPin(pool, pin) : null;
    if (!manager) {
      return res.status(403).json({ ok: false, code: 'PIN_INVALID' });
    }
    const { rows } = await pool.query(
      'SELECT fname, lname FROM users WHERE id = $1',
      [manager.id],
    );
    const name = rows[0] ? `${rows[0].fname} ${rows[0].lname}` : manager.email;
    res.json({ ok: true, manager: { id: manager.id, email: manager.email, role: manager.role, name } });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// Staff writes (create / update / deactivate / restore), all gated
// by the manager PIN. Mirrors the patients router's patterns:
// whitelist, validate, one transaction per write, admin_action event
// in the same transaction naming the authorizing manager.
// ------------------------------------------------------------------

const ROLES = [
  'clinician',
  'manager',
  'admin',
  'developer',
  'support',
  'billing',
  'front_office',
];

// Columns a staff write may set. `active` is deliberately absent —
// activation changes go through DELETE (deactivate) and restore so
// they are always deliberate, logged acts. `pin` is handled
// separately (hashed into pin_hash, never stored or returned raw).
const WRITABLE = [
  'email',
  'role',
  'authorized',
  'fname',
  'mname',
  'lname',
  'suffix',
  'title',
  'position',
  'valedictory',
  'npi',
  'taxonomy',
  'specialty',
  'physician_type',
  'state_license_number',
  'facility',
  'facility_id',
  'organization',
  'street',
  'city',
  'state',
  'zip',
  'phone',
  'phonecell',
  'fax',
  'info',
  'notes',
];

function pickWritable(body) {
  const out = {};
  for (const field of WRITABLE) {
    if (body[field] !== undefined) out[field] = body[field];
  }
  return out;
}

function validateUser(fields, { creating }) {
  if (creating) {
    for (const required of ['email', 'fname', 'lname']) {
      if (fields[required] === undefined) {
        return `${required} is required`;
      }
    }
  }
  for (const required of ['fname', 'lname']) {
    if (
      fields[required] !== undefined &&
      (typeof fields[required] !== 'string' || !fields[required].trim())
    ) {
      return `${required} must be a non-empty string`;
    }
  }
  if (fields.email !== undefined) {
    if (
      typeof fields.email !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)
    ) {
      return 'email must be a valid email address';
    }
    if (fields.email !== fields.email.toLowerCase()) {
      return 'email must be lowercase';
    }
  }
  if (fields.role !== undefined && !ROLES.includes(fields.role)) {
    return `role must be one of: ${ROLES.join(', ')}`;
  }
  if (
    fields.authorized !== undefined &&
    typeof fields.authorized !== 'boolean'
  ) {
    return 'authorized must be a boolean';
  }
  if (
    fields.facility_id !== undefined &&
    fields.facility_id !== null &&
    !Number.isInteger(fields.facility_id)
  ) {
    return 'facility_id must be an integer';
  }
  for (const [key, value] of Object.entries(fields)) {
    if (
      key !== 'authorized' &&
      key !== 'facility_id' &&
      value !== null &&
      typeof value !== 'string'
    ) {
      return `${key} must be a string`;
    }
  }
  return null;
}

// Run fn(client) inside one transaction (same helper shape as the
// patients router): BEGIN, COMMIT on success, ROLLBACK + rethrow.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// The admin_action event for a staff write, in the caller's
// transaction. The PIN in the request body (when setting a staff
// member's own PIN) is never logged — only the fact of the write,
// its target, and the manager who authorized it.
async function logStaffAction(client, req, action, target) {
  await insertEvent(client, {
    actor: req.user,
    event: 'admin_action',
    details: {
      action,
      target_user_id: target.id,
      target_email: target.email,
      manager_user_id: req.manager.id,
      manager_email: req.manager.email,
      manager_role: req.manager.role,
    },
    ip: req.ip,
  });
}

// Resolve the optional `pin` field on a write to a pin_hash value.
// Returns { pinHash } (possibly undefined = leave unchanged), or
// { error } when a provided PIN is malformed.
async function resolvePinHash(body) {
  if (body.pin === undefined) return {};
  if (typeof body.pin !== 'string' || !isPinFormat(body.pin)) {
    return { error: 'pin must be 4-8 digits' };
  }
  return { pinHash: await hashPin(body.pin) };
}

function isUniqueViolation(err) {
  return err && err.code === '23505';
}

const EMAIL_EXISTS = {
  error: 'a staff member with that email already exists',
  code: 'EMAIL_EXISTS',
};

// POST /users — create a staff member. MANAGER-GATED.
router.post('/', requireManagerPin, async (req, res, next) => {
  try {
    const fields = pickWritable(req.body ?? {});
    const error = validateUser(fields, { creating: true });
    if (error) return res.status(400).json({ error });
    const { pinHash, error: pinError } = await resolvePinHash(req.body ?? {});
    if (pinError) return res.status(400).json({ error: pinError });
    if (fields.role === undefined) fields.role = 'clinician';
    if (fields.authorized === undefined) fields.authorized = false;
    const keys = Object.keys(fields);
    const columns = [...keys, ...(pinHash !== undefined ? ['pin_hash'] : [])];
    const values = [
      ...keys.map((k) => fields[k]),
      ...(pinHash !== undefined ? [pinHash] : []),
    ];
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const created = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO users (${columns.join(', ')})
         VALUES (${placeholders})
         RETURNING ${SAFE_COLUMNS}`,
        values,
      );
      const row = result.rows[0];
      await logStaffAction(client, req, 'user_create', row);
      return row;
    });
    res.status(201).json(created);
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json(EMAIL_EXISTS);
    next(err);
  }
});

// PUT /users/:id — update a staff member (partial payloads fine).
// MANAGER-GATED. Send `pin` to set/replace that member's PIN.
router.put('/:id', requireManagerPin, async (req, res, next) => {
  try {
    const fields = pickWritable(req.body ?? {});
    const error = validateUser(fields, { creating: false });
    if (error) return res.status(400).json({ error });
    const { pinHash, error: pinError } = await resolvePinHash(req.body ?? {});
    if (pinError) return res.status(400).json({ error: pinError });
    const keys = Object.keys(fields);
    if (keys.length === 0 && pinHash === undefined) {
      return res.status(400).json({ error: 'no updatable fields provided' });
    }
    const sets = keys.map((key, i) => `${key} = $${i + 1}`);
    const values = keys.map((k) => fields[k]);
    if (pinHash !== undefined) {
      sets.push(`pin_hash = $${values.length + 1}`);
      values.push(pinHash);
    }
    const updated = await withTransaction(async (client) => {
      const existing = await client.query(
        'SELECT id FROM users WHERE id = $1',
        [req.params.id],
      );
      if (!existing.rows[0]) return null;
      const result = await client.query(
        `UPDATE users SET ${sets.join(', ')} WHERE id = $${values.length + 1}
         RETURNING ${SAFE_COLUMNS}`,
        [...values, req.params.id],
      );
      const row = result.rows[0];
      await logStaffAction(client, req, 'user_update', row);
      return row;
    });
    if (!updated) {
      return res.status(404).json({ error: 'staff member not found' });
    }
    res.json(updated);
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json(EMAIL_EXISTS);
    next(err);
  }
});

// DELETE /users/:id — deactivate: active = false, row kept.
// 404 when the member does not exist or is already inactive (reads
// treat inactive as off the team, and so does the delete). A user
// cannot deactivate their OWN account — someone else's manager PIN
// session has to do it. MANAGER-GATED.
router.delete('/:id', requireManagerPin, async (req, res, next) => {
  try {
    const outcome = await withTransaction(async (client) => {
      const existing = await client.query(
        'SELECT * FROM users WHERE id = $1 AND active',
        [req.params.id],
      );
      if (!existing.rows[0]) return { status: 404 };
      if (existing.rows[0].email === req.user.email) {
        return { status: 400, body: { error: "you can't deactivate your own account", code: 'SELF_DEACTIVATE' } };
      }
      const result = await client.query(
        `UPDATE users SET active = false WHERE id = $1 RETURNING ${SAFE_COLUMNS}`,
        [req.params.id],
      );
      const row = result.rows[0];
      await logStaffAction(client, req, 'user_deactivate', row);
      return { status: 204 };
    });
    if (outcome.status === 404) {
      return res.status(404).json({ error: 'staff member not found' });
    }
    if (outcome.status === 400) {
      return res.status(400).json(outcome.body);
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /users/:id/restore — reactivate a deactivated staff member.
// 404 when the member does not exist; 409 when already active.
// MANAGER-GATED.
router.post('/:id/restore', requireManagerPin, async (req, res, next) => {
  try {
    const outcome = await withTransaction(async (client) => {
      const existing = await client.query(
        'SELECT * FROM users WHERE id = $1',
        [req.params.id],
      );
      if (!existing.rows[0]) return { status: 404 };
      if (existing.rows[0].active) return { status: 409 };
      const result = await client.query(
        `UPDATE users SET active = true WHERE id = $1 RETURNING ${SAFE_COLUMNS}`,
        [req.params.id],
      );
      const row = result.rows[0];
      await logStaffAction(client, req, 'user_reactivate', row);
      return { status: 200, row };
    });
    if (outcome.status === 404) {
      return res.status(404).json({ error: 'staff member not found' });
    }
    if (outcome.status === 409) {
      return res.status(409).json({ error: 'staff member is already active' });
    }
    res.json(outcome.row);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
