# CareTask

Monorepo for the Marc Innotech CareTask platform (demo build — all patient and staff data is fictional).

- **dashboard/** — Vite + React + TypeScript dashboard, deployed to Cloudflare Pages (https://marcinnotech-app.pages.dev)
- **api/** — Node + PostgreSQL API behind https://api.marcinnotech.net (Firebase ID-token auth, manager-PIN gates, append-only audit log with a SHA-256 hash chain)
- **docs/** — developer documentation; start with [docs/README.md](docs/README.md). Every build or deploy updates the affected doc and the CHANGELOG in the same round.

Configuration lives in environment variables only — copy `.env.example` to `.env` in `dashboard/` and `api/` and fill in your own values. Never commit a real `.env`.

Note: `dashboard/public/mit-monogram.webp` (the MIT monogram logo, a binary asset) is not in this repo — the push tool only carries text files. It lives in the working dashboard source; drop it into `dashboard/public/` after cloning.
