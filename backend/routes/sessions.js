const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeAdmin } = require('./auth');

// Start a new work session
router.post('/start', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const pool = req.app.locals.pool;
    const { notes } = req.body;

    // Check if there's already an active session
    const existingSession = await pool.query(
      `SELECT id FROM work_sessions
       WHERE user_id = $1 AND session_end IS NULL`,
      [userId]
    );

    if (existingSession.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'An active session already exists',
        sessionId: existingSession.rows[0].id
      });
    }

    const result = await pool.query(
      `INSERT INTO work_sessions (user_id, session_start, notes)
       VALUES ($1, CURRENT_TIMESTAMP, $2)
       RETURNING *`,
      [userId, notes || null]
    );

    res.status(201).json({
      success: true,
      message: 'Work session started',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Start session error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to start work session'
    });
  }
});

// End current work session
router.post('/end', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const pool = req.app.locals.pool;
    const { totalActiveTime, totalIdleTime, notes } = req.body;

    const result = await pool.query(
      `UPDATE work_sessions
       SET session_end = CURRENT_TIMESTAMP,
           total_active_time = COALESCE($1, total_active_time),
           total_idle_time = COALESCE($2, total_idle_time),
           notes = COALESCE($3, notes)
       WHERE user_id = $4 AND session_end IS NULL
       RETURNING *`,
      [totalActiveTime, totalIdleTime, notes, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No active session found'
      });
    }

    res.json({
      success: true,
      message: 'Work session ended',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('End session error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to end work session'
    });
  }
});

// Get current active session
router.get('/current', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const pool = req.app.locals.pool;

    const result = await pool.query(
      `SELECT
        ws.*,
        EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - ws.session_start)) as duration_seconds
       FROM work_sessions ws
       WHERE ws.user_id = $1 AND ws.session_end IS NULL`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        data: null,
        message: 'No active session'
      });
    }

    res.json({
      success: true,
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Get current session error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve current session'
    });
  }
});

// Update session activity times
router.patch('/current/activity', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const pool = req.app.locals.pool;
    const { activeSeconds, idleSeconds } = req.body;

    const result = await pool.query(
      `UPDATE work_sessions
       SET total_active_time = total_active_time + COALESCE($1, 0),
           total_idle_time = total_idle_time + COALESCE($2, 0)
       WHERE user_id = $3 AND session_end IS NULL
       RETURNING *`,
      [activeSeconds, idleSeconds, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No active session found'
      });
    }

    res.json({
      success: true,
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Update session activity error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update session activity'
    });
  }
});

// Get all sessions with filtering
router.get('/', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const {
      userId,
      startDate,
      endDate,
      isOffline,
      offlineApproved,
      limit = 50,
      offset = 0
    } = req.query;

    let query = `
      SELECT
        ws.id,
        ws.user_id,
        ws.session_start,
        ws.session_end,
        ws.total_active_time,
        ws.total_idle_time,
        ws.screenshot_count,
        ws.is_offline,
        ws.offline_approved,
        ws.approved_by,
        ws.notes,
        u.email,
        u.full_name,
        au.full_name as approved_by_name,
        EXTRACT(EPOCH FROM (COALESCE(ws.session_end, CURRENT_TIMESTAMP) - ws.session_start)) as duration_seconds
      FROM work_sessions ws
      JOIN users u ON ws.user_id = u.id
      LEFT JOIN users au ON ws.approved_by = au.id
      WHERE 1=1
    `;

    const params = [];
    let paramCount = 1;

    // Non-admins can only see their own sessions
    if (req.user.role !== 'admin') {
      query += ` AND ws.user_id = $${paramCount}`;
      params.push(req.user.userId);
      paramCount++;
    } else if (userId) {
      query += ` AND ws.user_id = $${paramCount}`;
      params.push(userId);
      paramCount++;
    }

    if (startDate) {
      query += ` AND ws.session_start >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      query += ` AND ws.session_start <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    if (isOffline !== undefined) {
      query += ` AND ws.is_offline = $${paramCount}`;
      params.push(isOffline === 'true');
      paramCount++;
    }

    if (offlineApproved !== undefined) {
      query += ` AND ws.offline_approved = $${paramCount}`;
      params.push(offlineApproved === 'true');
      paramCount++;
    }

    query += ` ORDER BY ws.session_start DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = `SELECT COUNT(*) as total FROM work_sessions ws WHERE 1=1`;
    const countParams = [];
    let countParamIndex = 1;

    if (req.user.role !== 'admin') {
      countQuery += ` AND ws.user_id = $${countParamIndex}`;
      countParams.push(req.user.userId);
      countParamIndex++;
    } else if (userId) {
      countQuery += ` AND ws.user_id = $${countParamIndex}`;
      countParams.push(userId);
      countParamIndex++;
    }

    if (startDate) {
      countQuery += ` AND ws.session_start >= $${countParamIndex}`;
      countParams.push(startDate);
      countParamIndex++;
    }

    if (endDate) {
      countQuery += ` AND ws.session_start <= $${countParamIndex}`;
      countParams.push(endDate);
      countParamIndex++;
    }

    const countResult = await pool.query(countQuery, countParams);

    res.json({
      success: true,
      data: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].total),
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: parseInt(offset) + result.rows.length < parseInt(countResult.rows[0].total)
      }
    });

  } catch (error) {
    console.error('Get sessions error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve sessions'
    });
  }
});

// Get single session
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    const result = await pool.query(
      `SELECT
        ws.*,
        u.email,
        u.full_name,
        au.full_name as approved_by_name,
        EXTRACT(EPOCH FROM (COALESCE(ws.session_end, CURRENT_TIMESTAMP) - ws.session_start)) as duration_seconds
       FROM work_sessions ws
       JOIN users u ON ws.user_id = u.id
       LEFT JOIN users au ON ws.approved_by = au.id
       WHERE ws.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }

    const session = result.rows[0];

    // Check authorization
    if (req.user.role !== 'admin' && session.user_id !== req.user.userId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    res.json({
      success: true,
      data: session
    });

  } catch (error) {
    console.error('Get session error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve session'
    });
  }
});

// Mark session as offline
router.patch('/:id/offline', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;
    const { isOffline, notes } = req.body;

    // Check if session belongs to user
    const checkResult = await pool.query(
      'SELECT user_id FROM work_sessions WHERE id = $1',
      [id]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }

    if (req.user.role !== 'admin' && checkResult.rows[0].user_id !== req.user.userId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const result = await pool.query(
      `UPDATE work_sessions
       SET is_offline = $1, notes = COALESCE($2, notes)
       WHERE id = $3
       RETURNING *`,
      [isOffline, notes, id]
    );

    res.json({
      success: true,
      message: 'Session updated',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Update offline status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update session'
    });
  }
});

// Approve offline session (admin only)
router.patch('/:id/approve', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;
    const { approved } = req.body;

    const result = await pool.query(
      `UPDATE work_sessions
       SET offline_approved = $1, approved_by = $2
       WHERE id = $3 AND is_offline = true
       RETURNING *`,
      [approved, req.user.userId, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Offline session not found'
      });
    }

    // Log audit trail
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.userId, approved ? 'APPROVE_OFFLINE' : 'REJECT_OFFLINE', 'session', id, JSON.stringify({ approved })]
    );

    res.json({
      success: true,
      message: approved ? 'Offline session approved' : 'Offline session rejected',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Approve offline error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update session'
    });
  }
});

// Get session statistics
router.get('/stats/summary', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, startDate, endDate } = req.query;

    let query = `
      SELECT
        COUNT(*) as total_sessions,
        COUNT(CASE WHEN session_end IS NULL THEN 1 END) as active_sessions,
        COUNT(CASE WHEN is_offline = true THEN 1 END) as offline_sessions,
        COUNT(CASE WHEN is_offline = true AND offline_approved = false THEN 1 END) as pending_approval,
        COALESCE(SUM(total_active_time), 0) as total_active_seconds,
        COALESCE(SUM(total_idle_time), 0) as total_idle_seconds,
        COALESCE(SUM(screenshot_count), 0) as total_screenshots,
        COALESCE(AVG(EXTRACT(EPOCH FROM (COALESCE(session_end, CURRENT_TIMESTAMP) - session_start))), 0) as avg_session_duration
      FROM work_sessions
      WHERE 1=1
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
      query += ` AND session_start >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      query += ` AND session_start <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Get session stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve session statistics'
    });
  }
});

// Get daily session breakdown
router.get('/stats/daily', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, startDate, endDate } = req.query;

    let query = `
      SELECT
        DATE(session_start) as date,
        COUNT(*) as sessions,
        COALESCE(SUM(total_active_time), 0) as active_seconds,
        COALESCE(SUM(total_idle_time), 0) as idle_seconds,
        COALESCE(SUM(screenshot_count), 0) as screenshots,
        MIN(session_start) as first_session,
        MAX(COALESCE(session_end, session_start)) as last_session
      FROM work_sessions
      WHERE 1=1
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
      query += ` AND session_start >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      query += ` AND session_start <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    query += ` GROUP BY DATE(session_start) ORDER BY date DESC`;

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error('Get daily stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve daily statistics'
    });
  }
});

module.exports = router;
