# Architecture

Last updated: 2026-10-30

## Components

```
 Clinician browser
       │
       ├─► Cloudflare Pages ──► CareTask dashboard (React SPA)
       │        marcinnotech-app.pages.dev
       │
       ├─► Firebase Authentication (project "marcinnotech")
       │        email/password + Google sign-in; issues ID tokens
       │
       ├─► Google People API (contacts import, read-only, per-user
       │        OAuth via Google Identity Services — token in
       │        browser memory only, nothing synced or stored)
       │
       ├─► Google Places API (New) (address autocomplete; browser
       │        key, referrer-restricted; OpenStreetMap Nominatim
       │        is the automatic fallback)
       │
       └─► https://api.marcinnotech.net (DNS-only A record)
                │
           GCP VM "marcinnotech-api" (e2-micro, us-central1-a)
                ├─ Caddy 2.x — TLS termination, reverse proxy
                └─ Node/Express patient API — 127.0.0.1:3001
                     └─ PostgreSQL 16 — database caretask_demo
```

The same VM is also designated to host the jakemarc.com backend
(Jake's decision, 2026-10-28: one shared VM for the demo period;
split when real patient data or paying customers arrive).

## Auth model

1. **Sign-in** happens against Firebase. The dashboard is
   sign-in-only — there is no self-registration; an admin creates
   accounts in the Firebase console. (Nuance: a first-time Google
   sign-in still auto-creates a Firebase account; the API allowlist
   below is what actually gates data access. A full allowlist at the
   auth layer is the pre-pilot hardening step.)
2. **API access**: every API call carries the Firebase ID token.
   The API verifies it against the Firebase project
   (`FIREBASE_PROJECT_ID`, public-key verification — no service
   account key on the VM) AND checks the caller's email against
   `ALLOWED_EMAILS`. Either check failing → 401/403, and auth
   failures are written to `event_log`. The gate fails closed.
3. **Manager override**: sensitive writes (patient edit/delete/
   restore, all staff writes) additionally require a manager PIN in
   the `X-Manager-Pin` header. The PIN belongs to an active
   manager/admin row in `users`, is stored only as a scrypt hash,
   and each use is attributed to that manager in an `admin_action`
   audit event. If the API is unreachable, the dashboard cannot
   verify a PIN, so the actions stay locked. See API.md.

## Audit design

Two append-only trails, both enforced at the database layer
(triggers reject UPDATE/DELETE):

- `audit_log` — one row per patient change (create / update /
  soft_delete / restore) with full before/after JSON snapshots,
  written in the same transaction as the change.
- `event_log` — security/activity events (sign_in, sign_out,
  patient_view, report_export, auth_failure, admin_action,
  api_request) with actor, patient (nullable, no FK by design),
  details, and IP.

Both tables carry a SHA-256 **hash chain** (`prev_hash` /
`row_hash`, canonical form: length-prefixed fields joined with
`|`, NULL as empty, `created_at` excluded), so any tampering with
history breaks verification. `GET /events/verify` recomputes the
chain; the dashboard's Audit Log view shows the validity badge.

⚠️ Technical fact, recorded 2026-10-29: audit snapshots store full
patient rows, including `ss` and `drivers_license`. Field-level
redaction of snapshots is required before any real patient data is
stored. (The dashboard UI does not display or accept those two
fields at all — deliberate minimization.)

## Data-handling boundaries

- The dashboard talks to Google People API **read-only**
  (`contacts.readonly`) to import contacts INTO CareTask. Nothing
  is written back to Google Contacts, no token is persisted, and
  patient records are never exported to Google (Contacts/People API
  is not a BAA-covered Google service — see
  `../people-api-research.md`).
- Address autocomplete sends only the partial address text being
  typed to the lookup provider (Google Places, or Nominatim as
  fallback) — never a patient name.
- Reports PDF export is generated entirely on-device (jsPDF).

## Hosting & accounts map

| Thing | Where |
|---|---|
| Domain registrar | Squarespace (marcinnotech.net, expires 2027-08-06, auto-renew OFF — manual renewal required) |
| DNS + Pages + Email Routing | Cloudflare (account jakemarc@gmail.com) |
| Dashboard hosting | Cloudflare Pages project `marcinnotech-app` |
| Teaser hosting | Cloudflare Pages project `marcinnotech` |
| Auth + GCP project (dashboard integrations) | Firebase/GCP project `marcinnotech` (jakemarc2@gmail.com) |
| API VM | GCP project `jakemarc-com`, VM `marcinnotech-api`, static IP 34.57.183.32 |
| Email routing | info@marcinnotech.net → jakemarc@gmail.com; jake@marcinnotech.net → jakemarc2@gmail.com |
