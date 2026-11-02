# Dashboard — Developer Guide

Last updated: 2026-10-30
Live: https://marcinnotech-app.pages.dev
Source: `~/workspace/marc-innotech-secure/`

## Stack

Vite + React + TypeScript, a single-page app. Firebase
Authentication for sign-in. No component library — hand-rolled CSS
in `src/styles.css`, Mediso-style line icons (Jake's preference:
modern line icons over emoji). Light mode by default with a
persisted dark/light toggle (localStorage key
`marcinnotech-theme`), plus selectable color themes under
Settings (localStorage key `marcinnotech-color-theme`) — see
the theme contract below.

## Layout of the source

```
src/
  App.tsx                  routes: / → /app, /login, /app (RequireAuth)
  pages/
    Login.tsx              email/password + Google sign-in
    Dashboard.tsx          the whole signed-in app (large file)
    NotFound.tsx
  components/
    AddressAutocomplete.tsx  Google Places engine + Nominatim fallback
    PatientMap.tsx           shared Leaflet map (zone/numbered/approx pins)
    PatientsMapView.tsx      all-patients map (view retained; left the sidebar menu 2026-11-01)
    ExpensesView.tsx         Record → Expenses: expense reports + mileage
    DayScheduleMap.tsx       calendar Map view + route optimization
    GoogleContactPicker.tsx  contacts import picker (single/multi)
    CsvImport.tsx            Settings → Database utilities (CSV import)
    StateSelect.tsx          US state dropdown (value = 2-letter code)
    Mark.tsx                 the MIT monogram
  lib/
    firebase.ts            Firebase app/auth init (config from .env)
    patientApi.ts          ALL API calls + types (ApiUser, StaffInput…)
    demoData.ts            demo schedule/zones data, ZONE_GUIDE
    googleContacts.ts      People API client (GIS token, in-memory)
    googleCsv.ts           Google Contacts CSV parser + row mapping
    geo.ts                 geocoding, placement, haversine, nearest-neighbor
    reportPdf.ts           on-device PDF export (jsPDF)
    usStates.ts            50 states + DC
    theme.ts               mode + color-theme helpers, COLOR_THEMES picker metadata
```

`Dashboard.tsx` holds the views: Dashboard overview, Patients,
Patient Profile, Add Patient, Clinician (staff directory), Agency,
Contacts, Integrations, Settings, Help Center, and System → Audit
Log. Clinician and Contacts are reached from Settings buttons,
not the sidebar (see the staff grouping contract below). Labels
follow Jake's naming: **Clinician** (not Doctor),
**Agency** (not Departments).

The Patients list is a sortable table (2026-10-30; renamed
from "Patient List" and the sidebar button from "Patient" to
**Patients** 2026-11-01, Jake): names render as
"Lastname, Firstname" (no title/middle), the zone dot sits
before the name, and the columns are **Patient | Address**,
both sortable on click — Address shows the full address
(street, line 2, city, state, ZIP) and sorts by street, then
city. The Zone, Status, and Clinician columns were removed
from the table at Jake's direction (status data is untouched
everywhere else), and the Age/Sex column was removed
2026-11-01 (also Jake — age/sex now appears only on the
profile header, and only when recorded); tapping a row opens
that patient's profile. **On mobile
(≤720px; 2026-10-31, locally built) the table narrows to
Patient | Address | (call)**: the
Address cell shows a Navigation directions icon instead of
the address text (same free Google Maps directions URL as
the profile; no icon when there is nothing to navigate to),
and a call column with an empty header holds a Phone icon
that dials the patient's main number (`tel:` — home phone
when dialable, else cell). Both icons stop propagation so
tapping them never opens the profile. Desktop is unchanged,
and the forced-desktop view restores the desktop columns on
small screens. A **search bar sits at the top of the panel**
(agency-search styling, X-circle clear included — added
2026-10-30, locally built) driving the shared `query` state;
it replaced the
green/yellow/red zone-legend line (the zone dots in the rows
stay; ZONE_GUIDE still powers the guide elsewhere). The
**Dashboard overview no longer has a "Today's schedule" panel**
(removed 2026-10-30, locally built) — the overview layout holds
just Urgent triage at full width; the "Today's visits (demo)"
stat card is unchanged. The **Patients list likewise no
longer renders the "Schedule — today" day-calendar aside**
(removed 2026-10-30, locally built): the list section uses
the single-column layout and the patient table spans the
full width; the underlying demo schedule data still powers
the "Today's visits" stat and the profile's day view. The
zone disclaimer line that sat under the patient table ("The
zone classifies attention only…") is also removed (2026-10-30,
locally built) — nothing replaces it. The Patient Profile has **no patient
selector panel** (removed 2026-10-30, locally built): a plain
"Patient Profile" heading sits above the card, which spans the
full width — switching patients happens from the Patients
tab (row click → profile). The Patient sidebar submenu
likewise no longer carries a "Patient Profile" entry (removed
2026-10-30, locally built). **The submenu itself is gone
(2026-11-01, Jake):** Patients is a direct sidebar button
that opens the Patients page — no chevron, no expansion.
Add Patient moved onto the Patients page as a right-justified
**Add Patient** button in the page head (a **+ icon only** on
mobile, ≤720px), and Patients Map left the menu (the map
view code stays in place, currently unreachable from the
nav).

**Mobile floating view (2026-11-02, Jake; LIVE as deploy-19,
bundle `index-CQDxFnPf.js`):** at ≤720px the header and bottom-bar sidebar are
replaced by floating glass chrome — menu circle top-left
(sidebar becomes a slide-in drawer; theme + sign out at its
foot), desktop-view toggle circle top-right, and a floating
pill footer (Dashboard / Patients / Mileage / Calendar;
Mileage opens the mileage day log on today).
Patients on mobile: floating translucent search whose funnel
holds the only filter — Status, default Active — while search
itself searches all patients and overrides the filter; the
list renders as address-free cards (zone dot, name, status
word when not active, directions/call buttons). The Patient
Profile carries a floating vertical pill on the right edge
with Call / Directions / Edit icons only. Forced-desktop view
restores the desktop arrangement wholesale. Displayed patient names carry **no
honorific title** (`fullName()` composes first/middle/last/
suffix only; the stored `title` field is unchanged). The Patient Profile is deliberately slim: the
header line shows a compact "74/F" (exact age from DOB + sex
initial; the stored `age` column is the fallback when there is
no DOB, 2026-11-01) · Zone — and the age/sex segment is
omitted entirely when the patient has neither an age nor a
sex recorded (2026-11-01, Jake) (no status word — status is the color bar under
the header: green = active, amber = on hold, red = discharged,
color only, no text); the alert/note line is not shown on the
card; the header carries the full name (plus one "Agency: …"
line when the patient has an agency — see the Agency picker
note); Contact shows the full
address (tap/click → free Google Maps directions link,
coordinates when stored) and home/cell phones (tap-to-call
`tel:` links). Tapping the profile header opens the Edit form
directly (since 2026-11-02 — the manager-PIN gate in front of it
was retired with the PIN system); a **visible "Edit patient"
button** (Pencil) on the profile head triggers the same flow
(restored 2026-10-30 — the header tap alone wasn't discoverable;
the button hides while the Edit form or delete confirm is open).
The Edit form carries Save changes for everyone and a **Delete
patient button only for managers/admins** (role-gated; the API
enforces it). The read-only profile also carries a **"Manage
list" block** (2026-11-02, Jake): Put on hold / Discharge /
Return to active, shown per the patient's current status and
available to every clinician — removing someone from your active
list is a status change, not a delete. Status is a property of
the shared patient record, not per-clinician. The button is **icon-only (a
Pencil) since 2026-10-31** — `title`/`aria-label` keep the
"Edit patient" name; the Edit form's own "Edit patient"
heading is unchanged. On the **Add Patient form, Date of
birth and Sex are OPTIONAL** (2026-11-01, Jake — they were
required 2026-10-30 → 2026-11-01, marked *, validated
client-side, and enforced by the API's retired
`DOB_REQUIRED` / `SEX_REQUIRED`). Both Add and Edit forms
carry an **Age (if birth date unknown)** number field writing
the stored `age` column, used for display only when the
patient has no usable DOB. The check-in/
review/clinician details grid and the Care/consent, Emergency
contact, and Billing sections are not shown in the profile UI —
the data, API fields, and Edit form fields are unchanged.
**API date/id normalization** (`lib/patientApi.ts`, 2026-10-30,
local): the pg driver returns DATE columns as ISO timestamps
and BIGINT ids as strings, so the client normalizes at the
boundary — `normalizeApiPatient` truncates `date_of_birth` to
YYYY-MM-DD (applied in `toPersonUnderCare`, `searchPatients`,
and `getPatientAudit`; `date_of_birth` is the only DATE-only
patient column, timestamps stay whole, and appointment
date/time fields are deliberately untouched), and
`normalizeApiAgency` coerces agency `id` to a number. Before
this, the Edit form's birthday `<input type="date">` rendered
empty so birthdays appeared not to save, and a linked agency
showed as "Agency #<id>" instead of its name.

## Configuration (.env, gitignored)

| Variable | What |
|---|---|
| `VITE_FIREBASE_*` | Firebase web config for project `marcinnotech` |
| `VITE_API_URL` | Set at build time (`https://api.marcinnotech.net` for production builds) |
| `VITE_GOOGLE_OAUTH_CLIENT_ID` | OAuth client ID for contacts import — a public identifier, not a secret |
| `VITE_GOOGLE_MAPS_API_KEY` | Places browser key — referrer-restricted + API-restricted in Cloud Console |

Builds bake these values into the bundle; that is by design for the
public identifiers/keys above (the Maps key is protected by its
restrictions, not by secrecy).

## Behavior contracts worth knowing

- **Themes (mode × color theme)**: two independent axes, both
  applied as attributes on `<html>` by `App.tsx` and both
  persisted in localStorage — mode is `data-theme`
  (`marcinnotech-theme`, light default) and color theme is
  `data-color-theme` (`marcinnotech-color-theme`, default
  `teal`). An inline script in `index.html` applies both before
  first paint (no flash); React state then owns them. Five
  color themes — **Teal** (the original look, unchanged),
  **Ocean** (blue), **Forest** (green), **Sunset**
  (orange/amber), **Plum** (purple) — and each has BOTH a light
  and a dark variant in `styles.css`, so any color theme works
  in either mode (10 combinations, each fully defining the
  accent variables). The picker lives in **Settings → Theme**,
  grouped with the Light/Dark buttons in the same card: one
  tappable swatch chip per theme (name, accent +
  secondary dots for light then dark, "Active" marker),
  applying IMMEDIATELY on tap — no save button. Only
  accent-driven variables vary per theme: `--teal`,
  `--teal-deep`, `--orange`, `--steel`, `--nav-active-bg`,
  `--nav-active-text`. **HARD RULE: `--green` / `--amber` /
  `--red` are never redefined by a color theme** — zone colors
  and the patient status bar keep their clinical meaning in
  every theme and mode; they are defined once, in the mode
  blocks only. The Settings swatch hexes live in
  `COLOR_THEMES` in `lib/theme.ts` and mirror the CSS values —
  change both together.
- **App shell chrome** (2026-10-31, locally built): the header's
  mobile/desktop layout toggle is icon-only (Monitor /
  Smartphone; `title` + `aria-label` carry "Show the desktop
  layout" / "Switch back to the mobile layout"; the theme
  toggle beside it keeps its text label). The DEMO DATA
  banner that sat under the header and the placeholder KPI
  row under it (Caseload by zone / Flags reviewed / Visits
  this week / Clinician workload, "Graph coming soon") are
  removed — the shell goes straight from the header to the
  sidebar + main body. Their CSS rules remain in styles.css,
  unused. (The API-unreachable fallback notice inside the
  main area is a separate element and stays.)
- **API-optional shell**: if the API is unreachable, patient views
  fall back to the on-screen demo list and a banner says so; the
  Clinician tab falls back to a read-only derived view. Anything
  Role-gated controls fail CLOSED (role unknown → treated as
  non-manager, so manager-only controls stay hidden).
  Since deploy-20 (2026-11-02) the sign-in check retries once
  after ~1.5s before this fallback verdict — a single failed
  first attempt no longer brands the session.
- **Role gates (2026-11-02, replacing the manager-PIN flow)**:
  the dashboard fetches the caller's own staff record once per
  sign-in (`GET /users/me`, `useMyRole` hook, cached per user).
  Manager/admin accounts see the gated controls (patient Delete,
  staff Add/Edit/Deactivate, category editing, agency sync/local
  edits, document Delete, expense review); everyone else gets
  read-only views with a short explanation line. Edits that used
  to sit behind the PIN (patient Edit, appointment save) now open
  directly for all clinicians. API role rejections
  (`ROLE_REQUIRED` / `NO_STAFF_RECORD`) surface as "That action
  needs a manager or admin role."; `SELF_APPROVAL` on expenses
  surfaces as "You can't process your own report — another
  manager needs to do this one." There is no PIN anywhere in the
  client anymore.
- **Clinician (staff) cards**: layout top to bottom — a header
  row with a text avatar (`.avatar-circle`, initials from first +
  last name) beside the FULL name (first + middle + last +
  suffix, empty parts skipped — `staffFullName`); the avatar is
  color-coded by active status (`.avatar-active` green /
  `.avatar-inactive` grey — clinician cards only, the patient
  profile avatar stays teal); then a divider line
  (`.card-divider`), a position line that leads with the
  person's POSITION when one is set (position · specialty),
  otherwise their TITLE in place of the role label (title ·
  specialty), falling back to the role label only when
  neither position nor title is set — position, title, and
  role are never shown together — then email, then a phone line
  (cell first, then phone; both when both exist; US-formatted and
  tap-to-call; omitted when no phone is on file). There is NO
  status line on the card — active status shows in the avatar
  color (authorized status lives in the record and edit form);
  Edit / Deactivate / Reactivate are manager/admin-only (the
  role gates above).
  The staff Add/Edit form carries a **Suffix / Credential**
  dropdown directly after the name fields — a list of common
  medical credentials (`STAFF_CREDENTIALS` in patientApi.ts:
  PT, DPT, PTA, OT, OTR/L, COTA, SLP, RN, BSN, APRN, NP, LPN,
  CNA, HHA, MSW, LCSW, RD, PharmD, MD, DO, PA, plus a blank
  "None") stored in `users.suffix` and rendered as part of
  the card's full name; a stored value outside the list is
  kept as an extra option so an edit never silently wipes
  it. Directly after it sits a **Position** dropdown
  (`STAFF_POSITIONS` in patientApi.ts — 23 common
  home-health positions, from Physical Therapist through
  Billing Specialist, plus Other and a blank "None"),
  stored in `users.position` (migration
  `schema-users-position.sql`; the API returns it on
  `GET /users`, `/users/me`, and `/users/clinicians`) and
  shown leading the card's position line; same out-of-list
  preservation as the credential dropdown.
  Beside Deactivate sits a **Patients** button (not
  PIN-gated — read-only), rendered ONLY for active clinicians
  (`active === true`); inactive clinicians show just Edit +
  Reactivate, with no Patients button and no patients section.
  For active clinicians it toggles an inline section on the
  card listing the clinician's ACTIVE assigned patients as a
  compact table in the Patients table's styling — a single
  Full name column only (the patient's full/display name as
  shown on their profile, e.g. "Rosa Delgado"; no Zone column,
  no Age/Sex column, and no zone dot — Zone and Age/Sex were
  removed at Jake's direction). The list is active-only
  (`patientStatus` active; hold/discharged
  excluded, a missing patientStatus counts as active).
  Clicking a row opens that patient's profile; no matches
  shows "No active patients assigned", and only one card's
  section is open at a time. Assignment is matched on the
  patients table's FREE-TEXT `clinician` field (there is no
  users FK): the patient's clinician string is compared
  (trimmed, case-insensitive) to the clinician's full name as
  rendered on the card, falling back to first + last name when
  the full name matches nobody — so the list is only as
  accurate as the names typed into the patient records (the
  seeded demo patients carry clinician strings like "Dr.
  Alvarez" / "P. Nguyen, PT", which match no staff record and
  show the empty state).
- **Staff grouping — Clinical / Non-clinical** (`staffGroups()`
  in Dashboard.tsx; built locally 2026-10-30): the staff
  directory is split into two groups by the users table's
  existing `authorized` flag — CareTask's provider flag.
  **Clinical staff** = authorized (can be assigned patients);
  **Non-clinical staff** = everyone with `authorized = false`,
  whatever their role. No new field, no schema change. The
  grouping applies in two places: the **Clinician page**
  (cards grouped under "Clinical staff" / "Non-clinical staff"
  headings, card layout and all actions unchanged — the
  Patients button keeps its active-only render rule, so it
  appears in the clinical group in practice; an empty group
  shows "No clinical staff yet" / "No non-clinical staff yet")
  and the **Contacts page**, which is now the REAL staff
  directory in read-only form: same users fetch, same two
  group headings, cards showing name, position line, email,
  and tap-to-call phones (shared `staffPositionLine()` /
  `staffPhoneNumbers()` helpers). The Contacts page's old demo
  content — derived clinician cards plus the four fictional
  "Agency team" placeholders (555 numbers, .example emails) —
  is REMOVED; when the API is unreachable the page shows an
  honest "staff directory is unavailable" note instead of any
  fallback contacts. The Clinician page's API-unreachable
  derived-from-patients fallback is unchanged. Consequence of
  the classification: CSV/Google-imported staff start
  `authorized = false`, so they land under Non-clinical until
  someone checks Authorized in the staff form.
- **Clinician + Contacts live under Settings** (built locally
  2026-10-30): their sidebar nav buttons are removed (the
  sidebar is one element — the ≤720px media query restyles it
  into the mobile bottom bar, so both navs lose the buttons
  together). Settings carries **Clinician** and **Contacts**
  buttons in a titled **Personnel** card, and the **Log**
  button in its own titled **Logging** card below it; each opens its view as
  its own page with a **← Back to Settings** button, following
  the Log / Visit categories page pattern, and the Settings
  nav item stays highlighted while either page is open. The
  tab state is unchanged (`clinician` / `contacts`), and no
  other view linked to those tabs.
- **Sidebar header** (2026-10-31, locally built): the sidebar
  has no search bar anymore — the search box that sat at its
  top is removed, and patient search lives only on the
  Patients page (same shared `query` state; the
  `.sidebar-search` CSS rules remain, unused). The
  collapse/expand chevron now shares one row with the
  **Main Menu** group label (`.sidebar-head` flex row —
  label left, chevron right, same button behavior/icons/
  titles as before) instead of sitting alone above the nav.
  When the sidebar is collapsed the label hides as before
  and the row centers the lone chevron; on mobile both stay
  hidden as before.
- **Add Patient form** (final shape, per Jake's slimming): Name
  (first/middle/last, DOB, Sex) / Contact (phones, address with
  autocomplete, State dropdown) / Status + Note. Fields not on the
  form still exist as DB columns and display on the Profile.
  Duplicate check: debounced first+last-name match, warning only,
  never blocks saving; matches render as "Lastname, Firstname —
  MM/DD/YY" with an OPEN button.
- **Agency picker** (Add + Edit Patient forms, with Status +
  Note at the end of the form; built locally 2026-10-30):
  `components/AgencyPicker.tsx`. Optional. Two modes, never
  both: pick from the IDPH directory (sets `agency_id`) or
  "Not listed — type the agency name" free text (sets
  `agency_name_text`). The directory side is a true type-ahead
  — no list up front; suggestions appear as you type, matched
  against display name / legal name / DBA / city / license #,
  capped at 12 rendered with the total match count ("Showing
  12 of N matches — keep typing to narrow"); agencies in the
  patient's own city (the form's City field) sort first. Scope
  DEFAULTS to Chicagoland counties (Cook, DuPage, Kane, Lake,
  McHenry, Will, Kendall, Grundy — the address autocomplete's
  metro expressed as counties) with a "search all Illinois"
  toggle widening to the full 595. The Edit form prefills from
  the patient and can switch modes; changing agencies rides
  the PIN-gated edit, and the API audit snapshots preserve the
  history. The Profile shows ONE line under the patient's name
  — "Agency: …" — only when an agency is set. When the
  directory can't be used (API unreachable — e.g. a
  per-deployment preview origin the API's CORS allowlist
  rejects, which drops the picker to free text — or the
  directory fetch failed), the free-text fallback shows a
  visible note saying so and pointing to the main domain for
  the searchable directory; free-text entry itself is
  unchanged. The suggestion dropdown anchors directly beneath
  the input (a `position: relative` wrapper around input +
  dropdown, the `.addr-wrap` pattern) instead of below the
  toggle links, and rows pick on pointerdown with the
  deploy-12 dedupe guard so phone taps register reliably.
  In both patient forms the picker sits in a non-label
  `.form-field` wrapper (caption in a `<span>`), never a
  `<label>`: a tap on the text inside a suggestion row could
  trigger the label's activation behavior, refocus the input,
  and steal the gesture before the selection landed.
  The selected agency's name resolves through
  `normalizeApiAgency` in `patientApi.ts`: pg sends the BIGINT
  `id` as a string ("446"), so `fetchAgencies`,
  `fetchPrimaryAgency`, and `updateAgency` coerce `id` to a
  number before returning, and the picker's selected-agency
  lookup compares `Number(a.id) === Number(agencyId)` as a
  backstop — without that, the chip fell back to
  "Agency #446" instead of the agency's name.
- **Phone format**: all phone fields (patient home/cell, staff
  cell) format as US `(312) 555-0142` while typing via
  `lib/phone.ts` `formatUSPhone` (digits-only core, leading 1
  tolerated, progressive formatting); profile displays format on
  render too, including the emergency-contact phone.
- **Tap-to-call (site-wide)**: every phone number the dashboard
  displays is a `tel:` link via `lib/phone.ts` `telHref` (the
  one shared helper; US numbers normalize to +1…): patient
  profile home/cell, agency profile card phone, the agency
  directory table's Phone column, and the Contacts tab's
  agency-team cards.
- **Address autocomplete**: Google Places (New) when the Maps key
  is configured (session token per typing session, Chicagoland
  locationBias, US-only; Place Details fills the fields; footer
  "Powered by Google"); automatic fallback to the two-stage
  Nominatim engine (Chicagoland-bounded first, whole US
  second). The fallback engages on ANY Google failure: an HTTP
  error (including the referrer-restricted browser key's 403
  on per-deployment preview origins), a network error, a hung
  request (the Google attempt is time-boxed at 4.5s), or a
  response with zero usable predictions; a failed Place
  Details call resolves the picked label through Nominatim
  before degrading to the raw prediction text.
  In both patient forms the Street field uses the same
  non-label `.form-field` wrapper as the agency picker for
  the same reason: wrapping this custom dropdown in a
  `<label>` let a tap on suggestion-row text trigger label
  activation and steal the pick.
  Since the maps build (2026-10-30, local), a pick also captures
  the location's latitude/longitude (Nominatim `lat`/`lon`, Places
  `location`) and saves it with the patient; typing an address by
  hand clears/leaves the coordinates null.
- **Contacts import**: Add Patient → single-pick prefill (nothing
  saves until the normal Save); Clinician tab → multi-pick →
  manager-PIN gate → create staff as clinician/unauthorized,
  skipping existing emails and reporting a summary. Sample contacts
  (4 fictional people) exercise the full flow with no Google
  connection. OAuth app is in Testing status — only the two
  test-user accounts can connect real contacts until Google OAuth
  verification is done (pre-pilot task).
- **Patient zones**: Green/Yellow/Red per the Cornell Traffic Light
  model (`ZONE_GUIDE` in demoData.ts; research in
  CORNELL-ZONES-NOTES.md). The Cornell questionnaire sorter is NOT
  built (open decision).
- **Log view (formerly Audit Log)**: the logging mechanism,
  filters, and chain badge are exactly as originally built
  (Jake, 2026-10-29: "don't change the way you log"). At Jake's
  direction on 2026-10-30 the *navigation and presentation*
  changed: the sidebar Audit Log button was removed; Settings
  now has a **Log** button (in the **Logging** card) that opens the log on its own page
  (heading "Log", Back to Settings button, Settings nav stays
  highlighted). Events render as a **table** (Event | Actor |
  Time | Type | Patient | IP) instead of cards, with a
  browser-side **search** box and **sortable column headers**
  (both act on the loaded page of events, on top of the
  unchanged server filters), plus an **Export** button that
  downloads the table as shown (search + sort applied) as
  `caretask-log.csv` and reports a `report_export` event.
- **Patients Map + day schedule map** (`PatientsMapView.tsx`,
  `DayScheduleMap.tsx`, `PatientMap.tsx`, `lib/geo.ts` — built
  2026-10-30, live the same day): Leaflet + OpenStreetMap
  tiles (free, no API key). Patient submenu gains a **Patients
  Map** view: one pin per patient, colored by zone, zone filter
  chips matching the patient list, click a pin for a popup with
  name/zone/address and an Open profile button. Placement order:
  stored coordinates → Nominatim street geocode → APPROXIMATE
  area-centroid pin (hollow, dashed ring, popup says "approximate
  — area only") → listed under "Not placed", never dropped.
  Geocoding is sequential (~1/sec, Nominatim courtesy) with a
  session in-memory cache; identical coordinates get a small
  deterministic spread so stacked pins stay clickable — the demo
  Springfield/"Example" addresses exercise exactly this path (all
  approximate ZIP-level pins). The Calendar gains a **Map** view:
  a selected day's appointments (cancelled excluded) as numbered
  pins in scheduled time order with a synced list (all providers —
  the calendar has no provider filter). **Optimize route** on the
  day map is a SUGGESTION ONLY: nearest-neighbor order from a
  start address (geocoded the same way, persisted in localStorage
  only), renumbered pins, straight-line mileage labeled as an
  estimate, a warning when the suggested order differs from
  scheduled times, and an "Open in Google Maps" free directions
  link. It never writes to the appointments API.
- **Calendar (Appointment tab)**: Google-style Month / Week /
  Agenda / Map views over the appointments API (`CalendarView.tsx`).
  It opens on **Agenda** — the daily schedule list — by default
  (2026-10-31, locally built); the agenda fetch window is today
  forward 31 days, so today's visits are always in the first
  load. Month grid: category-colored chips, click a day for its list,
  double-click to book. The booking form follows OpenEMR: picking
  a category fills the default duration; provider is a staff
  picker (authorized + active); provider-type categories (Lunch,
  Vacation…) hide the patient picker. Status changes from the
  detail card are one click and NOT PIN-gated (flow board);
  Edit/Delete go through the same manager-PIN panel as staff.
  When the API is unreachable the tab shows an honest notice —
  appointments live in the database, so there is no local fallback
  data.
- **Messages tab** (`MessagesView.tsx`): Inbox / Sent over the
  messages API, unread rows highlighted, an unread badge on the
  nav item. Opening a thread marks my messages in it read.
  Compose takes a staff recipient and/or a patient attachment;
  replies stay in the thread; my own messages can be deleted
  (sender-only soft delete). A **Messages panel on the Patient
  Profile** shows the chart thread and posts chart messages.
- **Clinical documents panel** (`ClinicalDocuments.tsx`, Patient
  Profile, below Messages — built 2026-10-30, LIVE since the
  2026-10-30 maps + agency deploy): the patient's documents from the documents API
  (type label, title, Draft/Finalized badge, author, updated
  date). New document = template picker (Evaluation /
  Reassessment / Discharge; definitions in
  `src/lib/documentTemplates.ts`, mirrored from the API) + title
  prefilled from the template; the editor renders one textarea
  per template section. Save draft is not PIN-gated; Finalize
  asks for confirmation and then renders read-only (finalized =
  locked, OpenEMR e-sign pattern); Delete goes through the
  manager-PIN panel (PIN verified via the API, held in memory
  only). There is no restore UI — the list excludes deleted
  documents. The Audit Log gained the `document_create` /
  `document_update` / `document_finalize` event names in its
  filter + one-line descriptions only; the view itself is
  unchanged (frozen display rule).
- **Settings → Visit categories** (`VisitCategoriesSettings.tsx`):
  the Settings card itself is slim — just **Add category** and
  **List categories** buttons. List categories opens a separate
  **Visit categories page** (its own tab, with a **Back to
  Settings** button) showing every category (active + inactive)
  with color swatch, default visit minutes, kind, description;
  Edit (name, kind, color picker, minutes, description) /
  Deactivate / Reactivate live on that page — all through the
  manager PIN panel, verified PIN held in memory while the
  page is open. This is where a practice changes a
  visit type's default time or adds a new visit type.
- **Agency tab** (`AgencyView.tsx`; live 2026-10-30, then
  slimmed by Jake the same day — slimming LIVE 2026-10-30 in
  the deploy-12 batch): just the searchable statewide
  directory under the heading **Agency directory** (server
  search over name/DBA/short name/city/license, "Show inactive"
  toggle). The table shows **Agency / City / Phone only**, all
  three sortable (client-side; the fetch loads the whole
  directory). The table renders inside a **scroll region
  capped at roughly one screen height** with the sortable
  column headers stuck to its top, so all ~595 rows load
  without stretching the page (2026-10-30, locally built).
  Tapping an agency name opens its **profile card**:
  every API field (DBA, full address, county, tap-to-call
  phone, admin contact, license # + expiration with a <90-day
  amber highlight, source, last synced, Active/Inactive) plus
  the manager-PIN-gated local-details editor (short name +
  notes) — directory fields themselves are IDPH's and
  read-only.
  **CMS enrichment UI (built locally 2026-10-30 — not yet
  deployed):** the table gains a **Rating** column between
  City and Phone ("★ 4.5"; "—" when unrated), sortable like
  the others — rating sorts best-first by default and unrated
  rows are always last in both directions. Under the search
  row, **service-line filter chips** and a
  **Rating select** (Any / 3+ / 4+ / 4.5+) filter the table.
  The chips spell the service out on desktop (All services,
  Nursing care, Physical therapy, Occupational therapy,
  Speech pathology, Medical social services, Home health
  aide) and abbreviate on phones ≤720px (All, SN, PT, OT,
  ST, MSW, HHA) — both labels render in spans and CSS
  switches them, with the forced-desktop view restoring the
  full names on small screens (2026-10-31, locally built);
  each chip's `aria-label` always carries the full name.
  these go through the API (`?service=` / `?min_rating=`),
  combining with search + Show inactive, while sorting stays
  client-side over the returned rows. The profile card shows
  the star rating near the top ("★ 4.5 — CMS quality of
  patient care rating", or "Not rated by CMS"), a
  **Services (CMS)** chip list (offered = ✓ highlighted,
  not offered = — muted), and CCN / ownership / CMS
  certification date when matched; unmatched agencies say so
  plainly instead of showing blanks. REMOVED at Jake's direction (2026-10-30): the
  "Our agency" card, "Set as our agency", and the tab's sync
  panel — Jake works for different agencies, so no single
  agency is specified (`is_primary` still exists in the
  API/DB, unused by this tab), and syncing lives only in
  Settings (below). When the API is unreachable the tab says
  so; the directory is never faked in the browser. The demo
  service-lines block that used to sit under the directory —
  a "demo placeholder" note plus six hard-coded discipline
  cards (PT/OT/Speech/Nursing/Aide/Social Work) — is REMOVED
  (2026-10-31, locally built); the tab is the heading and
  the directory only.
- **Settings → Agency directory** (`AgencyDirectorySettings.tsx`
  + shared `AgencySyncPanel.tsx`): the only in-app sync, here
  labeled **Update agencies** — one
  PIN-gated `POST /agencies/sync`, showing the source label
  ("Source: IDPH Home Health Agency Directory (Illinois open
  data)"), last synced time + last summary counts, total/active
  directory counts, and the auto-sync status line ("Automatic
  updates: weekly … activates when deployed"). A skipped sync
  reports "Already up to date". Sync errors surface plainly in
  both places, never silently.
- **Settings → Database utilities** (`CsvImport.tsx` +
  `lib/googleCsv.ts`): the connected card's description above
  its buttons is exactly **Import from CSV**. Behind that
  minimal label, it imports a Google Contacts export
  (the CSV form of Google People contacts) through two buttons,
  **Import patients** and **Import staff**, each opening its own
  flow inside the card. The parser is a real CSV state machine
  (quoted fields, embedded commas/newlines, CRLF, numbered
  `E-mail N` / `Phone N` / `Address N` column groups) and maps
  rows into the SAME `ContactCandidate` shape as the People API
  import — one mapping vocabulary for both paths — plus the
  CSV-only title/suffix and a three-way phone split (Mobile →
  cell, Home → home, Work/Main/Other → main). The parser
  accepts BOTH Google header dialects (2026-11-01 fix):
  Takeout/People-style (Given Name / Family Name,
  `Organization 1 - Name`) and the contacts.google.com export
  (First Name / Last Name, `Organization Name`, no E-mail or
  Gender columns) — before the fix, a file in the second
  dialect parsed to zero contacts and the preview reported
  "No importable contacts were found in that file" (Jake's
  own contacts.csv: 29 contacts, all importable after the
  fix). Birthday accepts
  `YYYY-MM-DD` and `MM/DD/YYYY`; the yearless `--MM-DD` form
  maps to blank (a year is never invented). Region names map to
  state codes; Gender maps only onto the stored sex values.
  **Privacy shape:** the file is parsed in the browser only and
  never uploaded; only confirmed rows are sent, one by one,
  through `createPatient` / `createStaff`. **Preview contract:**
  nothing saves before the preview — every row shows a status:
  patients get Ready / Missing required (first and last name
  only — date of birth and sex became optional 2026-11-01 and
  are never flagged) / Possible duplicate
  (exact first+last match against existing patients, DOB match
  noted); staff get Ready / Missing required (email, first,
  last) / Already on the team / Duplicate in file. Ready rows
  start checked; problem rows are unchecked and locked. The
  Import button names the row count it will save. **Staff
  saving is manager-PIN gated first** (verified PIN held in
  memory while the card is open; a PIN rejection stops the
  import mid-run and reports partial counts); imported staff
  start as role `clinician`, `authorized=false`. Patient saves
  collect per-row failures without aborting the rest and end
  with "Imported X · Skipped Y · Failed Z" plus a failure list;
  created patients are handed up to the dashboard so the
  patient list includes them without a reload. **Fails
  closed:** with no API connection the card shows the
  not-connected notice and no import is possible. Fields
  Google has no equivalent for (SS, driver's license, billing,
  zone, agency, consent flags) stay blank/default — patients
  default zone green, status active, country US, matching the
  Add Patient form. Staff address parts are parsed but not
  sent (the `StaffInput` surface carries no address fields,
  same as the Google Contacts staff import), and the CSV note
  maps to patients' care note only.

- **Record → Expenses** (`ExpensesView.tsx` +
  `lib/expensesApi.ts`; REBUILT 2026-11-02 as a mileage day
  log, LIVE via deploy-27): the view is now **Mileage** — a
  per-day chain editor plus a report generator; there is no
  approval flow and no report envelopes in the UI. The chain
  builds itself: Home -> Office bookends are fixed PERSONAL
  legs (addresses from the clinician's staff profile and the
  agency profile, geocoded client-side; their routed miles
  snapshot onto the day's legs at save). Stops added between
  them are billable legs in visit order, ending back at the
  office. Every stop can be set three ways: tap **Home** /
  **Office**, pick a **patient** (name search; address +
  coordinates + patient link come from the record), or type
  any address in the shared AddressAutocomplete. Legs route
  automatically when both endpoints have coordinates
  (`POST /mileage/route`); each billable leg carries a
  **Tollway / Back roads** toggle (default tollway; both
  figures shown), miles stay hand-editable, and the
  Billable/Personal badge can be tapped to override the
  derived kind. Day totals split billable / personal /
  driven / reimbursement at the day's rate (localStorage
  `caretask-mileage-rate`). Switching date or agency with
  unsaved changes is refused. **Expense report** card:
  month preset or custom range + agency filter (or all) ->
  generated day-by-day report with per-leg detail and a
  Print / PDF button (print CSS isolates the report block).
  Fails closed like before: with the API unreachable the
  view is a notice only. The old envelope UI (report list,
  submit / manager review / print window) is gone; legacy
  reports remain readable through the API only.

## Build & deploy

```bash
cd ~/workspace/marc-innotech-secure
VITE_API_URL=https://api.marcinnotech.net npm run build
npx --yes wrangler pages deploy dist \
  --project-name marcinnotech-app --commit-dirty=true
```

Deploys authenticate with a one-time Cloudflare API token (Account
→ Cloudflare Pages → Edit; created fresh per deploy round, used
transiently from the terminal env, never stored). Cloudflare
sign-in for token creation is email + password for
jakemarc@gmail.com plus an emailed 7-digit two-factor code, which
Jake relays. After deploying, verify the main URL serves the new
bundle filename and the asset returns 200. See OPERATIONS.md for
the full runbook.

Local dev: `npm run dev` (Vite, port 5173 — this origin is on both
Google allowlists: OAuth JS origins and the Maps key referrers).
