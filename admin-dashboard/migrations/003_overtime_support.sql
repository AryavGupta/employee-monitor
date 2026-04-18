-- 003_overtime_support.sql
-- Adds overtime / extra-hours tracking support across sessions, team settings, and presence.

-- 1. Overtime flag on sessions (regular vs extra-hours)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS overtime BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_sessions_user_overtime
    ON sessions(user_id, overtime, start_time DESC);

-- 2. Per-team toggle: allow desktop to track outside the configured shift window
ALTER TABLE team_monitoring_settings
    ADD COLUMN IF NOT EXISTS track_outside_hours BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. Promote 'logged_out' to a first-class presence state.
-- Drop the existing CHECK constraint (named or unnamed) and re-add with the expanded enum.
DO $$
DECLARE
    cname text;
BEGIN
    SELECT conname INTO cname
    FROM pg_constraint
    WHERE conrelid = 'user_presence'::regclass
      AND contype  = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%IN%';
    IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE user_presence DROP CONSTRAINT %I', cname);
    END IF;
END$$;

ALTER TABLE user_presence
    ADD CONSTRAINT user_presence_status_check
    CHECK (status IN ('online', 'idle', 'offline', 'logged_out'));
