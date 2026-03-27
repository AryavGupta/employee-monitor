import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { format, startOfDay, endOfDay } from 'date-fns';
import Sidebar from './Sidebar';
import './UserActivity.css';

const API_URL = process.env.REACT_APP_API_URL || '';

function UserActivity({ user, onLogout }) {
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [activitySummary, setActivitySummary] = useState({}); // Map of userId -> { activeSeconds, idleSeconds }
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [selectedUserId, setSelectedUserId] = useState('');

  const fetchUsers = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_URL}/api/users`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.data.success) {
        setUsers(response.data.data);
      }
    } catch (error) {
      console.error('Error fetching users:', error);
    }
  }, []);

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const headers = { Authorization: `Bearer ${token}` };
      const params = new URLSearchParams();
      // API expects startDate/endDate, not date
      const startDate = startOfDay(new Date(selectedDate)).toISOString();
      const endDate = endOfDay(new Date(selectedDate)).toISOString();
      params.append('startDate', startDate);
      params.append('endDate', endDate);
      if (selectedUserId) params.append('userId', selectedUserId);

      // Fetch sessions and activity summary in parallel
      const [sessionsRes, activityRes] = await Promise.all([
        axios.get(`${API_URL}/api/sessions?${params}`, { headers }),
        // Fetch actual tracked time from activity_logs for accurate uptime
        axios.get(`${API_URL}/api/reports/dashboard-summary?startDate=${startDate}&endDate=${endDate}${selectedUserId ? `&userId=${selectedUserId}` : ''}`, { headers })
      ]);

      if (sessionsRes.data.success) {
        setSessions(sessionsRes.data.data || []);
      }

      // Store activity summary for accurate uptime calculation
      if (activityRes.data.success) {
        const data = activityRes.data.data;
        // Convert hours to seconds for consistency
        setActivitySummary({
          totalActiveSeconds: Math.round((data.active_time_hours || 0) * 3600),
          totalIdleSeconds: Math.round((data.idle_time_hours || 0) * 3600),
          totalSeconds: Math.round(((data.active_time_hours || 0) + (data.idle_time_hours || 0)) * 3600)
        });
      }
    } catch (error) {
      console.error('Error fetching sessions:', error);
      setSessions([]);
      setActivitySummary({});
    } finally {
      setLoading(false);
    }
  }, [selectedDate, selectedUserId]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  useEffect(() => {
    fetchSessions();

    // Auto-refresh every 30 seconds to detect status changes (Active → Disconnected)
    const refreshInterval = setInterval(fetchSessions, 30000);
    return () => clearInterval(refreshInterval);
  }, [fetchSessions]);

  // Calculate uptime for a single session
  // Uses actual tracked time (duration_seconds or active_seconds + idle_seconds) instead of wall-clock time
  // This prevents inflated uptime during system sleep
  const calculateUptime = (session) => {
    if (!session || !session.start_time) return '-';

    // For closed sessions: prefer actual tracked duration
    if (session.end_time) {
      // Use tracked duration if available (set by desktop app)
      if (session.duration_seconds != null && session.duration_seconds > 0) {
        const hours = Math.floor(session.duration_seconds / 3600);
        const minutes = Math.floor((session.duration_seconds % 3600) / 60);
        return `${hours}h ${minutes}m`;
      }
      // Fallback to wall-clock time for legacy sessions
      const diffMs = new Date(session.end_time) - new Date(session.start_time);
      const hours = Math.floor(diffMs / (1000 * 60 * 60));
      const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
      return `${hours}h ${minutes}m`;
    }

    // For open (active) sessions: show "Active" indicator
    // The total uptime is calculated from activity_logs, not wall-clock time
    return 'Active';
  };

  // Calculate total uptime from actual activity data
  // Uses activity_logs summary for accuracy (same as Analytics page)
  const getTotalUptime = () => {
    // Use activity summary from activity_logs (accurate tracked time)
    if (activitySummary.totalSeconds > 0) {
      const hours = Math.floor(activitySummary.totalSeconds / 3600);
      const minutes = Math.floor((activitySummary.totalSeconds % 3600) / 60);
      return `${hours}h ${minutes}m`;
    }

    // Fallback: sum duration_seconds from closed sessions only
    let totalSeconds = 0;
    sessions.forEach(session => {
      if (session.end_time && session.duration_seconds) {
        totalSeconds += session.duration_seconds;
      }
    });

    if (totalSeconds === 0) {
      return '0h 0m';
    }

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  };

  const getActiveUsers = () => {
    return new Set(sessions.filter(s => s.effective_status === 'active' || s.effective_status === 'idle').map(s => s.user_id)).size;
  };

  // Format idle seconds into human-readable string
  const formatIdleTime = (seconds) => {
    if (!seconds || seconds < 10) return null;
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins < 60) return `${mins}m ${secs}s`;
    const hrs = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `${hrs}h ${remainMins}m`;
  };

  // Get status badge info based on effective_status from server
  const getSessionStatus = (session) => {
    const status = session.effective_status || (session.end_time ? 'logged_out' : 'active');
    switch (status) {
      case 'active':
        return { label: 'Active', className: 'online', idle: null };
      case 'idle':
        return { label: 'Idle', className: 'idle', idle: formatIdleTime(session.idle_seconds) };
      case 'disconnected':
        return { label: 'Disconnected', className: 'disconnected', idle: null };
      case 'logged_out':
      default:
        return { label: 'Logged Out', className: 'offline', idle: null };
    }
  };

  if (user.role !== 'admin' && user.role !== 'team_manager') {
    return (
      <div className="app-layout">
        <Sidebar user={user} onLogout={onLogout} activePage="user-activity" />
        <div className="main-content">
          <div className="access-denied">
            <h2>Access Denied</h2>
            <p>Only administrators and team managers can access User Activity.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-layout">
      <Sidebar user={user} onLogout={onLogout} activePage="user-activity" />

      <div className="main-content">
        <div className="content-header">
          <div>
            <h1>User Activity</h1>
            <p>Track employee login/logout times and work hours</p>
          </div>
        </div>

        {/* Stats Summary */}
        <div className="activity-stats">
          <div className="activity-stat">
            <span className="stat-value">{sessions.length}</span>
            <span className="stat-label">Total Sessions</span>
          </div>
          <div className="activity-stat active">
            <span className="stat-value">{getActiveUsers()}</span>
            <span className="stat-label">Currently Active</span>
          </div>
          <div className="activity-stat">
            <span className="stat-value">{getTotalUptime()}</span>
            <span className="stat-label">Total Uptime</span>
          </div>
        </div>

        {/* Filters */}
        <div className="activity-filters">
          <div className="filter-group">
            <label>Date</label>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
            />
          </div>

          <div className="filter-group">
            <label>Employee</label>
            <select
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value)}
            >
              <option value="">All Employees</option>
              {users.map(u => (
                <option key={u.id} value={u.id}>{u.full_name}</option>
              ))}
            </select>
          </div>

          <button className="refresh-btn" onClick={fetchSessions}>
            Refresh
          </button>
        </div>

        {/* Sessions Table */}
        <div className="sessions-container">
          {loading ? (
            <div className="loading">Loading sessions...</div>
          ) : sessions.length === 0 ? (
            <div className="no-data">No sessions found for the selected date</div>
          ) : (
            <table className="sessions-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Login Time</th>
                  <th>Logout Time</th>
                  <th>Uptime</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map(session => (
                  <tr key={session.id}>
                    <td>
                      <div className="employee-cell">
                        <strong>{session.full_name}</strong>
                        <span>{session.email}</span>
                      </div>
                    </td>
                    <td>
                      {session.start_time
                        ? format(new Date(session.start_time), 'hh:mm a')
                        : '-'}
                    </td>
                    <td>
                      {session.end_time
                        ? format(new Date(session.end_time), 'hh:mm a')
                        : '-'}
                    </td>
                    <td className="uptime-cell">
                      {calculateUptime(session)}
                    </td>
                    <td>
                      {(() => {
                        const statusInfo = getSessionStatus(session);
                        return (
                          <div>
                            <span className={`status-badge ${statusInfo.className}`}>
                              {statusInfo.label}
                            </span>
                            {statusInfo.idle && (
                              <span className="idle-duration" style={{ marginLeft: '6px', fontSize: '0.85em', color: '#f59e0b' }}>
                                ({statusInfo.idle})
                              </span>
                            )}
                            {session.effective_status === 'disconnected' && session.last_heartbeat && (
                              <div style={{ fontSize: '0.8em', color: '#9ca3af', marginTop: '2px' }}>
                                Last seen: {format(new Date(session.last_heartbeat), 'hh:mm a')}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

export default UserActivity;
