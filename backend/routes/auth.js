const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRES_IN = '24h';
const RESET_TOKEN_EXPIRES = 3600000; // 1 hour in milliseconds

// Login endpoint
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const pool = req.app.locals.pool;

    console.log('🔍 Login attempt:', email); // ADD THIS

    if (!email || !password) {
      console.log('❌ Missing credentials'); // ADD THIS
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }

    // Find user
    const userQuery = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND is_active = true',
      [email.toLowerCase()]
    );

    console.log('🔍 Users found:', userQuery.rows.length); // ADD THIS

    if (userQuery.rows.length === 0) {
      console.log('❌ User not found'); // ADD THIS
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    const user = userQuery.rows[0];
    console.log('🔍 User found:', user.email); // ADD THIS

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    console.log('🔍 Password valid:', isPasswordValid); // ADD THIS

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    // Log audit trail
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, ip_address, user_agent) 
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, 'LOGIN', 'user', req.ip, req.get('user-agent')]
    );

    // Return success response
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
    res.status(500).json({
      success: false,
      message: 'Login failed. Please try again.'
    });
  }
});

// Register new user (admin only)
router.post('/register', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const { email, password, fullName, role, teamId } = req.body;
    const pool = req.app.locals.pool;

    if (!email || !password || !fullName || !role) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required'
      });
    }

    // Check if user already exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'User with this email already exists'
      });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Insert new user
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, role, team_id) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id, email, full_name, role, team_id`,
      [email.toLowerCase(), passwordHash, fullName, role, teamId || null]
    );

    const newUser = result.rows[0];

    // Log audit trail
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id) 
       VALUES ($1, $2, $3, $4)`,
      [req.user.userId, 'CREATE_USER', 'user', newUser.id]
    );

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      user: newUser
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Registration failed. Please try again.'
    });
  }
});

// Verify token endpoint
router.get('/verify', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;

    const userQuery = await pool.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.team_id, t.name as team_name
       FROM users u
       LEFT JOIN teams t ON u.team_id = t.id
       WHERE u.id = $1 AND u.is_active = true`,
      [req.user.userId]
    );

    if (userQuery.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      user: userQuery.rows[0]
    });

  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Verification failed'
    });
  }
});

// Change password endpoint
router.post('/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const pool = req.app.locals.pool;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password are required'
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 8 characters long'
      });
    }

    // Get current user
    const userQuery = await pool.query(
      'SELECT id, password_hash FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (userQuery.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = userQuery.rows[0];

    // Verify current password
    const isPasswordValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, 10);

    // Update password
    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newPasswordHash, req.user.userId]
    );

    // Log audit trail
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.userId, 'CHANGE_PASSWORD', 'user', req.user.userId, req.ip]
    );

    res.json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to change password'
    });
  }
});

// Request password reset (admin can reset for any user)
router.post('/reset-password-request', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    const pool = req.app.locals.pool;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = await bcrypt.hash(resetToken, 10);
    const resetTokenExpiry = new Date(Date.now() + RESET_TOKEN_EXPIRES);

    // Store reset token in database (you might want to add these columns to users table)
    // For now, we'll use a simple approach with audit_logs
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.userId,
        'PASSWORD_RESET_REQUEST',
        'user',
        userId,
        JSON.stringify({ resetTokenHash, resetTokenExpiry, requestedBy: req.user.userId })
      ]
    );

    res.json({
      success: true,
      message: 'Password reset initiated',
      resetToken: resetToken // In production, this would be sent via email
    });

  } catch (error) {
    console.error('Password reset request error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to initiate password reset'
    });
  }
});

// Admin reset user password directly
router.post('/admin-reset-password', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const { userId, newPassword } = req.body;
    const pool = req.app.locals.pool;

    if (!userId || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'User ID and new password are required'
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters long'
      });
    }

    // Check if user exists
    const userCheck = await pool.query('SELECT id, email FROM users WHERE id = $1', [userId]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, 10);

    // Update password
    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [passwordHash, userId]
    );

    // Log audit trail
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.userId, 'ADMIN_RESET_PASSWORD', 'user', userId, req.ip]
    );

    res.json({
      success: true,
      message: 'Password reset successfully'
    });

  } catch (error) {
    console.error('Admin reset password error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reset password'
    });
  }
});

// Logout endpoint (for audit logging)
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;

    // Log audit trail
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.userId, 'LOGOUT', 'user', req.ip, req.get('user-agent')]
    );

    res.json({
      success: true,
      message: 'Logged out successfully'
    });

  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      success: false,
      message: 'Logout failed'
    });
  }
});

// Get current user profile
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const pool = req.app.locals.pool;

    const userQuery = await pool.query(
      `SELECT
        u.id,
        u.email,
        u.full_name,
        u.role,
        u.team_id,
        u.is_active,
        u.created_at,
        u.updated_at,
        t.name as team_name
       FROM users u
       LEFT JOIN teams t ON u.team_id = t.id
       WHERE u.id = $1`,
      [req.user.userId]
    );

    if (userQuery.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      data: userQuery.rows[0]
    });

  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve profile'
    });
  }
});

// Update own profile
router.patch('/profile', authenticateToken, async (req, res) => {
  try {
    const { fullName } = req.body;
    const pool = req.app.locals.pool;

    if (!fullName) {
      return res.status(400).json({
        success: false,
        message: 'Full name is required'
      });
    }

    const result = await pool.query(
      `UPDATE users
       SET full_name = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, email, full_name, role, team_id`,
      [fullName, req.user.userId]
    );

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update profile'
    });
  }
});

// Middleware to authenticate JWT token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Access token required'
    });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({
        success: false,
        message: 'Invalid or expired token'
      });
    }
    req.user = user;
    next();
  });
}

// Middleware to authorize admin role
function authorizeAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Admin access required'
    });
  }
  next();
}

module.exports = router;
module.exports.authenticateToken = authenticateToken;
module.exports.authorizeAdmin = authorizeAdmin;
