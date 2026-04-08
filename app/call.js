import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Dimensions,
  Animated, Easing, StatusBar, PanResponder, AppState,
} from 'react-native';
import { IconSmile } from '../components/Icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import AvatarCircle from '../components/AvatarCircle';
import {
  IconMic, IconMicOff, IconVideo, IconVideoOff, IconPhoneOff,
  IconVolume2, IconArrowLeft, IconCameraFlip, IconScreenShare,
  IconPause, IconPlay, IconMoreHorizontal, IconPhone,
} from '../components/Icons';
import { reportConnected, endCall as callKeepEnd, startCall as callKeepStart } from '../services/callkeep';
import { getPendingOffer, getPendingIceCandidates, getPendingTurnCredentials, setCallActive } from '../components/IncomingCallListener';
import { setActiveCall, clearActiveCall } from '../components/ActiveCallBar';
import { addCallToHistory } from '../components/ChatCallsTab';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// ── Global state for minimized calls ──
// When user taps back arrow, the call is "minimized" — WebRTC resources
// move here so the component can unmount without killing the connection.
// Global call state lives in services/callState.js so it survives module re-imports
// (Expo Router loads screens as separate chunks; module-level vars don't share).
import { getGlobalCall as _getGC, setGlobalCall as _setGC, clearGlobalCall as _clearGC } from '../services/callState';
export const getGlobalCall = _getGC;
export const clearGlobalCall = _clearGC;

export default function CallScreen() {
  const params = useLocalSearchParams();
  const {
    callId, contactName, contactEmail,
    isVideo: isVideoParam, conversationId,
    isCaller: isCallerParam,
  } = params;
  const router = useRouter();
  const { user } = useAuth();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();

  // Call state
  const [audioMuted, setAudioMuted] = useState(false);
  const [videoEnabled, setVideoEnabled] = useState(isVideoParam === '1' || isVideoParam === 'true');
  // Default: earpiece (false) for audio calls, speaker (true) for video calls
  const [speakerOn, setSpeakerOn] = useState(isVideoParam === '1' || isVideoParam === 'true' ? true : false);
  const [callDuration, setCallDuration] = useState(0);
  const [peerConnected, setPeerConnected] = useState(false);
  const [ended, setEnded] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [facingFront, setFacingFront] = useState(true);
  const [screenSharing, setScreenSharing] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [showEmojiBar, setShowEmojiBar] = useState(false);
  const [floatingEmojis, setFloatingEmojis] = useState([]);
  const [onHold, setOnHold] = useState(false);
  const [showMoreSheet, setShowMoreSheet] = useState(false);
  const holdStateRef = useRef({ audioWasMuted: false, videoWasEnabled: false });
  const [activeFilter, setActiveFilter] = useState(null);
  const [showFilterPicker, setShowFilterPicker] = useState(false);
  const [connectionQuality, setConnectionQuality] = useState('good'); // 'good', 'medium', 'poor'
  const [qualityScore, setQualityScore] = useState(5); // 1-5 score
  const [rttMs, setRttMs] = useState(null); // round-trip time in ms
  const [showWeakBanner, setShowWeakBanner] = useState(false);
  const [suggestAudioOnly, setSuggestAudioOnly] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [networkType, setNetworkType] = useState(null); // 'wifi', 'cellular', etc.
  const iceRestartCountRef = useRef(0);
  const turnFetchRetryRef = useRef(0);
  const statsIntervalRef = useRef(null);
  const iceTimeoutRef = useRef(null);
  const turnRefreshRef = useRef(null);
  const lastQualityRef = useRef(5);
  const wakeLockRef = useRef(null);
  const netInfoUnsubRef = useRef(null);
  const lastNetTypeRef = useRef(null);
  const turnExpiresAtRef = useRef(0); // timestamp when TURN creds expire

  // Draggable PiP
  const pipPosition = useRef(new Animated.ValueXY({ x: SCREEN_W - 126, y: 80 })).current;
  const pipPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 5 || Math.abs(g.dy) > 5,
      onPanResponderGrant: () => { pipPosition.extractOffset(); },
      onPanResponderMove: Animated.event([null, { dx: pipPosition.x, dy: pipPosition.y }], { useNativeDriver: false }),
      onPanResponderRelease: (_, g) => {
        pipPosition.flattenOffset();
        // Snap to nearest edge
        const snapX = g.moveX > SCREEN_W / 2 ? SCREEN_W - 126 : 16;
        const snapY = Math.max(60, Math.min(g.moveY - 80, SCREEN_H - 280));
        Animated.spring(pipPosition, { toValue: { x: snapX, y: snapY }, friction: 7, tension: 100, useNativeDriver: false }).start();
      },
    })
  ).current;

  const timerRef = useRef(null);
  const callerTimeoutRef = useRef(null);
  const disconnectTimeoutRef = useRef(null);
  const callDurationRef = useRef(0);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const controlsFadeAnim = useRef(new Animated.Value(1)).current;
  const endedRef = useRef(false);
  // Stash WhatsApp-grade Opus params on the SDP. The Opus payload type
  // varies (typically 111) so we look it up dynamically. Adds:
  //   • maxaveragebitrate=24000 (clear voice without wasting bandwidth)
  //   • useinbandfec=1            (forward error correction for packet loss)
  //   • usedtx=1                  (silence suppression)
  //   • stereo=0                  (mono is enough for voice, half the bytes)
  //   • cbr=0                     (variable bitrate adapts to network)
  // Same config WhatsApp uses according to BlogGeek's wireshark analysis.
  // eslint-disable-next-line no-unused-vars
  const applyOpusTuning = (sdp) => {
    if (!sdp) return sdp;
    try {
      const lines = sdp.split('\r\n');
      // Find the Opus rtpmap → "a=rtpmap:111 opus/48000/2"
      let opusPt = null;
      for (const l of lines) {
        const m = l.match(/^a=rtpmap:(\d+)\s+opus\//i);
        if (m) { opusPt = m[1]; break; }
      }
      if (!opusPt) return sdp;
      const fmtpLineIdx = lines.findIndex(l => l.startsWith(`a=fmtp:${opusPt}`));
      const params = 'maxaveragebitrate=24000;useinbandfec=1;usedtx=1;stereo=0;cbr=0';
      if (fmtpLineIdx >= 0) {
        // Append our params to the existing fmtp line
        const existing = lines[fmtpLineIdx];
        if (!/maxaveragebitrate=/.test(existing)) {
          lines[fmtpLineIdx] = existing + ';' + params;
        }
      } else {
        // Insert a new fmtp line right after the rtpmap
        const rtpmapIdx = lines.findIndex(l => l.startsWith(`a=rtpmap:${opusPt}`));
        if (rtpmapIdx >= 0) {
          lines.splice(rtpmapIdx + 1, 0, `a=fmtp:${opusPt} ${params}`);
        }
      }
      return lines.join('\r\n');
    } catch {
      return sdp;
    }
  };
  const minimizedRef = useRef(false);
  const controlsTimerRef = useRef(null);

  // ─── Call state machine (Skype/WhatsApp pattern) ───────────────
  // Formal states prevent the race conditions that the bare endedRef
  // boolean was missing. Each transition must move forward, never back.
  //
  //   idle → dialing → ringing → connecting → active → ending → ended
  //                                         ↘ failed → ended
  //
  // The 'ending' state is the critical one: we set it BEFORE sending BYE
  // and BEFORE tearing down media, so the ICE state callback can see we're
  // already shutting down and not fire its own cleanup race.
  const callStateRef = useRef('idle');
  const setCallStateInternal = useCallback((next) => {
    const order = ['idle', 'dialing', 'ringing', 'connecting', 'active', 'ending', 'ended'];
    const cur = callStateRef.current;
    const curIdx = order.indexOf(cur);
    const nextIdx = order.indexOf(next);
    if (nextIdx < 0 || nextIdx < curIdx) return; // never go backwards
    callStateRef.current = next;
    if (__DEV__) console.log('[call] state', cur, '→', next);
  }, []);

  // Native AudioSession (iOS) — proper category/mode and notifyOthersOnDeactivation
  const _NativeAudioSession = (() => {
    if (Platform.OS !== 'ios') return null;
    try { return require('../modules/expo-audio-session').default; } catch { return null; }
  })();

  // WebRTC refs
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const iceCandidateQueueRef = useRef([]);
  const wsUnsubsRef = useRef([]);
  const screenStreamRef = useRef(null);

  // Native streams for RTCView
  const [localStreamUrl, setLocalStreamUrl] = useState(null);
  const [remoteStreamUrl, setRemoteStreamUrl] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);

  const isCaller = isCallerParam === '1' || isCallerParam === 'true';
  const callerName = contactName || contactEmail?.split('@')[0] || '?';

  // Auto-hide controls after 5s when video is showing
  const resetControlsTimer = useCallback(() => {
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    setControlsVisible(true);
    Animated.timing(controlsFadeAnim, { toValue: 1, duration: 200, useNativeDriver: false }).start();
    controlsTimerRef.current = setTimeout(() => {
      if (videoEnabled && peerConnected) {
        Animated.timing(controlsFadeAnim, { toValue: 0, duration: 300, useNativeDriver: false }).start(() => {
          setControlsVisible(false);
        });
      }
    }, 5000);
  }, [videoEnabled, peerConnected, controlsFadeAnim]);

  // Toggle controls on tap (video mode)
  const handleScreenTap = useCallback(() => {
    if (!videoEnabled || !peerConnected) return;
    if (controlsVisible) {
      Animated.timing(controlsFadeAnim, { toValue: 0, duration: 300, useNativeDriver: false }).start(() => {
        setControlsVisible(false);
      });
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    } else {
      resetControlsTimer();
    }
  }, [videoEnabled, peerConnected, controlsVisible, resetControlsTimer, controlsFadeAnim]);

  // Wake lock - keep screen on during call (web + native)
  useEffect(() => {
    if (Platform.OS === 'web') {
      if (navigator.wakeLock) {
        navigator.wakeLock.request('screen').then(lock => { wakeLockRef.current = lock; }).catch(() => {});
      }
    } else {
      // Native: use expo-keep-awake
      try {
        const { activateKeepAwakeAsync, deactivateKeepAwake } = require('expo-keep-awake');
        activateKeepAwakeAsync('call-screen').catch(() => {});
        wakeLockRef.current = { release: () => deactivateKeepAwake('call-screen') };
      } catch {}
    }
    return () => {
      if (wakeLockRef.current) { try { wakeLockRef.current.release(); } catch {} wakeLockRef.current = null; }
    };
  }, []);

  // Keep call alive when app goes to background — pause video, keep audio + connection
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (!localStreamRef.current) return;
      if (nextState === 'background' || nextState === 'inactive') {
        // Pause local video but keep audio and peer connection alive
        localStreamRef.current.getVideoTracks().forEach(t => { t.enabled = false; });
      } else if (nextState === 'active') {
        // Resume video when coming back to foreground
        if (videoEnabled) {
          localStreamRef.current.getVideoTracks().forEach(t => { t.enabled = true; });
        }
      }
    });
    return () => sub.remove();
  }, [videoEnabled]);

  // Network change detection (WiFi <-> cellular) -> trigger ICE restart
  useEffect(() => {
    let cleanup = () => {};
    try {
      const NetInfo = require('@react-native-community/netinfo').default;
      const unsub = NetInfo.addEventListener((state) => {
        const newType = state?.type || 'unknown';
        const wasConnected = lastNetTypeRef.current !== null;
        const typeChanged = lastNetTypeRef.current && lastNetTypeRef.current !== newType;
        lastNetTypeRef.current = newType;
        setNetworkType(newType);

        // If network type changed mid-call and we're connected, trigger ICE restart
        if (wasConnected && typeChanged && peerConnected && !endedRef.current && pcRef.current) {
          console.log('[Call] Network changed:', lastNetTypeRef.current, '->', newType, '— triggering ICE restart');
          setReconnecting(true);
          iceRestartCountRef.current = 0; // Reset counter for network-change restarts

          // Refresh TURN credentials first, then restart ICE
          const doRestart = async () => {
            try {
              const mailWs = require('../services/websocket').default;
              if (mailWs.isConnected) {
                const creds = await new Promise((resolve) => {
                  const u = mailWs.on('turn_credentials', (d) => { u(); resolve(d?.credentials || d); });
                  mailWs._send({ type: 'get_turn_credentials' });
                  setTimeout(() => { u(); resolve(null); }, 3000);
                });
                if (creds?.urls) {
                  turnCredsRef.current = creds;
                  turnExpiresAtRef.current = Date.now() + 23 * 60 * 60 * 1000;
                  if (pcRef.current?.setConfiguration) {
                    try { pcRef.current.setConfiguration(getIceConfig()); } catch {}
                  }
                }
              }
            } catch {}

            // Now do ICE restart
            const pc = pcRef.current;
            if (pc && pc.signalingState === 'stable') {
              try {
                const offer = await pc.createOffer({ iceRestart: true });
                await pc.setLocalDescription(offer);
                sendSignaling('call_offer', {
                  call_id: callId,
                  target_email: contactEmail,
                  sdp: offer.sdp,
                  sdp_type: offer.type,
                  ice_restart: true,
                });
                console.log('[Call] ICE restart offer sent after network change');
              } catch (e) {
                console.warn('[Call] ICE restart after network change failed:', e?.message);
              }
            }
          };
          doRestart();
        }
      });
      cleanup = unsub;
    } catch {
      // NetInfo not available (web or missing dependency) — use online/offline events
      if (Platform.OS === 'web') {
        const handleOnline = () => {
          if (peerConnected && !endedRef.current && pcRef.current) {
            console.log('[Call] Browser came online — triggering ICE restart');
            setReconnecting(true);
            iceRestartCountRef.current = 0;
            const pc = pcRef.current;
            if (pc && pc.signalingState === 'stable') {
              pc.createOffer({ iceRestart: true }).then(offer => {
                pc.setLocalDescription(offer);
                sendSignaling('call_offer', {
                  call_id: callId,
                  target_email: contactEmail,
                  sdp: offer.sdp,
                  sdp_type: offer.type,
                  ice_restart: true,
                });
              }).catch(() => {});
            }
          }
        };
        window.addEventListener('online', handleOnline);
        cleanup = () => window.removeEventListener('online', handleOnline);
      }
    }
    netInfoUnsubRef.current = cleanup;
    return () => { if (netInfoUnsubRef.current) netInfoUnsubRef.current(); };
  }, [peerConnected, callId, contactEmail, sendSignaling]);

  // Mark call as active so IncomingCallListener doesn't interfere with signaling
  useEffect(() => {
    setCallActive(true);
    return () => {
      if (!minimizedRef.current) setCallActive(false);
    };
  }, []);

  // Register active call for the green bar
  useEffect(() => {
    setActiveCall({
      callId,
      contactName: callerName,
      contactEmail,
      isVideo: isVideoParam === '1' || isVideoParam === 'true',
      conversationId,
      isCaller,
    });
    // Don't clear on unmount if minimized — the bar should remain
    return () => {
      if (!minimizedRef.current) clearActiveCall();
    };
  }, []);

  // Restore from minimized global state (when returning via ActiveCallBar)
  useEffect(() => {
    const gc = _getGC();
    if (gc && gc.callId === callId) {
      console.log('[Call] Restoring minimized call');
      pcRef.current = gc.pc;
      localStreamRef.current = gc.localStream;
      screenStreamRef.current = gc.screenStream;
      wsUnsubsRef.current = gc.wsUnsubs || [];
      callDurationRef.current = gc.duration || 0;
      setCallDuration(gc.duration || 0);
      setPeerConnected(true);
      minimizedRef.current = false;
      _clearGC();
    }
  }, [callId]);

  // Minimize: go back to chat without ending the call
  const handleMinimize = useCallback(() => {
    // Save WebRTC resources to global so they survive unmount
    _setGC({
      callId,
      pc: pcRef.current,
      localStream: localStreamRef.current,
      screenStream: screenStreamRef.current,
      wsUnsubs: wsUnsubsRef.current,
      duration: callDurationRef.current,
      contactEmail,
      isCaller,
    });
    // Prevent cleanup from destroying the connection
    minimizedRef.current = true;
    pcRef.current = null;
    localStreamRef.current = null;
    screenStreamRef.current = null;
    wsUnsubsRef.current = [];

    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/chat');
    }
  }, [callId, contactEmail, isCaller, router]);

  // Store RTC constructors in refs (different on web vs native)
  const rtcRef = useRef({
    PeerConnection: null,
    SessionDescription: null,
    IceCandidate: null,
  });

  const formatDuration = (secs) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // ICE servers config
  // TURN URLs must use mail.onemundo.com.br (resolves directly to 69.62.103.131)
  // chatyy.com.br goes through Cloudflare and won't reach coturn
  const TURN_FALLBACK_URLS = [
    'turn:mail.onemundo.com.br:3478?transport=udp',
    'turn:mail.onemundo.com.br:3478?transport=tcp',
    'turns:mail.onemundo.com.br:5349?transport=tcp',
  ];
  const STUN_ONLY_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:mail.onemundo.com.br:3478' },
  ];
  const turnCredsRef = useRef(null);
  const getIceConfig = () => {
    const config = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:mail.onemundo.com.br:3478' },
      ],
    };
    if (turnCredsRef.current) {
      config.iceServers.push({
        urls: turnCredsRef.current.urls || TURN_FALLBACK_URLS,
        username: turnCredsRef.current.username,
        credential: turnCredsRef.current.credential,
      });
    }
    return config;
  };

  // Send signaling message via WebSocket
  const sendSignaling = useCallback((type, data) => {
    try {
      const mailWs = require('../services/websocket').default;
      if (mailWs.isConnected) {
        mailWs._send({ type, ...data });
      }
    } catch {}
  }, []);

  // Attach remote stream for playback
  const attachRemoteStream = useCallback((stream) => {
    setRemoteStream(stream);

    if (Platform.OS === 'web') {
      let el = document.getElementById('remoteCallAudio');
      if (!el) {
        el = document.createElement('audio');
        el.id = 'remoteCallAudio';
        el.autoplay = true;
        el.playsInline = true;
        document.body.appendChild(el);
      }
      el.srcObject = stream;
      remoteAudioRef.current = el;

      if (stream.getVideoTracks().length > 0) {
        let vid = document.getElementById('remoteCallVideo');
        if (!vid) {
          vid = document.createElement('video');
          vid.id = 'remoteCallVideo';
          vid.autoplay = true;
          vid.playsInline = true;
          vid.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:1;';
          document.body.appendChild(vid);
        }
        vid.srcObject = stream;
        remoteVideoRef.current = vid;
      }
    } else {
      if (stream?.toURL) {
        setRemoteStreamUrl(stream.toURL());
      }
    }
  }, []);

  // Apply video filter to web remote video
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const vid = document.getElementById('remoteCallVideo');
    if (vid) {
      const filters = { warm: 'saturate(1.3) sepia(0.15) brightness(1.05)', cool: 'saturate(0.9) hue-rotate(15deg) brightness(1.05)', bw: 'grayscale(1)', vintage: 'sepia(0.4) contrast(1.1) brightness(0.95)', beauty: 'brightness(1.08) contrast(0.95) saturate(1.1) blur(0.3px)' };
      vid.style.filter = (activeFilter && filters[activeFilter]) || 'none';
    }
  }, [activeFilter]);

  // Handle incoming ICE candidate
  const handleIceCandidate = useCallback(async (data) => {
    if (!data?.candidate) return;
    const pc = pcRef.current;

    if (!pc || !pc.remoteDescription) {
      iceCandidateQueueRef.current.push(data.candidate);
      return;
    }

    try {
      await pc.addIceCandidate(new (rtcRef.current.IceCandidate || RTCIceCandidate)(data.candidate));
    } catch (e) { console.warn('[Call] addIceCandidate failed:', e?.message); }
  }, []);

  // Handle incoming SDP answer (caller receives this)
  const handleAnswer = useCallback(async (data) => {
    const pc = pcRef.current;
    if (!pc || !data?.sdp) return;

    try {
      await pc.setRemoteDescription(new (rtcRef.current.SessionDescription || RTCSessionDescription)({
        type: data.sdp_type || data.type || 'answer',
        sdp: data.sdp,
      }));

      for (const candidate of iceCandidateQueueRef.current) {
        try { await pc.addIceCandidate(new (rtcRef.current.IceCandidate || RTCIceCandidate)(candidate)); } catch (e) { console.warn('[Call] addIceCandidate failed:', e?.message); }
      }
      iceCandidateQueueRef.current = [];
    } catch (err) {
      console.error('Failed to set remote answer:', err);
    }
  }, []);

  // Handle incoming SDP offer (callee receives this)
  const handleOffer = useCallback(async (data) => {
    const pc = pcRef.current;
    if (!pc || !data?.sdp) return;

    try {
      await pc.setRemoteDescription(new (rtcRef.current.SessionDescription || RTCSessionDescription)({
        type: data.sdp_type || data.type || 'offer',
        sdp: data.sdp,
      }));

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      sendSignaling('call_answer', {
        call_id: callId,
        target_email: contactEmail,
        sdp: answer.sdp,
        sdp_type: answer.type,
      });

      for (const candidate of iceCandidateQueueRef.current) {
        try { await pc.addIceCandidate(new (rtcRef.current.IceCandidate || RTCIceCandidate)(candidate)); } catch (e) { console.warn('[Call] addIceCandidate failed:', e?.message); }
      }
      iceCandidateQueueRef.current = [];
    } catch (err) {
      console.error('Failed to handle offer:', err);
    }
  }, [callId, contactEmail, sendSignaling]);

  // End the call — Skype/WhatsApp-style ordered teardown.
  //
  // Order matters because each step depends on the previous one being done:
  //   1. Move state to 'ending' so concurrent ICE callbacks bail out
  //   2. Stop ringtone (caller-side ringing UI)
  //   3. Stop sending media (pause RTP) — gives the other side a clean fade-out
  //   4. Send BYE with retry/ACK (3 attempts, 1.5s timeout each)
  //   5. Close PeerConnection
  //   6. Release AudioSession with notifyOthersOnDeactivation (Spotify resumes)
  //   7. End CallKit transaction
  //   8. Persist to history + nav back
  const handleEndCall = useCallback(() => {
    if (endedRef.current) return;
    if (callStateRef.current === 'ending' || callStateRef.current === 'ended') return;
    setCallStateInternal('ending');
    endedRef.current = true;
    minimizedRef.current = false;
    _clearGC();
    setEnded(true);
    clearActiveCall();

    // Cancel all timers / interval / network listeners FIRST so callbacks
    // racing with the teardown can't fire.
    if (callerTimeoutRef.current) clearTimeout(callerTimeoutRef.current);
    if (disconnectTimeoutRef.current) clearTimeout(disconnectTimeoutRef.current);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
    if (iceTimeoutRef.current) { clearTimeout(iceTimeoutRef.current); iceTimeoutRef.current = null; }
    if (turnRefreshRef.current) { clearInterval(turnRefreshRef.current); turnRefreshRef.current = null; }
    if (netInfoUnsubRef.current) { try { netInfoUnsubRef.current(); } catch {} netInfoUnsubRef.current = null; }
    if (wakeLockRef.current) { try { wakeLockRef.current.release(); } catch {} wakeLockRef.current = null; }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }

    // Stop ringtone immediately — this is the UX change the user notices.
    try { const { stopRingtone } = require('../services/ringtone'); stopRingtone(); } catch {}

    // Pause RTP send so the other side hears silence rather than a glitch.
    if (localStreamRef.current) {
      try {
        localStreamRef.current.getTracks().forEach(t => { try { t.enabled = false; } catch {} });
      } catch {}
    }

    // Send BYE with retry + ACK. Fire-and-forget the retry loop so the UI
    // doesn't block on it — but we DO wait briefly before tearing down media
    // to give the message a chance to flush over the WebSocket.
    const sendByeWithRetry = async () => {
      const maxAttempts = 3;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          sendSignaling('call_end', {
            call_id: callId,
            target_email: contactEmail,
            reason: 'hangup',
            attempt: attempt + 1,
          });
        } catch {}
        // Give the WS 600ms to flush the message, then check for ack.
        // The signaling-server can echo back call_end_ack on receipt; if no
        // global ack handler is wired up yet (older server), we just retry.
        await new Promise(r => setTimeout(r, 600));
        if (window?.__lastCallEndAckId === callId) break;
      }
    };
    sendByeWithRetry().catch(() => {});

    // Persist to history (independent of teardown)
    addCallToHistory({
      contactEmail,
      contactName: callerName,
      callId,
      type: isCaller ? 'outgoing' : 'incoming',
      video: isVideoParam === '1' || isVideoParam === 'true',
      timestamp: Date.now(),
      duration: callDurationRef.current,
    }).catch(() => {});

    // Stop screen sharing
    if (screenStreamRef.current) {
      try { screenStreamRef.current.getTracks().forEach(t => t.stop()); } catch {}
      screenStreamRef.current = null;
    }

    if (localStreamRef.current) {
      try { localStreamRef.current.getTracks().forEach(t => t.stop()); } catch {}
      localStreamRef.current = null;
    }
    if (pcRef.current) {
      try { pcRef.current.close(); } catch {}
      pcRef.current = null;
    }

    // Audio session: prefer the new native module (notifies Spotify/Music
    // to resume). Fall back to expo-audio for parity if the module isn't
    // present (e.g. on older builds).
    if (_NativeAudioSession?.deactivate) {
      _NativeAudioSession.deactivate().catch(() => {});
    } else if (Platform.OS !== 'web') {
      try {
        const { setAudioModeAsync } = require('expo-audio');
        setAudioModeAsync({
          interruptionMode: 'mixWithOthers',
          playsInSilentMode: false,
          shouldPlayInBackground: false,
          allowsRecording: false,
        });
      } catch {}
      try {
        const { RTCAudioSession } = require('@stream-io/react-native-webrtc');
        RTCAudioSession.audioSessionDidDeactivate();
      } catch {}
    }

    callKeepEnd(callId);
    setCallStateInternal('ended');
    if (Platform.OS === 'web') {
      try { document.getElementById('remoteCallAudio')?.remove(); } catch {}
      try { document.getElementById('remoteCallVideo')?.remove(); } catch {}
      try { document.getElementById('localCallVideo')?.remove(); } catch {}
    }
    wsUnsubsRef.current.forEach(unsub => { try { unsub(); } catch {} });
    wsUnsubsRef.current = [];

    setTimeout(() => {
      try {
        if (router.canGoBack()) {
          router.back();
        } else {
          router.replace('/chat');
        }
      } catch {
        try { router.replace('/chat'); } catch {}
      }
    }, 800);
  }, [callId, contactEmail, sendSignaling, router]);

  // Reconnect: tear down existing PC, fetch fresh TURN credentials, and re-create
  const handleReconnect = useCallback(async () => {
    if (endedRef.current) return;
    console.log('[Call] handleReconnect: retrying connection...');
    setConnectionFailed(false);
    setErrorMsg(null);
    setReconnecting(true);
    iceRestartCountRef.current = 0;

    // Close old peer connection
    if (pcRef.current) {
      try { pcRef.current.close(); } catch {}
      pcRef.current = null;
    }

    try {
      const mailWs = require('../services/websocket').default;
      const video = isVideoParam === '1' || isVideoParam === 'true';

      // Fetch fresh TURN credentials
      let turnSuccess = false;
      for (let attempt = 0; attempt < 3 && !turnSuccess; attempt++) {
        try {
          const creds = await new Promise((resolve) => {
            const unsub = mailWs.on('turn_credentials', (data) => {
              unsub();
              resolve(data?.credentials || data);
            });
            mailWs._send({ type: 'get_turn_credentials' });
            setTimeout(() => { unsub(); resolve(null); }, 5000);
          });
          if (creds?.urls) {
            turnCredsRef.current = creds;
            turnExpiresAtRef.current = Date.now() + 23 * 60 * 60 * 1000;
            turnSuccess = true;
          } else if (attempt < 2) {
            await new Promise(r => setTimeout(r, 1000));
          }
        } catch {
          if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
        }
      }
      if (!turnSuccess) {
        console.log('[Call] Reconnect: TURN unavailable, using STUN-only');
        turnCredsRef.current = null;
      }

      let RTC_PeerConnection, RTC_SessionDescription;
      if (Platform.OS === 'web') {
        RTC_PeerConnection = window.RTCPeerConnection;
        RTC_SessionDescription = window.RTCSessionDescription;
      } else {
        const webrtc = require('@stream-io/react-native-webrtc');
        RTC_PeerConnection = webrtc.RTCPeerConnection;
        RTC_SessionDescription = webrtc.RTCSessionDescription;
      }

      const pc = new RTC_PeerConnection(getIceConfig());
      pcRef.current = pc;

      // ICE timeout for reconnect
      if (iceTimeoutRef.current) clearTimeout(iceTimeoutRef.current);
      iceTimeoutRef.current = setTimeout(() => {
        if (!endedRef.current &&
            pc.iceConnectionState !== 'connected' &&
            pc.iceConnectionState !== 'completed') {
          console.log('[Call] Reconnect ICE timeout after 30s');
          setErrorMsg(t('call.connectionFailed') || 'Nao foi possivel conectar. Tente novamente.');
          setConnectionFailed(true);
          setReconnecting(false);
        }
      }, 30000);

      // Re-add local tracks
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => {
          pc.addTrack(track, localStreamRef.current);
        });
      }

      pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          attachRemoteStream(event.streams[0]);
          setPeerConnected(true);
          setReconnecting(false);
          reportConnected(callId);
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignaling('call_ice', {
            call_id: callId,
            target_email: contactEmail,
            candidate: event.candidate.toJSON(),
          });
        }
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        console.log('[Call] Reconnect ICE state:', state);
        if (state === 'connected' || state === 'completed') {
          if (iceTimeoutRef.current) { clearTimeout(iceTimeoutRef.current); iceTimeoutRef.current = null; }
          setPeerConnected(true);
          setReconnecting(false);
          setConnectionFailed(false);
          setErrorMsg(null);
          iceRestartCountRef.current = 0;
        } else if (state === 'failed') {
          setConnectionFailed(true);
          setReconnecting(false);
          setErrorMsg(t('call.connectionFailed') || 'Nao foi possivel conectar. Tente novamente.');
        }
      };

      if (pc.onconnectionstatechange !== undefined) {
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'connected') setPeerConnected(true);
          else if (pc.connectionState === 'failed') {
            setConnectionFailed(true);
            setReconnecting(false);
            setErrorMsg(t('call.connectionFailed') || 'Nao foi possivel conectar. Tente novamente.');
          }
        };
      }

      // Create and send new offer with ICE restart
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: video,
        iceRestart: true,
      });
      // WhatsApp-grade Opus tuning: 24kbps target, FEC for packet loss
      // recovery, DTX (silence suppression) to save bandwidth.
      offer.sdp = applyOpusTuning(offer.sdp);
      await pc.setLocalDescription(offer);

      sendSignaling('call_offer', {
        call_id: callId,
        target_email: contactEmail,
        conversation_id: conversationId,
        sdp: offer.sdp,
        sdp_type: offer.type,
        video,
        ice_restart: true,
      });

      console.log('[Call] Reconnect offer sent');
    } catch (err) {
      console.error('[Call] Reconnect error:', err);
      setReconnecting(false);
      setConnectionFailed(true);
      setErrorMsg(t('call.connectionFailed') || 'Nao foi possivel conectar. Tente novamente.');
    }
  }, [callId, contactEmail, conversationId, isVideoParam, sendSignaling, attachRemoteStream, t]);

  // Initialize WebRTC call
  useEffect(() => {
    let RTC_PeerConnection, RTC_SessionDescription, RTC_IceCandidate, getUserMediaFn;

    if (Platform.OS === 'web') {
      RTC_PeerConnection = window.RTCPeerConnection;
      RTC_SessionDescription = window.RTCSessionDescription;
      RTC_IceCandidate = window.RTCIceCandidate;
      getUserMediaFn = (constraints) => navigator.mediaDevices.getUserMedia(constraints);
    } else {
      try {
        const webrtc = require('@stream-io/react-native-webrtc');
        RTC_PeerConnection = webrtc.RTCPeerConnection;
        RTC_SessionDescription = webrtc.RTCSessionDescription;
        RTC_IceCandidate = webrtc.RTCIceCandidate;
        getUserMediaFn = (constraints) => webrtc.mediaDevices.getUserMedia(constraints);
      } catch {
        setErrorMsg(t('call.webOnly') || 'Chamadas não disponíveis nesta versão');
        return;
      }
    }

    rtcRef.current = {
      PeerConnection: RTC_PeerConnection,
      SessionDescription: RTC_SessionDescription,
      IceCandidate: RTC_IceCandidate,
    };

    let mounted = true;

    const setupCall = async () => {
      try {
        // Stop ringtone and release audio session BEFORE WebRTC takes over
        try {
          const { stopRingtone } = require('../services/ringtone');
          stopRingtone();
        } catch {}
        // Small delay to let audio session fully release from ringtone player
        if (Platform.OS !== 'web') {
          await new Promise(r => setTimeout(r, 300));
        }

        const video = isVideoParam === '1' || isVideoParam === 'true';
        console.log('[Call] setupCall: isCaller=' + isCaller + ' video=' + video + ' callId=' + callId);

        const mailWs = require('../services/websocket').default;

        const unsubTurn = mailWs.on('call_turn_credentials', (data) => {
          if (data?.call_id === callId && data?.credentials) {
            turnCredsRef.current = data.credentials;
            turnExpiresAtRef.current = Date.now() + 23 * 60 * 60 * 1000;
            if (pcRef.current && pcRef.current.setConfiguration) {
              try { pcRef.current.setConfiguration(getIceConfig()); } catch {}
            }
          }
        });
        const unsubAnswer = mailWs.on('call_answer', (data) => {
          if (data?.call_id === callId) handleAnswer(data);
        });
        const unsubIce = mailWs.on('call_ice', (data) => {
          if (data?.call_id === callId) handleIceCandidate(data);
        });
        const unsubOffer = mailWs.on('call_offer', (data) => {
          if (data?.call_id === callId) {
            if (data.turn_credentials) {
              turnCredsRef.current = data.turn_credentials;
              if (pcRef.current && pcRef.current.setConfiguration) {
                try { pcRef.current.setConfiguration(getIceConfig()); } catch {}
              }
            }
            handleOffer(data);
          }
        });
        const callAcceptedRef = { current: false };
        const unsubAccepted = mailWs.on('call_accepted', (data) => {
          if (data?.call_id === callId && mounted) {
            callAcceptedRef.current = true;
            if (callerTimeoutRef.current) clearTimeout(callerTimeoutRef.current);
            try {
              const { stopRingtone } = require('../services/ringtone');
              stopRingtone();
            } catch {}
          }
        });
        const unsubEnd = mailWs.on('call_end', (data) => {
          if (callAcceptedRef.current && data?.reason === 'declined') return;
          if (data?.call_id === callId && mounted && !endedRef.current) {
            endedRef.current = true;
            setEnded(true);
            clearActiveCall();
            // Log call to history (remote ended)
            addCallToHistory({
              contactEmail,
              contactName: callerName,
              callId,
              type: isCaller ? 'outgoing' : 'incoming',
              video: isVideoParam === '1' || isVideoParam === 'true',
              timestamp: Date.now(),
              duration: callDurationRef.current,
            }).catch(() => {});
            try { const { stopRingtone } = require('../services/ringtone'); stopRingtone(); } catch {}
            if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
            if (Platform.OS !== 'web') {
              try {
                const { setAudioModeAsync } = require('expo-audio');
                setAudioModeAsync({ interruptionMode: 'mixWithOthers', playsInSilentMode: false, shouldPlayInBackground: false, allowsRecording: false });
              } catch {}
              try {
                const { RTCAudioSession } = require('@stream-io/react-native-webrtc');
                RTCAudioSession.audioSessionDidDeactivate();
              } catch {}
            }
            callKeepEnd(callId);
            if (localStreamRef.current) {
              localStreamRef.current.getTracks().forEach(t => { try { t.stop(); } catch {} });
              localStreamRef.current = null;
            }
            if (screenStreamRef.current) {
              screenStreamRef.current.getTracks().forEach(t => { try { t.stop(); } catch {} });
              screenStreamRef.current = null;
            }
            if (pcRef.current) {
              try { pcRef.current.close(); } catch {}
              pcRef.current = null;
            }
            if (Platform.OS === 'web') {
              try { document.getElementById('remoteCallAudio')?.remove(); } catch {}
              try { document.getElementById('remoteCallVideo')?.remove(); } catch {}
            }
            setTimeout(() => { try { router.canGoBack() ? router.back() : router.replace('/chat'); } catch { try { router.replace('/chat'); } catch {} } }, 1500);
          }
        });
        wsUnsubsRef.current = [unsubTurn, unsubAnswer, unsubIce, unsubOffer, unsubAccepted, unsubEnd];

        // Set audio mode BEFORE getUserMedia so music pauses immediately when calling.
        // Prefer the native AVAudioSession module — it sets the right category
        // (.playAndRecord), mode (.voiceChat / .videoChat), and Bluetooth options
        // and properly notifies other apps. expo-audio is a fallback.
        if (Platform.OS === 'ios' && _NativeAudioSession?.activateForCall) {
          try {
            const isVideo = isVideoParam === '1' || isVideoParam === 'true';
            if (isVideo) {
              _NativeAudioSession.activateForVideoCall().catch(() => {});
            } else {
              _NativeAudioSession.activateForCall(false).catch(() => {});
            }
          } catch (e) {
            console.log('[Call] native audio session error:', e?.message);
          }
        } else if (Platform.OS !== 'web') {
          try {
            const { AudioModule } = require('expo-audio');
            AudioModule.setAudioMode({
              interruptionMode: 'doNotMix',
              playsInSilentMode: true,
              shouldPlayInBackground: true,
            });
          } catch (e) {
            console.log('[Call] early setAudioMode error:', e);
          }
        }

        const mediaPromise = getUserMediaFn({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
            sampleRate: { ideal: 48000 },
            sampleSize: { ideal: 16 },
          },
          video: video ? {
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
            frameRate: { ideal: 30, max: 30 },
            facingMode: 'user',
          } : false,
        });
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Permissão de câmera/microfone expirou')), 15000)
        );
        const stream = await Promise.race([mediaPromise, timeoutPromise]);
        console.log('[Call] getUserMedia OK: audio=' + stream.getAudioTracks().length + ' video=' + stream.getVideoTracks().length);

        if (!mounted) {
          stream.getTracks().forEach(tr => tr.stop());
          return;
        }

        localStreamRef.current = stream;

        if (Platform.OS !== 'web') {
          try {
            const { setAudioModeAsync } = require('expo-audio');
            await setAudioModeAsync({
              interruptionMode: 'doNotMix',
              playsInSilentMode: true,
              shouldPlayInBackground: true,
              allowsRecording: true,
            });
          } catch (audioErr) {
            console.log('[Call] expo-audio setAudioModeAsync error:', audioErr);
          }
          try {
            const { RTCAudioSession } = require('@stream-io/react-native-webrtc');
            // Initialize RTC audio session with proper configuration
            RTCAudioSession.audioSessionDidActivate();
            // Explicitly set active to enable speaker/receiver routing
            if (RTCAudioSession.audioSessionSetActive) {
              RTCAudioSession.audioSessionSetActive(true);
            }
            console.log('[Call] RTCAudioSession activated');
          } catch (e) {
            console.warn('[Call] RTCAudioSession error:', e?.message);
          }
        }

        if (Platform.OS !== 'web' && stream?.toURL) {
          setLocalStreamUrl(stream.toURL());
        }
        // Web: create local video PiP element
        if (Platform.OS === 'web' && video) {
          let localVid = document.getElementById('localCallVideo');
          if (!localVid) {
            localVid = document.createElement('video');
            localVid.id = 'localCallVideo';
            localVid.autoplay = true;
            localVid.playsInline = true;
            localVid.muted = true;
            localVid.style.cssText = 'position:fixed;bottom:180px;right:16px;width:110px;height:160px;object-fit:cover;z-index:30;border-radius:16px;border:2px solid rgba(255,255,255,0.25);cursor:grab;';
            document.body.appendChild(localVid);
            // Make draggable
            let dragging = false, startX = 0, startY = 0, origX = 0, origY = 0;
            localVid.addEventListener('mousedown', (e) => {
              dragging = true; startX = e.clientX; startY = e.clientY;
              const rect = localVid.getBoundingClientRect();
              origX = rect.left; origY = rect.top;
              localVid.style.cursor = 'grabbing';
              e.preventDefault();
            });
            document.addEventListener('mousemove', (e) => {
              if (!dragging) return;
              localVid.style.left = (origX + e.clientX - startX) + 'px';
              localVid.style.top = (origY + e.clientY - startY) + 'px';
              localVid.style.right = 'auto';
              localVid.style.bottom = 'auto';
            });
            document.addEventListener('mouseup', () => { dragging = false; if (localVid) localVid.style.cursor = 'grab'; });
          }
          localVid.srcObject = stream;
        }

        // Get TURN credentials with retry (up to 3 attempts)
        if (isCaller) {
          let turnSuccess = false;
          for (let attempt = 0; attempt < 3 && !turnSuccess; attempt++) {
            try {
              const turnPromise = new Promise((resolve) => {
                const unsub = mailWs.on('turn_credentials', (data) => {
                  unsub();
                  resolve(data?.credentials || data);
                });
                mailWs._send({ type: 'get_turn_credentials' });
                setTimeout(() => { unsub(); resolve(null); }, 5000);
              });
              const creds = await turnPromise;
              if (creds?.urls) {
                turnCredsRef.current = creds;
                turnExpiresAtRef.current = Date.now() + 23 * 60 * 60 * 1000;
                turnSuccess = true;
              } else if (attempt < 2) {
                console.log('[Call] TURN credential fetch empty, retry', attempt + 1);
                await new Promise(r => setTimeout(r, 1000));
              }
            } catch (e) {
              console.log('[Call] TURN credential fetch error, retry', attempt + 1, e?.message);
              if (attempt < 2) {
                await new Promise(r => setTimeout(r, 1000));
              }
            }
          }
          if (!turnSuccess) {
            console.log('[Call] TURN credentials unavailable after 3 attempts, proceeding with STUN-only (P2P)');
          }
        } else {
          const pendingTurn = getPendingTurnCredentials();
          if (pendingTurn?.urls) {
            turnCredsRef.current = pendingTurn;
            turnExpiresAtRef.current = Date.now() + 23 * 60 * 60 * 1000;
          }
        }

        const pc = new RTC_PeerConnection(getIceConfig());
        pcRef.current = pc;

        // ICE connection timeout — 45 seconds to establish connection
        // (30s was too short for mobile networks with TURN relay negotiation)
        if (iceTimeoutRef.current) clearTimeout(iceTimeoutRef.current);
        iceTimeoutRef.current = setTimeout(() => {
          if (mounted && !endedRef.current &&
              pc.iceConnectionState !== 'connected' &&
              pc.iceConnectionState !== 'completed') {
            console.log('[Call] ICE timeout after 45s, state:', pc.iceConnectionState);
            // Instead of immediately failing, try one ICE restart with relay-only
            if (iceRestartCountRef.current === 0 && turnCredsRef.current) {
              console.log('[Call] ICE timeout — attempting relay-only restart');
              iceRestartCountRef.current++;
              setReconnecting(true);
              pc.createOffer({ iceRestart: true }).then(offer => {
                pc.setLocalDescription(offer);
                sendSignaling('call_offer', {
                  call_id: callId,
                  target_email: contactEmail,
                  sdp: offer.sdp,
                  sdp_type: offer.type,
                  ice_restart: true,
                });
              }).catch(() => {
                setErrorMsg(t('call.connectionFailed') || 'Connection failed. Tap to retry.');
                setConnectionFailed(true);
                setReconnecting(false);
              });
              // Give the restart another 20s
              iceTimeoutRef.current = setTimeout(() => {
                if (mounted && !endedRef.current &&
                    pc.iceConnectionState !== 'connected' &&
                    pc.iceConnectionState !== 'completed') {
                  setErrorMsg(t('call.connectionFailed') || 'Connection failed. Tap to retry.');
                  setConnectionFailed(true);
                  setReconnecting(false);
                }
              }, 20000);
            } else {
              setErrorMsg(t('call.connectionFailed') || 'Connection failed. Tap to retry.');
              setConnectionFailed(true);
              setReconnecting(false);
            }
          }
        }, 45000);

        stream.getTracks().forEach(track => {
          pc.addTrack(track, stream);
        });

        pc.ontrack = (event) => {
          const stream = event.streams?.[0];
          if (stream) {
            attachRemoteStream(stream);
          } else if (event.track) {
            // Track arrived without a stream (renegotiation / addTrack without stream)
            // Create a new MediaStream and attach the track
            if (Platform.OS === 'web') {
              const ms = new MediaStream();
              ms.addTrack(event.track);
              attachRemoteStream(ms);
            }
          }
          if (mounted) {
            setPeerConnected(true);
            reportConnected(callId);
            if (Platform.OS !== 'web') {
              try {
                const { RTCAudioSession } = require('@stream-io/react-native-webrtc');
                RTCAudioSession.audioSessionDidActivate();
              } catch {}
            }
          }
        };

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            sendSignaling('call_ice', {
              call_id: callId,
              target_email: contactEmail,
              candidate: event.candidate.toJSON(),
            });
          }
        };

        pc.oniceconnectionstatechange = () => {
          const state = pc.iceConnectionState;
          console.log('[Call] ICE state:', state);
          if (disconnectTimeoutRef.current) { clearTimeout(disconnectTimeoutRef.current); disconnectTimeoutRef.current = null; }
          if (state === 'connected' || state === 'completed') {
            // Clear ICE timeout on successful connection
            if (iceTimeoutRef.current) { clearTimeout(iceTimeoutRef.current); iceTimeoutRef.current = null; }
            if (mounted) {
              setPeerConnected(true);
              setReconnecting(false);
              iceRestartCountRef.current = 0;
            }
          } else if (state === 'disconnected') {
            // Brief disconnections are normal (WiFi<->cell, tunnel, etc.) - wait before acting
            if (mounted) setReconnecting(true);
            disconnectTimeoutRef.current = setTimeout(async () => {
              if (mounted && !endedRef.current && pcRef.current?.iceConnectionState === 'disconnected') {
                // Refresh TURN credentials if they might be stale
                if (!turnExpiresAtRef.current || (turnExpiresAtRef.current - Date.now()) < 2 * 60 * 60 * 1000) {
                  try {
                    const mailWs = require('../services/websocket').default;
                    if (mailWs.isConnected) {
                      const creds = await new Promise((resolve) => {
                        const u = mailWs.on('turn_credentials', (d) => { u(); resolve(d?.credentials || d); });
                        mailWs._send({ type: 'get_turn_credentials' });
                        setTimeout(() => { u(); resolve(null); }, 3000);
                      });
                      if (creds?.urls) {
                        turnCredsRef.current = creds;
                        turnExpiresAtRef.current = Date.now() + 23 * 60 * 60 * 1000;
                        if (pcRef.current?.setConfiguration) {
                          try { pcRef.current.setConfiguration(getIceConfig()); } catch {}
                        }
                      }
                    }
                  } catch {}
                }

                // Try ICE restart first (up to 3 times) before showing retry button
                if (iceRestartCountRef.current < 3) {
                  console.log('[Call] ICE restart attempt', iceRestartCountRef.current + 1);
                  iceRestartCountRef.current++;
                  try {
                    if (pcRef.current.signalingState === 'stable') {
                      pcRef.current.createOffer({ iceRestart: true }).then(offer => {
                        pcRef.current.setLocalDescription(offer);
                        sendSignaling('call_offer', {
                          call_id: callId,
                          target_email: contactEmail,
                          sdp: offer.sdp,
                          sdp_type: offer.type,
                          ice_restart: true,
                        });
                      }).catch(() => {});
                    } else {
                      console.log('[Call] Skipping ICE restart, signalingState:', pcRef.current.signalingState);
                    }
                  } catch {}
                } else {
                  console.log('[Call] ICE restart failed after 3 attempts, showing reconnect button');
                  setConnectionFailed(true);
                  setReconnecting(false);
                  setErrorMsg(t('call.connectionFailed') || 'Connection failed. Tap to retry.');
                }
              }
            }, 3000);
          } else if (state === 'failed') {
            // Try ICE restart on failure (up to 3 times)
            if (mounted && !endedRef.current && iceRestartCountRef.current < 3) {
              console.log('[Call] ICE failed, attempting restart', iceRestartCountRef.current + 1);
              setReconnecting(true);
              iceRestartCountRef.current++;
              try {
                if (pcRef.current.signalingState !== 'stable') {
                  console.log('[Call] Skipping ICE restart on failure, signalingState:', pcRef.current.signalingState);
                  return;
                }
                pcRef.current.createOffer({ iceRestart: true }).then(offer => {
                  pcRef.current.setLocalDescription(offer);
                  sendSignaling('call_offer', {
                    call_id: callId,
                    target_email: contactEmail,
                    sdp: offer.sdp,
                    sdp_type: offer.type,
                    ice_restart: true,
                  });
                }).catch(() => {
                  if (mounted && !endedRef.current) {
                    setConnectionFailed(true);
                    setReconnecting(false);
                    setErrorMsg(t('call.connectionFailed') || 'Nao foi possivel conectar. Tente novamente.');
                  }
                });
              } catch {
                if (mounted && !endedRef.current) {
                  setConnectionFailed(true);
                  setReconnecting(false);
                  setErrorMsg(t('call.connectionFailed') || 'Nao foi possivel conectar. Tente novamente.');
                }
              }
            } else if (mounted && !endedRef.current) {
              // All ICE restarts exhausted — show reconnect button
              setConnectionFailed(true);
              setReconnecting(false);
              setErrorMsg(t('call.connectionFailed') || 'Nao foi possivel conectar. Tente novamente.');
            }
          } else if (state === 'closed') {
            if (mounted && !endedRef.current) {
              handleEndCall();
            }
          }
        };

        if (pc.onconnectionstatechange !== undefined) {
          pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            console.log('[Call] Connection state:', state);
            if (state === 'connected') {
              if (mounted) {
                setPeerConnected(true);
                setReconnecting(false);
                setConnectionFailed(false);
              }
            } else if (state === 'disconnected') {
              // Brief disconnections happen during network switches - don't end call yet
              if (mounted) setReconnecting(true);
            } else if (state === 'failed') {
              // Try ICE restart before giving up
              if (mounted && !endedRef.current && iceRestartCountRef.current < 3) {
                console.log('[Call] connectionState failed, attempting ICE restart');
                setReconnecting(true);
                iceRestartCountRef.current++;
                if (pcRef.current?.signalingState === 'stable') {
                  pcRef.current.createOffer({ iceRestart: true }).then(offer => {
                    pcRef.current.setLocalDescription(offer);
                    sendSignaling('call_offer', {
                      call_id: callId,
                      target_email: contactEmail,
                      sdp: offer.sdp,
                      sdp_type: offer.type,
                      ice_restart: true,
                    });
                  }).catch(() => {
                    if (mounted && !endedRef.current) {
                      setConnectionFailed(true);
                      setReconnecting(false);
                      setErrorMsg(t('call.connectionFailed') || 'Connection failed. Tap to retry.');
                    }
                  });
                }
              } else if (mounted && !endedRef.current) {
                setConnectionFailed(true);
                setReconnecting(false);
                setErrorMsg(t('call.connectionFailed') || 'Connection failed. Tap to retry.');
              }
            }
          };
        }

        if (isCaller) {
          callKeepStart(callId, callerName, contactEmail, video);

          sendSignaling('call_invite', {
            call_id: callId,
            target_email: contactEmail,
            conversation_id: conversationId,
            video,
          });

          // Wait for callee to accept, but also send offer immediately as backup
          // (some clients need the offer before they can show incoming call screen)
          console.log('[Call] Creating offer immediately + waiting for accept...');

          console.log('[Call] Callee accepted! Creating offer...');
          let offer;
          try {
            offer = await pc.createOffer({
              offerToReceiveAudio: true,
              offerToReceiveVideo: video,
            });
            // WhatsApp-grade Opus tuning: 24kbps + FEC + DTX
            offer.sdp = applyOpusTuning(offer.sdp);
          } catch (offerErr) {
            console.error('createOffer failed:', offerErr);
            sendSignaling('call_debug', { call_id: callId, error: 'createOffer: ' + (offerErr?.message || String(offerErr)) });
            throw offerErr;
          }

          try {
            await pc.setLocalDescription(offer);
          } catch (sdErr) {
            console.error('setLocalDescription failed:', sdErr);
            sendSignaling('call_debug', { call_id: callId, error: 'setLocalDesc: ' + (sdErr?.message || String(sdErr)) });
            throw sdErr;
          }

          sendSignaling('call_offer', {
            call_id: callId,
            target_email: contactEmail,
            conversation_id: conversationId,
            sdp: offer.sdp,
            sdp_type: offer.type,
            video,
          });
          console.log('[Call] Offer sent after accept, sdp length:', offer.sdp?.length || 0);

          callerTimeoutRef.current = setTimeout(() => {
            if (mounted && !endedRef.current && !pcRef.current?.remoteDescription) {
              sendSignaling('call_debug', { call_id: callId, msg: 'caller timeout: no answer after 60s' });
              handleEndCall();
            }
          }, 60000);
        } else {
          const pendingOffer = getPendingOffer();
          console.log('[Call] callee setup: has_pending=' + (!!pendingOffer) + ' has_sdp=' + (!!pendingOffer?.sdp));

          if (pendingOffer && pendingOffer.sdp) {
            try {
              await pc.setRemoteDescription(new RTC_SessionDescription({
                type: pendingOffer.type || 'offer',
                sdp: pendingOffer.sdp,
              }));

              const answer = await pc.createAnswer();
              // Apply Opus tuning to the answer SDP too — both peers must agree
              answer.sdp = applyOpusTuning(answer.sdp);
              await pc.setLocalDescription(answer);

              sendSignaling('call_answer', {
                call_id: callId,
                target_email: contactEmail,
                sdp: answer.sdp,
                sdp_type: answer.type,
              });
              console.log('[Call] callee answer sent, sdp_len:', answer.sdp?.length || 0);

              const bufferedCandidates = getPendingIceCandidates();
              if (bufferedCandidates.length > 0) {
                console.log('[Call] processing', bufferedCandidates.length, 'buffered ICE candidates');
                for (const candidate of bufferedCandidates) {
                  try { await pc.addIceCandidate(new RTC_IceCandidate(candidate)); } catch (e) { console.warn('[Call] addIceCandidate failed:', e?.message); }
                }
              }

              for (const candidate of iceCandidateQueueRef.current) {
                try { await pc.addIceCandidate(new RTC_IceCandidate(candidate)); } catch (e) { console.warn('[Call] addIceCandidate failed:', e?.message); }
              }
              iceCandidateQueueRef.current = [];
            } catch (calleeErr) {
              sendSignaling('call_debug', { call_id: callId, error: 'callee SDP error: ' + (calleeErr?.message || String(calleeErr)) });
              throw calleeErr;
            }
          } else {
            sendSignaling('call_debug', { call_id: callId, msg: 'callee: no pending SDP, requesting offer...' });
            try {
              mailWs._send({
                type: 'call_request_offer',
                call_id: callId,
              });
            } catch {}
          }
        }
      } catch (err) {
        console.error('Call setup error:', err);
        if (mounted) {
          setErrorMsg(err.message || t('call.connectionFailed') || 'Erro ao iniciar chamada');
          setConnectionFailed(true);
        }
      }
    };

    setupCall();

    return () => {
      mounted = false;
      if (callerTimeoutRef.current) clearTimeout(callerTimeoutRef.current);
      if (disconnectTimeoutRef.current) clearTimeout(disconnectTimeoutRef.current);
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
      if (iceTimeoutRef.current) clearTimeout(iceTimeoutRef.current);
      if (turnRefreshRef.current) clearInterval(turnRefreshRef.current);

      // If minimized, don't destroy WebRTC resources — they're saved globally
      if (minimizedRef.current) {
        console.log('[Call] Unmounting minimized — preserving WebRTC');
        return;
      }

      wsUnsubsRef.current.forEach(unsub => { try { unsub(); } catch {} });
      wsUnsubsRef.current = [];
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach(t => { try { t.stop(); } catch {} });
        screenStreamRef.current = null;
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => { try { t.stop(); } catch {} });
        localStreamRef.current = null;
      }
      if (pcRef.current) {
        try { pcRef.current.close(); } catch {}
        pcRef.current = null;
      }
      if (callId) callKeepEnd(callId);
      if (Platform.OS !== 'web') {
        try {
          const { setAudioModeAsync } = require('expo-audio');
          setAudioModeAsync({ interruptionMode: 'mixWithOthers', playsInSilentMode: false, shouldPlayInBackground: false, allowsRecording: false });
        } catch {}
        try {
          const { RTCAudioSession } = require('@stream-io/react-native-webrtc');
          RTCAudioSession.audioSessionDidDeactivate();
        } catch {}
      }
      if (Platform.OS === 'web') {
        try { document.getElementById('remoteCallAudio')?.remove(); } catch {}
        try { document.getElementById('remoteCallVideo')?.remove(); } catch {}
        try { document.getElementById('localCallVideo')?.remove(); } catch {}
      }
    };
  }, []); // Run once on mount

  // Fade in + calling tone (caller only)
  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: false }).start();
    if (isCaller) {
      const { startCallingTone, stopRingtone } = require('../services/ringtone');
      startCallingTone();
      return () => stopRingtone();
    }
  }, []);

  // Avatar pulse while waiting
  useEffect(() => {
    if (peerConnected) return;
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.08, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [peerConnected]);

  // Call timer + quality stats when connected
  useEffect(() => {
    if (!peerConnected) return;
    const { stopRingtone } = require('../services/ringtone');
    stopRingtone();
    timerRef.current = setInterval(() => setCallDuration(d => { callDurationRef.current = d + 1; return d + 1; }), 1000);

    // Monitor connection quality via WebRTC stats every 2 seconds
    let prevBytesReceived = 0;
    let prevTimestamp = 0;
    statsIntervalRef.current = setInterval(async () => {
      const pc = pcRef.current;
      if (!pc || endedRef.current) return;
      try {
        const stats = await pc.getStats();
        let rtt = null;
        let packetsLost = 0;
        let packetsTotal = 0;
        let bytesReceived = 0;
        let currentTimestamp = 0;
        let videoFramesDecoded = 0;
        let videoFramesDropped = 0;
        let videoWidth = 0;
        let videoHeight = 0;
        let availableBandwidth = null;

        stats.forEach(report => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            rtt = report.currentRoundTripTime;
            if (report.availableOutgoingBitrate) {
              availableBandwidth = report.availableOutgoingBitrate;
            }
          }
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            packetsLost = report.packetsLost || 0;
            packetsTotal = (report.packetsReceived || 0) + packetsLost;
            bytesReceived = report.bytesReceived || 0;
            currentTimestamp = report.timestamp || Date.now();
          }
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            videoFramesDecoded = report.framesDecoded || 0;
            videoFramesDropped = report.framesDropped || 0;
            videoWidth = report.frameWidth || 0;
            videoHeight = report.frameHeight || 0;
          }
        });

        // Calculate quality score (1-5) based on RTT and packet loss
        const currentRttMs = rtt !== null ? Math.round(rtt * 1000) : null;
        const lossRate = packetsTotal > 0 ? packetsLost / packetsTotal : 0;
        let score = 5;
        let quality = 'good';

        if (rtt !== null) {
          if (rtt < 0.1 && lossRate < 0.01) { score = 5; quality = 'good'; }
          else if (rtt < 0.2 && lossRate < 0.03) { score = 4; quality = 'good'; }
          else if (rtt < 0.4 && lossRate < 0.05) { score = 3; quality = 'medium'; }
          else if (rtt < 0.8) { score = 2; quality = 'poor'; }
          else { score = 1; quality = 'poor'; }
        }

        // Check for no data flowing (connection stalled)
        if (prevBytesReceived > 0 && bytesReceived === prevBytesReceived && currentTimestamp - prevTimestamp > 5000) {
          quality = 'poor';
          score = 1;
        }
        prevBytesReceived = bytesReceived;
        prevTimestamp = currentTimestamp;

        setConnectionQuality(quality);
        setQualityScore(score);
        if (currentRttMs !== null) setRttMs(currentRttMs);

        // Show weak connection banner when quality drops to 2 or below
        setShowWeakBanner(score <= 2);

        // Suggest audio-only when quality is 1 (bad) and video is enabled
        setSuggestAudioOnly(score === 1 && videoEnabled);

        // Adaptive bitrate — adjust video sender encoding based on quality
        if (score !== lastQualityRef.current) {
          lastQualityRef.current = score;
          const senders = pc.getSenders();
          for (const sender of senders) {
            if (sender.track?.kind === 'video') {
              try {
                const params = sender.getParameters();
                if (!params.encodings || params.encodings.length === 0) {
                  params.encodings = [{}];
                }
                switch (score) {
                  case 5:
                    params.encodings[0].maxBitrate = 2500000;
                    params.encodings[0].maxFramerate = 30;
                    break;
                  case 4:
                    params.encodings[0].maxBitrate = 1500000;
                    params.encodings[0].maxFramerate = 24;
                    break;
                  case 3:
                    params.encodings[0].maxBitrate = 800000;
                    params.encodings[0].maxFramerate = 15;
                    break;
                  case 2:
                    params.encodings[0].maxBitrate = 400000;
                    params.encodings[0].maxFramerate = 10;
                    break;
                  default:
                    params.encodings[0].maxBitrate = 150000;
                    params.encodings[0].maxFramerate = 5;
                    break;
                }
                await sender.setParameters(params);
              } catch {}
            }
          }
        }
      } catch {}
    }, 2000);

    // Refresh TURN credentials every hour (they expire in 24h, but refresh early)
    // Also refresh if they're about to expire (< 2 hours remaining)
    turnRefreshRef.current = setInterval(async () => {
      try {
        // Skip if TURN creds are still fresh (more than 2h remaining)
        if (turnExpiresAtRef.current && (turnExpiresAtRef.current - Date.now()) > 2 * 60 * 60 * 1000) return;

        const mailWs = require('../services/websocket').default;
        if (!mailWs.isConnected) return;
        const creds = await new Promise((resolve) => {
          const unsub = mailWs.on('turn_credentials', (data) => {
            unsub();
            resolve(data?.credentials || data);
          });
          mailWs._send({ type: 'get_turn_credentials' });
          setTimeout(() => { unsub(); resolve(null); }, 5000);
        });
        if (creds?.urls && pcRef.current) {
          turnCredsRef.current = creds;
          turnExpiresAtRef.current = Date.now() + 23 * 60 * 60 * 1000;
          try { pcRef.current.setConfiguration(getIceConfig()); } catch {}
          console.log('[Call] TURN credentials refreshed');
        }
      } catch {}
    }, 60 * 60 * 1000); // Every hour

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
      if (turnRefreshRef.current) clearInterval(turnRefreshRef.current);
    };
  }, [peerConnected, videoEnabled]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  // Toggle mute
  const handleToggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    const audioTrack = localStreamRef.current.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      setAudioMuted(!audioTrack.enabled);
    }
    resetControlsTimer();
  }, [resetControlsTimer]);

  // Toggle video (supports upgrading audio-only call to video)
  const handleToggleVideo = useCallback(async () => {
    if (!localStreamRef.current || !pcRef.current) return;

    const videoTrack = localStreamRef.current.getVideoTracks()[0];
    if (videoTrack) {
      // Existing video track — just toggle enabled
      videoTrack.enabled = !videoTrack.enabled;
      const nowEnabled = videoTrack.enabled;
      setVideoEnabled(nowEnabled);
      if (Platform.OS !== 'web' && localStreamRef.current.toURL) {
        setLocalStreamUrl(nowEnabled ? localStreamRef.current.toURL() : null);
      }
      // Web: show/hide local video PiP
      if (Platform.OS === 'web') {
        const localVid = document.getElementById('localCallVideo');
        if (localVid) {
          localVid.style.display = nowEnabled ? 'block' : 'none';
        }
      }
      // Notify remote peer about video state change
      sendSignaling('call_video_toggle', {
        call_id: callId,
        target_email: contactEmail,
        video_enabled: nowEnabled,
      });
    } else {
      // No video track exists — this is an audio-only call upgrading to video
      try {
        let getUserMediaFn;
        if (Platform.OS === 'web') {
          getUserMediaFn = (c) => navigator.mediaDevices.getUserMedia(c);
        } else {
          const webrtc = require('@stream-io/react-native-webrtc');
          getUserMediaFn = (c) => webrtc.mediaDevices.getUserMedia(c);
        }
        const videoStream = await getUserMediaFn({
          video: {
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
            frameRate: { ideal: 30, max: 30 },
            facingMode: facingFront ? 'user' : 'environment',
          },
        });
        const newTrack = videoStream.getVideoTracks()[0];
        localStreamRef.current.addTrack(newTrack);

        // Check if there's already a video sender (transceiver) we can reuse
        const sender = pcRef.current.getSenders().find(s => s.track === null || s.track?.kind === 'video');
        if (sender) {
          await sender.replaceTrack(newTrack);
        } else {
          // No video sender exists — add new track to peer connection
          pcRef.current.addTrack(newTrack, localStreamRef.current);
        }

        setVideoEnabled(true);

        // Web: create local video PiP element if it doesn't exist
        if (Platform.OS === 'web') {
          let localVid = document.getElementById('localCallVideo');
          if (!localVid) {
            localVid = document.createElement('video');
            localVid.id = 'localCallVideo';
            localVid.autoplay = true;
            localVid.playsInline = true;
            localVid.muted = true;
            localVid.style.cssText = 'position:fixed;bottom:180px;right:16px;width:110px;height:160px;object-fit:cover;z-index:30;border-radius:16px;border:2px solid rgba(255,255,255,0.25);cursor:grab;';
            document.body.appendChild(localVid);
            // Make draggable
            let dragging = false, startX = 0, startY = 0, origX = 0, origY = 0;
            localVid.addEventListener('mousedown', (e) => {
              dragging = true; startX = e.clientX; startY = e.clientY;
              const rect = localVid.getBoundingClientRect();
              origX = rect.left; origY = rect.top;
              localVid.style.cursor = 'grabbing';
              e.preventDefault();
            });
            document.addEventListener('mousemove', (e) => {
              if (!dragging) return;
              localVid.style.left = (origX + e.clientX - startX) + 'px';
              localVid.style.top = (origY + e.clientY - startY) + 'px';
              localVid.style.right = 'auto';
              localVid.style.bottom = 'auto';
            });
            document.addEventListener('mouseup', () => { dragging = false; if (localVid) localVid.style.cursor = 'grab'; });
          }
          localVid.srcObject = localStreamRef.current;
          localVid.style.display = 'block';
        }

        if (Platform.OS !== 'web' && localStreamRef.current.toURL) {
          setLocalStreamUrl(localStreamRef.current.toURL());
        }

        // Notify remote peer that video was enabled (audio→video upgrade)
        sendSignaling('call_video_toggle', {
          call_id: callId,
          target_email: contactEmail,
          video_enabled: true,
        });

        // Renegotiate so the remote peer knows about the new video track
        try {
          const offer = await pcRef.current.createOffer();
          await pcRef.current.setLocalDescription(offer);
          sendSignaling('call_offer', {
            call_id: callId,
            target_email: contactEmail,
            sdp: offer.sdp,
            sdp_type: offer.type,
          });
        } catch (reErr) {
          console.error('[Call] renegotiation after video add failed:', reErr);
        }
      } catch (err) {
        console.error('[Call] Failed to add video track:', err);
      }
    }
    resetControlsTimer();
  }, [facingFront, resetControlsTimer, callId, contactEmail, sendSignaling]);

  // Flip camera (front/back)
  const handleFlipCamera = useCallback(async () => {
    if (!localStreamRef.current || !pcRef.current) return;
    const videoTrack = localStreamRef.current.getVideoTracks()[0];
    if (!videoTrack) return;

    const newFacing = !facingFront;

    if (Platform.OS !== 'web') {
      // Native: use _switchCamera() if available (react-native-webrtc)
      try {
        if (typeof videoTrack._switchCamera === 'function') {
          videoTrack._switchCamera();
          setFacingFront(newFacing);
          resetControlsTimer();
          return;
        }
      } catch {}
    }

    // Web fallback: get new stream with opposite facingMode
    try {
      let getUserMediaFn;
      if (Platform.OS === 'web') {
        getUserMediaFn = (c) => navigator.mediaDevices.getUserMedia(c);
      } else {
        const webrtc = require('@stream-io/react-native-webrtc');
        getUserMediaFn = (c) => webrtc.mediaDevices.getUserMedia(c);
      }

      const newStream = await getUserMediaFn({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: newFacing ? 'user' : 'environment',
        },
      });

      const newTrack = newStream.getVideoTracks()[0];

      // Replace track in peer connection
      const sender = pcRef.current.getSenders().find(s => s.track?.kind === 'video');
      if (sender) {
        await sender.replaceTrack(newTrack);
      }

      // Stop old track and replace in local stream
      videoTrack.stop();
      localStreamRef.current.removeTrack(videoTrack);
      localStreamRef.current.addTrack(newTrack);

      if (Platform.OS !== 'web' && localStreamRef.current.toURL) {
        setLocalStreamUrl(localStreamRef.current.toURL());
      }

      setFacingFront(newFacing);
    } catch (err) {
      console.error('[Call] flip camera error:', err);
    }
    resetControlsTimer();
  }, [facingFront, resetControlsTimer]);

  // Screen share (web only)
  const handleScreenShare = useCallback(async () => {
    if (Platform.OS !== 'web') return; // Screen sharing only on web
    if (!pcRef.current) return;

    if (screenSharing) {
      // Stop screen sharing, restore camera
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach(t => t.stop());
        screenStreamRef.current = null;
      }

      // Restore camera track
      const videoTrack = localStreamRef.current?.getVideoTracks()[0];
      if (videoTrack) {
        const sender = pcRef.current.getSenders().find(s => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(videoTrack);
      }
      setScreenSharing(false);
    } else {
      // Start screen sharing
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        screenStreamRef.current = screenStream;

        const screenTrack = screenStream.getVideoTracks()[0];
        const sender = pcRef.current.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          await sender.replaceTrack(screenTrack);
        } else {
          pcRef.current.addTrack(screenTrack, screenStream);
        }

        // When user stops sharing via browser UI
        screenTrack.onended = () => {
          setScreenSharing(false);
          screenStreamRef.current = null;
          const camTrack = localStreamRef.current?.getVideoTracks()[0];
          if (camTrack) {
            const s = pcRef.current?.getSenders()?.find(s => s.track?.kind === 'video');
            if (s) s.replaceTrack(camTrack).catch(() => {});
          }
        };

        setScreenSharing(true);
      } catch {
        // User cancelled screen share picker
      }
    }
    resetControlsTimer();
  }, [screenSharing, resetControlsTimer]);

  // Toggle speaker
  const handleToggleSpeaker = useCallback(async () => {
    const newSpeakerOn = !speakerOn;
    setSpeakerOn(newSpeakerOn);

    if (Platform.OS === 'web') {
      // Web: use setSinkId to switch between default (earpiece-like) and speaker output
      const audioEl = remoteAudioRef.current || document.getElementById('remoteCallAudio');
      if (audioEl && typeof audioEl.setSinkId === 'function') {
        try {
          // Enumerate audio output devices to find a speaker
          const devices = await navigator.mediaDevices.enumerateDevices();
          const outputDevices = devices.filter(d => d.kind === 'audiooutput');
          if (newSpeakerOn) {
            // Try to find a speaker device (usually the default or one labeled 'speaker')
            const speaker = outputDevices.find(d =>
              d.label.toLowerCase().includes('speaker') ||
              d.label.toLowerCase().includes('alto-falante')
            ) || outputDevices.find(d => d.deviceId === 'default') || outputDevices[0];
            if (speaker) {
              await audioEl.setSinkId(speaker.deviceId);
            }
          } else {
            // Switch to communications device (earpiece-like) if available, otherwise default
            const earpiece = outputDevices.find(d =>
              d.deviceId === 'communications' ||
              d.label.toLowerCase().includes('earpiece') ||
              d.label.toLowerCase().includes('fone')
            );
            if (earpiece) {
              await audioEl.setSinkId(earpiece.deviceId);
            } else {
              await audioEl.setSinkId('default');
            }
          }
        } catch (err) {
          console.log('[Call] setSinkId error:', err);
        }
      }
    } else {
      // Native: toggle speaker using InCallManager or expo-audio
      try {
        const { setAudioModeAsync } = require('expo-audio');
        await setAudioModeAsync({
          interruptionMode: 'doNotMix',
          playsInSilentMode: true,
          shouldPlayInBackground: true,
          allowsRecording: true,
        });
      } catch {}
      if (Platform.OS !== 'web') {
        try {
          const InCallManager = require('react-native-incall-manager').default;
          // speakerOn = true → force speaker ON, false → allow receiver/earpiece
          InCallManager.setForceSpeakerphoneOn(newSpeakerOn);
          console.log('[Call] Speaker toggled:', newSpeakerOn ? 'ON (speaker)' : 'OFF (earpiece)');
        } catch (e) {
          console.warn('[Call] InCallManager error:', e?.message);
        }
      }
    }
    resetControlsTimer();
  }, [speakerOn, resetControlsTimer]);

  // Emoji reactions on call
  const CALL_EMOJIS = useMemo(() => ['❤️', '😂', '😮', '👏', '🔥', '🎉', '👍', '😢'], []);

  const handleSendEmoji = useCallback((emoji) => {
    const id = Date.now() + Math.random();
    const x = 20 + Math.random() * (SCREEN_W - 80);
    const anim = new Animated.Value(0);
    setFloatingEmojis(prev => [...prev, { id, emoji, x, anim }]);
    Animated.timing(anim, {
      toValue: 1,
      duration: 2000,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start(() => {
      setFloatingEmojis(prev => prev.filter(e => e.id !== id));
    });
    setShowEmojiBar(false);
    resetControlsTimer();
  }, [resetControlsTimer]);

  // Hold call — mute audio + disable video temporarily
  const handleToggleHold = useCallback(() => {
    if (!localStreamRef.current) return;
    const newHold = !onHold;

    if (newHold) {
      // Going on hold: save current state, mute audio, disable video
      holdStateRef.current.audioWasMuted = audioMuted;
      holdStateRef.current.videoWasEnabled = videoEnabled;

      // Mute audio
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) audioTrack.enabled = false;
      setAudioMuted(true);

      // Disable video if enabled
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack && videoTrack.enabled) {
        videoTrack.enabled = false;
        setVideoEnabled(false);
        if (Platform.OS === 'web') {
          const localVid = document.getElementById('localCallVideo');
          if (localVid) localVid.style.display = 'none';
        }
        if (Platform.OS !== 'web') setLocalStreamUrl(null);
      }
    } else {
      // Coming off hold: restore previous state
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) audioTrack.enabled = !holdStateRef.current.audioWasMuted;
      setAudioMuted(holdStateRef.current.audioWasMuted);

      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack && holdStateRef.current.videoWasEnabled) {
        videoTrack.enabled = true;
        setVideoEnabled(true);
        if (Platform.OS === 'web') {
          const localVid = document.getElementById('localCallVideo');
          if (localVid) localVid.style.display = 'block';
        }
        if (Platform.OS !== 'web' && localStreamRef.current.toURL) {
          setLocalStreamUrl(localStreamRef.current.toURL());
        }
      }
    }

    setOnHold(newHold);
    resetControlsTimer();
  }, [onHold, audioMuted, videoEnabled, resetControlsTimer]);

  // Listen for remote peer's video toggle notification
  useEffect(() => {
    try {
      const mailWs = require('../services/websocket').default;
      const unsub = mailWs.on('call_video_toggle', (data) => {
        if (data?.call_id !== callId) return;
        const remoteVideoOn = data.video_enabled ?? data.videoEnabled;
        console.log('[Call] Remote peer video toggle:', remoteVideoOn);

        // When remote enables video, ensure we show the remote video element
        if (Platform.OS === 'web' && remoteVideoOn) {
          // The remote video element will be created/updated when the track arrives via ontrack
          // but we should ensure the remoteCallVideo element exists
          setTimeout(() => {
            const remoteStream = remoteAudioRef.current?.srcObject;
            if (remoteStream && remoteStream.getVideoTracks().length > 0) {
              let vid = document.getElementById('remoteCallVideo');
              if (!vid) {
                vid = document.createElement('video');
                vid.id = 'remoteCallVideo';
                vid.autoplay = true;
                vid.playsInline = true;
                vid.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:1;';
                document.body.appendChild(vid);
              }
              vid.srcObject = remoteStream;
              remoteVideoRef.current = vid;
            }
          }, 500);
        }

        // When remote disables video, hide the remote video element
        if (Platform.OS === 'web' && !remoteVideoOn) {
          const vid = document.getElementById('remoteCallVideo');
          if (vid) {
            vid.remove();
            remoteVideoRef.current = null;
          }
        }
      });
      return () => { try { unsub(); } catch {} };
    } catch {}
  }, [callId]);

  // Video filters
  const VIDEO_FILTERS = useMemo(() => [
    { key: null, label: 'Normal', color: '#fff' },
    { key: 'warm', label: '☀️ Warm', color: '#ff9800' },
    { key: 'cool', label: '❄️ Cool', color: '#03a9f4' },
    { key: 'bw', label: '⬛ B&W', color: '#888' },
    { key: 'vintage', label: '📷 Vintage', color: '#d4a574' },
    { key: 'beauty', label: '✨ Beauty', color: '#e91e63' },
  ], []);

  const getFilterStyle = useCallback((filter) => {
    if (!filter) return {};
    switch (filter) {
      case 'warm': return Platform.OS === 'web' ? { filter: 'saturate(1.3) sepia(0.15) brightness(1.05)' } : { opacity: 0.92 };
      case 'cool': return Platform.OS === 'web' ? { filter: 'saturate(0.9) hue-rotate(15deg) brightness(1.05)' } : {};
      case 'bw': return Platform.OS === 'web' ? { filter: 'grayscale(1)' } : {};
      case 'vintage': return Platform.OS === 'web' ? { filter: 'sepia(0.4) contrast(1.1) brightness(0.95)' } : {};
      case 'beauty': return Platform.OS === 'web' ? { filter: 'brightness(1.08) contrast(0.95) saturate(1.1) blur(0.3px)' } : {};
      default: return {};
    }
  }, []);

  // Status text
  let statusText = t('call.ringing') || 'Chamando...';
  if (connectionFailed) statusText = t('call.connectionFailed') || 'Nao foi possivel conectar. Tente novamente.';
  else if (errorMsg) statusText = errorMsg;
  else if (ended) statusText = t('call.ended') || 'Chamada encerrada';
  else if (reconnecting) statusText = t('call.reconnecting') || 'Reconectando...';
  else if (onHold) statusText = (t('call.onHold') || 'Em espera') + ' · ' + formatDuration(callDuration);
  else if (screenSharing) statusText = t('call.screenSharing') || 'Compartilhando tela';
  else if (peerConnected) statusText = formatDuration(callDuration);

  // Signal bars component — maps 5-level quality score to visual bars
  const SignalBars = ({ quality, score, rtt }) => {
    // Map quality score (1-5) to bar count (1-5)
    const bars = score || (quality === 'good' ? 4 : quality === 'medium' ? 2 : 1);
    const color = bars >= 4 ? '#25D366' : bars === 3 ? '#f59e0b' : '#ef4444';
    return (
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 1.5, height: 14, marginLeft: 8 }}>
        {[1, 2, 3, 4, 5].map(i => (
          <View key={i} style={{ width: 3, height: 2 + i * 2.5, borderRadius: 1, backgroundColor: i <= bars ? color : 'rgba(255,255,255,0.2)' }} />
        ))}
        {rtt !== null && rtt !== undefined && (
          <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 9, marginLeft: 3, fontVariant: ['tabular-nums'] }}>{rtt}ms</Text>
        )}
      </View>
    );
  };

  // Get RTCView for native video rendering
  const RTCView = Platform.OS !== 'web' ? (() => {
    try { return require('@stream-io/react-native-webrtc').RTCView; } catch { return null; }
  })() : null;

  const showRemoteVideo = videoEnabled && peerConnected && (Platform.OS === 'web' ? !!remoteVideoRef.current : !!remoteStreamUrl);
  const showLocalVideo = videoEnabled && (Platform.OS === 'web' ? !!localStreamRef.current : !!localStreamUrl);
  const isVideoCall = isVideoParam === '1' || isVideoParam === 'true';

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
      <StatusBar barStyle="light-content" />

      {/* Remote video (full screen) — native */}
      {Platform.OS !== 'web' && RTCView && remoteStreamUrl && videoEnabled && peerConnected && (
        <RTCView
          streamURL={remoteStreamUrl}
          style={StyleSheet.absoluteFill}
          objectFit="cover"
          zOrder={0}
        />
      )}

      {/* Tap area to toggle controls in video mode */}
      <TouchableOpacity
        activeOpacity={1}
        onPress={handleScreenTap}
        style={StyleSheet.absoluteFill}
      >
        {/* Audio-only overlay / video overlay */}
        <View style={[styles.audioOverlay, {
          backgroundColor: showRemoteVideo ? 'transparent' : (isVideoCall ? '#064e3b' : '#1a1a2e'),
        }]}>
          {/* Top bar - WhatsApp style */}
          <Animated.View style={[styles.topBar, { paddingTop: insets.top + 10, opacity: controlsFadeAnim }]}>
            <TouchableOpacity onPress={handleMinimize} style={styles.backBtn}>
              <IconArrowLeft size={22} color="#fff" />
            </TouchableOpacity>
            <View style={styles.topInfo}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={styles.topName} numberOfLines={1}>{callerName}</Text>
                {peerConnected && !ended && <SignalBars quality={connectionQuality} score={qualityScore} rtt={rttMs} />}
              </View>
              <Text style={[styles.topStatus, reconnecting && { color: '#f59e0b' }]}>{statusText}</Text>
            </View>
            {/* Encryption indicator - WhatsApp style */}
            {peerConnected && (
              <View style={styles.encryptionBadge}>
                <Text style={styles.encryptionIcon}>🔒</Text>
                <Text style={styles.encryptionText}>E2E</Text>
              </View>
            )}
          </Animated.View>

          {/* Weak connection warning banner */}
          {showWeakBanner && peerConnected && !ended && (
            <View style={styles.weakBanner}>
              <Text style={styles.weakBannerText}>{t('call.poorConnection') || 'Conexao fraca'}</Text>
            </View>
          )}

          {/* Suggest audio-only when quality is very bad */}
          {suggestAudioOnly && peerConnected && !ended && (
            <TouchableOpacity
              style={styles.audioOnlyBanner}
              onPress={() => {
                handleToggleVideo();
                setSuggestAudioOnly(false);
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.audioOnlyBannerText}>
                {t('call.suggestAudioOnly') || 'Conexao muito fraca. Toque para desativar o video.'}
              </Text>
            </TouchableOpacity>
          )}

          {/* Center - Avatar (shown when no video or not connected yet) */}
          {!showRemoteVideo && (
            <View style={styles.centerArea}>
              {/* Pulse rings behind avatar */}
              {!peerConnected && (
                <>
                  <Animated.View style={[styles.pulseRing, styles.pulseRingOuter, {
                    transform: [{ scale: pulseAnim }],
                    opacity: Animated.subtract(1, Animated.multiply(pulseAnim, 0.5)),
                  }]} />
                  <Animated.View style={[styles.pulseRing, styles.pulseRingInner, {
                    transform: [{ scale: pulseAnim }],
                  }]} />
                </>
              )}
              <Animated.View style={{ transform: [{ scale: peerConnected ? 1 : pulseAnim }] }}>
                <AvatarCircle name={callerName} email={contactEmail} size={140} />
              </Animated.View>
              <Text style={styles.centerName}>{callerName}</Text>
              <Text style={[styles.centerStatus, connectionFailed && { color: '#ef4444' }]}>{statusText}</Text>
              {ended && (
                <Text style={styles.endedHint}>{t('call.ended') || 'Chamada encerrada'}</Text>
              )}
              {connectionFailed && !ended && (
                <View style={styles.reconnectContainer}>
                  <TouchableOpacity
                    style={styles.reconnectBtn}
                    onPress={handleReconnect}
                    activeOpacity={0.7}
                  >
                    <IconPhone size={18} color="#fff" />
                    <Text style={styles.reconnectBtnText}>{t('call.reconnect') || 'Reconectar'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.reconnectEndBtn}
                    onPress={handleEndCall}
                    activeOpacity={0.7}
                  >
                    <IconPhoneOff size={18} color="#fff" />
                    <Text style={styles.reconnectEndBtnText}>{t('call.hangUp') || 'Desligar'}</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}

          {/* When video connected, show minimal overlay */}
          {showRemoteVideo && (
            <View style={styles.centerArea}>
              <View style={{ flex: 1 }} />
              {ended && (
                <Text style={styles.endedHint}>{t('call.ended') || 'Chamada encerrada'}</Text>
              )}
            </View>
          )}
        </View>
      </TouchableOpacity>

      {/* Floating emoji reactions */}
      {floatingEmojis.map(({ id, emoji, x, anim }) => (
        <Animated.View
          key={id}
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: x,
            bottom: 200,
            zIndex: 50,
            opacity: anim.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0, 1, 0] }),
            transform: [{
              translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [0, -SCREEN_H * 0.5] }),
            }, {
              scale: anim.interpolate({ inputRange: [0, 0.15, 0.3, 1], outputRange: [0.3, 1.3, 1, 0.8] }),
            }],
          }}
        >
          <Text style={{ fontSize: 48 }}>{emoji}</Text>
        </Animated.View>
      ))}

      {/* Local video preview (picture-in-picture) — draggable */}
      {Platform.OS !== 'web' && RTCView && localStreamUrl && videoEnabled && (
        <Animated.View
          {...pipPanResponder.panHandlers}
          style={[styles.localVideoContainer, { transform: pipPosition.getTranslateTransform() }]}
        >
          <RTCView
            streamURL={localStreamUrl}
            style={styles.localVideo}
            objectFit="cover"
            mirror={facingFront}
            zOrder={1}
          />
          <TouchableOpacity style={styles.pipFlipBtn} onPress={handleFlipCamera} activeOpacity={0.7}>
            <IconCameraFlip size={16} color="#fff" />
          </TouchableOpacity>
        </Animated.View>
      )}

      {/* "More" bottom sheet — emoji reactions + video effects */}
      {showMoreSheet && peerConnected && !ended && (
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setShowMoreSheet(false)}
          style={styles.moreSheetOverlay}
        >
          <TouchableOpacity activeOpacity={1} style={[styles.moreSheet, { paddingBottom: insets.bottom + 20 }]}>
            {/* Drag handle */}
            <View style={styles.moreSheetHandle} />

            {/* Emoji reactions section */}
            <Text style={styles.moreSheetSectionTitle}>{t('call.reactions') || 'Reacoes'}</Text>
            <View style={styles.moreSheetEmojiRow}>
              {CALL_EMOJIS.map(emoji => (
                <TouchableOpacity key={emoji} onPress={() => { handleSendEmoji(emoji); setShowMoreSheet(false); }} style={styles.emojiBtnItem}>
                  <Text style={{ fontSize: 32 }}>{emoji}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Video filters section — only when video is enabled */}
            {videoEnabled && (
              <>
                <Text style={[styles.moreSheetSectionTitle, { marginTop: 16 }]}>{t('call.effects') || 'Efeitos'}</Text>
                <View style={styles.moreSheetFilterRow}>
                  {VIDEO_FILTERS.map(f => (
                    <TouchableOpacity
                      key={f.key || 'none'}
                      onPress={() => { setActiveFilter(f.key); setShowMoreSheet(false); }}
                      style={[styles.filterItem, activeFilter === f.key && styles.filterItemActive]}
                    >
                      <View style={[styles.filterDot, { backgroundColor: f.color }]} />
                      <Text style={styles.filterLabel}>{f.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      )}

      {/* Bottom controls — WhatsApp style: 2 rows */}
      {!ended && !connectionFailed && (
        <Animated.View style={[styles.controlsBar, { paddingBottom: insets.bottom + 16, opacity: controlsFadeAnim }]}>
          {/* Top row: secondary controls */}
          <View style={styles.controlsRowTop}>
            {/* Speaker */}
            <TouchableOpacity
              style={styles.controlBtn}
              onPress={handleToggleSpeaker}
              activeOpacity={0.7}
            >
              <View style={[styles.controlBtnCircle, speakerOn && styles.controlBtnCircleActive]}>
                <IconVolume2 size={22} color="#fff" />
              </View>
              <Text style={styles.controlLabel}>{t('call.speaker') || 'Alto-falante'}</Text>
            </TouchableOpacity>

            {/* Video toggle */}
            <TouchableOpacity
              style={styles.controlBtn}
              onPress={handleToggleVideo}
              activeOpacity={0.7}
            >
              <View style={[styles.controlBtnCircle, videoEnabled && styles.controlBtnCircleActive]}>
                {videoEnabled ? <IconVideo size={22} color="#fff" /> : <IconVideoOff size={22} color="#fff" />}
              </View>
              <Text style={styles.controlLabel}>{t('call.video') || 'Video'}</Text>
            </TouchableOpacity>

            {/* Mute */}
            <TouchableOpacity
              style={styles.controlBtn}
              onPress={handleToggleMute}
              activeOpacity={0.7}
            >
              <View style={[styles.controlBtnCircle, audioMuted && styles.controlBtnCircleActive]}>
                {audioMuted ? <IconMicOff size={22} color="#fff" /> : <IconMic size={22} color="#fff" />}
              </View>
              <Text style={styles.controlLabel}>{audioMuted ? (t('call.unmute') || 'Ativar') : (t('call.mute') || 'Mudo')}</Text>
            </TouchableOpacity>

            {/* Hold */}
            {peerConnected && (
              <TouchableOpacity
                style={styles.controlBtn}
                onPress={handleToggleHold}
                activeOpacity={0.7}
              >
                <View style={[styles.controlBtnCircle, onHold && styles.controlBtnCircleHold]}>
                  {onHold ? <IconPlay size={22} color="#fff" /> : <IconPause size={22} color="#fff" />}
                </View>
                <Text style={styles.controlLabel}>{onHold ? (t('call.unhold') || 'Retomar') : (t('call.hold') || 'Espera')}</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Bottom row: camera flip + end call + screen share + more */}
          <View style={styles.controlsRowBottom}>
            {/* Camera flip - only show when video is enabled */}
            {videoEnabled ? (
              <TouchableOpacity
                style={styles.controlBtn}
                onPress={handleFlipCamera}
                activeOpacity={0.7}
              >
                <View style={styles.controlBtnCircle}>
                  <IconCameraFlip size={22} color="#fff" />
                </View>
                <Text style={styles.controlLabel}>{t('call.flipCamera') || 'Girar'}</Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.controlBtnPlaceholder} />
            )}

            {/* End call button - big red */}
            <TouchableOpacity style={styles.endCallBtn} onPress={handleEndCall} activeOpacity={0.7}>
              <IconPhoneOff size={28} color="#fff" />
            </TouchableOpacity>

            {/* Screen share (web) or More button */}
            {Platform.OS === 'web' ? (
              <TouchableOpacity
                style={styles.controlBtn}
                onPress={handleScreenShare}
                activeOpacity={0.7}
              >
                <View style={[styles.controlBtnCircle, screenSharing && styles.controlBtnCircleScreenShare]}>
                  <IconScreenShare size={22} color="#fff" />
                </View>
                <Text style={styles.controlLabel}>{t('call.screenShare') || 'Tela'}</Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.controlBtnPlaceholder} />
            )}

            {/* More button — opens bottom sheet with emoji + effects */}
            {peerConnected && (
              <TouchableOpacity
                style={styles.controlBtn}
                onPress={() => { setShowMoreSheet(prev => !prev); }}
                activeOpacity={0.7}
              >
                <View style={[styles.controlBtnCircle, showMoreSheet && styles.controlBtnCircleActive]}>
                  <IconMoreHorizontal size={22} color="#fff" />
                </View>
                <Text style={styles.controlLabel}>{t('call.more') || 'Mais'}</Text>
              </TouchableOpacity>
            )}
          </View>
        </Animated.View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  audioOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 5,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    zIndex: 10,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  topInfo: {
    flex: 1,
    marginLeft: 12,
  },
  topName: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  topStatus: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
    marginTop: 1,
  },
  encryptionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 3,
  },
  encryptionIcon: {
    fontSize: 10,
  },
  encryptionText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 10,
    fontWeight: '600',
  },
  centerArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 180,
  },
  pulseRing: {
    position: 'absolute',
    borderRadius: 999,
    borderWidth: 1,
  },
  pulseRingOuter: {
    width: 200,
    height: 200,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  pulseRingInner: {
    width: 170,
    height: 170,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  centerName: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '700',
    marginTop: 24,
    textAlign: 'center',
  },
  centerStatus: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 15,
    marginTop: 6,
  },
  endedHint: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 13,
    marginTop: 12,
  },
  reconnectContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginTop: 24,
  },
  reconnectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#25D366',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 30,
  },
  reconnectBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  reconnectEndBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#ef4444',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 30,
  },
  reconnectEndBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  controlsBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    alignItems: 'center',
    paddingTop: 20,
    paddingHorizontal: 24,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  controlsRowTop: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 32,
    marginBottom: 20,
  },
  controlsRowBottom: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 32,
    marginBottom: 4,
  },
  controlBtn: {
    alignItems: 'center',
    gap: 6,
    width: 64,
  },
  controlBtnPlaceholder: {
    width: 64,
  },
  controlBtnActive: {},
  controlBtnCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlBtnCircleActive: {
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  controlBtnCircleScreenShare: {
    backgroundColor: '#25d366',
  },
  controlLabel: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 11,
    fontWeight: '500',
    textAlign: 'center',
  },
  endCallBtn: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: '#ef4444',
    alignItems: 'center',
    justifyContent: 'center',
  },
  localVideoContainer: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 110,
    height: 160,
    borderRadius: 16,
    overflow: 'hidden',
    zIndex: 30,
    elevation: 10,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  localVideo: {
    flex: 1,
  },
  pipFlipBtn: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emojiBar: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderRadius: 28,
    paddingVertical: 10,
    paddingHorizontal: 12,
    zIndex: 40,
    ...Platform.select({
      web: { backdropFilter: 'blur(16px)' },
      default: {},
    }),
  },
  emojiBtnItem: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterBar: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderRadius: 20,
    paddingVertical: 12,
    paddingHorizontal: 16,
    zIndex: 40,
    ...Platform.select({
      web: { backdropFilter: 'blur(16px)' },
      default: {},
    }),
  },
  filterItem: {
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 12,
    gap: 4,
  },
  filterItemActive: {
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  filterDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  filterLabel: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '500',
  },
  controlBtnCircleHold: {
    backgroundColor: '#f59e0b',
  },
  weakBanner: {
    position: 'absolute',
    top: 100,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(239, 68, 68, 0.85)',
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignItems: 'center',
    zIndex: 15,
  },
  weakBannerText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  audioOnlyBanner: {
    position: 'absolute',
    top: 140,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(245, 158, 11, 0.9)',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
    zIndex: 15,
  },
  audioOnlyBannerText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '500',
    textAlign: 'center',
  },
  moreSheetOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 45,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  moreSheet: {
    backgroundColor: 'rgba(30,30,30,0.97)',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 12,
    paddingHorizontal: 20,
    ...Platform.select({
      web: { backdropFilter: 'blur(20px)' },
      default: {},
    }),
  },
  moreSheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.3)',
    alignSelf: 'center',
    marginBottom: 16,
  },
  moreSheetSectionTitle: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
    marginLeft: 4,
  },
  moreSheetEmojiRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 4,
  },
  moreSheetFilterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 8,
  },
});
