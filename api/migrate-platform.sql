-- CareTask multi-user platform — DATA migration for existing rows
-- (spec §7, 2026-11-03). Run AFTER schema-platform.sql.
--
-- What it does:
-- 1. Links every existing patient to every platform-admin staff row
--    (today: Jake's admin account — his demo world keeps working)
--    and to every staff user who has >= 1 appointment with them.
--    list_status comes from the patient's current status column.
-- 2. For each patient WITH an agency and no active episode: creates
--    one active episode at that agency. Primary = provider of the
--    patient's earliest appointment, else the (first) admin user.
--    Members = all distinct providers of the patient's appointments
--    plus the primary. The patient's appointments are stamped.
-- 3. Agency memberships: every episode member joins the episode's
--    agency; admin users join every agency that appears on any
--    patient (so episodes can be started for any existing patient).
--
-- Patients WITHOUT an agency get links only: no episode, and
-- their appointments keep episode_id NULL. New bookings for them
-- are personal visits (solo mode, Jake 2026-11-03) until an
-- episode is started for them.
--
-- Re-running is safe: links/memberships use ON CONFLICT DO NOTHING,
-- episode creation is guarded by NOT EXISTS (live episode — active
-- or on hold, matching the one-live-episode index).

BEGIN;

-- 1a. Links: admins -> all patients.
INSERT INTO patient_links (user_id, patient_id, list_status)
SELECT u.id, p.id,
       CASE WHEN p.status IN ('active', 'hold', 'discharged')
            THEN p.status ELSE 'active' END
  FROM users u
  CROSS JOIN patients p
 WHERE u.role = 'admin' AND u.active = true AND p.deleted_at IS NULL
ON CONFLICT (user_id, patient_id) DO NOTHING;

-- 1b. Links: any provider with appointments -> those patients.
INSERT INTO patient_links (user_id, patient_id, list_status)
SELECT DISTINCT a.provider_id, a.patient_id,
       CASE WHEN p.status IN ('active', 'hold', 'discharged')
            THEN p.status ELSE 'active' END
  FROM appointments a
  JOIN patients p ON p.id = a.patient_id
 WHERE a.provider_id IS NOT NULL AND a.patient_id IS NOT NULL
   AND a.deleted_at IS NULL AND p.deleted_at IS NULL
ON CONFLICT (user_id, patient_id) DO NOTHING;

-- 2. Episodes for patients with an agency and no active episode.
WITH candidates AS (
  SELECT p.id AS patient_id, p.agency_id,
         COALESCE(
           (SELECT a.provider_id FROM appointments a
             WHERE a.patient_id = p.id AND a.provider_id IS NOT NULL
               AND a.deleted_at IS NULL
             ORDER BY a.starts_at ASC LIMIT 1),
           (SELECT u.id FROM users u
             WHERE u.role = 'admin' AND u.active = true
             ORDER BY u.id ASC LIMIT 1)
         ) AS primary_user_id,
         COALESCE(
           (SELECT a.starts_at::date FROM appointments a
             WHERE a.patient_id = p.id AND a.deleted_at IS NULL
             ORDER BY a.starts_at ASC LIMIT 1),
           CURRENT_DATE
         ) AS admitted_at
    FROM patients p
   WHERE p.agency_id IS NOT NULL AND p.deleted_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM patient_episodes e
        WHERE e.patient_id = p.id AND e.status IN ('active', 'on_hold')
          AND e.deleted_at IS NULL
     )
)
INSERT INTO patient_episodes (patient_id, agency_id, primary_user_id, case_manager_user_id, admitted_at, created_by)
SELECT patient_id, agency_id, primary_user_id, primary_user_id, admitted_at, primary_user_id
  FROM candidates
 WHERE primary_user_id IS NOT NULL;

-- 2b. Members: the primary of every live episode.
INSERT INTO episode_members (episode_id, user_id, member_role, added_by)
SELECT e.id, e.primary_user_id, 'primary', e.primary_user_id
  FROM patient_episodes e
 WHERE e.status IN ('active', 'on_hold') AND e.deleted_at IS NULL
ON CONFLICT (episode_id, user_id) DO NOTHING;

-- 2c. Members: every distinct provider of the patient's appointments.
INSERT INTO episode_members (episode_id, user_id, member_role, added_by)
SELECT DISTINCT e.id, a.provider_id, 'member', e.primary_user_id
  FROM patient_episodes e
  JOIN appointments a ON a.patient_id = e.patient_id
 WHERE e.status IN ('active', 'on_hold') AND e.deleted_at IS NULL
   AND a.provider_id IS NOT NULL AND a.deleted_at IS NULL
ON CONFLICT (episode_id, user_id) DO NOTHING;

-- 2d. Stamp the patient's appointments with the live episode.
UPDATE appointments a
   SET episode_id = e.id
  FROM patient_episodes e
 WHERE e.patient_id = a.patient_id
   AND e.status IN ('active', 'on_hold') AND e.deleted_at IS NULL
   AND a.episode_id IS NULL AND a.deleted_at IS NULL;

-- 3a. Memberships: episode members join their episode's agency.
INSERT INTO user_agencies (user_id, agency_id)
SELECT DISTINCT em.user_id, e.agency_id
  FROM episode_members em
  JOIN patient_episodes e ON e.id = em.episode_id
ON CONFLICT (user_id, agency_id) DO NOTHING;

-- 3b. Memberships: admins join every agency on any patient.
INSERT INTO user_agencies (user_id, agency_id)
SELECT DISTINCT u.id, p.agency_id
  FROM users u
  CROSS JOIN patients p
 WHERE u.role = 'admin' AND u.active = true
   AND p.agency_id IS NOT NULL AND p.deleted_at IS NULL
ON CONFLICT (user_id, agency_id) DO NOTHING;

COMMIT;
