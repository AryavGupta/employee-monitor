import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import './Sidebar.css';

// Icon components (Lucide-style)
const Icons = {
  Logo: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/>
      <path d="m9 12 2 2 4-4"/>
    </svg>
  ),
  Home: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  ),
  BarChart: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" x2="12" y1="20" y2="10"/>
      <line x1="18" x2="18" y1="20" y2="4"/>
      <line x1="6" x2="6" y1="20" y2="16"/>
    </svg>
  ),
  Camera: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/>
      <circle cx="12" cy="13" r="3"/>
    </svg>
  ),
  Clock: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
  ),
  Building: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="16" height="20" x="4" y="2" rx="2" ry="2"/>
      <path d="M9 22v-4h6v4"/>
      <path d="M8 6h.01"/>
      <path d="M16 6h.01"/>
      <path d="M12 6h.01"/>
      <path d="M12 10h.01"/>
      <path d="M12 14h.01"/>
      <path d="M16 10h.01"/>
      <path d="M16 14h.01"/>
      <path d="M8 10h.01"/>
      <path d="M8 14h.01"/>
    </svg>
  ),
  Bot: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 8V4H8"/>
      <rect width="16" height="12" x="4" y="8" rx="2"/>
      <path d="M2 14h2"/>
      <path d="M20 14h2"/>
      <path d="M15 13v2"/>
      <path d="M9 13v2"/>
    </svg>
  ),
  Users: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  ),
  User: () => (
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
            <Icons.Logo />
          </div>
          <h2>Employee Monitor</h2>
        </div>
        <p className="version">v1.0.0</p>
      </div>

      <nav className="sidebar-nav">
        <div className="nav-section">
          <div className="nav-section-label">Overview</div>
          <Link
            to="/dashboard"
            className={`nav-item ${activePage === 'dashboard' ? 'active' : ''}`}
          >
            <span className="nav-icon"><Icons.Home /></span>
            <span>Dashboard</span>
          </Link>

          <Link
            to="/analytics"
            className={`nav-item ${activePage === 'analytics' ? 'active' : ''}`}
          >
            <span className="nav-icon"><Icons.BarChart /></span>
            <span>Analytics</span>
          </Link>

          <Link
            to="/screenshots"
            className={`nav-item ${activePage === 'screenshots' ? 'active' : ''}`}
          >
            <span className="nav-icon"><Icons.Camera /></span>
            <span>Screenshots</span>
          </Link>
        </div>

        {/* Admin and Team Manager sections */}
        {(user.role === 'admin' || user.role === 'team_manager') && (
          <div className="nav-section">
            <div className="nav-section-label">Management</div>
            <Link
              to="/user-activity"
              className={`nav-item ${activePage === 'user-activity' ? 'active' : ''}`}
            >
              <span className="nav-icon"><Icons.Clock /></span>
              <span>User Activity</span>
            </Link>

            <Link
              to="/teams"
              className={`nav-item ${activePage === 'teams' ? 'active' : ''}`}
            >
              <span className="nav-icon"><Icons.Building /></span>
              <span>Teams</span>
            </Link>
          </div>
        )}

        {/* Admin only section */}
        {user.role === 'admin' && (
          <div className="nav-section">
            <div className="nav-section-label">Administration</div>
            <Link
              to="/users"
              className={`nav-item ${activePage === 'users' ? 'active' : ''}`}
            >
              <span className="nav-icon"><Icons.Users /></span>
              <span>Users</span>
            </Link>
          </div>
        )}

        <div className="nav-divider"></div>

        <Link
          to="/profile"
          className={`nav-item ${activePage === 'profile' ? 'active' : ''}`}
        >
          <span className="nav-icon"><Icons.User /></span>
          <span>My Profile</span>
        </Link>
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
