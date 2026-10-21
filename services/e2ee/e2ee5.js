// [e2ee5 WP-08c 2026-10-21] Integração JS do E2EE v5 (envio, recepção, caches, busca local).
//
// Contrato: docs/e2ee/CONTRATO.md (e2ee5-contrato/1.2) §2 (envelope/payload v1), §4.2.19
// (conversation_state), §5 (WS), §6.4/§6.11 (API JS do host em services/crypto), §8.
//
// FLAG: tudo atrás de `globalThis.__chatyy_e2ee5 === true` (OTA, DESLIGADA por padrão). Com a
// flag desligada nenhuma função toca o núcleo, a rede ou o armazenamento: os ganchos devolvem
// null/false e o app se comporta byte a byte como hoje — exceto o placeholder do contrato §2.1
// ("Mensagem protegida. Atualize o Chatyy para ler.") para `{"e2e":N≥5}` e o texto das mensagens
// de sistema `{"sys":"e2ee_on"|"e2ee_off"}` (antes o app mostrava o JSON cru).
//
// O que mora aqui (o resto do app chama em 1 linha, blocos marcados [e2ee5]):
//   - sessão: setAuth → status → open → sync (+ bootstrapIdentity no celular; na web só QA);
//     sync em e2ee5_td / e2ee5_devices / volta ao 1º plano / push_preview / a cada 60 s.
//   - estado da conversa (e2ee_mode, membros por uid) via e2ee5_conversation_state + WS conv_e2ee.
//   - selar (cifrar) texto/edição/resposta/encaminhada ANTES de qualquer transporte.
//   - decifrar (WS/HTTP/sync/cache) com cache LOCAL do texto (memória; web: IndexedDB com valores
//     cifrados por chave WebCrypto não-exportável). O texto decifrado nunca volta ao servidor.
//   - "aguardando" (UTD retentável) → re-tenta após convsWithNewKeys; 60 s → chatyy.decrypt_report.
//   - prévia da lista, texto das mensagens de sistema, busca local, encaminhar (recifra no cliente).
//
// Logs: só ids/tamanhos/códigos (nunca conteúdo, chave, bearer).
import { Platform, AppState } from 'react-native';

const ORIGIN = 'https://chatyy.com.br';
const CONTRACT_MAJOR = 1;
const RETRYABLE = new Set(['missing_session', 'unknown_index', 'store', 'untrusted_device', 'no_session', 'sender_unknown']);
const CONV_TTL_MS = 10 * 60 * 1000;
const STATUS_TTL_MS = 10 * 60 * 1000;
const PLAIN_MEM_MAX = 5000;
const REPORT_AFTER_MS = 60 * 1000;
const BODY_MAX = 16 * 1024;

// ───────────────────────────────────────────────────────────── utilitários

export function isOn() {
  try {
    const g = typeof globalThis !== 'undefined' ? globalThis : global;
    return g.__chatyy_e2ee5 === true;
  } catch (_) {
    return false;
  }
}

function _g() { return typeof globalThis !== 'undefined' ? globalThis : global; }
function _C() { return require('../crypto'); }
function _A() { return require('../api'); }
function _health() { try { return require('./health').default; } catch (_) { return null; } }
function _ws() { try { return require('../websocket').default; } catch (_) { return null; } }
function _log(what, kv) {
  // console.warn: o build de produção remove console.log (transform-remove-console).
  try { if (_g().__chatyy_e2ee5_debug === true) console.warn('[e2ee5] ' + what + ' ' + (kv ? JSON.stringify(kv) : '')); } catch (_) {}
}
function _err(code, msg) { const e = new Error('e2ee5:' + code + (msg ? ' ' + msg : '')); e.code = code; return e; }
function _emitLocal(ev, data) { try { _ws()?._emit?.(ev, data); } catch (_) {} }
const _norm = (s) => String(s || '').trim().toLowerCase();
const _canon = (e) => { const s = _norm(e); return s.endsWith('@onemundo.com.br') ? s.slice(0, -16) + '@chatyy.com.br' : s; };

/** `{"e2e":5…` (envelope deste contrato). */
export function isEnvelope(s) { return typeof s === 'string' && s.startsWith('{"e2e":5'); }
/** Versão N de `{"e2e":N…}` ou null. */
export function envVersion(s) {
  if (typeof s !== 'string') return null;
  const t = s.trimStart();
  if (!t.startsWith('{"e2e":')) return null;
  const m = /^\{"e2e":(\d+)/.exec(t);
  return m ? Number(m[1]) : null;
}
/** Envelope que ESTE módulo trata (N ≥ 5). v1–v4 continuam com o código legado. */
export function isV5Family(s) { const v = envVersion(s); return v != null && v >= 5; }

// Chave estável por envelope (o ciphertext é único por mensagem; edição compat troca o envelope).
export function keyOf(env) {
  if (typeof env !== 'string') return '';
  const sid = /"session_id":"([^"]{1,128})"/.exec(env);
  const ct = /"ciphertext":"([^"]{8,})"/.exec(env);
  if (!ct) return 'x|' + env.length + '|' + env.slice(-40);
  return (sid ? sid[1] : '') + '|' + ct[1].length + '|' + ct[1].slice(-40);
}

function _tx(t, key, fb, params) {
  let s = '';
  try { const v = t ? t(key, params) : null; if (typeof v === 'string' && v && v !== key) s = v; } catch (_) {}
  if (!s) s = fb || '';
  if (params) Object.keys(params).forEach((k) => { s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), String(params[k])); });
  return s;
}

/** Texto do placeholder do balão / prévia para um estado (sem emoji; o ícone é SVG na UI). */
export function stateText(t, state) {
  if (state === 'update_to_read') return _tx(t, 'e2ee5.msg.update_to_read', 'Mensagem protegida. Atualize o Chatyy para ler.');
  if (state === 'cannot_decrypt') return _tx(t, 'e2ee5.msg.cannot_decrypt', 'Não foi possível exibir esta mensagem.');
  if (state === 'decrypting') return '...';
  return _tx(t, 'e2ee5.msg.waiting', 'Aguardando esta mensagem. Isso pode levar um tempo.');
}

// ───────────────────────────────────────────────────────────── HTTP direto (sem X-E2EE-Device)

function _bearer() {
  try { const a = _A(); return String((a.getAuthToken && a.getAuthToken()) || (a.getToken && a.getToken()) || ''); } catch (_) { return ''; }
}
function _me() {
  try { const a = _A(); return _norm((a.getActiveAccountEmail && a.getActiveAccountEmail()) || (a.getTokenMeta && a.getTokenMeta().email) || ''); } catch (_) { return ''; }
}
// Origem ABSOLUTA: o worker do núcleo (blob:) não resolve URL relativa.
function _base() {
  if (Platform.OS === 'web') {
    try { if (typeof location !== 'undefined' && location.origin === ORIGIN) return location.origin; } catch (_) {}
  }
  return ORIGIN;
}

async function _http(action, body) {
  const bearer = _bearer();
  if (!bearer) return { ok: false, status: 0, code: 'unauthorized' };
  let ctl = null; let timer = null;
  try { ctl = new AbortController(); timer = setTimeout(() => { try { ctl.abort(); } catch (_) {} }, 15000); } catch (_) {}
  try {
    const r = await fetch(_base() + '/api/email.php?action=' + encodeURIComponent(action), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctl ? ctl.signal : undefined,
    });
    let j = null;
    try { j = await r.json(); } catch (_) {}
    if (r.ok && j && j.success) return { ok: true, status: r.status, data: j.data || {} };
    return { ok: false, status: r.status, code: (j && j.data && j.data.code) || ('http_' + r.status), message: (j && j.message) || '' };
  } catch (e) {
    return { ok: false, status: 0, code: 'network' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ───────────────────────────────────────────────────────────── sessão

let _sess = null;          // {uid, deviceId, bearer, email, status, signed, at}
let _sessP = null;
let _sessFailAt = 0;
let _acctDisabled = false; // servidor respondeu e2ee5_disabled (conta fora da coorte)
let _wired = false;

export function sessionSync() { return _sess; }
export function deviceIdSync() { return (_sess && _sess.deviceId) || ''; }
export function myUidSync() { return (_sess && _sess.uid) || ''; }
export function isReadySync() { return !!(_sess && _sess.signed); }

function _prefix() {
  try { const p = _g().__chatyy_e2ee5_device_prefix; if (p === 'X' || p === 'W' || p === 'T' || p === 'P') return { prefix: p }; } catch (_) {}
  return undefined;
}

function _majorOf(contract) {
  const m = /e2ee5-contrato\/(\d+)\./.exec(String(contract || ''));
  return m ? Number(m[1]) : CONTRACT_MAJOR;
}

/** Abre (uma vez) a sessão do núcleo para a conta atual. null = indisponível (flag, coorte, aparelho). */
export function ensureSession() {
  if (!isOn()) return Promise.resolve(null);
  const bearer = _bearer();
  if (!bearer) return Promise.resolve(null);
  if (_sess && _sess.bearer === bearer && _sess.email === _me()) return Promise.resolve(_sess);
  if (_sessP) return _sessP;
  if (_acctDisabled && Date.now() - _sessFailAt < STATUS_TTL_MS) return Promise.resolve(null);
  if (!_acctDisabled && Date.now() - _sessFailAt < 20000) return Promise.resolve(null);
  _sessP = (async () => {
    const c = _C();
    const email = _me();
    if (_sess) { try { await c.close(); } catch (_) {} _sess = null; _conv.clear(); _plain.clear(); _byMid.clear(); }
    const qa = _g().__chatyy_e2ee5_qa_transport;
    if (typeof qa === 'function') await c.setAuth({ mode: 'main', base: '', bearer, transport: qa });
    else await c.setAuth({ base: _base(), bearer, account: email });
    const st = await c.status();
    if (!st || st.enabled !== true || st.kill === true) { _acctDisabled = !st || st.enabled !== true; throw _err('disabled'); }
    if (_majorOf(st.contract) !== CONTRACT_MAJOR) throw _err('contract');
    if (Platform.OS !== 'web' && !(st.flags && st.flags.e2ee5_native === true)) throw _err('disabled', 'native');
    const op = await c.open(String(st.uid), _prefix());
    let s1 = null;
    try { s1 = await c.sync(); } catch (e) { _log('sync0_fail', { code: e && e.code }); }
    let td = null;
    try { td = await c.thisDevice(); } catch (_) {}
    if (!(td && td.signedByOwner)) {
      // Celular = aparelho principal: assume a identidade (reinstalar = aparelho novo, como no
      // WhatsApp: os contatos veem "o código de segurança mudou"). Web = só pelo QR do celular
      // (F4); exceção D4/QA com flag explícita.
      const webOk = _g().__chatyy_e2ee5_web_bootstrap === true;
      if (Platform.OS !== 'web' || webOk) {
        try {
          await c.bootstrapIdentity();
          try { await c.sync(); } catch (_) {}
          td = await c.thisDevice();
        } catch (e) { _log('bootstrap_fail', { code: e && e.code }); }
      }
    }
    _sess = { uid: String(st.uid), deviceId: String(op.deviceId || ''), bearer, email, status: st, signed: !!(td && td.signedByOwner), at: Date.now() };
    _acctDisabled = false;
    try { _health()?.setTransport((action, body) => _http('e2ee5_' + action, body).then((r) => { if (!r.ok) throw _err(r.code || 'server'); return r.data; })); } catch (_) {}
    _wireOnce();
    _wireNative();
    _armPeriodic();
    if (s1) _onSyncResult(s1);
    for (const cid of Array.from(_waiting.keys())) _retryWaiting(cid); // "aguardando" de antes da sessão
    _log('session', { uid: _sess.uid, dev: _sess.deviceId, signed: _sess.signed });
    return _sess;
  })().catch((e) => {
    _sessFailAt = Date.now();
    _log('session_fail', { code: e && e.code });
    return null;
  }).finally(() => { _sessP = null; });
  return _sessP;
}

/** WS autenticou: abre a sessão (se a flag estiver ligada) e sincroniza. */
export function onWsAuth() {
  if (!isOn()) return;
  ensureSession().then((s) => { if (s) requestSync(50); }).catch(() => {});
}

/** Logout / troca de conta. `wipe` = apagar também o store (desvincular). */
export async function endSession({ wipe } = {}) {
  const s = _sess;
  _sess = null; _conv.clear(); _plain.clear(); _byMid.clear(); _waiting.clear();
  if (!s || !isOn()) return;
  try { if (wipe) await _C().wipe(s.uid); else await _C().close(); } catch (_) {}
}

// ───────────────────────────────────────────────────────────── sync

let _syncTimer = null;
let _syncRunning = false;
let _syncAgain = false;

/** Pede um `sync()` (debounce). Chamado por e2ee5_td/e2ee5_devices/push/1º plano. */
export function requestSync(delayMs = 300) {
  if (!isOn()) return;
  if (_syncTimer) return;
  _syncTimer = setTimeout(() => { _syncTimer = null; _runSync(); }, delayMs);
}

async function _runSync() {
  if (_syncRunning) { _syncAgain = true; return; }
  const s = await ensureSession();
  if (!s) return;
  _syncRunning = true;
  try {
    for (let i = 0; i < 6; i++) {
      let r = null;
      try { r = await _C().sync(); } catch (e) { _log('sync_fail', { code: e && e.code }); break; }
      _onSyncResult(r);
      if (!r || !r.more) break;
    }
  } finally {
    _syncRunning = false;
    if (_syncAgain) { _syncAgain = false; requestSync(300); }
  }
}

function _onSyncResult(r) {
  if (!r) return;
  try {
    const convs = Array.isArray(r.convsWithNewKeys) ? r.convsWithNewKeys : [];
    for (const cid of convs) _retryWaiting(String(cid));
    // Sem saber a conversa (to-device com chave de sala nova), re-tenta tudo o que aguarda.
    if ((r.toDeviceProcessed || 0) > 0 && !convs.length) for (const cid of Array.from(_waiting.keys())) _retryWaiting(cid);
  } catch (_) {}
  try {
    const uids = Array.isArray(r.identityChangedUids) ? r.identityChangedUids.map(String) : [];
    if (uids.length) {
      // Comportamento WhatsApp: avisa (linha local), não bloqueia. Verificado → encrypt falha até confirmar.
      for (const u of uids) { try { _C().pinIdentity(u).catch(() => {}); } catch (_) {} }
      const convs = [];
      for (const [cid, st] of _conv) if (st && st.mode === 1 && (st.members || []).some((m) => uids.includes(m))) convs.push(cid);
      _emitLocal('e2ee5_identity_changed', { uids, conversations: convs });
    }
  } catch (_) {}
  try {
    for (const ev of (Array.isArray(r.chatyyEvents) ? r.chatyyEvents : [])) {
      if (!ev || (ev.eventType !== 'chatyy.decrypt_report' && ev.eventType !== 'chatyy.key_resend')) continue;
      let c = null;
      try { c = JSON.parse(ev.contentJson || '{}'); } catch (_) {}
      // Alguém não decifrou: a próxima mensagem desta conversa sai em sessão nova (re-compartilha a chave).
      if (c && c.conv_id) _C().rotateConversation(String(c.conv_id)).catch(() => {});
    }
  } catch (_) {}
}

let _periodic = null;
let _appStateSub = null;
let _lastStatusAt = 0;
function _armPeriodic() {
  if (_periodic) return;
  try {
    _periodic = setInterval(() => {
      if (!isOn() || !_sess) return;
      try { if (AppState.currentState && AppState.currentState !== 'active') return; } catch (_) {}
      requestSync(0);
    }, 60000);
  } catch (_) {}
  try {
    _appStateSub = AppState.addEventListener('change', (st) => {
      if (st !== 'active' || !isOn() || !_sess) {
        if (st === 'background') { try { _health()?.flush(); } catch (_) {} }
        return;
      }
      requestSync(100);
      if (Date.now() - _lastStatusAt > STATUS_TTL_MS) {
        _lastStatusAt = Date.now();
        _C().status().then((st2) => { if (_sess && st2) _sess.status = st2; }).catch(() => {});
      }
    });
  } catch (_) {}
}

// ───────────────────────────────────────────────────────────── WS

function _wireOnce() {
  if (_wired) return;
  const ws = _ws();
  if (!ws || typeof ws.on !== 'function') return;
  _wired = true;
  const dataOf = (raw) => (raw && raw.data && typeof raw.data === 'object' ? raw.data : raw) || {};
  ws.on('e2ee5_td', (raw) => {
    if (!isOn()) return;
    const d = dataOf(raw);
    if (d.device_id && _sess && d.device_id !== _sess.deviceId) return;
    requestSync(300);
  });
  ws.on('e2ee5_devices', () => { if (isOn()) requestSync(300); });
  ws.on('conv_e2ee', (raw) => {
    if (!isOn()) return;
    const d = dataOf(raw);
    if (d.conv_id == null) return;
    const k = String(d.conv_id);
    const prev = _conv.get(k);
    const mode = Number(d.e2ee_mode) === 1 ? 1 : 0;
    if (prev) _conv.set(k, { ...prev, mode, since: d.since_pts != null ? Number(d.since_pts) : prev.since, at: 0 });
    convState(k, { force: true }).then((st) => { if (st) _notifyConv(k, st); }).catch(() => {});
  });
  const onMsg = (raw) => {
    if (!isOn()) return;
    try {
      const m = (raw && raw.message) || raw;
      if (m && isEnvelope(m.content) && m.conversation_id != null) decryptRow(m, m.conversation_id).catch(() => {});
    } catch (_) {}
  };
  ws.on('chat_message', onMsg);
  ws.on('chat_summary', onMsg);
  ws.on('push_preview', (raw) => {
    if (!isOn()) return;
    const d = dataOf(raw);
    if (String(d.e2e || '') !== '5') return;
    requestSync(0);
    if (d.e2e_c && d.e2e_conv) {
      decryptRow({ id: d.e2e_mid, conversation_id: d.e2e_conv, client_message_id: d.e2e_cmid || '', content: d.e2e_c, _senderUid: d.e2e_sender_uid }, d.e2e_conv).catch(() => {});
    }
  });
  ws.on('chat_send_error', (raw) => {
    const d = dataOf(raw);
    if (!d || !d.conversation_id) return;
    if (d.code === 'e2ee5_plaintext_refused' || d.code === 'e2ee5_not_e2ee') {
      try { if (d.code === 'e2ee5_plaintext_refused') _health()?.recordPlaintextRefused(); } catch (_) {}
      convState(String(d.conversation_id), { force: true }).catch(() => {});
    }
  });
}

/** Campos extras do frame de auth do WS (§5.1). */
export function wsAuthFields() {
  if (!isOn() || !_sess || !_sess.deviceId) return null;
  return { e2ee5_device: _sess.deviceId };
}

// ───────────────────────────────────────────────────────────── estado da conversa

const _conv = new Map();      // conv → {mode, since, members:[uid], capable, blocked, canEnable, at}
const _convP = new Map();
const _watchers = new Map();  // conv → Set(cb)

export function convModeSync(cid) { const s = _conv.get(String(cid)); return s ? s.mode : null; }
export function isConvE2eeSync(cid) { return isOn() && convModeSync(cid) === 1; }
export function convStateSync(cid) { return _conv.get(String(cid)) || null; }

function _notifyConv(k, st) {
  const set = _watchers.get(k);
  if (!set) return;
  for (const cb of Array.from(set)) { try { cb(st); } catch (_) {} }
}

/** Assina mudanças de estado (e2ee_mode) da conversa. → função de cancelar. */
export function watchConversation(cid, cb) {
  if (!isOn() || cid == null || typeof cb !== 'function') return () => {};
  const k = String(cid);
  let set = _watchers.get(k);
  if (!set) { set = new Set(); _watchers.set(k, set); }
  set.add(cb);
  return () => { try { set.delete(cb); if (!set.size) _watchers.delete(k); } catch (_) {} };
}

/** `e2ee5_conversation_state` (cache 10 min; `force` re-busca). null = indisponível. */
export async function convState(cid, opts) {
  if (!isOn() || cid == null || cid === '') return null;
  const k = String(cid);
  const force = !!(opts && opts.force);
  const cur = _conv.get(k);
  if (cur && !force && Date.now() - cur.at < CONV_TTL_MS) return cur;
  if (_acctDisabled && Date.now() - _sessFailAt < STATUS_TTL_MS) {
    const z = { mode: 0, since: null, members: [], blocked: 'not_allowed', canEnable: false, at: Date.now(), disabled: true };
    _conv.set(k, z);
    return z;
  }
  if (_convP.has(k)) return _convP.get(k);
  const p = (async () => {
    const r = await _http('e2ee5_conversation_state', { conv_id: k });
    if (!r.ok) {
      if (r.code === 'e2ee5_disabled') {
        _acctDisabled = true; _sessFailAt = Date.now();
        const z = { mode: 0, since: null, members: [], blocked: 'not_allowed', canEnable: false, at: Date.now(), disabled: true };
        _conv.set(k, z);
        return z;
      }
      if (r.code === 'e2ee5_link_forbidden') { // não é membro (saiu)
        const z = { mode: cur ? cur.mode : 0, since: null, members: [], blocked: 'public', canEnable: false, at: Date.now() };
        _conv.set(k, z);
        return z;
      }
      return cur || null;
    }
    return _applyState(k, r.data, cur);
  })().finally(() => { _convP.delete(k); });
  _convP.set(k, p);
  return p;
}

function _applyState(k, d, prev) {
  const members = (Array.isArray(d.members) ? d.members : []).map((m) => (m && m.uid != null ? String(m.uid) : '')).filter(Boolean);
  // e-mail canônico ↔ uid (o servidor manda `email` desde o WP-05 de 21/10; antes só uid)
  for (const m of (Array.isArray(d.members) ? d.members : [])) if (m && m.uid != null && m.email) _emailUid.set(_canon(m.email), String(m.uid));
  const ns = {
    mode: Number(d.e2ee_mode) === 1 ? 1 : 0,
    since: d.since_pts != null ? Number(d.since_pts) : null,
    members,
    capable: Array.isArray(d.members) ? d.members : [],
    blocked: d.blocked_reason || null,
    canEnable: !!d.can_enable,
    at: Date.now(),
  };
  _conv.set(k, ns);
  if (!prev || prev.mode !== ns.mode) _nativeNoteConv(k, ns.mode);
  if (_sess && ns.mode === 1) {
    try {
      if (prev && Array.isArray(prev.members) && prev.members.length) {
        const removed = prev.members.filter((u) => !members.includes(u));
        if (removed.length) _C().onMembersChanged(k, members, removed).catch(() => {}); // saiu alguém ⇒ rotação
      }
      if (members.length) _C().trackUsers(members).catch(() => {});
    } catch (_) {}
  }
  if (!prev || prev.mode !== ns.mode || prev.blocked !== ns.blocked) _notifyConv(k, ns);
  return ns;
}

/**
 * Ao abrir a conversa: sessão + estado. → `{mode, ready, blocked, canEnable, since, members}` ou null.
 * `ready` = este aparelho pode cifrar/decifrar (assinado pelo dono).
 */
export async function prepareConversation(cid) {
  if (!isOn() || cid == null) return null;
  const sP = ensureSession();
  const st = await convState(cid, { force: true });
  const s = await sP;
  if (!st) return null;
  if (s && st.mode === 1 && st.members.length) { try { _C().trackUsers(st.members).catch(() => {}); } catch (_) {} }
  return { ...st, ready: !!(s && s.signed), uid: s ? s.uid : null };
}

/** Liga (1) / rebaixa (0, com confirmação) — §4.2.19/§8.5. → `{ok, code, state}` */
export async function setConversationMode(cid, mode) {
  if (!isOn()) return { ok: false, code: 'disabled' };
  const k = String(cid);
  const body = mode === 1 ? { conv_id: k, set: 1 } : { conv_id: k, set: 0, confirm: true };
  const r = await _http('e2ee5_conversation_state', body);
  if (!r.ok) return { ok: false, code: r.code || 'server' };
  const st = _applyState(k, r.data, _conv.get(k));
  return { ok: true, state: st };
}

// ───────────────────────────────────────────────────────────── selar (cifrar)

const _sealMeta = new Map(); // keyOf(env) → {has_link, mention_all, edit_of, cmid}
function _sealMetaPut(env, meta) {
  _sealMeta.set(keyOf(env), meta);
  if (_sealMeta.size > 500) _sealMeta.delete(_sealMeta.keys().next().value);
}
export function sealMetaOf(env) { return _sealMeta.get(keyOf(env)) || null; }

const _LINK_RE = /(https?:\/\/|www\.)[^\s]+/i;

function _replyField(reply) {
  if (!reply || reply.id == null) return null;
  const mid = String(reply.id);
  if (!/^\d+$/.test(mid)) return null; // alvo ainda tmp_ → sem citação cifrada (só reply_to_id)
  const out = { mid };
  const pe = _byMid.get(mid);
  if (pe && pe.cmid) out.cmid = pe.cmid;
  else if (reply.client_message_id) out.cmid = String(reply.client_message_id);
  const q = typeof reply.quoteText === 'string' && reply.quoteText ? reply.quoteText
    : (pe && pe.text) || (typeof reply.content === 'string' && !isV5Family(reply.content) ? reply.content : '');
  if (q) out.quote = String(q).slice(0, 300);
  out.qt = (pe && pe.t === 'edit') ? 'text' : (pe ? pe.t : (reply.type || 'text'));
  return out;
}

/**
 * Cifra um texto para a conversa (payload v1 `t:text` ou `t:edit`). → envelope (string).
 * Rejeita com `.code`: disabled | not_linked | not_e2ee | too_large | identity_violation | …
 * opts: {cmid, reply:{id, content, quoteText, type, client_message_id}, mentionAll, editOf, editOfCmid, fwd}
 */
export async function sealText(convId, text, opts) {
  const o = opts || {};
  if (!isOn()) throw _err('disabled');
  const s = await ensureSession();
  if (!s) throw _err('e2ee_unsupported');
  if (!s.signed) throw _err('not_linked');
  const k = String(convId);
  let st = await convState(k);
  if (!st || st.mode !== 1) st = await convState(k, { force: true });
  if (!st || st.mode !== 1) throw _err('not_e2ee');
  const body = String(text == null ? '' : text);
  if (body.length * 3 > BODY_MAX && new TextEncoder().encode(body).length > BODY_MAX) throw _err('too_large');
  const cmid = String(o.cmid || ('e5_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)));
  const members = st.members.includes(s.uid) ? st.members.slice() : st.members.concat([s.uid]);
  const payload = { v: 1, t: o.editOf ? 'edit' : 'text', conv: k, cmid, ts: Date.now(), body };
  if (o.editOf) { payload.edit_of = String(o.editOf); payload.edit_of_cmid = String(o.editOfCmid || (_byMid.get(String(o.editOf)) || {}).cmid || ''); }
  const rep = !o.editOf ? _replyField(o.reply) : null;
  if (rep) payload.reply = { ...rep, sender_uid: rep.sender_uid || undefined };
  if (o.mentionAll) payload.mention_all = true;
  if (o.fwd) payload.fwd = { n: Math.max(1, Number(o.fwd) || 1) };
  if (o.via === 'bia') payload.via = 'bia'; // [e2ee5 WP-08c→WP-17] resposta da Bia a pedido explícito (D2), cifrada p/ todos
  const t0 = Date.now();
  let r;
  try {
    r = await _C().encrypt(k, members, payload);
  } catch (e) {
    _log('encrypt_fail', { conv: k, code: e && e.code });
    throw e;
  }
  try { _health()?.recordEncrypt(Date.now() - t0, { claimed: (r && r.keyShareRequests) > 0 }); } catch (_) {}
  const env = r.envelopeJson;
  _plainPut(env, { conv: k, mid: null, cmid, text: body, t: payload.t, payload, sender: s.email || _me(), ts: payload.ts });
  _sealMetaPut(env, { has_link: _LINK_RE.test(body), mention_all: !!o.mentionAll, edit_of: o.editOf ? String(o.editOf) : null, cmid });
  _log('sealed', { conv: k, len: env.length, ms: Date.now() - t0 });
  return env;
}

/**
 * Gancho do `api._chatSendInner` (ANTES de qualquer transporte, inclusive a fila nativa):
 *   null                         → conversa normal: segue o caminho de hoje
 *   {refuse:{code,message}}      → não enviar (nada sai do aparelho)
 *   {content, extra}             → enviar `content` (envelope) + campos em claro `extra`
 */
export async function sealForSend(convId, content, type, fileUrl, cmid, opts) {
  if (!isOn() || convId == null || convId === '') return null;
  const k = String(convId);
  let mode = convModeSync(k);
  if (mode == null) { const st = await convState(k).catch(() => null); mode = st ? st.mode : 0; }
  if (mode !== 1) {
    if (isEnvelope(content)) {
      // Estado mudou para 0 depois de cifrar: o texto local permite reenviar em claro (§5.4).
      const e = _plain.get(keyOf(content));
      if (e && e.t === 'text') return { content: e.text, extra: {}, downgraded: true };
      return { refuse: { code: 'e2ee5_not_e2ee', message: 'Esta conversa não é protegida.' } };
    }
    return null;
  }
  if (isEnvelope(content)) {
    const m = sealMetaOf(content) || {};
    return { content, extra: _extraOf(m) };
  }
  if (fileUrl || (type && type !== 'text')) {
    // F1 = texto. Mídia/local/contato/enquete cifrados entram na F2/F3 (WP-09/WP-11): nada vai em claro.
    return { refuse: { code: 'e2ee5_unsupported_type', message: 'Este tipo de mensagem ainda não pode ser enviado numa conversa protegida.' } };
  }
  try {
    const env = await sealText(k, content, { cmid, reply: opts && opts.reply, mentionAll: opts && opts.mentionAll, fwd: opts && opts.fwd, via: opts && opts.via, editOf: opts && opts.editOf, editOfCmid: opts && opts.editOfCmid });
    return { content: env, extra: _extraOf(sealMetaOf(env) || {}) };
  } catch (e) {
    return { refuse: { code: (e && e.code) || 'encrypt_failed', message: 'Não foi possível criptografar a mensagem. Nada foi enviado.' } };
  }
}

function _extraOf(m) {
  const x = {};
  if (m.has_link != null) x.has_link = !!m.has_link;
  if (m.mention_all) x.mention_all = true;
  if (m.edit_of) x.edit_of = m.edit_of;
  return x;
}

/** Depois do chat_send (api): id do servidor ↔ texto local; recusa por estado → re-busca o estado. */
export function afterSend(convId, content, result) {
  if (!isOn()) return;
  try {
    const d = result && result.data;
    if (result && result.success && d && d.id != null && isEnvelope(content)) noteServerId(content, d.id);
    const code = (result && (result.code || (d && d.code))) || '';
    if (code === 'e2ee5_plaintext_refused' || code === 'e2ee5_not_e2ee') {
      if (code === 'e2ee5_plaintext_refused') { try { _health()?.recordPlaintextRefused(); } catch (_) {} }
      convState(String(convId), { force: true }).catch(() => {});
    }
  } catch (_) {}
}

/**
 * Gancho do api.chatEdit: em conversa E2EE a edição vai como linha NOVA (chat_send + edit_of).
 * `content` = envelope já selado (sealEdit) ou texto. → resultado no formato do chat_edit, ou null
 * (não é E2EE: caminho de hoje).
 */
export async function editViaSend(messageId, content, convId) {
  if (!isOn()) return null;
  const pe = _byMid.get(String(messageId));
  let conv = convId != null ? String(convId) : (pe ? pe.conv : '');
  let meta = isEnvelope(content) ? sealMetaOf(content) : null;
  if (!conv && meta && _plain.get(keyOf(content))) conv = _plain.get(keyOf(content)).conv;
  if (!conv) return isEnvelope(content) ? { success: false, code: 'e2ee5_edit_stale', message: 'e2ee5_edit_stale' } : null;
  const st = await convState(conv).catch(() => null);
  if (!st || st.mode !== 1) return isEnvelope(content) ? { success: false, code: 'e2ee5_not_e2ee', message: 'e2ee5_not_e2ee' } : null;
  let env = content;
  if (!isEnvelope(env)) {
    try { env = await sealEdit(conv, messageId, String(content || '')); } catch (e) { return { success: false, code: (e && e.code) || 'encrypt_failed', message: 'encrypt_failed' }; }
    meta = sealMetaOf(env);
  }
  if (!meta || String(meta.edit_of) !== String(messageId)) {
    // Envelope sem os metadados desta sessão (ex.: fila offline depois de reiniciar): não dá para
    // saber o cmid cifrado → não manda algo que ninguém decifraria.
    return { success: false, code: 'e2ee5_edit_stale', message: 'e2ee5_edit_stale' };
  }
  const r = await _A().chatSend(conv, env, 'text', null, null, null, null, meta.cmid, null, { skipRust: true, editOf: String(messageId) });
  if (r && r.success) return { success: true, data: { id: messageId, edited_at: new Date().toISOString(), edit_row_id: r.data ? r.data.id : undefined } };
  return r || { success: false, message: 'edit_failed' };
}

/** Edição (§2.4 t=edit): linha NOVA com edit_of em claro. → envelope. */
export function sealEdit(convId, targetId, text) {
  const pe = _byMid.get(String(targetId));
  return sealText(convId, text, { editOf: String(targetId), editOfCmid: pe ? pe.cmid : '' });
}

// ───────────────────────────────────────────────────────────── cache local do texto decifrado

const _plain = new Map();  // keyOf(env) → entry {conv, mid, cmid, text, t, payload, sender, ts}
const _byMid = new Map();  // mid → entry (citação/encaminhar/edição)
const _fail = new Map();   // keyOf → {reason, state, at}
const _inflight = new Map();
const _emailUid = new Map(); // e-mail canônico → uid (aprendido)

// Edições t:edit por alvo (mid → {text, sender, ts, n}): o alvo mostra a versão mais nova mesmo
// depois que a linha de edição saiu da lista. Só vale edição do MESMO remetente do alvo.
const _edits = new Map();
function _noteEdit(e) {
  if (!e || e.t !== 'edit' || !e.payload || e.payload.edit_of == null) return;
  const tid = String(e.payload.edit_of);
  const prev = _edits.get(tid);
  const ts = Number(e.ts) || Date.now();
  if (!prev || ts >= prev.ts) _edits.set(tid, { text: e.text, sender: e.sender || '', ts, n: (prev ? prev.n : 0) + 1 });
  else prev.n += 1;
  if (_edits.size > 2000) _edits.delete(_edits.keys().next().value);
}
export function editOf(mid, sender) {
  const ed = mid == null ? null : _edits.get(String(mid));
  if (!ed) return null;
  if (sender && ed.sender && _canon(ed.sender) !== _canon(sender)) return null;
  return ed;
}

function _plainPut(env, entry) {
  const k = keyOf(env);
  if (!k) return;
  _noteEdit(entry);
  _plain.delete(k);
  _plain.set(k, entry);
  if (entry.mid != null) _byMid.set(String(entry.mid), entry);
  if (_plain.size > PLAIN_MEM_MAX) {
    const old = _plain.keys().next().value;
    const oe = _plain.get(old);
    _plain.delete(old);
    if (oe && oe.mid != null && _byMid.get(String(oe.mid)) === oe) _byMid.delete(String(oe.mid));
  }
  _fail.delete(k);
  _persistPut(k, entry);
}

/** Texto já decifrado neste aparelho (síncrono). → entry | null */
export function peek(env) { return _plain.get(keyOf(env)) || null; }
export function peekByMid(mid) { return mid == null ? null : (_byMid.get(String(mid)) || null); }
export function peekFailure(env) { const f = _fail.get(keyOf(env)); return f ? f.state : null; }

/** Anota o id do servidor de uma mensagem que eu mesmo selei (✓ do envio). */
export function noteServerId(env, mid) {
  if (!isEnvelope(env) || mid == null) return;
  const e = _plain.get(keyOf(env));
  if (!e) return;
  e.mid = String(mid);
  _byMid.set(String(mid), e);
  _persistPut(keyOf(env), e);
}

// ── persistência local (web: IndexedDB, valores cifrados AES-GCM com chave não-exportável)
const IDB_NAME = 'chatyy-e2ee5-plain';
const IDB_STORE = 'p';
let _idbP = null;
let _wrapP = null;

function _idbOk() {
  try { return Platform.OS === 'web' && typeof globalThis.indexedDB !== 'undefined' && !!globalThis.crypto && !!globalThis.crypto.subtle; } catch (_) { return false; }
}
function _idb() {
  if (!_idbP) {
    _idbP = new Promise((resolve, reject) => {
      const req = globalThis.indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => { try { req.result.createObjectStore(IDB_STORE); } catch (_) {} };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((e) => { _idbP = null; throw e; });
  }
  return _idbP;
}
function _idbReq(mode, fn) {
  return _idb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, mode);
    const st = tx.objectStore(IDB_STORE);
    let out;
    try { out = fn(st); } catch (e) { reject(e); return; }
    tx.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}
function _wrapKey(uid) {
  if (!_wrapP || _wrapP.uid !== uid) {
    const p = (async () => {
      const kk = 'k|' + uid;
      let key = await _idbReq('readonly', (st) => st.get(kk));
      if (!key) {
        key = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        await _idbReq('readwrite', (st) => st.put(key, kk));
      }
      return key;
    })();
    _wrapP = { uid, p };
    p.catch(() => { if (_wrapP && _wrapP.p === p) _wrapP = null; });
  }
  return _wrapP.p;
}
const _te = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const _td = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
async function _encVal(uid, obj) {
  const key = await _wrapKey(uid);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: _te.encode('e5p|' + uid) }, key, _te.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length); out.set(iv, 0); out.set(ct, 12);
  return out;
}
async function _decVal(uid, bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 13) return null;
  try {
    const key = await _wrapKey(uid);
    const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: _te.encode('e5p|' + uid) }, key, bytes.slice(12));
    return JSON.parse(_td.decode(pt));
  } catch (_) { return null; }
}
function _pkey(uid, conv, k) { return 'm|' + uid + '|' + conv + '|' + k; }

function _persistPut(k, entry) {
  if (!_idbOk() || !_sess || !entry || !entry.conv) return;
  const uid = _sess.uid;
  const v = { conv: entry.conv, mid: entry.mid, cmid: entry.cmid, text: entry.text, t: entry.t, payload: entry.payload, sender: entry.sender, ts: entry.ts };
  _encVal(uid, v).then((b) => _idbReq('readwrite', (st) => st.put(b, _pkey(uid, entry.conv, k)))).catch(() => {});
}
async function _persistGet(conv, k) {
  if (!_idbOk() || !_sess) return null;
  try {
    const uid = _sess.uid;
    const b = await _idbReq('readonly', (st) => st.get(_pkey(uid, conv, k)));
    return b ? await _decVal(uid, b) : null;
  } catch (_) { return null; }
}
async function _persistScan(conv) {
  if (!_idbOk() || !_sess) return [];
  const uid = _sess.uid;
  const lo = 'm|' + uid + '|' + conv + '|';
  try {
    const vals = await _idbReq('readonly', (st) => st.getAll(IDBKeyRange.bound(lo, lo + '￿'), 5000));
    const out = [];
    for (const b of (vals || [])) { const v = await _decVal(uid, b); if (v) out.push(v); }
    return out;
  } catch (_) { return []; }
}

// ── nativo (WP-08a/08b): a ingestão nativa já decifra e grava `e2e_plain` no store; o JS lê de lá
function _nativeMod(name) {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try { const { requireOptionalNativeModule } = require('expo'); return requireOptionalNativeModule(name) || null; } catch (_) { return null; }
}
function _nativePlain(conv, id) {
  if (id == null || !/^\d+$/.test(String(id))) return null;
  const st = _nativeMod('ChatyyChatStore');
  if (!st || typeof st.e2ePlainSync !== 'function') return null;
  try {
    const j = JSON.parse(st.e2ePlainSync(_me(), String(conv), JSON.stringify([Number(id)])) || '{}') || {};
    return j[String(id)] || null;
  } catch (_) { return null; }
}
function _nativeNoteConv(conv, mode) {
  const m = _nativeMod('ChatyyTransport');
  try { if (m && typeof m.e2eeNoteConv === 'function') m.e2eeNoteConv(_me(), String(conv), mode === 1 ? 1 : 0); } catch (_) {}
}
let _nativeSub = null;
function _wireNative() {
  if (_nativeSub) return;
  const m = _nativeMod('ChatyyTransport');
  if (!m || typeof m.addListener !== 'function') return;
  try {
    _nativeSub = m.addListener('onE2EEPlain', (ev) => {
      if (!isOn() || !ev || !Array.isArray(ev.items)) return;
      for (const it of ev.items) {
        if (!it || it.conv == null) continue;
        _emitLocal('e2ee5_plain', { conversation_id: String(it.conv), id: it.id, native: true });
      }
    });
  } catch (_) {}
}

// ───────────────────────────────────────────────────────────── decifrar

const _devCache = new Map(); // uid → {at, devs}
async function _devicesOf(uid) {
  const c = _devCache.get(uid);
  if (c && Date.now() - c.at < 60000) return c.devs;
  let devs = [];
  try { devs = (await _C().listDevices(uid)) || []; } catch (_) { devs = []; }
  _devCache.set(uid, { at: Date.now(), devs });
  return devs;
}

// O núcleo exige o uid do remetente (confere com a sessão Megolm). A linha só tem o e-mail:
// eu mesmo → meu uid; aprendido antes → cache; 1:1 → o outro membro; grupo → aparelho do envelope.
async function _senderUid(convId, email, env, hint) {
  if (hint) return String(hint);
  const s = _sess;
  const em = _canon(email);
  if (s && em && em === _canon(s.email)) return s.uid;
  if (em && _emailUid.has(em)) return _emailUid.get(em);
  const st = await convState(convId);
  const others = ((st && st.members) || []).filter((u) => !s || u !== s.uid);
  if (others.length === 1 && em) return others[0];
  if (!em && s && others.length === 0) return s.uid;
  const dev = /"device_id":"([^"]+)"/.exec(env || '');
  const skey = /"sender_key":"([^"]+)"/.exec(env || '');
  if (dev || skey) {
    for (const u of others.slice(0, 64)) {
      const devs = await _devicesOf(u);
      if (devs.some((d) => (dev && d.deviceId === dev[1]) || (skey && d.curve25519 === skey[1]))) return u;
    }
  }
  if (others.length === 1) return others[0];
  return null;
}

function _rowTs(row) {
  const t = Date.parse((row && row.created_at) || '');
  return Number.isFinite(t) ? t : Date.now();
}

/**
 * Decifra uma linha (`{id, conversation_id, sender_email, content, client_message_id, created_at}`).
 * → entry {text, t, payload, …} | {error, state}. Nunca lança. Ao decifrar emite o evento LOCAL
 * `e2ee5_plain` {conversation_id, key, id} (lista/conversa repintam).
 */
export function decryptRow(row, convId) {
  const env = row && row.content;
  const conv = String(convId != null ? convId : (row && row.conversation_id) || '');
  if (!isOn() || !isEnvelope(env) || !conv) return Promise.resolve({ error: 'disabled', state: 'update_to_read' });
  const k = keyOf(env);
  const hit = _plain.get(k);
  if (hit) {
    if (row.id != null && /^\d+$/.test(String(row.id)) && hit.mid !== String(row.id)) { hit.mid = String(row.id); _byMid.set(hit.mid, hit); }
    return Promise.resolve(hit);
  }
  if (_inflight.has(k)) return _inflight.get(k);
  const p = (async () => {
    const np = _nativePlain(conv, row.id);
    if (np && np.state === 'ok' && np.payload) {
      let payload = {};
      try { payload = JSON.parse(np.payload) || {}; } catch (_) { payload = {}; }
      const e = { conv, mid: String(row.id), cmid: String(payload.cmid || np.cmid || ''), text: typeof payload.body === 'string' ? payload.body : '', t: String(payload.t || 'text'), payload, sender: _norm(row.sender_email), ts: _rowTs(row), trust: np.trust };
      _plain.set(k, e); _byMid.set(e.mid, e); _fail.delete(k); _unwait(conv, k); _noteEdit(e);
      _emitLocal('e2ee5_plain', { conversation_id: conv, key: k, id: row.id });
      return e;
    }
    const pk = await _persistGet(conv, k);
    if (pk && typeof pk.text === 'string') {
      const e = { ...pk, mid: row.id != null && /^\d+$/.test(String(row.id)) ? String(row.id) : pk.mid };
      _plain.set(k, e);
      if (e.mid != null) _byMid.set(String(e.mid), e);
      _noteEdit(e);
      _emitLocal('e2ee5_plain', { conversation_id: conv, key: k, id: row.id });
      return e;
    }
    const s = await ensureSession();
    if (!s) return _setFail(k, 'no_session', row, conv);
    const su = await _senderUid(conv, row.sender_email, env, row._senderUid);
    if (!su) return _setFail(k, 'sender_unknown', row, conv);
    try {
      const d = await _C().decrypt({ convId: conv, envelopeJson: env, senderUid: su, serverMid: String(row.id != null ? row.id : ''), cmid: String(row.client_message_id || row._client_id || ''), tsMs: _rowTs(row) });
      let payload = {};
      try { payload = JSON.parse(d.payloadJson || '{}') || {}; } catch (_) { payload = {}; }
      const em = _canon(row.sender_email);
      if (em) _emailUid.set(em, su);
      const entry = {
        conv, mid: row.id != null && /^\d+$/.test(String(row.id)) ? String(row.id) : null,
        cmid: String(payload.cmid || row.client_message_id || ''),
        text: typeof payload.body === 'string' ? payload.body : '',
        t: String(payload.t || 'text'), payload, sender: _norm(row.sender_email), ts: _rowTs(row), trust: d.trust,
      };
      const wasWaiting = _fail.has(k);
      _plainPut(env, entry);
      _unwait(conv, k);
      if (wasWaiting) { try { _health()?.recordResolved(k); } catch (_) {} }
      _emitLocal('e2ee5_plain', { conversation_id: conv, key: k, id: row.id });
      return entry;
    } catch (e) {
      const reason = (e && (e.reason || e.code)) || 'internal';
      return _setFail(k, reason, row, conv);
    }
  })().finally(() => { _inflight.delete(k); });
  _inflight.set(k, p);
  return p;
}

function _setFail(k, reason, row, conv, forceState) {
  const retry = RETRYABLE.has(String(reason));
  const state = forceState || (retry ? 'waiting' : (reason === 'no_core' || reason === 'unsupported' ? 'update_to_read' : 'cannot_decrypt'));
  const first = !_fail.has(k);
  _fail.set(k, { reason, state, at: Date.now() });
  if (retry && state === 'waiting') {
    _wait(conv, k, row);
    try { _health()?.recordDecrypt(false, reason === 'no_session' || reason === 'sender_unknown' ? 'missing_session' : reason, k); } catch (_) {}
  }
  if (first) _emitLocal('e2ee5_plain', { conversation_id: conv, key: k, id: row && row.id, failed: state });
  _log('utd', { conv, mid: row && row.id, reason });
  return { error: reason, state };
}

// "aguardando": re-tenta quando chegam chaves novas da conversa; 60 s → decrypt_report ao remetente.
const _waiting = new Map(); // conv → Map(k → {row, at, reported})
function _wait(conv, k, row) {
  let m = _waiting.get(conv);
  if (!m) { m = new Map(); _waiting.set(conv, m); }
  if (!m.has(k)) {
    m.set(k, { row, at: Date.now(), reported: false });
    try { setTimeout(() => _maybeReport(conv, k), REPORT_AFTER_MS + 500); } catch (_) {}
  }
}
function _unwait(conv, k) { const m = _waiting.get(conv); if (m) { m.delete(k); if (!m.size) _waiting.delete(conv); } }
function _retryWaiting(conv) {
  const m = _waiting.get(conv);
  if (!m) return;
  for (const [k, w] of Array.from(m)) {
    _fail.delete(k);
    decryptRow(w.row, conv).catch(() => {});
  }
}
async function _maybeReport(conv, k) {
  const m = _waiting.get(conv);
  const w = m && m.get(k);
  if (!w || w.reported || !_sess) return;
  w.reported = true;
  try {
    const su = await _senderUid(conv, w.row.sender_email, w.row.content, w.row._senderUid);
    if (!su || su === _sess.uid) return;
    const sid = /"session_id":"([^"]+)"/.exec(w.row.content || '');
    await _C().sendToDevice('chatyy.decrypt_report', [{ uid: su, deviceId: '' }], { v: 1, conv_id: conv, mid: String(w.row.id || ''), session_id: sid ? sid[1] : '', reason: (_fail.get(k) || {}).reason || 'missing_session', ts: Date.now() });
  } catch (_) {}
}

// ───────────────────────────────────────────────────────────── linhas da conversa

/**
 * Gancho do decryptMessages da conversa (síncrono): devolve a linha com o texto decifrado (cache)
 * ou um placeholder, e dispara a decifragem em 2º plano (o evento `e2ee5_plain` repinta).
 * `_e2eRaw` fica SEMPRE (caches persistem o envelope, nunca o texto). null = não é v5.
 */
export function applyToRow(msg, raw, convId, t) {
  if (!msg || typeof raw !== 'string' || !isV5Family(raw)) return null;
  const v = envVersion(raw);
  if (v !== 5 || !isOn()) {
    return { ...msg, content: stateText(t, 'update_to_read'), _e2e: true, _e2eRaw: raw, _e5State: 'update_to_read' };
  }
  const e = _plain.get(keyOf(raw));
  if (e) return _rowFromEntry(msg, raw, e);
  const f = _fail.get(keyOf(raw));
  decryptRow({ ...msg, content: raw }, convId != null ? convId : msg.conversation_id).catch(() => {});
  if (f) return { ...msg, content: stateText(t, f.state), _e2e: true, _e2eFailed: f.state !== 'waiting', _e2eRaw: raw, _e5State: f.state };
  return { ...msg, content: '...', _e2e: true, _e2eRaw: raw, _e5State: 'decrypting' };
}

function _rowFromEntry(msg, raw, e) {
  const out = { ...msg, content: e.text, _e2e: true, _e2eRaw: raw };
  delete out._e5State; delete out._e2eFailed;
  const ed = e.t !== 'edit' ? editOf(msg.id, e.sender || msg.sender_email) : null;
  if (ed) { out.content = ed.text; out.edited = true; out.edited_at = msg.edited_at || new Date(ed.ts).toISOString(); out.edited_count = Math.max(Number(msg.edited_count) || 0, ed.n); }
  const p = e.payload || {};
  if (e.t === 'edit' && p.edit_of) out._e5EditOf = String(p.edit_of);
  if (p.reply && (p.reply.quote || p.reply.mid)) {
    const rt = msg.reply_to && typeof msg.reply_to === 'object' ? msg.reply_to : { id: Number(p.reply.mid) || p.reply.mid };
    const pe = p.reply.mid != null ? _byMid.get(String(p.reply.mid)) : null;
    out.reply_to = { ...rt, content: (pe && pe.text) || p.reply.quote || '', type: rt.type || p.reply.qt || 'text' };
  }
  if (p.fwd && !msg.forwarded_from) out._e5Fwd = Number(p.fwd.n) || 1;
  if (p.mention_all) out._e5MentionAll = true;
  return out;
}

/**
 * Edições `t:edit` (linhas novas com edit_of): aplica o texto na mensagem alvo e tira a linha de
 * edição da lista. Devolve o MESMO array quando não há nada a fazer.
 */
export function foldEdits(list) {
  if (!Array.isArray(list) || !list.length) return list;
  let edits = null;
  for (const m of list) if (m && m._e5EditOf) (edits || (edits = [])).push(m);
  if (!edits) return list;
  const byTarget = new Map();
  for (const ed of edits) {
    const prev = byTarget.get(ed._e5EditOf);
    const ts = Date.parse(ed.created_at || '') || 0;
    if (!prev || ts >= prev.ts) byTarget.set(ed._e5EditOf, { ts, row: ed, n: (prev ? prev.n : 0) + 1 });
    else prev.n += 1;
  }
  const out = [];
  for (const m of list) {
    if (!m) { out.push(m); continue; }
    if (m._e5EditOf) continue;
    const ed = byTarget.get(String(m.id));
    if (ed && m.content !== ed.row.content && _canon(ed.row.sender_email) === _canon(m.sender_email)) {
      out.push({ ...m, content: ed.row.content, edited: true, edited_at: m.edited_at || ed.row.created_at || new Date().toISOString(), edited_count: Math.max(Number(m.edited_count) || 0, ed.n) });
    } else out.push(m);
  }
  return out;
}

/** O nó tem alguma linha v5 que ainda precisa repintar (para o efeito de "e2ee5_plain"). */
export function rowNeedsRefresh(m, key) {
  return !!(m && typeof m._e2eRaw === 'string' && isEnvelope(m._e2eRaw) && (!key || keyOf(m._e2eRaw) === key));
}

// ───────────────────────────────────────────────────────────── mensagens de sistema

/** 'on' | 'off' | null para `{"sys":"e2ee_on"|"e2ee_off"}` (sem JSON cru na UI). */
export function sysKind(content) {
  try {
    const o = typeof content === 'string' ? (content.trim().charAt(0) === '{' ? JSON.parse(content) : null) : content;
    if (!o || typeof o !== 'object') return null;
    if (o.sys === 'e2ee_on') return 'on';
    if (o.sys === 'e2ee_off') return 'off';
    if (o.sys === 'e2ee_member_update') return 'member_update';
  } catch (_) {}
  return null;
}
export function sysObj(content) {
  try { const o = typeof content === 'string' ? JSON.parse(content) : content; return o && typeof o === 'object' ? o : null; } catch (_) { return null; }
}
/** Texto (localizado) da mensagem de sistema — prévia da lista e balão sem a UI nova. */
export function sysText(t, content) {
  const k = sysKind(content);
  const o = sysObj(content) || {};
  if (k === 'on') return _tx(t, 'e2ee5.divider.on', 'A partir daqui, as mensagens são protegidas com criptografia de ponta a ponta.');
  if (k === 'off') {
    if (o.by_uid && _sess && String(o.by_uid) === _sess.uid && (o.reason || 'user') === 'user') {
      return _tx(t, 'e2ee5.divider.off_self', 'Você desativou a criptografia de ponta a ponta. As mensagens novas não são mais protegidas.');
    }
    return _tx(t, 'e2ee5.divider.off_generic', 'A criptografia de ponta a ponta foi desativada nesta conversa. As mensagens novas não são mais protegidas.');
  }
  if (k === 'member_update') return _tx(t, 'e2ee5.banner.needs_update_generic', 'Um participante precisa atualizar o Chatyy para ativar a criptografia.');
  return '';
}

// ───────────────────────────────────────────────────────────── prévia da lista

/**
 * Prévia de `last_message` (síncrona). null = não é v5 (código de hoje). Texto decifrado do cache
 * local; senão "Mensagem" genérica e decifra em 2º plano (evento `e2ee5_plain` repinta a linha).
 */
export function previewText(lastMsg, t, convId) {
  const c = lastMsg && lastMsg.content;
  if (typeof c !== 'string') return null;
  const s = c.trim();
  if (sysKind(s)) return sysText(t, s);
  if (!isV5Family(s)) return null;
  if (envVersion(s) !== 5 || !isOn()) return stateText(t, 'update_to_read');
  const e = _plain.get(keyOf(s));
  if (e) return e.text || _tx(t, 'e2ee5.msg.generic', 'Mensagem');
  const f = _fail.get(keyOf(s));
  const cid = convId != null ? convId : (lastMsg.conversation_id != null ? lastMsg.conversation_id : lastMsg.conv_id);
  if (cid != null) decryptRow({ ...lastMsg, content: s }, cid).catch(() => {});
  if (f && f.state !== 'waiting') return stateText(t, f.state);
  return _tx(t, 'e2ee5.msg.generic', 'Mensagem');
}

// ───────────────────────────────────────────────────────────── busca local

const _fold = (v) => { try { return String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); } catch (_) { return String(v || '').toLowerCase(); } };

/**
 * Busca no texto decifrado guardado NESTE aparelho (o servidor não indexa conversa E2EE).
 * → linhas `{id, conversation_id, sender_email, content, type, created_at, client_message_id}` (mais nova primeiro).
 */
/**
 * [e2ee5 WP-08c→WP-17] TODAS as mensagens decifradas guardadas NESTE aparelho para a conversa (memória +
 * cache local persistido), não só as da tela — exportação no aparelho. Nada vai ao servidor.
 * → `[{id, cmid, conversation_id, sender_email, content, t, payload, created_at, edited}]` (mais antiga primeiro).
 */
export async function listLocal(convId) {
  if (!isOn() || convId == null) return [];
  const conv = String(convId);
  const byId = new Map();
  const add = (e) => {
    if (!e || e.conv !== conv || e.t === 'edit') return;
    const id = String(e.mid || e.cmid || '');
    if (!id || byId.has(id)) return;
    const ed = e.mid ? editOf(e.mid, e.sender) : null;
    byId.set(id, { id: e.mid ? Number(e.mid) : id, cmid: e.cmid || null, conversation_id: Number(conv) || conv, sender_email: e.sender || '', content: ed ? ed.text : (e.text || ''), t: e.t || 'text', payload: e.payload || null, created_at: new Date(e.ts || 0).toISOString(), edited: !!ed });
  };
  const all = [..._plain.values()];
  try { all.push(...(await _persistScan(conv))); } catch (_) {}
  for (const e of all) _noteEdit(e);
  for (const e of all) add(e);
  return [...byId.values()].sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0));
}

export async function searchLocal(convId, query, limit = 60) {
  if (!isOn() || convId == null) return [];
  const toks = _fold(query).split(/\s+/).filter(Boolean).slice(0, 8);
  if (!toks.length) return [];
  const conv = String(convId);
  const seen = new Set();
  const rows = [];
  const consider = (e) => {
    if (!e || e.conv !== conv || e.t === 'edit' || !e.text) return;
    const id = e.mid || e.cmid;
    if (!id || seen.has(String(id))) return;
    const hay = _fold(e.text);
    if (!toks.every((tk) => hay.includes(tk))) return;
    seen.add(String(id));
    rows.push({ id: e.mid ? Number(e.mid) : id, conversation_id: Number(conv) || conv, sender_email: e.sender || '', content: e.text, type: 'text', created_at: new Date(e.ts || Date.now()).toISOString(), client_message_id: e.cmid || null, _e2e: true });
  };
  for (const e of _plain.values()) consider(e);
  for (const e of await _persistScan(conv)) consider(e);
  rows.sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0));
  return rows.slice(0, limit);
}

// ───────────────────────────────────────────────────────────── encaminhar (o cliente recifra)

/**
 * Encaminhar quando a ORIGEM é cifrada ou algum DESTINO é E2EE (o servidor recusa clonar envelope).
 * → null (não é caso E2EE: caminho do servidor) | {success, data:{results:[{conversation_id, success, error}]}}
 */
export async function forwardClient(messageId, targetIds, opts) {
  if (!isOn()) return null;
  const targets = (Array.isArray(targetIds) ? targetIds : [targetIds]).filter((x) => x != null && x !== '');
  if (!targets.length) return null;
  const src = _byMid.get(String(messageId)) || null;
  const states = await Promise.all(targets.map((id) => convState(id).catch(() => null)));
  const anyE2ee = states.some((s) => s && s.mode === 1);
  if (!src && !anyE2ee) return null;
  let text = src ? src.text : (opts && typeof opts.sourceText === 'string' ? opts.sourceText : null);
  if (src && src.t !== 'text' && src.t !== 'edit') text = null;
  if (text == null || text === '') {
    return { success: false, data: { results: targets.map((id) => ({ conversation_id: id, success: false, error: 'e2ee5_forward_unsupported' })) }, message: 'e2ee5_forward_unsupported' };
  }
  const n = (src && src.payload && src.payload.fwd ? Number(src.payload.fwd.n) || 1 : 0) + 1;
  const api = _A();
  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const id = targets[i];
    try {
      const r = await api.chatSend(id, text, 'text', null, null, null, null, null, null, { skipRust: true, fwd: n, _e5fwd: true });
      results.push({ conversation_id: id, success: !!(r && r.success), error: r && !r.success ? (r.code || r.message || 'failed') : undefined, message_id: r && r.data ? r.data.id : undefined });
    } catch (e) {
      results.push({ conversation_id: id, success: false, error: 'network' });
    }
  }
  const okN = results.filter((x) => x.success).length;
  return { success: okN > 0, data: { results, success: okN } };
}

// ───────────────────────────────────────────────────────────── outbox / relay (sem texto puro)

/** A linha do outbox desta conversa só pode guardar o envelope (ou nada) — §WP-08c. */
export function outboxScrub(payload) {
  if (!isOn() || !payload || payload.conversation_id == null) return payload;
  if (!isConvE2eeSync(payload.conversation_id)) return payload;
  const out = { ...payload };
  if (!isEnvelope(out.content)) { out.content = ''; out._e2eWanted = true; out._e2e = false; }
  else out._e2e = true;
  out.display_content = '';
  if (out.caption) out.caption = '';
  return out;
}

/** Relay WS (chat_message_relay): só envelope, sem citação/prévia em claro. null = não relayar. */
export function relayScrub(conversationId, message) {
  if (!message || typeof message !== 'object') return message;
  const env = isEnvelope(message.content);
  if (!env) {
    if (isOn() && isConvE2eeSync(conversationId) && message.type !== 'system') return null;
    return message;
  }
  const m = { ...message };
  if (m.reply_to && typeof m.reply_to === 'object') m.reply_to = { id: m.reply_to.id };
  delete m.reply_quote_text; delete m.link_preview; delete m.thumb_b64; delete m.file_name; delete m._e2eRaw;
  if (!m.client_message_id && m._client_id) m.client_message_id = m._client_id;
  return m;
}

const e2ee5 = {
  isOn, isEnvelope, envVersion, isV5Family, keyOf, stateText, ensureSession, onWsAuth, endSession, requestSync,
  wsAuthFields, convState, convModeSync, convStateSync, isConvE2eeSync, watchConversation, prepareConversation,
  setConversationMode, sealText, sealEdit, sealForSend, sealMetaOf, peek, peekByMid, peekFailure, noteServerId,
  decryptRow, applyToRow, foldEdits, rowNeedsRefresh, sysKind, sysText, previewText, searchLocal, forwardClient,
  outboxScrub, relayScrub, afterSend, editViaSend, editOf, listLocal, sessionSync, deviceIdSync, myUidSync, isReadySync,
};
export default e2ee5;
