import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { format } from 'date-fns';
import Sidebar from './Sidebar';
import './Profile.css';

const API_URL = process.env.REACT_APP_API_URL || '';

function Profile({ user, onLogout }) {
  const [profile, setProfile] = useState(null);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [passwordData, setPasswordData] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: ''
  });
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');

  useEffect(() => {
    fetchProfileData();
  }, []);

  const fetchProfileData = async () => {
    try {
      const token = localStorage.getItem('token');

      const [profileRes, statsRes] = await Promise.all([
        axios.get(`${API_URL}/api/users/me`, {
          headers: { Authorization: `Bearer ${token}` }
        }),
        axios.get(`${API_URL}/api/screenshots/stats/summary`, {
          headers: { Authorization: `Bearer ${token}` }
        })
      ]);

      if (profileRes.data.success) {
        setProfile(profileRes.data.data);
      }
      if (statsRes.data.success) {
        setStats(statsRes.data.data);
      }
    } catch (error) {
      console.error('Error fetching profile:', error);
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    setPasswordError('');
    setPasswordSuccess('');

    if (passwordData.newPassword !== passwordData.confirmPassword) {
      setPasswordError('New passwords do not match');
      return;
    }

    if (passwordData.newPassword.length < 8) {
      setPasswordError('Password must be at least 8 characters');
      return;
    }

    try {
      const token = localStorage.getItem('token');
      const response = await axios.post(
        `${API_URL}/api/auth/change-password`,
        {
          currentPassword: passwordData.currentPassword,
          newPassword: passwordData.newPassword
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (response.data.success) {
        setPasswordSuccess('Password changed successfully');
        setPasswordData({ currentPassword: '', newPassword: '', confirmPassword: '' });
        setTimeout(() => {
          setShowPasswordModal(false);
          setPasswordSuccess('');
        }, 2000);
      }
    } catch (error) {
      setPasswordError(error.response?.data?.message || 'Failed to change password');
    }
  };

  const getRoleBadgeClass = (role) => {
    switch (role) {
      case 'admin': return 'role-admin';
      case 'team_manager': return 'role-manager';
      default: return 'role-employee';
    }
  };

  if (loading) {
    return (
      <div className="app-layout">
        <Sidebar user={user} onLogout={onLogout} activePage="profile" />
        <div className="main-content">
          <div className="loading">Loading profile...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-layout">
      <Sidebar user={user} onLogout={onLogout} activePage="profile" />

      <div className="main-content">
        <div className="content-header">
          <div>
            <h1>My Profile</h1>
            <p>View and manage your account information</p>
          </div>
        </div>

        <div className="profile-layout">
          {/* Profile Card */}
          <div className="profile-card">
            <div className="profile-avatar">
              {profile?.full_name?.charAt(0).toUpperCase()}
            </div>
            <h2>{profile?.full_name}</h2>
            <span className={`role-badge ${getRoleBadgeClass(profile?.role)}`}>
              {profile?.role?.replace('_', ' ')}
            </span>
            <p className="profile-email">{profile?.email}</p>
            {profile?.team_name && (
              <p className="profile-team">Team: {profile.team_name}</p>
            )}
            <button
              className="btn-secondary"
              onClick={() => setShowPasswordModal(true)}
            >
              Change Password
            </button>
          </div>

          {/* Profile Details */}
          <div className="profile-details">
            <div className="details-section">
              <h3>Account Information</h3>
              <div className="details-grid">
                <div className="detail-item">
                  <label>Full Name</label>
                  <span>{profile?.full_name}</span>
                </div>
                <div className="detail-item">
                  <label>Email Address</label>
                  <span>{profile?.email}</span>
                </div>
                <div className="detail-item">
                  <label>Role</label>
                  <span className="capitalize">{profile?.role?.replace('_', ' ')}</span>
                </div>
                <div className="detail-item">
                  <label>Team</label>
                  <span>{profile?.team_name || 'Not assigned'}</span>
                </div>
                <div className="detail-item">
                  <label>Account Status</label>
                  <span className={`status-badge ${profile?.is_active ? 'active' : 'inactive'}`}>
                    {profile?.is_active ? 'Active' : 'Inactive'}
                  </span>
                </div>
                <div className="detail-item">
                  <label>User ID</label>
                  <span className="user-id">{profile?.id}</span>
                </div>
              </div>
            </div>

            {/* Activity Stats */}
            <div className="details-section">
              <h3>Activity Summary</h3>
              <div className="stats-grid">
                <div className="stat-card">
                  <div className="stat-value">{stats?.total_screenshots || 0}</div>
                  <div className="stat-label">Total Screenshots</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{stats?.flagged_screenshots || 0}</div>
                  <div className="stat-label">Flagged</div>
                </div>
                {stats?.first_screenshot && (
                  <div className="stat-card wide">
                    <div className="stat-value small">
                      {format(new Date(stats.first_screenshot), 'MMM d, yyyy')}
                    </div>
                    <div className="stat-label">First Activity</div>
                  </div>
                )}
                {stats?.last_screenshot && (
                  <div className="stat-card wide">
                    <div className="stat-value small">
                      {format(new Date(stats.last_screenshot), 'MMM d, yyyy HH:mm')}
                    </div>
                    <div className="stat-label">Last Activity</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Change Password Modal */}
        {showPasswordModal && (
          <div className="modal-overlay" onClick={() => setShowPasswordModal(false)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <h2>Change Password</h2>
              <form onSubmit={handlePasswordChange}>
                <div className="form-group">
                  <label>Current Password</label>
                  <input
                    type="password"
                    value={passwordData.currentPassword}
                    onChange={e => setPasswordData({ ...passwordData, currentPassword: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>New Password</label>
                  <input
                    type="password"
                    value={passwordData.newPassword}
                    onChange={e => setPasswordData({ ...passwordData, newPassword: e.target.value })}
                    required
                    minLength={8}
                  />
                </div>
                <div className="form-group">
                  <label>Confirm New Password</label>
                  <input
                    type="password"
                    value={passwordData.confirmPassword}
                    onChange={e => setPasswordData({ ...passwordData, confirmPassword: e.target.value })}
                    required
                  />
                </div>
                {passwordError && <div className="error-message">{passwordError}</div>}
                {passwordSuccess && <div className="success-message">{passwordSuccess}</div>}
                <div className="modal-actions">
                  <button type="button" onClick={() => setShowPasswordModal(false)}>Cancel</button>
                  <button type="submit" className="btn-primary">Change Password</button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default Profile;
