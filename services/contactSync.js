import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { apiCall } from './api';

const CACHE_KEY = '@chatyy_synced_contacts';
const CACHE_TTL = 60 * 60 * 1000; // 1 hour in milliseconds

/**
 * Normalize a phone number by stripping formatting characters and
 * common country code prefixes so that duplicates can be detected.
 */
function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  // Strip everything that isn't a digit or leading +
  let cleaned = phone.replace(/[\s\-().]/g, '');
  // Remove leading + and common country codes (55 for BR, 1 for US)
  if (cleaned.startsWith('+')) {
    cleaned = cleaned.slice(1);
  }
  // Remove leading country code 55 (Brazil) if number is long enough
  if (cleaned.startsWith('55') && cleaned.length >= 12) {
    cleaned = cleaned.slice(2);
  }
  // Remove leading country code 1 (US/CA) if number is long enough
  if (cleaned.startsWith('1') && cleaned.length === 11) {
    cleaned = cleaned.slice(1);
  }
  return cleaned;
}

/**
 * Extract unique emails and phone numbers from raw device contacts.
 * Returns { emailMap, phoneMap, contactsByIdentifier } where the maps
 * go from normalised value -> contact info for deduplication.
 */
function extractContactData(rawContacts) {
  // email -> { name, phone, email }
  const emailMap = new Map();
  // normalizedPhone -> { name, phone (original), email }
  const phoneMap = new Map();

  for (const contact of rawContacts) {
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || 'Unknown';

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
 * Sync phone contacts with the OneMundo Mail backend.
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
export async function syncContacts(forceRefresh = false) {
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

    // Dynamically import expo-contacts to avoid crash on web
    const Contacts = await import('expo-contacts');

    // Request permission
    const { status } = await Contacts.requestPermissionsAsync();
    if (status !== 'granted') {
      return { chatyContacts: [], otherContacts: [], error: 'permission_denied' };
    }

    // Fetch all contacts that have at least a phone or email
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

    // Deduplicate and extract
    const { emailMap, phoneMap } = extractContactData(rawContacts);

    const uniqueEmails = Array.from(emailMap.keys());
    const uniquePhones = Array.from(phoneMap.keys());

    // Nothing to check
    if (uniqueEmails.length === 0 && uniquePhones.length === 0) {
      const empty = { chatyContacts: [], otherContacts: [], timestamp: Date.now() };
      await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(empty));
      return { chatyContacts: [], otherContacts: [], error: null };
    }

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
        if (reg.phone) registeredPhones.add(normalizePhone(reg.phone));

        // Merge backend info with local contact info
        const localByEmail = reg.email ? emailMap.get(reg.email.toLowerCase()) : null;
        const localByPhone = reg.phone ? phoneMap.get(normalizePhone(reg.phone)) : null;
        const local = localByEmail || localByPhone || {};

        chatyContacts.push({
          email: reg.email || local.email || '',
          name: reg.name || local.name || 'Unknown',
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
      if (!registeredPhones.has(normalized)) {
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
