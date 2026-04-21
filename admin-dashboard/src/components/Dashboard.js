import React, { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import { formatDistanceToNow } from 'date-fns';
import Sidebar from './Sidebar';
import { getStatusLabel, getStatusClassName, getStatusColor } from '../utils/statusHelpers';
import './Dashboard.css';

const API_URL = process.env.REACT_APP_API_URL || '';

function Dashboard({ user, onLogout }) {
  const [presence, setPresence] = useState({ online: 0, idle: 0, offline: 0, total_users: 0 });
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const fetchDashboardData = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      const headers = { Authorization: `Bearer ${token}` };

      const requests = [
        axios.get(`${API_URL}/api/presence/summary`, { headers }),
        axios.get(`${API_URL}/api/presence/online`, { headers })
      ];

      const [presenceRes, employeesRes] = await Promise.all(requests);

      if (presenceRes.data.success) setPresence(presenceRes.data.data);
      if (employeesRes.data.success) setEmployees(employeesRes.data.data);
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboardData();
    const interval = setInterval(() => {
      if (!document.hidden) fetchDashboardData();
    }, 60000);
    const onVisible = () => { if (!document.hidden) fetchDashboardData(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', onVisible); };
  }, [fetchDashboardData]);

  const getStatusBadge = (status) => (
    <span className={`status-badge ${getStatusClassName(status)}`}>{getStatusLabel(status)}</span>
  );

  const filteredEmployees = useMemo(() =>
    employees.filter(emp => {
      const matchesSearch = emp.full_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        emp.email?.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesStatus = statusFilter === 'all' || emp.effective_status === statusFilter;
      return matchesSearch && matchesStatus;
    }),
    [employees, searchTerm, statusFilter]
  );

  const statusCounts = useMemo(() => {
    // Presence API returns effective_status ∈ {online, idle, offline, logged_out}
    // (presence.js EFFECTIVE_STATUS_SQL). The UI labels 'offline' as "Disconnected"
    // but the key here must be 'offline' or counts/filtering break. Sessions API
    // uses 'disconnected' for the same concept — don't confuse the two.
    const counts = { all: employees.length, online: 0, idle: 0, offline: 0, logged_out: 0 };
    employees.forEach(emp => {
      const s = emp.effective_status;
      if (counts[s] !== undefined) counts[s]++;
    });
    return counts;
  }, [employees]);

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
          <div>
            <h1>Dashboard</h1>
            <p className="content-subtitle">Monitor your team's activity in real-time</p>
          </div>
          <div className="header-right">
            <div className="search-box">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/>
              </svg>
              <input
                type="text"
                placeholder="Search employees..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <div className="header-avatar">
              {user.fullName?.charAt(0).toUpperCase()}
            </div>
          </div>
        </div>

        <div className="dash-stats-grid">
          <div className="dash-stat-card dark">
            <div className="dash-stat-content">
              <div className="dash-stat-label">Total Employees</div>
              <div className="dash-stat-value">{presence.total_users}</div>
              <div className="dash-stat-sub">
                <span className="dash-stat-change positive">+{presence.online + presence.idle} tracked</span>
              </div>
            </div>
            <div className="dash-stat-icon teal">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            </div>
          </div>

          <div className="dash-stat-card dark">
            <div className="dash-stat-content">
              <div className="dash-stat-label">Active Now</div>
              <div className="dash-stat-value">{presence.online}</div>
              <div className="dash-stat-sub">
                {presence.total_users > 0
                  ? `${Math.round((presence.online / presence.total_users) * 100)}% of team online`
                  : '0% of team online'}
              </div>
            </div>
            <div className="dash-stat-icon green">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            </div>
          </div>

          <div className="dash-stat-card dark">
            <div className="dash-stat-content">
              <div className="dash-stat-label">Idle</div>
              <div className="dash-stat-value">{presence.idle}</div>
              <div className="dash-stat-sub">
                {presence.idle > 0 ? `${presence.idle} user${presence.idle !== 1 ? 's' : ''}` : 'None idle'}
              </div>
            </div>
            <div className="dash-stat-icon amber">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>
            </div>
          </div>
        </div>

        <div className="dash-section">
          <div className="dash-section-header">
            <h2>Employees</h2>
            <div className="dash-section-actions">
              <button className="dash-btn outline" onClick={fetchDashboardData}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                Refresh
              </button>
            </div>
          </div>

          <div className="dash-filter-tabs">
            {[
              { key: 'all', label: 'All' },
              { key: 'online', label: 'Active' },
              { key: 'idle', label: 'Idle' },
              { key: 'offline', label: 'Disconnected' },
              { key: 'logged_out', label: 'Logged Out' }
            ].map(tab => (
              <button
                key={tab.key}
                className={`dash-filter-tab ${statusFilter === tab.key ? 'active' : ''}`}
                onClick={() => setStatusFilter(tab.key)}
              >
                {tab.label} <span className="dash-filter-count">({statusCounts[tab.key] ?? 0})</span>
              </button>
            ))}
          </div>

          <div className="dash-table-container">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Status</th>
                  <th>Last Seen</th>
                </tr>
              </thead>
              <tbody>
                {filteredEmployees.length === 0 ? (
                  <tr><td colSpan="3" className="dash-empty">No employees found</td></tr>
                ) : (
                  filteredEmployees.map((emp) => (
                    <tr key={emp.user_id}>
                      <td>
                        <div className="emp-info">
                          <div className="emp-avatar" style={{ background: getStatusColor(emp.effective_status) }}>
                            {emp.full_name?.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <div className="emp-name">{emp.full_name}</div>
                            <div className="emp-email">{emp.email}</div>
                          </div>
                        </div>
                      </td>
                      <td>{getStatusBadge(emp.effective_status)}</td>
                      <td className="emp-lastseen">
                        {emp.last_heartbeat
                          ? formatDistanceToNow(new Date(emp.last_heartbeat), { addSuffix: true })
                          : '--'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Dashboard;
