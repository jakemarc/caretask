// Invite routes for the CareTask multi-user platform
// (spec: multi-user-platform-spec.md §6). Mounted under /invites by
// server.js behind requireAuth ONLY — no staff gate — because
// POST /invites/accept is how a staff record comes to exist.
// Create/list/revoke are platform-admin acts, gated inside.
//
// Sign-up is invite-only. An admin invites an email; the invitee
// creates their Firebase account (dashboard accept-invite view)
// and calls /accept with their token; the API checks the token's
// email against the invite, provisions the staff record, and the
// workspace is blank by construction (no links, no agencies).
// The raw code is returned exactly once, at creation; only its
// SHA-256 is stored.
const express = require('express');
const { randomBytes, createHash } = require('node:crypto');
const pool = require('../db');
const { insertEvent } = require('../lib/eventLog');
const { requireRole } = require('../lib/requireRole');
const { resolveStaff } = require('../lib/platform');

const router = express.Router();
const requireAdmin = requireRole('admin', 'developer');

const ROLES = [
  'clinician',
  'manager',
  'admin',
  'developer',
  'support',
  'billing',
  'front_office',
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashCode(code) {
  return createHash('sha256').update(String(code)).digest('hex');
}

function inviteStatus(inv) {
  if (inv.accepted_at) return 'accepted';
  if (inv.revoked_at) return 'revoked';
  if (new Date(inv.expires_at) < new Date()) return 'expired';
  return 'pending';
}

function shapeInvite(inv) {
  return {
    id: inv.id,
    email: inv.email,
    role: inv.role,
    status: inviteStatus(inv),
    invited_by: inv.invited_by,
    expires_at: inv.expires_at,
    accepted_by: inv.accepted_by,
    accepted_at: inv.accepted_at,
    created_at: inv.created_at,
  };
}

// POST /invites/accept { code, fname?, lname? } — the one route a
// signed-in account with NO staff record may use. The token's
// email must match the invite's email.
router.post('/accept', async (req, res, next) => {
  try {
    const code = req.body?.code;
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ error: 'code is required', code: 'VALIDATION' });
    }
    const { rows } = await pool.query(
      'SELECT * FROM invites WHERE code_hash = $1',
      [hashCode(code.trim())],
    );
    const inv = rows[0];
    if (!inv || inv.revoked_at) {
      return res.status(404).json({ error: 'invite not found', code: 'INVITE_INVALID' });
    }
    if (inv.accepted_at) {
      return res.status(409).json({ error: 'invite already accepted', code: 'INVITE_USED' });
    }
    if (new Date(inv.expires_at) < new Date()) {
      return res.status(400).json({ error: 'invite has expired', code: 'INVITE_EXPIRED' });
    }
    if ((req.user.email || '').toLowerCase() !== inv.email.toLowerCase()) {
      return res.status(403).json({
        error: 'this invite was issued to a different email address',
        code: 'INVITE_EMAIL_MISMATCH',
      });
    }
    const fname = typeof req.body?.fname === 'string' ? req.body.fname.trim() : '';
    const lname = typeof req.body?.lname === 'string' ? req.body.lname.trim() : '';
    const staff = await (async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // An existing row for this email (e.g. pre-provisioned by a
        // manager) is claimed: attach the Firebase uid, reactivate.
        const existing = await client.query(
          'SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1',
          [inv.email],
        );
        let row;
        if (existing.rows[0]) {
          const r = await client.query(
            `UPDATE users SET firebase_uid = $2, active = true,
                    fname = CASE WHEN fname = '' THEN $3 ELSE fname END,
                    lname = CASE WHEN lname = '' THEN $4 ELSE lname END,
                    updated_at = now()
              WHERE id = $1 RETURNING *`,
            [existing.rows[0].id, req.user.uid, fname, lname],
          );
          row = r.rows[0];
        } else {
          const r = await client.query(
            `INSERT INTO users (firebase_uid, email, role, authorized, active, fname, lname)
             VALUES ($1, $2, $3, true, true, $4, $5) RETURNING *`,
            [req.user.uid, inv.email.toLowerCase(), inv.role, fname, lname],
          );
          row = r.rows[0];
        }
        await client.query(
          'UPDATE invites SET accepted_by = $2, accepted_at = now() WHERE id = $1',
          [inv.id, row.id],
        );
        await insertEvent(client, {
          actor: req.user,
          event: 'invite_accept',
          details: { invite_id: inv.id, staff_user_id: row.id, role: inv.role },
          ip: req.ip,
        });
        await client.query('COMMIT');
        return row;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    })();
    const { pin_hash, ...safe } = staff;
    res.status(201).json({ staff: { ...safe, has_pin: pin_hash != null } });
  } catch (err) {
    next(err);
  }
});

// POST /invites { email, role? } — platform admin. Re-inviting an
// email supersedes its pending invite. Returns the raw code and
// the accept path ONCE — the admin sends the link themselves.
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'a valid email is required', code: 'VALIDATION' });
    }
    const role = req.body?.role ?? 'clinician';
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}`, code: 'VALIDATION' });
    }
    const existing = await pool.query(
      'SELECT id FROM users WHERE lower(email) = lower($1) AND active = true LIMIT 1',
      [email],
    );
    if (existing.rows[0]) {
      return res.status(409).json({
        error: 'that email already has an active staff account',
        code: 'ALREADY_STAFF',
      });
    }
    const admin = await resolveStaff(req);
    const code = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const client = await pool.connect();
    let inv;
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE invites SET revoked_at = now()
          WHERE lower(email) = lower($1) AND accepted_at IS NULL AND revoked_at IS NULL`,
        [email],
      );
      const r = await client.query(
        `INSERT INTO invites (email, role, code_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [email, role, hashCode(code), admin?.id ?? null, expiresAt.toISOString()],
      );
      inv = r.rows[0];
      await insertEvent(client, {
        actor: req.user,
        event: 'invite_create',
        details: { invite_id: inv.id, role },
        ip: req.ip,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    res.status(201).json({
      invite: shapeInvite(inv),
      code,
      accept_path: `/accept-invite?code=${code}`,
    });
  } catch (err) {
    next(err);
  }
});

// GET /invites — platform admin: all invites, newest first.
router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM invites ORDER BY created_at DESC LIMIT 200',
    );
    res.json({ invites: rows.map(shapeInvite) });
  } catch (err) {
    next(err);
  }
});

// DELETE /invites/:id — platform admin: revoke a pending invite.
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'id must be an integer', code: 'VALIDATION' });
    }
    const r = await pool.query(
      `UPDATE invites SET revoked_at = now()
        WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
        RETURNING *`,
      [id],
    );
    if (!r.rows[0]) {
      return res.status(404).json({ error: 'pending invite not found', code: 'INVITE_INVALID' });
    }
    res.json({ invite: shapeInvite(r.rows[0]) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
