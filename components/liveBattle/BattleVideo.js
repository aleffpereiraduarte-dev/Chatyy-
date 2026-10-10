// [live-pk 2026-10-10] Vídeo de um lado da Batalha PK (track LiveKit remota
// ou renderVideo() custom — prévia local do host). Web: <video>/<audio>.
import React, { useEffect, useRef } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { getLiveKitVideoView } from '../../hooks/useLiveKitRoom';

function WebTrackVideo({ track, mirror }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return undefined;
    try {
      if (typeof track.attach === 'function') track.attach(el);
      else if (track.mediaStreamTrack) el.srcObject = new MediaStream([track.mediaStreamTrack]);
      el.muted = true;
      const pr = el.play?.();
      if (pr && pr.catch) pr.catch(() => {});
    } catch {}
    return () => {
      try { if (typeof track.detach === 'function') track.detach(el); else el.srcObject = null; } catch {}
    };
  }, [track]);
  return React.createElement('video', {
    ref, autoPlay: true, playsInline: true, muted: true,
    style: {
      position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
      objectFit: 'cover', backgroundColor: '#000', transform: mirror ? 'scaleX(-1)' : 'none',
    },
  });
}

/** Web: áudio do adversário (livekit-client não toca áudio remoto sozinho). */
export function BattleWebAudio({ track, muted }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !track || typeof track.attach !== 'function') return undefined;
    try { track.attach(el); const pr = el.play?.(); if (pr && pr.catch) pr.catch(() => {}); } catch {}
    return () => { try { track.detach(el); } catch {} };
  }, [track]);
  useEffect(() => { if (ref.current) ref.current.muted = !!muted; }, [muted]);
  if (Platform.OS !== 'web') return null;
  return React.createElement('audio', { ref, autoPlay: true, muted: !!muted, style: { display: 'none' } });
}

export default function BattleVideo({ track, renderVideo, mirror, zOrder = 0, keyHint }) {
  if (typeof renderVideo === 'function') return renderVideo();
  if (!track) return null;
  if (Platform.OS === 'web') return <WebTrackVideo track={track} mirror={!!mirror} />;
  const VV = getLiveKitVideoView();
  if (!VV) return null;
  return (
    <VV
      key={`${keyHint || 'pk'}:${track.sid || 'local'}`}
      videoTrack={track}
      style={StyleSheet.absoluteFill}
      objectFit="cover"
      mirror={!!mirror}
      zOrder={zOrder}
    />
  );
}
