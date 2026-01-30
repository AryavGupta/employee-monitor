import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { format } from 'date-fns';
import Sidebar from './Sidebar';
import './Screenshots.css';

const API_URL = process.env.REACT_APP_API_URL || '';

const INTERVAL_OPTIONS = [
  { value: '', label: 'All' },
  { value: '1', label: '1 minute' },
  { value: '2', label: '2 minutes' },
  { value: '5', label: '5 minutes' },
  { value: '10', label: '10 minutes' },
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '60', label: '1 hour' }
];

function Screenshots({ user, onLogout }) {
  const [screenshots, setScreenshots] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedScreenshot, setSelectedScreenshot] = useState(null);
  const [enlargedImage, setEnlargedImage] = useState(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [userSearch, setUserSearch] = useState('');
  const [showUserDropdown, setShowUserDropdown] = useState(false);
  const [filters, setFilters] = useState({
    userId: '',
    userName: '',
    startDate: format(new Date(), 'yyyy-MM-dd'),
    endDate: format(new Date(), 'yyyy-MM-dd'),
    startTime: '00:00',
    endTime: '23:59',
    interval: '',
    flagged: ''
  });
  const [stats, setStats] = useState(null);
  const usersLoaded = useRef(false);
  const debounceTimer = useRef(null);
  const userDropdownRef = useRef(null);

  // Fetch users only once on mount
  useEffect(() => {
    if (!usersLoaded.current) {
      fetchUsers();
      usersLoaded.current = true;
    }
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (userDropdownRef.current && !userDropdownRef.current.contains(e.target)) {
        setShowUserDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Debounced fetch for filter changes (only when user is selected)
  useEffect(() => {
    if (!filters.userId) return;

    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    debounceTimer.current = setTimeout(() => {
      fetchData();
    }, 300);

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [filters]);

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (enlargedImage) {
          setEnlargedImage(null);
        } else if (selectedScreenshot) {
          setSelectedScreenshot(null);
        }
      }

      // Arrow key navigation when viewing a screenshot
      if (selectedScreenshot && !enlargedImage) {
        if (e.key === 'ArrowLeft' && currentIndex > 0) {
          navigateScreenshot(-1);
        } else if (e.key === 'ArrowRight' && currentIndex < screenshots.length - 1) {
          navigateScreenshot(1);
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [enlargedImage, selectedScreenshot, currentIndex, screenshots.length]);

  const navigateScreenshot = (direction) => {
    const newIndex = currentIndex + direction;
    if (newIndex >= 0 && newIndex < screenshots.length) {
      setCurrentIndex(newIndex);
      setSelectedScreenshot(screenshots[newIndex]);
    }
  };

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

  const fetchData = useCallback(async () => {
    if (!filters.userId) return;

    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const params = new URLSearchParams();

      params.append('userId', filters.userId);
      params.append('startDate', `${filters.startDate}T${filters.startTime}:00Z`);
      params.append('endDate', `${filters.endDate}T${filters.endTime}:59Z`);
      if (filters.flagged) params.append('flagged', filters.flagged);
      if (filters.interval) params.append('interval', filters.interval);
      params.append('limit', '100');

      const [screenshotsRes, statsRes] = await Promise.all([
        axios.get(`${API_URL}/api/screenshots?${params}`, {
          headers: { Authorization: `Bearer ${token}` }
        }),
        axios.get(`${API_URL}/api/screenshots/stats/summary?${params}`, {
          headers: { Authorization: `Bearer ${token}` }
        })
      ]);

      if (screenshotsRes.data.success) {
        setScreenshots(screenshotsRes.data.data);
      }
      if (statsRes.data.success) {
        setStats(statsRes.data.data);
      }
    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  const handleFilterChange = (field, value) => {
    setFilters(prev => ({ ...prev, [field]: value }));
  };

  const handleUserSelect = (selectedUser) => {
    setFilters(prev => ({
      ...prev,
      userId: selectedUser.id,
      userName: selectedUser.full_name
    }));
    setUserSearch(selectedUser.full_name);
    setShowUserDropdown(false);
  };

  const handleFlagScreenshot = async (screenshotId, isFlagged, reason) => {
    try {
      const token = localStorage.getItem('token');
      await axios.patch(
        `${API_URL}/api/screenshots/${screenshotId}/flag`,
        { isFlagged, reason },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      setScreenshots(prev => prev.map(s =>
        s.id === screenshotId ? { ...s, is_flagged: isFlagged, flag_reason: reason } : s
      ));
      setSelectedScreenshot(prev => prev ? { ...prev, is_flagged: isFlagged, flag_reason: reason } : null);
    } catch (error) {
      console.error('Error flagging screenshot:', error);
      alert('Failed to flag screenshot');
    }
  };

  const viewScreenshot = (screenshot, index) => {
    setSelectedScreenshot(screenshot);
    setCurrentIndex(index);
  };

  // Get thumbnail URL for grid view (smaller, faster loading)
  const getThumbnailUrl = (screenshot) => {
    const url = screenshot.screenshot_url;
    if (!url) return '';
    // If it's a data URL or absolute URL, use as-is
    if (url.startsWith('data:') || url.startsWith('http')) {
      return url;
    }
    return `${API_URL}${url}`;
  };

  // Get full resolution URL for modal view
  const getFullImageUrl = (screenshot) => {
    // Use full_url if available (returned by API for Storage-based screenshots)
    const url = screenshot.full_url || screenshot.screenshot_url;
    if (!url) return '';
    if (url.startsWith('data:') || url.startsWith('http')) {
      return url;
    }
    return `${API_URL}${url}`;
  };

  // Legacy function for backward compatibility
  const getImageUrl = getThumbnailUrl;

  const filteredUsers = users.filter(u =>
    u.full_name.toLowerCase().includes(userSearch.toLowerCase()) ||
    u.email.toLowerCase().includes(userSearch.toLowerCase())
  );

  return (
    <div className="app-layout">
      <Sidebar user={user} onLogout={onLogout} activePage="screenshots" />

      <div className="main-content">
        <div className="content-header">
          <h1>Screenshots</h1>
          <p>View and manage employee screenshots</p>
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
                  setFilters(prev => ({ ...prev, userId: '', userName: '' }));
                  setScreenshots([]);
                  setStats(null);
                }
              }}
              onFocus={() => setShowUserDropdown(true)}
              className="user-search-input"
            />
            {showUserDropdown && (
              <div className="user-dropdown">
                {filteredUsers.length === 0 ? (
                  <div className="user-dropdown-empty">No users found</div>
                ) : (
                  filteredUsers.map(u => (
                    <div
                      key={u.id}
                      className={`user-dropdown-item ${filters.userId === u.id ? 'selected' : ''}`}
                      onClick={() => handleUserSelect(u)}
                    >
                      <strong>{u.full_name}</strong>
                      <span>{u.email}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        {filters.userId && (
          <>
            {stats && (
              <div className="stats-row">
                <div className="stat-pill">
                  <span className="stat-num">{stats.total_screenshots || 0}</span>
                  <span className="stat-txt">Total</span>
                </div>
                <div className="stat-pill flagged">
                  <span className="stat-num">{stats.flagged_screenshots || 0}</span>
                  <span className="stat-txt">Flagged</span>
                </div>
              </div>
            )}

            <div className="filters-section">
              <div className="filter-group">
                <label>Start Date</label>
                <input
                  type="date"
                  value={filters.startDate}
                  onChange={(e) => handleFilterChange('startDate', e.target.value)}
                />
              </div>

              <div className="filter-group">
                <label>Start Time</label>
                <input
                  type="time"
                  value={filters.startTime}
                  onChange={(e) => handleFilterChange('startTime', e.target.value)}
                />
              </div>

              <div className="filter-group">
                <label>End Date</label>
                <input
                  type="date"
                  value={filters.endDate}
                  onChange={(e) => handleFilterChange('endDate', e.target.value)}
                />
              </div>

              <div className="filter-group">
                <label>End Time</label>
                <input
                  type="time"
                  value={filters.endTime}
                  onChange={(e) => handleFilterChange('endTime', e.target.value)}
                />
              </div>

              <div className="filter-group">
                <label>Interval</label>
                <select
                  value={filters.interval}
                  onChange={(e) => handleFilterChange('interval', e.target.value)}
                >
                  {INTERVAL_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              <div className="filter-group">
                <label>Status</label>
                <select
                  value={filters.flagged}
                  onChange={(e) => handleFilterChange('flagged', e.target.value)}
                >
                  <option value="">All</option>
                  <option value="true">Flagged Only</option>
                  <option value="false">Not Flagged</option>
                </select>
              </div>

              <button className="refresh-btn" onClick={fetchData}>
                Refresh
              </button>
            </div>

            {loading ? (
              <div className="loading">Loading screenshots...</div>
            ) : (
              <div className="screenshots-grid">
                {screenshots.length === 0 ? (
                  <div className="no-data">No screenshots found for the selected filters</div>
                ) : (
                  screenshots.map((screenshot, index) => (
                    <div key={screenshot.id} className="screenshot-card" onClick={() => viewScreenshot(screenshot, index)}>
                      <div className="screenshot-thumbnail">
                        <img src={getImageUrl(screenshot)} alt="Screenshot" loading="lazy" />
                        {screenshot.is_flagged && <div className="flag-badge">Flagged</div>}
                      </div>
                      <div className="screenshot-info">
                        <span>{format(new Date(screenshot.captured_at), 'MMM dd, HH:mm')}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </>
        )}

        {!filters.userId && (
          <div className="select-user-prompt">
            <div className="prompt-icon">👆</div>
            <h3>Select an Employee</h3>
            <p>Search and select an employee above to view their screenshots</p>
          </div>
        )}

        {/* Screenshot Detail Modal */}
        {selectedScreenshot && (
          <div className="modal-overlay" onClick={() => setSelectedScreenshot(null)}>
            <div className="screenshot-modal" onClick={(e) => e.stopPropagation()}>
              <button className="modal-close" onClick={() => setSelectedScreenshot(null)}>×</button>

              {/* Navigation Arrows */}
              {currentIndex > 0 && (
                <button className="nav-arrow nav-prev" onClick={(e) => { e.stopPropagation(); navigateScreenshot(-1); }}>
                  ‹
                </button>
              )}
              {currentIndex < screenshots.length - 1 && (
                <button className="nav-arrow nav-next" onClick={(e) => { e.stopPropagation(); navigateScreenshot(1); }}>
                  ›
                </button>
              )}

              <div className="modal-layout">
                <div className="modal-image-section">
                  <img
                    src={getFullImageUrl(selectedScreenshot)}
                    alt="Screenshot"
                    className="modal-screenshot"
                    onClick={() => setEnlargedImage(getFullImageUrl(selectedScreenshot))}
                    title="Click to enlarge"
                  />
                  <div className="modal-footer">
                    <span className="enlarge-hint">Click image to enlarge</span>
                    <span className="nav-hint">Use ← → arrow keys to navigate</span>
                    <span className="screenshot-counter">{currentIndex + 1} / {screenshots.length}</span>
                  </div>
                </div>

                <div className="modal-info-section">
                  <h3>Screenshot Details</h3>

                  <div className="info-list">
                    <div className="info-item">
                      <label>Employee</label>
                      <span>{selectedScreenshot.full_name}</span>
                    </div>
                    <div className="info-item">
                      <label>Email</label>
                      <span>{selectedScreenshot.email}</span>
                    </div>
                    <div className="info-item">
                      <label>Captured</label>
                      <span>{format(new Date(selectedScreenshot.captured_at), 'PPpp')}</span>
                    </div>
                    <div className="info-item">
                      <label>Team</label>
                      <span>{selectedScreenshot.team_name || 'N/A'}</span>
                    </div>
                    <div className="info-item">
                      <label>Status</label>
                      <span className={`status-badge ${selectedScreenshot.is_flagged ? 'flagged' : 'normal'}`}>
                        {selectedScreenshot.is_flagged ? 'Flagged' : 'Normal'}
                      </span>
                    </div>
                    {selectedScreenshot.is_flagged && selectedScreenshot.flag_reason && (
                      <div className="info-item">
                        <label>Reason</label>
                        <span>{selectedScreenshot.flag_reason}</span>
                      </div>
                    )}
                  </div>

                  <div className="modal-actions">
                    <button
                      className="download-btn"
                      onClick={async () => {
                        try {
                          const imgUrl = getFullImageUrl(selectedScreenshot);
                          const response = await fetch(imgUrl);
                          const blob = await response.blob();
                          const timestamp = format(new Date(selectedScreenshot.captured_at), 'yyyy-MM-dd_HH-mm-ss');
                          const username = selectedScreenshot.full_name.replace(/\s+/g, '_');
                          const filename = `${username}_${timestamp}.png`;
                          const url = window.URL.createObjectURL(blob);
                          const link = document.createElement('a');
                          link.href = url;
                          link.download = filename;
                          link.click();
                          window.URL.revokeObjectURL(url);
                        } catch (err) {
                          console.error('Download failed:', err);
                          alert('Failed to download screenshot');
                        }
                      }}
                    >
                      Download Screenshot
                    </button>
                  </div>

                  {user.role === 'admin' && (
                    <div className="modal-actions admin-actions">
                      {!selectedScreenshot.is_flagged ? (
                        <button
                          className="flag-btn"
                          onClick={() => {
                            const reason = prompt('Enter reason for flagging:');
                            if (reason) {
                              handleFlagScreenshot(selectedScreenshot.id, true, reason);
                            }
                          }}
                        >
                          Flag Screenshot
                        </button>
                      ) : (
                        <button
                          className="unflag-btn"
                          onClick={() => handleFlagScreenshot(selectedScreenshot.id, false, null)}
                        >
                          Remove Flag
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Full Screen Image Viewer */}
        {enlargedImage && (
          <div className="lightbox" onClick={() => setEnlargedImage(null)}>
            <button className="lightbox-close" onClick={() => setEnlargedImage(null)}>×</button>
            <img src={enlargedImage} alt="Full size screenshot" />
          </div>
        )}
      </div>
    </div>
  );
}

export default Screenshots;
