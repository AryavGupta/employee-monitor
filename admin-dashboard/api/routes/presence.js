const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeAdmin, authorizeAdminOrManager, getManagedTeamIds, getManagedUserIds } = require('./auth');

// Heartbeat - Desktop app sends this every 30 seconds
router.post('/heartbeat', authenticateToken, async (req, res) => {
  try {
    const { status, currentApplication, windowTitle, currentUrl, sessionId } = req.body;
    const userId = req.user.userId;
    const pool = req.app.locals.pool;

    // Upsert user presence
    await pool.query(`
      INSERT INTO user_presence (user_id, status, current_application, current_window_title, current_url, session_id, last_heartbeat)
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id)
      DO UPDATE SET
        status = $2,
        current_application = $3,
        current_window_title = $4,
        current_url = $5,
        session_id = $6,
        last_heartbeat = CURRENT_TIMESTAMP
    `, [userId, status || 'online', currentApplication || null, windowTitle || null, currentUrl || null, sessionId || null]);

    res.json({ success: true, message: 'Heartbeat received' });
  } catch (error) {
    console.error('Heartbeat error:', error);
    res.status(500).json({ success: false, message: 'Failed to update presence' });
  }
});

// Get all online users (admin and team managers)
router.get('/online', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  try {
    const pool = req.app.locals.pool;

    let query = `
      SELECT
        p.user_id,
        p.status,
        p.current_application,
        p.current_window_title,
        p.current_url,
        p.last_heartbeat,
        u.full_name,
        u.email,
        t.name as team_name,
        t.id as team_id,
        CASE
          WHEN p.last_heartbeat > NOW() - INTERVAL '90 seconds' THEN p.status
          ELSE 'offline'
        END as effective_status
      FROM user_presence p
      JOIN users u ON p.user_id = u.id
      LEFT JOIN teams t ON u.team_id = t.id
      WHERE u.is_active = true
    `;

    const params = [];

    // Team managers only see their team members
    if (req.user.role === 'team_manager') {
      const managedTeamIds = await getManagedTeamIds(pool, req.user.userId);
      if (managedTeamIds.length > 0) {
        const placeholders = managedTeamIds.map((_, i) => `$${i + 1}`).join(', ');
        query += ` AND u.team_id IN (${placeholders})`;
        params.push(...managedTeamIds);
      } else {
        // No teams managed - return empty
        return res.json({ success: true, data: [] });
      }
    }

    query += ` ORDER BY p.last_heartbeat DESC`;

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get online users error:', error);
    res.status(500).json({ success: false, message: 'Failed to get online users' });
  }
});

// Get presence summary stats (admin and team managers)
router.get('/summary', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  try {
    const pool = req.app.locals.pool;

    let summaryQuery = `
      SELECT
        COUNT(CASE WHEN last_heartbeat > NOW() - INTERVAL '90 seconds' AND status = 'online' THEN 1 END) as online_count,
        COUNT(CASE WHEN last_heartbeat > NOW() - INTERVAL '90 seconds' AND status = 'idle' THEN 1 END) as idle_count,
        COUNT(CASE WHEN last_heartbeat <= NOW() - INTERVAL '90 seconds' OR status = 'offline' THEN 1 END) as offline_count
      FROM user_presence p
      JOIN users u ON p.user_id = u.id
      WHERE u.is_active = true
    `;

    let totalQuery = `SELECT COUNT(*) as total FROM users WHERE is_active = true`;
    const params = [];

    // Team managers only see their team stats
    if (req.user.role === 'team_manager') {
      const managedTeamIds = await getManagedTeamIds(pool, req.user.userId);
      if (managedTeamIds.length > 0) {
        const placeholders = managedTeamIds.map((_, i) => `$${i + 1}`).join(', ');
        summaryQuery += ` AND u.team_id IN (${placeholders})`;
        totalQuery += ` AND team_id IN (${placeholders})`;
        params.push(...managedTeamIds);
      } else {
        return res.json({
          success: true,
          data: { online: 0, idle: 0, offline: 0, total_users: 0 }
        });
      }
    }

    const result = await pool.query(summaryQuery, params);
    const totalResult = await pool.query(totalQuery, params);

    res.json({
      success: true,
      data: {
        online: parseInt(result.rows[0]?.online_count || 0),
        idle: parseInt(result.rows[0]?.idle_count || 0),
        offline: parseInt(result.rows[0]?.offline_count || 0),
        total_users: parseInt(totalResult.rows[0]?.total || 0)
      }
    });
  } catch (error) {
    console.error('Get presence summary error:', error);
    res.status(500).json({ success: false, message: 'Failed to get presence summary' });
  }
});

// Get specific user's presence
router.get('/user/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const pool = req.app.locals.pool;

    // Non-admins can only view their own presence
    if (req.user.role !== 'admin' && req.user.userId !== id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const result = await pool.query(`
      SELECT
        p.*,
        u.full_name,
        u.email,
        t.name as team_name,
        CASE
          WHEN p.last_heartbeat > NOW() - INTERVAL '90 seconds' THEN p.status
          ELSE 'offline'
        END as effective_status
      FROM user_presence p
      JOIN users u ON p.user_id = u.id
      LEFT JOIN teams t ON u.team_id = t.id
      WHERE p.user_id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.json({ success: true, data: { status: 'offline', user_id: id } });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Get user presence error:', error);
    res.status(500).json({ success: false, message: 'Failed to get user presence' });
  }
});

// Set user offline (called when desktop app closes)
router.post('/offline', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const pool = req.app.locals.pool;

    await pool.query(`
      UPDATE user_presence
      SET status = 'offline', last_heartbeat = CURRENT_TIMESTAMP
      WHERE user_id = $1
    `, [userId]);

    res.json({ success: true, message: 'Status set to offline' });
  } catch (error) {
    console.error('Set offline error:', error);
    res.status(500).json({ success: false, message: 'Failed to update status' });
  }
});

// Get live activity feed (recent activities across users - admin and team managers)
router.get('/activity-feed', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  try {
    const { limit = 50, since } = req.query;
    const pool = req.app.locals.pool;

    let query = `
      SELECT
        a.id,
        a.user_id,
        a.activity_type,
        a.application_name,
        a.window_title,
        a.is_idle,
        a.url,
        a.domain,
        a.is_blocked_attempt,
        a.timestamp,
        u.full_name,
        u.email,
        t.name as team_name
      FROM activity_logs a
      JOIN users u ON a.user_id = u.id
      LEFT JOIN teams t ON u.team_id = t.id
      WHERE 1=1
    `;

    const params = [];
    let paramCount = 1;

    // Team managers only see their team's activity
    if (req.user.role === 'team_manager') {
      const managedTeamIds = await getManagedTeamIds(pool, req.user.userId);
      if (managedTeamIds.length > 0) {
        const placeholders = managedTeamIds.map((_, i) => `$${paramCount + i}`).join(', ');
        query += ` AND u.team_id IN (${placeholders})`;
        params.push(...managedTeamIds);
        paramCount += managedTeamIds.length;
      } else {
        return res.json({ success: true, data: [] });
      }
    }

    if (since) {
      query += ` AND a.timestamp > $${paramCount}`;
      params.push(since);
      paramCount++;
    }

    query += ` ORDER BY a.timestamp DESC LIMIT $${paramCount}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get activity feed error:', error);
    res.status(500).json({ success: false, message: 'Failed to get activity feed' });
  }
});

// Get recent screenshots for live view (admin and team managers)
router.get('/recent-screenshots', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  try {
    const { limit = 20, since } = req.query;
    const pool = req.app.locals.pool;

    let query = `
      SELECT
        s.id,
        s.user_id,
        s.screenshot_url,
        s.captured_at,
        s.is_flagged,
        u.full_name,
        u.email,
        t.name as team_name
      FROM screenshots s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN teams t ON u.team_id = t.id
      WHERE 1=1
    `;

    const params = [];
    let paramCount = 1;

    // Team managers only see their team's screenshots
    if (req.user.role === 'team_manager') {
      const managedTeamIds = await getManagedTeamIds(pool, req.user.userId);
      if (managedTeamIds.length > 0) {
        const placeholders = managedTeamIds.map((_, i) => `$${paramCount + i}`).join(', ');
        query += ` AND u.team_id IN (${placeholders})`;
        params.push(...managedTeamIds);
        paramCount += managedTeamIds.length;
      } else {
        return res.json({ success: true, data: [] });
      }
    }

    if (since) {
      query += ` AND s.captured_at > $${paramCount}`;
      params.push(since);
      paramCount++;
    }

    query += ` ORDER BY s.captured_at DESC LIMIT $${paramCount}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get recent screenshots error:', error);
    res.status(500).json({ success: false, message: 'Failed to get recent screenshots' });
  }
});

// =====================================================
// Alert Rules Management
// =====================================================

// Get all alert rules
router.get('/alert-rules', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const { teamId, isActive } = req.query;
    const pool = req.app.locals.pool;

    let query = `
      SELECT
        ar.*,
        t.name as team_name,
        u.full_name as created_by_name
      FROM alert_rules ar
      LEFT JOIN teams t ON ar.team_id = t.id
      LEFT JOIN users u ON ar.created_by = u.id
      WHERE 1=1
    `;

    const params = [];
    let paramCount = 1;

    if (teamId) {
      query += ` AND (ar.team_id = $${paramCount} OR ar.team_id IS NULL)`;
      params.push(teamId);
      paramCount++;
    }

    if (isActive !== undefined) {
      query += ` AND ar.is_active = $${paramCount}`;
      params.push(isActive === 'true');
      paramCount++;
    }

    query += ` ORDER BY ar.created_at DESC`;

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get alert rules error:', error);
    res.status(500).json({ success: false, message: 'Failed to get alert rules' });
  }
});

// Create alert rule
router.post('/alert-rules', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const { name, description, ruleType, conditions, severity, teamId, isActive } = req.body;
    const pool = req.app.locals.pool;

    if (!name || !ruleType || !conditions) {
      return res.status(400).json({ success: false, message: 'Name, rule type, and conditions are required' });
    }

    const validRuleTypes = ['idle_threshold', 'blocked_site', 'application_usage', 'working_hours', 'productivity_drop'];
    if (!validRuleTypes.includes(ruleType)) {
      return res.status(400).json({ success: false, message: 'Invalid rule type' });
    }

    const result = await pool.query(`
      INSERT INTO alert_rules (name, description, rule_type, conditions, severity, team_id, is_active, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [name, description || null, ruleType, JSON.stringify(conditions), severity || 'medium', teamId || null, isActive !== false, req.user.userId]);

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Create alert rule error:', error);
    res.status(500).json({ success: false, message: 'Failed to create alert rule' });
  }
});

// Update alert rule
router.patch('/alert-rules/:id', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, ruleType, conditions, severity, teamId, isActive } = req.body;
    const pool = req.app.locals.pool;

    const updates = [];
    const params = [];
    let paramCount = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramCount}`);
      params.push(name);
      paramCount++;
    }

    if (description !== undefined) {
      updates.push(`description = $${paramCount}`);
      params.push(description);
      paramCount++;
    }

    if (ruleType !== undefined) {
      updates.push(`rule_type = $${paramCount}`);
      params.push(ruleType);
      paramCount++;
    }

    if (conditions !== undefined) {
      updates.push(`conditions = $${paramCount}`);
      params.push(JSON.stringify(conditions));
      paramCount++;
    }

    if (severity !== undefined) {
      updates.push(`severity = $${paramCount}`);
      params.push(severity);
      paramCount++;
    }

    if (teamId !== undefined) {
      updates.push(`team_id = $${paramCount}`);
      params.push(teamId || null);
      paramCount++;
    }

    if (isActive !== undefined) {
      updates.push(`is_active = $${paramCount}`);
      params.push(isActive);
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    params.push(id);

    const result = await pool.query(
      `UPDATE alert_rules SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Alert rule not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Update alert rule error:', error);
    res.status(500).json({ success: false, message: 'Failed to update alert rule' });
  }
});

// Delete alert rule
router.delete('/alert-rules/:id', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const pool = req.app.locals.pool;

    const result = await pool.query('DELETE FROM alert_rules WHERE id = $1 RETURNING id', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Alert rule not found' });
    }

    res.json({ success: true, message: 'Alert rule deleted' });
  } catch (error) {
    console.error('Delete alert rule error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete alert rule' });
  }
});

// Toggle alert rule active status
router.patch('/alert-rules/:id/toggle', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const pool = req.app.locals.pool;

    const result = await pool.query(`
      UPDATE alert_rules
      SET is_active = NOT is_active, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Alert rule not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Toggle alert rule error:', error);
    res.status(500).json({ success: false, message: 'Failed to toggle alert rule' });
  }
});

module.exports = router;
