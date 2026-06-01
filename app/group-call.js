// Group call via LiveKit (SFU).
// Scales to 50+ participants, media server does the mixing instead of
// every client talking to every other (mesh P2P limit ~5).
//
// Token obtained from chat_livekit_token endpoint.
// Full UI rendered by /livekit-room.html (WebView).
// On leave, WebView posts 'leave' message → we router.back().
//
// On top of the WebView we paint native polishes (WhatsApp / FaceTime
// parity), all wired through `postMessage` from /livekit-room.html which
// knows the LiveKit Room state authoritatively:
//   1. Connecting skeleton — 2x2 / 3x3 / scrollable grid of avatar
//      placeholders so the user sees structure immediately, and the
//      currently-speaking tile gets a yellow 2px ring.
//   2. Header "X participantes" → opens CallParticipantList sheet.
//   3. Host gear → opens HostControlsSheet (mute all / lock / record /
//      share link). Render only when local user is host/cohost.
//   4. Reactions floating bar — 6 emoji presets, burst animation. Sync
//      via WS `call_reaction` so participants on the mesh fallback see
//      it too.
//   5. Raise-hand banner — ordered queue of who-raised-when. Synced via
//      WS `call_hand_raise` AND mirrored from the WebView.
//   6. Recording banner — top-of-screen red badge when anyone in the
//      room (host) initiates recording; required by consent law in
//      multiple jurisdictions.
//   7. Pin specific participant — long-press routed into the WebView so
//      it owns the focus tile selection. We just track the pinned email
//      locally for the participant-list sheet's "Pinned" chip.
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { View, ActivityIndicator, Text, Platform, StyleSheet, TouchableOpacity, ScrollView, Animated, Easing, Pressable, Alert, Share, Dimensions } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import Svg, { Path as SvgPath } from 'react-native-svg';
import * as api from '../services/api';
import { BASE_URL } from '../services/api';
import AvatarCircle from '../components/AvatarCircle';
import { IconSmile } from '../components/Icons';
import CallParticipantList from '../components/CallParticipantList';
import HostControlsSheet from '../components/HostControlsSheet';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';

let WebView = null;
if (Platform.OS !== 'web') {
  try { WebView = require('react-native-webview').WebView; } catch {}
}

let Clipboard = null;
try { Clipboard = require('expo-clipboard'); } catch {}

// Brand purple — keep in sync with theme/Colors.brand.
const BRAND_PURPLE = '#7C3AED';
// Active-speaker ring — calm emerald green (Meet/WhatsApp style). Clear
// active indication without the gaudy amber flash.
const SPEAKER_RING = '#34d399';
// Recording red badge color — matches CallKit native recording chip.
const REC_RED = '#DC2626';
// 6 emoji presets — order is intentional (👍 first because positive ack
// is the most-used micro-reaction in product analytics).
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
// Active-speaker pulse animation period.
const SPEAKER_PULSE_MS = 900;

const ROLE = CallParticipantList.ROLE;

// Pick grid columns based on participant count. Matches FaceTime / Meet:
// up to 4 → 2x2, 5–9 → 3x3, 10+ → scrollable 3-wide.
// [gap E4 2026-05-20] Beyond 4 participants we switch to 'focus' mode:
// big active-speaker tile + horizontal filmstrip below. Returning the
// special string from this function lets the renderer branch on it.
function pickGridCols(count) {
  if (count <= 4) return 2;
  // >4: return 'focus' sentinel so the grid renders a 1-up + filmstrip
  // (Meet/Zoom "speaker view" — keeps every face on screen without
  // shrinking the active speaker into a tiny tile).
  return 'focus';
}

// Debounce window for active-speaker switches in focus mode. Without
// this, fast back-and-forth talkers flicker the big tile every 200ms.
// 1500ms matches WhatsApp's perceived stickiness.
const ACTIVE_SPEAKER_DEBOUNCE_MS = 1500;

const SCREEN_W = Dimensions.get('window').width;

export default function GroupCallScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { user } = useAuth();
  const { t } = useLanguage();
  // Params podem vir como string[] em deep links — extrai sempre o primeiro.
  const conversation_id = Array.isArray(params.conversation_id) ? params.conversation_id[0] : params.conversation_id;
  const video = Array.isArray(params.video) ? params.video[0] : params.video;
  const room = Array.isArray(params.room) ? params.room[0] : params.room;
  // Caller is the implicit host. For ring-and-join flows the WS payload may
  // carry `host_email`, but in the absence of that the user that started the
  // call (isCaller=1) is the host. We re-validate via backend before any
  // host-only action goes through.
  const isCaller = (Array.isArray(params.isCaller) ? params.isCaller[0] : params.isCaller) === '1';
  const hostEmailParam = (Array.isArray(params.host_email) ? params.host_email[0] : params.host_email) || '';

  const [token, setToken] = useState(null);
  const [livekitUrl, setLivekitUrl] = useState(null);
  const [roomName, setRoomName] = useState(room || '');
  const [err, setErr] = useState(null);
  // Participant list (live from LiveKit via WebView postMessage). Shape:
  //   [{ email, name, role, isSpeaking, muted, videoOn, handRaised }]
  const [participants, setParticipants] = useState([]);
  const [activeSpeakerEmail, setActiveSpeakerEmail] = useState(null);
  // Pinned participant — local UI state, also forwarded into the WebView so
  // /livekit-room.html keeps the tile in the foreground.
  const [pinnedEmail, setPinnedEmail] = useState('');
  // Sheets
  const [showParticipants, setShowParticipants] = useState(false);
  const [showHostControls, setShowHostControls] = useState(false);
  // Reactions — floating bursts above the grid; queue trimmed to last 12.
  const [reactions, setReactions] = useState([]); // [{ id, emoji, x, anim }]
  const [showReactionBar, setShowReactionBar] = useState(false);
  // Raised hands queue — ordered FIFO so the banner lists them in the
  // order they raised. Map email→{ name, ts }.
  const [raisedHands, setRaisedHands] = useState([]);
  // Lock / recording state for the room. Lock is local-optimistic; backend
  // is authoritative on rejection.
  const [locked, setLocked] = useState(false);
  const [recording, setRecording] = useState(false);

  // Refs we read inside callbacks without re-binding.
  const webViewRef = useRef(null);

  // [gap E3 2026-05-20] Local per-participant volume / silence-for-me map.
  // Keyed by lowercase email → number in [0..1]. Persisted only for the
  // duration of the call; reset on leave. NOT mirrored to other clients
  // (this is local audio mix only).
  const [silencedEmails, setSilencedEmails] = useState({});

  // [gap E4 2026-05-20] Long-press participant menu state.
  const [participantMenu, setParticipantMenu] = useState(null); // { email, name }

  // [gap E4 2026-05-20] Debounced active-speaker mirror for focus mode.
  // We expose `displayedSpeaker` separately from `activeSpeakerEmail` so
  // the halo (which can flicker fast) keeps the snappy feel while the
  // big focus tile only swaps after ACTIVE_SPEAKER_DEBOUNCE_MS of
  // sustained speaking.
  const [displayedSpeaker, setDisplayedSpeaker] = useState(null);
  const _speakerDebounceTimerRef = useRef(null);
  useEffect(() => {
    if (!activeSpeakerEmail) return;
    if (activeSpeakerEmail === displayedSpeaker) return;
    if (_speakerDebounceTimerRef.current) {
      try { clearTimeout(_speakerDebounceTimerRef.current); } catch {}
    }
    _speakerDebounceTimerRef.current = setTimeout(() => {
      setDisplayedSpeaker(activeSpeakerEmail);
    }, ACTIVE_SPEAKER_DEBOUNCE_MS);
    return () => {
      if (_speakerDebounceTimerRef.current) {
        try { clearTimeout(_speakerDebounceTimerRef.current); } catch {}
        _speakerDebounceTimerRef.current = null;
      }
    };
  }, [activeSpeakerEmail, displayedSpeaker]);

  // Add-member pill press anim — soft scale-down on press for tactility.
  const pillScale = useState(new Animated.Value(1))[0];
  // Recording badge pulse — slow opacity wobble for visibility.
  const recPulse = useRef(new Animated.Value(0.7)).current;
  // Active-speaker tile pulse driver — shared across all tiles, each one
  // multiplies its halo opacity by the same value so the pulse is in sync.
  const speakerPulse = useRef(new Animated.Value(0)).current;
  // Connecting skeleton shimmer — gentle opacity breathe so the avatar
  // placeholders read as "loading" rather than a static empty grid.
  const skeletonPulse = useRef(new Animated.Value(0)).current;

  // Compute my role — derived from `role` carried on the participant entry
  // (LiveKit metadata mirrored from chat_call_roles) with a fallback for
  // the caller path that just started the room (we're host until the
  // backend says otherwise).
  const myEmail = (user?.email || '').toLowerCase();
  const myEntry = participants.find(p => (p.email || '').toLowerCase() === myEmail);
  const myRoleFromList = Number(myEntry?.role || 0);
  // If the WebView hasn't reported a role yet, assume host when we're the
  // caller OR when `host_email` matches us. Conservative default = guest.
  const myRoleFallback = isCaller || (hostEmailParam && hostEmailParam.toLowerCase() === myEmail)
    ? ROLE.HOST
    : ROLE.GUEST;
  const myRole = myRoleFromList || myRoleFallback;
  const isHostOrCohost = myRole >= ROLE.COHOST;

  useEffect(() => {
    // Watchdog: se não conseguir token+livekit-room.html em 10s, surface o erro
    // ao invés de ficar "Conectando..." pra sempre. Antes (round 67) o user
    // ficava infinito porque o token vinha rápido mas o WebView falhava em
    // carregar lk.chatyy.com.br (NXDOMAIN) sem feedback nenhum.
    const watchdog = setTimeout(() => {
      if (!token) {
        setErr(t('call.connectError') || 'Falha ao conectar à sala. Tente novamente.');
      }
    }, 12000);
    (async () => {
      try {
        const r = await api.chatLivekitToken(Number(conversation_id) || 0, room || '');
        if (r?.success && r.data?.token) {
          setToken(r.data.token);
          setLivekitUrl(r.data.url || 'wss://livekit.chatyy.com.br');
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
              role: m.role || 0,
            })).filter(p => p.email));
          }
          // Initial locked/recording state from backend payload — both
          // optional fields, default false.
          if (typeof r.data.locked === 'boolean' || r.data.locked === 1 || r.data.locked === 0) {
            setLocked(!!r.data.locked);
          }
          if (typeof r.data.recording === 'boolean' || r.data.recording === 1 || r.data.recording === 0) {
            setRecording(!!r.data.recording);
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
    return () => clearTimeout(watchdog);
  }, [conversation_id, room]);

  // ─── WebSocket subscriptions for cross-client call events ───
  // Even though the LiveKit DataChannel is the primary fan-out for in-room
  // events, we subscribe to the WS too because (a) clients on the mesh
  // fallback can't see DataChannel msgs, (b) host actions (lock, record,
  // mute-all) are emitted server-side bypassing the data plane.
  useEffect(() => {
    let mailWs = null;
    try { mailWs = require('../services/websocket').default; } catch {}
    if (!mailWs) return;

    const unsubs = [];

    // call_reaction — any participant fires a reaction. We render the burst
    // even when it's our own (so we get visual confirmation immediately).
    unsubs.push(mailWs.on?.('call_reaction', (data) => {
      if (!data || data.call_id !== (roomName || room)) return;
      if (typeof data.emoji !== 'string') return;
      _addReactionBurst(data.emoji, data.from_email || '');
    }) || (() => {}));

    // call_hand_raise — keep a small ordered list. raised=true adds; false
    // removes. We dedupe by email so a double-press doesn't duplicate.
    unsubs.push(mailWs.on?.('call_hand_raise', (data) => {
      if (!data || data.call_id !== (roomName || room)) return;
      const email = (data.email || data.from_email || '').toLowerCase();
      if (!email) return;
      setRaisedHands(prev => {
        const filtered = prev.filter(h => h.email !== email);
        if (data.raised) {
          return [...filtered, { email, name: data.name || email.split('@')[0], ts: Date.now() }];
        }
        return filtered;
      });
    }) || (() => {}));

    // call_mute_request — backend tells me to mute. Forward into the
    // WebView; LiveKit room HTML handles the actual setMicrophoneEnabled.
    unsubs.push(mailWs.on?.('call_mute_request', (data) => {
      if (!data || data.call_id !== (roomName || room)) return;
      _postToWebView({ type: 'force_mute' });
    }) || (() => {}));

    // call_force_end — host removed me. Bail out cleanly.
    unsubs.push(mailWs.on?.('call_force_end', (data) => {
      if (!data || data.call_id !== (roomName || room)) return;
      Alert.alert(
        t('call.group.removed') || 'Participante removido',
        t('call.group.removedByHost') || 'O host removeu você da chamada.',
        [{ text: 'OK', onPress: () => router.back() }]
      );
    }) || (() => {}));

    // Lock / unlock state — sync from server.
    unsubs.push(mailWs.on?.('call_locked', (data) => {
      if (!data || data.call_id !== (roomName || room)) return;
      setLocked(!!data.locked);
    }) || (() => {}));

    // Recording state — show the top banner on every client.
    unsubs.push(mailWs.on?.('call_recording_started', (data) => {
      if (!data || data.call_id !== (roomName || room)) return;
      setRecording(true);
    }) || (() => {}));
    unsubs.push(mailWs.on?.('call_recording_stopped', (data) => {
      if (!data || data.call_id !== (roomName || room)) return;
      setRecording(false);
    }) || (() => {}));

    return () => { unsubs.forEach(fn => { try { fn?.(); } catch {} }); };
  }, [roomName, room, router, t]);

  // ─── Recording badge pulse ───
  useEffect(() => {
    if (!recording) {
      recPulse.setValue(0.7);
      return;
    }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(recPulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.timing(recPulse, { toValue: 0.55, duration: 700, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [recording, recPulse]);

  // ─── Active-speaker pulse driver ───
  // Shared loop animation. Each speaking tile multiplies the halo glow by
  // this value so all of them pulse in lockstep (visually calmer than
  // independent loops per tile).
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(speakerPulse, { toValue: 1, duration: SPEAKER_PULSE_MS / 2, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
      Animated.timing(speakerPulse, { toValue: 0, duration: SPEAKER_PULSE_MS / 2, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [speakerPulse]);

  // ─── Connecting skeleton shimmer ───
  // Lightweight opacity breathe (native driver) shared by every skeleton
  // tile so the connecting grid feels alive without per-tile loops.
  useEffect(() => {
    if (token) return; // only while the placeholder grid is up
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(skeletonPulse, { toValue: 1, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(skeletonPulse, { toValue: 0, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [token, skeletonPulse]);

  // origin extrai só o host:port — antes mantinha o path do BASE_URL e
  // gerava URLs tipo `/api/livekit-room.html` que não existem.
  const origin = (() => { try { return new URL(BASE_URL).origin; } catch { return BASE_URL; } })();
  // Pass features=raisehand to the LiveKit room HTML so the hosted UI knows
  // to render the raise-hand button (LiveKit metadata-based; gracefully
  // ignored by older /livekit-room.html builds that don't read the param).
  // We also pass features=reactions,pinning,nativechrome so the WebView
  // knows the native shell is painting these affordances and it should
  // skip its own.
  const pageUrl = token
    ? `${origin}/livekit-room.html?token=${encodeURIComponent(token)}&url=${encodeURIComponent(livekitUrl || 'wss://livekit.chatyy.com.br')}&room=${encodeURIComponent(roomName)}&video=${video === '1' ? '1' : '0'}&features=raisehand,noise,reactions,pinning,nativechrome`
    : null;

  // ─── Helpers ───

  const _postToWebView = useCallback((msg) => {
    // postMessage shape mirrors /livekit-room.html's onmessage handler.
    try {
      const json = JSON.stringify(msg);
      if (webViewRef.current && webViewRef.current.injectJavaScript) {
        webViewRef.current.injectJavaScript(`window.postMessage(${JSON.stringify(json)}, '*'); true;`);
      }
    } catch {}
  }, []);

  const _wsSend = useCallback((payload) => {
    try {
      const ws = require('../services/websocket').default;
      if (ws?._send) ws._send(payload);
    } catch {}
  }, []);

  // Reaction burst — pushes a new floating emoji, animates upward, evicts.
  const _addReactionBurst = useCallback((emoji, _fromEmail) => {
    const id = Date.now() + Math.random();
    const x = 40 + Math.random() * (SCREEN_W - 120);
    const anim = new Animated.Value(0);
    setReactions(prev => {
      const next = [...prev, { id, emoji, x, anim }];
      // Cap queue size so a spam doesn't pile up.
      return next.length > 12 ? next.slice(-12) : next;
    });
    Animated.timing(anim, {
      toValue: 1,
      duration: 1800,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(() => {
      setReactions(prev => prev.filter(r => r.id !== id));
    });
  }, []);

  const sendReaction = useCallback((emoji) => {
    _addReactionBurst(emoji, myEmail);
    // Fan via WS so peers without LK DataChannel still see it.
    _wsSend({
      type: 'call_reaction',
      call_id: roomName || room,
      conversation_id: conversation_id,
      emoji,
      from_email: myEmail,
    });
    // ALSO ask the LiveKit room HTML to broadcast over the DataChannel —
    // this is what gets to other LK participants <100ms instead of via WS.
    _postToWebView({ type: 'reaction', emoji });
    setShowReactionBar(false);
  }, [_addReactionBurst, _wsSend, _postToWebView, roomName, room, conversation_id, myEmail]);

  // ─── Participant action handlers (wired into both sheets) ───

  const handleMuteParticipant = useCallback(async (targetEmail) => {
    if (!targetEmail) return;
    try {
      await api.chatCallMuteParticipant(Number(conversation_id) || 0, roomName || room, targetEmail);
    } catch (e) { if (__DEV__) console.warn('[GroupCall.mute]', e?.message); }
  }, [conversation_id, roomName, room]);

  const handleRemoveParticipant = useCallback(async (targetEmail) => {
    if (!targetEmail) return;
    try {
      await api.chatCallRemoveParticipant(Number(conversation_id) || 0, roomName || room, targetEmail);
      setParticipants(prev => prev.filter(p => (p.email || '').toLowerCase() !== targetEmail.toLowerCase()));
    } catch (e) { if (__DEV__) console.warn('[GroupCall.remove]', e?.message); }
  }, [conversation_id, roomName, room]);

  const handleMakeCoHost = useCallback(async (targetEmail) => {
    if (!targetEmail) return;
    try {
      await api.chatCallMakeCoHost(Number(conversation_id) || 0, roomName || room, targetEmail);
      setParticipants(prev => prev.map(p =>
        (p.email || '').toLowerCase() === targetEmail.toLowerCase()
          ? { ...p, role: ROLE.COHOST }
          : p
      ));
    } catch (e) { if (__DEV__) console.warn('[GroupCall.cohost]', e?.message); }
  }, [conversation_id, roomName, room]);

  const handlePin = useCallback((targetEmail, pinned) => {
    setPinnedEmail(pinned ? targetEmail : '');
    // Forward into the WebView so /livekit-room.html keeps the tile in
    // the foreground (the LK Room object lives there).
    _postToWebView({ type: pinned ? 'pin' : 'unpin', email: targetEmail });
  }, [_postToWebView]);

  // [gap E3 2026-05-20] Silence / unsilence a specific remote for me only.
  // Posts `set_remote_volume` (0 or 1) to the WebView so livekit-room.html
  // calls RemoteParticipant.setVolume on the LK side. Tracks state locally
  // for the menu toggle indicator. Does NOT mute the participant globally;
  // peers still hear them.
  const handleToggleSilenceForMe = useCallback((targetEmail) => {
    if (!targetEmail) return;
    const k = String(targetEmail).toLowerCase();
    setSilencedEmails(prev => {
      const isOn = !!prev[k];
      const next = { ...prev };
      if (isOn) delete next[k]; else next[k] = 1;
      _postToWebView({ type: 'set_remote_volume', email: k, volume: isOn ? 1 : 0 });
      return next;
    });
  }, [_postToWebView]);

  // ─── Host-only handlers ───

  const handleMuteAll = useCallback(async () => {
    try {
      await api.chatCallMuteAll(Number(conversation_id) || 0, roomName || room);
    } catch (e) { if (__DEV__) console.warn('[GroupCall.muteAll]', e?.message); }
  }, [conversation_id, roomName, room]);

  const handleToggleLock = useCallback(async (next) => {
    setLocked(next); // optimistic
    try {
      await api.chatCallSetLocked(Number(conversation_id) || 0, roomName || room, next);
    } catch (e) {
      setLocked(!next); // revert
      if (__DEV__) console.warn('[GroupCall.lock]', e?.message);
    }
  }, [conversation_id, roomName, room]);

  const handleToggleRecording = useCallback(async (next) => {
    setRecording(next);
    try {
      await api.chatCallSetRecording(Number(conversation_id) || 0, roomName || room, next);
    } catch (e) {
      setRecording(!next);
      if (__DEV__) console.warn('[GroupCall.record]', e?.message);
    }
  }, [conversation_id, roomName, room]);

  const handleShareLink = useCallback(async () => {
    try {
      const r = await api.chatCallCreateLink(Number(conversation_id) || 0, roomName || room);
      const url = r?.data?.url;
      if (!url) return { copied: false };
      // Native share sheet if available (better UX than just clipboard
      // copy — user picks WhatsApp/iMessage/etc directly).
      let copied = false;
      try {
        if (Clipboard?.setStringAsync) {
          await Clipboard.setStringAsync(url);
          copied = true;
        }
      } catch {}
      try {
        if (Platform.OS !== 'web' && Share?.share) {
          await Share.share({ message: url, url });
        }
      } catch {}
      return { url, copied };
    } catch (e) {
      if (__DEV__) console.warn('[GroupCall.shareLink]', e?.message);
      return { copied: false };
    }
  }, [conversation_id, roomName, room]);

  // Compose the "Add person" CTA used by both the floating pill and the
  // participant sheet header. Routes back to chat-conversation with the
  // addMember intent so we reuse the existing picker.
  const openAddPerson = useCallback(() => {
    try {
      router.push({
        pathname: '/chat-conversation',
        params: { conversation_id: String(conversation_id || ''), addMember: '1', call_id: roomName || room || '' },
      });
    } catch {}
  }, [router, conversation_id, roomName, room]);

  // ─── Render bits ───

  // Native grid skeleton — only shown while we don't have the live LiveKit
  // WebView feed. Builds a fixed-cell grid so cells don't reflow when the
  // count changes.
  //
  // [gap E4 2026-05-20] >4 participants → focus layout: big active-speaker
  // tile (75% height) + horizontal filmstrip with everyone else (scroll-x).
  // 4-or-fewer keeps the original 2x2 grid.
  const ParticipantGrid = useMemo(() => {
    if (!participants.length) return null;
    const mode = pickGridCols(participants.length);
    // Halo opacity shared across modes.
    const haloOpacity = speakerPulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.85] });
    // Connecting-skeleton shimmer — gentle opacity breathe over the avatar
    // placeholders while we don't yet have the live LiveKit feed.
    const connecting = !token;
    const shimmerOpacity = skeletonPulse.interpolate({ inputRange: [0, 1], outputRange: [0.04, 0.16] });

    const renderTile = (p, size, opts = {}) => {
      const isSpeaking = activeSpeakerEmail && p.email === activeSpeakerEmail;
      const isSilenced = !!silencedEmails[(p.email || '').toLowerCase()];
      return (
        <Pressable
          key={p.email}
          onLongPress={() => setParticipantMenu({ email: p.email, name: p.name })}
          delayLongPress={350}
          style={[styles.gridCell, { width: size + 16, height: size + 40 }, opts.cellStyle]}
        >
          <View style={[
            styles.avatarShell,
            { width: size, height: size, borderRadius: size / 2 },
            isSpeaking && styles.avatarShellSpeaking,
            (pinnedEmail || '').toLowerCase() === (p.email || '').toLowerCase() && styles.avatarShellPinned,
          ]}>
            {isSpeaking && (
              <Animated.View style={[
                styles.speakerHalo,
                { width: size + 8, height: size + 8, borderRadius: (size + 8) / 2, opacity: haloOpacity },
              ]} />
            )}
            <AvatarCircle email={p.email} name={p.name} size={size - 8} />
            {connecting && (
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.skeletonShimmer,
                  { borderRadius: size / 2, opacity: shimmerOpacity },
                ]}
              />
            )}
            {isSilenced && (
              <View style={styles.silencedBadge}>
                <Svg width={12} height={12} viewBox="0 0 24 24" fill="none">
                  <SvgPath
                    d="M23 9l-6 6M17 9l6 6M15 8.94V5a3 3 0 0 0-6 0v6m6 1v3a3 3 0 0 1-6 0v-1m6-3l-9 9"
                    stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
                  />
                </Svg>
              </View>
            )}
          </View>
          <Text style={styles.gridName} numberOfLines={1}>{p.name}</Text>
        </Pressable>
      );
    };

    if (mode === 'focus') {
      // Resolve who occupies the big tile. Preference order:
      //   1. pinned participant (user explicitly chose them)
      //   2. debounced active speaker
      //   3. first non-self participant
      //   4. first participant
      const pinnedLc = (pinnedEmail || '').toLowerCase();
      const speakerLc = (displayedSpeaker || '').toLowerCase();
      let primary = participants.find(p => (p.email || '').toLowerCase() === pinnedLc);
      if (!primary) primary = participants.find(p => (p.email || '').toLowerCase() === speakerLc);
      if (!primary) primary = participants.find(p => (p.email || '').toLowerCase() !== myEmail);
      if (!primary) primary = participants[0];
      const others = participants.filter(p => p !== primary);

      // Match the rest of the screen — 75% available height for the
      // big tile, 25% for the filmstrip. Use Dimensions to size deterministically
      // so the layout doesn't reflow when participant.length changes.
      const bigSize = Math.min(SCREEN_W - 40, 320);
      const stripSize = 76;
      return (
        <View style={{ flex: 1 }}>
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 }}>
            {primary ? renderTile(primary, bigSize, { cellStyle: { marginBottom: 8 } }) : null}
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}
            style={{ flexGrow: 0 }}
          >
            {others.map(p => renderTile(p, stripSize))}
          </ScrollView>
        </View>
      );
    }

    // Default: 2x2 grid for <=4 participants.
    const cellSize = 140;
    return (
      <View
        style={{ flex: 1 }}
      >
        <View style={[styles.gridWrap, { paddingHorizontal: 16 }]}>
          {participants.map(p => renderTile(p, cellSize))}
        </View>
      </View>
    );
  }, [participants, activeSpeakerEmail, displayedSpeaker, speakerPulse, skeletonPulse, token, pinnedEmail, silencedEmails, myEmail]);

  // Floating reaction layer — sits above the WebView. Each reaction
  // animates upward + fades out.
  const ReactionsLayer = (
    <View pointerEvents="none" style={styles.reactionsLayer}>
      {reactions.map(({ id, emoji, x, anim }) => {
        const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [0, -360] });
        const opacity = anim.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 1, 0] });
        const scale = anim.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0.6, 1.2, 1] });
        return (
          <Animated.Text
            key={id}
            style={[
              styles.reactionEmoji,
              { left: x, transform: [{ translateY }, { scale }], opacity },
            ]}
          >
            {emoji}
          </Animated.Text>
        );
      })}
    </View>
  );

  // Raise-hand banner — surfaces ordered queue. Shows top hand + "+N more"
  // when more than one. Tap → opens participant sheet so host can address it.
  const HandsBanner = raisedHands.length > 0 ? (
    <TouchableOpacity
      activeOpacity={0.85}
      style={styles.handsBanner}
      onPress={() => setShowParticipants(true)}
    >
      <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
        <SvgPath d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6.5-2.9L1 15a2.83 2.83 0 0 1 4-4l3 3" stroke="#fbbf24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
      <Text style={styles.handsBannerText} numberOfLines={1}>
        {raisedHands.length === 1
          ? (t('call.group.handsBanner') || '{name} raised their hand').replace('{name}', raisedHands[0].name)
          : (t('call.group.handsBannerMore') || '{name} and {count} more raised their hand')
              .replace('{name}', raisedHands[0].name)
              .replace('{count}', String(raisedHands.length - 1))
        }
      </Text>
    </TouchableOpacity>
  ) : null;

  // Recording banner — full-width top strip. Pulsing red dot to draw the
  // eye. We render it for EVERYONE in the room (legal consent rule).
  const RecordingBanner = recording ? (
    <View style={styles.recBanner}>
      <Animated.View style={[styles.recPill, { opacity: recPulse }]}>
        <View style={styles.recDot} />
        <Text style={styles.recPillText}>REC</Text>
      </Animated.View>
      <Text style={styles.recBannerText}>{t('call.group.recordedBadge') || 'Being recorded'}</Text>
    </View>
  ) : null;

  // Header — tap on "X participantes" opens the sheet. Top-right has the
  // host gear (host/cohost only) + add-person.
  const Header = (
    <View pointerEvents="box-none" style={styles.headerWrap}>
      <View style={styles.headerInner}>
        <TouchableOpacity
          onPress={() => setShowParticipants(true)}
          style={styles.participantPill}
          activeOpacity={0.8}
        >
          <Svg width={14} height={14} viewBox="0 0 24 24" fill="none">
            <SvgPath d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M23 21v-2a4 4 0 0 0-3-3.87M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM16 3.13a4 4 0 0 1 0 7.75" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
          <Text style={styles.participantPillText}>
            {participants.length} {t('call.group.participants') || 'participantes'}
          </Text>
        </TouchableOpacity>
        <View style={styles.headerRight}>
          {locked && (
            <View style={styles.lockChip}>
              <Svg width={10} height={10} viewBox="0 0 24 24" fill="none">
                <SvgPath d="M5 11h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM7 11V7a5 5 0 0 1 10 0v4" stroke="#fff" strokeWidth={2} strokeLinejoin="round" />
              </Svg>
              <Text style={styles.lockChipText}>{t('call.group.lockOn') || 'Locked'}</Text>
            </View>
          )}
          <TouchableOpacity
            onPress={openAddPerson}
            style={styles.headerIconBtn}
            accessibilityLabel={t('call.addParticipant') || 'Add'}
          >
            <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
              <SvgPath d="M19 8v6M16 11h6M9 11a4 4 0 100-8 4 4 0 000 8zM3 21a6 6 0 0112 0" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            </Svg>
          </TouchableOpacity>
          {isHostOrCohost && (
            <TouchableOpacity
              onPress={() => setShowHostControls(true)}
              style={[styles.headerIconBtn, recording && styles.headerIconBtnRec]}
              accessibilityLabel={t('call.group.hostControls') || 'Host controls'}
            >
              <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
                <SvgPath d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="#fff" strokeWidth={2} strokeLinejoin="round" />
              </Svg>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );

  // Reaction bar — small floating row of 6 emojis above the add-member
  // pill. Tap toggles the bar; tap emoji fires + closes.
  const ReactionBar = (
    <View pointerEvents="box-none" style={styles.reactionBarWrap}>
      {showReactionBar && (
        <View style={styles.reactionBar}>
          {REACTION_EMOJIS.map((e) => (
            <TouchableOpacity key={e} onPress={() => sendReaction(e)} style={styles.reactionBtn}>
              <Text style={styles.reactionBtnText}>{e}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
      <TouchableOpacity
        onPress={() => setShowReactionBar(s => !s)}
        style={styles.reactionToggle}
        accessibilityLabel={t('call.reactions') || 'Reactions'}
      >
        <IconSmile size={22} color="#fff" />
      </TouchableOpacity>
    </View>
  );

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
        onPress={openAddPerson}
        style={styles.pill}
      >
        <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
          <SvgPath d="M19 8v6M16 11h6M9 11a4 4 0 100-8 4 4 0 000 8zM3 21a6 6 0 0112 0" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
        <Text style={styles.pillText}>{t('call.addParticipant') || 'Adicionar pessoa'}</Text>
      </TouchableOpacity>
    </Animated.View>
  );

  // Sheets — kept at the top of the tree so they overlay everything.
  const Sheets = (
    <>
      <CallParticipantList
        visible={showParticipants}
        onClose={() => setShowParticipants(false)}
        participants={participants}
        myEmail={myEmail}
        myRole={myRole}
        pinnedEmail={pinnedEmail}
        onMute={handleMuteParticipant}
        onRemove={handleRemoveParticipant}
        onMakeCoHost={handleMakeCoHost}
        onPin={handlePin}
        onAddPerson={openAddPerson}
      />
      <HostControlsSheet
        visible={showHostControls}
        onClose={() => setShowHostControls(false)}
        myRole={myRole}
        locked={locked}
        recording={recording}
        onMuteAll={handleMuteAll}
        onToggleLock={handleToggleLock}
        onToggleRecording={handleToggleRecording}
        onShareLink={handleShareLink}
      />
      {/* [gap E3 + E4 long-press menu, 2026-05-20] Per-participant actions.
          Includes "Silenciar pra mim" (local mute) + Pin/Unpin. Host actions
          (mute remote, remove, promote) live in the participant list sheet. */}
      {participantMenu ? (
        <View style={styles.menuOverlay} pointerEvents="box-none">
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setParticipantMenu(null)}
          />
          <View style={styles.menuSheet}>
            <Text style={styles.menuTitle} numberOfLines={1}>
              {participantMenu.name || participantMenu.email}
            </Text>
            <TouchableOpacity
              style={styles.menuRow}
              onPress={() => {
                const target = participantMenu.email;
                setParticipantMenu(null);
                handleToggleSilenceForMe(target);
              }}
            >
              <Text style={styles.menuRowText}>
                {silencedEmails[(participantMenu.email || '').toLowerCase()]
                  ? (t('call.group.unsilenceForMe') || 'Cancelar silêncio pra mim')
                  : (t('call.group.silenceForMe') || 'Silenciar pra mim')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.menuRow}
              onPress={() => {
                const target = participantMenu.email;
                const isPinned = (pinnedEmail || '').toLowerCase() === (target || '').toLowerCase();
                setParticipantMenu(null);
                handlePin(target, !isPinned);
              }}
            >
              <Text style={styles.menuRowText}>
                {(pinnedEmail || '').toLowerCase() === (participantMenu.email || '').toLowerCase()
                  ? (t('call.group.unpin') || 'Desafixar')
                  : (t('call.group.pin') || 'Fixar')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.menuRow, styles.menuCancel]}
              onPress={() => setParticipantMenu(null)}
            >
              <Text style={[styles.menuRowText, { color: '#9ca3af' }]}>
                {t('common.cancel') || 'Cancelar'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
    </>
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
        {RecordingBanner}
        {Header}
        {HandsBanner}
        {ReactionsLayer}
        {ReactionBar}
        {AddMemberPill}
        {Sheets}
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
        ref={webViewRef}
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
                role: Number(m.role || 0),
                isSpeaking: !!m.isSpeaking || !!m.is_speaking,
                muted: !!m.muted,
                videoOn: !!m.videoOn || !!m.video_on,
                handRaised: !!m.handRaised || !!m.hand_raised,
              })).filter(p => p.email));
            }
            // Reactions received over the LK DataChannel — paint native
            // burst so the animation is GPU-smooth (vs the WebView SVG path).
            if (msg.type === 'reaction' && typeof msg.emoji === 'string') {
              _addReactionBurst(msg.emoji, msg.from_email || '');
            }
            // 'raise_hand' / 'lower_hand' from the LiveKit room HTML are
            // forwarded through the WS so peers on the mesh side (older
            // builds, audio-only etc.) see the same indicator. We also
            // mirror locally into raisedHands so our own banner shows it.
            if (msg.type === 'raise_hand' || msg.type === 'lower_hand') {
              const email = (msg.email || myEmail || '').toLowerCase();
              const raised = msg.type === 'raise_hand';
              setRaisedHands(prev => {
                const filtered = prev.filter(h => h.email !== email);
                if (raised) return [...filtered, { email, name: msg.name || email.split('@')[0], ts: Date.now() }];
                return filtered;
              });
              _wsSend({
                type: 'call_hand_raise',
                call_id: msg.call_id || roomName || room,
                conversation_id: conversation_id,
                raised,
                name: msg.name,
                email,
              });
            }
            // Room state mirror — locked / recording changes coming from
            // the LK room metadata (set by the host's chatCallSetLocked /
            // chatCallSetRecording → LK metadata update → WebView surfaces).
            if (msg.type === 'room_state') {
              if (typeof msg.locked === 'boolean') setLocked(msg.locked);
              if (typeof msg.recording === 'boolean') setRecording(msg.recording);
            }
          } catch {}
        }}
      />
      {RecordingBanner}
      {Header}
      {HandsBanner}
      {ReactionsLayer}
      {ReactionBar}
      {AddMemberPill}
      {Sheets}
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
    gap: 12,
  },
  gridCell: {
    alignItems: 'center',
    justifyContent: 'flex-start',
    margin: 0,
  },
  avatarShell: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  // Active-speaker ring — calm 3px emerald green (Meet/WhatsApp affordance).
  // Clear active indication with a soft matching glow, no flashing.
  avatarShellSpeaking: {
    borderWidth: 3,
    borderColor: SPEAKER_RING,
    shadowColor: SPEAKER_RING,
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  // Pinned tile gets a purple ring — communicates "manually held in
  // foreground" vs the green "currently speaking".
  avatarShellPinned: {
    borderColor: BRAND_PURPLE,
  },
  // Speaker pulse halo — a thin green ring just outside the avatar that
  // breathes with the shared animation driver.
  speakerHalo: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: SPEAKER_RING,
    backgroundColor: 'transparent',
  },
  // Connecting skeleton shimmer — soft white wash over placeholder avatars.
  skeletonShimmer: {
    position: 'absolute',
    top: 4,
    left: 4,
    right: 4,
    bottom: 4,
    backgroundColor: '#fff',
  },
  gridName: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 8,
    maxWidth: 140,
    textAlign: 'center',
    letterSpacing: -0.1,
  },
  // [gap E3] Silenced-for-me badge — sits bottom-right of avatar to flag
  // "you've muted them locally" so the user doesn't think they're silent.
  silencedBadge: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#ef4444',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#000',
  },
  // [gap E3+E4] Long-press participant action menu — bottom-sheet overlay.
  menuOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  menuSheet: {
    backgroundColor: '#1c1c1e',
    paddingTop: 12,
    paddingBottom: 28,
    paddingHorizontal: 16,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
  },
  menuTitle: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
    paddingBottom: 12,
    opacity: 0.7,
  },
  menuRow: {
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
  menuRowText: {
    color: '#fff',
    fontSize: 16,
    textAlign: 'center',
  },
  menuCancel: {
    marginTop: 6,
    borderTopWidth: 0,
  },
  connectingHud: {
    position: 'absolute',
    bottom: 60,
    left: 0,
    right: 0,
    alignItems: 'center',
  },

  // Header — top bar with participant count + host gear.
  headerWrap: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 52 : 32,
    left: 0,
    right: 0,
    zIndex: 60,
  },
  headerInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  participantPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
  },
  participantPillText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerIconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerIconBtnRec: {
    borderWidth: 1.5,
    borderColor: REC_RED,
  },
  lockChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: 'rgba(124,58,237,0.4)',
    borderRadius: 10,
  },
  lockChipText: { color: '#fff', fontSize: 10, fontWeight: '700' },

  // Recording banner — top of screen, full-width strip.
  recBanner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingTop: Platform.OS === 'ios' ? 50 : 20,
    paddingBottom: 6,
    backgroundColor: 'rgba(220,38,38,0.18)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    zIndex: 55,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(220,38,38,0.4)',
  },
  // REC pill — small red rounded badge with a dot + "REC" label. The whole
  // pill gently pulses (recPulse) so it reads as actively recording.
  recPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: REC_RED,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  recDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: '#fff' },
  recPillText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.8 },
  recBannerText: { color: '#fff', fontSize: 12, fontWeight: '700', letterSpacing: 0.2 },

  // Raised-hand banner — small chip below the header.
  handsBanner: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 100 : 80,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.5)',
    zIndex: 56,
    maxWidth: '85%',
  },
  handsBannerText: { color: '#fff', fontSize: 13, fontWeight: '600', flexShrink: 1 },

  // Floating reaction layer + bar.
  reactionsLayer: {
    position: 'absolute',
    bottom: 90,
    left: 0,
    right: 0,
    height: 360,
    overflow: 'hidden',
    zIndex: 40,
  },
  reactionEmoji: {
    position: 'absolute',
    bottom: 0,
    fontSize: 40,
  },
  reactionBarWrap: {
    position: 'absolute',
    bottom: 86,
    left: 16,
    alignItems: 'flex-start',
    zIndex: 45,
  },
  reactionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.75)',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 22,
    marginBottom: 8,
  },
  reactionBtn: { paddingHorizontal: 6, paddingVertical: 4 },
  reactionBtnText: { fontSize: 24 },
  reactionToggle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reactionToggleText: { fontSize: 22 },

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
