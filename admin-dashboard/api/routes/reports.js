const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeAdmin } = require('./auth');

// Get productivity metrics with date range and grouping
router.get('/productivity', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, teamId, startDate, endDate, groupBy = 'day', isOvertime } = req.query;

    // Build the base query for productivity data
    // Use shift_date for grouping (handles night shifts crossing midnight)
    // Falls back to DATE(timestamp) for old records without shift_date
    let query = `
      SELECT
        u.id as user_id,
        u.full_name,
        u.email,
        t.name as team_name,
        COALESCE(a.shift_date, DATE(a.timestamp)) as date,
        COUNT(*) as total_activities,
        COUNT(CASE WHEN a.is_idle = false THEN 1 END) as active_count,
        COUNT(CASE WHEN a.is_idle = true THEN 1 END) as idle_count,
        COALESCE(SUM(CASE WHEN a.is_idle = false THEN a.duration_seconds ELSE 0 END), 0) as active_seconds,
        COALESCE(SUM(CASE WHEN a.is_idle = true THEN a.duration_seconds ELSE 0 END), 0) as idle_seconds,
        COALESCE(SUM(a.keyboard_events), 0) as keyboard_events,
        COALESCE(SUM(a.mouse_events), 0) as mouse_events,
        COALESCE(SUM(CASE WHEN a.is_overtime = true AND a.is_idle = false THEN a.duration_seconds ELSE 0 END), 0) as overtime_active_seconds,
        COALESCE(SUM(CASE WHEN a.is_overtime = true AND a.is_idle = true THEN a.duration_seconds ELSE 0 END), 0) as overtime_idle_seconds
      FROM activity_logs a
      JOIN users u ON a.user_id = u.id
      LEFT JOIN teams t ON u.team_id = t.id
      WHERE 1=1
    `;

    const params = [];
    let paramCount = 1;

    // Non-admin users can only see their own data
    if (req.user.role !== 'admin') {
      query += ` AND a.user_id = $${paramCount}`;
      params.push(req.user.userId);
      paramCount++;
    } else if (userId) {
      query += ` AND a.user_id = $${paramCount}`;
      params.push(userId);
      paramCount++;
    }

    if (teamId) {
      query += ` AND u.team_id = $${paramCount}`;
      params.push(teamId);
      paramCount++;
    }

    if (startDate) {
      query += ` AND a.timestamp >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      query += ` AND a.timestamp <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    if (isOvertime !== undefined) {
      query += ` AND a.is_overtime = $${paramCount}`;
      params.push(isOvertime === 'true');
      paramCount++;
    }

    // Group by date (shift_date) and user
    query += ` GROUP BY u.id, u.full_name, u.email, t.name, COALESCE(a.shift_date, DATE(a.timestamp)) ORDER BY date DESC, u.full_name`;

    const result = await pool.query(query, params);

    // Calculate productivity score for each row
    const data = result.rows.map(row => {
      const totalTime = parseInt(row.active_seconds) + parseInt(row.idle_seconds);
      const productivityScore = totalTime > 0
        ? Math.round((parseInt(row.active_seconds) / totalTime) * 100)
        : 0;

      return {
        ...row,
        productivity_score: productivityScore,
        total_time_seconds: totalTime
      };
    });

    res.json({ success: true, data });
  } catch (error) {
    console.error('Get productivity error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve productivity data' });
  }
});

// Get hourly breakdown for a specific date
router.get('/productivity/hourly', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, date, timezone } = req.query;

    if (!date) {
      return res.status(400).json({ success: false, message: 'Date is required' });
    }

    let targetUserId = req.user.role === 'admin' && userId ? userId : req.user.userId;

    // Use client timezone for hour extraction so graph matches user's local time
    // Falls back to UTC if no timezone provided
    const tz = timezone || 'UTC';

    const query = `
      SELECT
        EXTRACT(HOUR FROM timestamp AT TIME ZONE $3) as hour,
        COUNT(*) as activity_count,
        COUNT(CASE WHEN is_idle = false THEN 1 END) as active_count,
        COUNT(CASE WHEN is_idle = true THEN 1 END) as idle_count,
        COALESCE(SUM(CASE WHEN is_idle = false THEN duration_seconds ELSE 0 END), 0) as active_seconds,
        COALESCE(SUM(keyboard_events), 0) as keyboard_events,
        COALESCE(SUM(mouse_events), 0) as mouse_events,
        COUNT(DISTINCT application_name) as unique_apps
      FROM activity_logs
      WHERE user_id = $1 AND DATE(timestamp AT TIME ZONE $3) = $2
      GROUP BY EXTRACT(HOUR FROM timestamp AT TIME ZONE $3)
      ORDER BY hour
    `;

    const result = await pool.query(query, [targetUserId, date, tz]);

    // Fill in missing hours with zeros
    const hourlyData = Array.from({ length: 24 }, (_, i) => {
      const existing = result.rows.find(r => parseInt(r.hour) === i);
      return existing || {
        hour: i,
        activity_count: 0,
        active_count: 0,
        idle_count: 0,
        active_seconds: 0,
        keyboard_events: 0,
        mouse_events: 0,
        unique_apps: 0
      };
    });

    res.json({ success: true, data: hourlyData });
  } catch (error) {
    console.error('Get hourly breakdown error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve hourly data' });
  }
});

// Get team comparison data
router.get('/productivity/comparison', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { startDate, endDate, compareBy = 'user' } = req.query;

    let query;
    const params = [];
    let paramCount = 1;

    if (compareBy === 'team') {
      query = `
        SELECT
          t.id as team_id,
          t.name as team_name,
          COUNT(DISTINCT u.id) as member_count,
          COUNT(a.id) as total_activities,
          COALESCE(SUM(CASE WHEN a.is_idle = false THEN a.duration_seconds ELSE 0 END), 0) as active_seconds,
          COALESCE(SUM(CASE WHEN a.is_idle = true THEN a.duration_seconds ELSE 0 END), 0) as idle_seconds,
          COALESCE(SUM(a.keyboard_events), 0) as keyboard_events,
          COALESCE(SUM(a.mouse_events), 0) as mouse_events
        FROM teams t
        LEFT JOIN users u ON u.team_id = t.id AND u.is_active = true
        LEFT JOIN activity_logs a ON a.user_id = u.id
      `;

      if (startDate) {
        query += ` AND a.timestamp >= $${paramCount}`;
        params.push(startDate);
        paramCount++;
      }

      if (endDate) {
        query += ` AND a.timestamp <= $${paramCount}`;
        params.push(endDate);
        paramCount++;
      }

      query += ` GROUP BY t.id, t.name ORDER BY active_seconds DESC`;
    } else {
      // Compare by user
      query = `
        SELECT
          u.id as user_id,
          u.full_name,
          u.email,
          t.name as team_name,
          COUNT(a.id) as total_activities,
          COALESCE(SUM(CASE WHEN a.is_idle = false THEN a.duration_seconds ELSE 0 END), 0) as active_seconds,
          COALESCE(SUM(CASE WHEN a.is_idle = true THEN a.duration_seconds ELSE 0 END), 0) as idle_seconds,
          COALESCE(SUM(a.keyboard_events), 0) as keyboard_events,
          COALESCE(SUM(a.mouse_events), 0) as mouse_events,
          COUNT(DISTINCT DATE(a.timestamp)) as days_active
        FROM users u
        LEFT JOIN teams t ON u.team_id = t.id
        LEFT JOIN activity_logs a ON a.user_id = u.id
        WHERE u.is_active = true
      `;

      if (startDate) {
        query += ` AND a.timestamp >= $${paramCount}`;
        params.push(startDate);
        paramCount++;
      }

      if (endDate) {
        query += ` AND a.timestamp <= $${paramCount}`;
        params.push(endDate);
        paramCount++;
      }

      query += ` GROUP BY u.id, u.full_name, u.email, t.name ORDER BY active_seconds DESC`;
    }

    const result = await pool.query(query, params);

    // Calculate productivity score
    const data = result.rows.map(row => {
      const totalTime = parseInt(row.active_seconds) + parseInt(row.idle_seconds);
      return {
        ...row,
        productivity_score: totalTime > 0
          ? Math.round((parseInt(row.active_seconds) / totalTime) * 100)
          : 0,
        total_time_seconds: totalTime
      };
    });

    res.json({ success: true, data });
  } catch (error) {
    console.error('Get comparison error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve comparison data' });
  }
});

// Get top applications with categorization
router.get('/applications', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, teamId, startDate, endDate, limit = 20 } = req.query;

    let query = `
      SELECT
        a.application_name,
        COUNT(*) as usage_count,
        COALESCE(SUM(a.duration_seconds), 0) as total_seconds,
        COALESCE(c.category, 'neutral') as category,
        c.name as category_name
      FROM activity_logs a
      LEFT JOIN app_categories c ON LOWER(a.application_name) ~ LOWER(c.pattern)
      JOIN users u ON a.user_id = u.id
      WHERE a.application_name IS NOT NULL AND a.application_name != ''
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

    if (teamId) {
      query += ` AND u.team_id = $${paramCount}`;
      params.push(teamId);
      paramCount++;
    }

    if (startDate) {
      query += ` AND a.timestamp >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      query += ` AND a.timestamp <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    query += ` GROUP BY a.application_name, c.category, c.name
               ORDER BY total_seconds DESC
               LIMIT $${paramCount}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);

    // Calculate totals by category
    const categoryTotals = {
      productive: { count: 0, seconds: 0 },
      unproductive: { count: 0, seconds: 0 },
      neutral: { count: 0, seconds: 0 }
    };

    result.rows.forEach(row => {
      const cat = row.category || 'neutral';
      categoryTotals[cat].count += parseInt(row.usage_count);
      categoryTotals[cat].seconds += parseInt(row.total_seconds);
    });

    res.json({
      success: true,
      data: result.rows,
      summary: categoryTotals
    });
  } catch (error) {
    console.error('Get applications error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve applications data' });
  }
});

// Get URL/website analytics
router.get('/websites', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, teamId, startDate, endDate, limit = 20 } = req.query;

    let query = `
      SELECT
        a.domain,
        COUNT(*) as visit_count,
        COALESCE(SUM(a.duration_seconds), 0) as total_seconds,
        COUNT(CASE WHEN a.is_blocked_attempt = true THEN 1 END) as blocked_attempts,
        sr.rule_type,
        sr.category
      FROM activity_logs a
      LEFT JOIN site_rules sr ON a.domain = sr.domain
      JOIN users u ON a.user_id = u.id
      WHERE a.domain IS NOT NULL AND a.domain != ''
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

    if (teamId) {
      query += ` AND u.team_id = $${paramCount}`;
      params.push(teamId);
      paramCount++;
    }

    if (startDate) {
      query += ` AND a.timestamp >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      query += ` AND a.timestamp <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    query += ` GROUP BY a.domain, sr.rule_type, sr.category
               ORDER BY total_seconds DESC
               LIMIT $${paramCount}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get websites error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve website data' });
  }
});

// Get dashboard summary stats (optimized - single combined query)
router.get('/dashboard-summary', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { startDate, endDate, userId, teamId } = req.query;

    const today = new Date().toISOString().split('T')[0];
    const start = startDate || today;
    const end = endDate || today + 'T23:59:59';

    // Combined query for better performance
    const combinedQuery = `
      WITH activity_stats AS (
        SELECT
          COUNT(DISTINCT a.user_id) as active_users,
          COUNT(a.id) as total_activities,
          COALESCE(SUM(CASE WHEN a.is_idle = false THEN a.duration_seconds ELSE 0 END), 0) as total_active_seconds,
          COALESCE(SUM(CASE WHEN a.is_idle = true THEN a.duration_seconds ELSE 0 END), 0) as total_idle_seconds,
          COALESCE(SUM(a.keyboard_events), 0) as total_keyboard_events,
          COALESCE(SUM(a.mouse_events), 0) as total_mouse_events
        FROM activity_logs a
        ${userId ? 'WHERE a.user_id = $3' : ''}
        ${!userId ? 'WHERE' : 'AND'} a.timestamp >= $1 AND a.timestamp <= $2
      ),
      screenshot_stats AS (
        SELECT
          COUNT(*) as total_screenshots,
          COUNT(CASE WHEN is_flagged = true THEN 1 END) as flagged_screenshots
        FROM screenshots
        WHERE captured_at >= $1 AND captured_at <= $2
        ${userId ? 'AND user_id = $3' : ''}
      ),
      alert_stats AS (
        SELECT
          COUNT(*) as total_alerts,
          COUNT(CASE WHEN is_read = false THEN 1 END) as unread_alerts
        FROM alerts
        WHERE created_at >= $1 AND created_at <= $2
        ${userId ? 'AND user_id = $3' : ''}
      )
      SELECT
        a.*, s.total_screenshots, s.flagged_screenshots, al.total_alerts, al.unread_alerts
      FROM activity_stats a, screenshot_stats s, alert_stats al
    `;

    const params = userId ? [start, end, userId] : [start, end];
    const result = await pool.query(combinedQuery, params);

    const stats = result.rows[0];
    const totalActiveSeconds = parseInt(stats.total_active_seconds) || 0;
    const totalIdleSeconds = parseInt(stats.total_idle_seconds) || 0;
    const totalTime = totalActiveSeconds + totalIdleSeconds;
    const productivityScore = totalTime > 0
      ? Math.round((totalActiveSeconds / totalTime) * 100)
      : 0;

    // Set cache headers for 30 seconds
    res.set('Cache-Control', 'private, max-age=30');

    res.json({
      success: true,
      data: {
        active_users: parseInt(stats.active_users) || 0,
        total_activities: parseInt(stats.total_activities) || 0,
        active_time_hours: Math.round(totalActiveSeconds / 3600 * 10) / 10,
        idle_time_hours: Math.round(totalIdleSeconds / 3600 * 10) / 10,
        productivity_score: productivityScore,
        keyboard_events: parseInt(stats.total_keyboard_events) || 0,
        mouse_events: parseInt(stats.total_mouse_events) || 0,
        screenshots: {
          total: parseInt(stats.total_screenshots) || 0,
          flagged: parseInt(stats.flagged_screenshots) || 0
        },
        alerts: {
          total: parseInt(stats.total_alerts) || 0,
          unread: parseInt(stats.unread_alerts) || 0
        }
      }
    });
  } catch (error) {
    console.error('Get dashboard summary error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve dashboard summary' });
  }
});

// Get shift-based attendance for a single user on a specific shift date
router.get('/shift-attendance', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, shiftDate, timezone } = req.query;

    if (!shiftDate) {
      return res.status(400).json({ success: false, message: 'shiftDate is required' });
    }

    const targetUserId = req.user.role === 'admin' && userId ? userId : req.user.userId;
    const tz = timezone || 'UTC';

    // 1. Get user's team working hours
    const teamResult = await pool.query(
      `SELECT tms.working_hours_start, tms.working_hours_end
       FROM users u
       LEFT JOIN team_monitoring_settings tms ON tms.team_id = u.team_id
       WHERE u.id = $1`,
      [targetUserId]
    );

    const teamSettings = teamResult.rows[0] || {};
    const whStart = teamSettings.working_hours_start; // e.g. '22:30:00'
    const whEnd = teamSettings.working_hours_end;     // e.g. '07:30:00'

    // 2. Compute shift time window in user's timezone, then convert to UTC
    let shiftStartLocal, shiftEndLocal, isNightShift = false, shiftLabel = 'Full Day';

    if (whStart && whEnd) {
      // Parse HH:MM or HH:MM:SS
      const startParts = whStart.split(':').map(Number);
      const endParts = whEnd.split(':').map(Number);
      const startMinutes = startParts[0] * 60 + startParts[1];
      const endMinutes = endParts[0] * 60 + endParts[1];

      isNightShift = startMinutes > endMinutes;

      // Shift start: shiftDate + working_hours_start in user's timezone
      shiftStartLocal = `${shiftDate}T${whStart.substring(0, 5)}:00`;
      if (isNightShift) {
        // Night shift: ends next day
        const nextDay = new Date(new Date(shiftDate).getTime() + 86400000).toISOString().split('T')[0];
        shiftEndLocal = `${nextDay}T${whEnd.substring(0, 5)}:00`;
        shiftLabel = 'Night Shift';
      } else {
        shiftEndLocal = `${shiftDate}T${whEnd.substring(0, 5)}:00`;
        shiftLabel = 'Day Shift';
      }
    } else {
      // No working hours — full calendar day
      shiftStartLocal = `${shiftDate}T00:00:00`;
      const nextDay = new Date(new Date(shiftDate).getTime() + 86400000).toISOString().split('T')[0];
      shiftEndLocal = `${nextDay}T00:00:00`;
    }

    // Convert local shift boundaries to UTC using PostgreSQL AT TIME ZONE
    const boundsResult = await pool.query(
      `SELECT
        ($1::timestamp AT TIME ZONE $3) AT TIME ZONE 'UTC' as shift_start_utc,
        ($2::timestamp AT TIME ZONE $3) AT TIME ZONE 'UTC' as shift_end_utc`,
      [shiftStartLocal, shiftEndLocal, tz]
    );
    const { shift_start_utc, shift_end_utc } = boundsResult.rows[0];

    // 3. Auto-close stale sessions for this user before querying
    try {
      await pool.query(
        `UPDATE sessions SET is_active = false,
         end_time = COALESCE(
           GREATEST(
             (SELECT last_heartbeat FROM user_presence WHERE user_id = sessions.user_id),
             (SELECT MAX(timestamp) FROM activity_logs WHERE user_id = sessions.user_id AND timestamp >= sessions.start_time),
             (SELECT MAX(captured_at) FROM screenshots WHERE user_id = sessions.user_id AND captured_at >= sessions.start_time)
           ),
           (SELECT last_heartbeat FROM user_presence WHERE user_id = sessions.user_id),
           CURRENT_TIMESTAMP
         ),
         duration_seconds = EXTRACT(EPOCH FROM (
           COALESCE(
             GREATEST(
               (SELECT last_heartbeat FROM user_presence WHERE user_id = sessions.user_id),
               (SELECT MAX(timestamp) FROM activity_logs WHERE user_id = sessions.user_id AND timestamp >= sessions.start_time),
               (SELECT MAX(captured_at) FROM screenshots WHERE user_id = sessions.user_id AND captured_at >= sessions.start_time)
             ),
             (SELECT last_heartbeat FROM user_presence WHERE user_id = sessions.user_id),
             CURRENT_TIMESTAMP
           ) - sessions.start_time
         ))
         WHERE user_id = $1 AND is_active = true
           AND NOT EXISTS (
             SELECT 1 FROM user_presence WHERE user_id = $1 AND last_heartbeat > NOW() - INTERVAL '5 minutes'
           )`,
        [targetUserId]
      );
    } catch (cleanupErr) {
      console.error('Stale session cleanup error:', cleanupErr.message);
    }

    // Query sessions within shift window
    const sessionsResult = await pool.query(
      `SELECT s.id, s.start_time, s.end_time, s.is_active,
              s.duration_seconds, s.active_seconds, s.idle_seconds,
              p.last_heartbeat, p.status as presence_status, p.idle_seconds as presence_idle_seconds,
              CASE
                WHEN s.end_time IS NOT NULL THEN 'logged_out'
                WHEN s.is_active = true AND p.last_heartbeat > NOW() - INTERVAL '90 seconds' AND p.status = 'idle' THEN 'idle'
                WHEN s.is_active = true AND p.last_heartbeat > NOW() - INTERVAL '90 seconds' THEN 'active'
                WHEN s.is_active = true THEN 'disconnected'
                ELSE 'logged_out'
              END as effective_status
       FROM sessions s
       LEFT JOIN user_presence p ON s.user_id = p.user_id
       WHERE s.user_id = $1 AND s.start_time >= $2 AND s.start_time < $3
       ORDER BY s.start_time ASC`,
      [targetUserId, shift_start_utc, shift_end_utc]
    );

    // 4. Query activity summary for this shift_date
    const activityResult = await pool.query(
      `SELECT
        COALESCE(SUM(CASE WHEN is_idle = false THEN duration_seconds ELSE 0 END), 0) as active_seconds,
        COALESCE(SUM(CASE WHEN is_idle = true THEN duration_seconds ELSE 0 END), 0) as idle_seconds,
        COALESCE(SUM(duration_seconds), 0) as total_seconds,
        MIN(timestamp) as first_activity,
        MAX(timestamp) as last_activity,
        COUNT(*) as activity_count
       FROM activity_logs
       WHERE user_id = $1 AND shift_date = $2`,
      [targetUserId, shiftDate]
    );

    const activity = activityResult.rows[0];
    const sessions = sessionsResult.rows;

    // Compute first login / last logout from sessions
    const firstLogin = sessions.length > 0 ? sessions[0].start_time : null;
    const lastSession = sessions.length > 0 ? sessions[sessions.length - 1] : null;
    const lastLogout = lastSession?.end_time || null;
    const hasActiveSession = sessions.some(s => s.effective_status === 'active' || s.effective_status === 'idle');

    res.json({
      success: true,
      data: {
        shift: {
          date: shiftDate,
          start_local: shiftStartLocal,
          end_local: shiftEndLocal,
          start_utc: shift_start_utc,
          end_utc: shift_end_utc,
          working_hours_start: whStart ? whStart.substring(0, 5) : null,
          working_hours_end: whEnd ? whEnd.substring(0, 5) : null,
          is_night_shift: isNightShift,
          label: shiftLabel
        },
        sessions: sessions.map(s => ({
          id: s.id,
          start_time: s.start_time,
          end_time: s.end_time,
          duration_seconds: parseInt(s.duration_seconds) || 0,
          active_seconds: parseInt(s.active_seconds) || 0,
          idle_seconds: parseInt(s.idle_seconds) || 0,
          effective_status: s.effective_status,
          presence_idle_seconds: parseInt(s.presence_idle_seconds) || 0
        })),
        summary: {
          first_login: firstLogin,
          last_logout: lastLogout,
          is_active: hasActiveSession,
          total_seconds: parseInt(activity.total_seconds) || 0,
          active_seconds: parseInt(activity.active_seconds) || 0,
          idle_seconds: parseInt(activity.idle_seconds) || 0,
          session_count: sessions.length,
          activity_count: parseInt(activity.activity_count) || 0
        }
      }
    });
  } catch (error) {
    console.error('Get shift attendance error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve shift attendance' });
  }
});

// Export shift attendance as CSV
router.get('/shift-attendance/export', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, shiftDate, timezone } = req.query;

    if (!shiftDate) {
      return res.status(400).json({ success: false, message: 'shiftDate is required' });
    }

    // Determine which users to export
    let userIds = [];
    if (req.user.role === 'admin') {
      if (userId) {
        userIds = [userId];
      } else {
        // All users
        const allUsers = await pool.query('SELECT id FROM users ORDER BY full_name');
        userIds = allUsers.rows.map(r => r.id);
      }
    } else {
      userIds = [req.user.userId];
    }

    const tz = timezone || 'UTC';
    const rows = [];

    for (const uid of userIds) {
      // Get user info + team working hours
      const userResult = await pool.query(
        `SELECT u.full_name, u.email, t.name AS team_name,
                tms.working_hours_start, tms.working_hours_end
         FROM users u
         LEFT JOIN teams t ON u.team_id = t.id
         LEFT JOIN team_monitoring_settings tms ON tms.team_id = u.team_id
         WHERE u.id = $1`,
        [uid]
      );
      if (userResult.rows.length === 0) continue;
      const userInfo = userResult.rows[0];

      const whStart = userInfo.working_hours_start;
      const whEnd = userInfo.working_hours_end;

      // Compute shift window (same logic as shift-attendance)
      let shiftStartLocal, shiftEndLocal;
      if (whStart && whEnd) {
        const startParts = whStart.split(':').map(Number);
        const endParts = whEnd.split(':').map(Number);
        const isNight = startParts[0] * 60 + startParts[1] > endParts[0] * 60 + endParts[1];
        shiftStartLocal = `${shiftDate}T${whStart.substring(0, 5)}:00`;
        if (isNight) {
          const nextDay = new Date(new Date(shiftDate).getTime() + 86400000).toISOString().split('T')[0];
          shiftEndLocal = `${nextDay}T${whEnd.substring(0, 5)}:00`;
        } else {
          shiftEndLocal = `${shiftDate}T${whEnd.substring(0, 5)}:00`;
        }
      } else {
        shiftStartLocal = `${shiftDate}T00:00:00`;
        const nextDay = new Date(new Date(shiftDate).getTime() + 86400000).toISOString().split('T')[0];
        shiftEndLocal = `${nextDay}T00:00:00`;
      }

      // Convert to UTC
      const boundsResult = await pool.query(
        `SELECT ($1::timestamp AT TIME ZONE $3) AT TIME ZONE 'UTC' as shift_start_utc,
                ($2::timestamp AT TIME ZONE $3) AT TIME ZONE 'UTC' as shift_end_utc`,
        [shiftStartLocal, shiftEndLocal, tz]
      );
      const { shift_start_utc, shift_end_utc } = boundsResult.rows[0];

      // Get sessions
      const sessionsResult = await pool.query(
        `SELECT s.start_time, s.end_time, s.duration_seconds, s.is_active,
                p.last_heartbeat
         FROM sessions s
         LEFT JOIN user_presence p ON s.user_id = p.user_id
         WHERE s.user_id = $1 AND s.start_time >= $2 AND s.start_time < $3
         ORDER BY s.start_time ASC`,
        [uid, shift_start_utc, shift_end_utc]
      );

      if (sessionsResult.rows.length === 0) continue;

      // Get all activity logs for this shift to compute per-session idle/active from actual data
      const activityResult = await pool.query(
        `SELECT timestamp, duration_seconds, is_idle
         FROM activity_logs
         WHERE user_id = $1 AND timestamp >= $2 AND timestamp < $3
         ORDER BY timestamp ASC`,
        [uid, shift_start_utc, shift_end_utc]
      );
      const activities = activityResult.rows;

      for (const s of sessionsResult.rows) {
        const sessionStart = new Date(s.start_time).getTime();
        const sessionEnd = s.end_time ? new Date(s.end_time).getTime() : Date.now();
        const totalSecs = parseInt(s.duration_seconds) || Math.round((sessionEnd - sessionStart) / 1000);

        // Sum activity logs that fall within this session's time range
        let activeSeconds = 0;
        let idleSeconds = 0;
        for (const a of activities) {
          const aTime = new Date(a.timestamp).getTime();
          if (aTime >= sessionStart && aTime < sessionEnd) {
            const dur = parseInt(a.duration_seconds) || 0;
            if (a.is_idle) {
              idleSeconds += dur;
            } else {
              activeSeconds += dur;
            }
          }
        }

        const workingHours = Math.max(totalSecs - idleSeconds, 0);

        rows.push({
          user_name: userInfo.full_name,
          email: userInfo.email,
          date: shiftDate,
          login: s.start_time,
          logout: s.end_time,
          is_active: s.is_active && !s.end_time,
          total_hours: totalSecs,
          idle_time: idleSeconds,
          active_time: activeSeconds,
          working_hours: workingHours
        });
      }
    }

    // Format helpers
    const fmtDuration = (secs) => {
      if (!secs || secs <= 0) return '0 min';
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      if (h > 0) return m > 0 ? `${h} Hours ${m} min` : `${h} Hours`;
      return `${m} min`;
    };
    const fmtTime = (ts, tz) => {
      if (!ts) return '';
      try {
        return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz });
      } catch { return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }); }
    };
    const fmtDate = (d) => {
      const dt = new Date(d + 'T00:00:00');
      const day = dt.getDate();
      const suffix = day === 1 || day === 21 || day === 31 ? 'st' : day === 2 || day === 22 ? 'nd' : day === 3 || day === 23 ? 'rd' : 'th';
      return `${day}${suffix} ${dt.toLocaleString('en-US', { month: 'long' })}`;
    };

    // Build CSV
    const csvHeader = 'User Name,Email ID,Date,Log in,Log Out,Total Hours,Idle Time,Active Time,Total Working Hours (Active Hours - Idle Hours)';
    const escapeCSV = (val) => {
      const str = String(val ?? '');
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };
    const csvRows = rows.map(r => [
      r.user_name,
      r.email,
      fmtDate(r.date),
      fmtTime(r.login, tz),
      r.is_active ? 'Active' : fmtTime(r.logout, tz),
      fmtDuration(r.total_hours),
      fmtDuration(r.idle_time),
      fmtDuration(r.active_time),
      fmtDuration(r.working_hours)
    ].map(escapeCSV).join(','));

    const csv = [csvHeader, ...csvRows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="shift-attendance-${shiftDate}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Export shift attendance error:', error);
    res.status(500).json({ success: false, message: 'Failed to export shift attendance' });
  }
});

// =====================================================
// App Categories Management
// =====================================================

// Get all app categories
router.get('/app-categories', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { teamId } = req.query;

    let query = `
      SELECT c.*, t.name as team_name, u.full_name as created_by_name
      FROM app_categories c
      LEFT JOIN teams t ON c.team_id = t.id
      LEFT JOIN users u ON c.created_by = u.id
      WHERE c.team_id IS NULL
    `;
    const params = [];

    if (teamId) {
      query += ` OR c.team_id = $1`;
      params.push(teamId);
    }

    query += ` ORDER BY c.category, c.name`;

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get app categories error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve app categories' });
  }
});

// Create app category (admin only)
router.post('/app-categories', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const { name, pattern, category, teamId } = req.body;
    const pool = req.app.locals.pool;

    if (!name || !pattern || !category) {
      return res.status(400).json({ success: false, message: 'Name, pattern, and category are required' });
    }

    if (!['productive', 'unproductive', 'neutral'].includes(category)) {
      return res.status(400).json({ success: false, message: 'Category must be productive, unproductive, or neutral' });
    }

    const result = await pool.query(
      `INSERT INTO app_categories (name, pattern, category, team_id, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, pattern, category, teamId || null, req.user.userId]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Create app category error:', error);
    res.status(500).json({ success: false, message: 'Failed to create app category' });
  }
});

// Update app category (admin only)
router.patch('/app-categories/:id', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, pattern, category, teamId } = req.body;
    const pool = req.app.locals.pool;

    const updates = [];
    const params = [];
    let paramCount = 1;

    if (name) {
      updates.push(`name = $${paramCount}`);
      params.push(name);
      paramCount++;
    }

    if (pattern) {
      updates.push(`pattern = $${paramCount}`);
      params.push(pattern);
      paramCount++;
    }

    if (category) {
      if (!['productive', 'unproductive', 'neutral'].includes(category)) {
        return res.status(400).json({ success: false, message: 'Category must be productive, unproductive, or neutral' });
      }
      updates.push(`category = $${paramCount}`);
      params.push(category);
      paramCount++;
    }

    if (teamId !== undefined) {
      updates.push(`team_id = $${paramCount}`);
      params.push(teamId || null);
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    params.push(id);
    const result = await pool.query(
      `UPDATE app_categories SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Update app category error:', error);
    res.status(500).json({ success: false, message: 'Failed to update app category' });
  }
});

// Delete app category (admin only)
router.delete('/app-categories/:id', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const pool = req.app.locals.pool;

    const result = await pool.query('DELETE FROM app_categories WHERE id = $1 RETURNING id', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    res.json({ success: true, message: 'Category deleted successfully' });
  } catch (error) {
    console.error('Delete app category error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete app category' });
  }
});

module.exports = router;
