// Read-only diagnostic for BUG-2026-04-21-01/02/03.
// Usage: node admin-dashboard/scripts/diag-bugs-2026-04-21.js
require('dotenv').config();
const { Pool } = require('pg');
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

const print = (label, rows) => {
  console.log(`\n=== ${label} ===`);
  if (Array.isArray(rows)) {
    if (rows.length === 0) console.log('(no rows)');
    else rows.forEach(r => console.log(r));
  } else console.log(rows);
};

(async () => {
  try {
    // -------- BUG-01: negative-duration rows --------
    const neg = await pool.query(`
      SELECT s.id, u.full_name, s.start_time AT TIME ZONE 'Asia/Kolkata' AS start_ist,
             s.end_time AT TIME ZONE 'Asia/Kolkata' AS end_ist,
             s.duration_seconds, s.is_active, s.overtime
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.end_time IS NOT NULL AND s.end_time < s.start_time
      ORDER BY s.start_time DESC LIMIT 30`);
    print('BUG-01 negative-duration session rows (end_time < start_time)', neg.rows);

    const negCount = await pool.query(
      `SELECT COUNT(*)::int AS total FROM sessions WHERE end_time IS NOT NULL AND end_time < start_time`
    );
    print('BUG-01 total negative rows', negCount.rows[0]);

    // -------- BUG-02: "Unknown" app share --------
    const unk = await pool.query(`
      SELECT u.full_name,
        COUNT(*)::int AS total_logs,
        COUNT(*) FILTER (WHERE a.application_name IS NULL OR a.application_name = ''
                         OR LOWER(a.application_name) = 'unknown')::int AS unknown_n,
        ROUND(100.0 * COUNT(*) FILTER (WHERE a.application_name IS NULL OR a.application_name = ''
                         OR LOWER(a.application_name) = 'unknown') / NULLIF(COUNT(*),0), 1) AS unknown_pct
      FROM activity_logs a JOIN users u ON u.id = a.user_id
      WHERE a.timestamp > NOW() - INTERVAL '24 hours'
      GROUP BY u.full_name
      HAVING COUNT(*) > 20 AND COUNT(*) FILTER (WHERE LOWER(COALESCE(a.application_name,'')) IN ('','unknown')) > 0
      ORDER BY unknown_pct DESC NULLS LAST LIMIT 20`);
    print('BUG-02 users with Unknown app share (last 24h, >20 logs)', unk.rows);

    // -------- BUG-03: Himanshu's team config + session/activity --------
    const who = await pool.query(`
      SELECT u.id, u.full_name, u.email, u.team_id,
             tms.working_hours_start, tms.working_hours_end, tms.track_outside_hours
      FROM users u LEFT JOIN team_monitoring_settings tms ON tms.team_id = u.team_id
      WHERE u.full_name ILIKE '%Himanshu%'`);
    print('BUG-03 Himanshu user + team settings', who.rows);

    // Verify overtime column exists (H3 check)
    const col = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'sessions' AND column_name = 'overtime'`);
    print('BUG-03 sessions.overtime column exists?', col.rows);

    if (who.rows.length > 0) {
      const himId = who.rows[0].id;
      const sess = await pool.query(`
        SELECT id, start_time AT TIME ZONE 'Asia/Kolkata' AS start_ist,
               end_time AT TIME ZONE 'Asia/Kolkata' AS end_ist,
               is_active, duration_seconds,
               COALESCE(overtime, false) AS overtime
        FROM sessions WHERE user_id = $1
          AND start_time > NOW() - INTERVAL '3 days'
        ORDER BY start_time DESC LIMIT 20`, [himId]);
      print('BUG-03 Himanshu sessions (last 3 days)', sess.rows);

      const act = await pool.query(`
        SELECT DATE(timestamp AT TIME ZONE 'Asia/Kolkata') AS day_ist,
               MIN(timestamp AT TIME ZONE 'Asia/Kolkata') AS first_ist,
               MAX(timestamp AT TIME ZONE 'Asia/Kolkata') AS last_ist,
               COUNT(*)::int AS n_logs,
               COUNT(*) FILTER (WHERE is_overtime = true)::int AS ot_logs
        FROM activity_logs WHERE user_id = $1
          AND timestamp > NOW() - INTERVAL '3 days'
        GROUP BY day_ist ORDER BY day_ist DESC`, [himId]);
      print('BUG-03 Himanshu activity by IST day (last 3 days)', act.rows);

      const postShift = await pool.query(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE is_overtime = true)::int AS ot_tagged,
               MIN(timestamp AT TIME ZONE 'Asia/Kolkata') AS first_post_7_ist,
               MAX(timestamp AT TIME ZONE 'Asia/Kolkata') AS last_post_7_ist
        FROM activity_logs
        WHERE user_id = $1
          AND (timestamp AT TIME ZONE 'Asia/Kolkata')::time >= '19:00:00'
          AND timestamp > NOW() - INTERVAL '3 days'`, [himId]);
      print('BUG-03 Himanshu post-7PM activity (last 3 days)', postShift.rows);

      const sc = await pool.query(`
        SELECT COUNT(*)::int AS total,
               MIN(captured_at AT TIME ZONE 'Asia/Kolkata') AS first_post_7_ist,
               MAX(captured_at AT TIME ZONE 'Asia/Kolkata') AS last_post_7_ist
        FROM screenshots WHERE user_id = $1
          AND (captured_at AT TIME ZONE 'Asia/Kolkata')::time >= '19:00:00'
          AND captured_at > NOW() - INTERVAL '3 days'`, [himId]);
      print('BUG-03 Himanshu post-7PM screenshots (last 3 days)', sc.rows);

      const hb = await pool.query(`
        SELECT last_heartbeat AT TIME ZONE 'Asia/Kolkata' AS last_hb_ist, status, idle_seconds
        FROM user_presence WHERE user_id = $1`, [himId]);
      print('BUG-03 Himanshu presence row', hb.rows);
    }
  } catch (e) {
    console.error('Diagnostic error:', e.message);
  } finally {
    await pool.end();
  }
})();
