import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  View, FlatList, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, Animated, Easing, Dimensions,
  ScrollView, Modal, Linking, ActivityIndicator, Image, Alert,
} from 'react-native';
// FlashList reverted to FlatList
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import {
  IconSend, IconArrowLeft, IconZap, IconMail, IconCalendar,
  IconMessageSquare, IconClock, IconPlus, IconSparkles,
  IconX, IconBell, IconMenu, IconMic, IconMicOff, IconVolume2, IconVolumeX,
  IconPhone, IconStop, IconFolder, IconUsers, IconCamera, IconEdit,
  IconChevronUp, IconChevronDown, IconTrash, IconCopy, IconRepeat,
  IconThumbsDown,
} from '../components/Icons';
// SVG primitives for the send-button gradient + empty-state sparkle illustration.
// Pure-SVG keeps us off expo-linear-gradient (not a dep) and renders identically
// on web/native.
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Circle as SvgCircle, Path as SvgPath, G as SvgG } from 'react-native-svg';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as api from '../services/api';
import { getCached, setCache } from '../services/cache';
import { OneRealtimeSession, isRealtimeSupported } from '../services/oneRealtime';
import SmartReplyChips from '../components/SmartReplyChips';
import ChatyyOneAvatar from '../components/ChatyyOneAvatar';

// Strip the trailing `<followups>q1|q2|q3</followups>` marker the server-side
// prompt appends to every One reply. Lets us hide it from rendered markdown
// during streaming (DB-side it's already stripped before persist). Returns
// the cleaned text + the parsed list (empty if marker incomplete/malformed).
const FOLLOWUPS_RE = /\s*<followups>([\s\S]*?)<\/followups>\s*$/i;
const FOLLOWUPS_OPEN_RE = /\s*<followups>[\s\S]*$/i;
function extractFollowups(text) {
  if (!text || typeof text !== 'string') return { text: text || '', followups: [] };
  if (text.indexOf('<followups>') === -1) return { text, followups: [] };
  const m = FOLLOWUPS_RE.exec(text);
  if (m) {
    const parts = m[1].split('|')
      .map(s => s.trim().replace(/^[-*\d.)\s]+/, ''))
      .filter(Boolean)
      .map(s => s.length > 60 ? s.slice(0, 60) : s)
      .slice(0, 3);
    return { text: text.replace(FOLLOWUPS_RE, ''), followups: parts };
  }
  // Marker started but not closed (mid-stream) — hide the open fragment.
  return { text: text.replace(FOLLOWUPS_OPEN_RE, ''), followups: [] };
}

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

const ACCENT = '#7C3AED'; // Chatyy purple
const ACCENT_DARK = '#6D28D9'; // Chatyy dark purple
const ACCENT_HEADER = '#6D28D9'; // Chatyy header dark
const USER_BUBBLE = '#EDE9FE'; // Chatyy sent bubble (light)
const USER_BUBBLE_DARK = '#4C1D95'; // Chatyy sent bubble (dark)

const ROTATING_PHRASES = [
  'resumir seus emails',
  'organizar sua agenda',
  'te lembrar de compromissos',
  'rascunhar respostas',
  'agendar reuniões',
  'te ligar pra lembrar',
  'buscar seus arquivos',
  'enviar mensagens',
  'criar eventos no calendário',
  'aprender seu estilo',
  'responder emails por você',
  'encontrar contatos',
  'marcar reuniões com sua equipe',
  'gerenciar suas pastas',
  'resumir conversas do chat',
  'planejar seu dia',
  'priorizar tarefas urgentes',
  'encaminhar emails importantes',
  'criar lembretes',
  'organizar seus documentos',
  'sugerir respostas inteligentes',
  'acompanhar prazos',
  'preparar briefings do dia',
  'traduzir mensagens',
  'te ajudar em tudo',
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

// Detect spoken language from text content (used for TTS so the One speaks in the
// same language she just wrote in, regardless of the app's UI locale).
function detectTextLang(text, fallbackLocale) {
  if (!text || typeof text !== 'string') return getTTSLang(fallbackLocale);
  const lower = text.toLowerCase();
  // Strong English markers
  const enHits = (lower.match(/\b(the|and|you|that|with|this|have|from|they|would|there|their|what|about|which|when|your|been|your|were|just|like|than|some|will|here|because|could|should|something|going|right|hello|hi|thanks|thank you|please|sorry)\b/g) || []).length;
  // Strong Portuguese markers
  const ptHits = (lower.match(/\b(você|voce|não|nao|para|com|que|como|também|tambem|está|esta|tudo|bem|obrigad[oa]|olá|ola|oi|sim|aqui|agora|porque|então|entao|posso|fazer|fiz|vou|vamos|temos|tem|tá|ta|tô|to|né|ne|cara|amigo|mas|mais|onde|quando|quem|qual)\b/g) || []).length;
  // Spanish markers
  const esHits = (lower.match(/\b(usted|gracias|hola|cómo|como|está|estás|por favor|ahora|también|tiene|hacer|hablar|quiero|necesito|donde|dónde|cuando|cuándo|porque|porqué|muy|muchas|nada|esto|esta)\b/g) || []).length;
  if (ptHits >= 2 && ptHits >= enHits && ptHits >= esHits) return 'pt-BR';
  if (enHits >= 2 && enHits > ptHits && enHits > esHits) return 'en-US';
  if (esHits >= 2 && esHits > ptHits && esHits > enHits) return 'es-ES';
  // Diacritic-based fallback (ã, õ, ç → PT; ñ → ES)
  if (/[ãõç]/i.test(text)) return 'pt-BR';
  if (/ñ/i.test(text)) return 'es-ES';
  // Default to UI locale
  return getTTSLang(fallbackLocale);
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

// Module-scoped refs for current TTS lifecycle so stop paths can clean up
// the playback poll interval and the active blob URL on web. Without
// these, calling stopSpeakAsync() while a playback is in flight leaks the
// setInterval (causes phantom onDone calls) and leaks the blob URL.
let _currentTtsInterval = null;
let _currentTtsBlobUrl = null;

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
      _currentTtsBlobUrl = url;
      audio.onended = () => { try { URL.revokeObjectURL(url); } catch {} if (_currentTtsBlobUrl === url) _currentTtsBlobUrl = null; _currentAudio = null; if (onDone) onDone(); };
      audio.onerror = () => { try { URL.revokeObjectURL(url); } catch {} if (_currentTtsBlobUrl === url) _currentTtsBlobUrl = null; _currentAudio = null; if (onDone) onDone(); };
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
          if (_currentTtsInterval) { try { clearInterval(_currentTtsInterval); } catch {} _currentTtsInterval = null; }
          _currentTtsInterval = setInterval(() => {
            try {
              if (!player.playing && player.currentTime > 0) {
                if (_currentTtsInterval) { clearInterval(_currentTtsInterval); _currentTtsInterval = null; }
                player.remove();
                _currentSound = null;
                if (onDone) onDone();
              }
            } catch {
              if (_currentTtsInterval) { clearInterval(_currentTtsInterval); _currentTtsInterval = null; }
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
  // Always clear the playback poll interval first — without this, the
  // interval keeps firing and calls onDone after stop, restarting voice
  // mode loops mid-recording.
  if (_currentTtsInterval) {
    try { clearInterval(_currentTtsInterval); } catch {}
    _currentTtsInterval = null;
  }
  // Stop web Audio + revoke any blob URL we created (was only revoked on
  // onended/onerror, leaking on early stops).
  if (_currentAudio) {
    try { _currentAudio.pause(); _currentAudio.src = ''; } catch {}
    _currentAudio = null;
  }
  if (_currentTtsBlobUrl) {
    try { URL.revokeObjectURL(_currentTtsBlobUrl); } catch {}
    _currentTtsBlobUrl = null;
  }
  // Stop the native audio handle. We use expo-audio's createAudioPlayer
  // (which exposes pause/remove), NOT expo-av Sound (which uses
  // stopAsync/unloadAsync). The previous version called the wrong API
  // family and threw silently — leaving audio playing.
  if (_currentSound) {
    try {
      if (typeof _currentSound.pause === 'function') _currentSound.pause();
      if (typeof _currentSound.remove === 'function') _currentSound.remove();
      // Fallback to expo-av if a Sound instance ever lands here
      if (typeof _currentSound.stopAsync === 'function') await _currentSound.stopAsync();
      if (typeof _currentSound.unloadAsync === 'function') await _currentSound.unloadAsync();
    } catch {}
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
      Animated.timing(pulseAnim, { toValue: 1.5, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
      Animated.timing(pulseAnim, { toValue: 1, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
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

// 1. Dynamic waveform with bars reacting to simulate audio
function SpeakingWaveform() {
  const NUM_BARS = 24;
  const bars = useRef(Array.from({ length: NUM_BARS }, () => new Animated.Value(0.15))).current;

  useEffect(() => {
    const timeouts = [];
    bars.forEach((bar, i) => {
      const randomDuration = () => 180 + Math.random() * 280;
      const randomHeight = () => 0.1 + Math.random() * 0.9;

      function animate() {
        Animated.timing(bar, {
          toValue: randomHeight(),
          duration: randomDuration(),
          useNativeDriver: false,
        }).start(() => animate());
      }
      const t = setTimeout(() => animate(), i * 30);
      timeouts.push(t);
    });

    return () => {
      timeouts.forEach(t => clearTimeout(t));
      bars.forEach(b => b.stopAnimation());
    };
  }, []);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, height: 60, justifyContent: 'center' }}>
      {bars.map((bar, i) => {
        // Create a dome shape: bars in center are taller
        const center = NUM_BARS / 2;
        const dist = Math.abs(i - center) / center;
        const maxH = 60 * (1 - dist * 0.6);
        return (
          <Animated.View key={i} style={{
            width: 3, borderRadius: 1.5, backgroundColor: ACCENT,
            height: maxH, transform: [{ scaleY: bar }],
            opacity: 0.8,
          }} />
        );
      })}
    </View>
  );
}

// 2. Listening - concentric ripples (ChatGPT style)
function ListeningRipples() {
  const NUM_RINGS = 3;
  const rings = useRef(Array.from({ length: NUM_RINGS }, () => ({
    scale: new Animated.Value(1),
    opacity: new Animated.Value(0.4),
  }))).current;

  useEffect(() => {
    const anims = rings.map((ring, i) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(i * 400),
          Animated.parallel([
            Animated.timing(ring.scale, { toValue: 2.2, duration: 1600, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
            Animated.timing(ring.opacity, { toValue: 0, duration: 1600, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
          ]),
          Animated.parallel([
            Animated.timing(ring.scale, { toValue: 1, duration: 0, useNativeDriver: false }),
            Animated.timing(ring.opacity, { toValue: 0.5, duration: 0, useNativeDriver: false }),
          ]),
        ])
      );
    });
    anims.forEach(a => a.start());
    return () => anims.forEach(a => a.stop());
  }, []);

  return (
    <View style={{ width: 200, height: 200, alignItems: 'center', justifyContent: 'center' }}>
      {rings.map((ring, i) => (
        <Animated.View key={i} style={{
          position: 'absolute', width: 100, height: 100, borderRadius: 50,
          borderWidth: 1.5, borderColor: ACCENT,
          opacity: ring.opacity, transform: [{ scale: ring.scale }],
        }} />
      ))}
    </View>
  );
}

// 3. Thinking - orbiting dots
function OrbitingDots() {
  const rotation = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(
      Animated.timing(rotation, { toValue: 1, duration: 2000, easing: Easing.linear, useNativeDriver: false })
    ).start();
    return () => rotation.stopAnimation();
  }, []);

  const spin = rotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <View style={{ width: 140, height: 140, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={{ position: 'absolute', width: 140, height: 140, transform: [{ rotate: spin }] }}>
        {[0, 120, 240].map((deg, i) => {
          const rad = (deg * Math.PI) / 180;
          const x = 60 * Math.cos(rad);
          const y = 60 * Math.sin(rad);
          return (
            <View key={i} style={{
              position: 'absolute', width: 8, height: 8, borderRadius: 4,
              backgroundColor: ['rgba(255,255,255,0.8)', 'rgba(255,255,255,0.5)', 'rgba(255,255,255,0.3)'][i],
              left: 66 + x, top: 66 + y,
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

// 5. Status text below orb
function VoiceStatusText({ voiceState, t }) {
  const label = voiceState === 'listening' ? t('one.voiceListening') :
    voiceState === 'thinking' ? t('one.thinking') :
    t('one.voiceSpeaking');

  return (
    <Text style={st.voiceStatusLabel}>{label}</Text>
  );
}

// 6. Voice orb - Siri-inspired multi-layer gradient blob with color shift.
// Three concentric rings counter-rotate + breathe at different tempos. The
// outer halo pulses color through a magenta→purple→teal palette, giving the
// "AI alive" feel without needing a video or LottieFiles.
function VoiceOrb({ voiceState }) {
  const scaleCore = useRef(new Animated.Value(1)).current;
  const scaleRing1 = useRef(new Animated.Value(1)).current;
  const scaleRing2 = useRef(new Animated.Value(1)).current;
  const glowAnim = useRef(new Animated.Value(0.2)).current;
  const rot1 = useRef(new Animated.Value(0)).current;
  const rot2 = useRef(new Animated.Value(0)).current;
  const hue = useRef(new Animated.Value(0)).current; // 0..3 — indexes palette

  useEffect(() => {
    // Continuous counter-rotation — runs across all states so the orb never
    // looks static. Ring 1 clockwise 18s, ring 2 counter 24s.
    Animated.loop(
      Animated.timing(rot1, { toValue: 1, duration: 18000, easing: Easing.linear, useNativeDriver: false })
    ).start();
    Animated.loop(
      Animated.timing(rot2, { toValue: 1, duration: 24000, easing: Easing.linear, useNativeDriver: false })
    ).start();
    // Slow color drift through the palette — 12s per cycle
    Animated.loop(
      Animated.sequence([
        Animated.timing(hue, { toValue: 1, duration: 4000, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        Animated.timing(hue, { toValue: 2, duration: 4000, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        Animated.timing(hue, { toValue: 3, duration: 4000, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        Animated.timing(hue, { toValue: 0, duration: 4000, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
      ])
    ).start();
  }, []);

  useEffect(() => {
    [scaleCore, scaleRing1, scaleRing2, glowAnim].forEach(a => a.stopAnimation());

    const breathe = (anim, toLo, toHi, dur) => Animated.loop(Animated.sequence([
      Animated.timing(anim, { toValue: toHi, duration: dur, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
      Animated.timing(anim, { toValue: toLo, duration: dur, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
    ]));

    if (voiceState === 'listening') {
      breathe(scaleCore, 1, 1.12, 1300).start();
      breathe(scaleRing1, 1, 1.22, 1700).start();
      breathe(scaleRing2, 1, 1.35, 2300).start();
      breathe(glowAnim, 0.25, 0.55, 1500).start();
    } else if (voiceState === 'thinking') {
      breathe(scaleCore, 0.94, 1.04, 700).start();
      breathe(scaleRing1, 0.98, 1.08, 850).start();
      breathe(scaleRing2, 1, 1.12, 950).start();
      breathe(glowAnim, 0.2, 0.4, 750).start();
    } else {
      // Speaking — rapid beat, like someone talking with energy
      breathe(scaleCore, 0.96, 1.1, 350).start();
      breathe(scaleRing1, 1, 1.2, 400).start();
      breathe(scaleRing2, 1, 1.28, 500).start();
      breathe(glowAnim, 0.3, 0.6, 380).start();
    }

    return () => [scaleCore, scaleRing1, scaleRing2, glowAnim].forEach(a => a.stopAnimation());
  }, [voiceState]);

  const rotDeg1 = rot1.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const rotDeg2 = rot2.interpolate({ inputRange: [0, 1], outputRange: ['360deg', '0deg'] });

  // Color palette shifts through magenta/purple/teal/violet. Each ring
  // samples a different stop on the palette so the colors harmonize instead
  // of clashing.
  const halo = hue.interpolate({
    inputRange: [0, 1, 2, 3],
    outputRange: ['#c026d3', '#7C3AED', '#06b6d4', '#a855f7'],
  });
  const core = hue.interpolate({
    inputRange: [0, 1, 2, 3],
    outputRange: ['#e879f9', '#a78bfa', '#22d3ee', '#c4b5fd'],
  });
  const ringOuter = hue.interpolate({
    inputRange: [0, 1, 2, 3],
    outputRange: ['#7C3AED', '#06b6d4', '#a855f7', '#c026d3'],
  });

  return (
    <View style={{ width: 260, height: 260, alignItems: 'center', justifyContent: 'center' }}>
      {/* Outer halo — large, low opacity, color-shifting */}
      <Animated.View style={{
        position: 'absolute', width: 260, height: 260, borderRadius: 130,
        backgroundColor: halo, opacity: glowAnim,
        transform: [{ scale: scaleRing2 }, { rotate: rotDeg2 }],
      }} />
      {/* Middle ring — hairline stroke rotating opposite way */}
      <Animated.View style={{
        position: 'absolute', width: 200, height: 200, borderRadius: 100,
        borderWidth: 2, borderColor: ringOuter,
        opacity: 0.5,
        transform: [{ scale: scaleRing1 }, { rotate: rotDeg1 }],
      }} />
      {/* Inner ring — subtle outline around core */}
      <Animated.View style={{
        position: 'absolute', width: 160, height: 160, borderRadius: 80,
        borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)',
        transform: [{ scale: scaleRing1 }, { rotate: rotDeg2 }],
      }} />
      {/* Core orb — solid, bright, shifts color slightly */}
      <Animated.View style={{
        width: 136, height: 136, borderRadius: 68,
        backgroundColor: core,
        transform: [{ scale: scaleCore }],
        ...(Platform.OS === 'web' ? {
          boxShadow: '0 0 80px rgba(167,139,250,0.55), 0 0 160px rgba(124,58,237,0.35), inset 0 0 40px rgba(255,255,255,0.22)',
        } : {
          shadowColor: '#a78bfa',
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: 0.7,
          shadowRadius: 40,
          elevation: 14,
        }),
      }} />
      {/* Specular highlight — makes it feel 3D */}
      <Animated.View style={{
        position: 'absolute', width: 50, height: 50, borderRadius: 25,
        top: 75, left: 95,
        backgroundColor: 'rgba(255,255,255,0.35)',
        transform: [{ scale: scaleCore }],
        opacity: 0.6,
      }} pointerEvents="none" />
    </View>
  );
}

function VoiceConversationOverlay({ isDark, colors, t, voiceState, transcript, onStop, onExit, onToggleMute, muted, onSwitchToText }) {
  // voiceState: 'listening' | 'thinking' | 'speaking'
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const silenceStart = useRef(Date.now());
  const [silenceHint, setSilenceHint] = useState('');

  // Call timer — format m:ss, starts at overlay mount.
  const startedAt = useRef(Date.now());
  const [elapsedStr, setElapsedStr] = useState('0:00');
  useEffect(() => {
    const tick = () => {
      const s = Math.floor((Date.now() - startedAt.current) / 1000);
      setElapsedStr(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, []);

  // Pulsing "LIVE" dot when active
  const livePulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(livePulse, { toValue: 0.35, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
      Animated.timing(livePulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 400, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, []);

  // Silence timeout hints
  useEffect(() => {
    if (voiceState === 'listening') {
      silenceStart.current = Date.now();
      setSilenceHint('');
      const iv = setInterval(() => {
        const elapsed = Date.now() - silenceStart.current;
        if (elapsed >= 30000) setSilenceHint(t('one.voiceSilenceLong') || 'Diga algo ou toque para parar');
        else if (elapsed >= 10000) setSilenceHint(t('one.voiceSilenceShort') || 'Estou ouvindo...');
      }, 2000);
      return () => clearInterval(iv);
    } else {
      setSilenceHint('');
    }
  }, [voiceState, t]);

  useEffect(() => {
    if (transcript) {
      silenceStart.current = Date.now();
      setSilenceHint('');
    }
  }, [transcript]);

  const handleStop = useCallback(() => {
    Animated.timing(fadeAnim, { toValue: 0, duration: 250, easing: Easing.in(Easing.cubic), useNativeDriver: false })
      .start(() => { if (onStop) onStop(); });
  }, [onStop, fadeAnim]);

  // Cores dinâmicas — branco minimalista (ChatGPT-style) em light mode,
  // quase-preto em dark. User pediu: "deixa fundo branco minimalista
  // igual chatgpt".
  const bg = isDark ? '#0d0d0d' : '#ffffff';
  const fg = isDark ? '#ffffff' : '#0d0d0d';
  const fgMuted = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(13,13,13,0.55)';
  const fgDim = isDark ? 'rgba(255,255,255,0.35)' : 'rgba(13,13,13,0.35)';
  const ctrlBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(13,13,13,0.05)';
  const ctrlBorder = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(13,13,13,0.10)';

  return (
    <Animated.View style={[st.voiceOverlay, { opacity: fadeAnim, backgroundColor: bg }]}>
      {/* Sem glow nem gradient — ChatGPT é flat clean. */}

      {/* Top bar: brand + timer */}
      <View style={st.voiceTopBar}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Animated.View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: '#ef4444', opacity: livePulse }} />
          <Text style={[st.voiceTopBarLive, { color: fgMuted, letterSpacing: 1 }]}>AO VIVO</Text>
        </View>
        <Text style={[st.voiceTopBarTitle, { color: fg }]}>Chatyy AI</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={[st.voiceTopBarTimer, { color: fgMuted }]}>{elapsedStr}</Text>
        </View>
      </View>

      <View style={st.voiceOverlayInner}>
        {/* Central orb */}
        <View style={st.voiceCenterAnim}>
          <VoiceOrb voiceState={voiceState} />
          {voiceState === 'listening' && <ListeningRipples />}
          {voiceState === 'thinking' && <OrbitingDots />}
          {voiceState === 'speaking' && (
            <View style={{ position: 'absolute', bottom: -40 }}>
              <SpeakingWaveform />
            </View>
          )}
        </View>

        {/* Status text */}
        <VoiceStatusText voiceState={voiceState} t={t} />

        {/* Transcript — card translúcido com cor de texto adaptativa */}
        {transcript ? (
          <View style={[st.voiceTranscriptCard, {
            backgroundColor: ctrlBg,
            borderColor: ctrlBorder,
            borderWidth: 1,
          }]}>
            <TypewriterText text={transcript} colors={{ text: fg }} />
          </View>
        ) : null}

        {/* Silence hint */}
        {silenceHint && !transcript ? (
          <Text style={[st.voiceSilenceHint, { color: fgDim }]}>{silenceHint}</Text>
        ) : null}
      </View>

      {/* Bottom control bar — branco/preto adaptativo */}
      <View style={st.voiceBottomBar}>
        {onToggleMute ? (
          <TouchableOpacity
            onPress={onToggleMute}
            activeOpacity={0.7}
            style={[st.voiceCtrlBtn, { backgroundColor: ctrlBg, borderColor: ctrlBorder, borderWidth: 1 }, muted && { backgroundColor: 'rgba(239,68,68,0.18)', borderColor: '#ef4444' }]}
            accessibilityLabel={muted ? (t('one.unmute') || 'Desmutar') : (t('one.mute') || 'Mutar')}
            accessibilityRole="button"
          >
            {muted ? <IconMicOff size={22} color="#ef4444" /> : <IconMic size={22} color={fg} />}
          </TouchableOpacity>
        ) : <View style={st.voiceCtrlBtn} />}

        <TouchableOpacity
          onPress={handleStop}
          activeOpacity={0.75}
          style={[st.voiceEndBtn, { backgroundColor: '#ef4444' }]}
          accessibilityLabel={t('one.voiceEnd') || 'Encerrar chamada'}
          accessibilityRole="button"
        >
          <IconX size={30} color="#fff" />
        </TouchableOpacity>

        {onSwitchToText ? (
          <TouchableOpacity
            onPress={onSwitchToText}
            activeOpacity={0.7}
            style={[st.voiceCtrlBtn, { backgroundColor: ctrlBg, borderColor: ctrlBorder, borderWidth: 1 }]}
            accessibilityLabel={t('one.switchToText') || 'Digitar'}
            accessibilityRole="button"
          >
            <IconEdit size={20} color={fg} />
          </TouchableOpacity>
        ) : <View style={st.voiceCtrlBtn} />}
      </View>
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
          Animated.timing(fadeAnim, { toValue: 0, duration: 300, useNativeDriver: false }),
          Animated.timing(slideAnim, { toValue: -20, duration: 300, useNativeDriver: false }),
        ]).start(() => {
          setIndex(prev => (prev + 1) % ROTATING_PHRASES.length);
          slideAnim.setValue(20);
          // Fade in + slide from below
          Animated.parallel([
            Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: false }),
            Animated.timing(slideAnim, { toValue: 0, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
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
          color: ACCENT,
          opacity: fadeAnim,
          transform: [{ translateY: slideAnim }],
        }]}
      >
        {phrase}
      </Animated.Text>
    </View>
  );
}

// ─── Pulsing logo ───

// Clean simple logo for empty state (not used currently but kept for reference)

// [#1239 2026-05-20] Header brand orb — sits next to the "One" title and pulses
// while the assistant is thinking. Same Chatyy purple as the rest of the AI
// surface, native driver so it doesn't tank perf on the JS thread.
function PulsingHeaderLogo({ active, isDark }) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0.85)).current;
  const loopRef = useRef(null);

  useEffect(() => {
    if (active) {
      const seq = Animated.loop(
        Animated.sequence([
          Animated.parallel([
            Animated.timing(scale, { toValue: 1.18, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
            Animated.timing(opacity, { toValue: 1, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          ]),
          Animated.parallel([
            Animated.timing(scale, { toValue: 1, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
            Animated.timing(opacity, { toValue: 0.55, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          ]),
        ])
      );
      loopRef.current = seq;
      seq.start();
    } else {
      try { loopRef.current?.stop?.(); } catch {}
      Animated.parallel([
        Animated.timing(scale, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start();
    }
    return () => { try { loopRef.current?.stop?.(); } catch {} };
  }, [active]);

  return (
    <Animated.View
      style={{
        width: 22,
        height: 22,
        borderRadius: 11,
        backgroundColor: ACCENT,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 8,
        opacity,
        transform: [{ scale }],
        shadowColor: ACCENT,
        shadowOpacity: active ? 0.55 : 0,
        shadowRadius: active ? 10 : 0,
        shadowOffset: { width: 0, height: 0 },
      }}
    >
      <IconSparkles size={12} color="#fff" />
    </Animated.View>
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

// ─── Quick Actions Bar (above input, visible when chat has messages) ───

function QuickActionsBar({ onSend, colors, isDark, t }) {
  const [workflows, setWorkflows] = useState([]);
  useEffect(() => {
    (async () => {
      try {
        const AS = require('@react-native-async-storage/async-storage').default;
        const raw = await AS.getItem('one_workflows');
        if (raw) setWorkflows(JSON.parse(raw) || []);
      } catch {}
    })();
  }, []);
  const defaults = [
    { key: 'daily', label: t('one.quickDailySummary'), icon: IconMail, msg: t('one.quickDailySummaryMsg') },
    { key: 'events', label: t('one.quickUpcomingEvents'), icon: IconCalendar, msg: t('one.quickUpcomingEventsMsg') },
    { key: 'unread', label: t('one.quickUnreadMessages'), icon: IconMessageSquare, msg: t('one.quickUnreadMessagesMsg') },
    { key: 'photo', label: t('one.quickAnalyzePhoto'), icon: IconCamera, msg: t('one.quickAnalyzePhotoMsg') },
  ];
  const deleteWorkflow = async (key) => {
    try {
      const next = workflows.filter(w => w.key !== key);
      setWorkflows(next);
      const AS = require('@react-native-async-storage/async-storage').default;
      await AS.setItem('one_workflows', JSON.stringify(next));
    } catch {}
  };
  const actions = [
    ...workflows.map(w => ({ key: w.key, label: w.label, icon: IconSparkles, msg: w.msg, custom: true })),
    ...defaults,
  ];

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={st.quickActionsContent}
      style={st.quickActionsBar}
    >
      {actions.map((a) => {
        const Icon = a.icon;
        return (
          <TouchableOpacity
            key={a.key}
            style={[st.quickActionChip, {
              backgroundColor: a.custom
                ? (isDark ? 'rgba(124,58,237,0.18)' : 'rgba(124,58,237,0.10)')
                : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.03)'),
              ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'all 0.15s ease' } : {}),
            }]}
            onPress={() => onSend(a.msg)}
            onLongPress={a.custom ? () => {
              try {
                const { Alert } = require('react-native');
                Alert.alert(a.label, t('one.workflowDeleteConfirm') || 'Remover este workflow?', [
                  { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
                  { text: t('common.delete') || 'Remover', style: 'destructive', onPress: () => deleteWorkflow(a.key) },
                ]);
              } catch {}
            } : undefined}
            activeOpacity={0.7}
          >
            <Icon size={13} color={a.custom ? '#7C3AED' : (isDark ? '#8696a0' : '#667781')} />
            <Text style={[st.quickActionText, { color: a.custom ? '#7C3AED' : (isDark ? '#8696a0' : '#667781') }]} numberOfLines={1}>{a.label}</Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
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
          <CodeBlockWithCopy key={`code-${codeKey++}`} code={codeLines.join('\n')} isDark={isDark} />
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

    // Headers (###, ##, #) — the model sometimes slips these in despite
    // the system-prompt ban. Render as bold lines sized by depth so the
    // bubble doesn't show literal "###" characters.
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      const depth = headerMatch[1].length;
      const fontSize = depth === 1 ? 18 : depth === 2 ? 16 : 15;
      elements.push(
        <Text
          key={`h-${li}`}
          style={[st.msgText, { color: textColor, fontSize, fontWeight: '700', marginTop: depth <= 2 ? 4 : 2 }]}
          selectable
        >
          {fmtInline(headerMatch[2], textColor, isDark)}
        </Text>
      );
      continue;
    }

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
      <CodeBlockWithCopy key={`code-${codeKey}`} code={codeLines.join('\n')} isDark={isDark} />
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
      return <Text key={i} style={[st.inlineCode, { backgroundColor: isDark ? '#3a3a3a' : '#f0f0f0' }]}>{part.slice(1, -1)}</Text>;
    if (/^https?:\/\//.test(part))
      return <Text key={i} style={{ color: ACCENT, textDecorationLine: 'underline' }} onPress={() => Linking.openURL(part)}>{part}</Text>;
    return part;
  });
}

// ─── Typing dots indicator (clean 3-dot animation) ───

function TypingDots({ isDark }) {
  const dot1 = useRef(new Animated.Value(0.3)).current;
  const dot2 = useRef(new Animated.Value(0.3)).current;
  const dot3 = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const animateDot = (dot, delay) => Animated.loop(Animated.sequence([
      Animated.delay(delay),
      Animated.timing(dot, { toValue: 1, duration: 400, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
      Animated.timing(dot, { toValue: 0.3, duration: 400, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
    ]));
    const a1 = animateDot(dot1, 0);
    const a2 = animateDot(dot2, 200);
    const a3 = animateDot(dot3, 400);
    a1.start(); a2.start(); a3.start();
    return () => { a1.stop(); a2.stop(); a3.stop(); };
  }, []);
  const dotStyle = { width: 7, height: 7, borderRadius: 3.5, backgroundColor: isDark ? '#888' : '#999' };
  return (
    <View style={{ flexDirection: 'row', gap: 5, alignItems: 'center', paddingVertical: 4 }}>
      <Animated.View style={[dotStyle, { opacity: dot1 }]} />
      <Animated.View style={[dotStyle, { opacity: dot2 }]} />
      <Animated.View style={[dotStyle, { opacity: dot3 }]} />
    </View>
  );
}

function ThinkingIndicator({ colors, isDark, t, toolStatus }) {
  return (
    <View style={st.aiBubbleRow}>
      <View style={st.aiBubbleAvatarWrap}>
        <View style={st.aiBubbleAvatar}>
          <Text style={st.aiBubbleAvatarText}>O</Text>
        </View>
      </View>
      <View style={[st.aiBubble, { backgroundColor: isDark ? '#1f2c34' : '#fff' }]}>
        {toolStatus ? (
          <View style={[st.toolChip, {
            backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
            borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
            marginBottom: 6,
            alignSelf: 'flex-start',
          }]}>
            <ActivityIndicator size={10} color={ACCENT_DARK} />
            <Text style={[st.toolChipText, { color: isDark ? '#aaa' : '#888' }]}>{toolStatus}</Text>
          </View>
        ) : null}
        <TypingDots isDark={isDark} />
        <View style={[st.aiBubbleTail, { borderRightColor: isDark ? '#1f2c34' : '#fff' }]} />
      </View>
    </View>
  );
}

// ─── Tool action label mapping ───

function getToolLabel(action, t) {
  if (!action) return '';
  const type = action.type || action.tool || action.name || '';
  const map = {
    'read_emails': t('one.toolSearchingEmails'),
    'search_emails': t('one.toolSearchingEmails'),
    'read_calendar': t('one.toolReadingCalendar'),
    'create_calendar_event': t('one.toolCreatingEvent'),
    'send_email': t('one.toolSendingEmail'),
    'send_chat': t('one.toolSendingMessage'),
    'read_chat': t('one.toolReadingChat'),
    'search_contacts': t('one.toolSearchingContacts'),
    'read_files': t('one.toolSearchingFiles'),
  };
  return map[type] || t('one.toolWorking');
}

// ─── Code block with copy button ───

function CodeBlockWithCopy({ code, isDark }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    // Why: previously copy worked only on web. Native users had no way to copy code
    // out of an AI answer — which is the #1 use case for code blocks. Now we use
    // expo-clipboard everywhere with a graceful fallback.
    try {
      if (Platform.OS === 'web' && navigator?.clipboard) {
        await navigator.clipboard.writeText(code);
      } else {
        const Clipboard = require('expo-clipboard');
        await Clipboard.setStringAsync(code);
      }
      setCopied(true);
      try {
        const Haptics = require('expo-haptics');
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } catch {}
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }, [code]);

  return (
    <View style={st.codeBlockWrap}>
      <TouchableOpacity onPress={handleCopy} style={st.codeCopyBtn} activeOpacity={0.7} accessibilityLabel="Copy code">
        <Text style={st.codeCopyBtnText}>{copied ? '✓ Copied' : 'Copy'}</Text>
      </TouchableOpacity>
      <View style={[st.codeBlock, isDark && { backgroundColor: '#1a1a1a' }]}>
        <Text style={st.codeText} selectable>{code}</Text>
      </View>
    </View>
  );
}

// ─── Message row (WhatsApp chat bubble style) ───

// Blinking cursor for streaming messages
function StreamingCursor({ isDark }) {
  const blink = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.loop(Animated.sequence([
      Animated.timing(blink, { toValue: 0, duration: 500, useNativeDriver: false }),
      Animated.timing(blink, { toValue: 1, duration: 500, useNativeDriver: false }),
    ])).start();
  }, [blink]);
  return (
    <Animated.Text style={{ opacity: blink, color: ACCENT, fontWeight: 'bold', fontSize: 16 }}>
      {'▋'}
    </Animated.Text>
  );
}

// Three-dot typing indicator shown while a tool is executing.
// Wave animation: each dot rises ~6px with spring physics, staggered. Reads
// as more lively than the old opacity-only pulse. Opacity still toggles so
// the dot fades while it falls — the combined effect mirrors iMessage /
// Telegram's "typing…" indicator more closely.
function ToolTypingIndicator({ toolName, isDark, t }) {
  const dot1 = useRef(new Animated.Value(0)).current;
  const dot2 = useRef(new Animated.Value(0)).current;
  const dot3 = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const wave = (v, delay) => Animated.loop(Animated.sequence([
      Animated.delay(delay),
      Animated.spring(v, { toValue: 1, tension: 220, friction: 8, useNativeDriver: false }),
      Animated.spring(v, { toValue: 0, tension: 220, friction: 10, useNativeDriver: false }),
      Animated.delay(360),
    ]));
    const a1 = wave(dot1, 0); const a2 = wave(dot2, 140); const a3 = wave(dot3, 280);
    a1.start(); a2.start(); a3.start();
    return () => { a1.stop(); a2.stop(); a3.stop(); };
  }, [dot1, dot2, dot3]);
  const dotBase = { width: 7, height: 7, borderRadius: 4, backgroundColor: isDark ? '#aaa' : '#666', marginHorizontal: 2 };
  const animStyle = (v) => ({
    opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
    transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -6] }) }],
  });
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 2 }}>
      <Animated.View style={[dotBase, animStyle(dot1)]} />
      <Animated.View style={[dotBase, animStyle(dot2)]} />
      <Animated.View style={[dotBase, animStyle(dot3)]} />
      {toolName ? (
        <Text style={{ marginLeft: 8, fontSize: 11, color: isDark ? '#8696a0' : '#9ba5ab' }}>
          {toolName.replace(/_/g, ' ')}
        </Text>
      ) : null}
    </View>
  );
}

// ChatGPT-style streaming dots inline with the last AI paragraph.
// Three small dots that fade in/out one after the other.
function InlineStreamingDots({ isDark }) {
  const d1 = useRef(new Animated.Value(0.3)).current;
  const d2 = useRef(new Animated.Value(0.3)).current;
  const d3 = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const anim = (v, delay) => Animated.loop(Animated.sequence([
      Animated.delay(delay),
      Animated.timing(v, { toValue: 1, duration: 380, useNativeDriver: false }),
      Animated.timing(v, { toValue: 0.3, duration: 380, useNativeDriver: false }),
    ]));
    const a1 = anim(d1, 0); const a2 = anim(d2, 160); const a3 = anim(d3, 320);
    a1.start(); a2.start(); a3.start();
    return () => { a1.stop(); a2.stop(); a3.stop(); };
  }, []);
  const c = isDark ? '#9ca3af' : '#6b7280';
  const dot = { width: 5, height: 5, borderRadius: 2.5, backgroundColor: c, marginHorizontal: 2 };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
      <Animated.View style={[dot, { opacity: d1 }]} />
      <Animated.View style={[dot, { opacity: d2 }]} />
      <Animated.View style={[dot, { opacity: d3 }]} />
    </View>
  );
}

// ── Brand-gradient send button (44px circle, purple gradient + SVG send icon).
// Replaces the flat ACCENT-filled 36px button. The gradient (top-left light
// purple → bottom-right ACCENT_DARK) plus a soft 1px inner highlight gives the
// button a premium "polished pebble" feel matching ChatGPT 4.5/Anthropic UI.
function BrandSendCircle({ size = 44, isDark }) {
  const r = size / 2;
  return (
    <Svg width={size} height={size}>
      <Defs>
        <SvgLinearGradient id="brandSendGrad" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#A78BFA" stopOpacity="1" />
          <Stop offset="0.6" stopColor={ACCENT} stopOpacity="1" />
          <Stop offset="1" stopColor={ACCENT_DARK} stopOpacity="1" />
        </SvgLinearGradient>
      </Defs>
      <SvgCircle cx={r} cy={r} r={r} fill="url(#brandSendGrad)" />
      {/* Subtle inner highlight — adds a soft glass edge so the circle doesn't
          read as a flat disk. Skipped in dark mode where the contrast already
          pops against the canvas. */}
      {!isDark && <SvgCircle cx={r} cy={r} r={r - 0.5} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth={1} />}
      {/* Send arrow — paper-plane style, centered. Stroke 2.2 for crispness. */}
      <SvgPath
        d={`M ${r - 7} ${r + 1} L ${r + 7} ${r - 6} L ${r + 1} ${r + 7} L ${r - 1} ${r + 1} Z`}
        fill="#fff"
      />
    </Svg>
  );
}

// ── Empty-state sparkle illustration (large 96px SVG: one big sparkle +
// two small accents). Replaces the previous solid circle + IconSparkles
// duo with a more illustrative mark so the empty canvas feels considered.
function SparkleIllustration({ size = 96, isDark }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 96 96">
      <Defs>
        <SvgLinearGradient id="sparkBigGrad" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#C4B5FD" stopOpacity="1" />
          <Stop offset="0.55" stopColor={ACCENT} stopOpacity="1" />
          <Stop offset="1" stopColor={ACCENT_DARK} stopOpacity="1" />
        </SvgLinearGradient>
        <SvgLinearGradient id="sparkSmallGrad" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#A78BFA" stopOpacity="1" />
          <Stop offset="1" stopColor={ACCENT} stopOpacity="1" />
        </SvgLinearGradient>
      </Defs>
      {/* Soft halo behind main sparkle */}
      <SvgCircle cx="48" cy="48" r="34" fill={isDark ? 'rgba(124,58,237,0.16)' : 'rgba(124,58,237,0.10)'} />
      {/* Big sparkle (4-point star) centered */}
      <SvgPath
        d="M48 18 L52 44 L78 48 L52 52 L48 78 L44 52 L18 48 L44 44 Z"
        fill="url(#sparkBigGrad)"
      />
      {/* Small sparkle top-right */}
      <SvgPath
        d="M76 16 L78 24 L86 26 L78 28 L76 36 L74 28 L66 26 L74 24 Z"
        fill="url(#sparkSmallGrad)"
        opacity={0.85}
      />
      {/* Tiny sparkle bottom-left */}
      <SvgPath
        d="M16 70 L17.5 75 L22.5 76.5 L17.5 78 L16 83 L14.5 78 L9.5 76.5 L14.5 75 Z"
        fill="url(#sparkSmallGrad)"
        opacity={0.7}
      />
    </Svg>
  );
}

// ── Suggested-prompt chip (horizontal scroll on the empty state). Brand
// outline 1px, transparent fill, press scale 0.96 with spring. Built as a
// small inline component so each chip owns its own animated value (avoids
// a shared scale flickering between presses).
function PromptChip({ label, sub, onPress, isDark }) {
  const scale = useRef(new Animated.Value(1)).current;
  const handleIn = () => Animated.spring(scale, { toValue: 0.96, tension: 320, friction: 14, useNativeDriver: true }).start();
  const handleOut = () => Animated.spring(scale, { toValue: 1, tension: 280, friction: 12, useNativeDriver: true }).start();
  return (
    <TouchableOpacity
      onPress={onPress}
      onPressIn={handleIn}
      onPressOut={handleOut}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Animated.View style={[st.promptChip, {
        borderColor: isDark ? 'rgba(167,139,250,0.55)' : 'rgba(124,58,237,0.45)',
        backgroundColor: isDark ? 'rgba(124,58,237,0.10)' : 'rgba(124,58,237,0.06)',
        transform: [{ scale }],
      }]}>
        <Text style={[st.promptChipLabel, { color: isDark ? '#ECECEC' : '#0D0D0D' }]} numberOfLines={1}>{label}</Text>
        {sub ? (
          <Text style={[st.promptChipSub, { color: isDark ? '#9CA3AF' : '#6B7280' }]} numberOfLines={1}>{sub}</Text>
        ) : null}
      </Animated.View>
    </TouchableOpacity>
  );
}

function MessageRow({ item, colors, isDark, onSpeak, speakingId, t, onCopy, onRegenerate, isLastAI, onLongPressAI }) {
  const isUser = item.role === 'user';
  const isSpeaking = speakingId === item.id;
  // Entrance: fadeIn + slideUp 8px. The slide gives the row a subtle "rise"
  // motion that ChatGPT/Claude apps use to make new messages feel placed,
  // not just popped in. Both animated values share the same timing so we
  // don't drift between opacity and position.
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(8)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
      Animated.timing(slideAnim, { toValue: 0, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
    ]).start();
  }, []);

  const isStreaming = !!item._streaming;
  const isToolPending = !!item._toolPending;
  const toolActions = item.actions || [];

  // ── User: subtle gray pill, right-aligned, no avatar (ChatGPT 2026 style)
  if (isUser) {
    return (
      <Animated.View style={[st.userRow, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
        <View style={[st.userPill, {
          backgroundColor: isDark ? '#2A2A2A' : '#F1F1F4',
        }]}>
          {item.imageUri && (
            <Image source={{ uri: item.imageUri }} style={{ width: 220, height: 220, borderRadius: 14, marginBottom: 8 }} resizeMode="cover" />
          )}
          <Text style={[st.userText, { color: isDark ? '#ECECEC' : '#0D0D0D' }]} selectable>{item.content}</Text>
        </View>
      </Animated.View>
    );
  }

  // ── AI: no bubble, plain left-aligned text. Small "One" chip+avatar header
  // sits above the first paragraph. Long-press opens the context sheet.
  return (
    <Animated.View style={[st.aiRow, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
      {/* Header chip — small gray pill with avatar + "One" label */}
      <TouchableOpacity
        activeOpacity={0.85}
        delayLongPress={320}
        onLongPress={() => { if (item.content && !isStreaming) onLongPressAI?.(item); }}
        style={st.aiHeaderRow}
      >
        {/* WAVE 46 (2026-05-21): real app icon avatar w/ blinking eyes (random 4-8s).
            Sized 18px to match the existing aiHeaderAvatar footprint. */}
        <ChatyyOneAvatar size={18} />
        <Text style={[st.aiHeaderLabel, { color: isDark ? '#9CA3AF' : '#6B7280' }]}>One</Text>
      </TouchableOpacity>

      {/* Tool chips only while AI is mid-flight. After the response lands we hide
          them — otherwise an unknown action type falls back to "Processando..."
          and lingers under a finished reply, looking like the AI is still working. */}
      {toolActions.length > 0 && (isStreaming || isToolPending) && (
        <View style={st.toolChipsRow}>
          {toolActions.slice(0, 3).map((action, i) => {
            const type = action.type || action.tool || action.name || '';
            const iconMap = {
              'read_emails': IconMail, 'search_emails': IconMail,
              'read_calendar': IconCalendar, 'create_calendar_event': IconCalendar,
              'send_email': IconSend, 'send_chat': IconMessageSquare,
              'read_chat': IconMessageSquare, 'search_contacts': IconUsers,
              'read_files': IconFolder,
            };
            const ToolIcon = iconMap[type] || IconZap;
            return (
              <View key={i} style={[st.toolChip, {
                backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
              }]}>
                <ToolIcon size={11} color={isDark ? '#aaa' : '#666'} />
                <Text style={[st.toolChipText, { color: isDark ? '#aaa' : '#666' }]}>
                  {getToolLabel(action, t)}
                </Text>
              </View>
            );
          })}
        </View>
      )}

      {/* Body — plain text, NO bubble background. Long-press opens context sheet. */}
      <TouchableOpacity
        activeOpacity={1}
        delayLongPress={320}
        onLongPress={() => { if (item.content && !isStreaming) onLongPressAI?.(item); }}
      >
        {isToolPending && !item.content ? (
          <ToolTypingIndicator toolName={item._toolName} isDark={isDark} t={t} />
        ) : (
          <View style={st.aiBody}>
            {/* Hide the trailing <followups>...</followups> marker the model
                appends — it's surfaced as chips below the last AI message
                (handled in the parent). */}
            {parseMarkdown(extractFollowups(item.content).text, isDark ? '#ECECEC' : '#0D0D0D', isDark)}
            {/* Streaming dots (•••) inline at end during generation. */}
            {isStreaming && !isToolPending && <InlineStreamingDots isDark={isDark} />}
          </View>
        )}
        {isToolPending && !!item.content && (
          <ToolTypingIndicator toolName={item._toolName} isDark={isDark} t={t} />
        )}
      </TouchableOpacity>

      {/* WhatsApp opt-in button (kept — feature still surfaces from AI replies) */}
      {item.content && (item.content.includes('wa.me') || (item.content.includes('WhatsApp') && (item.content.includes('conecte') || item.content.includes('conectar') || item.content.includes('opt') || item.content.includes('connect')))) && (
        <TouchableOpacity
          style={[st.waOptInBtn, { backgroundColor: ACCENT, marginTop: 10 }]}
          onPress={() => {
            const url = 'https://wa.me/12093093434?text=Oi!%20Quero%20receber%20lembretes%20do%20Chatyy.';
            if (Platform.OS === 'web') {
              window.open(url, '_blank');
            } else {
              Linking.openURL(url).catch(() => {});
            }
          }}
        >
          <Text style={st.waOptInBtnText}>{t('one.whatsappConnectBtn')}</Text>
        </TouchableOpacity>
      )}

      {/* Inline action row — copy / read aloud / regenerate (only on most recent AI message) */}
      {item.content && !isStreaming && (
        <View style={st.aiActionsRow}>
          {onCopy && (
            <TouchableOpacity
              onPress={() => onCopy(item)}
              hitSlop={6}
              style={st.aiActionBtn}
              accessibilityLabel={t?.('common.copy') || 'Copy'}
            >
              <IconCopy size={14} color={isDark ? '#9CA3AF' : '#6B7280'} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={() => onSpeak?.(item)}
            hitSlop={6}
            style={st.aiActionBtn}
            accessibilityLabel={isSpeaking ? 'Stop reading' : 'Read aloud'}
          >
            {isSpeaking ? (
              <IconVolumeX size={14} color={ACCENT_DARK} />
            ) : (
              <IconVolume2 size={14} color={isDark ? '#9CA3AF' : '#6B7280'} />
            )}
          </TouchableOpacity>
          {isLastAI && onRegenerate && (
            <TouchableOpacity
              onPress={() => onRegenerate(item)}
              hitSlop={6}
              style={st.aiActionBtn}
              accessibilityLabel={t?.('one.regenerate') || 'Regenerate'}
            >
              <IconRepeat size={14} color={isDark ? '#9CA3AF' : '#6B7280'} />
            </TouchableOpacity>
          )}
        </View>
      )}
    </Animated.View>
  );
}

// ─── Model picker pill (top center) + bottom sheet ───
const MODEL_OPTIONS = [
  { id: 'gpt-5.5', label: 'GPT-5.5', sub: 'one.modelSubFast' },
  { id: 'gpt-5.5-pro', label: 'GPT-5.5 Pro', sub: 'one.modelSubPro' },
  { id: 'claude-opus-4.7', label: 'Claude Opus 4.7', sub: 'one.modelSubReason' },
];

function ModelPickerPill({ isDark, onPress, modelLabel }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={[st.modelPill, {
        backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
      }]}
      accessibilityLabel="Pick model"
    >
      <Text style={[st.modelPillText, { color: isDark ? '#9CA3AF' : '#6B7280' }]}>
        {`One · ${modelLabel}`}
      </Text>
      <IconChevronDown size={13} color={isDark ? '#9CA3AF' : '#6B7280'} />
    </TouchableOpacity>
  );
}

function ModelPickerSheet({ visible, onClose, isDark, t, currentModelId, onPick }) {
  if (!visible) return null;
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} style={st.sheetDim} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={[st.sheet, { backgroundColor: isDark ? '#1F1F22' : '#fff' }]}>
          <View style={st.sheetGrabber} />
          <Text style={[st.sheetTitle, { color: isDark ? '#ECECEC' : '#0D0D0D' }]}>
            {t('one.pickModel') || 'Choose model'}
          </Text>
          {MODEL_OPTIONS.map((m) => {
            const active = m.id === currentModelId;
            return (
              <TouchableOpacity
                key={m.id}
                onPress={() => { onPick(m); onClose(); }}
                activeOpacity={0.7}
                style={[st.sheetItem, active && { backgroundColor: isDark ? 'rgba(124,58,237,0.15)' : 'rgba(124,58,237,0.08)' }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[st.sheetItemTitle, { color: isDark ? '#ECECEC' : '#0D0D0D' }]}>{m.label}</Text>
                  <Text style={[st.sheetItemSub, { color: isDark ? '#9CA3AF' : '#6B7280' }]}>
                    {t(m.sub) || ''}
                  </Text>
                </View>
                {active ? <Text style={{ color: ACCENT_DARK, fontSize: 18 }}>✓</Text> : null}
              </TouchableOpacity>
            );
          })}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

// Long-press sheet for AI message: Copy / Regenerate / Bad response.
function MessageContextSheet({ visible, onClose, isDark, t, onCopy, onRegenerate, onBadResponse, canRegenerate }) {
  if (!visible) return null;
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} style={st.sheetDim} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={[st.sheet, { backgroundColor: isDark ? '#1F1F22' : '#fff' }]}>
          <View style={st.sheetGrabber} />
          <TouchableOpacity onPress={() => { onCopy?.(); onClose(); }} activeOpacity={0.7} style={st.sheetItem}>
            <IconCopy size={18} color={isDark ? '#ECECEC' : '#0D0D0D'} />
            <Text style={[st.sheetItemTitle, { color: isDark ? '#ECECEC' : '#0D0D0D', marginLeft: 12 }]}>
              {t('common.copy') || 'Copy'}
            </Text>
          </TouchableOpacity>
          {canRegenerate && (
            <TouchableOpacity onPress={() => { onRegenerate?.(); onClose(); }} activeOpacity={0.7} style={st.sheetItem}>
              <IconRepeat size={18} color={isDark ? '#ECECEC' : '#0D0D0D'} />
              <Text style={[st.sheetItemTitle, { color: isDark ? '#ECECEC' : '#0D0D0D', marginLeft: 12 }]}>
                {t('one.regenerate') || 'Regenerate'}
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => { onBadResponse?.(); onClose(); }} activeOpacity={0.7} style={st.sheetItem}>
            <IconThumbsDown size={18} color="#ef4444" />
            <Text style={[st.sheetItemTitle, { color: '#ef4444', marginLeft: 12 }]}>
              {t('one.badResponse') || 'Bad response'}
            </Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

// ─── History sidebar ───

function HistorySidebar({ visible, onClose, conversations, onSelect, currentId, colors, isDark, t, insets, onDelete, onClearAll }) {
  if (!visible) return null;
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <View style={st.sidebarOverlay}>
        <TouchableOpacity style={st.sidebarDim} activeOpacity={1} onPress={onClose} />
        <View style={[st.sidebar, {
          backgroundColor: isDark ? '#171717' : '#fff',
          paddingTop: insets.top + 8,
        }]}>
          <View style={st.sidebarHeader}>
            <Text style={[st.sidebarTitle, { color: isDark ? '#e5e5e5' : '#1a1a1a' }]}>{t('one.history')}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {/* Botão "Limpar tudo" — apaga todo o histórico do user.
                  Confirma via Alert antes de chamar oneHistoryDelete clearAll. */}
              {conversations.length > 0 && (
                <TouchableOpacity
                  onPress={onClearAll}
                  hitSlop={10}
                  style={{ paddingHorizontal: 8, paddingVertical: 6, borderRadius: 8 }}
                  accessibilityLabel={t('one.clearHistory') || 'Limpar histórico'}
                >
                  <Text style={{ fontSize: 12, color: '#ef4444', fontWeight: '600' }}>
                    {t('one.clearAll') || 'Limpar'}
                  </Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={onClose} hitSlop={12}>
                <IconX size={20} color={isDark ? '#888' : '#999'} />
              </TouchableOpacity>
            </View>
          </View>
          <ScrollView style={st.sidebarList} showsVerticalScrollIndicator={false}>
            {conversations.length === 0 && (
              <Text style={[st.sidebarEmpty, { color: isDark ? '#666' : '#aaa' }]}>{t('one.noConversations')}</Text>
            )}
            {conversations.map((c) => {
              const active = c.id === currentId;
              return (
                <View key={c.id} style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <TouchableOpacity
                    style={[st.sidebarItem, { flex: 1 }, active && { backgroundColor: isDark ? '#2f2f2f' : '#f0f0f0' }]}
                    onPress={() => { onSelect(c); onClose(); }}
                    activeOpacity={0.7}
                  >
                    <Text style={[st.sidebarItemText, { color: active ? (isDark ? '#fff' : '#1a1a1a') : (isDark ? '#ccc' : '#555') }]} numberOfLines={1}>
                      {c.title || `#${c.id}`}
                    </Text>
                  </TouchableOpacity>
                  {/* Tap no lixinho → delete só essa conversa */}
                  <TouchableOpacity
                    onPress={() => onDelete?.(c)}
                    hitSlop={10}
                    style={{ paddingHorizontal: 12, paddingVertical: 10 }}
                    accessibilityLabel={t('common.delete') || 'Deletar'}
                  >
                    <IconTrash size={16} color={isDark ? '#666' : '#999'} />
                  </TouchableOpacity>
                </View>
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
  const params = useLocalSearchParams();

  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [attachedImage, setAttachedImage] = useState(null); // { uri, base64, mimeType }
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  // Suggested follow-up chips for the most-recent AI reply. Rendered as a
  // SmartReplyChips strip under the last assistant message — tap = autosend.
  // Cleared whenever the user types, picks an image, switches threads, or
  // sends a new prompt (so stale chips never linger).
  const [lastFollowups, setLastFollowups] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  // ChatGPT-style model picker pill at top center.
  const [selectedModel, setSelectedModel] = useState(MODEL_OPTIONS[0]);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  // Long-press AI message context sheet (Copy / Regenerate / Bad response).
  const [ctxSheetItem, setCtxSheetItem] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [isListening, setIsListening] = useState(false);
  const [speakingId, setSpeakingId] = useState(null);
  const [autoRead, setAutoRead] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false); // Siri-like voice conversation mode
  const [voiceState, setVoiceState] = useState('listening'); // 'listening' | 'thinking' | 'speaking'
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [inputFocused, setInputFocused] = useState(false);
  const flatListRef = useRef(null);
  const recognitionRef = useRef(null);
  const audioRecordingRef = useRef(null); // expo-audio recorder for Whisper auto-detect path
  const vadTimerRef = useRef(null); // polling interval for voice activity detection
  const vadStateRef = useRef({ startedAt: 0, lastVoiceAt: 0 });
  const speakCheckRef = useRef(null);
  const voiceModeRef = useRef(false); // ref to avoid stale closures
  const isMountedRef = useRef(true); // guard against setState after unmount
  const voiceStartTimerRef = useRef(null); // timer for delayed voice mode start
  const voiceRecTimerRef = useRef(null); // 8s native auto-stop — must be cancellable
  const voiceSessionRef = useRef(0); // monotonic session id for race-safe restarts
  const aiAbortRef = useRef(null); // AbortController for in-flight AI requests
  const realtimeRef = useRef(null); // OneRealtimeSession — OpenAI Realtime WS client (web)
  const emptyListenRef = useRef(0); // consecutive empty transcriptions in voice mode (guard vs mic-stuck-on)

  // [bug-fix #one-ai-2h, 2026-05-15] Auto-fresh conversation after idle window.
  //
  // Previous incarnation (#one-ai-1h) only updated `lastActiveAt` on *send*
  // and only on `useFocusEffect`, so:
  //   1. AI replies didn't bump the timestamp — if you sent a question, walked
  //      away while it was streaming, and came back 70min later, focus-effect
  //      saw the send timestamp (>60min ago) and cleared — but the auto-restore
  //      gate (`initialLoaded`) had already fired, so the cleared `conversationId`
  //      was the only signal the next send had. Result: 50/50 whether the send
  //      attached to the dead convo (server side `conversation_id` was still
  //      passed in via stale state) or made a new one.
  //   2. If the user just lurked re-reading the thread, the timestamp never
  //      bumped, so reset triggered even though the user *was* engaged.
  //   3. Cached `one_messages_<id>` were never invalidated on reset, so on the
  //      NEXT visit `loadConversations(true)` re-hydrated old messages from
  //      cache before realising the convo had aged out.
  //
  // Fixes here:
  //   - Threshold bumped back to **2h** (matches #944 ship note).
  //   - Single `resetIfStale()` helper used from focus-effect AND from the
  //     auto-restore path so behaviour is identical.
  //   - Resets clear `one_messages_<convId>` from cache so a cold reopen
  //     doesn't flash the old thread for 100ms before the network call.
  //   - `lastActiveAt` is bumped on EVERY user send AND on every AI response
  //     receipt — see `handleAIResponse` + `sendMessage`.
  //   - On reset, AsyncStorage is rewritten with `Date.now()` so the next
  //     reset only fires after another full idle window.
  const ONE_RESET_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours
  const lastActiveAtRef = useRef(Date.now());

  // Reusable across focus-effect + auto-restore. Returns true if it actually
  // performed a reset (caller can short-circuit subsequent restore steps).
  const resetIfStale = useCallback(async () => {
    try {
      const key = `oneAi.lastActiveAt.${user?.email || 'anon'}`;
      const persisted = await getCached(key);
      const now = Date.now();
      // No persisted stamp means "first ever open on this device for this
      // user" — treat as fresh, just plant the stamp.
      if (typeof persisted !== 'number' || persisted <= 0) {
        setCache(key, now, 86400000 * 30).catch(() => {});
        lastActiveAtRef.current = now;
        return false;
      }
      const since = now - persisted;
      if (since >= ONE_RESET_WINDOW_MS) {
        // Wipe cached messages for the convo we're about to abandon so the
        // next mount can't flash them from cache.
        try {
          const cid = conversationId;
          if (cid) setCache('one_messages_' + cid, [], 1).catch(() => {});
        } catch {}
        try { aiAbortRef.current?.abort?.(); } catch {}
        setMessages([]);
        setConversationId(null);
        setCache(key, now, 86400000 * 30).catch(() => {});
        lastActiveAtRef.current = now;
        return true;
      }
      // Within window — restore stamp ref so in-session sends compute idle
      // correctly even if the user closes/reopens mid-thread.
      lastActiveAtRef.current = persisted;
      return false;
    } catch {
      return false;
    }
  }, [user?.email, conversationId]);

  // Bump persistence on any activity (user send OR AI reply received).
  // Exposed as a ref-stable callback for safety across closures.
  const bumpActivity = useCallback(() => {
    try {
      lastActiveAtRef.current = Date.now();
      const key = `oneAi.lastActiveAt.${user?.email || 'anon'}`;
      setCache(key, Date.now(), 86400000 * 30).catch(() => {});
    } catch {}
  }, [user?.email]);

  useFocusEffect(useCallback(() => {
    resetIfStale();
    return () => {
      try { aiAbortRef.current?.abort?.(); } catch {}
    };
  }, [resetIfStale]));

  const firstName = user?.name?.split(' ')[0] || user?.email?.split('@')[0] || '';

  const [initialLoaded, setInitialLoaded] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  // Load conversations and auto-restore the most recent one
  const loadConversations = useCallback(async (autoRestore = false) => {
    // Show cached conversations INSTANTLY (don't wait for network)
    const cached = await getCached('one_conversations');
    let convos = [];
    if (cached) {
      if (cached?.data?.conversations) convos = cached.data.conversations;
      else if (Array.isArray(cached?.data)) convos = cached.data;
      else if (Array.isArray(cached)) convos = cached;
      if (convos.length > 0) {
        setConversations(convos);
        setInitialLoading(false); // Show UI immediately with cached data
      }
    }
    try {
      const res = await api.oneHistory();
      convos = [];
      if (res?.success && res.data?.conversations) convos = res.data.conversations;
      else if (res?.success && Array.isArray(res.data)) convos = res.data;
      setConversations(convos);
      setCache('one_conversations', res, 7776000000).catch(() => {});

      // Auto-restore if the last conversation message is < 2h old (matches
      // ONE_RESET_WINDOW_MS in the focus-effect above). Two independent gates
      // would let a "fresh" focus-effect re-hydrate a thread the auto-restore
      // would have rejected. Keep them in sync.
      //
      // [bug-fix #one-ai-2h, 2026-05-18] PG returns `updated_at` as TEXT (the
      // schema uses `TEXT NOT NULL DEFAULT NOW()` — see migrate-sqlite-to-pg.php).
      // Depending on PG session config + driver, the string can land here as
      // `"2026-05-17 14:30:45"` (no TZ — JS engine-dependent parsing, often
      // local-time) or as `"2026-05-17 14:30:45.123456+00"` (parsed reliably).
      // Worse, if the field is somehow missing/null, `new Date(undefined)` →
      // `Invalid Date` → `.getTime()` → `NaN`. The old check
      // `if (msAgo >= ONE_RESET_WINDOW_MS) return` then evaluated `NaN >= ...`
      // which is ALWAYS `false`, falling through to `setConversationId(last.id)`
      // and re-hydrating the OLD thread (task #944 regression — the gate
      // failed OPEN on parse error instead of failing SAFE to "fresh").
      // Now we fail SAFE: any non-finite/negative/exceed-window value starts
      // a fresh conversation. Also cross-check with the local `lastActiveAt`
      // ref bumped on every send/reply — if local activity is older than 2h,
      // we ALWAYS start fresh regardless of what the server timestamp says.
      if (autoRestore && convos.length > 0 && !conversationId && messages.length === 0) {
        const last = convos[0]; // most recent
        const lastUpdated = new Date(last.updated_at || last.created_at);
        const lastUpdatedMs = lastUpdated.getTime();
        const msAgo = Date.now() - lastUpdatedMs;
        // Local activity stamp — wins over server timestamp on disagreement.
        // If we have no local stamp (first ever open or a fresh device) we
        // fall back to the server gate; otherwise both must agree on "fresh".
        const localActiveMs = lastActiveAtRef.current;
        const localSince = Date.now() - localActiveMs;
        const isStaleByServer = !Number.isFinite(msAgo) || msAgo < 0 || msAgo >= ONE_RESET_WINDOW_MS;
        const isStaleByLocal = Number.isFinite(localSince) && localSince >= ONE_RESET_WINDOW_MS;
        if (isStaleByServer || isStaleByLocal) {
          // Server-side convo is stale too — make sure local timestamp matches
          // so future focuses don't oscillate between "restore" and "reset".
          try {
            const key = `oneAi.lastActiveAt.${user?.email || 'anon'}`;
            setCache(key, Date.now(), 86400000 * 30).catch(() => {});
          } catch {}
          // Also drop the cached messages blob for this convo so a future
          // cold-open can't flash the abandoned thread before the gate runs.
          try {
            if (last?.id) setCache('one_messages_' + last.id, [], 1).catch(() => {});
          } catch {}
          return; // older than window OR parse failed → start fresh
        }
        setConversationId(last.id);
        // Show cached messages instantly
        const cachedMsgs = await getCached('one_messages_' + last.id);
        if (cachedMsgs && cachedMsgs.length > 0) {
          setMessages(cachedMsgs);
          setInitialLoading(false);
        }
        try {
          const hRes = await api.oneHistory(last.id);
          const msgs = hRes?.data?.messages || (Array.isArray(hRes?.data) ? hRes.data : []);
          if (msgs.length > 0) {
            const mapped = msgs.map((m, i) => ({
              id: `h-${i}`, role: m.role, content: m.content,
              actions: (() => { try { return m.tool_calls ? (JSON.parse(m.tool_calls || '[]') || []) : []; } catch { return []; } })(),
              userName: firstName,
            }));
            setMessages(mapped);
            setCache('one_messages_' + last.id, mapped, 7776000000).catch(() => {});
          }
        } catch {}
      }
    } catch {} finally {
      setInitialLoading(false);
    }
  }, [conversationId, messages.length, firstName, user?.email]);

  useEffect(() => {
    if (!initialLoaded) {
      setInitialLoaded(true);
      // Auto-restore with 60-min window (2026-05-13 user request) —
      // resume same conversation when returning to One within 60 min of
      // the last message; otherwise open fresh in a new thread. Cached
      // messages render instantly via getCached() before network lands.
      loadConversations(true);
    }
  }, [initialLoaded]);

  // Proactive daily briefing disabled: user feedback said the auto-fired
  // "me dá um briefing rápido" prompt felt intrusive on every cold open.
  // If we want to bring it back, gate it behind a settings toggle.

  const handleSendRef = useRef(null);

  // Handle file analysis intent from Cloud (?intent={...}&prefill=...)
  const fileIntentHandledRef = useRef(false);
  useEffect(() => {
    if (fileIntentHandledRef.current) return;
    if (!params?.intent) return;
    let intent = null;
    try { intent = JSON.parse(params.intent); } catch {}
    if (!intent) return;

    // analyze_doc — content was fetched client-side from docs.db, inline it directly.
    if (intent.type === 'analyze_doc') {
      fileIntentHandledRef.current = true;
      const prompt = params.prefill || `Analise esse documento: ${intent.title || 'documento'}`;
      const body = intent.content
        ? `${prompt}\n\n--- Conteúdo do documento "${intent.title || 'documento'}" ---\n${intent.content}\n--- fim ---`
        : `${prompt}\n\n(O conteúdo do documento não pôde ser carregado.)`;
      setInputText(body);
      return;
    }

    if (intent.type !== 'analyze_file') return;
    fileIntentHandledRef.current = true;
    // Detect image either by MIME type OR by file extension (drive items often have empty mime_type)
    const lowerName = (intent.file_name || '').toLowerCase();
    const isImageByExt = /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(lowerName);
    const isImageByMime = !!intent.mime_type && intent.mime_type.startsWith('image/');
    const isImage = isImageByExt || isImageByMime;

    if (isImage) {
      // Server-side path: tell oneChat to read the image directly from disk via drive_file_id.
      // Avoids cross-domain CORS when fetching from the CDN subdomain.
      const prompt = params.prefill || `Analise a imagem ${intent.file_name}`;
      setInputText(prompt);
      // Show a preview thumbnail in the bubble; base64 stays null because the backend will load it.
      setAttachedImage({
        uri: intent.file_url,
        mimeType: intent.mime_type || 'image/jpeg',
        base64: null,
        driveFileId: intent.file_id || null,
      });
    } else {
      // For docs/PDFs/etc., pass the file_id explicitly so the AI uses read_drive_file directly.
      const prompt = params.prefill || `Analise esse arquivo: ${intent.file_name}`;
      const fileIdHint = intent.file_id
        ? `\n\n[Use a tool read_drive_file com file_id=${intent.file_id} para ler o conteudo. Nome: ${intent.file_name}.]`
        : '';
      setInputText(prompt + fileIdHint);
    }
  }, [params?.intent, params?.prefill]);

  const loadConversation = useCallback(async (conv) => {
    setConversationId(conv.id);
    setMessages([]);
    setLastFollowups([]); // Chips belong to the just-finished thread, not the switched-to one.
    setLoading(true);
    try {
      const res = await api.oneHistory(conv.id);
      const msgs = res?.data?.messages || (Array.isArray(res?.data) ? res.data : []);
      setMessages(msgs.map((m, i) => ({
        id: `h-${i}`, role: m.role, content: m.content,
        actions: (() => { try { return m.tool_calls ? (JSON.parse(m.tool_calls || '[]') || []) : []; } catch { return []; } })(),
        userName: firstName,
      })));
    } catch {} finally { setLoading(false); }
  }, [firstName]);

  // Unified "pick image" handler: shows a native action sheet with
  // Camera / Gallery / Cancel. Previously only the gallery path was wired
  // up — users had no way to take a photo on the fly.
  const pickFromLibrary = useCallback(async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') return;
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.8,
        base64: true,
        allowsEditing: false,
      });
      if (!result.canceled && result.assets?.[0]) {
        const asset = result.assets[0];
        const mimeType = asset.mimeType || (asset.uri?.endsWith('.png') ? 'image/png' : 'image/jpeg');
        setAttachedImage({ uri: asset.uri, base64: asset.base64, mimeType });
      }
    } catch (e) {
      console.warn('Image library error:', e);
    }
  }, []);

  const takePhoto = useCallback(async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') return;
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        quality: 0.8,
        base64: true,
        allowsEditing: false,
      });
      if (!result.canceled && result.assets?.[0]) {
        const asset = result.assets[0];
        const mimeType = asset.mimeType || 'image/jpeg';
        setAttachedImage({ uri: asset.uri, base64: asset.base64, mimeType });
      }
    } catch (e) {
      console.warn('Camera error:', e);
    }
  }, []);

  const pickImage = useCallback(() => {
    // ActionSheet on iOS (native); Alert buttons on Android. On WEB, RN-Web's
    // Alert.alert is a no-op (literally returns nothing) — the "+" button used
    // to silently do nothing for web users. Web path now opens an <input
    // type="file"> picker directly via a hidden DOM element, which supports
    // both gallery and camera capture on mobile browsers.
    const options = [
      { text: t('one.takePhoto') || 'Tirar foto', onPress: takePhoto },
      { text: t('one.chooseFromLibrary') || 'Escolher da galeria', onPress: pickFromLibrary },
      { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
    ];

    if (Platform.OS === 'ios') {
      try {
        const { ActionSheetIOS } = require('react-native');
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options: options.map(o => o.text),
            cancelButtonIndex: 2,
          },
          (idx) => { options[idx]?.onPress?.(); }
        );
        return;
      } catch {}
    }

    if (Platform.OS === 'web') {
      // Web: use a native <input type=file> — Alert.alert is no-op on
      // react-native-web so the old fallback below never showed the picker.
      try {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*,application/pdf,.doc,.docx,.txt,.csv,.xls,.xlsx';
        input.style.display = 'none';
        input.onchange = (ev) => {
          const file = ev?.target?.files?.[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result || '';
            // result = "data:image/png;base64,xxxx" — split off the base64 part
            const comma = String(result).indexOf(',');
            const base64 = comma >= 0 ? String(result).slice(comma + 1) : '';
            const mimeType = file.type || 'image/jpeg';
            // Only attach images as visual context; for other files, embed text-style hint.
            if (mimeType.startsWith('image/')) {
              setAttachedImage({ uri: result, base64, mimeType });
            } else {
              // Document: append a note to the input so the user knows
              // they can ask One about it; full doc parsing is server-side
              // territory and not wired yet.
              setInputText(prev => (prev ? prev + '\n' : '') + `[${t('one.attachedFile') || 'arquivo'}: ${file.name}]`);
            }
          };
          reader.readAsDataURL(file);
          try { document.body.removeChild(input); } catch {}
        };
        document.body.appendChild(input);
        input.click();
        return;
      } catch (e) {
        console.warn('[one] web file picker failed:', e);
        // Last-resort: try gallery via ImagePicker (works on some mobile web)
        pickFromLibrary();
        return;
      }
    }

    // Android: use Alert 3-button fallback (native modal works there).
    try {
      const { Alert } = require('react-native');
      Alert.alert(
        t('one.attachPhoto') || 'Anexar foto',
        '',
        options
      );
    } catch {
      // Final fallback: just open the gallery.
      pickFromLibrary();
    }
  }, [takePhoto, pickFromLibrary, t]);

  // ─── Shared post-response handler (used by both streaming and fallback paths) ───
  const handleAIResponse = useCallback((responseText, actions, aiMsgId) => {
    // [bug-fix #one-ai-2h] Bump idle timer on every AI reply too — without
    // this, a long-thinking question (>2h via tools/streaming) would idle out
    // its own reply by the time it lands.
    try { bumpActivity(); } catch {}
    // Auto-execute actions from AI. Two shapes come in:
    //   Legacy PHP: { action: 'start_call', phone: '...' }
    //   New Rust one-api: { tool: 'send_email', action: 'send_email', params: {...} }
    for (const act of (actions || [])) {
      // Rust shape normalized — pull tool name from either 'tool' or 'action' field
      const kind = act?.tool || act?.action;
      const params = act?.params || act;

      if (kind === 'start_call') {
        if (params.contact_email) {
          // New Rust: navigate to /call with the contact
          const video = params.video ? '1' : '0';
          const callId = `one_${Date.now()}`;
          const contactEmail = params.contact_email;
          const contactName = contactEmail.split('@')[0];
          // [2026-05-20 restore foreground gate] voipNative routes to JS
          // /call.js when foreground, native CallActivity/CallViewController
          // when backgrounded. onWebFallback covers both the web path and
          // the foreground gate.
          if (Platform.OS === 'ios' || Platform.OS === 'android') {
            (async () => {
              try {
                const voipNative = require('../services/voipNative');
                // [CALL-TRACE 2026-05-21 ROUND3] Step 1c/12 — /one (Chatyy
                // AI) action handler. start_call action arrives from the
                // Rust one-api / legacy PHP. Logging the params + resolved
                // contactEmail catches AI hallucinated empty email.
                try {
                  console.log('[CALL-TRACE][1c/12] one.js start_call action', {
                    contactEmail, contactName, video: !!params.video, callId, ts: Date.now(),
                  });
                } catch {}
                if (!contactEmail || !String(contactEmail).trim()) {
                  try {
                    console.warn('[CALL-TRACE][1c/12][FAIL] empty contactEmail from AI action', { params });
                  } catch {}
                  try {
                    const { Alert } = require('react-native');
                    Alert.alert(
                      (typeof t === 'function' && t('common.error')) || 'Erro',
                      (typeof t === 'function' && t('chat.calleeNotIdentified')) || 'Não foi possível identificar o destinatário',
                    );
                  } catch {}
                  return;
                }
                const { native } = await voipNative.startOutgoingCall({
                  calleeEmail: contactEmail,
                  calleeName: contactName,
                  isVideo: !!params.video,
                  callId,
                  onWebFallback: (cid) => {
                    // [WAVE 117A] Web only — mobile uses 100% native call screen.
                    if (Platform.OS === 'web') {
                      router.push(`/call?contactEmail=${encodeURIComponent(contactEmail)}&contactName=${encodeURIComponent(contactName)}&isVideo=${video}&isCaller=1&callId=${cid}`);
                    }
                  },
                });
                if (!native) {
                  // onWebFallback already handled the navigation. No-op here.
                }
              } catch (e) {
                console.warn('[one start_call] startOutgoingCall failed:', e);
                // [WAVE 117A] Mobile = 100% native. Web falls through to /call.js.
                if (Platform.OS === 'web') {
                  router.push(`/call?contactEmail=${encodeURIComponent(contactEmail)}&contactName=${encodeURIComponent(contactName)}&isVideo=${video}&isCaller=1&callId=${callId}`);
                }
              }
            })();
          } else {
            router.push(`/call?contactEmail=${encodeURIComponent(contactEmail)}&contactName=${encodeURIComponent(contactName)}&isVideo=${video}&isCaller=1&callId=${callId}`);
          }
        } else if (params.phone) {
          if (Platform.OS === 'web') {
            router.push(`/chat?tab=calls&dial=${encodeURIComponent(params.phone)}`);
          } else {
            try {
              const sipModule = require('../services/sipCall');
              if (sipModule?.startSipCall) sipModule.startSipCall(params.phone);
              else { const { Linking } = require('react-native'); Linking.openURL(`tel:${params.phone}`).catch(() => {}); }
            } catch { const { Linking } = require('react-native'); Linking.openURL(`tel:${params.phone}`).catch(() => {}); }
          }
        }
      }
      else if (kind === 'send_email' && params.to) {
        const query = new URLSearchParams({
          to: params.to,
          subject: params.subject || '',
          body: params.body || '',
        }).toString();
        router.push(`/compose?${query}`);
      }
      else if (kind === 'create_event') {
        const q = new URLSearchParams({
          title: params.title || '',
          start_at: params.start_at || '',
          end_at: params.end_at || '',
          location: params.location || '',
          description: params.description || '',
        }).toString();
        router.push(`/event-detail?new=1&${q}`);
      }
      else if (kind === 'search_drive' && params.query) {
        router.push(`/files?q=${encodeURIComponent(params.query)}`);
      }
      else if (kind === 'create_note') {
        const q = new URLSearchParams({
          title: params.title || '',
          content: params.content || '',
          new: '1',
        }).toString();
        router.push(`/notes-edit?${q}`);
      }
      else if (kind === 'search_contacts' && params.query) {
        router.push(`/contacts?q=${encodeURIComponent(params.query)}`);
      }
      else if (kind === 'read_inbox') {
        router.push(`/inbox`);
      }
    }
    // Voice mode: speak sentence-by-sentence, then auto-listen
    if (voiceModeRef.current) {
      setVoiceState('speaking');
      setSpeakingId(aiMsgId);
      const lang = detectTextLang(responseText, locale);
      haptic('light');
      speakSentenceBysentence(responseText, lang, () => {
        setSpeakingId(null);
        if (voiceModeRef.current) {
          setTimeout(() => {
            if (voiceModeRef.current && isMountedRef.current) {
              playReactivationSound();
              haptic('light');
              setVoiceState('listening');
              startListeningForVoiceMode();
            }
          }, 500);
        }
      });
    }
  }, [locale, router, bumpActivity]);

  // ─── Fallback: non-streaming path ────────────────────────────────────────────
  const sendMessageFallback = useCallback(async (msg, currentImage, aiMsgId) => {
    try {
      const result = await api.oneChat(
        msg || (currentImage ? 'Analise esta imagem. Se for um recibo/nota fiscal/conta, extraia os dados e me pergunte se quero criar uma planilha.' : ''),
        conversationId,
        currentImage ? currentImage.base64 : null,
        currentImage ? currentImage.mimeType : null,
        currentImage ? currentImage.driveFileId : null,
      );
      if (result?.success && result.data) {
        if (result.data.conversation_id) setConversationId(result.data.conversation_id);
        const responseTextRaw = result.data.response || t('one.errorProcess');
        // Backend already strips <followups> for the JSON path, but parse
        // defensively in case an old PHP-FPM worker still has the old code
        // cached.
        const { text: responseText, followups: parsedFollowups } = extractFollowups(responseTextRaw);
        const followupsFromMeta = Array.isArray(result.data.suggested_followups)
          ? result.data.suggested_followups.slice(0, 3)
          : [];
        const finalFollowups = followupsFromMeta.length ? followupsFromMeta : parsedFollowups;
        if (finalFollowups.length > 0) setLastFollowups(finalFollowups);
        setMessages(prev => [...prev, {
          id: aiMsgId, role: 'assistant',
          content: responseText,
          actions: result.data.actions || [],
        }]);
        handleAIResponse(responseText, result.data.actions || [], aiMsgId);
      } else {
        const errText = result?.message || t('one.errorProcess');
        setMessages(prev => [...prev, { id: aiMsgId, role: 'assistant', content: errText }]);
        if (voiceModeRef.current) {
          setVoiceState('speaking');
          haptic('light');
          const lang = detectTextLang(errText, locale);
          speakSentenceBysentence(errText, lang, () => {
            if (voiceModeRef.current) {
              setTimeout(() => {
                if (voiceModeRef.current) { playReactivationSound(); haptic('light'); setVoiceState('listening'); startListeningForVoiceMode(); }
              }, 500);
            }
          });
        }
      }
    } catch (e) {
      // [bug-fix 2026-05-18] Suffix the actual exception message so users +
      // QA see *why* it failed (network, parse, abort, etc.) instead of a
      // dead-end "Não consegui conectar com o servidor.".
      const base = t('one.error');
      const detail = (e && (e.message || String(e))) || '';
      const errText = detail ? base + '\n\n_' + detail + '_' : base;
      setMessages(prev => [...prev, { id: aiMsgId, role: 'assistant', content: errText }]);
      if (voiceModeRef.current) {
        setVoiceState('speaking');
        haptic('light');
        const lang = getTTSLang(locale);
        // Speak only the base message — the technical detail is for the UI
        // bubble, not the TTS read-out.
        speakSentenceBysentence(base, lang, () => {
          if (voiceModeRef.current) {
            setTimeout(() => {
              if (voiceModeRef.current) { playReactivationSound(); haptic('light'); setVoiceState('listening'); startListeningForVoiceMode(); }
            }, 500);
          }
        });
      }
    }
  }, [conversationId, t, locale, handleAIResponse]);

  const sendMessage = useCallback(async (text, opts = {}) => {
    const msg = (text || inputText).trim();
    if (!msg && !attachedImage) return;
    if (loading) return;
    // [bug-fix #one-ai-2h] Mark activity so the focus-effect idle reset
    // only kicks in after a real idle window. Persisted via AsyncStorage so
    // it survives app kill — without this, refreshing kept stale convo.
    bumpActivity();
    // /save <label>: <command> — persists a workflow chip instead of
    // sending. Lets power-users build personal macros in one line.
    if (msg.startsWith('/save ') || msg.startsWith('/salvar ')) {
      const rest = msg.replace(/^\/(save|salvar)\s+/, '');
      const sep = rest.indexOf(':');
      if (sep > 0) {
        const label = rest.slice(0, sep).trim();
        const cmd = rest.slice(sep + 1).trim();
        if (label && cmd) {
          try {
            const AS = require('@react-native-async-storage/async-storage').default;
            const raw = await AS.getItem('one_workflows');
            const list = raw ? (JSON.parse(raw) || []) : [];
            list.unshift({ key: 'wf_' + Date.now(), label, msg: cmd });
            await AS.setItem('one_workflows', JSON.stringify(list.slice(0, 20)));
            setInputText('');
            setMessages(prev => [...prev, { id: 'wfs-' + Date.now(), role: 'assistant', content: (t('one.workflowSaved') || '✨ Workflow salvo') + ': **' + label + '**\n\n' + (t('one.workflowHint') || 'Agora aparece como botão roxo no topo. Longo toque remove.'), actions: [], userName: firstName }]);
          } catch {}
          return;
        }
      }
    }
    const currentImage = attachedImage;
    if (!opts.proactive) setInputText('');
    setVoiceTranscript('');
    setAttachedImage(null);
    // Sending a new prompt invalidates the prior reply's chips. New ones
    // arrive via meta.suggested_followups when this turn lands.
    setLastFollowups([]);
    const displayMsg = msg || (currentImage ? t('one.analyzingImage') : '');
    setMessages(prev => [...prev, {
      id: Date.now(), role: 'user', content: displayMsg, userName: firstName,
      ...(currentImage ? { imageUri: currentImage.uri } : {}),
    }]);
    setLoading(true);
    if (voiceModeRef.current) setVoiceState('thinking');

    const aiMsgId = Date.now() + 1;
    const effectiveMsg = msg || (currentImage ? 'Analise esta imagem. Se for um recibo/nota fiscal/conta, extraia os dados e me pergunte se quero criar uma planilha.' : '');

    // ── Try SSE streaming first; fall back to oneChat on any error ─────────────
    // [WAVE 43A 2026-05-21] Native (RN 0.83 + Hermes) now supports
    // text streaming via `reactNative.textStreaming: true` in fetch opts (set
    // in api.oneChatStream). Without streaming on native the user waited
    // 6-10s for the full reply ("a one ta lenta"). With streaming the first
    // token shows in ~700ms. The onError path still falls back to oneChat()
    // so any platform that doesn't honor the flag degrades cleanly.
    const canStream = typeof fetch !== 'undefined';

    if (canStream) {
      // Place a placeholder message so the UI shows content as it streams
      const placeholder = { id: aiMsgId, role: 'assistant', content: '', actions: [], _streaming: true };
      setMessages(prev => [...prev, placeholder]);

      let streamedText = '';
      let streamActions = [];
      let activeToolName = null;
      let streamConvId = conversationId;
      let streamFailed = false;
      // Typing indicator state — shown while a tool is executing (no text yet for that round)
      let toolPending = false;

      const abortCtrl = api.oneChatStream(
        effectiveMsg,
        conversationId,
        {
          onDelta: (delta) => {
            if (!isMountedRef.current) return;
            streamedText += delta;
            // Clear tool pending indicator once text starts flowing
            toolPending = false;
            setMessages(prev => prev.map(m =>
              m.id === aiMsgId ? { ...m, content: streamedText, _streaming: true, _toolPending: false } : m
            ));
          },
          onToolCall: (name /*, args*/) => {
            if (!isMountedRef.current) return;
            activeToolName = name;
            toolPending = true;
            // Show typing indicator with tool name hint while waiting for result
            setMessages(prev => prev.map(m =>
              m.id === aiMsgId ? { ...m, _streaming: true, _toolPending: true, _toolName: name } : m
            ));
          },
          onToolResult: (name, result) => {
            if (!isMountedRef.current) return;
            activeToolName = null;
            toolPending = false;
            streamActions.push({ tool: name, result });
            setMessages(prev => prev.map(m =>
              m.id === aiMsgId ? { ...m, _streaming: true, _toolPending: false, _toolName: null } : m
            ));
          },
          onMeta: (meta) => {
            if (!isMountedRef.current) return;
            if (meta.conversation_id) {
              streamConvId = meta.conversation_id;
              setConversationId(meta.conversation_id);
            }
            if (meta.actions) streamActions = meta.actions;
            // Suggested follow-ups arrive in the final meta event — surface
            // them as chips under the last AI reply.
            if (Array.isArray(meta.suggested_followups) && meta.suggested_followups.length > 0) {
              setLastFollowups(meta.suggested_followups.slice(0, 3));
            }
          },
          onDone: () => {
            if (!isMountedRef.current) return;
            const finalRaw = streamedText || t('one.errorProcess');
            // Fallback parse: if the meta event somehow didn't carry chips
            // (older server, partial flush) we recover them from the marker
            // still embedded in the streamed text.
            const { text: cleanText, followups: parsedFollowups } = extractFollowups(finalRaw);
            if (parsedFollowups.length > 0) setLastFollowups(parsedFollowups);
            setMessages(prev => prev.map(m =>
              m.id === aiMsgId
                ? { ...m, content: cleanText, actions: streamActions, _streaming: false, _toolPending: false, _toolName: null }
                : m
            ));
            setLoading(false);
            loadConversations(false);
            handleAIResponse(cleanText, streamActions, aiMsgId);
          },
          onError: (errMsg) => {
            if (!isMountedRef.current) return;
            streamFailed = true;
            // Remove placeholder and fall back to non-streaming
            setMessages(prev => prev.filter(m => m.id !== aiMsgId));
            sendMessageFallback(effectiveMsg, currentImage, aiMsgId).finally(() => {
              setLoading(false);
              loadConversations(false);
            });
          },
        },
        currentImage ? currentImage.base64 : null,
        currentImage ? currentImage.mimeType : null,
        currentImage ? currentImage.driveFileId : null,
      );

      // Store abort controller so the cancel button works
      aiAbortRef.current = abortCtrl;
      // Note: setLoading(false) and loadConversations are called inside onDone/onError
      return;
    }

    // ── Non-streaming fallback (native or no ReadableStream) ───────────────────
    try {
      await sendMessageFallback(effectiveMsg, currentImage, aiMsgId);
    } finally {
      setLoading(false);
      loadConversations(false);
    }
  }, [inputText, attachedImage, loading, conversationId, t, firstName, loadConversations, locale, sendMessageFallback, handleAIResponse, bumpActivity]);
  // Wire the ref AFTER sendMessage is defined so the proactive briefing
  // effect up above can trigger a send without causing a TDZ cycle.
  // Deferred to useEffect to avoid TDZ in minified bundle (sendMessage
  // may reference variables declared later in the component scope).
  useEffect(() => { handleSendRef.current = sendMessage; }, [sendMessage]);

  const newChat = useCallback(() => {
    setMessages([]); setConversationId(null); setLastFollowups([]); loadConversations(false);
  }, [loadConversations]);

  // ─── Voice Input (Speech-to-Text) ───

  const startListening = useCallback(async () => {
    setAutoRead(true); // Enable auto-read when using voice
    if (Platform.OS !== 'web') {
      // Native: record audio and transcribe via server-side Whisper (auto language detect).
      // expo-audio v55 changed the API — we now use the AudioModule
      // `AudioRecorder` with an explicit recording config instead of the
      // opaque `RecordingPresets.HIGH_QUALITY` preset which silently
      // dropped fields (including sample rate) on iOS, resulting in a
      // nearly-empty audio file that Whisper couldn't understand.
      try {
        const expoAudio = require('expo-audio');
        const perm = await expoAudio.requestRecordingPermissionsAsync();
        if (!perm.granted) {
          if (typeof alert !== 'undefined') alert(t('one.voiceNotSupported'));
          return;
        }
        await expoAudio.setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
          interruptionMode: 'mixWithOthers',
        });
        const AudioMod = require('expo-audio/build/AudioModule').default;
        // Explicit Whisper-friendly config: 16kHz mono m4a. Groq Whisper
        // prefers ≥ 16kHz. High-quality preset on iOS was giving us 8kHz
        // telephony-grade audio that transcribed poorly.
        const WHISPER_CONFIG = {
          extension: '.m4a',
          sampleRate: 44100,
          numberOfChannels: 1,
          bitRate: 128000,
          isMeteringEnabled: true,
          ios: {
            extension: '.m4a',
            outputFormat: 'MPEG4AAC',
            audioQuality: 96, // HIGH
            sampleRate: 44100,
            numberOfChannels: 1,
            bitRate: 128000,
            linearPCMBitDepth: 16,
            linearPCMIsBigEndian: false,
            linearPCMIsFloat: false,
          },
          android: {
            extension: '.m4a',
            outputFormat: 'mpeg4',
            audioEncoder: 'aac',
            sampleRate: 44100,
            numberOfChannels: 1,
            bitRate: 128000,
          },
          web: {
            mimeType: 'audio/webm',
            bitsPerSecond: 128000,
          },
        };
        const rec = new AudioMod.AudioRecorder(WHISPER_CONFIG);
        await rec.prepareToRecordAsync();
        // ⭐ Triple-redundant auto-stop at 12 seconds:
        //   1. Native forDuration (AVAudioRecorder.record(forDuration:))
        //   2. JS setTimeout (guaranteed fire even if native stops silently)
        //   3. JS VAD polling loop with its own drift/silence detection
        // If any of the three fire, the mic stops. User doesn't have to tap
        // the mic button a second time.
        rec.record({ forDuration: 12 });
        audioRecordingRef.current = rec;
        setIsListening(true);
        if (__DEV__) console.log('[one] Recording started — 12s hard cap');

        // JS hard stop — fires stopListening() even if the native forDuration
        // path silently fails to call our event handler. This is the guarantee.
        setTimeout(() => {
          if (audioRecordingRef.current === rec) {
            if (__DEV__) console.log('[one] JS hard-stop at 12s');
            stopListening();
          }
        }, 12000);

        // ─── Voice Activity Detection (tries to stop BEFORE the 12s cap) ─
        // Two strategies running in parallel:
        //   1. `recorder.currentTime` drift — if it stops advancing for
        //      ≥ 300ms, iOS has probably paused the session silently.
        //   2. Metering poll (best effort). On builds where it works,
        //      cuts recording ~1.4s after user stops speaking.
        const SILENCE_DB = -45;     // louder room → more forgiving
        const SILENCE_MS = 1400;
        const MIN_SPEECH_MS = 700;
        const t0 = Date.now();
        vadStateRef.current = { startedAt: t0, lastVoiceAt: t0 };
        let lastTime = 0;
        let lastTimeChangeAt = t0;
        if (vadTimerRef.current) { clearInterval(vadTimerRef.current); vadTimerRef.current = null; }
        vadTimerRef.current = setInterval(() => {
          const r = audioRecordingRef.current;
          if (!r) { if (vadTimerRef.current) { clearInterval(vadTimerRef.current); vadTimerRef.current = null; } return; }
          const now = Date.now();
          const elapsed = now - vadStateRef.current.startedAt;

          // Strategy A: metering (when available)
          let level = null;
          try {
            const status = typeof r.getStatus === 'function' ? r.getStatus() : null;
            if (status && typeof status.metering === 'number') level = status.metering;
            else if (typeof r.metering === 'number') level = r.metering;
          } catch {}
          if (level != null) {
            if (level > SILENCE_DB) {
              vadStateRef.current.lastVoiceAt = now;
            } else if (elapsed > MIN_SPEECH_MS && (now - vadStateRef.current.lastVoiceAt) > SILENCE_MS) {
              if (__DEV__) console.log('[one] VAD metering silence → stop');
              stopListening();
              return;
            }
          }

          // Strategy B: currentTime drift detection. iOS ticks this ~10x/s
          // while audio is flowing. If it freezes for > 300ms, something
          // went wrong or encoder paused.
          try {
            const ct = typeof r.currentTime === 'number' ? r.currentTime : 0;
            if (ct > lastTime) { lastTime = ct; lastTimeChangeAt = now; }
            if (elapsed > 2000 && (now - lastTimeChangeAt) > 1800) {
              if (__DEV__) console.log('[one] VAD currentTime frozen → stop');
              stopListening();
              return;
            }
          } catch {}
        }, 150);
      } catch (e) {
        console.warn('[one] Audio recording error:', e?.message);
        setIsListening(false);
        if (typeof alert !== 'undefined') alert((t('one.micError') || 'Erro ao iniciar microfone') + ': ' + (e?.message || t('common.unknown') || 'desconhecido'));
      }
      return;
    }
    // Web: use MediaRecorder + Whisper (auto language detect). The
    // browser's SpeechRecognition API forces a `lang` hint which locks
    // the detected language to the UI locale — that was the "fala em
    // portugues mas transcreve em ingles no computador" bug. MediaRecorder
    // + OpenAI Whisper auto-detects language from the audio itself.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : (MediaRecorder.isTypeSupported?.('audio/webm') ? 'audio/webm' : 'audio/mp4');
      const mr = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 128000 });
      const chunks = [];
      mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      mr.onstop = async () => {
        try { stream.getTracks().forEach(t => t.stop()); } catch {}
        setIsListening(false);
        const blob = new Blob(chunks, { type: mimeType });
        if (blob.size < 512) {
          if (typeof alert !== 'undefined') alert('Gravacao muito curta. Tenta novamente.');
          return;
        }
        setLoading(true);
        try {
          const form = new FormData();
          const ext = mimeType.includes('webm') ? 'webm' : 'm4a';
          form.append('audio', blob, 'audio.' + ext);
          const base = require('../services/api').BASE_URL || 'https://chatyy.com.br';
          const authHeaders = require('../services/api').getAuthHeaders();
          const resp = await fetch(base + '/api/email.php?action=ai_transcribe_audio', {
            method: 'POST',
            body: form,
            headers: { Accept: 'application/json', ...authHeaders },
          });
          const data = await resp.json();
          const text = (data?.success && data?.data?.text) ? String(data.data.text).trim() : '';
          setLoading(false);
          if (text) {
            setInputText(text);
            setTimeout(() => { sendMessage(text); setInputText(''); }, 150);
          } else {
            if (typeof alert !== 'undefined') alert('Nao consegui entender. Tenta falar mais perto.');
          }
        } catch (e) {
          setLoading(false);
          if (typeof alert !== 'undefined') alert('Erro na transcricao: ' + (e?.message || 'tenta de novo'));
        }
      };
      mr.start();
      recognitionRef.current = { _mr: mr, stop: () => { try { mr.state === 'recording' && mr.stop(); } catch {} } };
      setIsListening(true);
      // Safety cap: 30s max — mic never "stays on forever"
      setTimeout(() => {
        try { if (recognitionRef.current?._mr === mr && mr.state === 'recording') mr.stop(); } catch {}
      }, 30000);
    } catch (e) {
      setIsListening(false);
      if (typeof alert !== 'undefined') alert('Microfone indisponivel: ' + (e?.message || 'permissao negada'));
    }
  }, [t, locale, sendMessage]);

  const stopListening = useCallback(async () => {
    // Kill the VAD poll loop first so it can't re-enter stopListening
    // while we're already tearing down the recorder.
    if (vadTimerRef.current) {
      clearInterval(vadTimerRef.current);
      vadTimerRef.current = null;
    }
    // Native: stop recording, upload to Whisper, send transcribed text
    if (audioRecordingRef.current) {
      const rec = audioRecordingRef.current;
      audioRecordingRef.current = null;
      setIsListening(false);
      if (__DEV__) console.log('[one] Stopping recording, uploading to Whisper...');
      setLoading(true); // show spinner while Whisper is transcribing
      try {
        await rec.stop();
        // Small flush delay — on iOS AVAudioRecorder the m4a moov atom is
        // written a few hundred ms after stop. Reading the file too soon
        // yields a 0-byte or corrupt file that Whisper can't decode.
        await new Promise(r => setTimeout(r, 250));
        const uri = rec.uri;
        if (!uri) {
          console.warn('[one] No audio URI after stop');
          setLoading(false);
          if (typeof alert !== 'undefined') alert('Nao consegui capturar o audio, tenta de novo');
          return;
        }
        // Sanity check: the recorded file must be non-trivial. A < 2KB
        // file means the mic didn't actually capture anything (mute
        // switch on, permission silently denied, or microphone blocked).
        let fileSize = 0;
        try {
          let FS; try { FS = require('expo-file-system/legacy'); } catch { FS = require('expo-file-system'); }
          const info = await FS.getInfoAsync(uri, { size: true });
          fileSize = info?.size || 0;
        } catch {}
        if (__DEV__) console.log('[one] Audio recorded at', uri, 'size=', fileSize, '— sending to Whisper');
        if (fileSize > 0 && fileSize < 2048) {
          setLoading(false);
          if (typeof alert !== 'undefined') alert('Gravacao muito curta. Fala algo e toca no microfone pra parar.');
          return;
        }
        const transRes = await api.aiTranscribeAudio(uri);
        if (__DEV__) console.log('[one] Whisper response:', JSON.stringify(transRes)?.slice(0, 200));
        const text = (transRes?.success && transRes?.data?.text) ? String(transRes.data.text).trim() : '';
        setLoading(false);
        if (text) {
          setInputText(text);
          setTimeout(() => { sendMessage(text); setInputText(''); }, 200);
        } else {
          // No text detected — let user know with a more actionable hint.
          const errMsg = transRes?.message || '';
          if (typeof alert !== 'undefined') {
            alert('Nao consegui entender. Tenta falar mais perto e mais alto.' + (errMsg ? '\n(' + errMsg + ')' : ''));
          }
        }
      } catch (e) {
        console.warn('[one] Whisper transcribe error:', e?.message, e);
        setLoading(false);
        if (typeof alert !== 'undefined') alert('Erro na transcricao: ' + (e?.message || 'tenta de novo'));
      }
      return;
    }
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch {}
      recognitionRef.current = null;
    }
    setIsListening(false);
  }, [sendMessage]);

  const toggleListening = useCallback(() => {
    if (isListening) stopListening();
    else startListening();
  }, [isListening, startListening, stopListening]);

  // ─── Voice conversation mode ───

  // Start listening specifically for voice conversation mode (auto-sends on result)
  const startListeningForVoiceMode = useCallback(() => {
    if (!voiceModeRef.current || !isMountedRef.current) return;
    // Per-session token: blocks the onend / onerror auto-restart and the
    // 8s native auto-stop from spawning overlapping recognition sessions
    // when a result already came in (codex finding: duplicate sends).
    const sessionToken = ++voiceSessionRef.current;
    const isFreshSession = () => sessionToken === voiceSessionRef.current && voiceModeRef.current && isMountedRef.current;
    setVoiceState('listening');
    setVoiceTranscript('');
    haptic('light');

    if (Platform.OS !== 'web') {
      // Voice conversation mode: record with dynamic VAD + Whisper.
      //
      // Bug we fixed 2026-04-20: previously a fixed 8s timer cut every turn,
      // so even a 500ms "oi" kept the user waiting 8 seconds before the AI
      // could respond. Now we use expo-audio's metering loop:
      //   • The mic runs for up to 20s (hard safety cap).
      //   • A 150ms poll reads `rec.getStatus()`. If the metering dB stays
      //     below SILENCE_DB for `SILENCE_MS` consecutive ms AND the user
      //     HAS already spoken (we saw voice above VOICE_DB), we stop.
      //   • Any catch path still schedules a re-listen so the mic never
      //     stalls silently when Whisper / permissions / audio errors hit.
      const SILENCE_DB = -50;   // quieter than this = probably silence
      const VOICE_DB   = -35;   // louder than this = user is speaking
      const SILENCE_MS = 1400;  // hold silent this long → stop
      const HARD_CAP_MS = 20000;

      // Empty-transcription guard: if we re-listen 3× in a row with no
      // speech detected, stop re-listening and surface a hint instead of
      // letting the mic run forever ("só fica ouvindo e não responde").
      const bumpEmpty = () => { emptyListenRef.current = (emptyListenRef.current || 0) + 1; };
      const resetEmpty = () => { emptyListenRef.current = 0; };
      const scheduleReListen = () => {
        if ((emptyListenRef.current || 0) >= 3) {
          // Bail out — user taps orb again to restart
          voiceModeRef.current = false;
          setVoiceMode(false);
          setVoiceState('idle');
          try {
            const cantHear = t('one.cantHearYou') || 'Não consegui te ouvir — toque o microfone de novo pra falar.';
            if (Platform.OS === 'web' && typeof alert !== 'undefined') alert(cantHear);
            else Alert.alert('Chatyy', cantHear);
          } catch {}
          return;
        }
        setTimeout(() => {
          if (isFreshSession()) startListeningForVoiceMode();
        }, 300);
      };

      const handleStopAndTranscribe = async (rec) => {
        if (!isFreshSession() || audioRecordingRef.current !== rec) return;
        audioRecordingRef.current = null;
        try { await rec.stop(); } catch {}
        await new Promise(r => setTimeout(r, 200)); // flush moov atom on iOS
        const uri = rec.uri;
        setIsListening(false);
        if (!uri || !isFreshSession()) {
          if (isFreshSession()) { bumpEmpty(); scheduleReListen(); }
          return;
        }
        try {
          const transRes = await api.aiTranscribeAudio(uri);
          if (!isFreshSession()) return;
          const text = (transRes?.success && transRes?.data?.text) ? String(transRes.data.text).trim() : '';
          if (text) {
            resetEmpty();
            setVoiceTranscript(text);
            haptic('medium');
            setTimeout(() => { if (isFreshSession()) sendMessage(text); }, 150);
          } else {
            bumpEmpty();
            scheduleReListen();
          }
        } catch (e) {
          console.warn('[one] Voice mode whisper error:', e?.message);
          if (isFreshSession()) { bumpEmpty(); scheduleReListen(); }
        }
      };

      (async () => {
        try {
          const expoAudio = require('expo-audio');
          const perm = await expoAudio.requestRecordingPermissionsAsync();
          if (!perm.granted) {
            if (typeof alert !== 'undefined') alert('Microfone negado. Libera em Ajustes → Chatyy → Microfone.');
            if (isFreshSession()) {
              voiceModeRef.current = false;
              setVoiceMode(false);
            }
            return;
          }
          await expoAudio.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
          const AudioMod = require('expo-audio/build/AudioModule').default;

          // Same explicit config the push-to-talk path uses, with metering
          // enabled so the VAD loop can actually read dB.
          const VOICE_CONFIG = {
            extension: '.m4a',
            sampleRate: 44100,
            numberOfChannels: 1,
            bitRate: 128000,
            isMeteringEnabled: true,
            ios: {
              extension: '.m4a', outputFormat: 'MPEG4AAC',
              audioQuality: 96, sampleRate: 44100,
              numberOfChannels: 1, bitRate: 128000,
              linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false,
            },
            android: {
              extension: '.m4a', outputFormat: 'mpeg4', audioEncoder: 'aac',
              sampleRate: 44100, numberOfChannels: 1, bitRate: 128000,
            },
            web: { mimeType: 'audio/webm', bitsPerSecond: 128000 },
          };
          const rec = new AudioMod.AudioRecorder(VOICE_CONFIG);
          await rec.prepareToRecordAsync();
          rec.record();
          audioRecordingRef.current = rec;
          setIsListening(true);

          // ─── VAD loop ───
          const startedAt = Date.now();
          let lastVoiceAt = 0;
          let hasSpoken = false;
          if (voiceRecTimerRef.current) { try { clearTimeout(voiceRecTimerRef.current); } catch {} voiceRecTimerRef.current = null; }
          if (vadTimerRef.current) { try { clearInterval(vadTimerRef.current); } catch {} vadTimerRef.current = null; }
          vadTimerRef.current = setInterval(async () => {
            if (!isFreshSession() || audioRecordingRef.current !== rec) {
              clearInterval(vadTimerRef.current);
              vadTimerRef.current = null;
              return;
            }
            let metering = -60;
            try {
              const status = (typeof rec.getStatus === 'function') ? await rec.getStatus() : null;
              if (status && typeof status.metering === 'number') metering = status.metering;
            } catch {}
            const elapsed = Date.now() - startedAt;
            if (metering > VOICE_DB) { hasSpoken = true; lastVoiceAt = Date.now(); }
            const silentMs = lastVoiceAt ? (Date.now() - lastVoiceAt) : elapsed;
            // Stop early if the user hasn't spoken at all in the first 5s.
            // Without this, the mic waits the full 20s hard-cap when the
            // user just taps the orb and doesn't say anything — felt like
            // the app was "só ouvindo e nada acontece".
            const shouldStop = (hasSpoken && metering < SILENCE_DB && silentMs > SILENCE_MS)
                            || (!hasSpoken && elapsed > 5000)
                            || elapsed > HARD_CAP_MS;
            if (shouldStop) {
              clearInterval(vadTimerRef.current);
              vadTimerRef.current = null;
              handleStopAndTranscribe(rec);
            }
          }, 150);

          // Belt-and-suspenders hard cap — if VAD loop dies, this still stops
          voiceRecTimerRef.current = setTimeout(() => {
            voiceRecTimerRef.current = null;
            if (vadTimerRef.current) { clearInterval(vadTimerRef.current); vadTimerRef.current = null; }
            handleStopAndTranscribe(rec);
          }, HARD_CAP_MS + 1000);
        } catch (e) {
          console.warn('[one] Voice mode recording error:', e?.message);
          if (isFreshSession()) scheduleReListen();
        }
      })();
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
      if (!isMountedRef.current) return;
      setIsListening(false);
      // If voice mode still active and no transcript came, re-listen
      if (voiceModeRef.current) {
        setTimeout(() => {
          if (voiceModeRef.current && isMountedRef.current) startListeningForVoiceMode();
        }, 500);
      }
    };
    recognition.onerror = (e) => {
      if (!isMountedRef.current) return;
      setIsListening(false);
      const err = e?.error || '';
      // Recover from benign errors by re-listening. Previously only
      // `no-speech` re-listened — other errors ('audio-capture',
      // 'aborted', 'network') left the orb stuck "ouvindo" forever.
      const recoverable = ['no-speech', 'aborted', 'network', 'audio-capture'];
      if (voiceModeRef.current && recoverable.includes(err)) {
        setTimeout(() => {
          if (voiceModeRef.current && isMountedRef.current) startListeningForVoiceMode();
        }, 500);
      } else if (err === 'not-allowed' || err === 'service-not-allowed') {
        // Permission denied — don't loop; surface it once.
        if (typeof alert !== 'undefined') alert('Microfone negado. Libera no navegador pra usar a voz.');
        voiceModeRef.current = false;
        setVoiceMode(false);
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
    // Bump the session token so ANY in-flight scheduleReListen / TTS-done
    // callback from a previous session becomes stale immediately. Without
    // this, tapping the orb twice in quick succession (or exit→enter after
    // TTS) spawned two concurrent recorders (audit bug #4).
    voiceSessionRef.current++;
    setVoiceMode(true);
    voiceModeRef.current = true;
    emptyListenRef.current = 0;
    setAutoRead(false); // voice mode handles its own TTS
    setVoiceState('listening');
    setVoiceTranscript('');
    stopSpeak();
    playActivationSound();

    // OpenAI Realtime via WebRTC — ChatGPT-style full-duplex voice.
    // Works on both web and native thanks to @livekit/react-native-webrtc.
    // The server mints an ephemeral token; client opens an RTCPeerConnection
    // directly with OpenAI. No Whisper/TTS chain — true live conversation.
    // Falls back to the legacy Whisper path only if WebRTC is unavailable
    // or the connect fails.
    if (isRealtimeSupported()) {
      const session = new OneRealtimeSession({
        onState: (s) => {
          if (!voiceModeRef.current) return;
          if (s === 'listening' || s === 'connecting') setVoiceState('listening');
          else if (s === 'speaking') setVoiceState('speaking');
        },
        onTranscript: (text) => {
          if (!voiceModeRef.current) return;
          setVoiceTranscript(text);
          haptic('light');
        },
        onAssistantText: () => {},
        onError: (e) => {
          console.warn('[one] realtime error:', e?.message || e);
        },
        onClose: () => {
          // If the session drops mid-voice-mode, fall back to legacy flow so
          // the user isn't stranded with a dead orb.
          if (voiceModeRef.current && realtimeRef.current === session) {
            realtimeRef.current = null;
            if (isMountedRef.current) startListeningForVoiceMode();
          }
        },
      });
      realtimeRef.current = session;
      session.start().catch((e) => {
        console.warn('[one] realtime start failed, falling back to Whisper:', e?.message);
        realtimeRef.current = null;
        if (voiceStartTimerRef.current) clearTimeout(voiceStartTimerRef.current);
        voiceStartTimerRef.current = setTimeout(() => {
          voiceStartTimerRef.current = null;
          if (isMountedRef.current && voiceModeRef.current) startListeningForVoiceMode();
        }, 200);
      });
      return;
    }

    // Native / unsupported: legacy Whisper path
    if (voiceStartTimerRef.current) clearTimeout(voiceStartTimerRef.current);
    voiceStartTimerRef.current = setTimeout(() => {
      voiceStartTimerRef.current = null;
      if (isMountedRef.current) startListeningForVoiceMode();
    }, 300);
  }, [startListeningForVoiceMode]);

  const exitVoiceMode = useCallback(() => {
    // Bump the session token so any in-flight onend / 8s timer / whisper
    // result becomes stale immediately.
    voiceSessionRef.current++;
    voiceModeRef.current = false;
    setVoiceMode(false);
    setVoiceState('listening');
    setVoiceTranscript('');
    if (voiceRecTimerRef.current) { try { clearTimeout(voiceRecTimerRef.current); } catch {} voiceRecTimerRef.current = null; }
    if (voiceStartTimerRef.current) { try { clearTimeout(voiceStartTimerRef.current); } catch {} voiceStartTimerRef.current = null; }
    if (audioRecordingRef.current) {
      try { audioRecordingRef.current.stop?.(); } catch {}
      audioRecordingRef.current = null;
    }
    if (realtimeRef.current) {
      try { realtimeRef.current.stop(); } catch {}
      realtimeRef.current = null;
    }
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

    const lang = detectTextLang(plainText, locale);
    const started = speakText(plainText, lang, () => {
      // Called when speech finishes
      setSpeakingId(null);
    });
    if (started) {
      setSpeakingId(item.id);
    }
  }, [speakingId, locale]);

  // Cleanup on unmount — tear down ALL side effects so the screen can be
  // closed mid-recording / mid-voice-mode without leaking intervals,
  // stuck microphones, or stale state updates from async callbacks.
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      voiceModeRef.current = false;
      try { abortVoiceSpeaking(); } catch {}
      try { stopSpeak(); } catch {}
      if (recognitionRef.current) try { recognitionRef.current.stop(); } catch {}
      if (speakCheckRef.current) { clearInterval(speakCheckRef.current); speakCheckRef.current = null; }
      if (voiceStartTimerRef.current) { clearTimeout(voiceStartTimerRef.current); voiceStartTimerRef.current = null; }
      // VAD poll loop + active recorder (fixes: mic keeps listening after
      // navigate away from the One screen)
      if (vadTimerRef.current) { clearInterval(vadTimerRef.current); vadTimerRef.current = null; }
      if (audioRecordingRef.current) {
        try { audioRecordingRef.current.stop(); } catch {}
        audioRecordingRef.current = null;
      }
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

  // Copy AI message → clipboard. Strips markdown so users get clean text by default,
  // matching ChatGPT's "Copy" behavior. Returns boolean for the row to show its checkmark.
  const copyMessage = useCallback(async (item) => {
    try {
      const plain = stripMarkdown(item.content || '');
      const text = plain || item.content || '';
      if (!text) return false;
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      } else {
        const Clipboard = require('expo-clipboard');
        await Clipboard.setStringAsync(text);
      }
      try {
        const Haptics = require('expo-haptics');
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } catch {}
      return true;
    } catch { return false; }
  }, []);

  // Regenerate — drop the last AI message and re-send the immediately preceding
  // user message so the model takes another shot at it. ChatGPT-style affordance.
  const regenerateLast = useCallback((aiItem) => {
    if (!aiItem) return;
    const idx = messages.findIndex(m => m.id === aiItem.id);
    if (idx <= 0) return;
    // Walk back to the most recent user message before this AI reply.
    let userMsg = null;
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { userMsg = messages[i]; break; }
    }
    if (!userMsg) return;
    // Trim AI reply (and any later messages) so the regenerate flow looks fresh.
    setMessages(prev => prev.slice(0, idx));
    // Small delay so React commits the trimmed list before the new send.
    setTimeout(() => { sendMessage(userMsg.content || ''); }, 60);
  }, [messages, sendMessage]);

  // Track the index of the latest assistant message so only that bubble shows
  // the regenerate icon (mirrors ChatGPT — older replies stay clean).
  const lastAIId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && !messages[i]._streaming) return messages[i].id;
    }
    return null;
  }, [messages]);

  const onLongPressAI = useCallback((item) => {
    haptic('light');
    setCtxSheetItem(item);
  }, []);

  const renderMessage = useCallback(({ item }) => (
    <MessageRow
      item={item} colors={colors} isDark={isDark}
      onSpeak={speakMessage} speakingId={speakingId} t={t}
      onCopy={copyMessage}
      onRegenerate={regenerateLast}
      isLastAI={item.id === lastAIId}
      onLongPressAI={onLongPressAI}
    />
  ), [colors, isDark, speakMessage, speakingId, t, copyMessage, regenerateLast, lastAIId, onLongPressAI]);

  // ─── Empty state — clean 2x2 prompt grid (Translate / Summarize / Code / Brainstorm)
  const renderEmpty = () => {
    // 3-card grid (Codar removed — user asked to drop the dev-oriented prompt
    // because the typical Chatyy user isn't here to write code; Translate /
    // Summarize / Brainstorm cover 95% of real entry intents.
    const sugCards = [
      { key: 'translate', label: t('one.promptTranslate') || 'Translate', sub: t('one.promptTranslateSub') || 'a phrase or paragraph', msg: t('one.promptTranslateMsg') || 'Translate this to English: ' },
      { key: 'summarize', label: t('one.promptSummarize') || 'Summarize', sub: t('one.promptSummarizeSub') || 'an article or thread', msg: t('one.promptSummarizeMsg') || 'Summarize my unread emails today.' },
      { key: 'brainstorm', label: t('one.promptBrainstorm') || 'Brainstorm', sub: t('one.promptBrainstormSub') || 'ideas with me', msg: t('one.promptBrainstormMsg') || 'Brainstorm 5 ideas for ' },
    ];

    return (
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={st.emptyOuter}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={st.emptyCenter}>
          {/* WAVE 46 (2026-05-21): real app icon avatar w/ blinking eyes
              replaces the abstract sparkle composition. Reads more like a
              mascot greeting the user on an empty canvas. */}
          <View style={{ marginBottom: 18 }}>
            <ChatyyOneAvatar size={96} />
          </View>
          {/* Title — "Como posso ajudar?" (i18n). Personalized greeting still
              shown on top as a small eyebrow when we know the first name. */}
          {firstName ? (
            <Text style={[st.emptyGreeting, { color: isDark ? '#9CA3AF' : '#6B7280', fontSize: 14, fontWeight: '500', marginBottom: 6 }]}>
              {`${getGreeting(t)}, ${firstName}`}
            </Text>
          ) : null}
          <Text style={[st.emptyGreeting, { color: isDark ? '#ECECEC' : '#0D0D0D' }]}>
            {t('one.emptyTitle') || 'How can I help?'}
          </Text>
          <Text style={[st.emptySubtitle, { color: isDark ? '#9CA3AF' : '#6B7280' }]}>
            {t('one.emptyHint') || 'How can I help today?'}
          </Text>
        </View>

        {/* Horizontal scroll prompt chips — brand outline + press scale 0.96.
            Replaces the old 2×2 grid; a scrollable rail surfaces more prompts
            without crowding the empty canvas and reads more like a modern
            ChatGPT/Claude entry. We keep the same sugCards source so adding
            new prompts is one-line. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 4 }}
          keyboardShouldPersistTaps="handled"
        >
          {sugCards.map((item) => (
            <PromptChip
              key={item.key}
              label={item.label}
              sub={item.sub}
              isDark={isDark}
              onPress={() => {
                if (item.msg.endsWith(' ') || item.msg.endsWith(': ')) {
                  setInputText(item.msg);
                } else {
                  sendMessage(item.msg);
                }
              }}
            />
          ))}
        </ScrollView>
      </ScrollView>
    );
  };

  // ChatGPT-style canvas: white in light mode, near-black in dark.
  const canvasBg = isDark ? '#1A1A1A' : '#FFFFFF';

  return (
    <KeyboardAvoidingView
      style={[st.container, { backgroundColor: canvasBg }]}
      // [2026-05-21] Android with behavior=undefined left the composer hidden
      // behind the keyboard on /one. Even with android:windowSoftInputMode=
      // adjustResize in the manifest, the KAV needed an explicit 'height' to
      // recompute layout when IME opened (user print: composer não visível,
      // só o keyboard sob os chips). 'height' shrinks the KAV to keyboard
      // height, push the input bar above the IME.
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
    >
      {/* Clean header — no gradient, just title + side actions on a flat canvas. */}
      <View style={[st.headerClean, { paddingTop: insets.top + 4, backgroundColor: canvasBg }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={st.headerCleanBtn}>
          <IconArrowLeft size={22} color={isDark ? '#ECECEC' : '#0D0D0D'} />
        </TouchableOpacity>

        <View style={st.headerCleanCenter}>
          <Text style={[st.headerCleanTitle, { color: isDark ? '#ECECEC' : '#0D0D0D' }]}>One</Text>
        </View>

        <View style={{ flexDirection: 'row' }}>
          <TouchableOpacity onPress={newChat} hitSlop={8} style={st.headerCleanBtn} accessibilityLabel={t('one.newChat') || 'New chat'}>
            <IconEdit size={20} color={isDark ? '#ECECEC' : '#0D0D0D'} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => { loadConversations(false); setHistoryOpen(true); }}
            hitSlop={8}
            style={st.headerCleanBtn}
            accessibilityLabel={t('one.history') || 'History'}
          >
            <IconMenu size={20} color={isDark ? '#ECECEC' : '#0D0D0D'} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Canvas (no wallpaper background — flat surface like ChatGPT) */}
      <View style={[st.chatArea, { backgroundColor: canvasBg }]}>
        {initialLoading && !hasMessages ? (
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <ActivityIndicator size="large" color={ACCENT} />
          </View>
        ) : hasMessages ? (
          <FlatList
            ref={flatListRef}
            data={messages}
            keyExtractor={item => String(item.id)}
            renderItem={renderMessage}
            onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
            showsVerticalScrollIndicator={false}
            style={{ flex: 1 }}
            contentContainerStyle={{
              paddingTop: 8,
              // [WAVE 43A 2026-05-21] When followup chips render in the footer,
              // the previous 16px wasn't enough on iOS — the chip row got
              // clipped by the input pill on auto-scrollToEnd (user report:
              // "ta cortando embaixo"). Bump to ~120 when chips are visible
              // so the chip row is fully clear of the input area.
              paddingBottom: (lastFollowups.length > 0 && !loading) ? 120 : 16,
              paddingHorizontal: 12,
            }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            automaticallyAdjustKeyboardInsets={true}
            ListFooterComponent={
              loading && !messages.some(m => m._streaming) ? (
                <View style={{ paddingHorizontal: 4, marginTop: 8 }}>
                  <View style={st.aiHeaderRow}>
                    <ChatyyOneAvatar size={18} />
                    <Text style={[st.aiHeaderLabel, { color: isDark ? '#9CA3AF' : '#6B7280' }]}>One</Text>
                  </View>
                  <InlineStreamingDots isDark={isDark} />
                </View>
              ) : (
                // Suggested follow-up chips — only shown when:
                //   • we have follow-ups from the latest AI reply
                //   • nothing is streaming/loading right now
                //   • user hasn't started typing (their own intent wins)
                //   • there IS a finished AI reply to attach them to
                !loading
                && lastFollowups.length > 0
                && !inputText.trim()
                && messages.some(m => m.role === 'assistant' && !m._streaming)
                  ? (
                    // [WAVE 43A] Wrap in View w/ paddingBottom so chip pills
                    // never sit flush against the input bar — gives the row
                    // a clear floor even if keyboard pushes layout around.
                    <View style={{ paddingBottom: 24 }}>
                      <SmartReplyChips
                        replies={lastFollowups}
                        label={t('one.followupSuggested') || 'Continue com'}
                        onSelectReply={(chip) => setInputText(chip)}
                        onSendReply={(chip) => { setLastFollowups([]); sendMessage(chip); }}
                      />
                    </View>
                  )
                  : null
              )
            }
          />
        ) : (
          renderEmpty()
        )}
      </View>

      {/* Input — rounded 24pt pill, multi-line, plus + mic left, send right (purple #7C3AED filled circle) */}
      <View style={[st.inputAreaClean, {
        paddingBottom: Math.max(insets.bottom, 8),
        backgroundColor: canvasBg,
      }]}>
        <View style={[st.inputWrapperClean, isWide && { maxWidth: 720, alignSelf: 'center', width: '100%' }]}>
          {attachedImage && (
            <View style={[st.attachPreview, { backgroundColor: isDark ? '#2A2A2A' : '#F1F1F4' }]}>
              <Image source={{ uri: attachedImage.uri }} style={{ width: 56, height: 56, borderRadius: 8 }} />
              <TouchableOpacity onPress={() => setAttachedImage(null)} style={st.attachRemove}>
                <IconX size={14} color="#fff" />
              </TouchableOpacity>
            </View>
          )}

          <View style={[st.inputBoxClean, {
            backgroundColor: isDark ? '#2A2A2A' : '#F4F4F5',
            borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
          }]}>
            {/* Left: plus (attach) + mic */}
            <View style={st.inputLeftIcons}>
              <TouchableOpacity
                style={st.inputIconBtn}
                onPress={pickImage}
                activeOpacity={0.7}
                accessibilityLabel={t('one.attachPhoto')}
              >
                <IconPlus size={20} color={isDark ? '#9CA3AF' : '#6B7280'} />
              </TouchableOpacity>
              <TouchableOpacity
                style={st.inputIconBtn}
                onPress={toggleListening}
                activeOpacity={0.7}
                accessibilityLabel={isListening ? t('one.speakStop') : 'Microphone'}
              >
                {isListening ? (
                  <IconMicOff size={20} color="#ef4444" />
                ) : (
                  <IconMic size={20} color={isDark ? '#9CA3AF' : '#6B7280'} />
                )}
              </TouchableOpacity>
            </View>

            <TextInput
              style={[st.inputClean, { color: isDark ? '#ECECEC' : '#0D0D0D' }]}
              placeholder={isListening ? (t('one.voiceListening') || 'Listening…') : (t('one.placeholder') || 'Message One…')}
              placeholderTextColor={isDark ? '#6B7280' : '#9CA3AF'}
              value={inputText}
              onChangeText={setInputText}
              onSubmitEditing={() => sendMessage()}
              onKeyPress={(e) => {
                if (Platform.OS === 'web' && e.nativeEvent.key === 'Enter' && !e.nativeEvent.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              returnKeyType="send"
              multiline
              maxLength={2000}
              editable={!loading}
            />

            {/* Right: send (filled purple) / stop (when generating) / voice (when empty) */}
            {loading ? (
              <TouchableOpacity
                onPress={() => {
                  try { aiAbortRef.current?.abort?.(); } catch {}
                  try { stopListening?.(); } catch {}
                  if (voiceRecTimerRef.current) { try { clearTimeout(voiceRecTimerRef.current); } catch {} voiceRecTimerRef.current = null; }
                  if (audioRecordingRef.current) { try { audioRecordingRef.current.stop?.(); } catch {} audioRecordingRef.current = null; }
                  setLoading(false);
                  setVoiceState('listening');
                }}
                activeOpacity={0.7}
                accessibilityLabel={t?.('common.cancel') || 'Cancel'}
              >
                <View style={[st.sendBtnClean, { backgroundColor: isDark ? '#3F3F46' : '#0D0D0D' }]}>
                  <IconStop size={14} color="#fff" />
                </View>
              </TouchableOpacity>
            ) : (inputText.trim() || attachedImage) ? (
              <TouchableOpacity onPress={() => sendMessage()} activeOpacity={0.85}>
                {/* Brand-gradient 44px circle — see BrandSendCircle. The SVG
                    is absolute-positioned; we use a same-size wrapper so the
                    layout slot matches the stop/voice buttons. */}
                <View style={st.sendBtnBrand}>
                  <BrandSendCircle size={44} isDark={isDark} />
                </View>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                onPress={enterVoiceMode}
                activeOpacity={0.7}
                accessibilityLabel={t('one.voiceConversation') || 'Voice conversation'}
              >
                <View style={[st.sendBtnClean, { backgroundColor: ACCENT }]}>
                  <IconPhone size={16} color="#fff" />
                </View>
              </TouchableOpacity>
            )}
          </View>
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

      {/* Model picker sheet (top-center pill opens this) */}
      <ModelPickerSheet
        visible={modelSheetOpen}
        onClose={() => setModelSheetOpen(false)}
        isDark={isDark}
        t={t}
        currentModelId={selectedModel.id}
        onPick={(m) => setSelectedModel(m)}
      />

      {/* Long-press AI message context sheet */}
      <MessageContextSheet
        visible={!!ctxSheetItem}
        onClose={() => setCtxSheetItem(null)}
        isDark={isDark}
        t={t}
        canRegenerate={!!(ctxSheetItem && ctxSheetItem.id === lastAIId)}
        onCopy={() => ctxSheetItem && copyMessage(ctxSheetItem)}
        onRegenerate={() => ctxSheetItem && regenerateLast(ctxSheetItem)}
        onBadResponse={() => {
          // Lightweight feedback hook — wire to telemetry later. For now, just confirm visually.
          haptic('light');
          try {
            const { Alert } = require('react-native');
            if (Platform.OS === 'web') {
              window.alert(t('one.badResponseThanks') || 'Thanks — feedback noted.');
            } else {
              Alert.alert(t('one.badResponseThanks') || 'Thanks — feedback noted.');
            }
          } catch {}
        }}
      />

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
        onDelete={(c) => {
          const doDel = async () => {
            try {
              await api.oneHistoryDelete({ conversationId: c.id });
              setConversations(prev => prev.filter(x => x.id !== c.id));
              if (conversationId === c.id) { setMessages([]); setConversationId(null); }
            } catch {}
          };
          if (Platform.OS === 'web') { if (window.confirm(t('one.deleteConfirm') || 'Apagar essa conversa?')) doDel(); }
          else Alert.alert(t('one.deleteConv') || 'Apagar conversa', t('one.deleteConfirm') || 'Apagar essa conversa do histórico?', [
            { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
            { text: t('common.delete') || 'Apagar', style: 'destructive', onPress: doDel },
          ]);
        }}
        onClearAll={() => {
          const doAll = async () => {
            try {
              await api.oneHistoryDelete({ clearAll: true });
              setConversations([]);
              setMessages([]); setConversationId(null);
              setHistoryOpen(false);
            } catch {}
          };
          if (Platform.OS === 'web') { if (window.confirm(t('one.clearAllConfirm') || 'Apagar TODO o histórico do One?')) doAll(); }
          else Alert.alert(t('one.clearAll') || 'Limpar histórico', t('one.clearAllConfirm') || 'Apagar TODO o histórico do One? Isso não pode ser desfeito.', [
            { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
            { text: t('one.clearAll') || 'Limpar', style: 'destructive', onPress: doAll },
          ]);
        }}
      />
    </KeyboardAvoidingView>
  );
}

// ─── Styles ───

const st = StyleSheet.create({
  container: { flex: 1 },

  // ─── Clean ChatGPT-style header ───
  headerClean: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingHorizontal: 8, paddingBottom: 8,
  },
  headerCleanBtn: {
    width: 40, height: 40, alignItems: 'center', justifyContent: 'center',
  },
  headerCleanCenter: {
    flex: 1, alignItems: 'center', justifyContent: 'flex-start',
    paddingTop: 6,
  },
  headerCleanTitle: {
    fontSize: 16, fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Inter' : undefined,
    letterSpacing: -0.2,
  },
  modelPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 999, marginTop: 4,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : {}),
  },
  modelPillText: {
    fontSize: 12, fontWeight: '500', letterSpacing: -0.1,
  },

  // ─── ChatGPT-style messages ───
  // User: subtle gray pill, right-aligned, no avatar
  userRow: {
    width: '100%', alignItems: 'flex-end', marginVertical: 6,
    ...(isWide ? { maxWidth: CONTENT_MAX, alignSelf: 'center' } : {}),
  },
  userPill: {
    maxWidth: '85%',
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 18,
  },
  userText: {
    fontSize: 15, lineHeight: 22, letterSpacing: -0.1,
  },

  // AI: no bubble, plain text, header chip above
  aiRow: {
    width: '100%', alignItems: 'flex-start', marginVertical: 10,
    paddingHorizontal: 4,
    ...(isWide ? { maxWidth: CONTENT_MAX, alignSelf: 'center' } : {}),
  },
  aiHeaderRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6,
  },
  aiHeaderAvatar: {
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: ACCENT,
    alignItems: 'center', justifyContent: 'center',
  },
  aiHeaderLabel: {
    fontSize: 12, fontWeight: '600', letterSpacing: -0.1,
  },
  aiBody: { gap: 2 },
  aiActionsRow: {
    flexDirection: 'row', alignItems: 'center', gap: 16,
    marginTop: 8,
  },
  aiActionBtn: { padding: 4 },

  // ─── Clean input bar ───
  inputAreaClean: {
    paddingHorizontal: 10, paddingTop: 6,
  },
  inputWrapperClean: {},
  inputBoxClean: {
    flexDirection: 'row', alignItems: 'flex-end',
    borderRadius: 24, borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 4, paddingRight: 4, paddingVertical: 4,
    minHeight: 48,
  },
  inputLeftIcons: {
    flexDirection: 'row', alignItems: 'center',
    paddingBottom: 2,
  },
  inputIconBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : {}),
  },
  inputClean: {
    flex: 1, fontSize: 16, lineHeight: 22,
    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    paddingHorizontal: 6,
    minHeight: 40, maxHeight: 140,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  sendBtnClean: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    marginLeft: 4, marginBottom: 2,
    ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'transform 140ms ease' } : {}),
  },
  // Brand-gradient send button — 44px circle, taller than the stop/voice
  // 36px buttons. The slight footprint bump makes "send" the primary CTA
  // visually even before color/gradient. Drop-shadow grounds the circle.
  sendBtnBrand: {
    width: 44, height: 44,
    alignItems: 'center', justifyContent: 'center',
    marginLeft: 4, marginBottom: 0,
    ...Platform.select({
      ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.32, shadowRadius: 8 },
      android: { elevation: 4 },
      web: { boxShadow: `0 4px 12px ${ACCENT}55`, cursor: 'pointer', transition: 'transform 140ms ease' },
    }),
  },
  // Suggested-prompt chip — empty-state horizontal scroll list.
  promptChip: {
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 18, borderWidth: 1,
    marginRight: 8,
    minWidth: 120, maxWidth: 220,
  },
  promptChipLabel: { fontSize: 13, fontWeight: '600', letterSpacing: -0.1 },
  promptChipSub: { fontSize: 11, fontWeight: '400', marginTop: 1 },

  // ─── Bottom sheets (model picker + context menu) ───
  sheetDim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    paddingTop: 8, paddingBottom: 28,
    paddingHorizontal: 16,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
  },
  sheetGrabber: {
    alignSelf: 'center', width: 36, height: 4, borderRadius: 2,
    backgroundColor: 'rgba(128,128,128,0.4)',
    marginBottom: 12,
  },
  sheetTitle: {
    fontSize: 13, fontWeight: '600', letterSpacing: 0.2,
    textTransform: 'uppercase',
    marginBottom: 8, opacity: 0.7,
  },
  sheetItem: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 14,
    borderRadius: 12, marginVertical: 1,
  },
  sheetItemTitle: { fontSize: 15, fontWeight: '500' },
  sheetItemSub: { fontSize: 12, marginTop: 2 },

  // Header - WhatsApp style (legacy — kept for HistorySidebar)
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 4, paddingBottom: 10, paddingTop: 10,
  },
  headerBtn: { padding: 8 },
  headerProfile: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingLeft: 4,
  },
  headerAvatar: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: ACCENT,
    alignItems: 'center', justifyContent: 'center',
  },
  headerInfo: { justifyContent: 'center' },
  headerName: { fontSize: 17, fontWeight: '600', color: '#fff' },
  headerStatus: { fontSize: 12, fontWeight: '400', color: 'rgba(255,255,255,0.7)' },

  // Chat area (wallpaper background)
  chatArea: { flex: 1 },

  // ─── AI bubble (received - left aligned) ───
  aiBubbleRow: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingRight: 60, marginVertical: 2,
    ...(isWide ? { maxWidth: CONTENT_MAX, alignSelf: 'center', width: '100%' } : {}),
  },
  aiBubbleAvatarWrap: {
    marginRight: 4, marginBottom: 2,
  },
  aiBubbleAvatar: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: ACCENT,
    alignItems: 'center', justifyContent: 'center',
    // Why: subtle violet halo around the AI avatar reads as "thinking" energy
    // and visually anchors the conversation as AI-led, not just another contact.
    ...Platform.select({
      ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.35, shadowRadius: 6 },
      android: { elevation: 3 },
      web: { boxShadow: `0 2px 8px ${ACCENT}55` },
    }),
  },
  aiBubbleAvatarText: {
    color: '#fff', fontSize: 13, fontWeight: '700',
  },
  aiBubble: {
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: 18,
    borderTopLeftRadius: 4,
    position: 'relative',
    maxWidth: '85%',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 2 },
      android: { elevation: 1 },
      web: { boxShadow: '0 1px 2px rgba(0,0,0,0.08)' },
    }),
  },
  aiBubbleTail: {
    position: 'absolute', top: 0, left: -6,
    width: 0, height: 0,
    borderTopWidth: 8, borderTopColor: 'transparent',
    borderRightWidth: 8,
    borderBottomWidth: 0, borderBottomColor: 'transparent',
  },

  // ─── User bubble (sent - right aligned) ───
  userBubbleRow: {
    flexDirection: 'row', justifyContent: 'flex-end',
    paddingLeft: 60, marginVertical: 2,
    ...(isWide ? { maxWidth: CONTENT_MAX, alignSelf: 'center', width: '100%' } : {}),
  },
  userBubble: {
    maxWidth: '85%',
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: 18,
    borderTopRightRadius: 4,
    position: 'relative',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 2 },
      android: { elevation: 1 },
      web: { boxShadow: '0 1px 2px rgba(0,0,0,0.08)' },
    }),
  },
  userBubbleText: {
    fontSize: 15, lineHeight: 21,
  },
  userBubbleTail: {
    position: 'absolute', top: 0, right: -6,
    width: 0, height: 0,
    borderTopWidth: 8, borderTopColor: 'transparent',
    borderLeftWidth: 8,
    borderBottomWidth: 0, borderBottomColor: 'transparent',
  },

  // Bubble footer (time + actions)
  bubbleFooter: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end',
    gap: 6, marginTop: 4,
  },
  bubbleTime: {
    fontSize: 11, fontWeight: '400',
  },

  // Message text
  speakBtn: { padding: 2 },
  mdContent: { gap: 2 },
  msgText: { fontSize: 15, lineHeight: 22 },

  // Tool chips
  toolChipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  toolChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8,
    borderWidth: 1,
  },
  toolChipText: { fontSize: 11, fontWeight: '500' },

  // WhatsApp opt-in button
  waOptInBtn: {
    paddingVertical: 10, paddingHorizontal: 18, borderRadius: 10,
    alignSelf: 'flex-start',
  },
  waOptInBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },

  // Code blocks
  codeBlockWrap: {
    position: 'relative', marginVertical: 6,
  },
  codeCopyBtn: {
    position: 'absolute', top: 6, right: 8, zIndex: 2,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  codeCopyBtnText: {
    fontSize: 11, fontWeight: '500', color: '#ccc',
  },
  codeBlock: {
    backgroundColor: '#1e1e1e', borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  codeText: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12, color: '#d4d4d4', lineHeight: 18,
  },
  inlineCode: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, color: '#e06c75',
  },

  // Lists
  bulletRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginVertical: 1 },
  bulletDot: { fontSize: 15, lineHeight: 22 },
  bulletNum: { fontSize: 14, lineHeight: 22, fontWeight: '600', minWidth: 18 },
  bulletText: { flex: 1, fontSize: 15, lineHeight: 22 },

  // Empty state — minimal ChatGPT-style
  emptyOuter: { flexGrow: 1, justifyContent: 'center', paddingVertical: 24 },
  emptyCenter: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, marginBottom: 24 },
  emptyLogoCircle: {
    width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 14,
  },
  emptyGreeting: {
    fontSize: 22, fontWeight: '600', textAlign: 'center', marginBottom: 4,
    letterSpacing: -0.3,
  },
  emptySubtitle: {
    fontSize: 14, fontWeight: '400', textAlign: 'center', marginBottom: 8,
  },

  // Prompt suggestion grid (2×2)
  sugArea: { paddingHorizontal: 16, paddingBottom: 12 },
  sugGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center',
    ...(isWide ? { alignSelf: 'center', width: '100%' } : {}),
  },
  sugCard: {
    width: isWide ? '47%' : '47%',
    paddingHorizontal: 14, paddingVertical: 14,
    borderRadius: 14, borderWidth: StyleSheet.hairlineWidth,
    minHeight: 76,
  },
  sugCardLabel: { fontSize: 14, fontWeight: '600', letterSpacing: -0.1, marginBottom: 2 },
  sugCardSub: { fontSize: 12, fontWeight: '400', lineHeight: 16 },

  // Quick Actions Bar
  quickActionsBar: {
    maxHeight: 42,
  },
  quickActionsContent: {
    paddingHorizontal: 12, paddingVertical: 5, gap: 8,
    ...(isWide ? { maxWidth: 680, alignSelf: 'center', width: '100%' } : {}),
  },
  quickActionChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 13, paddingVertical: 7,
    borderRadius: 20,
    // Why: suggestion pills are the discoverability surface — bumped padding
    // (12/6 → 13/7) and radius (18 → 20) reads more pill-like; the soft
    // web shadow lifts them off the toolbar without competing with the input.
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 2 },
      android: { elevation: 1 },
      web: { cursor: 'pointer', transition: 'transform 160ms ease, box-shadow 160ms ease, background-color 160ms ease', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' },
    }),
  },
  quickActionText: {
    fontSize: 12.5, fontWeight: '600', letterSpacing: -0.1,
  },

  // Input - WhatsApp style
  inputArea: { paddingHorizontal: 6, paddingTop: 4 },
  inputWrapper: {},
  inputRow: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 6,
  },
  inputBox: {
    flex: 1, flexDirection: 'row', alignItems: 'flex-end',
    borderRadius: 24,
    paddingLeft: 4, paddingRight: 8, paddingVertical: 4,
    // Why: premium messenger inputs lift slightly and have a softer, longer
    // shadow rather than a hairline. On web we also animate so the focus
    // state (handled by `:focus-within` cascade from the container) feels alive.
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 4 },
      android: { elevation: 2 },
      web: { boxShadow: '0 2px 6px rgba(0,0,0,0.08)', transition: 'box-shadow 200ms ease' },
    }),
  },
  inputIcon: {
    padding: 8, marginBottom: 0,
  },
  input: {
    flex: 1, fontSize: 16, minHeight: 40,
    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    paddingHorizontal: 4,
    maxHeight: 120,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  sendCircle: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    // Why: send button is the conversion CTA — give it a violet ambient glow
    // so it reads as the primary action even when the bg is white. Web gets
    // a transition so press states feel snappy.
    ...Platform.select({
      ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.32, shadowRadius: 8 },
      android: { elevation: 4 },
      web: { boxShadow: `0 4px 12px ${ACCENT}44`, transition: 'transform 140ms ease, box-shadow 200ms ease', cursor: 'pointer' },
    }),
  },

  // Attached image preview
  attachPreview: {
    flexDirection: 'row', alignItems: 'center',
    padding: 8, marginBottom: 6, borderRadius: 12,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 3 },
      android: { elevation: 2 },
      web: { boxShadow: '0 1px 4px rgba(0,0,0,0.1)' },
    }),
  },
  attachRemove: {
    position: 'absolute', top: 2, right: 2,
    backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 12,
    width: 24, height: 24, alignItems: 'center', justifyContent: 'center',
  },

  // Rotating text
  rotatingWrap: { height: 28, justifyContent: 'center', alignItems: 'center' },
  rotatingText: { fontSize: 16, fontWeight: '500' },

  // History sidebar
  sidebarOverlay: { flex: 1, flexDirection: 'row' },
  sidebarDim: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sidebar: {
    position: 'absolute', left: 0, top: 0, bottom: 0, width: '85%', maxWidth: 280,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 4, height: 0 }, shadowOpacity: 0.2, shadowRadius: 16 },
      android: { elevation: 12 },
      web: { boxShadow: '4px 0 24px rgba(0,0,0,0.15)' },
    }),
  },
  sidebarHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 0.5, borderBottomColor: 'rgba(128,128,128,0.15)',
  },
  sidebarTitle: { fontSize: 15, fontWeight: '600' },
  sidebarList: { flex: 1, paddingVertical: 8 },
  sidebarEmpty: { textAlign: 'center', marginTop: 40, fontSize: 14 },
  sidebarItem: {
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 8, marginHorizontal: 8, marginVertical: 1,
  },
  sidebarItemText: { fontSize: 14, fontWeight: '400' },

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
    fontSize: 16, fontWeight: '400',
    color: 'rgba(255,255,255,0.7)',
    marginTop: 32,
    letterSpacing: 0.5,
  },
  voiceCenterAnim: {
    alignItems: 'center', justifyContent: 'center',
    minHeight: 280,
  },
  voiceTranscript: {
    fontSize: 18, fontWeight: '400', textAlign: 'center',
    marginTop: 32, maxWidth: 340,
    lineHeight: 26, color: '#fff',
  },
  voiceSilenceHint: {
    fontSize: 14, fontWeight: '400', textAlign: 'center',
    marginTop: 24, color: 'rgba(255,255,255,0.4)',
  },
  voiceStopBtn: {
    position: 'absolute', bottom: 60,
    alignItems: 'center', gap: 10,
  },
  voiceStopCircle: {
    width: 60, height: 60, borderRadius: 30,
    backgroundColor: '#ef4444',
    alignItems: 'center', justifyContent: 'center',
  },
  // Modern overlay additions
  voiceTopBar: {
    position: 'absolute', top: Platform.OS === 'web' ? 16 : 56, left: 20, right: 20,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    zIndex: 3,
  },
  voiceTopBarLive: {
    color: '#fca5a5', fontSize: 11, fontWeight: '800', letterSpacing: 1.5,
  },
  voiceTopBarTitle: {
    color: '#fff', fontSize: 15, fontWeight: '700', letterSpacing: 0.3,
    textShadowColor: 'rgba(124,58,237,0.35)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 8,
  },
  voiceTopBarTimer: {
    color: 'rgba(255,255,255,0.8)', fontSize: 13, fontWeight: '600',
    fontVariant: ['tabular-nums'],
    backgroundColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 9, paddingVertical: 3, borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.12)',
  },
  voiceTranscriptCard: {
    marginTop: 28, paddingHorizontal: 18, paddingVertical: 14,
    maxWidth: 380, minHeight: 58,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.12)',
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(20px)' } : {}),
  },
  voiceBottomBar: {
    position: 'absolute', bottom: Platform.OS === 'web' ? 40 : 60,
    left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 26, zIndex: 3,
  },
  voiceCtrlBtn: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(16px)' } : {}),
  },
  voiceEndBtn: {
    width: 76, height: 76, borderRadius: 38,
    backgroundColor: '#ef4444',
    alignItems: 'center', justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: '#ef4444', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.5, shadowRadius: 18 },
      android: { elevation: 10 },
      web: { boxShadow: '0 10px 30px rgba(239,68,68,0.45)' },
    }),
  },
});
