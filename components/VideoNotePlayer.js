import React from 'react';
import { View, Text, Platform } from 'react-native';
import { IconVideo } from './Icons';

let _expoVideo = null;
function loadExpoVideo() {
  if (_expoVideo !== null) return _expoVideo;
  try { _expoVideo = require('expo-video'); }
  catch { _expoVideo = false; }
  return _expoVideo;
}

// Plays a round video-note (Telegram/iMessage style). Autoplays muted on
// mount; expanded playback (with audio) lives in the full-screen media
// viewer. Hooks are called here (never behind a conditional in the parent)
// to stay Rules-of-Hooks safe.
export default function VideoNotePlayer({ uri }) {
  if (!uri) return null;
  const mod = loadExpoVideo();
  if (!mod || !mod.useVideoPlayer || !mod.VideoView) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#111' }}>
        <IconVideo size={28} color="#fff" />
        <Text style={{ color: '#fff', fontSize: 11, marginTop: 4 }}>Video note</Text>
      </View>
    );
  }
  // OFFLINE-FIRST: prefer the cached file:// URI when mediaCache has it on
  // disk. Round-bubble video notes are short (5-30s, <2MB) so prefetch lands
  // them with the rest of the chat media — by the time the user taps to
  // play, the local file already exists and playback survives offline.
  let resolvedUri = uri;
  if (Platform.OS !== 'web' && typeof uri === 'string' && !uri.startsWith('file://')) {
    try {
      const { getLocalUriIfCached } = require('../services/mediaCache');
      const local = getLocalUriIfCached(uri.startsWith('http') ? uri : `https://chatyy.com.br${uri}`);
      if (local) resolvedUri = local;
    } catch {}
  }
  const { useVideoPlayer, VideoView } = mod;
  const player = useVideoPlayer(resolvedUri, (p) => {
    // expo-video usa `muted`/`loop` como properties (não isMuted como em
    // expo-av). p?.play() pode rejeitar em iOS — engole.
    try { p.muted = true; p.loop = true; const r = p.play?.(); if (r?.catch) r.catch(() => {}); } catch {}
  });
  return (
    <VideoView
      player={player}
      style={{ width: '100%', height: '100%' }}
      contentFit="cover"
      nativeControls={false}
      allowsFullscreen={false}
    />
  );
}
