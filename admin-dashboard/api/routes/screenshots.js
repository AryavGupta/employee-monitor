const express = require('express');
const router = express.Router();
const { authenticateToken, getManagedUserIds } = require('./auth');

// Lazy-load sharp and supabase to avoid issues during build
let sharp = null;
let supabase = null;

const initSupabase = () => {
  if (!supabase && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  }
  return supabase;
};

const initSharp = () => {
  if (!sharp) {
    try {
      sharp = require('sharp');
    } catch (e) {
      console.warn('Sharp not available, falling back to base64 storage');
    }
  }
  return sharp;
};

// Upload screenshot (for desktop app)
router.post('/upload', authenticateToken, async (req, res) => {
  try {
    const { screenshot, timestamp, systemInfo } = req.body;
    const userId = req.user.userId;
    const pool = req.app.locals.pool;

    if (!screenshot || !timestamp) {
      return res.status(400).json({ success: false, message: 'Screenshot data and timestamp are required' });
    }

    const supabaseClient = initSupabase();
    const sharpLib = initSharp();

    // If Supabase Storage is configured, use it with compression
    if (supabaseClient && sharpLib) {
      try {
        // Decode base64 to buffer
        const imageBuffer = Buffer.from(screenshot, 'base64');

        // Generate file paths
        const dateStr = new Date(timestamp).toISOString().split('T')[0];
        const timeStr = new Date(timestamp).toISOString().replace(/[:.]/g, '-');
        const basePath = `${userId}/${dateStr}`;
        const fullPath = `${basePath}/${timeStr}.webp`;
        const thumbPath = `${basePath}/thumbs/${timeStr}.webp`;

        // Compress to WebP (85% quality, ~100KB instead of ~650KB)
        const compressedImage = await sharpLib(imageBuffer)
          .webp({ quality: 85 })
          .toBuffer();

        // Generate thumbnail (480px width, 88% quality - clear enough to see content)
        const thumbnail = await sharpLib(imageBuffer)
          .resize(480, null, { fit: 'inside' })
          .webp({ quality: 88 })
          .toBuffer();

        // Upload full image to Supabase Storage
        const { error: uploadError } = await supabaseClient.storage
          .from('screenshots')
          .upload(fullPath, compressedImage, {
            contentType: 'image/webp',
            upsert: false
          });

        if (uploadError) throw uploadError;

        // Upload thumbnail
        const { error: thumbError } = await supabaseClient.storage
          .from('screenshots')
          .upload(thumbPath, thumbnail, {
            contentType: 'image/webp',
            upsert: false
          });

        if (thumbError) console.warn('Thumbnail upload failed:', thumbError);

        // Get public URLs
        const { data: { publicUrl: screenshotUrl } } = supabaseClient.storage
          .from('screenshots')
          .getPublicUrl(fullPath);

        const { data: { publicUrl: thumbnailUrl } } = supabaseClient.storage
          .from('screenshots')
          .getPublicUrl(thumbPath);

        // Store URLs in database (not base64)
        const result = await pool.query(
          `INSERT INTO screenshots (user_id, screenshot_url, thumbnail_url, storage_path, captured_at, file_size, system_info)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, captured_at`,
          [userId, screenshotUrl, thumbnailUrl, fullPath, timestamp, compressedImage.length, systemInfo ? JSON.stringify(systemInfo) : null]
        );

        return res.json({ success: true, message: 'Screenshot uploaded to storage', screenshotId: result.rows[0].id });
      } catch (storageError) {
        console.error('Storage upload failed, falling back to base64:', storageError);
        // Fall through to base64 storage
      }
    }

    // Fallback: Store as base64 data URL (original behavior)
    const screenshotUrl = `data:image/png;base64,${screenshot}`;

    const result = await pool.query(
      `INSERT INTO screenshots (user_id, screenshot_url, captured_at, system_info) VALUES ($1, $2, $3, $4) RETURNING id, captured_at`,
      [userId, screenshotUrl, timestamp, systemInfo ? JSON.stringify(systemInfo) : null]
    );

    res.json({ success: true, message: 'Screenshot uploaded successfully', screenshotId: result.rows[0].id });
  } catch (error) {
    console.error('Screenshot upload error:', error);
    res.status(500).json({ success: false, message: 'Failed to upload screenshot' });
  }
});

// Get screenshots with filtering (returns thumbnail_url for list view)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, startDate, endDate, limit = 50, offset = 0, flagged, interval } = req.query;

    let query = `
      SELECT s.id, s.user_id,
             COALESCE(s.thumbnail_url, s.screenshot_url) as screenshot_url,
             s.screenshot_url as full_url,
             s.captured_at, s.file_size, s.is_flagged, s.flag_reason,
             u.email, u.full_name, t.name as team_name
      FROM screenshots s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN teams t ON u.team_id = t.id
      WHERE 1=1
    `;

    const params = [];
    let paramCount = 1;

    // Role-based filtering
    if (req.user.role === 'admin') {
      // Admin can filter by any user or see all
      if (userId) {
        query += ` AND s.user_id = $${paramCount}`;
        params.push(userId);
        paramCount++;
      }
    } else if (req.user.role === 'team_manager') {
      // Team manager can see their team members + themselves
      const managedUserIds = await getManagedUserIds(pool, req.user.userId);
      const allowedIds = [req.user.userId, ...managedUserIds];

      if (userId && allowedIds.includes(userId)) {
        // Filter by specific user if allowed
        query += ` AND s.user_id = $${paramCount}`;
        params.push(userId);
        paramCount++;
      } else {
        // Show all allowed users
        const placeholders = allowedIds.map((_, i) => `$${paramCount + i}`).join(', ');
        query += ` AND s.user_id IN (${placeholders})`;
        params.push(...allowedIds);
        paramCount += allowedIds.length;
      }
    } else {
      // Regular employee - only own screenshots
      query += ` AND s.user_id = $${paramCount}`;
      params.push(req.user.userId);
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

    // Interval filter: only show screenshots at interval boundaries (e.g., :00, :05, :10 for 5-min interval)
    if (interval && parseInt(interval) > 0) {
      const intervalMinutes = parseInt(interval);
      query += ` AND EXTRACT(MINUTE FROM s.captured_at)::integer % $${paramCount} = 0`;
      params.push(intervalMinutes);
      paramCount++;
    }

    query += ` ORDER BY s.captured_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    res.json({ success: true, data: result.rows, pagination: { limit: parseInt(limit), offset: parseInt(offset) } });
  } catch (error) {
    console.error('Get screenshots error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve screenshots' });
  }
});

// Get single screenshot by ID (returns full resolution image)
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const pool = req.app.locals.pool;

    let query = `
      SELECT s.id, s.user_id, s.screenshot_url, s.thumbnail_url, s.storage_path,
             s.captured_at, s.file_size, s.is_flagged, s.flag_reason,
             u.email, u.full_name, t.name as team_name
      FROM screenshots s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN teams t ON u.team_id = t.id
      WHERE s.id = $1
    `;

    const params = [id];

    // Role-based access check
    if (req.user.role === 'team_manager') {
      const managedUserIds = await getManagedUserIds(pool, req.user.userId);
      const allowedIds = [req.user.userId, ...managedUserIds];
      const placeholders = allowedIds.map((_, i) => `$${i + 2}`).join(', ');
      query += ` AND s.user_id IN (${placeholders})`;
      params.push(...allowedIds);
    } else if (req.user.role !== 'admin') {
      query += ` AND s.user_id = $2`;
      params.push(req.user.userId);
    }

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Screenshot not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Get screenshot error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve screenshot' });
  }
});

// Get screenshot statistics
router.get('/stats/summary', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { userId, startDate, endDate } = req.query;

    let query = `
      SELECT COUNT(*) as total_screenshots,
             COUNT(CASE WHEN is_flagged = true THEN 1 END) as flagged_screenshots,
             COUNT(DISTINCT user_id) as active_users,
             MIN(captured_at) as first_screenshot,
             MAX(captured_at) as last_screenshot
      FROM screenshots WHERE 1=1
    `;

    const params = [];
    let paramCount = 1;

    // Role-based filtering
    if (req.user.role === 'admin') {
      // Admin can filter by any user or see all
      if (userId) {
        query += ` AND user_id = $${paramCount}`;
        params.push(userId);
        paramCount++;
      }
    } else if (req.user.role === 'team_manager') {
      // Team manager can see stats for their team members + themselves
      const managedUserIds = await getManagedUserIds(pool, req.user.userId);
      const allowedIds = [req.user.userId, ...managedUserIds];

      if (userId && allowedIds.includes(userId)) {
        query += ` AND user_id = $${paramCount}`;
        params.push(userId);
        paramCount++;
      } else {
        const placeholders = allowedIds.map((_, i) => `$${paramCount + i}`).join(', ');
        query += ` AND user_id IN (${placeholders})`;
        params.push(...allowedIds);
        paramCount += allowedIds.length;
      }
    } else {
      // Regular employee - only own stats
      query += ` AND user_id = $${paramCount}`;
      params.push(req.user.userId);
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
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve statistics' });
  }
});

// Flag/unflag a screenshot (admin only)
router.patch('/:id/flag', authenticateToken, async (req, res) => {
  try {
    // Only admins can flag screenshots
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admins can flag screenshots' });
    }

    const { id } = req.params;
    const { isFlagged, reason } = req.body;
    const pool = req.app.locals.pool;

    if (typeof isFlagged !== 'boolean') {
      return res.status(400).json({ success: false, message: 'isFlagged must be a boolean' });
    }

    const result = await pool.query(
      `UPDATE screenshots
       SET is_flagged = $1, flag_reason = $2
       WHERE id = $3
       RETURNING id, is_flagged, flag_reason`,
      [isFlagged, isFlagged ? (reason || null) : null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Screenshot not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Flag screenshot error:', error);
    res.status(500).json({ success: false, message: 'Failed to update screenshot flag' });
  }
});

module.exports = router;
