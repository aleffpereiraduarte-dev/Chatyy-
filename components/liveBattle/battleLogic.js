/**
 * battleLogic — regras PURAS da Batalha PK (sem React / rede), testáveis em node.
 *
 * Fases (do ponto de vista de UMA tela, host ou espectador):
 *   idle      nada acontecendo
 *   outgoing  (host) convite enviado, aguardando o outro host (30s)
 *   incoming  (host) recebeu convite, aceitar/recusar (30s)
 *   active    batalha rolando (5 min), placar ao vivo
 *   ended     resultado + comemoração/castigo (20s), depois volta a idle
 *
 * Lado: 'a' = quem convidou, 'b' = quem aceitou. A tela sempre mostra o
 * PRÓPRIO host à esquerda (mySide) e o adversário à direita.
 */

export const PHASE = Object.freeze({ IDLE: 'idle', OUTGOING: 'outgoing', INCOMING: 'incoming', ACTIVE: 'active', ENDED: 'ended' });

export const INVITE_TTL_MS = 30000;
export const BATTLE_MS = 5 * 60 * 1000;
export const CELEBRATE_MS = 20000;

export const INITIAL_BATTLE_STATE = Object.freeze({
  phase: PHASE.IDLE,
  battle: null,     // objeto normalizado (ver normalizeBattle)
  invite: null,     // convite pendente (outgoing/incoming) normalizado
  mySide: null,     // 'a' | 'b'
  offset: 0,        // relógio do servidor - relógio local (ms)
});

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const str = (v) => (v == null ? '' : String(v));

function normHost(h, fallbackSession) {
  if (!h || typeof h !== 'object') return { email: '', name: '', session_id: str(fallbackSession) };
  return { email: str(h.email).toLowerCase(), name: str(h.name), session_id: str(h.session_id || fallbackSession) };
}

function normFan(f) {
  if (!f || typeof f !== 'object' || !f.email) return null;
  return { email: str(f.email).toLowerCase(), name: str(f.name), points: num(f.points != null ? f.points : f.likes) };
}

/** Normaliza frame do hub OU resposta REST no mesmo formato. */
export function normalizeBattle(m) {
  if (!m || typeof m !== 'object') return null;
  const id = str(m.battle_id || m.id);
  if (!id) return null;
  return {
    id,
    status: str(m.status) || 'active',
    sessionA: str(m.session_a),
    sessionB: str(m.session_b),
    hostA: normHost(m.host_a, m.session_a),
    hostB: normHost(m.host_b, m.session_b),
    scoreA: num(m.score_a),
    scoreB: num(m.score_b),
    mvpA: normFan(m.mvp_a),
    mvpB: normFan(m.mvp_b),
    topA: Array.isArray(m.top_a) ? m.top_a.map(normFan).filter(Boolean) : [],
    topB: Array.isArray(m.top_b) ? m.top_b.map(normFan).filter(Boolean) : [],
    startedAt: num(m.started_at, 0),
    endsAt: num(m.ends_at, 0),
    endedAt: num(m.ended_at, 0),
    inviteExpiresAt: num(m.invite_expires_at, 0),
    celebrateUntil: num(m.celebrate_until, 0),
    winner: m.winner ? str(m.winner) : null,
    reason: m.reason ? str(m.reason) : null,
    endedBy: m.ended_by ? str(m.ended_by) : null,
    isRandom: !!m.is_random,
  };
}

export function sideFor(battle, sessionId) {
  if (!battle || !sessionId) return null;
  const s = String(sessionId);
  if (battle.sessionA === s) return 'a';
  if (battle.sessionB === s) return 'b';
  return null;
}

/** Offset servidor-local a partir de server_now (ignora valores absurdos). */
export function clockOffset(serverNow, localNow = Date.now()) {
  const sn = num(serverNow, 0);
  if (!sn) return 0;
  const d = sn - localNow;
  return Math.abs(d) > 24 * 3600 * 1000 ? 0 : d;
}

export function remainingMs(battle, offset = 0, now = Date.now()) {
  if (!battle || !battle.endsAt) return 0;
  return Math.max(0, battle.endsAt - (now + offset));
}

export function formatClock(ms) {
  const total = Math.max(0, Math.ceil(num(ms) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/** Fração (0..1) da barra ocupada pelo lado esquerdo. 0x0 = meio a meio. */
export function scoreRatio(left, right, minShare = 0.08) {
  const l = Math.max(0, num(left));
  const r = Math.max(0, num(right));
  if (l + r <= 0) return 0.5;
  const raw = l / (l + r);
  return Math.min(1 - minShare, Math.max(minShare, raw));
}

export function winnerOf(scoreA, scoreB) {
  const a = num(scoreA); const b = num(scoreB);
  if (a > b) return 'a';
  if (b > a) return 'b';
  return 'draw';
}

/** 'win' | 'lose' | 'draw' do ponto de vista de mySide. */
export function outcomeFor(winner, mySide) {
  if (!winner || winner === 'draw' || !mySide) return 'draw';
  return winner === mySide ? 'win' : 'lose';
}

/** Esquerda = meu host; direita = adversário. */
export function orient(battle, mySide) {
  if (!battle) return null;
  const a = { host: battle.hostA, score: battle.scoreA, mvp: battle.mvpA, top: battle.topA, side: 'a' };
  const b = { host: battle.hostB, score: battle.scoreB, mvp: battle.mvpB, top: battle.topB, side: 'b' };
  return mySide === 'b' ? { left: b, right: a } : { left: a, right: b };
}

function mergeScores(prev, next) {
  // Placar só sobe dentro da mesma batalha (frames fora de ordem não regridem);
  // o resultado final (ended) é autoritativo.
  if (!prev || prev.id !== next.id || next.status === 'ended') return next;
  return {
    ...next,
    scoreA: Math.max(prev.scoreA, next.scoreA),
    scoreB: Math.max(prev.scoreB, next.scoreB),
    mvpA: next.mvpA || prev.mvpA,
    mvpB: next.mvpB || prev.mvpB,
    startedAt: next.startedAt || prev.startedAt,
    endsAt: next.endsAt || prev.endsAt,
  };
}

/**
 * Máquina de estados. ev = { type, ...payload, sessionId, now }.
 * Tipos:
 *   frame          frame WS live_battle_* / snapshot REST (payload.msg)
 *   invite_sent    REST invite ok (payload.battle)
 *   invite_in      WS live_battle_invite
 *   invite_gone    WS live_battle_declined / _invite_cancelled / expirou / respondido
 *   tick           relógio (expira convite, fecha comemoração)
 *   dismiss        usuário fecha o resultado
 *   reset          live trocou / encerrou
 */
export function battleReduce(state, ev) {
  const s = state || INITIAL_BATTLE_STATE;
  const now = ev && ev.now != null ? ev.now : Date.now();
  switch (ev && ev.type) {
    case 'frame': {
      const msg = ev.msg || {};
      const b = normalizeBattle(msg);
      if (!b) {
        // live_battle_state sem batalha: só derruba ativa/encerrada se for o mesmo snapshot "none".
        if (msg.status === 'none' && (s.phase === PHASE.ACTIVE)) return { ...s, phase: PHASE.IDLE, battle: null };
        return s;
      }
      const mySide = sideFor(b, ev.sessionId);
      if (!mySide) return s;
      const offset = msg.server_now ? clockOffset(msg.server_now, now) : s.offset;
      if (b.status === 'ended' || msg.type === 'live_battle_ended') {
        const ended = { ...b, status: 'ended' };
        if (!ended.winner) ended.winner = winnerOf(ended.scoreA, ended.scoreB);
        if (!ended.celebrateUntil) ended.celebrateUntil = (ended.endedAt || (now + offset)) + CELEBRATE_MS;
        // Já passou da comemoração (snapshot atrasado) → idle.
        if (ended.celebrateUntil <= now + offset) {
          return s.battle && s.battle.id === b.id ? { ...s, phase: PHASE.IDLE, battle: null, invite: null } : s;
        }
        // Resultado de batalha que dispensamos? mantém dismiss.
        if (s.dismissedId === b.id) return s;
        return { ...s, phase: PHASE.ENDED, battle: ended, invite: null, mySide, offset };
      }
      if (b.status === 'active' || msg.type === 'live_battle_started' || msg.type === 'live_battle_score') {
        if (s.phase === PHASE.ENDED && s.battle && s.battle.id === b.id) return s; // fim já chegou
        const merged = mergeScores(s.battle, { ...b, status: 'active' });
        return { ...s, phase: PHASE.ACTIVE, battle: merged, invite: null, mySide, offset };
      }
      return s;
    }
    case 'invite_sent': {
      const b = normalizeBattle(ev.battle);
      if (!b || s.phase === PHASE.ACTIVE || s.phase === PHASE.ENDED) return s;
      const offset = ev.battle && ev.battle.server_now ? clockOffset(ev.battle.server_now, now) : s.offset;
      return { ...s, phase: PHASE.OUTGOING, invite: { ...b, direction: 'out' }, offset };
    }
    case 'invite_in': {
      const b = normalizeBattle(ev.msg);
      if (!b || s.phase === PHASE.ACTIVE || s.phase === PHASE.ENDED) return s;
      if (ev.sessionId && b.sessionB !== String(ev.sessionId)) return s; // convite pra outra live minha
      const offset = ev.msg && ev.msg.server_now ? clockOffset(ev.msg.server_now, now) : s.offset;
      if (b.inviteExpiresAt && b.inviteExpiresAt <= now + offset) return s;
      return {
        ...s, phase: PHASE.INCOMING, offset,
        invite: { ...b, direction: 'in', fromName: str(ev.msg.from_name) || b.hostA.name, fromEmail: str(ev.msg.from_email) || b.hostA.email },
      };
    }
    case 'invite_gone': {
      const id = str(ev.battleId);
      if (!s.invite || (id && s.invite.id !== id)) return s;
      if (s.phase !== PHASE.OUTGOING && s.phase !== PHASE.INCOMING) return { ...s, invite: null };
      return { ...s, phase: PHASE.IDLE, invite: null };
    }
    case 'tick': {
      const t = now + s.offset;
      if ((s.phase === PHASE.OUTGOING || s.phase === PHASE.INCOMING) && s.invite) {
        const exp = s.invite.inviteExpiresAt || 0;
        if (exp && t >= exp + 1000) return { ...s, phase: PHASE.IDLE, invite: null, lastInviteExpired: s.invite.id };
      }
      if (s.phase === PHASE.ENDED && s.battle && s.battle.celebrateUntil && t >= s.battle.celebrateUntil) {
        return { ...s, phase: PHASE.IDLE, battle: null };
      }
      return s;
    }
    case 'dismiss': {
      if (s.phase !== PHASE.ENDED) return s;
      return { ...s, phase: PHASE.IDLE, battle: null, dismissedId: s.battle ? s.battle.id : null };
    }
    case 'reset':
      return { ...INITIAL_BATTLE_STATE };
    default:
      return s;
  }
}

/** A tela mostra o split (ativa ou comemorando)? */
export function isSplitVisible(state) {
  return !!state && !!state.battle && (state.phase === PHASE.ACTIVE || state.phase === PHASE.ENDED);
}
