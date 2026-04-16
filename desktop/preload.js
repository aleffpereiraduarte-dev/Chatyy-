'use strict';

/**
 * preload.js — Chatyy Desktop Bridge
 *
 * Runs in the renderer process with contextIsolation=true and sandbox=true.
 * Exposes a safe, typed API to the web app via contextBridge.
 *
 * The web app accesses these via: window.chatyy.*
 */

const { contextBridge, ipcRenderer } = require('electron');

// ─── Allowed IPC channels ────────────────────────────────────────────────────

const SEND_CHANNELS = new Set([
  'badge-count',
  'show-notification',
  'set-preference',
  'open-external',
  'window-show',
  'window-hide',
  'window-minimize',
  'install-update',
]);

const INVOKE_CHANNELS = new Set([
  'get-preference',
  'app-info',
  'check-updates',
]);

const RECEIVE_CHANNELS = new Set([
  'deep-link',
  'navigate',
  'focus-search',
  'power-resume',
  'update-available',
  'update-progress',
  'update-downloaded',
]);

// ─── Exposed API ─────────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('chatyy', {
  /**
   * Platform info — available immediately (no async needed)
   */
  platform: process.platform, // 'darwin' | 'win32' | 'linux'
  isDesktop: true,

  /**
   * Update badge count (tray + dock + taskbar overlay)
   * @param {number} count
   */
  setBadgeCount(count) {
    if (typeof count !== 'number' || count < 0) return;
    ipcRenderer.send('badge-count', Math.floor(count));
  },

  /**
   * Show a native OS desktop notification (bypasses web push)
   * @param {{ title: string, body: string, icon?: string, tag?: string }} opts
   */
  showNotification(opts) {
    if (!opts || typeof opts.title !== 'string') return;
    ipcRenderer.send('show-notification', {
      title: String(opts.title).slice(0, 256),
      body: String(opts.body || '').slice(0, 512),
      icon: typeof opts.icon === 'string' ? opts.icon : undefined,
      tag: typeof opts.tag === 'string' ? opts.tag : undefined,
    });
  },

  /**
   * Get a persisted preference value
   * @param {string} key
   * @returns {Promise<any>}
   */
  getPreference(key) {
    const allowed = new Set([
      'minimizeToTray',
      'launchOnStartup',
      'notificationsEnabled',
      'windowBounds',
      'windowMaximized',
    ]);
    if (!allowed.has(key)) return Promise.resolve(undefined);
    return ipcRenderer.invoke('get-preference', key);
  },

  /**
   * Persist a preference value
   * @param {string} key
   * @param {any} value
   */
  setPreference(key, value) {
    const allowed = new Set([
      'minimizeToTray',
      'launchOnStartup',
      'notificationsEnabled',
    ]);
    if (!allowed.has(key)) return;
    ipcRenderer.send('set-preference', key, value);
  },

  /**
   * Get Electron app info
   * @returns {Promise<{ version: string, platform: string, arch: string, isPackaged: boolean }>}
   */
  getAppInfo() {
    return ipcRenderer.invoke('app-info');
  },

  /**
   * Open a URL in the system default browser
   * @param {string} url
   */
  openExternal(url) {
    if (typeof url !== 'string') return;
    if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('mailto:')) return;
    ipcRenderer.send('open-external', url);
  },

  /**
   * Window controls
   */
  window: {
    show: () => ipcRenderer.send('window-show'),
    hide: () => ipcRenderer.send('window-hide'),
    minimize: () => ipcRenderer.send('window-minimize'),
  },

  /**
   * Auto-updater controls
   */
  updater: {
    check: () => ipcRenderer.invoke('check-updates'),
    install: () => ipcRenderer.send('install-update'),
  },

  /**
   * Subscribe to events sent from the main process.
   * Returns an unsubscribe function.
   *
   * @param {'deep-link'|'navigate'|'focus-search'|'power-resume'|'update-available'|'update-progress'|'update-downloaded'} channel
   * @param {Function} handler
   * @returns {() => void} unsubscribe
   */
  on(channel, handler) {
    if (!RECEIVE_CHANNELS.has(channel)) {
      console.warn('[Chatyy Desktop] Blocked subscribe to unknown channel:', channel);
      return () => {};
    }
    if (typeof handler !== 'function') return () => {};

    const wrappedHandler = (_event, ...args) => handler(...args);
    ipcRenderer.on(channel, wrappedHandler);

    // Return unsubscribe
    return () => ipcRenderer.removeListener(channel, wrappedHandler);
  },

  /**
   * Subscribe to an event exactly once.
   * @param {string} channel
   * @param {Function} handler
   */
  once(channel, handler) {
    if (!RECEIVE_CHANNELS.has(channel)) return;
    if (typeof handler !== 'function') return;
    ipcRenderer.once(channel, (_event, ...args) => handler(...args));
  },
});

// ─── Override web Notification API to use native notifications ───────────────
// This runs in the page context so native Notification calls go through Electron.
// We keep the existing web Notification API shape for compatibility.

const _OriginalNotification = window.Notification;

class NativeNotification {
  constructor(title, options = {}) {
    // Delegate to Electron native via our bridge
    window.chatyy.showNotification({
      title,
      body: options.body,
      icon: options.icon,
      tag: options.tag,
    });
    // Simulate onclick/onshow callbacks (fire immediately)
    setTimeout(() => {
      if (typeof this.onshow === 'function') this.onshow();
    }, 0);
  }

  static get permission() {
    return 'granted'; // Electron always grants in-app notifications
  }

  static requestPermission() {
    return Promise.resolve('granted');
  }

  close() {}
}

// Preserve static properties
NativeNotification.prototype.onclick = null;
NativeNotification.prototype.onshow = null;
NativeNotification.prototype.onerror = null;
NativeNotification.prototype.onclose = null;

try {
  Object.defineProperty(window, 'Notification', {
    value: NativeNotification,
    writable: false,
    configurable: true,
  });
} catch {
  // If override fails (e.g., CSP), fall back to original — not critical
}

// ─── Deep-link / navigate listener — forward to SPA router ──────────────────
// The web app should call: window.chatyy.on('navigate', (path) => router.push(path))
// We auto-handle the most common deep-link formats here as a fallback.

window.chatyy.on('deep-link', (url) => {
  try {
    const parsed = new URL(url);
    // chatyy://chat/123 → /chat/123
    const path = `/${parsed.hostname}${parsed.pathname}`;
    window.chatyy.on('navigate', path); // re-emit as navigate
    // Also try to dispatch a custom DOM event the SPA can listen to
    window.dispatchEvent(new CustomEvent('chatyy-navigate', { detail: { path, url } }));
  } catch {
    /* malformed URL, ignore */
  }
});

// ─── Power resume — reload if page is stale (e.g., after long sleep) ─────────

window.chatyy.on('power-resume', () => {
  window.dispatchEvent(new CustomEvent('chatyy-power-resume'));
  // If the page has a special handler, it will manage reconnection.
  // Fallback: if page has been asleep > 30 min, reload automatically.
  const STALE_MS = 30 * 60 * 1000;
  if (!window._chatyyLastActive) window._chatyyLastActive = Date.now();
  const elapsed = Date.now() - (window._chatyyLastActive || 0);
  if (elapsed > STALE_MS) {
    window.location.reload();
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) window._chatyyLastActive = Date.now();
});

// ─── Log that preload ran ─────────────────────────────────────────────────────

console.info('[Chatyy Desktop] Preload OK — platform:', process.platform);
