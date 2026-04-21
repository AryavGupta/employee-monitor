import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import axios from 'axios';
import { format } from 'date-fns';
import Sidebar from './Sidebar';
import { useUsers, useFilteredUsers } from '../hooks/useUsers';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';
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
  const { users } = useUsers();
  const [screenshots, setScreenshots] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedScreenshot, setSelectedScreenshot] = useState(null);
  const [enlargedImage, setEnlargedImage] = useState(null);
  useBodyScrollLock(!!selectedScreenshot || !!enlargedImage);
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
  const [modalFullUrl, setModalFullUrl] = useState(null);
  const debounceTimer = useRef(null);
  const userDropdownRef = useRef(null);
  // Cache full-resolution URLs fetched on modal open, keyed by screenshot id.
  // Arrow-key navigation revisits the cache instead of re-hitting the API.
  const fullUrlCacheRef = useRef(new Map());

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

  // Debounced fetch for filter changes (only when user is selected).
  // Interval is filtered client-side via useMemo below, so changing it
  // should NOT trigger a refetch — only the displayed subset changes.
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
  }, [filters.userId, filters.startDate, filters.endDate, filters.startTime, filters.endTime, filters.flagged]);

  // Client-side interval filter. Keeps one screenshot per N-minute bucket
  // (aligned to epoch) so "every 5 min" actually means every 5 min of elapsed
  // time, not wall-clock :00/:05/:10 boundaries.
  const displayedScreenshots = useMemo(() => {
    const intervalMin = parseInt(filters.interval, 10);
    if (!intervalMin || intervalMin <= 0) return screenshots;
    const bucketMs = intervalMin * 60 * 1000;
    const seen = new Set();
    const kept = [];
    // screenshots come from the API sorted captured_at DESC; iterate in order
    // and keep the first (newest) per bucket.
    for (const s of screenshots) {
      const bucket = Math.floor(new Date(s.captured_at).getTime() / bucketMs);
      if (!seen.has(bucket)) {
        seen.add(bucket);
        kept.push(s);
      }
    }
    return kept;
  }, [screenshots, filters.interval]);

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
        } else if (e.key === 'ArrowRight' && currentIndex < displayedScreenshots.length - 1) {
          navigateScreenshot(1);
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [enlargedImage, selectedScreenshot, currentIndex, displayedScreenshots.length]);

  const navigateScreenshot = (direction) => {
    const newIndex = currentIndex + direction;
    if (newIndex >= 0 && newIndex < displayedScreenshots.length) {
      setCurrentIndex(newIndex);
      setSelectedScreenshot(displayedScreenshots[newIndex]);
    }
  };

  // Fetch full-resolution URL when the modal opens or navigates to a new
  // screenshot. The list endpoint no longer returns full_url to save bandwidth;
  // the full URL lives on GET /api/screenshots/:id. Results are cached by id so
  // arrow-key nav revisits previously-viewed frames instantly.
  useEffect(() => {
    if (!selectedScreenshot) {
      setModalFullUrl(null);
      return;
    }
    const id = selectedScreenshot.id;
    const cached = fullUrlCacheRef.current.get(id);
    if (cached) {
      setModalFullUrl(cached);
      return;
    }
    // Show the thumbnail immediately as a placeholder while the full loads.
    setModalFullUrl(null);
    let cancelled = false;
    (async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await axios.get(`${API_URL}/api/screenshots/${id}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (cancelled) return;
        if (res.data.success && res.data.data) {
          const url = res.data.data.screenshot_url;
          fullUrlCacheRef.current.set(id, url);
          setModalFullUrl(url);
        }
      } catch (err) {
        console.error('Failed to load full screenshot:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedScreenshot]);

  const fetchData = useCallback(async () => {
    if (!filters.userId) return;

    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const params = new URLSearchParams();

      params.append('userId', filters.userId);
      params.append('startDate', new Date(`${filters.startDate}T${filters.startTime}:00`).toISOString());
      params.append('endDate', new Date(`${filters.endDate}T${filters.endTime}:59`).toISOString());
      if (filters.flagged) params.append('flagged', filters.flagged);
      // interval is applied client-side via useMemo — do not send to the server
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

  // Get full resolution URL for modal view. Resolution order:
  //   1) modalFullUrl — the full URL fetched via GET /:id when the modal opened
  //   2) fullUrlCacheRef — a previously fetched URL for this same screenshot
  //   3) screenshot.screenshot_url — the thumbnail, used as an instant placeholder
  //      while (1) is still loading
  const getFullImageUrl = (screenshot) => {
    if (!screenshot) return '';
    const cached = fullUrlCacheRef.current.get(screenshot.id);
    const url = (selectedScreenshot && screenshot.id === selectedScreenshot.id && modalFullUrl)
      || cached
      || screenshot.screenshot_url;
    if (!url) return '';
    if (url.startsWith('data:') || url.startsWith('http')) {
      return url;
    }
    return `${API_URL}${url}`;
  };

  // Legacy function for backward compatibility
  const getImageUrl = getThumbnailUrl;

  const filteredUsers = useFilteredUsers(users, userSearch);

  return (
    <div className="app-layout">
      <Sidebar user={user} onLogout={onLogout} activePage="screenshots" />

      <div className="main-content">
        <div className="content-header">
          <div>
            <h1>Screenshots</h1>
            <p className="content-subtitle">View captured screenshots for the selected employees</p>
          </div>
          <div className="header-right">
            <span className="header-user-name">{filters.userName || user.fullName}</span>
            <div className="header-avatar">
              {(filters.userName || user.fullName)?.charAt(0).toUpperCase()}
            </div>
          </div>
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
              <div className="stats-tabs">
                <button
                  className={`stats-tab ${filters.flagged !== 'true' ? 'active' : ''}`}
                  onClick={() => handleFilterChange('flagged', '')}
                >
                  <span className="tab-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>
                  </span>
                  <strong>{stats.total_screenshots || 0}</strong> Total
                </button>
                <button
                  className={`stats-tab flagged ${filters.flagged === 'true' ? 'active' : ''}`}
                  onClick={() => handleFilterChange('flagged', filters.flagged === 'true' ? '' : 'true')}
                >
                  <span className="tab-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/></svg>
                  </span>
                  <strong>{stats.flagged_screenshots || 0}</strong> Flagged
                </button>
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

              <button className="btn-refresh" onClick={fetchData}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                Refresh
              </button>
            </div>

            {loading ? (
              <div className="loading">Loading screenshots...</div>
            ) : (
              <div className="screenshots-grid">
                {displayedScreenshots.length === 0 ? (
                  <div className="no-data">No screenshots found for the selected filters</div>
                ) : (
                  displayedScreenshots.map((screenshot, index) => (
                    <div key={screenshot.id} className="screenshot-card" onClick={() => viewScreenshot(screenshot, index)}>
                      <div className="screenshot-thumbnail">
                        <img src={getImageUrl(screenshot)} alt="Screenshot" loading="lazy" />
                        {screenshot.is_flagged && <div className="flag-badge">Flagged</div>}
                        <div className="screenshot-overlay">
                          <div className="overlay-user">
                            <div className="overlay-avatar">
                              {(screenshot.full_name || filters.userName)?.charAt(0).toUpperCase()}
                            </div>
                            <span>{screenshot.full_name || filters.userName}</span>
                          </div>
                          <span className="overlay-time">{format(new Date(screenshot.captured_at), 'h:mm a')}</span>
                        </div>
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
              {currentIndex < displayedScreenshots.length - 1 && (
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
                    onClick={() => setEnlargedImage(true)}
                    title="Click to enlarge"
                  />
                  <div className="modal-footer">
                    <span className="enlarge-hint">Click image to enlarge</span>
                    <span className="nav-hint">Use ← → arrow keys to navigate</span>
                    <span className="screenshot-counter">{currentIndex + 1} / {displayedScreenshots.length}</span>
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

        {/* Full Screen Image Viewer — reads URL live via getFullImageUrl so it
            upgrades from thumbnail → full-resolution as soon as the fetch lands */}
        {enlargedImage && selectedScreenshot && (
          <div className="lightbox" onClick={() => setEnlargedImage(null)}>
            <button className="lightbox-close" onClick={() => setEnlargedImage(null)}>×</button>
            <img src={getFullImageUrl(selectedScreenshot)} alt="Full size screenshot" />
          </div>
        )}
      </div>
    </div>
  );
}

export default Screenshots;
