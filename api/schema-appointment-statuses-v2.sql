-- Appointment statuses v2 (Jake, 2026-11-02): the flow-board
-- seven (booked/confirmed/arrived/in_room/checked_out/
-- cancelled/no_show) collapse to THREE user-facing statuses —
--   scheduled  (yellow)  — the visit is on the books
--   completed  (green)   — the visit happened
--   missed     (red)     — the visit did not happen
-- Legacy codes stay in appointment_statuses (history and audit
-- rows may reference them) but sort below the big three, and
-- every stored appointment is remapped:
--   booked/confirmed/arrived/in_room -> scheduled
--   checked_out                      -> completed
--   no_show                          -> missed
--   cancelled                        -> stays cancelled (a
--     cancellation is neither completed nor missed)
-- New appointments default to 'scheduled'. Idempotent.

BEGIN;

INSERT INTO appointment_statuses (code, label, color, is_checkin, is_checkout, sort_order)
VALUES
  ('scheduled', 'Scheduled', '#d97706', false, false, 1),
  ('completed', 'Completed', '#16a34a', false, true, 2),
  ('missed',    'Missed',    '#dc2626', false, false, 3)
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label, color = EXCLUDED.color,
  is_checkin = EXCLUDED.is_checkin, is_checkout = EXCLUDED.is_checkout,
  sort_order = EXCLUDED.sort_order;

UPDATE appointment_statuses
   SET sort_order = sort_order + 10
 WHERE code IN ('booked','confirmed','arrived','in_room','checked_out','cancelled','no_show')
   AND sort_order < 10;

UPDATE appointments SET status = 'scheduled'
 WHERE status IN ('booked','confirmed','arrived','in_room');
UPDATE appointments SET status = 'completed' WHERE status = 'checked_out';
UPDATE appointments SET status = 'missed'    WHERE status = 'no_show';

ALTER TABLE appointments ALTER COLUMN status SET DEFAULT 'scheduled';

COMMIT;
