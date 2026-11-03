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
const { createHash } = require('node:crypto');
const pool = require('../db');
const { insertEvent } = require('../lib/eventLog');
const { requireRole, attachManager } = require('../lib/requireRole');
const requireManagerRole = requireRole('manager', 'admin');
const { computeDisplayName } = require('./agencies');
const {
  resolveStaff,
  isPlatformAdmin,
  hasChartAccess,
  normName,
  levenshtein,
} = require('../lib/platform');

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
  // Age in years (schema-patients-age.sql) — the fallback for
  // patients whose date of birth is unknown. Integer or null.
  // Display prefers an age derived from date_of_birth; this
  // column is only consulted when date_of_birth is NULL.
  'age',
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
  // An empty string means "no birth date" (HTML date inputs
  // submit ''), not a malformed date — normalize it to NULL
  // before the format check.
  if (typeof fields.date_of_birth === 'string'
      && !fields.date_of_birth.trim()) {
    fields.date_of_birth = null;
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
  if (
    fields.age !== undefined &&
    fields.age !== null &&
    (!Number.isInteger(fields.age) || fields.age < 0 || fields.age > 130)
  ) {
    return 'age must be an integer between 0 and 130';
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
      key !== 'age' &&
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

// GET /patients — list, newest first. PLATFORM SCOPING (2026-11-03):
// the default list is the CALLER'S OWN list — registry patients they
// are linked to (patient_links) — and the `status` each row carries
// is the caller's per-link list_status, not the registry column.
// Platform admins may pass ?all=1 for the full registry view.
// Filters:
//   ?zone=green|yellow|red  (exact match)
//   ?status=active|hold|discharged  (link status; registry status
//                           under ?all=1)
//   ?q=text                (partial match on fname, lname,
//                           preferred_name, or email)
//   ?limit=50 (max 200), ?offset=0
router.get('/', async (req, res, next) => {
  try {
    const staff = await resolveStaff(req);
    if (!staff) {
      return res.status(403).json({
        error: 'no active staff record for this account',
        code: 'NO_STAFF_RECORD',
      });
    }
    const all = req.query.all === '1';
    if (all && !isPlatformAdmin(staff)) {
      return res.status(403).json({
        error: 'the registry view is for platform admins',
        code: 'ADMIN_REQUIRED',
      });
    }
    const conditions = ['p.deleted_at IS NULL'];
    const params = [];
    let from = `patients p ${AGENCY_JOIN}`;
    if (!all) {
      params.push(staff.id);
      from += ` JOIN patient_links l ON l.patient_id = p.id
                AND l.user_id = $${params.length} AND l.removed_at IS NULL`;
    }
    if (req.query.zone !== undefined) {
      if (!ZONES.includes(req.query.zone)) {
        return res
          .status(400)
          .json({ error: `zone must be one of: ${ZONES.join(', ')}` });
      }
      params.push(req.query.zone);
      conditions.push(`p.zone = $${params.length}`);
    }
    if (req.query.status !== undefined) {
      if (!STATUSES.includes(req.query.status)) {
        return res
          .status(400)
          .json({ error: `status must be one of: ${STATUSES.join(', ')}` });
      }
      params.push(req.query.status);
      conditions.push(
        `${all ? 'p.status' : 'l.list_status'} = $${params.length}`,
      );
    }
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      const p = params.length;
      conditions.push(
        `(p.fname ILIKE $${p} OR p.lname ILIKE $${p} OR p.preferred_name ILIKE $${p} OR p.email ILIKE $${p})`,
      );
    }
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 50, 1),
      200,
    );
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const result = await pool.query(
      `SELECT p.*, ${all ? 'NULL' : 'l.list_status'} AS _link_status, ${AGENCY_COLS} FROM ${from} WHERE ${conditions.join(' AND ')} ORDER BY p.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    res.json(
      result.rows.map((row) => {
        const shaped = shapePatientRow(row);
        if (shaped._link_status) shaped.status = shaped._link_status;
        delete shaped._link_status;
        return shaped;
      }),
    );
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
    // Chart access (platform spec §3): linked, episode team, or
    // platform admin — otherwise the same 404 as a missing patient,
    // so the registry cannot be enumerated by guessing ids.
    const staff = await resolveStaff(req);
    if (!(await hasChartAccess(staff, result.rows[0].id))) {
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
    const auditStaff = await resolveStaff(req);
    if (!(await hasChartAccess(auditStaff, req.params.id))) {
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
// ------------------------------------------------------------------
// Platform duplicate rules (spec §4). The registry holds ONE record
// per real person. Exact identity (same normalized name + same DOB;
// or, when a DOB is missing on either side, same name + same phone
// or email) is a HARD BLOCK — stricter than OpenEMR's
// warn-and-confirm, Jake's call. Near matches (same DOB + similar
// name, same phone/email under a different name, or the same name
// with a different/missing DOB) get a POSSIBLE_MATCH prompt the
// caller can override with confirm_create: true.
function dobStr(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function phoneKey(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-10) : '';
}

function intakeFingerprint(fields) {
  const raw = `${normName(fields.fname)}|${normName(fields.lname)}|${dobStr(fields.date_of_birth) || ''}`;
  return createHash('sha1').update(raw).digest('hex');
}

async function findDuplicates(fields) {
  const fn = normName(fields.fname);
  const ln = normName(fields.lname);
  const dob = dobStr(fields.date_of_birth);
  const fingerprint = intakeFingerprint(fields);
  const phones = [phoneKey(fields.phone_cell), phoneKey(fields.phone_home)].filter(Boolean);
  const email = (fields.email || '').trim().toLowerCase();
  const { rows } = await pool.query(
    `SELECT id, fname, lname, date_of_birth, city, phone_home, phone_cell, email
       FROM patients
      WHERE deleted_at IS NULL AND (
        lower(btrim(lname)) = $1
        OR ($2::date IS NOT NULL AND date_of_birth = $2)
        OR ($3 <> '' AND lower(email) = $3)
        OR ($4 <> '' AND phone_cell = $4)
        OR ($5 <> '' AND phone_home = $5)
      ) LIMIT 50`,
    [ln, dob, email, fields.phone_cell || '', fields.phone_home || ''],
  );
  let exact = null;
  const near = [];
  for (const row of rows) {
    const rFn = normName(row.fname);
    const rLn = normName(row.lname);
    const namesEqual = rFn === fn && rLn === ln;
    const rDob = dobStr(row.date_of_birth);
    const dobEqual = !!(dob && rDob && dob === rDob);
    const phoneMatch =
      phones.length > 0 &&
      [phoneKey(row.phone_cell), phoneKey(row.phone_home)].some(
        (k) => k && phones.includes(k),
      );
    const emailMatch =
      !!email && (row.email || '').trim().toLowerCase() === email;
    let kind = null;
    if (namesEqual && dobEqual) kind = 'exact';
    else if (namesEqual && (!dob || !rDob) && (phoneMatch || emailMatch)) kind = 'exact';
    else if (dobEqual && levenshtein(rLn, ln) <= 2 && levenshtein(rFn, fn) <= 2) kind = 'near';
    else if (phoneMatch || emailMatch) kind = 'near';
    else if (namesEqual) kind = 'near';
    if (kind === 'exact' && !exact) {
      exact = { id: row.id, name: `${row.fname} ${row.lname}`, dob: rDob, city: row.city || null };
    } else if (kind === 'near' && near.length < 3) {
      near.push({ id: row.id, name: `${row.fname} ${row.lname}`, dob: rDob, city: row.city || null });
    }
  }
  // Known Non-Duplicates (Epic's KND, adapted): pairs a reviewer
  // already cleared for this exact intake fingerprint never prompt
  // again. Exact matches are NEVER suppressed — only near prompts.
  if (near.length) {
    const dismissed = await pool.query(
      `SELECT patient_id FROM patient_duplicate_dismissals
        WHERE fingerprint = $1 AND patient_id = ANY($2::uuid[])`,
      [fingerprint, near.map((c) => c.id)],
    );
    const dismissedIds = new Set(dismissed.rows.map((r) => r.patient_id));
    for (let i = near.length - 1; i >= 0; i--) {
      if (dismissedIds.has(near[i].id)) near.splice(i, 1);
    }
  }
  return { exact, near, fingerprint };
}

// POST /patients — create. fname + lname are required. Audit: create
// entry, before null, after the inserted row. Platform: the create
// runs the duplicate rules first, and a successful create auto-links
// the patient to the creator's list (patient_links).
router.post('/', async (req, res, next) => {
  try {
    const staff = await resolveStaff(req);
    if (!staff) {
      return res.status(403).json({
        error: 'no active staff record for this account',
        code: 'NO_STAFF_RECORD',
      });
    }
    const fields = pickWritable(req.body);
    if (!fields.fname || !fields.fname.trim()) {
      return res.status(400).json({ error: 'fname is required' });
    }
    if (!fields.lname || !fields.lname.trim()) {
      return res.status(400).json({ error: 'lname is required' });
    }
    // Date of birth and sex were required on create from
    // 2026-10-30 to 2026-11-01 (400 DOB_REQUIRED / SEX_REQUIRED).
    // Jake reversed that on 2026-11-01: both are OPTIONAL now —
    // the new `age` column covers patients whose birth date is
    // unknown, and the CSV import no longer blocks rows that
    // lack a birthday or a gender. Format validation above
    // still applies whenever a value IS provided.
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
    const dup = await findDuplicates(fields);
    if (dup.exact) {
      const linked = await pool.query(
        `SELECT 1 FROM patient_links
          WHERE user_id = $1 AND patient_id = $2 AND removed_at IS NULL`,
        [staff.id, dup.exact.id],
      );
      return res.status(409).json({
        error: 'this patient is already in the database',
        code: 'PATIENT_EXISTS',
        patient: { ...dup.exact, already_linked: linked.rows.length > 0 },
      });
    }
    if (dup.near.length && req.body.confirm_create !== true) {
      return res.status(409).json({
        error: 'possible duplicate — review before creating',
        code: 'POSSIBLE_MATCH',
        candidates: dup.near,
      });
    }
    const linkStatus = STATUSES.includes(fields.status) ? fields.status : 'active';
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
      await client.query(
        `INSERT INTO patient_links (user_id, patient_id, list_status)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, patient_id) DO UPDATE
           SET removed_at = NULL, list_status = EXCLUDED.list_status,
               updated_at = now()`,
        [staff.id, row.id, linkStatus],
      );
      return row;
    });
    if (req.body.confirm_create === true && dup.near.length) {
      insertEvent(pool, {
        actor: req.user,
        event: 'admin_action',
        patientId: created.id,
        details: {
          action: 'patient_create_duplicate_confirmed',
          candidate_ids: dup.near.map((c) => c.id),
        },
        ip: req.ip || null,
      }).catch(() => {});
      // Remember the clearance (Known Non-Duplicate): this intake
      // fingerprint vs. each reviewed candidate never prompts again.
      for (const c of dup.near) {
        pool
          .query(
            `INSERT INTO patient_duplicate_dismissals (patient_id, fingerprint, dismissed_by)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [c.id, dup.fingerprint, staff.id],
          )
          .catch(() => {});
      }
    }
    const shaped = await decoratePatient(created);
    shaped.status = linkStatus;
    res.status(201).json(shaped);
  } catch (err) {
    next(err);
  }
});

// PUT /patients/:id — update only the whitelisted fields provided.
// Audit: update entry, before the pre-update row, after the new row.
// Platform: the caller needs chart access (404 otherwise, when the
// patient exists). A `status` in the body also syncs the caller's
// per-link list status — list status is per-user now (spec §2).
router.put('/:id', attachManager, async (req, res, next) => {
  try {
    const staff = await resolveStaff(req);
    if (!(await hasChartAccess(staff, req.params.id))) {
      const exists = await pool.query(
        `SELECT 1 FROM patients WHERE id = $1 AND ${ACTIVE}`,
        [req.params.id],
      );
      if (exists.rows.length) {
        return res.status(404).json({ error: 'patient not found' });
      }
    }
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
      if (fields.status !== undefined && staff) {
        await client.query(
          `UPDATE patient_links SET list_status = $3, updated_at = now()
            WHERE user_id = $1 AND patient_id = $2 AND removed_at IS NULL`,
          [staff.id, row.id, fields.status],
        );
      }
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
router.delete('/:id', requireManagerRole, async (req, res, next) => {
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
router.post('/:id/restore', requireManagerRole, async (req, res, next) => {
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

// ------------------------------------------------------------------
// List links (platform spec §4): "my list" membership is the
// caller's own act — add, remove, and per-link status. The registry
// patient is never touched by these routes.
// ------------------------------------------------------------------

// POST /patients/:id/link — add to my list (idempotent; revives a
// removed link, resetting its status to active).
router.post('/:id/link', async (req, res, next) => {
  try {
    const staff = await resolveStaff(req);
    if (!staff) {
      return res.status(403).json({
        error: 'no active staff record for this account',
        code: 'NO_STAFF_RECORD',
      });
    }
    const patient = await pool.query(
      `SELECT id FROM patients WHERE id = $1 AND ${ACTIVE}`,
      [req.params.id],
    );
    if (!patient.rows[0]) {
      return res.status(404).json({ error: 'patient not found' });
    }
    const r = await pool.query(
      `INSERT INTO patient_links (user_id, patient_id, list_status)
       VALUES ($1, $2, 'active')
       ON CONFLICT (user_id, patient_id) DO UPDATE
         SET list_status = CASE WHEN patient_links.removed_at IS NOT NULL
                                THEN 'active' ELSE patient_links.list_status END,
             removed_at = NULL, updated_at = now()
       RETURNING list_status`,
      [staff.id, req.params.id],
    );
    insertEvent(pool, {
      actor: req.user,
      event: 'patient_link',
      patientId: req.params.id,
      details: {},
      ip: req.ip || null,
    }).catch(() => {});
    res.json({ linked: true, patient_id: req.params.id, list_status: r.rows[0].list_status });
  } catch (err) {
    next(err);
  }
});

// DELETE /patients/:id/link — remove from my list. History (my
// appointments, documents) stays; the patient just leaves my list.
router.delete('/:id/link', async (req, res, next) => {
  try {
    const staff = await resolveStaff(req);
    if (!staff) {
      return res.status(403).json({
        error: 'no active staff record for this account',
        code: 'NO_STAFF_RECORD',
      });
    }
    const r = await pool.query(
      `UPDATE patient_links SET removed_at = now(), updated_at = now()
        WHERE user_id = $1 AND patient_id = $2 AND removed_at IS NULL
        RETURNING 1`,
      [staff.id, req.params.id],
    );
    if (!r.rows.length) {
      return res.status(404).json({
        error: 'patient is not on your list',
        code: 'NOT_LINKED',
      });
    }
    insertEvent(pool, {
      actor: req.user,
      event: 'patient_unlink',
      patientId: req.params.id,
      details: {},
      ip: req.ip || null,
    }).catch(() => {});
    res.json({ linked: false, patient_id: req.params.id });
  } catch (err) {
    next(err);
  }
});

// PUT /patients/:id/link — set my per-link list status.
router.put('/:id/link', async (req, res, next) => {
  try {
    const staff = await resolveStaff(req);
    if (!staff) {
      return res.status(403).json({
        error: 'no active staff record for this account',
        code: 'NO_STAFF_RECORD',
      });
    }
    const status = req.body?.list_status;
    if (!STATUSES.includes(status)) {
      return res.status(400).json({
        error: `list_status must be one of: ${STATUSES.join(', ')}`,
      });
    }
    const r = await pool.query(
      `UPDATE patient_links SET list_status = $3, updated_at = now()
        WHERE user_id = $1 AND patient_id = $2 AND removed_at IS NULL
        RETURNING list_status`,
      [staff.id, req.params.id, status],
    );
    if (!r.rows.length) {
      return res.status(404).json({
        error: 'patient is not on your list',
        code: 'NOT_LINKED',
      });
    }
    res.json({ linked: true, patient_id: req.params.id, list_status: r.rows[0].list_status });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
