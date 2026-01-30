import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { format } from 'date-fns';
import Sidebar from './Sidebar';
import './Teams.css';

const API_URL = process.env.REACT_APP_API_URL || '';
const STORAGE_KEY = 'teams_selectedTeamId';

function Teams({ user, onLogout }) {
  const [teams, setTeams] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [unassignedUsers, setUnassignedUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedTeam, setSelectedTeam] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showAddMemberModal, setShowAddMemberModal] = useState(false);
  const [editingTeam, setEditingTeam] = useState(null);
  const [formData, setFormData] = useState({ name: '', description: '', manager_id: '' });
  const [settingsData, setSettingsData] = useState({});
  const initialLoadDone = useRef(false);

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

  const fetchAllUsers = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_URL}/api/users`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.data.success) {
        setAllUsers(response.data.data);
      }
    } catch (error) {
      console.error('Error fetching users:', error);
    }
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

  const fetchTeamDetails = useCallback(async (teamId, saveToStorage = true) => {
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
  }, []);

  // Initial load - restore selected team from storage
  useEffect(() => {
    const initializeData = async () => {
      const [teamsData] = await Promise.all([fetchTeams(), fetchAllUsers()]);

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
  }, [fetchTeams, fetchAllUsers, fetchTeamDetails]);

  const handleCreateTeam = async (e) => {
    e.preventDefault();
    try {
      const token = localStorage.getItem('token');
      const response = await axios.post(`${API_URL}/api/teams`, formData, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.data.success) {
        setShowCreateModal(false);
        setFormData({ name: '', description: '', manager_id: '' });
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
      const response = await axios.patch(`${API_URL}/api/teams/${editingTeam.id}`, formData, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.data.success) {
        setEditingTeam(null);
        setFormData({ name: '', description: '', manager_id: '' });
        fetchTeams();
        if (selectedTeam?.id === editingTeam.id) {
          fetchTeamDetails(editingTeam.id);
        }
      }
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

  const handleOpenSettings = async (team) => {
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_URL}/api/teams/${team.id}/settings`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.data.success) {
        setSettingsData(response.data.data);
        // Only update selectedTeam if it's a different team, to preserve members data
        if (selectedTeam?.id !== team.id) {
          await fetchTeamDetails(team.id);
        }
        setShowSettingsModal(true);
      }
    } catch (error) {
      console.error('Error fetching settings:', error);
    }
  };

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    try {
      const token = localStorage.getItem('token');
      const response = await axios.put(
        `${API_URL}/api/teams/${selectedTeam.id}/settings`,
        settingsData,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (response.data.success) {
        setShowSettingsModal(false);
        alert('Settings saved successfully');
      }
    } catch (error) {
      alert(error.response?.data?.message || 'Failed to save settings');
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
      fetchTeamDetails(selectedTeam.id);
      fetchUnassignedUsers();
      fetchTeams();
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
      fetchTeamDetails(selectedTeam.id);
      fetchTeams();
    } catch (error) {
      alert(error.response?.data?.message || 'Failed to remove member');
    }
  };

  const openEditModal = (team) => {
    setEditingTeam(team);
    setFormData({
      name: team.name,
      description: team.description || '',
      manager_id: team.manager_id || ''
    });
  };

  const openAddMemberModal = (team) => {
    setSelectedTeam(team);
    fetchUnassignedUsers();
    setShowAddMemberModal(true);
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'online': return '#22c55e';
      case 'idle': return '#f59e0b';
      default: return '#6b7280';
    }
  };

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
            <p>{user.role === 'admin' ? 'Manage teams and their monitoring settings' : 'View your managed teams'}</p>
          </div>
          {user.role === 'admin' && (
            <button className="btn-primary" onClick={() => setShowCreateModal(true)}>
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
              <h3>All Teams ({teams.length})</h3>
              <div className="teams-list">
                {teams.length === 0 ? (
                  <div className="empty-state">No teams created yet</div>
                ) : (
                  teams.map(team => (
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
                          <button onClick={(e) => { e.stopPropagation(); handleOpenSettings(team); }}>Settings</button>
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
                      <span className="stat-value">{selectedTeam.members?.length || 0}</span>
                      <span className="stat-label">Total Members</span>
                    </div>
                    <div className="stat-item">
                      <span className="stat-value">
                        {selectedTeam.members?.filter(m => m.presence_status === 'online').length || 0}
                      </span>
                      <span className="stat-label">Online Now</span>
                    </div>
                    <div className="stat-item">
                      <span className="stat-value">
                        {selectedTeam.members?.filter(m => m.is_active).length || 0}
                      </span>
                      <span className="stat-label">Active</span>
                    </div>
                  </div>

                  <h4>Team Members</h4>
                  <div className="members-list">
                    {selectedTeam.members?.length === 0 ? (
                      <div className="empty-state">No members in this team</div>
                    ) : (
                      selectedTeam.members?.map(member => (
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

        {/* Create Team Modal */}
        {showCreateModal && (
          <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <h2>Create New Team</h2>
              <form onSubmit={handleCreateTeam}>
                <div className="form-group">
                  <label>Team Name *</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Description</label>
                  <textarea
                    value={formData.description}
                    onChange={e => setFormData({ ...formData, description: e.target.value })}
                    rows="3"
                  />
                </div>
                <div className="form-group">
                  <label>Team Manager</label>
                  <select
                    value={formData.manager_id}
                    onChange={e => setFormData({ ...formData, manager_id: e.target.value })}
                  >
                    <option value="">Select Manager</option>
                    {allUsers.filter(u => u.role === 'admin' || u.role === 'manager').map(u => (
                      <option key={u.id} value={u.id}>{u.full_name}</option>
                    ))}
                  </select>
                </div>
                <div className="modal-actions">
                  <button type="button" onClick={() => setShowCreateModal(false)}>Cancel</button>
                  <button type="submit" className="btn-primary">Create Team</button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Edit Team Modal */}
        {editingTeam && (
          <div className="modal-overlay" onClick={() => setEditingTeam(null)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <h2>Edit Team</h2>
              <form onSubmit={handleUpdateTeam}>
                <div className="form-group">
                  <label>Team Name *</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Description</label>
                  <textarea
                    value={formData.description}
                    onChange={e => setFormData({ ...formData, description: e.target.value })}
                    rows="3"
                  />
                </div>
                <div className="form-group">
                  <label>Team Manager</label>
                  <select
                    value={formData.manager_id}
                    onChange={e => setFormData({ ...formData, manager_id: e.target.value })}
                  >
                    <option value="">Select Manager</option>
                    {allUsers.filter(u => u.role === 'admin' || u.role === 'manager').map(u => (
                      <option key={u.id} value={u.id}>{u.full_name}</option>
                    ))}
                  </select>
                </div>
                <div className="modal-actions">
                  <button type="button" onClick={() => setEditingTeam(null)}>Cancel</button>
                  <button type="submit" className="btn-primary">Save Changes</button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Settings Modal */}
        {showSettingsModal && (
          <div className="modal-overlay" onClick={() => setShowSettingsModal(false)}>
            <div className="modal modal-large" onClick={e => e.stopPropagation()}>
              <h2>Monitoring Settings - {selectedTeam?.name}</h2>
              <form onSubmit={handleSaveSettings}>
                <div className="settings-grid">
                  <div className="form-group">
                    <label>Screenshot Interval (seconds)</label>
                    <input
                      type="number"
                      min="30"
                      max="600"
                      value={settingsData.screenshot_interval || 60}
                      onChange={e => setSettingsData({ ...settingsData, screenshot_interval: parseInt(e.target.value) })}
                    />
                    <small>How often to capture screenshots (30-600 seconds)</small>
                  </div>
                  <div className="form-group">
                    <label>Activity Interval (seconds)</label>
                    <input
                      type="number"
                      min="5"
                      max="60"
                      value={settingsData.activity_interval || 10}
                      onChange={e => setSettingsData({ ...settingsData, activity_interval: parseInt(e.target.value) })}
                    />
                    <small>How often to log activity (5-60 seconds)</small>
                  </div>
                  <div className="form-group">
                    <label>Idle Threshold (seconds)</label>
                    <input
                      type="number"
                      min="60"
                      max="1800"
                      value={settingsData.idle_threshold || 300}
                      onChange={e => setSettingsData({ ...settingsData, idle_threshold: parseInt(e.target.value) })}
                    />
                    <small>Mark user idle after this many seconds of inactivity</small>
                  </div>
                </div>

                <div className="settings-section">
                  <h4>Tracking Options</h4>
                  <div className="checkbox-group">
                    <label>
                      <input
                        type="checkbox"
                        checked={settingsData.track_urls !== false}
                        onChange={e => setSettingsData({ ...settingsData, track_urls: e.target.checked })}
                      />
                      Track URLs/Websites
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={settingsData.track_applications !== false}
                        onChange={e => setSettingsData({ ...settingsData, track_applications: e.target.checked })}
                      />
                      Track Applications
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={settingsData.track_keyboard_mouse !== false}
                        onChange={e => setSettingsData({ ...settingsData, track_keyboard_mouse: e.target.checked })}
                      />
                      Track Keyboard/Mouse Activity
                    </label>
                  </div>
                </div>

                <div className="settings-section">
                  <h4>Working Hours</h4>
                  <div className="time-inputs">
                    <div className="form-group">
                      <label>Start Time</label>
                      <input
                        type="time"
                        value={settingsData.working_hours_start || ''}
                        onChange={e => setSettingsData({ ...settingsData, working_hours_start: e.target.value })}
                      />
                    </div>
                    <div className="form-group">
                      <label>End Time</label>
                      <input
                        type="time"
                        value={settingsData.working_hours_end || ''}
                        onChange={e => setSettingsData({ ...settingsData, working_hours_end: e.target.value })}
                      />
                    </div>
                  </div>
                </div>

                <div className="modal-actions">
                  <button type="button" onClick={() => setShowSettingsModal(false)}>Cancel</button>
                  <button type="submit" className="btn-primary">Save Settings</button>
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
