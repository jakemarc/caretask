# Data Model

Last updated: 2026-11-01
Database: `caretask_demo` (PostgreSQL 16) on the API VM.
Schemas (apply in this order): `patient-api/schema.sql`,
`schema-events.sql`, `schema-patients-v2.sql`,
`schema-patients-map.sql`, `schema-users.sql`,
`schema-users-position.sql`, `schema-appointments.sql`,
`schema-messages.sql`,
`schema-documents.sql`, `schema-agencies.sql`,
`schema-agencies-cms.sql`, `schema-patients-agency.sql`,
`schema-patients-age.sql`, `schema-expense-reports.sql`,
`schema-expenses.sql`, `schema-mileage-chains.sql`,
`schema-patient-merge.sql`, `schema-tasks.sql`.

Tables: `patients`, `users`, `appointment_categories`,
`appointment_statuses`, `appointments`, `messages`, `documents`,
`agencies`, `expense_reports`, `mileage_entries`, `expenses`,
`patient_merge_marks`, `patient_merges`, `clinician_tasks`,
`audit_log`, `event_log` (16 in total).

## patients (v2 — 48 columns)

Split name/address/phone (v2 migration, 2026-10-29, replaced the
single `name`/`address`/`phone` columns and dropped `age_band` —
age derives from date of birth when one is recorded; the
stored `age` column below covers patients whose birth date
is unknown).

| Group | Columns |
|---|---|
| Identity | id, title, fname*, mname, lname*, suffix, preferred_name, date_of_birth, age, sex |
| Demographics | race, ethnicity, language, occupation, interpreter_needed (bool, default false) |
| Address | street, street_line_2, city, state, postal_code, country_code, latitude, longitude (double precision, range-checked; NULL unless captured from an autocomplete pick) |
| Contact | phone_home, phone_cell, email |
| Care | zone (green/yellow/red), flags, notes, clinician (free text), status (active/hold/discharged, default active), referrer |
| Consent | hipaa_allowsms (bool), hipaa_allowemail (bool) |
| Emergency | emergency_contact_name, emergency_contact_relationship, emergency_contact_phone |
| Sensitive | ss, drivers_license — stored + audited, but NOT displayed or enterable in the dashboard UI (deliberate minimization) |
| Billing | billing_note, pricelevel (default 'standard'), financial, pharmacy_id (integer, no FK — a reference number, not a relation) |
| Agency | agency_id (BIGINT, FK → agencies.id, NULL), agency_name_text (TEXT, NULL) — `schema-patients-agency.sql`, built locally 2026-10-30, not yet deployed |
| System | created_at, updated_at, deleted_at (soft delete) |

\* NOT NULL. Modeled on OpenEMR's `patient_data` core fields.

Age fallback (`age`, added 2026-11-01 by
`schema-patients-age.sql` — additive, idempotent, LIVE on the
VM since deploy-17, 2026-11-01): INTEGER, NULL, CHECK 0–130.
Date of birth and sex are OPTIONAL on patient create (Jake,
2026-11-01 — reversing the 2026-10-30 required rule), so a
patient can exist with no birth date; `age` records their age
in years for that case. Display rule: an age derived from
date_of_birth wins; `age` is consulted only when there is no
usable DOB. A stored age does not advance on its own.

Agency tag (`agency_id` / `agency_name_text`, added 2026-10-30
by `schema-patients-agency.sql` — additive, idempotent): a
patient's home health agency is EITHER a directory link
(`agency_id` → agencies) OR a free-text name
(`agency_name_text`, for agencies not in the directory) OR
neither — never both (the API stores the text as NULL when an
id is set). Patients change agencies over time; changes go
through the PIN-gated edit and the audit_log before/after
snapshots carry both columns, so agency history is preserved
in the audit trail. Seeds do not assign agencies.

Map coordinates (`latitude`/`longitude`, added 2026-10-30 by
`schema-patients-map.sql` — idempotent, non-destructive) are
captured when a clinician picks an address-autocomplete suggestion
in the dashboard; hand-typed addresses leave them NULL and the
dashboard geocodes those patients on map load instead. They are
part of the row like the address itself, so they appear in audit
snapshots the same way.

Seed: 8 fictional patients (seed.js) — SSNs in the never-issued
900-01-xxxx range, licenses literally `EXAMPLE-DL-000x`, 555 phone
numbers, `.example` emails.

## users (staff — 36 columns)

Modeled on OpenEMR's `users` table core fields, plus the fields
OpenEMR splits out that we keep inline. In OpenEMR, clinicians are
not a separate table — they are `users` rows with the `authorized`
(provider) flag; we follow that model and add an explicit `role`.

| Group | Columns |
|---|---|
| Link/identity | id, firebase_uid (unique), email* (unique, lowercase CHECK), fname*, mname, lname*, suffix, title, position, valedictory |
| Role & status | role (clinician / manager / admin / developer / support / billing / front_office; default clinician), authorized (bool — can be assigned patients), active (bool — deactivation instead of deletion). `position` (added by `schema-users-position.sql`, 2026-10-30) is the person's job position (e.g. "Physical Therapist", "Clinical Manager") — distinct from the system `role` and the free-text `title`; the dashboard offers a dropdown of common home-health positions but the column is plain TEXT |
| Credentials (professional) | npi, taxonomy, specialty, physician_type, state_license_number, federaldrugid, federaltaxid |
| Workplace | facility, facility_id (integer, no FK), organization |
| Contact/address | street, city, state, zip, phone, phonecell, fax |
| Other | info, notes |
| Security | pin_hash — scrypt hash (`scrypt$<salt>$<key>`), NULL until a PIN is set; NEVER returned by the API |
| System | created_at, updated_at (trigger-maintained) |

Seed: 5 rows (seed-users.js) — Jake's two accounts (admin +
manager, authorized, demo PIN 1234 hashed) and three fictional
staff. Re-running the seed resets demo PINs to 1234.

Grants: the runtime DB user has SELECT/INSERT/UPDATE on `users` —
deliberately NO DELETE grant; staff are deactivated, never deleted.

## appointment_categories / appointment_statuses / appointments

The calendar model, correlated with OpenEMR's
(`openemr_postcalendar_categories` / `list_options` 'apptstat' /
`openemr_postcalendar_events` — full mapping in
`schema-appointments.sql`'s header):

- **appointment_categories**: id, name (unique), color,
  description, cattype (appointment | provider), default_duration_min,
  active. Seeded (home-health terminology, Jake 2026-10-30):
  Initial Evaluation 60, Start of Care 90, Resumption of Care 60,
  Revisit 45, Reassessment 60, Transfer 30, Discipline Discharge
  45, Admin Discharge 30, OASIS Discharge 60; provider blocks
  In Office / Out of Office / Lunch / Vacation.
- **appointment_statuses**: code (PK), label, color, is_checkin,
  is_checkout (OpenEMR's toggle_setting_1/2), sort_order. Seeded:
  booked, confirmed, arrived (check-in), in_room, checked_out
  (check-out), cancelled, no_show.
- **appointments**: id, patient_id (UUID FK → patients; NULL for
  provider events), provider_id (FK → users), category_id (FK),
  title, starts_at / ends_at (timestamptz, CHECK ends > starts),
  status (FK → appointment_statuses), room, notes, created_at,
  updated_at, deleted_at (soft delete). Mutations log
  `appointment_change` events (status changes carry from/to;
  PIN-gated writes name the manager).

## messages

Staff messaging (Phase 1, 2026-10-30; OpenEMR Messages center +
chart messages): id, thread_id (a root message's thread is
itself), sender_id (FK → users), recipient_id (FK → users,
NULL for chart-only messages), patient_id (UUID FK → patients,
NULL for pure staff messages) — CHECK at least one of
recipient/patient is set. subject, body, read_at (the read
receipt), created_at, deleted_at (soft delete, sender-only).
Sends/reads log `message_send` / `message_read` events —
metadata only, never the body.

## documents

Clinical documentation (2026-10-30, LIVE — deployed 2026-10-30;
OpenEMR encounter-forms pattern: a document is a form attached
to a patient, optionally to the appointment/encounter it belongs
to): id, patient_id (UUID FK → patients, NOT NULL),
appointment_id (FK → appointments, NULL), author_id (FK →
users), doc_type (evaluation | reassessment | discharge),
title, sections JSONB (template key → note text; the template
section definitions live in `patient-api/lib/documentTemplates.js`
and are mirrored in the dashboard's
`src/lib/documentTemplates.ts`), status (draft | finalized,
default draft), finalized_at / finalized_by (FK → users) —
finalizing locks the document against edits (OpenEMR's e-sign
pattern), created_at, updated_at, deleted_at (soft delete,
manager-PIN gated; restore endpoint exists). Mutations log
`document_create` / `document_update` / `document_finalize`
events — ids and doc_type only, never section content.

## agencies

The IDPH home health agency directory (2026-10-30, LIVE —
deployed 2026-10-30, 595 rows synced; `schema-agencies.sql`): one row per licensed
Illinois home health agency, imported from the IDPH Home Health
Agency Directory on Illinois' Socrata portal (dataset
`p7mg-cnpx`; verified 595 rows, rowsUpdatedAt 2026-04-28 — see
`~/workspace/marc-innotech/agency-directory-research.md`).
`license_number` (unique — the upsert key; IDPH state license,
the source publishes no CMS CCN), `name` (the full published
facility name), `dba` (parsed out of "… - DBA …" in the name
when present), street / city / `state` (always 'IL') /
postal_code / county, phone, admin_contact_name,
license_expiration_date, `source` ('idph'), source_updated_at,
last_synced_at, `active` (a sync marks agencies missing from
the latest import inactive — never hard-deletes; no DELETE
grant), created_at / updated_at. LOCAL fields a sync never
overwrites: `is_primary` (our agency; at most one row, partial
unique index `agencies_one_primary_idx`), `notes`, `short_name`.
CMS enrichment columns (`schema-agencies-cms.sql`, ADDITIVE,
built locally 2026-10-30 — not yet deployed): matched from the
CMS Provider Data "Home Health Care Agencies" dataset
(`6jpm-sxkc`) by the sync's second pass — `ccn` (CMS
Certification Number), `offers_nursing` / `offers_pt` /
`offers_ot` / `offers_speech` / `offers_msw` / `offers_hha`
BOOLEAN service lines, `star_rating` NUMERIC(2,1) (CMS quality
of patient care; NULL when CMS doesn't rate the agency),
`cms_ownership`, `cms_cert_date`, `cms_matched_at`. All
nullable — an unmatched agency carries NULLs. These are
CMS-owned source fields (a sync may overwrite them); the
local fields above are never touched by either pass. Live
match measurement 2026-10-30: 483 of 595 IDPH agencies
matched a CMS row (386 with a star rating).
The dashboard's `display_name` is computed by the API per
response: short_name → dba → first two words of name → full
name (when ≤ 2 words). Syncs log one `agency_sync` event with
counts only. BIGINT identity id (a directory table like
users/appointments, not patients — agency ids never travel in
URLs or event payloads the way patient UUIDs do).

## expense_reports

The monthly envelope (Jake's model, 2026-11-01;
`schema-expense-reports.sql`; built locally and deployed
2026-11-01, deploy-18): id (BIGINT identity — auto-generated, never
typed or edited), `user_id` (BIGINT, FK → users.id — the
report's owner, by id never by name), `agency_id` (nullable),
`title` (friendly name; NULL → the UI generates one from
period + agency), `period_start` / `period_end` (DATE,
end ≥ start), `status` (draft / submitted / approved /
rejected / paid — submission, approval, and payment are
properties of the WHOLE report), `submitted_at`,
`approved_by` (FK → users), `approved_at`, `paid_at`,
`payment_ref`, `notes`, created_at / updated_at / deleted_at
(soft delete; runtime user has no DELETE grant). 16 columns.

## mileage_entries

The individual drives inside a report (same schema file):
id, `expense_report_id` (FK → expense_reports), `entry_date`,
`seq`, `entry_kind` (business = a driven leg / commute = the
day's home↔home-office deduction leg), start/end address
text + coordinates, `appointment_id` (nullable FK),
`miles_toll` / `miles_no_toll` (both routing figures stored
so the report shows its work), `used_tollway`, `round_trip`,
`business_miles` (the leg's FINAL miles — chosen route's
figure, user-correctable), `rate_per_mile` (per-entry
snapshot, nullable), `vehicle`, `notes`, timestamps,
deleted_at. 21 columns. **Day math (API-side):** daily
reimbursable = max(0, Σ business miles − Σ commute miles);
mileage dollars come from reimbursable miles × the day's
rate when every entry is rated.

## expenses

One row per non-mileage expense LINE inside a report
(`schema-expenses.sql`, built locally 2026-10-31, revised
2026-11-01 to the report model, deployed 2026-11-01 with
deploy-18):
id (BIGINT identity), `report_id` (BIGINT, FK →
expense_reports.id, required — lines belong to a report),
`user_id` (BIGINT, FK → users.id — the connection to staff
is by id, never by name; the employee name shown in lists is
read from `users` with a JOIN), `expense_date`, `category`
(CHECK list of the twelve standard categories: mileage,
parking, tolls, medical_supplies, office_supplies, meals,
travel, lodging, phone_internet, training, licenses, other),
`description`, `vendor_name`, `amount_cents` (INTEGER ≥ 0 —
money is integer cents, never floats), `currency` (default
'USD'), `payment_method` (personal_card / company_card /
cash / other, nullable), `receipt_url`, `agency_id` (BIGINT,
FK → agencies.id, nullable), `notes`, created_at /
updated_at / deleted_at (soft delete; the runtime user has
no DELETE grant). 17 columns. There are NO lifecycle columns
here — the draft → submitted → approved → paid lifecycle
moved up to `expense_reports` when the report model was
adopted (2026-11-01); the pre-revision 21-column lifecycle
version was never deployed, so the revision is in place.
Verified locally: full schema chain applies with the new
files, both apply twice, FK/CHECK constraints reject bad
user ids, categories and negative amounts, the JOIN returns
the right name even for two staff with identical names, and
the expenses API suite passes end to end (42 checks incl.
day math, lifecycle, PIN gates, cross-user isolation).

## patient_merge_marks / patient_merges (deploy-28)

Duplicate bookkeeping (`schema-patient-merge.sql`).
`patient_merge_marks`: one open mark per unordered patient pair
(normalized low/high UUID pair as the primary key); a mark
closes by stamping `deleted_at` (there is no DELETE grant).
`patient_merges`: survivor/loser ids, the acting manager,
`moved_ids` JSONB holding the exact row ids re-pointed in
appointments / documents / messages / mileage_entries (that
record is what makes Undo exact), and `undone_at` / `undone_by`.

## clinician_tasks (deploy-28)

Per-clinician reminders (`schema-tasks.sql`): `user_id` owner
(FK → users), `patient_id` (nullable FK → patients), `title`
(≤300), `notes`, `due_at`, `done_at`, soft delete via
`deleted_at`. Owner-scoped at the API — no other clinician can
read or address a row.

## Platform tables (Live — deploy-35, 2026-11-03, schema-platform.sql)

The multi-user platform (spec:
`~/workspace/marc-innotech/multi-user-platform-spec.md`). All
six tables are new; `appointments` gains one column. The schema
file is idempotent and runs LAST in the chain (it also widens
the `event_log` CHECK with the platform event types).

- `user_agencies` — agency memberships: PK (user_id, agency_id),
  both FKs CASCADE. Self-managed via `/users/me/agencies`.
- `patient_links` — per-user patient lists: PK (user_id,
  patient_id), both FKs CASCADE; `list_status` CHECK
  active/hold/discharged; `removed_at` soft-unlink. The
  patient's LIST status lives here now, not on the registry row.
- `patient_episodes` — UUID PK; patient_id (CASCADE), agency_id,
  primary_user_id, `case_manager_user_id` (FK → users; the
  clinical coordinator — addendum 2026-11-03), status CHECK
  active/on_hold/discharged, admitted_at DATE, discharged_at,
  `discharge_reason` CHECK (completed / patient_declined /
  transferred_agency / transferred_inpatient /
  moved_out_of_area / physician_order / deceased / other),
  discharge_note, `recert_of` self-FK (recertification chain),
  created_by, deleted_at. **Partial unique index
  `patient_episodes_one_active_idx` UNIQUE (patient_id) WHERE
  status IN ('active','on_hold') AND deleted_at IS NULL** —
  the one-live-episode rule is enforced by the database, not
  by convention; a held episode still owns the patient.
- `episode_members` — PK (episode_id, user_id), both FKs
  CASCADE; member_role CHECK primary/member; `supervised_by`
  (nullable FK → users, the PTA→PT pointer); added_by;
  removed_at (leaving the team stops future visibility; past
  visits stay).
- `episode_holds` — (addendum 2026-11-03) BIGINT identity PK;
  episode_id (CASCADE); reason CHECK hospitalized /
  patient_request / physician_order / other; note; started_on /
  ended_on DATEs (the open hold has ended_on NULL);
  started_by / ended_by. One row per hold, so pause time is
  accountable across multiple holds.
- `invites` — BIGINT identity PK; email; role CHECK (same set
  as users.role); `code_hash` TEXT UNIQUE (SHA-256 of the code —
  the raw code exists only in the create response); invited_by;
  expires_at (7 days); accepted_by/accepted_at; revoked_at.
  Status is derived, never stored.
- `patient_duplicate_dismissals` — Known Non-Duplicates: PK
  (patient_id, fingerprint) where the fingerprint is a SHA-1 of
  the normalized intake (first|last|DOB); dismissed_by. A pair
  stored here suppresses future near-match prompts for that
  intake; exact matches are never suppressed.
- `appointments.episode_id` — UUID FK → patient_episodes, ON
  DELETE SET NULL. Stamped by the booking gate; pre-platform
  rows keep NULL until the platform migration stamps them.

## audit_log (patient change history)

id, patient_id, actor_uid, actor_email, action
(create/update/soft_delete/restore), changed JSONB `{before,
after}` (full row snapshots), created_at, + hash-chain columns
(seq, prev_hash, row_hash). Append-only: triggers reject
UPDATE/DELETE. Written in the same transaction as the change it
records.

## event_log (security & activity)

id, seq, actor_uid, actor_email, event (patient_view / sign_in /
sign_out / report_export / auth_failure / admin_action /
api_request / appointment_change / message_send / message_read /
document_create / document_update / document_finalize /
agency_sync / expense_change — the last added by
`schema-expenses.sql`, local only; the platform adds
patient_link / patient_unlink / episode_create /
episode_discharge / episode_team / episode_hold / episode_resume /
episode_case_manager / invite_create / invite_accept /
agency_membership — Live, deploy-35, 2026-11-03),
patient_id (nullable, **no FK by design** — events
about deleted/unknown patients must still record), details JSONB,
ip, created_at, prev_hash, row_hash. Append-only, same triggers.

HTTP request logging folds into this table: method/path/status
only — never tokens, never bodies. 401/403 responses on
auth-excluded paths are still logged as `auth_failure`.

## Hash chain (audit_log + event_log)

Rows are chained in `seq` order: each row's `row_hash` =
SHA-256 over a canonical string (length-prefixed fields joined
with `|`, NULL rendered empty, `created_at` excluded) that
includes the previous row's hash. Rows with NULL hashes are legacy
(pre-chain) and skipped by the verifier. Verify via
`GET /events/verify` or `scripts/verify-chain.js`.

## Invariants to protect

1. Audit tables are append-only — no code path updates or deletes
   from them, ever.
2. `pin_hash` never leaves the API.
3. Patients and staff are soft-deleted/deactivated only.
4. Migrations run as the table OWNER (see DEVELOPMENT.md) and
   re-grant the runtime user afterwards.
