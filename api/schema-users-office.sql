-- CareTask staff office address — office_* columns on users: the
-- office half of the clinician's own address pair (the home half
-- rides the existing street/city/state/zip contact columns).
-- Settings -> Home & Office writes both halves through
-- PUT /users/me/addresses; the Mileage page uses the pair as the
-- day's bookends (home<->office legs are personal/commute miles).
--
-- Apply AFTER schema-users.sql, AS THE TABLE OWNER (e.g.
-- postgres) — the runtime API user cannot ALTER columns it does
-- not own. Table-level grants already cover the new columns, so
-- no per-column grants are needed.
--
-- Idempotency: ADD COLUMN uses IF NOT EXISTS. Safe to re-run;
-- nothing is truncated or dropped.

ALTER TABLE users ADD COLUMN IF NOT EXISTS office_street TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS office_city TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS office_state TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS office_zip TEXT;
