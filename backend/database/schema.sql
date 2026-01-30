-- Employee Monitoring System Database Schema

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL CHECK (role IN ('admin', 'team_manager', 'employee')),
  team_id UUID,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Teams table
CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Screenshots table
CREATE TABLE screenshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  screenshot_url TEXT NOT NULL,
  thumbnail_url TEXT,
  captured_at TIMESTAMP NOT NULL,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  file_size BIGINT,
  resolution VARCHAR(20),
  system_info JSONB,
  is_flagged BOOLEAN DEFAULT false,
  flag_reason VARCHAR(255),
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Activity tracking table
CREATE TABLE activity_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_type VARCHAR(50) NOT NULL,
  application_name VARCHAR(255),
  window_title VARCHAR(500),
  is_idle BOOLEAN DEFAULT false,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  duration_seconds INTEGER,
  metadata JSONB
);

-- Work sessions table
CREATE TABLE work_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_start TIMESTAMP NOT NULL,
  session_end TIMESTAMP,
  total_active_time INTEGER DEFAULT 0,
  total_idle_time INTEGER DEFAULT 0,
  screenshot_count INTEGER DEFAULT 0,
  is_offline BOOLEAN DEFAULT false,
  offline_approved BOOLEAN DEFAULT false,
  approved_by UUID REFERENCES users(id),
  notes TEXT
);

-- Alerts table
CREATE TABLE alerts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  message TEXT NOT NULL,
  metadata JSONB,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP,
  resolved_by UUID REFERENCES users(id)
);

-- Audit logs table
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id),
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id UUID,
  changes JSONB,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add foreign key for team_id in users table
ALTER TABLE users ADD CONSTRAINT fk_team FOREIGN KEY (team_id) REFERENCES teams(id);

-- Create indexes for better query performance
CREATE INDEX idx_screenshots_user_id ON screenshots(user_id);
CREATE INDEX idx_screenshots_captured_at ON screenshots(captured_at);
CREATE INDEX idx_screenshots_flagged ON screenshots(is_flagged);
CREATE INDEX idx_activity_logs_user_id ON activity_logs(user_id);
CREATE INDEX idx_activity_logs_timestamp ON activity_logs(timestamp);
CREATE INDEX idx_work_sessions_user_id ON work_sessions(user_id);
CREATE INDEX idx_work_sessions_dates ON work_sessions(session_start, session_end);
CREATE INDEX idx_alerts_user_id ON alerts(user_id);
CREATE INDEX idx_alerts_unread ON alerts(is_read) WHERE is_read = false;
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply trigger to users table
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Apply trigger to teams table
CREATE TRIGGER update_teams_updated_at BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert default admin user (password: Admin@123)
-- Hash generated with bcrypt, rounds=10
INSERT INTO users (email, password_hash, full_name, role) VALUES
('admin@company.com', '$2b$10$8K1p/a0dL3.I9U.8Zwv.sO5LLBEqGMxaLJhLZMo4sDGBxvJnxDxFK', 'System Admin', 'admin');

-- Insert sample teams
INSERT INTO teams (name, description) VALUES
('Engineering', 'Software development team'),
('Sales', 'Sales and business development'),
('Support', 'Customer support team'),
('Marketing', 'Marketing and growth');

-- Create view for user activity summary
CREATE OR REPLACE VIEW user_activity_summary AS
SELECT 
  u.id,
  u.email,
  u.full_name,
  u.role,
  t.name as team_name,
  COUNT(DISTINCT ws.id) as total_sessions,
  COALESCE(SUM(ws.total_active_time), 0) as total_active_seconds,
  COALESCE(SUM(ws.total_idle_time), 0) as total_idle_seconds,
  COUNT(s.id) as total_screenshots,
  COUNT(CASE WHEN s.is_flagged = true THEN 1 END) as flagged_screenshots
FROM users u
LEFT JOIN teams t ON u.team_id = t.id
LEFT JOIN work_sessions ws ON u.id = ws.user_id
LEFT JOIN screenshots s ON u.id = s.user_id
WHERE u.is_active = true
GROUP BY u.id, u.email, u.full_name, u.role, t.name;

-- Create view for daily activity
CREATE OR REPLACE VIEW daily_activity AS
SELECT 
  u.id as user_id,
  u.email,
  u.full_name,
  DATE(s.captured_at) as activity_date,
  COUNT(s.id) as screenshots_count,
  COUNT(CASE WHEN s.is_flagged = true THEN 1 END) as flagged_count,
  MIN(s.captured_at) as first_activity,
  MAX(s.captured_at) as last_activity
FROM users u
LEFT JOIN screenshots s ON u.id = s.user_id
GROUP BY u.id, u.email, u.full_name, DATE(s.captured_at)
ORDER BY activity_date DESC;

COMMENT ON TABLE users IS 'Stores user account information';
COMMENT ON TABLE teams IS 'Organizational teams for grouping users';
COMMENT ON TABLE screenshots IS 'Captured screenshots with metadata';
COMMENT ON TABLE activity_logs IS 'Detailed activity tracking logs';
COMMENT ON TABLE work_sessions IS 'Work session records with time tracking';
COMMENT ON TABLE alerts IS 'System alerts and notifications';
COMMENT ON TABLE audit_logs IS 'Audit trail for all system actions';
