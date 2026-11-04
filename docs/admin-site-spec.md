# CareTask — Admin Site (admin.marcinnotech.net) — Specification

Status: **LIVE — built and deployed as deploy-38,
2026-11-04** (Jake's "go" the same morning, §8 defaults
included; the seed deactivation in §8c was executed in the
deploy round). API `routes/admin.js` + dashboard
`src/admin/AdminApp.tsx`; `e2e-admin-test.js` 41/41 green
with full regressions; admin.marcinnotech.net active
(CNAME + Pages custom domain); signed-in visual check by
Jake is the last open item.
Decisions already locked by Jake (2026-11-04): a separate
subdomain for administrators only; user management + site
monitoring live there; the console's theme is **Mission
Control** (dark ops deck — §6), chosen from three mockups.

## 1. Goal

One administrators-only home — on its own subdomain — for the
two jobs that don't belong in a clinician's daily app: **user
management** (who has a staff record, what role, whether
they're active, what's on their list) and **site monitoring**
(is the platform healthy, are syncs and backups running, who
failed to sign in and why).

Motivating example (2026-11-04): Jake holds three staff
logins (jakemarc@gmail.com admin, jakemarc2@gmail.com
manager, jake@jakemarc.com clinician), each with its own
patient list (128 / 1 / 5). "Why does my phone show 130 and
my PC show 1?" took a server-side database audit to answer.
The admin Users page answers it on sight.

## 2. Hosting and routing

- **admin.marcinnotech.net** is a custom domain on the SAME
  Cloudflare Pages project as the dashboard
  (`marcinnotech-app`) — same build, same deploy command,
  both hostnames update together. DNS: one CNAME record
  `admin` → `marcinnotech-app.pages.dev` (proxied) in the
  marcinnotech.net zone; Cloudflare issues the certificate.
  No VM or Caddy involvement.
- The dashboard app boots by hostname
  (`src/main.tsx` / `App.tsx`): hostname
  `admin.marcinnotech.net` renders the **AdminApp**; any
  other hostname renders the clinician app as today. The
  main app gains no admin links; the admin host renders
  nothing but the console.
- Same Firebase project and sign-in. The console header
  carries an **ADMIN** badge and the title "CareTask Admin"
  so it is never confused with the clinician app.

## 3. Access control (the part that matters)

- New API router `routes/admin.js`, mounted in `server.js`:
  `app.use('/admin', requireAuth, requireRole('admin',
  'developer'), adminRouter)` — reusing the existing role
  gate (`lib/requireRole.js`). No staff record → 403
  `NO_STAFF_RECORD`; wrong role → 403 `ROLE_REQUIRED`.
  This matches the platform definition of platform admin
  (`lib/platform.js` `ADMIN_ROLES = ['admin','developer']`)
  and the precedent in `routes/invites.js` (`requireAdmin`).
- **Every** admin endpoint is gated server-side, on every
  request. The UI hiding things is cosmetic only — the JS
  bundle is public by nature; the API gate is the wall.
- Who qualifies today: jakemarc@gmail.com (id1, admin).
  Note: the seeded test rows include a *developer*
  (chris.novak@example.com, id5, active) — see §8(c).
- After sign-in the console probes `GET /admin/overview`;
  on 403 it shows an **"Administrators only"** wall that
  names the signed-in email and offers Sign out — so a
  wrong-login admin (the Nov 4 mix-up) can see *which*
  account they're holding and switch.
- Admin actions keep flowing through the existing event /
  audit logging (user writes and invites already log;
  audit core is unchanged — additive only, per standing
  rule).

## 4. API — new read endpoints (routes/admin.js)

- `GET /admin/overview` →
  `{ generated_at, patients: { total, created_last_30d },
  users: { total, active, by_role }, links: { active, hold,
  discharged }, episodes: { active, on_hold,
  discharged_total }, appointments: { today, next_7d,
  total }, agencies: { total, active }, invites:
  { pending }, contact_sync: [ { user_id, email, enabled,
  last_sync_at, last_result, items } ], backups:
  { latest: { filename, size_bytes, mtime } | null },
  auth_failures_24h: n, recent_errors: [ … ] }`
  - `backups` = newest file in `/home/jakemarc2/backups`
    read by the API process (filename, size, mtime only).
  - `recent_errors` = the latest 10 `event_log` rows from
    the last 7 days whose details mark an error, plus
    `auth_failure` entries folded in by the request logger;
    timestamps + actor email + short detail only.
- `GET /admin/users` → every staff row (safe columns —
  **never `pin_hash`**) plus per-user aggregates:
  `links { active, hold, discharged }`,
  `episodes_primary`, `episodes_case_manager`,
  `appointments_total`, `contact_sync { enabled, items,
  last_result } | null`, `last_event_at` (latest
  `event_log` row for that actor email).

## 5. Writes — reused, not rebuilt

- Staff create / edit / deactivate / restore: the existing
  `POST|PUT|DELETE /users` (+ `/:id/restore`) endpoints,
  with their existing manager-role gates and event logging.
  The console is a new front door to the same machinery.
- Invites: existing `POST|GET|DELETE /invites` (already
  admin-gated). The console hosts the same card UI.
- Audit log: existing `GET /events` (+ `/verify`); the
  console embeds the existing Log viewer component.

## 6. Dashboard — the console (src/admin/)

- `AdminApp.tsx` with four sections:
  - **Overview** — stat cards (patients, active users,
    active episodes, appointments today), phone-sync table
    (per user: enabled, items, last sync, result), backup
    freshness (amber warning when the newest backup is
    > 26 h old), recent failures list.
  - **Users** — the full staff table: email, role,
    active, authorized, **list counts (active / hold /
    discharged)**, sync state, last activity; row actions
    Edit (role / active / authorized), Deactivate /
    Restore — all via the reused §5 endpoints. Counts
    only: no patient names or clinical data in this view.
  - **Invites** — create (email + role, link shown once),
    list with derived status, revoke.
  - **Log** — the existing audit-log viewer.
- Phone-first responsive. **Theme: Mission Control**
  (Jake's pick, 2026-11-04) — the console is dark-only and
  does NOT follow the main app's theme settings; the dark
  skin is the "you are under the admin roof" signal.
  Palette (from the approved mockup): background `#0B1220`,
  header bar `#0E1930`, panels `#111C30`, hairlines
  `#1E2C47`, text `#E8F0FA`, muted `#8FA5C0`, accent teal
  `#2DD4BF`, stat numerals in a mono font tinted
  `#7EF0DD`. Status lights keep the house semantics —
  green `#22C55E` fine, amber `#F59E0B` look, red `#EF4444`
  problem — with a soft glow on the dots.

## 7. Testing and deploy

- New suite `e2e-admin-test.js` (scratch PG, stub auth):
  no token → 401; clinician → 403; manager → 403; admin →
  200s; developer → 200 (per §8b); seeded fixtures make
  the aggregates exact (links by status, sync items);
  `/admin/users` output contains no `pin_hash` key;
  overview shape incl. `backups.latest` null-safe.
- Regressions: platform (90), patients, users,
  users-mgmt, patient-merge, contact-sync suites.
- Deploy (one round, next deploy number): API (router +
  mount) → dashboard (AdminApp + hostname switch) → DNS
  CNAME + Pages custom domain → verify: admin host as
  admin shows the console; as jakemarc2 shows the named
  wall; main domain unchanged. Docs + CHANGELOG in the
  round; GitHub branch + main.
- Verification limit, stated now: hostname-gated UI can't
  be exercised on `*.pages.dev` preview URLs, so the
  console's visual check happens on the real subdomain
  after DNS (plus Jake's device check).

## 8. Decisions for Jake (defaults — veto any)

a. **Subdomain:** `admin.marcinnotech.net`. *(default: yes)*
b. **Developer counts as platform admin** (the existing
   platform definition — the invites gate already works
   this way). *(default: keep)*
c. **Deactivate the three `@example.com` seed staff rows**
   (Maria Santos id3 — already inactive; Dana Whitfield
   id4; Chris Novak id5, developer) before the console
   launches, so the Users page lists only real people and
   no test row carries an admin-capable role.
   *(default: yes — needs Jake's explicit OK at build
   time; it is a data change.)*
d. **Main app afterwards:** hide the Invites card from
   Settings (its home moves to the console); keep the
   Personnel/Clinician directory in the main app
   (clinicians need it for team and message picks).
   User *writes* stay manager-gated in v1 — tightening
   them to admin-only is a later call. *(default: as
   stated)*
e. **Backup freshness from the API reading the backups
   folder** (name/size/time only). *(default: yes)*

## 9. Out of scope (v1)

Service control (restart buttons), backup download or
restore, sign-in-as (impersonation), patient editing from
the console, VM resource graphs (CPU/RAM/disk), and email
or push alerts. Monitoring v1 is only what the API, the
database, and the backup folder can truthfully report.
