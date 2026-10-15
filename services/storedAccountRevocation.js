// [incidente-sessao 2026-10-14] Conta GUARDADA com bearer revogado sai do aparelho.
//
// Caso real: a conta do founder ficou no mail_accounts do iPhone de outra
// pessoa desde abril; o bearer foi revogado no servidor, mas a linha (email +
// token morto) continuava lá — o app seguia usando-a p/ push/VoIP/troca de
// conta. Agora, quando QUALQUER uso do bearer de uma conta guardada recebe a
// rejeição EXPLÍCITA do servidor (email.php: HTTP 401 +
// {success:false,data:{error:'logged_out'},message:'logged_out'} — só emitida
// quando $_BEARER_REJECT_REASON==='revoked', ou seja revoked_at no PG / marcador
// de revogação), a conta é apagada deste aparelho: linha do mail_accounts,
// bearer, Face ID dela, caches locais namespaced por ela, journal nativo, e o
// mapa de bearers entregue ao nativo (NSE/Android) é re-sincronizado sem ela.
//
// NUNCA remove por: erro de rede, timeout, 5xx, 401 genérico ("Not
// authenticated" — transitório por contrato do servidor), 403
// must_change_password, ou resposta sem o marcador. Só remove a linha cujo
// token == o token que o servidor rejeitou (se o usuário relogou e a linha tem
// token novo, nada acontece). A conta ATIVA só sai se o token rejeitado for o
// token em uso agora (sessão de fato morta) — o fluxo de logout segue o atual.

const REVOKE_MARKERS = new Set(['logged_out', 'revoked']);
const NOTICE_KEY = 'stored_acct_removed_notice_v1';
const VALIDATE_KEY = 'stored_acct_validate_at_v1';
const VALIDATE_EVERY_MS = 24 * 3600 * 1000;
const VALIDATE_MAX_PER_RUN = 6;
const VALIDATE_TIMEOUT_MS = 8000;

// Dependências injetáveis (teste em node com mocks). Em produção: lazy require.
let _deps = null;
function _d() {
  if (_deps) return _deps;
  const api = require('./api');
  let AsyncStorage = null;
  try { AsyncStorage = require('@react-native-async-storage/async-storage').default; } catch {}
  let mmkv = null;
  try { mmkv = require('./mmkv'); } catch {}
  let SecureStore = null;
  try { const { Platform } = require('react-native'); if (Platform.OS !== 'web') SecureStore = require('expo-secure-store'); } catch {}
  return {
    api,
    AsyncStorage,
    mmkv,
    SecureStore,
    fetch: (...a) => fetch(...a),
    now: () => Date.now(),
    isOnline: () => { try { return require('./offlineCache').isOnline?.() !== false; } catch { return true; } },
    accountKeyHash: (e) => { try { return require('./chatStore/schema').accountKeyHash(e); } catch { return ''; } },
    push: () => { try { return require('./pushNotifications'); } catch { return null; } },
    bgJournal: () => { try { return require('./bgJournal'); } catch { return null; } },
  };
}
export function __setDepsForTest(d) { _deps = d; _validateInFlight = null; _listeners.clear(); }

const _norm = (e) => String(e || '').trim().toLowerCase();
const _canon = (e) => _norm(e).replace('@onemundo.com.br', '@chatyy.com.br');

/**
 * true SÓ quando a resposta é a rejeição explícita de bearer revogado.
 * `status` opcional (apiCall devolve só o JSON); quando presente, precisa ser 401/403.
 */
export function isRevokedAuthPayload(json, status) {
  if (status != null && status !== 401 && status !== 403) return false;
  if (!json || typeof json !== 'object' || json.success === true) return false;
  const cands = [json.error, json.data && typeof json.data === 'object' ? json.data.error : null, json.message];
  return cands.some((v) => typeof v === 'string' && REVOKE_MARKERS.has(v.trim().toLowerCase()));
}

// ── Listeners (AuthContext recarrega a lista; aviso na UI) ──
const _listeners = new Set();
export function onStoredAccountRemoved(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
function _emit(email) { _listeners.forEach((fn) => { try { fn(email); } catch {} }); }

async function _readJSON(key, fb) {
  try { const s = await _d().AsyncStorage?.getItem(key); return s ? JSON.parse(s) : fb; } catch { return fb; }
}
async function _writeJSON(key, v) {
  try { await _d().AsyncStorage?.setItem(key, JSON.stringify(v)); } catch {}
}

/** Aviso pendente ("A conta X foi removida deste aparelho") — lido e zerado pela UI. */
export async function takeRemovedAccountNotices() {
  const list = await _readJSON(NOTICE_KEY, []);
  if (Array.isArray(list) && list.length) { try { await _d().AsyncStorage?.removeItem(NOTICE_KEY); } catch {} }
  return Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x) : [];
}

// Caches locais desta conta (somente chaves namespaced pelo DONO — nunca chaves
// sobre contatos, p/ não mexer em dados da conta ativa).
async function _wipeLocalDataFor(email) {
  const d = _d();
  const e = _norm(email);
  if (!e) return;
  const h = d.accountKeyHash(e);
  let oh = '';
  try { oh = d.api.offlineLastKnownAccountHash?.(e) || ''; } catch {}
  // AsyncStorage
  try {
    const AS = d.AsyncStorage;
    if (AS) {
      const exact = new Set([
        `push_enabled:${e}`, `chat_full_bootstrap:${e}`, `chat_full_bar_shown:${e}`,
        `cloud_photos_${e}`, `chat_statuses:${e}`, `chat_status_manifest:${e}`,
      ]);
      if (h) exact.add(`email_outbox_v1_${h}`);
      let keys = [];
      try { keys = (await AS.getAllKeys()) || []; } catch {}
      const kill = keys.filter((k) => typeof k === 'string' && (exact.has(k) || k.startsWith(`u:${e}:`) || k.startsWith(`@chatyy_cache_u:${e}:`)));
      for (const k of exact) if (!kill.includes(k)) kill.push(k);
      if (kill.length) { try { await AS.multiRemove(kill); } catch { for (const k of kill) { try { await AS.removeItem(k); } catch {} } } }
    }
  } catch {}
  // [2026-10-14 offline-first] telas offline-first (services/cache.js, chave por conta).
  try { require('./cache').clearUserCache?.(e); } catch {}
  try { require('./settingsCache').purgeAccount?.(e); } catch {}
  // MMKV (offlineCache e-mail, last-known da api, espelhos de chat por hash)
  try {
    const mm = d.mmkv;
    if (mm && typeof mm.getAllKeys === 'function') {
      const pre = [`omc_list_${e}_`, `omc_msg_${e}_`];
      const eq = new Set([`omc_msg_index_${e}`, `omc_offline_queue_${e}`]);
      if (oh) pre.push(`apiofl1_${oh}_`);
      if (h) { pre.push(`chat_msgs_a${h}_`, `chat_msgs_v2__${h}_`); eq.add(`chat_convs_v2_${h}`); eq.add(`chat_index_v2_${h}`); }
      for (const k of (mm.getAllKeys() || [])) {
        if (typeof k !== 'string') continue;
        if (eq.has(k) || pre.some((p) => k.startsWith(p))) { try { mm.remove(k); } catch {} }
      }
    }
  } catch {}
  // SecureStore: Face ID desta conta
  try {
    const SS = d.SecureStore;
    if (SS) {
      try { await SS.deleteItemAsync(`bio_token:${e}`); } catch {}
      let bioEmail = '';
      try { bioEmail = _norm(await SS.getItemAsync('bio_email')); } catch {}
      if (bioEmail && _canon(bioEmail) === _canon(e)) {
        try { await SS.deleteItemAsync('bio_email'); } catch {}
        try { await SS.deleteItemAsync('bio_token'); } catch {}
      }
    }
  } catch {}
  // Último identificador do login (prefill) se apontar p/ ela
  try {
    const AS = d.AsyncStorage;
    const last = _norm(await AS?.getItem('@chatyy_login_last_id'));
    if (last && _canon(last) === _canon(e)) await AS.removeItem('@chatyy_login_last_id');
  } catch {}
  try { d.push()?.forgetSentPushTokens?.(e); } catch {}
  try { d.bgJournal()?.onLogout?.(e); } catch {}
}

/**
 * Remove do aparelho a conta guardada cujo token o servidor declarou revogado.
 * @param {{email:string, token:string, source?:string}} p
 * @returns {Promise<boolean>} true se removeu
 */
export async function purgeRevokedStoredAccount({ email, token, source } = {}) {
  try {
    const d = _d();
    const api = d.api;
    const tok = typeof token === 'string' ? token : '';
    if (!tok) return false; // sem o token rejeitado não há prova → não remove
    const accounts = (typeof api.getStoredAccounts === 'function' ? api.getStoredAccounts() : []) || [];
    if (!Array.isArray(accounts)) return false;
    const want = _canon(email);
    // Linha alvo: mesmo token (e, se veio e-mail, mesma conta).
    const row = accounts.find((a) => a && a.token === tok && (!want || _canon(a.email) === want));
    if (!row) return false;
    const target = _norm(row.email);
    const active = _canon(typeof api.getActiveAccountEmail === 'function' ? api.getActiveAccountEmail() : '');
    if (active && _canon(target) === active) {
      // Conta ativa: só se o token rejeitado é o que está EM USO (sessão morta).
      const cur = (typeof api.getAuthToken === 'function' ? api.getAuthToken() : '') || '';
      if (cur && cur !== tok) return false;
    }
    const next = accounts.filter((a) => !(a && _canon(a.email) === _canon(target)));
    api.storeAccounts(next);
    // Persistência garantida (storeAccounts nativo é fire-and-forget).
    try { if (d.SecureStore) await d.SecureStore.setItemAsync('mail_accounts', JSON.stringify(next)); } catch {}
    try { console.warn('[accounts] conta guardada removida (bearer revogado) via', source || '?'); } catch {}
    await _wipeLocalDataFor(target);
    // [2026-10-15 troca-sem-senha] refresh guardado desta conta também sai.
    try { await api.forgetAccountRefreshToken?.(target); } catch {}
    // Nativo (NSE iOS / Android reply/mark-read): re-entrega o mapa sem ela.
    try {
      const pn = d.push();
      const curTok = (typeof api.getAuthToken === 'function' ? api.getAuthToken() : '') || '';
      const others = next.some((a) => a && typeof a.token === 'string' && a.token);
      if ((!curTok || curTok === tok) && !others) pn?.clearNativeChatAuth?.();
      else pn?.syncNativeChatAuth?.(true);
    } catch {}
    // Aviso único na UI.
    try {
      const list = await _readJSON(NOTICE_KEY, []);
      const arr = Array.isArray(list) ? list : [];
      if (!arr.includes(target)) arr.push(target);
      await _writeJSON(NOTICE_KEY, arr.slice(-5));
    } catch {}
    try {
      const m = await _readJSON(VALIDATE_KEY, {});
      if (m && typeof m === 'object' && m[target]) { delete m[target]; await _writeJSON(VALIDATE_KEY, m); }
    } catch {}
    _emit(target);
    return true;
  } catch { return false; }
}

/**
 * Atalho p/ chamadas com o bearer de uma conta guardada: se a resposta for a
 * rejeição explícita, remove. Não faz nada p/ qualquer outra resposta.
 */
export function noteStoredAccountAuthResult({ email, token, status, json, source }) {
  if (!isRevokedAuthPayload(json, status)) return false;
  purgeRevokedStoredAccount({ email, token, source }).catch?.(() => {});
  return true;
}

let _validateInFlight = null;
/**
 * Abertura do app: check_auth leve das contas guardadas NÃO ativas, no máximo
 * 1×/24h por conta, só com rede. Remove as revogadas.
 */
export function validateStoredAccountsInBackground() {
  if (_validateInFlight) return _validateInFlight;
  _validateInFlight = (async () => {
    const d = _d();
    const api = d.api;
    let removed = 0;
    try {
      if (!d.isOnline()) return 0;
      const url = typeof api.getApiUrl === 'function' ? api.getApiUrl() : '';
      if (!url) return 0;
      const accounts = (typeof api.getStoredAccounts === 'function' ? api.getStoredAccounts() : []) || [];
      if (!Array.isArray(accounts) || !accounts.length) return 0;
      const active = _canon(typeof api.getActiveAccountEmail === 'function' ? api.getActiveAccountEmail() : '');
      const seen = await _readJSON(VALIDATE_KEY, {});
      const map = seen && typeof seen === 'object' ? seen : {};
      let n = 0;
      for (const a of accounts.slice()) {
        const e = _norm(a?.email);
        if (!e || !a || typeof a.token !== 'string' || !a.token) continue;
        if (active && _canon(e) === active) continue;
        if (d.now() - Number(map[e] || 0) < VALIDATE_EVERY_MS) continue;
        if (++n > VALIDATE_MAX_PER_RUN) break;
        if (!d.isOnline()) break;
        let status = 0; let json = null;
        try {
          const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
          const to = setTimeout(() => { try { ctl?.abort(); } catch {} }, VALIDATE_TIMEOUT_MS);
          try {
            const resp = await d.fetch(`${url}?action=check_auth`, {
              method: 'GET',
              // Sem cookie: a sessão PHP da conta ativa NÃO pode responder por ela.
              credentials: 'omit',
              headers: { Authorization: `Bearer ${a.token}` },
              signal: ctl?.signal,
            });
            status = resp.status;
            json = await resp.json().catch(() => null);
          } finally { clearTimeout(to); }
        } catch { status = 0; json = null; }
        if (isRevokedAuthPayload(json, status)) {
          if (await purgeRevokedStoredAccount({ email: e, token: a.token, source: 'boot_validate' })) removed++;
          continue;
        }
        // Resposta definitiva do servidor (2xx ou 4xx sem marcador) → espera 24h.
        // Rede/timeout/5xx → tenta de novo na próxima abertura.
        if (status >= 200 && status < 500) map[e] = d.now();
      }
      await _writeJSON(VALIDATE_KEY, map);
    } catch {}
    return removed;
  })().finally(() => { _validateInFlight = null; });
  return _validateInFlight;
}
