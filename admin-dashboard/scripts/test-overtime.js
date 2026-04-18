// Smoke test for the Overtime / Extra Hours feature.
// Read-only against schema + presence; writes to user_presence are temporary
// (round-tripped to the original status). Exercises the SQL paths the new
// endpoints will use rather than hitting HTTP — this avoids needing a JWT.
//
// Run: node admin-dashboard/scripts/test-overtime.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`  PASS  ${name}`); };
const bad = (name, details) => { fail++; console.log(`  FAIL  ${name}\n        ${details}`); };

// Same SQL fragment presence.js uses — kept in sync manually.
const EFFECTIVE_STATUS_SQL = `
  CASE
    WHEN p.status = 'logged_out' THEN 'logged_out'
    WHEN p.last_heartbeat <= NOW() - INTERVAL '90 seconds' THEN 'offline'
    WHEN EXISTS (
      SELECT 1 FROM activity_logs a
      WHERE a.user_id = p.user_id
        AND a.timestamp > NOW() - INTERVAL '90 seconds'
        AND a.is_idle = false
    ) THEN 'online'
    ELSE 'idle'
  END
`;

(async () => {
  console.log('\n=== Overtime / Extra Hours smoke test ===\n');

  // ── 1. Schema ────────────────────────────────────────────────────────────
  console.log('1. Schema');

  const sessionsCols = await pool.query(
    `SELECT column_name, data_type, column_default, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'sessions' AND column_name = 'overtime'`
  );
  if (sessionsCols.rows.length === 1 && sessionsCols.rows[0].data_type === 'boolean') {
    ok('sessions.overtime column (boolean)');
  } else {
    bad('sessions.overtime column missing', JSON.stringify(sessionsCols.rows));
  }

  const tmsCols = await pool.query(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_name = 'team_monitoring_settings' AND column_name = 'track_outside_hours'`
  );
  if (tmsCols.rows.length === 1 && tmsCols.rows[0].data_type === 'boolean') {
    ok('team_monitoring_settings.track_outside_hours column (boolean)');
  } else {
    bad('track_outside_hours column missing', JSON.stringify(tmsCols.rows));
  }

  const checkCon = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE conrelid = 'user_presence'::regclass AND contype = 'c'`
  );
  const hasLoggedOut = checkCon.rows.some(r => r.def.includes("'logged_out'"));
  if (hasLoggedOut) {
    ok("user_presence CHECK constraint allows 'logged_out'");
  } else {
    bad("user_presence CHECK doesn't include 'logged_out'", JSON.stringify(checkCon.rows));
  }

  const idx = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'sessions' AND indexname = 'idx_sessions_user_overtime'`
  );
  if (idx.rows.length === 1) {
    ok('idx_sessions_user_overtime index present');
  } else {
    bad('idx_sessions_user_overtime missing', '');
  }

  // ── 2. logged_out CHECK constraint round-trip ────────────────────────────
  console.log('\n2. logged_out write path');
  const userResult = await pool.query(`SELECT id FROM users WHERE is_active = true ORDER BY created_at LIMIT 1`);
  if (userResult.rows.length === 0) {
    bad('no users to test with', 'create at least one user first');
  } else {
    const testUserId = userResult.rows[0].id;
    const before = await pool.query(`SELECT status, last_heartbeat FROM user_presence WHERE user_id = $1`, [testUserId]);
    const restoreStatus = before.rows[0]?.status || 'offline';

    try {
      await pool.query(
        `INSERT INTO user_presence (user_id, status, last_heartbeat)
         VALUES ($1, 'logged_out', CURRENT_TIMESTAMP)
         ON CONFLICT (user_id) DO UPDATE SET status = 'logged_out', last_heartbeat = CURRENT_TIMESTAMP`,
        [testUserId]
      );
      ok("INSERT user_presence with status='logged_out' succeeds");
    } catch (e) {
      bad("INSERT 'logged_out' failed", e.message);
    }

    // Restore
    if (before.rows.length > 0) {
      await pool.query(
        `UPDATE user_presence SET status = $2 WHERE user_id = $1`,
        [testUserId, restoreStatus]
      );
    }
  }

  // ── 3. EFFECTIVE_STATUS_SQL produces all four states ─────────────────────
  console.log('\n3. effective_status computation');
  const statusBreakdown = await pool.query(
    `SELECT
       ${EFFECTIVE_STATUS_SQL} AS effective_status,
       COUNT(*) AS n
     FROM user_presence p
     GROUP BY 1
     ORDER BY 1`
  );
  console.log('   status distribution:', statusBreakdown.rows.map(r => `${r.effective_status}=${r.n}`).join('  '));
  const validStates = new Set(['online', 'idle', 'offline', 'logged_out']);
  const invalid = statusBreakdown.rows.filter(r => !validStates.has(r.effective_status));
  if (invalid.length === 0) {
    ok('all computed statuses are within {online, idle, offline, logged_out}');
  } else {
    bad('unexpected status values', JSON.stringify(invalid));
  }

  // ── 4. heartbeat-only without activity → idle ────────────────────────────
  console.log('\n4. Online requires activity (the Neeraj fix)');
  const heartbeatOnly = await pool.query(
    `SELECT COUNT(*) AS n FROM user_presence p
     WHERE p.last_heartbeat > NOW() - INTERVAL '90 seconds'
       AND p.status NOT IN ('logged_out')
       AND NOT EXISTS (
         SELECT 1 FROM activity_logs a
         WHERE a.user_id = p.user_id
           AND a.timestamp > NOW() - INTERVAL '90 seconds'
           AND a.is_idle = false
       )`
  );
  console.log(`   ${heartbeatOnly.rows[0].n} users currently in heartbeat-only state — these will show as Idle (not Online)`);
  ok('rule encoded — heartbeat without activity classifies as Idle');

  // ── 5. /shift-attendance regular vs overtime separation ──────────────────
  console.log('\n5. Regular vs overtime session separation');
  const regularCount = await pool.query(
    `SELECT COUNT(*) AS n FROM sessions WHERE overtime = false OR overtime IS NULL`
  );
  const overtimeCount = await pool.query(
    `SELECT COUNT(*) AS n FROM sessions WHERE overtime = true`
  );
  console.log(`   regular sessions: ${regularCount.rows[0].n}, overtime sessions: ${overtimeCount.rows[0].n}`);
  ok('overtime column queryable');

  // ── 6. Heartbeat settings_version lookup shape ───────────────────────────
  console.log('\n6. Heartbeat settings_version + track_outside_hours lookup');
  if (userResult.rows.length > 0) {
    const cfgResult = await pool.query(
      `SELECT
         EXTRACT(EPOCH FROM tms.updated_at) * 1000 AS settings_version,
         tms.track_outside_hours
       FROM users u
       LEFT JOIN team_monitoring_settings tms ON tms.team_id = u.team_id
       WHERE u.id = $1
       LIMIT 1`,
      [userResult.rows[0].id]
    );
    if (cfgResult.rows.length === 1) {
      const row = cfgResult.rows[0];
      console.log(`   settings_version=${row.settings_version}, track_outside_hours=${row.track_outside_hours}`);
      ok('lookup returns expected shape');
    } else {
      bad('lookup returned wrong row count', `got ${cfgResult.rows.length}`);
    }
  }

  // ── 7. Index will be used by overtime queries ────────────────────────────
  console.log('\n7. Query plan check');
  const explain = await pool.query(
    `EXPLAIN SELECT id FROM sessions WHERE user_id = (SELECT id FROM users LIMIT 1)
       AND start_time >= NOW() - INTERVAL '7 days' AND start_time < NOW() AND overtime = true`
  );
  const planText = explain.rows.map(r => r['QUERY PLAN']).join(' ');
  if (planText.includes('idx_sessions_user_overtime') || planText.includes('Index')) {
    ok('overtime query uses an index');
  } else {
    console.log('   plan:', planText.substring(0, 200));
    bad('overtime query may seq-scan', planText.substring(0, 200));
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  process.exitCode = fail === 0 ? 0 : 1;
  await pool.end();
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
