# Marc Innotech — Secure Clinician Dashboard

The secure side of marcinnotech.net: a clinician-facing dashboard behind
sign-in. Working name for the dashboard: **CareTask** (the platform naming
decision — Valen / Heron — is still pending, so nothing in this app treats a
platform name as final).

Tagline shown in the header: "Empowering clinicians to provide modern
medical care".

## What it is

- `/login` — sign in or create an account with email/password or Google
  (Firebase Auth).
- `/app` — guarded dashboard. Signed-out visitors are redirected to
  `/login`. There is no demo bypass: the dashboard is only reachable after
  signing in.
- Dashboard sections (tabs inside `/app`):
  - **People under care** — registry with traffic-light status (green =
    on track, amber = watch, red = needs clinician review), filterable.
  - **Urgent triage** — tickets prioritized P1 first.
  - **Preventive calendar** — visits, screenings, labs, vaccines, and
    check-ins coming due.
  - **Clinician-reviewed flags** — each flag shows a signal and a draft
    suggestion, plus clinician-review actions (Acknowledge, Schedule
    follow-up, Dismiss). Flags are assistive, never automatic: the system
    never sends a message, books an appointment, or places an order on its
    own, and in this demo a decision is recorded on screen only.
  - **Clinic analytics** — illustrative demo numbers and a weekly
    flags-reviewed chart.

Dark theme echoing the teaser site (near-black, deep teal accent, orange
used sparingly). The monogram in the header is an inline SVG (text only) —
no image files, so the source stays syncable as UTF-8 text.

## Demo data notice

**All dashboard content is synthetic demo data.** Every person, reading,
ticket, reminder, flag, and number is invented for demonstration. No real
patient data is shown, stored, or sent anywhere by this app, and there is
no backend or API yet. Do not enter real patient information into this
build.

## Run locally

```bash
npm install
npm run dev
```

Then open the local URL Vite prints (usually http://localhost:5173).
`/` redirects to `/app`, which redirects to `/login` while signed out.

## Build

```bash
npm run build
```

This runs `tsc -b` and then `vite build`. Output goes to `dist/`.

## Firebase config (required for sign-in)

Sign-in needs the **company's own Firebase project** — not any personal
project. Until the config below is supplied, the login page shows a setup
notice and sign-in stays disabled.

1. Create a Firebase project for Marc Innotech (or use the company project
   once it exists).
2. In the Firebase console, add a **Web app** and copy its config.
3. In Authentication → Sign-in method, enable **Email/Password** and
   **Google**.
4. Copy `.env.example` to `.env` and fill in the values:

```bash
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
```

5. Rebuild. `.env` is git-ignored — never commit it.
6. After deploying, add the deployed domain under Authentication →
   Settings → Authorized domains.

Firebase web config values are public client identifiers, not secrets, but
they still belong in `.env`, not in committed code.

## Deploy options

The build output is a static site (`dist/`), so any static host works:

- **Firebase Hosting** (matches the Auth setup): `firebase.json` is
  included with an SPA rewrite to `/index.html`. Run `firebase deploy`
  from this folder after `firebase login` and `firebase use <project>`.
- **Cloudflare Pages**: connect the repo, build command `npm run build`,
  output directory `dist`, and set the `VITE_FIREBASE_*` variables in the
  Pages project settings.
- **Any static host**: serve `dist/` with a fallback that rewrites unknown
  paths to `/index.html` (required for `/login` and `/app` deep links).

Suggested live shape, mirroring the public site: the teaser stays on
`marcinnotech.net`, and this app lives at `app.marcinnotech.net`
(or a `/login` + `/app` section of a future rebuilt site).

## What is NOT done

- **No real patient data.** Nothing here is cleared for real data.
- **No backend or API.** Flag decisions and dashboard content are local
  demo state only; nothing persists.
- **No user allowlist.** Self-registration was removed from the login page
  (2026-10-27), but a first-time Google sign-in still creates an account
  automatically. Before any pilot, add an allowlist (as on the existing
  clients admin page) to close that path too.
- **No BAA, no TLS review, no audit history, no soft-delete.** Those gates
  are still pending and must pass before any real patient data is used.
- **Not deployed.** This folder is source only until someone creates the
  repo, connects the company Firebase project, and deploys it (see "To put
  this live" below).

## To put this live (checklist)

1. Jake creates a private GitHub repo for this app (the GitHub App cannot
   create repos) and selects it in the GitHub App installation.
2. Push this folder's contents to the repo's `main` branch.
3. Create the company Firebase project + web app; enable Email/Password
   and Google sign-in.
4. Set the `VITE_FIREBASE_*` variables in the hosting provider (or `.env`
   for a manual Firebase Hosting deploy).
5. Deploy `dist/` (Firebase Hosting or Cloudflare Pages) and add the live
   domain to Firebase Authorized domains.
6. Verify: open the live URL, confirm `/` → `/login` while signed out,
   sign in, confirm the dashboard loads with the DEMO DATA banner, and
   confirm sign-out returns to `/login`.

## Stack

Vite + React + TypeScript + react-router-dom + Firebase Auth. No UI
framework, no binary assets — HTML, CSS, TypeScript, and inline SVG only.

## Patient API (demo, optional)

The dashboard can load its patient list from the Marc Innotech demo
patient API instead of the in-browser demo data, and save new patients
to it. Wiring lives in `src/lib/patientApi.ts`; the API itself is at
`workspace/marc-innotech/patient-api/` (Express + Postgres, Firebase
ID-token auth + allowlist, fails closed).

- Set `VITE_API_URL` (see `.env.example`) to the API base URL, then
  rebuild. The API's `DASHBOARD_ORIGIN` must include the dashboard's
  origin or browser calls are blocked by CORS.
- Fallback is deliberate: if `VITE_API_URL` is unset, or the API is
  unreachable, or the token is rejected, the dashboard keeps showing
  its in-browser demo data, and Add Patient saves for the session only.
  The Add Patient view states which source is in use.
- Demo data only. The API serves fictional patients until the TLS +
  BAA + audit gates pass; nothing real goes through it.
