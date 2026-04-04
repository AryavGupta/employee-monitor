import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import './Sidebar.css';

const Icons = {
  // Monitor/Screen logo matching design
  Monitor: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
      <line x1="8" x2="16" y1="21" y2="21"/>
      <line x1="12" x2="12" y1="17" y2="21"/>
    </svg>
  ),
  // Dashboard - grid/layout icon
  Dashboard: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7"/>
      <rect x="14" y="3" width="7" height="4"/>
      <rect x="14" y="10" width="7" height="7"/>
      <rect x="3" y="13" width="7" height="4"/>
    </svg>
  ),
  // Employees - people icon
  Employees: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  ),
  // Screenshots - image/photo icon
  Screenshots: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
      <circle cx="8.5" cy="8.5" r="1.5"/>
      <polyline points="21 15 16 10 5 21"/>
    </svg>
  ),
  // Analytics - bar chart icon
  Analytics: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" x2="18" y1="20" y2="10"/>
      <line x1="12" x2="12" y1="20" y2="4"/>
      <line x1="6" x2="6" y1="20" y2="14"/>
    </svg>
  ),
  // Attendance - clock icon
  Attendance: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
  ),
  // Teams - folder/briefcase icon
  Teams: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
    </svg>
  ),
  // Reports - file/document icon
  Reports: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" x2="8" y1="13" y2="13"/>
      <line x1="16" x2="8" y1="17" y2="17"/>
      <polyline points="10 9 9 9 8 9"/>
    </svg>
  ),
  // Settings - gear icon
  Settings: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  ),
  // Users - admin user management
  Users: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/>
      <circle cx="12" cy="7" r="4"/>
    </svg>
  ),
  LogOut: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
      <polyline points="16 17 21 12 16 7"/>
      <line x1="21" x2="9" y1="12" y2="12"/>
    </svg>
  ),
};

function Sidebar({ user, onLogout, activePage }) {
  const navigate = useNavigate();

  const handleLogout = () => {
    if (window.confirm('Are you sure you want to logout?')) {
      onLogout();
      navigate('/login');
    }
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <div className="sidebar-logo">
            <Icons.Monitor />
          </div>
          <h2>EmpMonitor</h2>
        </div>
      </div>

      <nav className="sidebar-nav">
        <div className="nav-section">
          <div className="nav-section-label">Main Menu</div>

          <Link to="/dashboard" className={`nav-item ${activePage === 'dashboard' ? 'active' : ''}`}>
            <span className="nav-icon"><Icons.Dashboard /></span>
            <span>Dashboard</span>
          </Link>

          {(user.role === 'admin' || user.role === 'team_manager') && (
            <Link to="/user-activity" className={`nav-item ${activePage === 'user-activity' ? 'active' : ''}`}>
              <span className="nav-icon"><Icons.Employees /></span>
              <span>User Activity</span>
            </Link>
          )}

          <Link to="/screenshots" className={`nav-item ${activePage === 'screenshots' ? 'active' : ''}`}>
            <span className="nav-icon"><Icons.Screenshots /></span>
            <span>Screenshots</span>
          </Link>

          <Link to="/analytics" className={`nav-item ${activePage === 'analytics' ? 'active' : ''}`}>
            <span className="nav-icon"><Icons.Analytics /></span>
            <span>Analytics</span>
          </Link>

          <Link to="/attendance-logs" className={`nav-item ${activePage === 'attendance-logs' ? 'active' : ''}`}>
            <span className="nav-icon"><Icons.Attendance /></span>
            <span>Attendance</span>
          </Link>

          {(user.role === 'admin' || user.role === 'team_manager') && (
            <Link to="/teams" className={`nav-item ${activePage === 'teams' ? 'active' : ''}`}>
              <span className="nav-icon"><Icons.Teams /></span>
              <span>Teams</span>
            </Link>
          )}

          {user.role === 'admin' && (
            <Link to="/users" className={`nav-item ${activePage === 'users' ? 'active' : ''}`}>
              <span className="nav-icon"><Icons.Reports /></span>
              <span>Reports</span>
            </Link>
          )}

          <Link to="/profile" className={`nav-item ${activePage === 'profile' ? 'active' : ''}`}>
            <span className="nav-icon"><Icons.Settings /></span>
            <span>Settings</span>
          </Link>
        </div>
      </nav>

      <div className="sidebar-footer">
        <Link to="/profile" className="user-info-link">
          <div className="user-info">
            <div className="user-avatar">
              {user.fullName?.charAt(0).toUpperCase()}
            </div>
            <div className="user-details">
              <strong>{user.fullName}</strong>
              <small>{user.role?.replace('_', ' ')}</small>
            </div>
          </div>
        </Link>
        <button className="logout-btn" onClick={handleLogout}>
          <Icons.LogOut />
          <span>Log out</span>
        </button>
      </div>
    </div>
  );
}

export default Sidebar;
