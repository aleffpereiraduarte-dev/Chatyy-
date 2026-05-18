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
import { useState, useRef, useMemo, useEffect } from 'react';
import { View, Text, TouchableOpacity, Pressable, Animated, Dimensions, PanResponder, StyleSheet, Platform, StatusBar } from 'react-native';
import Svg, { Path, Rect, Circle, Line, Defs, LinearGradient, Stop, Ellipse, G } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as Haptics from 'expo-haptics';

const { width: SCREEN_W } = Dimensions.get('window');

// ─── 5 slide illustrations (mirrors /mockups/telegram-clean.html SVGs) ───

function IconBrand() {
  return (
    <Svg viewBox="0 0 200 200" width="100%" height="100%" fill="none">
      <Defs>
        <LinearGradient id="brandGrad" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#c4b5fd" />
          <Stop offset="1" stopColor="#7c3aed" />
        </LinearGradient>
      </Defs>
      <Circle cx="100" cy="100" r="94" stroke="#ede9fe" strokeWidth="2" />
      <Circle cx="100" cy="100" r="76" fill="url(#brandGrad)" />
      <Path d="M68 88 Q68 76 80 76 L120 76 Q132 76 132 88 L132 110 Q132 122 120 122 L96 122 L84 134 L84 122 L80 122 Q68 122 68 110 Z" stroke="#fff" strokeWidth="3.5" strokeLinejoin="round" />
      <Circle cx="86" cy="100" r="3" fill="#fff" />
      <Circle cx="100" cy="100" r="3" fill="#fff" />
      <Circle cx="114" cy="100" r="3" fill="#fff" />
      <Path d="M154 50 L156 56 L162 58 L156 60 L154 66 L152 60 L146 58 L152 56 Z" fill="#a78bfa" />
    </Svg>
  );
}

function IconAllInOne() {
  return (
    <Svg viewBox="0 0 200 200" width="100%" height="100%" fill="none" strokeLinecap="round" strokeLinejoin="round">
      {/* chat (top-left) — purple filled */}
      <G transform="translate(40, 38)">
        <Rect width="56" height="56" rx="16" fill="#7c3aed" />
        <Path d="M16 22 Q16 18 20 18 L36 18 Q40 18 40 22 L40 32 Q40 36 36 36 L26 36 L20 41 L20 36 Q16 36 16 32 Z" stroke="#fff" strokeWidth="2.5" />
      </G>
      {/* mail (top-right) — outline */}
      <G transform="translate(104, 38)">
        <Rect width="56" height="56" rx="16" fill="#f5f3ff" stroke="#ede9fe" strokeWidth="1" />
        <Rect x="14" y="20" width="28" height="20" rx="3" stroke="#7c3aed" strokeWidth="2.5" />
        <Path d="M14 22 L28 31 L42 22" stroke="#7c3aed" strokeWidth="2.5" />
      </G>
      {/* calendar (bottom-left) — outline */}
      <G transform="translate(40, 104)">
        <Rect width="56" height="56" rx="16" fill="#f5f3ff" stroke="#ede9fe" strokeWidth="1" />
        <Rect x="14" y="18" width="28" height="22" rx="3" stroke="#7c3aed" strokeWidth="2.5" />
        <Line x1="14" y1="25" x2="42" y2="25" stroke="#7c3aed" strokeWidth="2.5" />
        <Circle cx="22" cy="32" r="1.5" fill="#7c3aed" />
        <Circle cx="28" cy="32" r="1.5" fill="#7c3aed" />
        <Circle cx="34" cy="32" r="1.5" fill="#7c3aed" />
        <Line x1="20" y1="14" x2="20" y2="20" stroke="#7c3aed" strokeWidth="2.5" />
        <Line x1="36" y1="14" x2="36" y2="20" stroke="#7c3aed" strokeWidth="2.5" />
      </G>
      {/* drive folder (bottom-right) — purple filled */}
      <G transform="translate(104, 104)">
        <Rect width="56" height="56" rx="16" fill="#a78bfa" />
        <Path d="M14 22 L24 22 L28 26 L42 26 Q44 26 44 28 L44 38 Q44 40 42 40 L14 40 Q12 40 12 38 L12 24 Q12 22 14 22 Z" stroke="#fff" strokeWidth="2.5" />
      </G>
    </Svg>
  );
}

function IconPrivacy() {
  return (
    <Svg viewBox="0 0 200 200" width="100%" height="100%" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <Defs>
        <LinearGradient id="shieldGrad" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#ede9fe" />
          <Stop offset="1" stopColor="#c4b5fd" />
        </LinearGradient>
      </Defs>
      <Path d="M100 28 L160 50 L160 100 Q160 148 100 178 Q40 148 40 100 L40 50 Z" fill="url(#shieldGrad)" stroke="#7c3aed" strokeWidth="3" />
      <Path d="M100 50 L138 64 L138 100 Q138 134 100 156 Q62 134 62 100 L62 64 Z" stroke="#a78bfa" strokeWidth="2" strokeDasharray="2 4" />
      <Path d="M76 102 L92 118 L126 86" stroke="#7c3aed" strokeWidth="6" />
    </Svg>
  );
}

function IconAI() {
  return (
    <Svg viewBox="0 0 200 200" width="100%" height="100%" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <Defs>
        <LinearGradient id="aiGrad" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#c4b5fd" />
          <Stop offset="1" stopColor="#7c3aed" />
        </LinearGradient>
      </Defs>
      <Path d="M100 36 Q104 84 132 88 Q104 92 100 140 Q96 92 68 88 Q96 84 100 36 Z" fill="url(#aiGrad)" />
      <Circle cx="100" cy="88" r="3" fill="#fff" opacity="0.85" />
      <Path d="M148 56 Q150 64 158 66 Q150 68 148 76 Q146 68 138 66 Q146 64 148 56 Z" fill="#a78bfa" />
      <Path d="M52 134 Q54 142 62 144 Q54 146 52 154 Q50 146 42 144 Q50 142 52 134 Z" fill="#c4b5fd" />
      <Circle cx="160" cy="116" r="2" fill="#a78bfa" />
      <Circle cx="38" cy="78" r="2" fill="#c4b5fd" />
    </Svg>
  );
}

function IconMultiDevice() {
  return (
    <Svg viewBox="0 0 200 200" width="100%" height="100%" fill="none" strokeLinecap="round" strokeLinejoin="round">
      {/* laptop body — outline */}
      <Rect x="34" y="58" width="116" height="74" rx="6" fill="#fff" stroke="#7c3aed" strokeWidth="3" />
      {/* screen content lines */}
      <Rect x="46" y="70" width="34" height="6" rx="3" fill="#a78bfa" />
      <Rect x="46" y="82" width="60" height="3" rx="1.5" fill="#ddd6fe" />
      <Rect x="46" y="89" width="50" height="3" rx="1.5" fill="#ddd6fe" />
      <Rect x="46" y="96" width="64" height="3" rx="1.5" fill="#ddd6fe" />
      <Rect x="46" y="106" width="22" height="10" rx="3" fill="#a78bfa" />
      <Rect x="74" y="106" width="32" height="10" rx="3" fill="#ede9fe" />
      {/* laptop base */}
      <Rect x="22" y="138" width="140" height="8" rx="3" fill="#a78bfa" />
      {/* phone overlapping right */}
      <Rect x="120" y="76" width="50" height="92" rx="10" fill="#fff" stroke="#7c3aed" strokeWidth="3" />
      <Line x1="138" y1="84" x2="152" y2="84" stroke="#a78bfa" strokeWidth="2" />
      <Circle cx="145" cy="100" r="8" fill="none" stroke="#a78bfa" strokeWidth="2" />
      <Rect x="128" y="116" width="34" height="3" rx="1.5" fill="#ddd6fe" />
      <Rect x="128" y="124" width="24" height="3" rx="1.5" fill="#ddd6fe" />
      <Rect x="128" y="136" width="34" height="9" rx="3" fill="#a78bfa" />
      <Rect x="128" y="148" width="26" height="9" rx="3" fill="#ede9fe" />
      <Line x1="138" y1="162" x2="152" y2="162" stroke="#a78bfa" strokeWidth="2" />
      {/* sync arrows */}
      <Path d="M178 110 Q186 118 178 126" stroke="#a78bfa" strokeWidth="2" />
      <Path d="M22 110 Q14 118 22 126" stroke="#a78bfa" strokeWidth="2" />
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
  const insets = useSafeAreaInsets();
  const [idx, setIdx] = useState(0);
  const slideAnim = useRef(new Animated.Value(0)).current;
  // Android: StatusBar.currentHeight is the system-bar (status bar) height.
  // useSafeAreaInsets handles iOS notch / Dynamic Island automatically.
  // Combine both with a sane minimum so the orb never sits behind the
  // camera punch-hole on phones like Pixel/Samsung center-notch.
  const topPad = Math.max(insets.top, Platform.OS === 'android' ? (StatusBar.currentHeight || 24) : 0, 24);
  const botPad = Math.max(insets.bottom, 16);

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
  // t() returns the key literal when the key isn't found in the bundle,
  // so the simple `|| fallback` short-circuit fails (the literal is truthy).
  // Compare value !== key to detect missing translation and fall through.
  const _ctaNext = t('intro.cta.next');
  const _ctaStart = t('intro.cta.start');
  const ctaLabel = isLast
    ? ((_ctaStart && _ctaStart !== 'intro.cta.start') ? _ctaStart : 'Começar')
    : ((_ctaNext && _ctaNext !== 'intro.cta.next') ? _ctaNext : 'Continuar');

  const _readCopy = (key) => {
    const v = t(key);
    if (v && v !== key) return v;
    return FALLBACK_COPY[key] || '';
  };

  // Skip button label — i18n with fallback
  const _skip = t('intro.cta.skip');
  const skipLabel = (_skip && _skip !== 'intro.cta.skip') ? _skip : 'Pular';

  // Container fade — subtle wash-in on first mount, wash-out on finish.
  // Telegram polish: don't snap-flip the carousel away when "Começar" hits.
  const containerFade = useRef(new Animated.Value(1)).current;
  const finishWithFade = () => {
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
    Animated.timing(containerFade, {
      toValue: 0, duration: 220, useNativeDriver: true,
    }).start(() => onFinish?.());
  };
  const handleNext = () => {
    if (idx < SLIDES.length - 1) animateTo(idx + 1);
    else finishWithFade();
  };

  return (
    <Animated.View style={[styles.root, { backgroundColor: colors.background, paddingTop: topPad, paddingBottom: botPad, opacity: containerFade }]}>
      {/* Skip button — top right, only shown before the last slide.
          Telegram-style: cheap escape hatch for returning users. */}
      {!isLast && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={skipLabel}
          onPress={finishWithFade}
          style={({ pressed }) => [styles.skipBtn, { top: topPad + 4, opacity: pressed ? 0.5 : 1 }]}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={[styles.skipLabel, { color: isDark ? '#9ca3af' : '#6b7280' }]}>{skipLabel}</Text>
        </Pressable>
      )}

      <View style={{ flex: 1, overflow: 'hidden' }} {...pan.panHandlers}>
        <Animated.View style={{ flexDirection: 'row', width: SCREEN_W * SLIDES.length, height: '100%', transform: [{ translateX: slideAnim }] }}>
          {SLIDES.map((s, i) => {
            // Per-slide opacity: brighten only the centered slide, dim
            // peeking edges. Adds depth without parallax cost.
            const inputRange = [-(i + 1) * SCREEN_W, -i * SCREEN_W, -(i - 1) * SCREEN_W];
            const slideOpacity = slideAnim.interpolate({
              inputRange, outputRange: [0.55, 1, 0.55], extrapolate: 'clamp',
            });
            const slideScale = slideAnim.interpolate({
              inputRange, outputRange: [0.94, 1, 0.94], extrapolate: 'clamp',
            });
            return (
              <Animated.View key={i} style={{ width: SCREEN_W, paddingHorizontal: 32, paddingTop: 20, alignItems: 'center', opacity: slideOpacity, transform: [{ scale: slideScale }] }}>
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
              </Animated.View>
            );
          })}
        </Animated.View>
      </View>

      {/* Dots — animated active dot grows wider (Telegram pattern).
          Each dot has its own Animated.Value that interpolates width 8→24
          and opacity 0.4→1 between idle and active state, springing on
          slide change. Tapping a dot jumps to that slide. */}
      <View style={styles.dotsRow}>
        {SLIDES.map((_, i) => {
          const isActive = i === idx;
          // eslint-disable-next-line react-hooks/rules-of-hooks
          const dotAnim = useRef(new Animated.Value(isActive ? 1 : 0)).current;
          // eslint-disable-next-line react-hooks/rules-of-hooks
          useEffect(() => {
            Animated.spring(dotAnim, {
              toValue: isActive ? 1 : 0,
              tension: 80, friction: 12,
              useNativeDriver: false,
            }).start();
          }, [isActive, dotAnim]);
          const widthInterp = dotAnim.interpolate({ inputRange: [0, 1], outputRange: [8, 24] });
          const opacityInterp = dotAnim.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] });
          return (
            <TouchableOpacity
              key={i}
              activeOpacity={0.7}
              onPress={() => animateTo(i)}
              hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
            >
              <Animated.View style={[styles.dot, {
                backgroundColor: isActive ? '#7c3aed' : (isDark ? '#374151' : '#d1d5db'),
                width: widthInterp,
                opacity: opacityInterp,
              }]} />
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={styles.ctaWrap}>
        {(() => {
          // Press-spring: scale 1→0.95 on pressIn, back to 1 on pressOut.
          // Matches iOS-native button "tap" feel (Telegram/iMessage pattern).
          const ctaScale = useRef(new Animated.Value(1)).current;
          const _pressIn = () => Animated.spring(ctaScale, { toValue: 0.95, tension: 220, friction: 10, useNativeDriver: true }).start();
          const _pressOut = () => Animated.spring(ctaScale, { toValue: 1, tension: 220, friction: 10, useNativeDriver: true }).start();
          return (
            <Animated.View style={{ transform: [{ scale: ctaScale }] }}>
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={handleNext}
                onPressIn={_pressIn}
                onPressOut={_pressOut}
                style={[styles.cta, {
                  // Saturated brand purple — mockup matches `#7c3aed`. The previous
                  // washed `#a78bfa` looked anemic next to the bold typography.
                  backgroundColor: '#7c3aed',
                  ...(Platform.OS === 'web'
                    ? { boxShadow: '0 8px 24px rgba(124,58,237,0.42), inset 0 1px 0 rgba(255,255,255,0.18)' }
                    : Platform.select({
                        ios: { shadowColor: '#7c3aed', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.42, shadowRadius: 18 },
                        android: { elevation: 8 },
                      })),
                }]}
              >
                <Text style={styles.ctaLabel}>{ctaLabel}</Text>
              </TouchableOpacity>
            </Animated.View>
          );
        })()}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  title: { fontSize: 28, fontWeight: '700', letterSpacing: -0.5, marginBottom: 14, textAlign: 'center' },
  sub: { fontSize: 16, lineHeight: 22, textAlign: 'center', maxWidth: 300 },
  dotsRow: { flexDirection: 'row', gap: 6, justifyContent: 'center', paddingVertical: 28, alignItems: 'center' },
  dot: { height: 8, borderRadius: 4 },
  ctaWrap: { paddingHorizontal: 32, paddingBottom: 32 },
  cta: { paddingVertical: 17, borderRadius: 28, alignItems: 'center' },
  ctaLabel: { color: '#fff', fontSize: 17, fontWeight: '700', letterSpacing: 0.2 },
  skipBtn: { position: 'absolute', right: 18, zIndex: 10, paddingHorizontal: 8, paddingVertical: 6 },
  skipLabel: { fontSize: 15, fontWeight: '600', letterSpacing: 0.1 },
});
