// Read-only diagnostic for the two Apr-21 issues:
// (A) Aryav shown under Extra Hours despite 12:39 PM being inside 11-20 shift
// (B) Harsh Pathak Idle + Unknown + no screenshots
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
    const now = await pool.query(`SELECT NOW() AS utc, NOW() AT TIME ZONE 'Asia/Kolkata' AS ist`);
    print('SERVER NOW', now.rows[0]);

    // ---------- ARYAV ----------
    const aryav = await pool.query(`
      SELECT u.id, u.full_name, u.email, u.team_id,
             tms.working_hours_start, tms.working_hours_end, tms.track_outside_hours, tms.updated_at
      FROM users u LEFT JOIN team_monitoring_settings tms ON tms.team_id = u.team_id
      WHERE u.full_name ILIKE '%Aryav%'`);
    print('ARYAV user + team settings', aryav.rows);

    if (aryav.rows.length > 0) {
      const aId = aryav.rows[0].id;
      const ses = await pool.query(`
        SELECT id, start_time AT TIME ZONE 'Asia/Kolkata' AS start_ist,
               end_time AT TIME ZONE 'Asia/Kolkata' AS end_ist,
               is_active, duration_seconds, COALESCE(overtime,false) AS overtime
        FROM sessions WHERE user_id=$1 AND start_time > NOW() - INTERVAL '36 hours'
        ORDER BY start_time DESC LIMIT 20`, [aId]);
      print('ARYAV sessions (last 36h)', ses.rows);

      const act = await pool.query(`
        SELECT DATE(timestamp AT TIME ZONE 'Asia/Kolkata') AS day_ist,
               MIN(timestamp AT TIME ZONE 'Asia/Kolkata') AS first_ist,
               MAX(timestamp AT TIME ZONE 'Asia/Kolkata') AS last_ist,
               COUNT(*)::int AS n,
               COUNT(*) FILTER (WHERE is_overtime=true)::int AS ot,
               COUNT(*) FILTER (WHERE is_overtime=false)::int AS reg
        FROM activity_logs WHERE user_id=$1 AND timestamp > NOW() - INTERVAL '36 hours'
        GROUP BY day_ist ORDER BY day_ist DESC`, [aId]);
      print('ARYAV activity by IST day (last 36h) — ot vs reg counts', act.rows);

      const actSample = await pool.query(`
        SELECT timestamp AT TIME ZONE 'Asia/Kolkata' AS ts_ist,
               application_name, is_overtime, shift_date, is_idle
        FROM activity_logs WHERE user_id=$1 AND timestamp > NOW() - INTERVAL '8 hours'
        ORDER BY timestamp ASC LIMIT 10`, [aId]);
      print('ARYAV earliest 10 activity rows in last 8h', actSample.rows);

      const hb = await pool.query(`
        SELECT last_heartbeat AT TIME ZONE 'Asia/Kolkata' AS last_hb_ist,
               status, idle_seconds
        FROM user_presence WHERE user_id=$1`, [aId]);
      print('ARYAV presence', hb.rows);
    }

    // ---------- HARSH PATHAK ----------
    const harsh = await pool.query(`
      SELECT u.id, u.full_name, u.email, u.team_id,
             tms.working_hours_start, tms.working_hours_end, tms.track_outside_hours
      FROM users u LEFT JOIN team_monitoring_settings tms ON tms.team_id = u.team_id
      WHERE u.full_name ILIKE '%Harsh Pathak%'`);
    print('HARSH user + team settings', harsh.rows);

    if (harsh.rows.length > 0) {
      const hId = harsh.rows[0].id;

      const ses = await pool.query(`
        SELECT id, start_time AT TIME ZONE 'Asia/Kolkata' AS start_ist,
               end_time AT TIME ZONE 'Asia/Kolkata' AS end_ist,
               is_active, duration_seconds, COALESCE(overtime,false) AS overtime
        FROM sessions WHERE user_id=$1 AND start_time > NOW() - INTERVAL '36 hours'
        ORDER BY start_time DESC LIMIT 20`, [hId]);
      print('HARSH sessions (last 36h)', ses.rows);

      const hb = await pool.query(`
        SELECT last_heartbeat AT TIME ZONE 'Asia/Kolkata' AS last_hb_ist,
               status, idle_seconds,
               EXTRACT(EPOCH FROM (NOW() - last_heartbeat))::int AS seconds_since_hb
        FROM user_presence WHERE user_id=$1`, [hId]);
      print('HARSH presence (seconds_since_hb)', hb.rows);

      const actAgg = await pool.query(`
        SELECT COUNT(*)::int AS n_last_1h,
               MAX(timestamp AT TIME ZONE 'Asia/Kolkata') AS last_ts_ist,
               MIN(timestamp AT TIME ZONE 'Asia/Kolkata') AS first_ts_ist,
               COUNT(*) FILTER (WHERE LOWER(COALESCE(application_name,''))
                                       IN ('','unknown'))::int AS unknown_n
        FROM activity_logs
        WHERE user_id=$1 AND timestamp > NOW() - INTERVAL '1 hour'`, [hId]);
      print('HARSH activity last 1h summary', actAgg.rows);

      const actAppsDay = await pool.query(`
        SELECT application_name, COUNT(*)::int AS n
        FROM activity_logs WHERE user_id=$1
          AND timestamp > NOW() - INTERVAL '12 hours'
        GROUP BY application_name ORDER BY n DESC LIMIT 20`, [hId]);
      print('HARSH app_name distribution last 12h', actAppsDay.rows);

      const actRecent = await pool.query(`
        SELECT timestamp AT TIME ZONE 'Asia/Kolkata' AS ts_ist,
               application_name, window_title, is_idle, duration_seconds, is_overtime
        FROM activity_logs WHERE user_id=$1
          AND timestamp > NOW() - INTERVAL '2 hours'
        ORDER BY timestamp DESC LIMIT 15`, [hId]);
      print('HARSH most-recent 15 activity rows (last 2h)', actRecent.rows);

      const sc = await pool.query(`
        SELECT COUNT(*)::int AS n_today,
               MIN(captured_at AT TIME ZONE 'Asia/Kolkata') AS first_today,
               MAX(captured_at AT TIME ZONE 'Asia/Kolkata') AS last_today
        FROM screenshots
        WHERE user_id=$1
          AND captured_at >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date AT TIME ZONE 'Asia/Kolkata'`,
        [hId]);
      print('HARSH screenshots today (IST day so far)', sc.rows);

      const scRecent = await pool.query(`
        SELECT captured_at AT TIME ZONE 'Asia/Kolkata' AS at_ist
        FROM screenshots WHERE user_id=$1 AND captured_at > NOW() - INTERVAL '6 hours'
        ORDER BY captured_at DESC LIMIT 5`, [hId]);
      print('HARSH most-recent 5 screenshots (last 6h)', scRecent.rows);
    }
  } catch (e) {
    console.error('Diagnostic error:', e.message);
  } finally {
    await pool.end();
  }
})();
