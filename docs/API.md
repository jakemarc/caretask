# Patient API — Developer Guide

Last updated: 2026-11-03
Live: https://api.marcinnotech.net
The multi-user platform sections below are **Live — deploy-35, 2026-11-03**
(built + suite-verified, not yet deployed); everything else
describes the live API.
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
auth.js              Firebase ID-token verification (the
                     ALLOWED_EMAILS allowlist retired by the
                     platform — Live — deploy-35, 2026-11-03: the perimeter
                     is the staff-record gate, see below)
db.js                pg pool
lib/platform.js      staff resolution, chart access, episode
                     helpers (Live — deploy-35, 2026-11-03)
routes/patients.js   patient CRUD + soft delete/restore + audit fetch
routes/episodes.js   episodes + teams (Live — deploy-35, 2026-11-03)
routes/invites.js    invite-only sign-up (Live — deploy-35, 2026-11-03)
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

**Platform change (Live — deploy-35, 2026-11-03, not yet deployed):** the
allowlist is retired. `auth.js` verifies the token only; every
router except `/invites` then passes `requireStaff` — the token
must resolve to an ACTIVE users row (firebase_uid, else email)
or the request is 403 `NO_STAFF_RECORD`. The live
`ALLOWED_EMAILS` env var becomes vestigial at that deploy. See
the platform section below.

| Route | Notes |
|---|---|
| `GET /health` | open; liveness |
| `GET /patients?q=&status=` | q matches fname/lname/preferred_name/email (ILIKE). **Platform (Live, deploy-35):** returns only the caller's LINKED patients, each row's `status` = the caller's link status; `?all=1` (platform admin) returns the whole registry with registry status |
| `POST /patients` | create (NOT gated — intake is a front-desk act). Requires only `fname` + `lname`. `date_of_birth` and `sex` are OPTIONAL (Jake, 2026-11-01 — they were required 2026-10-30 → 2026-11-01 with 400 `DOB_REQUIRED` / `SEX_REQUIRED`; those codes are retired). An empty-string `date_of_birth` normalizes to NULL; a provided one must still be YYYY-MM-DD. Accepts the stored-age fallback `age` (integer 0–130, else 400) for patients whose birth date is unknown. **Platform (Live, deploy-35):** runs the registry duplicate rules first — exact match → 409 `PATIENT_EXISTS`, near match → 409 `POSSIBLE_MATCH` (override with `confirm_create: true`); a successful create auto-links the patient to the creator's list |

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
| `POST /patients/:id/link` | **Platform (Live, deploy-35):** add the patient to MY list (idempotent; revives a removed link as active) |
| `DELETE /patients/:id/link` | **Platform (Live, deploy-35):** remove from MY list (404 `NOT_LINKED` when not linked) |
| `PUT /patients/:id/link` | **Platform (Live, deploy-35):** set MY list status `{list_status}` (active/hold/discharged) |
| `GET /patients/:id/episodes` | **Platform (Live, deploy-35):** the patient's episodes, newest first, each with its team (chart access) |
| `POST /patients/:id/episodes` | **Platform (Live, deploy-35):** open an episode `{agency_id, admitted_at?}` — caller becomes primary; 409 `EPISODE_ACTIVE` names the holding agency + primary |
| `POST /episodes/:id/discharge` | **Platform (Live, deploy-35):** discharge `{discharged_at?, discharge_reason?, discharge_note?}` — works from active or on hold (an open hold closes at the discharge date); manager = primary, case manager, or manager/admin of the agency |
| `POST /episodes/:id/recertify` | **Platform (Live, deploy-35):** close + reopen same-agency with the team copied (active episodes only; on hold → 409 `EPISODE_ON_HOLD`) |
| `PUT /episodes/:id/primary` | **Platform (Live, deploy-35):** hand the primary role to another current member |
| `PUT /episodes/:id/case-manager` | **Platform (Live — deploy-35, addendum 2026-11-03):** hand case management to another current member (400 `NOT_ON_TEAM`) |
| `POST /episodes/:id/hold` | **Platform (Live — deploy-35, addendum 2026-11-03):** put the episode on hold `{reason?, note?, started_on?}` (reasons: hospitalized / patient_request / physician_order / other) |
| `POST /episodes/:id/resume` | **Platform (Live — deploy-35, addendum 2026-11-03):** end the current hold `{resumed_on?}` |
| `POST /episodes/:id/members` | **Platform (Live, deploy-35):** add a teammate `{user_id, supervised_by?}` (must belong to the episode's agency; auto-links the patient to them) |
| `DELETE /episodes/:id/members/:userId` | **Platform (Live, deploy-35):** remove a teammate (400 `CANNOT_REMOVE_PRIMARY` for the primary) |
| `GET /users/me/agencies` | **Platform (Live, deploy-35):** my agency memberships (light rows: id, name, display_name, city, state) |
| `POST /users/me/agencies` | **Platform (Live, deploy-35):** join an agency `{agency_id}` |
| `DELETE /users/me/agencies/:agencyId` | **Platform (Live, deploy-35):** leave an agency (409 `PRIMARY_ON_ACTIVE_EPISODE`) |
| `POST /invites` | **Platform (Live, deploy-35): platform admin** — create an invite `{email, role}`; the raw `code` + `accept_path` return ONCE (only the SHA-256 hash is stored); 7-day expiry; 409 `ALREADY_STAFF` |
| `GET /invites` | **Platform (Live, deploy-35): platform admin** — invites with derived status (pending/accepted/revoked/expired) |
| `DELETE /invites/:id` | **Platform (Live, deploy-35): platform admin** — revoke a pending invite |
| `POST /invites/accept` | **Platform (Live, deploy-35):** the one route open without a staff record — `{code, fname?, lname?}`; the token's email must match the invite (403 `INVITE_EMAIL_MISMATCH`); creates or claims the staff record with the invite's role |
| `GET /contact-sync/me` | **Phone contacts (Live, deploy-36, 2026-11-03):** the caller's sync status — configured/enabled, dav username, server URL, book name, last sync + result, contact count |
| `POST /contact-sync/me/enable` | **Phone contacts:** provision the caller's Radicale credential + "CareTask" address book and run the first sync; the CardDAV **password returns ONCE** (bcrypt hash only in Radicale's htpasswd; never stored in the DB); 409 `ALREADY_ENABLED`, 503 `SYNC_NOT_CONFIGURED` when the server env is unset |
| `POST /contact-sync/me/regenerate-password` | **Phone contacts:** replace the caller's CardDAV password (returned once); the old one stops working immediately |
| `POST /contact-sync/me/sync-now` | **Phone contacts:** reconcile the caller's book now (also runs on change — patient/link/merge/user hooks poke it — and hourly) |
| `DELETE /contact-sync/me` | **Phone contacts:** turn off — deletes the server-side book + credential and clears sync state |
| `GET /patients/:id/audit` | audit_log rows for the patient |
| `GET /users` | staff list — safe columns only, `pin_hash` is NEVER returned (`has_pin` boolean instead) |
| `GET /users/me` | caller's staff row or null |
| `GET /users/clinicians` | authorized AND active staff (the assignable providers). **Platform (Live, deploy-35):** scoped to the caller's agency colleagues + the caller (platform admins see everyone) |
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
| `GET /appointments?from=&to=&patient_id=&provider_id=` | overlap-window list, joined with patient/provider/category names. **Platform (Live, deploy-35):** default scope is PERSONAL (my visits + unassigned visits on my episodes); `patient_id=` returns that patient's MASTER schedule (chart access); `?scope=all` is the manager/admin/developer practice view (403 `SCOPE_FORBIDDEN`) |
| `POST /appointments` | create (NOT gated — booking is a front-desk act). **Platform (Live, deploy-35):** patient visits pass the episode gate — no live episode → booked as a personal visit, `episode_id` NULL (solo mode); episode on hold → 409 `EPISODE_ON_HOLD` (a single Resumption of Care booking is the exception — it ends the hold); with a live episode the provider must be on the episode team, or a same-agency colleague covering a single (non-series) visit, else 403 `NOT_ON_TEAM`; the row is stamped with `episode_id` |
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

## Mileage day log + generated reports (routes/expenses.js)

LIVE via deploy-27 (2026-11-02): migration applied on the
VM; the pre-existing test envelope data (report #1 + its 2
entries) was wiped at Jake's direction — it was
form-testing data — so the log starts clean.

Simplified 2026-11-02 (Jake): NO approval process. Mileage is
a per-clinician DAY LOG of legs (a chain), top-level since
`schema-mileage-chains.sql` (legs carry `user_id`, `agency_id`,
`patient_id`, `start_label`/`end_label`; `expense_report_id`
is nullable and legacy-only). Mounted at root in server.js.
Every route requires the caller to resolve to an active users
row (403 `NO_STAFF_RECORD` otherwise).

- A day's legs in `seq` order form the chain: `entry_kind`
  'commute' legs are the fixed home<->office bookends
  (personal miles, never billed); 'business' legs are
  billable. `business_miles` is the leg's FINAL miles for
  both kinds; `miles_toll` / `miles_no_toll` keep both routed
  figures and `used_tollway` says which was driven (default
  tollway); `rate_per_mile` is a per-leg snapshot.
- `GET /mileage?from&to&agency_id&user_id` — legs in range
  (date / agency filters optional). Own legs; manager/admin
  may pass `user_id` for another clinician (403 otherwise).
- `POST /mileage` · `PUT|DELETE /mileage/:id` — leg create /
  owner-only update / owner-only soft delete. Agency and
  patient references are validated (400 `AGENCY_NOT_FOUND` /
  `PATIENT_NOT_FOUND`); coordinates are range-checked.
- `GET /mileage/report?from&to&agency_id&user_id` — a
  GENERATED report (range required, 400 `RANGE_REQUIRED`):
  days grouped with `billable_miles` / `personal_miles` /
  `driven_miles` / `amount_cents`, plus totals. Dollars come
  only from rated BUSINESS legs (miles x rate); personal
  legs never pay. Nothing is stored or locked — the report
  is computed from the log on demand.
- `POST /mileage/route` — `{start_lat, start_lng, end_lat,
  end_lng}` -> `{miles_toll, miles_no_toll}` from the public
  Valhalla instance (lib/routing.js; either figure may be
  null; both failing -> 502 `ROUTE_FAILED`). Coordinates
  only; demo-grade by design — miles are always
  hand-enterable.
- LEGACY envelope reads (read-only, pre-simplification
  monthly reports): `GET /expense-reports` (own; managers
  everyone's) and `GET /expense-reports/:id` with the
  ORIGINAL summary math (daily reimbursable = max(0,
  driven - commute); dollars per the all-rated day rule).
  All envelope writes, the submit/approve/reject/pay
  lifecycle, and the non-mileage expense-line endpoints are
  REMOVED (404); the tables and their data stay untouched.
  Non-mileage lines are parked with the envelopes.
- Events: `expense_change` with ids + action only — never
  addresses, amounts, or notes. Suite:
  `e2e-expenses-test.js` (45 checks, all passing locally
  2026-11-02).

## Patient merge (routes/patientMerge.js, mounted at /patient-merge) — Live 2026-11-02 (deploy-28)

Duplicate-record handling per contacts-multiagency-spec.md §1.
Migration `schema-patient-merge.sql` (after schema-mileage-chains.sql):
`patient_merge_marks` (one open mark per unordered pair; closes via
deleted_at — no DELETE grant), `patient_merges` (survivor/loser,
actor, `moved_ids` JSONB with the exact re-pointed row ids,
undone_at/undone_by), event type `patient_merge` (also added to
SERVER_EVENTS in lib/eventLog.js).

- `GET /patient-merge/marks` — the review queue: open marks with a
  summary of both patients (name, DOB/age, sex, zone, status,
  address, phones, email, agency).
- `POST /patient-merge/mark` {patient_id, other_id} — any signed-in
  clinician; idempotent per pair (either order); 400 SAME_PATIENT,
  404 PATIENT_NOT_FOUND, 409 PATIENT_DELETED.
- `POST /patient-merge/mark/dismiss` {patient_id, other_id} —
  closes an open mark; 404 MARK_NOT_FOUND.
- `POST /patient-merge` {survivor_id, loser_id} — **manager/admin
  role gate**. One transaction: appointments, documents, messages,
  and mileage_entries re-point from loser to survivor (ids
  recorded); the survivor inherits the loser's values ONLY where
  its own are empty (contact/address/demographic/billing fields;
  agency as a pair; notes append with a "[Merged from a duplicate
  record]" marker). Names, zone, status, clinician, consent flags,
  and ss/drivers_license never move. The loser is soft-deleted and
  every open mark touching either record closes.
- `POST /patient-merge/:id/undo` — **manager/admin**. Re-points
  exactly the recorded ids back, restores the loser, stamps
  undone_at/by; 409 ALREADY_UNDONE. Field copies into the survivor
  are NOT reversed (documented behavior — they were copies; the
  loser kept its originals).
- `GET /patient-merge` — the 50 most recent merges with per-table
  moved counts.

Suite: `e2e-patient-merge-test.js` (27 checks; full battery green
2026-11-02).

## Clinician tasks (routes/tasks.js, mounted at /tasks) — Live 2026-11-02 (deploy-28)

The todo/reminder list (Jake, 2026-11-02). Migration
`schema-tasks.sql` (after schema-patient-merge.sql):
`clinician_tasks` (user_id owner, patient_id NULL, title, notes,
due_at, done_at, soft delete) + event type `task_change` (ids and
action only — titles/notes never enter the log).

- Tasks are **owner-scoped**: the caller resolves to their active
  staff record (403 NO_STAFF_RECORD without one); lists and writes
  only ever touch the caller's tasks, and another clinician's task
  id answers 404 TASK_NOT_FOUND (existence hiding).
- `GET /tasks?scope=open|done|all&patient_id=` — open-first
  ordering (due soonest first, undated last).
- `POST /tasks` {title, notes?, patient_id?, due_at?} — title
  required (≤300), patient must exist (400 PATIENT_NOT_FOUND),
  due_at must parse (400 DUE_INVALID).
- `PUT /tasks/:id` — field edits; `done: true/false` stamps/clears
  done_at; `patient_id: null` / `due_at: null` clear the link/due.
- `DELETE /tasks/:id` — soft delete, 204.
- **In-app only** — patient-facing reminders remain the separate
  messaging Phase 3 proposal.

Suite: `e2e-tasks-test.js` (22 checks, all passing 2026-11-02).
The dashboard half (the overview "My reminders" panel and the
profile Reminders card) shipped in the same deploy — see
DASHBOARD.md.

## News feed (routes/news.js, mounted at /news) — Live 2026-11-02 (deploy-28)

Server-side RSS/Atom aggregation for the dashboard's news card,
so feeds are fetched once per API instance instead of from every
browser.

- `GET /news?topics=a,b&limit=n` — behind requireAuth. Topics:
  `physical_therapy`, `home_health`, `apta`, `medicare_cms`,
  `research`; an unknown topic answers 400 `TOPIC_UNKNOWN`.
  `limit` clamps to 1–30 (default 12). Response `{items, topics,
  fetched_at}`; items carry source, title, description, link,
  and published time.
- Feeds (lib/newsFeeds.js; overridable wholesale via the
  `NEWS_FEEDS_JSON` env var): APTA's RSS feed (it carries both
  the apta and physical_therapy topics), Home Health Care News'
  home-health and CMS category feeds, and PTJ's Editor's Choice
  feed (research). CMS publishes no official RSS feed, hence the
  HHCN CMS category feed.
- Parsing is a tolerant in-house RSS `<item>` / Atom `<entry>`
  extractor (entities and CDATA decoded, HTML stripped). Titles
  trim to at most 110 characters and descriptions to 180, at a
  word boundary; items dedupe by link and sort newest-first.
  Each feed is cached in memory for 10 minutes with a 6-second
  fetch timeout; a failing feed drops out of that response only.

Suite: `e2e-news-test.js` (10 checks against fixture RSS/Atom
servers — the suite needs no database; all passing 2026-11-02).

## Appointment series (routes/appointments.js) — Live 2026-11-02 (deploy-32)

Repeating visits are ordinary appointment rows linked by
`appointments.series_id` (UUID, nullable;
`schema-appointment-series.sql`), so one visit can move or
cancel without touching the rest.

- `POST /appointments/series` (ungated) — body = the normal
  appointment fields + `duration_min` (5–480) + `visits`
  (1–60 ISO start times). Validates like a single create
  (category / patient / provider / status rules), then inserts
  every visit in ONE transaction under one fresh series_id;
  one `appointment_create` event per visit (details carry
  series_id). Errors: 400 `SERIES_VISITS_REQUIRED` /
  `SERIES_TOO_LARGE` / the usual codes.
- `PUT /appointments/series/:seriesId` (ungated, like the
  single PUT) — applies category_id / provider_id / title /
  room / notes to every live member; dates and times are
  per-visit BY DESIGN and never change here. One
  `appointment_series_update` event. 404 `SERIES_NOT_FOUND`.
- `DELETE /appointments/:id?scope=series` (manager/admin, like
  the single delete) — soft-deletes every live member; the
  response row carries `series_deleted_count`; one
  `appointment_series_delete` event.
- CORS (2026-11-02): besides DASHBOARD_ORIGIN, per-deployment
  preview origins `https://<hash>.marcinnotech-app.pages.dev`
  are allowed, so a preview build can be checked against the
  live API before going canonical (the Places browser key got
  the matching referrer entry the same day).

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

## Multi-user platform (lib/platform.js, routes/episodes.js, routes/invites.js) — Live — deploy-35, 2026-11-03

Jake's design (2026-11-03), informed by same-day model research
on Epic, Homecare Homebase, and OpenEMR; full spec in
`~/workspace/marc-innotech/multi-user-platform-spec.md`. Built and
verified locally (65-check platform suite + the full legacy
battery green); **not yet deployed** — deploy needs Jake's go,
and `migrate-platform.sql` gets reviewed before it runs live.

- **Registry + personal lists.** `patients` is a single master
  registry ("their data becomes our data"). What a clinician
  sees is governed by `patient_links` (per-user list + list
  status). List status moved OFF the shared record onto the
  link; a `status` in a patient PUT still syncs the caller's own
  link as a bridge.
- **Chart access** (`hasChartAccess`): platform admin, OR a live
  link, OR membership of ANY of the patient's episodes (current
  team, incl. discharged episodes — history stays readable to
  those who worked it), OR a **coverage visit**: a non-cancelled
  appointment for this patient with the caller as provider
  within ±7 days (the HCHB field rule). No access → 404 (the
  record's existence is not leaked).
- **Duplicate rules on create.** Exact (normalized first+last
  name + DOB; or name + phone/email when either DOB is missing)
  → hard block 409 `PATIENT_EXISTS` with the record's id/name/
  DOB/city + `already_linked` — the answer is "Add to my list",
  never a second record. Near (same DOB + similar name, same
  phone, same email, or same name alone) → 409 `POSSIBLE_MATCH`
  with ≤3 candidates; `confirm_create: true` overrides and is
  event-logged. **Known Non-Duplicates (Epic's KND, adapted):**
  a confirmed create stores (candidate, intake-fingerprint)
  dismissals, so the same intake data never prompts again for
  that pair. Exact matches are never suppressed.
- **Episodes are the unit of sharing.** `patient_episodes` +
  `episode_members`; a partial unique index enforces ONE live
  episode per patient across the whole platform. An episode
  belongs to one agency, has one primary (its opener; manages
  the team; discharges) and any number of members from the same
  agency, with an optional `supervised_by` pointer (PTA → PT).
  Same-agency handoff = add/remove members, no discharge.
  Another agency can only admit after discharge; the 409 names
  the holding agency + primary (no clinical detail). Recertify
  closes and reopens same-agency with the team copied and
  `recert_of` chaining the history.
- **Holds, discharge reasons, case manager (addendum,
  Jake 2026-11-03).** An episode may be ON HOLD (status
  `on_hold`; each hold is an `episode_holds` row with reason /
  note / dates) — the hospitalized-patient case: the episode
  still owns the patient (the unique index covers
  active + on_hold), booking refuses with 409
  `EPISODE_ON_HOLD`, and a single Resumption of Care booking
  ends the hold in the same transaction. Discharge records a
  structured `discharge_reason` (completed / patient_declined /
  transferred_agency / transferred_inpatient /
  moved_out_of_area / physician_order / deceased / other) — the
  "couldn't finish" accounting. `case_manager_user_id` names
  one team member as the clinical coordinator (HCHB's
  episode-header role): defaults to the primary, transferable
  via `PUT /episodes/:id/case-manager`, holds full management
  rights, and cannot be removed from the team until a
  successor is named (400 `CANNOT_REMOVE_CASE_MANAGER`).
- **Booking gate.** WHEN a patient has a live episode, a visit
  is stamped with its id and the provider must be a current
  team member; a colleague from the episode's agency may take
  a SINGLE coverage visit without joining the team (series
  stay team-only). Unassigned bookings require the booker to
  be on the team (or a platform admin). Pure reschedules
  (drag) are never re-gated. On a held episode the gate
  answers 409 `EPISODE_ON_HOLD` except for the ROC rule above.
  **Solo mode (Jake, 2026-11-03):** when the patient has NO
  live episode, booking just works and the visit stays
  unstamped — a personal practice visit. Episodes are the
  unit of sharing, not a toll booth for booking; the gate
  engages only once an episode exists. (`NO_ACTIVE_EPISODE`
  is retired.)
- **Calendars.** Default = personal. `?patient_id=` = the
  patient's master schedule (all team members' visits, provider
  names shown — double-bookings are shown, not blocked).
  `?scope=all` = practice view for manager/admin/developer.
- **Invites.** Invite-only sign-up (Jake's call over the
  open-sign-up recommendation). Admin creates by email + role;
  only the code's SHA-256 is stored; acceptance requires the
  signed-in token's email to match the invite. Accepting creates
  (or claims/reactivates) the staff record with
  `authorized = true` and a blank workspace by construction.
- **Migration** (`migrate-platform.sql`, pure SQL, idempotent):
  every patient links to Jake's admin row (plus any staff with
  appointments on them); patients with an agency get an episode
  (primary = earliest appointment's provider, else the admin;
  members = distinct appointment providers + the primary;
  appointments stamped); agency memberships derive from the
  episodes (admin → all agencies on patients). Verified against
  a scratch fixture before ever touching live data.
- **New event types** (additive only, per the audit rule):
  `patient_link`, `patient_unlink`, `episode_create`,
  `episode_discharge`, `episode_team`, `episode_hold`,
  `episode_resume`, `episode_case_manager`, `invite_create`,
  `invite_accept`, `agency_membership`.
- **Error codes:** `PATIENT_EXISTS`, `POSSIBLE_MATCH`,
  `EPISODE_ACTIVE`, `EPISODE_NOT_ACTIVE`,
  `EPISODE_ON_HOLD`, `ALREADY_ON_HOLD`, `NOT_ON_HOLD`,
  `NOT_ON_TEAM`, `NOT_AGENCY_MEMBER`, `AGENCY_NOT_FOUND`,
  `NOT_LINKED`, `CANNOT_REMOVE_PRIMARY`,
  `CANNOT_REMOVE_CASE_MANAGER`,
  `PRIMARY_ON_ACTIVE_EPISODE`, `SCOPE_FORBIDDEN`,
  `ADMIN_REQUIRED`, `INVITE_INVALID`, `INVITE_USED`,
  `INVITE_EXPIRED`, `INVITE_EMAIL_MISMATCH`, `ALREADY_STAFF`,
  `USER_NOT_FOUND`, `SUPERVISOR_NOT_ON_TEAM`.

## Admin console (routes/admin.js, mounted at /admin) — Live 2026-11-04 (deploy-38)

Read-only aggregates for the admin site
(admin.marcinnotech.net; spec: `admin-site-spec.md`). Mounted
behind requireAuth + requireStaff in server.js; the router
itself applies `requireRole('admin', 'developer')` (the same
platform-admin definition as `routes/invites.js`), so every
endpoint is gated on every request: no ACTIVE staff record →
403 `NO_STAFF_RECORD`; any other role → 403 `ROLE_REQUIRED`.

- `GET /admin/overview` → `{ generated_at, patients {total,
  created_last_30d}, users {total, active, by_role}, links
  {active, hold, discharged}, episodes {active, on_hold,
  discharged_total}, appointments {today, next_7d, total},
  agencies {total, active}, invites {pending}, contact_sync
  [{user_id, email, enabled, last_sync_at, last_result,
  items}], backups {latest {filename, size_bytes, mtime} |
  null}, auth_failures_24h, recent_errors [{at, event,
  actor_email, detail}] }`. Day boundaries are the database's
  `CURRENT_DATE`. `backups` reads the newest file by mtime in
  `ADMIN_BACKUPS_DIR` (default `/home/jakemarc2/backups`;
  name/size/time only, null-safe when the folder is missing
  or empty). `recent_errors` = the latest 10 `event_log` rows
  from 7 days whose event is `auth_failure` or whose details
  carry an error marker. All counts are cast to integers.
- `GET /admin/users` → every staff row (safe columns —
  `pin_hash` is never selected, not even hashed) with
  per-user aggregates: `links {active, hold, discharged}`
  (links with `removed_at` set don't count),
  `episodes_primary`, `episodes_case_manager`,
  `appointments_total` (non-deleted, as provider),
  `contact_sync {enabled, items, last_result, last_sync_at}
  | null`, `last_event_at` (newest `event_log` row for the
  user's email).

There are deliberately no admin writes: staff create / edit
/ deactivate / restore stay on `/users`, invites on
`/invites`, each with its own existing gates and event
logging. Suite: `e2e-admin-test.js` (41 checks).

## Known gaps (deliberate, tracked)

- `patients.clinician` is still free text ("Unassigned" default);
  the patient form is not yet wired to pick from `GET
  /users/clinicians`.
- Roles are enforced for writes via the role gates above
  (manager/admin) since 2026-11-02. READ-side scoping arrived
  with the platform (Live — deploy-35, 2026-11-03): patient lists are
  link-scoped and chart reads follow episode-team / link /
  coverage access. Still future: role-based Audit Log scoping
  (e.g., a developer role seeing the Log but not patient rows).
- Audit snapshots include `ss` / `drivers_license` verbatim —
  redaction is required before any real data (see ARCHITECTURE.md).
- Appointments: recurrence ships as the series model above
  (Jake's staggered-phase builder, 2026-11-02) — deliberately
  NOT OpenEMR's pc_recurrtype spec: no stored recurrence rule,
  no edit-future split; a series is just linked rows. Still
  open: facility/billing-facility fields (no facility table
  yet). Categories are editable in Settings →
  Visit categories (role-gated); statuses are still seeded data
  only (`seed-appointment-lists.js`), no admin UI.
  **Status model v2 (Jake, 2026-11-02; LIVE as deploy-31 —
  migration run on the live DB and verified: 13 scheduled /
  2 completed / 1 missed / 1 cancelled of 17 appointments):**
  exactly three user-facing statuses — `scheduled` (yellow),
  `completed` (green), `missed` (red) — via
  `schema-appointment-statuses-v2.sql`, which adds the three
  codes (sort 1–3), pushes the legacy flow-board codes to sort
  11–17 (rows kept for history), remaps stored appointments
  (booked/confirmed/arrived/in_room → scheduled, checked_out →
  completed, no_show → missed, cancelled untouched), and sets
  the column default to 'scheduled'.
- Documents: clinical documentation v1 is LIVE (deployed
  2026-10-30 in the maps + agency round). Templates are fixed in code
  (`lib/documentTemplates.js`) — there is no template-builder UI
  (OpenEMR's Layout-Based Forms editor is the future analogue),
  and documents cannot yet be attached from the calendar UI
  (the API accepts `appointment_id`; the profile panel does not
  send one yet).
