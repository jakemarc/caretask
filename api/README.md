# CareTask Patient API — demo patient database

Express + Postgres CRUD for the `patients` table. This is a SEPARATE
Marc Innotech API — it is not the jakemarc.com clients API, and nothing
here edits that project. It runs on the Marc Innotech VM next to Postgres
(localhost only), behind a reverse proxy that terminates TLS.

**DEMO DATA ONLY.** Every patient this API serves is fictional (see
`seed.js`). No real patient data goes through this API until TLS, a
signed BAA, and the company entity are all in place. Audit history and
soft delete — two of those gates — are implemented here now, on
fictional data, so they are proven before any real data arrives.

## Prerequisites (in order)

1. **Postgres on the VM.** Install Postgres 16, create the database and
   the app role (as the Postgres superuser):
   ```sql
   CREATE DATABASE caretask_demo;
   CREATE ROLE caretask_app LOGIN PASSWORD '<set-a-password>';
   GRANT ALL ON DATABASE caretask_demo TO caretask_app;
   ```
2. **Create the tables.** Connected to caretask_demo, run the schema
   and then the migrations, in this order (use whichever role created
   the database if `caretask_app` lacks CREATE):
   `psql -h localhost -U caretask_app -d caretask_demo -f schema.sql`
   `psql -h localhost -U caretask_app -d caretask_demo -f schema-events.sql`
   `schema-events.sql` is safe to re-apply to an already-migrated
   database (columns use `IF NOT EXISTS`, functions use
   `CREATE OR REPLACE`, triggers are dropped and recreated) — that
   is how a live database picks up trigger fixes without a rebuild.
3. **Apply the patients v2 migration — DESTRUCTIVE, demo only.**
   `psql -h localhost -U postgres -d caretask_demo -f schema-patients-v2.sql`
   ⚠️ This migration TRUNCATEs `audit_log` and `patients` and DROPs
   the `name`, `address`, `phone`, and `age_band` columns (see the
   patients v2 section below). Never run it on a database holding
   real data. Run it **as the table owner** (e.g. `postgres`): the
   runtime API user cannot ALTER/DROP columns it does not own — the
   Oct 29 live deploy failed on exactly this gap. After applying,
   re-grant the runtime user (table-level grants cover new columns):
   `GRANT SELECT, INSERT, UPDATE, DELETE ON patients TO patient_api;`
   `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO patient_api;`
   Then re-seed (step 4) — the migration leaves the tables empty.
4. **Seed fictional patients.**
   `npm run seed`
   (This resets the tables with TRUNCATE — audit_log and patients —
   then inserts the fictional set. TRUNCATE is used because the
   append-only triggers reject row DELETEs on audit_log. Never run it
   against tables holding real data.)
5. **Copy this `patient-api/` folder to the VM** and install
   dependencies: `npm install`
6. **Set the environment** (see `.env.example`; never commit `.env`):
   `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`,
   `GOOGLE_APPLICATION_CREDENTIALS` (Marc Innotech Firebase service
   account, VM only), `ALLOWED_EMAILS` (fails closed when unset),
   `DASHBOARD_ORIGIN` (required for dashboard browser calls).
7. **Start it:** `node server.js` (or `npm start`). It listens on
   `http://127.0.0.1:3001` — localhost only, by design.

## Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/health` | Liveness check: `{ "ok": true }` (no auth) |
| GET | `/patients` | List active patients, newest first. Filters: `?zone=green\|yellow\|red`, `?status=active\|hold\|discharged`, `?q=text` (fname, lname, preferred_name, or email), `?limit=` (default 50, max 200), `?offset=` |
| GET | `/patients/:id` | One patient, by UUID `id`. A successful read also writes a `patient_view` event to the event log |
| GET | `/patients/:id/audit` | That patient's audit trail, newest first. Works for soft-deleted patients too |
| POST | `/patients` | Create. `fname` + `lname` are required; `zone` must be green, yellow, or red; `status` must be active, hold, or discharged; `flags` must be an array of strings; `date_of_birth` must be YYYY-MM-DD; `interpreter_needed` / `hipaa_allowsms` / `hipaa_allowemail` must be real JSON booleans (strings/numbers are rejected, never coerced); `pharmacy_id` must be an integer |
| PUT | `/patients/:id` | Update the fields provided (same whitelist). **Manager PIN required** (`X-Manager-Pin` header; 403 `PIN_REQUIRED` / `PIN_INVALID` without a valid one) |
| DELETE | `/patients/:id` | SOFT delete: sets `deleted_at`, keeps the row. Returns 204, or 404 if not found. **Manager PIN required** |
| POST | `/patients/:id/restore` | Undo a soft delete: clears `deleted_at`. Returns the patient, 404 if not found, 409 if already active. **Manager PIN required** |
| GET | `/users` | Staff directory (users table), safe columns only — `pin_hash` is never returned; rows carry `has_pin` instead |
| GET | `/users/me` | The signed-in user's own users row, or `null` |
| PUT | `/users/me/addresses` | Self-service: update the caller's own home (`street`/`city`/`state`/`zip`) and/or office (`office_*`, migration `schema-users-office.sql`) address fields. Strings trimmed, blank/null clears; 400 `VALIDATION` on a non-string value or empty body; 403 `NO_STAFF_RECORD` without an active staff row. Returns the updated row |
| GET | `/users/clinicians` | Active users with `authorized = true` (assignable providers) |
| POST | `/users/verify-pin` | `{ pin }` → `{ ok, manager }`. UX check for the dashboard's PIN prompt; the writes above re-check the PIN independently |
| POST | `/users` | Create a staff member. **Manager-gated** (`X-Manager-Pin`). Optional `pin` in the body sets that member's own PIN (hashed). Duplicate email → 409 `EMAIL_EXISTS` |
| PUT | `/users/:id` | Update a staff member (partial). **Manager-gated**. Optional `pin` replaces that member's PIN |
| DELETE | `/users/:id` | Deactivate a staff member (`active = false`, row kept). **Manager-gated**. You cannot deactivate your own account (400 `SELF_DEACTIVATE`) |
| POST | `/users/:id/restore` | Reactivate a deactivated staff member. **Manager-gated** |
| GET | `/events` | Central event log, newest first. Filters: `?event=` (exact, must be a known event name), `?actor_email=` (partial match), `?patient_id=` (exact UUID), `?from=` / `?to=` (YYYY-MM-DD dates), `?limit=` (default 50, max 200), `?offset=`. Unknown event names and bad dates are 400 |
| GET | `/events/verify` | Recompute both hash chains and report validity: `{ audit_log: { total, legacy, checked, valid, first_break }, event_log: {...} }`. `first_break` names the first failing row (`seq`, `id`, `reason`) or is null |
| POST | `/events` | Report a client-side event. Accepts ONLY `sign_in`, `sign_out`, `report_export` (body: `{ event, details?, patient_id? }`). Server-generated events (`patient_view`, `auth_failure`, `api_request`, `admin_action`) are rejected with 400, so a client can never forge them |
| GET | `/agencies` | IDPH agency directory (migration: `schema-agencies.sql`). Filters: `?q=` (name/dba/short_name/city/license), `?active=true\|false`, `?limit=`/`?offset=`. Rows include a computed `display_name` (short_name → DBA → first two words → full name) |
| GET | `/agencies/primary` | The `is_primary` ("our agency") row or `null` |
| GET | `/agencies/sync-status` | Latest `agency_sync` event (`{last_run_at, …counts}`) or `null` |
| GET | `/agencies/:id` | One agency by bigint id |
| POST | `/agencies/sync` | Run the IDPH sync now (lib/agencySync.js). **Manager PIN required**. Skips when the dataset's `rowsUpdatedAt` is unchanged; upstream failure → 502 `SYNC_FAILED` |
| PUT | `/agencies/:id` | Edit LOCAL fields only (`is_primary`, `notes`, `short_name`) — a sync never overwrites them. **Manager PIN required** |

Agencies sync also runs from the CLI (`node sync-agencies.js [--live | --sample file.json]`) and weekly via the systemd timer units in `deploy/` (install at deploy time — see docs/OPERATIONS.md). Source: IDPH Home Health Agency Directory, Socrata dataset `p7mg-cnpx` on illinois-edp.data.socrata.com (see `~/workspace/marc-innotech/agency-directory-research.md`).

Example (from the VM itself; `/patients` needs a token — see below):

```
curl -s http://127.0.0.1:3001/health
curl -s http://127.0.0.1:3001/patients \
  -H "Authorization: Bearer <firebase-id-token>"
```

## Authentication (required for /patients and /events)

The page-level login is not the protection — anyone who finds the API
URL could call it directly. So every `/patients` and `/events`
request must carry the signed-in user's Firebase ID token, and the
API checks it:

1. **Service account (VM only, never in chat or the repo).** Firebase
   console -> Project settings -> Service accounts -> "Generate new
   private key", from the MARC INNOTECH project. Save that JSON file on
   the VM and set:
   `GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json`
2. **Allowlist (fails closed).** Set `ALLOWED_EMAILS` to the sign-in
   emails allowed to use the API, comma-separated. If it is unset or
   empty, every request is rejected with 403.
3. **Outbound HTTPS.** Token verification fetches Google's public keys,
   so the VM must reach Google over HTTPS.

The dashboard sends the token as `Authorization: Bearer <token>` (it gets
it from `user.getIdToken()`). `GET /health` stays open as a liveness
check.

## CORS

Restricted to `DASHBOARD_ORIGIN` (comma-separated). If it is unset, CORS
is off entirely and dashboard browser calls are blocked. Set it to the
dashboard's origin: `http://localhost:5173` for local dev, the Pages URL
for the live dashboard.

## Patients table v2 (migration: `schema-patients-v2.sql`)

Applied after `schema.sql` and `schema-events.sql`. The table now
carries the OpenEMR-style split fields instead of the v1 single
`name` / `address` / `phone` text columns, plus demographics, care,
sensitive, billing, and pharmacy fields.

**Destructive migration + re-seed procedure.** The migration
TRUNCATEs `audit_log` and `patients` and DROPs `name`, `address`,
`phone`, and `age_band`. `age_band` is derived from `date_of_birth`
now (the dashboard computes the decade band), so nothing of value is
lost. Run it **as the table owner**, then `npm run seed` (procedure
in the prerequisites above). `event_log` is NOT truncated — its
`patient_id` is informational, so old event rows survive the reset.

**Field list (45 columns — 43 v2 + `latitude`/`longitude` from
`schema-patients-map.sql`, an idempotent non-destructive migration
applied after v2, as the table owner):**

| Group | Fields |
| --- | --- |
| System | `id` (UUID PK), `created_at`, `updated_at`, `deleted_at` (soft-delete marker) |
| Name | `title`, `fname` (required), `mname`, `lname` (required), `suffix`, `preferred_name` |
| Demographics | `date_of_birth`, `sex`, `race`, `ethnicity`, `language` |
| Address | `street`, `street_line_2`, `city`, `state`, `postal_code`, `country_code`, `latitude`, `longitude` (map coordinates; numbers-or-null, range-checked; set from an address-autocomplete pick, else NULL) |
| Contact | `phone_home`, `phone_cell`, `email` |
| Care | `zone` (green/yellow/red CHECK), `flags` (TEXT[]), `notes`, `clinician`, `occupation`, `interpreter_needed` (bool), `hipaa_allowsms` (bool), `hipaa_allowemail` (bool), `referrer`, `status` (active/hold/discharged CHECK, default active) |
| Emergency contact | `emergency_contact_name`, `emergency_contact_relationship`, `emergency_contact_phone` |
| Sensitive | `ss`, `drivers_license` |
| Billing | `billing_note`, `pricelevel` (default `standard`), `financial` |
| Pharmacy | `pharmacy_id` (INTEGER, NULL allowed) |

`pharmacy_id` has **no foreign key** — there is no pharmacy table
yet, so there is nothing to reference. The column is
OpenEMR-compatible; add the FK when a pharmacy table exists.

⚠️ **WARNING — audit snapshots now include sensitive values.**
`audit_log` rows store full `{ before, after }` patient snapshots,
which now include `ss` and `drivers_license` verbatim. **Field-level
redaction of audit snapshots MUST be addressed before any real data
is ever stored** — e.g. hashing or masking those two fields in
snapshots, or excluding them from `changed`. The demo seed keeps
both fields obviously fictional (SSNs in the never-issued 900 area
range, licenses marked `EXAMPLE`), and the dashboard UI
deliberately never renders them — but that is minimization for the
demo, not a substitute for snapshot redaction. Demo data only until
the standing gates pass (BAA + incorporation; TLS is live).

## Audit + soft delete (implemented)

- **Soft delete, never hard delete.** `DELETE /patients/:id` sets
  `deleted_at`; the row stays. Every list/get excludes soft-deleted
  rows. `POST /patients/:id/restore` clears `deleted_at`.
- **Append-only audit log.** Every mutation (create, update,
  soft_delete, restore) writes one `audit_log` row in the same
  transaction as the change: who (Firebase UID + email from the
  verified token), what action, which patient, when, and
  `{ before, after }` row snapshots. The schema rejects UPDATE/DELETE
  on `audit_log`, and no endpoint writes to it except the audit insert.
- **Trail endpoint.** `GET /patients/:id/audit` returns one patient's
  trail, newest first, including for soft-deleted patients.
- **Seed rows have no audit entries by design:** the trail records API
  mutations by a signed-in user, and seeding is setup, not an action.
  Seeding resets `audit_log` and `patients` but intentionally leaves
  `event_log` alone: it is a historical record, and its `patient_id`
  is informational (no foreign key), so old event rows stay readable
  after a reset.

## Central event log + tamper-evident hash chain (OpenEMR-style audit core)

Beyond the per-patient `audit_log` above, the API keeps one central
`event_log` (migration: `schema-events.sql`, applied after
`schema.sql`):

- **One stream for everything.** `event_log` rows: `id`, `seq`,
  `actor_uid`, `actor_email`, `event`, `patient_id` (nullable),
  `details` JSONB, `ip`, `created_at`, `prev_hash`, `row_hash`.
  Event vocabulary: `patient_view`, `sign_in`, `sign_out`,
  `report_export`, `auth_failure`, `api_request`, `admin_action`.
  Same trigger-enforced append-only protection as `audit_log`
  (UPDATE/DELETE rejected). `patient_id` is deliberately NOT a
  foreign key: events are history and must survive patient-table
  resets, so the id is informational, not a constraint.
- **API request logging (OpenEMR's `api_log`, folded in).** Every
  request except `/health` and `/events` writes one `api_request`
  row (or `auth_failure` for 401/403 responses): method, path (no
  query string — query params are never logged), actor, patient id
  when the path carries a UUID, status, IP, timestamp. Tokens,
  passwords, and request bodies are NEVER logged. The path and
  patient id are captured when the request arrives, not when the
  response finishes — Express rewrites `req.path` during routing,
  so reading it at finish time would log the wrong path.
  Logging is best-effort and fire-and-forget: a logging failure
  never fails the clinician's request. `/health` is excluded
  (liveness noise); `/events` is excluded (a client event already
  IS its own record, and viewer polling would flood the log) —
  except that a 401/403 on an excluded path IS still logged as
  `auth_failure`, so probing an excluded path leaves a trace.
  A successful `GET /patients/:id` additionally writes a
  `patient_view` event: the request row answers "was the API
  called", the view row answers "was this record viewed".
  Requests with no verified token are logged under the actor
  `anonymous` (the actor columns are NOT NULL; naming the absence
  beats inventing an email).
- **Tamper-evident hash chain over both tables.** Each row stores
  `prev_hash` (the previous row's hash, NULL on the first row) and
  `row_hash` (SHA-256 over the canonical row content plus the
  previous hash). Canonical form (identical in the SQL triggers and
  in `lib/hashChain.js`, or every row verifies as broken): each
  field as `<character count>:<value>`, fields joined with `|`,
  hashed as UTF-8, hex-encoded. NULL counts as empty. Field order:
  audit_log = prev_hash, id, seq, patient_id, actor_uid,
  actor_email, action, changed; event_log = prev_hash, id, seq,
  actor_uid, actor_email, event, patient_id, details, ip.
  `created_at` is excluded (its text form differs between SQL and
  JS). JSONB fields use Postgres's jsonb text output — which puts
  a space after every structural colon and comma, NOT the compact
  form `JSON.stringify` produces; the JS side reproduces the
  Postgres form (`jsonbText` in `lib/hashChain.js`). Character
  count is Postgres `length()`; the JS side counts Unicode code
  points, which agrees for all valid input.
- **seq is assigned by the trigger, under lock.** Each chain
  trigger takes a per-table advisory transaction lock (audit_log
  key 727001, event_log key 727002), then sets
  `NEW.seq = MAX(seq) + 1` and reads the last hash. Assigning seq
  inside the lock (rather than trusting the BIGSERIAL default, which
  fires before the lock) guarantees seq order always equals chain
  order, even when a fire-and-forget request-log insert races a
  synchronous event insert.
- **Verification.** `GET /events/verify` (token-verified,
  allowlisted) recomputes both chains and reports
  `{ total, legacy, checked, valid, first_break }` per table. The
  operator script does the same read-only check from the shell:
  `node scripts/verify-chain.js` (uses the `PG*` env vars, exit 0
  when all valid, 1 otherwise). Rows with NULL hashes predate
  chaining and are reported as `legacy` (skipped, never "broken"):
  the chain is only claimed from the first hashed row onward. A
  break stops the walk at the first bad row, reported by `seq` and
  `id` with reason (`prev_hash mismatch` or `row_hash mismatch`).
- **Dashboard Audit Log view.** The dashboard's System → Audit Log
  view lists events with filters for user email, event type, date
  range, and patient, plus limit/offset paging and a chain-validity
  badge from `/events/verify`. Dashboard sign-in reports `sign_in`
  and sign-out reports `sign_out` (best-effort, before the Firebase
  sign-out, since the call needs the token). When the API is not
  configured or is unreachable, the view says so instead of showing
  demo data. `report_export` is accepted by `POST /events` for
  future use; the dashboard does not report it yet.
- **Deliberately NOT built (left for later, as approved):**
  configurable event categories (the vocabulary is fixed in a
  CHECK constraint) and ATNA/syslog forwarding to an external
  server.

## Users table + manager PIN override (migration: `schema-users.sql`)

Staff directory modeled on OpenEMR's `users` table (core fields only),
kept separate from `patients` the way OpenEMR separates `users` from
`patient_data`. Logins stay in Firebase Auth — the row links by
`firebase_uid` / email and NEVER stores a password. Two fields do
different jobs: `role` (clinician, manager, admin, developer, support,
billing, front_office) says what the user's job is; `authorized`
(OpenEMR's provider flag) says whether they can be assigned patients.

Patient update / soft-delete / restore are gated by a **manager
override PIN** (built 2026-10-29 at Jake's direction, replacing the
demo's original client-side PIN constant, which anyone could read in
the dashboard bundle):

- Each manager/admin user has their own PIN, stored only as a scrypt
  hash in `users.pin_hash` (lib/pin.js; Node crypto, no extra deps).
- Any active manager/admin's PIN authorizes a write — the PIN belongs
  to the authorizing manager, not to the signed-in user. The API
  records which manager authorized each override as an `admin_action`
  event (details: action + manager id/email/role) in the same
  transaction as the change.
- Enforcement is `lib/requireManagerPin.js` on the three routes;
  `POST /users/verify-pin` exists only so the dashboard can check the
  PIN before opening the edit form — it grants nothing by itself.
- Staff management writes (create / update / deactivate / reactivate
  a `users` row) are gated by the same middleware — managing who is
  on the team is a manager act. "Delete" is a deactivate
  (`active = false`), never a hard delete, and restore undoes it.
  Each write logs an `admin_action` event (`user_create` /
  `user_update` / `user_deactivate` / `user_reactivate`) naming the
  target and the authorizing manager. Tests:
  `node e2e-users-mgmt-test.js`.
- CORS must allow the `X-Manager-Pin` header (server.js does).
- Seed demo staff with `node seed-users.js`: Jake's two sign-in
  accounts (admin + manager, demo PIN **1234**, hashed) plus fictional
  clinician / front-office / developer users. Re-running the seed
  resets the demo PINs. To set a real PIN, hash it with
  `require('./lib/pin').hashPin(pin)` and UPDATE the row — never store
  a plaintext PIN anywhere.
- Tests: `node e2e-users-test.js` covers the gate matrix, attribution,
  and the directory endpoints; the patients/events suites send a test
  PIN on their gated calls.

## What this is NOT yet (read before real use)

- **No TLS on this process itself.** It binds localhost only; TLS comes
  from the reverse proxy (Caddy) in front of it on the VM, serving
  `api.marcinnotech.net`. Do not expose this port publicly without TLS.
- **No BAA, no company entity yet.** Audit history and soft delete are
  done; the BAA and incorporation still gate real patient data.
- **No real patient data.** Fictional demo patients only, until the
  gates above are done.
- **Audit snapshots are not redacted.** `ss` and `drivers_license`
  appear verbatim in `audit_log` snapshots. Field-level redaction of
  audit snapshots MUST be built before any real data is stored (see
  the patients v2 warning above).

## What remains (outside this local build)

- Provision the Marc Innotech VM (GCP e2-micro, us-central1, always-free
  tier) with Postgres + this API.
- Caddy (or certbot) TLS for `api.marcinnotech.net`, DNS A record to the
  VM, and `DASHBOARD_ORIGIN` set to the live dashboard origin.
- Dashboard `VITE_API_URL` set to the live API URL, then a dashboard
  redeploy. Until then the dashboard falls back to its in-browser demo
  data whenever the API is unset or unreachable — and shows a visible
  banner when that fallback is in use.

## Deploy-time checks (must be run against the live VM — they were NOT
testable here, because local testing used a stubbed auth middleware;
see the second-pass report)

- Sign into the live dashboard and confirm the patient list loads from
  the API (no fallback banner) with a real Firebase ID token.
- Exercise add → update → soft-delete → restore → audit trail through
  the live API and confirm each step, including that a soft-deleted
  patient disappears from the list but keeps its audit trail.
- Confirm unauthenticated requests get 401 and a signed-in but
  non-allowlisted account gets 403.
- Confirm `https://api.marcinnotech.net/health` answers over TLS and
  plain `http://` redirects to `https://`.
- Audit core (after `schema-events.sql` is applied on the VM):
  `GET /events/verify` reports valid chains for both tables;
  `node scripts/verify-chain.js` agrees; the dashboard System →
  Audit Log view loads, filters, and pages; sign-in and sign-out
  each add one event row (no double row from request logging);
  a profile read adds a `patient_view` row; a no-token call adds
  an `auth_failure` row under the `anonymous` actor.
- Patients v2 (after `schema-patients-v2.sql` is applied on the VM
  **as the table owner**, followed by `npm run seed` and the runtime
  grants from the prerequisites):
  `\d patients` shows no `name` / `address` / `phone` / `age_band`
  columns and does show the 43 v2 columns; the seeded list shows
  split names (preferred name when set), zone, status, and
  clinician; the Patient Profile shows the v2 detail groups; an
  Add Patient save with first + last name succeeds, and creates
  without them are 400; `GET /events/verify` still reports valid
  chains (the v2 migration must not disturb the audit core).
