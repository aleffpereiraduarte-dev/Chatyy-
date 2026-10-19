// Shareable call-link lobby: https://chatyy.com.br/c/<código> e /call/<id>
//
// A "Criar link de chamada" (ChatCallsTab → CreateCallLinkSheet) produces a
// standalone link anyone can tap to join a voice/video call. Tapping it (universal
// link /call/* — e /c/* com o AASA novo — ou o cartão no chat) lands here. We:
//   1. read `link_id` from the route (normaliza "xxxx-xxxx-xxxx"),
//   2. call chat_call_link_info → render a pre-join lobby (título, avatar e nome de
//      quem criou, prévia da câmera, microfone/câmera liga-desliga, Entrar), or an
//      "expired / revoked" state,
//   3. on tap call chat_call_link_join → get { url, token, room, is_video },
//   4. stash that pre-minted LiveKit token in the SAME global the call screen's
//      fast-path consumes (globalThis.__chatyy_prefetched_lk_token) and hand off to
//      the native group screen or /call — reusing the EXISTING LiveKit join code.
// [call-link 2026-10-19] Lobby nível WhatsApp: título, prévia da câmera
// (expo-camera, solta antes de entrar), microfone desligado → /call?startMuted=1,
// câmera desligada → entra só com áudio, ?now=1 (Entrar agora do criador) entra direto.
import { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, ActivityIndicator, Pressable, Platform, Share } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import AvatarCircle from '../../components/AvatarCircle';
import { IconPhone, IconVideo, IconVideoOff, IconMic, IconMicOff, IconX, IconLink, IconShare } from '../../components/Icons';
import PressableScale from '../../components/PressableScale';
import * as api from '../../services/api';
import { buildCallLinkMessage } from '../../components/calls/callLinkUtil';

let _Camera = null;
function _cameraMod() {
  if (_Camera !== null) return _Camera;
  try { _Camera = require('expo-camera'); } catch { _Camera = false; }
  return _Camera;
}

function tr(t, key, fb, params) {
  let v;
  try { v = t?.(key, params); } catch {}
  if (v && v !== key) return v;
  let s = fb;
  if (params) Object.keys(params).forEach((k) => { s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(params[k])); });
  return s;
}

function CameraPreview({ facing = 'front', onDenied }) {
  const mod = _cameraMod();
  const [perm, setPerm] = useState(null); // null | granted | denied
  const deniedRef = useRef(onDenied);
  deniedRef.current = onDenied;
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!mod?.Camera) { setPerm('denied'); return; }
        let p = await mod.Camera.getCameraPermissionsAsync();
        if (!p?.granted && p?.canAskAgain !== false) p = await mod.Camera.requestCameraPermissionsAsync();
        if (alive) setPerm(p?.granted ? 'granted' : 'denied');
        if (!p?.granted) deniedRef.current?.();
      } catch { if (alive) setPerm('denied'); }
    })();
    return () => { alive = false; };
  }, [mod]);
  if (perm !== 'granted' || !mod?.CameraView) return null;
  const CV = mod.CameraView;
  return <CV style={{ flex: 1 }} facing={facing} mirror animateShutter={false} />;
}

export default function CallLinkLobbyScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const rawId = Array.isArray(params.id) ? params.id[0] : params.id;
  const linkId = typeof rawId === 'string' ? rawId.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  const autoJoin = String(params.now || '') === '1';
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user, loading: authLoading } = useAuth();
  const insets = useSafeAreaInsets();

  // loading | ready | revoked | expired | auth | error | joining
  const [status, setStatus] = useState('loading');
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState('');
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [camDenied, setCamDenied] = useState(false);
  const autoJoinedRef = useRef(false);

  // ── Fetch link info for the lobby ──
  useEffect(() => {
    if (authLoading) return;
    if (!user) { setStatus('auth'); return; }
    if (!linkId || !/^[a-z0-9]{6,64}$/.test(linkId)) {
      setErr(tr(t, 'calls.callLinkBad', 'Link inválido'));
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
          const m = String(r?.message || '');
          setErr(/not found/i.test(m) ? tr(t, 'callLink.notFound', 'Este link não existe. Confira se ele está completo.')
            : (m || tr(t, 'calls.callLinkFailed', 'Não foi possível abrir o link.')));
          setStatus('error');
          return;
        }
        setInfo(data);
        if (data.revoked || data.state === 'revoked') { setStatus('revoked'); return; }
        if (data.expired || data.state === 'expired' || data.state === 'exhausted') { setStatus('expired'); return; }
        setCamOn(!!data.is_video);
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
    const wantVideo = !!info?.is_video && camOn && !camDenied;
    const wantMic = micOn;
    setStatus('joining'); // desmonta a prévia → câmera solta antes da chamada abrir
    try {
      const r = await api.chatCallLinkJoin(linkId);
      const data = r?.data || r;
      const token = data?.token;
      const room = data?.room;
      const url = data?.url || 'wss://livekit.chatyy.com.br';
      if (!r || r.success === false || !token || !room) {
        // Link may have just been revoked/expired between info and join.
        const msg = String(r?.message || '');
        if (/revok/i.test(msg)) { setStatus('revoked'); return; }
        if (/expir|limit/i.test(msg)) { setStatus('expired'); return; }
        if (/locked/i.test(msg)) { setErr(tr(t, 'callLink.locked', 'O anfitrião trancou a chamada.')); setStatus('error'); return; }
        setErr(msg || tr(t, 'calls.callLinkFailed', 'Não foi possível entrar na chamada.'));
        setStatus('error');
        return;
      }
      if (Platform.OS === 'android' && wantVideo) await new Promise((res) => setTimeout(res, 250));
      // Prime the call screen's pre-fetched-token fast-path (call.js).
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
      const title = info?.title || info?.creator_name || '';
      // [2026-10-09 native-group-call] Native group screen when available (uses this
      // exact pre-minted link token). Microfone desligado no lobby → tela JS, que
      // respeita startMuted (a nativa sempre abre com o microfone ligado).
      if (wantMic) {
        try {
          const ngc = require('../../services/nativeGroupCall');
          if (ngc.canUseNativeGroupCall(user?.email)) {
            const opened = await ngc.openNativeGroupCall({
              callId: String(room), conversationId: '', isVideo: wantVideo, isCaller: false,
              title, email: user?.email,
              token, url, iceServers: Array.isArray(data?.iceServers) ? data.iceServers : [],
            });
            if (opened) {
              try { if (router.canGoBack()) router.back(); else router.replace('/chat'); } catch {}
              return;
            }
          }
        } catch {}
      }
      // Reuse the validated "enter a LiveKit room" path (same params group-call.js
      // uses to join): groupCall=1 + isCaller=1.
      router.replace(
        `/call?callId=${encodeURIComponent(String(room))}`
        + `&isVideo=${wantVideo ? '1' : '0'}`
        + `&groupCall=1&isCaller=1`
        + (wantMic ? '' : '&startMuted=1')
        + `&contactName=${encodeURIComponent(title || tr(t, 'calls.callLink', 'Chamada'))}`
      );
    } catch (e) {
      setErr(String(e?.message || e));
      setStatus('error');
    }
  }, [linkId, info, router, t, user?.email, camOn, camDenied, micOn]);

  // "Entrar agora" (folha de criação) → entra direto, uma vez.
  useEffect(() => {
    if (autoJoin && status === 'ready' && !autoJoinedRef.current) {
      autoJoinedRef.current = true;
      handleJoin();
    }
  }, [autoJoin, status, handleJoin]);

  const onShare = useCallback(async () => {
    if (!info?.url) return;
    const message = buildCallLinkMessage({ url: info.url, title: info.title, is_video: info.is_video }, t);
    try { await Share.share(Platform.OS === 'ios' ? { message } : { message, url: info.url }); } catch {}
  }, [info, t]);

  const close = useCallback(() => {
    try { if (router.canGoBack()) router.back(); else router.replace('/chat'); } catch {}
  }, [router]);

  const bg = colors?.background || '#000';
  const text = colors?.text || '#fff';
  const sub = colors?.textSecondary || '#8e8e93';
  const isVideo = !!info?.is_video;
  const ink = colors?.primary || '#111111';
  const onInk = colors?.onPrimary || '#ffffff';
  const soft = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)';
  const kind = isVideo ? tr(t, 'callLink.kindVideo', 'Chamada de vídeo do Chatyy') : tr(t, 'callLink.kindVoice', 'Chamada de voz do Chatyy');

  const Center = ({ children }) => (
    <View style={{ flex: 1, backgroundColor: bg, paddingTop: insets.top, paddingBottom: insets.bottom }}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        {children}
      </View>
    </View>
  );

  if (status === 'loading' || status === 'joining') {
    return (
      <Center>
        <ActivityIndicator size="large" color={ink} />
        <Text style={{ color: sub, marginTop: 16, fontSize: 14 }}>
          {status === 'joining'
            ? tr(t, 'calls.callLinkJoining', 'Entrando na chamada…')
            : tr(t, 'calls.callLinkLoading', 'Abrindo link…')}
        </Text>
      </Center>
    );
  }

  if (status === 'auth') {
    return (
      <Center>
        <Text style={{ color: text, fontSize: 16, marginBottom: 16, textAlign: 'center' }}>
          {tr(t, 'calls.callLinkLoginFirst', 'Faça login pra entrar na chamada')}
        </Text>
        <PressableScale
          onPress={() => router.replace({ pathname: '/login', params: { redirect: `/call/${linkId}` } })}
          scaleTo={0.96}
          accessibilityRole="button"
          style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 28, paddingVertical: 12, borderRadius: 24, backgroundColor: ink }}
        >
          <Text style={{ color: onInk, fontWeight: '700', fontSize: 15 }}>{tr(t, 'common.login', 'Entrar')}</Text>
        </PressableScale>
      </Center>
    );
  }

  if (status === 'revoked' || status === 'expired' || status === 'error') {
    const title = status === 'revoked'
      ? tr(t, 'calls.callLinkRevoked', 'Link revogado')
      : status === 'expired'
        ? tr(t, 'calls.callLinkExpired', 'Link expirado')
        : tr(t, 'calls.callLinkFailed', 'Não foi possível abrir o link');
    const detail = status === 'revoked'
      ? tr(t, 'callLink.revokedSub', 'Quem criou este link não aceita mais entradas por ele.')
      : status === 'expired'
        ? tr(t, 'callLink.expiredSub', 'Este link ficou muito tempo sem uso. Peça um novo a quem convidou.')
        : err;
    return (
      <Center>
        <View style={{ width: 72, height: 72, borderRadius: 36, marginBottom: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: soft }}>
          <IconLink size={30} color={text} />
        </View>
        <Text style={{ color: text, fontSize: 18, fontWeight: '700', marginBottom: 8, textAlign: 'center' }}>{title}</Text>
        {!!detail && <Text style={{ color: sub, fontSize: 14, lineHeight: 19, marginBottom: 16, textAlign: 'center', maxWidth: 320 }}>{detail}</Text>}
        <PressableScale
          onPress={close}
          scaleTo={0.96}
          accessibilityRole="button"
          style={{ marginTop: 12, minHeight: 48, justifyContent: 'center', paddingHorizontal: 28, paddingVertical: 12, borderRadius: 24, backgroundColor: soft }}
        >
          <Text style={{ color: text, fontWeight: '600', fontSize: 15 }}>{tr(t, 'common.close', 'Fechar')}</Text>
        </PressableScale>
      </Center>
    );
  }

  // status === 'ready' — pre-join lobby
  const ToggleBtn = ({ on, onPress, IconOn, IconOff, labelOn, labelOff }) => (
    <Pressable
      onPress={onPress}
      accessibilityRole="switch"
      accessibilityState={{ checked: !!on }}
      accessibilityLabel={on ? labelOn : labelOff}
      hitSlop={6}
      style={({ pressed }) => ({
        width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center',
        backgroundColor: on ? soft : text, opacity: pressed ? 0.75 : 1,
      })}
    >
      {on ? <IconOn size={24} color={text} /> : <IconOff size={24} color={bg} />}
    </Pressable>
  );
  const showPreview = isVideo && camOn && !camDenied && Platform.OS !== 'web';
  return (
    <View style={{ flex: 1, backgroundColor: bg, paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 16) }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 12, paddingTop: 6 }}>
        <Pressable onPress={close} hitSlop={8} accessibilityRole="button" accessibilityLabel={tr(t, 'common.close', 'Fechar')}
          style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: soft, opacity: pressed ? 0.6 : 1 })}>
          <IconX size={20} color={text} />
        </Pressable>
        {!!info?.url && (
          <Pressable onPress={onShare} hitSlop={8} accessibilityRole="button" accessibilityLabel={tr(t, 'common.share', 'Compartilhar')}
            style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: soft, opacity: pressed ? 0.6 : 1 })}>
            <IconShare size={19} color={text} />
          </Pressable>
        )}
      </View>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 }}>
        {isVideo ? (
          <View style={{ width: '100%', maxWidth: 420, aspectRatio: 3 / 4, maxHeight: 360, borderRadius: 22, overflow: 'hidden', backgroundColor: '#0b0b0c', marginBottom: 20, alignItems: 'center', justifyContent: 'center' }}>
            {showPreview ? <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}><CameraPreview onDenied={() => setCamDenied(true)} /></View> : null}
            {!showPreview && (
              <View style={{ alignItems: 'center', gap: 10 }}>
                <AvatarCircle name={user?.name || user?.email || ''} email={user?.email} size={84} />
                <Text style={{ color: '#a0a0a6', fontSize: 13 }}>
                  {camDenied ? tr(t, 'callLink.camDenied', 'Sem acesso à câmera') : tr(t, 'callLink.camOff', 'Câmera desligada')}
                </Text>
              </View>
            )}
            <View style={{ position: 'absolute', left: 12, top: 12, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14 }}>
              <AvatarCircle name={info?.creator_name || ''} uri={info?.creator_avatar || undefined} size={22} />
              <Text numberOfLines={1} style={{ color: '#fff', fontSize: 12.5, maxWidth: 200 }}>
                {info?.is_creator ? tr(t, 'callLink.yourLink', 'Seu link') : tr(t, 'callLink.invitedBy', 'Convite de {n}', { n: info?.creator_name || '' })}
              </Text>
            </View>
          </View>
        ) : (
          <AvatarCircle name={info?.creator_name || ''} uri={info?.creator_avatar || undefined} size={96} style={{ marginBottom: 20 }} />
        )}
        <Text numberOfLines={2} style={{ color: text, fontSize: 22, fontWeight: '700', textAlign: 'center', letterSpacing: -0.3 }}>
          {info?.title || kind}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
          {isVideo ? <IconVideo size={15} color={sub} /> : <IconPhone size={15} color={sub} />}
          <Text style={{ color: sub, fontSize: 14 }}>{info?.title ? kind : (info?.is_creator ? tr(t, 'callLink.yourLink', 'Seu link') : tr(t, 'callLink.invitedBy', 'Convite de {n}', { n: info?.creator_name || '' }))}</Text>
        </View>
        {!isVideo && !!info?.title && !info?.is_creator && (
          <Text style={{ color: sub, fontSize: 13, marginTop: 2 }}>{tr(t, 'callLink.invitedBy', 'Convite de {n}', { n: info?.creator_name || '' })}</Text>
        )}
        {typeof info?.participant_count === 'number' && info.participant_count > 0 && (
          <Text style={{ color: sub, fontSize: 13, marginTop: 8 }}>
            {tr(t, 'calls.callLinkInCall', 'na chamada agora') + `: ${info.participant_count}`}
          </Text>
        )}
        <View style={{ flexDirection: 'row', gap: 18, marginTop: 24 }}>
          <ToggleBtn on={micOn} onPress={() => setMicOn((v) => !v)} IconOn={IconMic} IconOff={IconMicOff}
            labelOn={tr(t, 'callLink.micOn', 'Microfone ligado')} labelOff={tr(t, 'callLink.micOff', 'Microfone desligado')} />
          {isVideo && (
            <ToggleBtn on={camOn && !camDenied} onPress={() => { if (camDenied) { setCamDenied(false); setCamOn(true); } else setCamOn((v) => !v); }}
              IconOn={IconVideo} IconOff={IconVideoOff}
              labelOn={tr(t, 'callLink.camOnL', 'Câmera ligada')} labelOff={tr(t, 'callLink.camOff', 'Câmera desligada')} />
          )}
        </View>
      </View>
      <View style={{ paddingHorizontal: 24, paddingBottom: 8 }}>
        <PressableScale
          onPress={handleJoin}
          haptic="medium"
          scaleTo={0.97}
          accessibilityRole="button"
          accessibilityLabel={tr(t, 'calls.callLinkJoin', 'Entrar na chamada')}
          testID="call-link-lobby-join"
          style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
            height: 54, borderRadius: 27, backgroundColor: ink, width: '100%', maxWidth: 420, alignSelf: 'center',
          }}
        >
          {isVideo && camOn && !camDenied ? <IconVideo size={20} color={onInk} /> : <IconPhone size={20} color={onInk} />}
          <Text style={{ color: onInk, fontSize: 16, fontWeight: '700' }}>{tr(t, 'calls.callLinkJoin', 'Entrar na chamada')}</Text>
        </PressableScale>
      </View>
    </View>
  );
}
