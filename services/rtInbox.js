// [sgu F1/F2 2026-10-23] Fila do APARELHO no roteador regional (rt_pull) → store local → `persisted`.
// Plano /root/sem-gravar-no-us-2026-10-22/PLANO.md §4.1 "App"/"Roteador — fetch", §5.2 "App", §8 (A5).
// Contrato esperado do servidor: /root/sem-gravar-no-us-2026-10-22/app/CONTRATO-APP.md (o app fala só com o
// PHP/leaf, nunca direto com o roteador).
//
// Fluxo: rt_pull (HTTP `chat_rt_pull`, cursor por conta+aparelho) → para cada item {cid, mid, envelope,…}:
//   - linha ainda não está no aparelho → grava (SQLite nativo; IndexedDB persistente na web, W1) e SÓ DEPOIS do
//     COMMIT o dlvPersisted manda `persisted` (F0, chat_dlv_persisted) → o roteador libera a inbox deste aparelho;
//   - linha já está (chegou ao vivo / PG na F1) → compara o envelope (F1: rt_cmp_ok / rt_cmp_mismatch, só contagem)
//     e reafirma `persisted`.
// Também: pullMids() para a hidratação de esqueleto (rtStore.hydrateResponse) e herança de inbox (A5) quando este
// é um aparelho novo da conta (reinstalou / trocou de celular): `chat_rt_inherit` uma vez por (conta, aparelho).
//
// Só liga quando há conversa body_store conhecida (rtStore) ou o servidor anuncia `rtstore` nas caps do WS
// (ou QA: globalThis.__chatyy_rt_inbox = true). Conversa sem a flag: nada roda.
// Kill OTA: globalThis.__chatyy_rt_inbox = false (pull, herança e pullMids) · __chatyy_rt_inherit = false (só A5)
//           · __chatyy_rt_web = false (web não guarda corpo nem manda persisted).

import { AppState, Platform } from 'react-native';

const isWeb = Platform.OS === 'web';
const CURSOR_KEY = 'chatyy_rt_cursor_v1';   // { 'conta|aparelho': cursor }
const INH_KEY = 'chatyy_rt_inh_v1';         // { 'conta|aparelho': ts }
const PAUSE_MS = 6 * 3600 * 1000;
const FG_THROTTLE_MS = 20 * 1000;
const MAX_PAGES = 10;
const PAGE = 200;
export const PULL_ACTION = 'chat_rt_pull';
export const INHERIT_ACTION = 'chat_rt_inherit';

let _started = false;
let _pausedUntil = 0;
let _pulling = null;      // Promise do pull por cursor em curso
let _again = false;
let _lastPullAt = 0;
let _inhBusy = false;
const _midWait = new Map(); // mid → Promise<{env|null, gone}>
let _ackQ = [];             // mids gravados desde o último pull (vai no próximo pedido; opcional p/ o servidor)
const _m = { pulled: 0, stored: 0, cmp_ok: 0, cmp_mismatch: 0, cmp_missing_local: 0, bad: 0, unavailable: {} };

function _flag(n) { try { return globalThis[n]; } catch { return undefined; } }
function _killed() { return _flag('__chatyy_rt_inbox') === false; }
function _webStoreOn() {
  if (!isWeb) return true;
  if (_flag('__chatyy_rt_web') === false) return false;
  try { return !!require('./localDb').webPersistedSync?.(); } catch { return false; }
}
function _serverAnnounces() {
  try { const c = require('./websocket').default?.serverCaps; return Array.isArray(c) && (c.includes('rtstore') || c.includes('rtstore1')); } catch { return false; }
}
export function isActive() {
  if (_killed()) return false;
  if (isWeb && !_webStoreOn()) return false;
  if (_flag('__chatyy_rt_inbox') === true) return true;
  try { if (require('./rtStore').hasRtConvs()) return true; } catch {}
  return _serverAnnounces();
}

function _acct() {
  try { const api = require('./api'); return String(api.getActiveAccountEmail?.() || api.getTokenMeta?.()?.email || '').trim().toLowerCase(); } catch { return ''; }
}
function _dev(acct) { try { return require('./dlvDevice').dlvDeviceIdSync(acct) || ''; } catch { return ''; } }
function _mmGet(k) { try { const raw = require('./mmkv').getString(k); return raw ? JSON.parse(raw) : {}; } catch { return {}; } }
function _mmSet(k, v) { try { require('./mmkv').setString(k, JSON.stringify(v)); } catch {} }

/** Capacidade `rtstore1` (auth WS): este app guarda o corpo antes do persisted e busca no roteador. */
export function capRtstore1() {
  if (_killed()) return false;
  if (!isWeb) return true;
  return _webStoreOn();
}

export function noteUnavailableShown(why) {
  const k = String(why || 'gone').slice(0, 24);
  _m.unavailable[k] = (_m.unavailable[k] || 0) + 1;
}
export function getRtInboxStats() { return { ..._m, unavailable: { ..._m.unavailable }, paused_until: _pausedUntil, active: isActive(), started: _started }; }

// ─── item do roteador → linha local ─────────────────────────────────────────
function _iso(ts) {
  if (ts == null || ts === '') return '';
  if (typeof ts === 'number' || /^\d+$/.test(String(ts))) { const n = Number(ts); return new Date(n < 1e12 ? n * 1000 : n).toISOString(); }
  return String(ts);
}
function _b64(s) {
  try {
    const bin = globalThis.atob ? globalThis.atob(String(s)) : '';
    try { return decodeURIComponent(escape(bin)); } catch { return bin; }
  } catch { return ''; }
}
// Aceita o item do PHP (envelope) ou o registro cru do roteador F1 (/pull: env_b64, from, kind, sha).
function _row(it) {
  if (it && it.kind && it.kind !== 'msg') return null; // reação/recibo/apagar: rtF4.applyItems
  if (it && (it.tomb || (typeof it.envelope === 'string' && it.envelope.startsWith('{"e2e_del":1')))) return null; // [sgu F4] lápide = evento de apagar
  const env = it && (it.envelope || it.e || it.content || (it.env_b64 ? _b64(it.env_b64) : ''));
  if (it && !it.from_uid && !it.from_email && it.from) { if (String(it.from).includes('@')) it.from_email = it.from; else it.from_uid = it.from; }
  const mid = Number(it && (it.mid || it.id));
  const cid = Number(it && (it.cid || it.conversation_id));
  if (typeof env !== 'string' || !env.startsWith('{"e2e":5') || !(mid > 0) || !(cid > 0)) return null;
  const r = {
    id: mid, conversation_id: cid, content: env, type: String(it.type || 'text'),
    sender_email: String(it.from_email || it.sender_email || ''),
    created_at: _iso(it.ts != null ? it.ts : it.created_at),
    client_message_id: it.cmid || it.client_message_id || null,
    reply_to_id: it.reply_to_id || null,
    pending_state: 'sent', _rt: 1,
  };
  if (it.from_uid || it.sender_uid) r.sender_uid = String(it.from_uid || it.sender_uid);
  if (it.from_device) r.sender_device = String(it.from_device);
  if (it.edit_of) r.edit_of = it.edit_of;
  if (it.mentions) r.mentions = it.mentions;
  if (it.mention_all) r.mention_all = it.mention_all;
  if (it.file_size || it.size) r.file_size = Number(it.file_size || it.size) || 0;
  return r;
}

async function _existingNative(ids) {
  try { return await require('./db').dbExistingMessageIds(ids); } catch { return new Set(); }
}

/** Grava os itens no store local; devolve Map(mid → envelope) do que ficou gravado/confirmado. */
async function _ingest(items, opts) {
  const out = new Map();
  if (!Array.isArray(items) || !items.length) return out;
  if (opts && opts.transient) { for (const it of items) { const r = _row(it); if (r) out.set(String(r.id), r.content); } return out; }
  const byCid = new Map();
  for (const it of items) {
    const r = _row(it);
    if (!r) { if (!(it && it.kind && it.kind !== 'msg')) _m.bad++; continue; }
    let l = byCid.get(r.conversation_id); if (!l) { l = []; byCid.set(r.conversation_id, l); }
    l.push(r);
  }
  const rtStore = require('./rtStore');
  const touched = [];
  for (const [cid, rows] of byCid) {
    try { if (!rtStore.convBodyStore(cid)) rtStore.noteConvBodyStore(cid, 2); } catch {}
    _m.pulled += rows.length;
    let fresh = rows; let had = [];
    if (!isWeb) {
      const ex = await _existingNative(rows.map((r) => r.id));
      fresh = rows.filter((r) => !ex.has(Number(r.id)));
      had = rows.filter((r) => ex.has(Number(r.id)));
    } else {
      let local = new Map();
      try { local = await require('./localDb').webGetEnvelopesByIds(rows.map((r) => r.id)); } catch {}
      fresh = rows.filter((r) => !local.has(String(r.id)));
      had = rows.filter((r) => local.has(String(r.id)));
    }
    // F1: compara o que já está no aparelho (veio ao vivo / do PG) com a cópia do roteador. Só contagem.
    if (had.length) {
      let localEnv = new Map();
      try { localEnv = isWeb ? await require('./localDb').webGetEnvelopesByIds(had.map((r) => r.id)) : rtStore.localEnvelopesSync(had.map((r) => r.id)); } catch {}
      const okRows = [];
      for (const r of had) {
        const e = localEnv.get(String(r.id));
        if (!e) { _m.cmp_missing_local++; fresh.push(r); continue; } // linha local sem envelope (esqueleto antigo) → grava
        if (e === r.content) { _m.cmp_ok++; okRows.push(r); } else _m.cmp_mismatch++;
        out.set(String(r.id), e);
      }
      // já gravado aqui → reafirma o persisted (o anel do dlvPersisted não repete o que já foi)
      if (okRows.length) { try { require('./dlvPersisted').noteSaved(cid, okRows, { web: isWeb }); } catch {} for (const r of okRows) _ackQ.push(r.id); }
    }
    if (!fresh.length) continue;
    try {
      if (!isWeb) {
        await require('./db').dbSaveMessages(cid, fresh); // COMMIT → noteSaved (persisted) lá dentro
      } else {
        const ok = await require('./localDb').webSaveMessages(cid, fresh);
        if (ok === false) continue;
        try { require('./dlvPersisted').noteSaved(cid, fresh, { web: true }); } catch {}
      }
      for (const r of fresh) { out.set(String(r.id), r.content); _ackQ.push(r.id); }
      _m.stored += fresh.length;
      touched.push(cid);
    } catch {}
  }
  if (_ackQ.length > 2000) _ackQ = _ackQ.slice(-2000);
  if (touched.length) {
    try {
      const ws = require('./websocket').default;
      for (const cid of touched) ws?._emit?.('envelope_available', { conversation_id: cid, source: 'rt' });
    } catch {}
  }
  return out;
}

/** [sgu F4] itens de mensagem vindos de outra fonte (chat_f4_sync): mesmo caminho do pull (grava → persisted). */
export async function ingestItems(items) {
  if (_killed() || (isWeb && !_webStoreOn())) return new Map();
  return _ingest(items);
}

// ─── pedido ao servidor ─────────────────────────────────────────────────────
async function _request(body) {
  const api = require('./api');
  let r = null;
  try { r = await api.apiCall(PULL_ACTION, body, 'POST'); } catch { r = null; }
  const d = r && (r.data || r);
  const msg = String((r && (r.message || r.error)) || '').toLowerCase();
  if (r && r.success !== false && d && !Array.isArray(d.items) && Array.isArray(d.messages)) d.items = d.messages; // formato do roteador
  if (r && r.success !== false && d && (Array.isArray(d.items) || d.ok === 1)) return { ok: true, d };
  if ((d && d.off) || msg.includes('unknown') || Number(r && r.__httpStatus) === 404) {
    _pausedUntil = Date.now() + PAUSE_MS; // servidor sem o rt_pull → para por 6 h
    return { ok: false, off: true };
  }
  return { ok: false };
}
function _metricsBody() {
  const m = { ..._m, unavailable: { ..._m.unavailable } };
  return m;
}
function _resetMetrics() {
  _m.pulled = 0; _m.stored = 0; _m.cmp_ok = 0; _m.cmp_mismatch = 0; _m.cmp_missing_local = 0; _m.bad = 0; _m.unavailable = {};
}

async function _pullCursor(why) {
  const acct = _acct();
  const dev = _dev(acct);
  if (!acct || !dev) return;
  await _maybeInherit(acct, dev);
  const ck = `${acct}|${dev}`;
  const cur = _mmGet(CURSOR_KEY);
  let since = cur[ck] || '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const ack = _ackQ.splice(0, 500);
    const body = { device_id: dev, since, limit: PAGE, why: String(why || '').slice(0, 16), m: _metricsBody() };
    if (ack.length) body.ack = ack;
    const r = await _request(body);
    if (!r.ok) { _ackQ = ack.concat(_ackQ); return; }
    _resetMetrics();
    await _ingest(r.d.items || []);
    if (r.d.cursor != null && String(r.d.cursor) !== String(since)) {
      since = String(r.d.cursor);
      const c2 = _mmGet(CURSOR_KEY); c2[ck] = since; _mmSet(CURSOR_KEY, c2);
    }
    if (!r.d.more || !(r.d.items || []).length) break;
  }
}

/** Pull por cursor agora (coalesce: um por vez; pedido durante o pull → mais um no fim). */
export function pullNow(why) {
  if (!isActive() || _pausedUntil > Date.now()) return Promise.resolve();
  if (_pulling) { _again = true; return _pulling; }
  _lastPullAt = Date.now();
  _pulling = (async () => {
    try {
      do { _again = false; await _pullCursor(why); } while (_again && _pausedUntil <= Date.now());
    } catch {} finally { _pulling = null; }
  })();
  return _pulling;
}

/**
 * Corpos por mid (hidratação de esqueleto). Espera até opts.waitMs; o que chegar depois grava e avisa
 * (envelope_available). Devolve { envelopes: Map(mid→env), gone: Set(mid), why }.
 * gone = o servidor respondeu e não tem (roteador já apagou/nunca teve) ou o servidor não tem rt_pull.
 */
export async function pullMids(rows, opts = {}) {
  const res = { envelopes: new Map(), gone: new Set(), why: '' };
  try {
    if (_killed() || !Array.isArray(rows) || !rows.length) return res;
    ensureStarted();
    // web sem store persistente (antes do W1): busca o corpo só para mostrar — não grava, não manda persisted
    const transient = isWeb && !_webStoreOn();
    if (_pausedUntil > Date.now()) { res.why = 'rt_off'; for (const r of rows) res.gone.add(String(r.id)); return res; }
    const acct = _acct();
    const dev = _dev(acct);
    if (!dev) { res.why = 'no_device'; return res; }
    const want = []; const waits = [];
    for (const r of rows) {
      const k = String(r.id);
      if (_midWait.has(k)) waits.push([k, _midWait.get(k)]); else want.push(r);
    }
    if (want.length) {
      const p = (async () => {
        const map = new Map(); const gone = new Set();
        const byCid = new Map();
        for (const r of want) { const c = String(r.conversation_id || ''); let l = byCid.get(c); if (!l) { l = []; byCid.set(c, l); } l.push(Number(r.id)); }
        for (const [cid, mids] of byCid) {
          for (let i = 0; i < mids.length; i += PAGE) {
            const part = mids.slice(i, i + PAGE);
            const body = { device_id: dev, mids: part, why: String(opts.why || 'mids').slice(0, 24) };
            if (cid) body.conversation_id = Number(cid);
            const r = await _request(body);
            if (r.off) { for (const x of part) gone.add(String(x)); res.why = 'rt_off'; continue; }
            if (!r.ok) continue;
            const got = await _ingest(r.d.items || [], { transient });
            for (const [k, v] of got) map.set(k, v);
            for (const x of [].concat(r.d.gone || [], r.d.unknown || [])) gone.add(String(x));
            if (!res.why && (r.d.gone || []).length) res.why = 'gone';
            else if (!res.why && (r.d.unknown || []).length) res.why = 'unknown';
          }
        }
        return { map, gone };
      })();
      const shared = p.then((x) => x, () => ({ map: new Map(), gone: new Set() }));
      for (const r of want) {
        const k = String(r.id);
        const one = shared.then((x) => ({ env: x.map.get(k) || null, gone: x.gone.has(k) }));
        _midWait.set(k, one);
        one.finally(() => { setTimeout(() => _midWait.delete(k), 30 * 1000); });
        waits.push([k, one]);
      }
    }
    const waitMs = Math.max(0, Number(opts.waitMs) || 0);
    const all = Promise.all(waits.map(([k, w]) => w.then((v) => { if (v.env) res.envelopes.set(k, v.env); else if (v.gone) res.gone.add(k); })));
    if (waitMs) await Promise.race([all, new Promise((r) => setTimeout(r, waitMs))]); else await all;
  } catch {}
  return res;
}

// ─── A5: herança de inbox (aparelho novo da mesma conta) ─────────────────────
function _h(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); }
async function _prevDevGet(acct) {
  const k = 'chatyy_rt_dev_' + _h(acct);
  try {
    if (isWeb) return (typeof localStorage !== 'undefined' && localStorage.getItem(k)) || '';
    const SS = require('expo-secure-store');
    return (await SS.getItemAsync(k)) || '';
  } catch { return ''; }
}
async function _prevDevSet(acct, dev) {
  const k = 'chatyy_rt_dev_' + _h(acct);
  try {
    if (isWeb) { if (typeof localStorage !== 'undefined') localStorage.setItem(k, dev); return; }
    const SS = require('expo-secure-store');
    // Keychain (iOS) sobrevive à reinstalação → o aparelho novo sabe qual era o antigo (dica; o servidor decide)
    await SS.setItemAsync(k, dev, { keychainAccessible: SS.AFTER_FIRST_UNLOCK });
  } catch {}
}
async function _maybeInherit(acct, dev) {
  if (_inhBusy || _flag('__chatyy_rt_inherit') === false) return;
  const ik = `${acct}|${dev}`;
  const done = _mmGet(INH_KEY);
  if (done[ik]) return;
  _inhBusy = true;
  try {
    const prev = await _prevDevGet(acct);
    if (prev === dev) { done[ik] = Date.now(); _mmSet(INH_KEY, done); return; } // mesmo aparelho de sempre
    let r = null;
    try { r = await require('./api').apiCall(INHERIT_ACTION, { device_id: dev, prev_device_id: prev || '' }, 'POST'); } catch { r = null; }
    const d = r && (r.data || r);
    const msg = String((r && (r.message || r.error)) || '').toLowerCase();
    const unknown = msg.includes('unknown') || Number(r && r.__httpStatus) === 404 || (d && d.off);
    if ((r && r.success !== false && d) || unknown) {
      done[ik] = Date.now();
      const keys = Object.keys(done); if (keys.length > 20) for (const k of keys.slice(0, keys.length - 20)) delete done[k];
      _mmSet(INH_KEY, done);
      await _prevDevSet(acct, dev);
    }
  } finally { _inhBusy = false; }
}

// ─── gatilhos ───────────────────────────────────────────────────────────────
export function ensureStarted() {
  if (_started || _killed()) return;
  _started = true;
  try {
    const ws = require('./websocket').default;
    ws?.on?.('connection', (ev) => { if (ev && ev.status === 'authenticated') setTimeout(() => pullNow('ws'), 800); });
    ws?.on?.('rt_available', () => pullNow('hint'));
  } catch {}
  try {
    AppState.addEventListener('change', (s) => {
      if (s === 'active' && Date.now() - _lastPullAt > FG_THROTTLE_MS) pullNow('fg');
    });
  } catch {}
  try {
    require('./rtStore').onRtConvsChange((cid, n, prev) => { if (n >= 1 && !prev) { if (isWeb) { try { require('./localDb').webRequestPersist?.(); } catch {} } pullNow('conv'); } });
  } catch {}
  if (isWeb) { try { require('./localDb').webRequestPersist?.(); } catch {} }
  setTimeout(() => pullNow('boot'), 1500);
}
