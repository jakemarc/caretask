-- CareTask appointments, correlated with OpenEMR's calendar model —
-- apply AFTER schema.sql, schema-events.sql, schema-patients-v2.sql,
-- schema-users.sql.
--
-- Run as the table owner (postgres), like every migration here:
--   sudo -u postgres psql -d caretask_demo -f schema-appointments.sql
--
-- How this maps to OpenEMR (openemr_postcalendar_*):
--   appointment_categories  ← openemr_postcalendar_categories:
--     name (pc_catname), color (pc_catcolor), description
--     (pc_catdesc), cattype (pc_cattype: appointment vs provider
--     schedule events), default duration (pc_duration — OpenEMR
--     stores seconds; we store minutes, the unit the form shows).
--     OpenEMR's provider categories (In Office, Out of Office,
--     Lunch, Vacation…) are seeded with cattype='provider'.
--   appointment_statuses    ← list_options where list_id='apptstat':
--     a configurable status list, each row flagged is_checkin /
--     is_checkout (OpenEMR's toggle_setting_1 / toggle_setting_2)
--     with a display color. OpenEMR stores single-symbol codes
--     ('@' = Arrived, '=' = Took Place); we use readable codes for
--     the same workflow: booked → confirmed → arrived (check-in) →
--     in_room → checked_out, plus cancelled / no_show.
--   appointments            ← openemr_postcalendar_events:
--     patient_id (pc_pid; NULL for provider schedule events),
--     provider_id (pc_aid → users), category_id (pc_catid),
--     room (pc_room), comments (pc_hometext → notes), status
--     (pc_apptstatus). OpenEMR splits date/time/duration across
--     pc_eventDate/pc_startTime/pc_duration; we store starts_at /
--     ends_at timestamptz and derive duration — equivalent, and the
--     form still works OpenEMR's way (category fills the default
--     duration; end = start + duration).
--   Deferred OpenEMR pieces (documented, not silently dropped):
--     recurrence (pc_recurrtype / pc_recurrspec / pc_endDate and
--     edit-one/future/all semantics), facility + billing facility
--     (pc_facility / pc_billing_location — we have no facility
--     table yet), provider IN/OUT auto-schedules.
--
-- Also widens event_log's vocabulary with 'appointment_change'.

CREATE TABLE IF NOT EXISTS appointment_categories (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                  TEXT NOT NULL UNIQUE,
  color                 TEXT NOT NULL DEFAULT '#3b82f6',
  description           TEXT,
  cattype               TEXT NOT NULL DEFAULT 'appointment'
                        CHECK (cattype IN ('appointment', 'provider')),
  default_duration_min  INTEGER NOT NULL DEFAULT 30
                        CHECK (default_duration_min > 0),
  active                BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS appointment_statuses (
  code        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#64748b',
  is_checkin  BOOLEAN NOT NULL DEFAULT false,
  is_checkout BOOLEAN NOT NULL DEFAULT false,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS appointments (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patient_id  UUID REFERENCES patients(id),
  provider_id BIGINT REFERENCES users(id),
  category_id BIGINT NOT NULL REFERENCES appointment_categories(id),
  title       TEXT NOT NULL DEFAULT 'Visit',
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ NOT NULL,
  status      TEXT NOT NULL DEFAULT 'scheduled'
              REFERENCES appointment_statuses(code),
  room        TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  CHECK (ends_at > starts_at),
  -- Patient appointments need a patient; provider events must not
  -- invent one. (Category cattype is the real discriminator; this
  -- just stops a patient-less row claiming an appointment category
  -- is impossible to express in a CHECK without a join — enforced
  -- in the route instead. Kept nullable on purpose.)
  CHECK (patient_id IS NOT NULL OR provider_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS appointments_starts_idx
  ON appointments (starts_at);
CREATE INDEX IF NOT EXISTS appointments_patient_idx
  ON appointments (patient_id, starts_at);
CREATE INDEX IF NOT EXISTS appointments_provider_idx
  ON appointments (provider_id, starts_at);

CREATE OR REPLACE FUNCTION appointments_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS appointments_updated_at ON appointments;
CREATE TRIGGER appointments_updated_at
  BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_set_updated_at();

-- Widen the event vocabulary (constraint name is the Postgres default
-- from schema-events.sql; drop-if-exists keeps this re-runnable).
ALTER TABLE event_log DROP CONSTRAINT IF EXISTS event_log_event_check;
ALTER TABLE event_log ADD CONSTRAINT event_log_event_check
  CHECK (event IN (
    'patient_view','sign_in','sign_out','report_export',
    'auth_failure','admin_action','api_request','appointment_change'
  ));

GRANT SELECT, INSERT, UPDATE ON appointments TO patient_api;
GRANT USAGE, SELECT ON SEQUENCE appointments_id_seq TO patient_api;
GRANT SELECT, INSERT, UPDATE ON appointment_categories TO patient_api;
GRANT USAGE, SELECT ON SEQUENCE appointment_categories_id_seq TO patient_api;
GRANT SELECT ON appointment_statuses TO patient_api;
