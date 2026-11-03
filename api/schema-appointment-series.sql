-- Appointment series (Jake, 2026-11-02): repeating visits are
-- individual appointment rows linked by a shared series_id, so
-- one visit can move or cancel without touching the rest —
-- the series link only records that they were created together
-- (create / edit / delete can then act on the whole set).
-- Idempotent.

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS series_id UUID;

CREATE INDEX IF NOT EXISTS appointments_series_idx
  ON appointments (series_id) WHERE series_id IS NOT NULL;
