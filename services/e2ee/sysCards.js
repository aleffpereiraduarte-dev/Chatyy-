// services/e2ee/sysCards.js — [2026-10-22 e2ee5 D7] cartões de JOGO e ASSISTIR JUNTO em conversa cifrada.
//
// Em conversa E2EE (e2ee_mode=1) o servidor grava esses cartões como `type='system'` com content
// `{"sys":"game",game_id,kind,state,…}` / `{"sys":"watch_session",session_id,kind,state,…}` — só ids,
// números e enums (D7, CONTRATO §2.7). O app de hoje desenha o cartão a partir do JSON público da
// conversa normal (`{kind:'game', g, type, status, players…}` / `{kind:'watch', sid, mode, title…}`).
// Este módulo traduz a linha D7 → a MESMA forma (type 'game' / 'watch_session'), buscando o estado
// pelo id (chat_game_state / watch_state) e avisando quando o estado chega (onSysCardPatch) para a
// conversa trocar o content da linha. O cache guarda a linha D7 original (_e5SysRaw → e2eeShape).
import { sysCardFields } from './payload';

const _subs = new Set();
/** fn({conversation_id, message_id, type, content}) — estado do cartão D7 chegou/mudou. */
export function onSysCardPatch(fn) { if (typeof fn === 'function') _subs.add(fn); return () => _subs.delete(fn); }
function _emit(conv, mid, type, content) {
  for (const fn of Array.from(_subs)) { try { fn({ conversation_id: String(conv || ''), message_id: mid, type, content }); } catch (_) {} }
}

function _G() { return require('../games'); }
function _W() { return require('../watchTogether'); }

/** content cru é cartão D7 de jogo/assistir? (barato, sem JSON.parse) */
export function isSysCardRaw(c) {
  return typeof c === 'string' && (c.startsWith('{"sys":"game"') || c.startsWith('{"sys":"watch_session"'));
}

// ── jogo ─────────────────────────────────────────────────────────────────────
const GAME_TTL = 60 * 1000;
const _gameAt = new Map();      // game_id → último pedido (ms)
const _gameMids = new Map();    // game_id → Map(mid → {conv, result})
function _gameState(f) {
  const s = String(f.state || '');
  return s === 'result' ? 'finished' : (s || 'pending');
}
function _gameContentFromView(view, result) {
  const G = _G();
  if (!result) return G.cardContentFromView(view);
  const o = { kind: 'result' };
  for (const k of ['g', 'type', 'title', 'winners', 'draw', 'ranking', 'seats', 'hanged', 'end', 'end_by', 'left', 'v']) if (view && view[k] !== undefined) o[k] = view[k];
  return JSON.stringify(o);
}
function _gameMinimal(f, result, msg) {
  // sem o estado ainda: cartão neutro do tipo certo (o patch troca em ~1 RTT)
  const o = { kind: result ? 'result' : 'game', g: Number(f.game_id), type: String(f.kind || 'velha'), status: _gameState(f), v: 0,
    by: msg && msg.sender_email ? String(msg.sender_email) : undefined, players: [], seats: [], winners: [], ranking: [] };
  return JSON.stringify(o);
}
function _wantGame(id, mid, conv, result) {
  let m = _gameMids.get(id);
  if (!m) { m = new Map(); _gameMids.set(id, m); }
  if (mid != null) m.set(String(mid), { conv: String(conv || ''), result });
  if (m.size > 20) m.delete(m.keys().next().value);
  const at = _gameAt.get(id) || 0;
  if (Date.now() - at < GAME_TTL) return;
  _gameAt.set(id, Date.now());
  if (_gameAt.size > 500) _gameAt.delete(_gameAt.keys().next().value);
  let G; try { G = _G(); } catch (_) { return; }
  _hookGameViews();
  Promise.resolve().then(() => G.gameState(id)).then((r) => {
    const view = r && r.success && r.data && r.data.game;
    if (!view) { _gameAt.set(id, Date.now() - GAME_TTL + 15000); return; } // falhou: tenta de novo em 15 s
    _patchGame(view);
  }).catch(() => {});
}
function _patchGame(view) {
  const id = Number(view && view.g);
  const m = id ? _gameMids.get(id) : null;
  if (!m) return;
  for (const [mid, x] of m) {
    const result = x.result || (view.result_mid != null && String(view.result_mid) === mid);
    try { _emit(x.conv || view.conversation_id, mid, 'game', _gameContentFromView(view, result)); } catch (_) {}
  }
}
let _gameHooked = false;
function _hookGameViews() {
  if (_gameHooked) return;
  _gameHooked = true;
  // visão nova de QUALQUER fonte (WS game_update, ação no cartão, folha do jogo) → cartões D7 desse jogo
  try { _G().onAnyGameView((v) => { try { _patchGame(v); } catch (_) {} }); } catch (_) { _gameHooked = false; }
}
function _game(msg, f) {
  const id = Number(f.game_id);
  if (!(id > 0)) return null;
  const result = f.state === 'result';
  let content = null;
  try {
    const view = _G().getGameView(id);
    if (view) content = _gameContentFromView(view, result || (view.result_mid != null && String(view.result_mid) === String(msg.id)));
    _wantGame(id, msg.id, msg.conversation_id, result);
  } catch (_) {}
  return { type: 'game', content: content || _gameMinimal(f, result, msg) };
}

// ── assistir/ouvir junto ─────────────────────────────────────────────────────
const WATCH_TTL = 60 * 1000;
const _watchAt = new Map();     // conv → último refresh (ms)
const _watchMids = new Map();   // sid → Map(mid → {conv, f, sender, senderName})
function _watchContent(f, s, sender, senderName) {
  const same = !!(s && s.sid && String(s.sid) === String(f.session_id));
  const it = same && s.item ? s.item : null;
  return JSON.stringify({
    kind: 'watch', sid: String(f.session_id), mode: f.kind === 'music' ? 'music' : 'video',
    status: same && s.status ? s.status : String(f.state || 'ended'),
    title: it ? String(it.title || '') : '', thumb: it ? String(it.thumb || '') : '', source: it ? String(it.source || '') : '',
    lic: it ? String(it.lic || '') : '', credit: it ? String(it.credit || '') : '', dur: it ? Number(it.dur) || 0 : 0,
    host: same && s.host ? s.host : (sender || ''), host_name: same && s.host_name ? s.host_name : (senderName || ''),
    started_at: Number(f.started_at) || 0, ended_at: Number(f.ended_at) || 0,
  });
}
let _watchHooked = false;
function _hookWatch() {
  if (_watchHooked) return;
  _watchHooked = true;
  try {
    _W().onAnySession((cid, s) => {
      if (!s || !s.sid) return;
      const m = _watchMids.get(String(s.sid));
      if (!m) return;
      for (const [mid, x] of m) { try { _emit(x.conv || cid, mid, 'watch_session', _watchContent(x.f, s, x.sender, x.senderName)); } catch (_) {} }
    });
  } catch (_) { _watchHooked = false; }
}
function _watch(msg, f) {
  const sid = f.session_id != null ? String(f.session_id) : '';
  if (!sid) return null;
  const conv = String(msg.conversation_id || '');
  let s = null;
  try {
    const W = _W();
    _hookWatch();
    let m = _watchMids.get(sid);
    if (!m) { m = new Map(); _watchMids.set(sid, m); if (_watchMids.size > 200) _watchMids.delete(_watchMids.keys().next().value); }
    if (msg.id != null) m.set(String(msg.id), { conv, f, sender: msg.sender_email || '', senderName: msg.sender_name || '' });
    s = conv ? W.getSession(conv) : null;
    // sessão desconhecida (ou de outro sid): 1 refresh por conversa/min
    if (conv && (!s || String(s.sid) !== sid) && Date.now() - (_watchAt.get(conv) || 0) > WATCH_TTL) {
      _watchAt.set(conv, Date.now());
      Promise.resolve().then(() => W.refresh(conv)).catch(() => {});
    }
  } catch (_) {}
  return { type: 'watch_session', content: _watchContent(f, s, msg.sender_email || '', msg.sender_name || '') };
}

/**
 * Linha D7 (`type='system'`, `{"sys":"game"|"watch_session",…}`) → linha no formato do cartão de
 * conversa normal (type 'game' / 'watch_session'), com `_e5SysRaw` (o cache volta à linha original).
 * null = não é cartão D7 de jogo/assistir.
 */
export function adaptSysRow(msg) {
  if (!msg) return null;
  const raw = typeof msg._e5SysRaw === 'string' ? msg._e5SysRaw : (msg.type === 'system' ? msg.content : null);
  if (!isSysCardRaw(raw)) return null;
  const f = sysCardFields(raw);
  if (!f) return null;
  const r = f.sys === 'game' ? _game(msg, f) : f.sys === 'watch_session' ? _watch(msg, f) : null;
  if (!r) return null;
  // conteúdo já melhor na linha (patch anterior com versão ≥) fica
  if (msg._e5SysRaw && msg.type === r.type && typeof msg.content === 'string' && msg.content !== r.content) {
    try {
      const a = JSON.parse(msg.content); const b = JSON.parse(r.content);
      if (r.type === 'game' ? (Number(a && a.v) || 0) > (Number(b && b.v) || 0) : !!(a && a.title && !b.title)) return msg;
    } catch (_) {}
  }
  return { ...msg, type: r.type, content: r.content, _e5SysRaw: raw, _e5Sys: f.sys };
}

/** Linha adaptada → linha D7 original (para o cache). */
export function toStoredSys(m) {
  if (!m || typeof m._e5SysRaw !== 'string') return m;
  const out = { ...m, type: 'system', content: m._e5SysRaw };
  delete out._e5SysRaw; delete out._e5Sys;
  return out;
}
