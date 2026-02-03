const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeAdmin, authorizeAdminOrManager, getManagedTeamIds, canAccessUserData } = require('./auth');

// Get current user profile (for desktop app)
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const userId = req.user.userId;

    const result = await pool.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.team_id, u.is_active, u.created_at, t.name as team_name
       FROM users u
       LEFT JOIN teams t ON u.team_id = t.id
       WHERE u.id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve user profile' });
  }
});

// Get all users (admin sees all, team manager sees their team members)
router.get('/', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { teamId, role, isActive } = req.query;

    let query = `SELECT u.id, u.email, u.full_name, u.role, u.team_id, u.is_active, u.created_at, t.name as team_name FROM users u LEFT JOIN teams t ON u.team_id = t.id WHERE 1=1`;
    const params = [];
    let paramCount = 1;

    // Team managers only see their team members
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
    }

    query += ` ORDER BY u.created_at DESC`;
    const result = await pool.query(query, params);

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve users' });
  }
});

// Get single user (admin, team manager for their team, or self)
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    // Check access permissions
    const canAccess = await canAccessUserData(pool, req.user, id);
    if (!canAccess) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const result = await pool.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.team_id, u.is_active, u.created_at, t.name as team_name FROM users u LEFT JOIN teams t ON u.team_id = t.id WHERE u.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve user' });
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
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'No updates provided' });
    }

    const query = `UPDATE users SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id, email, full_name, role, team_id, is_active`;
    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({ success: true, message: 'User updated successfully', data: result.rows[0] });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ success: false, message: 'Failed to update user' });
  }
});

// Delete user (admin only)
router.delete('/:id', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    // Compare as strings to handle UUID comparison
    if (String(id) === String(req.user.userId)) {
      return res.status(400).json({ success: false, message: 'Cannot delete your own account' });
    }

    // Check if user exists and get their role
    const userCheck = await pool.query('SELECT id, email, role FROM users WHERE id = $1', [id]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const userToDelete = userCheck.rows[0];

    // Prevent deleting other admins (optional safety measure)
    if (userToDelete.role === 'admin') {
      return res.status(403).json({ success: false, message: 'Cannot delete admin users. Demote them first.' });
    }

    // Delete the user (CASCADE will handle related records)
    await pool.query('DELETE FROM users WHERE id = $1', [id]);

    // Log the deletion (non-blocking - don't fail delete if audit fails)
    try {
      await pool.query(
        `INSERT INTO audit_logs (user_id, action, entity_type, entity_id) VALUES ($1, $2, $3, $4)`,
        [req.user.userId, 'DELETE_USER', 'user', id]
      );
    } catch (auditErr) {
      console.error('Audit log failed:', auditErr.message);
    }

    res.json({ success: true, message: `User ${userToDelete.email} deleted successfully` });
  } catch (error) {
    console.error('Delete user error:', error);
    // Handle foreign key constraint errors
    if (error.code === '23503') {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete user: they have related records that must be deleted first'
      });
    }
    res.status(500).json({ success: false, message: 'Failed to delete user' });
  }
});

module.exports = router;
