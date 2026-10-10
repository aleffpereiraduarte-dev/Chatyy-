// [multi-guest 2026-10-10] Estado do "palco" de uma live (host + até 4
// convidados, estilo TikTok Multi-guest) derivado da sala LiveKit que a tela
// JÁ tem conectada — host: sala de publicação (lkRoomRef); espectador: sala de
// espectador (lkViewerRoomRef); web: lkRoomRef do live-viewer.web.js.
//
// Só entra no palco quem PUBLICA (tem publicação de câmera/mic). Espectadores
// (canPublish=false) nunca têm publicações, então não aparecem.
//
// Anti-eco: quando o próprio espectador está no palco, a conexão de
// publicação dele ("email#device~guest") aparece como participante REMOTO na
// sala de espectador do mesmo aparelho. Assinar isso = ouvir a própria voz com
// atraso. `selfEmail` marca o tile como isSelf e desassina as faixas dele
// (o tile próprio usa a prévia local).
import { useEffect, useRef, useState } from 'react';

let _lkc = null;
function _lk() {
  if (_lkc) return _lkc;
  try { _lkc = require('livekit-client'); } catch { _lkc = null; }
  return _lkc;
}

/** "ana@x.com#dev~guest" → "ana@x.com"; "ana@x.com-host" → "ana@x.com". */
export function emailFromIdentity(identity) {
  let s = String(identity || '').toLowerCase();
  const h = s.indexOf('#');
  if (h >= 0) s = s.slice(0, h);
  if (s.endsWith('-host')) s = s.slice(0, -5);
  return s;
}

function _metaOf(p) {
  try {
    const m = p && p.metadata;
    if (!m) return null;
    return typeof m === 'string' ? JSON.parse(m) : m;
  } catch { return null; }
}

function _nameOf(p, fallbackEmail) {
  const raw = typeof p?.name === 'string' ? p.name.trim() : '';
  if (raw && !raw.includes('@') && !raw.includes('#')) return raw.replace(/\s*\(host\)$/i, '');
  const meta = _metaOf(p);
  const dn = meta && (meta.displayName || meta.name);
  if (dn && !String(dn).includes('@')) return String(dn);
  const local = String(fallbackEmail || '').split('@')[0] || '';
  return local.replace(/[._-]+/g, ' ').replace(/\b(\w)/g, (c) => c.toUpperCase()) || '';
}

function _pubsOf(p) {
  try { return Array.from(p?.trackPublications?.values?.() || []); } catch { return []; }
}

function _snapshot(room, hostLc, selfLc) {
  const byEmail = new Map();
  let speakers = [];
  try { speakers = Array.isArray(room?.activeSpeakers) ? room.activeSpeakers : []; } catch {}
  const speakingIds = new Set(speakers.map((sp) => String(sp?.identity || '')));
  const remotes = (() => { try { return Array.from(room?.remoteParticipants?.values?.() || []); } catch { return []; } })();
  for (const p of remotes) {
    const pubs = _pubsOf(p);
    const camPub = pubs.find((pb) => pb.kind === 'video' && pb.source !== 'screen_share') || pubs.find((pb) => pb.kind === 'video');
    const micPub = pubs.find((pb) => pb.kind === 'audio');
    if (!camPub && !micPub) continue; // espectador (não publica)
    const identity = String(p.identity || '');
    const email = emailFromIdentity(identity);
    if (!email) continue;
    const isHost = !!hostLc && email === hostLc;
    const isSelf = !!selfLc && email === selfLc && !isHost;
    const entry = {
      identity,
      email,
      name: _nameOf(p, email),
      isHost,
      isSelf,
      isGuest: !isHost,
      videoTrack: camPub && camPub.track && !camPub.isMuted ? camPub.track : null,
      videoTrackSid: camPub ? (camPub.trackSid || camPub.sid || '') : '',
      audioTrack: micPub && micPub.track ? micPub.track : null,
      micMuted: !micPub || !!micPub.isMuted,
      camOff: !camPub || !!camPub.isMuted,
      speaking: speakingIds.has(identity) || !!p.isSpeaking,
      _pubs: pubs,
    };
    const prev = byEmail.get(email);
    // Mesmo e-mail com 2 conexões (reconexão): fica a que tem vídeo.
    if (!prev || (!prev.videoTrack && entry.videoTrack)) byEmail.set(email, entry);
  }
  let localSpeaking = false;
  try { localSpeaking = speakingIds.has(String(room?.localParticipant?.identity || '')) || !!room?.localParticipant?.isSpeaking; } catch {}
  return { list: Array.from(byEmail.values()), localSpeaking };
}

function _sameList(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]; const y = b[i];
    if (x.identity !== y.identity || x.videoTrack !== y.videoTrack || x.audioTrack !== y.audioTrack || x.micMuted !== y.micMuted
      || x.camOff !== y.camOff || x.speaking !== y.speaking || x.name !== y.name) return false;
  }
  return true;
}

/**
 * @param room   livekit-client Room (ou null) — pode trocar (re-join).
 * @param opts   { hostEmail, selfEmail }
 * @returns { publishers, guests, host, localSpeaking }
 *   publishers = todos que publicam (host remoto + convidados), host primeiro.
 */
export default function useLiveStage(room, opts = {}) {
  const hostLc = String(opts.hostEmail || '').toLowerCase();
  const selfLc = String(opts.selfEmail || '').toLowerCase();
  const [state, setState] = useState({ list: [], localSpeaking: false });
  const stateRef = useRef(state);
  const unsubscribedRef = useRef(new Set());

  useEffect(() => {
    const lk = _lk();
    if (!room || !lk?.RoomEvent) {
      if (stateRef.current.list.length || stateRef.current.localSpeaking) {
        stateRef.current = { list: [], localSpeaking: false };
        setState(stateRef.current);
      }
      return undefined;
    }
    let alive = true;
    let raf = null;
    const recompute = () => {
      raf = null;
      if (!alive) return;
      const snap = _snapshot(room, hostLc, selfLc);
      // Anti-eco: desassina a própria conexão de publicação.
      for (const e of snap.list) {
        if (!e.isSelf) continue;
        for (const pb of e._pubs) {
          const key = e.identity + ':' + (pb.trackSid || pb.sid || pb.kind);
          if (unsubscribedRef.current.has(key)) continue;
          try {
            if (typeof pb.setSubscribed === 'function') { pb.setSubscribed(false); unsubscribedRef.current.add(key); }
          } catch {}
        }
      }
      const prev = stateRef.current;
      if (_sameList(prev.list, snap.list) && prev.localSpeaking === snap.localSpeaking) return;
      stateRef.current = snap;
      setState(snap);
    };
    // Coalesce rajadas de eventos (connect inicial dispara dezenas).
    const schedule = () => {
      if (raf != null) return;
      raf = setTimeout(recompute, 60);
    };
    const E = lk.RoomEvent;
    const evs = [
      E.ParticipantConnected, E.ParticipantDisconnected, E.TrackPublished, E.TrackUnpublished,
      E.TrackSubscribed, E.TrackUnsubscribed, E.TrackMuted, E.TrackUnmuted,
      E.ActiveSpeakersChanged, E.ParticipantNameChanged, E.ParticipantMetadataChanged,
      E.Reconnected, E.ConnectionStateChanged,
    ].filter(Boolean);
    for (const ev of evs) { try { room.on(ev, schedule); } catch {} }
    recompute();
    return () => {
      alive = false;
      if (raf != null) { clearTimeout(raf); raf = null; }
      for (const ev of evs) { try { room.off(ev, schedule); } catch {} }
    };
  }, [room, hostLc, selfLc]);

  const publishers = state.list.slice().sort((a, b) => (a.isHost === b.isHost ? 0 : a.isHost ? -1 : 1));
  return {
    publishers,
    guests: publishers.filter((p) => !p.isHost),
    host: publishers.find((p) => p.isHost) || null,
    localSpeaking: state.localSpeaking,
  };
}
