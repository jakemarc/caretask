// Staff directory routes (users table — see schema-users.sql).
//
// Endpoints (mounted under /users by server.js, behind requireAuth):
//   GET    /users            all staff (safe columns only)
//   GET    /users/me         the signed-in user's own row, or null
//   GET    /users/clinicians active users with authorized = true
//                          (the assignable-provider list)
//   POST   /users            create a staff member — ROLE-GATED
//   PUT    /users/:id        update a staff member — ROLE-GATED
//   DELETE /users/:id        deactivate (active = false) — ROLE-GATED
//   POST   /users/:id/restore reactivate — ROLE-GATED
//
// Staff writes require a manager/admin ROLE (lib/requireRole.js).
// Until 2026-11-02 they were gated by a manager PIN; Jake retired
// the PIN in favor of role gates (DECISIONS.md). "Delete" is a deactivate, never a hard delete — the
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
const { hashPin, isPinFormat } = require('../lib/pin');
const { insertEvent } = require('../lib/eventLog');
const { requireRole, attachManager } = require('../lib/requireRole');
const requireManagerRole = requireRole('manager', 'admin');
const {
  resolveStaff,
  isPlatformAdmin,
  isAgencyMember,
} = require('../lib/platform');
const { computeDisplayName } = require('./agencies');

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
    // Platform scoping (spec §3): the assignable-provider list is
    // the caller's AGENCY COLLEAGUES — users sharing at least one
    // agency membership — plus the caller. Platform admins see
    // everyone. (Before the platform this returned all authorized
    // staff; team assignment picks from this list, so it must be
    // the people the caller can actually work with.)
    const staff = await resolveStaff(req);
    if (!staff) {
      return res.status(403).json({
        error: 'no active staff record for this account',
        code: 'NO_STAFF_RECORD',
      });
    }
    if (isPlatformAdmin(staff)) {
      const { rows } = await pool.query(
        `SELECT ${SAFE_COLUMNS} FROM users
          WHERE authorized AND active ORDER BY lname, fname`,
      );
      return res.json(rows);
    }
    const { rows } = await pool.query(
      `SELECT ${SAFE_COLUMNS} FROM users u
        WHERE u.authorized AND u.active AND (
          u.id = $1 OR EXISTS (
            SELECT 1 FROM user_agencies mine
              JOIN user_agencies theirs
                ON theirs.agency_id = mine.agency_id
             WHERE mine.user_id = $1 AND theirs.user_id = u.id
          )
        ) ORDER BY u.lname, u.fname`,
      [staff.id],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// My agencies (platform spec §3/§8): the agencies I work for.
// Self-service — any staff member manages their own memberships.
// ------------------------------------------------------------------

router.get('/me/agencies', async (req, res, next) => {
  try {
    const staff = await resolveStaff(req);
    if (!staff) {
      return res.status(403).json({
        error: 'no active staff record for this account',
        code: 'NO_STAFF_RECORD',
      });
    }
    const { rows } = await pool.query(
      `SELECT ag.id, ag.name, ag.dba, ag.short_name, ag.city, ag.state
         FROM user_agencies ua
         JOIN agencies ag ON ag.id = ua.agency_id
        WHERE ua.user_id = $1
        ORDER BY ag.name`,
      [staff.id],
    );
    res.json({
      agencies: rows.map((r) => ({
        id: r.id,
        name: r.name,
        display_name: computeDisplayName(r),
        city: r.city,
        state: r.state,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/me/agencies', async (req, res, next) => {
  try {
    const staff = await resolveStaff(req);
    if (!staff) {
      return res.status(403).json({
        error: 'no active staff record for this account',
        code: 'NO_STAFF_RECORD',
      });
    }
    const agencyId = Number(req.body?.agency_id);
    if (!Number.isInteger(agencyId) || agencyId <= 0) {
      return res.status(400).json({ error: 'agency_id is required', code: 'VALIDATION' });
    }
    const agency = await pool.query('SELECT id FROM agencies WHERE id = $1', [agencyId]);
    if (!agency.rows[0]) {
      return res.status(400).json({
        error: 'agency_id does not match an existing agency',
        code: 'AGENCY_NOT_FOUND',
      });
    }
    await pool.query(
      `INSERT INTO user_agencies (user_id, agency_id) VALUES ($1, $2)
       ON CONFLICT (user_id, agency_id) DO NOTHING`,
      [staff.id, agencyId],
    );
    insertEvent(pool, {
      actor: req.user,
      event: 'agency_membership',
      details: { action: 'add', agency_id: agencyId },
      ip: req.ip || null,
    }).catch(() => {});
    res.status(201).json({ added: true, agency_id: agencyId });
  } catch (err) {
    next(err);
  }
});

router.delete('/me/agencies/:agencyId', async (req, res, next) => {
  try {
    const staff = await resolveStaff(req);
    if (!staff) {
      return res.status(403).json({
        error: 'no active staff record for this account',
        code: 'NO_STAFF_RECORD',
      });
    }
    const agencyId = Number(req.params.agencyId);
    if (!Number.isInteger(agencyId) || agencyId <= 0) {
      return res.status(400).json({ error: 'agency id must be an integer', code: 'VALIDATION' });
    }
    if (await isAgencyMember(pool, staff.id, agencyId)) {
      // Refuse to strand an ACTIVE episode: a primary cannot leave
      // an agency while they primary one of its episodes.
      const primary = await pool.query(
        `SELECT 1 FROM patient_episodes
          WHERE primary_user_id = $1 AND agency_id = $2
            AND status = 'active' AND deleted_at IS NULL`,
        [staff.id, agencyId],
      );
      if (primary.rows.length) {
        return res.status(409).json({
          error: 'you are the primary on an active episode at this agency — transfer or discharge it first',
          code: 'PRIMARY_ON_ACTIVE_EPISODE',
        });
      }
    }
    const r = await pool.query(
      'DELETE FROM user_agencies WHERE user_id = $1 AND agency_id = $2 RETURNING 1',
      [staff.id, agencyId],
    );
    if (!r.rows.length) {
      return res.status(404).json({ error: 'not a member of this agency', code: 'NOT_A_MEMBER' });
    }
    insertEvent(pool, {
      actor: req.user,
      event: 'agency_membership',
      details: { action: 'remove', agency_id: agencyId },
      ip: req.ip || null,
    }).catch(() => {});
    res.json({ removed: true, agency_id: agencyId });
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
  // Manager PINs were retired on 2026-11-02 in favor of role gates
  // (see lib/requireRole.js). A `pin` field on a staff write is
  // ignored; pin_hash stays dormant in the schema.
  return {};
}

function isUniqueViolation(err) {
  return err && err.code === '23505';
}

const EMAIL_EXISTS = {
  error: 'a staff member with that email already exists',
  code: 'EMAIL_EXISTS',
};

// POST /users — create a staff member. MANAGER-GATED.
router.post('/', requireManagerRole, async (req, res, next) => {
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
router.put('/:id', requireManagerRole, async (req, res, next) => {
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
router.delete('/:id', requireManagerRole, async (req, res, next) => {
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
router.post('/:id/restore', requireManagerRole, async (req, res, next) => {
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
