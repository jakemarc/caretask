// CRUD routes for the patients table, v2 schema (CareTask demo API).
//
// Endpoints (mounted under /patients by server.js, behind requireAuth):
//   GET    /patients            list (filters: ?zone=, ?q=, ?status=, ?limit=, ?offset=)
//   GET    /patients/:id        one patient, by UUID id
//   GET    /patients/:id/audit  that patient's audit trail, newest first
//   POST   /patients            create
//   PUT    /patients/:id        update (MANAGER PIN required)
//   DELETE /patients/:id        SOFT delete (sets deleted_at; row kept)
//                               (MANAGER PIN required)
//   POST   /patients/:id/restore  undo a soft delete (clears deleted_at)
//                               (MANAGER PIN required)
//
// Audit: every mutation above runs inside one database transaction
// with its audit_log insert, so a change and its audit entry land
// together or not at all. The actor is req.user (Firebase UID + email
// from the verified token, set by auth.js). Audit rows are append-only
// — the schema rejects UPDATE/DELETE on audit_log, and no endpoint
// writes to it except the audit insert itself.
//
// ⚠️  SENSITIVE FIELDS: v2 adds ss and drivers_license. Audit
// snapshots (before/after) include their values verbatim, so
// field-level redaction of audit snapshots MUST be addressed before
// any real data is ever stored. Demo data only until the standing
// gates pass (BAA + incorporation; TLS is live).
//
// Notes:
// - DELETE here is a soft delete on purpose: the row stays in the table
//   with deleted_at set, and every read excludes deleted rows. Nothing
//   is permanently removed through this API.
// - All values go through parameterized queries ($1, $2, ...). Never
//   interpolate request input into SQL strings.
// - zone must be green, yellow, or red; status must be active, hold,
//   or discharged. flags, when supplied, must be an array of strings.
// - Booleans (interpreter_needed, hipaa_allowsms, hipaa_allowemail)
//   must be real JSON booleans or null — strings like "true" and
//   numbers like 1 are REJECTED, not silently coerced, so a client
//   bug cannot flip a consent flag by accident.
// - pharmacy_id must be an integer or null (no FK: no pharmacy table
//   exists yet). Everything else writable must be a string or null.
const express = require('express');
const pool = require('../db');
const { insertEvent } = require('../lib/eventLog');
const requireManagerPin = require('../lib/requireManagerPin');
const { computeDisplayName } = require('./agencies');

const router = express.Router();

const ZONES = ['green', 'yellow', 'red'];
const STATUSES = ['active', 'hold', 'discharged'];
const BOOLEAN_FIELDS = ['interpreter_needed', 'hipaa_allowsms', 'hipaa_allowemail'];

// Fields a request is allowed to set. Anything else in the body is ignored.
const WRITABLE = [
  // Name split.
  'title',
  'fname',
  'mname',
  'lname',
  'suffix',
  // Demographics.
  'date_of_birth',
  'sex',
  'race',
  'ethnicity',
  'language',
  // Address split.
  'street',
  'street_line_2',
  'city',
  'state',
  'postal_code',
  'country_code',
  // Map coordinates (schema-patients-map.sql). Numbers or null —
  // captured from an address-autocomplete pick in the dashboard.
  'latitude',
  'longitude',
  // Phone split.
  'phone_home',
  'phone_cell',
  'email',
  // Care.
  'zone',
  'flags',
  'notes',
  'clinician',
  'occupation',
  'preferred_name',
  'interpreter_needed',
  'hipaa_allowsms',
  'hipaa_allowemail',
  'referrer',
  'status',
  'emergency_contact_name',
  'emergency_contact_relationship',
  'emergency_contact_phone',
  // Sensitive identifiers (fictional-only in the demo).
  'ss',
  'drivers_license',
  // Billing.
  'billing_note',
  'pricelevel',
  'financial',
  // Pharmacy (integer, no FK yet).
  'pharmacy_id',
  // Agency tag (schema-patients-agency.sql): agency_id links
  // the IDPH directory (BIGINT FK, validated — 400
  // AGENCY_NOT_FOUND); agency_name_text is the free-text
  // fallback for an agency not in the directory. Never both:
  // when agency_id is set, agency_name_text is stored NULL.
  'agency_id',
  'agency_name_text',
];

function pickWritable(body) {
  const out = {};
  for (const field of WRITABLE) {
    if (body[field] !== undefined) out[field] = body[field];
  }
  return out;
}

function validatePatient(fields) {
  // Required names: fname + lname must be non-empty strings whenever
  // they are present (create enforces presence; update enforces
  // non-emptiness so a required name can never be blanked out).
  for (const required of ['fname', 'lname']) {
    if (
      fields[required] !== undefined &&
      (typeof fields[required] !== 'string' || !fields[required].trim())
    ) {
      return `${required} must be a non-empty string`;
    }
  }
  if (
    fields.zone !== undefined &&
    !ZONES.includes(fields.zone)
  ) {
    return `zone must be one of: ${ZONES.join(', ')}`;
  }
  if (
    fields.status !== undefined &&
    !STATUSES.includes(fields.status)
  ) {
    return `status must be one of: ${STATUSES.join(', ')}`;
  }
  if (
    fields.flags !== undefined &&
    (!Array.isArray(fields.flags) ||
      fields.flags.some((f) => typeof f !== 'string'))
  ) {
    return 'flags must be an array of strings';
  }
  if (
    fields.date_of_birth !== undefined &&
    fields.date_of_birth !== null &&
    !/^\d{4}-\d{2}-\d{2}$/.test(fields.date_of_birth)
  ) {
    return 'date_of_birth must be YYYY-MM-DD';
  }
  for (const key of BOOLEAN_FIELDS) {
    if (
      fields[key] !== undefined &&
      fields[key] !== null &&
      typeof fields[key] !== 'boolean'
    ) {
      return `${key} must be a boolean`;
    }
  }
  if (
    fields.pharmacy_id !== undefined &&
    fields.pharmacy_id !== null &&
    !Number.isInteger(fields.pharmacy_id)
  ) {
    return 'pharmacy_id must be an integer';
  }
  // agency_id: like the appointments route's references, an
  // integer-valued string is accepted (pg returns int8 as a
  // string, and clients echo it back); anything else that is
  // not an integer or null is a client bug.
  if (fields.agency_id !== undefined && fields.agency_id !== null) {
    const n =
      typeof fields.agency_id === 'string' && /^\d+$/.test(fields.agency_id)
        ? Number(fields.agency_id)
        : fields.agency_id;
    if (!Number.isInteger(n) || n <= 0) {
      return 'agency_id must be a positive integer';
    }
    fields.agency_id = n;
  }
  // Coordinates must be real JSON numbers (never strings) inside
  // their geographic ranges — same strictness as the booleans above,
  // so a client bug cannot store a text "latitude".
  for (const [key, max] of [['latitude', 90], ['longitude', 180]]) {
    if (
      fields[key] !== undefined &&
      fields[key] !== null &&
      (typeof fields[key] !== 'number' ||
        !Number.isFinite(fields[key]) ||
        fields[key] < -max ||
        fields[key] > max)
    ) {
      return `${key} must be a number between ${-max} and ${max}`;
    }
  }
  for (const [key, value] of Object.entries(fields)) {
    if (
      key !== 'flags' &&
      !BOOLEAN_FIELDS.includes(key) &&
      key !== 'pharmacy_id' &&
      key !== 'agency_id' &&
      key !== 'latitude' &&
      key !== 'longitude' &&
      value !== null &&
      typeof value !== 'string'
    ) {
      return `${key} must be a string`;
    }
  }
  return null;
}

// Agency tag housekeeping, applied on create/update after
// validation — keeps the stored invariant "never both":
// when agency_id is set it WINS and the free-text fallback is
// stored NULL; when a non-blank free-text name is set without
// an id, any directory link is cleared; a blank free-text
// name means "no agency text" and is stored NULL.
function normalizeAgencyFields(fields) {
  if (fields.agency_id !== undefined && fields.agency_id !== null) {
    fields.agency_name_text = null;
  } else if (typeof fields.agency_name_text === 'string') {
    fields.agency_name_text = fields.agency_name_text.trim() || null;
    if (fields.agency_name_text !== null && fields.agency_id === undefined) {
      fields.agency_id = null;
    }
  }
}

// Reference check (mirrors the appointments route): a non-null
// agency_id must name an existing agencies row.
async function agencyExists(agencyId) {
  const r = await pool.query('SELECT 1 FROM agencies WHERE id = $1', [agencyId]);
  return r.rows.length > 0;
}

// Read decoration: rows fetched with the agency LEFT JOIN
// (aliases _ag_name/_ag_dba/_ag_short) get a resolved
// agency_name — the linked agency's display_name, else the
// free-text fallback, else null — and the join columns are
// stripped so responses stay clean patient rows.
function shapePatientRow(row) {
  if (!row) return row;
  const { _ag_name, _ag_dba, _ag_short, ...rest } = row;
  let agency_name = null;
  if (rest.agency_id !== null && rest.agency_id !== undefined && _ag_name) {
    agency_name = computeDisplayName({
      name: _ag_name,
      dba: _ag_dba,
      short_name: _ag_short,
    });
  } else if (rest.agency_name_text) {
    agency_name = rest.agency_name_text;
  }
  return { ...rest, agency_name };
}

const AGENCY_JOIN =
  'LEFT JOIN agencies ag ON ag.id = p.agency_id';
const AGENCY_COLS =
  'ag.name AS _ag_name, ag.dba AS _ag_dba, ag.short_name AS _ag_short';

// Single-row decoration for write responses (INSERT/UPDATE
// RETURNING rows carry no join): resolve agency_name with one
// extra lookup only when the patient is directory-linked.
async function decoratePatient(row) {
  if (!row) return row;
  if (row.agency_id === null || row.agency_id === undefined) {
    return { ...row, agency_name: row.agency_name_text || null };
  }
  const r = await pool.query(
    'SELECT name, dba, short_name FROM agencies WHERE id = $1',
    [row.agency_id],
  );
  return {
    ...row,
    agency_name: r.rows.length ? computeDisplayName(r.rows[0]) : null,
  };
}

const ACTIVE = 'deleted_at IS NULL';

// Run fn(client) inside one transaction: BEGIN, COMMIT on success,
// ROLLBACK + rethrow on failure. The client is always released.
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

// Append one audit row. Must be called with the transaction's client,
// never the pool, so the entry lands atomically with its change.
// `before`/`after` are full row snapshots (null where there is none:
// create has no before, soft_delete's after carries deleted_at set).
// v2 snapshots include the new columns (including ss and
// drivers_license — see the redaction warning in the header).
async function writeAudit(client, { patientId, actor, action, before, after }) {
  await client.query(
    `INSERT INTO audit_log (patient_id, actor_uid, actor_email, action, changed)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      patientId,
      actor.uid,
      actor.email,
      action,
      JSON.stringify({ before, after }),
    ],
  );
}

// GET /patients — list, newest first. Filters:
//   ?zone=green|yellow|red  (exact match)
//   ?status=active|hold|discharged  (exact match)
//   ?q=text                (partial match on fname, lname,
//                           preferred_name, or email)
//   ?limit=50 (max 200), ?offset=0
router.get('/', async (req, res, next) => {
  try {
    const conditions = [ACTIVE];
    const params = [];
    if (req.query.zone !== undefined) {
      if (!ZONES.includes(req.query.zone)) {
        return res
          .status(400)
          .json({ error: `zone must be one of: ${ZONES.join(', ')}` });
      }
      params.push(req.query.zone);
      conditions.push(`zone = $${params.length}`);
    }
    if (req.query.status !== undefined) {
      if (!STATUSES.includes(req.query.status)) {
        return res
          .status(400)
          .json({ error: `status must be one of: ${STATUSES.join(', ')}` });
      }
      params.push(req.query.status);
      conditions.push(`status = $${params.length}`);
    }
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      const p = params.length;
      conditions.push(
        `(fname ILIKE $${p} OR lname ILIKE $${p} OR preferred_name ILIKE $${p} OR email ILIKE $${p})`,
      );
    }
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 50, 1),
      200,
    );
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const result = await pool.query(
      `SELECT p.*, ${AGENCY_COLS} FROM patients p ${AGENCY_JOIN} WHERE ${conditions.join(' AND ')} ORDER BY p.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    res.json(result.rows.map(shapePatientRow));
  } catch (err) {
    next(err);
  }
});

// GET /patients/:id — a record view, so a successful read also writes
// a patient_view event. Best-effort: a failed log write must never
// fail the read itself. (The request logger separately records this
// call as an api_request; the two rows answer different questions —
// "was the API called" versus "was this record viewed".)
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT p.*, ${AGENCY_COLS} FROM patients p ${AGENCY_JOIN} WHERE p.id = $1 AND ${ACTIVE}`,
      [req.params.id],
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'patient not found' });
    }
    insertEvent(pool, {
      actor: req.user,
      event: 'patient_view',
      patientId: result.rows[0].id,
      details: {},
      ip: req.ip || null,
    }).catch(() => {
      // View logging must never fail a read.
    });
    res.json(shapePatientRow(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

// GET /patients/:id/audit — that patient's audit trail, newest first.
// Works for soft-deleted patients too: the trail must survive deletion.
// 404 only when no patient with that id exists at all.
router.get('/:id/audit', async (req, res, next) => {
  try {
    const patient = await pool.query(
      'SELECT id FROM patients WHERE id = $1',
      [req.params.id],
    );
    if (!patient.rows[0]) {
      return res.status(404).json({ error: 'patient not found' });
    }
    const result = await pool.query(
      `SELECT id, patient_id, actor_uid, actor_email, action, changed, created_at
       FROM audit_log WHERE patient_id = $1 ORDER BY created_at DESC`,
      [req.params.id],
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});
// POST /patients — create. fname + lname are required. Audit: create
// entry, before null, after the inserted row.
router.post('/', async (req, res, next) => {
  try {
    const fields = pickWritable(req.body);
    if (!fields.fname || !fields.fname.trim()) {
      return res.status(400).json({ error: 'fname is required' });
    }
    if (!fields.lname || !fields.lname.trim()) {
      return res.status(400).json({ error: 'lname is required' });
    }
    // Date of birth and sex are REQUIRED on create (Jake,
    // 2026-10-30). Create-only scope: PUT/edit is unchanged,
    // so records that predate the rule can still be edited.
    // A deliberately chosen sex value — including "Unknown" —
    // counts as provided.
    if (!fields.date_of_birth
        || (typeof fields.date_of_birth === 'string'
            && !fields.date_of_birth.trim())) {
      return res.status(400).json({
        error: 'date_of_birth is required',
        code: 'DOB_REQUIRED',
      });
    }
    if (!fields.sex
        || (typeof fields.sex === 'string' && !fields.sex.trim())) {
      return res.status(400).json({
        error: 'sex is required',
        code: 'SEX_REQUIRED',
      });
    }
    const error = validatePatient(fields);
    if (error) return res.status(400).json({ error });
    normalizeAgencyFields(fields);
    if (fields.agency_id !== undefined && fields.agency_id !== null
        && !(await agencyExists(fields.agency_id))) {
      return res.status(400).json({
        error: 'agency_id does not match an existing agency',
        code: 'AGENCY_NOT_FOUND',
      });
    }
    const keys = Object.keys(fields);
    const columns = keys.join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const created = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO patients (${columns}) VALUES (${placeholders}) RETURNING *`,
        Object.values(fields),
      );
      const row = result.rows[0];
      await writeAudit(client, {
        patientId: row.id,
        actor: req.user,
        action: 'create',
        before: null,
        after: row,
      });
      return row;
    });
    res.status(201).json(await decoratePatient(created));
  } catch (err) {
    next(err);
  }
});

// PUT /patients/:id — update only the whitelisted fields provided.
// Audit: update entry, before the pre-update row, after the new row.
router.put('/:id', requireManagerPin, async (req, res, next) => {
  try {
    const fields = pickWritable(req.body);
    const error = validatePatient(fields);
    if (error) return res.status(400).json({ error });
    normalizeAgencyFields(fields);
    if (fields.agency_id !== undefined && fields.agency_id !== null
        && !(await agencyExists(fields.agency_id))) {
      return res.status(400).json({
        error: 'agency_id does not match an existing agency',
        code: 'AGENCY_NOT_FOUND',
      });
    }
    const keys = Object.keys(fields);
    if (keys.length === 0) {
      return res.status(400).json({ error: 'no updatable fields provided' });
    }
    const setClause = keys.map((key, i) => `${key} = $${i + 1}`).join(', ');
    const updated = await withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT * FROM patients WHERE id = $1 AND ${ACTIVE}`,
        [req.params.id],
      );
      if (!existing.rows[0]) return null;
      const result = await client.query(
        `UPDATE patients SET ${setClause} WHERE id = $${keys.length + 1} RETURNING *`,
        [...Object.values(fields), req.params.id],
      );
      const row = result.rows[0];
      await writeAudit(client, {
        patientId: row.id,
        actor: req.user,
        action: 'update',
        before: existing.rows[0],
        after: row,
      });
      await insertEvent(client, {
        actor: req.user,
        event: 'admin_action',
        patientId: row.id,
        details: {
          action: 'patient_update',
          manager_user_id: req.manager.id,
          manager_email: req.manager.email,
          manager_role: req.manager.role,
        },
        ip: req.ip,
      });
      return row;
    });
    if (!updated) {
      return res.status(404).json({ error: 'patient not found' });
    }
    res.json(await decoratePatient(updated));
  } catch (err) {
    next(err);
  }
});

// DELETE /patients/:id — soft delete: sets deleted_at, keeps the row.
// Audit: soft_delete entry, before the active row, after the row with
// deleted_at set. Deleting an already-deleted patient is a 404: the
// reads treat it as gone, and so does the delete.
router.delete('/:id', requireManagerPin, async (req, res, next) => {
  try {
    const deleted = await withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT * FROM patients WHERE id = $1 AND ${ACTIVE}`,
        [req.params.id],
      );
      if (!existing.rows[0]) return null;
      const result = await client.query(
        'UPDATE patients SET deleted_at = now() WHERE id = $1 RETURNING *',
        [req.params.id],
      );
      const row = result.rows[0];
      await writeAudit(client, {
        patientId: row.id,
        actor: req.user,
        action: 'soft_delete',
        before: existing.rows[0],
        after: row,
      });
      await insertEvent(client, {
        actor: req.user,
        event: 'admin_action',
        patientId: row.id,
        details: {
          action: 'patient_delete',
          manager_user_id: req.manager.id,
          manager_email: req.manager.email,
          manager_role: req.manager.role,
        },
        ip: req.ip,
      });
      return row;
    });
    if (!deleted) {
      return res.status(404).json({ error: 'patient not found' });
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /patients/:id/restore — undo a soft delete: clears deleted_at.
// 404 when no patient with that id exists; 409 when the patient is
// already active (there is nothing to restore).
router.post('/:id/restore', requireManagerPin, async (req, res, next) => {
  try {
    const restored = await withTransaction(async (client) => {
      const existing = await client.query(
        'SELECT * FROM patients WHERE id = $1',
        [req.params.id],
      );
      if (!existing.rows[0]) return { status: 404 };
      if (!existing.rows[0].deleted_at) return { status: 409 };
      const result = await client.query(
        'UPDATE patients SET deleted_at = NULL WHERE id = $1 RETURNING *',
        [req.params.id],
      );
      const row = result.rows[0];
      await writeAudit(client, {
        patientId: row.id,
        actor: req.user,
        action: 'restore',
        before: existing.rows[0],
        after: row,
      });
      await insertEvent(client, {
        actor: req.user,
        event: 'admin_action',
        patientId: row.id,
        details: {
          action: 'patient_restore',
          manager_user_id: req.manager.id,
          manager_email: req.manager.email,
          manager_role: req.manager.role,
        },
        ip: req.ip,
      });
      return { status: 200, row };
    });
    if (restored.status === 404) {
      return res.status(404).json({ error: 'patient not found' });
    }
    if (restored.status === 409) {
      return res.status(409).json({ error: 'patient is not deleted' });
    }
    res.json(restored.row);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
