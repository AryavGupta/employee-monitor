const { app, BrowserWindow, screen, desktopCapturer, ipcMain, powerMonitor, Tray, Menu, dialog, nativeImage } = require('electron');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const { exec, spawn } = require('child_process');

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
        userData: { type: 'object' }
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
  RETRY_DELAY: 1000 // Base delay in ms, will be exponentially increased
};

// Retry wrapper for API calls with exponential backoff
async function apiCallWithRetry(apiCall, maxRetries = CONFIG.MAX_RETRIES) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await apiCall();
    } catch (error) {
      lastError = error;

      // Don't retry on auth errors (401, 403) or client errors (400)
      const status = error.response?.status;
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

// Initialize app
app.on('ready', async () => {
  console.log('Starting Employee Monitor...');
  console.log('API URL:', CONFIG.API_URL);

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

      if (status === 401 || status === 403) {
        // Token genuinely invalid/expired — clear and show login
        console.log(`Token rejected with ${status}, clearing credentials`);
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

  startScreenshotCapture();
  mainWindow.loadFile(path.join(__dirname, 'tracking.html'));
}

// =====================================================
// Power Monitor Handlers (Sleep/Wake Detection)
// Prevents uptime from being inflated during system sleep
// =====================================================

function setupPowerMonitorHandlers() {
  // System is about to sleep/suspend
  powerMonitor.on('suspend', () => {
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

    // Flush any pending activity logs before sleep
    sendActivityBatch().catch(err => {
      console.log('Could not flush activity before sleep:', err.message);
    });

    // Notify server that user is going offline due to sleep
    if (CONFIG.USER_TOKEN) {
      axios.post(
        `${CONFIG.API_URL}/api/presence/heartbeat`,
        { status: 'away', reason: 'system_sleep' },
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
      console.log('Resuming tracking after wake...');

      // If sleep was long (>5 min), the server may have auto-closed the session.
      // Check and start a new session if needed.
      if (sleepDuration > 300) {
        console.log('Long sleep detected, checking if session is still active...');
        try {
          const checkRes = await axios.get(
            `${CONFIG.API_URL}/api/sessions/active`,
            { headers: { Authorization: `Bearer ${CONFIG.USER_TOKEN}` }, timeout: 5000 }
          );
          if (!checkRes.data.data) {
            // Session was closed server-side during sleep — start a new one
            console.log('Session was closed during sleep, starting new session...');
            totalActiveSeconds = 0;
            totalIdleSeconds = 0;
            await startWorkSession();
          }
        } catch (e) {
          // Network not ready yet after wake — start new session to be safe
          console.log('Could not check session status, starting new session:', e.message);
          totalActiveSeconds = 0;
          totalIdleSeconds = 0;
          await startWorkSession();
        }
      }

      // Restart intervals
      screenshotInterval = setInterval(captureScreenshot, CONFIG.SCREENSHOT_INTERVAL);
      activityInterval = setInterval(trackActivity, CONFIG.ACTIVITY_INTERVAL);
      heartbeatInterval = setInterval(sendHeartbeat, CONFIG.HEARTBEAT_INTERVAL);

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

      axios.post(
        `${CONFIG.API_URL}/api/presence/heartbeat`,
        { status: 'offline', reason: 'system_shutdown' },
        { headers: { Authorization: `Bearer ${CONFIG.USER_TOKEN}` }, timeout: 3000 }
      ).catch(() => {});
    }
  });

  console.log('Power monitor handlers registered');
}

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

// IPC Handlers
ipcMain.on('login', async (event, credentials) => {
  try {
    const response = await axios.post(`${CONFIG.API_URL}/api/auth/login`, credentials);

    if (response.data.success) {
      CONFIG.USER_TOKEN = response.data.token;
      CONFIG.USER_ID = response.data.userId;
      CONFIG.USER_DATA = response.data.user;

      // Store credentials for persistent login
      store.set('credentials', {
        token: response.data.token,
        userId: response.data.userId,
        userData: response.data.user
      });

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
          }
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
  const currentDay = now.getDay() === 0 ? 7 : now.getDay(); // ISO: 1=Mon, 7=Sun
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

  let isWithinHours = false;
  let shiftDate = todayStr;

  if (startMinutes <= endMinutes) {
    // Normal shift (e.g., 09:00 - 17:00)
    isWithinHours = currentMinutes >= startMinutes && currentMinutes < endMinutes;
    shiftDate = todayStr;

    if (!CONFIG.WORKING_DAYS.includes(currentDay)) {
      isWithinHours = false;
    }
  } else {
    // Night shift (e.g., 22:30 - 07:30) — crosses midnight
    if (currentMinutes >= startMinutes) {
      // After start time, same day (e.g., 23:00 when shift starts 22:30)
      isWithinHours = CONFIG.WORKING_DAYS.includes(currentDay);
      shiftDate = todayStr; // Shift started today
    } else if (currentMinutes < endMinutes) {
      // Before end time, next day (e.g., 03:00 when shift ends 07:30)
      const yesterdayDay = yesterday.getDay() === 0 ? 7 : yesterday.getDay();
      isWithinHours = CONFIG.WORKING_DAYS.includes(yesterdayDay);
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
async function extractBrowserUrl(appName, windowTitle) {
  const browserPatterns = ['chrome', 'firefox', 'edge', 'msedge', 'brave', 'opera', 'safari', 'vivaldi'];
  const appNameLower = appName.toLowerCase();

  const isBrowser = browserPatterns.some(b => appNameLower.includes(b));
  if (!isBrowser) return null;

  // Try to extract URL from window title
  // Many browsers show "Page Title - Browser Name" or "Page Title - URL - Browser"
  let url = null;

  // For Windows, try to get URL from browser using accessibility APIs
  if (os.platform() === 'win32') {
    url = await getWindowsEdgeChromeUrl(appName);
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
async function getWindowsEdgeChromeUrl(appName) {
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

    exec(`powershell -ExecutionPolicy Bypass -File "${browserUrlScriptPath}" -ProcessName "${safeProcessName}"`, { timeout: 5000 }, (error, stdout) => {
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
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: screen.getPrimaryDisplay().workAreaSize
    });

    if (sources.length === 0) {
      console.error('No screen sources available');
      return;
    }

    // Get the primary screen
    const primarySource = sources[0];
    const screenshot = primarySource.thumbnail.toDataURL();

    // Send to server
    await uploadScreenshot(screenshot);

    console.log(`Screenshot captured and uploaded at ${new Date().toISOString()}`);

    // Update UI
    if (mainWindow) {
      mainWindow.webContents.send('screenshot-captured', {
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('Error capturing screenshot:', error);
  }
}

async function uploadScreenshot(screenshotDataUrl) {
  // Extract base64 data
  const base64Data = screenshotDataUrl.replace(/^data:image\/\w+;base64,/, '');

  // Get system info
  const systemInfo = {
    hostname: os.hostname(),
    platform: os.platform(),
    username: os.userInfo().username
  };

  try {
    const response = await apiCallWithRetry(async () => {
      return axios.post(
        `${CONFIG.API_URL}/api/screenshots/upload`,
        {
          userId: CONFIG.USER_ID,
          screenshot: base64Data,
          timestamp: new Date().toISOString(),
          systemInfo: systemInfo
        },
        {
          headers: {
            'Authorization': `Bearer ${CONFIG.USER_TOKEN}`,
            'Content-Type': 'application/json'
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 30000 // 30 second timeout for large uploads
        }
      );
    });

    return response.data;
  } catch (error) {
    console.error('Error uploading screenshot after retries:', error.message);
    throw error;
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

// Check working hours and pause/resume tracking accordingly
async function checkWorkingHoursAndToggle() {
  const shouldTrack = shouldTrackNow();

  if (shouldTrack && !isTracking) {
    console.log('Within working hours — starting tracking');
    await startTrackingNow();
  } else if (!shouldTrack && isTracking) {
    console.log('Outside working hours — pausing tracking');
    await pauseTrackingNow();
  }
}

// Internal: start tracking (called by working hours check)
async function startTrackingNow() {
  if (isTracking) return;

  isTracking = true;
  console.log('Starting screenshot capture...');
  updateTrayMenu();

  await startWorkSession();
  startActivityTracking();
  startHeartbeat();
  captureScreenshot();
  screenshotInterval = setInterval(captureScreenshot, CONFIG.SCREENSHOT_INTERVAL);
}

// Internal: pause tracking (called by working hours check)
async function pauseTrackingNow() {
  if (!isTracking) return;

  console.log('Pausing tracking (outside working hours)...');

  if (screenshotInterval) {
    clearInterval(screenshotInterval);
    screenshotInterval = null;
  }
  stopActivityTracking();
  stopHeartbeat();
  await endWorkSession();

  isTracking = false;
  updateTrayMenu();
}

async function startScreenshotCapture() {
  // Start working hours enforcement check (every 60 seconds)
  if (CONFIG.WORKING_HOURS_START && CONFIG.WORKING_HOURS_END) {
    console.log(`Working hours enforcement active: ${CONFIG.WORKING_HOURS_START} - ${CONFIG.WORKING_HOURS_END}`);

    // Check immediately and start/skip accordingly
    const shouldTrack = shouldTrackNow();
    if (shouldTrack) {
      await startTrackingNow();
    } else {
      console.log('Outside working hours — tracking will start when work hours begin');
      // Still send heartbeat so presence shows the user is online
      startHeartbeat();
    }

    // Periodically check if we need to start/stop based on working hours
    workingHoursCheckInterval = setInterval(checkWorkingHoursAndToggle, 60000);
  } else {
    // No working hours configured — track all the time
    await startTrackingNow();
  }
}

async function stopScreenshotCapture() {
  // Stop working hours enforcement
  if (workingHoursCheckInterval) {
    clearInterval(workingHoursCheckInterval);
    workingHoursCheckInterval = null;
  }

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

  // Active window detection script
  activeWindowScriptPath = path.join(tempDir, `em-activewin-${process.pid}.ps1`);
  fs.writeFileSync(activeWindowScriptPath, `
Add-Type -MemberDefinition '
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
' -Name 'WinAPI' -Namespace 'User32' -ErrorAction SilentlyContinue

$hwnd = [User32.WinAPI]::GetForegroundWindow()
$title = New-Object System.Text.StringBuilder 256
[User32.WinAPI]::GetWindowText($hwnd, $title, 256) | Out-Null
$processId = [uint32]0
[User32.WinAPI]::GetWindowThreadProcessId($hwnd, [ref]$processId) | Out-Null
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
$pName = if ($process) { $process.ProcessName } else { "Unknown" }

$filePath = ""
if ($pName -eq "explorer" -and $hwnd -ne [IntPtr]::Zero) {
    try {
        $shell = New-Object -ComObject Shell.Application
        foreach ($w in $shell.Windows()) {
            if ($w.HWND -eq [long]$hwnd) {
                $filePath = $w.Document.Folder.Self.Path
                break
            }
        }
    } catch {}
}

@{
    Title = $title.ToString()
    ProcessName = $pName
    FilePath = $filePath
} | ConvertTo-Json
`);

  // Browser URL extraction script
  browserUrlScriptPath = path.join(tempDir, `em-browserurl-${process.pid}.ps1`);
  fs.writeFileSync(browserUrlScriptPath, `
param([string]$ProcessName)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$procs = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
if ($procs) {
    $proc = $procs | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($proc) {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
        $condition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Edit
        )
        $addressBar = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
        if ($addressBar) {
            $valuePattern = $addressBar.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            if ($valuePattern) {
                Write-Output $valuePattern.Current.Value
            }
        }
    }
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
        resolve({ appName: 'Unknown', windowTitle: 'Unknown', filePath: null });
        return;
      }

      exec(`powershell -ExecutionPolicy Bypass -File "${activeWindowScriptPath}"`, { timeout: 5000 }, (error, stdout) => {
        if (error) {
          resolve({ appName: 'Unknown', windowTitle: 'Unknown', filePath: null });
          return;
        }
        try {
          const result = JSON.parse(stdout);
          resolve({
            appName: result.ProcessName || 'Unknown',
            windowTitle: result.Title || 'Unknown',
            filePath: result.FilePath || null
          });
        } catch (e) {
          resolve({ appName: 'Unknown', windowTitle: 'Unknown', filePath: null });
        }
      });
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
          resolve({ appName: 'Unknown', windowTitle: 'Unknown' });
          return;
        }
        const parts = stdout.trim().split('|');
        resolve({
          appName: parts[0] || 'Unknown',
          windowTitle: parts[1] || 'Unknown'
        });
      });
    } else {
      // Linux: Use xdotool
      exec('xdotool getactivewindow getwindowname && xdotool getactivewindow getwindowpid | xargs -I {} ps -p {} -o comm=', (error, stdout) => {
        if (error) {
          resolve({ appName: 'Unknown', windowTitle: 'Unknown' });
          return;
        }
        const lines = stdout.trim().split('\n');
        resolve({
          appName: lines[1] || 'Unknown',
          windowTitle: lines[0] || 'Unknown'
        });
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

function startKeyboardMonitor() {
  if (os.platform() !== 'win32' || keyboardMonitorProcess) return;

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

function readKeyboardStats() {
  const result = { keystrokes: pendingKeystrokes, maxRepeat: pendingMaxRepeat };
  pendingKeystrokes = 0;
  pendingMaxRepeat = 0;
  return result;
}

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

  try {
    const idleTime = getSystemIdleTime();
    const isIdle = idleTime >= CONFIG.IDLE_THRESHOLD;

    // Get active application info
    const appInfo = await trackActiveApplication();

    // Track keyboard activity - use real monitor if available, else infer
    let kbData = null;
    if (keyboardMonitorProcess) {
      kbData = readKeyboardStats();
      keyboardEvents = kbData.keystrokes;
    } else {
      trackKeyboardActivity();
    }

    // Track mouse movement
    const mouseDistance = trackMouseMovement();

    // Try to extract URL/file path
    let currentUrl = null;
    let currentDomain = null;

    // For Explorer windows, capture the directory path
    if (appInfo.filePath) {
      currentUrl = 'file:///' + appInfo.filePath.replace(/\\/g, '/');
      currentDomain = 'local';
    } else if (teamSettings?.track_urls !== false) {
      currentUrl = await extractBrowserUrl(appInfo.appName, appInfo.windowTitle);
      if (currentUrl) {
        currentDomain = extractDomain(currentUrl);
      }
    }

    // Calculate duration since last check
    const now = Date.now();
    const durationSeconds = Math.round((now - lastActivityTime) / 1000);
    lastActivityTime = now;

    // Update totals
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

    // Check working hours for overtime detection
    const { isOvertime, shiftDate } = getWorkingHoursStatus();

    // Create activity log entry
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
      await sendActivityBatch();
    }

    // Update UI
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

  } catch (error) {
    console.error('Error tracking activity:', error);
  }
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

    // Only re-queue on network/server errors, not client errors (4xx will always fail)
    if (!status || status >= 500) {
      activityBuffer = [...activitiesToSend, ...activityBuffer].slice(0, 100);
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
      currentUrl = await extractBrowserUrl(appInfo.appName, appInfo.windowTitle);
    }

    const idleSeconds = getSystemIdleTime();

    await apiCallWithRetry(async () => {
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
  } catch (error) {
    console.error('Error sending heartbeat:', error.message);
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

async function startWorkSession() {
  try {
    const response = await axios.post(
      `${CONFIG.API_URL}/api/sessions/start`,
      { notes: `Session started from ${os.hostname()}` },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.USER_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data.success) {
      currentSessionId = response.data.data.id;
      totalActiveSeconds = 0;
      totalIdleSeconds = 0;
      console.log('Work session started:', currentSessionId);
    }

    return response.data;
  } catch (error) {
    console.error('Error starting work session:', error.message);
    return null;
  }
}

async function endWorkSession() {
  if (!currentSessionId) return;

  try {
    // Send any remaining activity logs
    await sendActivityBatch();

    const response = await axios.post(
      `${CONFIG.API_URL}/api/sessions/end`,
      {
        totalActiveTime: totalActiveSeconds,
        totalIdleTime: totalIdleSeconds,
        notes: `Session ended. Active: ${Math.round(totalActiveSeconds / 60)}min, Idle: ${Math.round(totalIdleSeconds / 60)}min`
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.USER_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('Work session ended');
    currentSessionId = null;

    return response.data;
  } catch (error) {
    console.error('Error ending work session:', error.message);
    return null;
  }
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
