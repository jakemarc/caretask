-- CareTask patient merge — mark-for-merge pairs, the merge record
-- (with the exact moved-row ids, so a merge is undoable), and the
-- 'patient_merge' event type. Designed in contacts-multiagency-
-- spec.md §1: pick the survivor, linked rows re-point, the loser is
-- soft-deleted, one patient_merge event ties both ids, nothing is
-- destroyed.
--
-- Marks are workflow state, not clinical data: they close via
-- deleted_at (house rule — the API role holds no DELETE grant).
--
-- Run AFTER schema-mileage-chains.sql (the merge re-points
-- mileage_entries.patient_id).

BEGIN;

-- One open mark per unordered pair: (patient_low, patient_high) is
-- the pair sorted by id, enforced by the CHECK.
CREATE TABLE IF NOT EXISTS patient_merge_marks (
  patient_low   UUID NOT NULL REFERENCES patients(id),
  patient_high  UUID NOT NULL REFERENCES patients(id),
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  PRIMARY KEY (patient_low, patient_high),
  CHECK (patient_low < patient_high)
);

-- The merge record. moved_ids holds the exact rows re-pointed per
-- table ({appointments:[], documents:[], messages:[],
-- mileage_entries:[]}) — undo re-points exactly those back.
CREATE TABLE IF NOT EXISTS patient_merges (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  survivor_id UUID NOT NULL REFERENCES patients(id),
  loser_id    UUID NOT NULL REFERENCES patients(id),
  merged_by   TEXT NOT NULL,
  moved_ids   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_at   TIMESTAMPTZ,
  undone_by   TEXT,
  CHECK (survivor_id <> loser_id)
);
CREATE INDEX IF NOT EXISTS patient_merges_created_idx
  ON patient_merges (created_at DESC);

ALTER TABLE event_log DROP CONSTRAINT IF EXISTS event_log_event_check;
ALTER TABLE event_log ADD CONSTRAINT event_log_event_check CHECK (
  event IN (
    'patient_view', 'sign_in', 'sign_out', 'report_export',
    'auth_failure', 'admin_action', 'api_request',
    'appointment_change', 'message_send', 'message_read',
    'document_create', 'document_update', 'document_finalize',
    'agency_sync', 'expense_change', 'patient_merge'
  )
);

GRANT SELECT, INSERT, UPDATE ON patient_merge_marks TO patient_api;
GRANT SELECT, INSERT, UPDATE ON patient_merges TO patient_api;
GRANT USAGE, SELECT ON SEQUENCE patient_merges_id_seq TO patient_api;

COMMIT;
