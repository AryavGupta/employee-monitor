import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { format } from 'date-fns';
import Sidebar from './Sidebar';
import './EmployeeSummary.css';

const API_URL = process.env.REACT_APP_API_URL || '';

function EmployeeSummary({ user, onLogout }) {
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [roleFilter, setRoleFilter] = useState('all');
  const [summaries, setSummaries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(new Set());

  const fetchSummaries = useCallback(async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get(`${API_URL}/api/ai-analysis/employee-summary?date=${date}&role=${roleFilter}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.data.success) setSummaries(res.data.data);
    } catch (err) {
      console.error('Failed to fetch summaries:', err);
    } finally {
      setLoading(false);
    }
  }, [date, roleFilter]);

  useEffect(() => { fetchSummaries(); }, [fetchSummaries]);

  const triggerAnalysis = async (userId) => {
    setAnalyzing(prev => new Set(prev).add(userId));
    try {
      const token = localStorage.getItem('token');
      await axios.post(`${API_URL}/api/ai-analysis/analyze`, { userId, date }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      await fetchSummaries();
    } catch (err) {
      alert('Analysis failed: ' + (err.response?.data?.message || err.message));
    } finally {
      setAnalyzing(prev => { const n = new Set(prev); n.delete(userId); return n; });
    }
  };

  const analyzeAll = async () => {
    const toAnalyze = summaries.filter(s => !s.ai_summary && s.screenshot_count > 0);
    for (const emp of toAnalyze) {
      await triggerAnalysis(emp.user_id);
    }
  };

  const formatTime = (seconds) => {
    if (!seconds) return '0h 0m';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  };

  const getActivityPercent = (active, total) => {
    if (!total) return 0;
    return Math.round((active / total) * 100);
  };

  if (user.role === 'employee') {
    return (
      <div className="app-layout">
        <Sidebar user={user} onLogout={onLogout} activePage="employee-summary" />
        <div className="main-content">
          <div className="access-denied">
            <h2>Access Denied</h2>
            <p>Only administrators and team managers can view employee summaries.</p>
          </div>
        </div>
      </div>
    );
  }

  const pendingAnalysis = summaries.filter(s => !s.ai_summary && s.screenshot_count > 0).length;

  return (
    <div className="app-layout">
      <Sidebar user={user} onLogout={onLogout} activePage="employee-summary" />
      <div className="main-content">
        <div className="content-header">
          <div>
            <h1>Employee Summary</h1>
            <p>AI-powered daily work summaries</p>
          </div>
          <div className="header-actions">
            <select
              value={roleFilter}
              onChange={e => setRoleFilter(e.target.value)}
              className="role-filter"
            >
              <option value="all">All Users</option>
              <option value="employee">Employees</option>
              <option value="admin">Admins</option>
              <option value="team_manager">Team Managers</option>
            </select>
            {pendingAnalysis > 0 && (
              <button className="btn-secondary" onClick={analyzeAll}>
                Analyze All ({pendingAnalysis})
              </button>
            )}
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              max={format(new Date(), 'yyyy-MM-dd')}
            />
          </div>
        </div>

        {loading ? (
          <div className="loading">Loading summaries...</div>
        ) : summaries.length === 0 ? (
          <div className="empty-state">No employees found</div>
        ) : (
          <div className="summary-grid">
            {summaries.map(emp => (
              <div key={emp.user_id} className="summary-card">
                <div className="card-header">
                  <div>
                    <strong>{emp.full_name}</strong>
                    <span className="email">{emp.email}</span>
                  </div>
                  <div className="badges">
                    <span className={`role-badge ${emp.role}`}>{emp.role}</span>
                    {emp.team_name && <span className="team-badge">{emp.team_name}</span>}
                  </div>
                </div>

                <div className="time-stats">
                  <div className="stat">
                    <span className="label">Uptime</span>
                    <span className="value">{formatTime(emp.total_uptime)}</span>
                  </div>
                  <div className="stat">
                    <span className="label">Active</span>
                    <span className="value">{formatTime(emp.active_time)}</span>
                  </div>
                  <div className="stat">
                    <span className="label">Idle</span>
                    <span className="value">{formatTime(emp.idle_time)}</span>
                  </div>
                </div>

                {emp.total_uptime > 0 && (
                  <div className="activity-bar">
                    <div
                      className="active-fill"
                      style={{ width: `${getActivityPercent(emp.active_time, emp.total_uptime)}%` }}
                    />
                  </div>
                )}

                <div className="screenshots-info">
                  {emp.screenshot_count} screenshots
                </div>

                <div className="ai-section">
                  {emp.ai_summary ? (
                    <div className="ai-summary">
                      <strong>AI Summary</strong>
                      <p>{emp.ai_summary}</p>
                      {emp.applications_detected && emp.applications_detected.length > 0 && (
                        <div className="apps-list">
                          {emp.applications_detected.slice(0, 5).map((app, i) => (
                            <span key={i} className="app-tag">{app.name}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : emp.analysis_status === 'failed' ? (
                    <div className="analysis-failed">
                      <span>Analysis failed</span>
                      <button onClick={() => triggerAnalysis(emp.user_id)} disabled={analyzing.has(emp.user_id)}>
                        Retry
                      </button>
                    </div>
                  ) : emp.screenshot_count > 0 ? (
                    <button
                      className="analyze-btn"
                      onClick={() => triggerAnalysis(emp.user_id)}
                      disabled={analyzing.has(emp.user_id)}
                    >
                      {analyzing.has(emp.user_id) ? 'Analyzing...' : 'Analyze Screenshots'}
                    </button>
                  ) : (
                    <div className="no-screenshots">No screenshots to analyze</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default EmployeeSummary;
