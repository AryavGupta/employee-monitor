-- Migration: Analytics and Monitoring Enhancement
-- Run this in Supabase SQL Editor to add new tables
-- Date: 2026-01-13

-- =====================================================
-- PHASE 1: Analytics & Reports Tables
-- =====================================================

-- Daily productivity metrics aggregation
CREATE TABLE IF NOT EXISTS productivity_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    total_active_time INTEGER DEFAULT 0,
    total_idle_time INTEGER DEFAULT 0,
    keyboard_events INTEGER DEFAULT 0,
    mouse_events INTEGER DEFAULT 0,
    productive_time INTEGER DEFAULT 0,
    unproductive_time INTEGER DEFAULT 0,
    neutral_time INTEGER DEFAULT 0,
    top_applications JSONB DEFAULT '[]',
    top_urls JSONB DEFAULT '[]',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, date)
);

-- Application categorization (productive/unproductive/neutral)
CREATE TABLE IF NOT EXISTS app_categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    pattern VARCHAR(500) NOT NULL,
    category VARCHAR(50) NOT NULL CHECK (category IN ('productive', 'unproductive', 'neutral')),
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for productivity metrics
CREATE INDEX IF NOT EXISTS idx_productivity_metrics_user_date ON productivity_metrics(user_id, date);
CREATE INDEX IF NOT EXISTS idx_productivity_metrics_date ON productivity_metrics(date DESC);
CREATE INDEX IF NOT EXISTS idx_app_categories_team ON app_categories(team_id);
CREATE INDEX IF NOT EXISTS idx_app_categories_category ON app_categories(category);

-- =====================================================
-- PHASE 2: Real-time Monitoring Tables
-- =====================================================

-- Create sessions table if it doesn't exist (needed for user_presence)
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    start_time TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    end_time TIMESTAMP WITH TIME ZONE,
    duration_seconds INTEGER,
    is_active BOOLEAN DEFAULT true,
    system_info JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON sessions(start_time DESC);

-- Real-time user presence
CREATE TABLE IF NOT EXISTS user_presence (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(50) NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'idle', 'offline')),
    current_application VARCHAR(255),
    current_window_title VARCHAR(500),
    current_url VARCHAR(1000),
    last_heartbeat TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
    UNIQUE(user_id)
);

-- Alert rules for automated alerts
CREATE TABLE IF NOT EXISTS alert_rules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    rule_type VARCHAR(50) NOT NULL CHECK (rule_type IN ('idle_threshold', 'blocked_site', 'application_usage', 'working_hours', 'productivity_drop')),
    conditions JSONB NOT NULL,
    severity VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    is_active BOOLEAN DEFAULT true,
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for real-time monitoring
CREATE INDEX IF NOT EXISTS idx_user_presence_status ON user_presence(status);
CREATE INDEX IF NOT EXISTS idx_user_presence_heartbeat ON user_presence(last_heartbeat);
CREATE INDEX IF NOT EXISTS idx_alert_rules_team ON alert_rules(team_id);
CREATE INDEX IF NOT EXISTS idx_alert_rules_active ON alert_rules(is_active);

-- =====================================================
-- PHASE 3: Team Management Tables
-- =====================================================

-- Add manager column to teams (safe to run multiple times)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'teams' AND column_name = 'manager_id') THEN
        ALTER TABLE teams ADD COLUMN manager_id UUID REFERENCES users(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'teams' AND column_name = 'settings') THEN
        ALTER TABLE teams ADD COLUMN settings JSONB DEFAULT '{}';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'teams' AND column_name = 'is_active') THEN
        ALTER TABLE teams ADD COLUMN is_active BOOLEAN DEFAULT true;
    END IF;
END $$;

-- Team-specific monitoring settings
CREATE TABLE IF NOT EXISTS team_monitoring_settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    screenshot_interval INTEGER DEFAULT 60,
    activity_interval INTEGER DEFAULT 10,
    idle_threshold INTEGER DEFAULT 300,
    track_urls BOOLEAN DEFAULT true,
    track_applications BOOLEAN DEFAULT true,
    track_keyboard_mouse BOOLEAN DEFAULT true,
    working_hours_start TIME,
    working_hours_end TIME,
    working_days INTEGER[] DEFAULT '{1,2,3,4,5}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(team_id)
);

-- Site blocking rules per team
CREATE TABLE IF NOT EXISTS site_rules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    domain VARCHAR(500) NOT NULL,
    rule_type VARCHAR(20) NOT NULL CHECK (rule_type IN ('block', 'allow', 'warn')),
    category VARCHAR(100),
    reason TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for team management
CREATE INDEX IF NOT EXISTS idx_team_monitoring_settings_team ON team_monitoring_settings(team_id);
CREATE INDEX IF NOT EXISTS idx_site_rules_team ON site_rules(team_id);
CREATE INDEX IF NOT EXISTS idx_site_rules_domain ON site_rules(domain);

-- =====================================================
-- PHASE 4: Enhanced Activity Logs
-- =====================================================

-- Add new columns to activity_logs for enhanced tracking (safe to run multiple times)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'activity_logs' AND column_name = 'keyboard_events') THEN
        ALTER TABLE activity_logs ADD COLUMN keyboard_events INTEGER DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'activity_logs' AND column_name = 'mouse_events') THEN
        ALTER TABLE activity_logs ADD COLUMN mouse_events INTEGER DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'activity_logs' AND column_name = 'mouse_distance') THEN
        ALTER TABLE activity_logs ADD COLUMN mouse_distance INTEGER DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'activity_logs' AND column_name = 'engagement_score') THEN
        ALTER TABLE activity_logs ADD COLUMN engagement_score DECIMAL(5,2);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'activity_logs' AND column_name = 'url') THEN
        ALTER TABLE activity_logs ADD COLUMN url VARCHAR(1000);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'activity_logs' AND column_name = 'domain') THEN
        ALTER TABLE activity_logs ADD COLUMN domain VARCHAR(255);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'activity_logs' AND column_name = 'is_blocked_attempt') THEN
        ALTER TABLE activity_logs ADD COLUMN is_blocked_attempt BOOLEAN DEFAULT false;
    END IF;
END $$;

-- Indexes for enhanced activity logs
CREATE INDEX IF NOT EXISTS idx_activity_logs_domain ON activity_logs(domain);

-- =====================================================
-- Default App Categories (Seed Data)
-- =====================================================

INSERT INTO app_categories (name, pattern, category) VALUES
    ('VS Code', 'code|visual studio code', 'productive'),
    ('Microsoft Office', 'word|excel|powerpoint|outlook', 'productive'),
    ('Terminal', 'terminal|cmd|powershell|bash|iterm', 'productive'),
    ('Slack', 'slack', 'productive'),
    ('Microsoft Teams', 'teams', 'productive'),
    ('Zoom', 'zoom', 'productive'),
    ('Chrome DevTools', 'devtools', 'productive'),
    ('GitHub', 'github', 'productive'),
    ('Jira', 'jira', 'productive'),
    ('Notion', 'notion', 'productive'),
    ('Facebook', 'facebook', 'unproductive'),
    ('Instagram', 'instagram', 'unproductive'),
    ('Twitter', 'twitter|x.com', 'unproductive'),
    ('YouTube', 'youtube', 'neutral'),
    ('Reddit', 'reddit', 'unproductive'),
    ('TikTok', 'tiktok', 'unproductive'),
    ('Netflix', 'netflix', 'unproductive'),
    ('Spotify', 'spotify', 'neutral'),
    ('WhatsApp', 'whatsapp', 'neutral'),
    ('LinkedIn', 'linkedin', 'neutral')
ON CONFLICT DO NOTHING;

-- Default site blocking rules (global)
INSERT INTO site_rules (domain, rule_type, category, reason) VALUES
    ('facebook.com', 'block', 'social_media', 'Social media not allowed during work hours'),
    ('instagram.com', 'block', 'social_media', 'Social media not allowed during work hours'),
    ('tiktok.com', 'block', 'social_media', 'Social media not allowed during work hours'),
    ('twitter.com', 'block', 'social_media', 'Social media not allowed during work hours'),
    ('x.com', 'block', 'social_media', 'Social media not allowed during work hours'),
    ('netflix.com', 'block', 'streaming', 'Streaming services not allowed during work hours'),
    ('twitch.tv', 'block', 'streaming', 'Streaming services not allowed during work hours')
ON CONFLICT DO NOTHING;

-- Success message
SELECT 'Migration completed successfully!' as status;
