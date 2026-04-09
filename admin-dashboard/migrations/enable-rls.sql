-- Enable Row Level Security on all public tables
-- This blocks direct PostgREST/anon access while the backend (service role) bypasses RLS automatically.
-- Run this in Supabase SQL Editor.

-- =====================================================
-- 1. Enable RLS on all tables
-- =====================================================

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.screenshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.productivity_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_monitoring_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.screenshot_analyses ENABLE ROW LEVEL SECURITY;

-- =====================================================
-- 2. Fix Security Definer Views
--    Change to SECURITY INVOKER so they respect the querying user's permissions
-- =====================================================

ALTER VIEW public.user_activity_summary SET (security_invoker = on);
ALTER VIEW public.daily_activity SET (security_invoker = on);

-- =====================================================
-- 3. Revoke direct anon/public access to tables
--    (belt and suspenders — RLS already blocks, but this ensures no leaks)
-- =====================================================

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;

-- Re-grant to service_role (used by backend) — this is the default but explicit is safer
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- =====================================================
-- Verification: Run these after applying to confirm
-- =====================================================
-- SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public';
-- Should show rowsecurity = true for all tables
