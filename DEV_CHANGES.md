# Dev Changes

Append-only log. Newest first.

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
