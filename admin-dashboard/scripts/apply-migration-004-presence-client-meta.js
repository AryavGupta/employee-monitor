// Apply migrations/004_presence_client_meta.sql to prod safely.
// Adds app_version, os_platform, os_version to user_presence.
require('dotenv').config();
const { Pool } = require('pg');
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

const statements = [
  `ALTER TABLE user_presence ADD COLUMN IF NOT EXISTS app_version VARCHAR(20)`,
  `ALTER TABLE user_presence ADD COLUMN IF NOT EXISTS os_platform VARCHAR(20)`,
  `ALTER TABLE user_presence ADD COLUMN IF NOT EXISTS os_version  VARCHAR(50)`
];

(async () => {
  const client = await pool.connect();
  try {
    for (const sql of statements) {
      const label = sql.slice(0, 70).trim() + '...';
      process.stdout.write(`Running: ${label} ... `);
      await client.query(sql);
      console.log('OK');
    }

    console.log('\n--- Verification ---');
    const cols = await client.query(`
      SELECT column_name, data_type, character_maximum_length
      FROM information_schema.columns
      WHERE table_name = 'user_presence'
        AND column_name IN ('app_version', 'os_platform', 'os_version')
      ORDER BY column_name`);
    console.table(cols.rows);

    console.log('\nMigration 004 applied successfully.');
  } catch (e) {
    console.error('Migration FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
