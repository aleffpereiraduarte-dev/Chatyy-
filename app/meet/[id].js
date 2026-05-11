import { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, TextInput, StyleSheet, Platform, ActivityIndicator, Alert, TouchableOpacity, AppState, Linking } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import * as api from '../../services/api';
import MeetControls from '../../components/MeetControls';
import MeetChatPanel from '../../components/MeetChatPanel';
import MeetParticipantsPanel from '../../components/MeetParticipantsPanel';
import MeetReactionsOverlay from '../../components/MeetReactionsOverlay';
import MeetPollPanel from '../../components/MeetPollPanel';
import MeetNotesPanel from '../../components/MeetNotesPanel';
import MeetCaptionsOverlay from '../../components/MeetCaptionsOverlay';
import MeetBreakoutPanel from '../../components/MeetBreakoutPanel';
import MeetMoreMenu from '../../components/MeetMoreMenu';
import MeetVirtualBgPicker from '../../components/MeetVirtualBgPicker';
import { IconFlashlight, IconLock, IconUnlock, IconHome, IconImage, IconBarChart, IconEdit, IconMessageSquare, IconPaperclip, IconInfo, IconUsers, IconScreenShare, IconMicOff, IconVideoOff } from '../../components/Icons';

// Grid layout math: 1=>1x1, 2=>1x2, 3-4=>2x2, 5-9=>3x3, 10-16=>4x4, 17-25=>5x5, 26-32=>6x6
function gridDimensions(count) {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  if (count <= 9) return { cols: 3, rows: 3 };
  if (count <= 16) return { cols: 4, rows: 4 };
  if (count <= 25) return { cols: 5, rows: 5 };
  return { cols: 6, rows: 6 };
}
function layoutLabel(count, t) {
  if (count <= 2) return null;
  const { cols, rows } = gridDimensions(count);
  return `${cols}x${rows}`;
}

let WebView = null;
if (Platform.OS !== 'web') {
  try { WebView = require('react-native-webview').default; } catch {}
}

const MEET_BASE = 'https://chatyy.com.br/meet/room.html';

export default function MeetScreen() {
  const { id: roomId, video } = useLocalSearchParams();
  const { user } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lobbyWaiting, setLobbyWaiting] = useState(false);
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

  // Participants & lobby
  const [showParticipants, setShowParticipants] = useState(false);
  const [participants, setParticipants] = useState([]);
  const [lobbyPeers, setLobbyPeers] = useState([]);

  // Reactions
  const [reactions, setReactions] = useState([]);
  const reactionIdRef = useRef(0);

  // Hand raised
  const [handRaised, setHandRaised] = useState(false);

  // Polls
  const [showPolls, setShowPolls] = useState(false);
  const [polls, setPolls] = useState([]);

  // Notes
  const [showNotes, setShowNotes] = useState(false);
  const [meetingNotes, setMeetingNotes] = useState('');

  // Captions
  const [captionsEnabled, setCaptionsEnabled] = useState(false);
  const [captions, setCaptions] = useState([]);
  const captionIdRef = useRef(0);

  // Breakout rooms
  const [showBreakout, setShowBreakout] = useState(false);
  const [breakoutRooms, setBreakoutRooms] = useState([]);

  // More menu
  const [showMore, setShowMore] = useState(false);

  // Virtual background
  const [showVirtualBg, setShowVirtualBg] = useState(false);
  const [virtualBgEffect, setVirtualBgEffect] = useState(null);

  // File sharing & spotlight
  const [sharedFiles, setSharedFiles] = useState([]);
  const [spotlightPeerId, setSpotlightPeerId] = useState(null);

  // Mic / camera permission state — surface explicit "permission denied" UI
  // instead of letting the call silently fail with a generic connection error.
  const [audioPermissionDenied, setAudioPermissionDenied] = useState(false);
  const [videoPermissionDenied, setVideoPermissionDenied] = useState(false);

  const notesTimerRef = useRef(null);
  const pendingTimersRef = useRef([]);
  const webViewRef = useRef(null);
  const iframeRef = useRef(null);
  // Holds the active screen MediaStream captured via getDisplayMedia (web only)
  const screenStreamRef = useRef(null);

  // Join meeting via API
  const attemptJoin = async (password) => {
    try {
      const params = { room_id: roomId };
      if (password) params.password = password;
      const r = await api.apiCall('meet_join', params, 'POST');
      if (r.success) {
        setNeedsPassword(false);
        setPasswordError('');
        if (r.data?.status === 'waiting') {
          setLobbyWaiting(true);
          setLoading(false);
        } else {
          setIsHost(r.data?.is_host || r.data?.your_role === 'host' || false);
          setMeetingTitle(r.data?.meeting?.title || '');
          setParticipants(r.data?.participants || []);
          setLoading(false);
        }
      } else if (r.data?.requires_password) {
        setNeedsPassword(true);
        setLoading(false);
        // If we just submitted a password and got 400/401 back, surface inline error
        // instead of an Alert. Detect via status code or wrong-password messaging.
        if (password && (r.status === 400 || r.status === 401 || /password|senha|contrase/i.test(r.message || ''))) {
          setPasswordError(t('meet.passwordWrong') || 'Senha incorreta');
        }
      } else {
        setError(r.message || t('meetScreen.joinFailed'));
        setLoading(false);
      }
    } catch (e) {
      try { console.warn('[meet] attemptJoin error', e); } catch {}
      setError(t('meetScreen.connectionError'));
      setLoading(false);
    }
  };

  useEffect(() => {
    if (roomId) attemptJoin();
  }, [roomId]);

  // Check mic/cam permissions on mount — on web we probe via getUserMedia
  // and surface explicit denied state. On native the WebView triggers the
  // OS prompt; we only flip the denied flags if the WebView reports them.
  useEffect(() => {
    let cancelled = false;
    if (Platform.OS !== 'web') return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;

    const wantsVideo = video !== 'off';
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: wantsVideo });
        // Permission granted — release tracks immediately, the iframe will
        // request its own stream. We only used this to detect the denial.
        try { stream.getTracks().forEach(t => t.stop()); } catch {}
      } catch (err) {
        if (cancelled) return;
        const name = err?.name || '';
        // NotAllowedError / SecurityError == user denied. Other errors
        // (NotFoundError, NotReadableError) we treat as denial too so the
        // user gets a clear "fix your permissions" message instead of a
        // generic connection error.
        if (/NotAllowed|SecurityError|Permission|NotFound|NotReadable/i.test(name) || /denied|permission/i.test(err?.message || '')) {
          // We can't reliably tell which track failed, so flag both when
          // we asked for both. If only audio was requested, only flip audio.
          setAudioPermissionDenied(true);
          if (wantsVideo) setVideoPermissionDenied(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [roomId, video]);

  const openSystemSettings = useCallback(() => {
    if (Platform.OS === 'web') {
      // Browsers don't expose a programmatic way to jump to the site
      // permission UI — best we can do is surface a hint and let the
      // user fix it manually, then reload.
      try {
        if (typeof window !== 'undefined') {
          window.alert(t('meet.permissionDeniedHintWeb') || 'Permita microfone/câmera nas configurações do navegador.');
        }
      } catch {}
      return;
    }
    try { Linking.openSettings(); } catch {}
  }, [t]);

  // Reconnect when app returns from background
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && roomId && !ended && !error) {
        // Re-join to refresh connection state
        attemptJoin();
      }
    });
    return () => sub.remove();
  }, [roomId, ended, error]);

  // Leave meeting + cleanup timers on unmount
  useEffect(() => {
    return () => {
      api.meetLeave(roomId).catch(() => {});
      pendingTimersRef.current.forEach(id => clearTimeout(id));
      pendingTimersRef.current = [];
      if (notesTimerRef.current) clearTimeout(notesTimerRef.current);
      // Stop any active screen share stream (web) so the OS recording indicator clears
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach(t => t.stop());
        screenStreamRef.current = null;
      }
      if (typeof window !== 'undefined') window.__screenStream = null;
    };
  }, [roomId]);

  const displayName = user?.name || user?.email || t('meetScreen.guest');
  const meetUrl = `${MEET_BASE}?id=${encodeURIComponent(roomId)}&token=${encodeURIComponent(api.getAuthToken() || '')}&name=${encodeURIComponent(displayName)}&webview=${Platform.OS !== 'web' ? '1' : '0'}&video=${video === 'off' ? '0' : '1'}`;

  // Inject JS into WebView/iframe
  const injectJS = useCallback((code) => {
    if (Platform.OS === 'web') {
      try {
        // Parse "window.meetController.methodName(...)" into structured {action, args}
        const stripped = code.replace('window.meetController.', '');
        const parenIdx = stripped.indexOf('(');
        let action, args;
        if (parenIdx === -1) {
          action = stripped;
          args = [];
        } else {
          action = stripped.substring(0, parenIdx);
          const argsStr = stripped.substring(parenIdx + 1, stripped.lastIndexOf(')'));
          if (argsStr.trim()) {
            try {
              // Parse args as JSON array elements
              args = JSON.parse('[' + argsStr + ']');
            } catch {
              args = [argsStr];
            }
          } else {
            args = [];
          }
        }
        const msg = { action, args };
        iframeRef.current?.contentWindow?.postMessage(JSON.stringify(msg), 'https://chatyy.com.br');
      } catch {}
    } else if (webViewRef.current) {
      webViewRef.current.injectJavaScript(`${code}; true;`);
    }
  }, []);

  // Handle messages from WebView/iframe
  const handleMessage = useCallback((event) => {
    let msg;
    try {
      if (Platform.OS === 'web') {
        msg = typeof event.data === 'object' ? event.data : JSON.parse(event.data);
      } else {
        msg = JSON.parse(event.nativeEvent.data);
      }
    } catch { return; }

    switch (msg.type) {
      case 'joined':
        setParticipantCount(msg.participantCount || 1);
        break;
      case 'peer_joined':
        setParticipantCount(prev => msg.participantCount || prev + 1);
        setParticipants(prev => [...prev.filter(p => p.peerId !== msg.peerId), {
          peerId: msg.peerId, displayName: msg.displayName, email: msg.email,
          audioMuted: false, videoMuted: false, handRaised: false,
        }]);
        break;
      case 'peer_left':
        setParticipantCount(prev => msg.participantCount || Math.max(1, prev - 1));
        setParticipants(prev => prev.filter(p => p.peerId !== msg.peerId));
        break;
      case 'audio_muted':
        setAudioMuted(msg.muted);
        break;
      case 'video_muted':
        setVideoMuted(msg.muted);
        break;
      case 'screen_share_started':
        setScreenSharing(true);
        break;
      case 'screen_share_stopped':
        // Also stop any tracks we captured natively (web) so the browser
        // "Stop sharing" indicator disappears from the OS toolbar.
        if (Platform.OS === 'web' && screenStreamRef.current) {
          screenStreamRef.current.getTracks().forEach(t => t.stop());
          screenStreamRef.current = null;
          if (typeof window !== 'undefined') window.__screenStream = null;
        }
        setScreenSharing(false);
        break;
      case 'chat_message': {
        // Skip if this is our own message echoed back (already added locally in handleSendChat)
        const isSelf = msg.isSelf || (msg.displayName && displayName && msg.displayName === displayName);
        if (isSelf) {
          // Check if we already have this message locally to avoid duplication
          setChatMessages(prev => {
            const hasDuplicate = prev.some(m => m.isLocal && m.message === msg.message && Math.abs((m.timestamp || 0) - (msg.timestamp || Date.now())) < 5000);
            if (hasDuplicate) return prev;
            return [...prev, { displayName: msg.displayName, message: msg.message, timestamp: msg.timestamp }];
          });
        } else {
          setChatMessages(prev => [...prev, { displayName: msg.displayName, message: msg.message, timestamp: msg.timestamp }]);
        }
        if (!showChatRef.current) setUnreadChat(prev => prev + 1);
        break;
      }
      case 'left':
        setEnded(true);
        pendingTimersRef.current.push(setTimeout(() => router.back(), 1500));
        break;
      case 'error':
        // Surface explicit permission-denied UI when the iframe reports
        // getUserMedia failure, instead of a generic connection error.
        if (msg.message && /camera|microphone|media|permission|access denied|allowed/i.test(msg.message)) {
          setAudioPermissionDenied(true);
          if (video !== 'off') setVideoPermissionDenied(true);
        } else {
          setError(msg.message);
        }
        break;

      // ─── New handlers ───
      case 'hand_raised':
        setParticipants(prev => prev.map(p =>
          p.peerId === msg.peerId ? { ...p, handRaised: true } : p
        ));
        break;
      case 'hand_lowered':
        setParticipants(prev => prev.map(p =>
          p.peerId === msg.peerId ? { ...p, handRaised: false } : p
        ));
        break;
      case 'reaction': {
        const id = ++reactionIdRef.current;
        const r = { id, emoji: msg.emoji, displayName: msg.displayName, timestamp: Date.now() };
        setReactions(prev => [...prev.slice(-9), r]);
        pendingTimersRef.current.push(setTimeout(() => setReactions(prev => prev.filter(x => x.id !== id)), 3500));
        break;
      }
      case 'lobby_pending':
        setLobbyPeers(prev => [...prev.filter(p => p.peerId !== msg.peerId),
          { peerId: msg.peerId, displayName: msg.displayName, email: msg.email }]);
        break;
      case 'lobby_admitted':
        setLobbyWaiting(false);
        setLoading(false);
        break;
      case 'lobby_denied':
        setError(t('meetScreen.lobbyDenied'));
        setLobbyWaiting(false);
        break;
      case 'mute_update':
        setParticipants(prev => prev.map(p =>
          p.peerId === msg.peerId ? { ...p, audioMuted: msg.audio, videoMuted: msg.video } : p
        ));
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
      case 'meeting_ended':
        setEnded(true);
        pendingTimersRef.current.push(setTimeout(() => router.back(), 2000));
        break;
      case 'kicked':
        setEnded(true);
        setError(t('meetScreen.kicked'));
        pendingTimersRef.current.push(setTimeout(() => router.back(), 2000));
        break;

      // ─── Polls ───
      case 'poll_created':
        setPolls(prev => [...prev, { id: msg.pollId, question: msg.question, options: msg.options.map(t => ({ text: t, votes: 0 })), active: true, myVote: null }]);
        break;
      case 'poll_vote':
        setPolls(prev => prev.map(p => p.id === msg.pollId ? { ...p, options: p.options.map((o, i) => i === msg.optionIndex ? { ...o, votes: (o.votes || 0) + 1 } : o) } : p));
        break;

      // ─── Notes ───
      case 'notes_updated':
        setMeetingNotes(msg.text || '');
        break;

      // ─── Captions ───
      case 'caption': {
        const capId = ++captionIdRef.current;
        const cap = { id: capId, speaker: msg.displayName || t('meetScreen.unknownSpeaker'), text: msg.text };
        setCaptions(prev => [...prev.slice(-9), cap]);
        pendingTimersRef.current.push(setTimeout(() => setCaptions(prev => prev.filter(c => c.id !== capId)), 5000));
        break;
      }

      // ─── File sharing ───
      case 'file_shared': {
        const file = { name: msg.fileName, url: msg.fileUrl, sender: msg.displayName, timestamp: Date.now() };
        setSharedFiles(prev => [...prev, file]);
        setChatMessages(prev => [...prev, { displayName: msg.displayName, message: t('meetScreen.fileShared', { name: msg.fileName }), timestamp: Date.now() }]);
        break;
      }

      // ─── Virtual Background ───
      case 'bg_effect_changed':
        if (msg.effect === 'none') setVirtualBgEffect(null);
        else if (msg.effect === 'blur') setVirtualBgEffect('blur');
        else if (msg.effect === 'blur-light') setVirtualBgEffect('blur-light');
        else if (msg.effect === 'gradient') setVirtualBgEffect('gradient:' + (msg.name || ''));
        else if (msg.effect === 'image') setVirtualBgEffect(msg.url || 'image');
        break;

      // ─── Spotlight ───
      case 'spotlight':
        setSpotlightPeerId(msg.peerId || null);
        break;

      // ─── Breakout rooms ───
      case 'breakout_created':
        setBreakoutRooms(msg.rooms || []);
        break;
      case 'breakout_ended':
        setBreakoutRooms([]);
        break;
    }
  }, []);

  // Web: listen for iframe messages
  useEffect(() => {
    if (Platform.OS === 'web') {
      window.addEventListener('message', handleMessage);
      return () => window.removeEventListener('message', handleMessage);
    }
  }, [handleMessage]);

  const handleEndCall = useCallback(() => {
    const doLeave = () => {
      injectJS('window.meetController.leaveRoom()');
      api.meetLeave(roomId).catch(() => {});
      // Reset mute/video state so the next call doesn't inherit a stuck
      // muted flag from a previous session — WhatsApp/Zoom behavior.
      setAudioMuted(false);
      setVideoMuted(false);
      setEnded(true);
      setTimeout(() => router.back(), 500);
    };
    if (Platform.OS === 'web') {
      if (!window.confirm(t('meetScreen.leaveConfirm'))) return;
      doLeave();
    } else {
      Alert.alert(
        t('meetScreen.leave'),
        t('meetScreen.leaveConfirm'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('meetScreen.leave'), style: 'destructive', onPress: doLeave },
        ]
      );
    }
  }, [roomId, injectJS]);

  const handleToggleChat = useCallback(() => {
    setShowChat(prev => {
      const next = !prev;
      showChatRef.current = next;
      if (next) { setShowParticipants(false); setShowPolls(false); setShowNotes(false); setShowBreakout(false); setShowVirtualBg(false); }
      return next;
    });
    setUnreadChat(0);
  }, []);

  const handleToggleParticipants = useCallback(() => {
    const wasOpen = showParticipants;
    setShowParticipants(prev => !prev);
    if (!wasOpen) { setShowChat(false); setShowPolls(false); setShowNotes(false); setShowBreakout(false); setShowVirtualBg(false); }
  }, [showParticipants]);

  const handleSendChat = useCallback((text) => {
    const msgId = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    injectJS(`window.meetController.sendChat(${JSON.stringify(text)})`);
    setChatMessages(prev => [...prev, { id: msgId, displayName: displayName + ' (You)', message: text, timestamp: Date.now(), isLocal: true }]);
  }, [injectJS, displayName]);

  // ─── Screen Sharing ───
  const _stopScreenShareWeb = useCallback(() => {
    // Stop all tracks on the captured stream
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(t => t.stop());
      screenStreamRef.current = null;
    }
    // Clean up the global stash used by the iframe
    if (typeof window !== 'undefined') {
      window.__screenStream = null;
    }
    // Tell the iframe to revert to camera track
    injectJS('window.meetController.stopScreenShare()');
    setScreenSharing(false);
  }, [injectJS]);

  const handleToggleScreenShare = useCallback(async () => {
    if (Platform.OS !== 'web') {
      // Screen sharing is not supported inside a native WebView — getDisplayMedia
      // requires a top-level browser context and is unavailable on iOS/Android.
      // Button is rendered disabled with a caption; this no-op is a safety net.
      return;
    }

    if (screenSharing) {
      _stopScreenShareWeb();
      return;
    }

    // ── Start screen sharing (web) ──────────────────────────────────────────
    // getDisplayMedia() must be called from a user-gesture handler in the
    // top-level browsing context (this React app), NOT inside the iframe.
    // We capture the stream here, stash it on window.__screenStream, then
    // inject code into the iframe that grabs the track from window.parent
    // and replaces the video sender — no room.html changes needed.
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: false,
      });

      screenStreamRef.current = stream;
      // Expose for the iframe to consume
      window.__screenStream = stream;

      const screenTrack = stream.getVideoTracks()[0];
      if (!screenTrack) {
        // No video track returned — bail out
        stream.getTracks().forEach(t => t.stop());
        screenStreamRef.current = null;
        window.__screenStream = null;
        return;
      }

      // When the user clicks "Stop sharing" in the browser's built-in bar,
      // the track ends automatically — mirror that here.
      screenTrack.onended = () => {
        _stopScreenShareWeb();
      };

      // Inject into iframe: grab the track from window.parent.__screenStream
      // and replace the outbound video sender track.
      injectJS(`(function() {
        try {
          var stream = window.parent.__screenStream;
          if (!stream) return;
          var track = stream.getVideoTracks()[0];
          if (!track) return;
          // Replace the outbound video track in every peer connection
          if (window._peerConnections) {
            window._peerConnections.forEach(function(pc) {
              pc.getSenders().forEach(function(sender) {
                if (sender.track && sender.track.kind === 'video') {
                  sender.replaceTrack(track);
                }
              });
            });
          } else if (window.meetController && window.meetController._pc) {
            // Fallback for single-peer implementations
            var senders = window.meetController._pc.getSenders();
            senders.forEach(function(sender) {
              if (sender.track && sender.track.kind === 'video') {
                sender.replaceTrack(track);
              }
            });
          } else {
            // Broadest fallback: scan all RTCPeerConnection senders via the
            // existing stopScreenShare/startScreenShare path in room.html.
            // Override getDisplayMedia to return our already-captured stream,
            // then call startScreenShare normally.
            var orig = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.getDisplayMedia = function() {
              navigator.mediaDevices.getDisplayMedia = orig;
              return Promise.resolve(window.parent.__screenStream);
            };
            if (window.meetController && window.meetController.startScreenShare) {
              window.meetController.startScreenShare();
              return; // startScreenShare will post screen_share_started itself
            }
          }
          // Show the screen track in the local video tile if room.html supports it
          if (window.meetController && window.meetController._localVideo) {
            window.meetController._localVideo.srcObject = stream;
          }
          // Notify the host / other peers
          if (window.meetController && window.meetController._notifyHost) {
            window.meetController._notifyHost({ type: 'screen_share_started' });
          }
        } catch(e) {}
      })()`);

      setScreenSharing(true);
    } catch (err) {
      // User cancelled the picker or permission denied — not an error worth showing
      if (err && err.name !== 'NotAllowedError') {
        if (typeof window !== 'undefined') {
          window.alert(t('meetScreen.screenShareFailed'));
        }
      }
    }
  }, [screenSharing, injectJS, t, _stopScreenShareWeb]);

  const handleRaiseHand = useCallback(() => {
    setHandRaised(prev => {
      injectJS(prev ? 'window.meetController.lowerHand()' : 'window.meetController.raiseHand()');
      return !prev;
    });
  }, [injectJS]);

  const handleReaction = useCallback((emoji) => {
    injectJS(`window.meetController.sendReaction('${emoji}')`);
    const id = ++reactionIdRef.current;
    setReactions(prev => [...prev.slice(-9), { id, emoji, displayName: 'You', timestamp: Date.now() }]);
    setTimeout(() => setReactions(prev => prev.filter(x => x.id !== id)), 3500);
  }, [injectJS]);

  const handleToggleRecording = useCallback(() => {
    if (recording) {
      api.meetStopRecording(roomId).catch(() => {});
      injectJS('window.meetController.stopRecording && window.meetController.stopRecording()');
    } else {
      api.meetStartRecording(roomId).catch(() => {});
      injectJS('window.meetController.startRecording && window.meetController.startRecording()');
    }
    setRecording(prev => !prev);
  }, [recording, roomId, injectJS]);

  const handleToggleLock = useCallback(() => {
    if (roomLocked) {
      api.meetUnlock(roomId).catch(() => {});
      injectJS('window.meetController.unlockRoom()');
    } else {
      api.meetLock(roomId).catch(() => {});
      injectJS('window.meetController.lockRoom()');
    }
    setRoomLocked(prev => !prev);
  }, [roomLocked, roomId, injectJS]);

  // Participant panel callbacks
  const handleAdmit = useCallback((peerId) => {
    injectJS(`window.meetController.admitFromLobby('${peerId}')`);
    setLobbyPeers(prev => prev.filter(p => p.peerId !== peerId));
  }, [injectJS]);

  const handleDeny = useCallback((peerId) => {
    injectJS(`window.meetController.denyFromLobby('${peerId}')`);
    setLobbyPeers(prev => prev.filter(p => p.peerId !== peerId));
  }, [injectJS]);

  const handleKick = useCallback((peerId) => {
    injectJS(`window.meetController.kickParticipant('${peerId}')`);
    setParticipants(prev => prev.filter(p => p.peerId !== peerId));
  }, [injectJS]);

  const handleMutePeer = useCallback((peerId) => {
    injectJS(`window.meetController.muteParticipant('${peerId}')`);
  }, [injectJS]);

  const handlePromote = useCallback((peerId) => {
    const peer = participants.find(p => p.peerId === peerId);
    if (peer?.email) api.meetPromote(roomId, peer.email).catch(() => {});
  }, [participants, roomId]);

  // ─── Polls ───
  const handleCreatePoll = useCallback((question, options) => {
    injectJS(`window.meetController.sendData && window.meetController.sendData(${JSON.stringify({ type: 'poll_created', pollId: 'poll_' + Date.now(), question, options })})`);
    const pollId = 'poll_' + Date.now();
    setPolls(prev => [...prev, { id: pollId, question, options: options.map(t => ({ text: t, votes: 0 })), active: true, myVote: null }]);
  }, [injectJS]);

  const handleVotePoll = useCallback((pollId, optionIndex) => {
    injectJS(`window.meetController.sendData && window.meetController.sendData(${JSON.stringify({ type: 'poll_vote', pollId, optionIndex })})`);
    setPolls(prev => prev.map(p => p.id === pollId ? { ...p, myVote: optionIndex, options: p.options.map((o, i) => i === optionIndex ? { ...o, votes: (o.votes || 0) + 1 } : o) } : p));
  }, [injectJS]);

  // ─── Notes ───
  const handleUpdateNotes = useCallback((text) => {
    setMeetingNotes(text);
    if (notesTimerRef.current) clearTimeout(notesTimerRef.current);
    notesTimerRef.current = setTimeout(() => {
      injectJS(`window.meetController.sendData && window.meetController.sendData(${JSON.stringify({ type: 'notes_updated', text })})`);
    }, 2000);
  }, [injectJS]);

  // ─── Captions ───
  const handleToggleCaptions = useCallback(() => {
    setCaptionsEnabled(prev => {
      const next = !prev;
      injectJS(next
        ? 'window.meetController.startCaptions && window.meetController.startCaptions()'
        : 'window.meetController.stopCaptions && window.meetController.stopCaptions()');
      return next;
    });
  }, [injectJS]);

  // ─── File sharing ───
  const handleShareFile = useCallback(async () => {
    try {
      if (Platform.OS === 'web') {
        const input = document.createElement('input');
        input.type = 'file';
        input.onchange = async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const form = new FormData();
          form.append('file', file);
          form.append('room_id', roomId);
          const r = await api.apiCall('meet_upload_file', form, 'POST');
          if (r.success) {
            injectJS(`window.meetController.sendData && window.meetController.sendData(${JSON.stringify({ type: 'file_shared', fileName: file.name, fileUrl: r.data?.file_url })})`);
          }
        };
        input.click();
      }
    } catch {}
  }, [roomId, injectJS]);

  // ─── Spotlight ───
  const handleSpotlight = useCallback((peerId) => {
    injectJS(`window.meetController.spotlightPeer && window.meetController.spotlightPeer('${peerId}')`);
    setSpotlightPeerId(peerId);
  }, [injectJS]);

  // ─── Breakout rooms ───
  const handleCreateBreakout = useCallback((rooms, timerSec) => {
    const payload = JSON.stringify({ type: 'breakout_created', rooms, timerSec });
    injectJS(`window.meetController.sendData && window.meetController.sendData(${payload})`);
    setBreakoutRooms(rooms);
  }, [injectJS]);

  const handleEndBreakout = useCallback(() => {
    injectJS('window.meetController.sendData && window.meetController.sendData({ type: "breakout_ended" })');
    setBreakoutRooms([]);
  }, [injectJS]);

  // ─── Toggle helpers for panels ───
  const closeAllPanels = useCallback(() => {
    setShowChat(false);
    setShowParticipants(false);
    setShowPolls(false);
    setShowNotes(false);
    setShowBreakout(false);
    setShowMore(false);
    setShowVirtualBg(false);
  }, []);

  const handleTogglePolls = useCallback(() => {
    setShowPolls(prev => {
      if (!prev) { setShowChat(false); setShowParticipants(false); setShowNotes(false); setShowBreakout(false); setShowMore(false); setShowVirtualBg(false); }
      return !prev;
    });
  }, []);

  const handleToggleNotes = useCallback(() => {
    setShowNotes(prev => {
      if (!prev) { setShowChat(false); setShowParticipants(false); setShowPolls(false); setShowBreakout(false); setShowMore(false); setShowVirtualBg(false); }
      return !prev;
    });
  }, []);

  const handleToggleBreakout = useCallback(() => {
    setShowBreakout(prev => {
      if (!prev) { setShowChat(false); setShowParticipants(false); setShowPolls(false); setShowNotes(false); setShowMore(false); setShowVirtualBg(false); }
      return !prev;
    });
  }, []);

  const handleToggleMore = useCallback(() => {
    setShowMore(prev => !prev);
  }, []);

  // ─── Virtual Background ───
  const handleToggleVirtualBg = useCallback(() => {
    setShowVirtualBg(prev => {
      if (!prev) { setShowChat(false); setShowParticipants(false); setShowPolls(false); setShowNotes(false); setShowBreakout(false); setShowMore(false); }
      return !prev;
    });
  }, []);

  const handleSelectVirtualBg = useCallback((type, value) => {
    if (type === 'none') {
      injectJS('window.meetController.setVirtualBackground("none")');
      setVirtualBgEffect(null);
    } else if (type === 'blur') {
      injectJS('window.meetController.setVirtualBackground("blur")');
      setVirtualBgEffect('blur');
    } else if (type === 'blur-light') {
      injectJS('window.meetController.setVirtualBackground("blur-light")');
      setVirtualBgEffect('blur-light');
    } else if (type === 'gradient') {
      injectJS(`window.meetController.setVirtualBackground("gradient", ${JSON.stringify(value)})`);
      setVirtualBgEffect('gradient:' + value);
    } else if (type === 'image') {
      injectJS(`window.meetController.setVirtualBackground("image", ${JSON.stringify(value)})`);
      setVirtualBgEffect(value);
    }
  }, [injectJS]);

  // ─── More menu options ───
  const moreMenuOptions = [
    // Collaboration
    { section: t('meetScreen.collaboration'), label: t('meetScreen.polls'), icon: IconBarChart, onPress: handleTogglePolls },
    { section: t('meetScreen.collaboration'), label: t('meetScreen.meetingNotes'), icon: IconEdit, onPress: handleToggleNotes },
    { section: t('meetScreen.collaboration'), label: t('meetScreen.shareFile'), icon: IconPaperclip, onPress: handleShareFile },
    // Media
    { section: t('meetScreen.media'), label: virtualBgEffect ? t('meetScreen.changeBackground') : t('meetScreen.virtualBackground'), icon: IconImage, onPress: handleToggleVirtualBg },
    { section: t('meetScreen.media'), label: captionsEnabled ? t('meetScreen.disableCaptions') : t('meetScreen.enableCaptions'), icon: IconMessageSquare, onPress: handleToggleCaptions },
    // Host Controls
    ...(isHost ? [
      { section: t('meetScreen.controls'), label: spotlightPeerId ? t('meetScreen.removeSpotlight') : t('meetScreen.spotlightSpeaker'), icon: IconFlashlight, onPress: () => handleSpotlight(spotlightPeerId ? null : '') },
      { section: t('meetScreen.controls'), label: recording ? t('meetScreen.stopRecording') : t('meetScreen.startRecording'), icon: null, onPress: handleToggleRecording },
      { section: t('meetScreen.controls'), label: roomLocked ? t('meetScreen.unlockRoom') : t('meetScreen.lockRoom'), icon: roomLocked ? IconUnlock : IconLock, onPress: handleToggleLock },
      { section: t('meetScreen.controls'), label: t('meetScreen.breakoutRooms'), icon: IconHome, onPress: handleToggleBreakout },
    ] : []),
    // Info
    { section: t('meetScreen.info'), label: t('meetScreen.meetingInfo'), icon: IconInfo, onPress: () => {
      const info = `${t('meetScreen.room')}: ${roomId}\n${t('meetScreen.participantsLabel')}: ${participantCount}`;
      if (Platform.OS === 'web') window.alert(info);
      else Alert.alert(t('meetScreen.meetingInfo'), info);
    }},
  ];

  // ─── Password prompt ───
  if (needsPassword) {
    return (
      <View style={s.centered}>
        <Text style={s.lobbyText}>{t('meetScreen.passwordRequired')}</Text>
        <TextInput
          style={s.passwordInput}
          value={passwordInput}
          onChangeText={(v) => { setPasswordInput(v); if (passwordError) setPasswordError(''); }}
          placeholder={t('meetScreen.passwordPlaceholder')}
          placeholderTextColor="#64748b"
          secureTextEntry
          autoFocus
          accessibilityLabel={t('meet.passwordLabel') || 'Senha da sala'}
          onSubmitEditing={() => { setLoading(true); attemptJoin(passwordInput); }}
        />
        {passwordError ? (
          <Text style={{ color: '#ef4444', fontSize: 13, marginTop: 8, textAlign: 'center' }}>
            {passwordError}
          </Text>
        ) : null}
        <TouchableOpacity
          onPress={() => { setLoading(true); attemptJoin(passwordInput); }}
          style={[s.lobbyBackBtn, { backgroundColor: '#3b82f6' }]}
        >
          <Text style={[s.lobbyBackText, { color: '#fff' }]}>{t('meetScreen.enter')}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.back()} style={s.lobbyBackBtn}>
          <Text style={s.lobbyBackText}>{t('common.cancel')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ─── Permission denied ───
  if (audioPermissionDenied || videoPermissionDenied) {
    const both = audioPermissionDenied && videoPermissionDenied;
    const bodyKey = both
      ? 'meet.permissionDeniedBody'
      : (audioPermissionDenied ? 'meet.permissionDeniedBodyAudio' : 'meet.permissionDeniedBodyVideo');
    const warning = '#f59e0b';
    return (
      <View style={[s.centered, { paddingHorizontal: 32 }]}>
        <View style={{
          width: 80, height: 80, borderRadius: 40,
          backgroundColor: warning + '15',
          alignItems: 'center', justifyContent: 'center', marginBottom: 16,
        }}>
          {videoPermissionDenied && !audioPermissionDenied
            ? <IconVideoOff size={36} color={warning} />
            : <IconMicOff size={36} color={warning} />}
        </View>
        <Text style={{ fontSize: 18, fontWeight: '700', color: '#fff', marginBottom: 8, textAlign: 'center' }}>
          {t('meet.permissionDeniedTitle')}
        </Text>
        <Text style={{ fontSize: 14, color: '#94a3b8', textAlign: 'center', marginBottom: 20, maxWidth: 320, lineHeight: 20 }}>
          {t(bodyKey)}
        </Text>
        <TouchableOpacity
          onPress={openSystemSettings}
          style={{ backgroundColor: '#3b82f6', paddingVertical: 12, paddingHorizontal: 24, borderRadius: 10 }}
        >
          <Text style={{ color: '#fff', fontWeight: '600' }}>{t('meet.openSettings')}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.back()} style={[s.lobbyBackBtn, { marginTop: 12 }]}>
          <Text style={s.lobbyBackText}>{t('common.cancel')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ─── Loading ───
  if (loading) {
    return (
      <View style={s.centered}>
        <ActivityIndicator size="large" color="#3b82f6" />
        <Text style={s.statusText}>{t('meetScreen.connecting')}</Text>
      </View>
    );
  }

  // ─── Lobby waiting ───
  if (lobbyWaiting) {
    return (
      <View style={s.centered}>
        <ActivityIndicator size="large" color="#3b82f6" />
        <Text style={s.lobbyText}>{t('meetScreen.lobbyWaiting')}</Text>
        <TouchableOpacity onPress={() => router.back()} style={s.lobbyBackBtn}>
          <Text style={s.lobbyBackText}>{t('common.cancel')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ─── Error ───
  if (error && !ended) {
    return (
      <View style={s.centered}>
        <Text style={s.errorText}>{error}</Text>
        <Text style={s.statusText} onPress={() => router.back()}>{t('meetScreen.goBack')}</Text>
      </View>
    );
  }

  // ─── Ended ───
  if (ended) {
    return (
      <View style={s.centered}>
        <Text style={s.endedText}>{t('meetScreen.ended')}</Text>
      </View>
    );
  }

  // ─── Recording banner ───
  const RecordingBanner = recording ? (
    <View style={s.recordingBanner}>
      <View style={s.recordingDot} />
      <Text style={s.recordingText}>REC</Text>
    </View>
  ) : null;

  // ─── Screen sharing banner ───
  const ScreenShareBanner = screenSharing ? (
    <TouchableOpacity
      style={s.screenShareBanner}
      onPress={Platform.OS === 'web' ? _stopScreenShareWeb : () => { injectJS('window.meetController.stopScreenShare()'); setScreenSharing(false); }}
      activeOpacity={0.8}
      accessibilityLabel={t('meetScreen.stopSharing')}
      accessibilityRole="button"
    >
      <IconScreenShare size={16} color="#fff" />
      <Text style={s.screenShareBannerText}>{t('meetScreen.youAreSharing')}</Text>
      <View style={s.stopShareBtn}>
        <Text style={s.stopShareBtnText}>{t('meetScreen.stopSharing')}</Text>
      </View>
    </TouchableOpacity>
  ) : null;

  // ─── Meeting title bar (and participant count badge) ───
  const isGroupCall = participantCount > 2;
  const gridLabel = layoutLabel(participantCount, t);
  const TitleBar = (meetingTitle || isGroupCall) ? (
    <View style={s.titleBar}>
      {meetingTitle ? (
        <Text style={s.titleText} numberOfLines={1}>{meetingTitle}</Text>
      ) : (
        <Text style={s.titleText} numberOfLines={1}>
          {isGroupCall ? (t('meetScreen.groupCall') || 'Chamada em grupo') : ''}
        </Text>
      )}
      {roomLocked && <IconLock size={14} color="#e2e8f0" style={{ marginLeft: 8 }} />}
    </View>
  ) : null;

  // Participant count badge — always visible, grid-aware (1-on-1 stays minimal)
  const ParticipantBadge = (
    <TouchableOpacity
      onPress={handleToggleParticipants}
      style={s.participantBadge}
      accessibilityLabel={t('meetScreen.participantsLabel') || 'Participants'}
      accessibilityRole="button"
    >
      <IconUsers size={13} color="#fff" />
      <Text style={s.participantBadgeText}>{participantCount}</Text>
      {gridLabel && (
        <Text style={s.participantBadgeGrid}>{gridLabel}</Text>
      )}
    </TouchableOpacity>
  );

  // Shared panels
  const panels = (
    <>
      <MeetReactionsOverlay reactions={reactions} />
      <MeetCaptionsOverlay enabled={captionsEnabled} captions={captions} />
      <MeetControls
        audioMuted={audioMuted}
        videoMuted={videoMuted}
        screenSharing={screenSharing}
        handRaised={handRaised}
        isHost={isHost}
        recording={recording}
        onToggleAudio={() => injectJS('window.meetController.toggleAudio()')}
        onToggleVideo={() => injectJS('window.meetController.toggleVideo()')}
        onScreenShare={handleToggleScreenShare}
        onStopScreenShare={Platform.OS === 'web' ? _stopScreenShareWeb : () => { injectJS('window.meetController.stopScreenShare()'); setScreenSharing(false); }}
        screenShareDisabled={Platform.OS !== 'web'}
        screenShareDisabledLabel={Platform.OS !== 'web' ? (t('meetScreen.screenShareWebOnly') || 'Compartilhar tela disponível só na web') : undefined}
        onEndCall={handleEndCall}
        onToggleChat={handleToggleChat}
        onToggleParticipants={handleToggleParticipants}
        onRaiseHand={handleRaiseHand}
        onReaction={handleReaction}
        onToggleRecording={handleToggleRecording}
        onToggleLock={handleToggleLock}
        onTogglePolls={handleTogglePolls}
        onToggleNotes={handleToggleNotes}
        onToggleCaptions={handleToggleCaptions}
        onToggleBreakout={handleToggleBreakout}
        onToggleMore={handleToggleMore}
        onToggleVirtualBg={handleToggleVirtualBg}
        virtualBgActive={!!virtualBgEffect}
        captionsEnabled={captionsEnabled}
        participantCount={participantCount}
        unreadChat={unreadChat}
        lobbyCount={lobbyPeers.length}
      />
      <MeetChatPanel
        visible={showChat}
        messages={chatMessages}
        onSend={handleSendChat}
        onClose={() => { setShowChat(false); showChatRef.current = false; setUnreadChat(0); }}
      />
      <MeetParticipantsPanel
        visible={showParticipants}
        onClose={() => setShowParticipants(false)}
        participants={participants}
        lobbyPeers={lobbyPeers}
        isHost={isHost}
        onAdmit={handleAdmit}
        onDeny={handleDeny}
        onKick={handleKick}
        onMute={handleMutePeer}
        onPromote={handlePromote}
      />
      <MeetPollPanel
        visible={showPolls}
        onClose={() => setShowPolls(false)}
        polls={polls}
        onCreatePoll={handleCreatePoll}
        onVote={handleVotePoll}
        isHost={isHost}
      />
      <MeetNotesPanel
        visible={showNotes}
        onClose={() => setShowNotes(false)}
        notes={meetingNotes}
        onUpdateNotes={handleUpdateNotes}
      />
      <MeetBreakoutPanel
        visible={showBreakout}
        onClose={() => setShowBreakout(false)}
        isHost={isHost}
        breakoutRooms={breakoutRooms}
        onCreateBreakout={handleCreateBreakout}
        onEndBreakout={handleEndBreakout}
      />
      <MeetMoreMenu
        visible={showMore}
        onClose={() => setShowMore(false)}
        isHost={isHost}
        options={moreMenuOptions}
      />
      <MeetVirtualBgPicker
        visible={showVirtualBg}
        onClose={() => setShowVirtualBg(false)}
        onSelect={handleSelectVirtualBg}
        currentEffect={virtualBgEffect}
      />
    </>
  );

  // ─── Web: iframe ───
  if (Platform.OS === 'web') {
    return (
      <View style={s.container}>
        {TitleBar}
        {RecordingBanner}
        {ScreenShareBanner}
        <iframe
          ref={iframeRef}
          src={meetUrl}
          style={{ width: '100%', flex: 1, border: 'none', background: '#111827' }}
          allow="camera; microphone; display-capture; autoplay"
        />
        {panels}
      </View>
    );
  }

  // ─── Mobile: WebView ───
  if (!WebView) {
    return (
      <View style={s.centered}>
        <Text style={s.errorText}>WebView not available</Text>
      </View>
    );
  }

  return (
    <View style={[s.container, { paddingTop: insets.top }]}>
      {TitleBar}
      {ParticipantBadge}
      {RecordingBanner}
      {ScreenShareBanner}
      <WebView
        ref={webViewRef}
        source={{ uri: meetUrl }}
        onMessage={handleMessage}
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback={true}
        mediaCapturePermissionGrantType="grant"
        javaScriptEnabled={true}
        domStorageEnabled={true}
        originWhitelist={['*']}
        style={{ flex: 1, backgroundColor: '#111827' }}
      />
      {panels}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111827' },
  centered: {
    flex: 1, backgroundColor: '#111827',
    justifyContent: 'center', alignItems: 'center', padding: 24,
  },
  statusText: { color: '#94a3b8', fontSize: 16, marginTop: 16 },
  errorText: { color: '#f87171', fontSize: 18, fontWeight: '600', textAlign: 'center' },
  endedText: { color: '#fff', fontSize: 20, fontWeight: '600' },
  lobbyText: { color: '#e2e8f0', fontSize: 18, fontWeight: '500', marginTop: 20, textAlign: 'center' },
  lobbyBackBtn: { marginTop: 24, paddingVertical: 10, paddingHorizontal: 24, borderRadius: 8, backgroundColor: '#374151' },
  lobbyBackText: { color: '#94a3b8', fontSize: 16 },
  passwordInput: {
    width: 260, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    borderRadius: 8, paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: 'rgba(255,255,255,0.05)', color: '#fff', fontSize: 16,
    marginTop: 16, textAlign: 'center',
  },
  titleBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 8, paddingHorizontal: 16, backgroundColor: '#1f2937',
  },
  titleText: { color: '#e2e8f0', fontSize: 14, fontWeight: '600', flex: 1, textAlign: 'center' },
  recordingBanner: {
    position: 'absolute', top: 60, left: 16, zIndex: 100,
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(220, 38, 38, 0.9)', borderRadius: 6,
    paddingVertical: 4, paddingHorizontal: 10,
  },
  recordingDot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: '#fff', marginRight: 6,
  },
  recordingText: { color: '#fff', fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  screenShareBanner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#3b82f6', paddingVertical: 8, paddingHorizontal: 16,
    gap: 12,
  },
  screenShareBannerText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  stopShareBtn: {
    backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 6,
    paddingHorizontal: 12, paddingVertical: 4,
  },
  stopShareBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  participantBadge: {
    position: 'absolute', top: 60, right: 16, zIndex: 100,
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(17, 24, 39, 0.82)',
    borderRadius: 14, paddingVertical: 5, paddingHorizontal: 10, gap: 5,
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.12)',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4 },
      android: { elevation: 4 },
      web: { boxShadow: '0 2px 6px rgba(0,0,0,0.3)' },
    }),
  },
  participantBadgeText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  participantBadgeGrid: {
    color: 'rgba(255,255,255,0.65)', fontSize: 11, fontWeight: '600',
    marginLeft: 2, borderLeftWidth: 0.5, borderLeftColor: 'rgba(255,255,255,0.2)', paddingLeft: 6,
  },
});
