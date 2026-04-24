-- 005_presence_local_ip.sql
-- Adds local IP column to user_presence so the dashboard can display both the
-- LAN address (reported by the desktop app via os.networkInterfaces) alongside
-- the existing public ip_address (captured server-side from x-forwarded-for).
-- Helps ops distinguish users on the same corporate NAT.

ALTER TABLE user_presence
  ADD COLUMN IF NOT EXISTS local_ip VARCHAR(45);
