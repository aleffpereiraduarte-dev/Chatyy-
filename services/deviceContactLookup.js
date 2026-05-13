/**
 * Lightweight phone→name lookup against the device address book.
 *
 * Why a separate module: the dialer + IncomingCallListener + ActiveCallScreen
 * all need the same "given this E.164 / digit-suffix, what name did the user
 * save in their phone book?" answer. contactSync.js does sync upload (heavy:
 * SHA-256 hash + network call + Apple consent gate). All we need here is a
 * read-only local index, no network, no consent — just a fast last-N-digits
 * suffix match like the native Phone app does.
 *
 * Strategy:
 *   1. Lazy-load device contacts once via expo-contacts (or the iOS native
 *      module if available). Cache in-memory and on disk (AsyncStorage) for
 *      6 h so cold-start isn't blocked.
 *   2. Build a Map<lastNdigits, name> indexed by the last 8 digits of each
 *      phone — handles +55 11 99999-9999 vs 11 99999-9999 vs 55 11 99999-9999.
 *   3. lookupName(input) accepts an E.164 / national / raw digits string and
 *      returns the best match name, or null. Synchronous after init.
 *
 * Edge cases:
 *   - contact has no name → skip (we only index named entries).
 *   - same suffix on multiple contacts → first one wins (rare; user can fix
 *     in Contacts app).
 *   - Brazilian 11-digit DDD+9 vs 10-digit legacy → both forms hit the same
 *     last-8 suffix so they collide harmlessly.
 *   - +55 vs 55 (no plus) → strip non-digits before suffixing.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const CACHE_KEY = '@dialer_contact_index_v1';
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// in-memory: suffix(8 digits) → name
let _index = null;
let _loading = null;

function digits(s) {
  return (s || '').toString().replace(/\D+/g, '');
}

function suffix(d, n = 8) {
  if (!d) return '';
  return d.length > n ? d.slice(-n) : d;
}

function normalizeMobileBR(d) {
  // Brazilian 9th-digit normalization: if 11 digits starting with 2-digit DDD,
  // also key by the legacy 10-digit form (without the leading 9 on the mobile).
  // Helps numbers saved before 2012 reform still match.
  if (d.length === 11 && d[2] === '9') return d.slice(0, 2) + d.slice(3);
  return null;
}

async function loadFromDevice() {
  if (Platform.OS === 'web') return new Map();
  let raw = [];
  // Try native iOS module first (lightweight, no Apple Contacts framework
  // round-trip per call), fall back to expo-contacts on Android.
  if (Platform.OS === 'ios') {
    try {
      const NativeContacts = require('../modules/expo-native-contacts').default;
      const granted = await NativeContacts?.requestContactsPermission?.();
      if (granted) {
        const list = await NativeContacts.getAllContacts();
        raw = (list || []).map(c => ({
          name: c.name || '',
          phones: (c.phones || []).map(p => ({ number: p })),
        }));
      }
    } catch {}
  }
  if (raw.length === 0) {
    try {
      const Contacts = require('expo-contacts');
      const perm = await Contacts.requestPermissionsAsync();
      if (perm?.status === 'granted') {
        const { data } = await Contacts.getContactsAsync({
          fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers, Contacts.Fields.FirstName, Contacts.Fields.LastName],
        });
        raw = (data || []).map(c => ({
          name: (c.name || [c.firstName, c.lastName].filter(Boolean).join(' ') || '').trim(),
          phones: c.phoneNumbers || [],
        }));
      }
    } catch {}
  }
  // Build the suffix → name map.
  const out = new Map();
  for (const c of raw) {
    const name = (c.name || '').trim();
    if (!name) continue;
    for (const p of (c.phones || [])) {
      const num = p?.number || p;
      const d = digits(num);
      if (d.length < 7) continue;
      const k = suffix(d, 8);
      if (!out.has(k)) out.set(k, name);
      // Also key by 10-digit suffix (international roaming users) and the BR
      // 9th-digit variant. We don't overwrite existing — first hit wins.
      if (d.length >= 10) {
        const k10 = suffix(d, 10);
        if (!out.has(k10)) out.set(k10, name);
      }
      const brAlt = normalizeMobileBR(d);
      if (brAlt) {
        const ka = suffix(brAlt, 8);
        if (!out.has(ka)) out.set(ka, name);
      }
    }
  }
  return out;
}

async function loadFromCache() {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.t || Date.now() - parsed.t > CACHE_TTL) return null;
    return new Map(parsed.entries);
  } catch {
    return null;
  }
}

async function saveToCache(map) {
  try {
    const entries = Array.from(map.entries());
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), entries }));
  } catch {}
}

/**
 * Ensure the lookup index is loaded. Safe to call multiple times — concurrent
 * calls share the same in-flight promise. Returns the Map once ready.
 */
export async function ensureContactIndex() {
  if (_index) return _index;
  if (_loading) return _loading;
  _loading = (async () => {
    const cached = await loadFromCache();
    if (cached && cached.size > 0) {
      _index = cached;
      // Refresh in background so a name change in the address book is picked
      // up next session without blocking now.
      loadFromDevice().then(fresh => {
        if (fresh && fresh.size > 0) {
          _index = fresh;
          saveToCache(fresh);
        }
      }).catch(() => {});
      return _index;
    }
    const fresh = await loadFromDevice();
    _index = fresh;
    if (fresh.size > 0) saveToCache(fresh);
    return fresh;
  })();
  try { return await _loading; }
  finally { _loading = null; }
}

/**
 * Synchronous lookup against the in-memory index. Returns the saved contact
 * name for the given phone, or null. Call ensureContactIndex() once at app /
 * screen init so this is hot. Pass anything: '+5511…', '11…', '+1 (555) …'.
 */
export function lookupName(phone) {
  if (!_index || !phone) return null;
  const d = digits(phone);
  if (d.length < 7) return null;
  // Try progressively shorter suffixes. 10 digits first (US/CA full) → 8 (BR
  // mobile sans country code). This handles +5511999998888 saved as
  // 11999998888 in the address book.
  const candidates = [];
  if (d.length >= 10) candidates.push(suffix(d, 10));
  candidates.push(suffix(d, 8));
  // BR alt — drop the 9th digit if 11 digits
  const alt = normalizeMobileBR(d);
  if (alt) candidates.push(suffix(alt, 8));
  for (const k of candidates) {
    if (_index.has(k)) return _index.get(k);
  }
  return null;
}

/**
 * Async sugar: ensures the index is loaded then looks up. Useful for first-
 * shot calls before ensureContactIndex() has been awaited elsewhere.
 */
export async function lookupNameAsync(phone) {
  if (!_index) {
    try { await ensureContactIndex(); } catch { return null; }
  }
  return lookupName(phone);
}

export function clearContactIndex() {
  _index = null;
  AsyncStorage.removeItem(CACHE_KEY).catch(() => {});
}
