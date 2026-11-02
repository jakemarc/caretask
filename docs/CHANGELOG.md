# Changelog

All notable shipped changes to the CareTask platform. Newest first.
"Live" means deployed and verified at the listed URL; "Local" means
built and verified but not deployed.

## 2026-11-02

- **Reveal-menu hotfix — Live 2026-11-02 (deploy-29:
  dashboard-only, bundle `index-Dhj0ZcU7.js`, deployment
  https://6e3f9ff9.marcinnotech-app.pages.dev, verified —
  Cloudflare API canonical deployment matches, deployment URL
  serves the new bundle, main-domain asset 200, the live CSS
  carries the fixed selector).** Jake's phone check caught the
  Muse-style menu broken: the sidebar rendered displaced to
  the right with a blank strip at the left and the page
  squeezed off-edge. Root cause (in the source): the menu is a
  `position: fixed` child of `.dashboard-body`, and deploy-28
  slid the page by transforming `.dashboard-body` — a
  transformed ancestor becomes the containing block for fixed
  descendants, so the menu's `left: 0` anchored to the sliding
  wrapper and the menu rode along with the page. Fix
  (styles.css only): the slide targets `.app-main` — the
  menu's sibling, not its parent — plus the top bar, fabs, and
  pill as before; the menu stays pinned to the viewport's left
  edge while the content slides to reveal it.

- **The build queue ships — Live 2026-11-02 (deploy-28: API
  files + 2 migrations on the VM + dashboard bundle
  `index-DiCXGtUH.js`, deployment
  https://c675c14f.marcinnotech-app.pages.dev, verified —
  Cloudflare API canonical deployment matches, the deployment
  URL serves the new bundle, main-domain asset 200, API
  /health green, the three new routes answer 401 without a
  token, and all 8 API files sha256-matched after upload).**
  Jake said "run the queue" — all eight queued items plus the
  same-day follow-ons and the afternoon dashboard round ship
  as one release:
  - **Patient merge** (API + dashboard): duplicate marks any
    clinician can place, a Patients-tab review card, and a
    manager-gated merge that re-points appointments,
    documents, messages, and mileage to the survivor (the
    exact row ids are recorded, so Undo re-points exactly
    those back and restores the loser), gap-fills empty
    survivor fields, and soft-deletes the loser. Names, zone,
    status, clinician, consent flags, and ss/license never
    move.
  - **Clinician tasks / reminders** (API + dashboard):
    owner-scoped `clinician_tasks` (another clinician's task
    id answers 404); "My reminders" on the overview and a
    Reminders card on the profile. In-app only — no
    patient-facing reminders.
  - **CSV import**: the patients preview gains an "Apply to
    all rows" agency + status bar and per-row agency/status
    selects; rows save with agency and status stamped.
  - **Calendar**: agency filter + agency names on month chips
    and week/agenda meta lines; on the mobile month grid the
    chips become up-to-3 color bars by visit type with a
    legend under the grid.
  - **Mobile**: Muse-style reveal menu (the sidebar rests
    under the page; the page slides right over it) + profile
    cleanup (top bar reads "Patient Profile"; the Manage-list
    block moved below Contact); profile swipe left/right
    through the Patients list order with a position row, no
    wrap at the ends.
  - **Calling app setting**: Settings → Calling app (Phone /
    Google Voice / WhatsApp / FaceTime) and every Call button
    follows it. Doximity is excluded — its number handoff is
    native-integration only and PTs are not Dialer-eligible.
  - **Add patient by photo**: on-device OCR (Tesseract.js,
    lazy-loaded chunk) pre-fills the Add form from a referral
    sheet or card; the photo is read on the device and never
    uploaded.
  - **Add form cleanup**: the Google Contacts button is
    removed from the Add form (the picker still serves
    Clinician staff import), placeholders read "e.g. Jake" /
    "e.g. Marc", parenthetical labels are gone, Agency sits
    above the Note, and the AgencyPicker toggles are shorter.
    The desktop Patients table scrolls inside one screen
    with a sticky header.
  - **Dashboard overview rebuilt to one screen** (desktop):
    a clock card (live time + Open-Meteo weather for Hickory
    Hills; the background shifts with season and time of
    day), an appointments-today card (bands: 1–3 green,
    4 yellow, 5–7 red, 8+ deep red), and a total-patients
    card over the reminders and news panels; the demo stat
    cards and the Urgent triage panel are removed.
  - **PT & Home Health News card**: server-aggregated RSS
    via `GET /news` with shortened titles/descriptions;
    topics are chosen in Settings → News feed topics
    (defaults: physical therapy, home health, APTA).
  Suites: the full API battery is green on a fresh database
  (11 DB suites, incl. merge 27 and tasks 22, plus the news
  suite 10/10); the dashboard production build is green.

- **Expenses simplified → mileage day log — Live
  2026-11-02 (deploy-27: API migration + routes on the VM +
  dashboard bundle `index-zT2OwENT.js`, deployment
  https://1c152405.marcinnotech-app.pages.dev, verified —
  Cloudflare API canonical deployment matches, the deployment
  URL serves the new bundle, main-domain asset 200, API
  /health green).** Jake's spec: log mileage, generate a
  report monthly or by date range filtered by agency, NO
  approval process. Refined by Jake into a day chain and
  approved via mockup: home -> office bookends are fixed
  personal legs (addresses from the staff and agency
  profiles); patient stops between them are billable legs in
  visit order; routing defaults to tollway with a per-leg
  back-roads toggle; every leg end tappable (Home / Office /
  patient) or typeable (autocomplete). API:
  `schema-mileage-chains.sql` gives `mileage_entries`
  `user_id` / `agency_id` / `patient_id` / endpoint labels
  (backfilled from envelopes) and makes the envelope link
  nullable; new `GET|POST|PUT|DELETE /mileage` and
  `GET /mileage/report` (chain math — billable = business
  legs, personal = commute bookends, dollars only from rated
  business legs). The envelope lifecycle (create / submit /
  approve / reject / pay, expense lines) is REMOVED; legacy
  envelope reads stay read-only with their original math.
  The old test data (report #1 + 2 entries) was wiped at
  Jake's direction — it was form-testing data — so the log
  starts clean. Dashboard: `ExpensesView` rebuilt as the
  chain editor + report generator (print/PDF via print
  CSS); `expensesApi.ts` rewritten; new `.mlg-*` styles.
  Suite: `e2e-expenses-test.js` rewritten, 45 checks, all
  passing; full battery green before deploy.

- **Manager PIN removed → role gates — Live 2026-11-02
  (deploy-26: API patch on the VM + dashboard bundle
  `index-Deu836Rg.js`, deployment
  https://907b5cc1.marcinnotech-app.pages.dev, verified —
  Cloudflare API reports it as the canonical production
  deployment, the deployment URL serves the new bundle,
  API /health green, unsigned requests 401).** Jake's call:
  "Remove the PIN — role gates instead." API: new
  `lib/requireRole.js` (`requireRole` / `attachManager`);
  `lib/requireManagerPin.js` deleted; `POST /users/verify-pin`
  removed. Gate map: patient delete/restore, all staff writes,
  category writes, appointment delete/restore, document
  delete/restore, agency sync/update → manager/admin role of
  the CALLER (403 `NO_STAFF_RECORD` / `ROLE_REQUIRED`);
  patient PUT and appointment PUT are now UNGATED (caller
  identity still attached for audit attribution). Expense
  approve/reject/pay are manager-role plus a self-processing
  block (403 `SELF_APPROVAL` — a manager cannot process their
  own report). `lib/pin.js` / `users.pin_hash` are dormant.
  Dashboard: role comes from `GET /users/me` once per sign-in
  (`useMyRole`); Edit opens directly everywhere (no PIN panel);
  manager-only controls (patient Delete, staff writes,
  category editing, agency sync, document Delete, expense
  review) render only for manager/admin, with plain-language
  explanations for everyone else; the patient profile gains a
  **Manage list** block (Put on hold / Discharge / Return to
  active) for all clinicians — Jake's refinement: a clinician
  removes a patient from their list by status, not delete.
  Deploy note: the first API attempt stopped at its dry-run —
  the VM's `routes/appointments.js` carries comment drift from
  the Oct 30 transmissions, so 3 patch hunks failed context;
  the round completed with a split patch (7 file ops) plus an
  asserted 9-swap script for that one file. All 8 e2e suites
  green locally before deploy.
- **Standard mobile header — Live 2026-11-02 (deploy-25:
  dashboard bundle `index-uH1O1clT.js`, deployment
  https://46719cf6.marcinnotech-app.pages.dev, verified —
  Cloudflare API reports it as the canonical production
  deployment and the deployment URL serves the new bundle;
  deploy-20 token reused).** Jake's call: the docked bar is
  now the standard header on EVERY mobile view, not just
  Patients. The bar moved into the app shell (`mobile-topbar`):
  fixed glass bar, menu + view circles on it, centered title
  naming the current view (Dashboard / Patients / Calendar /
  Expenses / Messages / Settings / Audit Log / …; on a patient
  profile, the patient's name), and the Add Patient circle in
  the bar on patient views. Per-view page-head titles are
  hidden at phone widths (the bar is the title); app-main top
  padding is 88px so content clears the bar; the Patients
  page's own docked head (deploys 23–24) is retired — its head
  hides on mobile and the shell bar replaces it; the floating
  search and count note keep their clearances under the shared
  bar. Forced-desktop view restores everything (bar off,
  titles back, padding back). Deploy-24 (an hour earlier:
  bundle `index-DCu59aeR.js`, deployment 4e6c5ac2) had shipped
  only the + -as-a-circle step on the Patients bar and was
  superseded by this deploy before its own changelog entry —
  recorded here for completeness.
- **Mobile Patients title as a docked BAR — Live 2026-11-02
  (deploy-23: dashboard bundle `index-FIx8xYCu.js`, deployment
  https://a68c0874.marcinnotech-app.pages.dev, verified —
  Cloudflare API reports it as the canonical production
  deployment and the deployment URL serves the new bundle;
  deploy-20 token reused).** Jake asked for a docked bar
  instead of the pill so the title can't go under the floating
  buttons (superseding deploy-22 within the hour): the page
  head is now a full-width fixed bar (72px, glass, bottom
  border) across the top; the menu and view-toggle circles
  (z 60) render ON the bar (z 59) as one piece of chrome, the
  title is plain centered text in the bar, and Add Patient
  sits in the bar left of the toggle circle. The floating
  search moved down to clear the bar (top 84px; filter popover
  142px; count note margin 128px). Forced-desktop un-docks the
  bar back to the normal head row.
- **Mobile Patients title DOCKED — Live 2026-11-02 (deploy-22:
  dashboard bundle `index-Cn9eNyDA.js`, deployment
  https://5144d7cd.marcinnotech-app.pages.dev, verified —
  Cloudflare API reports it as the canonical production
  deployment and the deployment URL serves the new bundle;
  deploy-20 token reused).** Jake asked for the title docked
  rather than in-flow (superseding deploy-21's placement an
  hour earlier): the Patients title is now a fixed glass pill
  centered between the menu and view-toggle circles — the
  deploy-19 design intent — staying put while the list scrolls
  under it. The Add Patient button rides at the docked strip's
  right end (just left of the toggle circle); the count note
  again clears the fixed search with its 118px top margin;
  forced-desktop view un-docks the head back to the normal row.
- **Mobile Patients title fix — Live 2026-11-02 (deploy-21:
  dashboard bundle `index-jIXS557U.js`, deployment
  https://342eda86.marcinnotech-app.pages.dev, verified —
  Cloudflare API reports it as the canonical production
  deployment and the deployment URL serves the new bundle;
  the deploy-20 token was reused, no new token minted).**
  Jake's phone screenshot showed the deploy-19 mobile Patients
  view working against his real imported census ("38 active
  patients", no API banner — deploy-20 verified in real use)
  but the "Patients" title missing: the page head rendered
  after the count note in flow, landing at ~90–125px, hidden
  behind the fixed floating search; only the Add Patient
  button's edge peeked out. Fix (mobile ≤720px CSS only): the
  list panel is now a flex column, the page head is ordered
  first with a 118px top margin so the stack clears the fixed
  search — title row (with a reachable Add Patient button),
  then the count note, then the cards.
- **Auth diagnostics + dashboard retry — Live 2026-11-02
  (API: surgical in-place edit on the VM, no deployment URL;
  dashboard deploy-20: bundle `index-dsXGun7Q.js`, deployment
  https://f1ed4a0c.marcinnotech-app.pages.dev, verified —
  Cloudflare API reports it as the project's canonical
  production deployment, the deployment URL serves the new
  bundle, the new asset returns 200 on the main domain, API
  health green; token `marcinnotech-app-deploy-20`).** Born of
  the recurring "Patient API unreachable" banner (Nov 1 evening
  + Nov 2 morning): the API was healthy throughout — event_log
  showed the failing loads were 403s, and in this API a 403
  means the token verified but its account was not on
  `ALLOWED_EMAILS` (both of Jake's emails ARE on it; the failing
  tab's identity was never identified because failures logged
  no reason). Two changes: (1) **API** — `auth.js` records WHY
  each auth rejection happened (`req.authFailure`:
  `missing_or_malformed_header` / `not_on_allowlist` + the
  account's email / `token_verification_failed` + the
  firebase-admin error code; the token itself is never logged)
  and `lib/requestLog.js` folds it into the `auth_failure`
  event's details as `details.auth`. Response behavior is
  unchanged (401/403 exactly as before) — additive detail on an
  existing event type, per the standing "don't change how
  logging works" rule. Verified live: no-header and
  garbage-token probes logged the two reasons in production.
  First whole-file transfer attempt corrupted in transit; the
  byte-count safeguard caught it, backups were restored, and
  the change shipped as in-place edits instead. (2)
  **Dashboard** — the sign-in patients check now retries once
  after ~1.5s before declaring the API unreachable, so one
  slow/racing first attempt no longer brands a whole session
  as demo-data fallback. Revert path: redeploy the deploy-19
  build; API revert from `*.bak-2026-11-02-authlog` on the VM.
  Source for both halves is on GitHub branch
  `auth-diagnostics` and on main with this deploy.
- **Mobile floating view — Live 2026-11-02 (deploy-19:
  dashboard bundle `index-CQDxFnPf.js`, deployment
  https://06bae334.marcinnotech-app.pages.dev, verified —
  main URL serves the new bundle, asset 200, live bundle
  carries the mobile-view markers, API health green).** The
  pre-deploy source sits on GitHub branch
  `mobile-floating-view` (commit `caafd2e`); main fast-forwards
  to the same files with this deploy. Revert path: redeploy
  the deploy-18 build (main's prior state). Jake's mobile-first redesign, mocked up and
  approved piece by piece the same morning. At phone widths
  (≤720px) the header and the bottom-bar sidebar are replaced
  by floating glass chrome: a **menu circle** (top-left) that
  opens the full sidebar as a slide-in drawer (theme toggle +
  sign out move to the drawer's foot), a **desktop-view toggle
  circle** (top-right, same force-desktop switch as the header
  button), and a **floating pill footer** — Dashboard /
  Patients / Mileage / Calendar with the active destination
  filled teal; **Mileage** opens Expenses flagged to auto-open
  the report covering the current month (the sidebar Expenses
  entry still opens the plain list). **Patients page:** title
  rides at the floating buttons' level; the search becomes a
  **floating translucent bar** with a **funnel button** — the
  only filter is Status, **defaulting to Active** (On hold /
  Discharged / All statuses in the popover; a teal dot badges
  the funnel whenever the filter differs from Active); typing
  in search **searches all patients** (every status) and
  overrides the filter, and the count line says so. The mobile
  list is **cards**: zone dot + name (+ status word when not
  active) + directions/call buttons — **no address on the
  card**; tap opens the profile. **Patient Profile:** a
  **floating vertical pill** on the right edge, icons only —
  Call (teal), Directions, Edit (same PIN-gate flow). Desktop
  and forced-desktop views are unchanged (the desktop table,
  its search row, and the header/sidebar all restore under
  `.force-desktop`).

## 2026-11-01

- **Expense reports + mileage — Live 2026-11-01
  (deploy-18: API migrations + routes on the VM, dashboard
  bundle `index-1VzRC432.js`, deployment
  https://1bfa5838.marcinnotech-app.pages.dev, verified —
  API health green, /expense-reports answers 401 unauthed,
  main URL serves the new bundle with all markers).** The full
  monthly-report system: `expense_reports` (the envelope —
  auto-generated id, optional friendly title, period, and the
  draft → submitted → approved / paid lifecycle with manager
  PIN on approve/reject/pay) + `mileage_entries` (legs with
  entry_kind business/commute, both routing figures stored,
  used_tollway, round trip, correctable final miles, rate
  snapshot) + `expenses` revised to non-mileage lines hanging
  off a report (its lifecycle columns moved up to the report;
  the earlier version was never deployed). API
  (`routes/expenses.js`, `lib/routing.js` — Valhalla tolls vs
  no-tolls): per-day commute deduction with a zero floor,
  owner-only draft editing, managers read all reports,
  `expense_change` events carry ids/status only. Dashboard:
  direct **Expenses** button under Record; list = previous
  reports; detail = day-grouped mileage with the
  driven − commute = reimbursable math, other-expense lines,
  totals, print view, submit/approve/pay flow; the mileage
  form takes autocomplete or a GPS **Nearest home** fill
  (confirm-first), calculates road miles both ways, and
  chains each leg's end into the next leg's start. Verified:
  full schema chain applies (new files idempotent),
  `e2e-expenses-test.js` 42/42 (day math, floor, lifecycle,
  PIN gates, isolation), the patients e2e suite still fully
  green (74 checks), dashboard bundle `index-1VzRC432.js`
  carries all markers. Deploy-18 candidate (API migration + routes +
  dashboard).
- **Navigation: Patients submenu removed — Live
  2026-11-01 (deploy-18, same bundle/deployment as above;
  live bundle check: "Patients Map" occurs exactly once —
  the retained view's heading).** Patients Map left
  the submenu, then Add Patient, then the submenu itself:
  **Patients is now a direct sidebar button** that opens the
  Patients page — no chevron, no expansion (the group
  open/close state and toggle handler are deleted). Add
  Patient moved onto the Patients page: a right-justified
  **Add Patient** button in the page head, collapsing to a
  **+ icon only** at ≤720px. The Patients Map view code stays
  in place (its heading is the one "Patients Map" string left
  in the bundle) but is unreachable from the nav. Mockup
  shown to Jake: `~/workspace/patients-nav-mockup.html`.
- **CSV import: second Google header dialect — Live
  2026-11-01 (deploy-18, dashboard bundle
  `index-1VzRC432.js`, deployment
  https://1bfa5838.marcinnotech-app.pages.dev, verified at
  https://marcinnotech-app.pages.dev).** Jake's own contacts.csv (the contacts.google.com
  export: First Name / Last Name, `Organization Name`, no
  E-mail/Gender columns) imported nothing — the parser only
  knew the Takeout/People dialect (Given Name / Family Name),
  read every row as nameless, and the preview answered "No
  importable contacts were found in that file." The row
  mapping now accepts both dialects for names, organization,
  and email groups, and the known-header check recognizes
  First/Last Name. Verified against Jake's real file with the
  real parser: 0 → 29 contacts, all 29 patient-import Ready
  (24 with phones, 29 with addresses, no birthdays in the
  file); an old-dialect fixture still parses 2/2 with all
  fields intact. Dashboard-only change; shipped inside the
  combined deploy-18 bundle (the standalone candidate bundle
  was `index-C-v38TGT.js`).
- **Patients rename + optional DOB/sex + stored age + Age/Sex
  column removal + CSV import fix — Live (2026-11-01, Jake;
  deploy-17: dashboard bundle `index-BwSBwNpi.js`, deployment
  https://3f6882a3.marcinnotech-app.pages.dev, main URL
  verified serving it; API migration + routes deployed to the
  VM the same round, /health ok, 401 without a token).** The sidebar button and
  list page are now **Patients** (was Patient / Patient List);
  Patient Profile and Add Patient keep their singular names.
  The patients table gains an `age` column
  (`patient-api/schema-patients-age.sql`, INTEGER, CHECK 0–130,
  additive + idempotent) for patients whose birth date is
  unknown; `date_of_birth` and `sex` are OPTIONAL on patient
  create (the 2026-10-30 `DOB_REQUIRED` / `SEX_REQUIRED` 400s
  are retired, empty-string DOB normalizes to NULL, and the
  dashboard form's client-side DOB/sex blocks and `*` markers
  are gone). Both Add and Edit forms carry an "Age (if birth
  date unknown)" field; display prefers a DOB-derived age and
  falls back to the stored age. The Patients table's Age/Sex
  column is removed (table is now Patient | Address); the
  profile header shows the "74/F" segment only when the
  patient has an age or a sex recorded — nothing shows when
  neither is recorded. The CSV import no longer flags or
  blocks rows missing a birthday or gender (patients now
  require first + last name only); the yearless `--MM-DD`
  birthday still maps to blank, never an invented year.
  Verified: full patients API suite passes on a scratch
  PostgreSQL 16 (75 checks incl. the new 11c DOB/sex-optional
  and age checks), the dashboard builds (bundle
  `index-BwSBwNpi.js`, API URL baked in, zero "Age/Sex"
  strings), and the import's required-field logic checks 4/4
  against the transpiled module.

## 2026-10-31

- **Expenses table created — Local (2026-10-31, schema only;
  no API routes or dashboard UI yet, not deployed).** New
  `patient-api/schema-expenses.sql` adds the `expenses` table
  (21 columns) at Jake's direction. An expense belongs to a
  staff member through `user_id` → `users.id` — by id, not by
  name (names are not unique and change; the name shown in
  lists comes from a JOIN on `users`). Fields: expense_date,
  category (CHECK list of twelve: mileage, parking, tolls,
  medical_supplies, office_supplies, meals, travel, lodging,
  phone_internet, training, licenses, other), description,
  vendor_name, amount_cents (integer cents, ≥ 0), currency,
  payment_method, receipt_url, agency_id (FK → agencies,
  nullable), the approval lifecycle (status draft / submitted
  / approved / rejected / reimbursed; submitted_at,
  approved_by → users, approved_at, reimbursed_at,
  reimbursement_ref), notes, and soft delete (deleted_at; the
  runtime user gets SELECT/INSERT/UPDATE only). The migration
  also widens the event_log CHECK with `expense_change`
  (additive only). Mileage trip detail deliberately stays out
  of this table — a future `mileage_entries` table will link
  by expense id; a mileage expense carries only its computed
  total. Verified against a scratch PostgreSQL 16: the full
  twelve-file schema chain applies cleanly, the new file
  applies twice (idempotent), FK violations (bad user_id,
  bad approved_by), a bad category and a negative amount are
  all rejected, a JOIN returns the correct employee for two
  staff with identical names, and as the limited `patient_api`
  user INSERT/UPDATE/SELECT work while DELETE is denied.
  DATA-MODEL.md updated in the same round.

- **Agency tab demo block removed; sidebar search removed;
  collapse chevron moved beside "Main Menu"; Patient List
  mobile row actions; icon-only Edit button; agenda default
  view; responsive agency filter chips; icon-only layout
  toggle; demo banner + KPI bar removed — Live (deploy-16,
  2026-10-31, bundle index-g6bkKTHa.js, deployment
  1bfb0fcd.marcinnotech-app.pages.dev; main URL verified
  serving it).**
  Ten changes at Jake's direction, in
  `src/pages/Dashboard.tsx`, `src/components/CalendarView.tsx`,
  `src/components/AgencyView.tsx`, and `src/styles.css`.
  (1) Agency
  tab: the demo service-lines block under the agency
  directory is gone — the "Service lines below are a demo
  placeholder — replace them with the agency's real
  disciplines." note and the six hard-coded discipline
  cards (Physical Therapy, Occupational Therapy, Speech
  Therapy, Skilled Nursing, Home Health Aide, Medical
  Social Work). The tab is now just the heading and the
  real <AgencyView> directory. (2) Sidebar: the sidebar
  search bar (icon, input, clear button) is removed.
  Patient search is unaffected — the Patient List page's
  own search input drives the same `query` state (the
  now-callerless `handleSearch` helper was removed; the
  `Search` icon import stays, still used by the Patient
  List and Audit Log searches). The `.sidebar-search` CSS
  rules remain in styles.css, unused and harmless.
  (3) Sidebar header: the collapse/expand chevron no
  longer sits alone above the nav — it shares one row
  with the "Main Menu" label (new `.sidebar-head` flex
  row: label left with its left margin kept so it lines
  up with the nav buttons, chevron right; behavior,
  icons, and title text unchanged). When the sidebar is
  collapsed the label is hidden as before and the row
  centers the lone chevron (`justify-content: center`);
  on mobile both stay hidden as before. (4) Patient List
  mobile layout: at the ≤720px breakpoint the Age/Sex
  column hides (new `.col-agesex` hook on its header and
  cells), the Address cell swaps its text for a Navigation
  directions icon linking to the existing
  `mapsDirectionsUrl(p)` (Google Maps, new tab; no icon
  when there is nothing to navigate to, and the "—" still
  shows for address-less patients), and a new call column
  after Address (`.col-call`, empty header) holds a Phone
  icon linking `tel:` to the patient's main number — home
  phone when it yields a dialable `telHref`, else cell.
  Both icons `stopPropagation` so a tap never also opens
  the profile via the row onClick. Desktop is unchanged:
  the directions icon and the whole call column are
  `display: none`, and `.force-desktop` rules restore the
  desktop arrangement on small screens. (5) The Patient
  Profile's visible "Edit patient" text button is now
  icon-only (lucide `Pencil`, `title`/`aria-label` keep
  "Edit patient"; same PIN-gate flow); `.profile-edit-btn`
  gets compact square padding (8px, inline-flex centered)
  like the login theme toggle. The edit form's own
  "Edit patient" <h3> heading is unchanged. (6)
  Appointment page: the calendar now opens on the daily
  schedule — `CalendarView`'s initial view changed from
  "month" to "agenda" (labels unchanged). The agenda
  fetch window is today forward 31 days, so today's
  visits are always in the first load. (7) Agency
  service filter chips: each chip now renders its
  spelled-out name on desktop ("Nursing care", "Physical
  therapy", "Occupational therapy", "Speech pathology",
  "Medical social services", "Home health aide"; "All
  services" for the reset chip) and an abbreviation on
  phones (SN / PT / OT / ST / MSW / HHA; "All"). Both
  labels render in `.chip-label-full` / `.chip-label-short`
  spans and styles.css switches them at the ≤720px
  breakpoint, with `.force-desktop` restoring the full
  labels on small screens; each chip keeps an
  `aria-label` with its full name. The agency detail
  view's "Services (CMS)" chips are not filters and are
  unchanged. (8) Header: the mobile/desktop layout
  toggle is icon-only (Monitor/Smartphone, same
  onClick); its `title` is unchanged and a matching
  `aria-label` was added — the neighboring theme toggle
  keeps its text. The `.header-right .btn` rule already
  supplies the compact icon padding, so no CSS change
  was needed. (9) The top DEMO DATA banner under the
  header is removed (the API-unreachable fallback notice
  inside the main area is a different element and stays).
  (10) The placeholder KPI/metrics row under the banner
  (Caseload by zone / Flags reviewed / Visits this week /
  Clinician workload, "Graph coming soon") is removed;
  it was self-contained static markup. The `.demo-banner`
  and `.metrics-row` CSS rules remain in styles.css,
  unused. Verified: build passes (tsc + Vite); the built
  JS contains no "demo placeholder", no demo
  discipline-card text, and no sidebar "Search patients…"
  placeholder, while the Patient List's "Search patients
  by name…" input and "Main Menu" are still present; the
  built CSS carries the `.col-agesex` / `.col-call` /
  `.address-directions` rules in base, ≤720px, and
  `.force-desktop` forms; the built JS also contains no
  "DEMO DATA" and no "Graph coming soon", the header
  toggle's text labels are gone (its title/aria strings
  "Show the desktop layout" / "Switch back to the mobile
  layout" remain, and "Desktop view"/"Mobile view" still
  appear only as the Settings → Layout card buttons and
  a Help Center reference), `CalendarView`'s initial
  view is "agenda" in source, and the built CSS carries
  the `.chip-label-full` / `.chip-label-short` rules in
  base, ≤720px, and `.force-desktop` forms.

## 2026-10-30

- **"Agency #446" + "birthday doesn't save" — pg type
  normalization — Live (deploy-15, 2026-10-30, bundle
  index-DyL5cYTg.js, deployment
  3cf880c1.marcinnotech-app.pages.dev; main URL verified
  serving it).** One root cause for both reports: the
  API's pg driver returns DATE columns as JS Date objects
  (JSON: "1961-07-22T00:00:00.000Z") and BIGINT columns as
  strings ("446"), while the dashboard was written for
  "YYYY-MM-DD" strings and numeric ids. All fixes are in the
  client normalization layer (`src/lib/patientApi.ts`); the
  API is unchanged. (1) Agency name missing: `fetchAgencies`
  cast the raw JSON, so `ApiAgency.id` was the string "446"
  at runtime while the patient's `agencyId` is a number, and
  the AgencyPicker's `a.id === agencyId` lookup never
  matched — the selected chip fell back to `Agency #446`.
  `fetchAgencies`, `fetchPrimaryAgency`, and `updateAgency`
  now run every returned agency through `normalizeApiAgency`
  (`id: Number(a.id)`), and the picker's selected-agency
  lookup compares `Number(a.id) === Number(agencyId)` as a
  backstop. (2) Birthday not saving: `date_of_birth` arrived
  as an ISO timestamp, which the Edit form's
  `<input type="date">` cannot hold — the field rendered
  empty and saves never stuck; the same bad format also fed
  `ageFromDob` and the duplicate checks' DOB comparisons.
  `normalizeApiPatient` truncates `date_of_birth` to its
  first 10 chars when longer (`dateOnly`), applied at every
  ApiPatient production point: `toPersonUnderCare` (patient
  list, single get, create, update, restore), `searchPatients`
  (the Add form's duplicate check reads raw rows), and
  `getPatientAudit` (before/after snapshots). `date_of_birth`
  is the only DATE-only column on ApiPatient —
  created_at/updated_at/deleted_at are timestamps and stay
  whole, and appointment date/time fields are untouched.
  Verified: build passes (tsc + Vite); a node check against
  the esbuild-transpiled real module passes 14/14 —
  "1961-07-22T00:00:00.000Z" normalizes to "1961-07-22"
  through both `normalizeApiPatient` and `toPersonUnderCare`,
  agency id "446" becomes the number 446, and the picker
  lookup finds the agency both after normalization and via
  the Number() backstop on raw data.

- **Login screen wording + icon-only theme toggle — Live
  (deploy-15, 2026-10-30, shipped in bundle
  index-DyL5cYTg.js).** At Jake's direction, in
  `src/pages/Login.tsx`: the heading is now "Sign in" (was
  "Clinician sign in"), the sub-line under it reads exactly
  "CareTask Dashboard" (was "Sign in to reach the CareTask
  clinician dashboard."), and the bottom "Demo build — dashboard
  content is synthetic demo data, not real patient information."
  footnote is removed entirely (the now-unused `.login-footnote`
  CSS rule is left in place, harmless). The light/dark toggle in
  the brand row is icon-only — same button, same `onToggleTheme`,
  same Moon-in-light / Sun-in-dark lucide icon; the text word is
  gone and the button carries both `title` and `aria-label`
  ("Switch to dark/light mode"). One CSS touch under the existing
  `.theme-toggle` rule in `src/styles.css`: drops the icon+text
  `gap` and sets centered `padding: 8px` so the icon-only button
  isn't a wide text-button rectangle (`.theme-toggle` is used
  only by the login page). Brand block, tagline, form, buttons,
  and error handling are untouched. Verified in the built bundle:
  "Demo build" 0 occurrences, the old sub-line 0, "Clinician sign
  in" 0, "CareTask Dashboard" present.

- **Patient List / nav cleanups + autocomplete & agency-picker
  robustness — Live (deploy-14, 2026-10-30, bundle
  index-6fNZ0MzL.js, deployment 7ca9c101.marcinnotech-app.pages.dev;
  main URL verified serving it).** Seven fixes at Jake's
  direction. (1) The zone disclaimer under the Patient List
  table ("The zone classifies attention only — it never takes
  action on its own. A clinician always decides.") is removed;
  nothing replaces it. (2) The Patient sidebar submenu drops
  its "Patient Profile" entry (List / Add Patient / Patients
  Map remain) — the profile view itself is untouched and still
  opens from a Patient List row click and existing links.
  (3) Address autocomplete fallback hardened in
  `AddressAutocomplete.tsx`: the plain-403 path (referrer-
  restricted key on preview origins) already fell through to
  Nominatim and still does, but three Google failure paths
  could still dead-end — a Google response with zero usable
  predictions returned early with "No matches" (now falls
  through to Nominatim), a hung Places request stalled the
  dropdown on "Searching…" forever (the Google attempt is now
  time-boxed at 4.5s with its own abort controller), and a
  failed Place Details call filled only the street text (it
  now resolves the picked label through Nominatim for
  structured city/state/ZIP + coordinates first). Google-first
  behavior on the main domain is unchanged. (4) Agency picker
  (`AgencyPicker.tsx`): when the directory can't be used
  (API unreachable — e.g. a preview origin the API CORS
  allowlist rejects — or the fetch failed), the free-text
  fallback now shows a visible note explaining why and
  pointing to marcinnotech-app.pages.dev for the searchable
  directory (before, it silently looked like a broken
  dropdown); the suggestion dropdown is restructured to
  anchor directly beneath the input (relative wrapper, the
  `.addr-wrap` pattern) instead of below the scope/mode
  toggle links; suggestion rows pick on pointerdown with the
  deploy-12 700ms dedupe guard (click kept as fallback) so
  phone taps register. (5) The Add and Edit Patient forms no
  longer wrap either custom dropdown (`AddressAutocomplete`
  for Street, `AgencyPicker` for Agency) in a `<label>`: a
  tap on the text inside a suggestion row could trigger the
  label's activation behavior and steal the gesture before
  the pick landed. Each of the four fields now uses a
  `<div className="form-field">` with the caption in a
  `<span>`; a matching `.add-form .form-field` CSS rule
  mirrors the label layout exactly, and no component props,
  state, or internals changed. (6) The Settings → Database
  utilities card description is reduced to exactly "Import
  from CSV" above the Import patients / Import staff
  buttons; the API-unreachable card variant and the import
  flow's later explanatory steps are unchanged. (7) The
  untitled Settings card that held the Clinician / Contacts /
  Log buttons is split in two: a titled **"Personnel"** card
  (Clinician + Contacts) with a separate titled **"Logging"**
  card immediately below it holding only the Log button;
  button labels, destinations, and card order are unchanged.
  Build passes
  type-check; bundle `index-6fNZ0MzL.js` /
  `index-CX_QFsc8.css` (verified: disclaimer text absent
  from the JS, "Patient Profile" remains only as the profile
  heading + a Help Center sentence, agency note +
  picker-field class present, all four target dropdowns use
  `.form-field` wrappers in source, the built CSS carries
  the matching rule, the old Database utilities card
  description is absent from the JS, and "Personnel" and
  "Logging" each appear once in the JS).

- **Agency directory scroll region + "Schedule — today" card
  removed from the Patient List — Local (not deployed).** Two
  layout changes at Jake's direction. (1) The Agency tab's
  directory table (all ~595 Illinois rows) no longer stretches
  the page: the existing `.agency-table-wrap` is now a scroll
  region capped at roughly one screen
  (`max-height: calc(100dvh - 340px)` desktop,
  `calc(100dvh - 410px)` in the ≤720px mobile layout to clear
  the fixed bottom bar, 220px floor), and the sortable column
  headers (Agency / City / Rating / Phone) stick to its top
  while scrolling. Pure CSS: the frame (border/radius/
  background) moved from the table to the wrap, and the
  table's `overflow: hidden` + `border-collapse: collapse`
  are neutralized inside the wrap because both trap
  `position: sticky`; on mobile the wrap is the single scroll
  container for both axes. Search, clear button, sorting,
  CMS filters, and row-tap → profile are unchanged — all
  rows still load. (2) The Patient List tab no longer renders
  the **"Schedule — today"** day-calendar aside
  (`DaySchedulePanel`): the component and its now-unused
  helpers were removed, the list section takes the
  single-column layout, and the patient table spans the full
  width. The `daySchedule` data stays (Dashboard overview
  "Today's visits" stat, profile day view). Build passes
  type-check; bundle `index-hqBz0kWg.js` /
  `index-BifKrp9Y.css` (verified: "Schedule — today" absent
  from the JS, scroll + sticky rules present in the CSS).

- **Staff grouping (Clinical / Non-clinical), real Contacts
  directory, and Clinician + Contacts moved under Settings —
  Local (not deployed; batches with deploy-13).** At Jake's
  direction, same build round as the CSV import: (1) The
  staff directory is split into **Clinical staff** and
  **Non-clinical staff** by the existing users `authorized`
  flag (authorized = clinical, i.e. assignable providers; no
  schema change, no new field) — applied on the Clinician
  page (cards grouped under the two headings, layout and
  actions unchanged) and on Contacts. (2) The **Contacts
  page is rebuilt as the real staff directory**: same
  users-table fetch as the Clinician tab, grouped under the
  same two headings, read-only cards (name, position line,
  email, tap-to-call phones). The four fictional "Agency
  team" placeholder cards, the derived demo cards, and the
  "Demo directory" note are removed; an unreachable API
  shows an honest "staff directory is unavailable" note —
  no fake contacts as fallback. Empty groups show "No
  clinical staff yet" / "No non-clinical staff yet".
  (3) The **Clinician and Contacts nav buttons are removed**
  from the sidebar (which is also the mobile bottom bar —
  one element, restyled by media query); Settings gains
  **Clinician** and **Contacts** buttons beside the Log
  button, each opening its page with a **Back to Settings**
  button, Settings nav staying highlighted — the same
  pattern as the earlier Log move. Imported staff (CSV or
  Google Contacts) start unauthorized, so they land under
  Non-clinical until marked Authorized — correct by design.
  Build passes; final rebuilt bundle for the combined batch
  is index-BDwxW7Ca.js (verified: contains "Clinical staff",
  "Non-clinical staff", "Database utilities", "Import
  patients", "Import staff"; the fictional placeholder names
  and demo-clinic.example addresses no longer appear).
- **Settings → Database utilities: CSV import — Local (not
  deployed; batches with deploy-13).** At Jake's direction:
  a new Settings card, **Database utilities**, with two
  buttons — **Import patients** and **Import staff** (his
  correction: staff, not clinicians) — importing a Google
  Contacts CSV export (Google People contact format) into the
  patients / users tables. New `lib/googleCsv.ts` (robust CSV
  parser: quoted fields, embedded commas/newlines, CRLF,
  numbered column groups) normalizes rows into the same
  `ContactCandidate` shape as the People API import; the file
  is parsed in the browser only and never uploaded — only
  confirmed rows are saved, one by one, through the existing
  API creates. Preview before any save with per-row statuses
  (patients: Ready / Missing required — first name, last
  name, DOB, sex all required / Possible duplicate; staff:
  Ready / Missing required / Already on the team / Duplicate
  in file), Ready rows pre-checked, problem rows locked.
  Staff import is manager-PIN gated first and imported staff
  start as unauthorized clinicians; patient saves collect
  per-row failures and end with an Imported/Skipped/Failed
  summary. Fails closed when the API is unreachable. Parser
  verified by a throwaway Node test (23 checks: quoted comma
  address, embedded-newline note, Mobile+Home phone labels,
  yearless birthday, MM/DD/YYYY conversion, Name fallback,
  missing-field detection — all pass). Build passes
  (superseded as the batch's final bundle by the grouping /
  nav entry above: index-BDwxW7Ca.js).
- **Log page (formerly Audit Log) — Local (batches with
  deploy-13).** At Jake's direction: the sidebar Audit Log
  button is removed; Settings gains a **Log** button opening
  the log on its own page (heading "Log", Back to Settings).
  Events now render as a **table** instead of cards, with a
  search box, sortable column headers, and an **Export**
  button (downloads the visible table as `caretask-log.csv`;
  the export reports a `report_export` event). Logging itself,
  the server filters, and the chain badge are unchanged.
- **Settings slimming + Visit categories page — Local (batches
  with deploy-13).** At Jake's direction: the Settings → Agency
  directory card was slimmed to just the **Update agencies**
  button (source/count/status text removed; PIN prompt, errors,
  and the post-run result note remain). The Theme card drops
  its description text (just Light / Dark buttons + the color
  theme picker remain) and the Layout card drops its description
  (just Mobile view / Desktop view buttons). The Visit
  categories Settings card keeps Add category + a **List
  categories** button; the list itself moved to a **separate
  Visit categories page** with Edit / Deactivate / Reactivate
  and a **Back to Settings** button (Settings nav stays
  highlighted while on it). Final rebuilt bundle for this batch
  is index-CgFPrskV.js (verified: contains api.marcinnotech.net,
  "List categories", "Back to Settings", "Search the log",
  "caretask-log.csv"; no "Audit Log" string remains).
- **Settings "Demo data" card removed — Local (batches with
  the deploy-13 build).** At Jake's direction: the explanatory
  "Demo data" card in Settings is removed. (The demo disclaimer
  elsewhere in the app and the Help FAQ are untouched; no demo
  data itself was deleted.) Rebuilt bundle index-D7zKbZxi.js
  (supersedes index-UYg6bGt8.js).
- **Patient List columns, profile layout, edit discoverability — Local (not deployed).**
  The Patient List table is now **Patient (zone dot + "Lastname,
  Firstname") | Age/Sex | Address**: Age/Sex added after the
  name ("74/F" — exact age from DOB via `ageFromDob` + sex
  initial, decade-band/"—" fallbacks; sortable by date of
  birth), Address added after it (full street/line 2/city/
  state/ZIP; sortable by street, then city); the **Zone,
  Status, and Clinician columns were removed** (headers, cells,
  sort keys — status data untouched elsewhere). The Patient
  Profile's **selector panel was removed** — a plain "Patient
  Profile" heading sits above the now full-width card; switching
  patients is via the Patient List. A **visible "Edit patient"
  button** on the profile head triggers the same PIN-gate →
  Edit form flow as the header tap (which still works; the
  button hides while the gate/form/delete-confirm is open).
  Displayed patient names **no longer include the honorific
  title** (`fullName()` composes first/middle/last/suffix;
  display only — the stored `title` field is unchanged, staff
  titles untouched).
- **Date of birth + Sex required when adding a patient — Local (not deployed).**
  API: `POST /patients` rejects a missing/empty
  `date_of_birth` with 400 `DOB_REQUIRED` and a missing/empty
  `sex` with 400 `SEX_REQUIRED` (create-only; PUT/edit
  unchanged; a chosen `"Unknown"` sex counts as provided).
  Dashboard Add Patient form: DOB and Sex marked *, validated
  client-side with an inline error naming the field. Patients
  e2e suite covers the new codes + the create-only scope (72
  checks; the events and users suites' patient-create fixtures
  gained DOB/sex to match).
- **Patient agency picker + agency tag — Local (not
  deployed; same batch).** At Jake's direction: patients can
  be tagged with their agency. New additive migration
  `schema-patients-agency.sql`: `patients.agency_id` (BIGINT
  FK → agencies) + `patients.agency_name_text` (free-text
  fallback for agencies NOT in the directory — patients
  change agencies, Jake noted). API: create/update whitelist
  both; bogus id → 400 `AGENCY_NOT_FOUND`; never both (id
  wins, text stored NULL; text-without-id clears a link);
  reads resolve `agency_name` (linked display_name, else
  free text). Agency changes ride the PIN-gated edit, and
  audit snapshots preserve the history. Dashboard
  (`AgencyPicker.tsx`, in Add + Edit forms with Status +
  Note): true type-ahead over the directory — no list up
  front, matches on display/legal/DBA/city/license #, 12
  rendered max with total count, patient's-city matches
  first, scope DEFAULTS to Chicagoland counties (Cook,
  DuPage, Kane, Lake, McHenry, Will, Kendall, Grundy) with a
  "search all Illinois" toggle; "Not listed" swaps to free
  text and back. Profile gains ONE line under the name:
  "Agency: …" (only when set). Tests: patients suite 67
  checks, all suites pass in both DB modes. Seeds assign no
  agencies. Dashboard bundle index-D1PZJerV.js.
- **Dashboard overview + Patient List changes — Local (same
  batch).** At Jake's direction: the overview's "Today's
  schedule" panel is REMOVED (DayAgenda component deleted;
  the `daySchedule` data and the "Today's visits (demo)"
  stat card stay) and Urgent triage spans the full width.
  The Patient List's zone-legend line is REMOVED (zone dots
  in rows stay) and replaced by a search bar at the top of
  the panel (agency-search styling, X-circle clear) wired
  to the same `query` state as the sidebar search, so both
  stay in sync. Bundle index-D1PZJerV.js.
- **CMS agency enrichment: service lines + star rating —
  Local (not deployed; batches with the themes build).** At
  Jake's direction: the IDPH directory has no service lines,
  so the sync gains a second pass over the CMS Provider Data
  "Home Health Care Agencies" dataset (data.cms.gov,
  `6jpm-sxkc`, datastore query API — browser user-agent
  required, the host 403s non-browser UAs). ILLINOIS-ONLY by
  design (Jake's hard requirement): the fetch uses the API's
  server-side `state = IL` filter (national rows are never
  downloaded), and enrichment only UPDATEs existing IDPH
  rows — it can never create an agency record, so the
  directory stays the 595 Illinois agencies. New additive
  migration `schema-agencies-cms.sql`: ccn, six offers_*
  booleans, star_rating, cms_ownership, cms_cert_date,
  cms_matched_at (all nullable; local fields untouched).
  Matching has no shared key: phone+ZIP primary, normalized
  name+ZIP (full name and DBA) secondary, unambiguous matches
  only. **Measured live through the built code: 531 CMS IL
  rows → 483 matched (91.0%), 0 ambiguous, 48 unmatched;
  483 of 595 IDPH agencies enriched, 386 with a star
  rating.** A CMS failure aborts only the enrichment pass and
  lands in the agency_sync event as cms_error + cms counts.
  API: GET /agencies returns the CMS fields and gains
  ?service= (comma list, ALL required) and ?min_rating=
  filters. CLI sample mode gains --cms-sample with a committed
  fixture. Dashboard: Rating column (sortable, best-first,
  unrated always last), service-line filter chips + Rating
  select (via the API filters), profile card star rating +
  Services (CMS) chips + CCN. Tests: agencies suite 55/55 in
  both DB modes (was 40), all other suites pass (appointments
  and events each pass in their documented run order/fresh-DB
  rerun — pre-existing quirks). Dashboard build passes with
  VITE_API_URL (bundle index-Cbp9GiIM.js). Research note:
  agency-directory-research.md CMS addendum.
- **Agency search clear button — Local (batches with the
  themes build).** At Jake's direction: the Agency directory
  search field gains a clear (X-circle) button that appears
  whenever the field has text; tapping it empties the search
  (restoring the full table) and returns focus to the field.
  The browser's built-in search clear is suppressed so there
  is only one clear affordance. Build passes (bundle
  index-BqyFtU50.js).
- **Agency table Agency column left-justified — Local (batches
  with the themes build for the next deploy).** At Jake's
  direction: agency names in the directory table rendered
  centered because the name is a `<button class="linklike">`
  and buttons center their label by UA default. `.linklike`
  now sets `text-align: left`, and the agency table's first
  column (header + cells) is explicitly left-aligned. Build
  passes (bundle index-BPhQ_fW4.js, CSS index-gEObT6tQ.css —
  includes the color-themes build below).
- **Selectable color themes (OpenEMR-style) — Local (not
  deployed).** At Jake's direction ("each theme has both light
  and dark modes, put this feature under the settings"), the
  dashboard's existing light/dark mechanism gains a second
  axis: a **color theme** — Teal (the original look, visually
  unchanged), Ocean (blue), Forest (green), Sunset
  (orange/amber), Plum (purple). Implementation extends the
  existing pattern rather than replacing it: `lib/theme.ts`
  gains `ColorTheme`, `COLOR_THEME_STORAGE_KEY`
  (`marcinnotech-color-theme`, default teal) and
  `COLOR_THEMES` picker metadata; `App.tsx` mirrors the mode
  wiring exactly (state → `data-color-theme` on `<html>` →
  localStorage); an inline script in `index.html` applies both
  axes before first paint so there is no flash of the wrong
  palette. In `styles.css` each theme × mode combination
  (10 total) fully defines ONLY the six accent-driven
  variables (`--teal`, `--teal-deep`, `--orange`, `--steel`,
  `--nav-active-bg`, `--nav-active-text`) — palettes were
  contrast-checked per mode against the current Teal baseline
  (new themes meet or beat it on primary-button, link, and
  sidebar-active contrast). **Clinical colors are untouched:
  `--green` / `--amber` / `--red` are defined only in the two
  mode blocks and stay identical in every theme**, so zone
  colors and the patient status bar keep their meaning.
  Settings → Theme card now groups the existing Light/Dark
  buttons with a **Color theme** picker: one tappable swatch
  chip per theme (accent + secondary dots for light, then
  dark; name, blurb, "Active" marker, `aria-pressed`),
  applying immediately with no save button. Dashboard build
  passes with VITE_API_URL (bundle index-B4uhoNXV.js); CSS
  verified programmatically — all 10 combinations complete,
  accent-only, no clinical variable redefined, and the
  picker's swatch hexes match the CSS values. NOT deployed —
  awaits Jake's go (next deploy token would be deploy-13).
- **UI batch (deploy-12) — Live.** Everything below that was
  tagged "Local (batches with the pending deploy)" shipped in
  this round at Jake's go: address-autocomplete mobile tap fix
  + Tab-to-accept; Profile + Patient List slimming; Agency page
  slimming + short-name-only table + site-wide tap-to-call;
  Clinician card redesign + Patients button/table; staff form
  credential dropdown; and the staff POSITION field end to end.
  API step: `schema-users-position.sql` applied on the VM as
  postgres (users gains `position` TEXT) + updated
  `routes/users.js` (backup `routes/users.js.bak-20261030-position`).
  Pre-deploy verification: local test harness rebuilt, staff
  e2e suites (users 25, users-mgmt) pass in limited-user mode
  with the migration applied, plus a position round-trip check
  (create/read/update + non-string 400) 5/5. Dashboard bundle
  index-CIZuS_y_.js, deployment
  https://7baf6464.marcinnotech-app.pages.dev (token
  deploy-12); live main URL serves the new bundle, /health ok.
- **Clinician card layout: avatar, FULL name, divider, position,
  email, phone — Local (batches with the pending deploy).** At
  Jake's direction, the staff directory card on the Clinician
  tab is restructured top to bottom: (1) a header row with a TEXT
  AVATAR (the `.avatar-circle` from the patient profile, initials
  = first letter of first + last name) beside the FULL name
  (first + middle + last + suffix, empty parts skipped, via a
  new `staffFullName` helper in Dashboard.tsx — previously just
  first + last); the avatar is COLOR-CODED BY ACTIVE STATUS —
  `.avatar-active` = `var(--green)`, `.avatar-inactive` =
  `var(--muted)` grey (clinician cards only; the patient profile
  avatar keeps the default teal); (2) a horizontal divider line
  (`.card-divider`) directly under the header row; (3) a
  POSITION line as its own line under the divider — the role
  label no longer sits beside the name; the line now leads
  with the person's TITLE in place of the role label
  (title · specialty), falling back to the role label only
  when no title is set — role and title are never shown
  together; (4) email; (5) a PHONE line — new on the
  card — cell first, then phone, both when both exist (deduped),
  `formatUSPhone`-formatted and tap-to-call via `telHref`;
  skipped entirely when no phone is on file. The old status line
  (Active/Inactive · Authorized · PIN set) is REMOVED from the
  card — display only; active status is conveyed by the avatar
  color, and the data stays in the record and edit form. The
  PIN-gated Edit/Deactivate/Reactivate buttons are unchanged
  after the phone line. A **Patients** button now sits beside
  Deactivate (read-only, NOT PIN-gated), rendered ONLY for
  active clinicians (`active === true`); inactive clinicians
  show just Edit + Reactivate, with no Patients button and no
  patients section. It toggles
  an inline section listing the clinician's ACTIVE assigned
  patients as a compact table (the Patient List table's
  `.patients-table` styling; a single Full name column only —
  the patient's full/display name as shown on their profile,
  e.g. "Rosa Delgado"; the Zone column, the Age/Sex column,
  and the zone dot beside the name were all removed at Jake's
  direction), one card open at a time. Clicking a row opens
  that patient's profile. Only patients whose patientStatus is
  active are included (hold/discharged excluded; a missing
  patientStatus counts as active, the profile status bar's
  convention); the empty state reads "No active patients
  assigned". Matching is on the patients table's free-text
  `clinician` field (no users FK exists): trimmed,
  case-insensitive equality with the full name as rendered on
  the card, falling back to first + last name when the full
  name matches nobody. Known limitation: the seeded demo
  patients carry clinician strings ("Dr. Alvarez", "P.
  Nguyen, PT") that match no staff record, so seeded cards
  show the empty state until a patient's clinician field
  carries a staff member's name. The staff Add/Edit form also
  gains a **Suffix / Credential** field directly after the
  name fields (previously there was no way to enter the
  suffix the card's full name renders): a DROPDOWN of common
  medical credentials (`STAFF_CREDENTIALS` in patientApi.ts —
  PT, DPT, PTA, OT, OTR/L, COTA, SLP, RN, BSN, APRN, NP, LPN,
  CNA, HHA, MSW, LCSW, RD, PharmD, MD, DO, PA, plus a blank
  "None"), stored in `users.suffix` through the existing
  PIN-gated writes; a stored value outside the list is kept
  as an extra option so an edit never silently wipes it.
  Staff also gain a real **position** field end to end: new
  idempotent migration `schema-users-position.sql`
  (`ALTER TABLE users ADD COLUMN IF NOT EXISTS position
  TEXT` — local only, NOT yet applied on the live VM);
  `routes/users.js` accepts `position` in the staff-write
  whitelist and returns it in the safe-column lists, so
  `GET /users`, `/users/me`, and `/users/clinicians` all
  carry it; the form gains a **Position** dropdown right
  after Suffix / Credential (`STAFF_POSITIONS` in
  patientApi.ts — 23 common home-health positions from
  Physical Therapist to Billing Specialist, plus Other and
  a blank "None", with the same out-of-list preservation);
  and the card's position line now LEADS with the position
  when one is set (position · specialty), falling back to
  title, then the role label, when it isn't.
- **Agency table short-name-only + site-wide tap-to-call — Local
  (batches with the pending deploy).** At Jake's direction: the
  Agency directory table's Agency column shows **only the
  display (short) name** — the full legal name and street that
  sat beneath it are removed from the table (the legal name
  still shows on the agency profile card). And **every phone
  number displayed anywhere in the dashboard is now a `tel:`
  link**: `telHref` moved into `lib/phone.ts` as the single
  shared helper (US numbers normalized to +1…), newly wired
  into the agency directory table's Phone column and the
  Contacts tab's agency-team cards; the patient profile
  home/cell phones and the agency profile card phone already
  were links and now use the same helper. Dashboard build
  passes (bundle index-B3oTJUuB.js, built with VITE_API_URL).
  NOT deployed — rides with the pending batch.
- **Agency page slimming — Local (batches with the pending
  deploy).** At Jake's direction: the Agency tab's sync panel
  removed (sync lives only in Settings → Agency directory);
  the "Our agency" card and "Set as our agency" removed
  entirely — Jake works for different agencies, so the app
  specifies no single agency (`is_primary` remains in the
  API/DB, unused by the tab); the directory card renamed to
  **Agency directory**; its table now shows **Agency / City /
  Phone only**, all sortable; tapping an agency name opens a
  **profile card** with every agency field (DBA, address,
  county, tap-to-call phone, admin contact, license # and
  expiration, source, last synced, status) and the PIN-gated
  local-details editor, which moved there from the table row.
  Dashboard build passes (bundle index-BvsLdxSo.js, built with
  VITE_API_URL). NOT deployed — rides with the autocomplete
  fix + profile/patient-list slimming batch.
- **Profile + Patient List slimming — Local (deploy pending;
  batches with the address-autocomplete touch/Tab fix).** At
  Jake's direction on a voice call: profile header shows a
  compact "74/F" (exact age from DOB via new `ageFromDob` +
  sex initial; decade band only as fallback) · Zone instead of
  the age band (the status word was removed from the header line
  later the same day); the zone explanation block became a color
  bar (color only, no text) that shows the patient's STATUS —
  green = active, amber = on hold, red = discharged; the alert/
  note line under the bar was removed from the card; the Last
  check-in / Next review / Clinician / Status details grid was
  removed;
  Demographics reduced to Full name only; Contact reduced to the
  full address + home phone + cell phone (email row removed);
  Care/consent & referrals, Emergency contact, and Billing
  sections hidden from the profile (data/API/Edit form
  untouched). The profile address is now a tap/click link to a
  free Google Maps directions URL (stored coordinates preferred),
  and both phone numbers are tap-to-call `tel:` links (US numbers
  normalized to +1). Editing: tapping the profile header opens
  the manager-PIN gate into the edit form — the standalone
  Edit/Delete buttons were removed, and the edit form itself
  carries Save changes + Delete patient (one verified PIN covers
  both; Delete moves to the existing soft-delete confirm).
  Patient List became a sortable table:
  "Lastname, Firstname" display (`listName`; no title/middle),
  zone dot before the name, Patient/Zone/Status header sorting,
  row tap/click opens the profile; the profile's patient
  selector uses the same Last, First format. Build passes
  (bundle index-CfyoUhbz.js). One mid-edit file splice briefly
  duplicated a JSX region; caught by the type-check, repaired,
  and re-verified — no other damage.
- **Agency table + IDPH directory import + auto-sync — Live
  (deployed 2026-10-30).** New `agencies` table
  (`schema-agencies.sql`, 10th table): the IDPH Home Health
  Agency Directory (Illinois open data, Socrata dataset
  `p7mg-cnpx` on illinois-edp.data.socrata.com — verified live:
  595 rows, rowsUpdatedAt 2026-04-28; mapping + samples in
  `~/workspace/marc-innotech/agency-directory-research.md`).
  `license_number` is the upsert key; a sync updates source
  fields only, inserts new agencies, and marks absent ones
  inactive (never deletes). Local fields a sync never touches:
  `is_primary` (our agency; at most one, partial unique index),
  `notes`, `short_name`. `lib/agencySync.js` is the single sync
  implementation + single `agency_sync` logging point (counts
  only): it skips when the dataset's `rowsUpdatedAt` is
  unchanged and aborts rather than deactivating the directory on
  an empty snapshot. Runners: `POST /agencies/sync`
  (manager-PIN), `sync-agencies.js` CLI (`--live` / `--sample`),
  and a weekly systemd timer packaged in `patient-api/deploy/`
  (Mondays ~03:00 VM time; install is a deploy step — see
  OPERATIONS.md). API: `GET /agencies` (search incl. DBA/short
  name), `/agencies/primary`, `/agencies/sync-status`,
  `PUT /agencies/:id` (PIN-gated, local fields only, logs
  `admin_action`); responses carry a computed `display_name`
  (short_name → embedded DBA → first two words → full name).
  Dashboard: Agency tab rebuilt (`AgencyView.tsx`) — Our agency
  card (demo-labeled fallback when the API is down), searchable
  directory with Active/Inactive badges, "Set as our agency" +
  local-details editor behind the PIN — and a Settings → Agency
  directory section whose "Update agencies" button runs the same
  sync (`AgencySyncPanel.tsx`, shared). Tests: new
  `e2e-agencies-test.js` 40/40; all eight suites pass in
  superuser and limited-user modes (patients 52, events 45,
  appointments 45 verdict, users 25, users-mgmt 28, messages 32,
  documents 38, agencies 40). Bug caught by the new suite:
  "latest sync" lookups must order event_log by `seq`, not the
  UUID `id`. DEPLOYED 2026-10-30 (Jake approved the combined
  maps + agency deploy): migration applied on the VM as
  postgres, first live sync inserted all 595 agencies (source
  rowsUpdatedAt 2026-04-28), weekly systemd timer installed
  and active (next run Mon 2026-11-02 03:00 UTC — the VM clock
  is UTC), API backups `.bak-20261030-mapagency`, dashboard
  bundle index-ByF2ZlN2.js (deployment d237c8a5, token
  deploy-11).
- **CareTask maps — Live (deployed 2026-10-30 with the agency
  deploy; bundle index-ByF2ZlN2.js).** Patients
  gain stored map coordinates: new idempotent migration
  `schema-patients-map.sql` adds `latitude`/`longitude` (double
  precision, range CHECKs) to patients; the patients API accepts
  and returns them (strict numbers-or-null validation, strings
  → 400). Address-autocomplete picks in Add/Edit Patient now save
  the picked location's coordinates from both engines (Nominatim
  lat/lon, Google Place Details `location`); hand-typed addresses
  leave them null. Dashboard gains a **Patients Map** (Patient
  submenu): Leaflet + OpenStreetMap, one pin per patient colored
  by zone, zone filter chips, popup with Open profile; patients
  without stored coordinates are geocoded on load (sequential
  ~1/sec Nominatim with session cache), falling back to an
  APPROXIMATE area-centroid pin (hollow/dashed, labeled) and then
  to a "Not placed" list — never silently dropped, never a
  fabricated street location. Demo consequence: the seed
  patients' fictional Springfield "Example" addresses all land as
  approximate ZIP-level pins (small deterministic spread so they
  stay individually clickable). Calendar gains a **Map** view: a
  day's appointments as numbered pins in scheduled order with a
  synced list, plus **Optimize route** — a labeled SUGGESTION
  ONLY (nearest-neighbor from a clinician start address,
  straight-line mileage estimate, differs-from-schedule warning,
  free "Open in Google Maps" directions link) that never writes
  to the appointments API. Patients e2e suite grows 46 → 52
  checks (coordinate round-trip + validation); all seven suites
  pass in superuser and limited-user modes (events suite's
  pre-existing async `patient_view` race flaked once in limited
  mode, passed on re-run). Dashboard build passes (bundle
  index-c2PLtfLQ.js; leaflet added as a dependency).
- **Clinical documentation v1 — Live (deployed 2026-10-30 in
  the maps + agency round — the integrated server build ships
  together and its migration is a prerequisite of the agency
  migration; bundle index-ByF2ZlN2.js).**
  OpenEMR encounter-forms pattern: new `documents` table
  (patient FK, optional appointment FK, author FK, doc_type
  CHECK evaluation/reassessment/discharge, sections JSONB,
  draft/finalized with finalized_by/at, soft delete) and
  `/documents` routes — create/edit/finalize are clinician acts
  (not PIN-gated; caller must resolve to an active staff row),
  finalized documents are locked (409 `DOCUMENT_FINALIZED`,
  the e-sign pattern), delete/restore are manager-PIN gated.
  Three PT templates (Evaluation, Reassessment, Discharge)
  defined once as section definitions in
  `patient-api/lib/documentTemplates.js` and mirrored in the
  dashboard; dashboard gains a Clinical Documents panel on the
  Patient Profile (template picker, section editor, finalize,
  PIN-gated delete). Mutations log `document_create` /
  `document_update` / `document_finalize` events with ids only —
  never note content; the Audit Log's filter/descriptions gained
  the new event names, display unchanged. New
  `e2e-documents-test.js`: 38 checks, passing in superuser and
  limited-user modes; all six prior suites still pass in both
  modes (fresh DB per mode; see DEVELOPMENT.md for the
  appointments-before-users suite-ordering note). Dashboard
  build passes (bundle index-DRXywLc2.js).
- **Messaging Phase 1 — Live.** OpenEMR-pattern messaging per the approved scope
  (`~/workspace/marc-innotech/messaging-scope.md`): new `messages`
  table (staff direct messages + patient-linked chart messages,
  threading, read receipts, sender-only soft delete) and routes —
  inbox/outbox/unread, patient chart list, thread reads with
  participant/care-team access rules; sends and reads log
  `message_send`/`message_read` events with ids only, never the
  body. 32-check e2e suite passes in both modes. Dashboard gains
  a Messages tab (unread nav badge, compose, thread view) and a
  chart-messages panel on the Patient Profile — ships with the
  dashboard deploy (bundle index-B65yeNuF.js, 2026-10-30).
  Patient-portal messaging
  (Phase 2) and SMS/email reminders (Phase 3) remain scoped
  proposals.
- **US phone formatting — Live.** All phone
  fields format as `(312) 555-0142` while typing (`lib/phone.ts`),
  and profile displays (incl. emergency contact) format on
  render.
- **Category management — Live.** Settings → Visit categories: change a visit type's
  default time, name, color, kind or description, add new
  categories, deactivate/reactivate — all manager-PIN gated via
  new category write endpoints (duplicate names 409, writes
  logged as admin_action). Deactivation is a state, never a
  delete. The endpoints are live on the VM; the Settings screen
  The dashboard screen is live (bundle index-B65yeNuF.js).
- **Appointments + Calendar — Live.** New OpenEMR-correlated calendar model: three tables
  (`appointment_categories` — color + default duration + cattype,
  mirroring `openemr_postcalendar_categories`; `appointment_statuses`
  — the `apptstat` list with check-in/check-out flags;
  `appointments` — patient/provider/category/room, soft delete)
  created live on the VM and seeded. Categories use home-health
  terminology (Jake, 2026-10-30): Initial Evaluation, Start of
  Care, Resumption of Care, Revisit, Reassessment, Transfer,
  Discipline Discharge, Admin Discharge, OASIS Discharge (13
  category rows incl. provider blocks) + 7 statuses + 15 demo
  appointments. Booking is open; edit/delete/restore are
  manager-PIN gated; status changes are ungated (flow board) and
  every mutation logs an `appointment_change` event. 29-check e2e
  suite passes in superuser and limited-user modes. Dashboard:
  the Appointment tab is now a Google-style Calendar (Month /
  Week / Agenda, `CalendarView.tsx`) — dashboard live
  2026-10-30 (bundle index-B65yeNuF.js). Recurrence and facility fields are
  deliberate deferrals (see API.md known gaps). Google Calendar
  API was evaluated first (memo:
  `~/workspace/marc-innotech/calendar-api-research.md`) — Jake
  chose our own store with a Google-style UI.
- **Staff management — Live.** Clinician tab is now a PIN-gated
  staff directory: Add / Edit / Deactivate / Reactivate, duplicate
  email 409s, self-deactivation blocked, every write attributed to
  the authorizing manager in the audit trail. API + dashboard.
- **Server-side manager PIN — Live.** Replaced the client-side PIN
  constant (deleted) with per-manager scrypt-hashed PINs in the new
  `users` table; patient edit/delete/restore and all staff writes
  verify via the API and fail closed.
- **Users table — Live.** 35 columns modeled on OpenEMR's `users`
  core fields + firebase_uid link + role + authorized flag.
- **Google Contacts import — Live.** People API
  research + prototype: patient import (Add Patient prefill) and
  staff import (multi-pick → PIN gate), GIS token client,
  contacts.readonly, sample-contacts path. GCP OAuth setup done
  (Testing status, two test users).
- **Google Places address autocomplete — Live.**
  AddressAutocomplete gains a Google Places (New) engine (session
  tokens, Chicagoland bias, Place Details fill) with automatic
  fallback to the Nominatim engine. Places API enabled; browser key
  created restricted to the dashboard origin + Places API only; no
  billing account added (free-tier scale).

## 2026-10-29

- **Patients table v2 — Live.** 43 columns: split name/address/
  phone, DOB-derived age, sex/race/ethnicity/language, consent
  flags, emergency contact, SSN/driver's license (stored, not
  displayed), billing fields, pharmacy_id. Re-seeded with 8
  fictional patients.
- **Audit core — Live.** `event_log` with SHA-256 hash chain over
  both audit tables, append-only triggers, request logging folded
  in, `/events` query + `/events/verify`, dashboard Audit Log view
  with chain-validity badge, sign-in/sign-out reporting.
- **API goes live.** https://api.marcinnotech.net — Caddy TLS on
  the GCP VM, Postgres 16, systemd service; DNS A record added.
- **Add Patient form upgrade — Live.** Address autocomplete
  (Nominatim, two-stage Chicagoland → US), duplicate-name warning
  panel, slim form per Jake's direction, State dropdown, Edit /
  Delete patient from the Profile.
- **Real-data moratorium removed as company policy** (Jake, CEO
  decision — see DECISIONS.md). System still holds fictional demo
  data only; BAA/incorporation remain open Phase 0 legal items.

## 2026-10-28

- **Shared VM decided**: marcinnotech-api hosts both the Marc
  Innotech demo backend and (when deployed) the jakemarc.com
  backend; split later when real data or paying customers arrive.
- jakemarc-api VM deleted; marcinnotech-api created by Jake with
  static IP 34.57.183.32.
- jake@marcinnotech.net email routing created and verified Active.

## 2026-10-27

- **Secure clinician dashboard launches** at
  marcinnotech-app.pages.dev: Firebase sign-in (email/password +
  Google), sign-in-only (no self-registration), Cornell
  Green/Yellow/Red patient zones, Mediso-style redesign (light
  default + dark toggle, Clinician/Agency labels), Dashboard /
  Patient List / Profile / Add Patient / Clinician / Agency /
  Contacts / Settings / Integrations / Help views, on-device
  Reports PDF export. Demo data only.
- Tagline decided: "Empowering clinicians to provide modern
  medical care."

## 2026-10-25

- marcinnotech.net goes live on Cloudflare Pages (custom domains +
  SSL), Cloudflare Email Routing enabled (info@ → jakemarc@gmail),
  MIT monogram in place. Domain auto-renew confirmed OFF at
  Squarespace — manual renewal before 2027-08-06.
