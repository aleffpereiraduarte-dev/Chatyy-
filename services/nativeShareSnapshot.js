// services/nativeShareSnapshot.js — [2026-10-18 native-share]
//
// Compartilhar NATIVO (sem abrir o app): a ShareExtension do iOS
// (native-ios/share-extension/ChatyyNativeShare.swift) e a ChatyyShareActivity
// do Android (modules/expo-chat-transport) mostram as conversas recentes a partir
// de um SNAPSHOT que o app grava sempre que a lista de conversas muda:
//   ExpoChatyySystem.setShareSnapshot(items, { enabled, account, base, locked })
//     iOS: App Group (chatyy.share.snapshot.v1 + miniaturas dos avatares)
//     Android: SharedPreferences "chatyy_native_share" (+ miniaturas)
// Token: iOS = App Group (ExpoChatyyIntents.setShareExtensionAuth, já existia);
// Android = credenciais da fila nativa (ChatyyTransport.outboxConfigure).
//
// Fora do snapshot (nunca aparecem no compartilhar nativo): arquivadas,
// trancadas/ocultas, canais/listas/salvas, E2EE (envelope/v4) e bloqueadas.
//
// Kill switch (OTA / remoto): globalThis.__chatyy_native_share = false → grava
// enabled=false → a extensão/Activity volta a abrir o app (/share-receive, como
// antes). Modo envelope global (E2EE) também desliga. Binário sem a API nativa
// (typeof check) → no-op.
import { Platform } from 'react-native';

const DEBOUNCE_MS = 2500;
const MAX_ITEMS = 60;

let _mod; // undefined = não resolvido; null = indisponível
let _timer = null;
let _pending = null;
let _lastSig = null;

function getModule() {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  if (_mod !== undefined) return _mod;
  _mod = null;
  try {
    const { requireOptionalNativeModule } = require('expo');
    const m = requireOptionalNativeModule('ExpoChatyySystem');
    if (m && typeof m.setShareSnapshot === 'function') _mod = m;
  } catch { _mod = null; }
  return _mod;
}

function _api() { try { return require('./api'); } catch { return null; } }

/** Kill switch: false explícito (remoto/OTA) ou modo envelope (E2EE) global. */
export function nativeShareEnabled() {
  try {
    if (globalThis.__chatyy_native_share === false) return false;
    if (globalThis.__chatyy_envelope_mode === true) return false;
  } catch {}
  return true;
}

function _appLockOn() {
  try {
    const SecureStore = require('expo-secure-store');
    if (typeof SecureStore.getItem !== 'function') return false;
    return SecureStore.getItem('biometric_enabled') === 'true';
  } catch { return false; }
}

function _ts(c) {
  const v = c?.last_message_at || c?.updated_at || c?.last_message_time || 0;
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}

function _blockedEmails() {
  const out = new Set();
  try {
    const sc = require('./settingsCache');
    let v = sc?.peek?.('blocked');
    if (v && !Array.isArray(v) && Array.isArray(v.items)) v = v.items;
    if (Array.isArray(v)) {
      for (const b of v) {
        const e = typeof b === 'string' ? b : (b?.blocked_email || b?.email || '');
        if (e) out.add(String(e).trim().toLowerCase());
      }
    }
  } catch {}
  return out;
}

/** Conversa com criptografia de ponta a ponta: o envio nativo é texto/mídia em claro → fora. */
export function isE2EConversation(c) {
  return !!(c && (c.is_e2ee || c.e2ee || c.e2ee_v4 || c.e2ee_enabled || c.encrypted || c.envelope || c.envelopes || c.sealed));
}

/** Pure (exportado p/ testes): conversas → linhas do snapshot. */
export function buildShareSnapshot(conversations, { me = '', lockedIds = null, blocked = null } = {}) {
  const meLc = String(me || '').trim().toLowerCase();
  const list = Array.isArray(conversations) ? conversations : [];
  const blockedSet = blocked || new Set();
  const api = _api();
  const out = [];
  const sorted = list
    .filter((c) => c && c.id != null && !c.archived && !c.locked && !c.hidden
      && !(lockedIds && typeof lockedIds.has === 'function' && (lockedIds.has(c.id) || lockedIds.has(String(c.id))))
      && c.type !== 'saved' && c.type !== 'channel' && c.type !== 'broadcast'
      && !c.is_channel && !c.left && !c.is_left && !c.removed
      && !c.blocked && !c.is_blocked && !c.blocked_by_me && !c.i_blocked
      && !isE2EConversation(c))
    .sort((a, b) => _ts(b) - _ts(a));
  for (const c of sorted) {
    if (out.length >= MAX_ITEMS) break;
    const isGroup = c.type === 'group' || !!c.is_group;
    const email = isGroup ? '' : String(c.other_email || c.contact_email || c.email || '').trim().toLowerCase();
    if (!isGroup && !email) continue;
    if (email && email === meLc) continue; // conversa comigo mesmo
    if (email && blockedSet.has(email)) continue;
    let title = String(c.display_name || c.name || email || '').trim();
    if (!isGroup && title.includes('@')) {
      try { title = api?.emailToDisplayName?.(title) || title; } catch {}
    }
    if (!title) continue;
    let avatar = String(c.avatar_url || c.group_avatar || '').trim();
    if (!avatar && !isGroup && email) {
      try { avatar = String(api?.getAvatarUrlForEmail?.(email) || ''); } catch {}
    }
    out.push({ id: String(c.id), title: title.slice(0, 80), is_group: isGroup, email, avatar_url: avatar });
  }
  return out;
}

function _flush() {
  _timer = null;
  const job = _pending;
  _pending = null;
  if (!job) return;
  const m = getModule();
  if (!m) return;
  const sig = JSON.stringify([job.opts.enabled, job.opts.account, job.opts.locked, job.opts.mq_wifi, job.opts.mq_cell, job.items.map((i) => [i.id, i.title, i.avatar_url])]);
  if (sig === _lastSig) return;
  _lastSig = sig;
  try {
    Promise.resolve(m.setShareSnapshot(job.items, job.opts)).catch(() => { _lastSig = null; });
  } catch { _lastSig = null; }
}

// [2026-10-19 media-quality] Qualidade de envio (Wi-Fi / dados móveis) p/ a
// extensão nativa comprimir fotos no mesmo nível do app (binários com o
// snapshot novo; os antigos ignoram as chaves e seguem 2560 px).
let _lastConvs = null;
let _lastOpts = null;
function _mqOpts() {
  try {
    const p = require('./mediaUploadQuality').getUploadQualityPrefs();
    return { mq_wifi: p.wifi, mq_cell: p.cell };
  } catch { return {}; }
}
/** Preferência mudou → regrava o snapshot com a qualidade nova. */
export function refreshShareSnapshotQuality() {
  if (_lastConvs) scheduleShareSnapshot(_lastConvs, _lastOpts || {});
}

/** Debounced; chamado sempre que a lista de conversas muda (services/systemIntegration). */
export function scheduleShareSnapshot(conversations, opts = {}) {
  if (!getModule()) return;
  try {
    const api = _api();
    const me = String(opts.me || api?.getActiveAccountEmail?.() || '').trim().toLowerCase();
    const enabled = nativeShareEnabled() && !!me;
    let base = 'https://chatyy.com.br';
    try { base = String(api?.getBaseUrl?.() || base); } catch {}
    _pending = {
      items: enabled ? buildShareSnapshot(conversations, { me, lockedIds: opts.lockedIds, blocked: _blockedEmails() }) : [],
      opts: { enabled, account: me, base, locked: _appLockOn(), ..._mqOpts() },
    };
    _lastConvs = conversations; _lastOpts = opts;
  } catch { return; }
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(_flush, DEBOUNCE_MS);
}

/** Logout / troca de conta: some o snapshot (a extensão volta ao fallback). */
export function clearShareSnapshot() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _pending = null;
  _lastSig = null;
  const m = getModule();
  if (!m || typeof m.clearShareSnapshot !== 'function') return;
  try { m.clearShareSnapshot(); } catch {}
}
