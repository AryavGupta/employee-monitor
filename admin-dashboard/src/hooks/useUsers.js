import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL || '';

// Module-level cache shared across all components
let cachedUsers = null;
let cacheTimestamp = 0;
let fetchPromise = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchUserList() {
  // Return in-flight request if one exists (dedup)
  if (fetchPromise) return fetchPromise;

  // Return cache if fresh
  if (cachedUsers && Date.now() - cacheTimestamp < CACHE_TTL) {
    return cachedUsers;
  }

  fetchPromise = (async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get(`${API_URL}/api/users/list`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.data.success) {
        cachedUsers = res.data.data;
        cacheTimestamp = Date.now();
        return cachedUsers;
      }
      return cachedUsers || [];
    } catch (err) {
      console.error('Error fetching users list:', err);
      return cachedUsers || [];
    } finally {
      fetchPromise = null;
    }
  })();

  return fetchPromise;
}

// Invalidate cache (call after creating/deleting users)
export function invalidateUsersCache() {
  cachedUsers = null;
  cacheTimestamp = 0;
}

export function useUsers() {
  const [users, setUsers] = useState(cachedUsers || []);
  const [loading, setLoading] = useState(!cachedUsers);

  useEffect(() => {
    let mounted = true;
    // If cache exists, set immediately (no loading state)
    if (cachedUsers && Date.now() - cacheTimestamp < CACHE_TTL) {
      setUsers(cachedUsers);
      setLoading(false);
      return;
    }

    fetchUserList().then(data => {
      if (mounted) {
        setUsers(data);
        setLoading(false);
      }
    });
    return () => { mounted = false; };
  }, []);

  return { users, loading };
}

export function useFilteredUsers(users, searchTerm) {
  return useMemo(() => {
    if (!searchTerm) return users;
    const term = searchTerm.toLowerCase();
    return users.filter(u =>
      u.full_name.toLowerCase().includes(term) ||
      u.email.toLowerCase().includes(term)
    );
  }, [users, searchTerm]);
}
