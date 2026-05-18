/**
 * vpnDetect.js — VPN / proxy detection for the "Considere usar VPN" banner.
 *
 * Uses @react-native-community/netinfo when present (already in our deps
 * tree via services/networkInfo.js) and falls back to web's NetworkInformation
 * API. NetInfo exposes details.isConnectionExpensive on cellular; on iOS
 * the `details.type === 'vpn'` branch is the canonical answer. Android
 * exposes vpn via ConnectivityManager.NetworkCapabilities.TRANSPORT_VPN.
 *
 * The banner is shown to users who have E2E chats AND no VPN, dismissible,
 * once per month. Dismissal state stored in AsyncStorage.
 */

import { Platform } from 'react-native';

const STORAGE_DISMISS_KEY = 'chatyy_vpn_banner_dismissed_at';
const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function _storageGet(key) {
  return new Promise((resolve) => {
    if (Platform.OS === 'web') {
      try {
        resolve(typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null);
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

/** Returns true if a VPN-like transport is in use right now. */
export async function isVpnActive() {
  try {
    const NetInfo = require('@react-native-community/netinfo')?.default
                 || require('@react-native-community/netinfo');
    const state = await NetInfo.fetch();
    if (state?.type === 'vpn') return true;
    if (state?.details?.isVpn === true) return true;
    if (Array.isArray(state?.details?.transports) && state.details.transports.includes('vpn')) return true;
  } catch {}
  // Web fallback: no reliable way (NetworkInformation doesn't expose VPN
  // transport). Pessimistic default = false; banner may show even when a
  // browser-level VPN is active.
  return false;
}

/** Should we surface the "consider VPN" banner right now? */
export async function shouldShowVpnSuggestion() {
  // 1) Already on a VPN → no need.
  if (await isVpnActive()) return false;
  // 2) Dismissed within the last month → respect user's choice.
  const last = await _storageGet(STORAGE_DISMISS_KEY);
  if (last) {
    const lastMs = parseInt(last, 10);
    if (Number.isFinite(lastMs) && Date.now() - lastMs < ONE_MONTH_MS) return false;
  }
  return true;
}

export async function dismissVpnSuggestion() {
  await _storageSet(STORAGE_DISMISS_KEY, String(Date.now()));
}
