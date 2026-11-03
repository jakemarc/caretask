# CareTask Multi-User Platform — Spec

Status: BUILT LOCALLY 2026-11-03 (API + dashboard, all suites
green, docs updated) — deployment awaits Jake's go, with
`migrate-platform.sql` reviewed before it runs live. Written
the same day from Jake's design session: blank per-user app →
master registry → episodes with teams → invite-only. OpenEMR,
Epic, and HCHB comparisons (all 2026-11-03) folded in where
they informed a choice:

- **Episode = one level = the 60-day certification period**
  (HCHB's working container; recertification opens a new
  episode chained to the old one). Epic's extra admission-long
  level above the cert period is deliberately NOT modelled in
  v1 — scheduling/transfer behavior is identical without it.
- **Primary + members mirrors HCHB's Case Manager + Team
  Members**; OpenEMR's 7.x "care team" is only three fields
  and gates nothing, Epic's is richer but access there is not
  team-gated either — our team-gated access is a deliberate
  home-health choice, stricter than both.
- **Duplicate handling is stricter than all three**: OpenEMR
  warns-and-confirms, Epic scores probabilistically and lets
  the registrar proceed, HCHB has no public evidence of any
  automatic check. Ours hard-blocks exact matches (Jake's
  call).
- **Coverage visits — ADOPTED (Jake, 2026-11-03, "combine the
  advantages of each system"):** HCHB's rule. A colleague who
  works for the episode's agency may take a SINGLE visit
  without joining the team (a series stays team-only — planned
  care belongs to the team), and chart access rides on that
  visit: a non-cancelled appointment within ±7 days grants
  read access to the chart, HCHB-style. Implemented in the
  booking gate (applyEpisodeGate) and hasChartAccess.
- **Known Non-Duplicates — ADOPTED (from Epic, 2026-11-03):**
  when a POSSIBLE_MATCH is reviewed and the create confirmed,
  the (candidate, intake-fingerprint) pair is stored in
  patient_duplicate_dismissals and never prompts again for the
  same intake data. Exact matches are never suppressed.

## 1. Principles

1. **The registry is ours.** A real person exists exactly once
   in `patients` — the platform's master table. Users never
   create a second record for the same person.
2. **Lists are personal.** What a user "has" is a set of links
   (`patient_links`) to registry patients. Their list, their
   calendar, their mileage — scoped to them.
3. **Episodes are the unit of sharing.** Clinical work on a
   patient happens inside an episode at one agency, worked by
   a team. Sharing = being on the episode's team. Nothing else
   grants chart access.
4. **One active episode per patient, system-wide.** Enforced
   by the database (partial unique index), not by convention.
   A transfer requires the current episode to be discharged
   first.
5. **Invite-only.** No public sign-up. A platform admin
   invites by email; accepting provisions the account and an
   empty workspace.

## 2. Data model

New tables (migration `schema-platform.sql`):

- `user_agencies` — (user_id → users.id, agency_id →
  agencies.id, created_at). PK (user_id, agency_id). "The
  agencies I work for." A user may have several.
- `patient_links` — (user_id, patient_id, list_status
  ['active'|'hold'|'discharged'] default 'active', created_at,
  removed_at). PK (user_id, patient_id). The per-user list;
  list status lives HERE now, not on the patient (the old
  `patients.status` column remains for legacy/demo data and
  is no longer the source of truth for lists).
- `patient_episodes` — (id UUID, patient_id, agency_id,
  primary_user_id → users.id, status ['active'|'discharged'],
  admitted_at date, discharged_at date, discharge_note text,
  created_by, created_at, updated_at). Partial unique index:
  `UNIQUE (patient_id) WHERE status='active' AND
  deleted_at IS NULL` — one active episode per patient.
  Soft-delete via deleted_at (consistent with the rest of the
  schema). `recert_of` — nullable self-FK marking an episode
  created by recertifying a previous same-agency episode.
- `episode_members` — (episode_id, user_id, member_role
  ['primary'|'member'], supervised_by → users.id nullable,
  added_by, added_at, removed_at). PK (episode_id, user_id)
  with removed_at for history (re-adding clears removed_at).
  The primary is also a member row (member_role='primary').
- `invites` — (id, email (lowercased), role default
  'clinician', code (random 32 chars), invited_by → users.id,
  expires_at, accepted_by → users.id nullable, accepted_at,
  revoked_at, created_at). One live invite per email
  (re-inviting supersedes).

Altered:

- `appointments.episode_id` UUID nullable → patient_episodes.
  NULL = legacy (pre-platform) or non-patient block. New
  patient bookings must set it (see §5).
- `patients` — unchanged as the registry. Created-by is
  recorded in the event log (patient_create), not a column.
- `users` — unchanged. Platform admin := role IN
  ('admin','developer') (Jake's admin account today).

New event types (event_log CHECK list grows — one migration
to extend it): `patient_link`, `patient_unlink`,
`episode_create`, `episode_discharge`, `episode_team`,
`invite_create`, `invite_accept`, `agency_membership`.

## 3. Identity & access

- `requireAuth` changes: a verified Firebase token is no
  longer enough. The caller must resolve to an **active staff
  record** (users row matched by firebase_uid, else by
  email) — otherwise 403 `NO_STAFF_RECORD`. This replaces
  ALLOWED_EMAILS as the gate (the env check is removed; the
  invite system is the perimeter now). Exception:
  `POST /invites/accept` accepts a verified token with no
  staff record yet (it creates it).
- **Chart access** to a patient (detail, documents, messages,
  master calendar): caller is linked to the patient, OR is
  a current member of any episode of the patient (active or
  discharged — history stays readable to those who worked
  it), OR is platform admin. Otherwise 404 (not 403 — don't
  confirm existence).
- **Patient list** (`GET /patients`): only the caller's
  linked patients (list_status carried from the link).
  Platform admins additionally see an `?all=1` registry view
  (for dedupe/merge administration) — not the default.
- **Staff directory** (`GET /users/clinicians`): users who
  share ≥1 agency membership with the caller, plus the
  caller; platform admins see everyone. (Team assignment
  picks from this list.)

## 4. Patient flows

### Add patient (POST /patients)
1. **Exact duplicate** — same normalized fname + lname +
   date_of_birth as a non-deleted registry patient → **409
   `PATIENT_EXISTS`** with `{ patient_id, name, dob, city }`
   (only what dedupe needs). No record created. The UI
   offers **Add to my list** (POST link). This is stricter
   than OpenEMR (warn-and-confirm) — Jake's call.
2. **Near match** — same DOB + similar name (trigram /
   soundex-lite on last name), OR same phone number, OR
   same email → **409 `POSSIBLE_MATCH`** with up to 3
   candidates `{ patient_id, name, dob, city }`. The client
   may resubmit with `confirm_create: true` to create
   anyway (the choice is event-logged), or link instead.
3. Clean → create the registry patient, auto-link to the
   creator (list_status 'active'), 201.

DOB-less adds: exact check falls back to name + phone/email;
a name-only add with an existing same-name patient is a
near match (prompt), never a hard block (names collide
legitimately).

### Link / unlink
- `POST /patients/:id/link` — adds to caller's list
  (idempotent; revives a removed link). Event `patient_link`.
- `DELETE /patients/:id/link` — removes from caller's list
  (removed_at). The registry patient is untouched; the
  caller's appointments/documents remain in history but the
  patient leaves their list and chart access via link ends
  (episode access, if any, is separate).
- `PUT /patients/:id/link` { list_status } — per-user
  Active / On hold / Discharged.

### CSV / Paste / contacts imports
All creation paths run the same server-side duplicate
rules. CSV import reports per-row: created / linked /
blocked-duplicate / possible-match (skipped, listed for
manual review). The dashboard's client-side dup panel is
replaced by these server responses.

## 5. Episodes

- `POST /patients/:id/episodes` { agency_id } — caller must
  be a member of that agency (`user_agencies`) and have
  chart access via link. Creates the episode with caller as
  primary + sole member. If an active episode already
  exists (any agency) → **409 `EPISODE_ACTIVE`** with
  `{ agency_name, primary_name, admitted_at }` — enough to
  coordinate the discharge, no clinical detail.
- `POST /episodes/:id/discharge` { discharged_at?,
  discharge_note? } — primary clinician, or a manager/admin
  who is a member of the episode's agency. Sets status +
  stamps members' history (memberships remain as history).
- `POST /episodes/:id/recertify` — same-agency only:
  discharges this episode and opens a new one at the same
  agency with the team copied (recert_of set). One call, so
  recertification never looks like a transfer.
- Team:
  - `POST /episodes/:id/members` { user_id, supervised_by? }
    — primary or agency manager/admin. The added user must
    be a member of the episode's agency. Auto-links the
    patient to the member's list.
  - `DELETE /episodes/:id/members/:userId` — primary or
    agency manager/admin; sets removed_at (history kept);
    the patient link stays (removing the link is the
    member's own action) but chart access via this episode
    ends for future scheduling; past appointments remain.
  - The primary cannot be removed; transfer of primary =
    `PUT /episodes/:id/primary` { user_id } (new primary
    must already be a member).
- `GET /patients/:id/episodes` — episode history for the
  chart (access per §3): agency, primary, team (current +
  past), dates, status.

### Booking gate (appointments)
- Creating an appointment **with a patient**: the patient
  must have an active episode; the appointment takes that
  episode_id; the **provider must be a current team member**
  of the episode (unassigned provider = allowed only if the
  booker is on the team; the visit can be assigned later by
  a team member). Violations: 409 `NO_ACTIVE_EPISODE`,
  403 `NOT_ON_TEAM`.
- Non-patient appointments (provider blocks) are unaffected.
- Series creation applies the same gate once, to all visits.
- Rescheduling an existing appointment keeps its episode;
  moving it to a provider off the team → 403 `NOT_ON_TEAM`.

### Calendars
- Personal: `GET /appointments` default scope = appointments
  where provider = caller (plus unassigned appointments on
  episodes the caller is a team member of, so primaries see
  unassigned case visits).
- Master (per patient): `GET /appointments?patient_id=`
  returns all appointments for that patient across episodes
  (chart access required), each with provider name — the
  patient's chart shows this as its schedule.
- The dashboard Calendar tab uses the personal scope; the
  patient profile's schedule uses the patient scope.

## 6. Invites & provisioning

- `POST /invites` { email, role? } — platform admin only.
  Creates (or supersedes) an invite, 7-day expiry. Returns
  the invite link path `/accept-invite?code=…` for the admin
  to send (no email sending from the API in v1 — the admin
  sends it through their own channel; sending via Gmail is a
  later nicety).
- `GET /invites` — platform admin: pending / accepted /
  expired, with who accepted.
- `DELETE /invites/:id` — revoke.
- `POST /invites/accept` { code } — verified Firebase token,
  no staff record required. The token's email must match
  the invite email (case-insensitive) and the invite must be
  live. Creates the staff record (email, firebase_uid, role
  from invite, active, authorized = true — an invited
  clinician is meant to work), marks the invite accepted.
  The new workspace is blank **by construction**: no links,
  no agencies, no appointments.
- Dashboard: an "Accept invite" view (code from the link,
  or pasted) → creates the Firebase account (email +
  password) or signs in → calls accept → lands in the empty
  app. The login screen gains a quiet "Have an invite?"
  path; there is still no public registration form.

## 7. Migration of existing data

One data migration (`migrate-platform.sql`), reviewed
before it runs on the live DB:

1. **Links**: every existing patient is linked to Jake's
   staff row (the authorized one that owns his appointments)
   and to any other staff user who has ≥1 appointment with
   that patient. list_status from the patient's current
   status column.
2. **Episodes**: for each patient WITH an agency: one active
   episode at that agency; primary = provider of the
   patient's earliest appointment, else Jake; members = all
   distinct providers of the patient's appointments (+
   primary). admitted_at = earliest appointment date, else
   today. The patient's appointments are stamped with it.
3. Patients without an agency: linked, no episode
   (legacy). Their appointments keep episode_id NULL and
   stay visible to their providers; the booking gate
   applies to NEW bookings (which will need an episode —
   the UI prompts to start one).
4. **Agency memberships**: Jake is added to the agencies
   that appear on his patients/appointments (so his world
   keeps working); other seeded staff get memberships for
   the agencies on their appointments.
5. The 8 fictional seed patients + demo staff stay as-is
   under the same rules (they're part of Jake's demo data).

## 8. Dashboard work

- Login screen: "Have an invite?" → Accept-invite view
  (email, password, code prefilled from the link) →
  provisions and lands blank.
- Settings (admin): **Invites** card — create by email,
  copy link, list + revoke.
- Settings (everyone): **My agencies** card — search the
  directory, add/remove the agencies I work for.
- Add Patient: server-driven duplicate UX — 409
  PATIENT_EXISTS → "Already in our database" panel with
  Add-to-my-list; POSSIBLE_MATCH → candidate list with
  "Add this one instead" / "Create anyway". CSV import maps
  the new per-row outcomes.
- Patients list: unchanged visually (it renders what the API
  returns — now the caller's links). "Remove from my list"
  joins the profile's Manage area (the manager Delete stays
  as the registry-level soft delete, platform-admin only in
  spirit — role gate unchanged).
- Patient profile: **Episode card** — current episode
  (agency, primary, team with roles + supervised-by,
  admitted date), Start episode (agency from my agencies),
  Discharge, Recertify, team add/remove (colleagues at the
  agency), episode history. Below it, the **patient
  schedule** (master calendar list, provider names shown).
- Calendar: personal scope default; the provider dropdown
  in the booking form lists the patient's episode team
  when a patient is picked.

## 9. API surface (new/changed)

- Auth: staff-record gate (403 NO_STAFF_RECORD).
- GET /patients (scoped), POST /patients (dedupe rules),
  POST/DELETE/PUT /patients/:id/link.
- POST /patients/:id/episodes, GET /patients/:id/episodes,
  POST /episodes/:id/discharge, /recertify, /primary,
  POST/DELETE /episodes/:id/members.
  (Episodes router mounted at /episodes + patient-nested
  routes in the patients router.)
- GET /appointments?patient_id= (master), default personal.
- GET/POST/DELETE /users/me/agencies.
- POST/GET/DELETE /invites, POST /invites/accept.

Error codes: PATIENT_EXISTS, POSSIBLE_MATCH, EPISODE_ACTIVE,
NO_ACTIVE_EPISODE, NOT_ON_TEAM, NOT_AGENCY_MEMBER,
INVITE_INVALID, INVITE_EXPIRED, INVITE_EMAIL_MISMATCH,
NO_STAFF_RECORD (existing shape).

## 10. Build order & tests

1. Schema + migration (local scratch DB first).
2. Auth gate + patient scoping + links (suite: two users,
   disjoint lists; admin all-view).
3. Dedupe on create (suite: exact block, near prompt,
   confirm-create, link-instead; DOB-less paths).
4. Episodes + team + booking gate (suite: create, conflict
   names the agency, discharge → transfer succeeds, member
   add requires agency membership, booking off-team refused,
   recert copies team).
5. Invites (suite: create, accept provisions staff record,
   wrong-email refused, expired refused, revoked refused,
   non-admin cannot create).
6. Dashboard (above), build + mockup-check the episode card.
7. Docs (API/DASHBOARD/DATA-MODEL/CHANGELOG/DECISIONS),
   then deploy on Jake's go: API (schema + migration +
   code), dashboard, GitHub.

Explicitly NOT in v1: email sending for invites, patient
portal, billing/org tenants above agencies, cross-episode
document sharing rules beyond §3 (documents follow chart
access), public sign-up.

## 11. Addendum — holds, discharge reasons, case manager (Jake, 2026-11-03)

Added the same day, after the v1 build, from Jake's follow-up
questions — folded into the local build BEFORE the first deploy
so the live migration carries the complete episode model.

**Episode holds.** An episode may be put ON HOLD (the
hospitalization case): `patient_episodes.status` gains
`on_hold`, and the one-active-episode index widens to
`status IN ('active','on_hold')` — a held episode still owns
the patient; no other agency can admit. Each hold is a row in
`episode_holds` (reason: hospitalized / patient_request /
physician_order / other; note; started_on / ended_on; started_by /
ended_by), so pause time is accountable, and hold/resume write
`episode_hold` / `episode_resume` events. While on hold the
booking gate refuses new visits with 409 `EPISODE_ON_HOLD` —
EXCEPT a Resumption of Care visit: booking one ends the hold
(the ROC is clinically the first visit back; the gate closes
the open hold and reactivates the episode in the same
transaction). Series are never booked onto a held episode.
Discharge is allowed straight from a hold (the open hold
closes at the discharge date). Recertify requires an active
episode (resume or discharge a held one first).

**Discharge reasons.** `patient_episodes.discharge_reason`
records WHY an episode ended: completed / patient_declined /
transferred_agency / transferred_inpatient /
moved_out_of_area / physician_order / deceased / other (the
note carries the detail for `other`). This is the "patient
couldn't finish" accounting: the chart history shows the
reason, not just a date. Optional in the API (older clients
keep working); the dashboard's discharge panel requires a
pick, defaulting to completed.

**Case manager.** HCHB's episode-header role, distinct from
the primary: `patient_episodes.case_manager_user_id` names ONE
current team member who coordinates the case clinically. It
defaults to the primary at admission (and in the migration)
and is transferable via `PUT /episodes/:id/case-manager`
(event `episode_case_manager`). The case manager holds full
management rights (team edits, hold/resume, discharge,
recertify, primary/case-manager transfer) — the nurse
case-managing a case can discharge it or hand it to another
clinician herself. The case manager cannot be removed from
the team until a successor is named (400
`CANNOT_REMOVE_CASE_MANAGER`, mirroring the primary's
protection). When the case manager's own discipline
discharges mid-episode, case management passes to a remaining
member and the episode continues — that handoff is the normal
case, not an exception.

## 12. Addendum — solo mode (Jake, 2026-11-03)

Jake's question: can someone use the platform as plain practice
management — own patient list + calendar — without other
disciplines, agencies, or episodes? As first built, no: the
booking gate required an episode, and an episode required an
agency, so a solo clinician hit a wall on their first booking.

DECIDED: **episodes are the unit of SHARING, not a toll booth
for booking.** When a patient has NO live episode, booking
(single or series) simply works and the visit is stored
unstamped (`episode_id` NULL) — a personal practice visit. The
gate's team/coverage/hold rules engage only once an episode
exists. A personal visit never creates an episode and never
blocks an agency admission; if an episode starts later, the
earlier personal visits stay on the chart as history (the
master schedule lists all of the patient's appointments,
stamped or not). Agencies, teams, and invites become opt-in
surface that only appears when a clinician actually
collaborates. `NO_ACTIVE_EPISODE` is retired as a gate outcome.
