-- ============================================================
-- CareTask demo API — patient agency tag (2026-10-30).
-- ADDITIVE migration. A patient may be tagged with the home
-- health agency they're under — two ways, never both at once:
--   agency_id        BIGINT FK → agencies(id): the agency is
--     in the IDPH directory. Validated by routes/patients.js
--     (400 AGENCY_NOT_FOUND for a bogus id).
--   agency_name_text TEXT: free-text fallback for an agency
--     that is NOT in the directory (Jake, 2026-10-30 — patients
--     periodically change agencies, and the new one may not
--     be listed). When agency_id is set, this is stored NULL
--     (the API enforces it: agency_id wins).
-- The API's read field agency_name resolves to the linked
-- agency's display_name, else agency_name_text.
--
-- Agencies are never hard-deleted (the sync marks them
-- inactive), so a plain FK with no cascade is safe. Changing
-- a patient's agency goes through the normal PIN-gated edit;
-- audit_log before/after snapshots carry both columns, so
-- agency history is preserved in the audit trail.
--
-- Apply AFTER schema-agencies.sql + schema-agencies-cms.sql
-- (it FKs the agencies table):
--   psql -d caretask_demo -f schema-patients-agency.sql
-- as the database OWNER. Idempotent: ADD COLUMN IF NOT EXISTS
-- + the FK added via a DO block guarded on pg_constraint.
-- Grants restated so the file is self-contained.
-- ============================================================

BEGIN;

ALTER TABLE patients ADD COLUMN IF NOT EXISTS agency_id        BIGINT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS agency_name_text TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'patients_agency_id_fk'
  ) THEN
    ALTER TABLE patients
      ADD CONSTRAINT patients_agency_id_fk
      FOREIGN KEY (agency_id) REFERENCES agencies(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS patients_agency_id_idx ON patients (agency_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON patients TO patient_api;

COMMIT;
