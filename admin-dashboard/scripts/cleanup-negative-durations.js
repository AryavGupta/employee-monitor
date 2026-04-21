// One-shot cleanup for BUG-2026-04-21-01.
// Operates only on the explicit IDs previewed by diag-bugs-2026-04-21.js.
// If other negative-duration rows exist, this script will NOT touch them —
// re-run the diagnostic and add IDs here deliberately.
require('dotenv').config();
const { Pool } = require('pg');
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

const TARGET_IDS = [
  '2792d89b-4fde-42bf-9abc-09d36954d301', // Sanyam Ahuja, -439s
  '3920280e-a08e-46be-8953-0bbebca727c6', // Aryav, -7240s
];

(async () => {
  try {
    const res = await pool.query(`
      UPDATE sessions
         SET end_time = start_time, duration_seconds = 0
       WHERE id = ANY($1::uuid[])
         AND end_time IS NOT NULL AND end_time < start_time
      RETURNING id, start_time, end_time, duration_seconds`, [TARGET_IDS]);
    console.log(`Updated ${res.rowCount} row(s):`);
    res.rows.forEach(r => console.log(`  - ${r.id} end=${r.end_time.toISOString()} dur=${r.duration_seconds}`));
  } catch (e) {
    console.error('Cleanup error:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
