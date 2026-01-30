const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeAdmin, authorizeAdminOrManager, getManagedTeamIds } = require('./auth');

// Get all teams with enhanced details (admin sees all, team manager sees managed teams)
router.get('/', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  try {
    const pool = req.app.locals.pool;

    let query = `
      SELECT
        t.id, t.name, t.description, t.manager_id, t.is_active, t.created_at, t.updated_at,
        m.full_name as manager_name,
        COUNT(DISTINCT u.id) as member_count,
        COALESCE(
          (SELECT COUNT(*) FROM user_presence up
           JOIN users u2 ON up.user_id = u2.id
           WHERE u2.team_id = t.id
             AND up.status IN ('online', 'idle')
             AND up.last_heartbeat > NOW() - INTERVAL '90 seconds'), 0
        ) as online_count
      FROM teams t
      LEFT JOIN users u ON t.id = u.team_id AND u.is_active = true
      LEFT JOIN users m ON t.manager_id = m.id
    `;

    const params = [];

    // Team managers only see teams they manage
    if (req.user.role === 'team_manager') {
      const managedTeamIds = await getManagedTeamIds(pool, req.user.userId);
      if (managedTeamIds.length > 0) {
        const placeholders = managedTeamIds.map((_, i) => `$${i + 1}`).join(', ');
        query += ` WHERE t.id IN (${placeholders})`;
        params.push(...managedTeamIds);
      } else {
        return res.json({ success: true, data: [] });
      }
    }

    query += ` GROUP BY t.id, m.full_name ORDER BY t.name`;

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get teams error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve teams' });
  }
});

// Get users not in any team (for assignment) - MUST be before /:id route
router.get('/unassigned/users', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;

    const result = await pool.query(`
      SELECT id, email, full_name, role, is_active, created_at
      FROM users
      WHERE team_id IS NULL AND is_active = true
      ORDER BY full_name
    `);

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get unassigned users error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve unassigned users' });
  }
});

// Get single team with members and settings (admin or team manager of this team)
router.get('/:id', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    // Team managers can only view teams they manage
    if (req.user.role === 'team_manager') {
      const managedTeamIds = await getManagedTeamIds(pool, req.user.userId);
      if (!managedTeamIds.includes(id)) {
        return res.status(403).json({ success: false, message: 'Access denied to this team' });
      }
    }

    const teamResult = await pool.query(`
      SELECT t.*, m.full_name as manager_name
      FROM teams t
      LEFT JOIN users m ON t.manager_id = m.id
      WHERE t.id = $1
    `, [id]);

    if (teamResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Team not found' });
    }

    const [membersResult, settingsResult] = await Promise.all([
      pool.query(`
        SELECT u.id, u.email, u.full_name, u.role, u.is_active, u.created_at,
          CASE
            WHEN up.last_heartbeat > NOW() - INTERVAL '90 seconds' THEN up.status
            ELSE 'offline'
          END as presence_status,
          CASE
            WHEN up.last_heartbeat > NOW() - INTERVAL '90 seconds' THEN up.current_application
            ELSE NULL
          END as current_application
        FROM users u
        LEFT JOIN user_presence up ON u.id = up.user_id
        WHERE u.team_id = $1
        ORDER BY u.full_name
      `, [id]),
      pool.query('SELECT * FROM team_monitoring_settings WHERE team_id = $1', [id])
    ]);

    res.json({
      success: true,
      data: {
        ...teamResult.rows[0],
        members: membersResult.rows,
        settings: settingsResult.rows[0] || null
      }
    });
  } catch (error) {
    console.error('Get team error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve team' });
  }
});

// Create team (admin only)
router.post('/', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { name, description, manager_id } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, message: 'Team name is required' });
    }

    const existingTeam = await pool.query('SELECT id FROM teams WHERE LOWER(name) = LOWER($1)', [name]);
    if (existingTeam.rows.length > 0) {
      return res.status(409).json({ success: false, message: 'A team with this name already exists' });
    }

    const result = await pool.query(
      'INSERT INTO teams (name, description, manager_id) VALUES ($1, $2, $3) RETURNING *',
      [name, description || null, manager_id || null]
    );

    // Create default monitoring settings for the team
    await pool.query(
      'INSERT INTO team_monitoring_settings (team_id) VALUES ($1) ON CONFLICT (team_id) DO NOTHING',
      [result.rows[0].id]
    );

    res.status(201).json({ success: true, message: 'Team created successfully', data: result.rows[0] });
  } catch (error) {
    console.error('Create team error:', error);
    res.status(500).json({ success: false, message: 'Failed to create team' });
  }
});

// Update team (admin only)
router.patch('/:id', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;
    const { name, description, manager_id } = req.body;

    const updates = [];
    const params = [id];
    let paramCount = 2;

    if (name !== undefined) {
      const existingTeam = await pool.query('SELECT id FROM teams WHERE LOWER(name) = LOWER($1) AND id != $2', [name, id]);
      if (existingTeam.rows.length > 0) {
        return res.status(409).json({ success: false, message: 'A team with this name already exists' });
      }
      updates.push(`name = $${paramCount}`);
      params.push(name);
      paramCount++;
    }

    if (description !== undefined) {
      updates.push(`description = $${paramCount}`);
      params.push(description);
      paramCount++;
    }

    if (manager_id !== undefined) {
      updates.push(`manager_id = $${paramCount}`);
      params.push(manager_id || null);
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'No updates provided' });
    }

    const result = await pool.query(
      `UPDATE teams SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Team not found' });
    }

    res.json({ success: true, message: 'Team updated successfully', data: result.rows[0] });
  } catch (error) {
    console.error('Update team error:', error);
    res.status(500).json({ success: false, message: 'Failed to update team' });
  }
});

// Delete team (admin only)
router.delete('/:id', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    const membersCheck = await pool.query('SELECT COUNT(*) as count FROM users WHERE team_id = $1', [id]);
    if (parseInt(membersCheck.rows[0].count) > 0) {
      return res.status(400).json({ success: false, message: 'Cannot delete team with active members. Please reassign members first.' });
    }

    // Delete associated settings
    await pool.query('DELETE FROM team_monitoring_settings WHERE team_id = $1', [id]);

    const result = await pool.query('DELETE FROM teams WHERE id = $1 RETURNING name', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Team not found' });
    }

    res.json({ success: true, message: 'Team deleted successfully' });
  } catch (error) {
    console.error('Delete team error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete team' });
  }
});

// =====================================================
// Team Monitoring Settings
// =====================================================

// Get team monitoring settings
// SECURITY: Requires admin or team manager of this specific team
router.get('/:id/settings', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    // Authorization check: admin can view any, team managers only their own teams, employees only their own team
    if (req.user.role === 'team_manager') {
      const managedTeamIds = await getManagedTeamIds(pool, req.user.userId);
      if (!managedTeamIds.includes(id)) {
        return res.status(403).json({ success: false, message: 'Access denied to this team settings' });
      }
    } else if (req.user.role !== 'admin') {
      // Regular employees can only view their own team's settings
      const userResult = await pool.query('SELECT team_id FROM users WHERE id = $1', [req.user.userId]);
      if (userResult.rows.length === 0 || userResult.rows[0].team_id !== id) {
        return res.status(403).json({ success: false, message: 'Access denied to this team settings' });
      }
    }

    let result = await pool.query('SELECT * FROM team_monitoring_settings WHERE team_id = $1', [id]);

    // Create default settings if none exist
    if (result.rows.length === 0) {
      result = await pool.query(
        'INSERT INTO team_monitoring_settings (team_id) VALUES ($1) RETURNING *',
        [id]
      );
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Get team settings error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve team settings' });
  }
});

// Update team monitoring settings
router.put('/:id/settings', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;
    const {
      screenshot_interval,
      activity_interval,
      idle_threshold,
      track_urls,
      track_applications,
      track_keyboard_mouse,
      working_hours_start,
      working_hours_end,
      working_days
    } = req.body;

    const result = await pool.query(`
      INSERT INTO team_monitoring_settings (
        team_id, screenshot_interval, activity_interval, idle_threshold,
        track_urls, track_applications, track_keyboard_mouse,
        working_hours_start, working_hours_end, working_days
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (team_id) DO UPDATE SET
        screenshot_interval = COALESCE($2, team_monitoring_settings.screenshot_interval),
        activity_interval = COALESCE($3, team_monitoring_settings.activity_interval),
        idle_threshold = COALESCE($4, team_monitoring_settings.idle_threshold),
        track_urls = COALESCE($5, team_monitoring_settings.track_urls),
        track_applications = COALESCE($6, team_monitoring_settings.track_applications),
        track_keyboard_mouse = COALESCE($7, team_monitoring_settings.track_keyboard_mouse),
        working_hours_start = $8,
        working_hours_end = $9,
        working_days = COALESCE($10, team_monitoring_settings.working_days),
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [
      id,
      screenshot_interval || 60,
      activity_interval || 10,
      idle_threshold || 300,
      track_urls !== undefined ? track_urls : true,
      track_applications !== undefined ? track_applications : true,
      track_keyboard_mouse !== undefined ? track_keyboard_mouse : true,
      working_hours_start || null,
      working_hours_end || null,
      working_days || [1, 2, 3, 4, 5]
    ]);

    res.json({ success: true, message: 'Settings updated successfully', data: result.rows[0] });
  } catch (error) {
    console.error('Update team settings error:', error);
    res.status(500).json({ success: false, message: 'Failed to update team settings' });
  }
});

// =====================================================
// Team Member Management
// =====================================================

// Assign user to team
router.post('/:id/members', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    const result = await pool.query(
      'UPDATE users SET team_id = $1 WHERE id = $2 RETURNING id, email, full_name',
      [id, user_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({ success: true, message: 'User assigned to team', data: result.rows[0] });
  } catch (error) {
    console.error('Assign user error:', error);
    res.status(500).json({ success: false, message: 'Failed to assign user' });
  }
});

// Bulk assign users to team
router.post('/:id/bulk-assign', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;
    const { user_ids } = req.body;

    if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
      return res.status(400).json({ success: false, message: 'User IDs array is required' });
    }

    const result = await pool.query(`
      UPDATE users SET team_id = $1
      WHERE id = ANY($2::uuid[])
      RETURNING id, email, full_name
    `, [id, user_ids]);

    res.json({
      success: true,
      message: `${result.rowCount} users assigned to team`,
      data: result.rows
    });
  } catch (error) {
    console.error('Bulk assign error:', error);
    res.status(500).json({ success: false, message: 'Failed to bulk assign users' });
  }
});

// Remove user from team
router.delete('/:id/members/:userId', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id, userId } = req.params;

    const result = await pool.query(
      'UPDATE users SET team_id = NULL WHERE id = $1 AND team_id = $2 RETURNING id, email, full_name',
      [userId, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found in this team' });
    }

    res.json({ success: true, message: 'User removed from team', data: result.rows[0] });
  } catch (error) {
    console.error('Remove user error:', error);
    res.status(500).json({ success: false, message: 'Failed to remove user from team' });
  }
});

// =====================================================
// Team Analytics
// =====================================================

// Get team analytics
// SECURITY: Requires admin or team manager of this specific team
router.get('/:id/analytics', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;
    const { start_date, end_date } = req.query;

    // Authorization check: admin can view any, team managers only their teams
    if (req.user.role === 'team_manager') {
      const managedTeamIds = await getManagedTeamIds(pool, req.user.userId);
      if (!managedTeamIds.includes(id)) {
        return res.status(403).json({ success: false, message: 'Access denied to this team analytics' });
      }
    } else if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin or Team Manager access required' });
    }

    const startDate = start_date || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = end_date || new Date().toISOString().split('T')[0];

    // Get aggregated productivity for the team
    const productivityResult = await pool.query(`
      SELECT
        pm.date,
        SUM(pm.total_active_time) as total_active_time,
        SUM(pm.total_idle_time) as total_idle_time,
        SUM(pm.productive_time) as productive_time,
        SUM(pm.unproductive_time) as unproductive_time,
        SUM(pm.keyboard_events) as keyboard_events,
        SUM(pm.mouse_events) as mouse_events,
        COUNT(DISTINCT pm.user_id) as active_users
      FROM productivity_metrics pm
      JOIN users u ON pm.user_id = u.id
      WHERE u.team_id = $1 AND pm.date BETWEEN $2 AND $3
      GROUP BY pm.date
      ORDER BY pm.date
    `, [id, startDate, endDate]);

    // Get per-member breakdown
    const memberResult = await pool.query(`
      SELECT
        u.id, u.full_name, u.email,
        SUM(pm.total_active_time) as total_active_time,
        SUM(pm.productive_time) as productive_time,
        SUM(pm.unproductive_time) as unproductive_time,
        CASE
          WHEN SUM(pm.total_active_time) > 0
          THEN ROUND(SUM(pm.productive_time)::numeric / SUM(pm.total_active_time) * 100, 1)
          ELSE 0
        END as productivity_percentage
      FROM users u
      LEFT JOIN productivity_metrics pm ON u.id = pm.user_id AND pm.date BETWEEN $2 AND $3
      WHERE u.team_id = $1
      GROUP BY u.id, u.full_name, u.email
      ORDER BY productivity_percentage DESC NULLS LAST
    `, [id, startDate, endDate]);

    // Get top applications for the team
    const appsResult = await pool.query(`
      SELECT
        al.application_name,
        COUNT(*) as usage_count,
        SUM(EXTRACT(EPOCH FROM (al.end_time - al.start_time))) as total_seconds
      FROM activity_logs al
      JOIN users u ON al.user_id = u.id
      WHERE u.team_id = $1
        AND al.start_time >= $2::date
        AND al.start_time < ($3::date + interval '1 day')
        AND al.application_name IS NOT NULL
      GROUP BY al.application_name
      ORDER BY total_seconds DESC NULLS LAST
      LIMIT 10
    `, [id, startDate, endDate]);

    res.json({
      success: true,
      data: {
        daily_productivity: productivityResult.rows,
        member_breakdown: memberResult.rows,
        top_applications: appsResult.rows
      }
    });
  } catch (error) {
    console.error('Get team analytics error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve team analytics' });
  }
});

module.exports = router;
