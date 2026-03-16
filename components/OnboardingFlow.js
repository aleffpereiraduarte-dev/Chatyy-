import { useRef, useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Dimensions,
  ScrollView, Animated, Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconMailLogo, IconMessageSquare, IconCloud, IconCheck } from './Icons';

const PAGES = 4;

export default function OnboardingFlow({ visible, onFinish }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const scrollRef = useRef(null);
  const [current, setCurrent] = useState(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const { width, height } = Dimensions.get('window');

  const handleScroll = useCallback((e) => {
    const page = Math.round(e.nativeEvent.contentOffset.x / width);
    if (page !== current) setCurrent(page);
  }, [current, width]);

  const handleFinish = useCallback(async () => {
    try {
      await AsyncStorage.setItem('onboarding_complete', '1');
    } catch (_) {}
    Animated.timing(fadeAnim, {
      toValue: 0,
      duration: 300,
      useNativeDriver: true,
    }).start(() => {
      if (onFinish) onFinish();
    });
  }, [onFinish, fadeAnim]);

  const goToPage = useCallback((page) => {
    scrollRef.current?.scrollTo({ x: page * width, animated: true });
  }, [width]);

  if (!visible) return null;

  const screens = [
    {
      icon: <IconMailLogo size={80} color={colors.primary} />,
      title: t('onboarding.welcome'),
      desc: t('onboarding.tagline'),
      bg: colors.primary + '10',
    },
    {
      icon: <IconMessageSquare size={72} color="#34D399" />,
      title: t('onboarding.chatTitle'),
      desc: t('onboarding.chatDesc'),
      bg: '#34D39910',
    },
    {
      icon: <IconCloud size={72} color="#60A5FA" />,
      title: t('onboarding.photosTitle'),
      desc: t('onboarding.photosDesc'),
      bg: '#60A5FA10',
    },
    {
      icon: <IconCheck size={72} color="#F59E0B" />,
      title: t('onboarding.readyTitle'),
      desc: t('onboarding.readyDesc'),
      bg: '#F59E0B10',
    },
  ];

  return (
    <Animated.View style={[s.overlay, { opacity: fadeAnim, backgroundColor: colors.bg }]}>
      {/* Skip button */}
      {current < PAGES - 1 && (
        <TouchableOpacity style={s.skipBtn} onPress={handleFinish} accessibilityLabel={t('onboarding.skip')}>
          <Text style={[s.skipText, { color: colors.textSecondary }]}>{t('onboarding.skip')}</Text>
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
      >
        {screens.map((screen, i) => (
          <View key={i} style={[s.page, { width }]}>
            <View style={[s.iconCircle, { backgroundColor: screen.bg }]}>
              {screen.icon}
            </View>
            <Text style={[s.title, { color: colors.text }]}>{screen.title}</Text>
            <Text style={[s.desc, { color: colors.textSecondary }]}>{screen.desc}</Text>

            {i === PAGES - 1 && (
              <TouchableOpacity
                style={[s.startBtn, { backgroundColor: colors.primary }]}
                onPress={handleFinish}
                accessibilityLabel={t('onboarding.start')}
                accessibilityRole="button"
              >
                <Text style={s.startText}>{t('onboarding.start')}</Text>
              </TouchableOpacity>
            )}
          </View>
        ))}
      </ScrollView>

      {/* Dot indicators */}
      <View style={s.dots}>
        {screens.map((_, i) => (
          <TouchableOpacity key={i} onPress={() => goToPage(i)} accessibilityLabel={`Page ${i + 1}`}>
            <View
              style={[
                s.dot,
                {
                  backgroundColor: i === current ? colors.primary : colors.border,
                  width: i === current ? 24 : 8,
                },
              ]}
            />
          </TouchableOpacity>
        ))}
      </View>

      {/* Next arrow for pages 0-2 */}
      {current < PAGES - 1 && (
        <TouchableOpacity
          style={[s.nextBtn, { backgroundColor: colors.primary }]}
          onPress={() => goToPage(current + 1)}
          accessibilityLabel="Next"
          accessibilityRole="button"
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
  },
  skipBtn: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 56 : 40,
    right: 24,
    zIndex: 10,
    padding: 8,
  },
  skipText: {
    fontSize: 16,
    fontWeight: '500',
  },
  scroller: {
    flex: 1,
  },
  page: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  iconCircle: {
    width: 160,
    height: 160,
    borderRadius: 80,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 40,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 16,
    letterSpacing: -0.5,
  },
  desc: {
    fontSize: 17,
    textAlign: 'center',
    lineHeight: 24,
    maxWidth: 320,
  },
  startBtn: {
    marginTop: 40,
    paddingHorizontal: 48,
    paddingVertical: 16,
    borderRadius: 30,
  },
  startText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingBottom: Platform.OS === 'ios' ? 50 : 40,
    gap: 8,
  },
  dot: {
    height: 8,
    borderRadius: 4,
    transition: 'width 0.3s',
  },
  nextBtn: {
    position: 'absolute',
    bottom: Platform.OS === 'ios' ? 44 : 32,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
  },
  nextText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '600',
  },
});
