const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeAdmin } = require('./auth');

// Log activity from desktop app
router.post('/log', authenticateToken, async (req, res) => {
  try {
    const { activityType, applicationName, windowTitle, isIdle, durationSeconds, metadata } = req.body;
    const userId = req.user.userId;
    const pool = req.app.locals.pool;

    if (!activityType) {
      return res.status(400).json({
        success: false,
        message: 'Activity type is required'
      });
    }

    const result = await pool.query(
      `INSERT INTO activity_logs
       (user_id, activity_type, application_name, window_title, is_idle, duration_seconds, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, timestamp`,
      [
        userId,
        activityType,
        applicationName || null,
        windowTitle || null,
        isIdle || false,
        durationSeconds || null,
        metadata ? JSON.stringify(metadata) : null
      ]
    );

    res.json({
      success: true,
      message: 'Activity logged successfully',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Log activity error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to log activity'
    });
  }
});

// Batch log multiple activities
router.post('/log/batch', authenticateToken, async (req, res) => {
  try {
    const { activities } = req.body;
    const userId = req.user.userId;
    const pool = req.app.locals.pool;

    if (!activities || !Array.isArray(activities) || activities.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Activities array is required'
      });
    }

    const values = activities.map((activity, index) => {
      const offset = index * 7;
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`;
    }).join(', ');

    const params = activities.flatMap(activity => [
      userId,
      activity.activityType,
      activity.applicationName || null,
      activity.windowTitle || null,
      activity.isIdle || false,
      activity.durationSeconds || null,
      activity.metadata ? JSON.stringify(activity.metadata) : null
    ]);

    const result = await pool.query(
      `INSERT INTO activity_logs
       (user_id, activity_type, application_name, window_title, is_idle, duration_seconds, metadata)
       VALUES ${values}
       RETURNING id, timestamp`,
      params
    );

    res.json({
      success: true,
      message: `${result.rows.length} activities logged successfully`,
      count: result.rows.length
    });

  } catch (error) {
    console.error('Batch log activity error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to log activities'
    });
  }
});

// Get activity logs with filtering
router.get('/', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const {
      userId,
      activityType,
      startDate,
      endDate,
      isIdle,
      limit = 100,
      offset = 0
    } = req.query;

    let query = `
      SELECT
        a.id,
        a.user_id,
        a.activity_type,
        a.application_name,
        a.window_title,
        a.is_idle,
        a.timestamp,
        a.duration_seconds,
        a.metadata,
        u.email,
        u.full_name
      FROM activity_logs a
      JOIN users u ON a.user_id = u.id
      WHERE 1=1
    `;

    const params = [];
    let paramCount = 1;

    // Non-admins can only see their own activity
    if (req.user.role !== 'admin') {
      query += ` AND a.user_id = $${paramCount}`;
      params.push(req.user.userId);
      paramCount++;
    } else if (userId) {
      query += ` AND a.user_id = $${paramCount}`;
      params.push(userId);
      paramCount++;
    }

    if (activityType) {
      query += ` AND a.activity_type = $${paramCount}`;
      params.push(activityType);
      paramCount++;
    }

    if (startDate) {
      query += ` AND a.timestamp >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      query += ` AND a.timestamp <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    if (isIdle !== undefined) {
      query += ` AND a.is_idle = $${paramCount}`;
      params.push(isIdle === 'true');
      paramCount++;
    }

    query += ` ORDER BY a.timestamp DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = `
      SELECT COUNT(*) as total
      FROM activity_logs a
      WHERE 1=1
    `;
    const countParams = [];
    let countParamIndex = 1;

    if (req.user.role !== 'admin') {
      countQuery += ` AND a.user_id = $${countParamIndex}`;
      countParams.push(req.user.userId);
      countParamIndex++;
    } else if (userId) {
      countQuery += ` AND a.user_id = $${countParamIndex}`;
      countParams.push(userId);
      countParamIndex++;
    }

    if (activityType) {
      countQuery += ` AND a.activity_type = $${countParamIndex}`;
      countParams.push(activityType);
      countParamIndex++;
    }

    if (startDate) {
      countQuery += ` AND a.timestamp >= $${countParamIndex}`;
      countParams.push(startDate);
      countParamIndex++;
    }

    if (endDate) {
      countQuery += ` AND a.timestamp <= $${countParamIndex}`;
      countParams.push(endDate);
      countParamIndex++;
    }

    if (isIdle !== undefined) {
      countQuery += ` AND a.is_idle = $${countParamIndex}`;
      countParams.push(isIdle === 'true');
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
    console.error('Get activity logs error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve activity logs'
    });
  }
});

// Get activity summary/statistics
router.get('/summary', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, startDate, endDate } = req.query;

    let query = `
      SELECT
        COUNT(*) as total_activities,
        COUNT(CASE WHEN is_idle = true THEN 1 END) as idle_periods,
        COUNT(CASE WHEN is_idle = false THEN 1 END) as active_periods,
        COUNT(DISTINCT application_name) as unique_applications,
        COALESCE(SUM(duration_seconds), 0) as total_duration_seconds,
        COALESCE(SUM(CASE WHEN is_idle = true THEN duration_seconds ELSE 0 END), 0) as total_idle_seconds,
        COALESCE(SUM(CASE WHEN is_idle = false THEN duration_seconds ELSE 0 END), 0) as total_active_seconds
      FROM activity_logs
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
      query += ` AND timestamp >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      query += ` AND timestamp <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Get activity summary error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve activity summary'
    });
  }
});

// Get top applications used
router.get('/top-apps', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, startDate, endDate, limit = 10 } = req.query;

    let query = `
      SELECT
        application_name,
        COUNT(*) as usage_count,
        COALESCE(SUM(duration_seconds), 0) as total_duration_seconds
      FROM activity_logs
      WHERE application_name IS NOT NULL
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
      query += ` AND timestamp >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      query += ` AND timestamp <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    query += ` GROUP BY application_name ORDER BY total_duration_seconds DESC LIMIT $${paramCount}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error('Get top apps error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve top applications'
    });
  }
});

// Get hourly activity breakdown
router.get('/hourly', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, date } = req.query;

    const targetDate = date || new Date().toISOString().split('T')[0];

    let query = `
      SELECT
        EXTRACT(HOUR FROM timestamp) as hour,
        COUNT(*) as activity_count,
        COUNT(CASE WHEN is_idle = true THEN 1 END) as idle_count,
        COUNT(CASE WHEN is_idle = false THEN 1 END) as active_count,
        COALESCE(SUM(duration_seconds), 0) as total_duration
      FROM activity_logs
      WHERE DATE(timestamp) = $1
    `;

    const params = [targetDate];
    let paramCount = 2;

    if (req.user.role !== 'admin') {
      query += ` AND user_id = $${paramCount}`;
      params.push(req.user.userId);
      paramCount++;
    } else if (userId) {
      query += ` AND user_id = $${paramCount}`;
      params.push(userId);
      paramCount++;
    }

    query += ` GROUP BY EXTRACT(HOUR FROM timestamp) ORDER BY hour`;

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows,
      date: targetDate
    });

  } catch (error) {
    console.error('Get hourly activity error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve hourly activity'
    });
  }
});

module.exports = router;
