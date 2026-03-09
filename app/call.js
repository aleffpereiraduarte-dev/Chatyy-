import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Dimensions,
  Animated, Easing, StatusBar,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import AvatarCircle from '../components/AvatarCircle';
import {
  IconMic, IconMicOff, IconVideo, IconVideoOff, IconPhoneOff,
  IconVolume2, IconArrowLeft,
} from '../components/Icons';
import { reportConnected, endCall as callKeepEnd, startCall as callKeepStart } from '../services/callkeep';
import { getPendingOffer, getPendingIceCandidates } from '../components/IncomingCallListener';
import { setActiveCall, clearActiveCall } from '../components/ActiveCallBar';
import { addCallToHistory } from '../components/ChatCallsTab';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

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
  const [speakerOn, setSpeakerOn] = useState(isVideoParam === '1' || isVideoParam === 'true');
  const [callDuration, setCallDuration] = useState(0);
  const [peerConnected, setPeerConnected] = useState(false);
  const [ended, setEnded] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  const timerRef = useRef(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const endedRef = useRef(false);

  // WebRTC refs
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const iceCandidateQueueRef = useRef([]);
  const wsUnsubsRef = useRef([]);

  // Native streams for RTCView
  const [localStreamUrl, setLocalStreamUrl] = useState(null);
  const [remoteStreamUrl, setRemoteStreamUrl] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);

  const isCaller = isCallerParam === '1' || isCallerParam === 'true';
  const callerName = contactName || contactEmail?.split('@')[0] || '?';

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
    return () => clearActiveCall();
  }, []);

  // Store RTC constructors in refs (different on web vs native)
  const rtcRef = useRef({
    PeerConnection: null,
    SessionDescription: null,
    IceCandidate: null,
  });

  const formatDuration = (secs) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // ICE servers config - TURN credentials are updated dynamically from signaling server
  const turnCredsRef = useRef(null);
  const getIceConfig = () => {
    const config = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    };
    if (turnCredsRef.current) {
      config.iceServers.push({
        urls: turnCredsRef.current.urls,
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
      // Web: create HTML audio/video elements
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
      // Native: set stream URL for RTCView
      if (stream?.toURL) {
        setRemoteStreamUrl(stream.toURL());
      }
    }
  }, []);

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
    } catch {}
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

      // Process queued ICE candidates
      for (const candidate of iceCandidateQueueRef.current) {
        try { await pc.addIceCandidate(new (rtcRef.current.IceCandidate || RTCIceCandidate)(candidate)); } catch {}
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

      // Process queued ICE candidates
      for (const candidate of iceCandidateQueueRef.current) {
        try { await pc.addIceCandidate(new (rtcRef.current.IceCandidate || RTCIceCandidate)(candidate)); } catch {}
      }
      iceCandidateQueueRef.current = [];
    } catch (err) {
      console.error('Failed to handle offer:', err);
    }
  }, [callId, contactEmail, sendSignaling]);

  // End the call
  const handleEndCall = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    setEnded(true);
    clearActiveCall();

    // Log call to history
    addCallToHistory({
      contactEmail,
      contactName: callerName,
      callId,
      type: isCaller ? 'outgoing' : 'incoming',
      video: isVideoParam === '1' || isVideoParam === 'true',
      timestamp: new Date().toISOString(),
      duration: callDuration,
    }).catch(() => {});

    sendSignaling('call_end', {
      call_id: callId,
      target_email: contactEmail,
      reason: 'hangup',
    });

    // Cleanup
    callKeepEnd(callId); // End on native call UI
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
    if (pcRef.current) {
      try { pcRef.current.close(); } catch {}
      pcRef.current = null;
    }

    setTimeout(() => router.back(), 800);
  }, [callId, contactEmail, sendSignaling, router]);

  // Initialize WebRTC call
  useEffect(() => {
    // On native, import react-native-webrtc; on web, use browser APIs
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
        setErrorMsg(t('call.webOnly') || 'Chamadas nao disponiveis nesta versao');
        return;
      }
    }

    // Store constructors in ref so callbacks can use them
    rtcRef.current = {
      PeerConnection: RTC_PeerConnection,
      SessionDescription: RTC_SessionDescription,
      IceCandidate: RTC_IceCandidate,
    };

    let mounted = true;

    const setupCall = async () => {
      try {
        // Get user media
        const video = isVideoParam === '1' || isVideoParam === 'true';
        const stream = await getUserMediaFn({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: video ? { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } : false,
        });

        if (!mounted) {
          stream.getTracks().forEach(tr => tr.stop());
          return;
        }

        localStreamRef.current = stream;

        // Activate audio session for VoIP on native
        if (Platform.OS !== 'web') {
          try {
            const { RTCAudioSession } = require('@stream-io/react-native-webrtc');
            RTCAudioSession.audioSessionDidActivate();
          } catch {}
        }

        // Set local stream URL for native RTCView
        if (Platform.OS !== 'web' && stream?.toURL) {
          setLocalStreamUrl(stream.toURL());
        }

        // Create peer connection
        const pc = new RTC_PeerConnection(getIceConfig());
        pcRef.current = pc;

        // Add local tracks
        stream.getTracks().forEach(track => {
          pc.addTrack(track, stream);
        });

        // Handle remote tracks
        pc.ontrack = (event) => {
          if (event.streams && event.streams[0]) {
            attachRemoteStream(event.streams[0]);
            if (mounted) {
              setPeerConnected(true);
              reportConnected(callId); // Tell CallKit/ConnectionService call is active
              // Activate audio session on iOS for WebRTC audio routing
              if (Platform.OS !== 'web') {
                try {
                  const { RTCAudioSession } = require('@stream-io/react-native-webrtc');
                  RTCAudioSession.audioSessionDidActivate();
                } catch {}
              }
            }
          }
        };

        // Handle ICE candidates - send to peer
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            sendSignaling('call_ice', {
              call_id: callId,
              target_email: contactEmail,
              candidate: event.candidate.toJSON(),
            });
          }
        };

        // Connection state
        pc.oniceconnectionstatechange = () => {
          const state = pc.iceConnectionState;
          if (state === 'connected' || state === 'completed') {
            if (mounted) setPeerConnected(true);
          } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
            if (mounted && !endedRef.current) {
              handleEndCall();
            }
          }
        };

        // Setup WebSocket signaling listeners
        const mailWs = require('../services/websocket').default;

        const unsubTurn = mailWs.on('call_turn_credentials', (data) => {
          if (data?.call_id === callId && data?.credentials) {
            turnCredsRef.current = data.credentials;
            // Apply TURN to existing PeerConnection
            if (pcRef.current && pcRef.current.setConfiguration) {
              try {
                pcRef.current.setConfiguration(getIceConfig());
              } catch {}
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
            // Extract TURN credentials and apply to PeerConnection
            if (data.turn_credentials) {
              turnCredsRef.current = data.turn_credentials;
              if (pcRef.current && pcRef.current.setConfiguration) {
                try { pcRef.current.setConfiguration(getIceConfig()); } catch {}
              }
            }
            handleOffer(data);
          }
        });
        const unsubEnd = mailWs.on('call_end', (data) => {
          if (data?.call_id === callId && mounted && !endedRef.current) {
            endedRef.current = true;
            setEnded(true);
            if (localStreamRef.current) {
              localStreamRef.current.getTracks().forEach(t => t.stop());
              localStreamRef.current = null;
            }
            if (pcRef.current) {
              try { pcRef.current.close(); } catch {}
              pcRef.current = null;
            }
            setTimeout(() => router.back(), 1500);
          }
        });
        wsUnsubsRef.current = [unsubTurn, unsubAnswer, unsubIce, unsubOffer, unsubEnd];

        // If caller: send invite first, then create and send offer
        if (isCaller) {
          callKeepStart(callId, callerName, contactEmail, video);

          // Send call_invite immediately so callee sees incoming call UI
          sendSignaling('call_invite', {
            call_id: callId,
            target_email: contactEmail,
            conversation_id: conversationId,
            video,
          });

          let offer;
          try {
            offer = await pc.createOffer({
              offerToReceiveAudio: true,
              offerToReceiveVideo: video,
            });
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
          sendSignaling('call_debug', { call_id: callId, msg: 'offer sent, sdp length: ' + (offer.sdp?.length || 0) });
        } else {
          // Callee: check global store for pending SDP offer
          const pendingOffer = getPendingOffer();
          sendSignaling('call_debug', { call_id: callId, msg: 'callee setup: has_pending=' + (!!pendingOffer) + ' has_sdp=' + (!!pendingOffer?.sdp) + ' sdp_len=' + (pendingOffer?.sdp?.length || 0) });

          if (pendingOffer && pendingOffer.sdp) {
            // We have the SDP — process it immediately
            try {
              await pc.setRemoteDescription(new RTC_SessionDescription({
                type: pendingOffer.type || 'offer',
                sdp: pendingOffer.sdp,
              }));

              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);

              sendSignaling('call_answer', {
                call_id: callId,
                target_email: contactEmail,
                sdp: answer.sdp,
                sdp_type: answer.type,
              });
              sendSignaling('call_debug', { call_id: callId, msg: 'callee answer sent, sdp_len=' + (answer.sdp?.length || 0) });

              // Process ICE candidates buffered in IncomingCallListener (arrived before call.js mounted)
              const bufferedCandidates = getPendingIceCandidates();
              if (bufferedCandidates.length > 0) {
                sendSignaling('call_debug', { call_id: callId, msg: 'processing ' + bufferedCandidates.length + ' buffered ICE candidates' });
                for (const candidate of bufferedCandidates) {
                  try { await pc.addIceCandidate(new RTC_IceCandidate(candidate)); } catch {}
                }
              }

              // Process queued ICE candidates (arrived after mount but before remote desc)
              for (const candidate of iceCandidateQueueRef.current) {
                try { await pc.addIceCandidate(new RTC_IceCandidate(candidate)); } catch {}
              }
              iceCandidateQueueRef.current = [];
            } catch (calleeErr) {
              sendSignaling('call_debug', { call_id: callId, error: 'callee SDP error: ' + (calleeErr?.message || String(calleeErr)) });
              throw calleeErr;
            }
          } else {
            // No SDP yet — request pending offer and wait for it via WebSocket listener
            sendSignaling('call_debug', { call_id: callId, msg: 'callee: no pending SDP, requesting offer...' });
            try {
              mailWs._send({
                type: 'call_request_offer',
                call_id: callId,
              });
            } catch {}
            // The unsubOffer listener above will handle the offer when it arrives
          }
        }
      } catch (err) {
        console.error('Call setup error:', err);
        if (mounted) {
          setErrorMsg(err.message || 'Erro ao iniciar chamada');
          setTimeout(() => router.back(), 3000);
        }
      }
    };

    setupCall();

    return () => {
      mounted = false;
      // Cleanup on unmount
      wsUnsubsRef.current.forEach(unsub => unsub());
      wsUnsubsRef.current = [];
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => t.stop());
        localStreamRef.current = null;
      }
      if (pcRef.current) {
        try { pcRef.current.close(); } catch {}
        pcRef.current = null;
      }
      // Remove remote audio/video elements
      if (Platform.OS === 'web') {
        const el = document.getElementById('remoteCallAudio');
        if (el) el.remove();
        const vid = document.getElementById('remoteCallVideo');
        if (vid) vid.remove();
      }
    };
  }, []); // Run once on mount

  // Fade in + calling tone (caller only)
  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: Platform.OS !== 'web' }).start();
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
        Animated.timing(pulseAnim, { toValue: 1.08, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [peerConnected]);

  // Call timer when connected
  useEffect(() => {
    if (!peerConnected) return;
    const { stopRingtone } = require('../services/ringtone');
    stopRingtone();
    timerRef.current = setInterval(() => setCallDuration(d => d + 1), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [peerConnected]);

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
  }, []);

  // Toggle video
  const handleToggleVideo = useCallback(async () => {
    if (!localStreamRef.current || !pcRef.current) return;

    const videoTrack = localStreamRef.current.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      setVideoEnabled(videoTrack.enabled);
      if (Platform.OS !== 'web' && localStreamRef.current.toURL) {
        setLocalStreamUrl(videoTrack.enabled ? localStreamRef.current.toURL() : null);
      }
    } else {
      try {
        let getUserMediaFn;
        if (Platform.OS === 'web') {
          getUserMediaFn = (c) => navigator.mediaDevices.getUserMedia(c);
        } else {
          const webrtc = require('@stream-io/react-native-webrtc');
          getUserMediaFn = (c) => webrtc.mediaDevices.getUserMedia(c);
        }
        const videoStream = await getUserMediaFn({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        });
        const newTrack = videoStream.getVideoTracks()[0];
        localStreamRef.current.addTrack(newTrack);
        const sender = pcRef.current.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          await sender.replaceTrack(newTrack);
        } else {
          pcRef.current.addTrack(newTrack, localStreamRef.current);
        }
        setVideoEnabled(true);
        if (Platform.OS !== 'web' && localStreamRef.current.toURL) {
          setLocalStreamUrl(localStreamRef.current.toURL());
        }
      } catch {}
    }
  }, []);

  // Toggle speaker (web: not really applicable, but we can toggle output)
  const handleToggleSpeaker = useCallback(() => {
    setSpeakerOn(prev => !prev);
    // On web, we could try to switch audio output device if supported
    if (Platform.OS === 'web' && remoteAudioRef.current?.setSinkId) {
      // Toggle between default and speaker (mobile browsers may not support this)
    }
  }, []);

  // Status text
  let statusText = t('call.ringing') || 'Chamando...';
  if (errorMsg) statusText = errorMsg;
  else if (ended) statusText = t('call.ended') || 'Chamada encerrada';
  else if (peerConnected) statusText = formatDuration(callDuration);

  // Get RTCView for native video rendering
  const RTCView = Platform.OS !== 'web' ? (() => {
    try { return require('@stream-io/react-native-webrtc').RTCView; } catch { return null; }
  })() : null;

  const showRemoteVideo = videoEnabled && peerConnected && (Platform.OS === 'web' ? !!remoteVideoRef.current : !!remoteStreamUrl);
  const showLocalVideo = videoEnabled && (Platform.OS === 'web' ? !!localStreamRef.current : !!localStreamUrl);

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

      {/* Audio-only overlay / video overlay */}
      <View style={[styles.audioOverlay, {
        backgroundColor: (showRemoteVideo) ? 'transparent' : (videoEnabled ? '#064e3b' : '#1a1a2e'),
      }]}>
        {/* Top bar */}
        <View style={[styles.topBar, { paddingTop: insets.top + 10 }]}>
          <TouchableOpacity onPress={handleEndCall} style={styles.backBtn}>
            <IconArrowLeft size={22} color="#fff" />
          </TouchableOpacity>
          <View style={styles.topInfo}>
            <Text style={styles.topName} numberOfLines={1}>{callerName}</Text>
            <Text style={styles.topStatus}>{statusText}</Text>
          </View>
        </View>

        {/* Center - Avatar (shown when no video or not connected yet) */}
        {!showRemoteVideo && (
          <View style={styles.centerArea}>
            <Animated.View style={{ transform: [{ scale: peerConnected ? 1 : pulseAnim }] }}>
              <AvatarCircle name={callerName} email={contactEmail} size={140} />
            </Animated.View>
            <Text style={styles.centerName}>{callerName}</Text>
            <Text style={styles.centerStatus}>{statusText}</Text>
            {ended && (
              <Text style={styles.endedHint}>{t('call.ended') || 'Chamada encerrada'}</Text>
            )}
          </View>
        )}

        {/* When video connected, show name/duration at center top */}
        {showRemoteVideo && (
          <View style={styles.centerArea}>
            <View style={{ flex: 1 }} />
            {ended && (
              <Text style={styles.endedHint}>{t('call.ended') || 'Chamada encerrada'}</Text>
            )}
          </View>
        )}
      </View>

      {/* Local video preview (picture-in-picture) — native */}
      {Platform.OS !== 'web' && RTCView && localStreamUrl && videoEnabled && (
        <View style={styles.localVideoContainer}>
          <RTCView
            streamURL={localStreamUrl}
            style={styles.localVideo}
            objectFit="cover"
            mirror
            zOrder={1}
          />
        </View>
      )}

      {/* Bottom controls */}
      {!ended && (
        <View style={[styles.controlsBar, { paddingBottom: insets.bottom + 20 }]}>
          <View style={styles.controlsRow}>
            {/* Speaker */}
            <TouchableOpacity
              style={[styles.controlBtn, speakerOn && styles.controlBtnActive]}
              onPress={handleToggleSpeaker}
              activeOpacity={0.7}
            >
              <View style={[styles.controlBtnCircle, speakerOn && styles.controlBtnCircleActive]}>
                <IconVolume2 size={22} color="#fff" />
              </View>
              <Text style={styles.controlLabel}>{t('call.speaker') || 'Alto-falante'}</Text>
            </TouchableOpacity>

            {/* Video */}
            <TouchableOpacity
              style={[styles.controlBtn, videoEnabled && styles.controlBtnActive]}
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
              style={[styles.controlBtn, audioMuted && styles.controlBtnActive]}
              onPress={handleToggleMute}
              activeOpacity={0.7}
            >
              <View style={[styles.controlBtnCircle, audioMuted && styles.controlBtnCircleActive]}>
                {audioMuted ? <IconMicOff size={22} color="#fff" /> : <IconMic size={22} color="#fff" />}
              </View>
              <Text style={styles.controlLabel}>{audioMuted ? (t('call.unmute') || 'Ativar') : (t('call.mute') || 'Mudo')}</Text>
            </TouchableOpacity>
          </View>

          {/* End call button */}
          <TouchableOpacity style={styles.endCallBtn} onPress={handleEndCall} activeOpacity={0.7}>
            <IconPhoneOff size={28} color="#fff" />
          </TouchableOpacity>
        </View>
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
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    marginTop: 1,
  },
  centerArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 120,
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
  controlsBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    alignItems: 'center',
    paddingTop: 16,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  controlsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 36,
    marginBottom: 24,
  },
  controlBtn: {
    alignItems: 'center',
    gap: 6,
  },
  controlBtnActive: {},
  controlBtnCircle: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlBtnCircleActive: {
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  controlLabel: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 11,
    fontWeight: '500',
  },
  endCallBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#ef4444',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  localVideoContainer: {
    position: 'absolute',
    top: 100,
    right: 16,
    width: 110,
    height: 160,
    borderRadius: 12,
    overflow: 'hidden',
    zIndex: 30,
    elevation: 10,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  localVideo: {
    flex: 1,
  },
});
