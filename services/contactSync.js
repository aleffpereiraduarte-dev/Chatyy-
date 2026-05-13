import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert, Platform, Linking } from 'react-native';
import { apiCall, chatSyncContacts } from './api';

const CACHE_KEY = '@chatyy_synced_contacts';
const CACHE_TTL = 60 * 60 * 1000; // 1 hour in milliseconds
const CONSENT_KEY = '@chatyy_contacts_consent_v1'; // 'granted' | 'denied' | undefined

// In-memory mirror of the persisted consent state. Avoids re-prompting the
// user inside the same session when AsyncStorage hasn't flushed yet (race
// between dismiss tap → resolve → next ensureContactsConsent call). Set
// synchronously the moment the user makes a choice or dismisses.
let _consentMemory = null;

// Apple App Store guideline 5.1.2 requires an in-app disclosure before
// the iOS permission prompt fires, explaining what data leaves the device
// and why. We persist the user's choice so we don't re-ask on every entry
// to chat-new (only after explicit revoke or app reinstall).
//
// Returns true if the user agreed (or had previously agreed) to upload
// hashed contact identifiers to the server. Returns false on dismissal or
// 'denied'. Does NOT trigger the iOS contacts permission prompt — caller
// is expected to do that *after* this returns true.
export async function ensureContactsConsent(t) {
  if (Platform.OS === 'web') return false;
  // In-memory short-circuit covers two cases that AsyncStorage cannot: (a) a
  // pending write hasn't flushed yet between rapid re-mounts, (b) the user
  // dismissed by tapping outside / back button, which used to bypass the
  // persistence step entirely and re-prompted on every chat-new mount.
  if (_consentMemory === 'granted') return true;
  if (_consentMemory === 'denied') return false;
  let saved = null;
  try { saved = await AsyncStorage.getItem(CONSENT_KEY); } catch {}
  if (saved === 'granted') { _consentMemory = 'granted'; return true; }
  if (saved === 'denied')  { _consentMemory = 'denied';  return false; }
  return await new Promise((resolve) => {
    const _t = typeof t === 'function' ? t : () => '';
    const title = _t('contactsConsent.title') || 'Encontrar amigos no Chatyy';
    const body =
      _t('contactsConsent.body') ||
      'Pra te mostrar quais amigos já estão no Chatyy, vamos enviar os números e emails dos seus contatos pro nosso servidor de forma criptografada (hash SHA-256). Os contatos não ficam armazenados depois da consulta e nunca são compartilhados com ninguém. Você pode revogar a qualquer momento em Configurações.';
    const cta = _t('contactsConsent.continue') || 'Continuar';
    const cancel = _t('common.notNow') || 'Agora não';
    let settled = false;
    const settle = (state, value) => {
      if (settled) return;
      settled = true;
      _consentMemory = state;
      AsyncStorage.setItem(CONSENT_KEY, state).catch(() => {});
      resolve(value);
    };
    Alert.alert(title, body, [
      { text: cancel, style: 'cancel', onPress: () => settle('denied', false) },
      { text: cta, onPress: () => settle('granted', true) },
    ], { cancelable: true, onDismiss: () => settle('denied', false) });
  });
}

export async function revokeContactsConsent() {
  _consentMemory = 'denied';
  try { await AsyncStorage.setItem(CONSENT_KEY, 'denied'); } catch {}
  try { await AsyncStorage.removeItem(CACHE_KEY); } catch {}
}

export async function getContactsConsentState() {
  if (_consentMemory) return _consentMemory;
  try { return await AsyncStorage.getItem(CONSENT_KEY); } catch { return null; }
}

// Normalize a phone to E.164 for hashing. Input is the raw device value;
// output is the same shape we use on the server (plus sign + digits).
// Exported so signup / phone-verify can reuse the same canonical form.
export function toE164(phone) {
  if (!phone || typeof phone !== 'string') return '';
  const digits = phone.replace(/\D+/g, '').replace(/^0+/, '');
  if (!digits) return '';
  return '+' + digits;
}

// SHA-256 hex of a string, using Web Crypto when available (RN ships it via
// expo-crypto polyfill) and falling back to a small WordArray-free
// implementation that only needs TextEncoder + subtle.digest.
async function sha256Hex(str) {
  try {
    const enc = new TextEncoder().encode(str);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // Fallback: expo-crypto if subtle is missing (old RN runtimes).
    try {
      const { digestStringAsync, CryptoDigestAlgorithm } = require('expo-crypto');
      return await digestStringAsync(CryptoDigestAlgorithm.SHA256, str);
    } catch {
      return '';
    }
  }
}

/**
 * Privacy-preserving variant of syncContacts that ONLY sends SHA-256 hashes of
 * E.164 phone numbers to the server. Server matches them against the registry
 * and records the lookup so later-joining users trigger a `contact_joined` WS
 * event. WhatsApp-style discovery.
 *
 * Returns { matches: [{ phone_hash, email, name }], error }.
 */
export async function syncContactsHashed(phoneList = []) {
  if (!Array.isArray(phoneList) || phoneList.length === 0) return { matches: [], error: null };
  // Apple 5.1.2: only upload after the user explicitly consented. The
  // disclosure modal is shown by ensureContactsConsent() during the main
  // syncContacts() flow; if syncContactsHashed is called directly without
  // that flow having run first, we silently no-op until consent exists.
  const saved = await getContactsConsentState();
  if (saved !== 'granted') return { matches: [], error: 'consent_required' };
  const uniqueE164 = Array.from(new Set(phoneList.map(toE164).filter(Boolean)));
  if (uniqueE164.length === 0) return { matches: [], error: null };
  // Hash client-side. Cap at 5000 to match server guard. We keep a
  // hash → E.164 map so callers can later resolve a matched hash back to the
  // number AND (if they have the phonebook row) to the locally-saved name.
  const hashes = [];
  const hashToPhone = {};
  for (const p of uniqueE164.slice(0, 5000)) {
    const h = await sha256Hex(p);
    if (h) { hashes.push(h); hashToPhone[h] = p; }
  }
  if (hashes.length === 0) return { matches: [], error: null };
  try {
    const r = await chatSyncContacts(hashes);
    if (!r?.success) return { matches: [], error: r?.message || 'sync_failed' };
    const matches = (r.data?.matches || []).map(m => ({
      ...m,
      phone: hashToPhone[m.phone_hash] || null,
    }));
    return { matches, hashToPhone, error: null };
  } catch (e) {
    return { matches: [], error: e?.message || 'sync_error' };
  }
}

/**
 * Map-builder that resolves a matched Chatyy user to the name the current
 * user saved in their phone book. Falls back to Chatyy profile name if the
 * phonebook didn't expose a label. Returns Map<phone_hash, localName>.
 *
 * rawContacts — array of expo-contacts rows with { name, phoneNumbers: [{number}] }
 */
export async function buildHashToLocalNameMap(rawContacts = []) {
  const out = new Map();
  for (const c of rawContacts) {
    const name = (c?.name || [c?.firstName, c?.lastName].filter(Boolean).join(' ')).trim();
    if (!name) continue;
    const nums = (c?.phoneNumbers || []).map(p => p?.number || '').filter(Boolean);
    for (const num of nums) {
      const e164 = toE164(num);
      if (!e164) continue;
      const h = await sha256Hex(e164);
      if (h) out.set(h, name);
    }
  }
  return out;
}

/**
 * Register the current user's verified phone in the registry so others can
 * discover them via hash lookup. Hash happens client-side.
 */
export async function registerOwnPhone(phone) {
  const e164 = toE164(phone);
  if (!e164) return { ok: false, error: 'invalid_phone' };
  const hash = await sha256Hex(e164);
  if (!hash) return { ok: false, error: 'hash_failed' };
  try {
    const { chatRegisterPhone } = require('./api');
    const r = await chatRegisterPhone(hash);
    return { ok: !!r?.success, notified: !!r?.data?.notified_waiters };
  } catch (e) {
    return { ok: false, error: e?.message || 'register_failed' };
  }
}

/**
 * Normalize a phone number by stripping formatting characters and
 * common country code prefixes so that duplicates can be detected.
 */
function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  // Strip everything that isn't a digit
  let cleaned = phone.replace(/\D/g, '');
  // Remove leading zeros
  cleaned = cleaned.replace(/^0+/, '');
  // Remove leading country code 55 (Brazil) if number is long enough
  if (cleaned.startsWith('55') && cleaned.length >= 12) {
    cleaned = cleaned.slice(2);
  }
  // Remove leading country code 1 (US/CA) if number is 11 digits
  if (cleaned.startsWith('1') && cleaned.length === 11) {
    cleaned = cleaned.slice(1);
  }
  return cleaned;
}

/**
 * Get all normalized variants of a Brazilian phone number
 * (with and without the 9th digit prefix).
 */
function phoneVariants(normalized) {
  const variants = [normalized];
  // 11 digits = DD + 9 + 8 digits → also try without 9th digit
  if (normalized.length === 11) {
    variants.push(normalized.slice(0, 2) + normalized.slice(3));
  }
  // 10 digits = DD + 8 digits → also try with 9th digit
  if (normalized.length === 10) {
    variants.push(normalized.slice(0, 2) + '9' + normalized.slice(2));
  }
  return variants;
}

/**
 * Extract unique emails and phone numbers from raw device contacts
 * returned by the legacy expo-contacts module (Android fallback).
 * Returns { emailMap, phoneMap } where the maps
 * go from normalised value -> contact info for deduplication.
 */
function extractContactData(rawContacts) {
  // email -> { name, phone, email }
  const emailMap = new Map();
  // normalizedPhone -> { name, phone (original), email }
  const phoneMap = new Map();

  for (const contact of rawContacts) {
    // Android costuma só preencher contact.name (composto); iOS preenche
    // firstName/lastName. Usar primeiro o composto pra não cair em "Unknown".
    const name = (
      contact.name
      || [contact.firstName, contact.lastName].filter(Boolean).join(' ')
    ).trim() || 'Unknown';

    // Collect emails
    if (contact.emails && contact.emails.length > 0) {
      for (const emailEntry of contact.emails) {
        const email = (emailEntry.email || '').trim().toLowerCase();
        if (email && !emailMap.has(email)) {
          // Also grab the first phone if available
          const firstPhone = (contact.phoneNumbers && contact.phoneNumbers.length > 0)
            ? contact.phoneNumbers[0].number || ''
            : '';
          emailMap.set(email, { name, email, phone: firstPhone });
        }
      }
    }

    // Collect phones
    if (contact.phoneNumbers && contact.phoneNumbers.length > 0) {
      for (const phoneEntry of contact.phoneNumbers) {
        const original = (phoneEntry.number || '').trim();
        const normalized = normalizePhone(original);
        if (normalized && !phoneMap.has(normalized)) {
          const firstEmail = (contact.emails && contact.emails.length > 0)
            ? (contact.emails[0].email || '').trim().toLowerCase()
            : '';
          phoneMap.set(normalized, { name, phone: original, email: firstEmail });
        }
      }
    }
  }

  return { emailMap, phoneMap };
}

/**
 * Extract unique emails and phone numbers from native contacts
 * returned by ExpoNativeContacts (array of { name, emails[], phones[] }).
 */
function extractNativeContactData(nativeContacts) {
  const emailMap = new Map();
  const phoneMap = new Map();

  for (const contact of nativeContacts) {
    const name = contact.name || 'Unknown';
    const emails = contact.emails || [];
    const phones = contact.phones || [];

    for (const email of emails) {
      const lower = (email || '').trim().toLowerCase();
      if (lower && !emailMap.has(lower)) {
        const firstPhone = phones.length > 0 ? phones[0] : '';
        emailMap.set(lower, { name, email: lower, phone: firstPhone });
      }
    }

    for (const phone of phones) {
      const original = (phone || '').trim();
      const normalized = normalizePhone(original);
      if (normalized && !phoneMap.has(normalized)) {
        const firstEmail = emails.length > 0 ? (emails[0] || '').trim().toLowerCase() : '';
        phoneMap.set(normalized, { name, phone: original, email: firstEmail });
      }
    }
  }

  return { emailMap, phoneMap };
}

/**
 * Try to load the native contacts module (iOS only).
 * Returns the module or null if unavailable.
 */
function getNativeContactsModule() {
  if (Platform.OS !== 'ios') return null;
  try {
    return require('../modules/expo-native-contacts').default;
  } catch {
    return null;
  }
}

/**
 * Sync phone contacts with the Chatyy backend.
 *
 * On iOS, uses the native ExpoNativeContacts module (CNContactStore)
 * for better performance and reliability. Falls back to expo-contacts
 * on Android or if the native module is unavailable.
 *
 * Requests contact permission, reads the device address book,
 * sends emails/phones to the backend to check which are registered,
 * and returns results split into chatyContacts vs otherContacts.
 *
 * Results are cached in AsyncStorage for 1 hour.
 *
 * @param {boolean} forceRefresh - bypass the cache TTL
 * @returns {{ chatyContacts: Array, otherContacts: Array, error: string|null }}
 */
export async function syncContacts(forceRefresh = false, t) {
  // Web has no contacts API
  if (Platform.OS === 'web') {
    return { chatyContacts: [], otherContacts: [], error: null };
  }

  try {
    // Check cache first (unless forced)
    if (!forceRefresh) {
      const cached = await getCachedContacts();
      if (cached) {
        return { chatyContacts: cached.chatyContacts, otherContacts: cached.otherContacts, error: null };
      }
    }

    // Apple guideline 5.1.2: get explicit user consent BEFORE the iOS
    // permission prompt and BEFORE any contacts data leaves the device.
    // Saved across app launches so users only see this once.
    const consented = await ensureContactsConsent(t);
    if (!consented) {
      return { chatyContacts: [], otherContacts: [], error: 'consent_denied' };
    }

    // Try native module first (iOS)
    const NativeContacts = getNativeContactsModule();

    let emailMap, phoneMap;

    if (NativeContacts) {
      // ─── Native path (iOS): CNContactStore via Swift ────────────
      const granted = await NativeContacts.requestContactsPermission();
      if (!granted) {
        console.warn('[contactSync] native permission denied');
        return { chatyContacts: [], otherContacts: [], error: 'permission_denied' };
      }

      const nativeContacts = await NativeContacts.getAllContacts();

      if (!nativeContacts || nativeContacts.length === 0) {
        const empty = { chatyContacts: [], otherContacts: [], timestamp: Date.now() };
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(empty));
        return { chatyContacts: [], otherContacts: [], error: null };
      }

      ({ emailMap, phoneMap } = extractNativeContactData(nativeContacts));
    } else {
      // ─── Fallback path (Android / missing native module) ────────
      let Contacts;
      try {
        Contacts = require('expo-contacts');
      } catch (e) {
        console.warn('[contactSync] expo-contacts module unavailable:', e?.message);
        return { chatyContacts: [], otherContacts: [], error: 'module_unavailable: ' + (e?.message || 'unknown') };
      }

      const permRes = await Contacts.requestPermissionsAsync();
      if (permRes?.status !== 'granted') {
        console.warn('[contactSync] permission status:', permRes?.status);
        return { chatyContacts: [], otherContacts: [], error: 'permission_denied' };
      }

      const { data: rawContacts } = await Contacts.getContactsAsync({
        fields: [
          Contacts.Fields.Emails,
          Contacts.Fields.PhoneNumbers,
          Contacts.Fields.FirstName,
          Contacts.Fields.LastName,
        ],
      });

      if (!rawContacts || rawContacts.length === 0) {
        const empty = { chatyContacts: [], otherContacts: [], timestamp: Date.now() };
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(empty));
        return { chatyContacts: [], otherContacts: [], error: null };
      }

      ({ emailMap, phoneMap } = extractContactData(rawContacts));
    }

    const uniqueEmails = Array.from(emailMap.keys());
    const uniquePhones = Array.from(phoneMap.keys());

    // Nothing to check
    if (uniqueEmails.length === 0 && uniquePhones.length === 0) {
      const empty = { chatyContacts: [], otherContacts: [], timestamp: Date.now() };
      await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(empty));
      return { chatyContacts: [], otherContacts: [], error: null };
    }

    // Fire-and-forget: hash and upload phone numbers for reverse-discovery.
    // This is what lets "contact_joined" WS events fire when someone you had
    // in your contacts joins Chatyy later. Kept non-blocking so the legacy
    // check_contacts path (below) still returns quickly even when hashing is
    // slow on low-end devices.
    // Usa o número original com DDI (phoneMap.values()) — antes mandava as
    // chaves normalizadas sem DDI e os hashes não batiam com o servidor.
    try {
      const phonesForHash = Array.from(phoneMap.values()).map(v => v?.phone).filter(Boolean);
      syncContactsHashed(phonesForHash).catch(() => {});
    } catch {}

    // Ask the backend which contacts are registered
    const result = await apiCall('check_contacts', {
      emails: uniqueEmails,
      phones: uniquePhones,
    }, 'POST');

    // If API call failed, don't overwrite cache with bad data
    if (!result || result.error) {
      console.warn('[contactSync] check_contacts failed:', result?.error || 'no response');
      const raw = await AsyncStorage.getItem(CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        return { chatyContacts: cached.chatyContacts || [], otherContacts: cached.otherContacts || [], error: result?.error || 'api_failed' };
      }
      return { chatyContacts: [], otherContacts: [], error: result?.error || 'api_failed' };
    }

    // Build registered set for fast lookup
    const registeredEmails = new Set();
    const registeredPhones = new Set();
    const chatyContacts = [];

    if (result && result.registered) {
      for (const reg of result.registered) {
        if (reg.email) registeredEmails.add(reg.email.toLowerCase());
        if (reg.phone) {
          const norm = normalizePhone(reg.phone);
          registeredPhones.add(norm);
          // Also add variants (with/without 9th digit)
          for (const v of phoneVariants(norm)) registeredPhones.add(v);
        }

        // Merge backend info with local contact info
        const localByEmail = reg.email ? emailMap.get(reg.email.toLowerCase()) : null;
        let localByPhone = null;
        if (reg.phone) {
          const norm = normalizePhone(reg.phone);
          localByPhone = phoneMap.get(norm);
          if (!localByPhone) {
            for (const v of phoneVariants(norm)) {
              localByPhone = phoneMap.get(v);
              if (localByPhone) break;
            }
          }
        }
        const local = localByEmail || localByPhone || {};

        chatyContacts.push({
          email: reg.email || local.email || '',
          name: local.name || reg.name || 'Unknown',
          phone: local.phone || reg.phone || '',
          avatar: reg.avatar || null,
          isRegistered: true,
        });
      }
    }

    // Build otherContacts from contacts not found in registered set
    const otherContacts = [];
    const addedOther = new Set(); // avoid duplicates in output

    for (const [email, info] of emailMap) {
      if (!registeredEmails.has(email)) {
        const key = email;
        if (!addedOther.has(key)) {
          addedOther.add(key);
          otherContacts.push({
            name: info.name,
            email: info.email,
            phone: info.phone,
            isRegistered: false,
          });
        }
      }
    }

    for (const [normalized, info] of phoneMap) {
      // Check all phone variants (with/without 9th digit)
      const isRegistered = phoneVariants(normalized).some(v => registeredPhones.has(v));
      if (!isRegistered) {
        // Only add if we haven't already added this contact via email
        const emailLower = (info.email || '').toLowerCase();
        if (emailLower && registeredEmails.has(emailLower)) continue;
        if (emailLower && addedOther.has(emailLower)) continue;

        const key = normalized;
        if (!addedOther.has(key)) {
          addedOther.add(key);
          otherContacts.push({
            name: info.name,
            email: info.email,
            phone: info.phone,
            isRegistered: false,
          });
        }
      }
    }

    // Sort alphabetically
    chatyContacts.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    otherContacts.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // Cache
    const cacheData = { chatyContacts, otherContacts, timestamp: Date.now() };
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(cacheData));

    return { chatyContacts, otherContacts, error: null };
  } catch (err) {
    console.warn('[contactSync] syncContacts error:', err);
    // Try to return stale cache on error
    try {
      const raw = await AsyncStorage.getItem(CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        return {
          chatyContacts: cached.chatyContacts || [],
          otherContacts: cached.otherContacts || [],
          error: 'sync_failed',
        };
      }
    } catch (_) {
      // ignore cache read failure
    }
    return { chatyContacts: [], otherContacts: [], error: 'sync_failed' };
  }
}

/**
 * Return cached contacts if the cache exists and is still fresh (< 1 hour old).
 * Returns null if there is no cache or it has expired.
 *
 * @returns {{ chatyContacts: Array, otherContacts: Array, timestamp: number } | null}
 */
export async function getCachedContacts() {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;

    const cached = JSON.parse(raw);
    if (!cached || !cached.timestamp) return null;

    const age = Date.now() - cached.timestamp;
    if (age > CACHE_TTL) return null;

    return {
      chatyContacts: cached.chatyContacts || [],
      otherContacts: cached.otherContacts || [],
      timestamp: cached.timestamp,
    };
  } catch (err) {
    console.warn('[contactSync] getCachedContacts error:', err);
    return null;
  }
}

/**
 * Clear the synced contacts cache from AsyncStorage.
 */
export async function clearContactsCache() {
  try {
    await AsyncStorage.removeItem(CACHE_KEY);
  } catch (err) {
    console.warn('[contactSync] clearContactsCache error:', err);
  }
}
