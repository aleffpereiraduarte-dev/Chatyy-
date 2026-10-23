// [sgu F0 2026-10-23] "Gravado no aparelho" (persisted) — fila SOMBRA no servidor, só MEDE.
// Plano /root/sem-gravar-no-us-2026-10-22/PLANO.md §3 (F0). Para apagar um dia o corpo do servidor (modelo WhatsApp)
// é preciso saber, por APARELHO, que a mensagem E2EE v5 está gravada no store local — não só que "chegou".
//
// Como funciona: os escritores do SQLite (db.dbSaveMessages, sqliteStore.upsertMessagesSync, bgJournal.mergeSync)
// chamam noteSaved() DEPOIS do COMMIT. Aqui só entram linhas com envelope ({"e2e":5…) e id do servidor; vão em lote
// (1,5 s, ≤ 200 ids por conversa) para `chat_dlv_persisted` com o device_id e2ee5 deste aparelho.
// Vale para mensagens recebidas, as MINHAS vindas de outro aparelho (self-sync) e as minhas enviadas daqui (quando a
// linha confirmada é gravada).
//
// NÃO muda o ✓/✓✓: o ack de entrega continua saindo na hora, pelo caminho de sempre. Isto é um POST extra, pequeno,
// só para conversas E2EE v5. Servidor sem o kit → 'Unknown chat action'/off → pausa 6 h (nada de repetir).
// Web: o SQLite não existe lá (dbSaveMessages sai antes) → nunca manda (web não guarda histórico; correto p/ a F0).
// Kill OTA: globalThis.__chatyy_dlv_persisted = false.

import { Platform } from 'react-native';

const isWeb = Platform.OS === 'web';
const FLUSH_MS = 1500;
const MAX_IDS = 200;
const MAX_AGE_MS = 8 * 24 * 3600 * 1000; // linhas antigas (re-sync de histórico) não interessam à medição de 7 d
const RING_MAX = 3000;                   // ids já reportados (sobrevive a reinício: re-sync não reenvia)
const RING_KEY = 'chatyy_dlv_persisted_v1';
const PAUSE_MS = 6 * 3600 * 1000;

const _queue = new Map(); // cid → Set(mid)
let _timer = null;
let _flushing = false;
let _pausedUntil = 0;
let _ring = null;         // Set('acct|cid:mid')
let _ringArr = null;
let _ringDirty = false;

function _off() {
  try { return globalThis.__chatyy_dlv_persisted === false; } catch { return false; }
}

function _acct() {
  try {
    const api = require('./api');
    return String(api.getActiveAccountEmail?.() || api.getTokenMeta?.()?.email || '').trim().toLowerCase();
  } catch { return ''; }
}

function _loadRing() {
  if (_ring) return;
  _ring = new Set();
  _ringArr = [];
  try {
    const raw = require('./mmkv').getString(RING_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) for (const k of arr.slice(-RING_MAX)) { if (typeof k === 'string') { _ring.add(k); _ringArr.push(k); } }
  } catch {}
}

function _ringAdd(k) {
  if (_ring.has(k)) return;
  _ring.add(k);
  _ringArr.push(k);
  if (_ringArr.length > RING_MAX) { const old = _ringArr.splice(0, _ringArr.length - RING_MAX); for (const o of old) _ring.delete(o); }
  _ringDirty = true;
}

function _ringSave() {
  if (!_ringDirty) return;
  _ringDirty = false;
  try { require('./mmkv').setString(RING_KEY, JSON.stringify(_ringArr)); } catch {}
}

// Envelope na linha: `content` cru OU `_e2eRaw` (linha já decifrada na memória — o raw_json gravado leva o envelope).
function _isEnvelope(m) {
  if (!m) return false;
  const c = m.content, r = m._e2eRaw;
  return (typeof c === 'string' && c.startsWith('{"e2e":5')) || (typeof r === 'string' && r.startsWith('{"e2e":5'));
}

function _tooOld(m) {
  const t = Date.parse(String(m.created_at || ''));
  return Number.isFinite(t) && Date.now() - t > MAX_AGE_MS;
}

/**
 * Chamado DEPOIS do COMMIT de um lote no SQLite. Nunca lança, nunca bloqueia (só enfileira).
 * @param {number|string} convId conversa do lote (ou null: usa m.conversation_id)
 * @param {object[]} messages linhas gravadas
 */
export function noteSaved(convId, messages, opts) {
  try {
    // [sgu W1 2026-10-23] web só manda quando gravou no IndexedDB persistente (rtInbox → opts.web)
    if ((isWeb && !(opts && opts.web)) || _off() || !Array.isArray(messages) || messages.length === 0) return;
    if (_pausedUntil > Date.now()) return;
    let any = false;
    for (const m of messages) {
      if (!m || !_isEnvelope(m) || m.deleted || m.deleted_at) continue;
      const mid = Number(m.id);
      const cid = Number(convId || m.conversation_id);
      // [sgu F1/F2] corpo vindo da fila do roteador (_rt): o persisted libera a inbox → vale em qualquer idade
      if (!(mid > 0) || !(cid > 0) || (!m._rt && _tooOld(m))) continue;
      let q = _queue.get(cid);
      if (!q) { q = new Set(); _queue.set(cid, q); }
      q.add(mid);
      any = true;
    }
    if (any && !_timer) _timer = setTimeout(() => { _timer = null; _flush().catch(() => {}); }, FLUSH_MS);
  } catch {}
}

async function _flush() {
  if (_flushing || _off()) return;
  _flushing = true;
  try {
    const acct = _acct();
    if (!acct) { _queue.clear(); return; }
    _loadRing();
    let dev = '';
    try { dev = require('./dlvDevice').dlvDeviceIdSync(acct) || ''; } catch {}
    const api = require('./api');
    const batches = [];
    for (const [cid, set] of _queue) {
      const ids = [];
      for (const mid of set) if (!_ring.has(`${acct}|${cid}:${mid}`)) ids.push(mid);
      for (let i = 0; i < ids.length; i += MAX_IDS) batches.push([cid, ids.slice(i, i + MAX_IDS)]);
    }
    _queue.clear();
    for (const [cid, ids] of batches) {
      const body = { conversation_id: cid, message_ids: ids };
      if (dev) body.device_id = dev;
      let r = null;
      try { r = await api.apiCall('chat_dlv_persisted', body, 'POST'); } catch { r = null; }
      const d = r && (r.data || r);
      const msg = String((r && (r.message || r.error)) || '').toLowerCase();
      if (r && r.success !== false && d && (d.ok === 1 || d.skipped === 'not_e2ee' || d.skipped === 'not_member')) {
        for (const mid of ids) _ringAdd(`${acct}|${cid}:${mid}`);
        continue;
      }
      if ((d && d.off) || msg.includes('unknown') || Number(r && r.__httpStatus) === 404) {
        // servidor sem o kit / sombra desligada → para por 6 h (medição, não vale tráfego)
        _pausedUntil = Date.now() + PAUSE_MS;
        break;
      }
      // falha de rede: não insiste agora; o próximo lote gravado (ou o re-sync) traz de novo os ids
    }
    _ringSave();
  } catch {} finally {
    _flushing = false;
  }
}

/** Diagnóstico (Ajuda/QA). */
export function getDlvPersistedStats() {
  return { queued: [..._queue.values()].reduce((a, s) => a + s.size, 0), paused_until: _pausedUntil, ring: _ring ? _ring.size : null, off: _off() };
}
