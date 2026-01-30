const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeAdmin } = require('./auth');

// Get productivity metrics with date range and grouping
router.get('/productivity', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, teamId, startDate, endDate, groupBy = 'day' } = req.query;

    // Build the base query for productivity data
    let query = `
      SELECT
        u.id as user_id,
        u.full_name,
        u.email,
        t.name as team_name,
        DATE(a.timestamp) as date,
        COUNT(*) as total_activities,
        COUNT(CASE WHEN a.is_idle = false THEN 1 END) as active_count,
        COUNT(CASE WHEN a.is_idle = true THEN 1 END) as idle_count,
        COALESCE(SUM(CASE WHEN a.is_idle = false THEN a.duration_seconds ELSE 0 END), 0) as active_seconds,
        COALESCE(SUM(CASE WHEN a.is_idle = true THEN a.duration_seconds ELSE 0 END), 0) as idle_seconds,
        COALESCE(SUM(a.keyboard_events), 0) as keyboard_events,
        COALESCE(SUM(a.mouse_events), 0) as mouse_events
      FROM activity_logs a
      JOIN users u ON a.user_id = u.id
      LEFT JOIN teams t ON u.team_id = t.id
      WHERE 1=1
    `;

    const params = [];
    let paramCount = 1;

    // Non-admin users can only see their own data
    if (req.user.role !== 'admin') {
      query += ` AND a.user_id = $${paramCount}`;
      params.push(req.user.userId);
      paramCount++;
    } else if (userId) {
      query += ` AND a.user_id = $${paramCount}`;
      params.push(userId);
      paramCount++;
    }

    if (teamId) {
      query += ` AND u.team_id = $${paramCount}`;
      params.push(teamId);
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

    // Group by date and user
    query += ` GROUP BY u.id, u.full_name, u.email, t.name, DATE(a.timestamp) ORDER BY date DESC, u.full_name`;

    const result = await pool.query(query, params);

    // Calculate productivity score for each row
    const data = result.rows.map(row => {
      const totalTime = parseInt(row.active_seconds) + parseInt(row.idle_seconds);
      const productivityScore = totalTime > 0
        ? Math.round((parseInt(row.active_seconds) / totalTime) * 100)
        : 0;

      return {
        ...row,
        productivity_score: productivityScore,
        total_time_seconds: totalTime
      };
    });

    res.json({ success: true, data });
  } catch (error) {
    console.error('Get productivity error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve productivity data' });
  }
});

// Get hourly breakdown for a specific date
router.get('/productivity/hourly', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, date } = req.query;

    if (!date) {
      return res.status(400).json({ success: false, message: 'Date is required' });
    }

    let targetUserId = req.user.role === 'admin' && userId ? userId : req.user.userId;

    const query = `
      SELECT
        EXTRACT(HOUR FROM timestamp) as hour,
        COUNT(*) as activity_count,
        COUNT(CASE WHEN is_idle = false THEN 1 END) as active_count,
        COUNT(CASE WHEN is_idle = true THEN 1 END) as idle_count,
        COALESCE(SUM(CASE WHEN is_idle = false THEN duration_seconds ELSE 0 END), 0) as active_seconds,
        COALESCE(SUM(keyboard_events), 0) as keyboard_events,
        COALESCE(SUM(mouse_events), 0) as mouse_events,
        COUNT(DISTINCT application_name) as unique_apps
      FROM activity_logs
      WHERE user_id = $1 AND DATE(timestamp) = $2
      GROUP BY EXTRACT(HOUR FROM timestamp)
      ORDER BY hour
    `;

    const result = await pool.query(query, [targetUserId, date]);

    // Fill in missing hours with zeros
    const hourlyData = Array.from({ length: 24 }, (_, i) => {
      const existing = result.rows.find(r => parseInt(r.hour) === i);
      return existing || {
        hour: i,
        activity_count: 0,
        active_count: 0,
        idle_count: 0,
        active_seconds: 0,
        keyboard_events: 0,
        mouse_events: 0,
        unique_apps: 0
      };
    });

    res.json({ success: true, data: hourlyData });
  } catch (error) {
    console.error('Get hourly breakdown error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve hourly data' });
  }
});

// Get team comparison data
router.get('/productivity/comparison', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { startDate, endDate, compareBy = 'user' } = req.query;

    let query;
    const params = [];
    let paramCount = 1;

    if (compareBy === 'team') {
      query = `
        SELECT
          t.id as team_id,
          t.name as team_name,
          COUNT(DISTINCT u.id) as member_count,
          COUNT(a.id) as total_activities,
          COALESCE(SUM(CASE WHEN a.is_idle = false THEN a.duration_seconds ELSE 0 END), 0) as active_seconds,
          COALESCE(SUM(CASE WHEN a.is_idle = true THEN a.duration_seconds ELSE 0 END), 0) as idle_seconds,
          COALESCE(SUM(a.keyboard_events), 0) as keyboard_events,
          COALESCE(SUM(a.mouse_events), 0) as mouse_events
        FROM teams t
        LEFT JOIN users u ON u.team_id = t.id AND u.is_active = true
        LEFT JOIN activity_logs a ON a.user_id = u.id
      `;

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

      query += ` GROUP BY t.id, t.name ORDER BY active_seconds DESC`;
    } else {
      // Compare by user
      query = `
        SELECT
          u.id as user_id,
          u.full_name,
          u.email,
          t.name as team_name,
          COUNT(a.id) as total_activities,
          COALESCE(SUM(CASE WHEN a.is_idle = false THEN a.duration_seconds ELSE 0 END), 0) as active_seconds,
          COALESCE(SUM(CASE WHEN a.is_idle = true THEN a.duration_seconds ELSE 0 END), 0) as idle_seconds,
          COALESCE(SUM(a.keyboard_events), 0) as keyboard_events,
          COALESCE(SUM(a.mouse_events), 0) as mouse_events,
          COUNT(DISTINCT DATE(a.timestamp)) as days_active
        FROM users u
        LEFT JOIN teams t ON u.team_id = t.id
        LEFT JOIN activity_logs a ON a.user_id = u.id
        WHERE u.is_active = true
      `;

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

      query += ` GROUP BY u.id, u.full_name, u.email, t.name ORDER BY active_seconds DESC`;
    }

    const result = await pool.query(query, params);

    // Calculate productivity score
    const data = result.rows.map(row => {
      const totalTime = parseInt(row.active_seconds) + parseInt(row.idle_seconds);
      return {
        ...row,
        productivity_score: totalTime > 0
          ? Math.round((parseInt(row.active_seconds) / totalTime) * 100)
          : 0,
        total_time_seconds: totalTime
      };
    });

    res.json({ success: true, data });
  } catch (error) {
    console.error('Get comparison error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve comparison data' });
  }
});

// Get top applications with categorization
router.get('/applications', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, teamId, startDate, endDate, limit = 20 } = req.query;

    let query = `
      SELECT
        a.application_name,
        COUNT(*) as usage_count,
        COALESCE(SUM(a.duration_seconds), 0) as total_seconds,
        COALESCE(c.category, 'neutral') as category,
        c.name as category_name
      FROM activity_logs a
      LEFT JOIN app_categories c ON LOWER(a.application_name) ~ LOWER(c.pattern)
      JOIN users u ON a.user_id = u.id
      WHERE a.application_name IS NOT NULL AND a.application_name != ''
    `;

    const params = [];
    let paramCount = 1;

    if (req.user.role !== 'admin') {
      query += ` AND a.user_id = $${paramCount}`;
      params.push(req.user.userId);
      paramCount++;
    } else if (userId) {
      query += ` AND a.user_id = $${paramCount}`;
      params.push(userId);
      paramCount++;
    }

    if (teamId) {
      query += ` AND u.team_id = $${paramCount}`;
      params.push(teamId);
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

    query += ` GROUP BY a.application_name, c.category, c.name
               ORDER BY total_seconds DESC
               LIMIT $${paramCount}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);

    // Calculate totals by category
    const categoryTotals = {
      productive: { count: 0, seconds: 0 },
      unproductive: { count: 0, seconds: 0 },
      neutral: { count: 0, seconds: 0 }
    };

    result.rows.forEach(row => {
      const cat = row.category || 'neutral';
      categoryTotals[cat].count += parseInt(row.usage_count);
      categoryTotals[cat].seconds += parseInt(row.total_seconds);
    });

    res.json({
      success: true,
      data: result.rows,
      summary: categoryTotals
    });
  } catch (error) {
    console.error('Get applications error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve applications data' });
  }
});

// Get URL/website analytics
router.get('/websites', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, teamId, startDate, endDate, limit = 20 } = req.query;

    let query = `
      SELECT
        a.domain,
        COUNT(*) as visit_count,
        COALESCE(SUM(a.duration_seconds), 0) as total_seconds,
        COUNT(CASE WHEN a.is_blocked_attempt = true THEN 1 END) as blocked_attempts,
        sr.rule_type,
        sr.category
      FROM activity_logs a
      LEFT JOIN site_rules sr ON a.domain = sr.domain
      JOIN users u ON a.user_id = u.id
      WHERE a.domain IS NOT NULL AND a.domain != ''
    `;

    const params = [];
    let paramCount = 1;

    if (req.user.role !== 'admin') {
      query += ` AND a.user_id = $${paramCount}`;
      params.push(req.user.userId);
      paramCount++;
    } else if (userId) {
      query += ` AND a.user_id = $${paramCount}`;
      params.push(userId);
      paramCount++;
    }

    if (teamId) {
      query += ` AND u.team_id = $${paramCount}`;
      params.push(teamId);
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

    query += ` GROUP BY a.domain, sr.rule_type, sr.category
               ORDER BY total_seconds DESC
               LIMIT $${paramCount}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get websites error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve website data' });
  }
});

// Get dashboard summary stats (optimized - single combined query)
router.get('/dashboard-summary', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { startDate, endDate, userId, teamId } = req.query;

    const today = new Date().toISOString().split('T')[0];
    const start = startDate || today;
    const end = endDate || today + 'T23:59:59';

    // Combined query for better performance
    const combinedQuery = `
      WITH activity_stats AS (
        SELECT
          COUNT(DISTINCT a.user_id) as active_users,
          COUNT(a.id) as total_activities,
          COALESCE(SUM(CASE WHEN a.is_idle = false THEN a.duration_seconds ELSE 0 END), 0) as total_active_seconds,
          COALESCE(SUM(CASE WHEN a.is_idle = true THEN a.duration_seconds ELSE 0 END), 0) as total_idle_seconds,
          COALESCE(SUM(a.keyboard_events), 0) as total_keyboard_events,
          COALESCE(SUM(a.mouse_events), 0) as total_mouse_events
        FROM activity_logs a
        ${userId ? 'WHERE a.user_id = $3' : ''}
        ${!userId ? 'WHERE' : 'AND'} a.timestamp >= $1 AND a.timestamp <= $2
      ),
      screenshot_stats AS (
        SELECT
          COUNT(*) as total_screenshots,
          COUNT(CASE WHEN is_flagged = true THEN 1 END) as flagged_screenshots
        FROM screenshots
        WHERE captured_at >= $1 AND captured_at <= $2
        ${userId ? 'AND user_id = $3' : ''}
      ),
      alert_stats AS (
        SELECT
          COUNT(*) as total_alerts,
          COUNT(CASE WHEN is_read = false THEN 1 END) as unread_alerts
        FROM alerts
        WHERE created_at >= $1 AND created_at <= $2
        ${userId ? 'AND user_id = $3' : ''}
      )
      SELECT
        a.*, s.total_screenshots, s.flagged_screenshots, al.total_alerts, al.unread_alerts
      FROM activity_stats a, screenshot_stats s, alert_stats al
    `;

    const params = userId ? [start, end, userId] : [start, end];
    const result = await pool.query(combinedQuery, params);

    const stats = result.rows[0];
    const totalActiveSeconds = parseInt(stats.total_active_seconds) || 0;
    const totalIdleSeconds = parseInt(stats.total_idle_seconds) || 0;
    const totalTime = totalActiveSeconds + totalIdleSeconds;
    const productivityScore = totalTime > 0
      ? Math.round((totalActiveSeconds / totalTime) * 100)
      : 0;

    // Set cache headers for 30 seconds
    res.set('Cache-Control', 'private, max-age=30');

    res.json({
      success: true,
      data: {
        active_users: parseInt(stats.active_users) || 0,
        total_activities: parseInt(stats.total_activities) || 0,
        active_time_hours: Math.round(totalActiveSeconds / 3600 * 10) / 10,
        idle_time_hours: Math.round(totalIdleSeconds / 3600 * 10) / 10,
        productivity_score: productivityScore,
        keyboard_events: parseInt(stats.total_keyboard_events) || 0,
        mouse_events: parseInt(stats.total_mouse_events) || 0,
        screenshots: {
          total: parseInt(stats.total_screenshots) || 0,
          flagged: parseInt(stats.flagged_screenshots) || 0
        },
        alerts: {
          total: parseInt(stats.total_alerts) || 0,
          unread: parseInt(stats.unread_alerts) || 0
        }
      }
    });
  } catch (error) {
    console.error('Get dashboard summary error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve dashboard summary' });
  }
});

// =====================================================
// App Categories Management
// =====================================================

// Get all app categories
router.get('/app-categories', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { teamId } = req.query;

    let query = `
      SELECT c.*, t.name as team_name, u.full_name as created_by_name
      FROM app_categories c
      LEFT JOIN teams t ON c.team_id = t.id
      LEFT JOIN users u ON c.created_by = u.id
      WHERE c.team_id IS NULL
    `;
    const params = [];

    if (teamId) {
      query += ` OR c.team_id = $1`;
      params.push(teamId);
    }

    query += ` ORDER BY c.category, c.name`;

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get app categories error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve app categories' });
  }
});

// Create app category (admin only)
router.post('/app-categories', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const { name, pattern, category, teamId } = req.body;
    const pool = req.app.locals.pool;

    if (!name || !pattern || !category) {
      return res.status(400).json({ success: false, message: 'Name, pattern, and category are required' });
    }

    if (!['productive', 'unproductive', 'neutral'].includes(category)) {
      return res.status(400).json({ success: false, message: 'Category must be productive, unproductive, or neutral' });
    }

    const result = await pool.query(
      `INSERT INTO app_categories (name, pattern, category, team_id, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, pattern, category, teamId || null, req.user.userId]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Create app category error:', error);
    res.status(500).json({ success: false, message: 'Failed to create app category' });
  }
});

// Update app category (admin only)
router.patch('/app-categories/:id', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, pattern, category, teamId } = req.body;
    const pool = req.app.locals.pool;

    const updates = [];
    const params = [];
    let paramCount = 1;

    if (name) {
      updates.push(`name = $${paramCount}`);
      params.push(name);
      paramCount++;
    }

    if (pattern) {
      updates.push(`pattern = $${paramCount}`);
      params.push(pattern);
      paramCount++;
    }

    if (category) {
      if (!['productive', 'unproductive', 'neutral'].includes(category)) {
        return res.status(400).json({ success: false, message: 'Category must be productive, unproductive, or neutral' });
      }
      updates.push(`category = $${paramCount}`);
      params.push(category);
      paramCount++;
    }

    if (teamId !== undefined) {
      updates.push(`team_id = $${paramCount}`);
      params.push(teamId || null);
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    params.push(id);
    const result = await pool.query(
      `UPDATE app_categories SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Update app category error:', error);
    res.status(500).json({ success: false, message: 'Failed to update app category' });
  }
});

// Delete app category (admin only)
router.delete('/app-categories/:id', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const pool = req.app.locals.pool;

    const result = await pool.query('DELETE FROM app_categories WHERE id = $1 RETURNING id', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    res.json({ success: true, message: 'Category deleted successfully' });
  } catch (error) {
    console.error('Delete app category error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete app category' });
  }
});

module.exports = router;
