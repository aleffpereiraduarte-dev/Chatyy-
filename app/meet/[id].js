// [2026-10-15 meet-v2] Tela de REUNIÃO redesenhada (nível Meet/Zoom/FaceTime, P&B, preto verdadeiro).
//  - Pré-visualização (mic/câmera antes de entrar) → sala.
//  - Sala = WebView/iframe de /meet/room-v2.html (mesh WebRTC + sinalização :8095, TURN próprio).
//    A página desenha só os vídeos (grade adaptativa, quem fala, nomes/mic, self-view flutuante);
//    o app desenha cabeçalho (título, cronômetro, rede), barra de 6 controles que CABE em qualquer
//    largura, sheet "Mais", conversa, participantes, cartão "Aguardando participantes" (link/QR).
//  - room.html (v1) segue intocado p/ quem ainda roda o app antigo.
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { View, Text, TextInput, StyleSheet, Platform, ActivityIndicator, Alert, Pressable, AppState, Linking, Share } from 'react-native';
import KeyboardSafeView from '../../components/ui/KeyboardSafeView'; // [2026-10-22 kb-uniforme]
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import * as api from '../../services/api';
import MeetControlBar from '../../components/meet/MeetControlBar';
import MeetHeader from '../../components/meet/MeetHeader';
import MeetWaitingCard from '../../components/meet/MeetWaitingCard';
import MeetPrejoin from '../../components/meet/MeetPrejoin';
import MeetChatPanel from '../../components/MeetChatPanel';
import MeetParticipantsPanel from '../../components/MeetParticipantsPanel';
import MeetReactionsOverlay from '../../components/MeetReactionsOverlay';
import MeetMoreMenu from '../../components/MeetMoreMenu';
import MeetVirtualBgPicker from '../../components/MeetVirtualBgPicker';
import {
  IconLock, IconUnlock, IconImage, IconInfo, IconUsers, IconScreenShare, IconMicOff, IconVideoOff,
  IconMessageCircle, IconUserPlus, IconRaisedHand, IconGrid, IconRecord, IconX,
} from '../../components/Icons';

// [2026-10-07 app-feel-webview] trava zoom + tira highlight/callout na sala.
const MEET_NATIVE_FEEL_JS = `(function(){try{
  function apply(){
    var m=document.querySelector('meta[name=viewport]');
    if(!m){m=document.createElement('meta');m.name='viewport';(document.head||document.documentElement).appendChild(m);}
    m.setAttribute('content','width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover');
    if(!document.getElementById('__chatyy_nf')){var s=document.createElement('style');s.id='__chatyy_nf';
      s.textContent='*{-webkit-tap-highlight-color:transparent}html,body{-webkit-text-size-adjust:100%;overscroll-behavior:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}input,textarea,[contenteditable]{-webkit-user-select:text;user-select:text}';
      (document.head||document.documentElement).appendChild(s);}
  }
  apply();document.addEventListener('DOMContentLoaded',apply);
}catch(e){}})();true;`;

let WebView = null;
if (Platform.OS !== 'web') {
  try { WebView = require('react-native-webview').default; } catch {}
}

const MEET_ORIGIN = 'https://chatyy.com.br';
const MEET_BASE = MEET_ORIGIN + '/meet/room-v2.html';
const HEADER_H = 60;

export default function MeetScreen() {
  const { id: roomId, video } = useLocalSearchParams();
  const { user } = useAuth();
  const { t, language } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // fases: prejoin → (senha) → sala
  const [phase, setPhase] = useState('prejoin');
  const [joining, setJoining] = useState(false);
  const [joinPrefs, setJoinPrefs] = useState({ audio: true, video: video !== 'off' });
  const [error, setError] = useState('');
  const [inRoom, setInRoom] = useState(false); // recebeu 'joined' da página
  const [audioMuted, setAudioMuted] = useState(false);
  const [videoMuted, setVideoMuted] = useState(video === 'off');
  const [screenSharing, setScreenSharing] = useState(false);
  const [participantCount, setParticipantCount] = useState(1);
  const [chatMessages, setChatMessages] = useState([]);
  const [showChat, setShowChat] = useState(false);
  const showChatRef = useRef(false);
  const [unreadChat, setUnreadChat] = useState(0);
  const [ended, setEnded] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [meetingTitle, setMeetingTitle] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [recording, setRecording] = useState(false);
  const [roomLocked, setRoomLocked] = useState(false);
  const [showParticipants, setShowParticipants] = useState(false);
  const [participants, setParticipants] = useState([]);
  const [lobbyPeers, setLobbyPeers] = useState([]);
  const [reactions, setReactions] = useState([]);
  const reactionIdRef = useRef(0);
  const [handRaised, setHandRaised] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [showVirtualBg, setShowVirtualBg] = useState(false);
  const [virtualBgEffect, setVirtualBgEffect] = useState(null);
  const [layoutMode, setLayoutMode] = useState('auto');
  const [net, setNet] = useState('');
  const [startedAt, setStartedAt] = useState(0);
  const [myPeerId, setMyPeerId] = useState('');
  const [chromeVisible, setChromeVisible] = useState(true);
  const [waitingDismissed, setWaitingDismissed] = useState(false);
  const [audioPermissionDenied, setAudioPermissionDenied] = useState(false);
  const [videoPermissionDenied, setVideoPermissionDenied] = useState(false);

  const pendingTimersRef = useRef([]);
  const webViewRef = useRef(null);
  const iframeRef = useRef(null);
  const screenStreamRef = useRef(null);
  const joinedApiRef = useRef(false);

  const displayName = user?.name || user?.email || t('meetScreen.guest');
  const userEmail = (user?.email || '').toLowerCase();
  const meetLink = `${MEET_ORIGIN}/meet/${roomId}`;

  // título p/ a pré-visualização (meet_info pode negar a não-convidados → fica o genérico)
  useEffect(() => {
    let alive = true;
    if (!roomId) return undefined;
    api.meetInfo(roomId).then((r) => {
      const title = r?.data?.meeting?.title;
      if (alive && title) setMeetingTitle(title);
    }).catch(() => {});
    return () => { alive = false; };
  }, [roomId]);

  // ─── Entrar (API) ───
  const attemptJoin = useCallback(async (password) => {
    try {
      const params = { room_id: roomId };
      if (password) params.password = password;
      const r = await api.apiCall('meet_join', params, 'POST');
      if (r.success) {
        joinedApiRef.current = true;
        setNeedsPassword(false);
        setPasswordError('');
        if (r.data?.meeting?.title) setMeetingTitle(r.data.meeting.title);
        setIsHost(!!(r.data?.is_host || r.data?.your_role === 'host'));
        // em sala de espera a própria sala consulta o anfitrião e mostra "Aguardando…"
        setPhase('room');
        return true;
      }
      if (r.data?.requires_password) {
        setNeedsPassword(true);
        setPhase('password');
        if (password && (r.status === 400 || r.status === 401 || r.status === 403 || /password|senha|contrase/i.test(r.message || ''))) {
          setPasswordError(t('meet.passwordWrong'));
        }
        return false;
      }
      setError(r.message || t('meetScreen.joinFailed'));
      return false;
    } catch (e) {
      try { console.warn('[meet] attemptJoin error', e); } catch {}
      setError(t('meetScreen.connectionError'));
      return false;
    }
  }, [roomId, t]);

  const handleJoin = useCallback(async ({ audio, video: vid }) => {
    setJoinPrefs({ audio, video: vid });
    setAudioMuted(!audio);
    setVideoMuted(!vid);
    setJoining(true);
    await attemptJoin();
    setJoining(false);
  }, [attemptJoin]);

  // web: checa permissão de mic/câmera logo ao entrar na sala (no app o WebView pede ao SO)
  useEffect(() => {
    if (Platform.OS !== 'web' || phase !== 'room') return undefined;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: joinPrefs.video });
        try { stream.getTracks().forEach((x) => x.stop()); } catch {}
      } catch (err) {
        if (cancelled) return;
        const name = err?.name || '';
        if (/NotAllowed|SecurityError|Permission/i.test(name) || /denied|permission/i.test(err?.message || '')) {
          setAudioPermissionDenied(true);
          if (joinPrefs.video) setVideoPermissionDenied(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [phase, joinPrefs.video]);

  const openSystemSettings = useCallback(() => {
    if (Platform.OS === 'web') {
      try { window.alert(t('meet.permissionDeniedHintWeb')); } catch {}
      return;
    }
    try { Linking.openSettings(); } catch {}
  }, [t]);

  // volta do segundo plano: renova a presença na API (a sala religa sozinha)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && roomId && phase === 'room' && !ended && !error) {
        api.apiCall('meet_join', { room_id: roomId }, 'POST').catch(() => {});
      }
    });
    return () => sub.remove();
  }, [roomId, phase, ended, error]);

  useEffect(() => () => {
    if (joinedApiRef.current) api.meetLeave(roomId).catch(() => {});
    pendingTimersRef.current.forEach((id) => clearTimeout(id));
    pendingTimersRef.current = [];
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((x) => x.stop());
      screenStreamRef.current = null;
    }
  }, [roomId]);

  // bearer sempre fresco no URL da sala (self-heal do "fica Conectando")
  const [authToken, setAuthToken] = useState(() => api.getAuthToken() || '');
  useEffect(() => {
    let alive = true;
    (async () => {
      try { await api.ensureFreshBearer(); } catch {}
      if (alive) setAuthToken(api.getAuthToken() || '');
    })();
    return () => { alive = false; };
  }, []);

  // insets iniciais congelados (mudar o URL recarrega a sala); depois só via setInsets()
  const initialInsetsRef = useRef(null);
  if (!initialInsetsRef.current) {
    initialInsetsRef.current = { top: insets.top + HEADER_H, bottom: insets.bottom + 96 };
  }
  const meetUrl = useMemo(() => {
    const ii = initialInsetsRef.current;
    const q = [
      `id=${encodeURIComponent(roomId)}`,
      `token=${encodeURIComponent(authToken)}`,
      `name=${encodeURIComponent(displayName)}`,
      `email=${encodeURIComponent(userEmail)}`,
      `webview=${Platform.OS !== 'web' ? '1' : '0'}`,
      `video=${joinPrefs.video ? '1' : '0'}`,
      `audio=${joinPrefs.audio ? '1' : '0'}`,
      `lang=${encodeURIComponent(String(language || 'pt').slice(0, 2))}`,
      `it=${Math.round(ii.top)}`,
      `ib=${Math.round(ii.bottom)}`,
      'v=2',
    ];
    return `${MEET_BASE}?${q.join('&')}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, authToken, displayName, userEmail, joinPrefs.video, joinPrefs.audio]);

  // ─── Ponte app → sala ───
  const callRoom = useCallback((action, ...args) => {
    if (Platform.OS === 'web') {
      try {
        iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ action, args }), MEET_ORIGIN);
      } catch {}
    } else if (webViewRef.current) {
      const a = args.map((x) => JSON.stringify(x)).join(',');
      webViewRef.current.injectJavaScript(`try{window.meetController&&window.meetController.${action}&&window.meetController.${action}(${a})}catch(e){};true;`);
    }
  }, []);

  // cabeçalho/barra ocultos (toque no vídeo) → vídeos usam a tela toda
  const [barH, setBarH] = useState(insets.bottom + 92);
  useEffect(() => {
    if (phase !== 'room') return;
    if (chromeVisible) callRoom('setInsets', insets.top + HEADER_H, barH + 4);
    else callRoom('setInsets', insets.top + 8, insets.bottom + 8);
  }, [chromeVisible, barH, insets.top, insets.bottom, phase, callRoom]);

  // ─── Sala → app ───
  const handleMessage = useCallback((event) => {
    let msg;
    try {
      if (Platform.OS === 'web') {
        if (event.origin && event.origin !== MEET_ORIGIN && event.origin !== window.location.origin) return;
        msg = typeof event.data === 'object' ? event.data : JSON.parse(event.data);
      } else {
        msg = JSON.parse(event.nativeEvent.data);
      }
    } catch { return; }
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'joined':
        setInRoom(true);
        setMyPeerId(msg.peerId || '');
        setStartedAt((s) => s || Date.now());
        if (typeof msg.isHost === 'boolean') setIsHost((h) => h || msg.isHost);
        setParticipantCount(msg.participantCount || ((msg.peers || []).length + 1));
        setParticipants((msg.peers || []).map((p) => ({
          peerId: p.peerId, displayName: p.displayName, email: p.email,
          audioMuted: !!p.audioMuted, videoMuted: p.videoMuted !== false, handRaised: !!p.handRaised,
        })));
        break;
      case 'meeting_info':
        if (msg.title) setMeetingTitle(msg.title);
        break;
      case 'local_media':
        setAudioMuted(!!msg.audioMuted);
        setVideoMuted(!!msg.videoMuted);
        break;
      case 'peer_joined':
        setParticipantCount((prev) => msg.participantCount || prev + 1);
        setParticipants((prev) => [...prev.filter((p) => p.peerId !== msg.peerId), {
          peerId: msg.peerId, displayName: msg.displayName, email: msg.email,
          audioMuted: false, videoMuted: true, handRaised: false,
        }]);
        setLobbyPeers((prev) => prev.filter((p) => !msg.email || (p.email || '').toLowerCase() !== String(msg.email).toLowerCase()));
        break;
      case 'peer_left':
        setParticipantCount((prev) => msg.participantCount || Math.max(1, prev - 1));
        setParticipants((prev) => prev.filter((p) => p.peerId !== msg.peerId));
        break;
      case 'audio_muted':
        setAudioMuted(!!msg.muted);
        break;
      case 'video_muted':
        setVideoMuted(!!msg.muted);
        break;
      case 'screen_share_started':
        setScreenSharing(true);
        break;
      case 'screen_share_stopped':
        if (Platform.OS === 'web' && screenStreamRef.current) {
          screenStreamRef.current.getTracks().forEach((x) => x.stop());
          screenStreamRef.current = null;
        }
        setScreenSharing(false);
        break;
      case 'chat_message':
        setChatMessages((prev) => [...prev, { id: `r_${msg.timestamp}_${prev.length}`, displayName: msg.displayName, message: msg.message, timestamp: msg.timestamp }]);
        if (!showChatRef.current) setUnreadChat((n) => n + 1);
        break;
      case 'connection_state':
        break;
      case 'net_quality':
        setNet(msg.level || '');
        break;
      case 'tap':
        setChromeVisible((v) => !v);
        break;
      case 'error':
        if (msg.message && /camera|microphone|permission|access denied/i.test(msg.message)) {
          setAudioPermissionDenied(true);
          if (joinPrefs.video) setVideoPermissionDenied(true);
        } else if (msg.code === 'NOT_FOUND' || msg.code === 'AUTH_REQUIRED' || msg.code === 'ROOM_FULL') {
          setError(msg.message || t('meetScreen.joinFailed'));
        }
        break;
      case 'hand_raised':
        if (msg.self) setHandRaised(true);
        setParticipants((prev) => prev.map((p) => (p.peerId === msg.peerId ? { ...p, handRaised: true } : p)));
        break;
      case 'hand_lowered':
        if (msg.self) setHandRaised(false);
        setParticipants((prev) => prev.map((p) => (p.peerId === msg.peerId ? { ...p, handRaised: false } : p)));
        break;
      case 'reaction': {
        const id = ++reactionIdRef.current;
        setReactions((prev) => [...prev.slice(-9), { id, emoji: msg.emoji, displayName: msg.displayName, timestamp: Date.now() }]);
        pendingTimersRef.current.push(setTimeout(() => setReactions((prev) => prev.filter((x) => x.id !== id)), 3500));
        break;
      }
      case 'lobby_pending':
      case 'lobby_request':
        setLobbyPeers((prev) => [...prev.filter((p) => p.peerId !== msg.peerId),
          { peerId: msg.peerId, displayName: msg.displayName, email: msg.email, viaApi: !!msg.viaApi }]);
        break;
      case 'lobby_resolved':
        setLobbyPeers((prev) => prev.filter((p) => (p.email || '').toLowerCase() !== String(msg.email || '').toLowerCase()));
        break;
      case 'lobby_denied':
        setError(t('meetScreen.lobbyDenied'));
        break;
      case 'mute_update':
        setParticipants((prev) => prev.map((p) => (p.peerId === msg.peerId ? { ...p, audioMuted: !!msg.audioMuted, videoMuted: !!msg.videoMuted } : p)));
        break;
      case 'recording_started':
        setRecording(true);
        break;
      case 'recording_stopped':
        setRecording(false);
        break;
      case 'room_locked':
        setRoomLocked(true);
        break;
      case 'room_unlocked':
        setRoomLocked(false);
        break;
      case 'layout_changed':
        if (msg.layout) setLayoutMode(msg.layout);
        break;
      case 'meeting_ended':
        setEnded(true);
        pendingTimersRef.current.push(setTimeout(() => router.back(), 1800));
        break;
      case 'kicked':
        setEnded(true);
        setError(t('meetScreen.kicked'));
        pendingTimersRef.current.push(setTimeout(() => router.back(), 2000));
        break;
      case 'bg_effect_changed':
        if (msg.effect === 'none') setVirtualBgEffect(null);
        else if (msg.effect === 'gradient') setVirtualBgEffect('gradient:' + (msg.name || ''));
        else if (msg.effect === 'image') setVirtualBgEffect(msg.url || 'image');
        else setVirtualBgEffect(msg.effect || null);
        break;
      default:
        break;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinPrefs.video]);

  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleMessage]);

  // ─── Ações ───
  const leaveNow = useCallback(() => {
    callRoom('leaveRoom');
    if (joinedApiRef.current) { api.meetLeave(roomId).catch(() => {}); joinedApiRef.current = false; }
    setEnded(true);
    pendingTimersRef.current.push(setTimeout(() => router.back(), 350));
  }, [roomId, callRoom, router]);

  const endForAll = useCallback(() => {
    api.meetEnd(roomId).catch(() => {});
    leaveNow();
  }, [roomId, leaveNow]);

  const handleLeave = useCallback(() => {
    if (!inRoom) { leaveNow(); return; }
    if (Platform.OS === 'web') {
      if (isHost && participantCount > 1) {
        // confirm() só tem 2 botões: OK = sair; o anfitrião encerra pelo menu "Mais"
        if (!window.confirm(t('meetScreen.leaveConfirm'))) return;
      } else if (!window.confirm(t('meetScreen.leaveConfirm'))) return;
      leaveNow();
      return;
    }
    const buttons = [{ text: t('common.cancel'), style: 'cancel' }];
    if (isHost && participantCount > 1) buttons.push({ text: t('meetV2.endForAll'), style: 'destructive', onPress: endForAll });
    buttons.push({ text: t('meetScreen.leave'), style: 'destructive', onPress: leaveNow });
    Alert.alert(t('meetScreen.leave'), t('meetScreen.leaveConfirm'), buttons);
  }, [inRoom, isHost, participantCount, leaveNow, endForAll, t]);

  const openChat = useCallback(() => {
    setShowParticipants(false); setShowVirtualBg(false);
    setShowChat(true); showChatRef.current = true; setUnreadChat(0);
  }, []);
  const closeChat = useCallback(() => { setShowChat(false); showChatRef.current = false; setUnreadChat(0); }, []);
  const openParticipants = useCallback(() => {
    setShowChat(false); showChatRef.current = false; setShowVirtualBg(false);
    setShowParticipants(true);
  }, []);

  const handleSendChat = useCallback((text) => {
    callRoom('sendChat', text);
    setChatMessages((prev) => [...prev, { id: 'l_' + Date.now() + '_' + prev.length, displayName: t('meet.you'), message: text, timestamp: Date.now(), isLocal: true }]);
  }, [callRoom, t]);

  const shareInvite = useCallback(async () => {
    const message = t('meetV2.inviteMsg', { title: meetingTitle || t('meet.title'), link: meetLink });
    try {
      if (Platform.OS === 'web') {
        if (navigator.share) await navigator.share({ title: meetingTitle || '', text: message, url: meetLink });
        else if (navigator.clipboard) { await navigator.clipboard.writeText(meetLink); window.alert(t('meetV2.linkCopied')); }
        return;
      }
      await Share.share(Platform.OS === 'ios' ? { message, url: meetLink } : { message });
    } catch {}
  }, [t, meetingTitle, meetLink]);

  const stopScreenShareWeb = useCallback(() => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((x) => x.stop());
      screenStreamRef.current = null;
    }
    callRoom('stopScreenShare');
    setScreenSharing(false);
  }, [callRoom]);

  // web: a captura precisa do gesto do usuário na página do app; a sala (mesma origem) recebe o stream
  const handleToggleScreenShare = useCallback(async () => {
    if (Platform.OS !== 'web') return;
    if (screenSharing) { stopScreenShareWeb(); return; }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: false });
      screenStreamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      if (track) track.onended = () => stopScreenShareWeb();
      const win = iframeRef.current?.contentWindow;
      let handed = false;
      try {
        if (win && win.navigator && win.meetController) {
          const md = win.navigator.mediaDevices;
          const orig = md.getDisplayMedia.bind(md);
          md.getDisplayMedia = () => { md.getDisplayMedia = orig; return Promise.resolve(stream); };
          win.meetController.startScreenShare();
          handed = true;
        }
      } catch {}
      if (!handed) { stream.getTracks().forEach((x) => x.stop()); screenStreamRef.current = null; window.alert(t('meetScreen.screenShareFailed')); return; }
      setScreenSharing(true);
    } catch (err) {
      if (err && err.name !== 'NotAllowedError') { try { window.alert(t('meetScreen.screenShareFailed')); } catch {} }
    }
  }, [screenSharing, stopScreenShareWeb, t]);

  const handleRaiseHand = useCallback(() => {
    callRoom(handRaised ? 'lowerHand' : 'raiseHand');
    setHandRaised((v) => !v);
  }, [callRoom, handRaised]);

  const handleReaction = useCallback((key) => {
    callRoom('sendReaction', key);
    const id = ++reactionIdRef.current;
    setReactions((prev) => [...prev.slice(-9), { id, emoji: key, displayName: t('meet.you'), timestamp: Date.now() }]);
    pendingTimersRef.current.push(setTimeout(() => setReactions((prev) => prev.filter((x) => x.id !== id)), 3500));
  }, [callRoom, t]);

  const handleToggleRecording = useCallback(() => {
    if (recording) {
      callRoom('stopRecording');
      setTimeout(() => api.meetStopRecording(roomId).catch(() => {}), 800);
    } else {
      api.meetStartRecording(roomId).catch(() => {}).finally(() => callRoom('startRecording'));
    }
    setRecording((v) => !v);
  }, [recording, roomId, callRoom]);

  const handleToggleLock = useCallback(() => {
    if (roomLocked) { api.meetUnlock(roomId).catch(() => {}); callRoom('unlockRoom'); }
    else { api.meetLock(roomId).catch(() => {}); callRoom('lockRoom'); }
    setRoomLocked((v) => !v);
  }, [roomLocked, roomId, callRoom]);

  const lobbyByPeer = useCallback((peerId) => lobbyPeers.find((p) => p.peerId === peerId), [lobbyPeers]);
  const handleAdmit = useCallback((peerId) => {
    const p = lobbyByPeer(peerId);
    if (p?.email) api.meetLobbyAdmit(roomId, p.email).catch(() => {});
    if (!p?.viaApi) callRoom('admitFromLobby', peerId);
    setLobbyPeers((prev) => prev.filter((x) => x.peerId !== peerId));
  }, [lobbyByPeer, roomId, callRoom]);
  const handleDeny = useCallback((peerId) => {
    const p = lobbyByPeer(peerId);
    if (p?.email) api.meetLobbyDeny(roomId, p.email).catch(() => {});
    if (!p?.viaApi) callRoom('denyFromLobby', peerId);
    setLobbyPeers((prev) => prev.filter((x) => x.peerId !== peerId));
  }, [lobbyByPeer, roomId, callRoom]);
  const handleKick = useCallback((peerId) => {
    const p = participants.find((x) => x.peerId === peerId);
    callRoom('kickParticipant', peerId);
    if (p?.email) api.meetKick(roomId, p.email).catch(() => {});
    setParticipants((prev) => prev.filter((x) => x.peerId !== peerId));
  }, [participants, roomId, callRoom]);
  const handleMutePeer = useCallback((peerId) => callRoom('muteParticipant', peerId), [callRoom]);
  const handlePromote = useCallback((peerId) => {
    const peer = participants.find((p) => p.peerId === peerId);
    if (peer?.email) api.meetPromote(roomId, peer.email).catch(() => {});
  }, [participants, roomId]);

  const handleSelectVirtualBg = useCallback((type, value) => {
    callRoom('setVirtualBackground', type, value);
    setVirtualBgEffect(type === 'none' ? null : type === 'gradient' ? 'gradient:' + value : type === 'image' ? value : type);
  }, [callRoom]);

  const toggleLayout = useCallback(() => {
    const next = layoutMode === 'speaker' ? 'grid' : 'speaker';
    callRoom('setLayout', next);
    setLayoutMode(next);
  }, [layoutMode, callRoom]);

  const showInfo = useCallback(() => {
    const info = `${meetingTitle || t('meet.title')}\n${meetLink}\n${t('meet.participants')}: ${participantCount}`;
    if (Platform.OS === 'web') window.alert(info);
    else Alert.alert(t('meetScreen.meetingInfo'), info, [
      { text: t('meet.copyLink'), onPress: () => { try { require('expo-clipboard').setStringAsync(meetLink); } catch {} } },
      { text: t('common.close'), style: 'cancel' },
    ]);
  }, [meetingTitle, meetLink, participantCount, t]);

  const allParticipants = useMemo(() => ([
    { peerId: myPeerId || 'self', displayName, email: userEmail, audioMuted, videoMuted, handRaised, isLocal: true, role: isHost ? 'host' : undefined },
    ...participants,
  ]), [myPeerId, displayName, userEmail, audioMuted, videoMuted, handRaised, isHost, participants]);

  const moreOptions = useMemo(() => {
    const opts = [
      { key: 'chat', label: t('meet.chat'), icon: IconMessageCircle, onPress: openChat, badge: unreadChat ? (unreadChat > 9 ? '9+' : String(unreadChat)) : null },
      { key: 'people', label: t('meet.participants'), icon: IconUsers, onPress: openParticipants, value: String(participantCount), badge: lobbyPeers.length ? String(lobbyPeers.length) : null },
      { key: 'invite', label: t('meetV2.invite'), icon: IconUserPlus, onPress: shareInvite },
      { key: 'hand', label: handRaised ? t('meetV2.lowerHand') : t('meetV2.raiseHand'), icon: IconRaisedHand, onPress: handleRaiseHand, active: handRaised },
      { key: 'layout', label: layoutMode === 'speaker' ? t('meetV2.layoutGrid') : t('meetV2.layoutSpeaker'), icon: IconGrid, onPress: toggleLayout },
    ];
    if (Platform.OS === 'web') {
      opts.push({ key: 'screen', label: screenSharing ? t('meet.stopSharing') : t('meet.shareScreen'), icon: IconScreenShare, onPress: handleToggleScreenShare, active: screenSharing });
      opts.push({ key: 'bg', label: virtualBgEffect ? t('meetScreen.changeBackground') : t('meetScreen.virtualBackground'), icon: IconImage, onPress: () => setShowVirtualBg(true), active: !!virtualBgEffect });
    }
    if (isHost) {
      opts.push({ key: 'rec', label: recording ? t('meetScreen.stopRecording') : t('meetScreen.startRecording'), icon: IconRecord, onPress: handleToggleRecording, active: recording });
      opts.push({ key: 'lock', label: roomLocked ? t('meetScreen.unlockRoom') : t('meetScreen.lockRoom'), icon: roomLocked ? IconUnlock : IconLock, onPress: handleToggleLock, active: roomLocked });
      if (participantCount > 1) opts.push({ key: 'end', label: t('meetV2.endForAll'), icon: IconX, onPress: endForAll, destructive: true });
    }
    opts.push({ key: 'info', label: t('meetScreen.meetingInfo'), icon: IconInfo, onPress: showInfo });
    return opts;
  }, [t, openChat, unreadChat, openParticipants, participantCount, lobbyPeers.length, shareInvite, handRaised, handleRaiseHand,
    layoutMode, toggleLayout, screenSharing, handleToggleScreenShare, virtualBgEffect, isHost, recording, handleToggleRecording,
    roomLocked, handleToggleLock, endForAll, showInfo]);

  // ─── Pré-visualização ───
  if (phase === 'prejoin' && !error) {
    return (
      <MeetPrejoin
        t={t}
        insets={insets}
        title={meetingTitle}
        userName={displayName}
        userEmail={userEmail}
        initialVideo={video !== 'off'}
        busy={joining}
        onJoin={handleJoin}
        onCancel={() => router.back()}
      />
    );
  }

  // ─── Senha ───
  if (phase === 'password' && needsPassword) {
    const submit = async () => { setJoining(true); await attemptJoin(passwordInput); setJoining(false); };
    return (
      <KeyboardSafeView style={{ flex: 1, backgroundColor: '#000' }}>
        <View style={[s.centered, { paddingTop: insets.top }]}>
          <View style={s.iconCircle}><IconLock size={28} color="#fff" /></View>
          <Text style={s.h1}>{t('meetScreen.passwordRequired')}</Text>
          <TextInput
            style={s.passwordInput}
            value={passwordInput}
            onChangeText={(v) => { setPasswordInput(v); if (passwordError) setPasswordError(''); }}
            placeholder={t('meetScreen.passwordPlaceholder')}
            placeholderTextColor="rgba(255,255,255,0.4)"
            secureTextEntry
            autoFocus
            accessibilityLabel={t('meet.passwordLabel')}
            onSubmitEditing={submit}
          />
          {passwordError ? <Text style={s.errSmall}>{passwordError}</Text> : null}
          <Pressable onPress={submit} disabled={joining} style={({ pressed }) => [s.primaryBtn, (pressed || joining) && { opacity: 0.8 }]} accessibilityRole="button">
            {joining ? <ActivityIndicator color="#000" /> : <Text style={s.primaryText}>{t('meetScreen.enter')}</Text>}
          </Pressable>
          <Pressable onPress={() => router.back()} style={s.ghostBtn} accessibilityRole="button">
            <Text style={s.ghostText}>{t('common.cancel')}</Text>
          </Pressable>
        </View>
      </KeyboardSafeView>
    );
  }

  // ─── Permissão negada ───
  if (audioPermissionDenied || videoPermissionDenied) {
    const both = audioPermissionDenied && videoPermissionDenied;
    const bodyKey = both ? 'meet.permissionDeniedBody' : (audioPermissionDenied ? 'meet.permissionDeniedBodyAudio' : 'meet.permissionDeniedBodyVideo');
    return (
      <View style={[s.centered, { paddingHorizontal: 32 }]}>
        <View style={s.iconCircle}>
          {videoPermissionDenied && !audioPermissionDenied ? <IconVideoOff size={30} color="#fff" /> : <IconMicOff size={30} color="#fff" />}
        </View>
        <Text style={s.h1}>{t('meet.permissionDeniedTitle')}</Text>
        <Text style={s.body}>{t(bodyKey)}</Text>
        <Pressable onPress={openSystemSettings} style={s.primaryBtn} accessibilityRole="button">
          <Text style={s.primaryText}>{t('meet.openSettings')}</Text>
        </Pressable>
        <Pressable onPress={() => router.back()} style={s.ghostBtn} accessibilityRole="button">
          <Text style={s.ghostText}>{t('common.cancel')}</Text>
        </Pressable>
      </View>
    );
  }

  // ─── Erro / encerrada ───
  if (error || ended) {
    return (
      <View style={s.centered}>
        <Text style={s.h1}>{error || t('meetScreen.ended')}</Text>
        {!ended || error ? (
          <Pressable onPress={() => router.back()} style={s.ghostBtn} accessibilityRole="button">
            <Text style={s.ghostText}>{t('common.close')}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const alone = inRoom && participantCount <= 1;
  const showWaiting = alone && !waitingDismissed && !showChat && !showParticipants && !showMore;
  const moreBadge = (unreadChat || 0) + (isHost ? lobbyPeers.length : 0);

  const overlays = (
    <>
      <MeetReactionsOverlay reactions={reactions} />
      {showWaiting ? (
        <View style={[s.waitingWrap, { top: insets.top + HEADER_H, bottom: barH }]} pointerEvents="box-none">
          <MeetWaitingCard t={t} link={meetLink} title={meetingTitle} onClose={() => setWaitingDismissed(true)} />
        </View>
      ) : null}
      {inRoom ? (
        <>
          <MeetHeader
            t={t}
            visible={chromeVisible}
            topInset={insets.top}
            title={meetingTitle}
            startedAt={startedAt}
            net={net}
            locked={roomLocked}
            recording={recording}
            count={participantCount}
            onParticipants={openParticipants}
          />
          <MeetControlBar
            t={t}
            visible={chromeVisible}
            bottomInset={insets.bottom}
            audioMuted={audioMuted}
            videoMuted={videoMuted}
            handRaised={handRaised}
            screenSharing={screenSharing}
            onToggleAudio={() => callRoom('toggleAudio')}
            onToggleVideo={() => callRoom('toggleVideo')}
            onFlipCamera={() => callRoom('switchCamera')}
            onScreenShare={handleToggleScreenShare}
            onRaiseHand={handleRaiseHand}
            onReaction={handleReaction}
            onMore={() => setShowMore(true)}
            onLeave={handleLeave}
            moreBadge={moreBadge ? (moreBadge > 9 ? '9+' : String(moreBadge)) : null}
            onLayout={(e) => { const h = e?.nativeEvent?.layout?.height; if (h && Math.abs(h - barH) > 2) setBarH(h); }}
          />
        </>
      ) : (
        <Pressable onPress={handleLeave} style={[s.cancelPill, { top: insets.top + 10 }]} accessibilityRole="button" accessibilityLabel={t('common.cancel')}>
          <IconX size={16} color="#fff" />
          <Text style={s.cancelText}>{t('common.cancel')}</Text>
        </Pressable>
      )}
      {screenSharing && Platform.OS === 'web' ? (
        <Pressable onPress={stopScreenShareWeb} style={[s.sharePill, { top: insets.top + HEADER_H + 8 }]} accessibilityRole="button">
          <IconScreenShare size={15} color="#000" />
          <Text style={s.sharePillText}>{t('meetScreen.stopSharing')}</Text>
        </Pressable>
      ) : null}
      <MeetChatPanel visible={showChat} messages={chatMessages} onSend={handleSendChat} onClose={closeChat} insets={insets} />
      <MeetParticipantsPanel
        visible={showParticipants}
        onClose={() => setShowParticipants(false)}
        participants={allParticipants}
        lobbyPeers={lobbyPeers}
        isHost={isHost}
        onAdmit={handleAdmit}
        onDeny={handleDeny}
        onKick={handleKick}
        onMute={handleMutePeer}
        onPromote={handlePromote}
        topInset={insets.top}
      />
      <MeetMoreMenu visible={showMore} onClose={() => setShowMore(false)} options={moreOptions} bottomInset={insets.bottom} title={meetingTitle || undefined} />
      <MeetVirtualBgPicker visible={showVirtualBg} onClose={() => setShowVirtualBg(false)} onSelect={handleSelectVirtualBg} currentEffect={virtualBgEffect} />
    </>
  );

  if (Platform.OS === 'web') {
    return (
      <View style={s.container}>
        <iframe
          ref={iframeRef}
          src={meetUrl}
          title={meetingTitle || 'meet'}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none', background: '#000' }}
          allow="camera; microphone; display-capture; autoplay; clipboard-write"
        />
        {overlays}
      </View>
    );
  }

  if (!WebView) {
    return (
      <View style={s.centered}>
        <Text style={s.h1}>{t('groupCallD.webviewUnavailable')}</Text>
      </View>
    );
  }

  return (
    <View style={s.container}>
      <WebView
        ref={webViewRef}
        source={{ uri: meetUrl }}
        onMessage={handleMessage}
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        mediaCapturePermissionGrantType="grant"
        javaScriptEnabled
        domStorageEnabled
        originWhitelist={['*']}
        bounces={false}
        overScrollMode="never"
        textZoom={100}
        decelerationRate={0.998} /* [2026-10-11] número: "normal" (texto) derrubava o Android (RNCWebView espera Double) */
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        allowsLinkPreview={false}
        allowsBackForwardNavigationGestures={false}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        hideKeyboardAccessoryView
        injectedJavaScriptBeforeContentLoaded={MEET_NATIVE_FEEL_JS}
        style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]}
        containerStyle={{ backgroundColor: '#000' }}
      />
      {overlays}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  centered: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center', padding: 24 },
  iconCircle: { width: 72, height: 72, borderRadius: 36, backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  h1: { color: '#fff', fontSize: 19, fontWeight: '700', textAlign: 'center', marginBottom: 8 },
  body: { color: 'rgba(255,255,255,0.6)', fontSize: 14.5, lineHeight: 20, textAlign: 'center', maxWidth: 320, marginBottom: 22 },
  errSmall: { color: '#FF453A', fontSize: 13, marginTop: 8, textAlign: 'center' },
  passwordInput: {
    width: 280, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 13, marginTop: 14,
    backgroundColor: '#1a1a1a', color: '#fff', fontSize: 16, textAlign: 'center',
  },
  primaryBtn: { marginTop: 18, minWidth: 220, height: 50, borderRadius: 14, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  primaryText: { color: '#000', fontSize: 16, fontWeight: '700' },
  ghostBtn: { marginTop: 10, paddingVertical: 12, paddingHorizontal: 24 },
  ghostText: { color: 'rgba(255,255,255,0.7)', fontSize: 15, fontWeight: '600' },
  waitingWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, zIndex: 60 },
  cancelPill: {
    position: 'absolute', left: 14, zIndex: 300, flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.14)',
  },
  cancelText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  sharePill: {
    position: 'absolute', alignSelf: 'center', zIndex: 95, flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, height: 34, borderRadius: 17, backgroundColor: '#fff',
  },
  sharePillText: { color: '#000', fontSize: 13.5, fontWeight: '700' },
});
