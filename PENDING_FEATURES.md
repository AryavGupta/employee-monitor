# Pending Features & Task Tracker

> **Note:** This file must be updated after every significant change. Check this file before starting work.

---

## Currently Pending

### Performance Improvements
- [ ] Implement frontend caching (SWR/React Query) for API responses
- [ ] Add pagination to activity logs list view
- [ ] Consider background aggregation for `productivity_metrics` table

### UI/UX Improvements
- [ ] Add loading skeletons instead of "Loading..." text
- [ ] Add real-time WebSocket updates for presence status

### Desktop App
- [x] Package for distribution (Windows installer) - COMPLETED
- [ ] Add auto-update functionality
- [ ] Add system tray tooltip with current status
- [ ] Package for Mac (DMG) and Linux

### Security Improvements (Medium Priority)
- [ ] Add rate limiting to auth endpoints (prevent brute force)
- [ ] Add rate limiting to screenshot upload (prevent DoS)
- [ ] Implement CSRF token protection
- [ ] Add security headers (CSP, X-Frame-Options, etc.) via helmet.js
- [ ] Add password complexity requirements at registration
- [ ] Implement Row-Level Security (RLS) in Supabase
- [ ] Use OS keychain for token storage in desktop app (electron-keytar)

### Future Roadmap
- [ ] Team comparison analytics (compare teams, not just users)
- [ ] Custom alert rules via UI
- [ ] Scheduled report generation and email delivery
- [ ] Break time tracking and reminders

---

## Known Issues

*No critical issues at this time.*

---

## Recently Completed

### Security Vulnerability Fixes (January 2026)
**Problem:**
Comprehensive security audit identified multiple critical vulnerabilities in the codebase.

**What was fixed:**

1. **JWT Secret Hardcoded Fallback** (`auth.js`)
   - Before: `JWT_SECRET || 'your-secret-key'` - auth bypass if env var missing
   - After: App exits with error if JWT_SECRET not set

2. **CORS Wildcard Vulnerability** (`api/index.js`)
   - Before: `origin: process.env.FRONTEND_URL || '*'` - any site could make authenticated requests
   - After: Explicit FRONTEND_URL required, supports comma-separated origins, warns if not set

3. **Electron Security** (`main.js`, `preload.js`, `*.html`)
   - Before: `nodeIntegration: true, contextIsolation: false` - XSS = full system compromise
   - After: `nodeIntegration: false, contextIsolation: true`, secure IPC via preload.js

4. **PowerShell Command Injection** (`main.js`)
   - Before: App names interpolated directly into PowerShell scripts
   - After: Whitelist of safe browser process names, no user input in shell commands

5. **Missing Authorization on Team Endpoints** (`teams.js`)
   - Before: Any authenticated user could view any team's settings/analytics
   - After: Role-based checks (admin sees all, manager sees own teams, employee sees own team)

6. **Missing Authorization on Alert Read** (`alerts.js`)
   - Before: Any user could mark any alert as read
   - After: Users can only mark their own alerts, admins can mark any

7. **Error Message Leakage** (`auth.js`)
   - Before: `'Setup failed: ' + error.message` - leaked system details
   - After: Generic error messages returned to clients

8. **Weak Admin Reset Key** (`auth.js`)
   - Before: Setup key was last 8 chars of DATABASE_URL (predictable)
   - After: Separate `ADMIN_SETUP_KEY` environment variable required

**New files created:**
- `desktop-app/preload.js` - Secure IPC bridge for Electron

**Files modified:**
- `admin-dashboard/api/routes/auth.js`
- `admin-dashboard/api/routes/teams.js`
- `admin-dashboard/api/routes/alerts.js`
- `admin-dashboard/api/index.js`
- `admin-dashboard/.gitignore`
- `admin-dashboard/.env.example`
- `desktop-app/main.js`
- `desktop-app/login.html`
- `desktop-app/tracking.html`
- `.env.example`

**New environment variables:**
- `ADMIN_SETUP_KEY` - Required for `/api/auth/reset-admin` endpoint (optional feature)

**Verification:**
1. Start app without JWT_SECRET - should exit with error
2. Test CORS from different origin - should be blocked unless in FRONTEND_URL
3. Desktop app should work with secure IPC (no `require('electron')` in renderer)
4. Non-admin users should get 403 on other teams' settings/analytics
5. Users should get 403 when marking other users' alerts as read

---

### Uptime Calculation Fix - Sleep/Wake Handling (January 2026)
**Problem:**
- User Activity page showed 67 hours uptime, Analytics showed 12 minutes
- Caused by User Activity using wall-clock time (`now - start_time`) for open sessions
- Desktop app had no sleep/wake handlers, inflating uptime during system sleep

**Root Cause:**
- User Activity: `end_time - start_time` or `now - start_time` for active sessions (wall-clock time)
- Analytics: `SUM(duration_seconds)` from activity_logs (actual tracked time)
- Different data sources = different values

**What changed:**
1. **Desktop App** (`main.js`):
   - Added `powerMonitor` event handlers: `suspend`, `resume`, `lock-screen`, `unlock-screen`
   - On suspend: pause all tracking intervals, flush pending activity, mark user as away
   - On resume: reset `lastActivityTime` to prevent counting sleep as uptime, log wake event
   - Added `isSuspended` and `suspendTime` state variables

2. **Sessions API** (`api/routes/sessions.js`):
   - Updated `/end` endpoint to accept `totalActiveTime` and `totalIdleTime` from desktop app
   - Uses actual tracked duration instead of wall-clock time when available
   - Backward compatible with legacy sessions (falls back to wall-clock time)

3. **User Activity Page** (`UserActivity.js`):
   - Now fetches activity summary alongside sessions (same data source as Analytics)
   - `getTotalUptime()` uses `activitySummary.totalSeconds` from activity_logs
   - For closed sessions, uses `duration_seconds` column (now contains actual tracked time)
   - For open sessions, shows "Active" instead of inflated wall-clock time

4. **Schema** (`supabase-schema.sql`):
   - Added `active_seconds`, `idle_seconds`, `notes` columns to sessions table

**Database migration (run on existing databases):**
```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS active_seconds INTEGER;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS idle_seconds INTEGER;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS notes TEXT;
```

**Files modified:**
- `desktop-app/main.js` - Power monitor handlers, sleep/wake tracking
- `admin-dashboard/src/components/UserActivity.js` - Activity-based uptime calculation
- `admin-dashboard/api/routes/sessions.js` - Accept tracked time from desktop app
- `admin-dashboard/supabase-schema.sql` - New session columns

**Verification:**
1. Start desktop app, log in
2. Put system to sleep for 5 minutes
3. Wake system
4. Uptime should NOT include sleep time
5. User Activity and Analytics should show matching values

---

### Desktop App Windows Distribution (January 2026)
**What changed:**
- App now works standalone without environment variables
- Embedded production API URL for plug-and-play distribution
- Added retry logic with exponential backoff for all API calls
- Fixed logout to properly flush pending activity data
- Increased PowerShell URL extraction timeout (3s → 5s)
- Created proper Windows icons (.ico format)
- Configured electron-builder for NSIS installer + portable exe

**Build outputs:**
- `Employee Monitor Setup 1.0.0.exe` - Windows installer (86 MB)
- `EmployeeMonitor-Portable-1.0.0.exe` - Portable version (86 MB)

**Files modified:**
- `desktop-app/main.js` - Embedded API URL, retry logic, improved error handling
- `desktop-app/assets/icon.ico` - Windows icon
- `desktop-app/assets/icon.png` - App icon
- `desktop-app/.env.example` - Environment template for development
- `package.json` - Updated electron-builder config, dependencies

**Build command:** `npm run build:desktop`

---

### Analytics Time Precision Fix (January 2026)
**What changed:**
- Active Time and Idle Time now show minute-level precision
- 2 minutes shows as "0h 2m" instead of "0h"
- Added `formatHoursWithMinutes()` helper function
- Updated stat cards and PDF report to use new formatting

**Files modified:**
- `admin-dashboard/src/components/Analytics.js`

---

### Analytics Page UI Remodel (January 2026)
**What changed:**
- Replaced emoji icons with clean SVG icons (productivity, active, idle, uptime, keyboard, mouse)
- Fixed button layout: consistent sizing, proper spacing, icons added to buttons
- Made layout fully responsive: buttons wrap to next line on small screens
- Removed horizontal scrolling with proper flex/grid wrapping
- Fixed daily breakdown time format to always show "Xh Xm" (e.g., 0h 2m, 1h 5m)
- Changed stat grid from 6 columns to 3 columns (2 rows of 3 cards)
- Added gradient backgrounds for icons and highlight card
- Added subtle shadows and hover lift effects on cards
- Modern SaaS-style design with rounded corners (16px) and proper spacing
- Refresh button now uses blue gradient, download buttons are dark
- Improved table styling with rounded header corners

**Files modified:**
- `src/components/Analytics.js` - SVG icon components, updated stat cards, buttons with icons, time formatting
- `src/components/Analytics.css` - Complete rewrite with modern SaaS styling, 3-column grid, responsive breakpoints

---

### Analytics Page Redesign (January 2026)
**What changed:**
- Removed unused sections (comparison chart, activity categories, top applications)
- Made analytics user-specific (must select employee first)
- Added Download PDF and Download CSV functionality
- Added daily breakdown table with keyboard/mouse metrics
- Cleaner, focused UI for real manager usage

**Files modified:**
- `src/components/Analytics.js` - Complete rewrite
- `src/components/Analytics.css` - New styles for user selection, downloads

---

### Activity Tracking Fix (January 2026)
**What changed:**
- Fixed Activity API to store all fields (keyboard_events, mouse_events, url, domain)
- Added keyboard tracking to desktop app (inferred from idle time changes)
- Improved mouse tracking accuracy

**Files modified:**
- `api/routes/activity.js` - Updated batch INSERT query
- `desktop-app/main.js` - Added `trackKeyboardActivity()` function

---

### Performance Optimization (January 2026)
**What changed:**
- Added database indexes for activity_logs and screenshots tables
- Optimized dashboard-summary API (combined 3 queries into 1 CTE)
- Added 30-second cache headers

**Database changes:**
```sql
CREATE INDEX idx_activity_logs_user_timestamp ON activity_logs(user_id, timestamp DESC);
CREATE INDEX idx_activity_logs_user_date ON activity_logs(user_id, DATE(timestamp));
CREATE INDEX idx_screenshots_user_captured_at ON screenshots(user_id, captured_at DESC);
```

---

### Screenshot Storage Optimization (January 2026)
**What changed:**
- Migrated to Supabase Storage (optional, with base64 fallback)
- Screenshots compressed to WebP (85% quality, ~100KB vs ~650KB)
- Thumbnails generated at 480px width (88% quality) for fast grid loading
- Download screenshot feature added

**Files modified:**
- `api/routes/screenshots.js` - Storage upload, thumbnail generation
- `src/components/Screenshots.js` - Download button, thumbnail/full image handling
- `src/components/Screenshots.css` - Download button styles

**Environment variables added:**
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_KEY` - Service role key for Storage access

---

### UserActivity Field Fix (January 2026)
**What changed:**
- Fixed field name mismatch (clock_in_time → start_time, clock_out_time → end_time)
- Fixed API call to use startDate/endDate instead of date

**Files modified:**
- `src/components/UserActivity.js`

---

### Screenshot Interval Filter (January 2026)
**What changed:**
- Backend now filters screenshots by minute intervals (e.g., 5-min shows only :00, :05, :10)

**Files modified:**
- `api/routes/screenshots.js` - Added interval filter to GET endpoint

---

## Completed Features Archive

### AI Screenshot Analysis with Gemini Vision
**Completed:** January 2026

- Database migration: `screenshot_analyses` table
- API: `api/routes/ai-analysis.js`, `api/services/geminiService.js`
- Frontend: `src/components/EmployeeSummary.js`
- Environment: `GEMINI_API_KEY`, `GEMINI_MODEL`
