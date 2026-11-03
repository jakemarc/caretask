// Episode routes for the CareTask multi-user platform
// (spec: multi-user-platform-spec.md §5). Mounted at root by
// server.js behind requireAuth + the staff gate; paths are
// /patients/:patientId/episodes and /episodes/:id/...
//
// An episode is the unit of sharing: a patient under ONE agency,
// worked by a team (one primary + members), bounded by admit and
// discharge. At most one ACTIVE episode per patient exists across
// the whole platform — the partial unique index in
// schema-platform.sql enforces it, and a create that collides
// answers 409 EPISODE_ACTIVE naming the holding agency + primary
// so the would-be team can coordinate the discharge.
const express = require('express');
const pool = require('../db');
const { insertEvent } = require('../lib/eventLog');
const { computeDisplayName } = require('./agencies');
const {
  resolveStaff,
  isPlatformAdmin,
  hasChartAccess,
  liveEpisode,
  isCurrentMember,
  isAgencyMember,
} = require('../lib/platform');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Addendum (Jake, 2026-11-03): holds, discharge reasons, and the
// case-manager role. The reason lists mirror the schema CHECKs.
const HOLD_REASONS = ['hospitalized', 'patient_request', 'physician_order', 'other'];
const DISCHARGE_REASONS = [
  'completed', 'patient_declined', 'transferred_agency',
  'transferred_inpatient', 'moved_out_of_area', 'physician_order',
  'deceased', 'other',
];

// An episode is LIVE while active or on hold: team management,
// discharge, and transfers all operate on live episodes.
function isLive(episode) {
  return episode.status === 'active' || episode.status === 'on_hold';
}

function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
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

const EPISODE_SELECT = `
  SELECT e.*, ag.name AS _ag_name, ag.dba AS _ag_dba, ag.short_name AS _ag_short,
         (pu.fname || ' ' || pu.lname) AS primary_name,
         (cm.fname || ' ' || cm.lname) AS _cm_name
    FROM patient_episodes e
    JOIN agencies ag ON ag.id = e.agency_id
    JOIN users pu ON pu.id = e.primary_user_id
    LEFT JOIN users cm ON cm.id = e.case_manager_user_id`;

function shapeEpisode(row) {
  if (!row) return row;
  const { _ag_name, _ag_dba, _ag_short, _cm_name, ...rest } = row;
  return {
    ...rest,
    agency_name: computeDisplayName({
      name: _ag_name,
      dba: _ag_dba,
      short_name: _ag_short,
    }),
    case_manager_name: _cm_name ?? null,
  };
}

async function fetchEpisode(db, id) {
  const r = await db.query(
    `${EPISODE_SELECT} WHERE e.id = $1 AND e.deleted_at IS NULL`,
    [id],
  );
  return r.rows[0] ? shapeEpisode(r.rows[0]) : null;
}

async function fetchMembers(db, episodeId) {
  const r = await db.query(
    `SELECT em.user_id, em.member_role, em.supervised_by,
            (su.fname || ' ' || su.lname) AS supervised_by_name,
            em.added_at, em.removed_at,
            (u.fname || ' ' || u.lname) AS user_name,
            u.role AS user_role, u.position AS user_position
       FROM episode_members em
       JOIN users u ON u.id = em.user_id
       LEFT JOIN users su ON su.id = em.supervised_by
      WHERE em.episode_id = $1
      ORDER BY em.removed_at NULLS FIRST, em.member_role DESC, em.added_at ASC`,
    [episodeId],
  );
  return r.rows;
}

async function withMembers(db, episode) {
  if (!episode) return episode;
  const out = { ...episode, members: await fetchMembers(db, episode.id) };
  if (episode.status === 'on_hold') {
    const h = await db.query(
      `SELECT reason, note, started_on FROM episode_holds
        WHERE episode_id = $1 AND ended_on IS NULL
        ORDER BY started_on DESC, id DESC LIMIT 1`,
      [episode.id],
    );
    out.current_hold = h.rows[0] || null;
  }
  return out;
}

// Who may manage an episode (discharge, recertify, team edits,
// hold/resume, primary + case-manager transfer): the primary,
// the CASE MANAGER (addendum 2026-11-03 — the clinician running
// the case can run the episode), a platform admin, or a
// manager/admin who belongs to the episode's agency.
async function canManage(staff, episode) {
  if (!staff) return false;
  if (Number(staff.id) === Number(episode.primary_user_id)) return true;
  if (
    episode.case_manager_user_id != null &&
    Number(staff.id) === Number(episode.case_manager_user_id)
  ) {
    return true;
  }
  if (isPlatformAdmin(staff)) return true;
  if (['manager', 'admin'].includes(staff.role)) {
    return isAgencyMember(pool, staff.id, episode.agency_id);
  }
  return false;
}

function fail(res, err) {
  return res.status(err.status).json({ error: err.message, code: err.code });
}

// ------------------------------------------------------------------
// POST /patients/:patientId/episodes — start an episode.
// The caller becomes primary. Caller must belong to the agency and
// have the patient on their list (chart access).
router.post('/patients/:patientId/episodes', async (req, res, next) => {
  try {
    const staff = await resolveStaff(req);
    if (!staff) {
      return fail(res, httpError(403, 'no active staff record for this account', 'NO_STAFF_RECORD'));
    }
    const patientId = req.params.patientId;
    if (!UUID_RE.test(patientId)) {
      return fail(res, httpError(400, 'patient id must be a UUID', 'VALIDATION'));
    }
    const patient = await pool.query(
      'SELECT id FROM patients WHERE id = $1 AND deleted_at IS NULL',
      [patientId],
    );
    if (!patient.rows[0]) {
      return fail(res, httpError(404, 'patient not found', 'NOT_FOUND'));
    }
    if (!(await hasChartAccess(staff, patientId))) {
      return fail(res, httpError(404, 'patient not found', 'NOT_FOUND'));
    }
    const agencyId = Number(req.body?.agency_id);
    if (!Number.isInteger(agencyId) || agencyId <= 0) {
      return fail(res, httpError(400, 'agency_id is required', 'VALIDATION'));
    }
    const agency = await pool.query('SELECT id FROM agencies WHERE id = $1', [agencyId]);
    if (!agency.rows[0]) {
      return fail(res, httpError(400, 'agency_id does not match an existing agency', 'AGENCY_NOT_FOUND'));
    }
    if (!isPlatformAdmin(staff) && !(await isAgencyMember(pool, staff.id, agencyId))) {
      return fail(res, httpError(403, 'you do not work for this agency', 'NOT_AGENCY_MEMBER'));
    }
    const admittedAt = req.body?.admitted_at;
    if (admittedAt !== undefined && admittedAt !== null && !DATE_RE.test(admittedAt)) {
      return fail(res, httpError(400, 'admitted_at must be YYYY-MM-DD', 'VALIDATION'));
    }
    const existing = await liveEpisode(pool, patientId);
    if (existing) {
      const holder = await fetchEpisode(pool, existing.id);
      return res.status(409).json({
        error: 'this patient already has an active episode',
        code: 'EPISODE_ACTIVE',
        episode: {
          id: holder.id,
          agency_id: holder.agency_id,
          agency_name: holder.agency_name,
          primary_user_id: holder.primary_user_id,
          primary_name: holder.primary_name,
          admitted_at: holder.admitted_at,
          status: holder.status,
        },
      });
    }
    let episode;
    try {
      episode = await withTx(async (client) => {
        const r = await client.query(
          `INSERT INTO patient_episodes (patient_id, agency_id, primary_user_id, case_manager_user_id, admitted_at, created_by)
           VALUES ($1, $2, $3, $3, COALESCE($4::date, CURRENT_DATE), $3) RETURNING id`,
          [patientId, agencyId, staff.id, admittedAt ?? null],
        );
        const id = r.rows[0].id;
        await client.query(
          `INSERT INTO episode_members (episode_id, user_id, member_role, added_by)
           VALUES ($1, $2, 'primary', $2)`,
          [id, staff.id],
        );
        await insertEvent(client, {
          actor: req.user,
          event: 'episode_create',
          patientId,
          details: { episode_id: id, agency_id: agencyId },
          ip: req.ip,
        });
        return fetchEpisode(client, id);
      });
    } catch (err) {
      if (err.code === '23505') {
        // Lost a create race — the unique index held the line.
        const nowActive = await liveEpisode(pool, patientId);
        const holder = nowActive ? await fetchEpisode(pool, nowActive.id) : null;
        return res.status(409).json({
          error: 'this patient already has an active episode',
          code: 'EPISODE_ACTIVE',
          episode: holder
            ? {
                id: holder.id,
                agency_id: holder.agency_id,
                agency_name: holder.agency_name,
                primary_user_id: holder.primary_user_id,
                primary_name: holder.primary_name,
                admitted_at: holder.admitted_at,
              }
            : null,
        });
      }
      throw err;
    }
    res.status(201).json({ episode: await withMembers(pool, episode) });
  } catch (err) {
    if (err.status) return fail(res, err);
    next(err);
  }
});

// GET /patients/:patientId/episodes — the chart's episode history,
// current episode first. Chart access required.
router.get('/patients/:patientId/episodes', async (req, res, next) => {
  try {
    const staff = await resolveStaff(req);
    if (!staff) {
      return fail(res, httpError(403, 'no active staff record for this account', 'NO_STAFF_RECORD'));
    }
    const patientId = req.params.patientId;
    if (!UUID_RE.test(patientId)) {
      return fail(res, httpError(400, 'patient id must be a UUID', 'VALIDATION'));
    }
    if (!(await hasChartAccess(staff, patientId))) {
      return fail(res, httpError(404, 'patient not found', 'NOT_FOUND'));
    }
    const r = await pool.query(
      `${EPISODE_SELECT} WHERE e.patient_id = $1 AND e.deleted_at IS NULL
       ORDER BY e.admitted_at DESC, e.created_at DESC`,
      [patientId],
    );
    const episodes = [];
    for (const row of r.rows) {
      episodes.push(await withMembers(pool, shapeEpisode(row)));
    }
    res.json({ episodes });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------
// POST /episodes/:id/discharge — close the live episode (active or
// on hold). The reason says WHY it ended (addendum 2026-11-03);
// discharging from a hold closes the open hold at the same date.
router.post('/episodes/:id/discharge', async (req, res, next) => {
  try {
    const staff = await resolveStaff(req);
    if (!staff) {
      return fail(res, httpError(403, 'no active staff record for this account', 'NO_STAFF_RECORD'));
    }
    const episode = await fetchEpisode(pool, req.params.id);
    if (!episode) return fail(res, httpError(404, 'episode not found', 'NOT_FOUND'));
    if (!isLive(episode)) {
      return fail(res, httpError(409, 'episode is not active', 'EPISODE_NOT_ACTIVE'));
    }
    if (!(await canManage(staff, episode))) {
      return fail(res, httpError(403, 'only the primary, the case manager, or an agency manager can discharge this episode', 'ROLE_REQUIRED'));
    }
    const dischargedAt = req.body?.discharged_at;
    if (dischargedAt !== undefined && dischargedAt !== null && !DATE_RE.test(dischargedAt)) {
      return fail(res, httpError(400, 'discharged_at must be YYYY-MM-DD', 'VALIDATION'));
    }
    const reason = req.body?.discharge_reason ?? null;
    if (reason !== null && !DISCHARGE_REASONS.includes(reason)) {
      return fail(res, httpError(400, 'discharge_reason is not a known reason', 'VALIDATION'));
    }
    const note = typeof req.body?.discharge_note === 'string' ? req.body.discharge_note : null;
    const updated = await withTx(async (client) => {
      await client.query(
        `UPDATE patient_episodes
            SET status = 'discharged',
                discharged_at = COALESCE($2::date, CURRENT_DATE),
                discharge_reason = $3,
                discharge_note = $4, updated_at = now()
          WHERE id = $1`,
        [episode.id, dischargedAt ?? null, reason, note],
      );
      // A discharge out of a hold closes the hold at the same date.
      await client.query(
        `UPDATE episode_holds
            SET ended_on = COALESCE($2::date, CURRENT_DATE), ended_by = $3
          WHERE episode_id = $1 AND ended_on IS NULL`,
        [episode.id, dischargedAt ?? null, staff.id],
      );
      await insertEvent(client, {
        actor: req.user,
        event: 'episode_discharge',
        patientId: episode.patient_id,
        details: { episode_id: episode.id, action: 'discharge', reason },
        ip: req.ip,
      });
      return fetchEpisode(client, episode.id);
    });
    res.json({ episode: await withMembers(pool, updated) });
  } catch (err) {
    if (err.status) return fail(res, err);
    next(err);
  }
});

// ------------------------------------------------------------------
// POST /episodes/:id/hold — put the episode on hold (addendum
// 2026-11-03: the hospitalization case). The episode stays live —
// it still owns the patient — but the booking gate refuses new
// visits until the hold ends.
router.post('/episodes/:id/hold', async (req, res, next) => {
  try {
    const staff = await resolveStaff(req);
    if (!staff) {
      return fail(res, httpError(403, 'no active staff record for this account', 'NO_STAFF_RECORD'));
    }
    const episode = await fetchEpisode(pool, req.params.id);
    if (!episode) return fail(res, httpError(404, 'episode not found', 'NOT_FOUND'));
    if (episode.status === 'on_hold') {
      return fail(res, httpError(409, 'episode is already on hold', 'ALREADY_ON_HOLD'));
    }
    if (episode.status !== 'active') {
      return fail(res, httpError(409, 'episode is not active', 'EPISODE_NOT_ACTIVE'));
    }
    if (!(await canManage(staff, episode))) {
      return fail(res, httpError(403, 'only the primary, the case manager, or an agency manager can hold this episode', 'ROLE_REQUIRED'));
    }
    const reason = req.body?.reason ?? 'other';
    if (!HOLD_REASONS.includes(reason)) {
      return fail(res, httpError(400, 'reason is not a known hold reason', 'VALIDATION'));
    }
    const note = typeof req.body?.note === 'string' ? req.body.note : null;
    const startedOn = req.body?.started_on;
    if (startedOn !== undefined && startedOn !== null && !DATE_RE.test(startedOn)) {
      return fail(res, httpError(400, 'started_on must be YYYY-MM-DD', 'VALIDATION'));
    }
    const updated = await withTx(async (client) => {
      await client.query(
        `INSERT INTO episode_holds (episode_id, reason, note, started_on, started_by)
         VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5)`,
        [episode.id, reason, note, startedOn ?? null, staff.id],
      );
      await client.query(
        `UPDATE patient_episodes SET status = 'on_hold', updated_at = now() WHERE id = $1`,
        [episode.id],
      );
      await insertEvent(client, {
        actor: req.user,
        event: 'episode_hold',
        patientId: episode.patient_id,
        details: { episode_id: episode.id, reason },
        ip: req.ip,
      });
      return fetchEpisode(client, episode.id);
    });
    res.json({ episode: await withMembers(pool, updated) });
  } catch (err) {
    if (err.status) return fail(res, err);
    next(err);
  }
});

// POST /episodes/:id/resume — end the current hold; the episode
// goes back to active and booking reopens.
router.post('/episodes/:id/resume', async (req, res, next) => {
  try {
    const staff = await resolveStaff(req);
    if (!staff) {
      return fail(res, httpError(403, 'no active staff record for this account', 'NO_STAFF_RECORD'));
    }
    const episode = await fetchEpisode(pool, req.params.id);
    if (!episode) return fail(res, httpError(404, 'episode not found', 'NOT_FOUND'));
    if (episode.status !== 'on_hold') {
      return fail(res, httpError(409, 'episode is not on hold', 'NOT_ON_HOLD'));
    }
    if (!(await canManage(staff, episode))) {
      return fail(res, httpError(403, 'only the primary, the case manager, or an agency manager can resume this episode', 'ROLE_REQUIRED'));
    }
    const resumedOn = req.body?.resumed_on;
    if (resumedOn !== undefined && resumedOn !== null && !DATE_RE.test(resumedOn)) {
      return fail(res, httpError(400, 'resumed_on must be YYYY-MM-DD', 'VALIDATION'));
    }
    const updated = await withTx(async (client) => {
      await client.query(
        `UPDATE episode_holds
            SET ended_on = COALESCE($2::date, CURRENT_DATE), ended_by = $3
          WHERE episode_id = $1 AND ended_on IS NULL`,
        [episode.id, resumedOn ?? null, staff.id],
      );
      await client.query(
        `UPDATE patient_episodes SET status = 'active', updated_at = now() WHERE id = $1`,
        [episode.id],
      );
      await insertEvent(client, {
        actor: req.user,
        event: 'episode_resume',
        patientId: episode.patient_id,
        details: { episode_id: episode.id },
        ip: req.ip,
      });
      return fetchEpisode(client, episode.id);
    });
    res.json({ episode: await withMembers(pool, updated) });
  } catch (err) {
    if (err.status) return fail(res, err);
    next(err);
  }
});

// PUT /episodes/:id/case-manager — hand case management to
// another current team member (addendum 2026-11-03). The normal
// case is a discipline finishing mid-episode: nursing discharges,
// therapy continues, the PT becomes case manager.
router.put('/episodes/:id/case-manager', async (req, res, next) => {
  try {
    const staff = await resolveStaff(req);
    if (!staff) {
      return fail(res, httpError(403, 'no active staff record for this account', 'NO_STAFF_RECORD'));
    }
    const episode = await fetchEpisode(pool, req.params.id);
    if (!episode) return fail(res, httpError(404, 'episode not found', 'NOT_FOUND'));
    if (!isLive(episode)) {
      return fail(res, httpError(409, 'episode is not active', 'EPISODE_NOT_ACTIVE'));
    }
    if (!(await canManage(staff, episode))) {
      return fail(res, httpError(403, 'only the primary, the case manager, or an agency manager can change the case manager', 'ROLE_REQUIRED'));
    }
    const userId = Number(req.body?.user_id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return fail(res, httpError(400, 'user_id is required', 'VALIDATION'));
    }
    if (!(await isCurrentMember(pool, episode.id, userId))) {
      return fail(res, httpError(400, 'the case manager must already be on the team', 'NOT_ON_TEAM'));
    }
    const updated = await withTx(async (client) => {
      await client.query(
        'UPDATE patient_episodes SET case_manager_user_id = $2, updated_at = now() WHERE id = $1',
        [episode.id, userId],
      );
      await insertEvent(client, {
        actor: req.user,
        event: 'episode_case_manager',
        patientId: episode.patient_id,
        details: {
          episode_id: episode.id,
          from_user_id: episode.case_manager_user_id,
          to_user_id: userId,
        },
        ip: req.ip,
      });
      return fetchEpisode(client, episode.id);
    });
    res.json({ episode: await withMembers(pool, updated) });
  } catch (err) {
    if (err.status) return fail(res, err);
    next(err);
  }
});

// POST /episodes/:id/recertify — same agency, same team: discharge
// this episode and open the next one, chained via recert_of. One
// call, so a recertification never looks like a transfer.
router.post('/episodes/:id/recertify', async (req, res, next) => {
  try {
    const staff = await resolveStaff(req);
    if (!staff) {
      return fail(res, httpError(403, 'no active staff record for this account', 'NO_STAFF_RECORD'));
    }
    const episode = await fetchEpisode(pool, req.params.id);
    if (!episode) return fail(res, httpError(404, 'episode not found', 'NOT_FOUND'));
    if (episode.status === 'on_hold') {
      return fail(res, httpError(409, 'episode is on hold — resume or discharge it first', 'EPISODE_ON_HOLD'));
    }
    if (episode.status !== 'active') {
      return fail(res, httpError(409, 'episode is not active', 'EPISODE_NOT_ACTIVE'));
    }
    if (!(await canManage(staff, episode))) {
      return fail(res, httpError(403, 'only the primary, the case manager, or an agency manager can recertify this episode', 'ROLE_REQUIRED'));
    }
    const admittedAt = req.body?.admitted_at;
    if (admittedAt !== undefined && admittedAt !== null && !DATE_RE.test(admittedAt)) {
      return fail(res, httpError(400, 'admitted_at must be YYYY-MM-DD', 'VALIDATION'));
    }
    const created = await withTx(async (client) => {
      const start = admittedAt ?? null;
      await client.query(
        `UPDATE patient_episodes
            SET status = 'discharged',
                discharged_at = CASE
                  WHEN $2::date IS NOT NULL AND $2::date - 1 >= admitted_at
                    THEN $2::date - 1
                  ELSE COALESCE($2::date, CURRENT_DATE) END,
                updated_at = now()
          WHERE id = $1`,
        [episode.id, start],
      );
      const r = await client.query(
        `INSERT INTO patient_episodes (patient_id, agency_id, primary_user_id, case_manager_user_id, admitted_at, recert_of, created_by)
         VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6, $7) RETURNING id`,
        [episode.patient_id, episode.agency_id, episode.primary_user_id, episode.case_manager_user_id, start, episode.id, staff.id],
      );
      const newId = r.rows[0].id;
      await client.query(
        `INSERT INTO episode_members (episode_id, user_id, member_role, supervised_by, added_by)
         SELECT $1, user_id, member_role, supervised_by, $2
           FROM episode_members
          WHERE episode_id = $3 AND removed_at IS NULL`,
        [newId, staff.id, episode.id],
      );
      await insertEvent(client, {
        actor: req.user,
        event: 'episode_discharge',
        patientId: episode.patient_id,
        details: { episode_id: episode.id, action: 'recertify', new_episode_id: newId },
        ip: req.ip,
      });
      await insertEvent(client, {
        actor: req.user,
        event: 'episode_create',
        patientId: episode.patient_id,
        details: { episode_id: newId, agency_id: episode.agency_id, action: 'recertify', recert_of: episode.id },
        ip: req.ip,
      });
      return fetchEpisode(client, newId);
    });
    res.status(201).json({ episode: await withMembers(pool, created) });
  } catch (err) {
    if (err.status) return fail(res, err);
    next(err);
  }
});

// PUT /episodes/:id/primary — hand the primary role to a current
// member of the team.
router.put('/episodes/:id/primary', async (req, res, next) => {
  try {
    const staff = await resolveStaff(req);
    if (!staff) {
      return fail(res, httpError(403, 'no active staff record for this account', 'NO_STAFF_RECORD'));
    }
    const episode = await fetchEpisode(pool, req.params.id);
    if (!episode) return fail(res, httpError(404, 'episode not found', 'NOT_FOUND'));
    if (!isLive(episode)) {
      return fail(res, httpError(409, 'episode is not active', 'EPISODE_NOT_ACTIVE'));
    }
    if (!(await canManage(staff, episode))) {
      return fail(res, httpError(403, 'only the primary, the case manager, or an agency manager can change the primary', 'ROLE_REQUIRED'));
    }
    const userId = Number(req.body?.user_id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return fail(res, httpError(400, 'user_id is required', 'VALIDATION'));
    }
    if (!(await isCurrentMember(pool, episode.id, userId))) {
      return fail(res, httpError(400, 'the new primary must already be on the team', 'NOT_ON_TEAM'));
    }
    const updated = await withTx(async (client) => {
      await client.query(
        `UPDATE episode_members SET member_role = 'member'
          WHERE episode_id = $1 AND user_id = $2`,
        [episode.id, episode.primary_user_id],
      );
      await client.query(
        `UPDATE episode_members SET member_role = 'primary'
          WHERE episode_id = $1 AND user_id = $2`,
        [episode.id, userId],
      );
      await client.query(
        'UPDATE patient_episodes SET primary_user_id = $2, updated_at = now() WHERE id = $1',
        [episode.id, userId],
      );
      await insertEvent(client, {
        actor: req.user,
        event: 'episode_team',
        patientId: episode.patient_id,
        details: { episode_id: episode.id, action: 'primary_change', user_id: userId },
        ip: req.ip,
      });
      return fetchEpisode(client, episode.id);
    });
    res.json({ episode: await withMembers(pool, updated) });
  } catch (err) {
    if (err.status) return fail(res, err);
    next(err);
  }
});

// POST /episodes/:id/members — add (or re-add) a team member. The
// member must work for the episode's agency. Adding auto-links the
// patient to the member's list.
router.post('/episodes/:id/members', async (req, res, next) => {
  try {
    const staff = await resolveStaff(req);
    if (!staff) {
      return fail(res, httpError(403, 'no active staff record for this account', 'NO_STAFF_RECORD'));
    }
    const episode = await fetchEpisode(pool, req.params.id);
    if (!episode) return fail(res, httpError(404, 'episode not found', 'NOT_FOUND'));
    if (!isLive(episode)) {
      return fail(res, httpError(409, 'episode is not active', 'EPISODE_NOT_ACTIVE'));
    }
    if (!(await canManage(staff, episode))) {
      return fail(res, httpError(403, 'only the primary, the case manager, or an agency manager can change the team', 'ROLE_REQUIRED'));
    }
    const userId = Number(req.body?.user_id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return fail(res, httpError(400, 'user_id is required', 'VALIDATION'));
    }
    const target = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND active = true',
      [userId],
    );
    if (!target.rows[0]) {
      return fail(res, httpError(404, 'user not found', 'USER_NOT_FOUND'));
    }
    if (!(await isAgencyMember(pool, userId, episode.agency_id))) {
      return fail(res, httpError(400, 'that clinician does not work for this agency', 'NOT_AGENCY_MEMBER'));
    }
    const supervisedBy = req.body?.supervised_by;
    if (supervisedBy !== undefined && supervisedBy !== null) {
      if (!Number.isInteger(Number(supervisedBy)) || !(await isCurrentMember(pool, episode.id, Number(supervisedBy)))) {
        return fail(res, httpError(400, 'supervised_by must be a current team member', 'SUPERVISOR_NOT_ON_TEAM'));
      }
    }
    await withTx(async (client) => {
      await client.query(
        `INSERT INTO episode_members (episode_id, user_id, member_role, supervised_by, added_by)
         VALUES ($1, $2, 'member', $3, $4)
         ON CONFLICT (episode_id, user_id) DO UPDATE
           SET removed_at = NULL,
               supervised_by = COALESCE(EXCLUDED.supervised_by, episode_members.supervised_by)`,
        [episode.id, userId, supervisedBy ?? null, staff.id],
      );
      await client.query(
        `INSERT INTO patient_links (user_id, patient_id, list_status)
         VALUES ($1, $2, 'active')
         ON CONFLICT (user_id, patient_id) DO UPDATE
           SET removed_at = NULL, updated_at = now()`,
        [userId, episode.patient_id],
      );
      await insertEvent(client, {
        actor: req.user,
        event: 'episode_team',
        patientId: episode.patient_id,
        details: { episode_id: episode.id, action: 'member_add', user_id: userId },
        ip: req.ip,
      });
    });
    const members = await fetchMembers(pool, episode.id);
    res.status(201).json({ members });
  } catch (err) {
    if (err.status) return fail(res, err);
    next(err);
  }
});

// DELETE /episodes/:id/members/:userId — remove from the team
// (history kept via removed_at). The primary cannot be removed.
router.delete('/episodes/:id/members/:userId', async (req, res, next) => {
  try {
    const staff = await resolveStaff(req);
    if (!staff) {
      return fail(res, httpError(403, 'no active staff record for this account', 'NO_STAFF_RECORD'));
    }
    const episode = await fetchEpisode(pool, req.params.id);
    if (!episode) return fail(res, httpError(404, 'episode not found', 'NOT_FOUND'));
    if (!isLive(episode)) {
      return fail(res, httpError(409, 'episode is not active', 'EPISODE_NOT_ACTIVE'));
    }
    if (!(await canManage(staff, episode))) {
      return fail(res, httpError(403, 'only the primary, the case manager, or an agency manager can change the team', 'ROLE_REQUIRED'));
    }
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return fail(res, httpError(400, 'user id must be an integer', 'VALIDATION'));
    }
    if (userId === Number(episode.primary_user_id)) {
      return fail(res, httpError(400, 'the primary cannot be removed — transfer the primary role first', 'CANNOT_REMOVE_PRIMARY'));
    }
    if (
      episode.case_manager_user_id != null &&
      userId === Number(episode.case_manager_user_id)
    ) {
      return fail(res, httpError(400, 'the case manager cannot be removed — hand case management to another member first', 'CANNOT_REMOVE_CASE_MANAGER'));
    }
    const r = await pool.query(
      `UPDATE episode_members SET removed_at = now()
        WHERE episode_id = $1 AND user_id = $2 AND removed_at IS NULL
        RETURNING 1`,
      [episode.id, userId],
    );
    if (!r.rows.length) {
      return fail(res, httpError(404, 'that clinician is not on the team', 'NOT_ON_TEAM'));
    }
    insertEvent(pool, {
      actor: req.user,
      event: 'episode_team',
      patientId: episode.patient_id,
      details: { episode_id: episode.id, action: 'member_remove', user_id: userId },
      ip: req.ip || null,
    }).catch(() => {});
    const members = await fetchMembers(pool, episode.id);
    res.json({ members });
  } catch (err) {
    if (err.status) return fail(res, err);
    next(err);
  }
});

module.exports = router;
