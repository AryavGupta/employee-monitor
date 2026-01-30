const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeAdmin } = require('./auth');

// Get all teams
router.get('/', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;

    const result = await pool.query(`
      SELECT
        t.id,
        t.name,
        t.description,
        t.created_at,
        t.updated_at,
        COUNT(u.id) as member_count
      FROM teams t
      LEFT JOIN users u ON t.id = u.team_id AND u.is_active = true
      GROUP BY t.id, t.name, t.description, t.created_at, t.updated_at
      ORDER BY t.name
    `);

    res.json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error('Get teams error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve teams'
    });
  }
});

// Get single team with members
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    // Get team details
    const teamResult = await pool.query(
      'SELECT * FROM teams WHERE id = $1',
      [id]
    );

    if (teamResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    // Get team members
    const membersResult = await pool.query(
      `SELECT id, email, full_name, role, is_active, created_at
       FROM users WHERE team_id = $1 ORDER BY full_name`,
      [id]
    );

    res.json({
      success: true,
      data: {
        ...teamResult.rows[0],
        members: membersResult.rows
      }
    });

  } catch (error) {
    console.error('Get team error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve team'
    });
  }
});

// Create new team (admin only)
router.post('/', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Team name is required'
      });
    }

    // Check if team name already exists
    const existingTeam = await pool.query(
      'SELECT id FROM teams WHERE LOWER(name) = LOWER($1)',
      [name]
    );

    if (existingTeam.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'A team with this name already exists'
      });
    }

    const result = await pool.query(
      `INSERT INTO teams (name, description)
       VALUES ($1, $2)
       RETURNING *`,
      [name, description || null]
    );

    // Log audit trail
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.userId, 'CREATE_TEAM', 'team', result.rows[0].id, JSON.stringify({ name, description })]
    );

    res.status(201).json({
      success: true,
      message: 'Team created successfully',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Create team error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create team'
    });
  }
});

// Update team (admin only)
router.patch('/:id', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;
    const { name, description } = req.body;

    const updates = [];
    const params = [id];
    let paramCount = 2;

    if (name !== undefined) {
      // Check if new name already exists for different team
      const existingTeam = await pool.query(
        'SELECT id FROM teams WHERE LOWER(name) = LOWER($1) AND id != $2',
        [name, id]
      );

      if (existingTeam.rows.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'A team with this name already exists'
        });
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

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No updates provided'
      });
    }

    const query = `
      UPDATE teams
      SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    // Log audit trail
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.userId, 'UPDATE_TEAM', 'team', id, JSON.stringify(req.body)]
    );

    res.json({
      success: true,
      message: 'Team updated successfully',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Update team error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update team'
    });
  }
});

// Delete team (admin only)
router.delete('/:id', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    // Check if team has members
    const membersCheck = await pool.query(
      'SELECT COUNT(*) as count FROM users WHERE team_id = $1',
      [id]
    );

    if (parseInt(membersCheck.rows[0].count) > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete team with active members. Reassign or remove members first.'
      });
    }

    const result = await pool.query(
      'DELETE FROM teams WHERE id = $1 RETURNING name',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    // Log audit trail
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id)
       VALUES ($1, $2, $3, $4)`,
      [req.user.userId, 'DELETE_TEAM', 'team', id]
    );

    res.json({
      success: true,
      message: 'Team deleted successfully'
    });

  } catch (error) {
    console.error('Delete team error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete team'
    });
  }
});

// Add member to team (admin only)
router.post('/:id/members', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    // Check if team exists
    const teamCheck = await pool.query('SELECT id FROM teams WHERE id = $1', [id]);
    if (teamCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    // Update user's team
    const result = await pool.query(
      `UPDATE users SET team_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, email, full_name, team_id`,
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Log audit trail
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.userId, 'ADD_TEAM_MEMBER', 'team', id, JSON.stringify({ userId })]
    );

    res.json({
      success: true,
      message: 'Member added to team',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Add member error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add member'
    });
  }
});

// Remove member from team (admin only)
router.delete('/:id/members/:userId', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id, userId } = req.params;

    const result = await pool.query(
      `UPDATE users SET team_id = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND team_id = $2
       RETURNING id, email, full_name`,
      [userId, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found in this team'
      });
    }

    // Log audit trail
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.userId, 'REMOVE_TEAM_MEMBER', 'team', id, JSON.stringify({ userId })]
    );

    res.json({
      success: true,
      message: 'Member removed from team',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Remove member error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove member'
    });
  }
});

// Get team statistics
router.get('/:id/stats', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;
    const { startDate, endDate } = req.query;

    // Get team member stats
    let query = `
      SELECT
        COUNT(DISTINCT u.id) as total_members,
        COUNT(DISTINCT CASE WHEN u.is_active = true THEN u.id END) as active_members,
        COUNT(s.id) as total_screenshots,
        COUNT(CASE WHEN s.is_flagged = true THEN 1 END) as flagged_screenshots,
        COALESCE(SUM(ws.total_active_time), 0) as total_active_seconds,
        COALESCE(SUM(ws.total_idle_time), 0) as total_idle_seconds
      FROM users u
      LEFT JOIN screenshots s ON u.id = s.user_id
      LEFT JOIN work_sessions ws ON u.id = ws.user_id
      WHERE u.team_id = $1
    `;

    const params = [id];
    let paramCount = 2;

    if (startDate) {
      query += ` AND (s.captured_at >= $${paramCount} OR s.captured_at IS NULL)`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      query += ` AND (s.captured_at <= $${paramCount} OR s.captured_at IS NULL)`;
      params.push(endDate);
      paramCount++;
    }

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Get team stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve team statistics'
    });
  }
});

module.exports = router;
