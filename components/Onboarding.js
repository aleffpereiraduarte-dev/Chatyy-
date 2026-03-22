import React, { useState, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated, Platform,
  FlatList, useWindowDimensions,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconMail, IconMessageSquare, IconFolder, IconSparkles, IconZap, IconImage } from './Icons';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';

const ONBOARDING_KEY = '@chatyy_onboarding_done';

const SLIDES = [
  {
    key: 'welcome',
    Icon: IconSparkles,
    iconColor: '#fff',
    gradientColors: ['#6366f1', '#8b5cf6', '#a78bfa'],
    titleKey: 'onboarding.welcomeTitle',
    descKey: 'onboarding.welcomeDesc',
    dark: true,
  },
  {
    key: 'features',
    icons: [
      { Icon: IconMail, color: '#2563eb', labelKey: 'onboarding.emailTitle' },
      { Icon: IconMessageSquare, color: '#25D366', labelKey: 'onboarding.chatSlideTitle' },
      { Icon: IconFolder, color: '#f59e0b', labelKey: 'onboarding.driveTitle' },
    ],
    iconColor: '#2563eb',
    gradientColors: ['#1e40af', '#2563eb', '#3b82f6'],
    titleKey: 'onboarding.featuresTitle',
    descKey: 'onboarding.featuresDesc',
    dark: true,
    multiIcon: true,
  },
  {
    key: 'one',
    Icon: IconZap,
    iconColor: '#fff',
    gradientColors: ['#7c3aed', '#8b5cf6', '#a78bfa'],
    titleKey: 'onboarding.oneTitle',
    descKey: 'onboarding.oneDesc',
    dark: true,
  },
  {
    key: 'backup',
    Icon: IconImage,
    iconColor: '#fff',
    gradientColors: ['#059669', '#10b981', '#34d399'],
    titleKey: 'onboarding.backupTitle',
    descKey: 'onboarding.backupDesc',
    dark: true,
  },
];

export default function Onboarding({ onDone }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [currentIndex, setCurrentIndex] = useState(0);
  const flatListRef = useRef(null);
  const scrollX = useRef(new Animated.Value(0)).current;
  const { width: SCREEN_WIDTH } = useWindowDimensions();

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

  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    if (viewableItems?.length > 0) {
      setCurrentIndex(viewableItems[0].index ?? 0);
    }
  }).current;

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 }).current;

  const isDesktop = Platform.OS === 'web' && SCREEN_WIDTH > 768;

  const renderSlide = ({ item }) => {
    const textColor = item.dark ? '#fff' : colors.text;
    const descColor = item.dark ? 'rgba(255,255,255,0.85)' : colors.textSecondary;
    const bgColor = item.gradientColors ? item.gradientColors[1] : colors.background;
    const Icon = item.Icon;

    return (
      <View style={[
        styles.slide,
        { width: SCREEN_WIDTH, backgroundColor: bgColor },
        Platform.OS === 'web' && item.gradientColors && {
          background: `linear-gradient(135deg, ${item.gradientColors[0]}, ${item.gradientColors[1]}, ${item.gradientColors[2]})`,
        },
      ]}>
        <View style={styles.slideContent}>
          {item.multiIcon ? (
            <View style={[styles.multiIconRow, isDesktop && styles.multiIconRowDesktop]}>
              {item.icons.map((ic, idx) => {
                const ItemIcon = ic.Icon;
                return (
                  <View key={idx} style={styles.multiIconItem}>
                    <View style={[
                      styles.iconCircle,
                      isDesktop && styles.iconCircleDesktop,
                      { backgroundColor: 'rgba(255,255,255,0.18)' },
                      Platform.OS === 'web' && {
                        boxShadow: '0 8px 32px rgba(0,0,0,0.15)',
                        backdropFilter: 'blur(8px)',
                        WebkitBackdropFilter: 'blur(8px)',
                      },
                    ]}>
                      <ItemIcon size={isDesktop ? 48 : 40} color="#fff" />
                    </View>
                    <Text style={[
                      styles.multiIconLabel,
                      { color: descColor },
                      isDesktop && { fontSize: 15 },
                    ]}>{t(ic.labelKey)}</Text>
                  </View>
                );
              })}
            </View>
          ) : Icon ? (
            <View style={[
              styles.iconCircle,
              isDesktop && styles.iconCircleDesktop,
              {
                backgroundColor: item.dark ? 'rgba(255,255,255,0.15)' : (item.iconColor + '15'),
              },
              Platform.OS === 'web' && {
                boxShadow: `0 12px 40px ${item.gradientColors?.[0]}44`,
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
              },
            ]}>
              <Icon size={isDesktop ? 80 : 64} color={item.iconColor} />
            </View>
          ) : null}
          <Text style={[
            styles.title,
            { color: textColor },
            isDesktop && styles.titleDesktop,
          ]}>
            {t(item.titleKey)}
          </Text>
          <Text style={[
            styles.description,
            { color: descColor },
            isDesktop && styles.descDesktop,
          ]}>
            {t(item.descKey)}
          </Text>
        </View>
      </View>
    );
  };

  const isLast = currentIndex === SLIDES.length - 1;
  const currentSlide = SLIDES[currentIndex];
  const isDarkSlide = currentSlide?.dark;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Skip button */}
      {!isLast && (
        <TouchableOpacity
          style={[styles.skipBtn, isDesktop && styles.skipBtnDesktop]}
          onPress={handleDone}
          activeOpacity={0.7}
        >
          <Text style={[styles.skipText, {
            color: isDarkSlide ? 'rgba(255,255,255,0.75)' : colors.textSecondary,
          }]}>{t('onboarding.skip')}</Text>
        </TouchableOpacity>
      )}

      <FlatList
        ref={flatListRef}
        data={SLIDES}
        renderItem={renderSlide}
        keyExtractor={item => item.key}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], { useNativeDriver: false })}
        scrollEventThrottle={16}
        bounces={false}
        getItemLayout={(_, index) => ({
          length: SCREEN_WIDTH,
          offset: SCREEN_WIDTH * index,
          index,
        })}
      />

      {/* Dots indicator */}
      <View style={[styles.dotsContainer, isDesktop && styles.dotsContainerDesktop]}>
        {SLIDES.map((_, i) => {
          const inputRange = [(i - 1) * SCREEN_WIDTH, i * SCREEN_WIDTH, (i + 1) * SCREEN_WIDTH];
          const dotWidth = scrollX.interpolate({
            inputRange,
            outputRange: [10, 28, 10],
            extrapolate: 'clamp',
          });
          const dotOpacity = scrollX.interpolate({
            inputRange,
            outputRange: [0.35, 1, 0.35],
            extrapolate: 'clamp',
          });
          return (
            <Animated.View
              key={i}
              style={[
                styles.dot,
                {
                  width: dotWidth,
                  opacity: dotOpacity,
                  backgroundColor: isDarkSlide ? '#fff' : (SLIDES[currentIndex]?.gradientColors?.[0] || colors.primary),
                },
              ]}
            />
          );
        })}
      </View>

      {/* Next / Start button */}
      <TouchableOpacity
        style={[
          styles.nextBtn,
          isDesktop && styles.nextBtnDesktop,
          {
            backgroundColor: isDarkSlide ? 'rgba(255,255,255,0.2)' : (SLIDES[currentIndex]?.gradientColors?.[0] || colors.primary),
            borderWidth: 1,
            borderColor: isDarkSlide ? 'rgba(255,255,255,0.15)' : 'transparent',
          },
          Platform.OS === 'web' && {
            boxShadow: '0 6px 24px rgba(0,0,0,0.2)',
            transition: 'transform 0.2s ease, box-shadow 0.2s ease',
          },
        ]}
        onPress={handleNext}
        activeOpacity={0.8}
      >
        <Text style={[styles.nextBtnText, isDesktop && { fontSize: 18 }]}>
          {isLast ? t('onboarding.start') : t('onboarding.next')}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

export { ONBOARDING_KEY };

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    ...Platform.select({
      web: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999 },
    }),
  },
  skipBtn: {
    position: 'absolute',
    top: 60,
    right: 24,
    zIndex: 10,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.12)',
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
    letterSpacing: 0.3,
  },
  slide: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  slideContent: {
    alignItems: 'center',
    maxWidth: 500,
  },
  iconCircle: {
    width: 150,
    height: 150,
    borderRadius: 75,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 44,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  iconCircleDesktop: {
    width: 200,
    height: 200,
    borderRadius: 100,
    marginBottom: 52,
  },
  title: {
    fontSize: 30,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 16,
    letterSpacing: -0.5,
    ...Platform.select({
      web: { fontFamily: '"Segoe UI", system-ui, -apple-system, sans-serif' },
    }),
  },
  titleDesktop: {
    fontSize: 40,
    marginBottom: 20,
  },
  description: {
    fontSize: 17,
    textAlign: 'center',
    lineHeight: 26,
    maxWidth: 380,
    fontWeight: '400',
  },
  descDesktop: {
    fontSize: 20,
    lineHeight: 32,
    maxWidth: 440,
  },
  multiIconRow: {
    flexDirection: 'row',
    gap: 32,
    marginBottom: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  multiIconRowDesktop: {
    gap: 48,
    marginBottom: 52,
  },
  multiIconItem: {
    alignItems: 'center',
    gap: 10,
  },
  multiIconLabel: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  dotsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 32,
    gap: 8,
  },
  dotsContainerDesktop: {
    marginBottom: 40,
    gap: 10,
  },
  dot: {
    height: 10,
    borderRadius: 5,
  },
  nextBtn: {
    paddingVertical: 18,
    paddingHorizontal: 52,
    borderRadius: 30,
    marginBottom: 60,
    minWidth: 220,
    alignItems: 'center',
  },
  nextBtnDesktop: {
    paddingVertical: 20,
    paddingHorizontal: 64,
    minWidth: 260,
    marginBottom: 48,
  },
  nextBtnText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
});
