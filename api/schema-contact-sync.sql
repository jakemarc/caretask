-- CareTask phone contacts sync (CardDAV) — see
-- ~/workspace/marc-innotech/carddav-contacts-sync-spec.md.
--
-- One row per clinician who enables phone sync, plus per-contact
-- sync state (etag cache + drift detection). The clinician's
-- CardDAV password is NEVER stored here — only as a bcrypt hash
-- in Radicale's htpasswd file on the VM.
--
-- Also widens the event_log CHECK with 'contact_sync' (additive;
-- event details carry ids and counts only, never contact data).
--
-- Run AFTER schema-platform.sql. Idempotent.

CREATE TABLE IF NOT EXISTS user_contact_sync (
  user_id      BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  dav_username TEXT UNIQUE NOT NULL,
  enabled      BOOLEAN NOT NULL DEFAULT false,
  book_path    TEXT,
  last_sync_at TIMESTAMPTZ,
  last_result  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contact_sync_items (
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  patient_id   UUID   NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  dav_href     TEXT   NOT NULL,
  dav_etag     TEXT,
  content_hash TEXT   NOT NULL,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, patient_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON user_contact_sync TO patient_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON contact_sync_items TO patient_api;

-- ---------------------------------------------------------------- event types
ALTER TABLE event_log DROP CONSTRAINT IF EXISTS event_log_event_check;
ALTER TABLE event_log ADD CONSTRAINT event_log_event_check CHECK (
  event IN (
    'patient_view', 'sign_in', 'sign_out', 'report_export',
    'auth_failure', 'admin_action', 'api_request',
    'appointment_change', 'message_send', 'message_read',
    'document_create', 'document_update', 'document_finalize',
    'agency_sync', 'expense_change', 'patient_merge', 'task_change',
    'patient_link', 'patient_unlink',
    'episode_create', 'episode_discharge', 'episode_team',
    'episode_hold', 'episode_resume', 'episode_case_manager',
    'invite_create', 'invite_accept', 'agency_membership',
    'contact_sync'
  )
);
