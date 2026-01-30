import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { format } from 'date-fns';
import Sidebar from './Sidebar';
import './Dashboard.css';

const API_URL = process.env.REACT_APP_API_URL || '';

function Dashboard({ user, onLogout }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');

      const statsResponse = await axios.get(`${API_URL}/api/screenshots/stats/summary`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (statsResponse.data.success) {
        setStats(statsResponse.data.data);
      }
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="app-layout">
        <Sidebar user={user} onLogout={onLogout} activePage="dashboard" />
        <div className="main-content">
          <div className="loading">Loading dashboard...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-layout">
      <Sidebar user={user} onLogout={onLogout} activePage="dashboard" />

      <div className="main-content">
        <div className="content-header">
          <h1>Dashboard</h1>
          <p>Welcome back, {user.fullName}</p>
        </div>

        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-icon">📸</div>
            <div className="stat-info">
              <div className="stat-value">{stats?.total_screenshots || 0}</div>
              <div className="stat-label">Total Screenshots</div>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon">⚠️</div>
            <div className="stat-info">
              <div className="stat-value">{stats?.flagged_screenshots || 0}</div>
              <div className="stat-label">Flagged Screenshots</div>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon">👥</div>
            <div className="stat-info">
              <div className="stat-value">{stats?.active_users || 0}</div>
              <div className="stat-label">Active Users</div>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon">✓</div>
            <div className="stat-info">
              <div className="stat-value">
                {stats?.total_screenshots && stats?.flagged_screenshots
                  ? Math.round(((stats.total_screenshots - stats.flagged_screenshots) / stats.total_screenshots) * 100)
                  : 100}%
              </div>
              <div className="stat-label">Compliance Rate</div>
            </div>
          </div>
        </div>

        <div className="section">
          <h2>System Information</h2>
          <div className="info-grid">
            <div className="info-item">
              <span className="info-label">Your Role:</span>
              <span className="info-value">{user.role}</span>
            </div>
            <div className="info-item">
              <span className="info-label">Email:</span>
              <span className="info-value">{user.email}</span>
            </div>
            {stats?.first_screenshot && (
              <div className="info-item">
                <span className="info-label">First Activity:</span>
                <span className="info-value">
                  {format(new Date(stats.first_screenshot), 'PPpp')}
                </span>
              </div>
            )}
            {stats?.last_screenshot && (
              <div className="info-item">
                <span className="info-label">Last Activity:</span>
                <span className="info-value">
                  {format(new Date(stats.last_screenshot), 'PPpp')}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default Dashboard;
