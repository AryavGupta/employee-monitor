/**
 * Preload script for secure IPC communication
 * This script runs in the renderer process before the page loads
 * and exposes only necessary APIs via contextBridge
 */
const { contextBridge, ipcRenderer } = require('electron');

// Whitelist of allowed IPC channels for security
const validSendChannels = [
  'login',
  'logout',
  'get-tracking-status',
  'change-password',
  'open-settings',
  'navigate-to'
];

const validReceiveChannels = [
  'login-response',
  'tracking-status',
  'screenshot-captured',
  'activity-update',
  'system-wake',
  'change-password-response'
];

// Expose protected APIs to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Send messages to main process (one-way)
  send: (channel, data) => {
    if (validSendChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    } else {
      console.warn(`Blocked IPC send to invalid channel: ${channel}`);
    }
  },

  // Receive messages from main process
  on: (channel, callback) => {
    if (validReceiveChannels.includes(channel)) {
      // Wrap callback to strip event object for security
      const subscription = (event, ...args) => callback(...args);
      ipcRenderer.on(channel, subscription);

      // Return cleanup function
      return () => {
        ipcRenderer.removeListener(channel, subscription);
      };
    } else {
      console.warn(`Blocked IPC listener on invalid channel: ${channel}`);
      return () => {};
    }
  },

  // One-time listener
  once: (channel, callback) => {
    if (validReceiveChannels.includes(channel)) {
      ipcRenderer.once(channel, (event, ...args) => callback(...args));
    } else {
      console.warn(`Blocked IPC once listener on invalid channel: ${channel}`);
    }
  }
});
