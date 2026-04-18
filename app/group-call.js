// Group call via LiveKit (SFU).
// Scales to 50+ participants, media server does the mixing instead of
// every client talking to every other (mesh P2P limit ~5).
//
// Token obtained from chat_livekit_token endpoint.
// Full UI rendered by /livekit-room.html (WebView).
// On leave, WebView posts 'leave' message → we router.back().
import { useState, useEffect } from 'react';
import { View, ActivityIndicator, Text, Platform, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as api from '../services/api';
import { BASE_URL } from '../services/api';

let WebView = null;
if (Platform.OS !== 'web') {
  try { WebView = require('react-native-webview').WebView; } catch {}
}

export default function GroupCallScreen() {
  const router = useRouter();
  const { conversation_id, video, room } = useLocalSearchParams();
  const [token, setToken] = useState(null);
  const [livekitUrl, setLivekitUrl] = useState(null);
  const [roomName, setRoomName] = useState(room || '');
  const [err, setErr] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.chatLivekitToken(Number(conversation_id) || 0, room || '');
        if (r?.success && r.data?.token) {
          setToken(r.data.token);
          setLivekitUrl(r.data.url || 'wss://chatyy.com.br:7880');
          setRoomName(r.data.room || roomName);
        } else {
          setErr(r?.message || 'Falha ao obter token');
        }
      } catch (e) {
        setErr(String(e?.message || e));
      }
    })();
  }, [conversation_id, room]);

  const origin = BASE_URL.replace(/^https?:/, 'https:');
  const pageUrl = token
    ? `${origin}/livekit-room.html?token=${encodeURIComponent(token)}&url=${encodeURIComponent(livekitUrl || 'wss://chatyy.com.br:7880')}&room=${encodeURIComponent(roomName)}&video=${video === '1' ? '1' : '0'}`
    : null;

  if (err) {
    return (
      <View style={[styles.center, { backgroundColor: '#000' }]}>
        <Text style={{ color: '#fff', fontSize: 16, marginBottom: 16 }}>⚠️ {err}</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={{ color: '#fff' }}>Voltar</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (!token) {
    return (
      <View style={[styles.center, { backgroundColor: '#000' }]}>
        <ActivityIndicator color="#fff" />
        <Text style={{ color: '#999', marginTop: 12, fontSize: 13 }}>Conectando...</Text>
      </View>
    );
  }

  if (Platform.OS === 'web') {
    // Full-screen iframe — LiveKit JS runs directly
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <iframe
          src={pageUrl}
          allow="camera; microphone; fullscreen; autoplay; display-capture"
          style={{ border: 0, width: '100%', height: '100%' }}
        />
      </View>
    );
  }

  if (!WebView) {
    return (
      <View style={[styles.center, { backgroundColor: '#000' }]}>
        <Text style={{ color: '#fff' }}>WebView não disponível nesta plataforma</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <WebView
        source={{ uri: pageUrl }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        startInLoadingState
        mixedContentMode="always"
        onMessage={(evt) => {
          try {
            const msg = JSON.parse(evt.nativeEvent.data);
            if (msg.type === 'leave') router.back();
          } catch {}
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  backBtn: { paddingHorizontal: 20, paddingVertical: 10, backgroundColor: '#333', borderRadius: 8 },
});
