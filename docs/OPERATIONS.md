# Operations

Last updated: 2026-10-30

## Production inventory

| Piece | Detail |
|---|---|
| API VM | GCP project `jakemarc-com`, VM `marcinnotech-api`, us-central1-a, e2-micro, Ubuntu 24.04, 30 GB standard disk |
| Static IP | 34.57.183.32 → Cloudflare DNS A record `api` (DNS-only, proxy OFF) |
| TLS | Caddy 2.11.7 on the VM (`api.marcinnotech.net { reverse_proxy localhost:3001 }`); http→https redirect on |
| API service | systemd unit `patient-api` (User jakemarc2, Restart=always), files in `/home/jakemarc2/patient-api/`, bound 127.0.0.1:3001 |
| Database | PostgreSQL 16.15 on the VM, db `caretask_demo`, runtime user `patient_api`; password only in the VM's `~/patient-api/.env` (mode 600) |
| Dashboard | Cloudflare Pages project `marcinnotech-app` → https://marcinnotech-app.pages.dev |
| Teaser | Cloudflare Pages project `marcinnotech` → marcinnotech.net + www |
| Cost | e2-micro + disk inside GCP always-free tier; public IPv4 ≈ $3.65/mo is the only expected charge — under the $50/mo Phase 0–1 cap |

## Access paths

- **VM shell**: GCP Console browser SSH (sign in as
  jakemarc2@gmail.com). Direct SSH from outside is blocked by the
  sandbox egress proxy; Jake added Milo's public key to the VM, but
  the console browser SSH is the working path.
- **Cloudflare**: dashboard sign-in is email/password for
  jakemarc@gmail.com + emailed 7-digit 2FA code (Jake relays the
  code; that Gmail is NOT a connected mailbox). Google SSO for that
  account is passkey-gated — Jake-only, in person.
- **Firebase/GCP console** (project marcinnotech): sign in as
  jakemarc2@gmail.com (works in the browser; passkey prompts are
  Jake's to approve on his phone).

⚠️ `/home/jakemarc2` is mode 750. Anything that must run as the
`postgres` OS user against files in that home (migrations, seeds)
needs a temporary `chmod o+x /home/jakemarc2` (751) — and it MUST
be restored to 750 immediately after, and the restore verified.

## Deploy runbooks

### Dashboard (Cloudflare Pages)

1. Fresh Cloudflare API token (My Profile → API Tokens → custom;
   Account → Cloudflare Pages → Edit; whole account; no expiry).
   The token value is shown once, reported by the browser task, and
   used transiently in the terminal env — never stored anywhere.
2. From `~/workspace/marc-innotech-secure`:
   `VITE_API_URL=https://api.marcinnotech.net npm run build`
   then `CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=ee910d831ca56296975fc2cf77d74c25 npx --yes wrangler pages deploy dist --project-name marcinnotech-app --commit-dirty=true`
3. Verify: the main URL serves the new bundle filename; the asset
   returns 200; the login page renders. (Signed-in checks are
   Jake's — Milo does not sign in as him.)
4. Known wrinkle: Cloudflare's login page intermittently shows an
   invisible-Turnstile error for automated browsers; a fresh
   browser task usually clears it. Wrangler OAuth login does NOT
   work from the sandbox (times out) — the token route is the
   method.

### API (VM)

1. Back up what you replace on the VM first
   (`server.js.bak-<date>`, `routes/*.bak-<date>` pattern is in use).
2. Write the new files into `/home/jakemarc2/patient-api/`.
3. Migrations: `sudo -u postgres psql -d caretask_demo -f <file>`
   (as the OWNER — see DEVELOPMENT.md), then explicit GRANTs to
   `patient_api`. Seeds run as the postgres OS user over the local
   socket (peer auth).
4. `sudo systemctl restart patient-api`; confirm `active`, then
   verify `/health` locally and publicly, plus the auth behavior
   (401 with no token on protected routes).

### Agency directory auto-sync (timer) — INSTALLED 2026-10-30

The IDPH agency directory refreshes itself weekly via a systemd
timer. The units are build artifacts in the repo
(`patient-api/deploy/caretask-agency-sync.service` +
`.timer`) — **installed and enabled on the VM 2026-10-30** as
part of the agencies deploy round (first live sync the same
day: 595 inserted). To reinstall or repair:

1. `sudo cp deploy/caretask-agency-sync.service deploy/caretask-agency-sync.timer /etc/systemd/system/`
   (from `/home/jakemarc2/patient-api/`).
2. `sudo systemctl daemon-reload && sudo systemctl enable --now caretask-agency-sync.timer`
3. Verify: `systemctl list-timers caretask-agency-sync.timer`
   shows a NEXT run (weekly, Mondays 03:00 — **the VM clock is
   UTC**, verified 2026-10-30: next run Mon 2026-11-02 03:00
   UTC = Sun 21:00 CT; Persistent=true catches up after downtime). The service is
   `Type=oneshot` running `node sync-agencies.js --live` as
   `jakemarc2` with the API's `.env`.
4. Manual run / check any time:
   `sudo systemctl start caretask-agency-sync.service`, then
   `journalctl -u caretask-agency-sync.service` — the run prints
   its summary JSON; a `skipped_no_change: 1` summary is the
   healthy common case (the IDPH dataset updates irregularly —
   rowsUpdatedAt was 2026-04-28 at build time — so weekly is
   plenty). Every run, manual or timed, lands as one
   `agency_sync` row in the Audit Log / Settings → Agency
   directory "last synced" line.
5. Rollback: `sudo systemctl disable --now caretask-agency-sync.timer`
   (the manual "Sync now" / "Update agencies" buttons keep
   working — they call the same code path through the API).

## Domain & email watch items

- marcinnotech.net expires **2027-08-06** at Squarespace with
  auto-renew OFF — manual renewal required or the domain, DNS, and
  email forwarding all stop. (A reminder is scheduled for
  ~2027-07-01.)
- Cloudflare Email Routing: info@ → jakemarc@gmail.com,
  jake@ → jakemarc2@gmail.com (both Active). Gmail "Send mail as"
  for those addresses is not set up yet (needs Jake's Gmail
  session).

## Backups — current state (honest)

- Source: dashboard + API source live in the workspace (no Git repo
  yet — open item; Jake creates repos).
- On-VM: per-deploy `.bak-<date>` copies of replaced files.
- Database: no automated backup is configured yet. Pre-pilot task:
  scheduled `pg_dump` of caretask_demo with rotation.
