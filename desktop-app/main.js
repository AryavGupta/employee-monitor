const { app, BrowserWindow, screen, desktopCapturer, ipcMain, powerMonitor, Tray, Menu, Notification, dialog, nativeImage } = require('electron');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');

// Load environment variables from .env file if exists
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (e) {
  // dotenv not available in packaged app, use defaults
}

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
let screenshotInterval;
let activityInterval;
let heartbeatInterval;
let isTracking = false;
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

  mainWindow.loadFile(path.join(__dirname, 'login.html'));

  // Show window when ready to prevent black screen
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Minimize to tray instead of closing
  mainWindow.on('close', (event) => {
    if (isTracking && tray) {
      event.preventDefault();
      mainWindow.hide();
      showNotification('Employee Monitor', 'Running in background. Click tray icon to show.');
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
      label: 'Quit',
      click: async () => {
        await stopScreenshotCapture();
        app.quit();
      }
    }
  ]);

  tray.setToolTip('Employee Monitor - Tracking Active');
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
      label: 'Quit',
      click: async () => {
        await stopScreenshotCapture();
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip(isTracking ? 'Employee Monitor - Tracking Active' : 'Employee Monitor');
}

// Show notification
function showNotification(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

// Initialize app
app.on('ready', () => {
  console.log('Starting Employee Monitor...');
  console.log('API URL:', CONFIG.API_URL);

  createWindow();

  // Setup auto-launch (optional - can be enabled by user)
  setupAutoLaunch();

  // Setup sleep/wake handlers to prevent uptime inflation
  setupPowerMonitorHandlers();
});

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
  powerMonitor.on('resume', () => {
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

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// Setup auto-launch on system boot
async function setupAutoLaunch() {
  try {
    const AutoLaunch = require('auto-launch');
    const autoLauncher = new AutoLaunch({
      name: 'Employee Monitor',
      path: app.getPath('exe'),
      isHidden: true
    });

    // Check if enabled and enable if not
    const isEnabled = await autoLauncher.isEnabled();
    if (!isEnabled) {
      // Auto-launch is disabled by default, user can enable in settings
      console.log('Auto-launch is available but not enabled');
    }
  } catch (error) {
    console.log('Auto-launch not available:', error.message);
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

      event.reply('login-response', { success: true, user: response.data.user });

      // Fetch team settings
      await fetchTeamSettings();

      // Create tray icon
      createTray();

      // Start monitoring
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
  try {
    // Stop tracking and flush all pending data
    await stopScreenshotCapture();

    // Clear user data
    CONFIG.USER_TOKEN = null;
    CONFIG.USER_ID = null;
    CONFIG.USER_DATA = null;
    teamSettings = null;

    // Destroy tray
    if (tray) {
      tray.destroy();
      tray = null;
    }

    // Return to login screen
    if (mainWindow) {
      mainWindow.loadFile(path.join(__dirname, 'login.html'));
    }
  } catch (error) {
    console.error('Error during logout:', error);
    // Still clear everything even if there was an error
    CONFIG.USER_TOKEN = null;
    CONFIG.USER_ID = null;
    CONFIG.USER_DATA = null;
    if (mainWindow) {
      mainWindow.loadFile(path.join(__dirname, 'login.html'));
    }
  }
});

ipcMain.on('get-tracking-status', (event) => {
  event.reply('tracking-status', {
    isTracking,
    userId: CONFIG.USER_ID,
    teamSettings: teamSettings
  });
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
        }
      } catch (e) {
        console.log('Could not fetch team settings:', e.message);
      }
    }
  } catch (error) {
    console.error('Error fetching team settings:', error.message);
  }
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

    // PowerShell script to get URL from Chrome/Edge address bar using UI Automation
    // SECURITY: safeProcessName is guaranteed to be from whitelist (no user input)
    const psScript = `
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes

      $processName = "${safeProcessName}"
      $procs = Get-Process -Name $processName -ErrorAction SilentlyContinue

      if ($procs) {
        $proc = $procs | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($proc) {
          $root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
          $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
          $addressBar = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
          if ($addressBar) {
            $valuePattern = $addressBar.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            if ($valuePattern) {
              Write-Output $valuePattern.Current.Value
            }
          }
        }
      }
    `;

    exec(`powershell -Command "${psScript.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { timeout: 5000 }, (error, stdout) => {
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

async function startScreenshotCapture() {
  if (isTracking) return;

  isTracking = true;
  console.log('Starting screenshot capture...');

  // Update tray
  updateTrayMenu();

  // Start a work session
  await startWorkSession();

  // Start activity tracking
  startActivityTracking();

  // Start heartbeat for presence
  startHeartbeat();

  // Capture immediately on start
  captureScreenshot();

  // Then capture at configured interval
  screenshotInterval = setInterval(captureScreenshot, CONFIG.SCREENSHOT_INTERVAL);
}

async function stopScreenshotCapture() {
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
// Active Application Tracking (PRESERVED + Enhanced)
// =====================================================

async function trackActiveApplication() {
  return new Promise((resolve) => {
    const platform = os.platform();

    if (platform === 'win32') {
      // Windows: Use PowerShell to get active window info
      const psScript = `
        Add-Type @"
          using System;
          using System.Runtime.InteropServices;
          using System.Text;
          public class WindowInfo {
            [DllImport("user32.dll")]
            public static extern IntPtr GetForegroundWindow();
            [DllImport("user32.dll")]
            public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
            [DllImport("user32.dll")]
            public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
          }
"@
        $hwnd = [WindowInfo]::GetForegroundWindow()
        $title = New-Object System.Text.StringBuilder 256
        [WindowInfo]::GetWindowText($hwnd, $title, 256) | Out-Null
        $processId = 0
        [WindowInfo]::GetWindowThreadProcessId($hwnd, [ref]$processId) | Out-Null
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        @{
          Title = $title.ToString()
          ProcessName = if($process) { $process.ProcessName } else { "Unknown" }
        } | ConvertTo-Json
      `;

      exec(`powershell -Command "${psScript.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, (error, stdout) => {
        if (error) {
          resolve({ appName: 'Unknown', windowTitle: 'Unknown' });
          return;
        }
        try {
          const result = JSON.parse(stdout);
          resolve({
            appName: result.ProcessName || 'Unknown',
            windowTitle: result.Title || 'Unknown'
          });
        } catch (e) {
          resolve({ appName: 'Unknown', windowTitle: 'Unknown' });
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

    // Track keyboard activity (inferred from idle time changes)
    trackKeyboardActivity();

    // Track mouse movement
    const mouseDistance = trackMouseMovement();

    // Try to extract URL if it's a browser
    let currentUrl = null;
    let currentDomain = null;

    if (teamSettings?.track_urls !== false) {
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
      metadata: {
        idleTime: idleTime,
        timestamp: new Date().toISOString()
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

  try {
    await apiCallWithRetry(async () => {
      return axios.post(
        `${CONFIG.API_URL}/api/activity/log/batch`,
        { activities: activitiesToSend },
        {
          headers: {
            'Authorization': `Bearer ${CONFIG.USER_TOKEN}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000 // 10 second timeout
        }
      );
    });
    console.log(`Sent ${activitiesToSend.length} activity logs`);
  } catch (error) {
    console.error('Error sending activity batch after retries:', error.message);
    // Re-add to buffer on failure (limit buffer size to prevent memory issues)
    activityBuffer = [...activitiesToSend, ...activityBuffer].slice(0, 100);
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

    await apiCallWithRetry(async () => {
      return axios.post(
        `${CONFIG.API_URL}/api/presence/heartbeat`,
        {
          status: isCurrentlyIdle ? 'idle' : 'online',
          current_application: appInfo.appName,
          current_window_title: appInfo.windowTitle,
          current_url: currentUrl
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

  // Send any remaining logs and wait for completion
  try {
    await sendActivityBatch();
  } catch (error) {
    console.error('Error flushing activity batch on stop:', error.message);
  }

  console.log('Activity tracking stopped');
}
