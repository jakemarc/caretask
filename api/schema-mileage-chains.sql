-- ============================================================
-- CareTask — day-chain mileage (2026-11-02, Jake's expenses
-- simplification): mileage entries become top-level day-log
-- legs owned by a clinician and tagged with an agency, instead
-- of living only inside a monthly report envelope.
--
-- - user_id / agency_id: the leg's owner and agency, backfilled
--   from the envelope for existing rows. New legs are created
--   top-level (expense_report_id NULL).
-- - patient_id: the patient a leg ends at, when it was picked
--   from the patient list (the picker also fills end_label /
--   end_address / coords; the id makes the link durable).
-- - start_label / end_label: place names for the chain UI
--   ("Home", "Office", "Reyes, Rosa"); addresses stay in
--   start_address / end_address.
-- - expense_report_id drops NOT NULL: envelopes are legacy.
--   Existing rows keep their link (history); the approval
--   lifecycle columns on expense_reports are simply unused
--   from this round on — no data is deleted.
--
-- Day math under the chain model: a day's legs in seq order —
-- entry_kind 'commute' legs are the fixed home<->office
-- bookends (personal miles); 'business' legs are billable.
-- Billable miles = sum of business legs' business_miles;
-- personal miles = sum of commute legs' business_miles (the
-- column is the leg's FINAL miles for both kinds).
--
-- Apply as the database OWNER, AFTER schema-expenses.sql:
--   sudo -u postgres psql -d caretask_demo -f schema-mileage-chains.sql
-- Idempotent (IF NOT EXISTS / guarded backfill).
-- ============================================================

BEGIN;

ALTER TABLE mileage_entries
  ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id);
ALTER TABLE mileage_entries
  ADD COLUMN IF NOT EXISTS agency_id BIGINT REFERENCES agencies(id);
ALTER TABLE mileage_entries
  ADD COLUMN IF NOT EXISTS patient_id UUID REFERENCES patients(id);
ALTER TABLE mileage_entries
  ADD COLUMN IF NOT EXISTS start_label TEXT;
ALTER TABLE mileage_entries
  ADD COLUMN IF NOT EXISTS end_label TEXT;

ALTER TABLE mileage_entries
  ALTER COLUMN expense_report_id DROP NOT NULL;

UPDATE mileage_entries me
   SET user_id = r.user_id,
       agency_id = r.agency_id
  FROM expense_reports r
 WHERE me.expense_report_id = r.id
   AND me.user_id IS NULL;

CREATE INDEX IF NOT EXISTS mileage_entries_user_date_idx
  ON mileage_entries (user_id, entry_date, seq);

COMMIT;
