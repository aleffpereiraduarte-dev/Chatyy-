// [live-pk 2026-10-10] Vídeo/áudio do host ADVERSÁRIO durante a Batalha PK.
//
// Design: cada tela (host ou espectador, de qualquer lado) abre uma 2ª conexão
// LiveKit, só-assinatura e OCULTA (token de chat_live_battle_state with_token:
// hidden=true, canPublish=false, identidade "email#device~pk"), na sala da
// live adversária. Assina SÓ as faixas do host de lá (autoSubscribe=false →
// convidados/espectadores da outra sala não custam banda). Nada é republicado
// e nenhuma sala é alterada: quando a batalha acaba, a conexão é fechada.
//
// Retorna { videoTrack, audioTrack, present, connected, absentMs }.
// present=false por > N s com a batalha ativa = adversário caiu (a tela do
// host chama chat_live_battle_end reason=opponent_left).
import { useEffect, useRef, useState } from 'react';
import { emailFromIdentity } from '../../hooks/useLiveStage';

let _lkc = null;
function _lk() {
  if (_lkc) return _lkc;
  try { _lkc = require('livekit-client'); } catch { _lkc = null; }
  return _lkc;
}

const EMPTY = { videoTrack: null, audioTrack: null, present: false, connected: false, since: 0 };

function _pubs(p) {
  try { return Array.from(p?.trackPublications?.values?.() || []); } catch { return []; }
}

function _findHost(room, hostLc) {
  let best = null;
  let remotes = [];
  try { remotes = Array.from(room?.remoteParticipants?.values?.() || []); } catch {}
  for (const p of remotes) {
    const id = String(p?.identity || '');
    if (id.endsWith('~pk') || id.endsWith('~guest') || id.endsWith('~pw')) continue;
    if (emailFromIdentity(id) !== hostLc) continue;
    const pubs = _pubs(p);
    if (!pubs.length) continue; // conexão só-assinatura do próprio host (-host)
    const hasVideo = pubs.some((pb) => pb.kind === 'video');
    if (!best || (hasVideo && !best.hasVideo)) best = { p, pubs, hasVideo };
  }
  return best;
}

export default function useOpponentRoom(opponent, { enabled = true } = {}) {
  const [st, setSt] = useState(EMPTY);
  const stRef = useRef(EMPTY);
  const [attempt, setAttempt] = useState(0);
  const token = enabled && opponent && opponent.token ? opponent.token : '';
  const url = opponent && opponent.url ? opponent.url : '';
  const hostLc = String(opponent?.host_email || '').toLowerCase();

  useEffect(() => {
    const lk = _lk();
    const put = (next) => {
      const prev = stRef.current;
      if (prev.videoTrack === next.videoTrack && prev.audioTrack === next.audioTrack && prev.present === next.present && prev.connected === next.connected) return;
      stRef.current = next;
      setSt(next);
    };
    if (!token || !url || !hostLc || !lk?.Room || !lk?.RoomEvent) { put(EMPTY); return undefined; }
    let alive = true;
    let room = null;
    let raf = null;
    let retryTimer = null;
    const recompute = () => {
      raf = null;
      if (!alive || !room) return;
      const h = _findHost(room, hostLc);
      let videoTrack = null;
      let audioTrack = null;
      if (h) {
        for (const pb of h.pubs) {
          try { if (!pb.isSubscribed && typeof pb.setSubscribed === 'function') pb.setSubscribed(true); } catch {}
          if (pb.kind === 'video' && pb.source !== 'screen_share' && pb.track && !pb.isMuted && !videoTrack) videoTrack = pb.track;
          if (pb.kind === 'audio' && pb.track && !audioTrack) audioTrack = pb.track;
        }
      }
      const connected = String(room.state || '') === 'connected';
      const present = !!h;
      const prev = stRef.current;
      put({ videoTrack, audioTrack, present, connected, since: (present === prev.present && prev.since) ? prev.since : Date.now() });
    };
    const schedule = () => { if (raf == null) raf = setTimeout(recompute, 80); };
    (async () => {
      try {
        room = new lk.Room({ adaptiveStream: true, dynacast: false, stopLocalTrackOnUnpublish: true });
        const E = lk.RoomEvent;
        const evs = [
          E.ParticipantConnected, E.ParticipantDisconnected, E.TrackPublished, E.TrackUnpublished,
          E.TrackSubscribed, E.TrackUnsubscribed, E.TrackMuted, E.TrackUnmuted, E.Reconnected, E.ConnectionStateChanged,
        ].filter(Boolean);
        for (const ev of evs) { try { room.on(ev, schedule); } catch {} }
        if (E.Disconnected) {
          room.on(E.Disconnected, () => {
            if (!alive) return;
            schedule();
            // Queda inesperada: uma nova tentativa (token vale 30 min).
            retryTimer = setTimeout(() => { if (alive) setAttempt((n) => (n < 3 ? n + 1 : n)); }, 3000);
          });
        }
        await room.connect(url, token, { autoSubscribe: false });
        if (!alive) { try { room.disconnect(); } catch {} return; }
        recompute();
      } catch (e) {
        if (alive) {
          put({ ...EMPTY, since: Date.now() });
          retryTimer = setTimeout(() => { if (alive) setAttempt((n) => (n < 3 ? n + 1 : n)); }, 4000);
        }
      }
    })();
    return () => {
      alive = false;
      if (raf != null) { clearTimeout(raf); raf = null; }
      if (retryTimer) clearTimeout(retryTimer);
      try { room && room.removeAllListeners && room.removeAllListeners(); } catch {}
      try { room && room.disconnect(); } catch {}
      room = null;
    };
  }, [token, url, hostLc, attempt]);

  const absentMs = st.present ? 0 : (st.since ? Date.now() - st.since : 0);
  return { ...st, absentMs };
}
