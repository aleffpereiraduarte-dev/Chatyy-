import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, FlatList,
  KeyboardAvoidingView, Platform, Animated, Easing, Dimensions,
  ScrollView, Modal, Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import {
  IconSend, IconArrowLeft, IconZap, IconMail, IconCalendar,
  IconMessageSquare, IconClock, IconPlus, IconSparkles,
  IconX, IconBell, IconMenu, IconMic, IconMicOff, IconVolume2, IconVolumeX,
  IconPhone, IconStop,
} from '../components/Icons';
import { useRouter } from 'expo-router';
import * as api from '../services/api';

const { width: SCREEN_W } = Dimensions.get('window');
const isWide = SCREEN_W > 700;
const CONTENT_MAX = 720;

// ─── Helpers ───

function getTimeOfDay() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

function getGreeting(t) {
  const tod = getTimeOfDay();
  if (tod === 'morning') return t('one.goodMorning');
  if (tod === 'afternoon') return t('one.goodAfternoon');
  return t('one.goodEvening');
}

const ROTATING_PHRASES = [
  { text: 'resumir seus emails', color: '#6366f1' },
  { text: 'organizar sua agenda', color: '#8b5cf6' },
  { text: 'te lembrar de compromissos', color: '#ec4899' },
  { text: 'rascunhar respostas', color: '#6366f1' },
  { text: 'agendar reuniões', color: '#8b5cf6' },
  { text: 'te ligar pra lembrar', color: '#ec4899' },
  { text: 'buscar seus arquivos', color: '#6366f1' },
  { text: 'enviar mensagens', color: '#8b5cf6' },
  { text: 'criar eventos no calendário', color: '#ec4899' },
  { text: 'aprender seu estilo', color: '#6366f1' },
  { text: 'responder emails por você', color: '#8b5cf6' },
  { text: 'encontrar contatos', color: '#ec4899' },
  { text: 'marcar reuniões com sua equipe', color: '#6366f1' },
  { text: 'gerenciar suas pastas', color: '#8b5cf6' },
  { text: 'resumir conversas do chat', color: '#ec4899' },
  { text: 'planejar seu dia', color: '#6366f1' },
  { text: 'priorizar tarefas urgentes', color: '#8b5cf6' },
  { text: 'encaminhar emails importantes', color: '#ec4899' },
  { text: 'criar lembretes', color: '#6366f1' },
  { text: 'organizar seus documentos', color: '#8b5cf6' },
  { text: 'sugerir respostas inteligentes', color: '#ec4899' },
  { text: 'acompanhar prazos', color: '#6366f1' },
  { text: 'preparar briefings do dia', color: '#8b5cf6' },
  { text: 'traduzir mensagens', color: '#ec4899' },
  { text: 'te ajudar em Tudo ✨', color: '#7c3aed' },
];

// ─── Voice helpers ───

// Strip markdown for TTS
function stripMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/```[\s\S]*?```/g, '') // code blocks
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/\*([^*]+)\*/g, '$1') // italic
    .replace(/^[-*]\s+/gm, '') // bullets
    .replace(/^\d+[.)]\s+/gm, '') // numbered lists
    .replace(/https?:\/\/[^\s)]+/g, '') // URLs
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '') // emojis
    .replace(/#{1,6}\s+/g, '') // headers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links [text](url)
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Get language code for TTS based on locale
function getTTSLang(locale) {
  if (locale?.startsWith('es')) return 'es-ES';
  if (locale?.startsWith('en')) return 'en-US';
  return 'pt-BR';
}

// Web Speech API for speech recognition
function getWebSpeechRecognition() {
  if (Platform.OS !== 'web') return null;
  const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
  return SR ? new SR() : null;
}

// TTS - ElevenLabs primary, expo-speech fallback
let ExpoSpeech = null;
try { ExpoSpeech = require('expo-speech'); } catch {}

let ExpoAV = null;
try { ExpoAV = require('expo-audio'); } catch {}

let _currentSound = null; // expo-av Sound instance (native)
let _currentAudio = null; // web Audio instance

// Fallback: use browser SpeechSynthesis or expo-speech
function speakFallback(text, lang, onDone) {
  if (Platform.OS === 'web') {
    if (typeof window === 'undefined' || !window.speechSynthesis) return false;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.onend = () => { if (onDone) onDone(); };
    window.speechSynthesis.speak(utterance);
    return true;
  }
  if (ExpoSpeech) {
    ExpoSpeech.stop();
    ExpoSpeech.speak(text, {
      language: lang,
      rate: 1.0,
      pitch: 1.0,
      onDone: () => { if (onDone) onDone(); },
    });
    return true;
  }
  return false;
}

// Primary: ElevenLabs TTS via API
async function speakElevenLabs(text, lang, onDone) {
  try {
    // Stop any current playback
    await stopSpeakAsync();

    if (Platform.OS === 'web') {
      const url = await api.oneTTS(text);
      if (!url) { if (onDone) onDone(); return false; }
      const audio = new window.Audio(url);
      _currentAudio = audio;
      audio.onended = () => { URL.revokeObjectURL(url); _currentAudio = null; if (onDone) onDone(); };
      audio.onerror = () => { URL.revokeObjectURL(url); _currentAudio = null; if (onDone) onDone(); };
      audio.play();
      return true;
    } else {
      // Native: use expo-audio createAudioPlayer
      try {
        if (ExpoAV?.createAudioPlayer) {
          const url = api.oneTTSUrl(text);
          const player = ExpoAV.createAudioPlayer({ uri: url });
          _currentSound = player;
          // Listen for playback end
          const checkInterval = setInterval(() => {
            try {
              if (!player.playing && player.currentTime > 0) {
                clearInterval(checkInterval);
                player.remove();
                _currentSound = null;
                if (onDone) onDone();
              }
            } catch {
              clearInterval(checkInterval);
              _currentSound = null;
              if (onDone) onDone();
            }
          }, 300);
          player.play();
          return true;
        }
      } catch (e) {
        console.warn('[one] expo-audio error:', e?.message);
      }
      // Fallback to expo-speech
      return speakFallback(text, lang, onDone);
    }
  } catch (e) {
    console.warn('[one] ElevenLabs TTS error:', e?.message);
    // Fallback to browser/expo-speech
    return speakFallback(text, lang, onDone);
  }
}

function speakText(text, lang, onDone) {
  // Fire-and-forget the async ElevenLabs call
  speakElevenLabs(text, lang, onDone).catch(() => {
    speakFallback(text, lang, onDone);
  });
  return true;
}

async function stopSpeakAsync() {
  // Stop web Audio
  if (_currentAudio) {
    try { _currentAudio.pause(); _currentAudio.src = ''; } catch {}
    _currentAudio = null;
  }
  // Stop expo-av Sound
  if (_currentSound) {
    try { await _currentSound.stopAsync(); await _currentSound.unloadAsync(); } catch {}
    _currentSound = null;
  }
  // Stop browser speechSynthesis
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
  } else if (ExpoSpeech) {
    try { ExpoSpeech.stop(); } catch {}
  }
}

function stopSpeak() {
  stopSpeakAsync().catch(() => {});
}

function isSpeakingNow() {
  if (_currentAudio && !_currentAudio.paused) return true;
  if (_currentSound) return true;
  if (Platform.OS === 'web') {
    return typeof window !== 'undefined' && window.speechSynthesis?.speaking;
  }
  return false;
}

// ─── Sentence-by-sentence TTS for voice conversation ───

function splitIntoSentences(text) {
  if (!text) return [];
  // Split on sentence-ending punctuation followed by space or end
  const raw = text.split(/(?<=[.!?;:])\s+/);
  // Merge very short fragments with previous sentence
  const sentences = [];
  for (const s of raw) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    if (sentences.length > 0 && trimmed.length < 12) {
      sentences[sentences.length - 1] += ' ' + trimmed;
    } else {
      sentences.push(trimmed);
    }
  }
  return sentences;
}

let _voiceSpeakingAborted = false;

async function speakSentenceBysentence(fullText, lang, onAllDone) {
  _voiceSpeakingAborted = false;
  const plainText = stripMarkdown(fullText);
  const sentences = splitIntoSentences(plainText);
  if (sentences.length === 0) { if (onAllDone) onAllDone(); return; }

  let idx = 0;
  function speakNext() {
    if (_voiceSpeakingAborted || idx >= sentences.length) {
      if (onAllDone) onAllDone();
      return;
    }
    const sentence = sentences[idx++];
    speakElevenLabs(sentence, lang, speakNext).catch(() => {
      // Fallback per sentence
      speakFallback(sentence, lang, speakNext);
    });
  }
  speakNext();
}

function abortVoiceSpeaking() {
  _voiceSpeakingAborted = true;
  stopSpeak();
}

// ─── Sound & haptic feedback (Alexa/Siri-like) ───

function playActivationSound() {
  if (Platform.OS === 'web') {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.value = 0.15;
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.stop(ctx.currentTime + 0.15);
    } catch {}
  }
  try {
    const Haptics = require('expo-haptics');
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } catch {}
}

function playReactivationSound() {
  if (Platform.OS === 'web') {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 660;
      gain.gain.value = 0.1;
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
      osc.stop(ctx.currentTime + 0.1);
    } catch {}
  }
}

function haptic(type = 'light') {
  try {
    const Haptics = require('expo-haptics');
    if (type === 'light') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    else if (type === 'medium') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    else Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } catch {}
}

// ─── Pulsing mic indicator ───

function PulsingMicDot({ isDark }) {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.loop(Animated.sequence([
      Animated.timing(pulseAnim, { toValue: 1.5, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(pulseAnim, { toValue: 1, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
    ])).start();
  }, []);

  return (
    <Animated.View style={{
      width: 8, height: 8, borderRadius: 4, backgroundColor: '#ef4444',
      transform: [{ scale: pulseAnim }],
    }} />
  );
}

// ─── Premium voice conversation components ───

// 1. Dynamic waveform with 15 bars reacting to simulate audio
function SpeakingWaveform() {
  const NUM_BARS = 15;
  const bars = useRef(Array.from({ length: NUM_BARS }, () => new Animated.Value(0.2))).current;

  useEffect(() => {
    const timeouts = [];
    bars.forEach((bar, i) => {
      const randomDuration = () => 200 + Math.random() * 300;
      const randomHeight = () => 0.2 + Math.random() * 0.8;

      function animate() {
        Animated.timing(bar, {
          toValue: randomHeight(),
          duration: randomDuration(),
          useNativeDriver: Platform.OS !== 'web',
        }).start(() => animate());
      }
      const t = setTimeout(() => animate(), i * 50);
      timeouts.push(t);
    });

    return () => {
      timeouts.forEach(t => clearTimeout(t));
      bars.forEach(b => b.stopAnimation());
    };
  }, []);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, height: 50, justifyContent: 'center' }}>
      {bars.map((bar, i) => (
        <Animated.View key={i} style={{
          width: 3, borderRadius: 1.5, backgroundColor: '#6366f1',
          height: 50, transform: [{ scaleY: bar }],
        }} />
      ))}
    </View>
  );
}

// 2. Listening - concentric sound wave ripples
function ListeningRipples() {
  const NUM_RINGS = 4;
  const rings = useRef(Array.from({ length: NUM_RINGS }, () => ({
    scale: new Animated.Value(1),
    opacity: new Animated.Value(0.5),
  }))).current;

  useEffect(() => {
    const anims = rings.map((ring, i) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(i * 400),
          Animated.parallel([
            Animated.timing(ring.scale, { toValue: 2.2, duration: 1600, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }),
            Animated.timing(ring.opacity, { toValue: 0, duration: 1600, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }),
          ]),
          Animated.parallel([
            Animated.timing(ring.scale, { toValue: 1, duration: 0, useNativeDriver: Platform.OS !== 'web' }),
            Animated.timing(ring.opacity, { toValue: 0.5, duration: 0, useNativeDriver: Platform.OS !== 'web' }),
          ]),
        ])
      );
    });
    anims.forEach(a => a.start());
    return () => anims.forEach(a => a.stop());
  }, []);

  return (
    <View style={{ width: 180, height: 180, alignItems: 'center', justifyContent: 'center' }}>
      {rings.map((ring, i) => (
        <Animated.View key={i} style={{
          position: 'absolute', width: 80, height: 80, borderRadius: 40,
          borderWidth: 2, borderColor: '#ef4444',
          opacity: ring.opacity, transform: [{ scale: ring.scale }],
        }} />
      ))}
      {/* Gradient center circle */}
      <View style={{
        width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden',
      }}>
        <View style={{
          position: 'absolute', width: 84, height: 84, borderRadius: 42,
          backgroundColor: '#ef4444',
        }} />
        <View style={{
          position: 'absolute', width: 84, height: 42, borderTopLeftRadius: 42, borderTopRightRadius: 42,
          backgroundColor: '#f87171', top: 0,
        }} />
        <View style={{
          position: 'absolute', width: 60, height: 60, borderRadius: 30,
          backgroundColor: '#ef4444', opacity: 0.8,
        }} />
        <IconMic size={36} color="#fff" style={{ zIndex: 2 }} />
      </View>
    </View>
  );
}

// 3. Thinking - orbiting dots around the avatar
function OrbitingDots() {
  const rotation = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(
      Animated.timing(rotation, { toValue: 1, duration: 1500, easing: Easing.linear, useNativeDriver: Platform.OS !== 'web' })
    ).start();
    return () => rotation.stopAnimation();
  }, []);

  const spin = rotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <View style={{ width: 120, height: 120, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={{ position: 'absolute', width: 120, height: 120, transform: [{ rotate: spin }] }}>
        {[0, 120, 240].map((deg, i) => {
          const rad = (deg * Math.PI) / 180;
          const x = 50 * Math.cos(rad);
          const y = 50 * Math.sin(rad);
          return (
            <View key={i} style={{
              position: 'absolute', width: 10, height: 10, borderRadius: 5,
              backgroundColor: ['#6366f1', '#8b5cf6', '#a78bfa'][i],
              left: 55 + x, top: 55 + y,
              shadowColor: '#6366f1', shadowOffset: { width: 0, height: 0 },
              shadowOpacity: 0.6, shadowRadius: 6, elevation: 3,
            }} />
          );
        })}
      </Animated.View>
    </View>
  );
}

// 4. Typewriter transcript
function TypewriterText({ text, colors }) {
  const [displayedChars, setDisplayedChars] = useState(0);
  const textRef = useRef(text);

  useEffect(() => {
    textRef.current = text;
    setDisplayedChars(0);
  }, [text]);

  useEffect(() => {
    if (displayedChars < text.length) {
      const timer = setTimeout(() => {
        setDisplayedChars(prev => Math.min(prev + 1, textRef.current.length));
      }, 30);
      return () => clearTimeout(timer);
    }
  }, [displayedChars, text]);

  return (
    <Text style={[st.voiceTranscript, { color: colors.text }]} numberOfLines={3}>
      {text.substring(0, displayedChars)}
      {displayedChars < text.length && (
        <Text style={{ opacity: 0.5 }}>|</Text>
      )}
    </Text>
  );
}

// 5. Status text with icon
function VoiceStatusWithIcon({ voiceState, colors, t }) {
  const micPulse = useRef(new Animated.Value(1)).current;
  const sparkleRotate = useRef(new Animated.Value(0)).current;
  const volumePulse = useRef(new Animated.Value(0.7)).current;

  useEffect(() => {
    micPulse.stopAnimation();
    sparkleRotate.stopAnimation();
    volumePulse.stopAnimation();

    if (voiceState === 'listening') {
      Animated.loop(Animated.sequence([
        Animated.timing(micPulse, { toValue: 1.3, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(micPulse, { toValue: 1, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
      ])).start();
    } else if (voiceState === 'thinking') {
      Animated.loop(
        Animated.timing(sparkleRotate, { toValue: 1, duration: 2000, easing: Easing.linear, useNativeDriver: Platform.OS !== 'web' })
      ).start();
    } else {
      Animated.loop(Animated.sequence([
        Animated.timing(volumePulse, { toValue: 1, duration: 500, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(volumePulse, { toValue: 0.7, duration: 500, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
      ])).start();
    }

    return () => {
      micPulse.stopAnimation();
      sparkleRotate.stopAnimation();
      volumePulse.stopAnimation();
    };
  }, [voiceState]);

  const sparkleSpin = sparkleRotate.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  const label = voiceState === 'listening' ? t('one.voiceListening') :
    voiceState === 'thinking' ? t('one.thinking') :
    t('one.voiceSpeaking');

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 40 }}>
      {voiceState === 'listening' && (
        <Animated.View style={{ transform: [{ scale: micPulse }] }}>
          <IconMic size={18} color="#ef4444" />
        </Animated.View>
      )}
      {voiceState === 'thinking' && (
        <Animated.View style={{ transform: [{ rotate: sparkleSpin }] }}>
          <IconSparkles size={18} color="#8b5cf6" />
        </Animated.View>
      )}
      {voiceState === 'speaking' && (
        <Animated.View style={{ opacity: volumePulse }}>
          <IconVolume2 size={18} color="#3b82f6" />
        </Animated.View>
      )}
      <Text style={[st.voiceStatusLabel, {
        color: voiceState === 'listening' ? '#ef4444' : voiceState === 'thinking' ? '#8b5cf6' : '#3b82f6',
        marginBottom: 0,
      }]}>
        {label}
      </Text>
    </View>
  );
}

// 6. Gradient background for voice overlay
function VoiceGradientBackground({ isDark }) {
  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
      {/* Base */}
      <View style={{
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: isDark ? '#080816' : '#f0f0ff',
      }} />
      {/* Radial glow center */}
      <View style={{
        position: 'absolute', top: '25%', left: '15%', right: '15%', height: '50%',
        borderRadius: 999, backgroundColor: isDark ? '#1a1040' : '#e0e0ff',
        opacity: 0.6,
      }} />
      {/* Subtle top accent */}
      <View style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: '40%',
        backgroundColor: isDark ? '#0d0d2a' : '#eeeeff',
        opacity: 0.5,
      }} />
      {/* Bottom accent */}
      <View style={{
        position: 'absolute', bottom: 0, left: 0, right: 0, height: '30%',
        backgroundColor: isDark ? '#0a0a1e' : '#f5f5ff',
        opacity: 0.4,
      }} />
    </View>
  );
}

function AmbientGlow({ voiceState }) {
  const glowAnim = useRef(new Animated.Value(0.3)).current;
  const prevState = useRef(voiceState);

  useEffect(() => {
    glowAnim.stopAnimation();
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(glowAnim, {
        toValue: voiceState === 'listening' ? 0.5 : voiceState === 'thinking' ? 0.4 : 0.45,
        duration: voiceState === 'thinking' ? 1500 : 1000,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: Platform.OS !== 'web',
      }),
      Animated.timing(glowAnim, {
        toValue: 0.15,
        duration: voiceState === 'thinking' ? 1500 : 1000,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: Platform.OS !== 'web',
      }),
    ]));
    loop.start();
    prevState.current = voiceState;
    return () => loop.stop();
  }, [voiceState]);

  const glowColor = voiceState === 'listening' ? '#ef4444'
    : voiceState === 'thinking' ? '#8b5cf6' : '#3b82f6';

  return (
    <Animated.View style={{
      position: 'absolute', width: 280, height: 280, borderRadius: 140,
      backgroundColor: glowColor, opacity: glowAnim,
    }} />
  );
}

function VoiceConversationOverlay({ isDark, colors, t, voiceState, transcript, onStop, onExit }) {
  // voiceState: 'listening' | 'thinking' | 'speaking'
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.9)).current;
  const contentFade = useRef(new Animated.Value(1)).current;
  const silenceStart = useRef(Date.now());
  const [silenceHint, setSilenceHint] = useState('');

  // 8. Entry animation: fade + scale up
  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 400, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(scaleAnim, { toValue: 1, duration: 400, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }),
    ]).start();
  }, []);

  // Cross-fade on state change
  useEffect(() => {
    contentFade.setValue(0);
    Animated.timing(contentFade, { toValue: 1, duration: 250, useNativeDriver: Platform.OS !== 'web' }).start();
  }, [voiceState]);

  // Silence timeout hints (only while listening)
  useEffect(() => {
    if (voiceState === 'listening') {
      silenceStart.current = Date.now();
      setSilenceHint('');
      const iv = setInterval(() => {
        const elapsed = Date.now() - silenceStart.current;
        if (elapsed >= 30000) setSilenceHint('Diga algo ou toque para parar');
        else if (elapsed >= 10000) setSilenceHint('Estou ouvindo...');
      }, 2000);
      return () => clearInterval(iv);
    } else {
      setSilenceHint('');
    }
  }, [voiceState]);

  // Reset silence timer when transcript changes
  useEffect(() => {
    if (transcript) {
      silenceStart.current = Date.now();
      setSilenceHint('');
    }
  }, [transcript]);

  // 8. Exit animation handler
  const handleStop = useCallback(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 0, duration: 300, easing: Easing.in(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(scaleAnim, { toValue: 0.85, duration: 300, easing: Easing.in(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }),
    ]).start(() => {
      if (onStop) onStop();
    });
  }, [onStop, fadeAnim, scaleAnim]);

  return (
    <Animated.View style={[st.voiceOverlay, {
      opacity: fadeAnim,
    }]}>
      {/* 6. Gradient background */}
      <VoiceGradientBackground isDark={isDark} />

      <Animated.View style={[st.voiceOverlayInner, { transform: [{ scale: scaleAnim }] }]}>
        {/* 5. Status text with icon */}
        <Animated.View style={{ opacity: contentFade }}>
          <VoiceStatusWithIcon voiceState={voiceState} colors={colors} t={t} />
        </Animated.View>

        {/* Ambient glow + central animation */}
        <View style={st.voiceCenterAnim}>
          <AmbientGlow voiceState={voiceState} />
          <Animated.View style={{ opacity: contentFade }}>
            {voiceState === 'listening' && <ListeningRipples />}
            {voiceState === 'thinking' && (
              <View style={{ alignItems: 'center' }}>
                <View style={[st.avatar, { backgroundColor: '#6366f1', width: 80, height: 80, borderRadius: 40 }]}>
                  <IconSparkles size={36} color="#fff" />
                </View>
                <OrbitingDots />
              </View>
            )}
            {voiceState === 'speaking' && (
              <View style={{ alignItems: 'center' }}>
                <View style={[st.avatar, { backgroundColor: '#6366f1', width: 80, height: 80, borderRadius: 40, marginBottom: 20 }]}>
                  <IconSparkles size={36} color="#fff" />
                </View>
                <SpeakingWaveform />
              </View>
            )}
          </Animated.View>
        </View>

        {/* 4. Typewriter transcript */}
        {transcript ? (
          <TypewriterText text={transcript} colors={colors} />
        ) : null}

        {/* Silence hint */}
        {silenceHint && !transcript ? (
          <Text style={[st.voiceSilenceHint, { color: colors.textSecondary }]}>
            {silenceHint}
          </Text>
        ) : null}

        {/* Stop button */}
        <TouchableOpacity
          style={st.voiceStopBtn}
          onPress={handleStop}
          activeOpacity={0.7}
        >
          <View style={st.voiceStopCircle}>
            <IconStop size={20} color="#fff" />
          </View>
          <Text style={st.voiceStopText}>{t('one.voiceTapStop')}</Text>
        </TouchableOpacity>
      </Animated.View>
    </Animated.View>
  );
}

// ─── Animated rotating text ───

function RotatingText({ isDark }) {
  const [index, setIndex] = useState(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const slideAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let timeout;
    const cycle = () => {
      // Last phrase ("Tudo") stays longer
      const isLast = index === ROTATING_PHRASES.length - 1;
      const delay = isLast ? 4000 : 2200;
      timeout = setTimeout(() => {
        // Fade out + slide up
        Animated.parallel([
          Animated.timing(fadeAnim, { toValue: 0, duration: 300, useNativeDriver: Platform.OS !== 'web' }),
          Animated.timing(slideAnim, { toValue: -20, duration: 300, useNativeDriver: Platform.OS !== 'web' }),
        ]).start(() => {
          setIndex(prev => (prev + 1) % ROTATING_PHRASES.length);
          slideAnim.setValue(20);
          // Fade in + slide from below
          Animated.parallel([
            Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: Platform.OS !== 'web' }),
            Animated.timing(slideAnim, { toValue: 0, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }),
          ]).start();
        });
      }, delay);
    };
    cycle();
    return () => clearTimeout(timeout);
  }, [index]);

  const phrase = ROTATING_PHRASES[index];

  return (
    <View style={st.rotatingWrap}>
      <Animated.Text
        style={[st.rotatingText, {
          color: phrase.color,
          opacity: fadeAnim,
          transform: [{ translateY: slideAnim }],
        }]}
      >
        {phrase.text}
      </Animated.Text>
    </View>
  );
}

// ─── Pulsing logo ───

function PulsingLogo() {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const glowAnim = useRef(new Animated.Value(0.1)).current;
  const ringAnim = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    Animated.loop(Animated.sequence([
      Animated.parallel([
        Animated.timing(pulseAnim, { toValue: 1.06, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(glowAnim, { toValue: 0.35, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(ringAnim, { toValue: 0.6, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
      ]),
      Animated.parallel([
        Animated.timing(pulseAnim, { toValue: 1, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(glowAnim, { toValue: 0.1, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(ringAnim, { toValue: 0.3, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
      ]),
    ])).start();
  }, []);

  return (
    <View style={st.logoWrap}>
      {/* Outer glow */}
      <Animated.View style={[st.logoGlowOuter, { opacity: glowAnim, transform: [{ scale: pulseAnim }] }]} />
      {/* Ring */}
      <Animated.View style={[st.logoRing, { opacity: ringAnim, transform: [{ scale: pulseAnim }] }]} />
      {/* Main circle */}
      <Animated.View style={[st.logoCircle, { transform: [{ scale: pulseAnim }] }]}>
        <Text style={st.logoText}>One</Text>
        <View style={st.logoSparkle}>
          <IconSparkles size={14} color="#fff" />
        </View>
      </Animated.View>
    </View>
  );
}

function getSuggestions(t) {
  const tod = getTimeOfDay();
  if (tod === 'morning') return [
    { text: t('one.todaySummary'), icon: IconMail },
    { text: t('one.whatsToday'), icon: IconCalendar },
    { text: t('one.draftEmail'), icon: IconSend },
    { text: t('one.sendMessage'), icon: IconMessageSquare },
  ];
  if (tod === 'afternoon') return [
    { text: t('one.unreadEmails'), icon: IconMail },
    { text: t('one.upcomingEvents'), icon: IconCalendar },
    { text: t('one.sendMessage'), icon: IconMessageSquare },
    { text: t('one.setReminder'), icon: IconBell },
  ];
  return [
    { text: t('one.daySummary'), icon: IconMail },
    { text: t('one.tomorrowAgenda'), icon: IconCalendar },
    { text: t('one.setReminder'), icon: IconBell },
    { text: t('one.sendMessage'), icon: IconMessageSquare },
  ];
}

// ─── Markdown parser ───

function parseMarkdown(text, textColor, isDark) {
  if (!text) return null;
  const elements = [];
  const lines = text.split('\n');
  let inCodeBlock = false;
  let codeLines = [];
  let codeKey = 0;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        elements.push(
          <View key={`code-${codeKey++}`} style={st.codeBlock}>
            <Text style={st.codeText} selectable>{codeLines.join('\n')}</Text>
          </View>
        );
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) { codeLines.push(line); continue; }
    if (!line.trim()) { elements.push(<View key={`br-${li}`} style={{ height: 8 }} />); continue; }

    // Bullet list
    const bulletMatch = line.match(/^(\s*)[-*]\s+(.+)/);
    if (bulletMatch) {
      const indent = Math.min(Math.floor((bulletMatch[1] || '').length / 2), 3);
      elements.push(
        <View key={`li-${li}`} style={[st.bulletRow, { marginLeft: indent * 16 }]}>
          <Text style={[st.bulletDot, { color: textColor }]}>{'\u2022'}</Text>
          <Text style={[st.bulletText, { color: textColor }]} selectable>{fmtInline(bulletMatch[2], textColor, isDark)}</Text>
        </View>
      );
      continue;
    }

    // Numbered list
    const numMatch = line.match(/^(\s*)\d+[.)]\s+(.+)/);
    if (numMatch) {
      const num = line.match(/(\d+)/)[1];
      elements.push(
        <View key={`ol-${li}`} style={st.bulletRow}>
          <Text style={[st.bulletNum, { color: textColor }]}>{num}.</Text>
          <Text style={[st.bulletText, { color: textColor }]} selectable>{fmtInline(numMatch[2], textColor, isDark)}</Text>
        </View>
      );
      continue;
    }

    elements.push(
      <Text key={`p-${li}`} style={[st.msgText, { color: textColor }]} selectable>
        {fmtInline(line, textColor, isDark)}
      </Text>
    );
  }

  if (inCodeBlock && codeLines.length) {
    elements.push(
      <View key={`code-${codeKey}`} style={st.codeBlock}>
        <Text style={st.codeText} selectable>{codeLines.join('\n')}</Text>
      </View>
    );
  }
  return elements;
}

function fmtInline(text, textColor, isDark) {
  if (!text) return text;
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|https?:\/\/[^\s)]+)/g);
  return parts.map((part, i) => {
    if (!part) return null;
    if (part.startsWith('**') && part.endsWith('**'))
      return <Text key={i} style={{ fontWeight: '700' }}>{part.slice(2, -2)}</Text>;
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2)
      return <Text key={i} style={{ fontStyle: 'italic' }}>{part.slice(1, -1)}</Text>;
    if (part.startsWith('`') && part.endsWith('`'))
      return <Text key={i} style={[st.inlineCode, { backgroundColor: isDark ? '#2a2a3d' : '#f0f0f5' }]}>{part.slice(1, -1)}</Text>;
    if (/^https?:\/\//.test(part))
      return <Text key={i} style={{ color: '#6366f1', textDecorationLine: 'underline' }} onPress={() => Linking.openURL(part)}>{part}</Text>;
    return part;
  });
}

// ─── Thinking indicator (ChatGPT style) ───

function ThinkingIndicator({ colors, isDark, t }) {
  const dots = [useRef(new Animated.Value(0.3)).current, useRef(new Animated.Value(0.3)).current, useRef(new Animated.Value(0.3)).current];
  useEffect(() => {
    const anims = dots.map((dot, i) =>
      Animated.loop(Animated.sequence([
        Animated.delay(i * 200),
        Animated.timing(dot, { toValue: 1, duration: 400, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(dot, { toValue: 0.3, duration: 400, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
      ]))
    );
    anims.forEach(a => a.start());
    return () => anims.forEach(a => a.stop());
  }, []);

  return (
    <View style={st.msgContainer}>
      <View style={st.msgInner}>
        <View style={[st.avatar, { backgroundColor: '#6366f1' }]}>
          <IconSparkles size={16} color="#fff" />
        </View>
        <View style={st.msgBody}>
          <View style={st.thinkRow}>
            {dots.map((dot, i) => (
              <Animated.View key={i} style={[st.thinkDot, { backgroundColor: isDark ? '#8b8ba3' : '#999', opacity: dot }]} />
            ))}
          </View>
        </View>
      </View>
    </View>
  );
}

// ─── Message row (ChatGPT style - full width, no bubbles) ───

function MessageRow({ item, colors, isDark, onSpeak, speakingId }) {
  const isUser = item.role === 'user';
  const isSpeaking = speakingId === item.id;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 250, useNativeDriver: Platform.OS !== 'web' }).start();
  }, []);

  return (
    <Animated.View style={[
      st.msgContainer,
      isUser && { backgroundColor: isDark ? '#1a1a2e' : '#f7f7f8' },
      { opacity: fadeAnim },
    ]}>
      <View style={[st.msgInner, isWide && { maxWidth: CONTENT_MAX, alignSelf: 'center', width: '100%' }]}>
        {/* Avatar */}
        {isUser ? (
          <View style={[st.avatar, { backgroundColor: isDark ? '#4a4a6a' : '#d1d1e0' }]}>
            <Text style={st.avatarText}>
              {item.userName?.charAt(0)?.toUpperCase() || '?'}
            </Text>
          </View>
        ) : (
          <View style={[st.avatar, { backgroundColor: '#6366f1' }]}>
            <IconSparkles size={16} color="#fff" />
          </View>
        )}

        {/* Content */}
        <View style={st.msgBody}>
          <View style={st.msgAuthorRow}>
            <Text style={[st.msgAuthor, { color: isUser ? colors.text : '#6366f1' }]}>
              {isUser ? 'Você' : 'One'}
            </Text>
            {/* Speaker button on AI messages */}
            {!isUser && item.content && (
              <TouchableOpacity
                onPress={() => onSpeak?.(item)}
                hitSlop={8}
                style={st.speakBtn}
                accessibilityLabel={isSpeaking ? 'Stop reading' : 'Read aloud'}
              >
                {isSpeaking ? (
                  <IconVolumeX size={16} color="#6366f1" />
                ) : (
                  <IconVolume2 size={16} color={isDark ? '#8b8ba3' : '#999'} />
                )}
              </TouchableOpacity>
            )}
          </View>
          {isUser ? (
            <Text style={[st.msgText, { color: colors.text }]} selectable>{item.content}</Text>
          ) : (
            <View style={st.mdContent}>{parseMarkdown(item.content, colors.text, isDark)}</View>
          )}
          {/* Tool actions hidden - cleaner UI */}
        </View>
      </View>
    </Animated.View>
  );
}

// ─── History sidebar ───

function HistorySidebar({ visible, onClose, conversations, onSelect, currentId, colors, isDark, t, insets }) {
  if (!visible) return null;
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <View style={st.sidebarOverlay}>
        <TouchableOpacity style={st.sidebarDim} activeOpacity={1} onPress={onClose} />
        <View style={[st.sidebar, {
          backgroundColor: isDark ? '#111128' : '#f9f9fb',
          paddingTop: insets.top + 8,
        }]}>
          <View style={st.sidebarHeader}>
            <Text style={[st.sidebarTitle, { color: colors.text }]}>{t('one.history')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <IconX size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <ScrollView style={st.sidebarList} showsVerticalScrollIndicator={false}>
            {conversations.length === 0 && (
              <Text style={[st.sidebarEmpty, { color: colors.textTertiary }]}>{t('one.noConversations')}</Text>
            )}
            {conversations.map((c) => {
              const active = c.id === currentId;
              return (
                <TouchableOpacity
                  key={c.id}
                  style={[st.sidebarItem, active && { backgroundColor: isDark ? '#1f1f3a' : '#ededf5' }]}
                  onPress={() => { onSelect(c); onClose(); }}
                  activeOpacity={0.7}
                >
                  <Text style={[st.sidebarItemText, { color: active ? '#6366f1' : colors.text }]} numberOfLines={1}>
                    {c.title || `#${c.id}`}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ─── Main Screen ───

export default function OneScreen() {
  const { colors, isDark } = useTheme();
  const { user } = useAuth();
  const { t, language: locale } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversations, setConversations] = useState([]);
  const [isListening, setIsListening] = useState(false);
  const [speakingId, setSpeakingId] = useState(null);
  const [autoRead, setAutoRead] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false); // Siri-like voice conversation mode
  const [voiceState, setVoiceState] = useState('listening'); // 'listening' | 'thinking' | 'speaking'
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const flatListRef = useRef(null);
  const recognitionRef = useRef(null);
  const speakCheckRef = useRef(null);
  const voiceModeRef = useRef(false); // ref to avoid stale closures

  const firstName = user?.name?.split(' ')[0] || user?.email?.split('@')[0] || '';

  const [initialLoaded, setInitialLoaded] = useState(false);

  // Load conversations and auto-restore the most recent one
  const loadConversations = useCallback(async (autoRestore = false) => {
    try {
      const res = await api.oneHistory();
      let convos = [];
      if (res?.success && res.data?.conversations) convos = res.data.conversations;
      else if (res?.success && Array.isArray(res.data)) convos = res.data;
      setConversations(convos);

      // Auto-restore last conversation if < 8 hours old, otherwise start fresh
      if (autoRestore && convos.length > 0 && !conversationId && messages.length === 0) {
        const last = convos[0]; // most recent
        const lastUpdated = new Date(last.updated_at || last.created_at);
        const hoursAgo = (Date.now() - lastUpdated.getTime()) / (1000 * 60 * 60);
        if (hoursAgo >= 8) return; // too old, start fresh chat
        setConversationId(last.id);
        try {
          const hRes = await api.oneHistory(last.id);
          const msgs = hRes?.data?.messages || (Array.isArray(hRes?.data) ? hRes.data : []);
          if (msgs.length > 0) {
            setMessages(msgs.map((m, i) => ({
              id: `h-${i}`, role: m.role, content: m.content,
              actions: m.tool_calls ? JSON.parse(m.tool_calls || '[]') : [],
              userName: firstName,
            })));
          }
        } catch {}
      }
    } catch {}
  }, [conversationId, messages.length, firstName]);

  useEffect(() => {
    if (!initialLoaded) {
      setInitialLoaded(true);
      loadConversations(true);
    }
  }, [initialLoaded]);

  const loadConversation = useCallback(async (conv) => {
    setConversationId(conv.id);
    setMessages([]);
    setLoading(true);
    try {
      const res = await api.oneHistory(conv.id);
      const msgs = res?.data?.messages || (Array.isArray(res?.data) ? res.data : []);
      setMessages(msgs.map((m, i) => ({
        id: `h-${i}`, role: m.role, content: m.content,
        actions: m.tool_calls ? JSON.parse(m.tool_calls || '[]') : [],
        userName: firstName,
      })));
    } catch {} finally { setLoading(false); }
  }, [firstName]);

  const sendMessage = useCallback(async (text) => {
    const msg = (text || inputText).trim();
    if (!msg || loading) return;
    setInputText('');
    setVoiceTranscript('');
    setMessages(prev => [...prev, { id: Date.now(), role: 'user', content: msg, userName: firstName }]);
    setLoading(true);
    if (voiceModeRef.current) setVoiceState('thinking');
    try {
      const result = await api.oneChat(msg, conversationId);
      const aiMsgId = Date.now() + 1;
      if (result?.success && result.data) {
        if (result.data.conversation_id) setConversationId(result.data.conversation_id);
        const responseText = result.data.response || t('one.errorProcess');
        setMessages(prev => [...prev, {
          id: aiMsgId, role: 'assistant',
          content: responseText,
          actions: result.data.actions || [],
        }]);
        // Voice mode: speak sentence-by-sentence, then auto-listen
        if (voiceModeRef.current) {
          setVoiceState('speaking');
          setSpeakingId(aiMsgId);
          const lang = getTTSLang(locale);
          haptic('light');
          speakSentenceBysentence(responseText, lang, () => {
            setSpeakingId(null);
            if (voiceModeRef.current) {
              // Done speaking - listen again after short pause
              setTimeout(() => {
                if (voiceModeRef.current) {
                  playReactivationSound();
                  haptic('light');
                  setVoiceState('listening');
                  startListeningForVoiceMode();
                }
              }, 500);
            }
          });
        }
      } else {
        const errText = result?.message || t('one.errorProcess');
        setMessages(prev => [...prev, { id: aiMsgId, role: 'assistant', content: errText }]);
        if (voiceModeRef.current) {
          setVoiceState('speaking');
          haptic('light');
          const lang = getTTSLang(locale);
          speakSentenceBysentence(errText, lang, () => {
            if (voiceModeRef.current) {
              setTimeout(() => {
                if (voiceModeRef.current) {
                  playReactivationSound();
                  haptic('light');
                  setVoiceState('listening');
                  startListeningForVoiceMode();
                }
              }, 500);
            }
          });
        }
      }
    } catch {
      const errText = t('one.error');
      setMessages(prev => [...prev, { id: Date.now() + 1, role: 'assistant', content: errText }]);
      if (voiceModeRef.current) {
        setVoiceState('speaking');
        haptic('light');
        const lang = getTTSLang(locale);
        speakSentenceBysentence(errText, lang, () => {
          if (voiceModeRef.current) {
            setTimeout(() => {
              if (voiceModeRef.current) {
                playReactivationSound();
                haptic('light');
                setVoiceState('listening');
                startListeningForVoiceMode();
              }
            }, 500);
          }
        });
      }
    } finally {
      setLoading(false);
      loadConversations(false); // refresh sidebar list
    }
  }, [inputText, loading, conversationId, t, firstName, loadConversations, locale]);

  const newChat = useCallback(() => {
    setMessages([]); setConversationId(null); loadConversations(false);
  }, [loadConversations]);

  // ─── Voice Input (Speech-to-Text) ───

  const startListening = useCallback(async () => {
    setAutoRead(true); // Enable auto-read when using voice
    if (Platform.OS !== 'web') {
      // Native: use expo-speech-recognition
      try {
        const { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } = require('expo-speech-recognition');
        const permResult = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
        if (permResult.status !== 'granted') {
          if (typeof alert !== 'undefined') alert(t('one.voiceNotSupported'));
          return;
        }
        // Start recognition
        ExpoSpeechRecognitionModule.start({ lang: getTTSLang(locale), interimResults: false });
        setIsListening(true);
        // Listen for results via event subscription
        const sub = ExpoSpeechRecognitionModule.addListener('result', (event) => {
          if (event.isFinal && event.results?.[0]?.transcript) {
            const transcript = event.results[0].transcript;
            setInputText(transcript);
            setIsListening(false);
            sub?.remove();
            // Auto-send after speech
            setTimeout(() => {
              sendMessage(transcript);
              setInputText('');
            }, 500);
          }
        });
        const endSub = ExpoSpeechRecognitionModule.addListener('end', () => {
          setIsListening(false);
          endSub?.remove();
        });
        const errSub = ExpoSpeechRecognitionModule.addListener('error', () => {
          setIsListening(false);
          errSub?.remove();
        });
      } catch (e) {
        console.warn('[one] Speech recognition error:', e?.message);
        if (typeof alert !== 'undefined') alert(t('one.voiceComingSoon'));
      }
      return;
    }
    const recognition = getWebSpeechRecognition();
    if (!recognition) {
      if (typeof alert !== 'undefined') alert(t('one.voiceNotSupported'));
      return;
    }
    recognition.lang = getTTSLang(locale);
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript || '';
      if (transcript) {
        setInputText(transcript);
        // Auto-send after speech
        setTimeout(() => {
          sendMessage(transcript);
          setInputText('');
        }, 500);
      }
    };
    recognition.onend = () => setIsListening(false);
    recognition.onerror = () => setIsListening(false);
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setIsListening(true);
    } catch {
      setIsListening(false);
    }
  }, [t, locale, sendMessage]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch {}
      recognitionRef.current = null;
    }
    setIsListening(false);
  }, []);

  const toggleListening = useCallback(() => {
    if (isListening) stopListening();
    else startListening();
  }, [isListening, startListening, stopListening]);

  // ─── Voice conversation mode ───

  // Start listening specifically for voice conversation mode (auto-sends on result)
  const startListeningForVoiceMode = useCallback(() => {
    if (!voiceModeRef.current) return;
    setVoiceState('listening');
    setVoiceTranscript('');
    haptic('light');

    if (Platform.OS !== 'web') {
      try {
        const { ExpoSpeechRecognitionModule } = require('expo-speech-recognition');
        ExpoSpeechRecognitionModule.start({ lang: getTTSLang(locale), interimResults: false });
        setIsListening(true);
        const sub = ExpoSpeechRecognitionModule.addListener('result', (event) => {
          if (event.isFinal && event.results?.[0]?.transcript) {
            const transcript = event.results[0].transcript;
            setVoiceTranscript(transcript);
            haptic('medium');
            setIsListening(false);
            sub?.remove();
            setTimeout(() => sendMessage(transcript), 200);
          }
        });
        const endSub = ExpoSpeechRecognitionModule.addListener('end', () => {
          setIsListening(false);
          endSub?.remove();
          // If voice mode is still active and no transcript, try again
          if (voiceModeRef.current) {
            setTimeout(() => {
              if (voiceModeRef.current) startListeningForVoiceMode();
            }, 500);
          }
        });
        const errSub = ExpoSpeechRecognitionModule.addListener('error', () => {
          setIsListening(false);
          errSub?.remove();
        });
      } catch (e) {
        console.warn('[one] Voice mode speech recognition error:', e?.message);
      }
      return;
    }

    // Web
    const recognition = getWebSpeechRecognition();
    if (!recognition) return;
    recognition.lang = getTTSLang(locale);
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript || '';
      if (transcript) {
        setVoiceTranscript(transcript);
        haptic('medium');
        setTimeout(() => sendMessage(transcript), 200);
      }
    };
    recognition.onend = () => {
      setIsListening(false);
      // If voice mode still active and no transcript came, re-listen
      if (voiceModeRef.current) {
        setTimeout(() => {
          if (voiceModeRef.current) startListeningForVoiceMode();
        }, 500);
      }
    };
    recognition.onerror = (e) => {
      setIsListening(false);
      // 'no-speech' is normal, just re-listen
      if (e.error === 'no-speech' && voiceModeRef.current) {
        setTimeout(() => {
          if (voiceModeRef.current) startListeningForVoiceMode();
        }, 500);
      }
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setIsListening(true);
    } catch {
      setIsListening(false);
    }
  }, [locale, sendMessage]);

  const enterVoiceMode = useCallback(() => {
    setVoiceMode(true);
    voiceModeRef.current = true;
    setAutoRead(false); // voice mode handles its own TTS
    setVoiceState('listening');
    setVoiceTranscript('');
    stopSpeak();
    playActivationSound();
    // Start listening
    setTimeout(() => startListeningForVoiceMode(), 300);
  }, [startListeningForVoiceMode]);

  const exitVoiceMode = useCallback(() => {
    voiceModeRef.current = false;
    setVoiceMode(false);
    setVoiceState('listening');
    setVoiceTranscript('');
    abortVoiceSpeaking();
    stopListening();
    setSpeakingId(null);
  }, [stopListening]);

  // ─── Voice Output (Text-to-Speech) ───

  const speakMessage = useCallback((item) => {
    // If already speaking this message, stop
    if (speakingId === item.id) {
      stopSpeak();
      setSpeakingId(null);
      if (speakCheckRef.current) { clearInterval(speakCheckRef.current); speakCheckRef.current = null; }
      return;
    }
    // Stop any current speech
    stopSpeak();
    if (speakCheckRef.current) { clearInterval(speakCheckRef.current); speakCheckRef.current = null; }

    const plainText = stripMarkdown(item.content);
    if (!plainText) return;

    const lang = getTTSLang(locale);
    const started = speakText(plainText, lang, () => {
      // Called when speech finishes
      setSpeakingId(null);
    });
    if (started) {
      setSpeakingId(item.id);
    }
  }, [speakingId, locale]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      voiceModeRef.current = false;
      abortVoiceSpeaking();
      stopSpeak();
      if (recognitionRef.current) try { recognitionRef.current.stop(); } catch {}
      if (speakCheckRef.current) clearInterval(speakCheckRef.current);
    };
  }, []);

  // Auto-read new AI messages (only when not in voice conversation mode)
  useEffect(() => {
    if (!autoRead || voiceMode || messages.length === 0) return;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === 'assistant' && lastMsg.content && !loading) {
      // Small delay to let UI render first
      const timer = setTimeout(() => speakMessage(lastMsg), 300);
      return () => clearTimeout(timer);
    }
  }, [messages.length, loading, autoRead, voiceMode]);

  const hasMessages = messages.length > 0;

  const renderMessage = useCallback(({ item }) => (
    <MessageRow item={item} colors={colors} isDark={isDark} onSpeak={speakMessage} speakingId={speakingId} />
  ), [colors, isDark, speakMessage, speakingId]);

  // ─── Empty state - beautiful animated ───
  const renderEmpty = () => {
    const greeting = getGreeting(t);
    const suggestions = getSuggestions(t);

    return (
      <View style={st.emptyOuter}>
        {/* Center - logo + animated text */}
        <View style={st.emptyCenter}>
          <PulsingLogo />

          <Text style={[st.emptyGreeting, { color: colors.text }]}>
            {greeting}{firstName ? `, ${firstName}` : ''}
          </Text>

          {/* "Posso te ajudar a..." + rotating text */}
          <View style={st.canHelpRow}>
            <Text style={[st.canHelpText, { color: colors.textSecondary }]}>
              Posso te ajudar a{' '}
            </Text>
            <RotatingText isDark={isDark} />
          </View>
        </View>

        {/* Suggestion chips at bottom */}
        <View style={st.sugArea}>
          <View style={[st.sugGrid, isWide && { maxWidth: CONTENT_MAX }]}>
            {suggestions.map((item, i) => {
              const Icon = item.icon;
              return (
                <TouchableOpacity
                  key={i}
                  style={[st.sugChip, {
                    backgroundColor: isDark ? '#1a1a2e' : '#fff',
                    borderColor: isDark ? '#252540' : '#e0e0ea',
                    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : {}),
                  }]}
                  onPress={() => sendMessage(item.text)}
                  activeOpacity={0.7}
                >
                  <Icon size={16} color={isDark ? '#a5a5c0' : '#666'} />
                  <Text style={[st.sugChipText, { color: colors.text }]} numberOfLines={1}>{item.text}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={[st.container, { backgroundColor: isDark ? '#0d0d1a' : '#fff' }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      {/* Header - minimal */}
      <View style={[st.header, {
        paddingTop: insets.top + 4,
        borderBottomColor: isDark ? '#1a1a2e' : '#e8e8ec',
      }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={st.headerBtn}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => { loadConversations(false); setHistoryOpen(true); }}
          hitSlop={8} style={st.headerBtn}
        >
          <IconMenu size={20} color={colors.textSecondary} />
        </TouchableOpacity>

        {/* Center title */}
        <View style={st.headerCenter}>
          <View style={[st.headerDot, { backgroundColor: '#6366f1' }]}>
            <IconSparkles size={12} color="#fff" />
          </View>
          <Text style={[st.headerTitle, { color: colors.text }]}>One</Text>
        </View>

        {/* Auto-read toggle */}
        <TouchableOpacity
          onPress={() => { setAutoRead(v => !v); if (autoRead) { stopSpeak(); setSpeakingId(null); } }}
          hitSlop={8}
          style={st.headerBtn}
          accessibilityLabel={t('one.voiceAutoRead')}
        >
          {autoRead ? (
            <IconVolume2 size={18} color="#6366f1" />
          ) : (
            <IconVolumeX size={18} color={colors.textTertiary} />
          )}
        </TouchableOpacity>

        {/* Voice conversation mode */}
        <TouchableOpacity
          onPress={enterVoiceMode}
          hitSlop={8}
          style={st.headerBtn}
          accessibilityLabel={t('one.voiceConversation')}
        >
          <IconPhone size={18} color={colors.textSecondary} />
        </TouchableOpacity>

        {/* Right: new chat */}
        <TouchableOpacity onPress={newChat} hitSlop={8} style={st.headerBtn}>
          <IconPlus size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* Messages */}
      {hasMessages ? (
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={item => String(item.id)}
          renderItem={renderMessage}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
          showsVerticalScrollIndicator={false}
          ListFooterComponent={loading ? <ThinkingIndicator colors={colors} isDark={isDark} t={t} /> : null}
        />
      ) : (
        renderEmpty()
      )}

      {/* Input - ChatGPT style centered */}
      <View style={[st.inputArea, {
        paddingBottom: Math.max(insets.bottom, 12),
        backgroundColor: isDark ? '#0d0d1a' : '#fff',
      }]}>
        <View style={[st.inputWrapper, isWide && { maxWidth: CONTENT_MAX, alignSelf: 'center', width: '100%' }]}>
          <View style={[st.inputBox, {
            backgroundColor: isDark ? '#1a1a2e' : '#f4f4f8',
            borderColor: isListening ? '#ef4444' : (isDark ? '#252540' : '#ddd'),
          }]}>
            {/* Listening indicator */}
            {isListening && (
              <View style={st.listeningRow}>
                <PulsingMicDot isDark={isDark} />
                <Text style={[st.listeningText, { color: '#ef4444' }]}>{t('one.voiceListening')}</Text>
              </View>
            )}
            <TextInput
              style={[st.input, { color: colors.text, maxHeight: 120 }]}
              placeholder={isListening ? '' : t('one.placeholder')}
              placeholderTextColor={colors.textTertiary}
              value={inputText}
              onChangeText={setInputText}
              onSubmitEditing={() => sendMessage()}
              returnKeyType="send"
              multiline
              maxLength={2000}
              editable={!loading}
            />
            {/* Mic button */}
            <TouchableOpacity
              style={st.micBtn}
              onPress={toggleListening}
              activeOpacity={0.7}
              accessibilityLabel={isListening ? t('one.speakStop') : 'Microphone'}
            >
              {isListening ? (
                <IconMicOff size={18} color="#ef4444" />
              ) : (
                <IconMic size={18} color={isDark ? '#8b8ba3' : '#999'} />
              )}
            </TouchableOpacity>
            {/* Send button */}
            <TouchableOpacity
              style={[st.sendBtn, { opacity: inputText.trim() ? 1 : 0.3 }]}
              onPress={() => sendMessage()}
              disabled={!inputText.trim() || loading}
              activeOpacity={0.7}
            >
              <View style={[st.sendCircle, { backgroundColor: inputText.trim() ? '#6366f1' : (isDark ? '#333' : '#ccc') }]}>
                <IconSend size={14} color="#fff" />
              </View>
            </TouchableOpacity>
          </View>
          <Text style={[st.disclaimer, { color: colors.textTertiary }]}>
            {t('one.disclaimer')}
          </Text>
        </View>
      </View>

      {/* Voice conversation overlay */}
      {voiceMode && (
        <VoiceConversationOverlay
          isDark={isDark}
          colors={colors}
          t={t}
          voiceState={voiceState}
          transcript={voiceTranscript}
          onStop={exitVoiceMode}
        />
      )}

      {/* History */}
      <HistorySidebar
        visible={historyOpen}
        onClose={() => setHistoryOpen(false)}
        conversations={conversations}
        onSelect={loadConversation}
        currentId={conversationId}
        colors={colors}
        isDark={isDark}
        t={t}
        insets={insets}
      />
    </KeyboardAvoidingView>
  );
}

// ─── Styles ───

const st = StyleSheet.create({
  container: { flex: 1 },

  // Header - minimal centered
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 8, paddingBottom: 10, borderBottomWidth: 1,
  },
  headerBtn: { padding: 8 },
  headerCenter: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  headerDot: {
    width: 24, height: 24, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { fontSize: 16, fontWeight: '600' },

  // Messages - full width rows
  msgContainer: {
    paddingVertical: 16, paddingHorizontal: 16,
  },
  msgInner: {
    flexDirection: 'row', gap: 14, maxWidth: CONTENT_MAX,
    ...(isWide ? { alignSelf: 'center', width: '100%' } : {}),
  },
  avatar: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', marginTop: 2,
  },
  avatarText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  msgBody: { flex: 1 },
  msgAuthorRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  msgAuthor: { fontSize: 13, fontWeight: '700' },
  speakBtn: { padding: 4 },
  mdContent: { gap: 2 },
  msgText: { fontSize: 15, lineHeight: 24 },

  // Actions
  actionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  actionChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8,
  },
  actionLabel: { fontSize: 10, fontWeight: '600' },

  // Code
  codeBlock: {
    backgroundColor: '#1e1e2e', borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 10, marginVertical: 4,
  },
  codeText: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13, color: '#a6e3a1', lineHeight: 20,
  },
  inlineCode: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, color: '#e06c75',
  },

  // Lists
  bulletRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginVertical: 1 },
  bulletDot: { fontSize: 16, lineHeight: 24 },
  bulletNum: { fontSize: 14, lineHeight: 24, fontWeight: '600', minWidth: 18 },
  bulletText: { flex: 1, fontSize: 15, lineHeight: 24 },

  // Thinking
  thinkRow: { flexDirection: 'row', gap: 5, paddingVertical: 4 },
  thinkDot: { width: 8, height: 8, borderRadius: 4 },

  // Pulsing logo
  logoWrap: {
    width: 110, height: 110, alignItems: 'center', justifyContent: 'center', marginBottom: 28,
  },
  logoGlowOuter: {
    position: 'absolute', width: 110, height: 110, borderRadius: 55,
    backgroundColor: '#7c3aed',
  },
  logoRing: {
    position: 'absolute', width: 88, height: 88, borderRadius: 44,
    borderWidth: 2, borderColor: '#a78bfa', backgroundColor: 'transparent',
  },
  logoCircle: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: '#6366f1', alignItems: 'center', justifyContent: 'center',
  },
  logoText: {
    color: '#fff', fontSize: 22, fontWeight: '800', letterSpacing: -0.5, marginTop: 2,
  },
  logoSparkle: {
    position: 'absolute', top: 8, right: 8,
  },

  // Animated rotating text
  rotatingWrap: { height: 32, justifyContent: 'center', overflow: 'hidden' },
  rotatingText: { fontSize: 18, fontWeight: '700' },

  // Empty state - ChatGPT style
  emptyOuter: { flex: 1, justifyContent: 'space-between' },
  emptyCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  emptyGreeting: { fontSize: 24, fontWeight: '700', marginBottom: 12, letterSpacing: -0.3 },
  canHelpRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' },
  canHelpText: { fontSize: 18, fontWeight: '400' },

  // Suggestion chips - bottom area
  sugArea: { paddingHorizontal: 16, paddingBottom: 8 },
  sugGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center',
    ...(isWide ? { alignSelf: 'center', width: '100%' } : {}),
  },
  sugChip: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 20, borderWidth: 1,
    width: isWide ? 'auto' : '47%',
  },
  sugChipText: { fontSize: 13, fontWeight: '500', flex: 1 },

  // Input - ChatGPT style
  inputArea: { paddingHorizontal: 16, paddingTop: 8 },
  inputWrapper: {},
  inputBox: {
    flexDirection: 'row', alignItems: 'flex-end',
    borderRadius: 24, borderWidth: 1,
    paddingLeft: 18, paddingRight: 6, paddingVertical: 4,
  },
  input: {
    flex: 1, fontSize: 15, minHeight: 36,
    paddingVertical: Platform.OS === 'ios' ? 8 : 6,
  },
  micBtn: { padding: 4, marginBottom: 2, marginRight: 2 },
  listeningRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    position: 'absolute', left: 18, top: 10, zIndex: 1,
  },
  listeningText: { fontSize: 12, fontWeight: '600' },
  sendBtn: { padding: 4, marginBottom: 2 },
  sendCircle: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  disclaimer: { fontSize: 11, textAlign: 'center', marginTop: 6, marginBottom: 2 },

  // History sidebar
  sidebarOverlay: { flex: 1, flexDirection: 'row' },
  sidebarDim: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sidebar: {
    position: 'absolute', left: 0, top: 0, bottom: 0, width: 280,
    shadowColor: '#000', shadowOffset: { width: 2, height: 0 },
    shadowOpacity: 0.15, shadowRadius: 10, elevation: 10,
  },
  sidebarHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: 'rgba(128,128,128,0.15)',
  },
  sidebarTitle: { fontSize: 17, fontWeight: '700' },
  sidebarList: { flex: 1, paddingVertical: 8 },
  sidebarEmpty: { textAlign: 'center', marginTop: 40, fontSize: 14 },
  sidebarItem: {
    paddingHorizontal: 16, paddingVertical: 12,
    borderRadius: 8, marginHorizontal: 8, marginVertical: 1,
  },
  sidebarItemText: { fontSize: 14, fontWeight: '500' },

  // Voice conversation overlay
  voiceOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 100, overflow: 'hidden',
  },
  voiceOverlayInner: {
    flex: 1, width: '100%',
    justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: 32,
  },
  voiceStatusLabel: {
    fontSize: 16, fontWeight: '600',
    marginBottom: 40,
    letterSpacing: 0.5,
  },
  voiceCenterAnim: {
    alignItems: 'center', justifyContent: 'center',
    minHeight: 200,
  },
  voiceTranscript: {
    fontSize: 18, fontWeight: '500', textAlign: 'center',
    marginTop: 40, maxWidth: 320,
    lineHeight: 26,
  },
  voiceSilenceHint: {
    fontSize: 14, fontWeight: '500', textAlign: 'center',
    marginTop: 24, opacity: 0.7,
  },
  voiceStopBtn: {
    position: 'absolute', bottom: 60,
    alignItems: 'center', gap: 10,
  },
  voiceStopCircle: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: '#ef4444',
    alignItems: 'center', justifyContent: 'center',
    elevation: 4,
    shadowColor: '#ef4444', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3, shadowRadius: 8,
  },
  voiceStopText: {
    color: '#ef4444', fontSize: 13, fontWeight: '600',
  },
});
