-- CareTask patients table v2 — split name/address/phone, demographics,
-- care/other, sensitive, billing, and pharmacy fields.
--
-- =====================================================================
-- ⚠️  DESTRUCTIVE MIGRATION — DEMO DATABASE ONLY. DO NOT RUN THIS ON
-- ANY DATABASE HOLDING REAL DATA.
-- =====================================================================
-- This migration TRUNCATES audit_log and patients, then DROPS the
-- name, address, phone, and age_band columns. The dropped values are
-- gone for good unless re-seeded, so this migration MUST be followed
-- by a re-seed (`npm run seed`), which repopulates the 8 fictional
-- demo patients with split names and addresses. event_log is
-- intentionally NOT truncated: its patient_id is informational (no
-- foreign key), so old event rows stay readable after the reset.
-- age_band is the only dropped value that is not re-seeded: it is
-- derived from date_of_birth now (the dashboard computes the decade
-- band from the birth date), so nothing of value is lost.
--
-- Apply AFTER schema.sql and schema-events.sql, AS THE TABLE OWNER
-- (e.g. postgres) — the runtime API user cannot ALTER or DROP
-- columns it does not own. This exact gap broke the Oct 29 live
-- deploy of schema-events.sql: the migration ran as the runtime
-- user and failed with "must be owner of table". After applying,
-- re-grant the runtime user its table access (table-level grants
-- cover the new columns, so no per-column grants are needed):
--   GRANT SELECT, INSERT, UPDATE, DELETE ON patients TO patient_api;
--   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO patient_api;
--
-- Idempotency: TRUNCATE is repeatable, ADD COLUMN uses IF NOT
-- EXISTS, the status CHECK is guarded by a DO block, and DROP
-- COLUMN uses IF EXISTS. Re-running wipes demo rows again — always
-- re-seed after. Nothing in this file touches audit_log or
-- event_log definitions, triggers, or hash chains.
--
-- Final v2 field list (see README.md for the documented list):
--   id, title, fname, mname, lname, suffix, date_of_birth, sex, race,
--   ethnicity, language, street, street_line_2, city, state,
--   postal_code, country_code, phone_home, phone_cell, email, zone,
--   flags, notes, clinician, occupation, preferred_name,
--   interpreter_needed, hipaa_allowsms, hipaa_allowemail, referrer,
--   status, emergency_contact_name, emergency_contact_relationship,
--   emergency_contact_phone, ss, drivers_license, billing_note,
--   pricelevel, financial, pharmacy_id, created_at, updated_at,
--   deleted_at.

-- Empty the tables first: fname/lname are NOT NULL, and adding a
-- NOT NULL column to a populated table fails. The demo rows come
-- back via `npm run seed` immediately after.
TRUNCATE audit_log, patients;

-- Name split (replaces `name`).
ALTER TABLE patients ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS fname TEXT NOT NULL;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS mname TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS lname TEXT NOT NULL;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS suffix TEXT;

-- Demographics.
ALTER TABLE patients ADD COLUMN IF NOT EXISTS sex TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS race TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS ethnicity TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS language TEXT;

-- Address split (replaces `address`).
ALTER TABLE patients ADD COLUMN IF NOT EXISTS street TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS street_line_2 TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS postal_code TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS country_code TEXT;

-- Phone split (replaces `phone`).
ALTER TABLE patients ADD COLUMN IF NOT EXISTS phone_home TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS phone_cell TEXT;

-- Care / other.
ALTER TABLE patients ADD COLUMN IF NOT EXISTS occupation TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS preferred_name TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS interpreter_needed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS hipaa_allowsms BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS hipaa_allowemail BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS referrer TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE patients ADD COLUMN IF NOT EXISTS emergency_contact_name TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS emergency_contact_relationship TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS emergency_contact_phone TEXT;

-- Sensitive identifiers. Fictional-only in the demo seed; see the
-- README warning — audit snapshots include these values, so
-- field-level redaction of audit snapshots MUST be addressed
-- before any real data is ever stored.
ALTER TABLE patients ADD COLUMN IF NOT EXISTS ss TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS drivers_license TEXT;

-- Billing.
ALTER TABLE patients ADD COLUMN IF NOT EXISTS billing_note TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS pricelevel TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE patients ADD COLUMN IF NOT EXISTS financial TEXT;

-- Pharmacy. OpenEMR-compatible integer, deliberately WITHOUT a
-- foreign key: there is no pharmacy table yet, so there is nothing
-- to reference. Add the FK when a pharmacy table exists.
ALTER TABLE patients ADD COLUMN IF NOT EXISTS pharmacy_id INTEGER;

-- status CHECK (guarded: Postgres has no ADD CONSTRAINT IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'patients_status_check'
  ) THEN
    ALTER TABLE patients ADD CONSTRAINT patients_status_check
      CHECK (status IN ('active', 'hold', 'discharged'));
  END IF;
END;
$$;

-- Drops. These four columns are gone after this runs — demo only.
ALTER TABLE patients DROP COLUMN IF EXISTS name;
ALTER TABLE patients DROP COLUMN IF EXISTS address;
ALTER TABLE patients DROP COLUMN IF EXISTS phone;
ALTER TABLE patients DROP COLUMN IF EXISTS age_band;
