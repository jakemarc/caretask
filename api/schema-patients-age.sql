-- ============================================================
-- CareTask demo API — patients.age (2026-11-01, Jake's
-- direction): a stored age in years for patients whose date
-- of birth is unknown.
--
-- Why: Jake made date_of_birth OPTIONAL on patient create
-- (it was required 2026-10-30 → 2026-11-01) so records and
-- CSV imports are no longer blocked by a missing birthday.
-- This column is the fallback for those patients: staff can
-- record "74" even when nobody knows the birth date.
--
-- Rules:
-- - date_of_birth stays the source of truth WHEN SET — the
--   dashboard derives the exact age from it and only consults
--   this column when date_of_birth IS NULL.
-- - A stored age does not advance on its own (it is the age
--   as recorded); that staleness is accepted by design, the
--   same trade the old age_band made.
-- - NULL = no age known. Range-checked 0–130.
--
-- Apply AFTER schema-patients-v2.sql, AS THE TABLE OWNER
-- (live tables are owned by postgres; the runtime API user
-- cannot ALTER):
--   sudo -u postgres psql -d caretask_demo -f schema-patients-age.sql
-- No grants needed: patient_api already holds table-level
-- SELECT/INSERT/UPDATE on patients.
-- ============================================================

ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS age INTEGER
  CHECK (age IS NULL OR (age >= 0 AND age <= 130));
