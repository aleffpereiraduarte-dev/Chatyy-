// Voicemail recorder — shown to the caller after a missed/declined call.
// Self-contained route so it doesn't bloat call.js. Caller sees:
//   "Não atendeu — gravar mensagem de voz?"
// Tap mic to record, tap stop to preview, tap send to upload + commit.
//
// Flow:
//   1. expo-audio (native) / MediaRecorder (web) records to a local tmp file.
//   2. Hard cap 60s — UI stops recording at the cap and the server enforces too.
//   3. On stop: preview with play/re-record/send buttons.
//   4. On send:
//        a. voicemail_init_upload  → presigned PUT
//        b. PUT raw audio bytes to R2
//        c. voicemail_send         → row + chat bubble
//      Each step has an error path that surfaces a banner instead of silently failing.
//   5. On done, navigate back to /chat-conversation with success haptic.
//
// The caller arrives here via `router.replace('/voicemail-recorder?...')`
// from call.js's call_missed / call_declined WS handler.
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Animated, Easing, Platform, StatusBar,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import AvatarCircle from '../components/AvatarCircle';
import * as api from '../services/api';
import * as Haptics from 'expo-haptics';
import { IconMic, IconPlay, IconPause } from '../components/Icons';

const MAX_DURATION_SEC = 60; // matches server-side cap

export default function VoicemailRecorder() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const params = useLocalSearchParams();
  const recipientEmail = String(params.recipient || params.recipient_email || '').trim();
  const recipientName = String(params.name || params.contactName || recipientEmail || '').trim();
  const conversationId = parseInt(String(params.conversationId || params.conversation_id || '0'), 10) || 0;
  const reason = String(params.reason || 'missed'); // 'missed' | 'declined'

  // 'idle' → user just landed here, mic shown
  // 'countdown' → 3..2..1 prep before mic opens (so the user has a beat
  //   to clear their throat instead of fumbling their first word)
  // 'recording' → countdown ticking, stop button shown
  // 'preview' → preview controls (play / re-record / send)
  // 'sending' → upload in flight, spinner
  // 'done' → success, navigating away
  // 'error' → terminal-ish error banner, retry button
  const [phase, setPhase] = useState('idle');
  const [duration, setDuration] = useState(0);
  const [errorMsg, setErrorMsg] = useState(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [countdownTick, setCountdownTick] = useState(3);
  // Cheap waveform during recording — random-walk 12 bars, mirrors the
  // "calling/connected" waveform style already used in ChatCallsTab. We
  // can't tap into the actual mic level on web/native without extra deps,
  // so we drive bars off a timer that visually breathes while recording.
  const waveBars = useRef(Array.from({ length: 14 }, () => new Animated.Value(0.25))).current;
  const countdownAnim = useRef(new Animated.Value(0)).current;
  const countdownTimerRef = useRef(null);

  // Native recorder ref. For web we use MediaRecorder + a Blob.
  const recRef = useRef(null);          // expo-audio recorder OR MediaRecorder (web)
  const recordingUriRef = useRef(null); // file uri (native) or Blob URL (web)
  const recordingBlobRef = useRef(null); // raw Blob (web only)
  const recordingMimeRef = useRef('audio/m4a');
  const timerRef = useRef(null);
  const previewPlayerRef = useRef(null);
  const mountedRef = useRef(true);
  // Ref-based "send in flight" guard. `phase` is closed over in the
  // sendVoicemail callback, so a double-tap in the same render tick would
  // fire two uploads (state hasn't propagated). Using a ref makes the
  // gate synchronous so the duplicate send call no-ops.
  const sendingRef = useRef(false);
  // Track the active mic stream on web. cleanupRecorder previously only
  // stopped tracks when MediaRecorder was still 'recording'; if the user
  // backed out during the brief 'inactive' window, the mic LED stayed on.
  const webStreamRef = useRef(null);

  // Mic-pulse animation while recording. Cheap fade scale loop — purely
  // visual, no impact on recording itself.
  const pulseAnim = useRef(new Animated.Value(1)).current;
  // Red halo behind the mic — breathing 1.5s loop. Sits behind the
  // recording mic button as a soft pulsing ring (scale + opacity), only
  // active in the 'recording' phase. Uses native driver.
  const haloAnim = useRef(new Animated.Value(0)).current;
  // Confetti burst on stop — 12 dot Animated.Values that radiate from the
  // center then fade. Only fired once per stop transition so we don't loop.
  const confettiAnims = useRef(
    Array.from({ length: 12 }, () => ({
      x: new Animated.Value(0),
      y: new Animated.Value(0),
      opacity: new Animated.Value(0),
      scale: new Animated.Value(0),
    }))
  ).current;
  const fireConfetti = useCallback(() => {
    confettiAnims.forEach((dot, i) => {
      const angle = (i / confettiAnims.length) * Math.PI * 2;
      const distance = 64 + Math.random() * 28;
      const dx = Math.cos(angle) * distance;
      const dy = Math.sin(angle) * distance;
      dot.x.setValue(0);
      dot.y.setValue(0);
      dot.opacity.setValue(1);
      dot.scale.setValue(0);
      Animated.parallel([
        Animated.timing(dot.x, { toValue: dx, duration: 380, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(dot.y, { toValue: dy, duration: 380, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(dot.scale, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.timing(dot.opacity, { toValue: 0, duration: 380, delay: 60, useNativeDriver: true }),
      ]).start();
    });
  }, [confettiAnims]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
      if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
      // Best-effort cleanup of any in-flight recorder on hard back-out.
      cleanupRecorder();
      cleanupPreview();
    };
  }, []);

  useEffect(() => {
    if (phase !== 'recording') {
      pulseAnim.setValue(1);
      haloAnim.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.18, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    // Red halo breathing loop — 1.5s in/out. Native driver.
    const haloLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(haloAnim, { toValue: 1, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(haloAnim, { toValue: 0, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    haloLoop.start();
    return () => { loop.stop(); haloLoop.stop(); };
  }, [phase, pulseAnim, haloAnim]);

  // Fire confetti exactly when we transition into 'preview' (i.e. the user
  // just stopped recording successfully). Skip on initial mount.
  const prevPhaseRef = useRef(phase);
  useEffect(() => {
    if (prevPhaseRef.current === 'recording' && phase === 'preview') {
      fireConfetti();
    }
    prevPhaseRef.current = phase;
  }, [phase, fireConfetti]);

  // Waveform jitter loop — runs only while recording, mirrors the
  // ChatCallsTab AudioWaveform pattern so we keep visual language consistent
  // without pulling the mic level from native (would need a heavier dep).
  useEffect(() => {
    if (phase !== 'recording') {
      waveBars.forEach(b => b.setValue(0.25));
      return;
    }
    const anims = waveBars.map((bar, i) => Animated.loop(
      Animated.sequence([
        Animated.timing(bar, {
          toValue: 0.4 + Math.random() * 0.6,
          duration: 280 + i * 40,
          useNativeDriver: false,
        }),
        Animated.timing(bar, {
          toValue: 0.15 + Math.random() * 0.3,
          duration: 240 + i * 50,
          useNativeDriver: false,
        }),
      ])
    ));
    anims.forEach(a => a.start());
    return () => anims.forEach(a => a.stop());
  }, [phase, waveBars]);

  // 3-2-1 prep countdown before recording actually begins.
  // Honors phase changes so a quick back-out cancels cleanly.
  const startCountdown = useCallback(() => {
    setErrorMsg(null);
    setCountdownTick(3);
    setPhase('countdown');
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    // Pop animation for each tick.
    const pop = () => {
      countdownAnim.setValue(0);
      Animated.timing(countdownAnim, { toValue: 1, duration: 600, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    };
    pop();
    countdownTimerRef.current = setInterval(() => {
      setCountdownTick(prev => {
        const next = prev - 1;
        if (next <= 0) {
          clearInterval(countdownTimerRef.current);
          countdownTimerRef.current = null;
          // Defer to next tick so the React state from setPhase
          // doesn't race the recorder permission prompt.
          setTimeout(() => {
            if (mountedRef.current) startRecording();
          }, 50);
          return 0;
        }
        pop();
        try { Haptics.selectionAsync(); } catch {}
        return next;
      });
    }, 800);
  }, [countdownAnim]);

  function cleanupRecorder() {
    try {
      const r = recRef.current;
      if (Platform.OS === 'web') {
        if (r && r.state === 'recording') {
          try { r.stop(); } catch {}
        }
        // Always kill the mic stream — the recorder may already be
        // 'inactive' (post-stop, pre-onstop fire) when the user backs out.
        // Without this the mic LED stays on after navigation.
        try { webStreamRef.current?.getTracks?.().forEach(t => t.stop()); } catch {}
        try { r?.stream?.getTracks?.().forEach(t => t.stop()); } catch {}
        webStreamRef.current = null;
      } else if (r?.__native && typeof r.stop === 'function') {
        r.stop().catch(() => {});
        // Release audio mode so the OS doesn't think we're still capturing.
        try {
          const expoAudio = require('expo-audio');
          expoAudio.setAudioModeAsync?.({ allowsRecording: false }).catch(() => {});
        } catch {}
      }
    } catch {}
    recRef.current = null;
  }

  function cleanupPreview() {
    try {
      const p = previewPlayerRef.current;
      if (!p) return;
      if (Platform.OS === 'web') {
        p.pause();
        p.src = '';
      } else if (typeof p.remove === 'function') {
        p.remove();
      }
    } catch {}
    previewPlayerRef.current = null;
  }

  const startRecording = useCallback(async () => {
    setErrorMsg(null);
    setDuration(0);
    if (Platform.OS === 'web') {
      try {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
          setErrorMsg(t('voicemail.audioNotSupported') || 'Gravação de voz não suportada neste navegador.');
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // If the user already navigated away while waiting on the
        // permission prompt, kill the freshly-granted stream and bail.
        if (!mountedRef.current) {
          try { stream.getTracks().forEach(t => t.stop()); } catch {}
          return;
        }
        webStreamRef.current = stream;
        const mime = (typeof MediaRecorder?.isTypeSupported === 'function' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus'))
          ? 'audio/webm;codecs=opus' : 'audio/webm';
        recordingMimeRef.current = mime.startsWith('audio/webm') ? 'audio/webm' : mime;
        const mr = new MediaRecorder(stream, { mimeType: mime });
        const chunks = [];
        mr.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
        mr.onstop = () => {
          const blob = new Blob(chunks, { type: recordingMimeRef.current });
          recordingBlobRef.current = blob;
          recordingUriRef.current = URL.createObjectURL(blob);
          try { stream.getTracks().forEach(t => t.stop()); } catch {}
        };
        mr.start();
        recRef.current = mr;
        setPhase('recording');
        startTimer();
      } catch (e) {
        if (e?.name === 'NotAllowedError') setErrorMsg(t('voicemail.micDenied') || 'Permissão de microfone negada.');
        else setErrorMsg(t('voicemail.micError') || 'Não foi possível acessar o microfone.');
      }
      return;
    }
    // Native (iOS/Android): use expo-audio.
    try {
      const expoAudio = require('expo-audio');
      const perm = await expoAudio.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setErrorMsg(t('voicemail.micDenied') || 'Permissão de microfone negada.');
        return;
      }
      await expoAudio.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      const AudioMod = require('expo-audio/build/AudioModule').default;
      const { RecordingPresets } = require('expo-audio');
      const recorder = new AudioMod.AudioRecorder(RecordingPresets.HIGH_QUALITY);
      await recorder.prepareToRecordAsync();
      recorder.record();
      recRef.current = { __native: true, recorder, stop: async () => {
        await recorder.stop();
        return { uri: recorder.uri };
      }};
      recordingMimeRef.current = 'audio/m4a';
      setPhase('recording');
      startTimer();
    } catch (e) {
      setErrorMsg((t('voicemail.micError') || 'Erro ao iniciar gravação') + ': ' + (e?.message || ''));
    }
  }, [t]);

  function startTimer() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      if (!mountedRef.current) return;
      setDuration(prev => {
        const next = prev + 1;
        // Hard cap at 60s — auto-stop. Server also enforces, but stopping
        // client-side avoids the ugly "your 90s recording was truncated" UX.
        if (next >= MAX_DURATION_SEC) {
          stopRecording();
          return MAX_DURATION_SEC;
        }
        return next;
      });
    }, 1000);
  }

  const stopRecording = useCallback(async () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    try {
      const r = recRef.current;
      if (!r) {
        setPhase('idle');
        return;
      }
      if (Platform.OS === 'web') {
        // MediaRecorder.stop() fires `onstop` async — wait for the blob.
        await new Promise((resolve) => {
          if (r.state !== 'recording') return resolve();
          const orig = r.onstop;
          r.onstop = (...args) => { try { orig?.(...args); } catch {} resolve(); };
          r.stop();
        });
      } else if (r.__native && typeof r.stop === 'function') {
        const out = await r.stop();
        recordingUriRef.current = out?.uri || r.recorder?.uri || null;
      }
      try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
      setPhase('preview');
    } catch (e) {
      setErrorMsg((t('voicemail.recordError') || 'Erro ao gravar') + ': ' + (e?.message || ''));
      setPhase('error');
    } finally {
      recRef.current = null;
    }
  }, [t]);

  const playPreview = useCallback(async () => {
    const uri = recordingUriRef.current;
    if (!uri) return;
    cleanupPreview();
    if (Platform.OS === 'web') {
      const audio = new Audio(uri);
      audio.onended = () => setPreviewPlaying(false);
      audio.onerror = () => setPreviewPlaying(false);
      previewPlayerRef.current = audio;
      try { await audio.play(); setPreviewPlaying(true); } catch { setPreviewPlaying(false); }
      return;
    }
    try {
      const expoAudio = require('expo-audio');
      const player = expoAudio.createAudioPlayer({ uri });
      previewPlayerRef.current = player;
      player.addListener('playbackStatusUpdate', (s) => {
        if (s?.didJustFinish) setPreviewPlaying(false);
      });
      player.play();
      setPreviewPlaying(true);
    } catch {
      setPreviewPlaying(false);
    }
  }, []);

  const stopPreview = useCallback(() => {
    cleanupPreview();
    setPreviewPlaying(false);
  }, []);

  const reRecord = useCallback(() => {
    cleanupPreview();
    recordingUriRef.current = null;
    recordingBlobRef.current = null;
    setDuration(0);
    setPhase('idle');
  }, []);

  const sendVoicemail = useCallback(async () => {
    // Synchronous double-tap guard. `phase === 'sending'` lags by a render
    // cycle, so two taps in the same tick (e.g. user double-taps the Send
    // button) used to fire two voicemail_init_upload + voicemail_send
    // pairs and the recipient saw the bubble twice.
    if (sendingRef.current) return;
    if (phase === 'sending') return;
    if (!recipientEmail) {
      setErrorMsg(t('voicemail.noRecipient') || 'Destinatário inválido');
      setPhase('error');
      return;
    }
    if (!recordingUriRef.current && !recordingBlobRef.current) {
      setErrorMsg(t('voicemail.noRecording') || 'Sem gravação para enviar');
      return;
    }
    sendingRef.current = true;
    setPhase('sending');
    setErrorMsg(null);
    try {
      // Step 1 — get presigned PUT URL.
      const initResp = await api.voicemailInitUpload(conversationId || 0, recordingMimeRef.current);
      if (!mountedRef.current) return;
      if (!initResp?.success || !initResp?.data?.upload_url || !initResp?.data?.object_key) {
        throw new Error(initResp?.message || 'init_failed');
      }
      const uploadUrl = initResp.data.upload_url;
      const objectKey = initResp.data.object_key;
      const mime = initResp.data.mime_type || recordingMimeRef.current;

      // Step 2 — PUT raw bytes to R2. Native uses fetch with the file URI
      // converted to a blob via FileSystem; web has the Blob already.
      let body;
      if (Platform.OS === 'web') {
        body = recordingBlobRef.current;
      } else {
        // Read native file into a blob the fetch layer can stream.
        const uri = recordingUriRef.current;
        const resp = await fetch(uri);
        if (!mountedRef.current) return;
        body = await resp.blob();
        if (!mountedRef.current) return;
      }
      if (!body || (body.size != null && body.size === 0)) {
        throw new Error('empty_recording');
      }
      const putResp = await fetch(uploadUrl, {
        method: 'PUT',
        body,
        headers: { 'Content-Type': mime },
      });
      if (!mountedRef.current) return;
      if (!putResp.ok) {
        throw new Error('r2_upload_' + putResp.status);
      }

      // Step 3 — register voicemail row + post chat bubble.
      const sendResp = await api.voicemailSend(recipientEmail, objectKey, duration, conversationId || null);
      if (!mountedRef.current) return;
      if (!sendResp?.success) {
        throw new Error(sendResp?.message || 'send_failed');
      }
      try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
      setPhase('done');
      // Navigate back to the conversation. router.replace so the call
      // screen and this recorder both leave the back stack.
      const cid = sendResp?.data?.conversation_id || conversationId;
      setTimeout(() => {
        try {
          if (cid) {
            router.replace('/chat-conversation?id=' + cid);
          } else {
            router.replace('/chat');
          }
        } catch {
          try { router.replace('/chat'); } catch {}
        }
      }, 600);
    } catch (e) {
      // Surface to console so devs investigating support tickets can see the
      // exact failure step (init / put / send) instead of just a banner.
      try { console.warn('[voicemail] send failed', e?.message || e); } catch {}
      if (!mountedRef.current) return;
      setErrorMsg((t('voicemail.sendError') || 'Erro ao enviar mensagem de voz') + ': ' + (e?.message || ''));
      setPhase('error');
    } finally {
      // Release the in-flight gate so a retry from the error-state UI
      // (which keeps the recording around) can fire again.
      sendingRef.current = false;
    }
  }, [conversationId, duration, recipientEmail, t, router, phase]);

  const dismiss = useCallback(() => {
    try { router.replace('/chat'); } catch {}
  }, [router]);

  const fmt = (s) => {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, '0')}`;
  };

  const isDark = colors.background === '#000' || colors.background === '#000000' || (colors._mode === 'dark');
  const styles = makeStyles(colors);

  const headerLine = reason === 'declined'
    ? (t('voicemail.declinedTitle') || 'Não pôde atender — gravar mensagem de voz?')
    : (t('voicemail.missedTitle') || 'Não atendeu — gravar mensagem de voz?');

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />

      <View style={styles.header}>
        <Text style={styles.headerTitle}>{headerLine}</Text>
        <Text style={styles.headerSubtitle}>
          {recipientName || recipientEmail}
        </Text>
      </View>

      <View style={styles.body}>
        <AvatarCircle email={recipientEmail} name={recipientName} size={120} />

        <View style={{ height: 32 }} />

        {phase === 'idle' && (
          <>
            <Text style={styles.bodyText}>
              {t('voicemail.tapToRecord') || 'Toque no microfone para gravar (até 1 minuto).'}
            </Text>
            <View style={{ height: 32 }} />
            <TouchableOpacity onPress={startCountdown} style={styles.micButton} accessibilityLabel="Gravar mensagem de voz">
              <IconMic size={40} color="#fff" />
            </TouchableOpacity>
          </>
        )}

        {phase === 'countdown' && (
          <>
            <Animated.Text style={[styles.countdownDigit, {
              transform: [
                { scale: countdownAnim.interpolate({ inputRange: [0, 1], outputRange: [1.6, 1] }) },
              ],
              opacity: countdownAnim.interpolate({ inputRange: [0, 0.6, 1], outputRange: [1, 1, 0.6] }),
            }]}>{countdownTick}</Animated.Text>
            <Text style={styles.bodyText}>{t('voicemail.getReady') || 'Prepare-se…'}</Text>
          </>
        )}

        {phase === 'recording' && (
          <>
            <Text style={styles.timer}>{fmt(duration)} / {fmt(MAX_DURATION_SEC)}</Text>
            {/* Live waveform — purely visual; recorder itself runs unaffected. */}
            <View style={styles.waveRow}>
              {waveBars.map((bar, i) => (
                <Animated.View
                  key={i}
                  style={{
                    width: 4,
                    borderRadius: 2,
                    marginHorizontal: 2,
                    backgroundColor: '#EF4444',
                    height: bar.interpolate({ inputRange: [0, 1], outputRange: [6, 36] }),
                  }}
                />
              ))}
            </View>
            <View style={{ height: 14 }} />
            <View style={{ alignItems: 'center', justifyContent: 'center' }}>
              {/* Breathing red halo — sits behind the mic button at low
                  opacity. Scales out + fades synchronously with haloAnim. */}
              <Animated.View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  width: 96, height: 96, borderRadius: 48,
                  backgroundColor: '#EF4444',
                  opacity: haloAnim.interpolate({ inputRange: [0, 1], outputRange: [0.18, 0.42] }),
                  transform: [{ scale: haloAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.55] }) }],
                }}
              />
              <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
                <TouchableOpacity onPress={stopRecording} style={[styles.micButton, styles.recordingActive]}>
                  <View style={styles.stopSquare} />
                </TouchableOpacity>
              </Animated.View>
            </View>
            <Text style={styles.bodyText}>{t('voicemail.tapToStop') || 'Toque para parar'}</Text>
            {/* Auto-stop hint when within 10s of the cap. Keeps the user from
                being surprised by the hard 60s ceiling. */}
            {duration >= MAX_DURATION_SEC - 10 && (
              <Text style={[styles.bodyText, { color: '#fbbf24', marginTop: 8 }]}>
                {(t('voicemail.cappingSoon') || 'Limite chegando — para automaticamente em {n}s')
                  .replace('{n}', String(MAX_DURATION_SEC - duration))}
              </Text>
            )}
          </>
        )}

        {phase === 'preview' && (
          <>
            {/* Confetti burst — dots radiate from center on the
                recording→preview transition. Pointer-events-none so they
                don't intercept the preview row buttons. */}
            <View pointerEvents="none" style={{ position: 'absolute', top: '40%', left: 0, right: 0, alignItems: 'center', justifyContent: 'center' }}>
              {confettiAnims.map((dot, i) => {
                const colorRing = ['#7c3aed', '#10B981', '#fbbf24', '#EC4899', '#3B82F6', '#EF4444'];
                return (
                  <Animated.View
                    key={i}
                    style={{
                      position: 'absolute',
                      width: 8, height: 8, borderRadius: 4,
                      backgroundColor: colorRing[i % colorRing.length],
                      opacity: dot.opacity,
                      transform: [
                        { translateX: dot.x },
                        { translateY: dot.y },
                        { scale: dot.scale },
                      ],
                    }}
                  />
                );
              })}
            </View>
            <Text style={styles.timer}>{fmt(duration)}</Text>
            <View style={{ height: 24 }} />
            <View style={styles.previewRow}>
              <TouchableOpacity onPress={reRecord} style={styles.previewBtn}>
                <Text style={styles.previewBtnText}>{t('voicemail.reRecord') || 'Regravar'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={previewPlaying ? stopPreview : playPreview} style={[styles.previewBtn, styles.playBtn]} accessibilityLabel={previewPlaying ? (t('voicemail.pause') || 'Pausar') : (t('voicemail.play') || 'Tocar')}>
                {previewPlaying ? <IconPause size={26} color="#fff" /> : <IconPlay size={26} color="#fff" />}
              </TouchableOpacity>
              <TouchableOpacity onPress={sendVoicemail} style={[styles.previewBtn, styles.sendBtn]}>
                <Text style={[styles.previewBtnText, { color: '#fff' }]}>{t('voicemail.send') || 'Enviar'}</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {phase === 'sending' && (
          <>
            <ActivityIndicator size="large" color={colors.primary || '#7c3aed'} />
            <Text style={[styles.bodyText, { marginTop: 16 }]}>{t('voicemail.sending') || 'Enviando…'}</Text>
          </>
        )}

        {phase === 'done' && (
          <Text style={[styles.bodyText, { color: '#10B981' }]}>
            {t('voicemail.sent') || 'Mensagem enviada!'}
          </Text>
        )}

        {phase === 'error' && (
          <>
            <Text style={[styles.bodyText, { color: '#EF4444' }]}>{errorMsg}</Text>
            <View style={{ height: 16 }} />
            <View style={styles.previewRow}>
              {/* Re-send: keep the recording, retry just the upload step.
                  Without this, an upload flake forced the user to re-record. */}
              {(recordingUriRef.current || recordingBlobRef.current) ? (
                <TouchableOpacity onPress={sendVoicemail} style={[styles.previewBtn, styles.sendBtn]}>
                  <Text style={[styles.previewBtnText, { color: '#fff' }]}>{t('voicemail.retrySend') || 'Reenviar'}</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity onPress={() => { setPhase('idle'); setErrorMsg(null); }} style={[styles.previewBtn]}>
                <Text style={styles.previewBtnText}>{t('voicemail.tryAgain') || 'Tentar novamente'}</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {errorMsg && phase !== 'error' ? (
          <Text style={[styles.bodyText, { color: '#EF4444', marginTop: 12 }]}>{errorMsg}</Text>
        ) : null}
      </View>

      {phase !== 'sending' && phase !== 'done' && (
        <TouchableOpacity onPress={dismiss} style={styles.dismissBtn}>
          <Text style={styles.dismissText}>{t('voicemail.dismiss') || 'Descartar'}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function makeStyles(colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background || '#0b0b12', paddingTop: Platform.OS === 'ios' ? 60 : 40 },
    header: { paddingHorizontal: 24, alignItems: 'center' },
    headerTitle: { color: colors.text || '#fff', fontSize: 20, fontWeight: '700', textAlign: 'center' },
    headerSubtitle: { color: colors.textSecondary || 'rgba(255,255,255,0.7)', fontSize: 15, marginTop: 6, textAlign: 'center' },
    body: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
    bodyText: { color: colors.textSecondary || 'rgba(255,255,255,0.7)', fontSize: 15, textAlign: 'center', lineHeight: 22 },
    timer: { color: colors.text || '#fff', fontSize: 32, fontWeight: '300', fontVariant: ['tabular-nums'] },
    countdownDigit: { color: colors.text || '#fff', fontSize: 96, fontWeight: '700', marginBottom: 12 },
    waveRow: { flexDirection: 'row', alignItems: 'center', height: 40, marginTop: 12, marginBottom: 4 },
    micButton: {
      width: 96, height: 96, borderRadius: 48,
      backgroundColor: colors.primary || '#7c3aed',
      alignItems: 'center', justifyContent: 'center',
      shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 6 },
      elevation: 6,
    },
    recordingActive: { backgroundColor: '#EF4444' },
    micEmoji: { fontSize: 40 },
    stopSquare: { width: 28, height: 28, backgroundColor: '#fff', borderRadius: 6 },
    previewRow: { flexDirection: 'row', gap: 12, alignItems: 'center' },
    previewBtn: {
      paddingVertical: 12, paddingHorizontal: 20, borderRadius: 24,
      backgroundColor: colors.surface || 'rgba(255,255,255,0.08)',
    },
    playBtn: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary || '#7c3aed', paddingHorizontal: 0, paddingVertical: 0 },
    sendBtn: { backgroundColor: colors.primary || '#7c3aed' },
    previewBtnText: { color: colors.text || '#fff', fontSize: 16, fontWeight: '600' },
    dismissBtn: { paddingVertical: 18, alignItems: 'center' },
    dismissText: { color: colors.textTertiary || 'rgba(255,255,255,0.5)', fontSize: 14 },
  });
}
