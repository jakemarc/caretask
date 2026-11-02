'use strict';

// CareTask patient merge (contacts-multiagency-spec.md §1).
// Mounted at /patient-merge behind requireAuth (server.js).
//
// Workflow: any clinician can MARK two patient records as a
// suspected duplicate pair (the review queue); a manager/admin
// performs the MERGE — linked rows (appointments, documents,
// messages, mileage legs) re-point to the survivor, the survivor
// inherits the loser's data only where its own fields are empty,
// and the loser is soft-deleted. The merge records the exact moved
// row ids, so UNDO re-points exactly those back and restores the
// loser. Nothing is ever destroyed. One 'patient_merge' event per
// mark/merge/undo carries ids only — no names, no PHI in the log.

const express = require('express');
const pool = require('../db');
const { insertEvent } = require('../lib/eventLog');
const { requireRole } = require('../lib/requireRole');

const router = express.Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function asUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v) ? v : null;
}

function dateOnly(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function patientSummary(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: [r.fname, r.lname].filter(Boolean).join(' '),
    fname: r.fname,
    lname: r.lname,
    date_of_birth: dateOnly(r.date_of_birth),
    age: r.age == null ? null : Number(r.age),
    sex: r.sex ?? null,
    zone: r.zone ?? null,
    status: r.status ?? null,
    address: [r.street, r.street_line_2, r.city, r.state, r.postal_code]
      .filter(Boolean)
      .join(', ') || null,
    phone_cell: r.phone_cell ?? null,
    phone_home: r.phone_home ?? null,
    email: r.email ?? null,
    agency_id: r.agency_id == null ? null : Number(r.agency_id),
    agency_name_text: r.agency_name_text ?? null,
    deleted: r.deleted_at != null,
  };
}

const SUMMARY_COLS = `id, fname, lname, date_of_birth, age, sex, zone,
  status, street, street_line_2, city, state, postal_code,
  phone_home, phone_cell, email, agency_id, agency_name_text,
  deleted_at`;

async function loadPatient(db, id) {
  const r = await db.query(
    `SELECT * FROM patients WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

// ── The review queue: open marks with both patients ──────────────

router.get('/marks', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT m.patient_low, m.patient_high, m.created_by, m.created_at,
              a.id AS a_id, a.fname AS a_fname, a.lname AS a_lname,
              a.date_of_birth AS a_dob, a.age AS a_age, a.sex AS a_sex,
              a.zone AS a_zone, a.status AS a_status, a.street AS a_street,
              a.street_line_2 AS a_st2, a.city AS a_city, a.state AS a_state,
              a.postal_code AS a_zip, a.phone_home AS a_ph,
              a.phone_cell AS a_pc, a.email AS a_email,
              a.agency_id AS a_ag, a.agency_name_text AS a_agt,
              a.deleted_at AS a_del,
              b.id AS b_id, b.fname AS b_fname, b.lname AS b_lname,
              b.date_of_birth AS b_dob, b.age AS b_age, b.sex AS b_sex,
              b.zone AS b_zone, b.status AS b_status, b.street AS b_street,
              b.street_line_2 AS b_st2, b.city AS b_city, b.state AS b_state,
              b.postal_code AS b_zip, b.phone_home AS b_ph,
              b.phone_cell AS b_pc, b.email AS b_email,
              b.agency_id AS b_ag, b.agency_name_text AS b_agt,
              b.deleted_at AS b_del
         FROM patient_merge_marks m
         JOIN patients a ON a.id = m.patient_low
         JOIN patients b ON b.id = m.patient_high
        WHERE m.deleted_at IS NULL
        ORDER BY m.created_at`
    );
    const un = (row, p) => patientSummary({
      id: row[`${p}_id`], fname: row[`${p}_fname`], lname: row[`${p}_lname`],
      date_of_birth: row[`${p}_dob`], age: row[`${p}_age`], sex: row[`${p}_sex`],
      zone: row[`${p}_zone`], status: row[`${p}_status`],
      street: row[`${p}_street`], street_line_2: row[`${p}_st2`],
      city: row[`${p}_city`], state: row[`${p}_state`],
      postal_code: row[`${p}_zip`], phone_home: row[`${p}_ph`],
      phone_cell: row[`${p}_pc`], email: row[`${p}_email`],
      agency_id: row[`${p}_ag`], agency_name_text: row[`${p}_agt`],
      deleted_at: row[`${p}_del`],
    });
    return res.json({
      marks: r.rows.map((row) => ({
        patient_low: row.patient_low,
        patient_high: row.patient_high,
        created_by: row.created_by,
        created_at: row.created_at,
        patient_a: un(row, 'a'),
        patient_b: un(row, 'b'),
      })),
    });
  } catch (err) {
    return sendErr(res, err);
  }
});

// ── Mark / dismiss a suspected-duplicate pair ────────────────────

async function pairFromBody(req) {
  const a = asUuid(req.body?.patient_id);
  const b = asUuid(req.body?.other_id);
  if (!a || !b) {
    throw httpError(400, 'INVALID_ID', 'patient_id and other_id must be patient ids.');
  }
  if (a === b) {
    throw httpError(400, 'SAME_PATIENT', 'A record cannot be marked against itself.');
  }
  const [pa, pb] = [await loadPatient(pool, a), await loadPatient(pool, b)];
  if (!pa || !pb) {
    throw httpError(404, 'PATIENT_NOT_FOUND', 'One of the patients was not found.');
  }
  if (pa.deleted_at || pb.deleted_at) {
    throw httpError(409, 'PATIENT_DELETED', 'A deleted record cannot be marked.');
  }
  return a < b ? [a, b] : [b, a];
}

router.post('/mark', async (req, res) => {
  try {
    const [low, high] = await pairFromBody(req);
    await pool.query(
      `INSERT INTO patient_merge_marks (patient_low, patient_high, created_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (patient_low, patient_high) DO UPDATE
         SET deleted_at = NULL, created_by = EXCLUDED.created_by,
             created_at = now()
       WHERE patient_merge_marks.deleted_at IS NOT NULL`,
      [low, high, req.user.email]
    );
    await insertEvent(pool, {
      event: 'patient_merge', actor: req.user, patientId: low,
      details: { action: 'mark', patient_low: low, patient_high: high },
    });
    return res.status(201).json({ marked: true, patient_low: low, patient_high: high });
  } catch (err) {
    return sendErr(res, err);
  }
});

router.post('/mark/dismiss', async (req, res) => {
  try {
    const a = asUuid(req.body?.patient_id);
    const b = asUuid(req.body?.other_id);
    if (!a || !b || a === b) {
      throw httpError(400, 'INVALID_ID', 'patient_id and other_id must be two different patient ids.');
    }
    const [low, high] = a < b ? [a, b] : [b, a];
    const r = await pool.query(
      `UPDATE patient_merge_marks SET deleted_at = now()
        WHERE patient_low = $1 AND patient_high = $2 AND deleted_at IS NULL`,
      [low, high]
    );
    if (r.rowCount === 0) {
      throw httpError(404, 'MARK_NOT_FOUND', 'No open mark for that pair.');
    }
    await insertEvent(pool, {
      event: 'patient_merge', actor: req.user, patientId: low,
      details: { action: 'dismiss', patient_low: low, patient_high: high },
    });
    return res.json({ dismissed: true });
  } catch (err) {
    return sendErr(res, err);
  }
});

// ── Recent merges (newest first) ─────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT mg.id, mg.survivor_id, mg.loser_id, mg.merged_by,
              mg.moved_ids, mg.created_at, mg.undone_at, mg.undone_by,
              s.fname AS s_fname, s.lname AS s_lname,
              l.fname AS l_fname, l.lname AS l_lname
         FROM patient_merges mg
         JOIN patients s ON s.id = mg.survivor_id
         JOIN patients l ON l.id = mg.loser_id
        ORDER BY mg.created_at DESC
        LIMIT 50`
    );
    return res.json({
      merges: r.rows.map((m) => ({
        id: Number(m.id),
        survivor_id: m.survivor_id,
        loser_id: m.loser_id,
        survivor_name: [m.s_fname, m.s_lname].filter(Boolean).join(' '),
        loser_name: [m.l_fname, m.l_lname].filter(Boolean).join(' '),
        merged_by: m.merged_by,
        created_at: m.created_at,
        moved: {
          appointments: (m.moved_ids?.appointments ?? []).length,
          documents: (m.moved_ids?.documents ?? []).length,
          messages: (m.moved_ids?.messages ?? []).length,
          mileage_entries: (m.moved_ids?.mileage_entries ?? []).length,
        },
        undone_at: m.undone_at,
        undone_by: m.undone_by,
      })),
    });
  } catch (err) {
    return sendErr(res, err);
  }
});

// ── The merge (manager/admin) ────────────────────────────────────

// Fields the survivor inherits from the loser ONLY where its own
// value is empty. Identity (names), clinical state (zone, status,
// clinician, flags), consent flags, and sensitive identifiers
// (ss, drivers_license) never move.
const GAP_FILL = [
  'date_of_birth', 'age', 'sex', 'race', 'ethnicity', 'language',
  'street', 'street_line_2', 'city', 'state', 'postal_code',
  'country_code', 'latitude', 'longitude', 'phone_home', 'phone_cell',
  'email', 'occupation', 'referrer', 'emergency_contact_name',
  'emergency_contact_relationship', 'emergency_contact_phone',
  'billing_note', 'financial', 'pharmacy_id',
];

const LINKED_TABLES = ['appointments', 'documents', 'messages', 'mileage_entries'];

function isEmpty(v) {
  return v == null || (typeof v === 'string' && v.trim() === '');
}

router.post('/', requireRole('manager', 'admin'), async (req, res) => {
  const survivorId = asUuid(req.body?.survivor_id);
  const loserId = asUuid(req.body?.loser_id);
  if (!survivorId || !loserId) {
    return sendErr(res, httpError(400, 'INVALID_ID', 'survivor_id and loser_id must be patient ids.'));
  }
  if (survivorId === loserId) {
    return sendErr(res, httpError(400, 'SAME_PATIENT', 'A record cannot be merged into itself.'));
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sRes = await client.query(
      `SELECT * FROM patients WHERE id = $1 FOR UPDATE`, [survivorId]
    );
    const lRes = await client.query(
      `SELECT * FROM patients WHERE id = $1 FOR UPDATE`, [loserId]
    );
    const survivor = sRes.rows[0];
    const loser = lRes.rows[0];
    if (!survivor || !loser) {
      throw httpError(404, 'PATIENT_NOT_FOUND', 'One of the patients was not found.');
    }
    if (survivor.deleted_at || loser.deleted_at) {
      throw httpError(409, 'PATIENT_DELETED', 'A deleted record cannot take part in a merge.');
    }

    // Re-point the linked rows, remembering exactly which moved.
    const moved = {};
    for (const table of LINKED_TABLES) {
      const ids = await client.query(
        `SELECT id FROM ${table} WHERE patient_id = $1`, [loserId]
      );
      moved[table] = ids.rows.map((r) => String(r.id));
      if (moved[table].length > 0) {
        await client.query(
          `UPDATE ${table} SET patient_id = $1 WHERE patient_id = $2`,
          [survivorId, loserId]
        );
      }
    }

    // Gap-fill the survivor from the loser.
    const sets = [];
    const vals = [];
    for (const col of GAP_FILL) {
      if (isEmpty(survivor[col]) && !isEmpty(loser[col])) {
        vals.push(loser[col]);
        sets.push(`${col} = $${vals.length}`);
      }
    }
    if (isEmpty(survivor.agency_id) && isEmpty(survivor.agency_name_text) &&
        (!isEmpty(loser.agency_id) || !isEmpty(loser.agency_name_text))) {
      vals.push(loser.agency_id);
      sets.push(`agency_id = $${vals.length}`);
      vals.push(loser.agency_name_text);
      sets.push(`agency_name_text = $${vals.length}`);
    }
    if (!isEmpty(loser.notes) && loser.notes !== survivor.notes) {
      const mergedNotes = isEmpty(survivor.notes)
        ? loser.notes
        : `${survivor.notes}\n[Merged from a duplicate record]\n${loser.notes}`;
      vals.push(mergedNotes);
      sets.push(`notes = $${vals.length}`);
    }
    if (sets.length > 0) {
      vals.push(survivorId);
      await client.query(
        `UPDATE patients SET ${sets.join(', ')} WHERE id = $${vals.length}`,
        vals
      );
    }

    // Soft-delete the loser; close every open mark touching either.
    await client.query(
      `UPDATE patients SET deleted_at = now() WHERE id = $1`, [loserId]
    );
    await client.query(
      `UPDATE patient_merge_marks SET deleted_at = now()
        WHERE deleted_at IS NULL
          AND (patient_low IN ($1, $2) OR patient_high IN ($1, $2))`,
      [survivorId, loserId]
    );

    const mg = await client.query(
      `INSERT INTO patient_merges (survivor_id, loser_id, merged_by, moved_ids)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id, created_at`,
      [survivorId, loserId, req.user.email, JSON.stringify(moved)]
    );
    await insertEvent(client, {
      event: 'patient_merge', actor: req.user, patientId: survivorId,
      details: {
        action: 'merge', merge_id: Number(mg.rows[0].id),
        survivor_id: survivorId, loser_id: loserId,
        moved: Object.fromEntries(
          Object.entries(moved).map(([k, v]) => [k, v.length])
        ),
      },
    });
    await client.query('COMMIT');
    return res.status(201).json({
      merge: {
        id: Number(mg.rows[0].id),
        survivor_id: survivorId,
        loser_id: loserId,
        created_at: mg.rows[0].created_at,
        moved: Object.fromEntries(
          Object.entries(moved).map(([k, v]) => [k, v.length])
        ),
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return sendErr(res, err);
  } finally {
    client.release();
  }
});

// ── Undo a merge (manager/admin) ─────────────────────────────────

router.post('/:id/undo', requireRole('manager', 'admin'), async (req, res) => {
  const mergeId = Number(req.params.id);
  if (!Number.isInteger(mergeId) || mergeId <= 0) {
    return sendErr(res, httpError(400, 'INVALID_ID', 'A merge id is required.'));
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const mgRes = await client.query(
      `SELECT * FROM patient_merges WHERE id = $1 FOR UPDATE`, [mergeId]
    );
    const mg = mgRes.rows[0];
    if (!mg) throw httpError(404, 'MERGE_NOT_FOUND', 'That merge was not found.');
    if (mg.undone_at) {
      throw httpError(409, 'ALREADY_UNDONE', 'That merge has already been undone.');
    }
    const moved = mg.moved_ids || {};
    for (const table of LINKED_TABLES) {
      const ids = (moved[table] ?? []).map(String);
      if (ids.length > 0) {
        await client.query(
          `UPDATE ${table} SET patient_id = $1
            WHERE patient_id = $2 AND id = ANY($3::bigint[])`,
          [mg.loser_id, mg.survivor_id, ids]
        );
      }
    }
    await client.query(
      `UPDATE patients SET deleted_at = NULL WHERE id = $1`, [mg.loser_id]
    );
    await client.query(
      `UPDATE patient_merges SET undone_at = now(), undone_by = $1
        WHERE id = $2`,
      [req.user.email, mergeId]
    );
    await insertEvent(client, {
      event: 'patient_merge', actor: req.user, patientId: mg.survivor_id,
      details: {
        action: 'undo', merge_id: mergeId,
        survivor_id: mg.survivor_id, loser_id: mg.loser_id,
      },
    });
    await client.query('COMMIT');
    return res.json({ undone: true, merge_id: mergeId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return sendErr(res, err);
  } finally {
    client.release();
  }
});

module.exports = router;
