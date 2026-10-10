/**
 * battleStore — estado da Batalha PK FORA da árvore das telas (useSyncExternalStore),
 * mesmo padrão do liveEngageStore: as telas de live têm 5-7k linhas e um
 * setState nelas re-renderiza tudo; aqui só os componentes da batalha mudam.
 *
 * Uso (tela):
 *   const battle = useLiveBattleController({ sessionId, wsRef, me, isHost });
 *   ws.onmessage → battle.onWsMessage(msg)   (observador, não consome)
 *   <LiveBattleStage battle={battle} left={...} />   split 50/50 + placar
 *   <LiveBattleLayer battle={battle} isHost />        convites, resultado, sheets
 *
 * Frames do hub (live_battle.go): live_battle_started | _score | _ended | _state.
 * Eventos REST→WS por usuário (chat.php): live_battle_invite | _declined |
 * _invite_cancelled. Hub/PHP antigos: nada chega → a UI simplesmente não
 * aparece (o botão "Batalha" mostra erro amigável no convite).
 */
import { useEffect, useRef, useSyncExternalStore, useCallback } from 'react';
import * as bApi from './battleApi';
import { PHASE, INITIAL_BATTLE_STATE, battleReduce, isSplitVisible } from './battleLogic';

const TOKEN_RETRY_MS = 4000;
const WS_STATE_DELAY_MS = 450;

const INITIAL = {
  ...INITIAL_BATTLE_STATE,
  sheet: null,            // 'pick' | 'confirmEnd' | null
  candidates: [],
  candidatesLoading: false,
  busy: false,            // convite/aceite/encerrar em andamento
  opponent: null,         // { token, url, room, identity, host_email, session_id, battleId }
  opponentBlocked: false,
  notice: null,           // { key, params, ts } — toast curto
};

const BATTLE_FRAMES = { live_battle_started: 1, live_battle_score: 1, live_battle_ended: 1, live_battle_state: 1 };

function createController() {
  let state = { ...INITIAL };
  const listeners = new Set();
  const opts = { sessionId: '', wsRef: null, me: { email: '', name: '' }, isHost: false };
  let tickTimer = null;
  let tokenInflight = false;
  let tokenLastTry = 0;
  let disposed = false;
  let refreshedFor = '';

  const emit = () => { listeners.forEach((l) => { try { l(); } catch {} }); };
  const set = (patch) => {
    const next = typeof patch === 'function' ? patch(state) : patch;
    if (!next) return;
    let changed = false;
    for (const k in next) { if (state[k] !== next[k]) { changed = true; break; } }
    if (!changed) return;
    state = { ...state, ...next };
    emit();
    syncTick();
  };

  const reduce = (ev) => {
    const prevPhase = state.phase;
    const core = battleReduce(state, { ...ev, sessionId: opts.sessionId, now: Date.now() });
    if (core === state) return;
    const patch = {};
    for (const k of ['phase', 'battle', 'invite', 'mySide', 'offset', 'dismissedId', 'lastInviteExpired']) {
      if (core[k] !== state[k]) patch[k] = core[k];
    }
    // Saiu do split → solta a sala do adversário.
    if (!isSplitVisible(core) && state.opponent) { patch.opponent = null; patch.opponentBlocked = false; }
    if (prevPhase === PHASE.OUTGOING && core.phase === PHASE.IDLE && core.lastInviteExpired && core.lastInviteExpired !== state.lastInviteExpired) {
      patch.notice = { key: 'liveBattle.noAnswer', ts: Date.now() };
    }
    if (core.phase === PHASE.ACTIVE && prevPhase !== PHASE.ACTIVE) patch.sheet = null;
    set(patch);
    maybeFetchToken();
  };

  const syncTick = () => {
    const need = !disposed && state.phase !== PHASE.IDLE;
    if (need && !tickTimer) tickTimer = setInterval(() => reduce({ type: 'tick' }), 1000);
    else if (!need && tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  };

  const wsSend = (obj) => {
    const ws = opts.wsRef?.current;
    try { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; } } catch {}
    return false;
  };

  const askHubState = () => {
    if (!opts.sessionId) return;
    setTimeout(() => { wsSend({ type: 'live_battle_state', session_id: opts.sessionId }); }, WS_STATE_DELAY_MS);
  };

  const applyRest = (d) => {
    if (!d || typeof d !== 'object') return;
    if (d.battle) reduce({ type: 'frame', msg: { ...d.battle, server_now: d.battle.server_now || d.server_now } });
    if (d.opponent && d.opponent.token && state.battle) {
      set({ opponent: { ...d.opponent, battleId: state.battle.id }, opponentBlocked: false });
    } else if (d.opponent_blocked) {
      set({ opponentBlocked: true });
    }
    if (opts.isHost) {
      if (d.incoming && state.phase === PHASE.IDLE) reduce({ type: 'invite_in', msg: d.incoming });
      if (d.outgoing && state.phase === PHASE.IDLE) reduce({ type: 'invite_sent', battle: d.outgoing });
    }
  };

  const refresh = async (withToken = true) => {
    const sid = opts.sessionId;
    if (!sid) return;
    // Um token por vez: o snapshot REST já traz o token, então o
    // maybeFetchToken() disparado pelo próprio frame não pede outro.
    if (withToken) { tokenInflight = true; tokenLastTry = Date.now(); }
    try {
      const r = await bApi.battleState(sid, withToken);
      if (disposed || sid !== opts.sessionId) return;
      if (r && r.success) applyRest(r.data);
    } catch {} finally {
      if (withToken) tokenInflight = false;
    }
  };

  function maybeFetchToken() {
    const b = state.battle;
    if (!b || state.phase !== PHASE.ACTIVE || state.opponentBlocked) return;
    if (state.opponent && state.opponent.battleId === b.id) return;
    if (tokenInflight || Date.now() - tokenLastTry < TOKEN_RETRY_MS) return;
    refresh(true);
  }

  const notice = (key, params) => set({ notice: { key, params: params || null, ts: Date.now() } });

  const api = {
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    getState() { return state; },
    setOpts(o) {
      const prevSid = opts.sessionId;
      Object.assign(opts, o);
      const switched = !!prevSid && prevSid !== opts.sessionId;
      if (opts.sessionId && refreshedFor !== opts.sessionId) {
        refreshedFor = opts.sessionId;
        // Fora do render (setOpts roda no corpo do componente).
        setTimeout(() => {
          if (disposed) return;
          if (switched) { state = { ...INITIAL }; emit(); syncTick(); }
          refresh(true);
        }, 0);
      } else if (switched) {
        setTimeout(() => { if (!disposed) { state = { ...INITIAL }; emit(); syncTick(); } }, 0);
      }
    },
    dispose() {
      disposed = true;
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
      listeners.clear();
    },

    /** Observador do WS da tela (frames já "achatados" msg.data → msg). */
    onWsMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      const ty = msg.type || msg.event;
      if (!ty) return;
      if (BATTLE_FRAMES[ty]) { reduce({ type: 'frame', msg: { ...msg, type: ty } }); return; }
      switch (ty) {
        case 'live_battle_invite':
          if (opts.isHost) reduce({ type: 'invite_in', msg });
          return;
        case 'live_battle_declined': {
          const mine = state.invite && state.invite.id === String(msg.battle_id || '');
          reduce({ type: 'invite_gone', battleId: msg.battle_id });
          if (mine && opts.isHost) notice(msg.reason === 'unavailable' ? 'liveBattle.unavailable' : 'liveBattle.declined');
          return;
        }
        case 'live_battle_invite_cancelled': {
          const mine = state.invite && state.invite.id === String(msg.battle_id || '');
          reduce({ type: 'invite_gone', battleId: msg.battle_id });
          if (mine && opts.isHost) notice('liveBattle.inviteCancelled');
          return;
        }
        case 'live_started':
        case 'live_joined':
        case 'live_host_back':
          askHubState();
          return;
        case 'live_ended':
          if (!msg.session_id || String(msg.session_id) === opts.sessionId) reduce({ type: 'reset' });
          return;
        default:
      }
    },

    // ── Host: convidar ────────────────────────────────────────────────
    async openPicker() {
      if (!opts.isHost || !opts.sessionId) return;
      if (state.phase === PHASE.ACTIVE || state.phase === PHASE.ENDED) { set({ sheet: 'confirmEnd' }); return; }
      set({ sheet: 'pick', candidatesLoading: true });
      try {
        const r = await bApi.battleCandidates(opts.sessionId);
        if (r && r.success) set({ candidates: Array.isArray(r.data?.candidates) ? r.data.candidates : [], candidatesLoading: false });
        else set({ candidates: [], candidatesLoading: false });
      } catch { set({ candidates: [], candidatesLoading: false }); }
    },
    async reloadCandidates() { return api.openPicker(); },
    closeSheet() { set({ sheet: null }); },
    askEnd() { if (state.phase === PHASE.ACTIVE) set({ sheet: 'confirmEnd' }); },

    async invite(targetSessionId) {
      if (!opts.isHost || !opts.sessionId || state.busy) return null;
      set({ busy: true });
      let r = null;
      try {
        r = targetSessionId ? await bApi.battleInvite(opts.sessionId, targetSessionId) : await bApi.battleInviteRandom(opts.sessionId);
      } catch {}
      set({ busy: false });
      if (r && r.success && r.data?.battle) {
        reduce({ type: 'invite_sent', battle: r.data.battle });
        set({ sheet: null });
        return r;
      }
      const reason = String(r?.data?.reason || '');
      const map = {
        rate_limited: 'liveBattle.rateLimited', cooldown: 'liveBattle.rateLimited',
        no_candidates: 'liveBattle.noCandidates', target_offline: 'liveBattle.targetOffline',
        target_busy: 'liveBattle.targetBusy', busy_self: 'liveBattle.alreadyInBattle',
        audience: 'liveBattle.needsPublic', not_host: 'liveBattle.failed',
      };
      notice(map[reason] || 'liveBattle.failed');
      if (reason === 'target_offline' || reason === 'target_busy') api.reloadCandidates();
      return r;
    },

    async cancelInvite() {
      const inv = state.invite;
      if (!inv) return;
      reduce({ type: 'invite_gone', battleId: inv.id });
      try { await bApi.battleEnd(inv.id, 'host_ended'); } catch {}
    },

    async respond(accept) {
      const inv = state.invite;
      if (!inv || state.busy) return;
      set({ busy: true });
      let r = null;
      try { r = await bApi.battleRespond(inv.id, !!accept); } catch {}
      set({ busy: false });
      if (!accept) { reduce({ type: 'invite_gone', battleId: inv.id }); return; }
      if (r && r.success && r.data?.battle) {
        reduce({ type: 'frame', msg: { ...r.data.battle, type: 'live_battle_started' } });
        return;
      }
      reduce({ type: 'invite_gone', battleId: inv.id });
      const reason = String(r?.data?.reason || '');
      notice(reason === 'expired' ? 'liveBattle.inviteExpired' : (reason === 'unavailable' ? 'liveBattle.unavailable' : 'liveBattle.failed'));
    },

    async endBattle(reason) {
      const b = state.battle;
      set({ sheet: null });
      if (!b || state.phase !== PHASE.ACTIVE || !opts.isHost) return;
      set({ busy: true });
      let r = null;
      try { r = await bApi.battleEnd(b.id, reason); } catch {}
      set({ busy: false });
      if (r && r.success && r.data?.battle) reduce({ type: 'frame', msg: { ...r.data.battle, type: 'live_battle_ended', status: 'ended' } });
      else if (!r || !r.success) notice('liveBattle.failed');
    },

    dismissResult() { reduce({ type: 'dismiss' }); },
    clearNotice() { set({ notice: null }); },
    refresh,
    getOpts() { return opts; },
  };
  return api;
}

/** Hook da tela: controlador estável por montagem. */
export function useLiveBattleController({ sessionId, wsRef, me, isHost }) {
  const ref = useRef(null);
  if (!ref.current) ref.current = createController();
  const ctl = ref.current;
  ctl.setOpts({ sessionId: sessionId ? String(sessionId) : '', wsRef, me: me || {}, isHost: !!isHost });
  useEffect(() => () => ctl.dispose(), [ctl]);
  return ctl;
}

/** Componentes: lê uma fatia do store (re-render só quando ela muda). */
export function useBattleSelector(battle, selector) {
  const sub = useCallback((l) => (battle ? battle.subscribe(l) : () => {}), [battle]);
  const get = useCallback(() => (battle ? selector(battle.getState()) : selector(INITIAL)), [battle, selector]);
  return useSyncExternalStore(sub, get, get);
}

export const selPhase = (s) => s.phase;
export const selBattle = (s) => s.battle;
export const selInvite = (s) => s.invite;
export const selMySide = (s) => s.mySide;
export const selOffset = (s) => s.offset;
export const selSheet = (s) => s.sheet;
export const selCandidates = (s) => s.candidates;
export const selCandidatesLoading = (s) => s.candidatesLoading;
export const selBusy = (s) => s.busy;
export const selOpponent = (s) => s.opponent;
export const selOpponentBlocked = (s) => s.opponentBlocked;
export const selNotice = (s) => s.notice;
export const selSplitVisible = (s) => isSplitVisible(s);
