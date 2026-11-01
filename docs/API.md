# Patient API — Developer Guide

Last updated: 2026-10-30
Live: https://api.marcinnotech.net
Source: `~/workspace/marc-innotech/patient-api/`
Full reference: that folder's `README.md` (prerequisites, migration
order, per-endpoint details). This doc is the working summary.

## Stack & layout

Node 20 + Express, PostgreSQL 16, no ORM (hand-written SQL).
Runs as a systemd service (`patient-api`) bound to 127.0.0.1:3001
behind Caddy on the VM. Config from `~/patient-api/.env` on the VM
(mode 600): DB credentials, `ALLOWED_EMAILS`,
`DASHBOARD_ORIGIN` (CORS), `PORT`, `FIREBASE_PROJECT_ID`.

```
server.js            app wiring, CORS (incl. X-Manager-Pin header)
auth.js              Firebase ID-token verification + allowlist
db.js                pg pool
routes/patients.js   patient CRUD + soft delete/restore + audit fetch
routes/users.js      staff directory + PIN-gated staff writes
routes/events.js     event query + chain verify + client event intake
lib/pin.js           scrypt PIN hashing/verification
lib/requireManagerPin.js  X-Manager-Pin middleware
lib/hashChain.js     canonical hash form for audit/event rows
lib/eventLog.js      event insert helpers
lib/requestLog.js    request → event_log folding (method/path/status only)
schema.sql           patients + audit_log (base)
schema-events.sql    event_log + hash-chain columns/triggers
schema-patients-v2.sql  patients v2 migration (DESTRUCTIVE — demo only)
schema-patients-map.sql  patients latitude/longitude (idempotent)
schema-users.sql     users table
seed.js              8 fictional patients
seed-users.js        5 fictional/demo staff (resets demo PINs to 1234)
scripts/verify-chain.js  standalone chain verification
e2e-*.js             four end-to-end suites (see DEVELOPMENT.md)
```

## Endpoint map

Auth: all routes except `/health` require a Firebase ID token from
an `ALLOWED_EMAILS` account.

| Route | Notes |
|---|---|
| `GET /health` | open; liveness |
| `GET /patients?q=&status=` | q matches fname/lname/preferred_name/email (ILIKE) |
| `POST /patients` | create (NOT PIN-gated — intake is a front-desk act). Requires only `fname` + `lname`. `date_of_birth` and `sex` are OPTIONAL (Jake, 2026-11-01 — they were required 2026-10-30 → 2026-11-01 with 400 `DOB_REQUIRED` / `SEX_REQUIRED`; those codes are retired). An empty-string `date_of_birth` normalizes to NULL; a provided one must still be YYYY-MM-DD. Accepts the stored-age fallback `age` (integer 0–130, else 400) for patients whose birth date is unknown. |

Patient agency fields (built locally 2026-10-30, not yet
deployed): create/update accept `agency_id` (integer; must
name an existing agencies row → else 400 `AGENCY_NOT_FOUND`)
and `agency_name_text` (free-text fallback). Never both: when
`agency_id` is set, `agency_name_text` is stored NULL; when a
non-blank text is set without an id, any link is cleared.
Every patient read (list, get, create/update responses)
carries `agency_id`, `agency_name_text`, and the resolved
read-only `agency_name` (the linked agency's display_name,
else the free text, else null). Agency changes ride the
normal PIN-gated update, so the audit_log snapshots preserve
the patient's agency history.
| `GET /patients/:id` | logs a `patient_view` event |
| `PUT /patients/:id` | **PIN-gated** |
| `DELETE /patients/:id` | **PIN-gated**; soft delete (deleted_at) |
| `POST /patients/:id/restore` | **PIN-gated** |
| `GET /patients/:id/audit` | audit_log rows for the patient |
| `GET /users` | staff list — safe columns only, `pin_hash` is NEVER returned (`has_pin` boolean instead) |
| `GET /users/me` | caller's staff row or null |
| `GET /users/clinicians` | authorized AND active staff (the assignable providers) |
| `POST /users/verify-pin` | `{ok, manager:{…}}` or 403 — how the dashboard checks a PIN |
| `POST /users` | **PIN-gated** create; 409 `EMAIL_EXISTS` on duplicate |
| `PUT /users/:id` | **PIN-gated**; may set that member's PIN (plaintext in, scrypt hash stored, never echoed) |
| `DELETE /users/:id` | **PIN-gated** DEACTIVATE (active=false — rows are never hard-deleted); 400 `SELF_DEACTIVATE` for your own account |
| `POST /users/:id/restore` | **PIN-gated** reactivate |
| `GET /events` | filters: event, actor_email, patient_id, from, to; limit ≤ 200 |
| `GET /events/verify` | recompute both hash chains |
| `POST /events` | client-reported events only: sign_in, sign_out, report_export |
| `GET /appointments/categories` | active categories (OpenEMR-correlated: color + default duration + cattype); `?all=1` includes inactive |
| `POST /appointments/categories` | **PIN-gated** create category (Settings screen) |
| `PUT /appointments/categories/:id` | **PIN-gated** update (name/color/kind/default minutes/description/active) |
| `DELETE /appointments/categories/:id` | **PIN-gated** deactivate (active=false; never a hard delete) |
| `POST /appointments/categories/:id/restore` | **PIN-gated** reactivate |
| `GET /messages` | my inbox (newest first); `?sent=1` outbox, `?unread=1` unread only; caller must resolve to an active users row (403 `NO_STAFF_RECORD`) |
| `GET /messages/patient/:uuid` | a patient's chart messages (care-team readable) |
| `GET /messages/threads/:id` | one conversation (participants, or any staff when patient-linked) |
| `POST /messages` | send (NOT PIN-gated); recipient and/or patient required |
| `POST /messages/:id/read` | mark read (recipient only; idempotent) |
| `DELETE /messages/:id` | soft delete (sender only) |
| `GET /documents?patient_id=` | a patient's clinical documents, newest first (deleted excluded); caller must resolve to an active users row (403 `NO_STAFF_RECORD`) |
| `GET /documents/:id` | one document (404 when missing/soft-deleted) |
| `POST /documents` | create draft (NOT PIN-gated); author = resolved staff user; `doc_type` ∈ evaluation/reassessment/discharge; optional `appointment_id` must belong to the patient |
| `PUT /documents/:id` | edit a DRAFT (title/sections/appointment link); finalized documents are locked → 409 `DOCUMENT_FINALIZED` |
| `POST /documents/:id/finalize` | finalize (sets status/finalized_at/finalized_by; re-finalize → 409 `DOCUMENT_FINALIZED`) |
| `DELETE /documents/:id` | **PIN-gated** soft delete |
| `POST /documents/:id/restore` | **PIN-gated** undo soft delete (409 `NOT_DELETED` when not deleted) |
| `GET /appointments/statuses` | status list in flow order, with is_checkin/is_checkout flags |
| `GET /appointments?from=&to=&patient_id=&provider_id=` | overlap-window list, joined with patient/provider/category names |
| `POST /appointments` | create (NOT PIN-gated — booking is a front-desk act) |
| `PUT /appointments/:id` | **PIN-gated** update |
| `POST /appointments/:id/status` | status-only change (NOT gated — flow-board pattern); logged with from/to |
| `DELETE /appointments/:id` | **PIN-gated**; soft delete |
| `POST /appointments/:id/restore` | **PIN-gated** |
| `GET /agencies?q=&active=&service=&min_rating=&limit=&offset=` | IDPH directory (live 2026-10-30); q matches name/dba/short_name/city/license_number; rows carry a computed `display_name` plus the CMS columns (ccn, offers_*, star_rating, cms_ownership, cms_cert_date, cms_matched_at). `service` = comma list of nursing,pt,ot,speech,msw,hha — agency must offer ALL (unknown value → 400); `min_rating` = number 0–5, star_rating >= value, unrated excluded (CMS filters built locally 2026-10-30, not yet deployed) |
| `GET /agencies/primary` | the `is_primary` ("our agency") row, or JSON null |
| `GET /agencies/sync-status` | latest `agency_sync` event as `{last_run_at, …counts}`, or null |
| `GET /agencies/:id` | one agency (404 for non-numeric/missing) |
| `POST /agencies/sync` | **PIN-gated**; runs the IDPH sync now; upstream failure → 502 `SYNC_FAILED` |
| `PUT /agencies/:id` | **PIN-gated**; LOCAL fields only (is_primary/notes/short_name); setting is_primary clears it elsewhere in the same transaction; logs `admin_action` (action `agency_update`) |

Agency sync (`lib/agencySync.js`, shared by the route, the CLI
`sync-agencies.js`, and the weekly systemd timer): fetches the
Socrata metadata first and skips when `rowsUpdatedAt` matches
the last full sync; otherwise pages the resource endpoint,
upserts on `license_number` (SOURCE fields only — is_primary /
notes / short_name are never overwritten), marks agencies
absent from the import inactive, and writes ONE `agency_sync`
event with counts only — the lib is the single logging point,
so the API route never double-logs. An empty/garbled snapshot
aborts the run instead of deactivating the directory. After
the IDPH pass the same run does a **CMS enrichment pass**
(built locally 2026-10-30): fetch the Illinois subset of the
CMS "Home Health Care Agencies" dataset (data.cms.gov
datastore query API; a browser user-agent header is required
— the host 403s non-browser UAs) and attach CCN, service
lines and the star rating to matched agencies (phone+ZIP,
then normalized name+ZIP against full name and DBA;
unambiguous single-candidate matches only). The pass runs on
every sync — including IDPH-skip runs — and a CMS failure
aborts only this pass, recorded as `cms_error` in the event
details alongside `cms_rows` / `cms_matched` /
`cms_unmatched` counts.

## The manager-PIN gate (lib/requireManagerPin.js)

- Header `X-Manager-Pin`; missing → 403 `PIN_REQUIRED`; malformed
  (not 4–8 digits) or unmatched → 403 `PIN_INVALID`.
- A PIN matches the first active manager/admin (in id order) whose
  scrypt hash verifies. The gate sets `req.manager`, and the route
  writes an `admin_action` event in the same transaction naming
  that manager and the target.
- PINs belong to people, not to the caller: any manager's PIN can
  authorize any gated write, and the audit trail attributes it to
  the PIN's owner. This is the classic override model.
- Appointment gated writes follow the same gate but log an
  `appointment_change` event (details name the manager) instead of
  `admin_action`.

## Validation rules (patients & staff)

Whitelisted fields only; required names/email enforced; zone ∈
green/yellow/red; status ∈ active/hold/discharged; strict booleans
(the string "yes" or 1 → 400); `pharmacy_id`/`facility_id` must be
integers; emails stored lowercase (DB CHECK backs this up).
Patients also accept `latitude`/`longitude` (maps build,
2026-10-30, local): real JSON numbers or null, range-checked
(lat ±90, lon ±180, DB CHECKs back this up); strings are rejected
with 400, never coerced. All patient reads return them.

Appointments: `category_id` required and must be an active
category; an `appointment`-type category requires a live patient
(400 `PATIENT_REQUIRED` / `PATIENT_NOT_FOUND`), a `provider`-type
category never carries one; `provider_id` must be a users row;
status must exist in `appointment_statuses`; `ends_at` must be
after `starts_at` (checked against the merged row on update);
BIGINT ids are accepted as integer-valued strings (Postgres returns
int8 as strings, so clients hand them back that way);
`patient_id` is a UUID (the patients PK is a UUID — unlike users).

Documents: `patient_id` required and must be a live patient
(400 `PATIENT_NOT_FOUND`); `sections` keys must belong to the
doc_type's template and values must be strings (400 `VALIDATION`);
an `appointment_id`, when given, must exist, be non-deleted, and
belong to the same patient (400 `APPOINTMENT_NOT_FOUND` /
`APPOINTMENT_PATIENT_MISMATCH`). Document events
(`document_create` / `document_update` / `document_finalize`)
carry ids and doc_type only — never title or section content.

## Known gaps (deliberate, tracked)

- `patients.clinician` is still free text ("Unassigned" default);
  the patient form is not yet wired to pick from `GET
  /users/clinicians`.
- Roles are recorded but not yet *enforced* beyond the PIN gate
  (e.g., a developer role seeing the Audit Log but not patient rows
  is future API work).
- Audit snapshots include `ss` / `drivers_license` verbatim —
  redaction is required before any real data (see ARCHITECTURE.md).
- Appointments: no recurrence yet (OpenEMR's
  pc_recurrtype/pc_recurrspec series + edit-one/future/all is a
  deliberate deferral), no facility/billing-facility fields (no
  facility table yet). Categories are editable in Settings →
  Visit categories (PIN-gated); statuses are still seeded data
  only (`seed-appointment-lists.js`), no admin UI.
- Documents: clinical documentation v1 is LIVE (deployed
  2026-10-30 in the maps + agency round). Templates are fixed in code
  (`lib/documentTemplates.js`) — there is no template-builder UI
  (OpenEMR's Layout-Based Forms editor is the future analogue),
  and documents cannot yet be attached from the calendar UI
  (the API accepts `appointment_id`; the profile panel does not
  send one yet).
