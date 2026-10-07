/**
 * SignupIntro — pre-login WELCOME screen. [2026-10-07 welcome]
 *
 * One clean screen: brand mark + one-line value prop, with "Começar" and
 * "Já tenho conta" ALWAYS visible at the bottom. The hero area is an optional
 * swipeable carousel (brand → chat → calls → e-mail/drive) — nobody is forced
 * through slides; a single tap on either button leaves.
 *
 * Rewritten 2026-10-07 (was a 5-slide gate whose last slide was the only exit,
 * claimed "criptografia ponta-a-ponta" while E2EE is flag-off, used hardcoded
 * light-only SVG colors and called hooks inside .map()).
 *
 * Contract (unchanged for callers app/login.js + app/signup-phone.js):
 *   <SignupIntro onFinish={fn} />  — fn({ mode: 'signup' | 'login' })
 * Callers that ignore the argument keep working (both buttons lead to the
 * phone form, which handles new AND existing numbers). Optional `onLogin`
 * overrides the "Já tenho conta" action.
 *
 * Never shown again: `chatyy_intro_seen` is persisted here on exit (callers
 * persist it too), and services/firstRun.js sets it after any login.
 * Reduced motion: entrance + slide fades are skipped.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, Pressable, Animated, ScrollView, StyleSheet, Platform, StatusBar,
  useWindowDimensions, Easing,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useReducedMotion } from './reducedMotion';
import { useOnbCopy } from './onboarding/copy';
import { BrandMark, ChatArt, CallsArt, MailDriveArt } from './onboarding/illustrations';

const SLIDES = [
  { key: 'brand' },
  { key: 'chat', Art: ChatArt, title: 'welcome.s1.title', sub: 'welcome.s1.sub' },
  { key: 'calls', Art: CallsArt, title: 'welcome.s2.title', sub: 'welcome.s2.sub' },
  { key: 'mail', Art: MailDriveArt, title: 'welcome.s3.title', sub: 'welcome.s3.sub' },
];

function _haptic() {
  if (Platform.OS === 'web') return;
  try { require('expo-haptics').selectionAsync(); } catch {}
}

function _markSeen() {
  try { AsyncStorage.setItem('chatyy_intro_seen', '1').catch(() => {}); } catch {}
}

export default function SignupIntro({ onFinish, onLogin }) {
  const { isDark } = useTheme();
  const c = useOnbCopy();
  const reduceMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { width: winW } = useWindowDimensions();
  const [idx, setIdx] = useState(0);
  const idxRef = useRef(0);
  const scrollRef = useRef(null);
  const leavingRef = useRef(false);

  // Pure black & white palette (follows the theme, independent of accent).
  const fg = isDark ? '#ffffff' : '#111111';
  const bg = isDark ? '#000000' : '#ffffff';
  const sub = isDark ? 'rgba(255,255,255,0.62)' : 'rgba(17,17,17,0.6)';
  const muted = isDark ? '#1c1c1e' : '#F1F2F4';

  const topPad = Math.max(insets.top, Platform.OS === 'android' ? (StatusBar.currentHeight || 24) : 0, 20);
  const botPad = Math.max(insets.bottom, 16);
  const pageW = Math.max(1, winW);

  // Entrance: fade + 12px rise. Skipped entirely under Reduce Motion.
  const enter = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  const fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reduceMotion) { enter.setValue(1); return; }
    Animated.timing(enter, { toValue: 1, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }).start();
  }, [reduceMotion, enter]);

  const onScroll = useCallback((e) => {
    const x = e?.nativeEvent?.contentOffset?.x || 0;
    const i = Math.max(0, Math.min(SLIDES.length - 1, Math.round(x / pageW)));
    if (idxRef.current !== i) {
      idxRef.current = i;
      _haptic();
      setIdx(i);
    }
  }, [pageW]);

  const goTo = useCallback((i) => {
    try { scrollRef.current?.scrollTo({ x: i * pageW, animated: !reduceMotion }); } catch {}
    idxRef.current = i;
    setIdx(i);
  }, [pageW, reduceMotion]);

  const leave = useCallback((mode) => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    _markSeen();
    if (Platform.OS !== 'web') {
      try { require('expo-haptics').impactAsync(require('expo-haptics').ImpactFeedbackStyle.Light); } catch {}
    }
    const done = () => {
      if (mode === 'login' && typeof onLogin === 'function') onLogin();
      else onFinish?.({ mode });
    };
    if (reduceMotion) { done(); return; }
    Animated.timing(fade, { toValue: 0, duration: 180, useNativeDriver: Platform.OS !== 'web' }).start(() => done());
  }, [onFinish, onLogin, fade, reduceMotion]);

  const translateY = enter.interpolate({ inputRange: [0, 1], outputRange: [12, 0] });

  return (
    <Animated.View style={[st.root, { backgroundColor: bg, paddingTop: topPad, paddingBottom: botPad, opacity: fade }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <Animated.View style={{ flex: 1, opacity: enter, transform: [{ translateY }] }}>
        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onScroll={onScroll}
          scrollEventThrottle={32}
          style={{ flex: 1 }}
          contentContainerStyle={{ alignItems: 'stretch' }}
          accessibilityRole="adjustable"
        >
          {SLIDES.map((s) => (
            <View key={s.key} style={[st.page, { width: pageW }]}>
              {s.key === 'brand' ? (
                <View style={st.brandWrap}>
                  <BrandMark size={92} fg={fg} bg={bg} />
                  <Text style={[st.wordmark, { color: fg }]} accessibilityRole="header" maxFontSizeMultiplier={1.4}>Chatyy</Text>
                  <Text style={[st.value, { color: sub }]} maxFontSizeMultiplier={1.5}>{c('welcome.value')}</Text>
                </View>
              ) : (
                <View style={st.slideWrap}>
                  <View style={st.art}><s.Art size={208} fg={fg} bg={bg} muted={muted} /></View>
                  <Text style={[st.title, { color: fg }]} accessibilityRole="header" maxFontSizeMultiplier={1.4}>{c(s.title)}</Text>
                  <Text style={[st.sub, { color: sub }]} maxFontSizeMultiplier={1.5}>{c(s.sub)}</Text>
                </View>
              )}
            </View>
          ))}
        </ScrollView>

        {/* Dots + swipe hint (hint only on the brand page). */}
        <View style={st.dotsRow}>
          {SLIDES.map((s, i) => (
            <Pressable
              key={s.key}
              onPress={() => goTo(i)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`${i + 1}/${SLIDES.length}`}
              accessibilityState={{ selected: i === idx }}
            >
              <View style={[st.dot, { width: i === idx ? 20 : 6, backgroundColor: fg, opacity: i === idx ? 1 : 0.22 }]} />
            </Pressable>
          ))}
        </View>
        <View style={st.hintRow}>
          {idx === 0 ? (
            <Pressable onPress={() => goTo(1)} hitSlop={10} style={st.hint} accessibilityRole="button">
              <Text style={[st.hintText, { color: sub }]}>{c('welcome.swipeHint')}</Text>
              <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={sub} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <Path d="M9 6l6 6-6 6" />
              </Svg>
            </Pressable>
          ) : null}
        </View>
      </Animated.View>

      <View style={st.ctaCol}>
        <Pressable
          onPress={() => leave('signup')}
          style={({ pressed }) => [st.primary, { backgroundColor: fg, opacity: pressed ? 0.86 : 1, transform: [{ scale: pressed && !reduceMotion ? 0.98 : 1 }] }]}
          accessibilityRole="button"
          accessibilityLabel={c('welcome.start')}
        >
          <Text style={[st.primaryText, { color: bg }]} maxFontSizeMultiplier={1.3}>{c('welcome.start')}</Text>
        </Pressable>
        <Pressable
          onPress={() => leave('login')}
          style={({ pressed }) => [st.secondary, { opacity: pressed ? 0.55 : 1 }]}
          accessibilityRole="button"
          accessibilityLabel={c('welcome.haveAccount')}
          hitSlop={6}
        >
          <Text style={[st.secondaryText, { color: fg }]} maxFontSizeMultiplier={1.3}>{c('welcome.haveAccount')}</Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1 },
  page: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  brandWrap: { alignItems: 'center', maxWidth: 420 },
  wordmark: { fontSize: 40, fontWeight: '800', letterSpacing: -1.2, marginTop: 22 },
  value: { fontSize: 17, lineHeight: 24, textAlign: 'center', marginTop: 10 },
  slideWrap: { alignItems: 'center', maxWidth: 420 },
  art: { width: 208, height: 208, marginBottom: 30 },
  title: { fontSize: 26, fontWeight: '800', letterSpacing: -0.6, textAlign: 'center' },
  sub: { fontSize: 16, lineHeight: 22, textAlign: 'center', marginTop: 10, maxWidth: 320 },
  dotsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingTop: 8, height: 26 },
  dot: { height: 6, borderRadius: 3 },
  hintRow: { height: 34, alignItems: 'center', justifyContent: 'center' },
  hint: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 10 },
  hintText: { fontSize: 13, fontWeight: '600' },
  ctaCol: { paddingHorizontal: 24, paddingTop: 8, alignItems: 'stretch', alignSelf: 'center', width: '100%', maxWidth: 460 },
  primary: { minHeight: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontSize: 17, fontWeight: '700', letterSpacing: 0.1 },
  secondary: { minHeight: 50, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  secondaryText: { fontSize: 16, fontWeight: '600' },
});
