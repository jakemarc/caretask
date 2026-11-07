-- ============================================================
-- CareTask — deploy-41 expense policy (Concur-style upgrade,
-- step 4 of 5): singleton settings row (id = 1) controlling
-- the receipt requirement. When require_receipts is on, a
-- line at or above receipt_threshold_cents (NULL threshold =
-- all lines) must carry a receipt before its report can be
-- submitted. Commute legs never require receipts.
--
-- Apply as the database OWNER, AFTER schema-mileage-rates.sql
-- and BEFORE schema-expense-approvals.sql (deploy-41 order:
-- itemization, receipts, rates, policy, approvals):
--   sudo -u postgres psql -d caretask_demo -f schema-expense-policy.sql
-- Idempotent (IF NOT EXISTS + ON CONFLICT DO NOTHING seed).
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS expense_settings (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  require_receipts        BOOLEAN NOT NULL DEFAULT false,
  receipt_threshold_cents INTEGER CHECK (receipt_threshold_cents IS NULL OR receipt_threshold_cents >= 0),
  updated_by              BIGINT REFERENCES users(id),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO expense_settings (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;

GRANT SELECT, INSERT, UPDATE ON expense_settings TO patient_api;

COMMIT;
