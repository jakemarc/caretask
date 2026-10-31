-- ============================================================
-- CareTask demo API — agencies CMS enrichment columns
-- (2026-10-30). ADDITIVE migration: layer CMS Provider Data
-- ("Home Health Care Agencies", data.cms.gov dataset
-- 6jpm-sxkc) onto the IDPH-imported agencies rows — service
-- lines, the CMS quality star rating, CCN, ownership and
-- certification date. See ../agency-directory-research.md
-- (CMS addendum) for the verified endpoint + field names.
--
-- The enrichment pass lives in lib/agencySync.js (same sync,
-- second pass): CMS rows are matched to IDPH agencies by
-- phone+ZIP, then normalized name+ZIP, unambiguous matches
-- only. These are CMS-owned SOURCE columns — a later sync may
-- overwrite them; the local fields (is_primary, notes,
-- short_name) are never touched by either pass.
--
-- All columns nullable: an agency with no CMS match (or a CMS
-- row with no rating) simply carries NULLs, and the dashboard
-- renders "—" / "Not rated by CMS".
--
-- Apply AFTER schema-agencies.sql:
--   psql -d caretask_demo -f schema-agencies-cms.sql
-- as the database OWNER (live tables are owned by postgres;
-- the runtime user patient_api gets grants only). The grants
-- are restated here so this file is self-contained if
-- schema-agencies.sql's grants were ever trimmed.
--
-- Idempotency: ADD COLUMN uses IF NOT EXISTS. Safe to re-run;
-- nothing is truncated or dropped.
-- ============================================================

BEGIN;

ALTER TABLE agencies ADD COLUMN IF NOT EXISTS ccn            TEXT;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS offers_nursing BOOLEAN;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS offers_pt      BOOLEAN;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS offers_ot      BOOLEAN;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS offers_speech  BOOLEAN;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS offers_msw     BOOLEAN;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS offers_hha     BOOLEAN;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS star_rating    NUMERIC(2,1);
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS cms_ownership  TEXT;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS cms_cert_date  DATE;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS cms_matched_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS agencies_star_rating_idx ON agencies (star_rating);
CREATE INDEX IF NOT EXISTS agencies_ccn_idx ON agencies (ccn);

GRANT SELECT, INSERT, UPDATE ON agencies TO patient_api;
GRANT USAGE, SELECT ON SEQUENCE agencies_id_seq TO patient_api;

COMMIT;
