const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeAdmin } = require('./auth');

// Get all users (admin only)
router.get('/', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { teamId, role, isActive } = req.query;

    let query = `
      SELECT 
        u.id,
        u.email,
        u.full_name,
        u.role,
        u.team_id,
        u.is_active,
        u.created_at,
        t.name as team_name
      FROM users u
      LEFT JOIN teams t ON u.team_id = t.id
      WHERE 1=1
    `;

    const params = [];
    let paramCount = 1;

    if (teamId) {
      query += ` AND u.team_id = $${paramCount}`;
      params.push(teamId);
      paramCount++;
    }

    if (role) {
      query += ` AND u.role = $${paramCount}`;
      params.push(role);
      paramCount++;
    }

    if (isActive !== undefined) {
      query += ` AND u.is_active = $${paramCount}`;
      params.push(isActive === 'true');
      paramCount++;
    }

    query += ` ORDER BY u.created_at DESC`;

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve users'
    });
  }
});

// Get single user
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    // Users can only view their own profile unless they're admin
    if (req.user.role !== 'admin' && req.user.userId !== id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const result = await pool.query(
      `SELECT 
        u.id,
        u.email,
        u.full_name,
        u.role,
        u.team_id,
        u.is_active,
        u.created_at,
        t.name as team_name
       FROM users u
       LEFT JOIN teams t ON u.team_id = t.id
       WHERE u.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve user'
    });
  }
});

// Update user (admin only)
router.patch('/:id', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;
    const { fullName, role, teamId, isActive } = req.body;

    const updates = [];
    const params = [id];
    let paramCount = 2;

    if (fullName !== undefined) {
      updates.push(`full_name = $${paramCount}`);
      params.push(fullName);
      paramCount++;
    }

    if (role !== undefined) {
      updates.push(`role = $${paramCount}`);
      params.push(role);
      paramCount++;
    }

    if (teamId !== undefined) {
      updates.push(`team_id = $${paramCount}`);
      params.push(teamId);
      paramCount++;
    }

    if (isActive !== undefined) {
      updates.push(`is_active = $${paramCount}`);
      params.push(isActive);
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No updates provided'
      });
    }

    const query = `
      UPDATE users 
      SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, email, full_name, role, team_id, is_active
    `;

    const result = await pool.query(query, params);

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
      [req.user.userId, 'UPDATE_USER', 'user', id, JSON.stringify(req.body)]
    );

    res.json({
      success: true,
      message: 'User updated successfully',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update user'
    });
  }
});

// Delete user (admin only)
router.delete('/:id', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    // Prevent deleting self
    if (id === req.user.userId) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete your own account'
      });
    }

    const result = await pool.query(
      'DELETE FROM users WHERE id = $1 RETURNING email',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Log audit trail
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id) 
       VALUES ($1, $2, $3, $4)`,
      [req.user.userId, 'DELETE_USER', 'user', id]
    );

    res.json({
      success: true,
      message: 'User deleted successfully'
    });

  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete user'
    });
  }
});

// Get user activity summary
router.get('/:id/activity', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;
    const { startDate, endDate } = req.query;

    // Users can only view their own activity unless they're admin
    if (req.user.role !== 'admin' && req.user.userId !== id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    let query = `
      SELECT 
        COUNT(DISTINCT s.id) as total_screenshots,
        COUNT(CASE WHEN s.is_flagged = true THEN 1 END) as flagged_screenshots,
        COUNT(DISTINCT ws.id) as total_sessions,
        COALESCE(SUM(ws.total_active_time), 0) as total_active_seconds,
        COALESCE(SUM(ws.total_idle_time), 0) as total_idle_seconds,
        MIN(s.captured_at) as first_activity,
        MAX(s.captured_at) as last_activity
      FROM users u
      LEFT JOIN screenshots s ON u.id = s.user_id
      LEFT JOIN work_sessions ws ON u.id = ws.user_id
      WHERE u.id = $1
    `;

    const params = [id];
    let paramCount = 2;

    if (startDate) {
      query += ` AND s.captured_at >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      query += ` AND s.captured_at <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Get user activity error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve user activity'
    });
  }
});

module.exports = router;
