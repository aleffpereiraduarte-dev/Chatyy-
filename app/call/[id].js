// Shareable call-link lobby: https://chatyy.com.br/call/<link_id>
//
// A "Criar link de chamada" (ChatCallsTab) produces a standalone link anyone
// can tap to join a voice/video call. Tapping it (web or, once native
// deep-links are configured, mobile) lands here. We:
//   1. read `link_id` from the route,
//   2. call chat_call_link_info → render a pre-join lobby (creator name/avatar,
//      "Entrar na chamada", or an "expired / revoked" state),
//   3. on tap call chat_call_link_join → get { url, token, room, is_video },
//   4. stash that pre-minted LiveKit token in the SAME global the call screen's
//      IncomingCallListener fast-path already consumes
//      (globalThis.__chatyy_prefetched_lk_token) and hand off to /call — reusing
//      the EXISTING LiveKit join code (call.js fetchLivekitToken fast-path +
//      connectToRoom). We do NOT reinvent the LiveKit client here.
//
// Works on web (livekit-client pure-JS in call.js) and on mobile when opened
// in-app. Note: external-browser universal-link deep-linking of
// chatyy.com.br/call/* is a NATIVE config item (associatedDomains / autoVerify
// intent filter) that is NOT set in app.json — see the report.
import { useEffect, useState, useCallback } from 'react';
import { View, Text, ActivityIndicator, TouchableOpacity, SafeAreaView, Platform } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import AvatarCircle from '../../components/AvatarCircle';
import { IconPhone, IconVideo } from '../../components/Icons';
import * as api from '../../services/api';

export default function CallLinkLobbyScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const linkId = Array.isArray(params.id) ? params.id[0] : params.id;
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { user, loading: authLoading } = useAuth();

  // loading | ready | revoked | expired | auth | error | joining
  const [status, setStatus] = useState('loading');
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState('');

  // ── Fetch link info for the lobby ──
  useEffect(() => {
    if (authLoading) return;
    if (!user) { setStatus('auth'); return; }
    if (!linkId || typeof linkId !== 'string') {
      setErr(t?.('calls.callLinkBad') || 'Link inválido');
      setStatus('error');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await api.chatCallLinkInfo(linkId);
        if (cancelled) return;
        const data = r?.data || r;
        if (!r || r.success === false || !data) {
          setErr(r?.message || t?.('calls.callLinkFailed') || 'Não foi possível abrir o link.');
          setStatus('error');
          return;
        }
        setInfo(data);
        if (data.revoked) { setStatus('revoked'); return; }
        if (data.expired) { setStatus('expired'); return; }
        setStatus('ready');
      } catch (e) {
        if (cancelled) return;
        setErr(String(e?.message || e));
        setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, [authLoading, user, linkId, t]);

  // ── Join → mint token → hand off to the existing call screen ──
  const handleJoin = useCallback(async () => {
    if (!linkId) return;
    setStatus('joining');
    try {
      const r = await api.chatCallLinkJoin(linkId);
      const data = r?.data || r;
      const token = data?.token;
      const room = data?.room;
      const url = data?.url || 'wss://livekit.chatyy.com.br';
      const isVideo = data?.is_video ?? info?.is_video ?? false;
      if (!r || r.success === false || !token || !room) {
        // Link may have just been revoked/expired between info and join.
        const msg = String(r?.message || '');
        if (/revok/i.test(msg)) { setStatus('revoked'); return; }
        if (/expir/i.test(msg)) { setStatus('expired'); return; }
        setErr(msg || t?.('calls.callLinkFailed') || 'Não foi possível entrar na chamada.');
        setStatus('error');
        return;
      }
      // Prime the call screen's pre-fetched-token fast-path (call.js:1207).
      // It consumes a fresh (<30s) cache whose call_id matches the callId param
      // and connects with this exact token — no extra network round-trip and no
      // conversation_id needed.
      try {
        globalThis.__chatyy_prefetched_lk_token = {
          call_id: String(room),
          token,
          url,
          room: String(room),
          iceServers: Array.isArray(data?.iceServers) ? data.iceServers : [],
          ts: Date.now(),
        };
      } catch {}
      // Reuse the validated "enter a LiveKit room" path (same params
      // group-call.js uses to join): groupCall=1 + isCaller=1.
      router.replace(
        `/call?callId=${encodeURIComponent(String(room))}`
        + `&isVideo=${isVideo ? '1' : '0'}`
        + `&groupCall=1&isCaller=1`
        + `&contactName=${encodeURIComponent(info?.creator_name || (t?.('calls.callLink') || 'Chamada'))}`
      );
    } catch (e) {
      setErr(String(e?.message || e));
      setStatus('error');
    }
  }, [linkId, info, router, t]);

  const bg = colors?.background || '#000';
  const text = colors?.text || '#fff';
  const sub = colors?.textSecondary || '#8e8e93';
  const isVideo = !!info?.is_video;

  const Center = ({ children }) => (
    <SafeAreaView style={{ flex: 1, backgroundColor: bg }}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        {children}
      </View>
    </SafeAreaView>
  );

  if (status === 'loading' || status === 'joining') {
    return (
      <Center>
        <ActivityIndicator size="large" color={colors?.primary || '#7C3AED'} />
        <Text style={{ color: sub, marginTop: 16, fontSize: 14 }}>
          {status === 'joining'
            ? (t?.('calls.callLinkJoining') || 'Entrando na chamada…')
            : (t?.('calls.callLinkLoading') || 'Abrindo link…')}
        </Text>
      </Center>
    );
  }

  if (status === 'auth') {
    return (
      <Center>
        <Text style={{ color: text, fontSize: 16, marginBottom: 16, textAlign: 'center' }}>
          {t?.('calls.callLinkLoginFirst') || 'Faça login pra entrar na chamada'}
        </Text>
        <TouchableOpacity
          onPress={() => router.replace({ pathname: '/login', params: { redirect: `/call/${linkId}` } })}
          style={{ paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, backgroundColor: '#7C3AED' }}
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>{t?.('common.login') || 'Entrar'}</Text>
        </TouchableOpacity>
      </Center>
    );
  }

  if (status === 'revoked' || status === 'expired' || status === 'error') {
    const title = status === 'revoked'
      ? (t?.('calls.callLinkRevoked') || 'Link revogado')
      : status === 'expired'
        ? (t?.('calls.callLinkExpired') || 'Link expirado')
        : (t?.('calls.callLinkFailed') || 'Não foi possível abrir o link');
    return (
      <Center>
        <View style={{
          width: 72, height: 72, borderRadius: 36, marginBottom: 20,
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'rgba(255,69,58,0.15)',
        }}>
          <IconPhone size={30} color="#ff453a" />
        </View>
        <Text style={{ color: text, fontSize: 18, fontWeight: '700', marginBottom: 8, textAlign: 'center' }}>
          {title}
        </Text>
        {status === 'error' && !!err && (
          <Text style={{ color: sub, fontSize: 13, marginBottom: 16, textAlign: 'center' }}>{err}</Text>
        )}
        <TouchableOpacity
          onPress={() => router.replace('/chat')}
          style={{ marginTop: 12, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, backgroundColor: colors?.card || '#1c1c1e' }}
        >
          <Text style={{ color: text, fontWeight: '600' }}>{t?.('common.close') || 'Fechar'}</Text>
        </TouchableOpacity>
      </Center>
    );
  }

  // status === 'ready' — pre-join lobby
  return (
    <Center>
      <AvatarCircle
        name={info?.creator_name || ''}
        uri={info?.creator_avatar || undefined}
        size={96}
        style={{ marginBottom: 20 }}
      />
      <Text style={{ color: text, fontSize: 20, fontWeight: '700', textAlign: 'center' }}>
        {info?.creator_name || (t?.('calls.callLink') || 'Chamada')}
      </Text>
      <Text style={{ color: sub, fontSize: 14, marginTop: 6, textAlign: 'center' }}>
        {isVideo
          ? (t?.('calls.callLinkInviteVideo') || 'convidou você para uma chamada de vídeo')
          : (t?.('calls.callLinkInviteVoice') || 'convidou você para uma chamada de voz')}
      </Text>
      {typeof info?.participant_count === 'number' && info.participant_count > 0 && (
        <Text style={{ color: sub, fontSize: 13, marginTop: 10 }}>
          {(t?.('calls.callLinkInCall') || 'na chamada agora') + `: ${info.participant_count}`}
        </Text>
      )}
      <TouchableOpacity
        onPress={handleJoin}
        activeOpacity={0.85}
        style={{
          flexDirection: 'row', alignItems: 'center', gap: 8,
          marginTop: 32, paddingHorizontal: 32, paddingVertical: 14,
          borderRadius: 28, backgroundColor: '#7C3AED',
        }}
      >
        {isVideo ? <IconVideo size={20} color="#fff" /> : <IconPhone size={20} color="#fff" />}
        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
          {t?.('calls.callLinkJoin') || 'Entrar na chamada'}
        </Text>
      </TouchableOpacity>
    </Center>
  );
}
