/**
 * SignupIntro — 5-slide swipeable intro carousel rendered before the
 * signup-phone form. Inspired by Telegram's onboarding but with honest
 * Chatyy value props (no fake "fastest app" claims) and our brand purple.
 *
 * Slides: brand → all-in-one → privacy → AI → multi-device.
 * Each slide has an illustrated SVG hero (~200dp) + title + subtitle
 * with bold strong words, animated dots indicator, and a primary CTA
 * that flips to "Começar" on the last slide.
 *
 * Used by signup-phone.js when step==='welcome' (the new initial step,
 * unless phone was forwarded from login).
 */
import { useState, useRef, useMemo } from 'react';
import { View, Text, TouchableOpacity, Animated, Dimensions, PanResponder, StyleSheet, Platform } from 'react-native';
import Svg, { Path, Rect, Circle, Line, Defs, LinearGradient, Stop, Ellipse } from 'react-native-svg';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as Haptics from 'expo-haptics';

const { width: SCREEN_W } = Dimensions.get('window');

// ─── 5 slide illustrations (mirrors /mockups/telegram-clean.html SVGs) ───

function IconBrand() {
  return (
    <Svg viewBox="0 0 200 200" width="100%" height="100%">
      <Defs>
        <LinearGradient id="brandGrad" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#c4b5fd" />
          <Stop offset="1" stopColor="#7c3aed" />
        </LinearGradient>
        <LinearGradient id="brandShine" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#fff" stopOpacity="0.45" />
          <Stop offset="0.55" stopColor="#fff" stopOpacity="0" />
        </LinearGradient>
      </Defs>
      <Circle cx="100" cy="100" r="92" fill="#a78bfa" opacity="0.18" />
      <Circle cx="100" cy="100" r="74" fill="url(#brandGrad)" />
      <Circle cx="100" cy="100" r="74" fill="url(#brandShine)" />
      <Path d="M70 80 Q70 70 80 70 L120 70 Q130 70 130 80 L130 110 Q130 120 120 120 L98 120 L86 132 L86 120 L80 120 Q70 120 70 110 Z" fill="#fff" />
      <Circle cx="86" cy="95" r="4" fill="#7c3aed" />
      <Circle cx="100" cy="95" r="4" fill="#7c3aed" />
      <Circle cx="114" cy="95" r="4" fill="#7c3aed" />
      <Path d="M148 58 L150 50 L152 58 L160 60 L152 62 L150 70 L148 62 L140 60 Z" fill="#fbbf24" />
    </Svg>
  );
}

function IconAllInOne() {
  return (
    <Svg viewBox="0 0 200 200" width="100%" height="100%">
      <Rect x="32" y="32" width="68" height="68" rx="16" fill="#a78bfa" />
      <Rect x="100" y="32" width="68" height="68" rx="16" fill="#c4b5fd" />
      <Rect x="32" y="100" width="68" height="68" rx="16" fill="#ddd6fe" />
      <Rect x="100" y="100" width="68" height="68" rx="16" fill="#7c3aed" />
      {/* chat bubble (top-left tile) */}
      <Path d="M50 56 L82 56 Q86 56 86 60 L86 76 Q86 80 82 80 L62 80 L54 87 L54 80 L50 80 Q46 80 46 76 L46 60 Q46 56 50 56 Z" fill="#fff" />
      {/* mail (top-right) */}
      <Rect x="116" y="50" width="36" height="28" rx="3" fill="#fff" stroke="#a78bfa" strokeWidth="2" />
      <Path d="M116 54 L134 68 L152 54" stroke="#a78bfa" strokeWidth="2" fill="none" />
      {/* calendar (bottom-left) */}
      <Rect x="46" y="120" width="40" height="36" rx="4" fill="#fff" stroke="#a78bfa" strokeWidth="2" />
      <Line x1="46" y1="130" x2="86" y2="130" stroke="#a78bfa" strokeWidth="2" />
      <Circle cx="56" cy="142" r="2" fill="#a78bfa" />
      <Circle cx="66" cy="142" r="2" fill="#a78bfa" />
      <Circle cx="76" cy="142" r="2" fill="#a78bfa" />
      {/* drive folder (bottom-right) */}
      <Path d="M114 122 L130 122 L134 128 L154 128 Q158 128 158 132 L158 152 Q158 156 154 156 L114 156 Q110 156 110 152 L110 126 Q110 122 114 122 Z" fill="#fff" />
    </Svg>
  );
}

function IconPrivacy() {
  return (
    <Svg viewBox="0 0 200 200" width="100%" height="100%">
      <Defs>
        <LinearGradient id="shieldGrad" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#c4b5fd" />
          <Stop offset="1" stopColor="#7c3aed" />
        </LinearGradient>
      </Defs>
      <Path d="M100 30 L160 50 L160 100 Q160 145 100 175 Q40 145 40 100 L40 50 Z" fill="url(#shieldGrad)" />
      <Path d="M100 42 L150 58 L150 100 Q150 138 100 162 Q50 138 50 100 L50 58 Z" fill="#fff" opacity="0.18" />
      <Rect x="78" y="92" width="44" height="38" rx="6" fill="#fff" />
      <Path d="M86 92 L86 80 Q86 66 100 66 Q114 66 114 80 L114 92" stroke="#fff" strokeWidth="6" fill="none" strokeLinecap="round" />
      <Circle cx="100" cy="106" r="5" fill="#7c3aed" />
      <Rect x="98" y="108" width="4" height="12" fill="#7c3aed" />
    </Svg>
  );
}

function IconAI() {
  return (
    <Svg viewBox="0 0 200 200" width="100%" height="100%">
      <Defs>
        <LinearGradient id="aiGrad" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#a78bfa" />
          <Stop offset="1" stopColor="#5b21b6" />
        </LinearGradient>
      </Defs>
      <Path d="M100 32 Q108 78 132 86 Q108 94 100 140 Q92 94 68 86 Q92 78 100 32 Z" fill="url(#aiGrad)" />
      <Path d="M150 50 Q153 64 162 67 Q153 70 150 84 Q147 70 138 67 Q147 64 150 50 Z" fill="#c4b5fd" />
      <Path d="M52 130 Q54 140 62 142 Q54 144 52 154 Q50 144 42 142 Q50 140 52 130 Z" fill="#c4b5fd" />
      <Circle cx="100" cy="86" r="6" fill="#fff" opacity="0.7" />
    </Svg>
  );
}

function IconMultiDevice() {
  return (
    <Svg viewBox="0 0 200 200" width="100%" height="100%">
      {/* laptop screen */}
      <Rect x="30" y="55" width="120" height="78" rx="8" fill="#a78bfa" />
      <Rect x="38" y="63" width="104" height="62" rx="3" fill="#fff" />
      <Rect x="46" y="71" width="32" height="6" rx="2" fill="#a78bfa" />
      <Rect x="46" y="83" width="56" height="3" rx="1" fill="#c4b5fd" />
      <Rect x="46" y="91" width="48" height="3" rx="1" fill="#c4b5fd" />
      <Rect x="46" y="99" width="60" height="3" rx="1" fill="#c4b5fd" />
      <Rect x="46" y="108" width="20" height="10" rx="3" fill="#a78bfa" />
      <Rect x="80" y="108" width="26" height="10" rx="3" fill="#ddd6fe" />
      <Rect x="20" y="133" width="140" height="8" rx="2" fill="#7c3aed" />
      {/* phone overlapping */}
      <Rect x="118" y="78" width="56" height="92" rx="10" fill="#7c3aed" />
      <Rect x="124" y="86" width="44" height="76" rx="3" fill="#fff" />
      <Circle cx="146" cy="100" r="8" fill="#a78bfa" />
      <Rect x="130" y="115" width="32" height="3" rx="1" fill="#c4b5fd" />
      <Rect x="130" y="123" width="22" height="3" rx="1" fill="#c4b5fd" />
      <Rect x="130" y="135" width="32" height="10" rx="3" fill="#a78bfa" />
      <Rect x="130" y="148" width="26" height="8" rx="3" fill="#ddd6fe" />
      <Circle cx="146" cy="166" r="2.5" fill="#fff" opacity="0.6" />
    </Svg>
  );
}

const SLIDES = [
  { Icon: IconBrand,        titleKey: 'intro.brand.title',      subKey: 'intro.brand.sub',      strong: ['vida digital', 'app só'] },
  { Icon: IconAllInOne,     titleKey: 'intro.allInOne.title',   subKey: 'intro.allInOne.sub',   strong: ['Chat'] },
  { Icon: IconPrivacy,      titleKey: 'intro.privacy.title',    subKey: 'intro.privacy.sub',    strong: ['criptografia ponta-a-ponta'] },
  { Icon: IconAI,           titleKey: 'intro.ai.title',         subKey: 'intro.ai.sub',         strong: ['Chatyy AI'] },
  { Icon: IconMultiDevice,  titleKey: 'intro.multi.title',      subKey: 'intro.multi.sub',      strong: ['sincronizado em tempo real'] },
];

const FALLBACK_COPY = {
  'intro.brand.title':    'Chatyy',
  'intro.brand.sub':      'Sua **vida digital**,\nnum **app só**.',
  'intro.allInOne.title': 'Tudo em um app',
  'intro.allInOne.sub':   '**Chat**, e-mail, agenda, drive.\nSem trocar de aplicativo.',
  'intro.privacy.title':  'Privado de verdade',
  'intro.privacy.sub':    'Suas conversas com **criptografia ponta-a-ponta**.\nSó você lê.',
  'intro.ai.title':       'AI nativa',
  'intro.ai.sub':         'Resumos, traduções e respostas\ncom a **Chatyy AI**.',
  'intro.multi.title':    'Em todo dispositivo',
  'intro.multi.sub':      'Celular, tablet ou web —\n**sincronizado em tempo real**.',
};

// Render markdown-style **bold** as <Text fontWeight=700>
function RichText({ raw, baseStyle, strongStyle }) {
  const parts = useMemo(() => {
    const out = [];
    const re = /\*\*([^*]+)\*\*/g;
    let last = 0; let m;
    while ((m = re.exec(raw)) !== null) {
      if (m.index > last) out.push({ type: 'normal', text: raw.slice(last, m.index) });
      out.push({ type: 'strong', text: m[1] });
      last = re.lastIndex;
    }
    if (last < raw.length) out.push({ type: 'normal', text: raw.slice(last) });
    return out;
  }, [raw]);
  return (
    <Text style={baseStyle}>
      {parts.map((p, i) => p.type === 'strong'
        ? <Text key={i} style={strongStyle}>{p.text}</Text>
        : <Text key={i}>{p.text}</Text>)}
    </Text>
  );
}

export default function SignupIntro({ onFinish }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [idx, setIdx] = useState(0);
  const slideAnim = useRef(new Animated.Value(0)).current;

  const animateTo = (i) => {
    const clamped = Math.max(0, Math.min(SLIDES.length - 1, i));
    setIdx(clamped);
    try { Haptics.selectionAsync(); } catch {}
    Animated.spring(slideAnim, {
      toValue: -clamped * SCREEN_W,
      useNativeDriver: true,
      tension: 60,
      friction: 12,
    }).start();
  };

  const next = () => {
    if (idx < SLIDES.length - 1) animateTo(idx + 1);
    else onFinish?.();
  };

  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderRelease: (_, g) => {
      if (g.dx < -50 && idx < SLIDES.length - 1) animateTo(idx + 1);
      else if (g.dx > 50 && idx > 0) animateTo(idx - 1);
    },
  })).current;

  const isLast = idx === SLIDES.length - 1;
  const ctaLabel = isLast ? (t('intro.cta.start') || 'Começar') : (t('intro.cta.next') || 'Continuar');

  const _readCopy = (key) => {
    const v = t(key);
    if (v && v !== key) return v;
    return FALLBACK_COPY[key] || '';
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={{ flex: 1, overflow: 'hidden' }} {...pan.panHandlers}>
        <Animated.View style={{ flexDirection: 'row', width: SCREEN_W * SLIDES.length, height: '100%', transform: [{ translateX: slideAnim }] }}>
          {SLIDES.map((s, i) => (
            <View key={i} style={{ width: SCREEN_W, paddingHorizontal: 32, paddingTop: 60, alignItems: 'center' }}>
              <View style={{ width: 200, height: 200, marginBottom: 60, marginTop: 40 }}>
                <s.Icon />
              </View>
              <Text style={[styles.title, { color: colors.text }]}>
                {_readCopy(s.titleKey)}
              </Text>
              <RichText
                raw={_readCopy(s.subKey)}
                baseStyle={[styles.sub, { color: colors.textSecondary }]}
                strongStyle={[styles.sub, { color: colors.text, fontWeight: '700' }]}
              />
            </View>
          ))}
        </Animated.View>
      </View>

      <View style={styles.dotsRow}>
        {SLIDES.map((_, i) => (
          <View key={i} style={[styles.dot, { backgroundColor: i === idx ? '#a78bfa' : (isDark ? '#374151' : '#d1d5db') }]} />
        ))}
      </View>

      <View style={styles.ctaWrap}>
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={next}
          style={[styles.cta, {
            backgroundColor: '#a78bfa',
            ...(Platform.OS === 'web'
              ? { boxShadow: '0 4px 14px rgba(167,139,250,0.4)' }
              : Platform.select({
                  ios: { shadowColor: '#a78bfa', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 14 },
                  android: { elevation: 6 },
                })),
          }]}
        >
          <Text style={styles.ctaLabel}>{ctaLabel}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  title: { fontSize: 28, fontWeight: '700', letterSpacing: -0.5, marginBottom: 14, textAlign: 'center' },
  sub: { fontSize: 16, lineHeight: 22, textAlign: 'center', maxWidth: 300 },
  dotsRow: { flexDirection: 'row', gap: 8, justifyContent: 'center', paddingVertical: 28 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  ctaWrap: { paddingHorizontal: 32, paddingBottom: 32 },
  cta: { paddingVertical: 16, borderRadius: 28, alignItems: 'center' },
  ctaLabel: { color: '#fff', fontSize: 17, fontWeight: '600' },
});
