// [2026-10-08 qa-calls] VideoView para WEB. @livekit/react-native (VideoView)
// só existe no nativo — no web LK_VideoView ficava null e a ligação de vídeo
// 1:1 no navegador não renderizava NENHUM <video> (remoto nem self-view).
// Mesma API usada em app/call.js: videoTrack / style / objectFit / mirror.
import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';

export default function WebLkVideoView({ videoTrack, style, objectFit = 'cover', mirror = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !videoTrack || typeof videoTrack.attach !== 'function') return undefined;
    try { videoTrack.attach(el); } catch {}
    try { const p = el.play && el.play(); if (p && p.catch) p.catch(() => {}); } catch {}
    return () => { try { videoTrack.detach(el); } catch {} };
  }, [videoTrack]);
  return (
    <View style={[{ overflow: 'hidden', backgroundColor: '#000' }, style]} pointerEvents="none">
      {React.createElement('video', {
        ref,
        autoPlay: true,
        playsInline: true,
        muted: true,
        style: {
          width: '100%',
          height: '100%',
          display: 'block',
          objectFit: objectFit === 'contain' ? 'contain' : 'cover',
          transform: mirror ? 'scaleX(-1)' : 'none',
        },
      })}
    </View>
  );
}
