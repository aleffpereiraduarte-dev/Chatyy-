// services/flyGame/api.js — [voar 2026-10-22] Brisa: servidor (chat_game_fly_* em api/games_engine_fly.php),
// recorde local, fila de seeds pré-buscadas ("mais uma" instantâneo) e gate.
//
// Gate (as duas coisas valem):
//   1) kill OTA: globalThis.__chatyy_fly_game === false esconde tudo (atalhos, grade, cartão abre tela antiga);
//   2) servidor: chat_game_fly_info respondeu enabled (o servidor desliga com data/.fly-game-off).
// Sem servidor (offline/erro) o jogo ainda abre como TREINO (seed local, não vale ranking).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const E = require('./engine');

const BEST_KEY = 'chatyy_fly_best_v1';
const CAP_KEY = 'chatyy_fly_cap_v1';

function _api() { const m = require('../api'); return m.default && m.default.apiCall ? m.default : m; }
async function call(action, params) {
  try {
    const r = await _api().apiCall(action, params || {}, 'POST');
    return r || { success: false, message: 'network' };
  } catch (e) { return { success: false, message: String((e && e.message) || 'network') }; }
}
const errOf = (r) => String((r && (r.message || (r.data && r.data.error))) || '');

export function flyKilled() { try { return globalThis.__chatyy_fly_game === false; } catch { return false; } }

// ─── capacidade (cache 6 h; "não" vale 5 min) ───────────────────────────────
let _cap = null; let _capAt = 0; let _capLoaded = false; let _probe = null; let _info = null;
const _capSubs = new Set();
export function flyAvailable() { return !flyKilled() && _cap === true; }
export function onFlyCap(fn) { _capSubs.add(fn); return () => _capSubs.delete(fn); }
function _setCap(v) {
  const ch = _cap !== v; _cap = v; _capAt = Date.now();
  try { AsyncStorage.setItem(CAP_KEY, JSON.stringify({ v, at: _capAt })).catch(() => {}); } catch {}
  if (ch) for (const fn of Array.from(_capSubs)) { try { fn(v); } catch {} }
}
export function lastInfo() { return _info; }
/** Sonda o servidor. Nunca lança. Devolve true/false. */
export async function probeFly(force) {
  if (flyKilled()) return false;
  if (!_capLoaded) {
    _capLoaded = true;
    try { const j = JSON.parse((await AsyncStorage.getItem(CAP_KEY)) || 'null'); if (j && typeof j.v === 'boolean' && _cap === null) { _cap = j.v; _capAt = j.at || 0; } } catch {}
  }
  if (!force && _cap !== null && Date.now() - _capAt < (_cap ? 6 * 3600e3 : 5 * 60e3)) return _cap;
  if (_probe) return _probe;
  _probe = (async () => {
    const r = await fetchInfo();
    if (r && r.success && r.data && r.data.enabled) _setCap(true);
    else if (r && (/unknown/i.test(errOf(r)) || errOf(r) === 'fly_disabled' || errOf(r) === 'games_disabled')) _setCap(false);
    _probe = null;
    return _cap === true;
  })();
  return _probe;
}
export async function fetchInfo() {
  const r = await call('chat_game_fly_info');
  if (r && r.success && r.data) { _info = r.data; if (r.data.best) mergeBest(r.data.best.all); }
  return r;
}

// ─── recorde local (vale offline; o servidor manda o "de todos os tempos" e a gente pega o maior) ───
let _best = null;
const _bestSubs = new Set();
export async function loadBest() {
  if (_best !== null) return _best;
  try { _best = Number(await AsyncStorage.getItem(BEST_KEY)) || 0; } catch { _best = 0; }
  return _best;
}
export function bestSync() { return _best || 0; }
export function onBest(fn) { _bestSubs.add(fn); return () => _bestSubs.delete(fn); }
export function mergeBest(v) {
  const n = Number(v) || 0;
  if (n <= (_best || 0)) return false;
  _best = n;
  try { AsyncStorage.setItem(BEST_KEY, String(n)).catch(() => {}); } catch {}
  for (const fn of Array.from(_bestSubs)) { try { fn(n); } catch {} }
  return true;
}

// ─── seeds assinadas (fila p/ "mais uma" instantâneo) ───────────────────────
const _queues = new Map(); // chave 'rank' ou 'ch:<gid>' → [{run_id, seed, ver, exp, sig}]
const _inflight = new Map();
function qkey(mode, gid) { return mode === 'challenge' ? `ch:${gid}` : 'rank'; }
async function fetchTicket(mode, gid) {
  const r = await call('chat_game_fly_start', mode === 'challenge' ? { mode, game_id: gid } : { mode: 'rank' });
  if (r && r.success && r.data && r.data.run_id && Number(r.data.ver) === E.FLY_VER) return { ...r.data, mode, game_id: gid || null };
  if (r && !r.success) return { error: errOf(r) || 'network' };
  return null;
}
/** Garante até `n` seeds na fila (em segundo plano). */
export function prefetchTickets(mode, gid, n = 2) {
  if (flyKilled()) return;
  const k = qkey(mode, gid);
  if (_inflight.get(k)) return;
  const q = _queues.get(k) || [];
  const now = Date.now() / 1000;
  const fresh = q.filter((x) => x.exp - now > 90);
  _queues.set(k, fresh);
  if (fresh.length >= n) return;
  _inflight.set(k, true);
  (async () => {
    try {
      for (let i = fresh.length; i < n; i++) {
        const t = await fetchTicket(mode, gid);
        if (!t || t.error) break;
        (_queues.get(k) || _queues.set(k, []).get(k)).push(t);
      }
    } catch {}
    _inflight.delete(k);
  })();
}
/** Pega a próxima seed da fila (null = sem seed do servidor → treino). Pede outra em seguida. */
export function takeTicket(mode, gid) {
  const k = qkey(mode, gid);
  const now = Date.now() / 1000;
  const q = (_queues.get(k) || []).filter((x) => x.exp - now > 90);
  const t = q.shift() || null;
  _queues.set(k, q);
  prefetchTickets(mode, gid, 2);
  return t;
}
/** Espera uma seed por até `ms` (1ª partida da tela). */
export async function waitTicket(mode, gid, ms = 2500) {
  const t0 = Date.now();
  prefetchTickets(mode, gid, 2);
  while (Date.now() - t0 < ms) {
    const q = _queues.get(qkey(mode, gid)) || [];
    if (q.length) return takeTicket(mode, gid);
    if (!_inflight.get(qkey(mode, gid)) && Date.now() - t0 > 400) break;
    await new Promise((res) => setTimeout(res, 80));
  }
  return takeTicket(mode, gid);
}
export function dropTickets(mode, gid) { _queues.delete(qkey(mode, gid)); }

/** Fim de partida: o servidor re-joga (seed+ticks) e devolve o resultado oficial. */
export async function finishRun(ticket, run) {
  if (!ticket) return { success: false, message: 'no_ticket' };
  const r = await call('chat_game_fly_finish', {
    run_id: ticket.run_id, sig: ticket.sig, seed: ticket.seed, ver: ticket.ver, exp: ticket.exp,
    ticks: E.encodeTicks(run.ticks), score: run.score, wall_ms: Math.round(run.wallMs || 0), plat: Platform.OS,
  });
  if (r && r.success && r.data && r.data.best) mergeBest(r.data.best.all);
  return r;
}

export const flyRank = (scope, week) => call('chat_game_fly_rank', { scope: scope || 'all', week: week || 'current', limit: 50 });
const _badges = new Map();
export async function flyBadge(email) {
  const k = String(email || '').toLowerCase();
  const c = _badges.get(k);
  if (c && Date.now() - c.at < 30 * 60e3) return c.v;
  const r = await call('chat_game_fly_badge', { email: k });
  const v = r && r.success && r.data ? r.data.badge || null : null;
  _badges.set(k, { v, at: Date.now() });
  return v;
}
/** Desafio na conversa a partir de uma partida validada (mesma seed). */
export async function sendChallenge(conversationId, runId) {
  const G = require('../games');
  let r = null;
  try { r = await _api().apiCall('chat_game_create', { conversation_id: conversationId, type: 'voar', players: [], open: 0, ...(runId ? { fly_run: runId } : {}) }, 'POST'); } catch (e) { r = { success: false, message: 'network' }; }
  try { if (r && r.data && r.data.game) G.putGameView(r.data.game); } catch {}
  return r || { success: false, message: 'network' };
}

/** Texto de erro amigável (pt; as telas traduzem pela chave fly.err.<código>). */
export const FLY_ERR_FB = {
  seed_used: 'Esta partida já foi enviada', seed_expired: 'A partida demorou demais para ser enviada', bad_sig: 'Partida inválida',
  bad_version: 'Atualize o app para valer no ranking', score_mismatch: 'A pontuação não confere', too_fast: 'Partida rápida demais',
  tap_rate: 'Toques rápidos demais', ticks_after_death: 'Partida inválida', bad_ticks: 'Partida inválida', tap_too_fast: 'Toques rápidos demais',
  rate_limited: 'Calma: muitas partidas seguidas', fly_disabled: 'O Brisa está indisponível agora', network: 'Sem conexão: partida de treino',
  already_done: 'Você já usou suas tentativas', game_over: 'O desafio já terminou', fly_run_invalid: 'Essa partida não pode virar desafio', fly_run_old: 'Partida antiga demais para desafiar',
};
export function flyErrCode(r) { return errOf(r) || 'network'; }
