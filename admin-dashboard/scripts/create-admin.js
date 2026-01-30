#!/usr/bin/env node
/**
 * Create Admin User Script
 * Creates an admin user in the Employee Monitor database
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../backend/.env') });

const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function createAdmin() {
  const email = process.argv[2] || 'admin@employee-monitor.com';
  const password = process.argv[3] || 'Admin@123';
  const fullName = process.argv[4] || 'System Admin';

  console.log(`\nCreating admin user: ${email}`);

  try {
    // Check if user already exists
    const existing = await pool.query('SELECT id, email FROM users WHERE email = $1', [email.toLowerCase()]);

    if (existing.rows.length > 0) {
      console.log(`User ${email} already exists with ID: ${existing.rows[0].id}`);
      console.log('Updating password...');

      const passwordHash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET password_hash = $1, is_active = true WHERE email = $2', [passwordHash, email.toLowerCase()]);
      console.log('Password updated successfully!');
    } else {
      // Create new user
      const passwordHash = await bcrypt.hash(password, 10);

      const result = await pool.query(
        `INSERT INTO users (email, password_hash, full_name, role, is_active)
         VALUES ($1, $2, $3, 'admin', true)
         RETURNING id, email, full_name, role`,
        [email.toLowerCase(), passwordHash, fullName]
      );

      console.log('\nAdmin user created successfully!');
      console.log('User ID:', result.rows[0].id);
      console.log('Email:', result.rows[0].email);
      console.log('Role:', result.rows[0].role);
    }

    // List all users
    console.log('\n--- All Users in Database ---');
    const allUsers = await pool.query('SELECT id, email, full_name, role, is_active FROM users ORDER BY created_at');

    if (allUsers.rows.length === 0) {
      console.log('No users found in database.');
    } else {
      allUsers.rows.forEach((user, i) => {
        console.log(`${i + 1}. ${user.email} (${user.role}) - Active: ${user.is_active}`);
      });
    }

  } catch (error) {
    console.error('Error:', error.message);
    if (error.code === '42P01') {
      console.error('\nThe users table does not exist. Please run the database schema first.');
    }
  } finally {
    await pool.end();
  }
}

createAdmin();
