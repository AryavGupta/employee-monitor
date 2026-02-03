const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const router = express.Router();
const { sendWelcomeEmail, isEmailConfigured } = require('../services/emailService');

// JWT_SECRET is required - no fallback to prevent security vulnerabilities
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set');
  process.exit(1);
}
const JWT_EXPIRES_IN = '24h';
const RESET_TOKEN_EXPIRES = 3600000;

// Login endpoint
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const pool = req.app.locals.pool;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }

    const userQuery = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND is_active = true',
      [email.toLowerCase()]
    );

    if (userQuery.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    const user = userQuery.rows[0];
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)`,
      [user.id, 'LOGIN', 'user', req.ip || req.headers['x-forwarded-for'], req.get('user-agent')]
    );

    res.json({
      success: true,
      token,
      userId: user.id,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        teamId: user.team_id
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
  }
});

// Register new user (admin only)
router.post('/register', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const { email, password, fullName, role, teamId, sendEmail } = req.body;
    const pool = req.app.locals.pool;

    if (!email || !password || !fullName || !role) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ success: false, message: 'User with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, role, team_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, full_name, role, team_id`,
      [email.toLowerCase(), passwordHash, fullName, role, teamId || null]
    );

    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id) VALUES ($1, $2, $3, $4)`,
      [req.user.userId, 'CREATE_USER', 'user', result.rows[0].id]
    );

    // Send welcome email if requested and email service is configured
    let emailSent = false;
    let emailError = null;
    if (sendEmail) {
      if (isEmailConfigured()) {
        const emailResult = await sendWelcomeEmail(email.toLowerCase(), fullName, password);
        emailSent = emailResult.success;
        if (!emailResult.success) {
          emailError = emailResult.error;
        }
      } else {
        emailError = 'Email service not configured';
      }
    }

    const message = emailSent
      ? 'User created and welcome email sent'
      : sendEmail && emailError
        ? `User created but email failed: ${emailError}`
        : 'User created successfully';

    res.status(201).json({
      success: true,
      message,
      user: result.rows[0],
      emailSent,
      emailConfigured: isEmailConfigured()
    });
  } catch (error) {
    console.error('Registration error:', error);
    // Handle PostgreSQL unique constraint violation (code 23505)
    if (error.code === '23505' && error.constraint && error.constraint.includes('email')) {
      return res.status(409).json({ success: false, message: 'User with this email already exists' });
    }
    res.status(500).json({ success: false, message: 'Registration failed. Please try again.' });
  }
});

// Verify token
router.get('/verify', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const userQuery = await pool.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.team_id, t.name as team_name FROM users u LEFT JOIN teams t ON u.team_id = t.id WHERE u.id = $1 AND u.is_active = true`,
      [req.user.userId]
    );

    if (userQuery.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({ success: true, user: userQuery.rows[0] });
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

// Change password
router.post('/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const pool = req.app.locals.pool;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Current password and new password are required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: 'New password must be at least 8 characters long' });
    }

    const userQuery = await pool.query('SELECT id, password_hash FROM users WHERE id = $1', [req.user.userId]);
    if (userQuery.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const isPasswordValid = await bcrypt.compare(currentPassword, userQuery.rows[0].password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    }

    const newPasswordHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newPasswordHash, req.user.userId]);

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ success: false, message: 'Failed to change password' });
  }
});

// Admin reset password
router.post('/admin-reset-password', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const { userId, newPassword } = req.body;
    const pool = req.app.locals.pool;

    if (!userId || !newPassword) {
      return res.status(400).json({ success: false, message: 'User ID and new password are required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters long' });
    }

    const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [passwordHash, userId]);

    res.json({ success: true, message: 'Password reset successfully' });
  } catch (error) {
    console.error('Admin reset password error:', error);
    res.status(500).json({ success: false, message: 'Failed to reset password' });
  }
});

// Initial setup - creates admin if no users exist
router.post('/setup', async (req, res) => {
  try {
    const { email, password, fullName } = req.body;
    const pool = req.app.locals.pool;

    if (!email || !password || !fullName) {
      return res.status(400).json({ success: false, message: 'Email, password, and full name are required' });
    }

    // Check if any users exist
    const usersExist = await pool.query('SELECT COUNT(*) as count FROM users');
    if (parseInt(usersExist.rows[0].count) > 0) {
      return res.status(403).json({ success: false, message: 'Setup already completed. Users already exist.' });
    }

    // Create the initial admin user
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, role, is_active) VALUES ($1, $2, $3, 'admin', true) RETURNING id, email, full_name, role`,
      [email.toLowerCase(), passwordHash, fullName]
    );

    res.status(201).json({
      success: true,
      message: 'Initial admin user created successfully',
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Setup error:', error);
    res.status(500).json({ success: false, message: 'Setup failed. Please try again.' });
  }
});

// Emergency admin setup - reset or create admin
router.post('/reset-admin', async (req, res) => {
  try {
    const { email, newPassword, fullName, setupKey } = req.body;
    const pool = req.app.locals.pool;

    // Require ADMIN_SETUP_KEY environment variable for security
    const expectedKey = process.env.ADMIN_SETUP_KEY;
    if (!expectedKey) {
      return res.status(503).json({ success: false, message: 'Admin reset not configured' });
    }

    if (!setupKey || setupKey !== expectedKey) {
      return res.status(403).json({ success: false, message: 'Invalid setup key' });
    }

    if (!email || !newPassword) {
      return res.status(400).json({ success: false, message: 'Email and new password are required' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    // Try to find existing admin user
    const adminUser = await pool.query(
      `SELECT id, email FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );

    if (adminUser.rows.length > 0) {
      // Update existing user's password and make them admin
      await pool.query(
        'UPDATE users SET password_hash = $1, role = $2, is_active = true, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [passwordHash, 'admin', adminUser.rows[0].id]
      );
      res.json({
        success: true,
        message: 'Admin password reset successfully'
      });
    } else {
      // Create new admin user
      const result = await pool.query(
        `INSERT INTO users (email, password_hash, full_name, role, is_active) VALUES ($1, $2, $3, 'admin', true) RETURNING id, email, full_name, role`,
        [email.toLowerCase(), passwordHash, fullName || 'System Admin']
      );
      res.status(201).json({
        success: true,
        message: 'Admin user created successfully',
        user: result.rows[0]
      });
    }
  } catch (error) {
    console.error('Reset admin error:', error);
    res.status(500).json({ success: false, message: 'Reset failed. Please try again.' });
  }
});

// Logout
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)`,
      [req.user.userId, 'LOGOUT', 'user', req.ip || req.headers['x-forwarded-for'], req.get('user-agent')]
    );
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ success: false, message: 'Logout failed' });
  }
});

// Get profile
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const userQuery = await pool.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.team_id, u.is_active, u.created_at, u.updated_at, t.name as team_name FROM users u LEFT JOIN teams t ON u.team_id = t.id WHERE u.id = $1`,
      [req.user.userId]
    );

    if (userQuery.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({ success: true, data: userQuery.rows[0] });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve profile' });
  }
});

// Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, message: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, message: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

function authorizeAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  next();
}

// Authorize admin or team manager
function authorizeAdminOrManager(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'team_manager') {
    return res.status(403).json({ success: false, message: 'Admin or Team Manager access required' });
  }
  next();
}

// Helper: Get team IDs that a manager manages
async function getManagedTeamIds(pool, userId) {
  const result = await pool.query(
    'SELECT id FROM teams WHERE manager_id = $1',
    [userId]
  );
  return result.rows.map(r => r.id);
}

// Helper: Get all user IDs in teams managed by this manager
async function getManagedUserIds(pool, userId) {
  const result = await pool.query(
    `SELECT DISTINCT u.id FROM users u
     JOIN teams t ON u.team_id = t.id
     WHERE t.manager_id = $1`,
    [userId]
  );
  return result.rows.map(r => r.id);
}

// Helper: Check if user can access target user's data
async function canAccessUserData(pool, requestingUser, targetUserId) {
  // Admin can access anyone
  if (requestingUser.role === 'admin') return true;

  // Users can access their own data
  if (requestingUser.userId === targetUserId) return true;

  // Team managers can access their team members' data
  if (requestingUser.role === 'team_manager') {
    const managedUserIds = await getManagedUserIds(pool, requestingUser.userId);
    return managedUserIds.includes(targetUserId);
  }

  return false;
}

// Helper: Build user filter for queries based on role
async function buildUserFilter(pool, user, paramCount = 1) {
  if (user.role === 'admin') {
    // Admin sees all - no filter needed
    return { condition: '', params: [], nextParamCount: paramCount };
  }

  if (user.role === 'team_manager') {
    // Team manager sees their team members
    const managedUserIds = await getManagedUserIds(pool, user.userId);
    if (managedUserIds.length === 0) {
      // Manager with no team members - only see own data
      return {
        condition: ` AND user_id = $${paramCount}`,
        params: [user.userId],
        nextParamCount: paramCount + 1
      };
    }
    // Include manager's own data + team members
    const allIds = [user.userId, ...managedUserIds];
    const placeholders = allIds.map((_, i) => `$${paramCount + i}`).join(', ');
    return {
      condition: ` AND user_id IN (${placeholders})`,
      params: allIds,
      nextParamCount: paramCount + allIds.length
    };
  }

  // Regular employee - only own data
  return {
    condition: ` AND user_id = $${paramCount}`,
    params: [user.userId],
    nextParamCount: paramCount + 1
  };
}

module.exports = router;
module.exports.authenticateToken = authenticateToken;
module.exports.authorizeAdmin = authorizeAdmin;
module.exports.authorizeAdminOrManager = authorizeAdminOrManager;
module.exports.getManagedTeamIds = getManagedTeamIds;
module.exports.getManagedUserIds = getManagedUserIds;
module.exports.canAccessUserData = canAccessUserData;
module.exports.buildUserFilter = buildUserFilter;
