// Group call via LiveKit (SFU).
// Scales to 50+ participants, media server does the mixing instead of
// every client talking to every other (mesh P2P limit ~5).
//
// Token obtained from chat_livekit_token endpoint.
// Full UI rendered by /livekit-room.html (WebView).
// On leave, WebView posts 'leave' message → we router.back().
//
// On top of the WebView we paint two native polishes (FaceTime parity):
//   1. Connecting skeleton — 2x2 / 3x3 / scrollable grid of avatar
//      placeholders so the user sees structure immediately, and the
//      currently-speaking tile gets a yellow 2px ring (matches WhatsApp/
//      FaceTime active-speaker affordance).
//   2. Floating "Add member" pill at the bottom — primary purple
//      (#7C3AED), always reachable, opens the existing add-participant
//      flow used by call.js. The WebView swallows clicks so the pill
//      sits in a sibling layer with absolute positioning.
import { useState, useEffect, useMemo } from 'react';
import { View, ActivityIndicator, Text, Platform, StyleSheet, TouchableOpacity, ScrollView, Animated, Easing } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import Svg, { Path as SvgPath } from 'react-native-svg';
import * as api from '../services/api';
import { BASE_URL } from '../services/api';
import AvatarCircle from '../components/AvatarCircle';

let WebView = null;
if (Platform.OS !== 'web') {
  try { WebView = require('react-native-webview').WebView; } catch {}
}

// Brand purple — keep in sync with theme/Colors.brand.
const BRAND_PURPLE = '#7C3AED';
// Active-speaker ring — bright amber so it pops on dark group call bg.
const SPEAKER_RING = '#fbbf24';

// Pick grid columns based on participant count. Matches FaceTime / Meet:
// up to 4 → 2x2, 5–9 → 3x3, 10+ → scrollable 3-wide.
function pickGridCols(count) {
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 3; // scrollable beyond 9
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
  const [participants, setParticipants] = useState([]); // [{ email, name, isSpeaking? }]
  const [activeSpeakerEmail, setActiveSpeakerEmail] = useState(null);
  const [showAddMember, setShowAddMember] = useState(false);

  // Add-member pill press anim — soft scale-down on press for tactility.
  const pillScale = useState(new Animated.Value(1))[0];

  useEffect(() => {
    (async () => {
      try {
        const r = await api.chatLivekitToken(Number(conversation_id) || 0, room || '');
        if (r?.success && r.data?.token) {
          setToken(r.data.token);
          setLivekitUrl(r.data.url || 'wss://chatyy.com.br:7880');
          setRoomName(r.data.room ?? room ?? '');
          // Best-effort prime of the participant skeleton from the same
          // payload — backend sometimes returns `members` or `participants`.
          // This is purely cosmetic; the live source-of-truth is LiveKit
          // inside the WebView.
          const seed = r.data.members || r.data.participants || [];
          if (Array.isArray(seed) && seed.length) {
            setParticipants(seed.map(m => ({
              email: m.email || m.identity || '',
              name: m.display_name || m.name || (m.email || '').split('@')[0],
            })).filter(p => p.email));
          }
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

  // Native grid skeleton — only shown while we don't have the live LiveKit
  // WebView feed. Builds a fixed-cell grid so cells don't reflow when the
  // count changes.
  const ParticipantGrid = useMemo(() => {
    if (!participants.length) return null;
    const cols = pickGridCols(participants.length);
    const cellSize = cols === 2 ? 140 : cols === 3 ? 100 : 100;
    const wrap = participants.length > 9; // scrollable
    const Container = wrap ? ScrollView : View;
    return (
      <Container
        contentContainerStyle={[styles.gridWrap, { paddingHorizontal: 16 }]}
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
      >
        {participants.map((p) => {
          const isSpeaking = activeSpeakerEmail && p.email === activeSpeakerEmail;
          return (
            <View
              key={p.email}
              style={[styles.gridCell, { width: cellSize + 16, height: cellSize + 40 }]}
            >
              <View style={[
                styles.avatarShell,
                { width: cellSize, height: cellSize, borderRadius: cellSize / 2 },
                isSpeaking && styles.avatarShellSpeaking,
              ]}>
                <AvatarCircle email={p.email} name={p.name} size={cellSize - 8} />
              </View>
              <Text style={styles.gridName} numberOfLines={1}>{p.name}</Text>
            </View>
          );
        })}
      </Container>
    );
  }, [participants, activeSpeakerEmail]);

  const AddMemberPill = (
    <Animated.View
      style={[
        styles.pillWrap,
        { transform: [{ scale: pillScale }] },
      ]}
      pointerEvents="box-none"
    >
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Adicionar pessoa"
        activeOpacity={0.85}
        onPressIn={() => Animated.timing(pillScale, { toValue: 0.94, duration: 90, easing: Easing.out(Easing.quad), useNativeDriver: true }).start()}
        onPressOut={() => Animated.spring(pillScale, { toValue: 1, friction: 5, tension: 180, useNativeDriver: true }).start()}
        onPress={() => {
          // Bounce back to the parent chat-conversation/call entry that
          // already owns the add-participant flow. Group call is a
          // WebView, so we bounce out via an event the WebView host can
          // surface, OR — fallback — open the same chat conversation
          // with the add-member intent flag so it surfaces the picker.
          setShowAddMember(true);
          try {
            router.push({ pathname: '/chat-conversation', params: { conversation_id: String(conversation_id || ''), addMember: '1' } });
          } catch {}
        }}
        style={styles.pill}
      >
        <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
          <SvgPath d="M19 8v6M16 11h6M9 11a4 4 0 100-8 4 4 0 000 8zM3 21a6 6 0 0112 0" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
        <Text style={styles.pillText}>Adicionar pessoa</Text>
      </TouchableOpacity>
    </Animated.View>
  );

  if (err) {
    return (
      <View style={[styles.center, { backgroundColor: '#000' }]}>
        <Text style={{ color: '#fff', fontSize: 16, marginBottom: 16 }}>{err}</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={{ color: '#fff' }}>Voltar</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (!token) {
    // Connecting state — render the participant skeleton grid + brand
    // spinner pinned bottom-center. Gives structure during the LiveKit
    // handshake instead of an empty black screen.
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {ParticipantGrid}
        <View style={styles.connectingHud}>
          <ActivityIndicator color={BRAND_PURPLE} />
          <Text style={{ color: '#999', marginTop: 10, fontSize: 13, fontWeight: '500' }}>Conectando ao grupo...</Text>
        </View>
      </View>
    );
  }

  if (Platform.OS === 'web') {
    // Full-screen iframe — LiveKit JS runs directly. Add-member pill
    // overlays the iframe corner so it's always reachable.
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <iframe
          src={pageUrl}
          allow="camera; microphone; fullscreen; autoplay; display-capture"
          style={{ border: 0, width: '100%', height: '100%' }}
        />
        {AddMemberPill}
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
            // Active-speaker mirror — LiveKit room HTML can post the
            // currently-speaking participant; we use it for the yellow
            // ring (and would for any native overlays). Optional.
            if (msg.type === 'active_speaker' && typeof msg.email === 'string') {
              setActiveSpeakerEmail(msg.email.toLowerCase());
            }
            if (msg.type === 'participants' && Array.isArray(msg.list)) {
              setParticipants(msg.list.map(m => ({
                email: (m.email || m.identity || '').toLowerCase(),
                name: m.name || (m.email || '').split('@')[0],
              })).filter(p => p.email));
            }
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
      {AddMemberPill}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  backBtn: { paddingHorizontal: 20, paddingVertical: 10, backgroundColor: '#333', borderRadius: 8 },

  // Skeleton grid — used while we haven't loaded LiveKit yet.
  gridWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 80,
    paddingBottom: 140,
    gap: 8,
  },
  gridCell: {
    alignItems: 'center',
    justifyContent: 'flex-start',
    margin: 6,
  },
  avatarShell: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  // Active-speaker ring — bright yellow 2px (matches WhatsApp / FaceTime
  // affordance). Only active on the participant LiveKit reports as
  // currently speaking.
  avatarShellSpeaking: {
    borderColor: SPEAKER_RING,
    shadowColor: SPEAKER_RING,
    shadowOpacity: 0.45,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  gridName: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 8,
    maxWidth: 140,
    textAlign: 'center',
  },
  connectingHud: {
    position: 'absolute',
    bottom: 60,
    left: 0,
    right: 0,
    alignItems: 'center',
  },

  // Add-member pill — primary brand purple, anchored to bottom center
  // above the system inset. Floats over the WebView with a soft halo
  // shadow so it reads as an action button on top of any video bg.
  pillWrap: {
    position: 'absolute',
    bottom: 28,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 50,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: BRAND_PURPLE,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 28,
    shadowColor: BRAND_PURPLE,
    shadowOpacity: 0.55,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  pillText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
});
