-- Multi-monitor support: track which display each screenshot came from.
-- Server inserts these via INSERT-then-fallback (catches 42703), so this
-- migration is optional — applying it just makes the data visible in DB.
--
-- Apply via: psql $DATABASE_URL -f migrations/002_screenshots_display.sql

ALTER TABLE screenshots ADD COLUMN IF NOT EXISTS display_id VARCHAR(64);
ALTER TABLE screenshots ADD COLUMN IF NOT EXISTS display_label VARCHAR(64);

-- Index for grouping by capture moment per user (multi-monitor reads).
-- CONCURRENTLY avoids locking writes on a busy screenshots table; cannot
-- run inside a transaction so apply via separate statement (apply script
-- handles this).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_screenshots_user_captured_display
  ON screenshots(user_id, captured_at, display_id);
