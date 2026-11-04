# Marc Innotech — Decision Log

One line per company decision: date, decision, who called it. Pending items are marked as such.

## 2026-10-02
- Company named **Marc Innovative Technologies (Marc Innotech)** — Jake.
- Roles: Jake = CEO, Milo = COO — Jake.
- Devon (subagent) created as Web Development Lead, promoted to **CTO** the same day. Owns all technology decisions (web, backend, infra, security, data); reports to Milo for execution; Jake has final say on product/business — Jake.
- First product: **brand website** for the company — Jake.
- Brand site scope: **coming-soon teaser** — just the brand and a contact line — Jake.
- Teaser styling: dark premium fintech look (matches Jake's personal site) — accepted proposal.
- Company domain: **marcinnotech.net** (Jake owns it); email + future TLS live there — Jake.
- Subdomain plan: `api.marcinnotech.net` → patient backend; root/www → brand via registrar forwarding — Devon (CTO call).
- Collaboration: run on built-in machinery (goals, tracked items, artifacts), **no external PM tool**; short weekly digest to Jake in chat — Jake, on Devon's recommendation.
- Mission/vision: draft exists (Devon's tightened mission version) — **pending Jake's sign-off**.
- Real-data moratorium on the patient platform until TLS + BAA are done — **pending Jake's sign-off**. **Superseded 2026-10-29 (see below).**
- Bio division (biomechanical devices for patient care): **long-term horizon**, parked — Jake.
- Company logo **locked**: crystal/faceted M inside a hexagonal badge (Jake's pick from generated concepts; Milo recommended badge over border ring). Held for the React rebuild, not applied to the current teaser — Jake.

## 2026-10-24
- Unicorn target **set**: Marc Innotech to reach a $1B valuation by Friday, March 5, 2027; Milo (COO) to drive it — Jake.
- Devon's unicorn sprint plan **approved as written** — Jake. Phases: Unblock Oct 24–Nov 7, 2026; MVP Nov 8–Dec 18, 2026; Pilot Dec 19, 2026–Jan 29, 2027 (5 recruited, ≥3 active weekly 3+ weeks); Paying Jan 30–Feb 26, 2027 (≥3 paying); Fundraise Feb 27–Mar 5, 2027. Unicorn = signed $1B term sheet / closed round; fallback March 5 checkpoint = live compliant MVP + pilots + paying customers + seed-ready data room.
- Incorporation and funding **added to Phase 0** — Jake. Incorporation to be completed before BAA in the company name, before real-PHI pilots, and before any outside money; Phase 0–1 bootstrapped, first outside money (if any) as a small angel SAFE after pilots prove time saved.

## 2026-10-29
- Real-data moratorium **removed** — Jake. CareTask real patient data is no longer gated on TLS/BAA/incorporation as company policy (TLS and audit are live; BAA and incorporation remain open as Phase 0 items). Recorded note: the BAA requirement for real PHI held by a cloud provider is a legal requirement, not company policy — removing the policy does not remove that exposure, accepted by Jake when deciding. The system still holds fictional demo data only; no real data was loaded by this change.

## 2026-11-02
- Manager PIN **removed** — replaced with **role gates** — Jake. Sensitive writes now check the caller's own active staff role (manager/admin) server-side (`lib/requireRole.js`); patient and appointment updates are ungated, with the caller's identity still recorded for audit attribution. Clinicians manage their patient list by **status** (On hold / Discharged — the patient leaves the active list without being deleted); true Delete/Restore stays manager-only. Expense approve/reject/pay are manager-role and additionally blocked for the report's own owner (`SELF_APPROVAL`). Live 2026-11-02 as deploy-26.

## 2026-11-02 — Expenses simplified to a mileage day log (Jake)
Jake: "all i need for now is a way to log mileage, and generate a expense report monthly or a date range, and filtered by agency, no need for approval process." Model refined by Jake the same day into a DAY CHAIN and approved via mockup ("looks good"): a day starts at home (address from the clinician's staff profile) -> agency office (address from the agency profile) — that leg is always fixed and personal; patients are then added in visit order, each consecutive leg billable, through the last patient, back to the office, then office -> home (fixed, personal). The office<->first/last-patient legs count as BILLABLE (as shown in the approved mockup). Routing defaults to tollways with a per-leg way to mark back roads (both figures stored per leg). Every leg's start/end can be set by tapping a known place (Home / Office / a patient) or typing an address with autocomplete. Consequences: the report-envelope approval lifecycle (draft/submitted/approved/rejected/paid, incl. the deploy-26 SELF_APPROVAL block) is RETIRED — reports are generated views over the log (month or custom range, agency filter); agency moved onto each mileage entry (existing entries inherit their report's agency; envelope rows stay as read-only history); the old driven-minus-commute day formula is replaced by the explicit chain; non-mileage expense lines are parked (data kept, out of the UI). Built locally 2026-11-02 (migration schema-mileage-chains.sql; API rewritten, e2e 45 checks green; dashboard ExpensesView rebuilt as the chain editor + generator); deploy pending Jake's go.

## 2026-11-02 — the queue ships as deploy-28 (Jake)
- Jake said **"run the queue"** — the eight queued CareTask items (patient merge, clinician tasks, CSV batch agency/status, calendar agency badges/filter, add-by-photo, reveal menu + profile cleanup, profile swipe, calling-app setting), the same-day follow-ons (Add form cleanup, desktop table scroll), and the afternoon dashboard round ship together as **deploy-28** — Jake.
- Add-by-photo engine: the **free on-device reader** (Tesseract.js in the browser; the photo never leaves the device) over cloud vision — Jake ("free photo add").
- Dashboard overview cards, from Jake's mockup round: card 1 = date/time + a weather icon, background changing by **season and time of day** (Jake confirmed); card 2 = appointments today, colored by count (bands as presented to Jake and shipped: 1–3 green, 4 yellow, 5–7 red, 8+ deep red, 0 plain); card 3 = total patients. The demo zone/triage cards are **removed** — Jake.
- An **RSS news card** (physical therapy / home health / APTA) sits on the desktop dashboard with shortened titles and descriptions, and its **topics are changeable in Settings** — Jake.
- The desktop dashboard stays **within one screen**, responsive — panels flex, lists scroll inside — Jake.

## Deploy-31 — calendar + intake batch (2026-11-02, LIVE)

Jake said "deploy" after an afternoon of calendar spec work.
Shipped as one batch: appointment patient autocomplete
(active only), photo parser v2 (his explicit pick: smarter
on-device parsing over cloud vision / hybrid), booking-form
order + defaults (patient first, Revisit, signed-in provider),
the Appointment/Calendar nav split with a 3 Day view, the
three-status model (Scheduled yellow / Completed green /
Missed red; cancelled deliberately left as its own state) with
its live-DB migration, and compact mobile day rows with his
visit codes (I.E., SOC, ROC, RE, DDC, ADC, ODC). Still open
after this deploy: the simple Google-style entry card, the
staggered-phase series builder, and drag-between-days — all
mocked and awaiting his build pick.

## Deploy-32 — queue run: entry card, series, drag, infra (2026-11-02, LIVE)

Jake: "run all of these." Executed: the simple entry card,
the staggered-phase series (the documented recurrence
deferral is closed — as linked rows, not a recurrence rule),
drag between days, automated VM database backups, and the
CORS + Places-referrer widening for preview origins. NOT run,
because they are not mine to run: the contacts/multi-agency
spec §9 decisions and the questionnaire sorter (Jake's
calls), his phone checks, and the AWS items (the past-due
balance is his payment; the IAM-user deletion sits in that
same account and was not done solo).

## Deploy-33 — calendar chrome (2026-11-03, LIVE)

Jake reviewed the live calendar on his phone and drove four
changes: icons on the view toggle; the agency filter out of
the toolbar into its own row (width + placement complaint);
the New appointment button onto that row and booking as a
full page instead of a card under the grid; and — his pick
of the two mockups — the mobile header band REMOVED entirely
(no duplicate heading, no pager, no range title on phones),
with edge-day month changes and Day-toggle-returns-to-today
as the replacement steering. Desktop keeps the band.

## Deploy-34 — Add Patient form, Paste intake (2026-11-03, LIVE)

Jake sent Google Contacts "create contact" photos as the
model for the Add Patient form: icon rows, placeholder-as-
label, a top-right Save, and progressive disclosure. His
refinements as we built: disclosure is an "Add field"
dropdown (add one field at a time, removable) rather than a
Show more block; the photo intake is REPLACED by a Paste
intake (raw text sifted on-device by the same parser) on
desktop AND mobile (he reversed his desktop-only call); the
entry card's visit type is a dropdown defaulting to Revisit;
the Room field is hidden (home health has no rooms; data
kept); appointment rows get their own Edit pencil because
the detail card's Edit button sat below the list where he
never saw it; and the booking page must scroll to the top
when it opens.

## Multi-user platform (2026-11-03, built — deploy pending Jake's go)

Jake's design, given across one session: every user gets a
blank workspace; sign-up is **invite-only** (Jake overrode the
open-sign-up recommendation); patient data entered by anyone
becomes part of a **master registry** ("their data becomes our
data") — an exact duplicate is blocked with "Already in our
database" + Add-to-my-list, a near match prompts "Possible
match — is this the same person?"; each user's list and list
status are personal. Sharing is by **episode**: one active
episode per patient across the whole platform (patient +
agency + primary + team); same-agency sharing happens by
assignment (a PT assigns to a PTA) without discharge; another
agency requires a discharge first, and the blocked user sees
WHICH agency holds the episode; discharge takes a date +
optional note and closes into history; same-agency
recertification is one tap. Two calendars: personal (default)
and a patient-centric master calendar on the chart. An
episode table was needed; an encounter table was NOT (the
appointment is the visit, the document is the note) —
vocabulary is episode/visit, not encounter.

Research synthesis (Jake: "can we combine the advantages of
each system to create a superior system", after Epic + HCHB +
OpenEMR model comparisons): ADOPTED into the build —
**coverage visits** (HCHB: a same-agency colleague may take a
single visit without joining the team; chart access rides on
the visit within ±7 days) and **Known Non-Duplicates** (Epic:
a reviewed-and-confirmed near match never prompts again for
the same intake data; exact matches never suppressed).
DELIBERATELY LEFT BEHIND — OpenEMR's permissive create-anyway
(Jake's hard block stands), Epic's two-level episode (HCHB's
flat certification-period model wins), Epic's security-class
complexity, HCHB's per-agency silos. Uniquely ours:
cross-agency master registry + one-active-episode lock across
organizations, invite-only multi-agency network, and the
exact-undo merge (deploy-28) that beats both OpenEMR's
non-recoverable merge and Epic's caveated unmerge.

Consequences recorded: the API perimeter moves from the
`ALLOWED_EMAILS` allowlist to the **staff-record gate +
invites** (the allowlist env var becomes vestigial at
deploy); Jake's current patients seed the registry, all
linked to him, via `migrate-platform.sql` (reviewed before
it runs live). Built + verified locally 2026-11-03 (API
65-check platform suite + full legacy battery green;
dashboard builds clean). Deploy (branch-first, API then
dashboard) awaits Jake's explicit go.

Addendum (same day, Jake's follow-ups, built into the same
local round BEFORE deploy): **episode holds** (a hospitalized
patient's episode goes on hold — still owns the patient, booking
paused, a Resumption of Care booking ends the hold) and
**structured discharge reasons** (so a patient who can't finish
an episode still closes with the why on record) were presented
as a design; Jake then approved **case manager** explicitly
("Add case manager to the build"), and the hold/reason work was
folded into that same build round as the foundation it builds
on (stated to Jake in the delivery report; his veto can split
them back out before deploy). Case manager (HCHB's model): a
distinct role from the primary — one team member who runs the
case clinically, defaults to the primary, is transferable
mid-episode, holds full management rights (hold/discharge/
recertify/team), and cannot be removed from the team until a
successor is named. Verified: platform suite 86 checks (21
new), full legacy battery green, dashboard builds clean.

Solo mode (same day, Jake's question + approval "Make solo
mode work"): the platform must serve a clinician who only
wants a patient list + calendar as practice management — no
other disciplines, no agency, no episodes. DECIDED: episodes
are the unit of SHARING, not a prerequisite for booking. No
live episode → booking works, visit stored unstamped
(personal); the gate's rules engage only once an episode
exists; a personal visit never creates an episode or blocks
an agency admission. Verified: platform suite 90 checks,
full battery green, dashboard builds clean.

DEPLOYED as deploy-35 (2026-11-03, Jake's go after reviewing
the migration walkthrough). API: schema + migration live
(backup caretask-20261103-174227.dump first). Catch found by
the counts: Jake's admin row (jakemarc@gmail.com) was inactive
in the live users table, so the migration's first run linked
only 8 patients; the row was activated (his recorded admin
account) and the idempotent migration re-run: 136 links, 4
episodes, 4 members, 5 memberships, 2 appointments stamped.
/health ok, 401 unauthenticated. Live patients: 128 — 119 of
them created 2026-11-02 (repeated contacts imports during
testing, before registry dedupe existed); cleanup via the
merge tool is Jake's call, not done. Dashboard: canonical
7525e40a, bundle index-D9AQpxmV.js, plus Jake's cache fix —
never-cache headers on the shell + version.json (verified
live) and a startup stale-build check that reloads once.
GitHub: branch deploy-35 600d79fc, main f16fae19, read-back
verified. Remaining verification: Jake's signed-in check.

PHONE CONTACTS SYNC (CardDAV) — Jake's choices (2026-11-03):
live sync over a vCard export; the phone list is named
"CareTask"; the CardDAV route over Google Contacts (People API
is not BAA-covered). Jake approved the spec's defaults
(one-way, read-only phone account, address included, hourly
reconcile, contacts.marcinnotech.net) by saying "go" to the
build. Spec: carddav-contacts-sync-spec.md. Built and deployed
as deploy-36: Radicale 3.9 on the API VM (systemd, htpasswd
bcrypt, rights = clinician read-only own book + service writer),
API sync engine + Settings card; verified locally against a
real Radicale (35 checks) before deploy. Public reachability
waits on the contacts DNS record + Caddy TLS; Jake's iPhone
pilot is the final verification.

## 2026-11-04 — Admin console on its own subdomain; Mission Control theme; seed rows deactivated

Jake asked for an administrators-only site ("a different
subdomain for user management, site monitoring, only for us
administrators") after the Nov 4 login/list audit showed why
his phone displayed ~130 patients and his PC 1 (different
logins, different per-user lists). Spec:
`admin-site-spec.md`. Jake picked the **Mission Control**
theme (dark ops deck) from three mockups — the console is
dark-only on purpose (dark = admin roof), independent of the
main app's themes. He approved the build with "go",
including the spec's §8 defaults: subdomain
admin.marcinnotech.net on the same Pages project; developer
counts as platform admin (the existing definition);
**deactivate the three @example.com seed staff rows** (done
in deploy-38 — all three inactive, so no test row holds an
admin-capable role); invites' home moves to the console
(the main-app Settings card is hidden; the Clinician
directory stays). Built and LIVE as deploy-38: API
`routes/admin.js` (read-only overview + users aggregates,
platform-admin gated, pin_hash never selected) with the
spec-first suite `e2e-admin-test.js` at 41/41 plus full
regressions; dashboard AdminApp with the named
"Administrators only" wall; DNS CNAME + Pages custom domain
active.
