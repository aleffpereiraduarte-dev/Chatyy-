// settingsCache — Configurações instantâneas (stale-while-revalidate local).
//
// [2026-10-13 settings-instant] Founder: "as configurações deveriam ficar
// salvas no celular — as opções demoram a carregar toda vez". Antes, cada tela
// de Configurações montava com os PADRÕES e só trocava para o valor real quando
// a rede respondia (switch piscando, skeleton de tela cheia, ~6 leituras por
// abertura, e o settings.js ainda invalidava o SWR do api.js a cada abertura).
//
// Agora (modelo WhatsApp / iOS Ajustes):
//   • Um snapshot por SEÇÃO (privacidade, notificações, padrões do chat…) salvo
//     no aparelho via services/mmkv (AsyncStorage/SQLite hidratado em memória
//     no boot no native; localStorage no web) → leitura SÍNCRONA no 1º frame.
//   • Chave = conta ativa (hash do e-mail) + seção → nada vaza entre contas no
//     multi-conta. Sem conta ativa = não lê nem grava.
//   • revalidate(): busca em 2º plano, dedupe em voo, TTL (5 min padrão),
//     ignora o SWR em memória do api.js (força dado fresco do servidor).
//   • prefetchAll(): TODAS as seções em PARALELO (Promise.all) — chamado no
//     boot/login (AuthContext.prefetchProfile) → 1ª abertura já quente.
//   • commit(): alteração OTIMISTA — grava local na hora, envia ao servidor;
//     recusa do servidor = desfaz SÓ as chaves alteradas + avisa; falha de
//     rede = fila offline persistida (por conta) reenviada ao reconectar.
import { useEffect, useState, useCallback } from 'react';
import { Platform } from 'react-native';
import * as mm from './mmkv';
import * as api from './api';

const PFX = 'setc1_';
const QUEUE_KEY = 'setc1_queue';
export const DEFAULT_TTL_MS = 5 * 60 * 1000;

function _hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}
export function activeAccount() {
  try { return String(api.getActiveAccountEmail?.() || '').trim().toLowerCase(); } catch { return ''; }
}
function _key(section, acct) {
  const a = acct != null ? acct : activeAccount();
  if (!a) return null;
  return PFX + _hash(a) + '_' + section;
}

// ── Seções conhecidas (fetch → valor a guardar; undefined = falhou) ─────────
// `action` = ação do api.js cujo SWR em memória é descartado antes da busca
// (e depois de cada alteração) para nunca servir uma cópia velha.
const _ok = (r) => !!(r && r.success !== false && !r._offline);
const SECTIONS = {
  settings: { action: 'get_settings', fetch: async () => { const r = await api.getSettings(); return _ok(r) && r.data && typeof r.data === 'object' ? r.data : undefined; } },
  notif: { action: 'chat_user_notif_prefs_get', fetch: async () => { const r = await api.chatGetNotifPrefs(); const d = r?.data || (r?.success ? r : null); return _ok(r) && d && typeof d === 'object' ? d : undefined; } },
  privacy: { action: 'chat_privacy_get', fetch: async () => { const r = await api.chatPrivacyGet(); return _ok(r) && r.data ? r.data : undefined; } },
  defaults: { action: 'chat_user_defaults_get', fetch: async () => { const r = await api.chatUserDefaultsGet(); return _ok(r) && r.data ? r.data : undefined; } },
  vacation: { action: 'vacation_get', fetch: async () => { const r = await api.vacationGet(); const d = r?.data || r; return d && (r?.success || d.enabled !== undefined) && !r?._offline ? d : undefined; } },
  profile: { action: 'profile_get', fetch: async () => { const e = activeAccount(); if (!e) return undefined; const r = await api.profileGet(e); return r?.success && r.data?.identity ? r.data.identity : undefined; } },
  referral: { action: 'get_referral_code', fetch: async () => { const r = await api.getReferralCode(); return r?.success && r.data ? r.data : undefined; } },
  muted_words: { action: 'feed_muted_words_list', fetch: async () => { const r = await api.feedMutedWordsList(); return r?.success && Array.isArray(r.data?.words) ? r.data.words : undefined; } },
  chat_settings: { action: 'chat_get_settings', fetch: async () => { const r = await api.chatGetSettings(); return _ok(r) && r.data && typeof r.data === 'object' ? r.data : undefined; } },
  blocked: { action: 'chat_blocked_list', fetch: async () => { const r = await api.chatBlockedList(); return _ok(r) ? (Array.isArray(r.data) ? r.data : []) : undefined; } },
  plan: {
    action: 'plan_info',
    fetch: async () => {
      const [p, u] = await Promise.all([api.planInfo?.().catch(() => null), api.storageUsage?.().catch(() => null)]);
      const plan = p?.success && p.data ? p.data : null;
      const usage = u?.success && u.data ? u.data : null;
      return plan || usage ? { plan, usage } : undefined;
    },
  },
  notif_keywords: { action: 'chat_user_keywords_list', fetch: async () => { const r = await api.apiCall('chat_user_keywords_list', {}, 'POST'); return r?.success && r.data ? (r.data.keywords || []) : undefined; } },
  discoverable: { action: 'chat_discoverable_get', fetch: async () => { const r = await api.chatDiscoverableGet(); if (!_ok(r)) return undefined; const v = r?.data?.discoverable ?? r?.discoverable; return v === undefined ? undefined : !!v; } },
  // Sob demanda (não entram no prefetch do boot — pesadas / raramente abertas).
  close_friends: {
    action: 'close_friends_list',
    fetch: async () => {
      const r = await api.closeFriendsList();
      if (!r?.success) return undefined;
      const list = r.data?.close_friends || r.data?.list || [];
      return list.map((f) => f.friend_email || f.email || f).filter((x) => typeof x === 'string');
    },
  },
  // Lista de contatos ENXUTA (só e-mail + nome, máx. 800) p/ os seletores
  // de Melhores amigos / Ocultar status — não guarda o objeto inteiro.
  contacts_lite: {
    action: 'chat_contacts',
    fetch: async () => {
      const r = await api.chatContacts();
      if (!r?.success) return undefined;
      const list = Array.isArray(r.data) ? r.data : (r.data?.contacts || []);
      return list.slice(0, 800).map((c) => ({ email: c.email || c.friend_email || '', display_name: c.display_name || c.name || '' })).filter((c) => c.email);
    },
  },
  sessions: { action: 'sessions_list', lazy: true, fetch: null },
  linked_phones: { action: 'linked_phones_list', lazy: true, fetch: null },
};
// Seções aquecidas no boot/login (o hub inteiro + subtelas mais abertas).
const PREFETCH = ['settings', 'notif', 'privacy', 'defaults', 'vacation', 'profile', 'referral', 'muted_words', 'chat_settings', 'blocked', 'plan', 'notif_keywords'];

// Telas podem registrar/atualizar o fetcher de uma seção (ex.: sessões).
export function register(section, fetch, opts = {}) {
  SECTIONS[section] = { ...(SECTIONS[section] || {}), ...opts, fetch };
}

// ── Leitura/escrita local (memória → mmkv) ────────────────────────────────
const _mem = new Map(); // fullKey -> { at, v }
function _read(section, acct) {
  const k = _key(section, acct);
  if (!k) return null;
  const hit = _mem.get(k);
  if (hit) return hit;
  try {
    const raw = mm.getString(k);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !('v' in o)) return null;
    _mem.set(k, o);
    return o;
  } catch { return null; }
}
function _write(section, v, { at, acct } = {}) {
  const k = _key(section, acct);
  if (!k) return;
  const o = { at: at != null ? at : Date.now(), v };
  _mem.set(k, o);
  try { mm.setString(k, JSON.stringify(o)); } catch {}
  _emit(section, v, acct != null ? acct : activeAccount());
}
/** Último valor salvo da seção para a conta ativa (síncrono) — ou null. */
export function peek(section) {
  const o = _read(section);
  return o ? o.v : null;
}
/** Snapshot de uma conta específica (não necessariamente a ativa) — ou null. */
export function peekFor(section, acct) {
  const a = String(acct || '').trim().toLowerCase();
  if (!a) return null;
  const o = _read(section, a);
  return o ? o.v : null;
}
export function ageMs(section) {
  const o = _read(section);
  return o ? Date.now() - (o.at || 0) : Infinity;
}
export function isStale(section, ttl = DEFAULT_TTL_MS) { return ageMs(section) > ttl; }
/** Grava o valor (ex.: tela que já buscou por conta própria). */
export function put(section, v) { if (v !== undefined) _write(section, v); }
/** Mescla local (objeto parcial ou fn(prev) → next). Não toca o servidor. */
// Geração de alterações locais por seção: uma revalidação que começou ANTES
// de uma alteração otimista não pode sobrescrevê-la com o valor antigo.
const _gen = new Map(); // fullKey -> n
function _bump(section) { const k = _key(section); if (k) _gen.set(k, (_gen.get(k) || 0) + 1); }
export function patch(section, p) {
  _bump(section);
  const o = _read(section);
  const prev = o ? o.v : null;
  const next = typeof p === 'function' ? p(prev) : { ...(prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {}), ...p };
  if (next === undefined) return;
  _write(section, next, { at: o ? o.at : 0 });
}

// ── Assinantes ────────────────────────────────────────────────────────────
const _subs = new Map(); // section -> Set(fn)
function _emit(section, v, acct) {
  const set = _subs.get(section);
  if (!set) return;
  set.forEach((fn) => { try { if (acct === activeAccount()) fn(v); } catch {} });
}
export function subscribe(section, fn) {
  let set = _subs.get(section);
  if (!set) { set = new Set(); _subs.set(section, set); }
  set.add(fn);
  return () => { try { set.delete(fn); } catch {} };
}

// ── Revalidação (2º plano, dedupe em voo) ─────────────────────────────────
const _inflight = new Map(); // fullKey -> Promise
export function revalidate(section, { force = false, ttl = DEFAULT_TTL_MS } = {}) {
  const def = SECTIONS[section];
  const acct = activeAccount();
  const k = _key(section, acct);
  if (!def || typeof def.fetch !== 'function' || !k) return Promise.resolve(peek(section));
  if (!force && !isStale(section, ttl)) return Promise.resolve(peek(section));
  const cur = _inflight.get(k);
  if (cur) return cur;
  const p = (async () => {
    try {
      // Fila offline primeiro: não sobrescrever uma alteração local ainda não enviada.
      await flushQueue().catch(() => {});
      // [2026-10-15 boot-dedupe] force → sempre fresco; senão reaproveita cópia SWR de ≤15 s.
      try {
        if (def.action) {
          if (!force && api.swrInvalidateIfOlder) api.swrInvalidateIfOlder(def.action, 15000);
          else api.swrInvalidate?.(def.action);
        }
      } catch {}
      const g0 = _gen.get(k) || 0;
      const v = await def.fetch();
      if (v === undefined) return peek(section);
      if (activeAccount() !== acct) return null; // conta trocou no meio → descarta
      if (_hasQueued(acct, section)) return peek(section);
      if ((_gen.get(k) || 0) !== g0) return peek(section); // alteração local no meio → ela vence
      _write(section, v, { acct });
      return v;
    } catch { return peek(section); } finally { _inflight.delete(k); }
  })();
  _inflight.set(k, p);
  return p;
}
export function isRevalidating(section) {
  const k = _key(section);
  return !!(k && _inflight.has(k));
}
/** Aquece todas as seções do hub em PARALELO. */
export function prefetchAll({ force = false, sections = PREFETCH, ttl = DEFAULT_TTL_MS } = {}) {
  if (!activeAccount()) return Promise.resolve([]);
  return Promise.all(sections.map((s) => revalidate(s, { force, ttl }).catch(() => null)));
}

// ── Alteração otimista + fila offline ─────────────────────────────────────
const TRANSPORT_MSGS = new Set(['Connection error', 'Tempo limite excedido', 'offline', 'Servidor indisponivel']);
function _isTransportFailure(r, err) {
  if (err) return true;
  if (!r) return true;
  if (r.success !== false) return false;
  const m = String(r.message || (r.data && r.data.message) || '');
  return TRANSPORT_MSGS.has(m) || r.__httpStatus === 0;
}
function _loadQueue() {
  try { const q = JSON.parse(mm.getString(QUEUE_KEY) || '[]'); return Array.isArray(q) ? q : []; } catch { return []; }
}
function _saveQueue(q) {
  try { if (q.length) mm.setString(QUEUE_KEY, JSON.stringify(q.slice(-100))); else mm.remove(QUEUE_KEY); } catch {}
}
function _hasQueued(acct, section) { return _loadQueue().some((x) => x.acct === acct && x.section === section); }

/**
 * commit(section, { patch, action, params, method })
 *   patch: objeto parcial (ou fn(prev)→next) aplicado ao snapshot local NA HORA.
 *   action/params: chamada ao servidor (api.apiCall). Sem action = só local.
 * Resolve { ok, queued, r }. ok:false = servidor recusou → snapshot desfeito
 * (assinantes recebem o valor anterior) e quem chamou deve avisar o usuário.
 */
export async function commit(section, { patch: p, action, params = {}, method = 'POST' } = {}) {
  const acct = activeAccount();
  const before = peek(section);
  if (p !== undefined && section) patch(section, p);
  if (!action) return { ok: true };
  try { const d = SECTIONS[section]; if (d && d.action) api.swrInvalidate?.(d.action); } catch {}
  let r = null; let err = null;
  try { r = await api.apiCall(action, params, method); } catch (e) { err = e; }
  if (_isTransportFailure(r, err)) {
    const q = _loadQueue();
    q.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), acct, section, action, params, method, at: Date.now() });
    _saveQueue(q);
    _armReconnect();
    return { ok: true, queued: true, r };
  }
  if (r && r.success === false) {
    // Desfaz SÓ o que esta alteração mudou (outras mudanças paralelas ficam).
    if (section && activeAccount() === acct) {
      if (p && typeof p === 'object' && before && typeof before === 'object' && !Array.isArray(before)) {
        const restore = {};
        for (const kk of Object.keys(p)) restore[kk] = before[kk];
        patch(section, restore);
      } else if (before !== null) {
        _write(section, before, { acct });
      }
    }
    return { ok: false, r };
  }
  return { ok: true, r };
}

let _flushing = null;
function _same(a, b) { return !!(a && b && a.id === b.id); }
export function flushQueue() {
  if (_flushing) return _flushing;
  _flushing = (async () => {
    try {
      const acct = activeAccount();
      const snap = _loadQueue();
      if (!snap.length || !acct) return;
      const done = [];
      for (const item of snap) {
        if (item.acct !== acct) continue; // o token em uso é o da conta ativa
        let r = null; let err = null;
        try { r = await api.apiCall(item.action, item.params || {}, item.method || 'POST'); } catch (e) { err = e; }
        if (_isTransportFailure(r, err)) break; // ainda sem rede → tenta depois
        done.push(item);
        // Recusado no reenvio → o servidor manda; revalida a seção.
        if (r && r.success === false && item.section) {
          const sec = item.section;
          setTimeout(() => { revalidate(sec, { force: true }).catch(() => {}); }, 0);
        }
      }
      // Relê a fila (itens podem ter entrado durante o envio) e tira os enviados.
      if (done.length) _saveQueue(_loadQueue().filter((x) => !done.some((d) => _same(d, x))));
    } catch {}
  })();
  // .finally no promise (não dentro do async): com a fila vazia o corpo
  // termina antes da atribuição e deixaria _flushing preso.
  const mine = _flushing;
  mine.finally(() => { if (_flushing === mine) _flushing = null; });
  return mine;
}
let _netUnsub = null;
function _armReconnect() {
  if (_netUnsub) return;
  try {
    const ni = require('./networkInfo');
    let first = true;
    _netUnsub = ni.onNetworkChange?.((st) => {
      if (first) { first = false; return; }
      if (st && st.isConnected) flushQueue().catch(() => {});
    }) || null;
  } catch {}
  // Rede de segurança (web sem eventos / NetInfo ausente): tenta a cada 30 s.
  if (!_retryTimer) {
    _retryTimer = setInterval(() => {
      if (!_loadQueue().length) { try { clearInterval(_retryTimer); } catch {} _retryTimer = null; return; }
      flushQueue().catch(() => {});
    }, 30000);
  }
}
let _retryTimer = null;

// ── Hook para telas ───────────────────────────────────────────────────────
// const { data, revalidating, refresh } = useSettingsSection('blocked');
// data = último valor salvo (null só na 1ª vez na vida) → render imediato.
export function useSettingsSection(section, { ttl = DEFAULT_TTL_MS, enabled = true } = {}) {
  // [2026-10-13 P2-10] Troca de conta: o useAuth re-renderiza a tela e a conta
  // ativa entra nas deps/estado → nunca mostra o snapshot da conta anterior.
  try { require('../context/AuthContext').useAuth(); } catch {}
  const acct = activeAccount();
  const [st, setSt] = useState(() => ({ acct, data: peek(section) }));
  const data = st.acct === acct ? st.data : peek(section);
  const setData = useCallback((v) => setSt({ acct: activeAccount(), data: v }), []);
  const [revalidating, setRevalidating] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    const unsub = subscribe(section, (v) => { if (alive) setData(v); });
    const cur = peek(section);
    if (cur !== st.data || st.acct !== acct) setData(cur);
    if (isStale(section, ttl)) {
      setRevalidating(true);
      revalidate(section, { ttl }).finally(() => { if (alive) setRevalidating(false); });
    }
    return () => { alive = false; unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, enabled, acct]);
  const refresh = useCallback(async () => {
    setRevalidating(true);
    try { return await revalidate(section, { force: true }); } finally { setRevalidating(false); }
  }, [section, acct]);
  return { data, revalidating, refresh };
}

// Logout / limpeza total: apaga os snapshots de TODAS as contas + fila.
export function purgeAll() {
  _mem.clear();
  try {
    const keys = mm.getAllKeys?.() || [];
    for (const k of keys) {
      const kk = typeof k === 'string' && k.startsWith('mmkv_') ? k.slice(5) : k;
      if (typeof kk === 'string' && kk.startsWith(PFX)) { try { mm.remove(kk); } catch {} }
    }
  } catch {}
  try { mm.remove(QUEUE_KEY); } catch {}
}

// [2026-10-14 offline-first] Remoção/revogação de UMA conta guardada: apaga só
// os snapshots dela (chave = hash do e-mail). Não toca a fila (é da conta ativa).
export function purgeAccount(email) {
  const a = String(email || '').trim().toLowerCase();
  if (!a) return;
  const pfx = PFX + _hash(a) + '_';
  for (const k of Array.from(_mem.keys())) if (k.startsWith(pfx)) _mem.delete(k);
  try {
    for (const k of (mm.getAllKeys?.() || [])) {
      const kk = typeof k === 'string' && k.startsWith('mmkv_') ? k.slice(5) : k;
      if (typeof kk === 'string' && kk.startsWith(pfx)) { try { mm.remove(kk); } catch {} }
    }
  } catch {}
}

// Aviso padrão quando o servidor recusa uma alteração (já desfeita localmente).
export function notifySaveFailed(t) {
  const msg = (t && t('settings.saveFailedReverted')) || 'Não foi possível salvar. A alteração foi desfeita.';
  try {
    const { showToast } = require('../components/ui/Toast');
    showToast({ message: msg, kind: 'error' });
  } catch {
    try { if (Platform.OS !== 'web') require('react-native').Alert.alert(msg); } catch {}
  }
}

// Boot: se ficou algo na fila de uma sessão anterior, tenta reenviar.
try { setTimeout(() => { if (_loadQueue().length) { _armReconnect(); flushQueue().catch(() => {}); } }, 8000); } catch {}
