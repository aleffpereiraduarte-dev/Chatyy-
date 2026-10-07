// [2026-10-07 welcome] Per-account first-run ("welcome to Chatyy") gating.
//
// The first-run flow (components/onboarding/FirstRunFlow.js) runs ONCE PER
// ACCOUNT, right after signup / first login, on the chat list. State lives in
// AsyncStorage under `chatyy_firstrun_v1:<email>`:
//   { status: 'pending', step: '<stepId>', at }   → show / resume at `step`
//   { status: 'done', reason, at }                → never show again
//
// Who is eligible when no state exists yet (fresh install, or an existing
// account that just got this OTA): we ask the server for the conversation
// list. 0 real conversations (Saved Messages doesn't count) → new account →
// 'pending'. Any conversation → existing user → silently 'done' (they never
// see it). A failed fetch decides nothing (re-evaluated next mount).
// Signup screens MAY call markFreshSignup(email) to force it explicitly.
//
// Kill switches: FIRST_RUN_ENABLED below (OTA) or globalThis.__chatyy_firstrun = false.
import AsyncStorage from '@react-native-async-storage/async-storage';

export const FIRST_RUN_ENABLED = true;
const KEY = 'chatyy_firstrun_v1:';

function _k(email) {
  return KEY + String(email || '').trim().toLowerCase();
}

async function _read(email) {
  try {
    const raw = await AsyncStorage.getItem(_k(email));
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

async function _write(email, v) {
  try { await AsyncStorage.setItem(_k(email), JSON.stringify({ ...v, at: Date.now() })); } catch {}
}

/** Force the flow for this account (e.g. from a signup screen). */
export async function markFreshSignup(email) {
  if (!email) return;
  const cur = await _read(email);
  if (cur?.status === 'done') return;
  await _write(email, { status: 'pending', step: cur?.step || null });
}

/** Persist the step the user is on, so an interrupted flow resumes there. */
export async function saveFirstRunStep(email, step) {
  if (!email) return;
  await _write(email, { status: 'pending', step: step || null });
}

/** Never show again for this account. */
export async function completeFirstRun(email, reason = 'completed') {
  if (!email) return;
  await _write(email, { status: 'done', reason });
}

function _realConversationCount(r, me) {
  const convs = Array.isArray(r?.data) ? r.data : (r?.data?.conversations || []);
  if (!Array.isArray(convs)) return -1;
  return convs.filter((cv) => {
    if (!cv || cv.type === 'saved' || cv.is_saved || cv.is_self) return false;
    const peer = String(cv.other_email || cv.contact_email || '').toLowerCase();
    return !(peer && peer === me && cv.type !== 'group' && cv.type !== 'channel');
  }).length;
}

/**
 * Decide whether to show the first-run flow for `user`.
 * Resolves { show: boolean, step: string|null }.
 */
export async function evaluateFirstRun(user) {
  const no = { show: false, step: null };
  try {
    if (!FIRST_RUN_ENABLED) return no;
    if (globalThis.__chatyy_firstrun === false) return no;
  } catch {}
  const email = String(user?.email || '').trim().toLowerCase();
  if (!email) return no;
  if (user?.needs_phone_verification === true) return no;
  try {
    const { isChildAccount } = require('../context/AuthContext');
    if (typeof isChildAccount === 'function' && isChildAccount()) return no;
  } catch {}

  // Any logged-in session means the pre-login welcome must never replay on
  // this device (covers QR / deep-link / account-switch logins too).
  try { AsyncStorage.setItem('chatyy_intro_seen', '1').catch(() => {}); } catch {}

  const st = await _read(email);
  if (st?.status === 'done') return no;
  if (st?.status === 'pending') return { show: true, step: st.step || null };

  try {
    const api = require('./api');
    const r = await api.chatConversations('', false);
    if (!r?.success) return no;
    const n = _realConversationCount(r, email);
    if (n < 0) return no;
    if (n === 0) {
      await _write(email, { status: 'pending', step: null });
      return { show: true, step: null };
    }
    await _write(email, { status: 'done', reason: 'existing_account' });
    return no;
  } catch {
    return no;
  }
}
