# Development

Last updated: 2026-10-30

## Local setup

```bash
# Dashboard
cd ~/workspace/marc-innotech-secure
npm install        # once
cp .env.example .env   # if present; values are public identifiers
npm run dev        # Vite on http://localhost:5173

# API
cd ~/workspace/marc-innotech/patient-api
npm install
node server.js     # needs DATABASE_URL etc. — see .env.example
```

Type-check + production build (the pre-deploy gate):

```bash
cd ~/workspace/marc-innotech-secure
VITE_API_URL=https://api.marcinnotech.net npm run build
```

A build is not "done" until the bundle is grepped for the strings
that prove the new feature is in it (endpoint URLs, marker text,
config values) — that check caught nothing yet, and it stays in
the routine because it costs a minute.

## API test suites

Eight end-to-end suites in `patient-api/` (each boots the real
server on its own port against a real Postgres, with stubbed auth):

| Suite | Port | Covers |
|---|---|---|
| `e2e-test.js` | — | patients CRUD, soft delete/restore, audit rows, latitude/longitude round-trip + validation (52 checks) |
| `e2e-events-test.js` | — | event intake/query, hash chain, request logging (45 checks) |
| `e2e-users-test.js` | — | users reads, PIN verification (25 checks) |
| `e2e-users-mgmt-test.js` | 3104 | PIN gate matrix, staff CRUD, duplicate 409s, self-deactivate block, admin_action attribution |
| `e2e-appointments-test.js` | 3105 | categories/statuses lists, OpenEMR category→patient rules, window/filter queries, ungated status flow, PIN gate on edit/delete, appointment_change attribution, PIN-gated category management (45 checks) |
| `e2e-messages-test.js` | 3106 | staff resolution (NO_STAFF_RECORD), DM + chart messages, thread access rules, read receipts (idempotent), sender-only delete, message events carry no body (32 checks) |
| `e2e-documents-test.js` | 3107 | staff resolution (NO_STAFF_RECORD), document create/list/get, template section validation, appointment-belongs-to-patient rule, draft edit, finalize locks editing (409 DOCUMENT_FINALIZED), PIN-gated delete + restore, document events carry no section content (38 checks) |
| `e2e-agencies-test.js` | 3108 | migration idempotency, fixture sync counts/upserts/deactivation, same-stamp skip, display_name precedence (short_name → DBA → two words), list/search/primary, PIN gate matrix, is_primary exclusivity, local fields survive re-sync, fake-fetch live path, agency_sync events carry counts only, CMS enrichment (phone+zip / DBA name+zip match, ambiguous skipped, unmatched counted, `?service=` / `?min_rating=` filters, idempotent re-run) (55 checks) — run LAST: it TRUNCATEs event_log for a deterministic skip state |
| `e2e-expenses-test.js` | 3111 | mileage day chains, bookends/commute split, generated report math, legacy envelope reads (43 checks; deploy-41 flipped its retired-write 404 checks — envelope create now answers 400 `REPORT_EMPTY` on an empty range) |
| `e2e-expense-upgrade-test.js` | 3112 | deploy-41: receipts (magic bytes, size cap, round-trip), rate table + resolve, expense lines, receipt policy gate (422 `RECEIPTS_REQUIRED`), saved-report lifecycle + timeline, `SELF_APPROVAL`, `REPORT_LOCKED` (104 checks) |

Schema apply order for a fresh test DB: schema.sql,
schema-events.sql, schema-patients-v2.sql, schema-patients-map.sql,
schema-users.sql, schema-appointments.sql, schema-messages.sql,
schema-documents.sql, schema-agencies.sql,
schema-agencies-cms.sql (CMS enrichment columns; additive,
applies twice cleanly), schema-patients-agency.sql (patient
agency tag; FKs agencies, so it comes after them). The
deploy-41 expense files apply after schema-mileage-chains.sql
in this order: schema-expense-itemization.sql,
schema-expense-receipts.sql, schema-mileage-rates.sql,
schema-expense-policy.sql, schema-expense-approvals.sql. Run each suite ONCE per fresh DB, and run
`e2e-appointments-test.js` BEFORE `e2e-users-test.js`: the users
suite leaves an active manager row holding demo PIN 1234, and
PIN attribution takes the first matching manager — appointments'
manager-attribution checks fail on the leftover (pre-existing
cross-suite contamination, reproduced 2026-10-30).

**Every suite must pass twice: once as a superuser and once as a
limited user with production-like grants.** The limited-user pass
is the one that resembles production — it caught the two worst
bugs so far (see house rules).

The suites clean up their own rows (fixed `@example.com` test
emails) at start AND in a `finally` block. Cross-suite
contamination (a leftover row failing another suite's "no row"
check) already happened once; keep the cleanup discipline.

### Local Postgres (sandbox recipe)

The sandbox's packaged Postgres is unreliable; the working setup
is zonky embedded Postgres 16.4 binaries: extract the Maven jar's
`postgres-linux-x86_64.txz` to `/tmp/pgbin`, run as an unprivileged
user, data dir `/tmp/pgdata`, port 5433, socket `/tmp`, trust auth.
There is no psql in the bundle (server binaries only) — do DB setup
through a Node script using the API's own `pg` dependency. `/tmp`
is ephemeral: rebuild this each test session.

## House rules (learned the hard way)

1. **Migrations run as the table owner.** Live tables are owned by
   `postgres`; the runtime user cannot ALTER/CREATE on them. Run
   migrations with `sudo -u postgres psql`, then GRANT explicitly.
   The patients-v2 live deploy failed on exactly this before the
   rule existed.
2. **Test as the limited user, not just the superuser.** Grants
   gaps are invisible as superuser.
3. **Seeds run as the postgres OS user** over the local socket
   (peer auth), with the temporary home-directory permission
   change restored right after (see OPERATIONS.md).
4. **Fail closed.** Auth and PIN checks deny on any error,
   including "the API is unreachable" on the client side.
5. **Never log secrets.** Request logging records method/path/
   status only. `pin_hash` never appears in an API response. PINs
   are scrypt-hashed at rest; demo PINs live only in the seeds.
6. **Demo data is fictional, always.** 900-01-xxxx SSNs, EXAMPLE-
   DL licenses, 555 phone numbers, `.example` emails — in seeds,
   tests, and sample contacts alike.
7. **Audit display is frozen.** The Audit Log UI and the logging
   format stay exactly as built unless Jake directs a change
   (2026-10-29).
8. **Docs move with code.** Any build/deploy updates the affected
   doc here and adds a CHANGELOG entry in the same round.
