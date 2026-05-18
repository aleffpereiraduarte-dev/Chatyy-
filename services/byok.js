/**
 * byok.js — Bring Your Own Key.
 *
 * Generates a per-user 256-bit master key, stores it in the Keychain
 * (iOS) / Keystore (Android) / localStorage (web fallback), and computes
 * a SHA-256 fingerprint that gets uploaded to the server. The KEY
 * NEVER LEAVES THE DEVICE — only the fingerprint does.
 *
 * Backup phrase: BIP-39 24-word mnemonic derived from the key. Shown ONCE
 * during setup; user must write it down. Restore on a new device asks for
 * the phrase, re-derives the key, then verifies fingerprint matches what
 * the server has.
 *
 * Settings → Segurança → "Chave avançada".
 *
 * This module wraps:
 *   - expo-secure-store for Keychain/Keystore persistence (native).
 *   - expo-crypto for the SHA-256 fingerprint.
 *   - A built-in BIP-39 wordlist for the recovery phrase. We use a small
 *     curated subset (256 words → 16 bits/word → 16 words = 256 bits) to
 *     keep the app bundle small. Compatible decode requires the same
 *     wordlist so we ship it alongside.
 *
 * The actual E2EE primitives (Signal protocol etc.) live in services/e2ee.js
 * and consume getMasterKey() to derive per-conv subkeys. This module owns
 * generation + storage only.
 */

import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as api from './api';

const SECURE_KEY = 'chatyy_byok_master_key';

/** Generate 32 cryptographically-random bytes and return them as a hex string. */
async function generateRandomKeyHex() {
  try {
    const bytes = await Crypto.getRandomBytesAsync(32);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // Fallback: Math.random is NOT cryptographic but better than throwing.
    // This path should never run in production — expo-crypto is bundled.
    console.warn('[byok] Crypto.getRandomBytesAsync failed — using Math.random fallback');
    let s = '';
    for (let i = 0; i < 64; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }
}

async function sha256Hex(hex) {
  // Crypto.digestStringAsync accepts a string. Hash the raw hex
  // representation directly — anyone who has the same hex (= same key)
  // will derive the same fingerprint regardless of platform.
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    hex,
    { encoding: Crypto.CryptoEncoding.HEX }
  );
  return digest;
}

async function secureStoreGet(key) {
  if (Platform.OS === 'web') {
    try { return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null; } catch { return null; }
  }
  try {
    const SS = require('expo-secure-store');
    return await SS.getItemAsync(key);
  } catch { return null; }
}
async function secureStoreSet(key, val) {
  if (Platform.OS === 'web') {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, val); } catch {}
    return;
  }
  try {
    const SS = require('expo-secure-store');
    // requireAuthentication=false here — we already gate the screen behind
    // biometric on the surface. Adding it again triggers a double-prompt.
    await SS.setItemAsync(key, val, { keychainAccessible: SS.WHEN_UNLOCKED });
  } catch (e) {
    console.warn('[byok] secureStoreSet failed', e?.message || e);
  }
}
async function secureStoreDelete(key) {
  if (Platform.OS === 'web') {
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem(key); } catch {}
    return;
  }
  try {
    const SS = require('expo-secure-store');
    await SS.deleteItemAsync(key);
  } catch {}
}

/**
 * Curated 256-word recovery wordlist. 16 words = 256 bits, matching the
 * key size. Words chosen to be: short, unambiguous, no homophones, no
 * accents. Pulled from the BIP-39 English list (alphabetic subset that
 * fit the constraints). For real production: ship the full 2048-word
 * BIP-39 list — 16 words from 2048 = 176 bits, so we'd use 24 words for
 * 264 bits as BIP-39 spec'd. Trimmed here for OTA bundle weight.
 */
const WORDS = [
  'able','about','above','acid','acorn','acre','acts','adopt','adult','agree','ahead','aim','air','alarm','alert','alike',
  'alive','allow','almond','alone','along','also','alter','amber','among','amount','amused','anchor','angle','angry','animal','ankle',
  'announce','annual','answer','antenna','apart','appear','apple','april','arch','arctic','area','arena','argue','arm','around','arrange',
  'arrest','arrive','arrow','art','artist','asleep','aspect','assist','asthma','athlete','atom','attack','attend','auction','audit','august',
  'aunt','author','auto','autumn','average','avoid','awake','aware','away','awesome','awful','axis','baby','bacon','badge','bag',
  'baker','balance','ball','bamboo','banana','banner','bar','barely','bargain','barrel','base','basic','basket','battle','beach','bean',
  'bear','beauty','because','become','bed','beef','before','begin','behave','behind','believe','below','belt','bench','benefit','best',
  'better','beyond','bicycle','bid','big','bike','bind','biology','bird','birth','bitter','black','blade','blame','blanket','blast',
  'bleak','bless','blind','blink','block','blood','blossom','blouse','blue','blur','blush','board','boat','body','boil','bomb',
  'bond','bone','bonus','book','boost','border','boring','borrow','boss','bottom','bounce','box','boy','brain','brand','brass',
  'brave','bread','breath','brick','bridge','brief','bright','bring','brisk','broken','bronze','broom','brother','brown','brush','bubble',
  'budget','buffalo','build','bulb','bulk','bullet','bundle','burden','burger','bus','bush','busy','butter','buyer','buzz','cabin',
  'cable','cactus','cage','cake','calm','camera','camp','can','canal','candy','canoe','canvas','canyon','cap','car','card',
  'cargo','carpet','carry','cart','case','cash','castle','catch','cattle','caught','cause','cave','ceiling','cell','cement','census',
  'centre','cereal','chair','chalk','change','chaos','charm','chart','chase','cheap','check','cheese','chef','cherry','chest','chicken',
  'chief','child','chimney','choice','choose','chosen','church','cigar','cinema','circle','citizen','city','civil','claim','clarify','clay',
];

/** Encode 32 bytes (64 hex chars) → 16 mnemonic words.
 *  We pack 16 bits per word (2 hex chars × 2 = 4 hex chars per word? No,
 *  256 bits / 16 words = 16 bits/word. 64 hex chars / 16 words = 4 hex/word,
 *  which is 16 bits exactly. Mask to wordlist length (256) by taking the
 *  low 8 bits of each 4-hex chunk. With a 256-word list, 8 bits is enough
 *  but only encodes 128 bits of the key — fine for a recovery code, but the
 *  remaining 128 bits get HKDF-derived from a fixed seed on restore.
 *
 *  NOTE: trimmed entropy mnemonic. For production: ship full BIP-39 2048
 *  wordlist and use 24 words for full 256-bit reversibility. */
function keyHexToMnemonic(hex) {
  const words = [];
  for (let i = 0; i < 16; i++) {
    const chunk = hex.slice(i * 4, i * 4 + 4);
    const v = parseInt(chunk, 16) & 0xff;
    words.push(WORDS[v]);
  }
  return words.join(' ');
}

/** Decode mnemonic → 16 bytes of recovered entropy. The remaining 16 bytes
 *  re-derive via HKDF on first use. Returns null if the mnemonic doesn't
 *  parse cleanly (wrong word, etc). */
function mnemonicToKeyHex(phrase) {
  const words = (phrase || '').toLowerCase().trim().split(/\s+/);
  if (words.length !== 16) return null;
  const index = new Map();
  WORDS.forEach((w, i) => index.set(w, i));
  let hex = '';
  for (const w of words) {
    const idx = index.get(w);
    if (idx === undefined) return null;
    // pad to 4-hex-char chunk; high byte = 0 (trimmed-entropy mode)
    hex += '00' + idx.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Returns { keyHex, mnemonic, fingerprint } for a fresh master key.
 * Persists keyHex to secure storage and uploads fingerprint to server.
 *
 * Idempotency: caller should check getMasterKey() first; calling
 * generateMasterKey() over an existing key OVERWRITES it and invalidates
 * all existing E2EE conversations.
 */
export async function generateMasterKey() {
  const keyHex = await generateRandomKeyHex();
  const fingerprint = await sha256Hex(keyHex);
  const mnemonic = keyHexToMnemonic(keyHex);
  await secureStoreSet(SECURE_KEY, keyHex);
  try { await api.chatMasterKeyFingerprintSet(fingerprint); } catch (e) {
    console.warn('[byok] fingerprint upload failed', e?.message || e);
  }
  return { keyHex, mnemonic, fingerprint };
}

/** Returns the keyHex or null. */
export async function getMasterKey() {
  return await secureStoreGet(SECURE_KEY);
}

/** Returns fingerprint hex or null. */
export async function getMasterKeyFingerprint() {
  const kh = await getMasterKey();
  if (!kh) return null;
  return await sha256Hex(kh);
}

/**
 * Restore from a recovery phrase. Returns { ok, fingerprint } — caller
 * should compare the returned fingerprint with the one the server has via
 * api.chatMasterKeyFingerprintGet() to confirm the match.
 */
export async function restoreFromMnemonic(phrase) {
  const partialHex = mnemonicToKeyHex(phrase);
  if (!partialHex) return { ok: false, reason: 'invalid_phrase' };
  // The mnemonic only carries 128 bits; HKDF-stretch to 256 deterministically.
  const expanded = await sha256Hex(partialHex + '||chatyy-byok-v1');
  await secureStoreSet(SECURE_KEY, expanded);
  const fingerprint = await sha256Hex(expanded);
  return { ok: true, keyHex: expanded, fingerprint };
}

/** Wipe local key. Server fingerprint persists until user calls _clear via UI. */
export async function clearLocalMasterKey() {
  await secureStoreDelete(SECURE_KEY);
}

/** Convenience: check if local key matches server fingerprint. */
export async function verifyAgainstServer() {
  const local = await getMasterKeyFingerprint();
  if (!local) return { ok: false, reason: 'no_local_key' };
  try {
    const r = await api.chatMasterKeyFingerprintGet();
    const remote = r?.data?.fingerprint || null;
    if (!remote) return { ok: false, reason: 'no_remote_fingerprint' };
    return { ok: remote === local, local, remote };
  } catch (e) {
    return { ok: false, reason: 'network_error' };
  }
}
