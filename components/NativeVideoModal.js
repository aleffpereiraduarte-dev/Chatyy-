// [2026-10-07 app-feel-webview] Minimal full-screen native video player
// (expo-video, already in the binary) for places that used to hand a video
// URL to the in-app browser (Safari sheet playing an .mp4 = web page feel).
import { Modal, View, TouchableOpacity, StyleSheet, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconX } from './Icons';

let _ev = null;
function loadExpoVideo() {
  if (_ev !== null) return _ev;
  try { _ev = require('expo-video'); } catch { _ev = false; }
  return _ev;
}

export function nativeVideoAvailable() {
  const ev = loadExpoVideo();
  return !!(ev && ev.useVideoPlayer && ev.VideoView);
}

function Player({ url }) {
  const ev = loadExpoVideo();
  const player = ev.useVideoPlayer(url, (p) => {
    try { p.loop = false; p.muted = false; const r = p.play?.(); if (r?.catch) r.catch(() => {}); } catch {}
  });
  const VideoView = ev.VideoView;
  return <VideoView player={player} style={{ flex: 1 }} contentFit="contain" nativeControls allowsFullscreen allowsPictureInPicture />;
}

export default function NativeVideoModal({ url, onClose }) {
  const insets = useSafeAreaInsets();
  if (!url || !nativeVideoAvailable()) return null;
  return (
    <Modal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <StatusBar barStyle="light-content" />
      <View style={st.root}>
        <Player url={url} />
        <TouchableOpacity
          onPress={onClose}
          style={[st.close, { top: insets.top + 8 }]}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Fechar"
        >
          <IconX size={22} color="#fff" />
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  close: { position: 'absolute', left: 12, width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
});
