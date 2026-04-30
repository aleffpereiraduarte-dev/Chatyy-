import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, ImageBackground } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { IconEye, IconLock, IconVideo, IconCheck } from './Icons';

let _expoVideoMod = null;
function loadExpoVideo() {
  if (_expoVideoMod !== null) return _expoVideoMod;
  try { _expoVideoMod = require('expo-video'); }
  catch { _expoVideoMod = false; }
  return _expoVideoMod;
}

function ViewOnceVideoPlayer({ uri, onFinished }) {
  const mod = loadExpoVideo();
  if (!mod || !mod.useVideoPlayer || !mod.VideoView) return null;
  const { useVideoPlayer, VideoView } = mod;
  const finishedRef = useRef(false);
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    try { const r = p.play?.(); if (r?.catch) r.catch(() => {}); } catch {}
  });
  useEffect(() => {
    if (!player) return;
    // Em expo-video o evento é 'ended' (não 'playToEnd' como em expo-av).
    const sub2 = player.addListener?.('ended', () => {
      if (!finishedRef.current) { finishedRef.current = true; onFinished?.(); }
    });
    return () => { try { sub2?.remove?.(); } catch {} };
  }, [player, onFinished]);
  return (
    <VideoView
      player={player}
      style={{ width: '100%', height: '100%' }}
      contentFit="contain"
      nativeControls={false}
      allowsFullscreen={false}
    />
  );
}

const VIEWED_KEY = 'chatyy.viewOnceViewed.v1';

async function _loadLocalViewed() {
  try {
    const raw = await AsyncStorage.getItem(VIEWED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch { return new Set(); }
}
async function _markLocalViewed(id) {
  try {
    const raw = await AsyncStorage.getItem(VIEWED_KEY);
    const arr = raw ? (JSON.parse(raw) || []) : [];
    const set = new Set(arr.map(String));
    set.add(String(id));
    const next = Array.from(set).slice(-2000);
    await AsyncStorage.setItem(VIEWED_KEY, JSON.stringify(next));
  } catch {}
}

const _parseViewedBy = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
};

/**
 * View Once Message — strict WhatsApp semantics:
 *  - Sender: NEVER opens. Always sees a locked pill ("Foto única · Visualização única",
 *    or "Visualizada" if a recipient already opened). No tap target.
 *  - Receiver: Tap once → 10s countdown → expired pill. After tapping, the message
 *    is locally + server marked as viewed and CANNOT be re-opened.
 */
export default function ViewOnceMessage({ msg, colors = {}, isOwn, onView, t, currentEmail }) {
  const safeColors = {
    surface: '#fff',
    border: '#e0e0e0',
    primary: '#7C3AED',
    textTertiary: '#999',
    textSecondary: '#666',
    text: '#000',
    ...colors,
  };

  const fileUrl = msg?.file_url || null;
  const isVideo = (msg?.type === 'video') || /\.(mp4|mov|webm|mkv|avi|m4v|3gp)(\?|$)/i.test(String(fileUrl || ''));

  // Server-side flags
  const vb = _parseViewedBy(msg?.viewed_by);
  const meLower = String(currentEmail || '').toLowerCase();
  const vbHasMe = !!meLower && vb.map(e => String(e || '').toLowerCase()).includes(meLower);
  const vbHasAny = vb.length > 0;

  // Local AsyncStorage flag — protects against WS sync gap if user kills app
  // mid-countdown. Even before backend/WS confirms, the receiver is locked.
  const [localViewed, setLocalViewed] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const set = await _loadLocalViewed();
      if (alive && msg?.id != null && set.has(String(msg.id))) setLocalViewed(true);
    })();
    return () => { alive = false; };
  }, [msg?.id]);

  // ───────────── SENDER BRANCH ─────────────
  // WhatsApp: o remetente NUNCA pode reabrir uma view-once que enviou.
  // Sempre mostramos o pill bloqueado, sem TouchableOpacity. Texto muda
  // só pra indicar se o destinatário já visualizou ou ainda não.
  if (isOwn) {
    const accent = 'rgba(255,255,255,0.92)';
    const subtle = 'rgba(255,255,255,0.65)';
    const sub = vbHasAny
      ? (t?.('chatConv.viewOnceOpened') || 'Visualizada')
      : (t?.('chatConv.viewOnceSent') || 'Visualização única');
    return (
      <View style={s.expiredRow}>
        <View style={[s.expiredIconCircle, { backgroundColor: 'rgba(255,255,255,0.15)' }]}>
          {isVideo ? <IconVideo size={16} color={accent} /> : <IconEye size={16} color={accent} />}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[s.expiredTitle, { color: accent }]} numberOfLines={1}>
            {isVideo
              ? (t?.('chatConv.viewOnceVideo') || 'Vídeo único')
              : (t?.('chatConv.viewOncePhoto') || 'Foto única')}
          </Text>
          <Text style={[s.expiredSub, { color: subtle }]} numberOfLines={1}>{sub}</Text>
        </View>
        <IconLock size={13} color={subtle} />
      </View>
    );
  }

  // ───────────── RECEIVER BRANCH ─────────────
  // Locked se: viewed_by já tem meu email OU já marquei localmente OU
  // backend marcou expired_at. Uma vez locked, NUNCA reabre.
  const _initialExpired = !!msg?.expired_at || vbHasMe || localViewed;
  const _initialViewed = !!msg?.viewed_at || _initialExpired;

  const [viewed, setViewed] = useState(_initialViewed);
  const [timeLeft, setTimeLeft] = useState(10);
  const [expired, setExpired] = useState(_initialExpired);

  useEffect(() => {
    const exp = !!msg?.expired_at || vbHasMe || localViewed;
    setExpired(exp);
    setViewed(!!msg?.viewed_at || exp);
    if (!exp) setTimeLeft(10);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msg?.id, msg?.viewed_by, localViewed]);

  const blurOpacity = useRef(new Animated.Value(_initialViewed ? 0 : 1)).current;
  const countdownRotate = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!viewed || expired) return;
    const interval = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) { setExpired(true); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [viewed, expired]);

  useEffect(() => {
    Animated.timing(blurOpacity, {
      toValue: viewed ? 0 : 1,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [viewed, blurOpacity]);

  useEffect(() => {
    if (!viewed || expired) return;
    Animated.timing(countdownRotate, {
      toValue: 1 - timeLeft / 10,
      duration: 100,
      useNativeDriver: false,
    }).start();
  }, [timeLeft, viewed, expired, countdownRotate]);

  const handleView = async () => {
    if (viewed || expired) return;
    setViewed(true);
    // Persist localmente IMEDIATAMENTE — mesmo se o usuário matar o app
    // dentro dos 10s, no próximo open o pill já vai mostrar "Expirou".
    if (msg?.id != null) { _markLocalViewed(msg.id).catch(() => {}); }
    setLocalViewed(true);
    onView?.(msg?.id);
  };

  // Estado expirado — pill bloqueado permanente
  if (expired) {
    const accent = safeColors.primary;
    const subtle = safeColors.textSecondary;
    return (
      <View style={s.expiredRow}>
        <View style={[s.expiredIconCircle, { backgroundColor: 'rgba(124,58,237,0.12)' }]}>
          <IconCheck size={16} color={accent} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[s.expiredTitle, { color: accent }]} numberOfLines={1}>
            {isVideo
              ? (t?.('chatConv.viewOnceVideo') || 'Vídeo único')
              : (t?.('chatConv.viewOncePhoto') || 'Foto única')}
          </Text>
          <Text style={[s.expiredSub, { color: subtle }]} numberOfLines={1}>
            {t?.('chatConv.expired') || 'Expirou'}
          </Text>
        </View>
        <IconLock size={13} color={subtle} />
      </View>
    );
  }

  // Não visualizada — tap-to-view pill (apenas receiver chega aqui)
  if (!viewed) {
    const accent = safeColors.primary;
    const subtle = safeColors.textSecondary;
    return (
      <TouchableOpacity onPress={handleView} activeOpacity={0.7} style={s.tapRow}>
        <View style={[s.tapIconCircle, { backgroundColor: 'rgba(124,58,237,0.14)' }]}>
          {isVideo ? <IconVideo size={18} color={accent} /> : <IconEye size={18} color={accent} />}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[s.tapTitle, { color: accent }]} numberOfLines={1}>
            {isVideo
              ? (t?.('chatConv.viewOnceVideo') || 'Vídeo único')
              : (t?.('chatConv.viewOncePhoto') || 'Foto única')}
          </Text>
          <Text style={[s.tapSub, { color: subtle }]} numberOfLines={1}>
            {t?.('chatConv.tapToView') || 'Toque para ver'}
          </Text>
        </View>
      </TouchableOpacity>
    );
  }

  // Visualizada — countdown ativo
  if (isVideo && fileUrl) {
    return (
      <View style={[s.container, { backgroundColor: '#000' }]}>
        <ViewOnceVideoPlayer uri={fileUrl} onFinished={() => setExpired(true)} />
        <View style={s.countdownContainer}>
          <View style={[s.countdownRing, { borderColor: '#fff' }]}>
            <View style={[s.countdownInner, { backgroundColor: 'rgba(0,0,0,0.75)' }]}>
              <Text style={[s.countdownText, { color: '#fff' }]}>{timeLeft}</Text>
            </View>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={s.container}>
      {fileUrl ? (
        <ImageBackground source={{ uri: fileUrl }} style={s.imageContainer}>
          <View style={s.countdownContainer}>
            <Animated.View
              style={[
                s.countdownRing,
                {
                  transform: [{
                    rotate: countdownRotate.interpolate({
                      inputRange: [0, 1],
                      outputRange: ['0deg', '360deg'],
                    }),
                  }],
                },
              ]}
            >
              <View style={[s.countdownInner, { backgroundColor: safeColors.surface }]}>
                <Text style={[s.countdownText, { color: safeColors.text }]}>{timeLeft}</Text>
              </View>
            </Animated.View>
          </View>
        </ImageBackground>
      ) : (
        <View style={[s.imageContainer, { backgroundColor: '#222', justifyContent: 'center', alignItems: 'center' }]}>
          <Text style={[s.countdownText, { color: '#fff', fontSize: 32 }]}>{timeLeft}</Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { width: '100%', height: 300, marginVertical: 6, borderRadius: 12, overflow: 'hidden' },
  imageContainer: { width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center' },
  expiredRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, paddingRight: 4, minWidth: 180 },
  expiredIconCircle: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  expiredTitle: { fontSize: 14, fontWeight: '600' },
  expiredSub: { fontSize: 12, marginTop: 1, fontStyle: 'italic' },
  tapRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingRight: 4, minWidth: 200 },
  tapIconCircle: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  tapTitle: { fontSize: 14, fontWeight: '600' },
  tapSub: { fontSize: 12, marginTop: 1 },
  countdownContainer: { position: 'absolute', top: 16, right: 16, width: 50, height: 50, justifyContent: 'center', alignItems: 'center' },
  countdownRing: { width: 50, height: 50, borderRadius: 25, borderWidth: 3, borderColor: '#fff', justifyContent: 'center', alignItems: 'center' },
  countdownInner: { width: 44, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center' },
  countdownText: { fontSize: 16, fontWeight: '700', textAlign: 'center' },
});
