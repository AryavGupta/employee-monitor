import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { format, subDays, startOfDay, endOfDay } from 'date-fns';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { jsPDF } from 'jspdf';
import Sidebar from './Sidebar';
import './Analytics.css';

const API_URL = process.env.REACT_APP_API_URL || '';

const COLORS = {
  active: '#3b82f6',
  idle: '#f59e0b',
  keyboard: '#8b5cf6',
  mouse: '#10b981'
};

// SVG Icon Components
const Icons = {
  Productivity: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3" />
    </svg>
  ),
  Active: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  Idle: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  ),
  Uptime: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  ),
  Keyboard: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" ry="2" />
      <line x1="6" y1="8" x2="6" y2="8" />
      <line x1="10" y1="8" x2="10" y2="8" />
      <line x1="14" y1="8" x2="14" y2="8" />
      <line x1="18" y1="8" x2="18" y2="8" />
      <line x1="6" y1="12" x2="6" y2="12" />
      <line x1="10" y1="12" x2="10" y2="12" />
      <line x1="14" y1="12" x2="14" y2="12" />
      <line x1="18" y1="12" x2="18" y2="12" />
      <line x1="7" y1="16" x2="17" y2="16" />
    </svg>
  ),
  Mouse: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="3" width="12" height="18" rx="6" />
      <line x1="12" y1="7" x2="12" y2="11" />
    </svg>
  ),
  Refresh: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  ),
  Download: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
  Chart: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  )
};

function Analytics({ user, onLogout }) {
  const [loading, setLoading] = useState(false);
  const [users, setUsers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedUserName, setSelectedUserName] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [showUserDropdown, setShowUserDropdown] = useState(false);
  const userDropdownRef = useRef(null);

  const [dateRange, setDateRange] = useState({
    startDate: format(subDays(new Date(), 7), 'yyyy-MM-dd'),
    endDate: format(new Date(), 'yyyy-MM-dd')
  });

  // Data states
  const [summary, setSummary] = useState(null);
  const [productivityData, setProductivityData] = useState([]);
  const [hourlyData, setHourlyData] = useState([]);

  // Fetch users on mount
  useEffect(() => {
    fetchUsers();
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (userDropdownRef.current && !userDropdownRef.current.contains(event.target)) {
        setShowUserDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const fetchUsers = async () => {
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
  };

  const fetchAnalytics = useCallback(async () => {
    if (!selectedUserId) return;

    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const headers = { Authorization: `Bearer ${token}` };

      const params = new URLSearchParams({
        startDate: startOfDay(new Date(dateRange.startDate)).toISOString(),
        endDate: endOfDay(new Date(dateRange.endDate)).toISOString(),
        userId: selectedUserId
      });

      // Fetch summary and productivity data
      const [summaryRes, productivityRes] = await Promise.all([
        axios.get(`${API_URL}/api/reports/dashboard-summary?${params}`, { headers }),
        axios.get(`${API_URL}/api/reports/productivity?${params}`, { headers })
      ]);

      if (summaryRes.data.success) {
        setSummary(summaryRes.data.data);
      }

      if (productivityRes.data.success) {
        // Group by date for trend chart
        const grouped = productivityRes.data.data.reduce((acc, item) => {
          const date = item.date;
          if (!acc[date]) {
            acc[date] = {
              date,
              active_seconds: 0,
              idle_seconds: 0,
              keyboard_events: 0,
              mouse_events: 0
            };
          }
          acc[date].active_seconds += parseInt(item.active_seconds) || 0;
          acc[date].idle_seconds += parseInt(item.idle_seconds) || 0;
          acc[date].keyboard_events += parseInt(item.keyboard_events) || 0;
          acc[date].mouse_events += parseInt(item.mouse_events) || 0;
          return acc;
        }, {});

        const trendData = Object.values(grouped).map(d => ({
          ...d,
          active_hours: Math.round(d.active_seconds / 3600 * 10) / 10,
          idle_hours: Math.round(d.idle_seconds / 3600 * 10) / 10,
          total_hours: Math.round((d.active_seconds + d.idle_seconds) / 3600 * 10) / 10
        })).sort((a, b) => new Date(a.date) - new Date(b.date));

        setProductivityData(trendData);
      }

      // Fetch hourly data for today
      const hourlyRes = await axios.get(
        `${API_URL}/api/reports/productivity/hourly?date=${format(new Date(), 'yyyy-MM-dd')}&userId=${selectedUserId}`,
        { headers }
      );

      if (hourlyRes.data.success) {
        setHourlyData(hourlyRes.data.data.map(h => ({
          ...h,
          hour: `${String(h.hour).padStart(2, '0')}:00`,
          active_minutes: Math.round((parseInt(h.active_seconds) || 0) / 60),
          keyboard: parseInt(h.keyboard_events) || 0,
          mouse: parseInt(h.mouse_events) || 0
        })));
      }

    } catch (error) {
      console.error('Error fetching analytics:', error);
    } finally {
      setLoading(false);
    }
  }, [selectedUserId, dateRange]);

  useEffect(() => {
    if (selectedUserId) {
      fetchAnalytics();
    }
  }, [selectedUserId, dateRange, fetchAnalytics]);

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

  // Format decimal hours to "Xh Ym" format (e.g., 0.033 hours -> "0h 2m")
  const formatHoursWithMinutes = (decimalHours) => {
    if (!decimalHours && decimalHours !== 0) return '0h 0m';
    const totalMinutes = Math.round(decimalHours * 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}h ${minutes}m`;
  };

  // Download PDF Report
  const downloadReport = async () => {
    if (!summary || !selectedUserName) return;

    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();

    // Title
    doc.setFontSize(20);
    doc.setFont('helvetica', 'bold');
    doc.text('Activity Analytics Report', pageWidth / 2, 20, { align: 'center' });

    // User Info
    doc.setFontSize(12);
    doc.setFont('helvetica', 'normal');
    doc.text(`Employee: ${selectedUserName}`, 20, 40);
    doc.text(`Date Range: ${dateRange.startDate} to ${dateRange.endDate}`, 20, 50);
    doc.text(`Generated: ${format(new Date(), 'PPpp')}`, 20, 60);

    // Separator
    doc.setDrawColor(200);
    doc.line(20, 70, pageWidth - 20, 70);

    // Summary Stats
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('Summary', 20, 85);

    doc.setFontSize(11);
    doc.setFont('helvetica', 'normal');
    const stats = [
      ['Productivity Score', `${summary.productivity_score || 0}%`],
      ['Active Time', formatHoursWithMinutes(summary.active_time_hours)],
      ['Idle Time', formatHoursWithMinutes(summary.idle_time_hours)],
      ['Total Uptime', formatHoursWithMinutes((summary.active_time_hours || 0) + (summary.idle_time_hours || 0))],
      ['Keyboard Events', (summary.keyboard_events || 0).toLocaleString()],
      ['Mouse Events', (summary.mouse_events || 0).toLocaleString()],
      ['Screenshots Captured', (summary.screenshots?.total || 0).toString()]
    ];

    let yPos = 95;
    stats.forEach(([label, value]) => {
      doc.text(`${label}:`, 25, yPos);
      doc.text(value, 100, yPos);
      yPos += 10;
    });

    // Daily Breakdown
    if (productivityData.length > 0) {
      yPos += 10;
      doc.setFontSize(14);
      doc.setFont('helvetica', 'bold');
      doc.text('Daily Activity', 20, yPos);
      yPos += 10;

      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');

      // Table header
      doc.setFont('helvetica', 'bold');
      doc.text('Date', 25, yPos);
      doc.text('Active', 60, yPos);
      doc.text('Idle', 90, yPos);
      doc.text('Keyboard', 115, yPos);
      doc.text('Mouse', 150, yPos);
      yPos += 7;

      doc.setFont('helvetica', 'normal');
      productivityData.slice(0, 10).forEach(day => {
        doc.text(format(new Date(day.date), 'MMM dd'), 25, yPos);
        doc.text(`${day.active_hours}h`, 60, yPos);
        doc.text(`${day.idle_hours}h`, 90, yPos);
        doc.text(day.keyboard_events.toLocaleString(), 115, yPos);
        doc.text(day.mouse_events.toLocaleString(), 150, yPos);
        yPos += 7;
      });
    }

    // Save
    const filename = `analytics_${selectedUserName.replace(/\s+/g, '_')}_${dateRange.startDate}_${dateRange.endDate}.pdf`;
    doc.save(filename);
  };

  // Download CSV
  const downloadCSV = () => {
    if (!productivityData.length) return;

    const headers = ['Date', 'Active Hours', 'Idle Hours', 'Total Hours', 'Keyboard Events', 'Mouse Events'];
    const rows = productivityData.map(d => [
      d.date,
      d.active_hours,
      d.idle_hours,
      d.total_hours,
      d.keyboard_events,
      d.mouse_events
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `analytics_${selectedUserName.replace(/\s+/g, '_')}_${dateRange.startDate}_${dateRange.endDate}.csv`;
    link.click();
    window.URL.revokeObjectURL(url);
  };

  const filteredUsers = users.filter(u =>
    u.full_name.toLowerCase().includes(userSearch.toLowerCase()) ||
    u.email.toLowerCase().includes(userSearch.toLowerCase())
  );

  return (
    <div className="app-layout">
      <Sidebar user={user} onLogout={onLogout} activePage="analytics" />

      <div className="main-content">
        <div className="content-header">
          <h1>Analytics</h1>
          <p>View detailed activity metrics for employees</p>
        </div>

        {/* User Selection */}
        <div className="user-selection-section">
          <label>Select Employee</label>
          <div className="user-search-container" ref={userDropdownRef}>
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
                  setSummary(null);
                  setProductivityData([]);
                  setHourlyData([]);
                }
              }}
              onFocus={() => setShowUserDropdown(true)}
              className="user-search-input"
            />
            {showUserDropdown && (
              <div className="user-dropdown">
                {filteredUsers.length > 0 ? (
                  filteredUsers.map(u => (
                    <div
                      key={u.id}
                      className={`user-option ${selectedUserId === u.id ? 'selected' : ''}`}
                      onClick={() => selectUser(u)}
                    >
                      <span className="user-name">{u.full_name}</span>
                      <span className="user-email">{u.email}</span>
                    </div>
                  ))
                ) : (
                  <div className="no-users">No users found</div>
                )}
              </div>
            )}
          </div>
        </div>

        {!selectedUserId ? (
          <div className="select-user-prompt">
            <div className="prompt-icon">
              <Icons.Chart />
            </div>
            <h2>Select an Employee</h2>
            <p>Choose an employee from the dropdown above to view their activity analytics</p>
          </div>
        ) : (
          <>
            {/* Filters & Actions */}
            <div className="filters-bar">
              <div className="filter-group">
                <label>Date Range</label>
                <div className="date-inputs">
                  <input
                    type="date"
                    value={dateRange.startDate}
                    onChange={(e) => setDateRange(prev => ({ ...prev, startDate: e.target.value }))}
                  />
                  <span>to</span>
                  <input
                    type="date"
                    value={dateRange.endDate}
                    onChange={(e) => setDateRange(prev => ({ ...prev, endDate: e.target.value }))}
                  />
                </div>
              </div>

              <div className="action-buttons">
                <button className="refresh-btn" onClick={fetchAnalytics} disabled={loading}>
                  <Icons.Refresh />
                  {loading ? 'Loading...' : 'Refresh'}
                </button>
                <button className="download-btn" onClick={downloadReport} disabled={!summary}>
                  <Icons.Download />
                  PDF Report
                </button>
                <button className="download-btn secondary" onClick={downloadCSV} disabled={!productivityData.length}>
                  <Icons.Download />
                  CSV Export
                </button>
              </div>
            </div>

            {loading ? (
              <div className="loading">Loading analytics...</div>
            ) : (
              <>
                {/* Summary Stats */}
                <div className="stats-grid compact">
                  <div className="stat-card highlight">
                    <div className="stat-icon productivity">
                      <Icons.Productivity />
                    </div>
                    <div className="stat-info">
                      <div className="stat-value">{summary?.productivity_score || 0}%</div>
                      <div className="stat-label">Productivity Score</div>
                    </div>
                  </div>

                  <div className="stat-card">
                    <div className="stat-icon active">
                      <Icons.Active />
                    </div>
                    <div className="stat-info">
                      <div className="stat-value">{formatHoursWithMinutes(summary?.active_time_hours)}</div>
                      <div className="stat-label">Active Time</div>
                    </div>
                  </div>

                  <div className="stat-card">
                    <div className="stat-icon idle">
                      <Icons.Idle />
                    </div>
                    <div className="stat-info">
                      <div className="stat-value">{formatHoursWithMinutes(summary?.idle_time_hours)}</div>
                      <div className="stat-label">Idle Time</div>
                    </div>
                  </div>

                  <div className="stat-card">
                    <div className="stat-icon uptime">
                      <Icons.Uptime />
                    </div>
                    <div className="stat-info">
                      <div className="stat-value">
                        {formatHoursWithMinutes((summary?.active_time_hours || 0) + (summary?.idle_time_hours || 0))}
                      </div>
                      <div className="stat-label">Total Uptime</div>
                    </div>
                  </div>

                  <div className="stat-card">
                    <div className="stat-icon keyboard">
                      <Icons.Keyboard />
                    </div>
                    <div className="stat-info">
                      <div className="stat-value">{(summary?.keyboard_events || 0).toLocaleString()}</div>
                      <div className="stat-label">Keyboard Activity</div>
                    </div>
                  </div>

                  <div className="stat-card">
                    <div className="stat-icon mouse">
                      <Icons.Mouse />
                    </div>
                    <div className="stat-info">
                      <div className="stat-value">{(summary?.mouse_events || 0).toLocaleString()}</div>
                      <div className="stat-label">Mouse Activity</div>
                    </div>
                  </div>
                </div>

                {/* Charts */}
                <div className="charts-section">
                  {/* Productivity Trend */}
                  <div className="chart-card full-width">
                    <h3>Activity Trend ({dateRange.startDate} to {dateRange.endDate})</h3>
                    {productivityData.length > 0 ? (
                      <ResponsiveContainer width="100%" height={300}>
                        <AreaChart data={productivityData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                          <XAxis
                            dataKey="date"
                            tickFormatter={(d) => format(new Date(d), 'MMM dd')}
                            stroke="#6b7280"
                          />
                          <YAxis
                            label={{ value: 'Hours', angle: -90, position: 'insideLeft' }}
                            stroke="#6b7280"
                          />
                          <Tooltip
                            formatter={(value, name) => [`${value}h`, name === 'active_hours' ? 'Active' : 'Idle']}
                            labelFormatter={(d) => format(new Date(d), 'EEEE, MMMM dd, yyyy')}
                          />
                          <Legend />
                          <Area
                            type="monotone"
                            dataKey="active_hours"
                            stackId="1"
                            stroke={COLORS.active}
                            fill={COLORS.active}
                            name="Active"
                            fillOpacity={0.8}
                          />
                          <Area
                            type="monotone"
                            dataKey="idle_hours"
                            stackId="1"
                            stroke={COLORS.idle}
                            fill={COLORS.idle}
                            name="Idle"
                            fillOpacity={0.8}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="no-data">No activity data for this period</div>
                    )}
                  </div>

                  {/* Today's Hourly Activity */}
                  <div className="chart-card full-width">
                    <h3>Today's Hourly Activity ({format(new Date(), 'MMMM dd, yyyy')})</h3>
                    {hourlyData.some(h => h.active_minutes > 0) ? (
                      <ResponsiveContainer width="100%" height={250}>
                        <BarChart data={hourlyData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                          <XAxis dataKey="hour" stroke="#6b7280" fontSize={11} />
                          <YAxis
                            label={{ value: 'Minutes', angle: -90, position: 'insideLeft' }}
                            stroke="#6b7280"
                          />
                          <Tooltip />
                          <Bar
                            dataKey="active_minutes"
                            fill={COLORS.active}
                            name="Active Minutes"
                            radius={[4, 4, 0, 0]}
                          />
                        </BarChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="no-data">No activity recorded today yet</div>
                    )}
                  </div>
                </div>

                {/* Daily Breakdown Table */}
                {productivityData.length > 0 && (
                  <div className="daily-breakdown">
                    <h3>Daily Breakdown</h3>
                    <table className="breakdown-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Active Time</th>
                          <th>Idle Time</th>
                          <th>Total</th>
                          <th>Keyboard</th>
                          <th>Mouse</th>
                        </tr>
                      </thead>
                      <tbody>
                        {productivityData.map((day, index) => (
                          <tr key={index}>
                            <td>{format(new Date(day.date), 'EEE, MMM dd')}</td>
                            <td>{formatDuration(day.active_seconds)}</td>
                            <td>{formatDuration(day.idle_seconds)}</td>
                            <td>{formatDuration(day.active_seconds + day.idle_seconds)}</td>
                            <td>{day.keyboard_events.toLocaleString()}</td>
                            <td>{day.mouse_events.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default Analytics;
