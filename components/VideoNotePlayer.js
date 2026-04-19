import React from 'react';
import { View, Text } from 'react-native';
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
  const mod = loadExpoVideo();
  if (!mod || !mod.useVideoPlayer || !mod.VideoView) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#111' }}>
        <IconVideo size={28} color="#fff" />
        <Text style={{ color: '#fff', fontSize: 11, marginTop: 4 }}>Video note</Text>
      </View>
    );
  }
  const { useVideoPlayer, VideoView } = mod;
  const player = useVideoPlayer(uri, (p) => {
    try { p.muted = true; p.loop = true; p.play(); } catch {}
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
