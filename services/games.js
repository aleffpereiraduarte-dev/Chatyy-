// services/games.js — [jogos 2026-10-18] Jogos dentro da conversa (estilo Messenger antigo).
//
// Servidor AUTORITATIVO (api/games.php via chat_game_*): o app só desenha a visão que o servidor
// manda (lances legais, cartas jogáveis, mão do próprio jogador) e envia a intenção do lance.
//
// Gate (o item "Jogos" só aparece quando os dois valem):
//   1) kill switch OTA: globalThis.__chatyy_games === false esconde tudo;
//   2) capacidade do servidor: chat_game_types respondeu enabled=true. Se QUALQUER chamada de jogo
//      voltar "Unknown chat action" / games_disabled, a capacidade vira false (item some).
// Cache da capacidade em AsyncStorage (6 h) para o menu não piscar.
//
// Tempo real: evento WS `game_update` {conversation_id, game_id, message_id, version, content, game}
// → store por jogo (subscribeGame) + ouvintes de conversa (onGameUpdate) que atualizam o cartão.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NOVOS_TYPES, NOVOS_TITLES, NOVOS_SUBS, NOVOS_ERRORS, novosStatusLine } from './gamesNovos'; // [jogos2b]
import { EXTRA_TYPES, EXTRA_TITLES, EXTRA_SUBS, EXTRA_ERRORS, extraStatusLine } from './gamesExtra'; // [jogos3]

const CAP_KEY = 'chatyy_games_cap_v1';
const CAP_TTL = 6 * 3600 * 1000;
let _cap = null;          // true | false | null (desconhecido)
let _capAt = 0;
let _probe = null;
let _capLoaded = false;
const _capSubs = new Set();
// [jogos 2026-10-19] recursos do servidor (chat_game_types.features): cancel, draw, hide, expire, rematch_consent, end_reason.
// Ações novas só aparecem quando o servidor anuncia — app novo + servidor antigo = sem botão quebrado.
let _features = new Set();
export function gameFeature(name) { return _features.has(name); }

function _api() { const m = require('./api'); return m.default && m.default.apiCall ? m.default : m; }

export function gamesKillSwitched() {
  try { return globalThis.__chatyy_games === false; } catch { return false; }
}
export function gamesAvailable() { return !gamesKillSwitched() && _cap === true; }
export function onGamesCap(fn) { _capSubs.add(fn); return () => _capSubs.delete(fn); }
function _setCap(v) {
  const changed = _cap !== v;
  _cap = v; _capAt = Date.now();
  try { AsyncStorage.setItem(CAP_KEY, JSON.stringify({ v, at: _capAt, f: Array.from(_features) })).catch(() => {}); } catch {}
  if (changed) for (const fn of Array.from(_capSubs)) { try { fn(v); } catch {} }
}
export function isUnknownAction(r) {
  if (!r) return false;
  const m = String(r.message || r.error || (r.data && r.data.error) || '');
  return /unknown (chat )?action/i.test(m) || m === 'unknown_action' || m === 'games_disabled';
}
/** Sonda o servidor (1x por sessão + a cada 6 h). Nunca lança. */
export async function probeGames(force = false) {
  if (gamesKillSwitched()) return false;
  if (!_capLoaded) {
    _capLoaded = true;
    try {
      const raw = await AsyncStorage.getItem(CAP_KEY);
      const j = raw ? JSON.parse(raw) : null;
      if (j && Array.isArray(j.f) && !_features.size) _features = new Set(j.f);
      if (j && typeof j.v === 'boolean' && _cap === null) { _cap = j.v; _capAt = j.at || 0; for (const fn of Array.from(_capSubs)) { try { fn(_cap); } catch {} } }
    } catch {}
  }
  // [2026-10-18] 'não' só vale 5 min (antes 6 h: sonda feita antes do kit do servidor escondia Jogos o dia todo)
  if (!force && _cap !== null && Date.now() - _capAt < (_cap ? CAP_TTL : 5 * 60 * 1000)) return _cap;
  if (_probe) return _probe;
  _probe = (async () => {
    try {
      const r = await _api().apiCall('chat_game_types', {}, 'POST');
      if (r && r.success && r.data && r.data.enabled) { _features = new Set(Array.isArray(r.data.features) ? r.data.features : []); _setCap(true); }
      else if (isUnknownAction(r)) _setCap(false);
    } catch {}
    _probe = null;
    return _cap === true;
  })();
  return _probe;
}

async function _call(action, params, soft) {
  let r = null;
  try { r = await _api().apiCall(action, params, 'POST'); } catch (e) { r = { success: false, message: String((e && e.message) || 'network') }; }
  // `soft` = ação nova (2026-10-19): servidor antigo responde unknown_action, mas isso NÃO esconde os jogos
  if (isUnknownAction(r) && !(soft && String(r && r.message) !== 'games_disabled')) _setCap(false);
  const view = r && r.data && r.data.game;
  if (view) putGameView(view);
  if (r && r.data && r.data.rematch) putGameView(r.data.rematch);
  return r || { success: false, message: 'network' };
}
export const gameCreate = (conversationId, type, players, open) => _call('chat_game_create', { conversation_id: conversationId, type, players: players || [], open: open ? 1 : 0 });
export const gameAccept = (id) => _call('chat_game_accept', { game_id: id });
export const gameJoin = (id) => _call('chat_game_join', { game_id: id });
export const gameDecline = (id) => _call('chat_game_decline', { game_id: id });
export const gameStart = (id) => _call('chat_game_start', { game_id: id });
export const gameMove = (id, version, move) => _call('chat_game_move', { game_id: id, version, move });
export const gameState = (id) => _call('chat_game_state', { game_id: id });
export const gameStateByMessage = (messageId) => _call('chat_game_state', { message_id: messageId });
export const gameResign = (id) => _call('chat_game_resign', { game_id: id });
// [jogos 2026-10-19] ciclo de vida completo (servidor v2). Sem o recurso no servidor: cancelar = resign antigo.
export const gameCancel = (id) => (gameFeature('cancel') ? _call('chat_game_cancel', { game_id: id }, true) : _call('chat_game_resign', { game_id: id }));
export const gameDraw = (id, op) => _call('chat_game_draw', { game_id: id, op: op || 'offer' }, true);
export const gameHide = (id) => _call('chat_game_hide', { game_id: id }, true);
export const gameHideAll = (conversationId) => _call('chat_game_hide', { conversation_id: conversationId, all: 1 }, true);
export const gameRematch = (id) => _call('chat_game_rematch', { game_id: id });
export const gameList = (conversationId) => _call('chat_game_list', { conversation_id: conversationId });
export const gameScoreboard = (conversationId) => _call('chat_game_scoreboard', { conversation_id: conversationId });

// ─── store por jogo + WS ────────────────────────────────────────────────────
const _views = new Map();
const _subs = new Map();
const _convSubs = new Set();
let _wsAttached = false;

export function getGameView(id) { return _views.get(Number(id)) || null; }
export function putGameView(view) {
  if (!view || !view.g) return;
  const id = Number(view.g);
  const prev = _views.get(id);
  if (prev && Number(prev.v) > Number(view.v)) return;
  const v = { ...view, _rx: Date.now() };
  _views.set(id, v);
  const set = _subs.get(id);
  if (set) for (const fn of Array.from(set)) { try { fn(v); } catch {} }
  for (const fn of Array.from(_anySubs)) { try { fn(v); } catch {} }
}
// [jogos 2026-10-19 inline] ouvinte de QUALQUER visão nova (lista nativa: re-monta os cartões com tabuleiro).
const _anySubs = new Set();
export function onAnyGameView(fn) { ensureGameWs(); _anySubs.add(fn); return () => _anySubs.delete(fn); }
export function subscribeGame(id, fn) {
  ensureGameWs();
  const k = Number(id);
  if (!_subs.has(k)) _subs.set(k, new Set());
  _subs.get(k).add(fn);
  return () => { const s = _subs.get(k); if (s) { s.delete(fn); if (!s.size) _subs.delete(k); } };
}
/** Ouvinte de conversa: fn({conversation_id, message_id, content, game}) a cada game_update. */
export function onGameUpdate(fn) { ensureGameWs(); _convSubs.add(fn); return () => _convSubs.delete(fn); }
export function ensureGameWs() {
  if (_wsAttached) return;
  _wsAttached = true;
  try {
    const ws = require('./websocket').default;
    ws.on('game_update', (d) => {
      const data = d && d.game ? d : (d && d.data && d.data.game ? d.data : d);
      if (!data) return;
      if (data.game) putGameView(data.game);
      if (!_cap && gamesKillSwitched() === false) _cap = true; // servidor mandou evento de jogo → tem jogos
      // [2026-10-22 e2ee5 D7] conversa cifrada: content = cartão `{"sys":"game",…}` (só ids) → o cartão
      // público sai da visão que veio junto (mesma forma da conversa normal)
      let out = data;
      if (data.game && typeof data.content === 'string' && data.content.startsWith('{"sys":')) {
        try { out = { ...data, content: cardContentFromView(data.game), _e5Sys: 'game' }; } catch { out = { ...data, content: '' }; }
      }
      for (const fn of Array.from(_convSubs)) { try { fn(out); } catch {} }
    });
  } catch { _wsAttached = false; }
}

// ─── textos e cartão ────────────────────────────────────────────────────────
export const GAME_TYPES = ['damas', 'velha', 'cartas', 'quiz', 'forca'];
// [jogos2 2026-10-21] Ligue 4, Batalha Naval, Dominó, Jogo da Memória (servidor: games_engine_<tipo>.php)
GAME_TYPES.push('ligue4', 'naval', 'domino', 'memoria');
const SUB_J2 = { ligue4: '4 em linha, fichas que caem', naval: 'Afunde os barcos do outro', domino: 'Clássico de 2', memoria: 'Vire pares de cartas' };
const TITLE_FB = { velha: 'Jogo da Velha', damas: 'Damas', cartas: 'Cartas Coloridas', quiz: 'Quiz', forca: 'Forca' };
// [jogos2b 2026-10-21] Termo em dupla / Pedra, papel e tesoura / Stop / Desenha e Adivinha (servidor: games_engine_<tipo>.php)
NOVOS_TYPES.forEach((x) => { if (!GAME_TYPES.includes(x)) GAME_TYPES.push(x); });
Object.assign(TITLE_FB, NOVOS_TITLES);
Object.assign(TITLE_FB, { ligue4: 'Ligue 4', naval: 'Batalha Naval', domino: 'Dominó', memoria: 'Jogo da Memória' }); // [jogos2]
// [jogos3 2026-10-22] Xadrez / Quem me conhece mais? (servidor: games_engine_<tipo>.php)
EXTRA_TYPES.forEach((x) => { if (!GAME_TYPES.includes(x)) GAME_TYPES.push(x); });
Object.assign(TITLE_FB, EXTRA_TITLES);
export function tr(t, k, fb, vars) {
  let s = fb;
  try { const v = t ? t(k, vars ? { ...vars, defaultValue: fb } : fb) : fb; if (v && v !== k) s = v; } catch {}
  if (vars && typeof s === 'string') Object.keys(vars).forEach((x) => { s = s.split('{' + x + '}').join(String(vars[x])); });
  return s;
}
export function gameTitle(t, type) { return tr(t, 'games.title.' + type, TITLE_FB[type] || 'Jogo'); }
export function gameSubtitle(t, type) {
  const fb = { damas: 'Regras brasileiras, dama voa', velha: 'Rapidinho, 3 em linha', cartas: 'Descarte por cor ou número, 2 a 6', quiz: 'Todos respondem ao mesmo tempo', forca: 'Adivinhe a palavra em turnos' };
  Object.assign(fb, NOVOS_SUBS); // [jogos2b]
  Object.assign(fb, SUB_J2); // [jogos2]
  Object.assign(fb, EXTRA_SUBS); // [jogos3]
  return tr(t, 'games.sub.' + type, fb[type] || '');
}
export function parseGameContent(c) {
  if (c && typeof c === 'object') return c.kind ? c : null;
  if (typeof c !== 'string') return null;
  const s = c.trim();
  if (!s.startsWith('{')) return null;
  try { const j = JSON.parse(s); return j && (j.kind === 'game' || j.kind === 'result') && j.type ? j : null; } catch { return null; }
}
const PUBLIC_KEYS = ['g', 'type', 'title', 'status', 'v', 'by', 'players', 'seats', 'turn', 'winners', 'draw', 'ranking', 'open', 'min', 'max', 'info', 'rematch_id', 'rematch_of', 'result_mid', 'hanged',
  'end', 'end_by', 'left', 'draw_offer', 'can_offer_draw', 'created', 'exp', 'ts', 'afk_ms', 'rematch_st', 'rematch_by'];
/** Visão do servidor → content JSON do cartão (só campos públicos). */
export function cardContentFromView(view) {
  const o = { kind: 'game' };
  for (const k of PUBLIC_KEYS) if (view && view[k] !== undefined) o[k] = view[k];
  return JSON.stringify(o);
}
function _lc(s) { return String(s || '').toLowerCase(); }
export function nameOf(g, email, meEmail, t) {
  const e = _lc(email);
  if (meEmail && e === _lc(meEmail)) return tr(t, 'games.you', 'Você');
  const p = (g && Array.isArray(g.players) ? g.players : []).find((x) => _lc(x.e) === e);
  if (p && p.n) return String(p.n).split(' ')[0];
  const r = (g && Array.isArray(g.ranking) ? g.ranking : []).find((x) => _lc(x.e) === e);
  if (r && r.n) return String(r.n).split(' ')[0];
  return e.split('@')[0];
}
export function myStatusIn(g, meEmail) {
  const p = (g && Array.isArray(g.players) ? g.players : []).find((x) => _lc(x.e) === _lc(meEmail));
  return p ? p.s : null;
}
export function isMyTurn(g, meEmail) { return !!(g && g.status === 'active' && g.turn && _lc(g.turn) === _lc(meEmail)); }
export function isSeat(g, meEmail) { return !!(g && Array.isArray(g.seats) && g.seats.some((e) => _lc(e) === _lc(meEmail))); }

/** Convite vencido? (o servidor fecha sozinho; o app já mostra "Expirado" na hora pelo `exp` do cartão) */
export function isInviteExpired(g, now) {
  if (!g || g.status !== 'pending' || !g.exp) return false;
  return (Number(now) || Date.now()) > Number(g.exp);
}
/** Quem abandonou (1º que saiu) — para "Ana abandonou". */
function _leaver(g) {
  if (g && g.end_by && (g.end === 'resign')) return g.end_by;
  const l = g && Array.isArray(g.left) ? g.left : [];
  return l.length ? l[0] : null;
}
/**
 * [jogos 2026-10-19] Estado final para o selo do cartão/tela:
 * 'expired' | 'cancelled' | 'declined' | 'draw' | 'won' (eu venci) | 'lost' | 'abandoned' (eu saí) | 'resigned_other' (o outro saiu e eu venci)
 * | 'winner' (espectador: alguém venceu) | 'hanged' | 'over' | null (em aberto).
 */
export function gameEndKind(g, meEmail, now) {
  if (!g) return null;
  const me = _lc(meEmail);
  if (g.status === 'pending') return isInviteExpired(g, now) ? 'expired' : null;
  if (g.status === 'cancelled') {
    if (g.end === 'expired') return 'expired';
    if (g.end === 'declined') return 'declined';
    return 'cancelled';
  }
  if (g.kind === 'result' || g.status === 'finished') {
    const w = Array.isArray(g.winners) ? g.winners.map(_lc) : [];
    if (g.draw) return 'draw';
    if (g.type === 'forca' && g.hanged) return 'hanged';
    const leaver = _lc(_leaver(g));
    if (g.end === 'resign' && leaver && leaver === me) return 'abandoned';
    if (w.includes(me)) return g.end === 'resign' && leaver ? 'resigned_other' : 'won';
    const seat = isSeat(g, me) || (Array.isArray(g.ranking) && g.ranking.some((r) => _lc(r.e) === me));
    if (seat && w.length) return 'lost';
    return w.length ? 'winner' : 'over';
  }
  return null;
}
/** Selo curto do estado final (cartão no chat / lista do seletor): Cancelado, Expirado, Recusado, Empate, Venceu, Abandonou… */
export function gameEndBadge(t, g, meEmail, now) {
  const k = gameEndKind(g, meEmail, now);
  if (!k) return null;
  const fb = {
    expired: ['games.badge.expired', 'Expirado'], cancelled: ['games.badge.cancelled', 'Cancelado'], declined: ['games.badge.declined', 'Recusado'],
    draw: ['games.badge.draw', 'Empate'], won: ['games.badge.won', 'Venceu'], resigned_other: ['games.badge.won', 'Venceu'], lost: ['games.badge.lost', 'Perdeu'],
    abandoned: ['games.badge.abandoned', 'Abandonou'], winner: ['games.badge.finished', 'Encerrado'], hanged: ['games.badge.finished', 'Encerrado'], over: ['games.badge.finished', 'Encerrado'],
  }[k];
  if (!fb) return null;
  // espectador/jogador vendo que alguém abandonou: "Abandonou" vale mais que "Encerrado"/"Perdeu"
  if ((k === 'winner' || k === 'lost') && g.end === 'resign' && _leaver(g)) return { kind: 'abandoned', label: tr(t, 'games.badge.abandoned', 'Abandonou') };
  return { kind: k, label: tr(t, fb[0], fb[1]) };
}

/** Linha de status do cartão: "Sua vez", "Vez de Ana", "Ana venceu", "Empate", "Aguardando Beto"… */
export function gameStatusLine(t, g, meEmail, now) {
  if (!g) return '';
  const me = _lc(meEmail);
  if (g.kind === 'result' || g.status === 'finished') {
    const w = Array.isArray(g.winners) ? g.winners : [];
    if (g.draw) return g.end === 'draw' ? tr(t, 'games.status.drawAgreed', 'Empate combinado') : tr(t, 'games.status.draw', 'Empate');
    if (g.type === 'forca' && g.hanged) return tr(t, 'games.status.hanged', 'Ninguém acertou a palavra');
    const leaver = _leaver(g);
    if (g.end === 'resign' && leaver) {
      if (_lc(leaver) === me) return tr(t, 'games.status.youLeft', 'Você abandonou a partida');
      const ln = nameOf(g, leaver, meEmail, t);
      if (w.some((e) => _lc(e) === me)) return tr(t, 'games.status.leftYouWon', '{name} abandonou. Você venceu', { name: ln });
      if (w.length === 1) return tr(t, 'games.status.leftWon', '{name} abandonou. {winner} venceu', { name: ln, winner: nameOf(g, w[0], meEmail, t) });
      return tr(t, 'games.status.left', '{name} abandonou', { name: ln });
    }
    if (!w.length) return tr(t, 'games.status.finished', 'Partida encerrada');
    if (w.some((e) => _lc(e) === me)) return w.length > 1 ? tr(t, 'games.status.youTied', 'Você empatou no 1º lugar') : tr(t, 'games.status.youWon', 'Você venceu');
    return tr(t, 'games.status.won', '{name} venceu', { name: nameOf(g, w[0], meEmail, t) });
  }
  if (g.status === 'cancelled') {
    if (g.end === 'expired') return tr(t, 'games.status.expired', 'Convite expirado');
    if (g.end === 'declined') {
      if (g.end_by && _lc(g.end_by) === me) return tr(t, 'games.status.youDeclined', 'Você recusou o convite');
      return g.end_by ? tr(t, 'games.status.declinedBy', '{name} recusou o convite', { name: nameOf(g, g.end_by, meEmail, t) }) : tr(t, 'games.status.declined', 'Convite recusado');
    }
    if (g.end === 'cancelled' && g.end_by) {
      return _lc(g.end_by) === me ? tr(t, 'games.status.youCancelled', 'Você cancelou o convite') : tr(t, 'games.status.cancelledBy', '{name} cancelou o convite', { name: nameOf(g, g.end_by, meEmail, t) });
    }
    return tr(t, 'games.status.cancelled', 'Partida cancelada');
  }
  if (g.status === 'pending') {
    if (isInviteExpired(g, now)) return tr(t, 'games.status.expired', 'Convite expirado');
    const mine = myStatusIn(g, meEmail);
    if (mine === 'invited') return g.rematch_of ? tr(t, 'games.status.rematchYou', 'Quer uma revanche') : tr(t, 'games.status.invitedYou', 'Convidou você para jogar');
    const waiting = (g.players || []).filter((p) => p.s === 'invited');
    if (g.open && !waiting.length) return tr(t, 'games.status.openWaiting', 'Aberto: toque em Entrar para jogar');
    if (waiting.length === 1) return tr(t, 'games.status.waitingFor', 'Aguardando {name}', { name: nameOf(g, waiting[0].e, meEmail, t) });
    return tr(t, 'games.status.waitingN', 'Aguardando {n} jogadores', { n: waiting.length });
  }
  if (g.status === 'active') {
    if (g.draw_offer) {
      if (_lc(g.draw_offer) === me) return tr(t, 'games.status.drawOffered', 'Você propôs empate');
      if (isSeat(g, me)) return tr(t, 'games.status.drawOfferYou', '{name} propôs empate', { name: nameOf(g, g.draw_offer, meEmail, t) });
    }
    if (g.type === 'quiz') {
      const i = g.info && g.info.i; const n = g.info && g.info.count;
      return i && n ? tr(t, 'games.status.quizProgress', 'Pergunta {i} de {n}', { i, n }) : tr(t, 'games.status.playing', 'Em andamento');
    }
    // [jogos2] Batalha Naval: fase de posicionar (sem vez)
    if (g.type === 'naval' && !g.turn && g.info && g.info.ph === 'place') return tr(t, 'games.naval.placing', 'Posicionando os barcos');
    { const nx = novosStatusLine(t, g, meEmail, tr, nameOf); if (nx) return nx; } // [jogos2b] termo/ppt/stop/desenho (sem vez)
    { const nx = extraStatusLine(t, g, meEmail, tr, nameOf); if (nx) return nx; } // [jogos3] xadrez/conhece
    if (!g.turn) return tr(t, 'games.status.playing', 'Em andamento');
    if (_lc(g.turn) === me) return tr(t, 'games.status.yourTurn', 'Sua vez');
    return tr(t, 'games.status.turnOf', 'Vez de {name}', { name: nameOf(g, g.turn, meEmail, t) });
  }
  return '';
}
/** Frase do cartão de resultado: "Ana venceu a partida de Damas!" */
export function resultHeadline(t, g, meEmail) {
  const title = gameTitle(t, g.type);
  const w = Array.isArray(g.winners) ? g.winners : [];
  if (g.draw) return g.end === 'draw' ? tr(t, 'games.result.drawAgreed', 'Empate combinado na partida de {game}', { game: title }) : tr(t, 'games.result.draw', 'Empate na partida de {game}', { game: title });
  if (g.type === 'forca' && g.hanged) return tr(t, 'games.result.hanged', 'A forca venceu desta vez');
  const leaver = _leaver(g);
  if (g.end === 'resign' && leaver && w.length === 1) {
    if (_lc(leaver) === _lc(meEmail)) return tr(t, 'games.result.youLeft', 'Você abandonou a partida de {game}', { game: title });
    if (_lc(w[0]) === _lc(meEmail)) return tr(t, 'games.result.leftYouWon', '{name} abandonou. Você venceu a partida de {game}!', { name: nameOf(g, leaver, meEmail, t), game: title });
    return tr(t, 'games.result.leftWon', '{name} abandonou. {winner} venceu a partida de {game}', { name: nameOf(g, leaver, meEmail, t), winner: nameOf(g, w[0], meEmail, t), game: title });
  }
  if (!w.length) return tr(t, 'games.result.over', 'Fim da partida de {game}', { game: title });
  if (w.length > 1) return tr(t, 'games.result.tie', 'Empate no topo da partida de {game}', { game: title });
  if (_lc(w[0]) === _lc(meEmail)) return tr(t, 'games.result.youWon', 'Você venceu a partida de {game}!', { game: title });
  return tr(t, 'games.result.won', '{name} venceu a partida de {game}!', { name: nameOf(g, w[0], meEmail, t), game: title });
}
/** Prévia na lista de conversas (sem emoji). */
export function gamePreviewText(t, content) {
  const g = parseGameContent(content);
  if (!g) return tr(t, 'games.preview', 'Jogo');
  if (g.kind === 'result') return resultHeadline(t, g, '');
  return tr(t, 'games.previewInvite', 'Jogo: {game}', { game: gameTitle(t, g.type) });
}
const ERR_FB = {
  not_your_turn: 'Não é a sua vez', illegal_move: 'Lance inválido', must_capture: 'A captura é obrigatória',
  cell_taken: 'Essa casa já está ocupada', version_conflict: 'O jogo mudou, atualizamos para você',
  illegal_card: 'Essa carta não serve agora', wild4_not_allowed: 'Coringa +4 só sem cartas da cor da mesa',
  must_play_drawn: 'Jogue a carta comprada ou passe', already_drew: 'Você já comprou nesta vez', must_draw_first: 'Compre uma carta antes de passar',
  color_required: 'Escolha uma cor', already_answered: 'Você já respondeu', time_up: 'Tempo esgotado', already_guessed: 'Essa letra já foi',
  bad_letter: 'Escolha uma letra', game_over: 'A partida já acabou', not_started: 'A partida ainda não começou',
  not_a_player: 'Você está assistindo', too_few_players: 'Faltam jogadores', too_many_players: 'Jogadores demais para este jogo',
  too_many_games: 'Já há muitos jogos abertos nesta conversa', rate_limited: 'Calma, muitas jogadas seguidas', games_disabled: 'Jogos indisponíveis no momento',
  not_invited: 'Este jogo é só para convidados', game_full: 'Este jogo já está cheio', only_creator: 'Só quem criou pode fazer isso',
  player_not_member: 'Essa pessoa não está na conversa', unavailable: 'Indisponível nesta conversa',
  // [2026-10-19] ciclo de vida
  already_accepted: 'Alguém já aceitou: não dá mais para cancelar', invite_expired: 'Este convite expirou', invite_cancelled: 'Este convite foi cancelado',
  not_pending: 'Este convite já foi respondido', draw_not_allowed: 'Este jogo não tem empate combinado', no_draw_offer: 'Não há proposta de empate',
  draw_wait: 'Jogue um lance antes de propor empate de novo', not_finished: 'A partida ainda não acabou',
  // [jogos2] Ligue 4 / Batalha Naval / Dominó / Memória
  column_full: 'Essa coluna está cheia', not_placing: 'Os barcos já foram posicionados', already_placed: 'Você já posicionou seus barcos',
  bad_fleet: 'Posição de barcos inválida', ships_overlap: 'Os barcos não podem se sobrepor', not_firing: 'Espere os dois posicionarem os barcos',
  already_shot: 'Você já atirou nessa casa', tile_not_in_hand: 'Essa pedra não está na sua mão', tile_no_fit: 'Essa pedra não encaixa',
  choose_side: 'Escolha a ponta', can_play: 'Você tem pedra que encaixa', pile_empty: 'O monte acabou', card_taken: 'Esse par já saiu', card_up: 'Essa carta já está virada',
};
Object.assign(ERR_FB, NOVOS_ERRORS); // [jogos2b]
Object.assign(ERR_FB, EXTRA_ERRORS); // [jogos3]
export function gameErrorText(t, r) {
  const code = String((r && (r.message || (r.data && r.data.error))) || '');
  if (ERR_FB[code]) return tr(t, 'games.err.' + code, ERR_FB[code]);
  return tr(t, 'games.err.generic', 'Não deu certo. Tente de novo.');
}

/** Botões do cartão no chat (JS e nativo usam a mesma regra). */
export function gameCardActions(g, meEmail, now) {
  const acts = [];
  if (!g) return acts;
  const me = _lc(meEmail);
  const seat = isSeat(g, me);
  const wasPlayer = seat || (Array.isArray(g.ranking) && g.ranking.some((r) => _lc(r.e) === me));
  if (g.kind === 'result') { if (wasPlayer && g.rematch_st !== 'active') acts.push('rematch'); acts.push('open'); return acts; }
  const mine = myStatusIn(g, me);
  if (g.status === 'pending') {
    if (isInviteExpired(g, now)) return acts;
    if (mine === 'invited') return ['accept', 'decline'];
    if (!mine && g.open) acts.push('join');
    if (_lc(g.by) === me) {
      const acc = (g.players || []).filter((p) => p.s === 'accepted').length;
      if (acc >= (Number(g.min) || 2)) acts.push('start');
      const others = (g.players || []).some((p) => p.s === 'accepted' && _lc(p.e) !== me);
      if (!others) acts.push('cancel');
    }
    return acts;
  }
  if (g.status === 'active') return [seat ? 'play' : 'watch'];
  if (g.status === 'finished') {
    acts.push('open');
    // revanche: o outro já pediu → "Aceitar revanche"; eu já pedi → espera (sem botão); aceita → some
    if (wasPlayer && !(g.rematch_st === 'pending' && _lc(g.rematch_by) === me) && g.rematch_st !== 'active') acts.push('rematch');
  }
  return acts;
}
export function gameActionLabel(t, act, g, meEmail) {
  if (act === 'rematch' && g && g.rematch_st === 'pending' && g.rematch_by && _lc(g.rematch_by) !== _lc(meEmail)) return tr(t, 'games.act.acceptRematch', 'Aceitar revanche');
  const fb = { accept: 'Aceitar', decline: 'Recusar', join: 'Entrar', start: 'Começar', cancel: 'Cancelar', play: 'Jogar', watch: 'Assistir', open: 'Ver partida', rematch: 'Revanche' };
  return tr(t, 'games.act.' + act, fb[act] || act);
}
export function playerStatusLabel(t, s) {
  const fb = { accepted: 'Pronto', invited: 'Convidado', declined: 'Recusou', left: 'Saiu', expired: 'Não entrou' };
  return tr(t, 'games.pstatus.' + s, fb[s] || '');
}
