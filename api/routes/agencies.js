// Agency directory routes for the CareTask demo API — the
// Illinois home-health agency directory imported from IDPH open
// data (see schema-agencies.sql and lib/agencySync.js).
//
// Endpoints (mounted under /agencies by server.js, behind
// requireAuth):
//   GET  /agencies               list (filters ?q= name/city/
//                                license search, ?active=true|false,
//                                ?service=nursing,pt (CMS service
//                                lines — agency must offer ALL),
//                                ?min_rating=4 (CMS star rating >=,
//                                unrated excluded), ?limit=,
//                                ?offset=; name order). Rows carry
//                                the CMS enrichment columns (ccn,
//                                offers_*, star_rating, …) from
//                                schema-agencies-cms.sql.
//   GET  /agencies/primary       the is_primary ("our agency") row,
//                                or JSON null when none is set
//   GET  /agencies/sync-status   latest agency_sync event summary
//                                (last run time + counts), or null
//   GET  /agencies/:id           one agency
//   POST /agencies/sync          run the IDPH sync now
//                                (MANAGER PIN required)
//   PUT  /agencies/:id           edit LOCAL fields only —
//                                is_primary, notes, short_name
//                                (MANAGER PIN required). Source
//                                fields belong
//                                to IDPH and are read-only here:
//                                anything else in the body is
//                                ignored, exactly like the patients
//                                whitelist.
//
// Logging discipline (single point): a sync writes exactly one
// agency_sync event, from inside lib/agencySync.js — this route
// never logs a second one. PUT writes an admin_action event in
// the same transaction naming the authorizing manager. Event
// details carry ids and counts only, never agency content beyond
// what an id identifies.
const express = require('express');
const pool = require('../db');
const { insertEvent } = require('../lib/eventLog');
const requireManagerPin = require('../lib/requireManagerPin');
const { syncAgencies, parseDba } = require('../lib/agencySync');

const router = express.Router();

function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  return Number(raw);
}

async function fetchOne(db, id) {
  const r = await db.query('SELECT * FROM agencies WHERE id = $1', [id]);
  return r.rows[0] ?? null;
}

// The name the dashboard shows big. Jake's precedence
// (2026-10-30): a local short_name wins; then the DBA embedded
// in the IDPH facility name; then the first two words of the
// name; the full name when it is already ≤ 2 words. Computed
// per response — it is a presentation rule, not stored data
// (short_name and dba ARE stored; this just combines them).
function computeDisplayName(row) {
  const short = (row.short_name || '').trim();
  if (short) return short;
  const dba = (row.dba || '').trim() || parseDba(row.name);
  if (dba) return dba;
  const words = (row.name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= 2) return (row.name || '').trim();
  return words.slice(0, 2).join(' ');
}

function withDisplay(row) {
  if (!row) return row;
  return { ...row, display_name: computeDisplayName(row) };
}

// --- GET /agencies/primary (before /:id — "primary" is not an id)
router.get('/primary', async (req, res, next) => {
  try {
    const r = await pool.query(
      'SELECT * FROM agencies WHERE is_primary = true LIMIT 1',
    );
    res.json(r.rows.length ? withDisplay(r.rows[0]) : null);
  } catch (err) {
    next(err);
  }
});

// --- GET /agencies/sync-status — derived from event_log, which is
// the system of record for sync runs (no separate state table).
router.get('/sync-status', async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT created_at, details FROM event_log
        WHERE event = 'agency_sync'
        ORDER BY seq DESC LIMIT 1`,
    );
    if (!r.rows.length) return res.json(null);
    return res.json({
      last_run_at: r.rows[0].created_at,
      ...r.rows[0].details,
    });
  } catch (err) {
    return next(err);
  }
});

// --- GET /agencies
router.get('/', async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    if (req.query.active !== undefined) {
      if (!['true', 'false'].includes(req.query.active)) {
        return res.status(400).json({ error: 'active must be true or false', code: 'VALIDATION' });
      }
      params.push(req.query.active === 'true');
      where.push(`active = $${params.length}`);
    }
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      where.push(
        `(name ILIKE $${params.length} OR dba ILIKE $${params.length} OR short_name ILIKE $${params.length} OR city ILIKE $${params.length} OR license_number ILIKE $${params.length})`,
      );
    }
    if (req.query.service) {
      const SERVICE_COLUMNS = {
        nursing: 'offers_nursing',
        pt: 'offers_pt',
        ot: 'offers_ot',
        speech: 'offers_speech',
        msw: 'offers_msw',
        hha: 'offers_hha',
      };
      const wanted = String(req.query.service)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (!wanted.length || wanted.some((s) => !(s in SERVICE_COLUMNS))) {
        return res.status(400).json({
          error: 'service must be a comma list of nursing, pt, ot, speech, msw, hha',
          code: 'VALIDATION',
        });
      }
      // Column names come only from the fixed map above — safe
      // to interpolate; no user value reaches the SQL text.
      for (const s of wanted) where.push(`${SERVICE_COLUMNS[s]} = true`);
    }
    if (req.query.min_rating !== undefined) {
      const min = Number(req.query.min_rating);
      if (!Number.isFinite(min) || min < 0 || min > 5) {
        return res.status(400).json({
          error: 'min_rating must be a number between 0 and 5',
          code: 'VALIDATION',
        });
      }
      params.push(min);
      // star_rating >= excludes NULL (unrated) rows on its own.
      where.push(`star_rating >= $${params.length}`);
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT * FROM agencies
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY name ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return res.json(result.rows.map(withDisplay));
  } catch (err) {
    return next(err);
  }
});

// --- GET /agencies/:id
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: 'agency not found' });
    const row = await fetchOne(pool, id);
    if (!row) return res.status(404).json({ error: 'agency not found' });
    return res.json(withDisplay(row));
  } catch (err) {
    return next(err);
  }
});

// --- POST /agencies/sync (manager PIN)
router.post('/sync', requireManagerPin, async (req, res, next) => {
  try {
    const summary = await syncAgencies(pool, {
      actor: req.user,
      trigger: 'api',
    });
    res.json(summary);
  } catch (err) {
    // Upstream/IDPH failures surface plainly (502), never silently.
    console.error('agency sync failed:', err.message);
    res.status(502).json({ error: 'agency sync failed', code: 'SYNC_FAILED' });
  }
});

// --- PUT /agencies/:id (manager PIN, local fields only)
router.put('/:id', requireManagerPin, async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'agency not found' });
  const body = req.body || {};
  const fields = {};
  if ('is_primary' in body) {
    if (typeof body.is_primary !== 'boolean') {
      return res.status(400).json({ error: 'is_primary must be a boolean', code: 'VALIDATION' });
    }
    fields.is_primary = body.is_primary;
  }
  if ('notes' in body) {
    if (body.notes !== null && typeof body.notes !== 'string') {
      return res.status(400).json({ error: 'notes must be a string or null', code: 'VALIDATION' });
    }
    fields.notes = body.notes;
  }
  if ('short_name' in body) {
    if (body.short_name !== null && typeof body.short_name !== 'string') {
      return res.status(400).json({ error: 'short_name must be a string or null', code: 'VALIDATION' });
    }
    // Blank means "no short name" — fall back to the DBA /
    // two-words rules instead of showing an empty heading.
    fields.short_name = body.short_name === null || body.short_name.trim() === ''
      ? null
      : body.short_name.trim();
  }
  if (!Object.keys(fields).length) {
    return res.status(400).json({
      error: 'no local fields to update (only is_primary, notes and short_name are editable)',
      code: 'VALIDATION',
    });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await fetchOne(client, id);
    if (!existing) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'agency not found' });
    }
    if (fields.is_primary === true) {
      // One primary at a time (the partial unique index is the
      // backstop; clearing first keeps the invariant obvious).
      await client.query(
        'UPDATE agencies SET is_primary = false WHERE is_primary = true AND id <> $1',
        [id],
      );
    }
    const keys = Object.keys(fields);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const result = await client.query(
      `UPDATE agencies SET ${setClause} WHERE id = $${keys.length + 1} RETURNING *`,
      [...Object.values(fields), id],
    );
    const row = result.rows[0];
    await insertEvent(client, {
      actor: req.user,
      event: 'admin_action',
      details: {
        action: 'agency_update',
        agency_id: row.id,
        fields: keys,
        manager_user_id: req.manager.id,
        manager_email: req.manager.email,
        manager_role: req.manager.role,
      },
      ip: req.ip,
    });
    await client.query('COMMIT');
    return res.json(withDisplay(row));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
// Shared with routes/patients.js, which resolves a patient's
// agency_name to the linked agency's display_name.
module.exports.computeDisplayName = computeDisplayName;
