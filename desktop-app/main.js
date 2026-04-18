const { app, BrowserWindow, screen, desktopCapturer, ipcMain, powerMonitor, Tray, Menu, dialog, nativeImage } = require('electron');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const { exec, execSync, spawn } = require('child_process');

// Load environment variables from .env file if exists
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (e) {
  // dotenv not available in packaged app, use defaults
}

// Persistent credential storage with encryption
const Store = require('electron-store');
const store = new Store({
  encryptionKey: 'employee-monitor-v1',
  schema: {
    credentials: {
      type: 'object',
      properties: {
        token: { type: 'string' },
        userId: { type: 'string' },
        userData: { type: 'object' },
        email: { type: 'string' },
        password: { type: 'string' }
      }
    }
  }
});

// Default production API URL - embedded for standalone operation
const DEFAULT_API_URL = 'https://admin-dashboard-vert-iota-16.vercel.app';

// Configuration
const CONFIG = {
  API_URL: process.env.API_URL || DEFAULT_API_URL,
  SCREENSHOT_INTERVAL: 60000, // 1 minute in milliseconds
  ACTIVITY_INTERVAL: 10000, // 10 seconds for activity tracking
  HEARTBEAT_INTERVAL: 30000, // 30 seconds for presence heartbeat
  IDLE_THRESHOLD: 300, // 5 minutes in seconds
  USER_TOKEN: null,
  USER_ID: null,
  USER_DATA: null,
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000, // Base delay in ms, will be exponentially increased
  WORKING_DAYS: [1, 2, 3, 4, 5], // Default Mon-Fri, overridden by team settings
  WORKING_HOURS_START: null,
  WORKING_HOURS_END: null,
  // Per-team toggle (synced via team settings). When true and the user is outside
  // the configured shift window, the desktop continues full tracking (screenshots,
  // activity, heartbeat) but tags the session as overtime=true. When false, tracking
  // pauses and presence flips to logged_out at shift end.
  TRACK_OUTSIDE_HOURS: false
};

// Token refresh state
let isRefreshingToken = false;
let refreshTokenPromise = null;
let consecutiveAuthFailures = 0;
let tokenRefreshTimer = null;

// Refresh the auth token — tries /refresh endpoint first, then re-login with stored credentials
async function refreshToken() {
  // Prevent concurrent refresh attempts
  if (isRefreshingToken) return refreshTokenPromise;
  isRefreshingToken = true;

  refreshTokenPromise = (async () => {
    try {
      // Attempt 1: Use /refresh endpoint with current token
      if (CONFIG.USER_TOKEN) {
        try {
          const response = await axios.post(
            `${CONFIG.API_URL}/api/auth/refresh`,
            {},
            {
              headers: { 'Authorization': `Bearer ${CONFIG.USER_TOKEN}` },
              timeout: 10000
            }
          );
          if (response.data.success && response.data.token) {
            CONFIG.USER_TOKEN = response.data.token;
            const creds = store.get('credentials');
            if (creds) {
              creds.token = response.data.token;
              store.set('credentials', creds);
            }
            consecutiveAuthFailures = 0;
            scheduleTokenRefresh(response.data.token);
            console.log('Token refreshed successfully via /refresh endpoint');
            return true;
          }
        } catch (refreshErr) {
          console.log(`Token refresh endpoint failed: ${refreshErr.response?.status || refreshErr.message}`);
        }
      }

      // Attempt 2: Re-login with stored email/password
      const creds = store.get('credentials');
      if (creds?.email && creds?.password) {
        try {
          const response = await axios.post(
            `${CONFIG.API_URL}/api/auth/login`,
            { email: creds.email, password: creds.password },
            { timeout: 10000 }
          );
          if (response.data.success && response.data.token) {
            CONFIG.USER_TOKEN = response.data.token;
            CONFIG.USER_ID = response.data.userId;
            CONFIG.USER_DATA = response.data.user;
            store.set('credentials', {
              ...creds,
              token: response.data.token,
              userId: response.data.userId,
              userData: response.data.user
            });
            consecutiveAuthFailures = 0;
            scheduleTokenRefresh(response.data.token);
            console.log('Token refreshed successfully via re-login');
            return true;
          }
        } catch (loginErr) {
          console.error(`Re-login failed: ${loginErr.response?.status || loginErr.message}`);
        }
      }

      console.error('All token refresh attempts failed');
      return false;
    } finally {
      isRefreshingToken = false;
      refreshTokenPromise = null;
    }
  })();

  return refreshTokenPromise;
}

// Schedule proactive token refresh 5 minutes before expiry
function scheduleTokenRefresh(token) {
  if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer);
  try {
    // Decode JWT payload (base64) to read exp claim
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    if (payload.exp) {
      const msUntilExpiry = (payload.exp * 1000) - Date.now();
      const refreshIn = msUntilExpiry - (5 * 60 * 1000); // 5 minutes before expiry
      if (refreshIn > 0) {
        tokenRefreshTimer = setTimeout(async () => {
          console.log('Proactive token refresh triggered (5 min before expiry)');
          await refreshToken();
        }, refreshIn);
        console.log(`Token refresh scheduled in ${Math.round(refreshIn / 60000)} minutes`);
      } else {
        // Token expires in less than 5 minutes — refresh now
        refreshToken();
      }
    }
  } catch (e) {
    console.warn('Could not schedule token refresh:', e.message);
  }
}

// Handle auth failure during tracking — trigger re-auth, pause if exhausted
async function handleTrackingAuthFailure(context) {
  consecutiveAuthFailures++;
  console.warn(`Auth failure #${consecutiveAuthFailures} on ${context}`);

  if (consecutiveAuthFailures >= 3) {
    console.error('Too many consecutive auth failures — pausing tracking, showing login');
    consecutiveAuthFailures = 0;
    store.delete('credentials');
    if (isTracking) {
      stopScreenshotCapture();
      stopActivityTracking();
      stopHeartbeat();
      isTracking = false;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      showWindowWithPage(path.join(__dirname, 'login.html'));
    }
    return false;
  }

  const refreshed = await refreshToken();
  if (refreshed) {
    console.log(`Re-auth succeeded after ${context} failure, resuming`);
    return true; // caller should retry
  }
  return false;
}

// Retry wrapper for API calls with exponential backoff
async function apiCallWithRetry(apiCall, maxRetries = CONFIG.MAX_RETRIES) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await apiCall();
      consecutiveAuthFailures = 0; // Reset on any successful call
      return result;
    } catch (error) {
      lastError = error;

      const status = error.response?.status;

      // On 401 (expired token): try to refresh and retry once
      if (status === 401 && attempt === 1) {
        const refreshed = await refreshToken();
        if (refreshed) {
          console.log('Token refreshed after 401, retrying API call');
          continue; // Retry with new token
        }
      }

      // Don't retry on auth errors (401, 403) or client errors (400)
      if (status === 400 || status === 401 || status === 403) {
        throw error;
      }

      if (attempt < maxRetries) {
        const delay = CONFIG.RETRY_DELAY * Math.pow(2, attempt - 1); // Exponential backoff
        console.log(`API call failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

let mainWindow;
let tray = null;
let adminQuitWindow = null;
let screenshotInterval;
let activityInterval;
let heartbeatInterval;
let isTracking = false;
let isQuitting = false;
let currentSessionId = null;
// Tracks the overtime flag of the in-flight session so transitions know when to
// open/close at the shift boundary. Reset to false on session-end.
let currentSessionIsOvertime = false;
// Last settings_version returned by the heartbeat. When the server reports a newer
// version we re-fetch /api/teams/:id/settings; in steady state this adds zero calls.
let lastSettingsVersion = null;
let lastActivityTime = Date.now();
let activityBuffer = [];
let totalActiveSeconds = 0;
let totalIdleSeconds = 0;
let isCurrentlyIdle = false;

// Team settings cache
let teamSettings = null;

// Keyboard/mouse tracking
let keyboardEvents = 0;
let mouseEvents = 0;
let lastMousePosition = { x: 0, y: 0 };
let lastIdleTime = 0;
let activitySampleCount = 0;

// Real keyboard monitoring (Windows low-level hook)
let keyboardMonitorProcess = null;
let pendingKeystrokes = 0;
let pendingMaxRepeat = 0;

// Tracking script paths (written to temp on startup to avoid PowerShell escaping issues)
let activeWindowScriptPath = null;
let browserUrlScriptPath = null;

// Sleep/wake tracking - prevents uptime inflation during system sleep
let isSuspended = false;
let suspendTime = null;

// Get icon path, return undefined if not exists
function getIconPath(filename) {
  const iconPath = path.join(__dirname, 'assets', filename);
  if (fs.existsSync(iconPath)) {
    return iconPath;
  }
  // Fallback to root desktop-app folder
  const fallbackPath = path.join(__dirname, filename);
  if (fs.existsSync(fallbackPath)) {
    return fallbackPath;
  }
  return undefined;
}

// Create the main application window
function createWindow() {
  const iconPath = getIconPath('icon.png');

  mainWindow = new BrowserWindow({
    width: 400,
    height: 650,
    show: false, // Don't show until ready
    backgroundColor: '#667eea', // Match the gradient background
    webPreferences: {
      nodeIntegration: false,      // SECURITY: Disabled to prevent XSS → RCE
      contextIsolation: true,      // SECURITY: Isolate renderer from Node.js
      preload: path.join(__dirname, 'preload.js')  // Secure IPC bridge
    },
    ...(iconPath && { icon: iconPath })
  });

  // Don't load login.html yet — checkStoredCredentials() decides what to show
  // Window stays hidden (show: false) until auth state is resolved

  // Always minimize to tray instead of closing - protects against close during startup
  // and while tracking. The only way to quit is via admin credentials (tray menu).
  mainWindow.on('close', (event) => {
    if (tray && !isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopScreenshotCapture();
  });
}

// Create system tray
function createTray() {
  if (tray) return;

  // Try to find tray icon, create a default one if not found
  let trayIcon;
  const iconPath = getIconPath('tray-icon.png') || getIconPath('icon.png');

  if (iconPath) {
    try {
      trayIcon = nativeImage.createFromPath(iconPath);
      // Resize for tray (16x16 on Windows)
      if (process.platform === 'win32') {
        trayIcon = trayIcon.resize({ width: 16, height: 16 });
      }
    } catch (e) {
      console.log('Could not load tray icon:', e.message);
    }
  }

  // Create a default icon if none available
  if (!trayIcon || trayIcon.isEmpty()) {
    // Create a simple 16x16 colored square as fallback
    trayIcon = nativeImage.createEmpty();
  }

  try {
    tray = new Tray(trayIcon);
  } catch (e) {
    console.log('Could not create tray:', e.message);
    return;
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show App',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: 'Tracking Status',
      enabled: false,
      label: isTracking ? 'Status: Tracking Active' : 'Status: Not Tracking'
    },
    { type: 'separator' },
    {
      label: 'Quit (Admin Only)',
      click: () => {
        showAdminQuitDialog();
      }
    }
  ]);

  tray.setToolTip(isTracking ? 'Employee Monitor - Tracking Active' : 'Employee Monitor - Starting...');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Update tray menu
function updateTrayMenu() {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show App',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: isTracking ? 'Status: Tracking Active' : 'Status: Not Tracking',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Quit (Admin Only)',
      click: () => {
        showAdminQuitDialog();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip(isTracking ? 'Employee Monitor - Tracking Active' : 'Employee Monitor');
}

// Single-instance lock — second launch (e.g. user double-clicking the start
// menu shortcut while the app is already running in the tray) MUST NOT spawn
// a new window. Without this, every launch creates a fresh BrowserWindow that
// shows briefly with the bare purple background before its page loads, looks
// broken, and burns RAM. We register early so the second instance can quit
// before doing any setup.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Hide the default Electron menu bar (File / Edit / View / Window / Help).
// Stealth tracker UI shouldn't expose dev menus to end users.
Menu.setApplicationMenu(null);

// Initialize app
app.on('ready', async () => {
  console.log('Starting Employee Monitor...');
  console.log('API URL:', CONFIG.API_URL);
  console.log('Platform:', os.platform());

  // Linux: Check X11 and required dependencies before anything else
  if (os.platform() === 'linux') {
    const sessionType = process.env.XDG_SESSION_TYPE || '';
    if (sessionType === 'wayland') {
      dialog.showErrorBox('Unsupported Display Server',
        'Employee Monitor requires X11. You are running Wayland.\n\n' +
        'To switch: Log out → click the gear icon on the login screen → select "Ubuntu on Xorg" → log in.');
      app.quit();
      return;
    }

    // Check required dependencies
    const missingDeps = [];
    try { execSync('which xdotool', { stdio: 'ignore' }); } catch (e) { missingDeps.push('xdotool'); }
    try { execSync('which xinput', { stdio: 'ignore' }); } catch (e) { missingDeps.push('xinput'); }

    if (missingDeps.length > 0) {
      dialog.showErrorBox('Missing Dependencies',
        `The following packages are required:\n  ${missingDeps.join(', ')}\n\nInstall with:\n  sudo apt install ${missingDeps.join(' ')}`);
      app.quit();
      return;
    }
  }

  // Initialize PowerShell tracking scripts (must be before any tracking starts)
  initTrackingScripts();

  createWindow();

  // Create tray immediately so user sees the app launched
  createTray();

  // Setup auto-launch - always enabled for stealth mode
  setupAutoLaunch();

  // Setup sleep/wake handlers to prevent uptime inflation
  setupPowerMonitorHandlers();

  // Delay startup to allow network initialization (firewall/VPN login on office networks)
  // Without this, the app launches before the user has authenticated with the firewall
  const BOOT_DELAY_MS = 30000; // 30 seconds
  const credentials = store.get('credentials');
  if (credentials && credentials.token) {
    console.log(`Waiting ${BOOT_DELAY_MS / 1000}s for network initialization (firewall/VPN)...`);
    await new Promise(resolve => setTimeout(resolve, BOOT_DELAY_MS));
  }

  // Resolve auth state, then show the correct page
  await checkStoredCredentials();
});

// Show the window after loading a page (waits for page to render)
function showWindowWithPage(pagePath) {
  if (!mainWindow) return;
  mainWindow.loadFile(pagePath);
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
}

// Check stored credentials and auto-login if valid
// Window stays hidden until this function decides what to show
// Uses progressive retry for networks that aren't ready at boot (firewall, VPN)
async function checkStoredCredentials() {
  const credentials = store.get('credentials');

  if (!credentials || !credentials.token) {
    console.log('No stored credentials found, showing login');
    showWindowWithPage(path.join(__dirname, 'login.html'));
    return;
  }

  console.log('Found stored credentials, validating token...');

  // Progressive retry: fast on good networks, patient on slow boot / firewall
  // Attempt 1: immediate (5s), Attempt 2: wait 10s (8s), Attempt 3: wait 20s (8s), Attempt 4: wait 30s (8s)
  const retrySchedule = [
    { delay: 0, timeout: 5000 },
    { delay: 10000, timeout: 8000 },
    { delay: 20000, timeout: 8000 },
    { delay: 30000, timeout: 8000 }
  ];

  for (let i = 0; i < retrySchedule.length; i++) {
    const { delay, timeout } = retrySchedule[i];

    if (delay > 0) {
      console.log(`Network not ready, retrying in ${delay / 1000}s... (attempt ${i + 1}/${retrySchedule.length})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    try {
      const response = await axios.get(`${CONFIG.API_URL}/api/auth/verify`, {
        headers: { Authorization: `Bearer ${credentials.token}` },
        timeout
      });

      // Detect captive portal / firewall login pages returning HTML instead of JSON
      // These return HTTP 200 but with HTML content, not our API's JSON
      const isApiResponse = response.data && typeof response.data === 'object' && 'success' in response.data;

      if (!isApiResponse) {
        // Response is not from our API (likely a captive portal / firewall page)
        console.log(`Attempt ${i + 1}: Got non-API response (captive portal?), treating as network error`);
        continue; // Retry — user may need to complete firewall login first
      }

      if (response.data.success) {
        console.log('Token valid, auto-logging in...');
        CONFIG.USER_TOKEN = credentials.token;
        CONFIG.USER_ID = credentials.userId;
        CONFIG.USER_DATA = credentials.userData;

        // Schedule proactive token refresh
        scheduleTokenRefresh(credentials.token);

        await fetchTeamSettings();
        startScreenshotCapture();

        // Load tracking page in background - window stays hidden (stealth startup).
        mainWindow.loadFile(path.join(__dirname, 'tracking.html'));
        return;
      } else {
        // Server explicitly rejected the token — clear and show login
        console.log('Token invalid (server rejected), clearing credentials');
        store.delete('credentials');
        showWindowWithPage(path.join(__dirname, 'login.html'));
        return;
      }
    } catch (error) {
      const status = error.response?.status;

      if (status === 401) {
        // Token expired — try to refresh before giving up
        console.log('Token expired on startup, attempting refresh...');
        const refreshed = await refreshToken();
        if (refreshed) {
          console.log('Token refreshed on startup, auto-logging in...');
          scheduleTokenRefresh(CONFIG.USER_TOKEN);
          await fetchTeamSettings();
          startScreenshotCapture();
          mainWindow.loadFile(path.join(__dirname, 'tracking.html'));
          return;
        }
        // Refresh failed — clear and show login
        console.log('Token refresh failed on startup, showing login');
        store.delete('credentials');
        showWindowWithPage(path.join(__dirname, 'login.html'));
        return;
      }

      if (status === 403) {
        // True authorization failure — clear and show login
        console.log('Token rejected with 403, clearing credentials');
        store.delete('credentials');
        showWindowWithPage(path.join(__dirname, 'login.html'));
        return;
      }

      // Network error (timeout, ECONNREFUSED, ENOTFOUND) — retry, never clear credentials
      console.log(`Auth attempt ${i + 1}/${retrySchedule.length} failed: ${error.code || error.message}`);
    }
  }

  // All retries exhausted — start with stored credentials (offline-first)
  // Tracking starts immediately; next heartbeat/API call will naturally validate
  console.log('Network unavailable after retries. Starting with stored credentials (offline mode).');
  CONFIG.USER_TOKEN = credentials.token;
  CONFIG.USER_ID = credentials.userId;
  CONFIG.USER_DATA = credentials.userData;

  // Schedule token refresh — will fire when network comes back within expiry window
  scheduleTokenRefresh(credentials.token);

  startScreenshotCapture();
  mainWindow.loadFile(path.join(__dirname, 'tracking.html'));
}

// =====================================================
// Power Monitor Handlers (Sleep/Wake Detection)
// Prevents uptime from being inflated during system sleep
// =====================================================

function setupPowerMonitorHandlers() {
  // System is about to sleep/suspend
  powerMonitor.on('suspend', async () => {
    console.log('System suspending - pausing tracking');
    isSuspended = true;
    suspendTime = Date.now();

    // Pause all tracking intervals to prevent queued callbacks
    if (screenshotInterval) {
      clearInterval(screenshotInterval);
      screenshotInterval = null;
    }
    if (activityInterval) {
      clearInterval(activityInterval);
      activityInterval = null;
    }
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    // Flush pending activity and explicitly end the session. Best-effort: the OS
    // may cut us off mid-request. Without this, the server has no way to know
    // the session is over until the 5-min heartbeat staleness gate trips.
    try {
      await Promise.race([
        sendActivityBatch(),
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);
    } catch (err) {
      console.log('Could not flush activity before sleep:', err.message);
    }

    if (CONFIG.USER_TOKEN && currentSessionId) {
      try {
        await Promise.race([
          endWorkSession(),
          new Promise(resolve => setTimeout(resolve, 3000))
        ]);
      } catch (err) {
        console.log('Could not end session on suspend:', err.message);
      }
    }

    // Notify server that user is going offline due to sleep
    if (CONFIG.USER_TOKEN) {
      axios.post(
        `${CONFIG.API_URL}/api/presence/heartbeat`,
        // 'away' was never in the presence CHECK constraint (online/idle/offline only)
        // and silently failed at the DB layer. Use 'offline' — session has already
        // been ended by the suspend handler, so this is just a status nudge.
        { status: 'offline', reason: 'system_sleep' },
        { headers: { Authorization: `Bearer ${CONFIG.USER_TOKEN}` }, timeout: 3000 }
      ).catch(() => {}); // Ignore errors, system is sleeping
    }
  });

  // System resumed from sleep/suspend
  powerMonitor.on('resume', async () => {
    const sleepDuration = suspendTime ? Math.round((Date.now() - suspendTime) / 1000) : 0;
    console.log(`System resumed - was asleep for ${sleepDuration} seconds`);

    isSuspended = false;
    suspendTime = null;

    // Reset the lastActivityTime to NOW to prevent counting sleep time as activity
    lastActivityTime = Date.now();

    // Reset idle tracking state since idle time resets after wake
    lastIdleTime = 0;

    // Resume tracking if we were tracking before sleep
    if (isTracking && CONFIG.USER_TOKEN) {
      // Working-hours boundary may have crossed during sleep. If we slept inside
      // hours and woke outside, do NOT restart tracking intervals — only
      // heartbeat, so presence shows online but no false activity is logged.
      // The workingHoursCheckInterval (still running, not cleared on suspend)
      // will resume tracking when hours next open.
      if (CONFIG.WORKING_HOURS_START && CONFIG.WORKING_HOURS_END && !shouldTrackNow()) {
        console.log('Woke outside working hours — staying paused, heartbeat-only');
        isTracking = false;
        startHeartbeat();
        sendHeartbeat();
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('system-wake', { sleepDuration });
        }
        return;
      }

      console.log('Resuming tracking after wake...');

      // Always start a fresh session on wake. The suspend handler attempted to
      // end the previous one, and /sessions/start closes any leftover active
      // row for this user before creating the new one (closeStaleSessionsForUser).
      // This guarantees the 11:41-AM-yesterday-to-now-morning inflation can't
      // happen even if suspend/end failed to reach the server.
      try {
        currentSessionId = null;
        totalActiveSeconds = 0;
        totalIdleSeconds = 0;
        // Fire-and-forget per Phase 2 — don't await, intervals must start
        // regardless of session-create success.
        startWorkSession().catch(err => console.error('startWorkSession after wake threw:', err?.message));
      } catch (e) {
        console.error('Failed to start new session after wake:', e.message);
      }

      // Restart intervals — MUST always run regardless of session check above
      screenshotInterval = setInterval(captureScreenshot, CONFIG.SCREENSHOT_INTERVAL);
      activityInterval = setInterval(trackActivity, CONFIG.ACTIVITY_INTERVAL);
      heartbeatInterval = setInterval(sendHeartbeat, CONFIG.HEARTBEAT_INTERVAL);

      // Restart keyboard monitor (may have died during sleep)
      try { startKeyboardMonitor(); } catch (e) { /* non-critical */ }

      // Send immediate heartbeat to mark user as online again
      sendHeartbeat();

      // Log a wake event in activity
      activityBuffer.push({
        activityType: 'system_wake',
        applicationName: 'System',
        windowTitle: 'Resumed from sleep',
        isIdle: false,
        durationSeconds: 0, // Don't count sleep time
        keyboardEvents: 0,
        mouseEvents: 0,
        mouseDistance: 0,
        metadata: {
          sleepDurationSeconds: sleepDuration,
          timestamp: new Date().toISOString()
        }
      });
    }

    // Update UI
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('system-wake', { sleepDuration });
    }
  });

  // Screen locked - treat as idle/away
  powerMonitor.on('lock-screen', () => {
    console.log('Screen locked - marking as idle');
    isCurrentlyIdle = true;

    if (CONFIG.USER_TOKEN) {
      axios.post(
        `${CONFIG.API_URL}/api/presence/heartbeat`,
        { status: 'idle', reason: 'screen_locked' },
        { headers: { Authorization: `Bearer ${CONFIG.USER_TOKEN}` }, timeout: 3000 }
      ).catch(() => {});
    }
  });

  // Screen unlocked - user is back
  powerMonitor.on('unlock-screen', () => {
    console.log('Screen unlocked - user returned');
    isCurrentlyIdle = false;

    // Reset activity time to prevent counting locked period as activity gap
    lastActivityTime = Date.now();

    if (CONFIG.USER_TOKEN) {
      sendHeartbeat();
    }
  });

  // System shutdown - end session before OS kills the app
  powerMonitor.on('shutdown', () => {
    console.log('System shutting down - ending session');

    if (CONFIG.USER_TOKEN && currentSessionId) {
      // Fire and forget with short timeout - OS gives very limited time
      axios.post(
        `${CONFIG.API_URL}/api/sessions/end`,
        {
          totalActiveTime: totalActiveSeconds,
          totalIdleTime: totalIdleSeconds,
          notes: `Session ended by system shutdown. Active: ${Math.round(totalActiveSeconds / 60)}min, Idle: ${Math.round(totalIdleSeconds / 60)}min`
        },
        {
          headers: { 'Authorization': `Bearer ${CONFIG.USER_TOKEN}`, 'Content-Type': 'application/json' },
          timeout: 3000
        }
      ).catch(() => {});

      // Use 'logged_out' (not 'offline') so the dashboard distinguishes a clean
      // shutdown from a network blip. The status is now a first-class enum value
      // (migration 003); old servers will normalize unknown values to 'online' so
      // a graceful fallback path exists.
      axios.post(
        `${CONFIG.API_URL}/api/presence/heartbeat`,
        { status: 'logged_out', reason: 'system_shutdown' },
        { headers: { Authorization: `Bearer ${CONFIG.USER_TOKEN}` }, timeout: 3000 }
      ).catch(() => {});
    }
  });

  console.log('Power monitor handlers registered');
}

// Synchronous session end for ungraceful exits (shutdown, SIGTERM, Task Manager)
// Uses Node's http module directly to avoid async issues during process exit
function sendSessionEndSync() {
  if (!CONFIG.USER_TOKEN || !currentSessionId) return;
  try {
    const url = new URL(`${CONFIG.API_URL}/api/sessions/end`);
    const data = JSON.stringify({
      totalActiveTime: totalActiveSeconds,
      totalIdleTime: totalIdleSeconds,
      notes: `Session ended by process exit`
    });
    const http = require(url.protocol === 'https:' ? 'https' : 'http');
    const req = http.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.USER_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 3000
    });
    req.write(data);
    req.end();
  } catch (e) {
    // Best effort — process is dying
  }
}

// Handle SIGTERM (Task Manager on some systems, service stop)
process.on('SIGTERM', () => {
  console.log('SIGTERM received - ending session');
  sendSessionEndSync();
});

// Handle SIGINT (Ctrl+C in terminal)
process.on('SIGINT', () => {
  console.log('SIGINT received - ending session');
  sendSessionEndSync();
  process.exit(0);
});

// Last resort: process exit handler (runs for ANY exit)
process.on('exit', () => {
  sendSessionEndSync();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Don't quit if tracking is active and tray exists
    if (!isTracking) {
      app.quit();
    }
  }
});

app.on('before-quit', async () => {
  if (CONFIG.USER_TOKEN && isTracking) {
    try {
      await sendActivityBatch();
      await endWorkSession();
    } catch (e) {
      console.log('Cleanup on quit failed:', e.message);
    }
  }
  stopKeyboardMonitor();
  cleanupTrackingScripts();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// Setup auto-launch on system boot using Electron's native API
function setupAutoLaunch() {
  // setLoginItemSettings only works on Windows/macOS; Linux uses .desktop file
  if (os.platform() !== 'linux') {
    try {
      app.setLoginItemSettings({
        openAtLogin: true,
        name: 'EmployeeMonitor'
      });
      console.log('Auto-launch enabled via setLoginItemSettings');
    } catch (error) {
      console.log('Error setting auto-launch:', error.message);
    }
  }

  // Linux: create .desktop file in autostart
  if (os.platform() === 'linux') {
    try {
      const autostartDir = path.join(os.homedir(), '.config', 'autostart');
      const desktopFile = path.join(autostartDir, 'employee-monitor.desktop');
      if (!fs.existsSync(desktopFile)) {
        if (!fs.existsSync(autostartDir)) fs.mkdirSync(autostartDir, { recursive: true });
        fs.writeFileSync(desktopFile,
          `[Desktop Entry]\nType=Application\nName=Employee Monitor\nExec=${process.execPath}\nHidden=false\nNoDisplay=false\nX-GNOME-Autostart-enabled=true\nComment=Employee monitoring system\n`
        );
        console.log('Linux autostart .desktop file created');
      }
    } catch (e) {
      console.error('Failed to create Linux autostart entry:', e.message);
    }
  }
}

// IPC Handlers
ipcMain.on('login', async (event, credentials) => {
  try {
    const response = await axios.post(`${CONFIG.API_URL}/api/auth/login`, credentials);

    if (response.data.success) {
      CONFIG.USER_TOKEN = response.data.token;
      CONFIG.USER_ID = response.data.userId;
      CONFIG.USER_DATA = response.data.user;

      // Store credentials for persistent login (include email/password for silent re-auth)
      store.set('credentials', {
        token: response.data.token,
        userId: response.data.userId,
        userData: response.data.user,
        email: credentials.email,
        password: credentials.password
      });

      // Schedule proactive token refresh before expiry
      scheduleTokenRefresh(response.data.token);

      event.reply('login-response', { success: true, user: response.data.user });

      // Fetch team settings
      await fetchTeamSettings();

      // Ensure tray exists (no-op if already created), then start monitoring
      createTray();
      startScreenshotCapture();
    } else {
      event.reply('login-response', { success: false, message: response.data.message });
    }
  } catch (error) {
    event.reply('login-response', {
      success: false,
      message: error.response?.data?.message || 'Login failed'
    });
  }
});

ipcMain.on('logout', async (event) => {
  // Logout is disabled in stealth mode - employees cannot logout
  console.log('Logout attempted but disabled in stealth mode');
});

ipcMain.on('get-tracking-status', (event) => {
  event.reply('tracking-status', {
    isTracking,
    userId: CONFIG.USER_ID,
    teamSettings: teamSettings
  });
});

// App version (shown in top-right badge of every HTML screen)
ipcMain.handle('get-app-version', () => app.getVersion());

// Change password handler
ipcMain.on('change-password', async (event, { currentPassword, newPassword }) => {
  try {
    const response = await axios.post(
      `${CONFIG.API_URL}/api/auth/change-password`,
      { currentPassword, newPassword },
      {
        headers: { Authorization: `Bearer ${CONFIG.USER_TOKEN}` },
        timeout: 10000
      }
    );

    if (response.data.success) {
      event.reply('change-password-response', { success: true, message: 'Password changed successfully' });
    } else {
      event.reply('change-password-response', { success: false, message: response.data.message || 'Failed to change password' });
    }
  } catch (error) {
    const message = error.response?.data?.message || 'Failed to change password. Please try again.';
    event.reply('change-password-response', { success: false, message });
  }
});

// Open settings page - disabled in stealth mode
ipcMain.on('open-settings', (event) => {
  // Settings access is disabled in stealth mode
  console.log('Settings access attempted but disabled in stealth mode');
});

// Navigate to different pages
ipcMain.on('navigate-to', (event, page) => {
  if (!mainWindow) return;

  switch (page) {
    case 'tracking':
      mainWindow.loadFile(path.join(__dirname, 'tracking.html'));
      break;
    case 'login':
      mainWindow.loadFile(path.join(__dirname, 'login.html'));
      break;
    case 'settings':
      mainWindow.loadFile(path.join(__dirname, 'settings.html'));
      break;
    default:
      console.log('Unknown page:', page);
  }
});

// =====================================================
// Admin Quit Dialog (Stealth Mode)
// =====================================================

function showAdminQuitDialog() {
  // Don't open multiple dialogs
  if (adminQuitWindow) {
    adminQuitWindow.focus();
    return;
  }

  const iconPath = getIconPath('icon.png');

  adminQuitWindow = new BrowserWindow({
    width: 450,
    height: 480,
    parent: mainWindow,
    modal: true,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#667eea',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    ...(iconPath && { icon: iconPath })
  });

  adminQuitWindow.loadFile(path.join(__dirname, 'admin-password.html'));

  adminQuitWindow.once('ready-to-show', () => {
    adminQuitWindow.show();
  });

  adminQuitWindow.on('closed', () => {
    adminQuitWindow = null;
  });
}

// Admin quit authentication handler
ipcMain.on('admin-quit-auth', async (event, { email, password }) => {
  try {
    // Validate credentials against server
    const response = await axios.post(`${CONFIG.API_URL}/api/auth/login`, {
      email,
      password
    }, { timeout: 10000 });

    if (response.data.success) {
      // Check if user has admin role
      const user = response.data.user;
      if (user.role === 'admin') {
        console.log('Admin authenticated, quitting application...');
        event.reply('admin-quit-response', { success: true });

        // Clear stored credentials
        store.delete('credentials');

        // Stop tracking and quit
        await stopScreenshotCapture();
        isQuitting = true;

        // Destroy tray so it doesn't linger
        if (tray) {
          tray.destroy();
          tray = null;
        }

        // Close the dialog first
        if (adminQuitWindow) {
          adminQuitWindow.close();
        }

        // Quit the app
        app.quit();
      } else {
        event.reply('admin-quit-response', {
          success: false,
          message: 'Only administrators can quit this application'
        });
      }
    } else {
      event.reply('admin-quit-response', {
        success: false,
        message: response.data.message || 'Authentication failed'
      });
    }
  } catch (error) {
    event.reply('admin-quit-response', {
      success: false,
      message: error.response?.data?.message || 'Authentication failed'
    });
  }
});

// Admin quit cancel handler
ipcMain.on('admin-quit-cancel', () => {
  if (adminQuitWindow) {
    adminQuitWindow.close();
  }
});

// =====================================================
// Team Settings
// =====================================================

async function fetchTeamSettings() {
  try {
    const headers = { Authorization: `Bearer ${CONFIG.USER_TOKEN}` };

    // Fetch user's team settings
    const userResponse = await axios.get(`${CONFIG.API_URL}/api/users/me`, { headers });

    if (userResponse.data.success && userResponse.data.data.team_id) {
      const teamId = userResponse.data.data.team_id;

      // Fetch team settings
      try {
        const settingsResponse = await axios.get(`${CONFIG.API_URL}/api/teams/${teamId}/settings`, { headers });
        if (settingsResponse.data.success) {
          teamSettings = settingsResponse.data.data;

          // Update intervals based on team settings
          if (teamSettings.screenshot_interval) {
            CONFIG.SCREENSHOT_INTERVAL = teamSettings.screenshot_interval * 1000;
          }
          if (teamSettings.activity_interval) {
            CONFIG.ACTIVITY_INTERVAL = teamSettings.activity_interval * 1000;
          }
          if (teamSettings.idle_threshold) {
            CONFIG.IDLE_THRESHOLD = teamSettings.idle_threshold;
          }

          // Store working hours for overtime detection
          if (teamSettings.working_hours_start != null && teamSettings.working_hours_end != null) {
            CONFIG.WORKING_HOURS_START = teamSettings.working_hours_start; // e.g., '22:30:00' or '22:30'
            CONFIG.WORKING_HOURS_END = teamSettings.working_hours_end;
            CONFIG.WORKING_DAYS = teamSettings.working_days || [1, 2, 3, 4, 5];
            console.log(`Working hours: ${CONFIG.WORKING_HOURS_START} - ${CONFIG.WORKING_HOURS_END}, days: ${CONFIG.WORKING_DAYS}`);
          } else {
            // Settings exist but hours cleared — treat as "no working hours configured"
            CONFIG.WORKING_HOURS_START = null;
            CONFIG.WORKING_HOURS_END = null;
          }

          // Per-team toggle for Extra Hours mode (added in migration 003).
          // Defaults to false on older servers that don't return the field.
          CONFIG.TRACK_OUTSIDE_HOURS = teamSettings.track_outside_hours === true;
          console.log(`Extra hours tracking: ${CONFIG.TRACK_OUTSIDE_HOURS ? 'ON' : 'OFF'}`);
        }
      } catch (e) {
        console.log('Could not fetch team settings:', e.message);
      }
    }
  } catch (error) {
    console.error('Error fetching team settings:', error.message);
  }
}

// Check if current time is within configured working hours
// Returns { isOvertime: boolean, shiftDate: string (YYYY-MM-DD) }
function getWorkingHoursStatus() {
  if (!CONFIG.WORKING_HOURS_START || !CONFIG.WORKING_HOURS_END) {
    // No working hours configured — never overtime
    const today = new Date();
    return { isOvertime: false, shiftDate: today.toISOString().split('T')[0] };
  }

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  // Parse time strings (handle both 'HH:MM' and 'HH:MM:SS')
  const [startH, startM] = CONFIG.WORKING_HOURS_START.split(':').map(Number);
  const [endH, endM] = CONFIG.WORKING_HOURS_END.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  const todayStr = now.toISOString().split('T')[0];
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  // Hours-only enforcement: tracking runs every day of the week within the
  // configured window. We deliberately do NOT consult working_days here —
  // off-days vary across teams and change over time, so baking them into the
  // desktop client created surprise pauses (Sanyam's team had working_days
  // [Mon-Fri] and stopped tracking on Saturday despite his shift being 11-20).
  // The server still stores working_days for reporting; client just ignores it.
  let isWithinHours = false;
  let shiftDate = todayStr;

  if (startMinutes <= endMinutes) {
    // Normal shift (e.g., 09:00 - 17:00)
    isWithinHours = currentMinutes >= startMinutes && currentMinutes < endMinutes;
    shiftDate = todayStr;
  } else {
    // Night shift (e.g., 22:30 - 07:30) — crosses midnight
    if (currentMinutes >= startMinutes) {
      // After start time, same calendar day (e.g., 23:00 when shift starts 22:30)
      isWithinHours = true;
      shiftDate = todayStr; // Shift started today
    } else if (currentMinutes < endMinutes) {
      // Before end time, shift started yesterday (e.g., 03:00 when shift ends 07:30)
      isWithinHours = true;
      shiftDate = yesterdayStr; // Shift started yesterday
    } else {
      // Between end and start (e.g., 14:00 when shift is 22:30-07:30) — outside hours
      isWithinHours = false;
      shiftDate = todayStr;
    }
  }

  return { isOvertime: !isWithinHours, shiftDate };
}

// Extract domain from URL
function extractDomain(url) {
  if (!url) return null;
  try {
    // Handle URLs without protocol
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    const urlObj = new URL(url);
    return urlObj.hostname.toLowerCase().replace(/^www\./, '');
  } catch (e) {
    return null;
  }
}

// =====================================================
// URL Extraction from Browser Windows
// =====================================================

// Extract URL from browser window title or using platform-specific methods
// Linux-specific URL extraction using xdotool + xprop
async function getLinuxBrowserUrl(appName) {
  return new Promise((resolve) => {
    exec('xdotool getactivewindow', { timeout: 3000 }, (err, wid) => {
      if (err || !wid.trim()) return resolve(null);
      const windowId = wid.trim();

      exec(`xprop -id ${parseInt(windowId)} _NET_WM_NAME`, { timeout: 3000 }, (err2, stdout) => {
        if (err2) return resolve(null);
        const match = stdout.match(/= "(.*)"/);
        if (!match) return resolve(null);
        const fullTitle = match[1];

        // Parse URL from title if present
        const urlMatch = fullTitle.match(/https?:\/\/[^\s]+/);
        if (urlMatch) return resolve(urlMatch[0]);

        resolve(null);
      });
    });
  });
}

async function extractBrowserUrl(appName, windowTitle, hwnd, processName = null) {
  // Match against BOTH the friendly display name ("Mozilla Firefox") and the
  // raw process name ("firefox"). This way a future browser with a weird display
  // name but a known exe still routes to URL extraction.
  const browserPatterns = ['chrome', 'firefox', 'edge', 'msedge', 'brave', 'opera', 'safari', 'vivaldi'];
  const haystack = `${appName || ''} ${processName || ''}`.toLowerCase();

  const isBrowser = browserPatterns.some(b => haystack.includes(b));
  if (!isBrowser) return null;

  let url = null;

  // Platform-specific URL extraction.
  // Pass the raw process name when available because the downstream PowerShell
  // script takes -ProcessName and queries Get-Process -Name on it.
  if (os.platform() === 'win32') {
    url = await getWindowsEdgeChromeUrl(processName || appName, hwnd);
  } else if (os.platform() === 'linux') {
    url = await getLinuxBrowserUrl(processName || appName);
  }

  // Fallback: try to parse URL from window title if it contains one
  if (!url && windowTitle) {
    const urlMatch = windowTitle.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      url = urlMatch[0];
    }
  }

  return url;
}

// SECURITY: Whitelist of safe browser process names to prevent command injection
const SAFE_BROWSER_PROCESSES = {
  'chrome': 'chrome',
  'google chrome': 'chrome',
  'msedge': 'msedge',
  'edge': 'msedge',
  'microsoft edge': 'msedge',
  'firefox': 'firefox',
  'brave': 'brave',
  'opera': 'opera',
  'vivaldi': 'vivaldi'
};

// SECURITY: Get safe process name - only returns whitelisted values
function getSafeProcessName(appName) {
  if (!appName) return null;
  const appNameLower = appName.toLowerCase();

  // Check whitelist
  for (const [pattern, processName] of Object.entries(SAFE_BROWSER_PROCESSES)) {
    if (appNameLower.includes(pattern)) {
      return processName;
    }
  }
  return null; // Not a recognized browser - don't attempt URL extraction
}

// Windows-specific URL extraction for Chrome/Edge
async function getWindowsEdgeChromeUrl(appName, hwnd) {
  return new Promise((resolve) => {
    // SECURITY: Only use whitelisted process names to prevent command injection
    const safeProcessName = getSafeProcessName(appName);
    if (!safeProcessName) {
      resolve(null);
      return;
    }

    if (!browserUrlScriptPath) {
      resolve(null);
      return;
    }

    const safeHwnd = typeof hwnd === 'number' ? hwnd : 0;
    exec(`powershell -ExecutionPolicy Bypass -File "${browserUrlScriptPath}" -ProcessName "${safeProcessName}" -Hwnd ${safeHwnd}`, { timeout: 5000 }, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve(null);
        return;
      }

      let url = stdout.trim();
      // Add protocol if missing
      if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
      }
      resolve(url);
    });
  });
}

// =====================================================
// Screenshot Capture (PRESERVED - Original Functionality)
// =====================================================

async function captureScreenshot() {
  try {
    // Capture ALL displays. Previously hardcoded sources[0] which silently
    // ignored secondary monitors — managers couldn't audit dual-display setups.
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: primary.workAreaSize
    });

    if (sources.length === 0) {
      console.error('No screen sources available');
      return;
    }

    const captureTs = new Date().toISOString();

    // Upload each display in parallel. One failure must not block other displays
    // — all errors are caught inside uploadScreenshot (which queues to disk on
    // any non-401 failure). Promise.allSettled ensures we wait for all.
    await Promise.allSettled(sources.map((source, idx) => {
      const display = displays[idx] || null;
      const displayId = display ? String(display.id) : `src-${idx}`;
      const displayLabel = sources.length > 1
        ? (display && display.id === primary.id ? `Primary (${idx + 1})` : `Display ${idx + 1}`)
        : null;
      return uploadScreenshot(source.thumbnail.toDataURL(), {
        timestamp: captureTs,
        displayId,
        displayLabel,
        displayCount: sources.length
      });
    }));

    console.log(`Captured ${sources.length} display(s) at ${captureTs}`);

    if (mainWindow) {
      mainWindow.webContents.send('screenshot-captured', { timestamp: captureTs });
    }
  } catch (error) {
    console.error('Error capturing screenshot:', error);
  }
}

// Upload a single screenshot. On failure (network, 5xx, timeout), persist to
// disk queue so it can be retried later. Auth failures (401) are NOT queued —
// the token-refresh layer handles those, and queuing would just delay the
// inevitable drop.
async function uploadScreenshot(screenshotDataUrl, opts = {}) {
  const base64Data = screenshotDataUrl.replace(/^data:image\/\w+;base64,/, '');
  const timestamp = opts.timestamp || new Date().toISOString();
  const systemInfo = {
    hostname: os.hostname(),
    platform: os.platform(),
    username: os.userInfo().username
  };

  const payload = {
    userId: CONFIG.USER_ID,
    screenshot: base64Data,
    timestamp,
    systemInfo,
    displayId: opts.displayId || null,
    displayLabel: opts.displayLabel || null,
    displayCount: opts.displayCount || 1
  };

  try {
    const response = await apiCallWithRetry(async () => {
      return axios.post(
        `${CONFIG.API_URL}/api/screenshots/upload`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${CONFIG.USER_TOKEN}`,
            'Content-Type': 'application/json'
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 30000
        }
      );
    });
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    if (status === 401) {
      await handleTrackingAuthFailure('screenshot-upload');
      // Don't queue — auth path will recover or the buffer is moot
      return null;
    }
    if (status >= 400 && status < 500) {
      // Server rejected as malformed — queuing won't help, drop.
      console.error('Screenshot upload rejected (4xx):', status);
      return null;
    }
    // Network failure or 5xx — queue to disk for later retry
    console.error('Screenshot upload failed, queueing to disk:', error.message);
    queueScreenshot(payload);
    return null;
  }
}

// =====================================================
// Screenshot offline queue — persists failed uploads to disk so a network
// blip doesn't permanently lose the shot. Previously uploadScreenshot dropped
// silently on any failure. Files live in userData/pending-screenshots/.
// =====================================================
const fsp = require('fs').promises;
const SCREENSHOT_QUEUE_DIR_NAME = 'pending-screenshots';
const SCREENSHOT_QUEUE_MAX_FILES = 200;        // ~200 MB cap at typical sizes
const SCREENSHOT_QUEUE_MAX_AGE_MS = 24 * 3600 * 1000; // 24h
const SCREENSHOT_RETRY_INTERVAL_MS = 60 * 1000;

let screenshotQueueDir = null;
let screenshotRetryInterval = null;
let queueFlushInProgress = false;

function getQueueDir() {
  if (screenshotQueueDir) return screenshotQueueDir;
  screenshotQueueDir = path.join(app.getPath('userData'), SCREENSHOT_QUEUE_DIR_NAME);
  return screenshotQueueDir;
}

async function queueScreenshot(payload) {
  try {
    const dir = getQueueDir();
    await fsp.mkdir(dir, { recursive: true });

    // Age-based cleanup + overflow eviction, so a long outage can't fill disk.
    const files = (await fsp.readdir(dir)).filter(f => f.endsWith('.json')).sort();
    const now = Date.now();
    const stats = await Promise.all(files.map(async f => {
      try { const s = await fsp.stat(path.join(dir, f)); return { f, mtime: s.mtimeMs }; }
      catch { return null; }
    }));
    const valid = stats.filter(Boolean);

    // Drop expired
    for (const { f, mtime } of valid) {
      if (now - mtime > SCREENSHOT_QUEUE_MAX_AGE_MS) {
        try { await fsp.unlink(path.join(dir, f)); } catch {}
      }
    }

    // Drop oldest if over cap (keep newest, drop oldest)
    const remaining = valid
      .filter(x => now - x.mtime <= SCREENSHOT_QUEUE_MAX_AGE_MS)
      .sort((a, b) => a.mtime - b.mtime);
    while (remaining.length >= SCREENSHOT_QUEUE_MAX_FILES) {
      const oldest = remaining.shift();
      try { await fsp.unlink(path.join(dir, oldest.f)); } catch {}
    }

    const fname = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    await fsp.writeFile(path.join(dir, fname), JSON.stringify(payload));
  } catch (err) {
    console.error('Failed to persist screenshot to queue:', err.message);
  }
}

async function flushScreenshotQueue() {
  if (queueFlushInProgress) return;
  if (!CONFIG.USER_TOKEN) return; // no auth — retry later
  queueFlushInProgress = true;
  try {
    const dir = getQueueDir();
    let files;
    try {
      files = (await fsp.readdir(dir)).filter(f => f.endsWith('.json')).sort();
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    if (files.length === 0) return;

    for (const f of files) {
      const fullPath = path.join(dir, f);
      let payload;
      try {
        payload = JSON.parse(await fsp.readFile(fullPath, 'utf8'));
      } catch (parseErr) {
        // Corrupted file — drop it so we don't loop forever
        console.error('Dropping unreadable queued screenshot:', f, parseErr.message);
        try { await fsp.unlink(fullPath); } catch {}
        continue;
      }

      try {
        await apiCallWithRetry(async () => {
          return axios.post(
            `${CONFIG.API_URL}/api/screenshots/upload`,
            payload,
            {
              headers: {
                'Authorization': `Bearer ${CONFIG.USER_TOKEN}`,
                'Content-Type': 'application/json'
              },
              maxContentLength: Infinity,
              maxBodyLength: Infinity,
              timeout: 30000
            }
          );
        });
        try { await fsp.unlink(fullPath); } catch {}
      } catch (uploadErr) {
        const status = uploadErr.response?.status;
        if (status >= 400 && status < 500 && status !== 401) {
          // Server-rejected — drop permanently
          try { await fsp.unlink(fullPath); } catch {}
        }
        // Otherwise keep on disk; next tick will retry.
        // Stop iterating on first failure to avoid hammering a down server.
        break;
      }
    }
  } catch (err) {
    console.error('Error flushing screenshot queue:', err.message);
  } finally {
    queueFlushInProgress = false;
  }
}

function startScreenshotQueueRetry() {
  if (screenshotRetryInterval) return;
  // Immediate attempt, then periodic
  flushScreenshotQueue().catch(() => {});
  screenshotRetryInterval = setInterval(() => {
    flushScreenshotQueue().catch(() => {});
  }, SCREENSHOT_RETRY_INTERVAL_MS);
}
function stopScreenshotQueueRetry() {
  if (screenshotRetryInterval) {
    clearInterval(screenshotRetryInterval);
    screenshotRetryInterval = null;
  }
}

// Check if tracking should be active based on working hours
// Returns true if within working hours OR no working hours configured
function shouldTrackNow() {
  if (!CONFIG.WORKING_HOURS_START || !CONFIG.WORKING_HOURS_END) {
    return true; // No working hours configured — always track
  }
  const { isOvertime } = getWorkingHoursStatus();
  return !isOvertime; // Track only during working hours (isOvertime=false means within hours)
}

// Working hours enforcement interval
let workingHoursCheckInterval = null;

// Check working hours and pause/resume/transition tracking accordingly.
// Four valid transitions:
//   in-hours, not tracking          → startTrackingNow() [regular]
//   out-of-hours, tracking regular  → CONFIG.TRACK_OUTSIDE_HOURS ? transitionToOvertime() : pauseTrackingForLogout()
//   in-hours, tracking overtime     → transitionToRegular()
//   out-of-hours, not tracking, overtime enabled (toggled on) → startTrackingNow({ overtime: true })
async function checkWorkingHoursAndToggle() {
  // Refresh settings when idle. The heartbeat-piggyback path (sendHeartbeat ->
  // settings_version) handles propagation while tracking, but in cold-start
  // "idle until shift starts" mode there's NO heartbeat — so toggling
  // track_outside_hours on the dashboard would otherwise require a desktop restart
  // (the bug that hit Aryav: dashboard toggle didn't reach idle desktop until kill+relaunch).
  // Cost: 2 API calls/min/idle desktop, only when working hours are configured.
  if (!isTracking && CONFIG.USER_TOKEN) {
    await fetchTeamSettings().catch(err => console.warn('Idle settings refresh failed:', err.message));
  }

  const shouldTrack = shouldTrackNow();

  if (shouldTrack && !isTracking) {
    console.log('Within working hours — starting tracking');
    await startTrackingNow();
  } else if (shouldTrack && isTracking && currentSessionIsOvertime) {
    // Returned to regular hours mid-overtime (next-day shift start)
    console.log('Working hours started — transitioning from overtime to regular');
    await transitionToRegular();
  } else if (!shouldTrack && isTracking && !currentSessionIsOvertime) {
    if (CONFIG.TRACK_OUTSIDE_HOURS) {
      console.log('Working hours ended — transitioning to Extra Hours');
      await transitionToOvertime();
    } else {
      console.log('Working hours ended — pausing tracking and marking logged out');
      await pauseTrackingForLogout();
    }
  } else if (!shouldTrack && !isTracking && CONFIG.TRACK_OUTSIDE_HOURS) {
    // Admin enabled overtime mid-shift (after we'd already paused at shift end)
    console.log('Extra hours enabled — starting overtime tracking');
    await startTrackingNow({ overtime: true });
  } else if (!shouldTrack && isTracking && currentSessionIsOvertime && !CONFIG.TRACK_OUTSIDE_HOURS) {
    // Admin disabled overtime while overtime session was running
    console.log('Extra hours disabled — pausing tracking');
    await pauseTrackingForLogout();
  }
}

// Push an immediate logged_out heartbeat so the dashboard flips to "Logged Out"
// without waiting on the 90s heartbeat-staleness gate. Best-effort — failure is
// not fatal because the heartbeat will eventually go stale anyway.
async function pushLoggedOutSignal() {
  if (!CONFIG.USER_TOKEN) return;
  try {
    await axios.post(
      `${CONFIG.API_URL}/api/presence/heartbeat`,
      { status: 'logged_out', idleSeconds: 0 },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.USER_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );
  } catch (err) {
    console.warn('Failed to push logged_out signal:', err.message);
  }
}

// Internal: start tracking (called by working hours check)
// Order matters: start screenshot/activity/heartbeat intervals FIRST, then kick
// off session creation in the background. Session creation must NOT gate
// tracking — if /api/sessions/start hangs or fails, tracking still runs and
// the reconciliation tick will retry the session create later. Awaiting
// session creation here was the Apr 18 Sanyam-class failure: a hung axios
// call left isTracking=true but no intervals scheduled, so the desktop
// silently dropped to heartbeat-only mode for the rest of the day.
async function startTrackingNow({ overtime = false } = {}) {
  if (isTracking) return;

  isTracking = true;
  currentSessionIsOvertime = overtime === true;
  console.log(`Starting screenshot capture${overtime ? ' (Extra Hours)' : ''}...`);
  updateTrayMenu();

  startActivityTracking();
  startHeartbeat();
  captureScreenshot();
  screenshotInterval = setInterval(captureScreenshot, CONFIG.SCREENSHOT_INTERVAL);

  // Fire-and-forget. startWorkSession has its own retry/timeout.
  startWorkSession({ overtime }).catch(err => console.error('startWorkSession threw:', err?.message));
}

// Shift end with overtime disabled. Order is load-bearing:
//   1. stopHeartbeat FIRST so no in-flight interval-fired heartbeat can overwrite
//      the logged_out status with 'online'/'idle' during endWorkSession (which
//      can block for up to 45s on retry path).
//   2. endWorkSession to settle the session row.
//   3. pushLoggedOutSignal as the FINAL write — it stays the persistent state.
async function pauseTrackingForLogout() {
  if (!isTracking) return;

  if (screenshotInterval) {
    clearInterval(screenshotInterval);
    screenshotInterval = null;
  }
  stopActivityTracking();
  stopHeartbeat();
  await endWorkSession();
  await pushLoggedOutSignal();

  isTracking = false;
  currentSessionIsOvertime = false;
  updateTrayMenu();
}

// Regular → Extra Hours transition. Close the regular session, push a logged_out
// signal so the dashboard shows the shift-end transition, then open a new
// overtime session. Tracking intervals (screenshot/activity/heartbeat) keep
// running — only the session row changes.
async function transitionToOvertime() {
  await endWorkSession();
  await pushLoggedOutSignal();
  // The reconciliation tick will retry if startWorkSession fails — fire-and-forget
  // so the dashboard's logged_out state isn't gated on session-create latency.
  currentSessionIsOvertime = true;
  startWorkSession({ overtime: true }).catch(err =>
    console.error('Overtime session start failed:', err?.message)
  );
}

// Extra Hours → Regular transition. Symmetric to transitionToOvertime; happens
// when working hours start the next day while the overtime session is still
// running. No logged_out push here — the user should appear continuously online
// across the day boundary.
async function transitionToRegular() {
  await endWorkSession();
  currentSessionIsOvertime = false;
  startWorkSession({ overtime: false }).catch(err =>
    console.error('Regular session start failed:', err?.message)
  );
}

async function startScreenshotCapture() {
  // Start working hours enforcement check (every 60 seconds)
  if (CONFIG.WORKING_HOURS_START && CONFIG.WORKING_HOURS_END) {
    console.log(`Working hours enforcement active: ${CONFIG.WORKING_HOURS_START} - ${CONFIG.WORKING_HOURS_END}`);

    // Check immediately and start/skip accordingly
    const shouldTrack = shouldTrackNow();
    if (shouldTrack) {
      await startTrackingNow();
    } else if (CONFIG.TRACK_OUTSIDE_HOURS) {
      // Cold-start outside working hours with overtime mode enabled — start full
      // tracking with overtime=true so screenshots/activity/heartbeat all run.
      console.log('Outside working hours — starting Extra Hours tracking');
      await startTrackingNow({ overtime: true });
    } else {
      // Cold-start outside hours, overtime disabled. Do NOT send heartbeats —
      // sending heartbeat-only made every laptop appear online forever (the
      // Neeraj-2pm-bug). User legitimately should appear logged out.
      console.log('Outside working hours, Extra Hours disabled — idle until shift starts');
    }

    // Periodically check if we need to start/stop based on working hours
    workingHoursCheckInterval = setInterval(checkWorkingHoursAndToggle, 60000);
  } else {
    // No working hours configured — track all the time
    await startTrackingNow();
  }

  startSessionReconciliation();
  startScreenshotQueueRetry();
}

// Heals mid-day session-create failures: every 5 min, if we're tracking but
// have no session id, retry. Without this, a single startWorkSession failure
// at boot leaves the entire shift with no session row.
let sessionReconcileInterval = null;
function startSessionReconciliation() {
  if (sessionReconcileInterval) return;
  sessionReconcileInterval = setInterval(() => {
    if (isTracking && !currentSessionId && CONFIG.USER_TOKEN) {
      // Preserve overtime context — without this, reconciling during the post-shift
      // window would create a regular session row and silently mis-tag the work.
      console.log(`No active session id — attempting reconciliation (overtime=${currentSessionIsOvertime})`);
      startWorkSession({ overtime: currentSessionIsOvertime })
        .catch(err => console.error('reconcile startWorkSession threw:', err?.message));
    }
  }, 5 * 60 * 1000);
}
function stopSessionReconciliation() {
  if (sessionReconcileInterval) {
    clearInterval(sessionReconcileInterval);
    sessionReconcileInterval = null;
  }
}

async function stopScreenshotCapture() {
  // Stop working hours enforcement
  if (workingHoursCheckInterval) {
    clearInterval(workingHoursCheckInterval);
    workingHoursCheckInterval = null;
  }

  stopSessionReconciliation();
  stopScreenshotQueueRetry();

  if (screenshotInterval) {
    clearInterval(screenshotInterval);
    screenshotInterval = null;
  }

  // Stop activity tracking
  stopActivityTracking();

  // Stop heartbeat
  stopHeartbeat();

  // End work session
  await endWorkSession();

  isTracking = false;
  updateTrayMenu();
  console.log('Screenshot capture stopped');
}

// =====================================================
// Active Application Tracking (File-based PowerShell)
// =====================================================

// Initialize PowerShell tracking scripts on disk (avoids escaping issues with -Command)
function initTrackingScripts() {
  if (os.platform() !== 'win32') return;

  const tempDir = os.tmpdir();

  // Active window detection script.
  // Design goals:
  //   - Universal: works for any app by reading the OS process table, no hardcoded app list.
  //   - Robust: UTF-8 stdout so non-ASCII window titles (Firefox em dash, CJK, emoji) survive
  //             Node's default utf8 decoding.
  //   - Silent side-channel: Add-Type / Get-Process errors route to stderr, never to stdout,
  //             so JSON.parse on the Node side sees only the JSON payload.
  //   - Friendly name: prefers FileVersionInfo.ProductName ("Mozilla Firefox", "Google Chrome")
  //             and falls back to ProcessName when the main module is sandbox-restricted.
  activeWindowScriptPath = path.join(tempDir, `em-activewin-${process.pid}.ps1`);
  fs.writeFileSync(activeWindowScriptPath, `
# Force UTF-8 so non-ASCII titles survive the stdout pipe into Node.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

# Load user32 bindings. Pipe to Out-Null so any "type already exists" warnings
# (shouldn't happen with a fresh process, but defensive) never touch stdout.
$null = Add-Type -MemberDefinition @'
[DllImport("user32.dll")]
public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet = CharSet.Unicode)]
public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder text, int count);
[DllImport("user32.dll")]
public static extern int GetWindowTextLengthW(IntPtr hWnd);
[DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
'@ -Name 'WinAPI' -Namespace 'User32' -PassThru 2>&1

$hwnd = [User32.WinAPI]::GetForegroundWindow()

# Fetch the exact title length instead of a fixed buffer so long Firefox/Chrome
# tab titles aren't truncated.
$titleLen = [User32.WinAPI]::GetWindowTextLengthW($hwnd)
if ($titleLen -lt 0) { $titleLen = 0 }
$title = New-Object System.Text.StringBuilder ($titleLen + 1)
if ($titleLen -gt 0) {
    [User32.WinAPI]::GetWindowTextW($hwnd, $title, $titleLen + 1) | Out-Null
}

$processId = [uint32]0
[User32.WinAPI]::GetWindowThreadProcessId($hwnd, [ref]$processId) | Out-Null

$pName = 'Unknown'
$displayName = $null
try {
    # GetProcessById is lighter than Get-Process and doesn't depend on provider modules.
    $proc = [System.Diagnostics.Process]::GetProcessById([int]$processId)
    if ($proc) {
        $pName = $proc.ProcessName
        # Prefer the friendly product name from the binary metadata. Wrapped in a
        # separate try because MainModule throws Access Denied on sandboxed children
        # (some Chrome/Firefox renderer processes) even when ProcessName is readable.
        try {
            $fvi = $proc.MainModule.FileVersionInfo
            if ($fvi) {
                if ($fvi.ProductName -and $fvi.ProductName.Trim()) { $displayName = $fvi.ProductName.Trim() }
                elseif ($fvi.FileDescription -and $fvi.FileDescription.Trim()) { $displayName = $fvi.FileDescription.Trim() }
            }
        } catch {
            [Console]::Error.WriteLine("MainModule access denied for pid $processId ($pName): $_")
        }
    }
} catch {
    [Console]::Error.WriteLine("GetProcessById failed for pid $processId : $_")
}
if (-not $displayName) { $displayName = $pName }

$filePath = ""
if ($pName -eq "explorer" -and $hwnd -ne [IntPtr]::Zero) {
    # Strategy 1: Shell.Application COM (classic Explorer windows)
    try {
        $shell = New-Object -ComObject Shell.Application
        foreach ($w in $shell.Windows()) {
            try {
                if ($w.HWND -eq [long]$hwnd) {
                    $filePath = $w.Document.Folder.Self.Path
                    break
                }
            } catch {}
        }
    } catch {
        [Console]::Error.WriteLine("Shell.Application failed: $_")
    }

    # Strategy 2: UI Automation fallback (Win11 tabs, edge cases)
    if (-not $filePath) {
        try {
            Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
            Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue
            $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
            $editCond = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                [System.Windows.Automation.ControlType]::Edit
            )
            $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
            foreach ($edit in $edits) {
                try {
                    $name = $edit.Current.Name
                    if ($name -match 'Address' -or $name -match 'path' -or $name -match 'breadcrumb') {
                        $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                        if ($vp -and $vp.Current.Value) {
                            $filePath = $vp.Current.Value
                            break
                        }
                    }
                } catch {}
            }
        } catch {
            [Console]::Error.WriteLine("UIAutomation Explorer fallback failed: $_")
        }
    }
}

[PSCustomObject]@{
    Title = $title.ToString()
    ProcessName = $pName
    DisplayName = $displayName
    FilePath = $filePath
    HWND = $hwnd.ToInt64()
} | ConvertTo-Json -Compress
`);

  // Browser URL extraction script
  browserUrlScriptPath = path.join(tempDir, `em-browserurl-${process.pid}.ps1`);
  fs.writeFileSync(browserUrlScriptPath, `
param([string]$ProcessName, [long]$Hwnd = 0)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$targetHwnd = [IntPtr]$Hwnd
if ($targetHwnd -eq [IntPtr]::Zero) {
    # Fallback: find process by name if HWND not provided
    $procs = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
    if ($procs) {
        $proc = $procs | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($proc) { $targetHwnd = $proc.MainWindowHandle }
    }
}

if ($targetHwnd -ne [IntPtr]::Zero) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($targetHwnd)
    $editCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Edit
    )
    $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)

    $url = $null

    # Strategy 1: Find the address bar by Name or AutomationId
    foreach ($edit in $edits) {
        $name = $edit.Current.Name
        $aid = $edit.Current.AutomationId
        if ($name -match 'Address' -or $name -match 'URL' -or $aid -match 'address' -or $aid -match 'url') {
            try {
                $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                if ($vp -and $vp.Current.Value) {
                    $url = $vp.Current.Value
                    break
                }
            } catch {}
        }
    }

    # Strategy 2: Fall back to first Edit with a URL-like value
    if (-not $url) {
        foreach ($edit in $edits) {
            try {
                $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                if ($vp -and $vp.Current.Value -match '^(https?://|[a-zA-Z0-9][-a-zA-Z0-9]*\\.[a-zA-Z]{2,})') {
                    $url = $vp.Current.Value
                    break
                }
            } catch {}
        }
    }

    if ($url) { Write-Output $url }
}
`);

  console.log('Tracking scripts initialized');
}

function cleanupTrackingScripts() {
  try { if (activeWindowScriptPath) fs.unlinkSync(activeWindowScriptPath); } catch (e) {}
  try { if (browserUrlScriptPath) fs.unlinkSync(browserUrlScriptPath); } catch (e) {}
}

async function trackActiveApplication() {
  return new Promise((resolve) => {
    const platform = os.platform();

    if (platform === 'win32') {
      if (!activeWindowScriptPath) {
        resolve({ appName: 'Unknown', processName: 'unknown', windowTitle: 'Unknown', filePath: null, hwnd: null });
        return;
      }

      // -NoProfile: skip the user's $PROFILE so banners / module-load output never
      //             contaminate stdout (the original Firefox=Unknown root cause).
      // -NonInteractive: never prompt.
      // windowsHide: no flashing console window each invocation.
      exec(
        `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${activeWindowScriptPath}"`,
        { timeout: 5000, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            console.warn('[activeWin] PowerShell exec error:', error.message);
            if (stderr && stderr.trim()) console.warn('[activeWin] stderr:', stderr.trim().slice(0, 500));
            resolve({ appName: 'Unknown', processName: 'unknown', windowTitle: 'Unknown', filePath: null, hwnd: null });
            return;
          }
          try {
            // ConvertTo-Json -Compress emits a single JSON line. If the user's
            // environment still contaminates stdout somehow, pull out the first
            // balanced {...} so one bad line from a module load doesn't break us.
            const raw = (stdout || '').trim();
            const firstBrace = raw.indexOf('{');
            const lastBrace = raw.lastIndexOf('}');
            const jsonSlice = firstBrace >= 0 && lastBrace > firstBrace
              ? raw.slice(firstBrace, lastBrace + 1)
              : raw;
            const result = JSON.parse(jsonSlice);
            if (stderr && stderr.trim()) {
              console.warn('[activeWin] stderr (non-fatal):', stderr.trim().slice(0, 500));
            }
            resolve({
              appName: result.DisplayName || result.ProcessName || 'Unknown',
              processName: (result.ProcessName || 'unknown').toString().toLowerCase(),
              windowTitle: result.Title || '',
              filePath: result.FilePath || null,
              hwnd: typeof result.HWND === 'number' ? result.HWND : null
            });
          } catch (e) {
            console.warn('[activeWin] JSON parse failed:', e.message);
            if (stdout) console.warn('[activeWin] raw stdout:', stdout.slice(0, 500));
            if (stderr) console.warn('[activeWin] stderr:', stderr.slice(0, 500));
            resolve({ appName: 'Unknown', processName: 'unknown', windowTitle: 'Unknown', filePath: null, hwnd: null });
          }
        }
      );
    } else if (platform === 'darwin') {
      // macOS: Use AppleScript
      const script = `
        tell application "System Events"
          set frontApp to name of first application process whose frontmost is true
          set frontWindow to ""
          try
            tell process frontApp
              set frontWindow to name of front window
            end tell
          end try
        end tell
        return frontApp & "|" & frontWindow
      `;

      exec(`osascript -e '${script}'`, (error, stdout) => {
        if (error) {
          resolve({ appName: 'Unknown', processName: 'unknown', windowTitle: 'Unknown', filePath: null, hwnd: null });
          return;
        }
        const parts = stdout.trim().split('|');
        const appName = parts[0] || 'Unknown';
        resolve({
          appName,
          processName: appName.toLowerCase(),
          windowTitle: parts[1] || 'Unknown',
          filePath: null,
          hwnd: null
        });
      });
    } else {
      // Linux: Use xdotool + detect file manager paths
      exec('xdotool getactivewindow getwindowname && xdotool getactivewindow getwindowpid | xargs -I {} ps -p {} -o comm=', (error, stdout) => {
        if (error) {
          resolve({ appName: 'Unknown', processName: 'unknown', windowTitle: 'Unknown', filePath: null, hwnd: null });
          return;
        }
        const lines = stdout.trim().split('\n');
        const appName = lines[1] || 'Unknown';
        const windowTitle = lines[0] || 'Unknown';
        let filePath = null;

        // Detect file manager paths from window title
        const fileManagers = ['nautilus', 'dolphin', 'thunar', 'nemo', 'pcmanfm', 'caja', 'files'];
        if (fileManagers.some(fm => appName.toLowerCase().includes(fm))) {
          if (windowTitle.startsWith('/')) {
            filePath = windowTitle;
          }
        }

        resolve({ appName, processName: appName.toLowerCase(), windowTitle, filePath, hwnd: null });
      });
    }
  });
}

// =====================================================
// Mouse & Keyboard Tracking (for engagement metrics)
// =====================================================

function trackMouseMovement() {
  try {
    const currentPos = screen.getCursorScreenPoint();
    const distance = Math.sqrt(
      Math.pow(currentPos.x - lastMousePosition.x, 2) +
      Math.pow(currentPos.y - lastMousePosition.y, 2)
    );

    // Count mouse events based on movement intensity
    if (distance > 3) {
      // Small movements = 1 event, larger movements = more events (simulates clicks/drags)
      const eventCount = Math.min(Math.ceil(distance / 20), 5);
      mouseEvents += eventCount;
    }

    lastMousePosition = currentPos;
    return Math.round(distance);
  } catch (e) {
    return 0;
  }
}

// Infer keyboard activity from idle time changes
// When idle time resets or decreases significantly, user was typing
function trackKeyboardActivity() {
  try {
    const currentIdleTime = powerMonitor.getSystemIdleTime();
    activitySampleCount++;

    // If idle time decreased (user became active) and mouse didn't move much
    // this likely means keyboard activity
    if (lastIdleTime > 0 && currentIdleTime < lastIdleTime) {
      const currentPos = screen.getCursorScreenPoint();
      const mouseDistance = Math.sqrt(
        Math.pow(currentPos.x - lastMousePosition.x, 2) +
        Math.pow(currentPos.y - lastMousePosition.y, 2)
      );

      // If mouse barely moved but idle time reset, it was keyboard input
      if (mouseDistance < 10) {
        // Estimate keystrokes based on how much idle time was reset
        // More aggressive typing = more frequent resets
        const estimatedKeystrokes = Math.min(Math.ceil((lastIdleTime - currentIdleTime) * 2), 20);
        keyboardEvents += Math.max(estimatedKeystrokes, 1);
      }
    }

    // Also count activity if user was previously idle and is now active
    if (lastIdleTime >= CONFIG.IDLE_THRESHOLD && currentIdleTime < 5) {
      // User just became active - add baseline activity
      keyboardEvents += 5;
      mouseEvents += 3;
    }

    lastIdleTime = currentIdleTime;
  } catch (e) {
    console.error('Keyboard tracking error:', e);
  }
}

// =====================================================
// Real Keyboard Monitoring (Windows Low-Level Hook)
// =====================================================

// Linux keyboard monitor using xinput
function startLinuxKeyboardMonitor() {
  if (os.platform() !== 'linux' || keyboardMonitorProcess) return;

  try {
    const devices = execSync('xinput list --short', { timeout: 5000 }).toString();
    // Find keyboard device - look for "keyboard" in device name, skip virtual/power/video
    const lines = devices.split('\n');
    let kbId = null;
    for (const line of lines) {
      if (line.toLowerCase().includes('keyboard') &&
          !line.toLowerCase().includes('virtual') &&
          !line.toLowerCase().includes('power') &&
          !line.toLowerCase().includes('video')) {
        const idMatch = line.match(/id=(\d+)/);
        if (idMatch) { kbId = idMatch[1]; break; }
      }
    }
    if (!kbId) {
      console.log('No keyboard device found for monitoring');
      return;
    }

    console.log(`Starting Linux keyboard monitor on device ${kbId}`);
    keyboardMonitorProcess = spawn('xinput', ['test', kbId]);

    let keyCount = 0;
    let lastKey = '';
    let repeatCount = 0;
    let maxRepeat = 0;

    keyboardMonitorProcess.stdout.on('data', (data) => {
      const dataLines = data.toString().split('\n');
      for (const l of dataLines) {
        if (l.includes('key press')) {
          keyCount++;
          const key = l.trim();
          if (key === lastKey) {
            repeatCount++;
            if (repeatCount > maxRepeat) maxRepeat = repeatCount;
          } else {
            repeatCount = 1;
            lastKey = key;
          }
        }
      }
    });

    keyboardMonitorProcess.on('error', (e) => {
      console.error('Linux keyboard monitor error:', e.message);
      keyboardMonitorProcess = null;
    });
    keyboardMonitorProcess.on('exit', () => { keyboardMonitorProcess = null; });

    // Override readKeyboardStats for Linux
    readKeyboardStats = () => {
      const result = { keystrokes: keyCount, maxRepeat };
      keyCount = 0;
      maxRepeat = 0;
      return result;
    };
  } catch (e) {
    console.error('Failed to start Linux keyboard monitor:', e.message);
  }
}

function startKeyboardMonitor() {
  if (keyboardMonitorProcess) return;
  if (os.platform() === 'linux') return startLinuxKeyboardMonitor();
  if (os.platform() !== 'win32') return;

  try {
    const scriptPath = path.join(os.tmpdir(), `em-kb-${process.pid}.ps1`);
    const scriptContent = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Diagnostics;
public class KBMon {
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SetWindowsHookEx(int idHook, LLKBProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")]
    static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")]
    static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetModuleHandle(string lpModuleName);
    [DllImport("user32.dll")]
    static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
    delegate IntPtr LLKBProc(int nCode, IntPtr wParam, IntPtr lParam);
    static int keys = 0;
    static int lastVK = -1;
    static int rep = 0;
    static int maxRep = 0;
    static LLKBProc cbDelegate;
    static IntPtr hookId;
    public static void Run() {
        cbDelegate = HookCB;
        hookId = SetWindowsHookEx(13, cbDelegate, GetModuleHandle(Process.GetCurrentProcess().MainModule.ModuleName), 0);
        if (hookId == IntPtr.Zero) { Console.WriteLine("HOOK_FAILED"); Console.Out.Flush(); return; }
        var timer = new Timer(_ => {
            int k = Interlocked.Exchange(ref keys, 0);
            int r = Interlocked.Exchange(ref maxRep, 0);
            Console.WriteLine(k + "|" + r);
            Console.Out.Flush();
        }, null, 1000, 1000);
        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) != 0) {}
        UnhookWindowsHookEx(hookId);
        timer.Dispose();
    }
    static IntPtr HookCB(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0 && (int)wParam == 256) {
            int vk = Marshal.ReadInt32(lParam);
            Interlocked.Increment(ref keys);
            if (vk == lastVK) { rep++; if (rep > maxRep) maxRep = rep; }
            else { rep = 1; lastVK = vk; }
        }
        return CallNextHookEx(hookId, nCode, wParam, lParam);
    }
}
"@ -Language CSharp
[KBMon]::Run()
`;
    fs.writeFileSync(scriptPath, scriptContent);

    keyboardMonitorProcess = spawn('powershell', [
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', scriptPath
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });

    keyboardMonitorProcess.stdout.on('data', (data) => {
      for (const line of data.toString().trim().split('\n')) {
        const trimmed = line.trim();
        if (trimmed === 'HOOK_FAILED') {
          console.warn('Keyboard hook failed, falling back to inference');
          stopKeyboardMonitor();
          return;
        }
        const parts = trimmed.split('|');
        const k = parseInt(parts[0]);
        const r = parseInt(parts[1]);
        if (!isNaN(k)) pendingKeystrokes += k;
        if (!isNaN(r) && r > pendingMaxRepeat) pendingMaxRepeat = r;
      }
    });

    keyboardMonitorProcess.on('error', (err) => {
      console.error('Keyboard monitor process error:', err);
      keyboardMonitorProcess = null;
    });

    keyboardMonitorProcess.on('exit', () => {
      keyboardMonitorProcess = null;
    });

    console.log('Keyboard monitor started (low-level hook)');
  } catch (err) {
    console.error('Failed to start keyboard monitor:', err);
  }
}

// Declared as let so Linux keyboard monitor can override it
let readKeyboardStats = function() {
  const result = { keystrokes: pendingKeystrokes, maxRepeat: pendingMaxRepeat };
  pendingKeystrokes = 0;
  pendingMaxRepeat = 0;
  return result;
};

function stopKeyboardMonitor() {
  if (keyboardMonitorProcess) {
    try { keyboardMonitorProcess.kill(); } catch (e) {}
    keyboardMonitorProcess = null;
  }
  pendingKeystrokes = 0;
  pendingMaxRepeat = 0;
  // Clean up script file
  try {
    fs.unlinkSync(path.join(os.tmpdir(), `em-kb-${process.pid}.ps1`));
  } catch (e) {}
  console.log('Keyboard monitor stopped');
}

// =====================================================
// Idle Detection (PRESERVED)
// =====================================================

function getSystemIdleTime() {
  return powerMonitor.getSystemIdleTime();
}

// =====================================================
// Activity Tracking (ENHANCED with URL tracking)
// =====================================================

async function trackActivity() {
  // Skip tracking if system is suspended
  if (isSuspended) {
    return;
  }

  // Calculate duration FIRST — this must always succeed so we never lose time
  const now = Date.now();
  const durationSeconds = Math.round((now - lastActivityTime) / 1000);
  lastActivityTime = now;

  // Get idle status — wrap in try/catch since powerMonitor can fail after wake
  let idleTime = 0;
  let isIdle = false;
  try {
    idleTime = getSystemIdleTime();
    isIdle = idleTime >= CONFIG.IDLE_THRESHOLD;
  } catch (e) {
    console.error('Error getting idle time:', e.message);
  }

  // Update totals (always runs)
  if (isIdle) {
    totalIdleSeconds += durationSeconds;
    if (!isCurrentlyIdle) {
      isCurrentlyIdle = true;
      console.log('User went idle');
    }
  } else {
    totalActiveSeconds += durationSeconds;
    if (isCurrentlyIdle) {
      isCurrentlyIdle = false;
      console.log('User became active');
    }
  }

  // Get app info, keyboard, mouse, URL — all optional, failures don't lose the log
  let appInfo = { appName: 'Unknown', processName: 'unknown', windowTitle: 'Unknown', filePath: null, hwnd: null };
  let kbData = null;
  let mouseDistance = 0;
  let currentUrl = null;
  let currentDomain = null;

  try {
    appInfo = await trackActiveApplication();
  } catch (e) {
    console.error('Error tracking application:', e.message);
  }

  try {
    if (keyboardMonitorProcess) {
      kbData = readKeyboardStats();
      keyboardEvents = kbData.keystrokes;
    } else {
      trackKeyboardActivity();
    }
  } catch (e) { /* non-critical */ }

  try {
    mouseDistance = trackMouseMovement();
  } catch (e) { /* non-critical */ }

  try {
    if (appInfo.filePath) {
      currentUrl = 'file:///' + appInfo.filePath.replace(/\\/g, '/');
      currentDomain = 'local';
    } else if (teamSettings?.track_urls !== false) {
      currentUrl = await extractBrowserUrl(appInfo.appName, appInfo.windowTitle, appInfo.hwnd, appInfo.processName);
      if (currentUrl) {
        currentDomain = extractDomain(currentUrl);
      }
    }
  } catch (e) {
    console.error('Error extracting URL:', e.message);
  }

  // Check working hours for overtime detection
  let isOvertime = false;
  let shiftDate = null;
  try {
    const wh = getWorkingHoursStatus();
    isOvertime = wh.isOvertime;
    shiftDate = wh.shiftDate;
  } catch (e) { /* non-critical */ }

  // Create activity log entry — always succeeds
  const activity = {
    activityType: isIdle ? 'idle' : 'active',
    applicationName: appInfo.appName,
    windowTitle: appInfo.windowTitle,
    url: currentUrl,
    domain: currentDomain,
    isIdle: isIdle,
    durationSeconds: durationSeconds,
    keyboardEvents: keyboardEvents,
    mouseEvents: mouseEvents,
    mouseDistance: mouseDistance,
    isOvertime: isOvertime,
    shiftDate: shiftDate,
    metadata: {
      idleTime: idleTime,
      timestamp: new Date().toISOString(),
      maxKeyRepeat: kbData?.maxRepeat || 0
    }
  };

  // Reset counters
  keyboardEvents = 0;
  mouseEvents = 0;

  // Add to buffer
  activityBuffer.push(activity);

  // Send batch if buffer is full (every 6 entries = 1 minute worth)
  if (activityBuffer.length >= 6) {
    try {
      await sendActivityBatch();
    } catch (e) {
      console.error('Error sending activity batch:', e.message);
    }
  }

  // Update UI
  try {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('activity-update', {
        isIdle,
        appName: appInfo.appName,
        windowTitle: appInfo.windowTitle,
        url: currentUrl,
        domain: currentDomain,
        totalActiveSeconds,
        totalIdleSeconds
      });
    }
  } catch (e) { /* UI update non-critical */ }
}

// =====================================================
// Activity Batch Sending (PRESERVED + Enhanced)
// =====================================================

async function sendActivityBatch() {
  if (activityBuffer.length === 0) return;

  const activitiesToSend = [...activityBuffer];
  activityBuffer = [];

  const payloadSize = JSON.stringify({ activities: activitiesToSend }).length;
  console.log(`Sending activity batch: ${activitiesToSend.length} entries, ~${payloadSize} bytes`);

  try {
    const response = await apiCallWithRetry(async () => {
      return axios.post(
        `${CONFIG.API_URL}/api/activity/log/batch`,
        { activities: activitiesToSend },
        {
          headers: {
            'Authorization': `Bearer ${CONFIG.USER_TOKEN}`,
            'Content-Type': 'application/json'
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 30000
        }
      );
    });

    if (response.data.success) {
      console.log(`Sent ${activitiesToSend.length} activity logs`);
    } else {
      console.error('Activity batch rejected by server:', response.data.message);
    }
  } catch (error) {
    const status = error.response?.status;
    console.error(`Activity batch failed: status=${status}, message=${error.message}`);
    if (error.response?.data) {
      console.error('Server response:', JSON.stringify(error.response.data));
    }

    // Re-queue on network/server errors and auth errors (token can be refreshed)
    if (!status || status >= 500 || status === 401) {
      activityBuffer = [...activitiesToSend, ...activityBuffer].slice(0, 100);
      if (status === 401) {
        await handleTrackingAuthFailure('activity-batch');
      }
    } else {
      console.error('Client error - discarding batch (would always fail)');
    }
  }
}

// =====================================================
// Heartbeat for Real-time Presence
// =====================================================

async function sendHeartbeat() {
  try {
    const appInfo = await trackActiveApplication();
    let currentUrl = null;

    if (teamSettings?.track_urls !== false) {
      currentUrl = await extractBrowserUrl(appInfo.appName, appInfo.windowTitle, appInfo.hwnd, appInfo.processName);
    }

    const idleSeconds = getSystemIdleTime();

    const response = await apiCallWithRetry(async () => {
      return axios.post(
        `${CONFIG.API_URL}/api/presence/heartbeat`,
        {
          status: isCurrentlyIdle ? 'idle' : 'online',
          current_application: appInfo.appName,
          current_window_title: appInfo.windowTitle,
          current_url: currentUrl,
          idleSeconds: idleSeconds
        },
        {
          headers: {
            'Authorization': `Bearer ${CONFIG.USER_TOKEN}`,
            'Content-Type': 'application/json'
          },
          timeout: 5000 // 5 second timeout
        }
      );
    }, 2); // Only 2 retries for heartbeat (less critical)

    // Settings change detection — server piggybacks settings_version on every heartbeat.
    // We refetch the full settings only when the version increments (zero extra calls
    // in steady state). Old servers omit the field → never refetch via this path.
    const newVersion = response?.data?.settings_version;
    if (newVersion != null && newVersion !== lastSettingsVersion) {
      const previous = lastSettingsVersion;
      lastSettingsVersion = newVersion;
      if (previous != null) {
        console.log(`Settings version changed (${previous} → ${newVersion}) — refreshing config`);
        fetchTeamSettings().catch(err => console.warn('Settings refresh failed:', err.message));
      }
    }
  } catch (error) {
    const status = error.response?.status;
    if (status === 401) {
      await handleTrackingAuthFailure('heartbeat');
    } else {
      console.error('Error sending heartbeat:', error.message);
    }
  }
}

function startHeartbeat() {
  if (heartbeatInterval) return;

  console.log('Starting heartbeat...');

  // Send immediately
  sendHeartbeat();

  // Then every 30 seconds
  heartbeatInterval = setInterval(sendHeartbeat, CONFIG.HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  console.log('Heartbeat stopped');
}

// =====================================================
// Work Session Management (PRESERVED)
// =====================================================

// Retry-with-backoff. Critical: must always resolve (never hang) so callers
// like startTrackingNow() don't get blocked. Without a timeout the previous
// version could await forever on a Vercel cold-start hiccup, leaving tracking
// permanently stuck in heartbeat-only mode (the Sanyam-class failure on Apr 18).
async function startWorkSession({ overtime = false } = {}) {
  const attempts = [
    { delay: 0, timeout: 10000 },
    { delay: 5000, timeout: 10000 },
    { delay: 15000, timeout: 10000 }
  ];

  for (let i = 0; i < attempts.length; i++) {
    const { delay, timeout } = attempts[i];
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    try {
      const response = await axios.post(
        `${CONFIG.API_URL}/api/sessions/start`,
        {
          notes: `Session started from ${os.hostname()}${overtime ? ' (Extra Hours)' : ''}`,
          overtime: overtime === true
        },
        {
          headers: {
            'Authorization': `Bearer ${CONFIG.USER_TOKEN}`,
            'Content-Type': 'application/json'
          },
          timeout
        }
      );

      if (response.data.success) {
        currentSessionId = response.data.data.id;
        currentSessionIsOvertime = overtime === true;
        totalActiveSeconds = 0;
        totalIdleSeconds = 0;
        console.log(`Work session started${overtime ? ' (overtime)' : ''}:`, currentSessionId);
        return response.data;
      }
      // 2xx without success flag → don't retry, server logic decided no
      console.error('Session start returned non-success:', response.data?.message);
      return response.data;
    } catch (error) {
      const status = error.response?.status;
      // Don't retry auth failures — token-refresh layer handles those.
      if (status === 401 || status === 403) {
        console.error('Session start auth failure:', status);
        return null;
      }
      console.error(`Session start attempt ${i + 1}/${attempts.length} failed:`, error.message);
    }
  }

  // All retries exhausted. Tracking continues; reconciliation tick will retry later.
  return null;
}

async function endWorkSession() {
  if (!currentSessionId) return;

  // Capture id locally — the regular→overtime transition starts a new session
  // immediately after closing this one and we must not race the global out from
  // under the new session.
  const sessionIdToEnd = currentSessionId;

  // Send any remaining activity logs
  await sendActivityBatch();

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post(
        `${CONFIG.API_URL}/api/sessions/end`,
        {
          sessionId: sessionIdToEnd,
          totalActiveTime: totalActiveSeconds,
          totalIdleTime: totalIdleSeconds,
          notes: `Session ended. Active: ${Math.round(totalActiveSeconds / 60)}min, Idle: ${Math.round(totalIdleSeconds / 60)}min`
        },
        {
          headers: {
            'Authorization': `Bearer ${CONFIG.USER_TOKEN}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );

      console.log('Work session ended');
      // Only clear if no other code path has already started a new session.
      if (currentSessionId === sessionIdToEnd) {
        currentSessionId = null;
        currentSessionIsOvertime = false;
      }
      return response.data;
    } catch (error) {
      console.error(`Error ending work session (attempt ${attempt}/${maxRetries}):`, error.message);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }

  // All retries failed — clear local state to avoid stale references
  console.error('Failed to end session after all retries. Server-side cleanup will handle it.');
  if (currentSessionId === sessionIdToEnd) {
    currentSessionId = null;
    currentSessionIsOvertime = false;
  }
  return null;
}

// =====================================================
// Activity Tracking Control (PRESERVED)
// =====================================================

function startActivityTracking() {
  if (activityInterval) return;

  console.log('Starting activity tracking...');
  lastActivityTime = Date.now();
  lastMousePosition = screen.getCursorScreenPoint();

  // Start real keyboard monitoring (Windows only)
  startKeyboardMonitor();

  // Track activity at configured interval
  activityInterval = setInterval(trackActivity, CONFIG.ACTIVITY_INTERVAL);

  // Initial tracking
  trackActivity();
}

async function stopActivityTracking() {
  if (activityInterval) {
    clearInterval(activityInterval);
    activityInterval = null;
  }

  // Stop keyboard monitor
  stopKeyboardMonitor();

  // Send any remaining logs and wait for completion
  try {
    await sendActivityBatch();
  } catch (error) {
    console.error('Error flushing activity batch on stop:', error.message);
  }

  console.log('Activity tracking stopped');
}
