-- CareTask staff position — a real `position` column on users
-- (e.g. "Physical Therapist", "Clinical Manager"), distinct from
-- the free-text `title` (e.g. "PT, DPT") and the system `role`.
--
-- Apply AFTER schema-users.sql, AS THE TABLE OWNER (e.g.
-- postgres) — the runtime API user cannot ALTER columns it does
-- not own. Table-level grants already cover the new column, so
-- no per-column grants are needed.
--
-- Idempotency: ADD COLUMN uses IF NOT EXISTS. Safe to re-run;
-- nothing is truncated or dropped.
--
-- The dashboard staff form offers a dropdown of common
-- home-health positions (STAFF_POSITIONS in the dashboard's
-- patientApi.ts); the column itself is plain TEXT so an
-- out-of-list position entered elsewhere is stored as-is.

ALTER TABLE users ADD COLUMN IF NOT EXISTS position TEXT;
