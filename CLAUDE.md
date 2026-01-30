# Employee Monitor

Employee monitoring system with real-time tracking, screenshots, and analytics.

---

## MANDATORY PROJECT WORKFLOW

> **Project Rule:** Any AI or developer working on this project MUST read this file (`CLAUDE.md`) before starting any work, and MUST update both `CLAUDE.md` and `PENDING_FEATURES.md` after making any significant change. These files are mandatory and must always reflect the current state of the project.

### Workflow Steps:
1. **Read `CLAUDE.md` first** - Understand project context, architecture, and constraints
2. **Check `PENDING_FEATURES.md`** - See what's incomplete, buggy, or planned
3. **Make changes** - Implement, fix, or refactor
4. **Update both files** - Document what changed, what's complete, what's pending
5. **Never skip this** - This ensures continuity and prevents context loss

---

## Architecture

```
employee-monitor/
├── admin-dashboard/     # React frontend + Express API (Vercel)
│   ├── src/components/  # React UI components
│   ├── api/routes/      # Express API endpoints (Vercel serverless)
│   └── supabase-schema.sql
└── desktop-app/         # Electron app for Windows/Mac/Linux
    ├── main.js          # Main process - tracking, screenshots
    ├── login.html       # Login UI
    └── tracking.html    # Tracking status UI
```

## Tech Stack

**Admin Dashboard:**
- React 18 (CRA) - Frontend
- Express.js - API routes (Vercel serverless functions)
- Recharts - Analytics charts
- date-fns - Date handling
- jspdf/papaparse - Report exports

**Desktop App:**
- Electron - Cross-platform desktop
- PowerShell/AppleScript - Active window detection
- desktopCapturer - Screenshot capture

**Infrastructure:**
- Vercel - Hosting & serverless API
- Supabase (PostgreSQL) - Database
- JWT - Authentication

## Database (Supabase)

Key tables:
- `users` - User accounts with team assignments
- `teams` - Team definitions with managers
- `team_monitoring_settings` - Per-team config (intervals, tracking options)
- `screenshots` - Screenshot metadata + URLs (Supabase Storage) or base64 fallback
- `activity_logs` - App usage, URLs, idle time, keyboard/mouse events
- `work_sessions` - Clock in/out tracking (start_time, end_time)
- `user_presence` - Real-time online status
- `productivity_metrics` - Daily aggregated stats
- `alerts` / `alert_rules` - Configurable notifications

**Key indexes (for performance):**
- `idx_activity_logs_user_timestamp` - (user_id, timestamp DESC)
- `idx_activity_logs_user_date` - (user_id, DATE(timestamp))
- `idx_screenshots_user_captured_at` - (user_id, captured_at DESC)
- `idx_screenshots_captured_date` - (DATE(captured_at))
- `idx_sessions_user_start` - (user_id, start_time DESC)

## API Routes

| Route | Purpose |
|-------|---------|
| `/api/auth/*` | Login, token validation |
| `/api/users/*` | User CRUD, profile |
| `/api/teams/*` | Teams, members, settings |
| `/api/screenshots/*` | Upload, fetch screenshots |
| `/api/activity/*` | Activity logs, batch upload |
| `/api/sessions/*` | Work session start/end |
| `/api/presence/*` | Heartbeat, online status |
| `/api/reports/*` | Analytics, exports |
| `/api/alerts/*` | Alert rules, notifications |

## Desktop App Flow

1. User logs in → JWT token stored
2. Fetches team settings (intervals, thresholds)
3. Starts tracking loop:
   - Screenshots at `screenshot_interval` (default 60s)
   - Activity tracking at `activity_interval` (default 10s)
   - Heartbeat every 30s for presence
4. Tracks: active app, window title, URL (browsers), idle time
5. Batches activity logs (6 entries) before sending
6. Runs in system tray when minimized

## Deployment

**Admin Dashboard:**
```bash
cd admin-dashboard
vercel --prod
```

**Desktop App:**
```bash
cd desktop-app
npm install
npm start          # Development
npm run build      # Package for distribution
```

## Environment Variables

**admin-dashboard/.env:**
```
# Required
DATABASE_URL=postgresql://...
JWT_SECRET=your-strong-random-secret-min-32-chars  # REQUIRED, no fallback
FRONTEND_URL=https://your-app.vercel.app           # REQUIRED for CORS (comma-separated for multiple origins)

# Optional: Supabase Storage (for optimized screenshot storage)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-key

# Optional: Admin reset functionality
ADMIN_SETUP_KEY=your-random-setup-key              # For /api/auth/reset-admin endpoint

# Optional: AI features
GEMINI_API_KEY=your-gemini-api-key
```

**Security Notes:**
- `JWT_SECRET` is **required** - the app will exit if not set (no insecure fallback)
- `FRONTEND_URL` must be explicitly set - wildcards (`*`) are not recommended
- Never commit `.env` files to git - use `.env.example` for templates
- See `.env.example` files for full documentation

## Key Features

- Real-time employee presence monitoring
- Periodic screenshot capture
- Application & URL tracking
- Idle time detection
- Team-based management
- Productivity analytics & reports
- Configurable monitoring settings per team
- Export reports (PDF/CSV)

---

## Claude Instructions (Project Rules)

### Response Style

* **Be token-efficient.** Keep answers tight, actionable, and avoid long explanations unless asked.
* Default output order:
  1. The exact change / code / command
  2. Any critical notes (edge cases, migrations, env vars)
  3. Quick verification steps

### Performance & Optimization (Non-negotiable)

* Optimize for **minimal load time + minimal API latency**.
* Prefer:
  * Pagination + selective fields (never `SELECT *` unless necessary)
  * Batched requests and debounced UI calls
  * Caching where safe (in-memory, SWR/React Query patterns, CDN where relevant)
  * Avoid heavy base64 payloads unless required; compress/resize screenshots before upload when possible
* Always consider:
  * DB indexes for frequent filters/sorts
  * Avoid N+1 queries
  * Background aggregation for analytics (`productivity_metrics`) instead of expensive live queries

### Safety: Don't Break Existing Functionality

* Any change must be **backward-safe**:
  * Maintain existing API shapes unless explicitly versioned
  * Avoid renaming fields without migration + compatibility layer
  * Add new fields as optional first, then enforce later
* Before finalizing a change, include a quick **regression checklist**:
  * Auth still works (JWT issuance + validation)
  * Screenshot upload + fetch works
  * Activity batch upload works
  * Sessions clock in/out works
  * Presence heartbeat updates online status
  * Dashboard analytics and reports still render/export

### Error Log (Keep Improving This File)

* Maintain a section at the bottom of this file called **"Known AI Mistakes / Fixes"**.
* If you (Claude) make an error (logic bug, wrong path, wrong command, broken API contract, perf regression), you must:
  1. Add a bullet entry describing the mistake
  2. Add the correct approach / fix
  3. Add a "how to prevent" note (test/checklist/guardrail)
* Do not repeat the same mistake: check this section before proposing changes.

### Code Change Discipline

* Make changes in **small, reviewable steps**.
* When modifying a module, ensure:
  * No dead code paths introduced
  * Errors are handled explicitly (clear status codes + messages in API)
  * Logging is useful but not noisy (avoid logging secrets/tokens)
* Prefer deterministic behavior:
  * Time handling in UTC internally; convert at UI edges
  * Stable sorting and consistent pagination

### Testing & Verification (Lightweight but Mandatory)

* Provide the fastest way to validate each change:
  * A minimal test case or manual steps
  * A sample request/response for any API changes
  * Any migration SQL if schema is touched
* If a change affects performance, include a quick "before/after" expectation:
  * payload size reduced, fewer queries, fewer renders, etc.

### Pending Features Tracking

* Keep `PENDING_FEATURES.md` up to date:
  * When implementing a feature from the file, remove it once complete
  * When adding new planned features, document them in the file
  * Include: database migrations, file changes, env vars, verification checklist
* Check this file before starting work to understand what's pending

---

## Known AI Mistakes / Fixes

*(Newest on top)*

* **Multiple critical security vulnerabilities identified and fixed** (January 2026): Security audit revealed several vulnerabilities that were fixed:
  1. **JWT secret had insecure fallback** - `process.env.JWT_SECRET || 'default'` allowed auth bypass if env var not set. Fixed: app now exits if JWT_SECRET missing.
  2. **CORS allowed wildcard with credentials** - `origin: '*'` allowed any site to make authenticated requests. Fixed: require explicit FRONTEND_URL, warn if not set.
  3. **Electron nodeIntegration enabled** - XSS could lead to full system compromise. Fixed: `nodeIntegration: false`, `contextIsolation: true`, added secure `preload.js`.
  4. **PowerShell command injection** - App names interpolated into PowerShell scripts without sanitization. Fixed: whitelist of known browser process names.
  5. **Missing authorization on team endpoints** - Any authenticated user could view any team's settings/analytics. Fixed: added role-based checks.
  6. **Missing authorization on alert read** - Any user could mark any alert as read. Fixed: ownership verification.
  7. **Error messages leaked system info** - Raw error messages exposed to clients. Fixed: generic messages returned.
  8. **Admin reset used weak key** - Setup key was last 8 chars of DATABASE_URL. Fixed: separate ADMIN_SETUP_KEY env var.
  * **Affected files**: `api/routes/auth.js`, `api/routes/teams.js`, `api/routes/alerts.js`, `api/index.js`, `desktop-app/main.js`, `desktop-app/preload.js`, `desktop-app/*.html`, `.gitignore`, `.env.example`
  * **Prevention**:
    - Never use hardcoded fallbacks for secrets
    - Always validate authorization, not just authentication
    - Use contextIsolation in Electron apps
    - Whitelist inputs before shell interpolation
    - Never expose raw error messages to clients

* **Uptime inflation during system sleep**: User Activity page showed 67 hours uptime while Analytics showed 12 minutes. Root cause: User Activity calculated uptime as `now - session.start_time` (wall-clock time) while Analytics summed `duration_seconds` from activity_logs (actual tracked time). Desktop app had no sleep/wake handlers, so sessions stayed "open" during sleep. Fixed by:
  1. Adding `powerMonitor` sleep/wake handlers to desktop app (suspend, resume, lock-screen, unlock-screen)
  2. Pausing tracking intervals during sleep and resetting `lastActivityTime` on wake
  3. Updating sessions API to store actual `duration_seconds` from desktop app instead of wall-clock time
  4. Updating User Activity page to use activity_logs summary for consistent uptime calculation
  * **Affected files**: `desktop-app/main.js`, `admin-dashboard/src/components/UserActivity.js`, `admin-dashboard/api/routes/sessions.js`, `admin-dashboard/supabase-schema.sql`
  * **Prevention**: Always use the same data source for the same metric across all pages. For time tracking, actual activity duration should be the source of truth, not wall-clock time. Handle system sleep/wake events in desktop apps.

* **Desktop app env validation broke standalone distribution**: Initially added strict API_URL validation that showed error dialog if env var was missing. This broke the packaged exe since .env files aren't bundled. Fixed by embedding the production API URL as default while still allowing env var override.
  * **Affected files**: `desktop-app/main.js`
  * **Prevention**: For distributable apps, always provide sensible defaults. Env vars should override, not be required.

* **NSIS installer requires .ico not .png**: Tried to use PNG icons for Windows NSIS installer which failed with "invalid icon file". NSIS requires ICO format.
  * **Affected files**: `package.json` (electron-builder config), `desktop-app/assets/icon.ico`
  * **Prevention**: Windows installers require .ico format. Use png-to-ico to convert.

* **Activity batch API not storing all fields**: The `/api/activity/log/batch` endpoint was ignoring `keyboardEvents`, `mouseEvents`, `mouseDistance`, `url`, and `domain` fields sent by the desktop app. Fixed by updating the INSERT query to include all fields.
  * **Affected files**: `api/routes/activity.js` batch endpoint
  * **Prevention**: When adding new fields to a data model, update ALL related API endpoints (single + batch)

* **Desktop app keyboard tracking non-existent**: The `keyboardEvents` counter was declared but never incremented - no keyboard listener existed. Fixed by inferring keyboard activity from system idle time changes (when idle time resets but mouse hasn't moved significantly).
  * **Affected files**: `desktop-app/main.js` - added `trackKeyboardActivity()` function
  * **Prevention**: When declaring tracking counters, immediately implement the tracking logic

* **Missing database indexes for activity queries**: Queries on `activity_logs` and `screenshots` were slow due to missing composite indexes. Added `idx_activity_logs_user_timestamp`, `idx_activity_logs_user_date`, `idx_screenshots_user_captured_at` for 5-10x query speedup.
  * **Prevention**: Always add indexes for frequently filtered/sorted columns, especially composite indexes for user_id + timestamp patterns

* **Falsy value bug in activity logging**: `durationSeconds || null` and `isIdle || false` would incorrectly convert `0` and `false` to `null`/default. Fixed by using nullish coalescing (`??`) instead of logical OR (`||`).
  * **Affected files**: `api/routes/activity.js` lines 19, 45
  * **Prevention**: Always use `??` for values where `0` or `false` are valid
