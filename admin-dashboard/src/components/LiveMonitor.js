import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { format, formatDistanceToNow } from 'date-fns';
import Sidebar from './Sidebar';
import './LiveMonitor.css';

const API_URL = process.env.REACT_APP_API_URL || '';

function LiveMonitor({ user, onLogout }) {
  const [loading, setLoading] = useState(true);
  const [presenceSummary, setPresenceSummary] = useState({ online: 0, idle: 0, offline: 0, total_users: 0 });
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [activityFeed, setActivityFeed] = useState([]);
  const [recentScreenshots, setRecentScreenshots] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(10); // seconds
  const lastActivityTimestamp = useRef(null);

  const fetchData = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      const headers = { Authorization: `Bearer ${token}` };

      const [summaryRes, usersRes, activityRes, screenshotsRes] = await Promise.all([
        axios.get(`${API_URL}/api/presence/summary`, { headers }),
        axios.get(`${API_URL}/api/presence/online`, { headers }),
        axios.get(`${API_URL}/api/presence/activity-feed?limit=30${lastActivityTimestamp.current ? `&since=${lastActivityTimestamp.current}` : ''}`, { headers }),
        axios.get(`${API_URL}/api/presence/recent-screenshots?limit=12`, { headers })
      ]);

      if (summaryRes.data.success) {
        setPresenceSummary(summaryRes.data.data);
      }

      if (usersRes.data.success) {
        setOnlineUsers(usersRes.data.data);
      }

      if (activityRes.data.success && activityRes.data.data.length > 0) {
        // Merge new activities with existing ones, keeping most recent
        setActivityFeed(prev => {
          const newActivities = activityRes.data.data;
          if (lastActivityTimestamp.current) {
            // Append new activities to the top
            const merged = [...newActivities, ...prev].slice(0, 100);
            return merged;
          }
          return newActivities;
        });
        // Update timestamp for next fetch
        lastActivityTimestamp.current = activityRes.data.data[0]?.timestamp;
      }

      if (screenshotsRes.data.success) {
        setRecentScreenshots(screenshotsRes.data.data);
      }

    } catch (error) {
      console.error('Error fetching live data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();

    let interval;
    if (autoRefresh) {
      interval = setInterval(fetchData, refreshInterval * 1000);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [fetchData, autoRefresh, refreshInterval]);

  const getStatusColor = (status) => {
    switch (status) {
      case 'online': return '#22c55e';
      case 'idle': return '#f59e0b';
      case 'offline': return '#6b7280';
      default: return '#6b7280';
    }
  };

  const getStatusIcon = (status) => {
    switch (status) {
      case 'online': return '🟢';
      case 'idle': return '🟡';
      case 'offline': return '⚫';
      default: return '⚫';
    }
  };

  const getActivityIcon = (activity) => {
    if (activity.is_blocked_attempt) return '🚫';
    if (activity.is_idle) return '💤';
    if (activity.activity_type === 'screenshot') return '📸';
    return '💻';
  };

  if (user.role !== 'admin' && user.role !== 'team_manager') {
    return (
      <div className="app-layout">
        <Sidebar user={user} onLogout={onLogout} activePage="live" />
        <div className="main-content">
          <div className="access-denied">
            <h2>Access Denied</h2>
            <p>Only administrators and team managers can access the Live Monitor.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-layout">
      <Sidebar user={user} onLogout={onLogout} activePage="live" />

      <div className="main-content">
        <div className="content-header">
          <div>
            <h1>Live Monitor</h1>
            <p>Real-time employee activity tracking</p>
          </div>
          <div className="header-controls">
            <label className="auto-refresh-toggle">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              Auto-refresh
            </label>
            <select
              value={refreshInterval}
              onChange={(e) => setRefreshInterval(parseInt(e.target.value))}
              disabled={!autoRefresh}
            >
              <option value="5">5 sec</option>
              <option value="10">10 sec</option>
              <option value="30">30 sec</option>
              <option value="60">1 min</option>
            </select>
            <button className="refresh-btn" onClick={fetchData}>
              Refresh Now
            </button>
          </div>
        </div>

        {loading ? (
          <div className="loading">Loading live data...</div>
        ) : (
          <>
            {/* Presence Summary */}
            <div className="presence-summary">
              <div className="presence-stat online">
                <span className="presence-icon">🟢</span>
                <div className="presence-info">
                  <span className="presence-count">{presenceSummary.online}</span>
                  <span className="presence-label">Online</span>
                </div>
              </div>
              <div className="presence-stat idle">
                <span className="presence-icon">🟡</span>
                <div className="presence-info">
                  <span className="presence-count">{presenceSummary.idle}</span>
                  <span className="presence-label">Idle</span>
                </div>
              </div>
              <div className="presence-stat offline">
                <span className="presence-icon">⚫</span>
                <div className="presence-info">
                  <span className="presence-count">{presenceSummary.offline}</span>
                  <span className="presence-label">Offline</span>
                </div>
              </div>
              <div className="presence-stat total">
                <span className="presence-icon">👥</span>
                <div className="presence-info">
                  <span className="presence-count">{presenceSummary.total_users}</span>
                  <span className="presence-label">Total Users</span>
                </div>
              </div>
            </div>

            <div className="live-grid">
              {/* Online Users Panel */}
              <div className="live-panel users-panel">
                <h3>Active Users</h3>
                <div className="users-list">
                  {onlineUsers.length === 0 ? (
                    <div className="empty-state">No users online</div>
                  ) : (
                    onlineUsers.map(u => (
                      <div
                        key={u.user_id}
                        className={`user-card ${selectedUser === u.user_id ? 'selected' : ''}`}
                        onClick={() => setSelectedUser(selectedUser === u.user_id ? null : u.user_id)}
                      >
                        <div className="user-status">
                          <span
                            className="status-dot"
                            style={{ backgroundColor: getStatusColor(u.effective_status) }}
                          />
                        </div>
                        <div className="user-info">
                          <strong>{u.full_name}</strong>
                          <span className="user-email">{u.email}</span>
                          {u.team_name && <span className="user-team">{u.team_name}</span>}
                        </div>
                        <div className="user-activity">
                          {u.current_application && (
                            <span className="current-app" title={u.current_window_title}>
                              {u.current_application}
                            </span>
                          )}
                          <span className="last-seen">
                            {formatDistanceToNow(new Date(u.last_heartbeat), { addSuffix: true })}
                          </span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Activity Feed Panel */}
              <div className="live-panel activity-panel">
                <h3>Activity Feed</h3>
                <div className="activity-feed">
                  {activityFeed.length === 0 ? (
                    <div className="empty-state">No recent activity</div>
                  ) : (
                    activityFeed
                      .filter(a => !selectedUser || a.user_id === selectedUser)
                      .map(activity => (
                        <div
                          key={activity.id}
                          className={`activity-item ${activity.is_blocked_attempt ? 'blocked' : ''} ${activity.is_idle ? 'idle' : ''}`}
                        >
                          <span className="activity-icon">{getActivityIcon(activity)}</span>
                          <div className="activity-content">
                            <div className="activity-header">
                              <strong>{activity.full_name}</strong>
                              <span className="activity-time">
                                {format(new Date(activity.timestamp), 'HH:mm:ss')}
                              </span>
                            </div>
                            <div className="activity-details">
                              {activity.is_blocked_attempt ? (
                                <span className="blocked-site">Attempted to access: {activity.domain || activity.url}</span>
                              ) : activity.is_idle ? (
                                <span className="idle-status">Went idle</span>
                              ) : (
                                <>
                                  <span className="app-name">{activity.application_name || 'Unknown'}</span>
                                  {activity.window_title && (
                                    <span className="window-title" title={activity.window_title}>
                                      {activity.window_title.substring(0, 50)}...
                                    </span>
                                  )}
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      ))
                  )}
                </div>
              </div>

              {/* Recent Screenshots Panel */}
              <div className="live-panel screenshots-panel">
                <h3>Recent Screenshots</h3>
                <div className="screenshots-grid">
                  {recentScreenshots.length === 0 ? (
                    <div className="empty-state">No recent screenshots</div>
                  ) : (
                    recentScreenshots
                      .filter(s => !selectedUser || s.user_id === selectedUser)
                      .map(screenshot => (
                        <div key={screenshot.id} className="screenshot-thumb">
                          <img
                            src={screenshot.screenshot_url.startsWith('data:')
                              ? screenshot.screenshot_url
                              : `${API_URL}${screenshot.screenshot_url}`}
                            alt={`Screenshot by ${screenshot.full_name}`}
                          />
                          <div className="screenshot-overlay">
                            <span className="screenshot-user">{screenshot.full_name}</span>
                            <span className="screenshot-time">
                              {format(new Date(screenshot.captured_at), 'HH:mm')}
                            </span>
                          </div>
                          {screenshot.is_flagged && <span className="flag-badge">⚠️</span>}
                        </div>
                      ))
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default LiveMonitor;
