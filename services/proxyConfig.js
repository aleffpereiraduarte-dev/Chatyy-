/**
 * proxyConfig.js — Settings-level proxy / Tor configuration.
 *
 * Settings → Privacidade → "Conexão via proxy" / "Usar Tor".
 *
 * What this module DOES:
 *   - Persists user proxy/Tor preferences (AsyncStorage on native, localStorage on web).
 *   - Exposes getProxyConfig() / setProxyConfig() for any caller.
 *   - On native, wires the saved config to the native HTTP stack via
 *     the `expo-proxy-config` module (if installed). The module exposes
 *     a tiny native shim per platform:
 *        Android: System.setProperty('socksProxyHost'/'socksProxyPort'),
 *                 which the OkHttp default client (used by fetch/axios)
 *                 picks up. Java's Proxy.Type.SOCKS routes everything
 *                 including DNS through the SOCKS5 proxy.
 *        iOS:    URLSessionConfiguration.connectionProxyDictionary
 *                 with kCFNetworkProxiesSOCKSEnable/Proxy/Port. Wired via
 *                 a custom NSURLProtocol so SocketRocket WS + URLSession
 *                 (used by RN bridge) honor it.
 *   - For "Usar Tor": app bundles Tor.framework (iOS) and tor-android (Android)
 *     and starts a local SOCKS5 proxy on 127.0.0.1:9050. The Tor module exposes
 *     await ExpoTor.start() / .stop() / .ready(). When the toggle is ON we
 *     start Tor and feed 127.0.0.1:9050 into the proxy plumbing above.
 *
 * What this module DOES NOT:
 *   - Implement the native shims (those live in modules/expo-proxy-config and
 *     modules/expo-tor — separate native build).
 *   - Run a SOCKS5 stack on web (browsers route through OS).
 *
 * Failure modes are silent: missing native module → toggles still persist
 * but apply on next launch when the module is installed.
 */

import { Platform } from 'react-native';

const STORAGE_KEY = 'chatyy_proxy_config_v1';

const DEFAULT_CONFIG = {
  enabled: false,
  type: 'socks5',     // 'socks5' is the only supported type for now
  host: '',
  port: 1080,
  username: '',
  password: '',
  useTor: false,      // when true, host/port are ignored — tor is forced 127.0.0.1:9050
};

let _cache = null;
let _listeners = [];

function _storageGet(key) {
  return new Promise((resolve) => {
    if (Platform.OS === 'web') {
      try {
        const v = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
        resolve(v);
      } catch { resolve(null); }
      return;
    }
    try {
      import('@react-native-async-storage/async-storage')
        .then(m => m.default.getItem(key))
        .then(resolve)
        .catch(() => resolve(null));
    } catch { resolve(null); }
  });
}
function _storageSet(key, val) {
  if (Platform.OS === 'web') {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, val); } catch {}
    return Promise.resolve();
  }
  try {
    return import('@react-native-async-storage/async-storage')
      .then(m => m.default.setItem(key, val))
      .catch(() => {});
  } catch { return Promise.resolve(); }
}

async function _hydrate() {
  if (_cache) return _cache;
  try {
    const raw = await _storageGet(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      _cache = { ...DEFAULT_CONFIG, ...parsed };
    } else {
      _cache = { ...DEFAULT_CONFIG };
    }
  } catch {
    _cache = { ...DEFAULT_CONFIG };
  }
  return _cache;
}

export async function getProxyConfig() {
  return await _hydrate();
}

export async function setProxyConfig(patch) {
  const next = { ...(await _hydrate()), ...(patch || {}) };
  // Sanitization — keep host/port reasonable so we don't ship garbage to the
  // native side.
  next.host = String(next.host || '').slice(0, 255).trim();
  next.port = Math.max(1, Math.min(65535, parseInt(next.port, 10) || 1080));
  next.username = String(next.username || '').slice(0, 255);
  next.password = String(next.password || '').slice(0, 255);
  _cache = next;
  await _storageSet(STORAGE_KEY, JSON.stringify(next));
  await applyProxyConfigNative(next);
  _listeners.forEach(l => { try { l(next); } catch {} });
  return next;
}

export function subscribeProxyConfig(fn) {
  _listeners.push(fn);
  return () => { _listeners = _listeners.filter(l => l !== fn); };
}

/**
 * Apply the proxy/Tor config to the native HTTP stack. Returns true on
 * success, false if the native module isn't installed (config is still
 * saved — applies next launch once the module ships).
 */
export async function applyProxyConfigNative(cfg) {
  if (Platform.OS === 'web') return false; // browser-controlled
  if (!cfg.enabled && !cfg.useTor) {
    // Best-effort disable. Tor stop is idempotent.
    try {
      const Proxy = require('expo-proxy-config');
      if (Proxy?.default?.clear) await Proxy.default.clear();
    } catch {}
    try {
      const Tor = require('expo-tor');
      if (Tor?.default?.stop) await Tor.default.stop();
    } catch {}
    return true;
  }
  let host = cfg.host;
  let port = cfg.port;
  let user = cfg.username || '';
  let pass = cfg.password || '';
  if (cfg.useTor) {
    try {
      const Tor = require('expo-tor');
      if (Tor?.default?.start) await Tor.default.start();
      host = '127.0.0.1';
      port = 9050;
      user = ''; pass = '';
    } catch (e) {
      // Native module missing — bail. User sees the toggle ON but no traffic
      // routes via Tor until they reinstall. Surface via console.warn so QA
      // catches a stale build.
      console.warn('[proxyConfig] expo-tor not installed — Tor toggle ignored');
      return false;
    }
  }
  try {
    const Proxy = require('expo-proxy-config');
    if (Proxy?.default?.applySocks5) {
      await Proxy.default.applySocks5({ host, port, username: user, password: pass });
      return true;
    }
  } catch (e) {
    console.warn('[proxyConfig] expo-proxy-config not installed — proxy ignored', e?.message || e);
  }
  return false;
}

/**
 * Hydrate + apply on app boot. Call once from _layout.js bootstrap so the
 * native stack picks up the saved proxy before any fetch fires.
 */
export async function initProxyConfig() {
  const cfg = await _hydrate();
  if (cfg.enabled || cfg.useTor) {
    await applyProxyConfigNative(cfg);
  }
  return cfg;
}
