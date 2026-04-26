# Dev Changes

Append-only log. Newest first.

---

## 2026-04-26 — Admin user deletion: actually deletes now (audit-log column drift)

**Reported symptom:** Toast says "User deleted", but after refresh the user is still there and the count is unchanged. Earlier same-day cleanup commit (06bc568) was insufficient.

**Root cause:** The new transactional delete inserted into `audit_logs (user_id, action, entity_type, entity_id, details)`. The schema-of-record (`supabase-schema.sql`) has `details JSONB`, but the **live Supabase DB** column is named `changes` — that column was renamed at some point and the schema file was never updated. The audit INSERT therefore failed with `42703 column "details" does not exist`. The error was caught silently by the inner `try/catch`. **But the txn was already in aborted state**, and `COMMIT` against an aborted txn silently rolls back (the `pg` driver returns the command tag `ROLLBACK` without throwing). End result: API returned `{ success: true }`, the user-facing toast fired, but every change in the txn — including `DELETE FROM users` — was discarded.

**Why it matched the user-visible symptoms:** success toast (HTTP 200 returned), zero DB change (rolled back), and pages unchanged after refresh.

**Fix (`admin-dashboard/api/routes/users.js`):**
1. **`safe()` SAVEPOINT helper.** Every cleanup query is wrapped in `SAVEPOINT … RELEASE / ROLLBACK TO SAVEPOINT`. A `42P01` (missing table) or `42703` (missing column) rolls back only the inner savepoint, not the outer txn. Future schema drift can no longer poison the deletion.
2. **Audit insert uses only the columns shared by every `INSERT INTO audit_logs` in the codebase** (`user_id, action, entity_type, entity_id`) — the same columns `auth.js` uses. No `details`/`changes` JSON payload, so the live/schema divergence is sidestepped entirely. Still wrapped in a savepoint as belt-and-suspenders.
3. **Two more child tables added** (defensive, even though both also CASCADE): `screenshot_analyses`, `work_sessions`. Live FK audit also showed a duplicate `fk_user` (NO ACTION) constraint on `screenshots.user_id` alongside the CASCADE one — the explicit `DELETE FROM screenshots` step satisfies both.
4. **`work_sessions.approved_by` (NO ACTION) added to nullableRefs.**

**Why the user also reported "Delete button styling regressed":** The committed source (06bc568) already has `className="btn btn-secondary"` / `"btn btn-danger"`. The user was hitting either a Vercel deploy that hadn't rolled forward yet or a stale browser bundle. Pushing the backend change triggers a fresh Vercel build, which busts the bundle hash and forces the browser to re-fetch the latest `Users.js` / `Users.css`.

**Files changed:**
- `admin-dashboard/api/routes/users.js`

**Validation (run against live DB, txn rolled back so nothing changes):**
1. Replay the new flow with `safe()` savepoints — `DELETE FROM users` returns `rowCount=1`, the audit `INSERT INTO audit_logs (user_id, action, entity_type, entity_id)` succeeds (no longer references missing column), within-txn `SELECT FROM users WHERE id = $1` returns 0 rows. After ROLLBACK the user is restored — confirmed.
2. Manual end-to-end after deploy: delete a non-admin employee, refresh — user gone from list, Total count decreases. Counts of `activity_logs`, `screenshots`, `sessions`, `user_presence` for that `user_id` are 0. `teams.manager_id` becomes NULL if the user managed a team. Self-delete still 400, admin-delete still 403.

**Deploy:** Push to `main` — Vercel rebuilds API + frontend. No schema migration required.

---

## 2026-04-26 — Admin user deletion: full cleanup + dialog button fix

**Root cause of "Delete button not working":** Confirmation-dialog buttons used `className="btn-secondary"` / `className="btn-danger"` without the `btn` base class. The base `.btn` rule in `App.css` is what supplies `display: inline-flex`, padding, font-size, border-radius, cursor, transition. Without it, the buttons fell back to default browser styling — undersized, misaligned, and visually broken (which is what made the Delete button feel "not working"). The click handler itself was wired correctly.

**Backend (`admin-dashboard/api/routes/users.js`)** — `DELETE /api/users/:id` rewritten with transactional cleanup. Old code relied solely on `ON DELETE CASCADE` and ran a single un-transacted `DELETE FROM users`. New flow inside a `BEGIN/COMMIT`:
1. `UPDATE users SET team_id = NULL` (detach from team per spec)
2. `UPDATE teams SET manager_id = NULL WHERE manager_id = $1` (clear manager pointer)
3. Explicit `DELETE FROM` of `activity_logs`, `screenshots`, `sessions`, `user_presence`, `productivity_metrics`, `alerts` by `user_id`. Per-table try/catch swallows `42P01` (table not present in this deployment) but rethrows everything else.
4. Null SET-NULL refs: `alerts.resolved_by`, `app_categories.created_by`, `alert_rules.created_by`, `site_rules.created_by`, `audit_logs.user_id`. Swallows `42P01`/`42703`.
5. `DELETE FROM users WHERE id = $1 RETURNING id` — rolls back if rowCount=0.
6. Audit log insert is non-fatal (caught locally) so the deletion still commits if `audit_logs` write fails.
7. Self-delete (400) and admin-delete (403) guards retained.
8. Response: `{ success: true, message: 'User deleted' }`.

**Frontend (`admin-dashboard/src/components/Users.js`)**:
- Modal buttons now `className="btn btn-secondary"` / `"btn btn-danger"`.
- New `deleting` state; both buttons disabled during the request, Delete shows `Deleting…`, ESC suppressed mid-request to prevent double-fire.
- Toast text now reads `User deleted` per spec.
- New `handleDeleteCancel` so cancel/ESC paths share one place that respects the `deleting` flag.

**CSS (`admin-dashboard/src/components/Users.css`)** — added `.delete-modal .modal-actions .btn` rule giving both buttons equal `flex: 1 1 0`, fixed `height: 42px`, identical padding/font/border-radius so Cancel and Delete are visually symmetrical.

**Files changed:**
- `admin-dashboard/api/routes/users.js`
- `admin-dashboard/src/components/Users.js`
- `admin-dashboard/src/components/Users.css`

**Validation:**
- Delete an employee with screenshots + activity logs + sessions + a presence row → `SELECT COUNT(*) FROM <table> WHERE user_id = '<deleted>'` should be 0 for each.
- Delete a user who is a team manager → `teams.manager_id` becomes NULL; team itself and other members untouched.
- Try to delete self → 400. Try to delete an admin → 403.
- Toast on success reads exactly "User deleted".
- Cancel and Delete buttons same height, same padding; Delete clickable across full visible area.
- Dashboard, analytics, attendance, screenshots pages still load with no console errors after deletion.

**Deploy:** Vercel auto-deploys from `main`. No schema migration required — fix is defensive against missing CASCADE.

---

## 2026-04-26 — Fix: lock-screen produces "Unknown" activity rows (BUG-2026-04-26-LOCKSCREEN-UNKNOWN)

**Reported symptom:** Activity logs intermittently show `application_name = 'Unknown'`. Concentrated on long-shift teams (Morning, 11AM–08PM) and on users with no team assigned. Screenshots unaffected.

**Live data confirmed the pattern (last 7d):**

| Team | Unknown | Total | % |
|---|---|---|---|
| (NULL — no team) | 5980 | 14513 | 41.20 |
| New morning team | 6457 | 17940 | 35.99 |
| 11Am-08PM | 8424 | 50593 | 16.65 |
| Evening | 44 | 19058 | 0.23 |
| 10:30PM-07:30AM | 25 | 53693 | 0.05 |
| 1PM-7PM | 4 | 10990 | 0.04 |

**Root cause.** `powerMonitor.on('lock-screen', …)` only flipped `isCurrentlyIdle = true` and pinged one heartbeat. It did NOT pause `activityInterval` (10s), `screenshotInterval` (60s), or stop the periodic heartbeat's app probe. While Windows showed the lock screen, every 10s tick of `trackActivity()` ran:

1. `GetForegroundWindow()` → `0` (secure desktop is isolated from the user session).
2. `GetProcessById(0)` → throws (System Idle Process can't be queried). Caught.
3. PowerShell script's `$pName` stayed at the literal initialisation `'Unknown'` (line 1974 of `desktop-app/main.js`).
4. Script emitted `{"DisplayName":"Unknown","ProcessName":"Unknown",...}`.
5. Node returned `appName: 'Unknown'`. Row inserted with `application_name = 'Unknown'`, `is_idle = true`, `window_title = ''`.

Why the rate scales with team:
- **NULL team** has no `team_monitoring_settings` row → `shouldTrackNow()` returns true 24/7 → the machine sits locked overnight ~14h → flood.
- **Morning/long shifts** straddle lunch (~1h locked) + multiple short breaks + the AM password-entry window before Windows is unlocked.
- **Evening / Night / Afternoon shifts** are short or compressed; outside the shift window `shouldTrackNow()` is false so locked-machine ticks aren't logged at all → near-zero.

Why screenshots were unaffected: Electron's `desktopCapturer` cannot read the Windows secure desktop, so locked-state captures fail or return black — they don't produce misleading rows the way the activity probe did.

**Fix (`desktop-app/main.js`):**
1. New `isScreenLocked` boolean (defaults false).
2. `powerMonitor.on('lock-screen')` sets it true; `unlock-screen` clears it. Existing idle/heartbeat behavior preserved.
3. `trackActivity()` early-returns when `isScreenLocked` (mirrors the existing `if (!isTracking) return` defense from BUG-2026-04-21-05).
4. `captureScreenshot()` early-returns when `isScreenLocked` — secure desktop captures are useless anyway.
5. `sendHeartbeat()` skips the `trackActiveApplication()` probe when locked and posts the heartbeat with `current_application: null`. Presence stays online (no false "disconnected" status while at lunch); `user_presence.current_application` stops being overwritten with `'Unknown'`.

**Files:** `desktop-app/main.js` (state declaration, two power-monitor handlers, three intervals).

**Validation:**
- Lock screen with `Win+L` → tail desktop log → `'Screen locked - marking as idle'` appears, then no further `Sending activity batch` / `Sent N activity logs` lines until unlock.
- DB check during lock: `SELECT COUNT(*) FROM activity_logs WHERE user_id = '<me>' AND timestamp >= '<lock_ts>'` should stay flat.
- Unlock → activity tracking resumes within ≤10s.
- Dashboard "Live" tab: user remains `online`/`idle` while locked (heartbeat still flowing), does NOT flip to `logged_out`.
- Re-run the team-rate query 24h after rollout — Morning/NULL buckets should drop by an order of magnitude.

**Followup (separate task — flagged, not implemented here):**
- The NULL-team bucket (41% Unknown) is symptomatic of users with no team assignment running 24/7. Even with this fix, NULL-team users will still produce overnight ghost rows for legitimate-but-empty foreground apps (a screen saver registered as a process, etc.). Audit `users` for `team_id IS NULL` and either assign or block their tracking.

**Deploy:** desktop-only. Per [batch desktop builds] feedback, do NOT bump version or run `build:desktop` in isolation — bundle with the user-identity-badge change from earlier today and any other pending desktop edits before the next installer.

---

## 2026-04-26 — Desktop user identity badge (top-left)

Tracking screen now shows the logged-in user's full name + email in a top-left badge, mirroring the visual style of the existing top-right version badge so the two read as a matched pair.

- New IPC: `get-user-info` returns `{ fullName, email }` from `CONFIG.USER_DATA` (null when unauthenticated). Exposed to the renderer via `preload.js → window.electronAPI.getUserInfo`.
- `tracking.html` renders a fixed `.user-badge` (top: 10px, left: 14px) with two stacked lines. Font sizes use `clamp(11px, 3.2vw, 13px)` / `clamp(9px, 2.6vw, 11px)` so the text scales with window width but stays bounded. Badge is `max-width: calc(100vw - 110px)` to reserve room for the version badge on the right; long names/emails ellipsize.
- Badge is hidden until `getUserInfo()` resolves with non-empty data, so unauthenticated states don't flash an empty pill.

Files: `desktop-app/main.js` (IPC handler near `get-app-version`), `desktop-app/preload.js`, `desktop-app/tracking.html`.

**Deploy:** desktop-only. No DB or backend change. Per [batch desktop builds] feedback — do NOT bump version or run `build:desktop` for this alone; bundle with the next batch.

**Validation:**
- Launch tracking screen post-login → badge appears top-left with name (bold) + email (lighter) on dark pill.
- Resize the 400px-wide window narrower → text shrinks via clamp, never overflows under the version badge.
- Log out / fresh install with no stored creds → tracking screen never shows empty badge (login screen runs first; if `tracking.html` ever loads pre-auth, `userBadge` stays `.hidden`).

---

## 2026-04-21 — /sessions/end end_time uses evidence-of-life (BUG-06)

`POST /api/sessions/end` previously wrote `end_time = GREATEST(CURRENT_TIMESTAMP, start_time)`. Usually fine — `CURRENT_TIMESTAMP` is within seconds of the real session end when the desktop calls /end from an online, tracking state.

But when `powerMonitor.on('suspend')`'s 3 s endWorkSession call times out (common — the OS gives very little I/O budget before sleep) and we retry on wake via `pauseTrackingForLogout`, `CURRENT_TIMESTAMP` is now **wake time**. For a 16-hour overnight sleep, dashboard's "Logout" time would display 9 AM instead of 5 PM the previous evening. `duration_seconds` was correct (client-reported) but `end_time` inflated.

**Fix:** `/sessions/end` now uses the same evidence-of-life logic as the stale-close helpers:

```sql
end_time = GREATEST(
  LEAST(CURRENT_TIMESTAMP, COALESCE(GREATEST(
    MAX(activity_logs.timestamp), MAX(screenshots.captured_at), user_presence.last_heartbeat
  ), CURRENT_TIMESTAMP)),
  s.start_time
)
```

Any close path (normal, suspend-then-wake-retry, stale cleanup) now produces the same Logout display regardless of when the endpoint actually fires.

File: `admin-dashboard/api/routes/sessions.js` (`/sessions/end`).

**Validation:**
- Simulate: manually INSERT a session with start_time 24h ago, no heartbeat since, then POST /sessions/end → end_time should equal start_time (no evidence of life), NOT NOW.
- Real-world: put laptop to sleep during shift, wake 12+ hours later → Logout displays last evidence-of-life minute (within seconds of actual sleep time), not wake time.

---

## 2026-04-21 — Night-shift overtime window fix (follow-up to BUG-04)

The initial BUG-04 fix only handled non-night shifts correctly. For night shifts (start > end, e.g. 23:00-07:00) the code still computed `overtime_end = shift_end + 24h`, which overlaps the NEXT night shift (which runs 23:00 the same day as the current shift's end, through to 07:00 the following day). Same bleed as before — tomorrow night's regular activity could count as today's overtime evidence.

**Fix:** For night shifts, next-shift-start is on the **same calendar day as shift_end**, at `whStart`. So for 23:00-07:00 night shift on shiftDate=D:
- shift_end = (D+1) 07:00
- next_shift_start = (D+1) 23:00
- overtime window = [07:00, 23:00] on D+1 (16-hour gap)

**File:** `admin-dashboard/api/routes/reports.js` `/shift-attendance/overtime`.

**Validation (executed):** `node -e` math check confirmed the correct windows for 11-20, 23-07, 22:30-07:30, and the degenerate 09-09 case (falls back to +24h).

Version 1.1.6 → 1.1.7; installer rebuilt.

---

## 2026-04-21 — Classification + wake-handler fixes (BUG-04 / BUG-05)

### BUG-04 — In-shift session classified as Extra Hours (Aryav)

**Root cause:** `/shift-attendance/overtime` computed `overtime_end = shift_end + 24h`, which for non-night shifts **extends past the next shift start**. For Aryav (11:00-20:00), the overtime window for shiftDate=2026-04-20 ran [2026-04-20 20:00 IST, 2026-04-21 20:00 IST] — swallowing his entire next-day regular shift. On top of that, the `evidenceFirst/Last` queries included **screenshots without an `is_overtime` filter**, so today's regular-shift screenshots showed up as yesterday's overtime "Login: 12:39 PM" even though activity was correctly tagged `is_overtime=false`.

**Fix:** `admin-dashboard/api/routes/reports.js` `/shift-attendance/overtime`
- Overtime window `end` now caps at the next-day shift start (for non-night shifts), not +24h.
- Evidence-of-life screenshot subqueries now require a matching overtime=true activity row within ±2 minutes of the screenshot — so regular-shift screenshots that happen to fall inside the overtime window can't masquerade as overtime evidence.

### BUG-05 — Wake-handler bypasses working-hours policy (Harsh Pathak)

**Root cause:** `desktop-app/main.js` `powerMonitor.on('resume')`
1. When woken outside hours, called `startHeartbeat()` unconditionally — kept heartbeat flowing even on teams with `track_outside_hours=false`, keeping the user shown as "idle" on the dashboard instead of "logged_out" (the Neeraj-2pm regression).
2. When woken inside hours, directly set `screenshotInterval/activityInterval/heartbeatInterval` and called `startWorkSession()` with **no overtime flag**, bypassing `shouldTrackNow()`, `currentSessionIsOvertime`, and `CONFIG.TRACK_OUTSIDE_HOURS` — so a shift-end crossed during sleep produced a regular-tagged session in the overtime window.

**Fix:**
- Rewrote the resume handler to re-derive state from working-hours policy. Now calls `pauseTrackingForLogout()` (if previously tracking) then `startTrackingNow({ overtime })` with the correct flag, or stays fully paused (no heartbeat) when outside hours and overtime disabled.
- Added `if (!isTracking) return;` belt-and-suspenders gates at the top of `captureScreenshot`, `trackActivity`, `sendHeartbeat`. A leaked interval can no longer produce ghost rows / false-online status.

**Files:** `admin-dashboard/api/routes/reports.js` (overtime window + evidence queries); `desktop-app/main.js` (resume handler, 3 internal gates).

**Validation:**
- Regression SQL after deploy: `SELECT COUNT(*) FROM activity_logs WHERE user_id=<user> AND is_overtime=true AND timestamp > NOW() - INTERVAL '2h'` — should be zero inside the user's regular shift window.
- Put laptop to sleep 15 min before shift end, wake 15 min after shift end on a team with `track_outside_hours=false`. Dashboard status should flip to "Logged Out" within 90 s; no new session row should be created; screenshots should stop at shift end.
- Wake during shift with `track_outside_hours=true` on the far side of a boundary: new session should be tagged `overtime=true` / `overtime=false` consistently with the wake-time clock.
- View an attendance date with 24h+ idle before/after: Extra Hours block should NOT display `Login: 12:39 PM` ghosts from the next day's regular shift.

---

## 2026-04-21 — Three production bug fixes (BUG-2026-04-21-01/02/03)

Plan: `~/.claude/plans/i-need-you-to-recursive-snail.md`. Bug registry: `~/.claude/projects/.../memory/project_bug_registry.md`.

### BUG-01 — Negative session duration (Sanyam Ahuja: login 2:14 PM, logout 2:07 PM, duration -1h 8m)

**Root cause:** `closeStaleSessionsForUser` / `closeAllStaleSessions` in `admin-dashboard/api/routes/sessions.js` used `user_presence.last_heartbeat` as a fallback for `end_time` without flooring at `s.start_time`. A leftover heartbeat from a prior session (before sleep/suspend / switch-user) wrote an `end_time` earlier than the new session's `start_time`.

**Fix:** Wrap computed `end_time` with `GREATEST(end_val, s.start_time)` and `duration_seconds` with `GREATEST(..., 0)` in both helpers and in `/sessions/end`. Defense-in-depth in `reports.js` (`/shift-attendance` + `/shift-attendance/overtime`): floor each per-row `duration_seconds` at 0 so legacy negative rows can't corrupt dashboard display.

**Files:** `admin-dashboard/api/routes/sessions.js` (L11-26, L37-55, L122-155), `admin-dashboard/api/routes/reports.js` (shift + overtime per-session loops).

**One-time cleanup (run manually with user approval):**
```sql
SELECT id, start_time, end_time, duration_seconds FROM sessions WHERE end_time < start_time;
-- Review, then:
UPDATE sessions SET end_time = start_time, duration_seconds = 0 WHERE end_time < start_time;
```

### BUG-02 — Application = "Unknown" in activity logs despite active Chrome/VS Code

**Root cause:** `desktop-app/main.js` active-window PowerShell script reads `$proc.MainModule.FileVersionInfo` for a friendly display name. On sandboxed Chrome renderer / VS Code helper processes, this hangs past the 5-second Node `exec` timeout — losing the entire foreground window including the reliably-available ProcessName.

**Fix:**
- Added display-name hashtable in the PS script. Known hazardous processes (chrome, firefox, msedge, code, cursor, slack, teams, etc.) skip `MainModule` entirely and use the map.
- Raised Node exec timeout from 5 s to 8 s.
- On timeout, attempt to salvage partial JSON from stdout before surrendering to "Unknown".
- Explicit `[activeWin] PowerShell timeout after 8s` logging so silent fails are visible.

**Files:** `desktop-app/main.js` L1943-2005 (PS script), L2099-2165 (Node exec wrapper).

### BUG-03 — Extra Hours 0h 0m / status "Logged Out" post-shift (Himanshu Sharma, 1–7 PM shift)

**Likely root cause (H1):** team's `track_outside_hours` is `false`, so at 7 PM the desktop correctly calls `pauseTrackingForLogout()` and stops all tracking. Symptoms match expected behavior when the team feature is off.

**Diagnostic SQL** (run before concluding code fix needed):
```sql
-- Team setting
SELECT u.name, tms.working_hours_start, tms.working_hours_end, tms.track_outside_hours
FROM users u LEFT JOIN team_monitoring_settings tms ON tms.team_id = u.team_id
WHERE u.name ILIKE '%Himanshu%';

-- Column exists?
SELECT column_name FROM information_schema.columns
WHERE table_name = 'sessions' AND column_name = 'overtime';

-- Any overtime sessions or post-shift activity on the reported day?
SELECT id, start_time, end_time, is_active, overtime FROM sessions
WHERE user_id = (SELECT id FROM users WHERE name ILIKE '%Himanshu%')
  AND start_time >= '2026-04-20' ORDER BY start_time;
SELECT COUNT(*), SUM(CASE WHEN is_overtime THEN 1 ELSE 0 END) AS ot_count
FROM activity_logs WHERE user_id = (SELECT id FROM users WHERE name ILIKE '%Himanshu%')
  AND timestamp >= '2026-04-20 19:00' AND timestamp < '2026-04-21 00:00';
```

**Defensive code fix (always safe):** `transitionToOvertime` in `desktop-app/main.js` now sets `currentSessionIsOvertime = true` **before** awaiting `endWorkSession()`. Closes a ~1 s window where an in-flight heartbeat/reconciliation could observe the stale regular flag.

**Files:** `desktop-app/main.js` L1781-1792.

**If diagnostic shows H3 (migration not applied):** run `admin-dashboard/supabase/migrations/003_overtime_support.sql`.

**If diagnostic shows H1 (team setting off):** enable "Allow tracking outside working hours" in Teams settings for the team.

### Regression Checklist
- [ ] `SELECT COUNT(*) FROM sessions WHERE end_time < start_time;` = 0 after cleanup
- [ ] Sleep/wake mid-session: no negative-duration rows
- [ ] Switch-user (Windows): no negative-duration rows
- [ ] Chrome + VS Code + Firefox + Explorer all resolve to correct `application_name` for 30+ consecutive ticks
- [ ] `application_name='Unknown'` share < 1% in fresh activity (`SELECT application_name, COUNT(*) FROM activity_logs WHERE timestamp > NOW() - INTERVAL '1 hour' GROUP BY 1`)
- [ ] Shift-boundary crossover (run test team with shift ending in next 5 min): regular session closes at boundary, overtime session opens, no negative durations, both blocks render
- [ ] Bump `desktop-app/package.json` patch version before rebuild (per `feedback_version_bump.md`)

---

## 2026-04-18 — Overtime / Extra Hours mode + activity-based "Online" status

End-to-end implementation of the spec captured in `~/.claude/plans/make-the-changes-as-fluttering-sketch.md`. Solves two problems:

1. **Neeraj-2pm bug:** Users appeared "online" any time their laptop was on, regardless of working hours / actual activity. Cold-start outside hours was sending heartbeats forever (`main.js` old line 1700–1702).
2. **No overtime visibility:** Customers couldn't see post-shift work as a separate bucket — it either showed up as part of the regular shift or didn't show at all.

### Schema (migration `003_overtime_support.sql` — required)

- `sessions.overtime BOOLEAN DEFAULT FALSE` + composite index `(user_id, overtime, start_time DESC)`
- `team_monitoring_settings.track_outside_hours BOOLEAN DEFAULT FALSE` (per-team toggle)
- `user_presence.status` CHECK constraint dropped/recreated to include `'logged_out'`

`activity_logs.is_overtime` and `shift_date` already exist (no change).

### Backend (`admin-dashboard/api/`)

- **`sessions.js`**
  - `POST /api/sessions/start` accepts `overtime` boolean. Falls back gracefully (42703) if migration hasn't run.
  - `POST /api/sessions/end` accepts optional `sessionId` for targeted close (needed during regular→overtime transition where two active sessions briefly coexist).
- **`presence.js`**
  - `POST /heartbeat` validates status against `{online, idle, offline, logged_out}` whitelist; piggybacks `settings_version` (epoch ms of `team_monitoring_settings.updated_at`) and `track_outside_hours` on the response so the desktop can detect config changes without polling.
  - **`effective_status` rewritten** in `/online`, `/summary`, `/user/:id` (extracted to a single `EFFECTIVE_STATUS_SQL` constant): `logged_out` wins → stale heartbeat = `offline` → fresh heartbeat AND non-idle activity in last 90s = `online` → otherwise `idle`. Heartbeat alone no longer counts as online.
  - `/summary` counts use the same expression — counts and per-user statuses can never disagree.
- **`teams.js`** PUT `/teams/:id/settings` accepts and persists `track_outside_hours` (with 42703 fallback). GET uses `SELECT *` so the field is included automatically once the column exists.
- **`reports.js`**
  - Existing `/shift-attendance` now filters `s.overtime = false` and `a.is_overtime = false` so the regular row is never polluted by overtime data.
  - **New endpoint `GET /shift-attendance/overtime`** returns the same shape but for the post-shift window `[shift_end, min(shift_end + 24h, now())]`, filtered to `overtime=true` sessions and `is_overtime=true` activity.

### Desktop (`desktop-app/main.js`)

- New global `CONFIG.TRACK_OUTSIDE_HOURS`, `currentSessionIsOvertime`, `lastSettingsVersion`.
- **`fetchTeamSettings()`** now stores `track_outside_hours` and clears working hours when team unsets them.
- **`sendHeartbeat()`** captures `settings_version` from response; refetches `fetchTeamSettings()` only on version change → settings propagate within 30s without polling.
- **`startWorkSession({ overtime })` / `endWorkSession()`** thread the overtime flag and target a specific `sessionId` on close (prevents race during transition).
- **Four new transition handlers** in `checkWorkingHoursAndToggle()`:
  - `pauseTrackingForLogout()` — shift end with overtime disabled. Pushes `status=logged_out` heartbeat before stopping so dashboard flips immediately (no 90s wait).
  - `transitionToOvertime()` — shift end with overtime enabled. End regular → push logged_out → start overtime session. Intervals keep running.
  - `transitionToRegular()` — overtime running when next-day shift starts. End overtime → start regular.
  - Cold-start outside hours: if `track_outside_hours=true` → start overtime tracking; if false → idle (no heartbeat). **This fixes the Neeraj-2pm bug.**
- `powerMonitor.on('shutdown')` now sends `status=logged_out` (was `offline`) so dashboard can distinguish clean shutdown from network blip.
- `powerMonitor.on('suspend')` heartbeat status changed from `'away'` (which silently failed the pre-existing CHECK constraint) to `'offline'`.

### Frontend

- **New `src/utils/statusHelpers.js`** with `STATUS_COLORS`, `STATUS_LABELS`, `STATUS_CLASS_NAMES`, plus `getStatusLabel/Color/ClassName/Icon` helpers. Adds `logged_out` everywhere with slate color and "Logged Out" label.
- `Dashboard.js`, `Teams.js`, `LiveMonitor.js`, `UserActivity.js` switched to shared helpers (replaced four duplicated `switch` statements).
- `Teams.js` settings modal: new "Extra Hours Tracking" section with `track_outside_hours` checkbox + helper text.
- `AttendanceLogs.js`:
  - `fetchShiftAttendance()` now does `Promise.all([regular, overtime])` (overtime fetch fails-soft for pre-migration servers).
  - New "Extra Hours" stats card renders below the regular shift card when `overtimeData.summary.total_seconds > 0`.
  - `exportShiftCSV()` rewritten as **client-side builder** (per `feedback_csv_export.md`) — emits the user's requested split-row format ("Reports" header → Regular row, blank line, "Extra Hours" header → Overtime row).
- CSS: `.badge-logged-out` added to `Dashboard.css` + `UserActivity.css`. `.al-overtime-block` added to `AttendanceLogs.css` (warm tint, dashed top border). `.checkbox-label`, `.settings-help` added to `Teams.css`.

### Rollout order

1. Apply `migrations/003_overtime_support.sql` to Supabase.
2. Deploy backend (Vercel auto-deploys on push). Old desktops keep working — overtime defaults false; logged_out won't be sent yet.
3. Deploy frontend (same push). New status helper renders gracefully for old data.
4. **Bump `desktop-app/package.json` patch version** (per `feedback_version_bump.md`), `npm run build:desktop`, distribute installer.
5. Admins toggle `track_outside_hours=true` per team in the Teams settings modal.

### Backwards compatibility

- Old desktop ⇄ new server: continues sending `online`/`idle` only. Sessions default to `overtime=false`. Effective status now requires activity → previously-online-without-activity users will start showing as Idle (this is the intended behavior change).
- New desktop ⇄ old server (pre-migration): `logged_out` heartbeat triggers a CHECK constraint error 500. Heartbeat then silently fails — dashboard reverts to 90s staleness for logout detection. Acceptable graceful degradation. Mitigation: run migration first.

### Risks / follow-ups (logged in TODO.md)

- New `EXISTS` subquery on every `/presence/online` poll. Hits the existing `(user_id, timestamp DESC)` index. If `pg_stat_statements` flags it, denormalize `last_activity_at` onto `user_presence`.

---

## 2026-04-18 — Validation fixes: WH-on-wake, multi-monitor, screenshot offline queue

Three fixes from the end-to-end validation report. Server changes are backward-compatible (no required migration); desktop changes ship in next installer rebuild.

**Fix 1.4 — Working-hours check on resume from sleep** (`desktop-app/main.js` resume handler):
- After waking, if working hours are configured AND we're outside them, stay paused (heartbeat-only) instead of restarting all intervals. The `workingHoursCheckInterval` (which survives sleep) will resume tracking when hours next open.
- Also changed the post-wake `startWorkSession()` call from `await` to fire-and-forget (consistency with Phase 2's `startTrackingNow` fix).
- Closes: false activity logged for up to 60s when sleep crossed a WH boundary.

**Fix 4.5 — Multi-monitor capture** (`desktop-app/main.js` captureScreenshot, `screenshots.js` upload route):
- `captureScreenshot()` now iterates ALL displays (`screen.getAllDisplays()` + `desktopCapturer.getSources()`), uploading each in parallel with `displayId` and `displayLabel` fields. Single-display setups behave identically (still 1 upload per interval).
- Server `POST /api/screenshots/upload` accepts the new fields. Insert uses try/catch with `42703` (column-not-exists) fallback — backward compatible. Optional migration `migrations/002_screenshots_display.sql` adds the columns + composite index when you want them persisted.
- Closes: secondary monitors invisible to the dashboard.

**Fix 4.8 — Screenshot offline disk queue** (`desktop-app/main.js` new functions):
- `uploadScreenshot()` now queues to disk on network/5xx failures via `queueScreenshot(payload)`. Files written to `app.getPath('userData')/pending-screenshots/`.
- New `flushScreenshotQueue()` retries every 60s while tracking is active. Started via `startScreenshotQueueRetry()` in `startScreenshotCapture`, stopped via `stopScreenshotQueueRetry()` in `stopScreenshotCapture`.
- Caps: 200 files (~200 MB) and 24h max age. Oldest evicted on overflow. Corrupted JSON dropped on read.
- Auth failures (401) NOT queued — token-refresh path handles those. 4xx (non-401) NOT queued — server-rejected, queuing won't help.
- Closes: silent screenshot loss on wifi/network blip.

**Risk:** Low. Multi-monitor change affects single-display users only by adding two null fields to payload. Server falls back gracefully if columns missing. Disk queue is dormant until first upload failure — no behavior change in healthy state.

**Build & distribute:** `npm run build:desktop` → distribute `dist/Employee Monitor Setup 1.1.0.exe`. Optional: apply `migrations/002_screenshots_display.sql` against prod DB to persist `display_id` / `display_label`.

**Verification matrix:**
| Scenario | Before | After |
|---|---|---|
| Sleep 18:00 → wake 22:00 (WH 09-18) | Tracks for ~60s false activity | Stays paused, heartbeat only |
| Sleep 14:00 → wake 14:30 (WH 09-18) | Resumes tracking | Resumes tracking (unchanged) |
| Single monitor capture | 1 upload/interval | 1 upload/interval (unchanged) |
| Dual monitor capture | 1 upload (primary only) | 2 uploads (1 per display) |
| Network blip during upload | Screenshot dropped | Queued to disk, retried within 60s |
| 24h network outage | All screenshots dropped | Queued (oldest evicted past 200 files / 24h) |
| Auth (401) failure | Drops + triggers token refresh | Drops + triggers token refresh (unchanged) |

---

## 2026-04-18 — Phase 2: Desktop session-create reliability (requires installer rebuild)

**Problem:** DB diagnostic confirmed Sanyam's class of failure. Teams with `working_hours_start/end` configured (Sanyam: 11:00-20:00) take a different startup path than teams without (Gaurav: NULL): they boot in heartbeat-only mode and transition to active tracking when working hours open. That transition called `await startWorkSession()` BEFORE starting the screenshot/activity intervals — and `startWorkSession`'s axios call had **no timeout**. If the request hung, the await blocked forever, intervals never scheduled, desktop stuck in heartbeat-only for the whole day. Sanyam's DB row showed: 0 activity_logs today, 0 screenshots today, but fresh heartbeat with `idle_seconds=235`. Confirmed exactly.

**Fix (`desktop-app/main.js`):**

1. **`startWorkSession()` (lines ~2364)** — added 10s timeout per attempt + 3-attempt retry-with-backoff (0s/5s/15s, mirrors `endWorkSession` pattern). Auth failures (401/403) skip retries since the token-refresh layer handles them. Always resolves — never hangs.

2. **`startTrackingNow()` (lines ~1444)** — reordered so `startActivityTracking()`, `startHeartbeat()`, `captureScreenshot()`, and `setInterval(captureScreenshot, ...)` run BEFORE session creation. `startWorkSession()` is now fire-and-forget: tracking is never gated on session creation. Even if all 3 retries fail, screenshots and activity continue.

3. **Session reconciliation tick (new)** — every 5 min, if `isTracking && !currentSessionId && CONFIG.USER_TOKEN`, retry `startWorkSession()`. Heals mid-day failures without requiring app restart. Started by `startScreenshotCapture()`, stopped by `stopScreenshotCapture()`. Safe across pause/resume because pause sets `isTracking=false`.

**Risk:** Low for Gaurav-class users (no working hours) — only difference is the no-await on session start, which couldn't have hung anyway (no timeout was the issue). Medium-low for Sanyam-class users — the new path is what they need; intervals start unconditionally.

**No server changes.** The Vercel deploy from earlier today is sufficient — Phase 1 + 1.3 + night-shift fix already restore the dashboard. Phase 2 fixes the upstream so the dashboard sees real session rows again going forward.

**Build & distribute:**
1. `cd desktop-app && npm run build` — produces `dist/Employee Monitor Setup 1.0.0.exe`
2. Distribute the new installer to all employees
3. Each employee runs the installer (over the existing install)
4. After restart, Sanyam-class users will be tracking within seconds (intervals start before session create)
5. Verify on dashboard: Active Now should reflect real tracking, sessions table should populate

**Verification (post-rebuild on a test machine):**
- Set test team's working_hours to a window starting 2 minutes from now
- Start the desktop app NOW (outside working hours) → should be heartbeat-only ✓
- Wait 2 min → at the WH boundary, intervals start immediately (don't wait for session API roundtrip)
- Check DB for activity_logs/screenshots within seconds of WH start
- Even if session API is slow, activity flows; session row appears within ~30s (or in next 5-min reconciliation tick)

---

## 2026-04-18 — Fix: night-shift double-attribution in virtual sessions

**Problem:** After Phase 1.3, Neeraj (night shift 22:30-07:30) appeared in User Activity for Apr 18 with login 12:00 AM, no logout, status Active. His real session was Apr 17 22:47 → Apr 18 06:59 (correctly shown in Apr 17 Shift Attendance as Night Shift 8h 11m). Apr 18 should not show Neeraj at all until he starts his Apr 18 night shift at 22:30.

**Root cause (my bug from Phase 1.3):** the `has_session` CTE filtered sessions by `start_time IN window`. Neeraj's session started before Apr 18 00:00 IST (= Apr 17 18:30 UTC), so the CTE missed it → synthesis triggered → virtual row built from his overnight activity_logs that bled into Apr 18 morning.

**Fix:** `admin-dashboard/api/routes/sessions.js` — change `has_session` to use PostgreSQL `OVERLAPS` operator with `COALESCE(end_time, NOW())` so any session whose interval intersects the date window is recognized, not just sessions that started in it. Now Neeraj's spanning session is detected → synthesis skips him → no false Apr 18 row.

**Lesson noted:** for any cross-midnight workload (sessions, work attribution, attendance), `start_time-in-window` is wrong; need OVERLAPS or `shift_date` semantics. Already in CLAUDE.md as a general rule — I missed applying it during synthesis design. Will check explicitly for night-shift edge cases when adding date-range queries in future.

**Verification:** Apr 17 Neeraj — real session shown (unchanged). Apr 18 Neeraj — no row (fixed). Gaurav/Sourabh Apr 18 — virtual rows still appear (no overlapping session, synthesis correctly triggers).

---

## 2026-04-18 — User Activity tab: virtual sessions from evidence (Phase 1.3)

**Problem:** After Phase 1, Shift Attendance showed login/logout correctly but the User Activity tab still showed "0 sessions found" because it calls `GET /api/sessions` which queries the sessions table directly.

**Fix:** `admin-dashboard/api/routes/sessions.js` `/` endpoint (lines 212+): after the real session SELECT, run an evidence query for users in scope who have NO session row in the date window but DO have activity_logs/screenshots/heartbeat. Synthesize a virtual session row per such user with `id = "virtual-{userId}-{startDate}"`, `start_time = first evidence`, `end_time = last evidence` (null if live within 90s), `effective_status = active|idle|logged_out` based on liveness + presence status. Combined list sorted by `start_time DESC`. Skipped when `isActive` filter is set or no date range is given.

**Risk:** Low. Read-only addition, scoped by same role rules as the existing query (admin sees all or filtered by `userId`; everyone else sees only own).

**Verification post-deploy:** User Activity tab → 18-04-2026 → expect Gaurav, Sourabh visible as virtual sessions with login ≈ first activity time, status = Active if currently live.

**Not fixed by this change:** Sessions table still empty — Phase 2 (desktop) is what restores real session rows.

---

## 2026-04-18 — Attendance: evidence-based fallback when sessions row missing

**Problem:** Shift Attendance and User Activity tabs showed `--` / 0h 0m for users with valid activity_logs and screenshots on Apr 18 (e.g., Gaurav Rawat 8:14 AM onwards). Root cause: `/shift-attendance` derived `first_login`/`last_logout`/`total_seconds` exclusively from the `sessions` table. Active time looked correct because it came from `activity_logs`. Diagnostic showed the `sessions` table had **zero new rows for the entire org on Apr 18** — `startWorkSession()` failing silently across the fleet.

**Fix (Phase 1, server-only):**
- `admin-dashboard/api/routes/reports.js` `/shift-attendance` (~lines 590-665): always run a single evidence query (`LEAST/GREATEST` of `activity_logs.timestamp`, `screenshots.captured_at`, `user_presence.last_heartbeat`) within the shift window. Use it to populate `first_login` / `last_logout` / `effectiveEndTs` when sessions row is missing or open. When evidence is stale and no live session exists, surface evidence-last as `last_logout`.
- `admin-dashboard/api/routes/reports.js` `/shift-attendance/export` (~lines 787-855): replaced `if (sessionsResult.rows.length === 0) continue;` with a synthesized virtual session row built from the same evidence query. CSV now includes users with no session row.
- `CLAUDE.md`: one-line rule under "Time & Sessions" — attendance derives from evidence-of-life, not sessions alone.

**Risk:** Low. Pure read-side derivation change. No schema changes, no writes, no impact on screenshot/activity/heartbeat pipelines.

**Behavior matrix (verified intent):**
| Scenario | Before | After |
|---|---|---|
| Apr 17 Gaurav (sessions exist) | login from session | login from session (unchanged) |
| Apr 18 Gaurav (no session, activity exists) | login = `--`, total = 0 | login = first activity, total = wall-clock |
| Sanyam (no activity at all) | `--`/0 | `--`/0 (honest zero) |
| Currently-live user with closed session | uses session.end_time | unchanged |
| Open zombie session (heartbeat <5min, no activity) | capped at evidence | capped at evidence (unchanged) |
| Multiple sessions same day | first start / last end | unchanged |
| Night shift crossing midnight | uses shift_start/end_utc | unchanged |

**Deploy:** Vercel auto-deploys from `main` (root: `admin-dashboard`). Push when ready. No env var or DB changes.

**Verification post-deploy:**
1. Open Attendance & Logs → 18-04-2026 → select Gaurav → confirm login ≈ 8:14 AM, total ≈ wall-clock
2. Same for Sourabh
3. Click Export CSV → verify Gaurav and Sourabh appear
4. Re-check Apr 17 Gaurav (baseline) → unchanged
5. Re-check User Activity tab → still shows 0 sessions until Phase 2 is shipped (this fix doesn't restore the sessions table; that's upstream)

**Not fixed by this change** (see TODO.md):
- Sessions table still receives 0 new rows — needs desktop-app fix (timeout, retry, reorder of `startTrackingNow()`)
- Dashboard "Active" badge still misleading for heartbeat-only users
- Dashboard "Active Time" column still shows time-since-heartbeat instead of cumulative active time
