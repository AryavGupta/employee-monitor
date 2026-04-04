import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import axios from 'axios';
import { format, addDays } from 'date-fns';
import Sidebar from './Sidebar';
import { useUsers, useFilteredUsers } from '../hooks/useUsers';
import './AttendanceLogs.css';

const API_URL = process.env.REACT_APP_API_URL || '';

function AttendanceLogs({ user, onLogout }) {
  // User selection
  const { users } = useUsers();
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedUserName, setSelectedUserName] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [showUserDropdown, setShowUserDropdown] = useState(false);
  const userDropdownRef = useRef(null);

  // Shift attendance
  const [shiftDate, setShiftDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [shiftData, setShiftData] = useState(null);
  const [shiftLoading, setShiftLoading] = useState(false);

  // Activity logs
  const [activityLog, setActivityLog] = useState([]);
  const [activityLogLoading, setActivityLogLoading] = useState(false);
  const [logOffset, setLogOffset] = useState(0);
  const [hasMoreLogs, setHasMoreLogs] = useState(false);
  const [logFilters, setLogFilters] = useState({
    startDate: format(new Date(), 'yyyy-MM-dd'),
    startTime: '00:00',
    endDate: format(new Date(), 'yyyy-MM-dd'),
    endTime: '23:59',
    status: '' // '' = all, 'active', 'idle'
  });

  const LOG_LIMIT = 100;
  const [exporting, setExporting] = useState(false);
  const [exportingShift, setExportingShift] = useState(false);

  // Fetch users on mount
  // Users loaded via shared useUsers hook

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (userDropdownRef.current && !userDropdownRef.current.contains(e.target)) {
        setShowUserDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Fetch shift attendance
  const fetchShiftAttendance = useCallback(async () => {
    if (!selectedUserId) return;
    setShiftLoading(true);
    try {
      const token = localStorage.getItem('token');
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const params = new URLSearchParams({ userId: selectedUserId, shiftDate, timezone: tz });
      const res = await axios.get(`${API_URL}/api/reports/shift-attendance?${params}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.data.success) setShiftData(res.data.data);
    } catch (err) {
      console.error('Error fetching shift attendance:', err);
    } finally {
      setShiftLoading(false);
    }
  }, [selectedUserId, shiftDate]);

  // Fetch activity logs
  const fetchActivityLogs = useCallback(async (offset = 0, append = false) => {
    if (!selectedUserId) return;
    setActivityLogLoading(true);
    try {
      const token = localStorage.getItem('token');
      const startISO = new Date(`${logFilters.startDate}T${logFilters.startTime}:00`).toISOString();
      const endISO = new Date(`${logFilters.endDate}T${logFilters.endTime}:59`).toISOString();
      const params = new URLSearchParams({
        userId: selectedUserId,
        startDate: startISO,
        endDate: endISO,
        sort: 'desc',
        limit: String(LOG_LIMIT),
        offset: String(offset)
      });
      if (logFilters.status) params.append('isIdle', logFilters.status === 'idle' ? 'true' : 'false');

      const res = await axios.get(`${API_URL}/api/activity?${params}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.data.success) {
        const newData = res.data.data;
        setActivityLog(prev => append ? [...prev, ...newData] : newData);
        setHasMoreLogs(newData.length === LOG_LIMIT);
        setLogOffset(offset + newData.length);
      }
    } catch (err) {
      console.error('Error fetching activity logs:', err);
    } finally {
      setActivityLogLoading(false);
    }
  }, [selectedUserId, logFilters]);

  // Export CSV — built client-side to match dashboard formatting exactly
  const exportCSV = async () => {
    if (!selectedUserId) return;
    setExporting(true);
    try {
      const token = localStorage.getItem('token');
      const startISO = new Date(`${logFilters.startDate}T${logFilters.startTime}:00`).toISOString();
      const endISO = new Date(`${logFilters.endDate}T${logFilters.endTime}:59`).toISOString();
      const params = new URLSearchParams({
        userId: selectedUserId,
        startDate: startISO,
        endDate: endISO,
        sort: 'desc',
        limit: '10000',
        offset: '0'
      });
      if (logFilters.status) params.append('isIdle', logFilters.status === 'idle' ? 'true' : 'false');

      const res = await axios.get(`${API_URL}/api/activity?${params}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!res.data.success || !res.data.data.length) return;

      const escapeCSV = (val) => {
        const str = String(val ?? '');
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
      };

      // Find selected user to get email/team
      const selectedUser = users.find(u => u.id === selectedUserId);
      const csvHeader = 'Date,User Name,Email,Team,Time,Application,App/URL Name,Window Title,Keys,Duration,Status';
      const csvRows = res.data.data.map(entry => {
        const detail = getActivityDetail(entry);
        const detailStr = detail.type === 'url' ? detail.value
          : detail.type === 'file' ? detail.value
          : detail.type === 'window' ? detail.value : '';
        return [
          format(new Date(entry.timestamp), 'yyyy-MM-dd'),
          entry.full_name || selectedUserName,
          entry.email || selectedUser?.email || '',
          selectedUser?.team_name || '',
          format(new Date(entry.timestamp), 'hh:mm:ss a'),
          entry.application_name || '--',
          detailStr,
          entry.window_title || '',
          entry.keyboard_events > 0 ? entry.keyboard_events : '',
          entry.duration_seconds ? `${entry.duration_seconds}s` : '--',
          entry.is_idle ? 'idle' : 'active'
        ].map(escapeCSV).join(',');
      });

      const csv = [csvHeader, ...csvRows].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `activity-logs-${selectedUserName.replace(/\s+/g, '-')}-${logFilters.startDate}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Error exporting CSV:', err);
    } finally {
      setExporting(false);
    }
  };

  // Export shift attendance CSV
  const exportShiftCSV = async () => {
    if (!selectedUserId) return;
    setExportingShift(true);
    try {
      const token = localStorage.getItem('token');
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const params = new URLSearchParams({ userId: selectedUserId, shiftDate, timezone: tz });

      const res = await axios.get(`${API_URL}/api/reports/shift-attendance/export?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'blob'
      });

      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `shift-attendance-${selectedUserName.replace(/\s+/g, '-')}-${shiftDate}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Error exporting shift CSV:', err);
    } finally {
      setExportingShift(false);
    }
  };

  // Fetch shift attendance on user or shift date change (independent from logs)
  useEffect(() => {
    if (selectedUserId) {
      fetchShiftAttendance();
    } else {
      setShiftData(null);
    }
  }, [selectedUserId, fetchShiftAttendance]);

  // Fetch logs on user selection or filter change (independent from shift)
  useEffect(() => {
    if (selectedUserId) {
      setLogOffset(0);
      fetchActivityLogs(0);
    } else {
      setActivityLog([]);
    }
  }, [selectedUserId, logFilters, fetchActivityLogs]);

  const selectUser = (u) => {
    setSelectedUserId(u.id);
    setSelectedUserName(u.full_name);
    setUserSearch(u.full_name);
    setShowUserDropdown(false);
  };

  const formatDuration = (seconds) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  };

  const getActivityDetail = (entry) => {
    if (entry.url) {
      if (entry.url.startsWith('file:///')) {
        return { type: 'file', value: decodeURIComponent(entry.url.replace('file:///', '')) };
      }
      return { type: 'url', value: entry.url, domain: entry.domain };
    }
    if (entry.window_title && entry.window_title !== 'Unknown') {
      return { type: 'window', value: entry.window_title };
    }
    return { type: 'none', value: '' };
  };

  const filteredUsers = useFilteredUsers(users, userSearch);

  // Log summary stats (memoized to avoid recomputing on every render)
  const logSummary = useMemo(() => ({
    total: activityLog.length,
    active: activityLog.filter(e => !e.is_idle).length,
    idle: activityLog.filter(e => e.is_idle).length,
    totalDuration: activityLog.reduce((sum, e) => sum + (parseInt(e.duration_seconds) || 0), 0)
  }), [activityLog]);

  return (
    <div className="app-layout">
      <Sidebar user={user} onLogout={onLogout} activePage="attendance-logs" />

      <div className="main-content">
        <div className="content-header">
          <h1>Attendance & Logs</h1>
          <p>Shift attendance and detailed activity logs</p>
        </div>

        {/* User Selection */}
        <div className="al-user-selection">
          <label>Select Employee</label>
          <div className="al-user-search-container" ref={userDropdownRef}>
            <input
              type="text"
              placeholder="Search and select an employee..."
              value={userSearch}
              onChange={(e) => {
                setUserSearch(e.target.value);
                setShowUserDropdown(true);
                if (!e.target.value) {
                  setSelectedUserId('');
                  setSelectedUserName('');
                  setShiftData(null);
                  setActivityLog([]);
                }
              }}
              onFocus={() => setShowUserDropdown(true)}
              className="al-user-search-input"
            />
            {showUserDropdown && (
              <div className="al-user-dropdown">
                {filteredUsers.length > 0 ? (
                  filteredUsers.map(u => (
                    <div
                      key={u.id}
                      className={`al-user-option ${selectedUserId === u.id ? 'selected' : ''}`}
                      onClick={() => selectUser(u)}
                    >
                      <span className="al-user-name">{u.full_name}</span>
                      <span className="al-user-email">{u.email}</span>
                    </div>
                  ))
                ) : (
                  <div className="al-no-users">No users found</div>
                )}
              </div>
            )}
          </div>
        </div>

        {!selectedUserId ? (
          <div className="al-empty-prompt">
            <h2>Select an Employee</h2>
            <p>Choose an employee to view their shift attendance and activity logs</p>
          </div>
        ) : (
          <>
            {/* ===== SHIFT ATTENDANCE ===== */}
            <div className="al-section">
              <div className="al-section-header">
                <h3>Shift Attendance</h3>
                <button className="al-refresh-btn al-refresh-btn-sm" onClick={fetchShiftAttendance} disabled={shiftLoading}>
                  {shiftLoading ? '...' : '↻'}
                </button>
                <button className="al-export-btn" onClick={exportShiftCSV}
                  disabled={exportingShift || !shiftData?.summary?.session_count}>
                  {exportingShift ? 'Exporting...' : 'Export CSV'}
                </button>
                <div className="al-shift-nav">
                  <button className="al-nav-btn" onClick={() => setShiftDate(format(addDays(new Date(shiftDate + 'T00:00:00'), -1), 'yyyy-MM-dd'))}>
                    &larr;
                  </button>
                  <input type="date" value={shiftDate} onChange={(e) => setShiftDate(e.target.value)} className="al-shift-date-input" />
                  <button className="al-nav-btn" onClick={() => setShiftDate(format(addDays(new Date(shiftDate + 'T00:00:00'), 1), 'yyyy-MM-dd'))}>
                    &rarr;
                  </button>
                </div>
              </div>

              <div className="al-shift-date">
                {format(new Date(shiftDate + 'T00:00:00'), 'EEEE, MMMM dd, yyyy')}
                {shiftData?.shift && (
                  <span className={`al-badge ${shiftData.shift.is_night_shift ? 'night' : 'day'}`}>
                    {shiftData.shift.label}
                  </span>
                )}
                {shiftData?.shift?.working_hours_start && (
                  <span className="al-shift-time">{shiftData.shift.working_hours_start} – {shiftData.shift.working_hours_end}</span>
                )}
              </div>

              {shiftLoading ? (
                <div className="al-loading">Loading shift data...</div>
              ) : shiftData?.summary?.session_count > 0 || shiftData?.summary?.activity_count > 0 ? (
                <>
                  <div className="al-stats-grid">
                    <div className="al-stat">
                      <div className="al-stat-label">Login</div>
                      <div className="al-stat-value">
                        {shiftData.summary.first_login ? format(new Date(shiftData.summary.first_login), 'hh:mm a') : '--'}
                      </div>
                    </div>
                    <div className="al-stat">
                      <div className="al-stat-label">Logout</div>
                      <div className="al-stat-value">
                        {shiftData.summary.is_active ? 'Active' : shiftData.summary.last_logout ? format(new Date(shiftData.summary.last_logout), 'hh:mm a') : '--'}
                      </div>
                    </div>
                    <div className="al-stat">
                      <div className="al-stat-label">Total Hours</div>
                      <div className="al-stat-value">{formatDuration(shiftData.summary.total_seconds)}</div>
                    </div>
                    <div className="al-stat">
                      <div className="al-stat-label">Active Time</div>
                      <div className="al-stat-value active">{formatDuration(shiftData.summary.active_seconds)}</div>
                    </div>
                    <div className="al-stat">
                      <div className="al-stat-label">Idle Time</div>
                      <div className="al-stat-value idle">{formatDuration(shiftData.summary.idle_seconds)}</div>
                    </div>
                  </div>

                  {shiftData.sessions.length > 1 && (
                    <div className="al-sessions">
                      <h4>Sessions ({shiftData.sessions.length})</h4>
                      <div className={shiftData.sessions.length > 4 ? 'al-sessions-scroll' : ''}>
                        <table className="al-table">
                          <thead>
                            <tr><th>#</th><th>Login</th><th>Logout</th><th>Duration</th><th>Status</th></tr>
                          </thead>
                          <tbody>
                            {shiftData.sessions.map((s, i) => (
                              <tr key={s.id}>
                                <td>{i + 1}</td>
                                <td>{format(new Date(s.start_time), 'hh:mm a')}</td>
                                <td>{s.end_time ? format(new Date(s.end_time), 'hh:mm a') : 'Active'}</td>
                                <td>{formatDuration(s.duration_seconds)}</td>
                                <td><span className={`al-status ${s.effective_status}`}>{s.effective_status.replace('_', ' ')}</span></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="al-empty">No attendance recorded for this shift</div>
              )}
            </div>

            {/* ===== ACTIVITY LOGS ===== */}
            <div className="al-section">
              <div className="al-section-header">
                <h3>Activity Logs</h3>
              </div>

              {/* Log Filters */}
              <div className="al-log-filters">
                <div className="al-filter-group">
                  <label>Start Date</label>
                  <input type="date" value={logFilters.startDate}
                    onChange={(e) => setLogFilters(f => ({ ...f, startDate: e.target.value }))} />
                </div>
                <div className="al-filter-group">
                  <label>Start Time</label>
                  <input type="time" value={logFilters.startTime}
                    onChange={(e) => setLogFilters(f => ({ ...f, startTime: e.target.value }))} />
                </div>
                <div className="al-filter-group">
                  <label>End Date</label>
                  <input type="date" value={logFilters.endDate}
                    onChange={(e) => setLogFilters(f => ({ ...f, endDate: e.target.value }))} />
                </div>
                <div className="al-filter-group">
                  <label>End Time</label>
                  <input type="time" value={logFilters.endTime}
                    onChange={(e) => setLogFilters(f => ({ ...f, endTime: e.target.value }))} />
                </div>
                <div className="al-filter-group">
                  <label>Status</label>
                  <select value={logFilters.status}
                    onChange={(e) => setLogFilters(f => ({ ...f, status: e.target.value }))}>
                    <option value="">All</option>
                    <option value="active">Active</option>
                    <option value="idle">Idle</option>
                  </select>
                </div>
                <button className="al-refresh-btn" onClick={() => { setLogOffset(0); fetchActivityLogs(0); }} disabled={activityLogLoading}>
                  {activityLogLoading ? 'Loading...' : 'Refresh'}
                </button>
                <button className="al-export-btn" onClick={exportCSV} disabled={exporting || activityLog.length === 0}>
                  {exporting ? 'Exporting...' : 'Export CSV'}
                </button>
              </div>

              {/* Summary Bar */}
              {activityLog.length > 0 && (
                <div className="al-log-summary">
                  <span><strong>{logSummary.total}</strong> entries</span>
                  <span className="active"><strong>{logSummary.active}</strong> active</span>
                  <span className="idle"><strong>{logSummary.idle}</strong> idle</span>
                  <span><strong>{formatDuration(logSummary.totalDuration)}</strong> total</span>
                </div>
              )}

              {/* Logs Table */}
              {activityLogLoading && activityLog.length === 0 ? (
                <div className="al-loading">Loading activity logs...</div>
              ) : activityLog.length > 0 ? (
                <>
                  <div className="al-log-scroll">
                    <table className="al-table al-log-table">
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Application</th>
                          <th>Details</th>
                          <th>Keys</th>
                          <th>Duration</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activityLog.map((entry, i) => {
                          const detail = getActivityDetail(entry);
                          const metadata = typeof entry.metadata === 'string' ? JSON.parse(entry.metadata || '{}') : (entry.metadata || {});
                          return (
                            <tr key={entry.id || i} className={entry.is_idle ? 'al-idle-row' : ''}>
                              <td className="al-col-time">{format(new Date(entry.timestamp), 'hh:mm:ss a')}</td>
                              <td className="al-col-app"><strong>{entry.application_name || '--'}</strong></td>
                              <td className="al-col-detail">
                                {detail.type === 'url' && <span className="al-detail-url" title={detail.value}>{detail.value}</span>}
                                {detail.type === 'file' && <span className="al-detail-file" title={detail.value}>{detail.value}</span>}
                                {detail.type === 'window' && <span className="al-detail-window" title={detail.value}>{detail.value.length > 60 ? detail.value.substring(0, 60) + '...' : detail.value}</span>}
                              </td>
                              <td className="al-col-keys">
                                {entry.keyboard_events > 0 && (
                                  <span className={metadata.maxKeyRepeat > 15 ? 'al-key-spam' : ''}>
                                    {entry.keyboard_events}
                                    {metadata.maxKeyRepeat > 5 && <span className="al-repeat-badge" title={`Max ${metadata.maxKeyRepeat}x same key`}>R{metadata.maxKeyRepeat}</span>}
                                  </span>
                                )}
                              </td>
                              <td className="al-col-duration">{entry.duration_seconds ? `${entry.duration_seconds}s` : '--'}</td>
                              <td><span className={`al-status ${entry.is_idle ? 'idle' : 'active'}`}>{entry.is_idle ? 'idle' : 'active'}</span></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {hasMoreLogs && (
                    <button className="al-load-more" onClick={() => fetchActivityLogs(logOffset, true)} disabled={activityLogLoading}>
                      {activityLogLoading ? 'Loading...' : 'Load More'}
                    </button>
                  )}
                </>
              ) : (
                <div className="al-empty">No activity logs found for the selected filters</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default AttendanceLogs;
