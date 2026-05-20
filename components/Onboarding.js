import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated, Platform, Easing,
  FlatList, useWindowDimensions,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import {
  IconMessageSquare, IconPlay, IconMail, IconShield,
} from './Icons';

const ONBOARDING_KEY = '@chatyy_onboarding_done';
const BRAND = '#7C3AED';

// React Native invariant: a regular FlatList cannot use `onScroll` with
// `useNativeDriver: true`. The list MUST be wrapped via
// Animated.createAnimatedComponent so the native side can hook the scroll
// event. Without this, iOS Release builds throw at first render of
// the onboarding modal — which (for users that haven't dismissed onboarding)
// surfaces as a crash on the Inbox screen since Onboarding renders inside it.
// Fix #1204 (2026-05-19): Apps→Email crash, root-cause via crash_report log.
const AnimatedFlatList = Animated.createAnimatedComponent(FlatList);

const SLIDES = [
  {
    key: 'chat',
    Icon: IconMessageSquare,
    titleKey: 'onboarding.slideChatTitle',
    descKey: 'onboarding.slideChatDesc',
    blob1: '#A78BFA',
    blob2: '#EC4899',
    blob3: '#6366F1',
  },
  {
    key: 'reels',
    Icon: IconPlay,
    titleKey: 'onboarding.slideReelsTitle',
    descKey: 'onboarding.slideReelsDesc',
    blob1: '#EC4899',
    blob2: '#7C3AED',
    blob3: '#F472B6',
  },
  {
    key: 'email',
    Icon: IconMail,
    titleKey: 'onboarding.slideEmailTitle',
    descKey: 'onboarding.slideEmailDesc',
    blob1: '#6366F1',
    blob2: '#A78BFA',
    blob3: '#7C3AED',
  },
  {
    key: 'privacy',
    Icon: IconShield,
    titleKey: 'onboarding.slidePrivacyTitle',
    descKey: 'onboarding.slidePrivacyDesc',
    blob1: '#7C3AED',
    blob2: '#6366F1',
    blob3: '#A78BFA',
  },
];

// Animated background blob — soft floating gradient mesh.
function Blob({ color, size, top, left, right, bottom, delay = 0 }) {
  const drift = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(drift, {
          toValue: 1,
          duration: 6000 + delay,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(drift, {
          toValue: 0,
          duration: 6000 + delay,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [drift, delay]);

  const tx = drift.interpolate({ inputRange: [0, 1], outputRange: [-18, 18] });
  const ty = drift.interpolate({ inputRange: [0, 1], outputRange: [12, -22] });
  const scale = drift.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.blob,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          top, left, right, bottom,
          transform: [{ translateX: tx }, { translateY: ty }, { scale }],
        },
        Platform.OS === 'web' && {
          filter: 'blur(80px)',
          WebkitFilter: 'blur(80px)',
          opacity: 0.55,
        },
      ]}
    />
  );
}

export default function Onboarding({ onDone }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [currentIndex, setCurrentIndex] = useState(0);
  const flatListRef = useRef(null);
  const scrollX = useRef(new Animated.Value(0)).current;
  const { width: SCREEN_WIDTH } = useWindowDimensions();
  const ctaScale = useRef(new Animated.Value(1)).current;

  const handleDone = useCallback(async () => {
    try {
      await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
    } catch {}
    onDone?.();
  }, [onDone]);

  const handleNext = useCallback(() => {
    if (currentIndex < SLIDES.length - 1) {
      flatListRef.current?.scrollToIndex({ index: currentIndex + 1, animated: true });
      setCurrentIndex(currentIndex + 1);
    } else {
      handleDone();
    }
  }, [currentIndex, handleDone]);

  const handleLogin = useCallback(async () => {
    try {
      await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
    } catch {}
    try {
      router.replace('/login');
    } catch {
      onDone?.();
    }
  }, [onDone]);

  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    if (viewableItems?.length > 0) {
      setCurrentIndex(viewableItems[0].index ?? 0);
    }
  }).current;

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 }).current;

  const isDesktop = Platform.OS === 'web' && SCREEN_WIDTH > 768;

  const renderSlide = ({ item, index }) => {
    const Icon = item.Icon;
    // Per-slide hero entrance animation tied to scrollX.
    const inputRange = [(index - 1) * SCREEN_WIDTH, index * SCREEN_WIDTH, (index + 1) * SCREEN_WIDTH];
    const heroScale = scrollX.interpolate({
      inputRange,
      outputRange: [0.82, 1, 0.82],
      extrapolate: 'clamp',
    });
    const heroOpacity = scrollX.interpolate({
      inputRange,
      outputRange: [0.3, 1, 0.3],
      extrapolate: 'clamp',
    });
    const textTranslate = scrollX.interpolate({
      inputRange,
      outputRange: [40, 0, -40],
      extrapolate: 'clamp',
    });

    return (
      <View style={[styles.slide, { width: SCREEN_WIDTH }]}>
        <View style={styles.slideContent}>
          <Animated.View
            style={[
              styles.heroWrap,
              isDesktop && styles.heroWrapDesktop,
              { transform: [{ scale: heroScale }], opacity: heroOpacity },
            ]}
          >
            <View
              style={[
                styles.heroOuter,
                isDesktop && styles.heroOuterDesktop,
                Platform.OS === 'web' && {
                  background: 'linear-gradient(135deg, rgba(255,255,255,0.18), rgba(255,255,255,0.06))',
                  backdropFilter: 'blur(20px)',
                  WebkitBackdropFilter: 'blur(20px)',
                  boxShadow: '0 24px 60px rgba(124, 58, 237, 0.35), inset 0 1px 0 rgba(255,255,255,0.4)',
                },
              ]}
            >
              <View
                style={[
                  styles.heroInner,
                  isDesktop && styles.heroInnerDesktop,
                  Platform.OS === 'web' && {
                    background: `linear-gradient(135deg, ${item.blob1}, ${item.blob2})`,
                    boxShadow: `0 16px 48px ${item.blob2}66`,
                  },
                  Platform.OS !== 'web' && { backgroundColor: item.blob2 },
                ]}
              >
                <Icon size={isDesktop ? 72 : 56} color="#fff" />
              </View>
            </View>
          </Animated.View>

          <Animated.Text
            style={[
              styles.title,
              isDesktop && styles.titleDesktop,
              { transform: [{ translateX: textTranslate }] },
            ]}
            accessibilityRole="header"
          >
            {t(item.titleKey)}
          </Animated.Text>
          <Animated.Text
            style={[
              styles.description,
              isDesktop && styles.descDesktop,
              { transform: [{ translateX: textTranslate }] },
            ]}
          >
            {t(item.descKey)}
          </Animated.Text>
        </View>
      </View>
    );
  };

  const isLast = currentIndex === SLIDES.length - 1;

  // CTA press animations — tactile 0.97 dip + snappy return.
  // Why 0.97 (not 0.96): subtler scale reads as confident-press on a primary
  // brand button; deeper scales feel like the surface is sticky. Spring is
  // friction=8 to land without overshoot.
  const onCtaPressIn = () => {
    Animated.spring(ctaScale, {
      toValue: 0.97,
      useNativeDriver: true,
      friction: 8,
      tension: 260,
    }).start();
  };
  const onCtaPressOut = () => {
    Animated.spring(ctaScale, {
      toValue: 1,
      useNativeDriver: true,
      friction: 6,
      tension: 220,
    }).start();
  };

  const baseBg = isDark ? '#0B0617' : '#FAF7FF';

  return (
    <View style={[styles.container, { backgroundColor: baseBg }]}>
      {/* Animated gradient mesh background — purple → pink → indigo */}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Blob color="#7C3AED" size={420} top={-120} left={-120} delay={0} />
        <Blob color="#EC4899" size={360} top={120} right={-140} delay={1200} />
        <Blob color="#6366F1" size={500} bottom={-180} left={-80} delay={2400} />
        <Blob color="#A78BFA" size={300} bottom={140} right={-60} delay={1800} />
      </View>

      {/* Skip glass pill top-right */}
      {!isLast && (
        <TouchableOpacity
          style={[
            styles.skipBtn,
            isDesktop && styles.skipBtnDesktop,
            Platform.OS === 'web' && {
              backdropFilter: 'blur(14px)',
              WebkitBackdropFilter: 'blur(14px)',
              background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.55)',
              boxShadow: '0 4px 16px rgba(124,58,237,0.18), inset 0 1px 0 rgba(255,255,255,0.5)',
            },
            Platform.OS !== 'web' && {
              backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.65)',
            },
          ]}
          onPress={handleDone}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel={t('onboarding.skip')}
        >
          <Text style={[styles.skipText, { color: isDark ? '#fff' : '#3B1F6B' }]}>
            {t('onboarding.skip')}
          </Text>
        </TouchableOpacity>
      )}

      <AnimatedFlatList
        ref={flatListRef}
        data={SLIDES}
        renderItem={renderSlide}
        keyExtractor={item => item.key}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], { useNativeDriver: true })}
        scrollEventThrottle={16}
        bounces={false}
        getItemLayout={(_, index) => ({
          length: SCREEN_WIDTH,
          offset: SCREEN_WIDTH * index,
          index,
        })}
        style={styles.flatList}
      />

      {/* Progress bar — smooth fill driven by scrollX (replaces dot indicators).
          Why: dots feel dated; a progressive bar gives clear "you're 60% through"
          feedback during scroll, scales gracefully with slide count, and the
          gradient mirrors the CTA so the eye links progress → action. */}
      <View style={[styles.progressTrack, isDesktop && styles.progressTrackDesktop, {
        backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(60,30,100,0.10)',
      }]}
      >
        <Animated.View
          style={[
            styles.progressFill,
            {
              width: scrollX.interpolate({
                inputRange: [0, Math.max(1, (SLIDES.length - 1) * SCREEN_WIDTH)],
                outputRange: ['18%', '100%'],
                extrapolate: 'clamp',
              }),
            },
            Platform.OS === 'web' && {
              background: `linear-gradient(90deg, ${BRAND}, #A78BFA)`,
              boxShadow: `0 1px 8px ${BRAND}66`,
            },
            Platform.OS !== 'web' && { backgroundColor: BRAND },
          ]}
        />
      </View>
      <View style={styles.progressLabelRow}>
        <Text style={[styles.progressLabel, { color: isDark ? 'rgba(255,255,255,0.65)' : 'rgba(60,30,100,0.65)' }]}>
          {Math.min(currentIndex + 1, SLIDES.length)} / {SLIDES.length}
        </Text>
      </View>

      {/* Primary CTA — purple gradient pill, full width, glow */}
      <View style={[styles.ctaWrap, isDesktop && styles.ctaWrapDesktop]}>
        <Animated.View style={{ transform: [{ scale: ctaScale }], width: '100%' }}>
          <TouchableOpacity
            onPress={handleNext}
            onPressIn={onCtaPressIn}
            onPressOut={onCtaPressOut}
            activeOpacity={0.9}
            accessibilityRole="button"
            accessibilityLabel={isLast ? t('onboarding.start') : t('onboarding.next')}
            style={[
              styles.cta,
              Platform.OS === 'web' && {
                background: `linear-gradient(135deg, ${BRAND} 0%, #9333EA 50%, #A78BFA 100%)`,
                boxShadow: `0 12px 32px ${BRAND}66, 0 4px 12px ${BRAND}44, inset 0 1px 0 rgba(255,255,255,0.35)`,
                transition: 'transform 0.18s ease',
              },
              Platform.OS !== 'web' && {
                backgroundColor: BRAND,
                shadowColor: BRAND,
                shadowOffset: { width: 0, height: 8 },
                shadowOpacity: 0.45,
                shadowRadius: 20,
                elevation: 12,
              },
            ]}
          >
            <Text style={styles.ctaText}>
              {isLast ? t('onboarding.start') : t('onboarding.next')}
            </Text>
          </TouchableOpacity>
        </Animated.View>

        {/* "Já tem conta? Entrar" subtle bottom link */}
        <TouchableOpacity
          onPress={handleLogin}
          activeOpacity={0.6}
          style={styles.loginLinkBtn}
          accessibilityRole="link"
          accessibilityLabel={t('onboarding.haveAccount')}
        >
          <Text
            style={[
              styles.loginLinkText,
              { color: isDark ? 'rgba(255,255,255,0.55)' : 'rgba(60,30,100,0.55)' },
            ]}
          >
            {t('onboarding.haveAccount')}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export { ONBOARDING_KEY };

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
    ...Platform.select({
      web: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999 },
    }),
  },
  blob: {
    position: 'absolute',
  },
  flatList: {
    flexGrow: 0,
  },
  skipBtn: {
    position: 'absolute',
    top: 60,
    right: 24,
    zIndex: 10,
    paddingVertical: 9,
    paddingHorizontal: 18,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  skipBtnDesktop: {
    top: 32,
    right: 40,
    paddingVertical: 11,
    paddingHorizontal: 22,
  },
  skipText: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  slide: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  slideContent: {
    alignItems: 'center',
    maxWidth: 520,
    width: '100%',
  },
  heroWrap: {
    marginBottom: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroWrapDesktop: {
    marginBottom: 56,
  },
  heroOuter: {
    width: 200,
    height: 200,
    borderRadius: 100,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  heroOuterDesktop: {
    width: 240,
    height: 240,
    borderRadius: 120,
    padding: 18,
  },
  heroInner: {
    flex: 1,
    width: '100%',
    borderRadius: 100,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroInnerDesktop: {
    borderRadius: 120,
  },
  title: {
    fontSize: 32,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 14,
    letterSpacing: -0.7,
    color: '#1A0938',
    ...Platform.select({
      web: {
        fontFamily: '"Segoe UI", system-ui, -apple-system, sans-serif',
        backgroundImage: `linear-gradient(135deg, #1A0938 0%, ${BRAND} 100%)`,
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
      },
    }),
  },
  titleDesktop: {
    fontSize: 44,
    marginBottom: 18,
  },
  description: {
    fontSize: 17,
    textAlign: 'center',
    lineHeight: 25,
    maxWidth: 380,
    fontWeight: '500',
    color: 'rgba(40,20,70,0.72)',
  },
  descDesktop: {
    fontSize: 19,
    lineHeight: 30,
    maxWidth: 460,
  },
  // Progressive bar (replaces dot indicators).
  progressTrack: {
    height: 4,
    borderRadius: 3,
    marginHorizontal: 56,
    marginBottom: 8,
    overflow: 'hidden',
  },
  progressTrackDesktop: {
    height: 5,
    marginHorizontal: 'auto',
    width: 320,
    marginBottom: 10,
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
  },
  progressLabelRow: {
    alignItems: 'center',
    marginBottom: 18,
  },
  progressLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  ctaWrap: {
    width: '100%',
    paddingHorizontal: 28,
    paddingBottom: 40,
    alignItems: 'center',
  },
  ctaWrapDesktop: {
    paddingBottom: 48,
    maxWidth: 460,
    alignSelf: 'center',
  },
  cta: {
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
  },
  ctaText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  loginLinkBtn: {
    marginTop: 18,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  loginLinkText: {
    fontSize: 14,
    fontWeight: '500',
    letterSpacing: 0.2,
  },
});
