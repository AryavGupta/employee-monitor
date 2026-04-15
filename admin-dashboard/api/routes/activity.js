const express = require('express');
const router = express.Router();
const { authenticateToken, getManagedUserIds } = require('./auth');

// Truncate string to max length (varchar column safety). Returns null for empty/nullish.
const truncate = (v, max) => {
  if (v == null) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
};

// Log activity
router.post('/log', authenticateToken, async (req, res) => {
  try {
    const { activityType, applicationName, windowTitle, isIdle, durationSeconds, metadata, isOvertime, shiftDate } = req.body;
    const userId = req.user.userId;
    const pool = req.app.locals.pool;

    if (!activityType) {
      return res.status(400).json({ success: false, message: 'Activity type is required' });
    }

    const result = await pool.query(
      `INSERT INTO activity_logs (user_id, activity_type, application_name, window_title, is_idle, duration_seconds, metadata, is_overtime, shift_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, timestamp`,
      [userId, activityType, truncate(applicationName, 255), truncate(windowTitle, 500), isIdle ?? false, durationSeconds ?? null, metadata ? JSON.stringify(metadata) : null, isOvertime ?? false, shiftDate || null]
    );

    res.json({ success: true, message: 'Activity logged', data: result.rows[0] });
  } catch (error) {
    console.error('Log activity error:', error);
    res.status(500).json({ success: false, message: 'Failed to log activity' });
  }
});

// Batch log activities
router.post('/log/batch', authenticateToken, async (req, res) => {
  try {
    const { activities } = req.body;
    const userId = req.user.userId;
    const pool = req.app.locals.pool;

    if (!activities || !Array.isArray(activities) || activities.length === 0) {
      return res.status(400).json({ success: false, message: 'Activities array is required' });
    }

    // Use a single batch insert for performance
    // Try full insert first, fall back to core columns if newer columns don't exist
    let insertSuccess = false;

    // Attempt 1: Full insert with all columns (including enhanced tracking columns)
    try {
      const values = [];
      const placeholders = [];
      let paramIndex = 1;

      for (const activity of activities) {
        placeholders.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7}, $${paramIndex + 8}, $${paramIndex + 9}, $${paramIndex + 10}, $${paramIndex + 11}, $${paramIndex + 12}, $${paramIndex + 13})`);
        values.push(
          userId,
          activity.activityType,
          truncate(activity.applicationName, 255),
          truncate(activity.windowTitle, 500),
          activity.isIdle ?? false,
          activity.durationSeconds ?? null,
          activity.keyboardEvents ?? 0,
          activity.mouseEvents ?? 0,
          activity.mouseDistance ?? 0,
          truncate(activity.url, 500),
          truncate(activity.domain, 255),
          activity.isOvertime ?? false,
          activity.shiftDate || null,
          activity.metadata ? JSON.stringify(activity.metadata) : null
        );
        paramIndex += 14;
      }

      const query = `
        INSERT INTO activity_logs
          (user_id, activity_type, application_name, window_title, is_idle, duration_seconds, keyboard_events, mouse_events, mouse_distance, url, domain, is_overtime, shift_date, metadata)
        VALUES ${placeholders.join(', ')}
      `;

      await pool.query(query, values);
      insertSuccess = true;
    } catch (fullInsertError) {
      // If it's a column-not-found error, try fallback with core columns only
      if (fullInsertError.code === '42703') {
        console.warn('Activity batch: some columns missing in DB, falling back to core columns. Run schema migrations to add: keyboard_events, mouse_events, mouse_distance, url, domain, is_overtime, shift_date');
      } else {
        throw fullInsertError; // Re-throw non-column errors
      }
    }

    // Attempt 2: Fallback to core columns if newer columns don't exist in DB
    if (!insertSuccess) {
      const values = [];
      const placeholders = [];
      let paramIndex = 1;

      for (const activity of activities) {
        placeholders.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6})`);
        values.push(
          userId,
          activity.activityType,
          truncate(activity.applicationName, 255),
          truncate(activity.windowTitle, 500),
          activity.isIdle ?? false,
          activity.durationSeconds ?? null,
          activity.metadata ? JSON.stringify(activity.metadata) : null
        );
        paramIndex += 7;
      }

      const query = `
        INSERT INTO activity_logs
          (user_id, activity_type, application_name, window_title, is_idle, duration_seconds, metadata)
        VALUES ${placeholders.join(', ')}
      `;

      await pool.query(query, values);
    }

    res.json({ success: true, message: `${activities.length} activities logged`, count: activities.length });
  } catch (error) {
    console.error('Batch log error:', error);
    res.status(500).json({ success: false, message: 'Failed to log activities' });
  }
});

// Get activity logs
router.get('/', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, activityType, startDate, endDate, isIdle, shiftDate, sort = 'desc', limit = 100, offset = 0 } = req.query;

    let query = `
      SELECT a.id, a.user_id, a.activity_type, a.application_name, a.window_title,
             a.is_idle, a.duration_seconds, a.keyboard_events, a.url, a.domain,
             a.metadata, a.timestamp,
             u.email, u.full_name
      FROM activity_logs a
      JOIN users u ON a.user_id = u.id WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;

    // Role-based filtering
    if (req.user.role === 'admin') {
      if (userId) {
        query += ` AND a.user_id = $${paramCount}`;
        params.push(userId);
        paramCount++;
      }
    } else if (req.user.role === 'team_manager') {
      const managedUserIds = await getManagedUserIds(pool, req.user.userId);
      const allowedIds = [req.user.userId, ...managedUserIds];

      if (userId && allowedIds.includes(userId)) {
        query += ` AND a.user_id = $${paramCount}`;
        params.push(userId);
        paramCount++;
      } else {
        const placeholders = allowedIds.map((_, i) => `$${paramCount + i}`).join(', ');
        query += ` AND a.user_id IN (${placeholders})`;
        params.push(...allowedIds);
        paramCount += allowedIds.length;
      }
    } else {
      query += ` AND a.user_id = $${paramCount}`;
      params.push(req.user.userId);
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

    if (shiftDate) {
      query += ` AND a.shift_date = $${paramCount}`;
      params.push(shiftDate);
      paramCount++;
    }

    const sortDir = sort === 'asc' ? 'ASC' : 'DESC';
    query += ` ORDER BY a.timestamp ${sortDir} LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get activity error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve activities' });
  }
});

// Get activity summary
router.get('/summary', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, startDate, endDate } = req.query;

    let query = `
      SELECT COUNT(*) as total_activities,
             COUNT(CASE WHEN is_idle = true THEN 1 END) as idle_periods,
             COUNT(CASE WHEN is_idle = false THEN 1 END) as active_periods,
             COUNT(DISTINCT application_name) as unique_applications,
             COALESCE(SUM(duration_seconds), 0) as total_duration_seconds
      FROM activity_logs WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;

    // Role-based filtering
    if (req.user.role === 'admin') {
      if (userId) {
        query += ` AND user_id = $${paramCount}`;
        params.push(userId);
        paramCount++;
      }
    } else if (req.user.role === 'team_manager') {
      const managedUserIds = await getManagedUserIds(pool, req.user.userId);
      const allowedIds = [req.user.userId, ...managedUserIds];

      if (userId && allowedIds.includes(userId)) {
        query += ` AND user_id = $${paramCount}`;
        params.push(userId);
        paramCount++;
      } else {
        const placeholders = allowedIds.map((_, i) => `$${paramCount + i}`).join(', ');
        query += ` AND user_id IN (${placeholders})`;
        params.push(...allowedIds);
        paramCount += allowedIds.length;
      }
    } else {
      query += ` AND user_id = $${paramCount}`;
      params.push(req.user.userId);
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
    }

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Get summary error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve summary' });
  }
});

// Get top applications
router.get('/top-apps', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, startDate, endDate, limit = 10 } = req.query;

    let query = `
      SELECT application_name, COUNT(*) as usage_count, COALESCE(SUM(duration_seconds), 0) as total_duration_seconds
      FROM activity_logs WHERE application_name IS NOT NULL
    `;
    const params = [];
    let paramCount = 1;

    // Role-based filtering
    if (req.user.role === 'admin') {
      if (userId) {
        query += ` AND user_id = $${paramCount}`;
        params.push(userId);
        paramCount++;
      }
    } else if (req.user.role === 'team_manager') {
      const managedUserIds = await getManagedUserIds(pool, req.user.userId);
      const allowedIds = [req.user.userId, ...managedUserIds];

      if (userId && allowedIds.includes(userId)) {
        query += ` AND user_id = $${paramCount}`;
        params.push(userId);
        paramCount++;
      } else {
        const placeholders = allowedIds.map((_, i) => `$${paramCount + i}`).join(', ');
        query += ` AND user_id IN (${placeholders})`;
        params.push(...allowedIds);
        paramCount += allowedIds.length;
      }
    } else {
      query += ` AND user_id = $${paramCount}`;
      params.push(req.user.userId);
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
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get top apps error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve top applications' });
  }
});

module.exports = router;
