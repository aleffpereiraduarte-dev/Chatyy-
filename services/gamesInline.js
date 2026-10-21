// services/gamesInline.js — [jogos 2026-10-19 inline] Jogo DENTRO da conversa (GamePigeon + Messenger).
//
//  - Velha, Forca e Quiz: jogados no próprio cartão da mensagem (render JS: components/games/GameInlineBoard.js;
//    lista NATIVA: components/chat/nativeRowCards.js buildGame → nós tocáveis `game:mv:<cell>`, `game:l:<A>`,
//    `game:q:<i>` — puro JS, sem build).
//  - Damas e Cartas Coloridas: o cartão mostra a miniatura + vez; tocar abre a FOLHA nativa por cima da
//    conversa (components/games/GamePlaySheet.js → NativeSheet: UISheetPresentationController / BottomSheet).
//    A conversa continua montada embaixo → fechar volta exatamente para a mesma posição.
//  - A rota /game/[id] continua existindo (deep link / app antigo), mas o chat não navega mais para lá.
//
//  - [2026-10-20] com o PAINEL (GameDock, kill __chatyy_games_dock=false) nada disso é folha: seletor e
//    Damas/Cartas abrem num painel acima do composer, dentro da própria tela da conversa.
//
// Kill switch (OTA): globalThis.__chatyy_games_inline = false → volta a navegação antiga para /game/[id].
//
// Estado: a visão de cada jogo vem do store de services/games.js (game_update do WS traz a visão do
// próprio jogador com `state`); aqui só há: busca preguiçosa da visão (cartão visível sem visão), lance com
// trava por jogo + erro curto no cartão, e o "tique" do Quiz (avança pergunta/revelação no prazo).
import { Platform } from 'react-native';
import {
  getGameView, gameState, gameMove, onAnyGameView, gamesKillSwitched, tr, isMyTurn,
} from './games';

export const INLINE_TYPES = { velha: 1, forca: 1, quiz: 1 };
export const SHEET_TYPES = { damas: 1, cartas: 1 };
Object.assign(SHEET_TYPES, { ligue4: 1, naval: 1, domino: 1, memoria: 1 }); // [jogos2 2026-10-21] abrem no painel

Object.assign(SHEET_TYPES, { termo: 1, ppt: 1, stop: 1, desenho: 1 }); // [jogos2b 2026-10-21] simultâneos: abrem no painel

export function gamesInlineOn() {
  try { if (globalThis.__chatyy_games_inline === false) return false; } catch {}
  return !gamesKillSwitched();
}
export function isInlineType(type) { return !!INLINE_TYPES[type]; }

// ─── ouvintes (lista nativa re-monta; cartão JS re-renderiza) ───────────────
const _subs = new Set();
let _anyOff = null;
function _emit(gid, why) { for (const fn of Array.from(_subs)) { try { fn(gid, why); } catch {} } }
export function onInlineChange(fn) {
  _subs.add(fn);
  if (!_anyOff) {
    try {
      _anyOff = onAnyGameView((v) => { try { _scheduleTick(v); } catch {} _emit(Number(v && v.g)); });
    } catch {}
  }
  return () => { _subs.delete(fn); };
}

// ─── visão preguiçosa ───────────────────────────────────────────────────────
const _inflight = new Map(); // gid -> Promise
const _lastAsk = new Map();  // gid -> ms
/** Visão do jogo p/ desenhar o tabuleiro no cartão; busca 1× (e de novo se ficar velha) quando falta. */
export function ensureInlineView(gid, cardStatus, cardV) {
  const id = Number(gid);
  if (!id) return null;
  const v = getGameView(id);
  // [audit 2026-10-19] visão atrás do cartão (WS perdido em 2º plano: o cartão veio pelo sync com versão/estado
  // mais novos) → re-busca; antes o tabuleiro ficava na posição velha (ou "ativo" com a partida já encerrada).
  const behind = !!v && ((Number(cardV) > 0 && Number(v.v) < Number(cardV)) || (v.status === 'active' && !!cardStatus && cardStatus !== 'active'));
  const stale = behind || (v && v.status === 'active' && cardStatus === 'active' && Date.now() - (v._rx || 0) > 90000);
  if (v && !stale) { _scheduleTick(v); return v; }
  // só vale buscar enquanto a partida está em andamento (ou acabou de acabar e o cartão ainda diz ativo)
  if (!behind && cardStatus !== 'active' && !(cardStatus === 'finished' && !v)) return v || null;
  if (_inflight.has(id)) return v || null;
  const last = _lastAsk.get(id) || 0;
  if (Date.now() - last < (behind ? 4000 : (v ? 30000 : 8000))) return v || null;
  _lastAsk.set(id, Date.now());
  const p = gameState(id).catch(() => null).finally(() => { _inflight.delete(id); _emit(id); });
  _inflight.set(id, p);
  return v || null;
}

// ─── lance a partir do cartão ───────────────────────────────────────────────
const _busy = new Set();
const _err = new Map(); // gid -> { text, at }
const _pending = new Map(); // gid -> { kind, val } (realce otimista da casa/letra/opção tocada)
export function inlineBusy(gid) { return _busy.has(Number(gid)); }
export function inlinePending(gid) { return _pending.get(Number(gid)) || null; }
export function inlineError(gid) {
  const e = _err.get(Number(gid));
  if (!e) return '';
  if (Date.now() - e.at > 2600) { _err.delete(Number(gid)); return ''; }
  return e.text;
}
function _fx() { try { return require('../components/games/fx'); } catch { return null; } }

/**
 * Faz o lance. `move` = intenção do servidor ({cell} | {a:'letter', l} | {a:'answer', q, c}).
 * Haptic no toque + erro curto no próprio cartão (some em 2,6 s). Nunca lança.
 */
export async function inlineMove(gid, move, t, pendingMark, noHaptic) {
  const id = Number(gid);
  const v = getGameView(id);
  if (!id || !v || _busy.has(id)) return false;
  const fx = _fx();
  if (!noHaptic) { try { fx && (move && move.a === 'answer' ? fx.hTap() : fx.hMove()); } catch {} }
  _busy.add(id);
  if (pendingMark) _pending.set(id, pendingMark);
  _err.delete(id);
  _emit(id);
  let ok = false;
  try {
    const r = await gameMove(id, v.v, move);
    ok = !!(r && r.success);
    if (ok && noHaptic) { try { fx && fx.hMove(); } catch {} }
    if (!ok) {
      const code = String((r && r.message) || '');
      if (code === 'version_conflict') { try { await gameState(id); } catch {} }
      if (code !== 'nothing_to_do') {
        try { fx && fx.hErr(); } catch {}
        let text = '';
        try { text = require('./games').gameErrorText(t, r); } catch { text = tr(t, 'games.err.generic', 'Não deu certo. Tente de novo.'); }
        _err.set(id, { text, at: Date.now() });
        setTimeout(() => _emit(id), 2700);
      }
    }
  } catch {}
  _busy.delete(id);
  _pending.delete(id);
  _emit(id);
  return ok;
}

/** Ação vinda da lista NATIVA (`game:mv:4` → arg 'mv:4'). true = tratada aqui. */
export function runInlineAction(m, arg, t) {
  const s = String(arg || '');
  const i = s.indexOf(':');
  if (i < 0) return false;
  const k = s.slice(0, i); const val = s.slice(i + 1);
  if (k !== 'mv' && k !== 'l' && k !== 'q') return false;
  let g = null;
  try { g = require('./games').parseGameContent(m && m.content); } catch {}
  if (!g || !g.g) return true;
  const v = getGameView(g.g);
  if (!v || v.status !== 'active') return true;
  if (k === 'mv') { const cell = Number(val); if (Number.isInteger(cell)) inlineMove(g.g, { cell }, t, { kind: 'cell', val: cell }); return true; }
  if (k === 'l') { const L = String(val || '').slice(0, 1).toUpperCase(); if (L) inlineMove(g.g, { a: 'letter', l: L }, t, { kind: 'letter', val: L }); return true; }
  if (k === 'q') {
    const c = Number(val);
    const S = v.state || {};
    if (Number.isInteger(c) && S.ph === 'q' && !S.my) inlineMove(g.g, { a: 'answer', q: S.i, c }, t, { kind: 'answer', val: c, q: S.i });
    return true;
  }
  return false;
}

// ─── Quiz: avança no prazo do servidor (sem tela aberta) ────────────────────
const _ticks = new Map(); // gid -> { at, timer }
function _offset(v) { return v && v.now && v._rx ? v.now - v._rx : 0; }
function _scheduleTick(v) {
  if (!v || v.type !== 'quiz' || !v.g) return;
  const id = Number(v.g);
  const prev = _ticks.get(id);
  if (v.status !== 'active') { if (prev) { clearTimeout(prev.timer); _ticks.delete(id); } return; }
  const S = v.state || {};
  const due = S.ph === 'q' ? Number(S.dl) + 300 : Number(S.rv) + 200;
  if (!due) return;
  const at = due - _offset(v); // relógio do app
  if (prev && prev.at === at) return;
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(async () => {
    _ticks.delete(id);
    const cur = getGameView(id);
    if (!cur || cur.status !== 'active') return;
    try {
      if (cur.me !== null && cur.me !== undefined) await gameMove(id, cur.v, { a: 'tick' });
      else await gameState(id);
    } catch {}
  }, Math.max(150, Math.min(120000, at - Date.now())));
  _ticks.set(id, { at, timer });
  // segundos do relógio do cartão: só re-renderiza os cartões de Quiz 1×/s enquanto há pergunta aberta
  _ensureSecondTicker();
}
let _secIv = null;
function _ensureSecondTicker() {
  if (_secIv) return;
  _secIv = setInterval(() => {
    let any = false;
    _ticks.forEach((_, id) => { const v = getGameView(id); if (v && v.status === 'active' && v.state && v.state.ph === 'q') { any = true; _emit(id, 'sec'); } });
    if (!any) { clearInterval(_secIv); _secIv = null; }
  }, 1000);
}
/** Segundos restantes da pergunta (relógio do servidor). */
export function quizSecondsLeft(v) {
  const S = (v && v.state) || {};
  if (S.ph !== 'q' || !S.dl) return 0;
  return Math.max(0, Math.ceil((Number(S.dl) - (Date.now() + _offset(v))) / 1000));
}

// ─── folha (Damas / Cartas — e "ver partida" de qualquer jogo) ──────────────
// pilha: conversa aberta por cima de outra (ambas montadas) → a de cima abre; ao sair, volta a de baixo
const _hosts = [];
/** components/games/GamePlaySheet.js (dono = tela da conversa) registra aqui. */
export function registerGameSheetHost(fn) {
  _hosts.push(fn);
  return () => { const i = _hosts.lastIndexOf(fn); if (i >= 0) _hosts.splice(i, 1); };
}
// [jogos 2026-10-20 dock] Painel EMBUTIDO na tela da conversa (components/games/GameDock.js, acima do
// composer, conversa rolável e chat funcionando): seletor de jogo + partida de Damas/Cartas. Nada de folha.
// Convite/espera/aceitar/cancelar = o próprio cartão (lobby) — o painel não abre para convite pendente nem
// para Velha/Forca/Quiz (jogadas no cartão). Kill: globalThis.__chatyy_games_dock = false → folha (19/10).
// partida aberta no painel (expandido) → o cartão dela na conversa vira 1 linha compacta (nada de "tela dentro de tela")
let _dockGid = 0;
export function dockedGameId() { return _dockGid; }
export function setDockedGame(gid) {
  const id = Number(gid) || 0;
  if (id === _dockGid) return;
  const prev = _dockGid;
  _dockGid = id;
  if (prev) _emit(prev);
  if (id) _emit(id);
}
export function gamesDockOn() {
  try { if (globalThis.__chatyy_games_dock === false) return false; } catch {}
  return gamesInlineOn();
}
const _pickHosts = [];
/** GameDock registra aqui o "abrir seletor". */
export function registerGamePickerHost(fn) {
  _pickHosts.push(fn);
  return () => { const i = _pickHosts.lastIndexOf(fn); if (i >= 0) _pickHosts.splice(i, 1); };
}
/** "Jogos" do "+": seletor no painel da conversa. false = sem painel (usa a folha antiga). */
export function openPickerInChat(cid) {
  if (!gamesDockOn()) return false;
  const host = _pickHosts[_pickHosts.length - 1];
  if (!host) return false;
  try { return host(cid) !== false; } catch { return false; }
}

/**
 * Abre o jogo SEM sair da conversa (painel embutido; com o kill do painel, folha por cima). Sem host
 * (tela fora do chat) ou kill switch → navegação antiga para a rota.
 * `hint` = cartão/visão ({status, type}); `hint.fromList` = escolhido na lista "Em andamento" (sempre abre).
 */
export function openGameInChat(gid, cid, router, hint) {
  if (!gid) return;
  const host = _hosts[_hosts.length - 1];
  if (gamesInlineOn() && host) {
    if (host.dock && hint && !hint.fromList) {
      if (hint.status === 'pending') return;       // o cartão é o lobby (aceitar/recusar/cancelar ali)
      if (isInlineType(hint.type)) { if (!getGameView(gid)) { try { gameState(Number(gid)).catch(() => {}); } catch {} } return; } // Velha/Forca/Quiz: joga no cartão
    }
    try { if (host(Number(gid), cid) !== false) return; } catch {}
  }
  try { router && router.push({ pathname: '/game/[id]', params: { id: String(gid), cid: String(cid || '') } }); } catch {}
}
/**
 * Depois de criar no seletor. Painel: nada abre — o cartão do convite aparece na conversa e o painel abre
 * sozinho quando a partida de Damas/Cartas começa. Sem painel: Velha/Forca/Quiz ficam no cartão e
 * Damas/Cartas abrem a folha (o seletor é folha nativa → espera ele descer: nunca folha sobre folha no iOS).
 */
export function afterGameCreated(gv, cid, router) {
  if (!gv || !gv.g) return;
  if (!gamesInlineOn()) { openGameInChat(gv.g, cid, router); return; }
  if (isInlineType(gv.type)) return;
  const host = _hosts[_hosts.length - 1];
  if (host && host.dock) return;
  try { require('../components/NativeSheet').runAfterNativeSheet(() => openGameInChat(gv.g, cid, router)); }
  catch { openGameInChat(gv.g, cid, router); }
}
export function afterSheetThen(fn) {
  try { require('../components/NativeSheet').runAfterNativeSheet(fn); } catch { fn(); }
}

/** Texto curto de vez para o cartão ("Sua vez" / "Vez de Ana" / resultado). */
export function inlineTurnText(t, v, meEmail) {
  try { return require('./games').gameStatusLine(t, v, meEmail); } catch { return ''; }
}
export { isMyTurn };
export const IS_WEB = Platform.OS === 'web';
