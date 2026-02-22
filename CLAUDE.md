# Employee Monitor

Employee monitoring system with real-time tracking, screenshots, and analytics.

---

## MANDATORY PROJECT WORKFLOW

> **Project Rule:** Any AI or developer working on this project MUST read this file (`CLAUDE.md`) before starting any work, and MUST update both `CLAUDE.md` and `TODO.md` after making any significant change. These files are mandatory and must always reflect the current state of the project.

### Workflow Steps:
1. **Read `CLAUDE.md` first** - Understand project context, architecture, and constraints
2. **Check `TODO.md`** - See what's incomplete, buggy, or planned
3. **Make changes** - Implement, fix, or refactor
4. **Update both files** - Document what changed, what's complete, what's pending
5. **Never skip this** - This ensures continuity and prevents context loss

### Documentation Files

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Project rules, architecture, conventions, and known issues |
| `TODO.md` | Planned features, bugs, and work continuity notes |

---

## Architecture

```
employee-monitor/
├── admin-dashboard/     # React frontend + Express API (Vercel)
│   ├── src/components/  # React UI components
│   ├── api/routes/      # Express API endpoints (Vercel serverless)
│   ├── api/services/    # Backend services (email, AI)
│   └── supabase-schema.sql
└── desktop-app/         # Electron app for Windows/Mac/Linux
    ├── main.js          # Main process - tracking, screenshots
    ├── preload.js       # Secure IPC bridge
    ├── login.html       # Login UI
    ├── tracking.html    # Tracking status UI
    └── settings.html    # Password change & settings UI
```

## Tech Stack

**Admin Dashboard:**
- React 18 (CRA) - Frontend
- Express.js - API routes (Vercel serverless functions)
- Recharts - Analytics charts
- date-fns - Date handling
- jspdf/papaparse - Report exports
- nodemailer - Email notifications (optional)

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

1. App starts → checks for stored credentials
2. If valid token exists → auto-login, skip to step 5
3. If no token → User logs in → JWT token stored (encrypted)
4. Fetches team settings (intervals, thresholds)
5. Starts tracking loop:
   - Screenshots at `screenshot_interval` (default 60s)
   - Activity tracking at `activity_interval` (default 10s)
   - Heartbeat every 30s for presence
6. Tracks: active app, window title, URL (browsers), idle time
7. Batches activity logs (6 entries) before sending
8. Runs in system tray when minimized
9. Auto-starts on boot (always enabled)
10. Quit requires admin credentials (stealth mode)

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

# Optional: Email (for sending user credentials on registration)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=noreply@yourcompany.com
APP_NAME=Employee Monitor
COMPANY_NAME=Your Company
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
- Email credentials to new employees (optional SMTP)
- Desktop app password change (Settings page)

---

## Key Files Reference

### Backend API (`admin-dashboard/api/routes/`)

| File | Purpose |
|------|---------|
| `auth.js` | Login, token validation, admin reset |
| `users.js` | User CRUD, profile updates, password changes |
| `activity.js` | Activity log upload (single + batch) |
| `sessions.js` | Work session clock in/out |
| `screenshots.js` | Screenshot upload + retrieval |
| `teams.js` | Team management, settings, members |
| `presence.js` | Heartbeat and online status |
| `reports.js` | Analytics queries, PDF/CSV exports |
| `alerts.js` | Alert rules and notifications |

### Frontend (`admin-dashboard/src/components/`)

| File | Purpose |
|------|---------|
| `Dashboard.js` | Main dashboard with overview stats |
| `Users.js` | User management table |
| `UserActivity.js` | Individual user activity details |
| `Analytics.js` | Charts and productivity metrics |
| `Teams.js` | Team configuration UI |
| `Screenshots.js` | Screenshot gallery view |
| `Reports.js` | Report generation and export |

### Desktop App (`desktop-app/`)

| File | Purpose |
|------|---------|
| `main.js` | Main process: tracking loops, screenshots, IPC handlers, power monitor, stealth mode |
| `preload.js` | Secure IPC bridge (contextIsolation) |
| `login.html` | Login UI |
| `tracking.html` | Tracking status display (simplified for stealth mode) |
| `settings.html` | Password change, app settings (disabled in stealth mode) |
| `admin-password.html` | Admin authentication dialog for quit (stealth mode) |

---

## Auth Architecture

### JWT-Based Authentication

1. **Login Flow**:
   - User submits email/password to `/api/auth/login`
   - Server validates credentials against `users` table (bcrypt hash)
   - On success, returns JWT containing `{ userId, email, role, teamId }`
   - Token signed with `JWT_SECRET` (required env var, no fallback)

2. **Token Storage**:
   - **Dashboard**: Stored in `localStorage` as `token`
   - **Desktop App**: Stored in Electron's `electron-store` (encrypted on disk)

3. **Route Protection**:
   - All protected routes use `authenticateToken` middleware (`api/middleware/auth.js`)
   - Middleware extracts token from `Authorization: Bearer <token>` header
   - Validates signature and expiration, attaches `req.user` with decoded payload
   - Returns 401 for missing/invalid token, 403 for insufficient role

4. **Role-Based Access**:
   - `admin`: Full access to all endpoints
   - `manager`: Access to own team's data only
   - `employee`: Access to own data only
   - Authorization checks in route handlers verify `req.user.role` and `req.user.teamId`

5. **Token Expiration**:
   - Default: 24 hours
   - Desktop app auto-refreshes on startup if token is near expiration

---

## Code Style & Conventions

### Data Handling
- **UTC internally**: All timestamps stored/processed in UTC; convert at UI edges only
- **Avoid `SELECT *`**: Always specify required columns; use pagination for list endpoints
- **Nullish coalescing**: Use `??` not `||` when `0` or `false` are valid values

### API Design
- **Add fields as optional first**: New fields should be optional initially, enforce later with migration
- **Handle errors explicitly**: Return clear status codes (400/401/403/404/500) with generic messages
- **Never log secrets**: No tokens, passwords, or API keys in logs

### Change Verification Checklist
Before finalizing any change, verify:
- [ ] Auth still works (login, token validation)
- [ ] Screenshot upload + fetch works
- [ ] Activity batch upload works
- [ ] Sessions clock in/out works
- [ ] Presence heartbeat updates online status
- [ ] Dashboard analytics render correctly
- [ ] No console errors in browser/Electron

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

* Keep `TODO.md` up to date:
  * When implementing a feature from the file, remove it once complete
  * When adding new planned features, document them in the file
  * Include: database migrations, file changes, env vars, verification checklist
* Check this file before starting work to understand what's pending

---

## Known AI Mistakes / Fixes

### IN PRODUCTION

*No active issues at this time.*

---

### RESOLVED HISTORICAL

*(Newest on top)*

* **Admin quit didn't actually quit — tray icon lingered** (February 2026): After admin authenticated to quit, `app.quit()` fired `close` on `mainWindow`, but the close handler always called `preventDefault()` when `tray` existed, preventing the app from exiting. The tray icon persisted as an orphan with stale tracking UI.
  * **Fix**: Added `isQuitting` flag set before `app.quit()`. Close handler skips `preventDefault()` when `isQuitting` is true. Tray is explicitly destroyed before quitting.
  * **Affected files**: `desktop-app/main.js` — close handler, admin-quit-auth handler
  * **Prevention**: Any code that calls `app.quit()` must account for close handlers that block window closing. Use a flag to signal intentional quit so close interceptors can stand down.

* **Close protection race condition on startup** (February 2026): During auto-login on boot, the app validates the stored token over the network (up to 8s). If the user clicked the tray icon during that window, the window appeared blank with `isTracking = false`, so clicking X closed the app without the admin credential prompt.
  * **Fix**: Changed close handler from `if (isTracking && tray)` to `if (tray)` — always redirect to hide as long as the tray exists (from the very first line of startup). On auto-login success, load `tracking.html` in background without showing the window (`mainWindow.loadFile` instead of `showWindowWithPage`). User only sees the app when they deliberately open it via tray, by which time tracking is active.
  * **Affected files**: `desktop-app/main.js` — close handler, `checkStoredCredentials`
  * **Prevention**: Close protection should never depend on `isTracking`. The tray existing is sufficient — if the tray is up, the app should never quit via the X button.

* **Auto-launch npm package doesn't prevent Task Manager disable** (February 2026): The `auto-launch` package only checks if the registry Run key exists, but when users disable an app in Task Manager → Startup Apps, Windows doesn't remove the Run key - it adds a "disabled" flag in `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run`. The package doesn't check or clear this flag.
  * **Fix**: Replaced `auto-launch` with direct `reg.exe` commands that both set the Run key AND delete the StartupApproved entry.
  * **Affected files**: `desktop-app/main.js`, `package.json` (removed auto-launch dependency)
  * **Prevention**: When implementing Windows auto-start features, always handle both the Run key and the StartupApproved key. Test by disabling in Task Manager, not just checking if the registry entry exists.

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

* **Delete modal not closing on error** (February 2026): When deleting a user failed, the confirmation modal stayed open and the error message appeared behind it, invisible to user. Fixed by closing modal and clearing state in the catch block.
  * **Affected files**: `admin-dashboard/src/components/Users.js`
  * **Prevention**: Always close modals/dialogs in both success AND error paths.

* **Gmail SMTP failing in Vercel serverless** (February 2026): Email worked locally but failed on Vercel. Root cause: transporter was cached globally (`let transporter = null`) which causes stale connections in serverless. Fixed by creating fresh transporter per request and using Gmail's `service: 'gmail'` shortcut with timeout settings.
  * **Affected files**: `admin-dashboard/api/services/emailService.js`
  * **Prevention**: Never cache connections/clients globally in serverless functions. Create fresh instances per request.

* **Audit log insert breaking user delete** (February 2026): Delete operation succeeded but returned error because audit log INSERT failed (possibly missing column in user's DB). Fixed by wrapping audit log in try-catch so it doesn't break the main operation.
  * **Affected files**: `admin-dashboard/api/routes/users.js`
  * **Prevention**: Non-critical operations (logging, analytics) should never break critical operations. Wrap in try-catch.

* **Error messages not visible when scrolled** (February 2026): Error/success alerts at top of page weren't visible if user had scrolled down. Fixed by implementing Toast notifications that appear at fixed bottom-right position regardless of scroll.
  * **Affected files**: `admin-dashboard/src/components/Toast.js` (new), `admin-dashboard/src/components/Toast.css` (new), `admin-dashboard/src/components/Users.js`
  * **Prevention**: Use fixed-position toast/snackbar components for feedback messages, not inline alerts.
