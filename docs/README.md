# CareTask Developer Documentation

The developer docs for the CareTask platform (Marc Innovative
Technologies). Maintained alongside the code: every build or deploy
updates the affected doc and adds a CHANGELOG entry in the same
round. If a doc and the code disagree, the code wins — fix the doc.

## Start here

| Doc | What it covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System shape: components, how they talk, auth model, trust boundaries |
| [DASHBOARD.md](DASHBOARD.md) | The clinician dashboard: stack, layout, env config, features, build & deploy |
| [API.md](API.md) | The patient API: overview, endpoint map, auth + manager-PIN gate (full reference lives in the API repo's README) |
| [DATA-MODEL.md](DATA-MODEL.md) | Database tables, columns, and invariants (patients, users, audit_log, event_log) |
| [OPERATIONS.md](OPERATIONS.md) | Production: the GCP VM, services, DNS, deploys, backups, recovery |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Local development: setup, the local test database, the e2e suites, house rules learned the hard way |
| [CHANGELOG.md](CHANGELOG.md) | What shipped, when, and where it runs |

## Related documents (outside this folder)

- `../DECISIONS.md` — the company decision log (dated, with the
  reasoning and who decided)
- `../business-plan-medical-marcelino-model.md` — Ava's business
  plan (proposal; platform working name CareTask)
- `../people-api-research.md` — Google People API research memo
  (field mapping, BAA finding, quota notes)
- `../patient-api/README.md` — the API's own full reference
  (prerequisites, migrations, endpoint details); API.md here is the
  map, that README is the territory
- `../../marc-innotech-secure/CORNELL-ZONES-NOTES.md` — Cornell
  Traffic Light zone model research behind the patient zones

## The system in one paragraph

CareTask is a clinician dashboard (React SPA on Cloudflare Pages)
backed by a small Express + PostgreSQL API on a Google Cloud VM
behind Caddy TLS. Firebase Authentication signs clinicians in; the
API verifies Firebase ID tokens and an email allowlist. Everything
patient-shaped is written through the API, which keeps two
append-only, hash-chained audit trails. The system currently holds
fictional demo data only.

## Source locations

| Component | Path |
|---|---|
| Dashboard | `~/workspace/marc-innotech-secure/` |
| Patient API | `~/workspace/marc-innotech/patient-api/` |
| Docs (this set) | `~/workspace/marc-innotech/docs/` |
| Teaser site | `~/workspace/marc-innotech-site/` (repo: github.com/jakemarc/marcinnotech) |

Note: the dashboard and API have no Git repository yet (open item —
Jake creates repos; when one exists, this docs set should move into
it).
