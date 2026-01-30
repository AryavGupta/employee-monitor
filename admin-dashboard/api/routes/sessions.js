const express = require('express');
const router = express.Router();
const { authenticateToken } = require('./auth');

// Start session
router.post('/start', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const userId = req.user.userId;
    const { systemInfo } = req.body;

    // End any existing active sessions
    await pool.query(
      `UPDATE sessions SET is_active = false, end_time = CURRENT_TIMESTAMP,
       duration_seconds = EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - start_time))
       WHERE user_id = $1 AND is_active = true`,
      [userId]
    );

    const result = await pool.query(
      `INSERT INTO sessions (user_id, start_time, system_info)
       VALUES ($1, CURRENT_TIMESTAMP, $2) RETURNING *`,
      [userId, systemInfo ? JSON.stringify(systemInfo) : null]
    );

    res.status(201).json({ success: true, message: 'Session started', data: result.rows[0] });
  } catch (error) {
    console.error('Start session error:', error);
    res.status(500).json({ success: false, message: 'Failed to start session' });
  }
});

// End session
router.post('/end', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const userId = req.user.userId;
    const { totalActiveTime, totalIdleTime, notes } = req.body;

    // Use actual tracked time if provided by desktop app, otherwise fall back to wall-clock time
    // This prevents uptime inflation during system sleep
    const hasTrackedTime = typeof totalActiveTime === 'number' && typeof totalIdleTime === 'number';
    const trackedDuration = hasTrackedTime ? (totalActiveTime + totalIdleTime) : null;

    let result;
    if (trackedDuration !== null) {
      // Try to use the new columns first, fall back to basic update if columns don't exist
      try {
        result = await pool.query(
          `UPDATE sessions SET
             is_active = false,
             end_time = CURRENT_TIMESTAMP,
             duration_seconds = $2,
             active_seconds = $3,
             idle_seconds = $4,
             notes = COALESCE($5, notes)
           WHERE user_id = $1 AND is_active = true RETURNING *`,
          [userId, trackedDuration, totalActiveTime, totalIdleTime, notes]
        );
      } catch (columnError) {
        // If columns don't exist, fall back to basic update with just duration_seconds
        console.log('New session columns not available, using fallback:', columnError.message);
        result = await pool.query(
          `UPDATE sessions SET
             is_active = false,
             end_time = CURRENT_TIMESTAMP,
             duration_seconds = $2
           WHERE user_id = $1 AND is_active = true RETURNING *`,
          [userId, trackedDuration]
        );
      }
    } else {
      // Fallback to wall-clock time (legacy behavior)
      result = await pool.query(
        `UPDATE sessions SET is_active = false, end_time = CURRENT_TIMESTAMP,
         duration_seconds = EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - start_time))
         WHERE user_id = $1 AND is_active = true RETURNING *`,
        [userId]
      );
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No active session found' });
    }

    res.json({ success: true, message: 'Session ended', data: result.rows[0] });
  } catch (error) {
    console.error('End session error:', error);
    res.status(500).json({ success: false, message: 'Failed to end session' });
  }
});

// Get sessions
router.get('/', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, startDate, endDate, isActive, limit = 50, offset = 0 } = req.query;

    let query = `
      SELECT s.*, u.email, u.full_name
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;

    if (req.user.role !== 'admin') {
      query += ` AND s.user_id = $${paramCount}`;
      params.push(req.user.userId);
      paramCount++;
    } else if (userId) {
      query += ` AND s.user_id = $${paramCount}`;
      params.push(userId);
      paramCount++;
    }

    if (startDate) {
      query += ` AND s.start_time >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      query += ` AND s.start_time <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    if (isActive !== undefined) {
      query += ` AND s.is_active = $${paramCount}`;
      params.push(isActive === 'true');
      paramCount++;
    }

    query += ` ORDER BY s.start_time DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get sessions error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve sessions' });
  }
});

// Get active session
router.get('/active', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const userId = req.user.userId;

    const result = await pool.query(
      'SELECT * FROM sessions WHERE user_id = $1 AND is_active = true ORDER BY start_time DESC LIMIT 1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, data: null, message: 'No active session' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Get active session error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve active session' });
  }
});

// Get session summary
router.get('/summary', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, startDate, endDate } = req.query;

    let query = `
      SELECT COUNT(*) as total_sessions,
             COUNT(CASE WHEN is_active = true THEN 1 END) as active_sessions,
             COALESCE(SUM(duration_seconds), 0) as total_duration_seconds,
             COALESCE(AVG(duration_seconds), 0) as avg_duration_seconds
      FROM sessions WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;

    if (req.user.role !== 'admin') {
      query += ` AND user_id = $${paramCount}`;
      params.push(req.user.userId);
      paramCount++;
    } else if (userId) {
      query += ` AND user_id = $${paramCount}`;
      params.push(userId);
      paramCount++;
    }

    if (startDate) {
      query += ` AND start_time >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      query += ` AND start_time <= $${paramCount}`;
      params.push(endDate);
    }

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Get session summary error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve summary' });
  }
});

module.exports = router;
