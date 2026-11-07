-- ============================================================
-- CareTask — deploy-41 expense itemization (Concur-style
-- upgrade, step 1 of 5): expense lines become top-level.
--
-- - expenses.report_id drops NOT NULL: new non-mileage lines
--   are created unlinked (report_id NULL) and are linked into
--   a chain-model report envelope at report-create time
--   (schema-expense-approvals.sql). Legacy lines keep their
--   link (history).
-- - expenses.category CHECK widens additively to also allow
--   'supplies'. All 12 legacy values stay valid.
--
-- Apply as the database OWNER, AFTER schema-mileage-chains.sql
-- and BEFORE schema-expense-receipts.sql (deploy-41 order:
-- itemization, receipts, rates, policy, approvals):
--   sudo -u postgres psql -d caretask_demo -f schema-expense-itemization.sql
-- Idempotent (guarded constraint swap).
-- ============================================================

BEGIN;

ALTER TABLE expenses ALTER COLUMN report_id DROP NOT NULL;

DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'expenses'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%category%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE expenses DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE expenses ADD CONSTRAINT expenses_category_check
  CHECK (category IN ('mileage', 'parking', 'tolls',
                      'medical_supplies', 'office_supplies',
                      'meals', 'travel', 'lodging',
                      'phone_internet', 'training',
                      'licenses', 'other', 'supplies'));

GRANT SELECT, INSERT, UPDATE ON expenses TO patient_api;
GRANT USAGE, SELECT ON SEQUENCE expenses_id_seq TO patient_api;

COMMIT;
