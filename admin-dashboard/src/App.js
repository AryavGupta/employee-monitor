import React, { useState, useEffect, useCallback } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import axios from 'axios';
import Login from './components/Login';
import Dashboard from './components/Dashboard';
import Screenshots from './components/Screenshots';
import Users from './components/Users';
import Analytics from './components/Analytics';
import UserActivity from './components/UserActivity';
import Teams from './components/Teams';
import Profile from './components/Profile';
import './App.css';

const API_URL = process.env.REACT_APP_API_URL || '';

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const verifyToken = useCallback(async (token) => {
    try {
      const response = await axios.get(`${API_URL}/api/auth/verify`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (response.data.success) {
        setUser(response.data.user);
        localStorage.setItem('user', JSON.stringify(response.data.user));
        setIsAuthenticated(true);
        return true;
      }
      return false;
    } catch (error) {
      console.error('Token verification failed:', error);
      return false;
    }
  }, []);

  useEffect(() => {
    const initAuth = async () => {
      const token = localStorage.getItem('token');

      if (token) {
        const isValid = await verifyToken(token);
        if (!isValid) {
          // Token is invalid, clear storage
          localStorage.removeItem('token');
          localStorage.removeItem('user');
        }
      }
      setLoading(false);
    };

    initAuth();
  }, [verifyToken]);

  const handleLogin = (token, userData) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(userData));
    setIsAuthenticated(true);
    setUser(userData);
  };

  const handleLogout = async () => {
    try {
      const token = localStorage.getItem('token');
      if (token) {
        await axios.post(`${API_URL}/api/auth/logout`, {}, {
          headers: { Authorization: `Bearer ${token}` }
        });
      }
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      setIsAuthenticated(false);
      setUser(null);
    }
  };

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner"></div>
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <Router>
      <div className="App">
        <Routes>
          <Route 
            path="/login" 
            element={
              !isAuthenticated ? 
              <Login onLogin={handleLogin} /> : 
              <Navigate to="/dashboard" />
            } 
          />
          <Route 
            path="/dashboard" 
            element={
              isAuthenticated ? 
              <Dashboard user={user} onLogout={handleLogout} /> : 
              <Navigate to="/login" />
            } 
          />
          <Route 
            path="/screenshots" 
            element={
              isAuthenticated ? 
              <Screenshots user={user} onLogout={handleLogout} /> : 
              <Navigate to="/login" />
            } 
          />
          <Route
            path="/users"
            element={
              isAuthenticated && user?.role === 'admin' ?
              <Users user={user} onLogout={handleLogout} /> :
              <Navigate to="/dashboard" />
            }
          />
          <Route
            path="/analytics"
            element={
              isAuthenticated ?
              <Analytics user={user} onLogout={handleLogout} /> :
              <Navigate to="/login" />
            }
          />
          <Route
            path="/user-activity"
            element={
              isAuthenticated && (user?.role === 'admin' || user?.role === 'team_manager') ?
              <UserActivity user={user} onLogout={handleLogout} /> :
              <Navigate to="/dashboard" />
            }
          />
          <Route
            path="/teams"
            element={
              isAuthenticated && (user?.role === 'admin' || user?.role === 'team_manager') ?
              <Teams user={user} onLogout={handleLogout} /> :
              <Navigate to="/dashboard" />
            }
          />
          <Route
            path="/profile"
            element={
              isAuthenticated ?
              <Profile user={user} onLogout={handleLogout} /> :
              <Navigate to="/login" />
            }
          />
          <Route
            path="/"
            element={<Navigate to={isAuthenticated ? "/dashboard" : "/login"} />}
          />
        </Routes>
      </div>
    </Router>
  );
}

export default App;
