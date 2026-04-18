# Dev Changes

Append-only log. Newest first.

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
