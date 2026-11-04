// Admin console API (admin-site-spec.md §3–§4) — read-only
// aggregates for the administrators-only site at
// admin.marcinnotech.net: platform overview (registry,
// staff, episodes, appointments, sync + backup health) and
// the staff table with per-user rollups.
//
// The gate lives in this router (requireRole with the
// platform-admin roles, 'admin' + 'developer' — the same
// definition as lib/platform.js ADMIN_ROLES and the
// precedent in routes/invites.js), so every endpoint here
// is gated on every request, whichever way the router is
// mounted. server.js additionally mounts it behind
// requireAuth + requireStaff like its siblings. No staff
// record -> 403 NO_STAFF_RECORD; wrong role -> 403
// ROLE_REQUIRED (both from lib/requireRole.js).
//
// Writes are NOT here: staff edits and invites keep flowing
// through the existing /users and /invites endpoints with
// their own gates and event logging (spec §5). The audit
// core is untouched — this router only reads.
const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const { requireRole } = require('../lib/requireRole');

const router = express.Router();
router.use(requireRole('admin', 'developer'));

const DEFAULT_BACKUPS_DIR = '/home/jakemarc2/backups';

// Newest backup file by mtime, or null when the directory is
// missing/empty/unreadable — a monitoring read must never
// 500 over a folder problem (spec §4: name/size/time only).
async function latestBackup() {
  const dir = process.env.ADMIN_BACKUPS_DIR || DEFAULT_BACKUPS_DIR;
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    let best = null;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const st = await fs.promises.stat(path.join(dir, entry.name));
      if (!best || st.mtimeMs > best.mtimeMs) {
        best = { filename: entry.name, size_bytes: st.size, mtimeMs: st.mtimeMs };
      }
    }
    if (!best) return null;
    return {
      filename: best.filename,
      size_bytes: best.size_bytes,
      mtime: new Date(best.mtimeMs).toISOString(),
    };
  } catch {
    return null;
  }
}

router.get('/overview', async (req, res, next) => {
  try {
    const patients = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM patients WHERE deleted_at IS NULL) AS total,
        (SELECT COUNT(*)::int FROM patients
          WHERE deleted_at IS NULL AND created_at >= now() - interval '30 days') AS created_last_30d
    `);
    const users = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM users) AS total,
        (SELECT COUNT(*)::int FROM users WHERE active = true) AS active
    `);
    const roles = await pool.query(
      `SELECT role, COUNT(*)::int AS n FROM users GROUP BY role`,
    );
    const byRole = {};
    for (const r of roles.rows) byRole[r.role] = r.n;
    const links = await pool.query(`
      SELECT list_status, COUNT(*)::int AS n FROM patient_links
      WHERE removed_at IS NULL GROUP BY list_status
    `);
    const linkCounts = { active: 0, hold: 0, discharged: 0 };
    for (const r of links.rows) linkCounts[r.list_status] = r.n;
    const episodes = await pool.query(`
      SELECT status, COUNT(*)::int AS n FROM patient_episodes GROUP BY status
    `);
    const episodeCounts = { active: 0, on_hold: 0, discharged: 0 };
    for (const r of episodes.rows) episodeCounts[r.status] = r.n;
    const appointments = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM appointments
          WHERE deleted_at IS NULL
            AND starts_at >= CURRENT_DATE AND starts_at < CURRENT_DATE + 1) AS today,
        (SELECT COUNT(*)::int FROM appointments
          WHERE deleted_at IS NULL
            AND starts_at >= CURRENT_DATE AND starts_at < CURRENT_DATE + 7) AS next_7d,
        (SELECT COUNT(*)::int FROM appointments WHERE deleted_at IS NULL) AS total
    `);
    const agencies = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM agencies) AS total,
        (SELECT COUNT(*)::int FROM agencies WHERE active = true) AS active
    `);
    const invites = await pool.query(`
      SELECT COUNT(*)::int AS pending FROM invites
      WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
    `);
    const sync = await pool.query(`
      SELECT ucs.user_id::int AS user_id, u.email, ucs.enabled,
             ucs.last_sync_at, ucs.last_result,
             (SELECT COUNT(*)::int FROM contact_sync_items i
               WHERE i.user_id = ucs.user_id) AS items
      FROM user_contact_sync ucs
      JOIN users u ON u.id = ucs.user_id
      ORDER BY u.email
    `);
    const failures = await pool.query(`
      SELECT COUNT(*)::int AS n FROM event_log
      WHERE event = 'auth_failure' AND created_at >= now() - interval '24 hours'
    `);
    // Recent errors: auth failures (folded into event_log by
    // the request logger) plus any event whose details carry
    // an error marker — timestamps, actor, short detail only.
    const errors = await pool.query(`
      SELECT created_at, event, actor_email, details FROM event_log
      WHERE created_at >= now() - interval '7 days'
        AND (event = 'auth_failure'
             OR details ->> 'result' = 'error'
             OR details ? 'error')
      ORDER BY created_at DESC
      LIMIT 10
    `);
    const recentErrors = errors.rows.map((r) => ({
      at: r.created_at,
      event: r.event,
      actor_email: r.actor_email,
      detail:
        r.details?.error ||
        (r.event === 'auth_failure'
          ? `${r.details?.method || ''} ${r.details?.path || ''} -> ${r.details?.status || ''}`.trim()
          : r.details?.result || ''),
    }));

    res.json({
      generated_at: new Date().toISOString(),
      patients: patients.rows[0],
      users: { ...users.rows[0], by_role: byRole },
      links: linkCounts,
      episodes: {
        active: episodeCounts.active,
        on_hold: episodeCounts.on_hold,
        discharged_total: episodeCounts.discharged,
      },
      appointments: appointments.rows[0],
      agencies: agencies.rows[0],
      invites: invites.rows[0],
      contact_sync: sync.rows,
      backups: { latest: await latestBackup() },
      auth_failures_24h: failures.rows[0].n,
      recent_errors: recentErrors,
    });
  } catch (err) {
    next(err);
  }
});

// Staff rows + per-user rollups. Safe columns only — the
// pin_hash column itself never leaves the database here
// (spec §4); counts are list/episode/appointment totals,
// never patient names or clinical data.
const ADMIN_USER_COLUMNS = `
  u.id, u.firebase_uid, u.email, u.role, u.authorized, u.active,
  u.fname, u.mname, u.lname, u.suffix, u.title, u.position,
  u.created_at, u.updated_at
`;

router.get('/users', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT ${ADMIN_USER_COLUMNS},
        (SELECT COUNT(*)::int FROM patient_links pl
          WHERE pl.user_id = u.id AND pl.removed_at IS NULL
            AND pl.list_status = 'active') AS links_active,
        (SELECT COUNT(*)::int FROM patient_links pl
          WHERE pl.user_id = u.id AND pl.removed_at IS NULL
            AND pl.list_status = 'hold') AS links_hold,
        (SELECT COUNT(*)::int FROM patient_links pl
          WHERE pl.user_id = u.id AND pl.removed_at IS NULL
            AND pl.list_status = 'discharged') AS links_discharged,
        (SELECT COUNT(*)::int FROM patient_episodes e
          WHERE e.primary_user_id = u.id) AS episodes_primary,
        (SELECT COUNT(*)::int FROM patient_episodes e
          WHERE e.case_manager_user_id = u.id) AS episodes_case_manager,
        (SELECT COUNT(*)::int FROM appointments a
          WHERE a.provider_id = u.id AND a.deleted_at IS NULL) AS appointments_total,
        (SELECT MAX(ev.created_at) FROM event_log ev
          WHERE lower(ev.actor_email) = lower(u.email)) AS last_event_at,
        ucs.enabled AS sync_enabled, ucs.last_result AS sync_last_result,
        ucs.last_sync_at AS sync_last_sync_at,
        (SELECT COUNT(*)::int FROM contact_sync_items i
          WHERE i.user_id = u.id) AS sync_items
      FROM users u
      LEFT JOIN user_contact_sync ucs ON ucs.user_id = u.id
      ORDER BY u.email
    `);
    res.json(
      rows.map((r) => ({
        id: r.id,
        firebase_uid: r.firebase_uid,
        email: r.email,
        role: r.role,
        authorized: r.authorized,
        active: r.active,
        fname: r.fname,
        mname: r.mname,
        lname: r.lname,
        suffix: r.suffix,
        title: r.title,
        position: r.position,
        created_at: r.created_at,
        updated_at: r.updated_at,
        links: {
          active: r.links_active,
          hold: r.links_hold,
          discharged: r.links_discharged,
        },
        episodes_primary: r.episodes_primary,
        episodes_case_manager: r.episodes_case_manager,
        appointments_total: r.appointments_total,
        contact_sync:
          r.sync_enabled === null
            ? null
            : {
                enabled: r.sync_enabled,
                items: r.sync_items,
                last_result: r.sync_last_result,
                last_sync_at: r.sync_last_sync_at,
              },
        last_event_at: r.last_event_at,
      })),
    );
  } catch (err) {
    next(err);
  }
});

module.exports = router;
