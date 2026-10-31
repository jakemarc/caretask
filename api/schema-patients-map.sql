-- CareTask patients map coordinates — latitude / longitude for the
-- Patients Map and day-schedule map views.
--
-- Apply AFTER schema-patients-v2.sql, AS THE TABLE OWNER (e.g.
-- postgres) — the runtime API user cannot ALTER columns it does not
-- own. Table-level grants already cover the new columns, so no
-- per-column grants are needed; the GRANT below is repeated anyway
-- so a fresh database ends in the same state:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON patients TO patient_api;
--
-- Idempotency: ADD COLUMN uses IF NOT EXISTS and the range CHECKs
-- are guarded by DO blocks (Postgres has no ADD CONSTRAINT IF NOT
-- EXISTS). Safe to re-run; nothing is truncated or dropped.
--
-- Coordinates are captured when a clinician picks an address
-- autocomplete suggestion in the dashboard (both engines return a
-- location with the address). Patients whose address was typed by
-- hand keep NULL coordinates — the dashboard geocodes them on map
-- load instead. Coordinates are part of the patient row exactly
-- like the street address already is, so they appear in audit
-- snapshots the same way the address does (see the redaction
-- warning in schema-patients-v2.sql).

ALTER TABLE patients ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'patients_latitude_range'
  ) THEN
    ALTER TABLE patients ADD CONSTRAINT patients_latitude_range
      CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'patients_longitude_range'
  ) THEN
    ALTER TABLE patients ADD CONSTRAINT patients_longitude_range
      CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180));
  END IF;
END;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON patients TO patient_api;
