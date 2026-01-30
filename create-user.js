const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'employee_monitor',
  password: '@Aryav2005', // <-- CHANGE THIS
  port: 5432,
});

async function createUser() {
  const email = 'admin@company.com';
  const password = 'Admin123';
  const fullName = 'OG admin';
  const role = 'admin';

  try {
    // Delete existing user if exists
    await pool.query('DELETE FROM users WHERE email = $1', [email]);
    
    // Hash the password properly
    const passwordHash = await bcrypt.hash(password, 10);
    console.log('Generated hash:', passwordHash);
    
    // Insert user
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, role, is_active) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id, email, full_name, role`,
      [email, passwordHash, fullName, role, true]
    );
    
    console.log('\n✅ User created successfully!');
    console.log('📧 Email:', email);
    console.log('🔑 Password:', password);
    console.log('\nNow try logging in with these credentials!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await pool.end();
  }
}

createUser();