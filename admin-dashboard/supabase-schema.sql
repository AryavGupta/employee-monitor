-- Employee Monitor Database Schema for Supabase
-- Run this in your Supabase SQL Editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Teams table
CREATE TABLE IF NOT EXISTS teams (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'employee' CHECK (role IN ('admin', 'manager', 'employee')),
    team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Activity logs table
CREATE TABLE IF NOT EXISTS activity_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    activity_type VARCHAR(100) NOT NULL,
    application_name VARCHAR(255),
    window_title TEXT,
    is_idle BOOLEAN DEFAULT false,
    duration_seconds INTEGER,
    metadata JSONB,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Screenshots table
CREATE TABLE IF NOT EXISTS screenshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    screenshot_url TEXT NOT NULL,
    captured_at TIMESTAMP WITH TIME ZONE NOT NULL,
    file_size INTEGER,
    is_flagged BOOLEAN DEFAULT false,
    flag_reason TEXT,
    system_info JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Audit logs table
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(100),
    entity_id UUID,
    ip_address VARCHAR(45),
    user_agent TEXT,
    details JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    end_time TIMESTAMP WITH TIME ZONE,
    duration_seconds INTEGER,
    active_seconds INTEGER,          -- Actual active (non-idle) time tracked by desktop app
    idle_seconds INTEGER,            -- Actual idle time tracked by desktop app
    is_active BOOLEAN DEFAULT true,
    system_info JSONB,
    notes TEXT,                      -- Session notes (e.g., "Active: 30min, Idle: 5min")
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Migration for existing databases:
-- ALTER TABLE sessions ADD COLUMN IF NOT EXISTS active_seconds INTEGER;
-- ALTER TABLE sessions ADD COLUMN IF NOT EXISTS idle_seconds INTEGER;
-- ALTER TABLE sessions ADD COLUMN IF NOT EXISTS notes TEXT;

-- Alerts table
CREATE TABLE IF NOT EXISTS alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    alert_type VARCHAR(100) NOT NULL,
    severity VARCHAR(50) DEFAULT 'low' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    title VARCHAR(255) NOT NULL,
    message TEXT,
    is_read BOOLEAN DEFAULT false,
    is_resolved BOOLEAN DEFAULT false,
    resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    resolved_at TIMESTAMP WITH TIME ZONE,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Add columns for Supabase Storage optimization
ALTER TABLE screenshots ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;
ALTER TABLE screenshots ADD COLUMN IF NOT EXISTS storage_path TEXT;

-- Composite index for efficient user+time queries (critical for performance)
CREATE INDEX IF NOT EXISTS idx_screenshots_user_captured_at ON screenshots(user_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_screenshots_captured_date ON screenshots(DATE(captured_at));

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id ON activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_timestamp ON activity_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_activity_type ON activity_logs(activity_type);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user_timestamp ON activity_logs(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user_date ON activity_logs(user_id, DATE(timestamp));

CREATE INDEX IF NOT EXISTS idx_screenshots_user_id ON screenshots(user_id);
CREATE INDEX IF NOT EXISTS idx_screenshots_captured_at ON screenshots(captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON sessions(start_time DESC);

CREATE INDEX IF NOT EXISTS idx_alerts_user_id ON alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_is_read ON alerts(is_read);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_team_id ON users(team_id);

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

-- Add manager column to teams
ALTER TABLE teams ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}';
ALTER TABLE teams ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

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

-- Add new columns to activity_logs for enhanced tracking
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS keyboard_events INTEGER DEFAULT 0;
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS mouse_events INTEGER DEFAULT 0;
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS mouse_distance INTEGER DEFAULT 0;
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS engagement_score DECIMAL(5,2);
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS url VARCHAR(1000);
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS domain VARCHAR(255);
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS is_blocked_attempt BOOLEAN DEFAULT false;

-- Indexes for enhanced activity logs
CREATE INDEX IF NOT EXISTS idx_activity_logs_domain ON activity_logs(domain);
CREATE INDEX IF NOT EXISTS idx_activity_logs_blocked ON activity_logs(is_blocked_attempt) WHERE is_blocked_attempt = true;

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

-- Insert default admin user (password: admin123)
-- You should change this password immediately after first login
INSERT INTO users (email, password_hash, full_name, role)
VALUES ('admin@example.com', '$2b$10$rQZ5x5p5p5p5p5p5p5p5p.5p5p5p5p5p5p5p5p5p5p5p5p5p5p5p5p', 'System Admin', 'admin')
ON CONFLICT (email) DO NOTHING;
