// [2026-10-10] Gate for the native Swift chat cache (modules/expo-chat-cache).
//
// The chat screen disabled it (`_NativeChatCache = null`) after its FTS5
// triggers corrupted the external-content index under INSERT OR REPLACE and
// crashed the process natively. The Swift module now ships schema 2 (no
// messages_fts, no triggers, LIKE search) and exposes getSchemaVersionSync().
//
// Returns the module ONLY when ALL hold:
//   - iOS (the Android module is a different, never-validated implementation),
//   - NATIVE_CHAT_CACHE_ENABLED (or globalThis.__chatyy_native_chat_cache = true),
//   - the installed binary reports schema >= MIN_SCHEMA (old binaries still
//     have the crashing triggers → always null, even if the flag is flipped
//     by OTA).
// Never throws.
import { Platform } from 'react-native';
import { NATIVE_CHAT_CACHE_ENABLED } from '../constants/featureFlags';

export const NATIVE_CHAT_CACHE_MIN_SCHEMA = 2;

let _mod; // undefined = not resolved yet; null = unavailable/unsafe

function _flagOn() {
  try {
    const o = typeof globalThis !== 'undefined' ? globalThis.__chatyy_native_chat_cache : undefined;
    if (o === true || o === false) return o;
  } catch {}
  return NATIVE_CHAT_CACHE_ENABLED === true;
}

function _resolveSafeModule() {
  if (_mod !== undefined) return _mod;
  _mod = null;
  try {
    // requireOptionalNativeModule inside → null instead of throwing.
    const m = require('../modules/expo-chat-cache').default;
    if (!m || typeof m.getSchemaVersionSync !== 'function') return _mod;
    const v = Number(m.getSchemaVersionSync());
    if (Number.isFinite(v) && v >= NATIVE_CHAT_CACHE_MIN_SCHEMA) _mod = m;
  } catch { _mod = null; }
  return _mod;
}

export function getNativeChatCache() {
  try {
    if (Platform.OS !== 'ios') return null;
    if (!_flagOn()) return null;
    return _resolveSafeModule();
  } catch { return null; }
}

// True when the installed binary is FTS-free (diagnostics / QA screen).
export function isNativeChatCacheBinarySafe() {
  try { return Platform.OS === 'ios' && !!_resolveSafeModule(); } catch { return false; }
}
