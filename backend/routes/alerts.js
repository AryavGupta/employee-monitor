const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeAdmin } = require('./auth');

// Create a new alert (system or admin)
router.post('/', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const { userId, alertType, severity, message, metadata } = req.body;
    const pool = req.app.locals.pool;

    if (!userId || !alertType || !severity || !message) {
      return res.status(400).json({
        success: false,
        message: 'userId, alertType, severity, and message are required'
      });
    }

    const validSeverities = ['low', 'medium', 'high', 'critical'];
    if (!validSeverities.includes(severity)) {
      return res.status(400).json({
        success: false,
        message: `Severity must be one of: ${validSeverities.join(', ')}`
      });
    }

    const result = await pool.query(
      `INSERT INTO alerts (user_id, alert_type, severity, message, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, alertType, severity, message, metadata ? JSON.stringify(metadata) : null]
    );

    // Log audit trail
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.userId, 'CREATE_ALERT', 'alert', result.rows[0].id, JSON.stringify({ alertType, severity })]
    );

    res.status(201).json({
      success: true,
      message: 'Alert created successfully',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Create alert error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create alert'
    });
  }
});

// Get all alerts with filtering
router.get('/', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const {
      userId,
      alertType,
      severity,
      isRead,
      resolved,
      startDate,
      endDate,
      limit = 50,
      offset = 0
    } = req.query;

    let query = `
      SELECT
        a.id,
        a.user_id,
        a.alert_type,
        a.severity,
        a.message,
        a.metadata,
        a.is_read,
        a.created_at,
        a.resolved_at,
        a.resolved_by,
        u.email,
        u.full_name,
        ru.full_name as resolved_by_name
      FROM alerts a
      JOIN users u ON a.user_id = u.id
      LEFT JOIN users ru ON a.resolved_by = ru.id
      WHERE 1=1
    `;

    const params = [];
    let paramCount = 1;

    // Non-admins can only see their own alerts
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

    if (resolved !== undefined) {
      if (resolved === 'true') {
        query += ` AND a.resolved_at IS NOT NULL`;
      } else {
        query += ` AND a.resolved_at IS NULL`;
      }
    }

    if (startDate) {
      query += ` AND a.created_at >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      query += ` AND a.created_at <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    query += ` ORDER BY a.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    // Get total count for pagination
    let countQuery = `SELECT COUNT(*) as total FROM alerts a WHERE 1=1`;
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

    if (alertType) {
      countQuery += ` AND a.alert_type = $${countParamIndex}`;
      countParams.push(alertType);
      countParamIndex++;
    }

    if (severity) {
      countQuery += ` AND a.severity = $${countParamIndex}`;
      countParams.push(severity);
      countParamIndex++;
    }

    if (isRead !== undefined) {
      countQuery += ` AND a.is_read = $${countParamIndex}`;
      countParams.push(isRead === 'true');
      countParamIndex++;
    }

    if (resolved !== undefined) {
      if (resolved === 'true') {
        countQuery += ` AND a.resolved_at IS NOT NULL`;
      } else {
        countQuery += ` AND a.resolved_at IS NULL`;
      }
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
    console.error('Get alerts error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve alerts'
    });
  }
});

// Get unread alerts count
router.get('/unread/count', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;

    let query = `SELECT COUNT(*) as count FROM alerts WHERE is_read = false`;
    const params = [];

    if (req.user.role !== 'admin') {
      query += ` AND user_id = $1`;
      params.push(req.user.userId);
    }

    const result = await pool.query(query, params);

    res.json({
      success: true,
      count: parseInt(result.rows[0].count)
    });

  } catch (error) {
    console.error('Get unread count error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve unread count'
    });
  }
});

// Get single alert
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    const result = await pool.query(
      `SELECT
        a.*,
        u.email,
        u.full_name,
        ru.full_name as resolved_by_name
       FROM alerts a
       JOIN users u ON a.user_id = u.id
       LEFT JOIN users ru ON a.resolved_by = ru.id
       WHERE a.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Alert not found'
      });
    }

    const alert = result.rows[0];

    // Check authorization
    if (req.user.role !== 'admin' && alert.user_id !== req.user.userId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    res.json({
      success: true,
      data: alert
    });

  } catch (error) {
    console.error('Get alert error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve alert'
    });
  }
});

// Mark alert as read
router.patch('/:id/read', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    // Check if alert exists and user has access
    const checkResult = await pool.query('SELECT user_id FROM alerts WHERE id = $1', [id]);

    if (checkResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Alert not found'
      });
    }

    if (req.user.role !== 'admin' && checkResult.rows[0].user_id !== req.user.userId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const result = await pool.query(
      `UPDATE alerts SET is_read = true WHERE id = $1 RETURNING *`,
      [id]
    );

    res.json({
      success: true,
      message: 'Alert marked as read',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Mark alert read error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update alert'
    });
  }
});

// Mark all alerts as read
router.patch('/read/all', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;

    let query = `UPDATE alerts SET is_read = true WHERE is_read = false`;
    const params = [];

    if (req.user.role !== 'admin') {
      query += ` AND user_id = $1`;
      params.push(req.user.userId);
    }

    query += ` RETURNING id`;

    const result = await pool.query(query, params);

    res.json({
      success: true,
      message: `${result.rows.length} alerts marked as read`
    });

  } catch (error) {
    console.error('Mark all read error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update alerts'
    });
  }
});

// Resolve alert (admin only)
router.patch('/:id/resolve', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE alerts
       SET resolved_at = CURRENT_TIMESTAMP, resolved_by = $1, is_read = true
       WHERE id = $2
       RETURNING *`,
      [req.user.userId, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Alert not found'
      });
    }

    // Log audit trail
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id)
       VALUES ($1, $2, $3, $4)`,
      [req.user.userId, 'RESOLVE_ALERT', 'alert', id]
    );

    res.json({
      success: true,
      message: 'Alert resolved',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Resolve alert error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to resolve alert'
    });
  }
});

// Delete alert (admin only)
router.delete('/:id', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    const result = await pool.query(
      `DELETE FROM alerts WHERE id = $1 RETURNING id`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Alert not found'
      });
    }

    // Log audit trail
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id)
       VALUES ($1, $2, $3, $4)`,
      [req.user.userId, 'DELETE_ALERT', 'alert', id]
    );

    res.json({
      success: true,
      message: 'Alert deleted'
    });

  } catch (error) {
    console.error('Delete alert error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete alert'
    });
  }
});

// Get alert statistics (admin only)
router.get('/stats/summary', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { startDate, endDate } = req.query;

    let query = `
      SELECT
        COUNT(*) as total_alerts,
        COUNT(CASE WHEN is_read = false THEN 1 END) as unread_alerts,
        COUNT(CASE WHEN resolved_at IS NOT NULL THEN 1 END) as resolved_alerts,
        COUNT(CASE WHEN severity = 'critical' THEN 1 END) as critical_alerts,
        COUNT(CASE WHEN severity = 'high' THEN 1 END) as high_alerts,
        COUNT(CASE WHEN severity = 'medium' THEN 1 END) as medium_alerts,
        COUNT(CASE WHEN severity = 'low' THEN 1 END) as low_alerts
      FROM alerts
      WHERE 1=1
    `;

    const params = [];
    let paramCount = 1;

    if (startDate) {
      query += ` AND created_at >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      query += ` AND created_at <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Get alert stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve alert statistics'
    });
  }
});

module.exports = router;
