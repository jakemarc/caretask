-- CareTask demo patient database — patients table + audit log.
--
-- DEMO DATA ONLY. Every row this schema holds is meant to be fictional
-- (see seed.js). No real patient data goes in this table until TLS, a
-- signed BAA, and the company entity are all in place. Audit history
-- and soft delete — two of those gates — are implemented here now, on
-- fictional data, so they are proven before any real data arrives.
-- The deleted_at column is the soft-delete marker: DELETE on the API
-- sets it instead of removing the row, so a deleted patient is
-- recoverable. Rows with deleted_at set are hidden from every read.
--
-- Run on the VM, connected to the caretask_demo database:
--   psql -h localhost -U caretask_app -d caretask_demo -f schema.sql
-- (Use whichever role created the database if caretask_app lacks CREATE.)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS patients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  date_of_birth DATE,
  phone         TEXT,
  email         TEXT,
  address       TEXT,
  -- Traffic-light zone: Green / Yellow / Red. Classifies attention only;
  -- the clinician always decides.
  zone          TEXT NOT NULL DEFAULT 'green'
                CHECK (zone IN ('green', 'yellow', 'red')),
  -- Free-text flag labels attached to the patient (e.g. 'missed check-in').
  -- The dashboard's clinician-reviewed flags are a separate in-browser
  -- demo feature and are not stored here yet.
  flags         TEXT[] NOT NULL DEFAULT '{}',
  notes         TEXT,
  clinician     TEXT,
  -- Display age band (e.g. '70s'). Stored so the dashboard can show it
  -- without deriving it; date_of_birth is the source of truth when set.
  age_band      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Soft delete: set by the API's DELETE. NULL means active.
  deleted_at    TIMESTAMPTZ
);

-- Active patients, newest first, is the common read path.
CREATE INDEX IF NOT EXISTS patients_active_idx
  ON patients (created_at DESC) WHERE deleted_at IS NULL;

-- Keep updated_at honest on every UPDATE.
CREATE OR REPLACE FUNCTION patients_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS patients_updated_at ON patients;
CREATE TRIGGER patients_updated_at
  BEFORE UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION patients_set_updated_at();

-- Append-only audit log. One row per mutation, written by the API in
-- the same transaction as the change itself, so an audit entry can
-- never exist without its change and vice versa.
--
--   patient_id  the patient the change touched (never hard-deleted, so
--               the reference always resolves)
--   actor_uid   Firebase UID from the verified ID token
--   actor_email email from the verified ID token (allowlist-checked)
--   action      create | update | soft_delete | restore
--   changed     JSON: { before: <row or null>, after: <row or null> }
--               Snapshots, not just diffs, so the trail answers "what
--               did this patient look like then?" without replaying.
--   created_at  when the change landed (server clock)
--
-- Append-only is enforced in the database, not just by convention:
-- any UPDATE or DELETE on this table raises an exception. The API
-- exposes no endpoint that writes to it except the audit insert.
CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id  UUID NOT NULL REFERENCES patients (id),
  actor_uid   TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  action      TEXT NOT NULL
              CHECK (action IN ('create', 'update', 'soft_delete', 'restore')),
  changed     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The trail for one patient, newest first, is the read path.
CREATE INDEX IF NOT EXISTS audit_log_patient_idx
  ON audit_log (patient_id, created_at DESC);

CREATE OR REPLACE FUNCTION audit_log_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
