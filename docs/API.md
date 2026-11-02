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
server.js            app wiring, CORS
auth.js              Firebase ID-token verification + allowlist
db.js                pg pool
routes/patients.js   patient CRUD + soft delete/restore + audit fetch
routes/users.js      staff directory + role-gated staff writes
routes/events.js     event query + chain verify + client event intake
lib/pin.js           scrypt PIN hashing (DORMANT since 2026-11-02:
                     seed-users only — the PIN gate is retired)
lib/requireRole.js   role gates (requireRole / attachManager);
                     replaced lib/requireManagerPin.js 2026-11-02
lib/hashChain.js     canonical hash form for audit/event rows
lib/eventLog.js      event insert helpers
lib/requestLog.js    request → event_log folding (method/path/status;
                     auth_failure rows also carry details.auth — see below)
schema.sql           patients + audit_log (base)
schema-events.sql    event_log + hash-chain columns/triggers
schema-patients-v2.sql  patients v2 migration (DESTRUCTIVE — demo only)
schema-patients-map.sql  patients latitude/longitude (idempotent)
schema-users.sql     users table
seed.js              8 fictional patients
seed-users.js        5 fictional/demo staff (still sets demo PIN
                     hashes — dormant, nothing verifies them)
scripts/verify-chain.js  standalone chain verification
e2e-*.js             four end-to-end suites (see DEVELOPMENT.md)
```

## Endpoint map

Auth: all routes except `/health` require a Firebase ID token from
an `ALLOWED_EMAILS` account. Since 2026-11-02 every auth rejection
also records its reason on the `auth_failure` event
(`details.auth.reason`: `missing_or_malformed_header`,
`not_on_allowlist` — with the verified account's email — or
`token_verification_failed` with the firebase-admin error code in
`details.auth.code`). Response codes are unchanged: 401 for a
missing/invalid token, 403 only for a verified token whose email
is not allowlisted.

| Route | Notes |
|---|---|
| `GET /health` | open; liveness |
| `GET /patients?q=&status=` | q matches fname/lname/preferred_name/email (ILIKE) |
| `POST /patients` | create (NOT gated — intake is a front-desk act). Requires only `fname` + `lname`. `date_of_birth` and `sex` are OPTIONAL (Jake, 2026-11-01 — they were required 2026-10-30 → 2026-11-01 with 400 `DOB_REQUIRED` / `SEX_REQUIRED`; those codes are retired). An empty-string `date_of_birth` normalizes to NULL; a provided one must still be YYYY-MM-DD. Accepts the stored-age fallback `age` (integer 0–130, else 400) for patients whose birth date is unknown. |

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
normal patient update (ungated since 2026-11-02), so the
  audit_log snapshots preserve
the patient's agency history.
| `GET /patients/:id` | logs a `patient_view` event |
| `PUT /patients/:id` | NOT gated (any signed-in user; the caller's staff identity is attached for audit attribution) |
| `DELETE /patients/:id` | **Role-gated (manager/admin)**; soft delete (deleted_at) |
| `POST /patients/:id/restore` | **Role-gated (manager/admin)** |
| `GET /patients/:id/audit` | audit_log rows for the patient |
| `GET /users` | staff list — safe columns only, `pin_hash` is NEVER returned (`has_pin` boolean instead) |
| `GET /users/me` | caller's staff row or null |
| `GET /users/clinicians` | authorized AND active staff (the assignable providers) |
| `POST /users` | **Role-gated (manager/admin)** create; 409 `EMAIL_EXISTS` on duplicate |
| `PUT /users/:id` | **Role-gated (manager/admin)**; a `pin` field in the body is ignored (PINs retired 2026-11-02; `pin_hash` column dormant) |
| `DELETE /users/:id` | **Role-gated (manager/admin)** DEACTIVATE (active=false — rows are never hard-deleted); 400 `SELF_DEACTIVATE` for your own account |
| `POST /users/:id/restore` | **Role-gated (manager/admin)** reactivate |
| `GET /events` | filters: event, actor_email, patient_id, from, to; limit ≤ 200 |
| `GET /events/verify` | recompute both hash chains |
| `POST /events` | client-reported events only: sign_in, sign_out, report_export |
| `GET /appointments/categories` | active categories (OpenEMR-correlated: color + default duration + cattype); `?all=1` includes inactive |
| `POST /appointments/categories` | **Role-gated (manager/admin)** create category (Settings screen) |
| `PUT /appointments/categories/:id` | **Role-gated (manager/admin)** update (name/color/kind/default minutes/description/active) |
| `DELETE /appointments/categories/:id` | **Role-gated (manager/admin)** deactivate (active=false; never a hard delete) |
| `POST /appointments/categories/:id/restore` | **Role-gated (manager/admin)** reactivate |
| `GET /messages` | my inbox (newest first); `?sent=1` outbox, `?unread=1` unread only; caller must resolve to an active users row (403 `NO_STAFF_RECORD`) |
| `GET /messages/patient/:uuid` | a patient's chart messages (care-team readable) |
| `GET /messages/threads/:id` | one conversation (participants, or any staff when patient-linked) |
| `POST /messages` | send (NOT gated); recipient and/or patient required |
| `POST /messages/:id/read` | mark read (recipient only; idempotent) |
| `DELETE /messages/:id` | soft delete (sender only) |
| `GET /documents?patient_id=` | a patient's clinical documents, newest first (deleted excluded); caller must resolve to an active users row (403 `NO_STAFF_RECORD`) |
| `GET /documents/:id` | one document (404 when missing/soft-deleted) |
| `POST /documents` | create draft (NOT gated); author = resolved staff user; `doc_type` ∈ evaluation/reassessment/discharge; optional `appointment_id` must belong to the patient |
| `PUT /documents/:id` | edit a DRAFT (title/sections/appointment link); finalized documents are locked → 409 `DOCUMENT_FINALIZED` |
| `POST /documents/:id/finalize` | finalize (sets status/finalized_at/finalized_by; re-finalize → 409 `DOCUMENT_FINALIZED`) |
| `DELETE /documents/:id` | **Role-gated (manager/admin)** soft delete |
| `POST /documents/:id/restore` | **Role-gated (manager/admin)** undo soft delete (409 `NOT_DELETED` when not deleted) |
| `GET /appointments/statuses` | status list in flow order, with is_checkin/is_checkout flags |
| `GET /appointments?from=&to=&patient_id=&provider_id=` | overlap-window list, joined with patient/provider/category names |
| `POST /appointments` | create (NOT gated — booking is a front-desk act) |
| `PUT /appointments/:id` | NOT gated update (attribution recorded; enables drag-reschedule) |
| `POST /appointments/:id/status` | status-only change (NOT gated — flow-board pattern); logged with from/to |
| `DELETE /appointments/:id` | **Role-gated (manager/admin)**; soft delete |
| `POST /appointments/:id/restore` | **Role-gated (manager/admin)** |
| `GET /agencies?q=&active=&service=&min_rating=&limit=&offset=` | IDPH directory (live 2026-10-30); q matches name/dba/short_name/city/license_number; rows carry a computed `display_name` plus the CMS columns (ccn, offers_*, star_rating, cms_ownership, cms_cert_date, cms_matched_at). `service` = comma list of nursing,pt,ot,speech,msw,hha — agency must offer ALL (unknown value → 400); `min_rating` = number 0–5, star_rating >= value, unrated excluded (CMS filters built locally 2026-10-30, not yet deployed) |
| `GET /agencies/primary` | the `is_primary` ("our agency") row, or JSON null |
| `GET /agencies/sync-status` | latest `agency_sync` event as `{last_run_at, …counts}`, or null |
| `GET /agencies/:id` | one agency (404 for non-numeric/missing) |
| `POST /agencies/sync` | **Role-gated (manager/admin)**; runs the IDPH sync now; upstream failure → 502 `SYNC_FAILED` |
| `PUT /agencies/:id` | **Role-gated (manager/admin)**; LOCAL fields only (is_primary/notes/short_name); setting is_primary clears it elsewhere in the same transaction; logs `admin_action` (action `agency_update`) |

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

## Expense reports (routes/expenses.js, built locally 2026-11-01)

Jake's model: one report per clinician per period (usually a
month); mileage entries and non-mileage lines live inside it;
the report is submitted, approved, and paid AS A WHOLE.
Mounted at root in server.js (the router carries its own
prefixes). Every route requires the caller to resolve to an
active users row (403 `NO_STAFF_RECORD` otherwise).

- `GET /expense-reports` — own reports; manager/admin roles
  get everyone's (they run approval/payment). Bare array,
  newest period first, soft-deleted excluded.
- `POST /expense-reports` — create a draft (period required,
  end ≥ start else 400 `PERIOD_INVALID`; title/agency
  optional). The id is auto-generated.
- `GET /expense-reports/:id` — the report PLUS its computed
  summary: `days` (entries grouped by date with driven /
  commute / reimbursable miles), `expenses` (lines), and
  totals (`total_driven_miles`, `total_commute_miles`,
  `total_reimbursable_miles`, `mileage_amount_cents`,
  `expenses_amount_cents`, `total_amount_cents`). Non-owners
  who aren't managers get 404 (existence isn't leaked).
- `PUT /expense-reports/:id`, `DELETE /expense-reports/:id`
  (soft) — owner only, draft only (409 `REPORT_LOCKED` after
  submit).
- `POST /expense-reports/:id/mileage` ·
  `PUT|DELETE /expense-reports/:id/mileage/:entryId` —
  mileage entries. `entry_kind` business | commute;
  `business_miles` is the leg's FINAL miles (≥ 0, required);
  both routing figures (`miles_toll`, `miles_no_toll`),
  `used_tollway`, `round_trip`, and a `rate_per_mile`
  snapshot ride along.
- `POST /expense-reports/:id/expenses` ·
  `PUT|DELETE /expense-reports/:id/expenses/:expenseId` —
  non-mileage lines (category CHECK list, `amount_cents`
  integer ≥ 0).
- Lifecycle: `POST /:id/submit` (owner; draft → submitted,
  stamps submitted_at) · `POST /:id/approve` (manager role;
  records approved_by/at) · `POST /:id/reject` (manager role;
  returns the report to draft, clears submitted_at) ·
  `POST /:id/pay` (manager role; approved → paid, optional
  payment_ref). Approve/reject/pay additionally refuse the
  report's OWN owner with 403 `SELF_APPROVAL` — a manager
  cannot process their own report (Jake's two accounts are
  separate users rows, so one can still process the other's).
- **Day math:** daily reimbursable = max(0, driven −
  commute). Mileage dollars: when every entry carries a rate
  (the normal one-rate month), each day claims
  reimbursable × that day's rate, so a commute-heavy day can
  never go negative; unrated entries count miles but no
  dollars.
- `POST /mileage/route` — `{start_lat, start_lng, end_lat,
  end_lng}` → `{miles_toll, miles_no_toll}` from the public
  Valhalla instance (lib/routing.js; either figure may be
  null; both failing → 502 `ROUTE_FAILED`). Coordinates only;
  demo-grade by design — miles are always hand-enterable.
- Events: `expense_change` with ids + action only — never
  addresses, amounts, or notes. Suite: `e2e-expenses-test.js`
  (42 checks, all passing locally 2026-11-01).

## Role gates (lib/requireRole.js) — replaced the manager-PIN gate 2026-11-02

Jake's decision (2026-11-02): "Remove the PIN — role gates
instead." The PIN model let any signed-in user perform a manager
action by borrowing a manager's PIN; the role model ties the
authority to the signed-in account's OWN staff role.

- `requireRole('manager', 'admin')` resolves the caller's ACTIVE
  users row by the token's email. No row → 403 `NO_STAFF_RECORD`;
  wrong role → 403 `ROLE_REQUIRED`. On success it sets `req.staff`
  and `req.manager` = the CALLER, so handler audit/event
  attribution (which already names `req.manager`) stays truthful —
  the authorizer IS the caller now.
- `attachManager` is the non-gating variant on routes that dropped
  their gate (patient update, appointment update): it attaches the
  same identity when a staff row exists and falls back to
  `{id: null, email, role: null}` when it doesn't.
- Gated surface: patient delete/restore; all staff writes;
  category create/update/deactivate/restore; appointment
  delete/restore; document delete/restore; agency sync/update;
  expense approve/reject/pay (manager role + the SELF_APPROVAL
  block above).
- Retired with the PIN: the `X-Manager-Pin` header, error codes
  `PIN_REQUIRED` / `PIN_INVALID`, `POST /users/verify-pin`, and
  `lib/requireManagerPin.js` (deleted). `lib/pin.js` and the
  `users.pin_hash` column remain but are DORMANT — seed-users still
  writes hashes; nothing verifies them.

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
- Roles are enforced for writes via the role gates above
  (manager/admin) since 2026-11-02; finer READ-side scoping
  (e.g., a developer role seeing the Audit Log but not patient
  rows) is still future API work.
- Audit snapshots include `ss` / `drivers_license` verbatim —
  redaction is required before any real data (see ARCHITECTURE.md).
- Appointments: no recurrence yet (OpenEMR's
  pc_recurrtype/pc_recurrspec series + edit-one/future/all is a
  deliberate deferral), no facility/billing-facility fields (no
  facility table yet). Categories are editable in Settings →
  Visit categories (role-gated); statuses are still seeded data
  only (`seed-appointment-lists.js`), no admin UI.
- Documents: clinical documentation v1 is LIVE (deployed
  2026-10-30 in the maps + agency round). Templates are fixed in code
  (`lib/documentTemplates.js`) — there is no template-builder UI
  (OpenEMR's Layout-Based Forms editor is the future analogue),
  and documents cannot yet be attached from the calendar UI
  (the API accepts `appointment_id`; the profile panel does not
  send one yet).
