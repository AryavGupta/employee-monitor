# Employee Monitor

Employee monitoring system with real-time tracking, screenshots, and analytics.

---

## Mandatory Workflow

1. Read `CLAUDE.md` and `TODO.md` before starting.
2. Make minimal-scope changes.
3. Update `CLAUDE.md` (new rules/mistakes) and `TODO.md` (pending work) after changes.

---

## Architecture

```
employee-monitor/
├── admin-dashboard/     # React frontend + Express API (Vercel)
│   ├── src/components/  # React UI
│   ├── api/routes/      # Express endpoints (serverless)
│   ├── api/services/    # Email, AI
│   └── supabase-schema.sql
└── desktop-app/         # Electron (Win/Mac/Linux)
    ├── main.js          # Tracking, screenshots, IPC
    ├── preload.js       # Secure IPC bridge
    ├── login.html / tracking.html / settings.html
```

**Stack:** React 18 (CRA), Express, Recharts, Electron, Supabase (Postgres), JWT, Vercel.

## Database

Key tables: `users`, `teams`, `team_monitoring_settings`, `screenshots`, `activity_logs`, `work_sessions`, `user_presence`, `productivity_metrics`, `alerts`, `alert_rules`.

**Key indexes** (perf-critical):
- `activity_logs`: (user_id, timestamp DESC), (user_id, DATE(timestamp))
- `screenshots`: (user_id, captured_at DESC), (DATE(captured_at))
- `work_sessions`: (user_id, start_time DESC)

## API Routes

`/api/auth`, `/api/users`, `/api/teams`, `/api/screenshots`, `/api/activity`, `/api/sessions`, `/api/presence`, `/api/reports`, `/api/alerts`.

## Desktop App Flow

1. Checks stored credentials → auto-login if valid token.
2. Fetches team settings (intervals, thresholds).
3. Tracking loop: screenshots (default 60s), activity (10s), heartbeat (30s).
4. Tracks: active app, window title, URL (browsers), idle time, keyboard/mouse.
5. Batches activity logs (6 entries) before sending.
6. Runs in system tray; auto-starts on boot; quit requires admin creds (stealth).

## Deployment

**Dashboard (Vercel):** Auto-deploys from `main` branch (root: `admin-dashboard`). Manual: `cd admin-dashboard && vercel --prod --yes`. URL: https://admin-dashboard-vert-iota-16.vercel.app

**Desktop:** `cd desktop-app && npm run build` → installer in `dist/`.

## Environment Variables

**Required:** `DATABASE_URL`, `JWT_SECRET` (≥32 chars, no fallback — app exits if missing), `FRONTEND_URL` (explicit, no wildcards).

**Optional:** `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` (storage), `ADMIN_SETUP_KEY`, `GEMINI_API_KEY`, SMTP vars (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`).

Never commit `.env`. See `.env.example`.

---

## Auth Architecture

- JWT issued on `/api/auth/login` with `{ userId, email, role, teamId }`, signed via `JWT_SECRET`, 24h expiry.
- Dashboard stores token in `localStorage`; desktop in encrypted `electron-store`.
- `authenticateToken` middleware (`api/middleware/auth.js`) validates `Authorization: Bearer <token>`.
- Roles: `admin` (all), `manager` (own team), `employee` (self). Handlers check `req.user.role`/`teamId`.

---

## Code Conventions

- **UTC internally**, convert at UI edges only.
- **No `SELECT *`**; specify columns; paginate lists.
- **Use `??` not `||`** when `0`/`false` are valid values.
- **New fields optional first**, then enforce.
- **Never log secrets.** Generic error messages to clients.
- **Same data source for related metrics** (total/active/idle must all come from `activity_logs` or all from sessions — never mix).
- **Client-side CSV export** using same formatting as UI.

### Regression Checklist

Before finalizing: auth login/validate • screenshot upload+fetch • activity batch upload • session start/end • presence heartbeat • dashboard analytics • no console errors.

---

## Known AI Mistakes / Fixes

One-liners. Check before proposing changes — don't repeat.

### Time & Sessions
- **Never compute duration as `now − start_time`** without capping at last evidence-of-life (`GREATEST(last_heartbeat, MAX(activity.timestamp), MAX(screenshot.captured_at))`). Sleep/crash/lid-close breaks the assumption. See `reports.js /shift-attendance`.
- **Session lifecycle defense-in-depth:** desktop ends session on `powerMonitor.suspend` (awaited with 3s timeout); `GET /api/sessions/active` calls `closeAllStaleSessions` (5-min heartbeat gate) before returning; `/sessions/start` calls `closeStaleSessionsForUser` (unconditional).
- **`closeStaleSessionsForUser` closes unconditionally** — only use where creating a replacement. Use `closeAllStaleSessions` for read-time cleanup.
- **"Total Hours" in attendance = wall-clock (login→logout)**, not `SUM(activity.duration_seconds)`. Activity sums are for active/idle breakdown only.
- **Don't rely on `sessions.active_seconds`/`idle_seconds`** — populated only on explicit session-end. Query `activity_logs` within the session range instead.
- **Working hours = `total - idle`**, not `active - idle` (active already excludes idle).
- **Presence ≠ session state.** Determine "active now" by heartbeat staleness (90s), not `session.end_time IS NULL`. See `UserActivity.js` `effective_status` (active/idle/disconnected/logged_out).
- **Night-shift crossing midnight:** use `shift_date` (date shift started), not `DATE(timestamp)`.

### PowerShell from Node
- **Always pass `-NoProfile -NonInteractive`** — user `$PROFILE` contaminates stdout.
- **Set UTF-8 encoding** at top of script: `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`. Non-ASCII titles (Firefox em dash) break JSON.parse otherwise.
- **Errors to stderr** via `[Console]::Error.WriteLine`; stdout = structured payload only.
- **Inline `-Command` breaks `Add-Type` here-strings** — write `.ps1` temp file, use `-File`.
- **On parse failure, log raw stdout+stderr** before falling back. Silent fallback = debugging dead-end.
- **Whitelist process names** before shell interpolation (`SAFE_BROWSER_PROCESSES`) — injection risk.
- **Windows auto-start** needs both Run key AND deleting `StartupApproved\Run` entry (Task Manager disable flag). `auto-launch` npm pkg doesn't handle the latter — use `reg.exe` directly.

### Desktop App
- **Network errors ≠ credential rejection.** Only clear stored creds on 401/403. Retry with progressive backoff (0/10/20/30s) for network failures. Captive portals return HTTP 200 HTML — verify response is from our API (`typeof data === 'object' && 'success' in data`).
- **Working hours must be enforced, not just tagged.** `shouldTrackNow()` + `checkWorkingHoursAndToggle()` pauses tracking outside hours (heartbeat stays for presence).
- **Sleep/wake handlers required** (`powerMonitor` suspend/resume/lock/unlock). Pause intervals on sleep, reset `lastActivityTime` on wake.
- **Activity batch uploads** need same config as screenshot upload: 30s timeout, `maxContentLength: Infinity`, validate `response.data.success`, only re-queue on 5xx/network (not 400).
- **Batch INSERT must handle missing columns** (42703) — fall back to core columns if enhanced columns don't exist.
- **Length-guard varchar inserts at the boundary.** Desktop app sends unbounded `url`/`application_name`/`window_title`/`domain` — long URLs (query strings, tokens, SPA routes) easily exceed varchar limits, causing Postgres 22001 and rejecting the entire batch. Truncate in `activity.js` before insert; one oversized row should never poison the batch.
- **`app.quit()` + tray:** set `isQuitting` flag so close handler skips `preventDefault()`; explicitly destroy tray.
- **Close protection:** redirect to hide whenever `tray` exists, never gate on `isTracking` (startup race).

### Electron Security
- **`nodeIntegration: false`, `contextIsolation: true`**, use `preload.js` for IPC.
- **Distributable apps need embedded defaults** (API URL) — `.env` isn't bundled.

### API & Backend
- **JWT_SECRET has no fallback** — app exits if unset.
- **CORS:** require explicit `FRONTEND_URL`, no wildcards with credentials.
- **Authorization ≠ authentication.** Every team/alert endpoint checks ownership, not just token.
- **Non-critical ops (audit log) in try-catch** so they don't break critical ops.
- **NSIS installer** requires `.ico`, not `.png`. Use `png-to-ico`.
- **Non-sargable predicates kill indexes.** `EXTRACT(MINUTE FROM col) % N = 0` or any function on an indexed column forces a seq scan. Do row-thinning client-side or use bucket math on the raw epoch in a CTE.
- **Don't return duplicate image payloads in list endpoints.** `screenshots.js` used to SELECT both `thumbnail_url` and `screenshot_url as full_url`; fetch full URL lazily via `GET /:id` when the modal opens.

### Frontend
- **Close modals in catch blocks**, not just success path.
- **Toast/fixed-position feedback**, not inline alerts (invisible when scrolled).
- **Export CSV client-side** using same `format()` + helper functions as the UI table. Server-side formatting uses UTC → mismatches local TZ display.
- **Reuse UI helpers (`getActivityDetail`) in exports** — don't re-derive.
- **No `// eslint-disable-next-line react-hooks/exhaustive-deps`** — that rule isn't in CRA's default config; referencing it makes the build fail. Just omit the comment or use a bare `// eslint-disable-next-line`.
- **Use `useMemo` for derived display state** (e.g. client-side interval thinning) instead of refetching on filter change.

### Serverless
- **Never cache connections globally** (nodemailer transporter) — stale in serverless. Create fresh per request.
