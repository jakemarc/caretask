-- CareTask clinician tasks — the todo/reminder list (queued by
-- Jake 2026-11-02): per-clinician tasks, each a general reminder
-- or linked to a patient (patient tasks also surface on the
-- patient profile), with an optional due date/time and a done
-- state. IN-APP ONLY — patient-facing SMS/email reminders are the
-- separate messaging Phase 3 proposal, not this table.
--
-- A task belongs to its owner (the clinician who created it);
-- other staff — managers included — do not read someone else's
-- list. Deletion is soft, house style.
--
-- Run AFTER schema-patient-merge.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS clinician_tasks (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  patient_id UUID NULL REFERENCES patients(id),
  title      TEXT NOT NULL,
  notes      TEXT,
  due_at     TIMESTAMPTZ,
  done_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS clinician_tasks_owner_idx
  ON clinician_tasks (user_id, done_at, due_at);
CREATE INDEX IF NOT EXISTS clinician_tasks_patient_idx
  ON clinician_tasks (patient_id) WHERE patient_id IS NOT NULL;

CREATE OR REPLACE FUNCTION clinician_tasks_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS clinician_tasks_updated_at ON clinician_tasks;
CREATE TRIGGER clinician_tasks_updated_at
  BEFORE UPDATE ON clinician_tasks
  FOR EACH ROW EXECUTE FUNCTION clinician_tasks_set_updated_at();

ALTER TABLE event_log DROP CONSTRAINT IF EXISTS event_log_event_check;
ALTER TABLE event_log ADD CONSTRAINT event_log_event_check CHECK (
  event IN (
    'patient_view', 'sign_in', 'sign_out', 'report_export',
    'auth_failure', 'admin_action', 'api_request',
    'appointment_change', 'message_send', 'message_read',
    'document_create', 'document_update', 'document_finalize',
    'agency_sync', 'expense_change', 'patient_merge', 'task_change'
  )
);

GRANT SELECT, INSERT, UPDATE ON clinician_tasks TO patient_api;
GRANT USAGE, SELECT ON SEQUENCE clinician_tasks_id_seq TO patient_api;

COMMIT;
