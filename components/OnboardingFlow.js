import { useRef, useState, useCallback, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Dimensions,
  ScrollView, Animated, Platform, useWindowDimensions,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconMailLogo, IconMessageSquare, IconCloud, IconCheck } from './Icons';

const PAGES = 4;

// Gradient backgrounds per slide
const SLIDE_THEMES = [
  { bg: ['#6366f1', '#8b5cf6'], accent: '#a78bfa' },
  { bg: ['#059669', '#10b981'], accent: '#34d399' },
  { bg: ['#2563eb', '#3b82f6'], accent: '#60a5fa' },
  { bg: ['#d97706', '#f59e0b'], accent: '#fbbf24' },
];

export default function OnboardingFlow({ visible, onFinish }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const scrollRef = useRef(null);
  const [current, setCurrent] = useState(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const scaleAnim = useRef(new Animated.Value(0.9)).current;
  const { width, height } = useWindowDimensions();

  // Entrance animation
  useEffect(() => {
    if (visible) {
      scaleAnim.setValue(0.9);
      fadeAnim.setValue(0);
      Animated.parallel([
        Animated.spring(scaleAnim, { toValue: 1, tension: 60, friction: 10, useNativeDriver: true }),
        Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
      ]).start();
    }
  }, [visible]);

  const handleScroll = useCallback((e) => {
    const page = Math.round(e.nativeEvent.contentOffset.x / width);
    if (page !== current && page >= 0 && page < PAGES) setCurrent(page);
  }, [current, width]);

  const handleFinish = useCallback(async () => {
    try {
      await AsyncStorage.setItem('onboarding_complete', '1');
    } catch (_) {}
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 0, duration: 300, useNativeDriver: true }),
      Animated.timing(scaleAnim, { toValue: 1.05, duration: 300, useNativeDriver: true }),
    ]).start(() => {
      if (onFinish) onFinish();
    });
  }, [onFinish, fadeAnim, scaleAnim]);

  const goToPage = useCallback((page) => {
    if (page < 0 || page >= PAGES) return;
    // React Native Web doesn't reliably fire onMomentumScrollEnd for
    // programmatic scrollTo, so clicking the arrow used to scroll but
    // never update `current` — the user saw the same slide content + the
    // arrow didn't feel responsive. Update the state immediately; the
    // subsequent onScroll event is idempotent.
    setCurrent(page);
    scrollRef.current?.scrollTo({ x: page * width, animated: true });
  }, [width]);

  if (!visible) return null;

  const isDesktop = Platform.OS === 'web' && width > 768;
  const iconSize = isDesktop ? 96 : 80;
  const circleSize = isDesktop ? 200 : 160;

  const screens = [
    {
      icon: <IconMailLogo size={iconSize} color="#fff" />,
      title: t('onboarding.welcome'),
      desc: t('onboarding.tagline'),
    },
    {
      icon: <IconMessageSquare size={iconSize} color="#fff" />,
      title: t('onboarding.chatTitle'),
      desc: t('onboarding.chatDesc'),
    },
    {
      icon: <IconCloud size={iconSize} color="#fff" />,
      title: t('onboarding.photosTitle'),
      desc: t('onboarding.photosDesc'),
    },
    {
      icon: <IconCheck size={iconSize} color="#fff" />,
      title: t('onboarding.readyTitle'),
      desc: t('onboarding.readyDesc'),
    },
  ];

  const theme = SLIDE_THEMES[current] || SLIDE_THEMES[0];

  return (
    <Animated.View style={[
      s.overlay,
      {
        opacity: fadeAnim,
        transform: [{ scale: scaleAnim }],
      },
      Platform.OS === 'web' && {
        background: `linear-gradient(135deg, ${theme.bg[0]}, ${theme.bg[1]})`,
        transition: 'background 0.5s ease',
      },
      Platform.OS !== 'web' && { backgroundColor: theme.bg[0] },
    ]}>
      {/* Skip button */}
      {current < PAGES - 1 && (
        <TouchableOpacity
          style={[s.skipBtn, isDesktop && s.skipBtnDesktop]}
          onPress={handleFinish}
          accessibilityLabel={t('onboarding.skip')}
          accessibilityRole="button"
          activeOpacity={0.7}
        >
          <Text style={s.skipText}>{t('onboarding.skip')}</Text>
        </TouchableOpacity>
      )}

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handleScroll}
        scrollEventThrottle={16}
        bounces={false}
        style={s.scroller}
        contentContainerStyle={s.scrollerContent}
      >
        {screens.map((screen, i) => {
          const slideTheme = SLIDE_THEMES[i];
          return (
            <View key={i} style={[s.page, { width }]}>
              <View style={s.pageInner}>
                {/* Icon circle with subtle glow */}
                <View style={[
                  s.iconCircle,
                  {
                    width: circleSize,
                    height: circleSize,
                    borderRadius: circleSize / 2,
                    backgroundColor: 'rgba(255,255,255,0.15)',
                  },
                  Platform.OS === 'web' && {
                    boxShadow: `0 0 60px ${slideTheme.accent}44, 0 0 120px ${slideTheme.accent}22`,
                    backdropFilter: 'blur(8px)',
                    WebkitBackdropFilter: 'blur(8px)',
                  },
                ]}>
                  {screen.icon}
                </View>

                <Text style={[s.title, isDesktop && s.titleDesktop]}>
                  {screen.title}
                </Text>
                <Text style={[s.desc, isDesktop && s.descDesktop]}>
                  {screen.desc}
                </Text>

                {/* Start button on last page */}
                {i === PAGES - 1 && (
                  <TouchableOpacity
                    style={[
                      s.startBtn,
                      Platform.OS === 'web' && {
                        boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
                        transition: 'transform 0.2s ease, box-shadow 0.2s ease',
                      },
                    ]}
                    onPress={handleFinish}
                    accessibilityLabel={t('onboarding.start')}
                    accessibilityRole="button"
                    activeOpacity={0.8}
                  >
                    <Text style={s.startText}>{t('onboarding.start')}</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          );
        })}
      </ScrollView>

      {/* Dot indicators */}
      <View style={[s.dots, isDesktop && s.dotsDesktop]}>
        {screens.map((_, i) => (
          <TouchableOpacity
            key={i}
            onPress={() => goToPage(i)}
            accessibilityLabel={`Page ${i + 1}`}
            hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
          >
            <View
              style={[
                s.dot,
                {
                  width: i === current ? 28 : 10,
                  backgroundColor: i === current ? '#fff' : 'rgba(255,255,255,0.35)',
                },
                Platform.OS === 'web' && {
                  transition: 'width 0.3s ease, background-color 0.3s ease',
                },
              ]}
            />
          </TouchableOpacity>
        ))}
      </View>

      {/* Next arrow for pages 0-2 */}
      {current < PAGES - 1 && (
        <TouchableOpacity
          style={[
            s.nextBtn,
            isDesktop && s.nextBtnDesktop,
            Platform.OS === 'web' && {
              boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
              transition: 'transform 0.2s ease',
            },
          ]}
          onPress={() => goToPage(current + 1)}
          accessibilityLabel={t('onboarding.next')}
          accessibilityRole="button"
          activeOpacity={0.8}
        >
          <Text style={s.nextText}>{'\u2192'}</Text>
        </TouchableOpacity>
      )}
    </Animated.View>
  );
}

const s = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    ...Platform.select({
      web: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 },
    }),
  },
  skipBtn: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 56 : 40,
    right: 24,
    zIndex: 10,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  skipBtnDesktop: {
    top: 32,
    right: 40,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  skipText: {
    fontSize: 16,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.85)',
    letterSpacing: 0.3,
  },
  scroller: {
    flex: 1,
  },
  scrollerContent: {
    alignItems: 'stretch',
  },
  page: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pageInner: {
    alignItems: 'center',
    paddingHorizontal: 40,
    maxWidth: 500,
  },
  iconCircle: {
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 48,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  title: {
    fontSize: 32,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 16,
    letterSpacing: -0.5,
    color: '#fff',
    ...Platform.select({
      web: { fontFamily: '"Segoe UI", system-ui, -apple-system, sans-serif' },
    }),
  },
  titleDesktop: {
    fontSize: 40,
    marginBottom: 20,
  },
  desc: {
    fontSize: 18,
    textAlign: 'center',
    lineHeight: 28,
    maxWidth: 380,
    color: 'rgba(255,255,255,0.85)',
    fontWeight: '400',
  },
  descDesktop: {
    fontSize: 20,
    lineHeight: 32,
    maxWidth: 440,
  },
  startBtn: {
    marginTop: 48,
    paddingHorizontal: 56,
    paddingVertical: 18,
    borderRadius: 30,
    backgroundColor: '#fff',
    minWidth: 220,
    alignItems: 'center',
  },
  startText: {
    color: '#1e293b',
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingBottom: Platform.OS === 'ios' ? 50 : 40,
    gap: 10,
  },
  dotsDesktop: {
    paddingBottom: 48,
    gap: 12,
  },
  dot: {
    height: 10,
    borderRadius: 5,
  },
  nextBtn: {
    position: 'absolute',
    bottom: Platform.OS === 'ios' ? 44 : 32,
    right: 24,
    width: 60,
    height: 60,
    borderRadius: 30,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  nextBtnDesktop: {
    width: 64,
    height: 64,
    borderRadius: 32,
    right: 40,
    bottom: 40,
  },
  nextText: {
    color: '#fff',
    fontSize: 26,
    fontWeight: '600',
  },
});
