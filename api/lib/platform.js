// Multi-user platform helpers (spec: multi-user-platform-spec.md).
//
// The platform model in one place:
// - A caller resolves to a staff row (users) by firebase_uid, else
//   by email. No staff row = no platform access (the invite system
//   is the perimeter; ALLOWED_EMAILS is retired).
// - Chart access to a patient = platform admin, OR a live link
//   (patient_links, removed_at IS NULL), OR current membership of
//   any of the patient's episodes (episode_members, removed_at
//   IS NULL — discharged episodes included: history stays readable
//   to those who worked it).
// - Platform admin := role admin or developer.
const pool = require('../db');

const ADMIN_ROLES = ['admin', 'developer'];

function isPlatformAdmin(staff) {
  return !!staff && ADMIN_ROLES.includes(staff.role);
}

async function resolveStaff(req) {
  if (req.staff) return req.staff;
  if (!req.user) return null;
  let row = null;
  if (req.user.uid) {
    const byUid = await pool.query(
      'SELECT * FROM users WHERE firebase_uid = $1 AND active = true LIMIT 1',
      [req.user.uid],
    );
    row = byUid.rows[0] || null;
  }
  if (!row && req.user.email) {
    const byEmail = await pool.query(
      'SELECT * FROM users WHERE lower(email) = lower($1) AND active = true LIMIT 1',
      [req.user.email],
    );
    row = byEmail.rows[0] || null;
  }
  if (row) req.staff = row;
  return row;
}

// Middleware: the staff-record gate. Mounted in server.js behind
// requireAuth on every router except /invites (whose accept route
// is how a staff record comes to exist).
async function requireStaff(req, res, next) {
  try {
    const staff = await resolveStaff(req);
    if (!staff) {
      return res.status(403).json({
        error: 'no active staff record for this account',
        code: 'NO_STAFF_RECORD',
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}

async function hasChartAccess(staff, patientId) {
  if (!staff) return false;
  if (isPlatformAdmin(staff)) return true;
  const link = await pool.query(
    `SELECT 1 FROM patient_links
      WHERE user_id = $1 AND patient_id = $2 AND removed_at IS NULL`,
    [staff.id, patientId],
  );
  if (link.rows.length) return true;
  const member = await pool.query(
    `SELECT 1 FROM episode_members em
       JOIN patient_episodes e ON e.id = em.episode_id
      WHERE em.user_id = $1 AND e.patient_id = $2
        AND em.removed_at IS NULL AND e.deleted_at IS NULL`,
    [staff.id, patientId],
  );
  if (member.rows.length) return true;
  // Coverage access (HCHB's rule, adopted 2026-11-03): a clinician
  // covering a visit gets chart access around that visit — a
  // non-cancelled appointment of theirs with this patient within
  // ±7 days — without joining the team or the list.
  const coverage = await pool.query(
    `SELECT 1 FROM appointments
      WHERE provider_id = $1 AND patient_id = $2
        AND deleted_at IS NULL AND status <> 'cancelled'
        AND starts_at BETWEEN now() - interval '7 days'
                          AND now() + interval '7 days'`,
    [staff.id, patientId],
  );
  return coverage.rows.length > 0;
}

async function activeEpisode(db, patientId) {
  const r = await db.query(
    `SELECT * FROM patient_episodes
      WHERE patient_id = $1 AND status = 'active' AND deleted_at IS NULL
      LIMIT 1`,
    [patientId],
  );
  return r.rows[0] || null;
}

// The patient's LIVE episode: active OR on hold (addendum
// 2026-11-03). A held episode still owns the patient — the
// one-live-episode index covers both statuses — so episode
// conflicts and the booking gate key off this, not activeEpisode.
async function liveEpisode(db, patientId) {
  const r = await db.query(
    `SELECT * FROM patient_episodes
      WHERE patient_id = $1 AND status IN ('active', 'on_hold')
        AND deleted_at IS NULL
      LIMIT 1`,
    [patientId],
  );
  return r.rows[0] || null;
}

async function isCurrentMember(db, episodeId, userId) {
  const r = await db.query(
    `SELECT 1 FROM episode_members
      WHERE episode_id = $1 AND user_id = $2 AND removed_at IS NULL`,
    [episodeId, userId],
  );
  return r.rows.length > 0;
}

async function isAgencyMember(db, userId, agencyId) {
  const r = await db.query(
    'SELECT 1 FROM user_agencies WHERE user_id = $1 AND agency_id = $2',
    [userId, agencyId],
  );
  return r.rows.length > 0;
}

function normName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Small Levenshtein for near-match name comparison (candidate sets
// are tiny — same-DOB rows — so a plain implementation is fine).
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

module.exports = {
  ADMIN_ROLES,
  isPlatformAdmin,
  resolveStaff,
  requireStaff,
  hasChartAccess,
  activeEpisode,
  liveEpisode,
  isCurrentMember,
  isAgencyMember,
  normName,
  levenshtein,
};
