-- CareTask multi-user platform — schema (Jake's design, 2026-11-03;
-- spec: ~/workspace/marc-innotech/multi-user-platform-spec.md).
--
-- The platform layer on top of the existing tables:
--   user_agencies   — the agencies a clinician works for.
--   patient_links   — a user's personal list: links to registry
--                     patients, carrying the PER-USER list status.
--   patient_episodes— one active episode per patient, system-wide
--                     (partial unique index), at one agency.
--   episode_members — the episode's team (primary + members).
--   episode_holds   — on-hold periods (hospitalization etc.),
--                     discharge_reason + case_manager on the
--                     episode (addendum, Jake 2026-11-03).
--   invites         — invite-only sign-up (code stored hashed).
--   appointments.episode_id — the episode a visit belongs to.
--
-- Also widens the event_log CHECK with the platform event types,
-- following the established pattern in the earlier schema files.
--
-- Idempotent: safe to re-run (IF NOT EXISTS / DROP CONSTRAINT IF
-- EXISTS throughout), matching the rest of the schema chain.

-- ---------------------------------------------------------------- user_agencies
CREATE TABLE IF NOT EXISTS user_agencies (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agency_id  BIGINT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, agency_id)
);

-- ---------------------------------------------------------------- patient_links
CREATE TABLE IF NOT EXISTS patient_links (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  patient_id  UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  list_status TEXT NOT NULL DEFAULT 'active'
              CHECK (list_status IN ('active', 'hold', 'discharged')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at  TIMESTAMPTZ,
  PRIMARY KEY (user_id, patient_id)
);
CREATE INDEX IF NOT EXISTS patient_links_patient_idx
  ON patient_links (patient_id);

-- ---------------------------------------------------------------- patient_episodes
CREATE TABLE IF NOT EXISTS patient_episodes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  agency_id       BIGINT NOT NULL REFERENCES agencies(id),
  primary_user_id BIGINT NOT NULL REFERENCES users(id),
  -- The clinical coordinator of the case (HCHB's episode-header
  -- role), distinct from the primary: a current team member,
  -- defaults to the primary, transferable (addendum 2026-11-03).
  case_manager_user_id BIGINT REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'on_hold', 'discharged')),
  admitted_at     DATE NOT NULL DEFAULT CURRENT_DATE,
  discharged_at   DATE,
  -- Why the episode ended (addendum 2026-11-03): the "patient
  -- couldn't finish" accounting. NULL while the episode is live.
  discharge_reason TEXT
                  CHECK (discharge_reason IN ('completed', 'patient_declined',
                    'transferred_agency', 'transferred_inpatient',
                    'moved_out_of_area', 'physician_order', 'deceased', 'other')),
  discharge_note  TEXT,
  recert_of       UUID REFERENCES patient_episodes(id),
  created_by      BIGINT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
-- The platform's central invariant: at most ONE live episode per
-- patient across ALL agencies. A transfer is impossible until the
-- current episode is discharged — enforced here, not by
-- convention. A HELD episode is still live: hospitalization does
-- not free the patient for another agency.
CREATE UNIQUE INDEX IF NOT EXISTS patient_episodes_one_active_idx
  ON patient_episodes (patient_id)
  WHERE status IN ('active', 'on_hold') AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS patient_episodes_patient_idx
  ON patient_episodes (patient_id, admitted_at DESC);
CREATE INDEX IF NOT EXISTS patient_episodes_agency_idx
  ON patient_episodes (agency_id);

-- ---------------------------------------------------------------- episode_members
CREATE TABLE IF NOT EXISTS episode_members (
  episode_id    UUID NOT NULL REFERENCES patient_episodes(id) ON DELETE CASCADE,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_role   TEXT NOT NULL DEFAULT 'member'
                CHECK (member_role IN ('primary', 'member')),
  supervised_by BIGINT REFERENCES users(id),
  added_by      BIGINT REFERENCES users(id),
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at    TIMESTAMPTZ,
  PRIMARY KEY (episode_id, user_id)
);
CREATE INDEX IF NOT EXISTS episode_members_user_idx
  ON episode_members (user_id);

-- ---------------------------------------------------------------- episode_holds
-- On-hold periods (addendum, Jake 2026-11-03): the hospitalized
-- patient case. An episode's current hold is the row with
-- ended_on NULL. Reason list mirrors the real causes; the note
-- carries the detail (hospital name, expected return, ...).
CREATE TABLE IF NOT EXISTS episode_holds (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  episode_id UUID NOT NULL REFERENCES patient_episodes(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL DEFAULT 'other'
             CHECK (reason IN ('hospitalized', 'patient_request',
                               'physician_order', 'other')),
  note       TEXT,
  started_on DATE NOT NULL DEFAULT CURRENT_DATE,
  ended_on   DATE,
  started_by BIGINT REFERENCES users(id),
  ended_by   BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS episode_holds_episode_idx
  ON episode_holds (episode_id, started_on DESC);

-- ---------------------------------------------------------------- duplicate dismissals
-- Epic's "Known Non-Duplicate" idea, adapted to our create flow:
-- when a user reviews a POSSIBLE_MATCH candidate and confirms the
-- create anyway, the pair (candidate patient, incoming fingerprint)
-- is remembered, so the same intake data never re-prompts the same
-- candidate. The fingerprint is sha1 of normalized fname|lname|dob.
CREATE TABLE IF NOT EXISTS patient_duplicate_dismissals (
  patient_id   UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  fingerprint  TEXT NOT NULL,
  dismissed_by BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (patient_id, fingerprint)
);

-- ---------------------------------------------------------------- invites
-- code_hash is the SHA-256 of the invite code; the raw code is
-- returned exactly once, at creation, for the admin to send.
CREATE TABLE IF NOT EXISTS invites (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'clinician'
              CHECK (role IN ('clinician', 'manager', 'admin', 'developer',
                              'support', 'billing', 'front_office')),
  code_hash   TEXT NOT NULL UNIQUE,
  invited_by  BIGINT REFERENCES users(id),
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_by BIGINT REFERENCES users(id),
  accepted_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invites_email_idx
  ON invites (lower(email));

-- ---------------------------------------------------------------- appointments
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS episode_id UUID
    REFERENCES patient_episodes(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS appointments_episode_idx
  ON appointments (episode_id);

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
    'invite_create', 'invite_accept', 'agency_membership'
  )
);
