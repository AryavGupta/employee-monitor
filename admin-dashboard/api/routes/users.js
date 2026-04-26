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

// Lightweight user list for dropdowns (no JOINs, minimal columns, cached response)
router.get('/list', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    let query = `SELECT id, full_name, email FROM users WHERE is_active = true`;
    const params = [];

    if (req.user.role === 'team_manager') {
      const managedTeamIds = await getManagedTeamIds(pool, req.user.userId);
      if (managedTeamIds.length > 0) {
        const placeholders = managedTeamIds.map((_, i) => `$${i + 1}`).join(', ');
        query += ` AND team_id IN (${placeholders})`;
        params.push(...managedTeamIds);
      } else {
        return res.json({ success: true, data: [] });
      }
    }

    query += ` ORDER BY full_name ASC`;
    const result = await pool.query(query, params);

    // Cache for 5 minutes - user list rarely changes
    res.set('Cache-Control', 'private, max-age=300');
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get users list error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve users list' });
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

// Delete user (admin only) — full cleanup: detach from team, remove all related
// rows, then delete the user. Transactional so a failure rolls back cleanly.
// We don't trust CASCADE alone because legacy/older deployments may have rows
// in tables that were created before the FK was added with ON DELETE CASCADE.
router.delete('/:id', authenticateToken, authorizeAdmin, async (req, res) => {
  const pool = req.app.locals.pool;
  const { id } = req.params;

  if (String(id) === String(req.user.userId)) {
    return res.status(400).json({ success: false, message: 'Cannot delete your own account' });
  }

  const userCheck = await pool.query('SELECT id, email, full_name, role, team_id FROM users WHERE id = $1', [id]);
  if (userCheck.rows.length === 0) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  const userToDelete = userCheck.rows[0];
  if (userToDelete.role === 'admin') {
    return res.status(403).json({ success: false, message: 'Cannot delete admin users. Demote them first.' });
  }

  const client = await pool.connect();

  // Run a query inside a SAVEPOINT so a 42P01 (missing table) or 42703
  // (missing column) doesn't poison the surrounding txn. Without this,
  // a single failure aborts the txn and every later query — including
  // COMMIT — silently rolls back. That's exactly how the previous
  // version returned `success: true` while the user row was never
  // deleted (audit_logs.details didn't exist in the live schema).
  const safe = async (label, sql, params) => {
    await client.query(`SAVEPOINT ${label}`);
    try {
      const r = await client.query(sql, params);
      await client.query(`RELEASE SAVEPOINT ${label}`);
      return r;
    } catch (err) {
      await client.query(`ROLLBACK TO SAVEPOINT ${label}`).catch(() => {});
      if (err.code === '42P01' || err.code === '42703') return null;
      throw err;
    }
  };

  try {
    await client.query('BEGIN');

    // Detach from team first (per requirement) and clear any team-manager pointer.
    if (userToDelete.team_id) {
      await client.query('UPDATE users SET team_id = NULL WHERE id = $1', [id]);
    }
    await client.query('UPDATE teams SET manager_id = NULL WHERE manager_id = $1', [id]);

    // Explicit cleanup of user-owned data. CASCADE handles most of these but
    // a duplicate `fk_user` (NO ACTION) FK on screenshots in the live DB
    // means we cannot rely on CASCADE alone — delete children first.
    const childTables = [
      'activity_logs',
      'screenshots',
      'screenshot_analyses',
      'sessions',
      'work_sessions',
      'user_presence',
      'productivity_metrics',
      'alerts',
    ];
    for (const t of childTables) {
      await safe(`del_${t}`, `DELETE FROM ${t} WHERE user_id = $1`, [id]);
    }

    // Detach SET NULL / NO ACTION references that point at this user.
    const nullableRefs = [
      { table: 'alerts',         column: 'resolved_by' },
      { table: 'app_categories', column: 'created_by' },
      { table: 'alert_rules',    column: 'created_by' },
      { table: 'site_rules',     column: 'created_by' },
      { table: 'audit_logs',     column: 'user_id' },
      { table: 'work_sessions',  column: 'approved_by' },
    ];
    for (const { table, column } of nullableRefs) {
      await safe(
        `nul_${table}_${column}`,
        `UPDATE ${table} SET ${column} = NULL WHERE ${column} = $1`,
        [id]
      );
    }

    const del = await client.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
    if (del.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Audit insert uses only columns guaranteed across deployments
    // (matches the inserts in auth.js — older live DBs have `changes` JSONB,
    // the schema-of-record has `details`; we use neither here). Wrapped in
    // a SAVEPOINT so any future column drift can't roll back the delete.
    await safe(
      'audit',
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id)
       VALUES ($1, $2, $3, $4)`,
      [req.user.userId, 'DELETE_USER', 'user', id]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'User deleted' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Delete user error:', error);
    if (error.code === '23503') {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete user: related records still reference this user'
      });
    }
    res.status(500).json({ success: false, message: 'Failed to delete user' });
  } finally {
    client.release();
  }
});

module.exports = router;
