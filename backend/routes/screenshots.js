const express = require('express');
const router = express.Router();
const { authenticateToken } = require('./auth');
const fs = require('fs').promises;
const path = require('path');

// Ensure upload directory exists
const UPLOAD_DIR = path.join(__dirname, '../uploads/screenshots');
fs.mkdir(UPLOAD_DIR, { recursive: true }).catch(console.error);

// Upload screenshot endpoint
router.post('/upload', authenticateToken, async (req, res) => {
  try {
    const { screenshot, timestamp, systemInfo } = req.body;
    const userId = req.user.userId;
    const pool = req.app.locals.pool;

    if (!screenshot || !timestamp) {
      return res.status(400).json({
        success: false,
        message: 'Screenshot data and timestamp are required'
      });
    }

    // Decode base64 screenshot
    const buffer = Buffer.from(screenshot, 'base64');
    const fileSize = buffer.length;

    // Generate filename
    const filename = `${userId}_${Date.now()}.png`;
    const filepath = path.join(UPLOAD_DIR, filename);

    // Save file to disk
    await fs.writeFile(filepath, buffer);

    // Store screenshot metadata in database
    const result = await pool.query(
      `INSERT INTO screenshots 
       (user_id, screenshot_url, captured_at, file_size, system_info) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id, captured_at`,
      [
        userId,
        `/uploads/screenshots/${filename}`,
        timestamp,
        fileSize,
        systemInfo ? JSON.stringify(systemInfo) : null
      ]
    );

    // Update work session screenshot count
    await pool.query(
      `UPDATE work_sessions 
       SET screenshot_count = screenshot_count + 1 
       WHERE user_id = $1 
       AND session_start <= $2 
       AND (session_end IS NULL OR session_end >= $2)`,
      [userId, timestamp]
    );

    res.json({
      success: true,
      message: 'Screenshot uploaded successfully',
      screenshotId: result.rows[0].id,
      timestamp: result.rows[0].captured_at
    });

  } catch (error) {
    console.error('Screenshot upload error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload screenshot'
    });
  }
});

// Get screenshots with filtering
router.get('/', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { 
      userId, 
      startDate, 
      endDate, 
      limit = 50, 
      offset = 0,
      flagged 
    } = req.query;

    // Build query based on filters
    let query = `
      SELECT 
        s.id,
        s.user_id,
        s.screenshot_url,
        s.captured_at,
        s.file_size,
        s.is_flagged,
        s.flag_reason,
        u.email,
        u.full_name,
        t.name as team_name
      FROM screenshots s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN teams t ON u.team_id = t.id
      WHERE 1=1
    `;
    
    const params = [];
    let paramCount = 1;

    // Only admins can see all screenshots
    if (req.user.role !== 'admin') {
      query += ` AND s.user_id = $${paramCount}`;
      params.push(req.user.userId);
      paramCount++;
    } else if (userId) {
      query += ` AND s.user_id = $${paramCount}`;
      params.push(userId);
      paramCount++;
    }

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

    if (flagged !== undefined) {
      query += ` AND s.is_flagged = $${paramCount}`;
      params.push(flagged === 'true');
      paramCount++;
    }

    query += ` ORDER BY s.captured_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = `
      SELECT COUNT(*) as total
      FROM screenshots s
      JOIN users u ON s.user_id = u.id
      WHERE 1=1
    `;
    
    const countParams = [];
    let countParamIndex = 1;

    if (req.user.role !== 'admin') {
      countQuery += ` AND s.user_id = $${countParamIndex}`;
      countParams.push(req.user.userId);
      countParamIndex++;
    } else if (userId) {
      countQuery += ` AND s.user_id = $${countParamIndex}`;
      countParams.push(userId);
      countParamIndex++;
    }

    if (startDate) {
      countQuery += ` AND s.captured_at >= $${countParamIndex}`;
      countParams.push(startDate);
      countParamIndex++;
    }

    if (endDate) {
      countQuery += ` AND s.captured_at <= $${countParamIndex}`;
      countParams.push(endDate);
      countParamIndex++;
    }

    if (flagged !== undefined) {
      countQuery += ` AND s.is_flagged = $${countParamIndex}`;
      countParams.push(flagged === 'true');
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
    console.error('Get screenshots error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve screenshots'
    });
  }
});

// Get single screenshot
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;

    const result = await pool.query(
      `SELECT 
        s.*,
        u.email,
        u.full_name,
        t.name as team_name
       FROM screenshots s
       JOIN users u ON s.user_id = u.id
       LEFT JOIN teams t ON u.team_id = t.id
       WHERE s.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Screenshot not found'
      });
    }

    const screenshot = result.rows[0];

    // Check authorization
    if (req.user.role !== 'admin' && screenshot.user_id !== req.user.userId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    res.json({
      success: true,
      data: screenshot
    });

  } catch (error) {
    console.error('Get screenshot error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve screenshot'
    });
  }
});

// Flag screenshot (admin only)
router.patch('/:id/flag', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { id } = req.params;
    const { isFlagged, reason } = req.body;

    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Admin access required'
      });
    }

    const result = await pool.query(
      `UPDATE screenshots 
       SET is_flagged = $1, flag_reason = $2 
       WHERE id = $3 
       RETURNING *`,
      [isFlagged, reason || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Screenshot not found'
      });
    }

    // Log audit trail
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes) 
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.userId,
        'FLAG_SCREENSHOT',
        'screenshot',
        id,
        JSON.stringify({ is_flagged: isFlagged, reason })
      ]
    );

    res.json({
      success: true,
      message: 'Screenshot updated successfully',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Flag screenshot error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update screenshot'
    });
  }
});

// Get screenshot statistics
router.get('/stats/summary', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, startDate, endDate } = req.query;

    let query = `
      SELECT 
        COUNT(*) as total_screenshots,
        COUNT(CASE WHEN is_flagged = true THEN 1 END) as flagged_screenshots,
        COUNT(DISTINCT user_id) as active_users,
        MIN(captured_at) as first_screenshot,
        MAX(captured_at) as last_screenshot
      FROM screenshots
      WHERE 1=1
    `;

    const params = [];
    let paramCount = 1;

    if (req.user.role !== 'admin') {
      query += ` AND user_id = $${paramCount}`;
      params.push(req.user.userId);
      paramCount++;
    } else if (userId) {
      query += ` AND user_id = $${paramCount}`;
      params.push(userId);
      paramCount++;
    }

    if (startDate) {
      query += ` AND captured_at >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      query += ` AND captured_at <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve statistics'
    });
  }
});

module.exports = router;
