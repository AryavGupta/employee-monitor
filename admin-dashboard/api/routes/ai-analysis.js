const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeAdminOrManager } = require('./auth');
const { analyzeScreenshots } = require('../services/geminiService');

// Trigger analysis for user + date
router.post('/analyze', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, date, forceRefresh } = req.body;

    if (!userId || !date) {
      return res.status(400).json({ success: false, message: 'userId and date required' });
    }

    // Check cache unless force refresh
    if (!forceRefresh) {
      const cached = await pool.query(
        `SELECT * FROM screenshot_analyses WHERE user_id = $1 AND analysis_date = $2 AND status = 'completed'`,
        [userId, date]
      );
      if (cached.rows.length > 0) {
        return res.json({ success: true, data: cached.rows[0], cached: true });
      }
    }

    // Get screenshots for that day
    const screenshots = await pool.query(
      `SELECT id, screenshot_url, captured_at FROM screenshots
       WHERE user_id = $1 AND DATE(captured_at) = $2 ORDER BY captured_at`,
      [userId, date]
    );

    if (screenshots.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No screenshots for this date' });
    }

    // Run AI analysis
    const analysis = await analyzeScreenshots(screenshots.rows);
    const screenshotIds = screenshots.rows.map(s => s.id);

    // Store result (upsert)
    const result = await pool.query(
      `INSERT INTO screenshot_analyses (user_id, analysis_date, screenshot_ids, ai_summary, applications_detected, activities_detected, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed')
       ON CONFLICT (user_id, analysis_date) DO UPDATE SET
         screenshot_ids = $3, ai_summary = $4, applications_detected = $5, activities_detected = $6,
         status = 'completed', error_message = NULL, created_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [userId, date, screenshotIds, analysis.summary, JSON.stringify(analysis.applications), JSON.stringify(analysis.activities)]
    );

    res.json({ success: true, data: result.rows[0], cached: false, screenshotsAnalyzed: screenshots.rows.length });
  } catch (error) {
    console.error('Analysis error:', error);

    // Store failed status if we have userId and date
    if (req.body.userId && req.body.date) {
      try {
        const pool = req.app.locals.pool;
        await pool.query(
          `INSERT INTO screenshot_analyses (user_id, analysis_date, screenshot_ids, ai_summary, status, error_message)
           VALUES ($1, $2, '{}', '', 'failed', $3)
           ON CONFLICT (user_id, analysis_date) DO UPDATE SET status = 'failed', error_message = $3`,
          [req.body.userId, req.body.date, error.message]
        );
      } catch (e) { /* ignore storage error */ }
    }

    res.status(500).json({ success: false, message: error.message });
  }
});

// Get employee summaries for a date
router.get('/employee-summary', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { date, role } = req.query;

    if (!date) {
      return res.status(400).json({ success: false, message: 'date query param required' });
    }

    let roleFilter = "u.role = 'employee'";
    if (role === 'admin') {
      roleFilter = "u.role = 'admin'";
    } else if (role === 'all') {
      roleFilter = "u.role IN ('employee', 'admin', 'team_manager')";
    } else if (role === 'team_manager') {
      roleFilter = "u.role = 'team_manager'";
    }

    const result = await pool.query(`
      SELECT
        u.id as user_id, u.full_name, u.email, u.role, t.name as team_name,
        COALESCE(SUM(CASE WHEN al.is_idle = false THEN al.duration_seconds ELSE 0 END), 0)::int as active_time,
        COALESCE(SUM(CASE WHEN al.is_idle = true THEN al.duration_seconds ELSE 0 END), 0)::int as idle_time,
        COALESCE(SUM(al.duration_seconds), 0)::int as total_uptime,
        (SELECT COUNT(*) FROM screenshots s WHERE s.user_id = u.id AND DATE(s.captured_at) = $1)::int as screenshot_count,
        sa.ai_summary, sa.applications_detected, sa.activities_detected,
        sa.status as analysis_status, sa.created_at as analyzed_at
      FROM users u
      LEFT JOIN teams t ON u.team_id = t.id
      LEFT JOIN activity_logs al ON u.id = al.user_id AND DATE(al.timestamp) = $1
      LEFT JOIN screenshot_analyses sa ON u.id = sa.user_id AND sa.analysis_date = $1
      WHERE u.is_active = true AND ${roleFilter}
      GROUP BY u.id, u.full_name, u.email, u.role, t.name, sa.ai_summary, sa.applications_detected, sa.activities_detected, sa.status, sa.created_at
      ORDER BY u.full_name
    `, [date]);

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Employee summary error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
