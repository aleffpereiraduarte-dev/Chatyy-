// [2026-10-10 lives-2] Pré-conexão da PRÓXIMA live (rolagem vertical estilo TikTok).
//
// Enquanto o espectador assiste a live atual, a próxima da fila já fica
// conectada ao LiveKit como participante OCULTO (token prewarm=1: o host não vê
// "entrou", não conta espectador) e com autoSubscribe:false — nenhum áudio ou
// vídeo dela é baixado/tocado. Ao deslizar, a tela nova "adota" essa sala:
// assina as faixas do host (vídeo aparece sem o handshake de sinalização/ICE)
// e pede ao servidor para torná-la visível (live_join_lk_promote).
//
// Só existe UMA pré-conexão por vez (módulo singleton, sobrevive à troca de
// tela). Qualquer falha devolve null → o chamador segue o caminho normal.
import * as api from './api';

let _entry = null;
const TAKE_WAIT_MS = 4000;
const IDLE_TTL_MS = 10 * 60 * 1000;
const HANDOFF_TTL_MS = 15000;

function _loadLk() {
  try { return require('livekit-client'); } catch { return null; }
}

function _drop(entry) {
  if (!entry) return;
  entry.dead = true;
  if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
  try { entry.room?.disconnect?.(); } catch {}
  if (_entry === entry) _entry = null;
}

export function prewarmedSessionId() {
  return _entry && !_entry.dead ? _entry.sessionId : null;
}

// Conecta (oculto, sem mídia) à live `sessionId`. Idempotente para o mesmo id.
export function prewarmLive(sessionId, opts = {}) {
  const sid = String(sessionId || '');
  if (!sid) return;
  if (_entry && !_entry.dead && _entry.sessionId === sid) {
    if (opts.handoff) markPrewarmHandoff(sid);
    return;
  }
  disposePrewarm();
  const lk = _loadLk();
  if (!lk?.Room) return;
  const entry = { sessionId: sid, room: null, joinRes: null, dead: false, handoff: false, timer: null };
  _entry = entry;
  entry.timer = setTimeout(() => { if (_entry === entry) _drop(entry); }, opts.handoff ? HANDOFF_TTL_MS : IDLE_TTL_MS);
  entry.handoff = !!opts.handoff;
  entry.promise = (async () => {
    const jr = await api.liveJoinLk(sid, { prewarm: true });
    // Servidor sem suporte a prewarm (token visível) → não arrisca "entrou" falso.
    if (entry.dead || !jr?.success || !jr?.data?.lk_token || jr?.data?.prewarm !== true) return null;
    const room = new lk.Room({ adaptiveStream: true, dynacast: false });
    entry.room = room;
    room.on(lk.RoomEvent.Disconnected, () => { if (!entry.taken) _drop(entry); });
    await room.connect(jr.data.lk_url || 'wss://livekit.chatyy.com.br', jr.data.lk_token, { autoSubscribe: false });
    if (entry.dead) { try { room.disconnect(); } catch {} return null; }
    entry.joinRes = jr;
    return entry;
  })().catch((e) => {
    console.log('[LIVE-PREWARM] falhou', sid, e?.message);
    _drop(entry);
    return null;
  });
}

// A tela atual vai ser trocada pela live `sessionId`: mantém a pré-conexão viva
// durante a desmontagem (só por alguns segundos, caso a tela nova não adote).
export function markPrewarmHandoff(sessionId) {
  const e = _entry;
  if (!e || e.dead || e.sessionId !== String(sessionId || '')) return;
  e.handoff = true;
  if (e.timer) clearTimeout(e.timer);
  e.timer = setTimeout(() => { if (_entry === e && !e.taken) _drop(e); }, HANDOFF_TTL_MS);
}

// Desmontagem da tela do espectador: descarta a pré-conexão, exceto se ela foi
// marcada para a tela seguinte (handoff).
export function releasePrewarmUnlessHandoff() {
  const e = _entry;
  if (e && !e.handoff) _drop(e);
}

export function disposePrewarm(sessionId) {
  const e = _entry;
  if (!e) return;
  if (sessionId && e.sessionId !== String(sessionId)) return;
  _drop(e);
}

// Adota a pré-conexão de `sessionId`. Devolve { room, joinRes, activate } ou null.
// O chamador liga seus listeners na `room` e DEPOIS chama activate(), que assina
// as faixas (TrackSubscribed dispara já com os listeners prontos) e promove o
// participante a visível em segundo plano.
export async function takePrewarmedLive(sessionId) {
  const e = _entry;
  if (!e || e.dead || e.sessionId !== String(sessionId || '')) return null;
  e.taken = true;
  if (e.timer) { clearTimeout(e.timer); e.timer = null; }
  _entry = null;
  let timer = null;
  const res = await Promise.race([
    e.promise,
    new Promise((r) => { timer = setTimeout(() => r(null), TAKE_WAIT_MS); }),
  ]);
  if (timer) clearTimeout(timer);
  const room = e.room;
  if (!res || !room || room.state !== 'connected') {
    // Ainda conectando (ou falhou): a conexão tardia se desfaz sozinha (dead).
    e.dead = true;
    try { room?.disconnect?.(); } catch {}
    return null;
  }
  const lk = _loadLk();
  const activate = async () => {
    const sub = (pub) => { try { if (pub && !pub.isSubscribed) pub.setSubscribed(true); } catch {} };
    try { if (lk?.RoomEvent) room.on(lk.RoomEvent.TrackPublished, (pub) => sub(pub)); } catch {}
    try { room.remoteParticipants.forEach((p) => p.trackPublications.forEach((pub) => sub(pub))); } catch {}
    const identity = e.joinRes?.data?.identity;
    if (identity) {
      api.liveJoinLkPromote(e.sessionId, identity).then((r) => {
        // Encerrada/banido nesse meio-tempo → solta a sala; o fluxo normal de
        // reconexão da tela recebe 410 e mostra "live terminou".
        if (r && r.success === false && /ended/i.test(String(r.message || ''))) {
          try { room.disconnect(); } catch {}
        }
      }).catch((err) => {
        if (/410|ended/i.test(String(err?.message || ''))) { try { room.disconnect(); } catch {} }
      });
    }
  };
  return { room, joinRes: e.joinRes, activate };
}
