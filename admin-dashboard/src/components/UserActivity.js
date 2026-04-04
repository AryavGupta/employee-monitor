import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { format, startOfDay, endOfDay } from 'date-fns';
import Sidebar from './Sidebar';
import { useUsers } from '../hooks/useUsers';
import './UserActivity.css';

const API_URL = process.env.REACT_APP_API_URL || '';

function UserActivity({ user, onLogout }) {
  const [loading, setLoading] = useState(true);
  const { users } = useUsers();
  const [sessions, setSessions] = useState([]);
  const [activitySummary, setActivitySummary] = useState({});
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [selectedUserId, setSelectedUserId] = useState('');

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const headers = { Authorization: `Bearer ${token}` };
      const startDate = startOfDay(new Date(selectedDate)).toISOString();
      const endDate = endOfDay(new Date(selectedDate)).toISOString();
      const params = new URLSearchParams();
      params.append('startDate', startDate);
      params.append('endDate', endDate);
      if (selectedUserId) params.append('userId', selectedUserId);

      const [sessionsRes, activityRes] = await Promise.all([
        axios.get(`${API_URL}/api/sessions?${params}`, { headers }),
        axios.get(`${API_URL}/api/reports/dashboard-summary?startDate=${startDate}&endDate=${endDate}${selectedUserId ? `&userId=${selectedUserId}` : ''}`, { headers })
      ]);

      if (sessionsRes.data.success) {
        setSessions(sessionsRes.data.data || []);
      }

      if (activityRes.data.success) {
        const data = activityRes.data.data;
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
    fetchSessions();
    const refreshInterval = setInterval(fetchSessions, 30000);
    return () => clearInterval(refreshInterval);
  }, [fetchSessions]);

  const calculateUptime = (session) => {
    if (!session?.start_time) return '--';
    if (session.end_time) {
      if (session.duration_seconds > 0) {
        const h = Math.floor(session.duration_seconds / 3600);
        const m = Math.floor((session.duration_seconds % 3600) / 60);
        return `${h}h ${m}m`;
      }
      const diffMs = new Date(session.end_time) - new Date(session.start_time);
      const h = Math.floor(diffMs / 3600000);
      const m = Math.floor((diffMs % 3600000) / 60000);
      return `${h}h ${m}m`;
    }
    return 'Active';
  };

  const formatSeconds = (secs) => {
    if (!secs || secs <= 0) return '0h 0m';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return `${h}h ${m}m`;
  };

  const getTotalUptime = () => formatSeconds(activitySummary.totalSeconds);
  const getActiveTime = () => formatSeconds(activitySummary.totalActiveSeconds);
  const getIdleTime = () => formatSeconds(activitySummary.totalIdleSeconds);

  const getActiveUsers = () => {
    return new Set(sessions.filter(s => s.effective_status === 'active' || s.effective_status === 'idle').map(s => s.user_id)).size;
  };

  const formatIdleTime = (seconds) => {
    if (!seconds || seconds < 10) return null;
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  };

  const getSessionStatus = (session) => {
    const status = session.effective_status || (session.end_time ? 'logged_out' : 'active');
    switch (status) {
      case 'active': return { label: 'Active', className: 'badge-active' };
      case 'idle': return { label: 'Idle', className: 'badge-idle', idle: formatIdleTime(session.idle_seconds) };
      case 'disconnected': return { label: 'Disconnected', className: 'badge-disconnected' };
      default: return { label: 'Logged Out', className: 'badge-offline' };
    }
  };

  if (user.role !== 'admin' && user.role !== 'team_manager') {
    return (
      <div className="app-layout">
        <Sidebar user={user} onLogout={onLogout} activePage="user-activity" />
        <div className="main-content">
          <div className="ua-empty">
            <h2>Access Denied</h2>
            <p>Only administrators and team managers can view this page.</p>
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
            <p className="content-subtitle">Track employee sessions, uptime, and activity</p>
          </div>
        </div>

        {/* Dark Stat Cards */}
        <div className="ua-stats-grid">
          <div className="ua-stat-card dark">
            <div className="ua-stat-content">
              <div className="ua-stat-label">Total Sessions</div>
              <div className="ua-stat-value">{sessions.length}</div>
            </div>
            <div className="ua-stat-icon teal">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>
            </div>
          </div>

          <div className="ua-stat-card dark">
            <div className="ua-stat-content">
              <div className="ua-stat-label">Currently Active</div>
              <div className="ua-stat-value">{getActiveUsers()}</div>
            </div>
            <div className="ua-stat-icon green">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>
            </div>
          </div>

          <div className="ua-stat-card dark">
            <div className="ua-stat-content">
              <div className="ua-stat-label">Active Time</div>
              <div className="ua-stat-value">{getActiveTime()}</div>
            </div>
            <div className="ua-stat-icon blue">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            </div>
          </div>

          <div className="ua-stat-card dark">
            <div className="ua-stat-content">
              <div className="ua-stat-label">Total Uptime</div>
              <div className="ua-stat-value">{getTotalUptime()}</div>
            </div>
            <div className="ua-stat-icon amber">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="ua-filters">
          <div className="ua-filter-group">
            <label>Date</label>
            <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} />
          </div>
          <div className="ua-filter-group">
            <label>Employee</label>
            <select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)}>
              <option value="">All Employees</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          </div>
          <button className="ua-refresh-btn" onClick={fetchSessions}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Refresh
          </button>
        </div>

        {/* Sessions Table */}
        <div className="ua-section">
          <div className="ua-section-header">
            <h2>Sessions</h2>
            <span className="ua-count">{sessions.length} records</span>
          </div>

          <div className="ua-table-container">
            {loading ? (
              <div className="ua-empty">Loading sessions...</div>
            ) : sessions.length === 0 ? (
              <div className="ua-empty">No sessions found for the selected date</div>
            ) : (
              <table className="ua-table">
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
                  {sessions.map(session => {
                    const statusInfo = getSessionStatus(session);
                    return (
                      <tr key={session.id}>
                        <td>
                          <div className="ua-emp-info">
                            <div className="ua-emp-avatar" style={{
                              background: session.effective_status === 'active' ? '#10b981'
                                : session.effective_status === 'idle' ? '#f59e0b' : '#94a3b8'
                            }}>
                              {session.full_name?.charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <div className="ua-emp-name">{session.full_name}</div>
                              <div className="ua-emp-email">{session.email}</div>
                            </div>
                          </div>
                        </td>
                        <td>{session.start_time ? format(new Date(session.start_time), 'hh:mm a') : '--'}</td>
                        <td>{session.end_time ? format(new Date(session.end_time), 'hh:mm a') : '--'}</td>
                        <td className="ua-uptime">{calculateUptime(session)}</td>
                        <td>
                          <span className={`ua-badge ${statusInfo.className}`}>
                            {statusInfo.label}
                          </span>
                          {statusInfo.idle && (
                            <span className="ua-idle-hint">({statusInfo.idle})</span>
                          )}
                          {session.effective_status === 'disconnected' && session.last_heartbeat && (
                            <div className="ua-lastseen">
                              Last seen: {format(new Date(session.last_heartbeat), 'hh:mm a')}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default UserActivity;
