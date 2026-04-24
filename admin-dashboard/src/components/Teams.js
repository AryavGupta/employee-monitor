import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import axios from 'axios';
import Sidebar from './Sidebar';
import Toast from './Toast';
import { useUsers } from '../hooks/useUsers';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';
import { getStatusColor as sharedStatusColor } from '../utils/statusHelpers';
import './Teams.css';

const API_URL = process.env.REACT_APP_API_URL || '';
const STORAGE_KEY = 'teams_selectedTeamId';

function Teams({ user, onLogout }) {
  const { users: allUsers } = useUsers();
  const [teams, setTeams] = useState([]);
  const [unassignedUsers, setUnassignedUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedTeam, setSelectedTeam] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showAddMemberModal, setShowAddMemberModal] = useState(false);
  const [editingTeam, setEditingTeam] = useState(null);
  const [memberSearch, setMemberSearch] = useState('');
  const [removingMember, setRemovingMember] = useState(null);
  const [toast, setToast] = useState({ message: '', type: 'success' });
  useBodyScrollLock(showCreateModal || showAddMemberModal || !!editingTeam || !!removingMember);

  useEffect(() => {
    const handleEsc = (e) => {
      if (e.key === 'Escape') {
        if (removingMember) setRemovingMember(null);
        else if (showCreateModal) setShowCreateModal(false);
        else if (editingTeam) setEditingTeam(null);
        else if (showAddMemberModal) { setShowAddMemberModal(false); setMemberSearch(''); }
      }
    };
    if (showCreateModal || editingTeam || showAddMemberModal || removingMember) {
      document.addEventListener('keydown', handleEsc);
      return () => document.removeEventListener('keydown', handleEsc);
    }
  }, [showCreateModal, editingTeam, showAddMemberModal, removingMember]);

  // Create form defaults: text fields empty (admin fills per-team), numeric
  // intervals empty (server applies schema defaults), tracking checkboxes all
  // on, standard 9-5 working hours. Don't inherit values from a previous Edit
  // (that would persist after closing Edit without saving, then opening Create).
  const emptyFormData = {
    name: '', description: '', manager_id: '',
    screenshot_interval: 60, activity_interval: 10, idle_threshold: 300,
    track_urls: true, track_applications: true, track_keyboard_mouse: true,
    working_hours_start: '09:00', working_hours_end: '17:00', track_outside_hours: true
  };
  const [formData, setFormData] = useState(emptyFormData);
  const [teamSearch, setTeamSearch] = useState('');
  const initialLoadDone = useRef(false);

  // Filter teams by name (case-insensitive). Computed once per teams/teamSearch change.
  const filteredTeams = useMemo(() => {
    const q = teamSearch.trim().toLowerCase();
    if (!q) return teams;
    return teams.filter(t => (t.name || '').toLowerCase().includes(q));
  }, [teams, teamSearch]);

  const filteredUnassigned = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return unassignedUsers;
    return unassignedUsers.filter(u =>
      (u.full_name || '').toLowerCase().includes(q) ||
      (u.email || '').toLowerCase().includes(q)
    );
  }, [unassignedUsers, memberSearch]);

  const avatarColors = ['#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#3B82F6', '#EF4444', '#14B8A6', '#F97316'];
  const getAvatarColor = (name) => {
    let hash = 0;
    for (let i = 0; i < (name || '').length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return avatarColors[Math.abs(hash) % avatarColors.length];
  };

  const showToast = (message, type = 'success') => setToast({ message, type });

  const fetchTeams = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_URL}/api/teams`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.data.success) {
        setTeams(response.data.data);
        return response.data.data;
      }
    } catch (error) {
      console.error('Error fetching teams:', error);
    } finally {
      setLoading(false);
    }
    return [];
  }, []);

  const fetchUnassignedUsers = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_URL}/api/teams/unassigned/users`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.data.success) {
        setUnassignedUsers(response.data.data);
      }
    } catch (error) {
      console.error('Error fetching unassigned users:', error);
    }
  }, []);

  // Optimistic render: paint header/description/counts from the list row
  // immediately on click, then swap in full members+settings when the
  // detail fetch returns. Avoids the 2s "blank panel" pause on Vercel.
  const fetchTeamDetails = useCallback(async (teamId, saveToStorage = true) => {
    setSelectedTeam(prev => {
      // If we already have fully-loaded details for this team, keep them
      // (prevents flicker on re-click) and still let the background fetch refresh presence.
      if (prev?.id === teamId && prev.members) return prev;
      const fromList = teams.find(t => t.id === teamId);
      return fromList ? { ...fromList, members: null, settings: null, _loading: true } : prev;
    });

    try {
      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_URL}/api/teams/${teamId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.data.success) {
        setSelectedTeam(response.data.data);
        if (saveToStorage) {
          sessionStorage.setItem(STORAGE_KEY, teamId);
        }
      }
    } catch (error) {
      console.error('Error fetching team details:', error);
      sessionStorage.removeItem(STORAGE_KEY);
    }
  }, [teams]);

  // Initial load - restore selected team from storage
  useEffect(() => {
    const initializeData = async () => {
      const [teamsData] = await Promise.all([fetchTeams(), fetchUnassignedUsers()]);

      // Restore selected team if stored
      if (!initialLoadDone.current) {
        const storedTeamId = sessionStorage.getItem(STORAGE_KEY);
        if (storedTeamId && teamsData.some(t => t.id === storedTeamId)) {
          fetchTeamDetails(storedTeamId, false);
        }
        initialLoadDone.current = true;
      }
    };
    initializeData();
  }, [fetchTeams, fetchUnassignedUsers, fetchTeamDetails]);

  const handleCreateTeam = async (e) => {
    e.preventDefault();
    try {
      const token = localStorage.getItem('token');
      const headers = { Authorization: `Bearer ${token}` };
      const response = await axios.post(`${API_URL}/api/teams`, {
        name: formData.name,
        description: formData.description
      }, { headers });
      if (response.data.success) {
        const teamId = response.data.data.id;
        // Build settings payload from ONLY the fields the admin filled. Empty
        // numeric inputs / unset working hours are omitted so the server's
        // schema defaults apply. Booleans are always sent (unchecked is a
        // deliberate choice, not an unset).
        const settingsPayload = {
          track_urls: formData.track_urls,
          track_applications: formData.track_applications,
          track_keyboard_mouse: formData.track_keyboard_mouse,
          track_outside_hours: formData.track_outside_hours
        };
        if (formData.screenshot_interval !== '') settingsPayload.screenshot_interval = Number(formData.screenshot_interval);
        if (formData.activity_interval !== '') settingsPayload.activity_interval = Number(formData.activity_interval);
        if (formData.idle_threshold !== '') settingsPayload.idle_threshold = Number(formData.idle_threshold);
        if (formData.working_hours_start) settingsPayload.working_hours_start = formData.working_hours_start;
        if (formData.working_hours_end) settingsPayload.working_hours_end = formData.working_hours_end;
        await axios.put(`${API_URL}/api/teams/${teamId}/settings`, settingsPayload, { headers });
        setShowCreateModal(false);
        setFormData(emptyFormData);
        fetchTeams();
      }
    } catch (error) {
      showToast(error.response?.data?.message || 'Failed to create team', 'error');
    }
  };

  const handleUpdateTeam = async (e) => {
    e.preventDefault();
    try {
      const token = localStorage.getItem('token');
      const headers = { Authorization: `Bearer ${token}` };
      const teamId = editingTeam.id;
      await Promise.all([
        axios.patch(`${API_URL}/api/teams/${teamId}`, {
          name: formData.name,
          description: formData.description,
          manager_id: formData.manager_id || null
        }, { headers }),
        axios.put(`${API_URL}/api/teams/${teamId}/settings`, (() => {
          // Mirror Create: omit fields the admin cleared so the server keeps
          // its previous value or applies its schema default.
          const p = {
            track_urls: formData.track_urls,
            track_applications: formData.track_applications,
            track_keyboard_mouse: formData.track_keyboard_mouse,
            track_outside_hours: formData.track_outside_hours
          };
          if (formData.screenshot_interval !== '') p.screenshot_interval = Number(formData.screenshot_interval);
          if (formData.activity_interval !== '') p.activity_interval = Number(formData.activity_interval);
          if (formData.idle_threshold !== '') p.idle_threshold = Number(formData.idle_threshold);
          if (formData.working_hours_start) p.working_hours_start = formData.working_hours_start;
          if (formData.working_hours_end) p.working_hours_end = formData.working_hours_end;
          return p;
        })(), { headers })
      ]);
      setEditingTeam(null);
      setFormData(emptyFormData);
      const promises = [fetchTeams()];
      if (selectedTeam?.id === teamId) {
        promises.push(fetchTeamDetails(teamId));
      }
      await Promise.all(promises);
      showToast('Team settings updated successfully', 'success');
    } catch (error) {
      showToast(error.response?.data?.message || 'Failed to update team', 'error');
    }
  };

  const handleDeleteTeam = async (teamId) => {
    if (!window.confirm('Are you sure you want to delete this team?')) return;
    try {
      const token = localStorage.getItem('token');
      const response = await axios.delete(`${API_URL}/api/teams/${teamId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.data.success) {
        fetchTeams();
        if (selectedTeam?.id === teamId) {
          setSelectedTeam(null);
        }
        showToast('Team deleted successfully', 'warning');
      }
    } catch (error) {
      showToast(error.response?.data?.message || 'Failed to delete team', 'error');
    }
  };

  const handleAddMember = async (userId) => {
    const addedUser = unassignedUsers.find(u => u.id === userId);
    try {
      const token = localStorage.getItem('token');
      await axios.post(
        `${API_URL}/api/teams/${selectedTeam.id}/members`,
        { user_id: userId },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      await Promise.all([
        fetchTeamDetails(selectedTeam.id),
        fetchUnassignedUsers(),
        fetchTeams()
      ]);
      showToast(`${addedUser?.full_name || 'Member'} added to the team`, 'info');
    } catch (error) {
      showToast(error.response?.data?.message || 'Failed to add member', 'error');
    }
  };

  const confirmRemoveMember = (member) => {
    setRemovingMember(member);
  };

  const handleRemoveMember = async () => {
    if (!removingMember) return;
    const memberName = removingMember.full_name;
    try {
      const token = localStorage.getItem('token');
      await axios.delete(`${API_URL}/api/teams/${selectedTeam.id}/members/${removingMember.id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setRemovingMember(null);
      await Promise.all([
        fetchTeamDetails(selectedTeam.id),
        fetchUnassignedUsers(),
        fetchTeams()
      ]);
      showToast(`${memberName} removed from team`, 'warning');
    } catch (error) {
      setRemovingMember(null);
      showToast(error.response?.data?.message || 'Failed to remove member', 'error');
    }
  };

  const openEditModal = async (team) => {
    try {
      const token = localStorage.getItem('token');
      const settingsRes = await axios.get(`${API_URL}/api/teams/${team.id}/settings`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const s = settingsRes.data.success ? settingsRes.data.data : {};
      setEditingTeam(team);
      setFormData({
        name: team.name,
        description: team.description || '',
        manager_id: team.manager_id || '',
        screenshot_interval: s.screenshot_interval ?? 60,
        activity_interval: s.activity_interval ?? 10,
        idle_threshold: s.idle_threshold ?? 300,
        track_urls: s.track_urls !== false,
        track_applications: s.track_applications !== false,
        track_keyboard_mouse: s.track_keyboard_mouse !== false,
        working_hours_start: s.working_hours_start || '',
        working_hours_end: s.working_hours_end || '',
        track_outside_hours: !!s.track_outside_hours
      });
    } catch (error) {
      console.error('Error loading team settings:', error);
      showToast('Failed to load team settings', 'error');
    }
  };

  const openAddMemberModal = (team) => {
    setSelectedTeam(team);
    setMemberSearch('');
    fetchUnassignedUsers();
    setShowAddMemberModal(true);
  };

  const getStatusColor = sharedStatusColor;

  if (user.role !== 'admin' && user.role !== 'team_manager') {
    return (
      <div className="app-layout">
        <Sidebar user={user} onLogout={onLogout} activePage="teams" />
        <div className="main-content">
          <div className="access-denied">
            <h2>Access Denied</h2>
            <p>Only administrators and team managers can view teams.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-layout">
      <Sidebar user={user} onLogout={onLogout} activePage="teams" />

      <div className="main-content">
        <div className="content-header">
          <div>
            <h1>Teams</h1>
            <p className="content-subtitle">{user.role === 'admin' ? 'Manage teams and their monitoring settings' : 'View your managed teams'}</p>
          </div>
          {user.role === 'admin' && (
            <button className="btn-primary" onClick={() => { setFormData(emptyFormData); setShowCreateModal(true); }}>
              + Create Team
            </button>
          )}
        </div>

        {loading ? (
          <div className="loading">Loading teams...</div>
        ) : (
          <div className="teams-layout">
            {/* Teams List */}
            <div className="teams-list-panel">
              <h3>All Teams ({filteredTeams.length}{teamSearch ? ` of ${teams.length}` : ''})</h3>
              <div className="teams-search">
                <input
                  type="text"
                  placeholder="Search teams..."
                  value={teamSearch}
                  onChange={e => setTeamSearch(e.target.value)}
                />
              </div>
              <div className="teams-list">
                {teams.length === 0 ? (
                  <div className="empty-state">No teams created yet</div>
                ) : filteredTeams.length === 0 ? (
                  <div className="empty-state">No teams match "{teamSearch}"</div>
                ) : (
                  filteredTeams.map(team => (
                    <div
                      key={team.id}
                      className={`team-card ${selectedTeam?.id === team.id ? 'selected' : ''}`}
                      onClick={() => fetchTeamDetails(team.id)}
                    >
                      <div className="team-card-header">
                        <h4>{team.name}</h4>
                        <span className="member-badge">{team.member_count} members</span>
                      </div>
                      {team.description && (
                        <p className="team-description">{team.description}</p>
                      )}
                      <div className="team-card-footer">
                        <span className="online-indicator">
                          <span className="dot" style={{ backgroundColor: '#22c55e' }}></span>
                          {team.online_count} online
                        </span>
                        {team.manager_name && (
                          <span className="manager-name">Mgr: {team.manager_name}</span>
                        )}
                      </div>
                      {user.role === 'admin' && (
                        <div className="team-actions">
                          <button onClick={(e) => { e.stopPropagation(); openEditModal(team); }}>Edit</button>
                          <button
                            className="delete-btn"
                            onClick={(e) => { e.stopPropagation(); handleDeleteTeam(team.id); }}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Team Details */}
            <div className="team-details-panel">
              {selectedTeam ? (
                <>
                  <div className="panel-header">
                    <h3>{selectedTeam.name}</h3>
                    {user.role === 'admin' && (
                      <button
                        className="btn-add-member"
                        onClick={() => openAddMemberModal(selectedTeam)}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                        </svg>
                        Add Member
                      </button>
                    )}
                  </div>

                  {selectedTeam.description && (
                    <p className="team-full-description">{selectedTeam.description}</p>
                  )}

                  <div className="team-stats">
                    <div className="stat-item">
                      <span className="stat-value">{selectedTeam.members?.length ?? selectedTeam.member_count ?? '—'}</span>
                      <span className="stat-label">Total Members</span>
                    </div>
                    <div className="stat-item">
                      <span className="stat-value">
                        {selectedTeam.members
                          ? selectedTeam.members.filter(m => m.presence_status === 'online').length
                          : (selectedTeam.online_count ?? '—')}
                      </span>
                      <span className="stat-label">Online Now</span>
                    </div>
                    <div className="stat-item">
                      <span className="stat-value">
                        {selectedTeam.members ? selectedTeam.members.filter(m => m.is_active).length : '—'}
                      </span>
                      <span className="stat-label">Active</span>
                    </div>
                  </div>

                  <h4>Team Members</h4>
                  <div className="members-list">
                    {selectedTeam._loading || !selectedTeam.members ? (
                      <div className="empty-state">Loading members…</div>
                    ) : selectedTeam.members.length === 0 ? (
                      <div className="empty-state">No members in this team</div>
                    ) : (
                      <>
                        <div className="member-row member-header">
                          <div className="member-col-name">Name</div>
                          <div className="member-col-email">Email</div>
                          <div className="member-col-role">Role</div>
                          <div className="member-col-action">Action</div>
                        </div>
                        {selectedTeam.members.map(member => (
                          <div key={member.id} className="member-row">
                            <div className="member-col-name">
                              <span
                                className="member-avatar"
                                style={{ backgroundColor: getStatusColor(member.presence_status) }}
                              >
                                {member.full_name?.charAt(0).toUpperCase()}
                              </span>
                              <div className="member-name-wrap">
                                <strong>{member.full_name}</strong>
                                {member.current_application && (
                                  <span className="current-app">{member.current_application}</span>
                                )}
                              </div>
                            </div>
                            <div className="member-col-email">{member.email}</div>
                            <div className="member-col-role">
                              <span className={`role-badge ${member.role}`}>{member.role}</span>
                            </div>
                            <div className="member-col-action">
                              {user.role === 'admin' && (
                                <button
                                  className="remove-btn"
                                  onClick={() => confirmRemoveMember(member)}
                                >
                                  Remove
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                </>
              ) : (
                <div className="empty-state">
                  <p>Select a team to view details</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Create Team Modal — all-in-one, no Manager */}
        {showCreateModal && (
          <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
            <div className="modal modal-large" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <div className="modal-header-left">
                  <h2>Create New Team</h2>
                  <p>Set up a new team with monitoring configuration</p>
                </div>
                <button type="button" className="modal-close-btn" onClick={() => setShowCreateModal(false)}>&times;</button>
              </div>
              <form onSubmit={handleCreateTeam}>
                <div className="modal-section">
                  <h4 className="section-title">Basic Information</h4>
                  <div className="form-group">
                    <label>Team Name *</label>
                    <input type="text" value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} required />
                  </div>
                  <div className="form-group">
                    <label>Description</label>
                    <textarea value={formData.description} onChange={e => setFormData({ ...formData, description: e.target.value })} rows="2" />
                  </div>
                </div>

                <div className="modal-section">
                  <h4 className="section-title">Working Hours</h4>
                  <div className="time-inputs">
                    <div className="form-group">
                      <label>Start Time</label>
                      <input type="time" value={formData.working_hours_start} onChange={e => setFormData({ ...formData, working_hours_start: e.target.value })} />
                    </div>
                    <div className="form-group">
                      <label>End Time</label>
                      <input type="time" value={formData.working_hours_end} onChange={e => setFormData({ ...formData, working_hours_end: e.target.value })} />
                    </div>
                  </div>
                </div>

                <div className="modal-section">
                  <h4 className="section-title">Monitoring</h4>
                  <div className="settings-grid">
                    <div className="form-group">
                      <label>Screenshot Interval (s)</label>
                      <input type="number" min="30" max="600" value={formData.screenshot_interval} onChange={e => setFormData({ ...formData, screenshot_interval: e.target.value })} />
                      <small>30–600 seconds</small>
                    </div>
                    <div className="form-group">
                      <label>Activity Interval (s)</label>
                      <input type="number" min="5" max="60" value={formData.activity_interval} onChange={e => setFormData({ ...formData, activity_interval: e.target.value })} />
                      <small>5–60 seconds</small>
                    </div>
                    <div className="form-group">
                      <label>Idle Threshold (s)</label>
                      <input type="number" min="60" max="1800" value={formData.idle_threshold} onChange={e => setFormData({ ...formData, idle_threshold: e.target.value })} />
                      <small>60–1800 seconds</small>
                    </div>
                  </div>
                </div>

                <div className="modal-section">
                  <h4 className="section-title">Tracking Options</h4>
                  <div className="checkbox-group">
                    <label><input type="checkbox" checked={formData.track_urls} onChange={e => setFormData({ ...formData, track_urls: e.target.checked })} /> Track URLs/Websites</label>
                    <label><input type="checkbox" checked={formData.track_applications} onChange={e => setFormData({ ...formData, track_applications: e.target.checked })} /> Track Applications</label>
                    <label><input type="checkbox" checked={formData.track_keyboard_mouse} onChange={e => setFormData({ ...formData, track_keyboard_mouse: e.target.checked })} /> Track Keyboard/Mouse Activity</label>
                  </div>
                </div>

                <div className="modal-section">
                  <h4 className="section-title">Extra Hours</h4>
                  <label className="checkbox-label">
                    <input type="checkbox" checked={formData.track_outside_hours} onChange={e => setFormData({ ...formData, track_outside_hours: e.target.checked })} />
                    <span>Allow tracking outside working hours</span>
                  </label>
                  <p className="settings-help">Continues capturing after shift ends, tagged as Extra Hours.</p>
                </div>

                <div className="modal-actions">
                  <button type="button" onClick={() => setShowCreateModal(false)}>Cancel</button>
                  <button type="submit" className="btn-primary">Create Team</button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Edit Team Modal — combined Edit + Settings, includes Manager */}
        {editingTeam && (
          <div className="modal-overlay" onClick={() => setEditingTeam(null)}>
            <div className="modal modal-large" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <div className="modal-header-left">
                  <h2>Edit Team</h2>
                  <p>Update team settings and monitoring configuration</p>
                </div>
                <button type="button" className="modal-close-btn" onClick={() => setEditingTeam(null)}>&times;</button>
              </div>
              <form onSubmit={handleUpdateTeam}>
                <div className="modal-section">
                  <h4 className="section-title">Basic Information</h4>
                  <div className="form-group">
                    <label>Team Name *</label>
                    <input type="text" value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} required />
                  </div>
                  <div className="form-group">
                    <label>Description</label>
                    <textarea value={formData.description} onChange={e => setFormData({ ...formData, description: e.target.value })} rows="2" />
                  </div>
                  <div className="form-group">
                    <label>Team Manager</label>
                    <select value={formData.manager_id} onChange={e => setFormData({ ...formData, manager_id: e.target.value })}>
                      <option value="">Select Manager</option>
                      {allUsers.filter(u => u.role === 'admin' || u.role === 'manager').map(u => (
                        <option key={u.id} value={u.id}>{u.full_name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="modal-section">
                  <h4 className="section-title">Working Hours</h4>
                  <div className="time-inputs">
                    <div className="form-group">
                      <label>Start Time</label>
                      <input type="time" value={formData.working_hours_start} onChange={e => setFormData({ ...formData, working_hours_start: e.target.value })} />
                    </div>
                    <div className="form-group">
                      <label>End Time</label>
                      <input type="time" value={formData.working_hours_end} onChange={e => setFormData({ ...formData, working_hours_end: e.target.value })} />
                    </div>
                  </div>
                </div>

                <div className="modal-section">
                  <h4 className="section-title">Monitoring</h4>
                  <div className="settings-grid">
                    <div className="form-group">
                      <label>Screenshot Interval (s)</label>
                      <input type="number" min="30" max="600" value={formData.screenshot_interval} onChange={e => setFormData({ ...formData, screenshot_interval: e.target.value })} />
                      <small>30–600 seconds</small>
                    </div>
                    <div className="form-group">
                      <label>Activity Interval (s)</label>
                      <input type="number" min="5" max="60" value={formData.activity_interval} onChange={e => setFormData({ ...formData, activity_interval: e.target.value })} />
                      <small>5–60 seconds</small>
                    </div>
                    <div className="form-group">
                      <label>Idle Threshold (s)</label>
                      <input type="number" min="60" max="1800" value={formData.idle_threshold} onChange={e => setFormData({ ...formData, idle_threshold: e.target.value })} />
                      <small>60–1800 seconds</small>
                    </div>
                  </div>
                </div>

                <div className="modal-section">
                  <h4 className="section-title">Tracking Options</h4>
                  <div className="checkbox-group">
                    <label><input type="checkbox" checked={formData.track_urls} onChange={e => setFormData({ ...formData, track_urls: e.target.checked })} /> Track URLs/Websites</label>
                    <label><input type="checkbox" checked={formData.track_applications} onChange={e => setFormData({ ...formData, track_applications: e.target.checked })} /> Track Applications</label>
                    <label><input type="checkbox" checked={formData.track_keyboard_mouse} onChange={e => setFormData({ ...formData, track_keyboard_mouse: e.target.checked })} /> Track Keyboard/Mouse Activity</label>
                  </div>
                </div>

                <div className="modal-section">
                  <h4 className="section-title">Extra Hours</h4>
                  <label className="checkbox-label">
                    <input type="checkbox" checked={formData.track_outside_hours} onChange={e => setFormData({ ...formData, track_outside_hours: e.target.checked })} />
                    <span>Allow tracking outside working hours</span>
                  </label>
                  <p className="settings-help">Continues capturing after shift ends, tagged as Extra Hours.</p>
                </div>

                <div className="modal-actions">
                  <button type="button" onClick={() => setEditingTeam(null)}>Cancel</button>
                  <button type="submit" className="btn-primary">Save Changes</button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Add Member Modal */}
        {showAddMemberModal && (
          <div className="modal-overlay" onClick={() => { setShowAddMemberModal(false); setMemberSearch(''); }}>
            <div className="modal add-member-modal" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <div className="modal-header-left">
                  <h2>Add Members</h2>
                  <p>Add members to {selectedTeam?.name}</p>
                </div>
                <button type="button" className="modal-close-btn" onClick={() => { setShowAddMemberModal(false); setMemberSearch(''); }}>&times;</button>
              </div>
              <div className="add-member-search">
                <div className="search-input-wrap">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                  <input
                    type="text"
                    placeholder="Search users by name or email..."
                    value={memberSearch}
                    onChange={e => setMemberSearch(e.target.value)}
                    autoFocus
                  />
                </div>
                <span className="user-count">{filteredUnassigned.length} unassigned user{filteredUnassigned.length !== 1 ? 's' : ''} available</span>
              </div>
              <div className="unassigned-users-list">
                {filteredUnassigned.length === 0 ? (
                  <div className="empty-state">{memberSearch ? 'No users match your search' : 'No unassigned users available'}</div>
                ) : (
                  filteredUnassigned.map(u => (
                    <div key={u.id} className="unassigned-user-item">
                      <div className="user-info-row">
                        <span className="user-avatar-sm" style={{ backgroundColor: getAvatarColor(u.full_name) }}>
                          {(u.full_name || '?').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                        </span>
                        <div className="user-info">
                          <strong>{u.full_name}</strong>
                          <span>{u.email}</span>
                        </div>
                      </div>
                      <button className="btn-add-sm" onClick={() => handleAddMember(u.id)}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        Add
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div className="modal-actions">
                <button type="button" onClick={() => { setShowAddMemberModal(false); setMemberSearch(''); }}>Close</button>
              </div>
            </div>
          </div>
        )}

        {/* Remove Member Confirmation */}
        {removingMember && (
          <div className="modal-overlay" onClick={() => setRemovingMember(null)}>
            <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
              <div className="confirm-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>
                </svg>
              </div>
              <h3>Remove Team Member</h3>
              <p>Are you sure you want to remove <strong>{removingMember.full_name}</strong> from <strong>{selectedTeam?.name}</strong>? This action cannot be undone.</p>
              <div className="confirm-actions">
                <button className="btn-secondary" onClick={() => setRemovingMember(null)}>Cancel</button>
                <button className="btn-danger" onClick={handleRemoveMember}>Remove Member</button>
              </div>
            </div>
          </div>
        )}

        <Toast message={toast.message} type={toast.type} onClose={() => setToast({ message: '', type: 'success' })} />
      </div>
    </div>
  );
}

export default Teams;
