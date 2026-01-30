const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeAdmin } = require('./auth');

// Get alerts
router.get('/', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, alertType, severity, isRead, isResolved, limit = 50, offset = 0 } = req.query;

    let query = `
      SELECT a.*, u.email, u.full_name
      FROM alerts a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE 1=1
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

    if (alertType) {
      query += ` AND a.alert_type = $${paramCount}`;
      params.push(alertType);
      paramCount++;
    }

    if (severity) {
      query += ` AND a.severity = $${paramCount}`;
      params.push(severity);
      paramCount++;
    }

    if (isRead !== undefined) {
      query += ` AND a.is_read = $${paramCount}`;
      params.push(isRead === 'true');
      paramCount++;
    }

    if (isResolved !== undefined) {
      query += ` AND a.is_resolved = $${paramCount}`;
      params.push(isResolved === 'true');
      paramCount++;
    }

    query += ` ORDER BY a.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get alerts error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve alerts' });
  }
});

// Create alert (admin only)
router.post('/', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, alertType, severity, title, message, metadata } = req.body;

    if (!alertType || !title) {
      return res.status(400).json({ success: false, message: 'Alert type and title are required' });
    }

    const result = await pool.query(
      `INSERT INTO alerts (user_id, alert_type, severity, title, message, metadata)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [userId || null, alertType, severity || 'low', title, message || null, metadata ? JSON.stringify(metadata) : null]
    );

    res.status(201).json({ success: true, message: 'Alert created', data: result.rows[0] });
  } catch (error) {
    console.error('Create alert error:', error);
    res.status(500).json({ success: false, message: 'Failed to create alert' });
  }
});

// Mark alert as read
// SECURITY: Users can only mark their own alerts as read, admins can mark any
router.patch('/:id/read', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    // First check if alert exists and verify ownership
    const alertCheck = await pool.query('SELECT user_id FROM alerts WHERE id = $1', [id]);
    if (alertCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Alert not found' });
    }

    // Authorization: admins can mark any alert, users only their own
    const alertUserId = alertCheck.rows[0].user_id;
    if (req.user.role !== 'admin' && alertUserId !== req.user.userId) {
      return res.status(403).json({ success: false, message: 'Access denied to this alert' });
    }

    const result = await pool.query(
      'UPDATE alerts SET is_read = true WHERE id = $1 RETURNING *',
      [id]
    );

    res.json({ success: true, message: 'Alert marked as read', data: result.rows[0] });
  } catch (error) {
    console.error('Mark alert read error:', error);
    res.status(500).json({ success: false, message: 'Failed to update alert' });
  }
});

// Resolve alert (admin only)
router.patch('/:id/resolve', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE alerts SET is_resolved = true, resolved_by = $1, resolved_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING *`,
      [req.user.userId, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Alert not found' });
    }

    res.json({ success: true, message: 'Alert resolved', data: result.rows[0] });
  } catch (error) {
    console.error('Resolve alert error:', error);
    res.status(500).json({ success: false, message: 'Failed to resolve alert' });
  }
});

// Get unread alert count
router.get('/unread-count', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;

    let query = 'SELECT COUNT(*) as count FROM alerts WHERE is_read = false';
    const params = [];

    if (req.user.role !== 'admin') {
      query += ' AND user_id = $1';
      params.push(req.user.userId);
    }

    const result = await pool.query(query, params);
    res.json({ success: true, count: parseInt(result.rows[0].count) });
  } catch (error) {
    console.error('Get unread count error:', error);
    res.status(500).json({ success: false, message: 'Failed to get unread count' });
  }
});

module.exports = router;
