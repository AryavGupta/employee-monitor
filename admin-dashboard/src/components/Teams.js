import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import axios from 'axios';
import Sidebar from './Sidebar';
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
  useBodyScrollLock(showCreateModal || showAddMemberModal || !!editingTeam);
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
      alert(error.response?.data?.message || 'Failed to create team');
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
    } catch (error) {
      alert(error.response?.data?.message || 'Failed to update team');
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
      }
    } catch (error) {
      alert(error.response?.data?.message || 'Failed to delete team');
    }
  };

  const handleAddMember = async (userId) => {
    try {
      const token = localStorage.getItem('token');
      await axios.post(
        `${API_URL}/api/teams/${selectedTeam.id}/members`,
        { user_id: userId },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      // Parallel refetch instead of 3 sequential calls
      await Promise.all([
        fetchTeamDetails(selectedTeam.id),
        fetchUnassignedUsers(),
        fetchTeams()
      ]);
    } catch (error) {
      alert(error.response?.data?.message || 'Failed to add member');
    }
  };

  const handleRemoveMember = async (userId) => {
    if (!window.confirm('Remove this member from the team?')) return;
    try {
      const token = localStorage.getItem('token');
      await axios.delete(`${API_URL}/api/teams/${selectedTeam.id}/members/${userId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      // Parallel refetch instead of 2 sequential calls
      await Promise.all([
        fetchTeamDetails(selectedTeam.id),
        fetchTeams()
      ]);
    } catch (error) {
      alert(error.response?.data?.message || 'Failed to remove member');
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
      alert('Failed to load team settings');
    }
  };

  const openAddMemberModal = (team) => {
    setSelectedTeam(team);
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
                        className="btn-secondary"
                        onClick={() => openAddMemberModal(selectedTeam)}
                      >
                        + Add Member
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
                      selectedTeam.members.map(member => (
                        <div key={member.id} className="member-item">
                          <div className="member-status">
                            <span
                              className="status-dot"
                              style={{ backgroundColor: getStatusColor(member.presence_status) }}
                            ></span>
                          </div>
                          <div className="member-info">
                            <strong>{member.full_name}</strong>
                            <span className="member-email">{member.email}</span>
                            {member.current_application && (
                              <span className="current-app">{member.current_application}</span>
                            )}
                          </div>
                          <div className="member-meta">
                            <span className={`role-badge ${member.role}`}>{member.role}</span>
                            {user.role === 'admin' && (
                              <button
                                className="remove-btn"
                                onClick={() => handleRemoveMember(member.id)}
                              >
                                Remove
                              </button>
                            )}
                          </div>
                        </div>
                      ))
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
              <h2>Create New Team</h2>
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
              <h2>Edit Team — {editingTeam.name}</h2>
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
          <div className="modal-overlay" onClick={() => setShowAddMemberModal(false)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <h2>Add Members to {selectedTeam?.name}</h2>
              <div className="unassigned-users-list">
                {unassignedUsers.length === 0 ? (
                  <div className="empty-state">No unassigned users available</div>
                ) : (
                  unassignedUsers.map(u => (
                    <div key={u.id} className="unassigned-user-item">
                      <div className="user-info">
                        <strong>{u.full_name}</strong>
                        <span>{u.email}</span>
                      </div>
                      <button
                        className="btn-secondary"
                        onClick={() => handleAddMember(u.id)}
                      >
                        Add
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div className="modal-actions">
                <button type="button" onClick={() => setShowAddMemberModal(false)}>Close</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default Teams;
