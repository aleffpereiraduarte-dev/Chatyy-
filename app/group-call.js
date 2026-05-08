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
  const params = useLocalSearchParams();
  // Params podem vir como string[] em deep links — extrai sempre o primeiro.
  const conversation_id = Array.isArray(params.conversation_id) ? params.conversation_id[0] : params.conversation_id;
  const video = Array.isArray(params.video) ? params.video[0] : params.video;
  const room = Array.isArray(params.room) ? params.room[0] : params.room;
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
          setRoomName(r.data.room ?? room ?? '');
        } else {
          // LiveKit unreachable. Fall back to the WebRTC mesh in /call so the
          // call still goes through (capped at ~5 peers but works). Without
          // this, the user got a "Voltar" screen with no way to actually
          // make the call. Mirrors the standard fallback pattern.
          console.warn('[GroupCall] LiveKit token failed, falling back to mesh:', r?.message);
          router.replace(`/call?callId=${encodeURIComponent(room || '')}&conversationId=${encodeURIComponent(String(conversation_id || ''))}&isVideo=${video === '1' ? '1' : '0'}&groupCall=1&isCaller=1`);
        }
      } catch (e) {
        console.warn('[GroupCall] LiveKit error, falling back to mesh:', e?.message);
        router.replace(`/call?callId=${encodeURIComponent(room || '')}&conversationId=${encodeURIComponent(String(conversation_id || ''))}&isVideo=${video === '1' ? '1' : '0'}&groupCall=1&isCaller=1`);
      }
    })();
  }, [conversation_id, room]);

  // origin extrai só o host:port — antes mantinha o path do BASE_URL e
  // gerava URLs tipo `/api/livekit-room.html` que não existem.
  const origin = (() => { try { return new URL(BASE_URL).origin; } catch { return BASE_URL; } })();
  // Pass features=raisehand to the LiveKit room HTML so the hosted UI knows
  // to render the raise-hand button (LiveKit metadata-based; gracefully
  // ignored by older /livekit-room.html builds that don't read the param).
  // Mirrors the WebRTC mesh raise-hand surfaced in /call so users get the
  // same primitive whether they fall back to mesh or use the SFU path.
  const pageUrl = token
    ? `${origin}/livekit-room.html?token=${encodeURIComponent(token)}&url=${encodeURIComponent(livekitUrl || 'wss://chatyy.com.br:7880')}&room=${encodeURIComponent(roomName)}&video=${video === '1' ? '1' : '0'}&features=raisehand,noise`
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
            // 'raise_hand' / 'lower_hand' from the LiveKit room HTML are
            // forwarded through the WS so peers on the mesh side (older
            // builds, audio-only etc.) see the same indicator. Defensive:
            // we don't depend on these; the mesh build broadcasts its own
            // call_hand_raise events directly.
            if (msg.type === 'raise_hand' || msg.type === 'lower_hand') {
              try {
                const ws = require('../services/websocket').default;
                if (ws?.isConnected) ws._send({
                  type: 'call_hand_raise',
                  call_id: msg.call_id || roomName,
                  conversation_id: conversation_id,
                  raised: msg.type === 'raise_hand',
                  name: msg.name,
                });
              } catch {}
            }
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
