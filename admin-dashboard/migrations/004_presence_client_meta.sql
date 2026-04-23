-- 004_presence_client_meta.sql
-- Adds desktop-client metadata columns to user_presence: app version and OS info.
-- Surfaced on the Dashboard employee table so admins can spot stale installs
-- (e.g. users still on a pre-overtime-split build).

ALTER TABLE user_presence
  ADD COLUMN IF NOT EXISTS app_version VARCHAR(20),
  ADD COLUMN IF NOT EXISTS os_platform VARCHAR(20),
  ADD COLUMN IF NOT EXISTS os_version  VARCHAR(50);
