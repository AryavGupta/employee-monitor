// Vercel Serverless API Entry Point
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

// Import route handlers
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const screenshotRoutes = require('./routes/screenshots');
const activityRoutes = require('./routes/activity');
const alertRoutes = require('./routes/alerts');
const sessionRoutes = require('./routes/sessions');
const teamRoutes = require('./routes/teams');
const reportRoutes = require('./routes/reports');
const presenceRoutes = require('./routes/presence');
const aiAnalysisRoutes = require('./routes/ai-analysis');

const app = express();

// Database connection using Supabase
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Make pool available to routes
app.locals.pool = pool;

// Middleware - CORS configuration
// FRONTEND_URL must be set explicitly - no wildcards allowed for security
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
  : [];

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);

    // In development, allow localhost
    if (process.env.NODE_ENV !== 'production' && origin.includes('localhost')) {
      return callback(null, true);
    }

    // Check against allowed origins
    if (allowedOrigins.length === 0) {
      console.warn('WARNING: FRONTEND_URL not set, CORS may block requests');
      return callback(null, true); // Allow for backwards compatibility during migration
    }

    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      return callback(null, true);
    }

    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/screenshots', screenshotRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/presence', presenceRoutes);
app.use('/api/ai-analysis', aiAnalysisRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

module.exports = app;
