/**
 * ChatReelsTab.js
 * TikTok-grade fullscreen vertical-swipe video feed (Reels home).
 * Hosts ReelsViewer + glass top bar (For You / Following + search),
 * first-time swipe hint, pull-to-refresh indicator, live ring on avatar,
 * read-more caption, and bottom dark fade gradient overlay.
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Platform,
  Pressable,
  Animated,
  Easing,
  Dimensions,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { IconSearch, IconCamera } from './Icons';
import ReelsViewer from './ReelsViewer';

const BRAND = '#7C3AED';
const HINT_KEY = '@chatyy:reels_hint_seen_v1';
const { height: SCREEN_H } = Dimensions.get('window');

export default function ChatReelsTab() {
  const { colors, isDark } = useTheme();
  const { user } = useAuth();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  // 1. Pra Você / Seguindo tabs
  const [activeTab, setActiveTab] = useState('foryou'); // 'foryou' | 'following'
  const tabUnderlineX = useRef(new Animated.Value(0)).current;

  // 5. First-time hint
  const [showHint, setShowHint] = useState(false);
  const hintOpacity = useRef(new Animated.Value(0)).current;
  const hintArrowY = useRef(new Animated.Value(0)).current;

  // 6. Pull-to-refresh indicator
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const seen = await AsyncStorage.getItem(HINT_KEY);
        if (!seen && mounted) {
          setShowHint(true);
          Animated.timing(hintOpacity, {
            toValue: 1,
            duration: 320,
            useNativeDriver: true,
          }).start();
          Animated.loop(
            Animated.sequence([
              Animated.timing(hintArrowY, {
                toValue: -14,
                duration: 700,
                easing: Easing.inOut(Easing.quad),
                useNativeDriver: true,
              }),
              Animated.timing(hintArrowY, {
                toValue: 0,
                duration: 700,
                easing: Easing.inOut(Easing.quad),
                useNativeDriver: true,
              }),
            ]),
          ).start();
          setTimeout(() => {
            Animated.timing(hintOpacity, {
              toValue: 0,
              duration: 420,
              useNativeDriver: true,
            }).start(() => {
              if (mounted) setShowHint(false);
            });
            AsyncStorage.setItem(HINT_KEY, '1').catch(() => {});
          }, 3000);
        }
      } catch {}
    })();
    return () => {
      mounted = false;
    };
  }, [hintOpacity, hintArrowY]);

  const switchTab = useCallback(
    (tab) => {
      setActiveTab(tab);
      Animated.spring(tabUnderlineX, {
        toValue: tab === 'foryou' ? 0 : 1,
        useNativeDriver: true,
        bounciness: 6,
        speed: 18,
      }).start();
    },
    [tabUnderlineX],
  );

  // 6. Algoritmo refresh handler — passed to ReelsViewer; show indicator briefly.
  const handlePullRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1400);
  }, []);

  // 7. Live indicator + tap-to-live router (consumed by ReelsViewer via prop)
  const handleAvatarTap = useCallback(
    (item) => {
      if (item?.is_live && item?.live_id) {
        router.push(`/live-viewer?id=${item.live_id}`);
        return true;
      }
      return false;
    },
    [router],
  );

  const topBarOffset = (insets.top || 0) + 6;

  return (
    <View style={styles.root}>
      {/* 2. Vertical pager full-bleed — ReelsViewer fills the screen */}
      <ReelsViewer
        colors={colors}
        isDark={isDark}
        t={t}
        user={user}
        router={router}
        feedMode={activeTab}
        onPullRefresh={handlePullRefresh}
        onAvatarTap={handleAvatarTap}
        showLiveRing
        readMoreEnabled
        bottomGradientOverlay
        fullBleed
      />

      {/* 4. Bottom info card glass: dark fade gradient (paint-only fallback when expo-linear-gradient absent) */}
      <View pointerEvents="none" style={styles.bottomFade}>
        <View style={[styles.bottomFadeBand, { opacity: 0.18 }]} />
        <View style={[styles.bottomFadeBand, { opacity: 0.34 }]} />
        <View style={[styles.bottomFadeBand, { opacity: 0.55 }]} />
        <View style={[styles.bottomFadeBand, { opacity: 0.78 }]} />
      </View>

      {/* 3. Top bar transparent / glass overlay */}
      <View
        pointerEvents="box-none"
        style={[styles.topBar, { paddingTop: topBarOffset }]}
      >
        <View pointerEvents="none" style={styles.topGlass} />

        {/* 1. Pra Você / Seguindo tabs */}
        <View style={styles.tabsRow} pointerEvents="box-none">
          <View style={styles.tabsCenter}>
            <Pressable
              onPress={() => switchTab('following')}
              style={styles.tabBtn}
              accessibilityRole="tab"
              accessibilityLabel="Seguindo"
            >
              <Text
                style={[
                  styles.tabText,
                  activeTab === 'following' && styles.tabTextActive,
                ]}
              >
                Seguindo
              </Text>
            </Pressable>

            <View style={styles.tabSep} />

            <Pressable
              onPress={() => switchTab('foryou')}
              style={styles.tabBtn}
              accessibilityRole="tab"
              accessibilityLabel="Pra Você"
            >
              <Text
                style={[
                  styles.tabText,
                  activeTab === 'foryou' && styles.tabTextActive,
                ]}
              >
                Pra Você
              </Text>
            </Pressable>

            <Animated.View
              style={[
                styles.tabUnderline,
                {
                  transform: [
                    {
                      translateX: tabUnderlineX.interpolate({
                        inputRange: [0, 1],
                        outputRange: [54, -54], // foryou(right) / following(left)
                      }),
                    },
                  ],
                },
              ]}
            />
          </View>

          {/* Create reel button (right of search) */}
          <Pressable
            onPress={() => router.push('/reels-recorder')}
            style={[styles.searchBtn, { right: 54 }]}
            accessibilityRole="button"
            accessibilityLabel={t?.('reels.recorder.title') || 'Criar reel'}
            hitSlop={10}
          >
            <IconCamera size={24} color="#fff" />
          </Pressable>

          {/* Search icon (right) */}
          <Pressable
            onPress={() => router.push('/chat-new?from=reels')}
            style={[styles.searchBtn, { right: 14 }]}
            accessibilityRole="button"
            accessibilityLabel="Buscar"
            hitSlop={10}
          >
            <IconSearch size={24} color="#fff" />
          </Pressable>
        </View>
      </View>

      {/* 6. Pull refresh indicator pill */}
      {refreshing && (
        <View
          style={[
            styles.refreshPill,
            { top: topBarOffset + 56 },
          ]}
          pointerEvents="none"
        >
          <ActivityIndicator size="small" color="#fff" />
          <Text style={styles.refreshText}>Atualizando feed</Text>
        </View>
      )}

      {/* 5. First-time swipe-up hint */}
      {showHint && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.hintWrap,
            { opacity: hintOpacity, bottom: (insets.bottom || 0) + 140 },
          ]}
        >
          <Animated.View
            style={[
              styles.hintArrow,
              { transform: [{ translateY: hintArrowY }] },
            ]}
          >
            <Text style={styles.hintArrowGlyph}>↑</Text>
          </Animated.View>
          <View style={styles.hintBubble}>
            <Text style={styles.hintText}>
              Deslize pra cima pra próximo
            </Text>
          </View>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
  },

  // Top bar
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingBottom: 10,
    zIndex: 30,
  },
  topGlass: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.18)',
    ...(Platform.OS === 'web'
      ? { backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)' }
      : {}),
  },
  tabsRow: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabsCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  tabBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  tabSep: {
    width: 1,
    height: 14,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  tabText: {
    fontSize: 17,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.62)',
    textShadowColor: 'rgba(0,0,0,0.45)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  tabTextActive: {
    color: '#fff',
    fontWeight: '800',
  },
  tabUnderline: {
    position: 'absolute',
    bottom: -4,
    left: '50%',
    marginLeft: -10,
    width: 20,
    height: 3,
    borderRadius: 2,
    backgroundColor: '#fff',
  },
  searchBtn: {
    position: 'absolute',
    top: 8,
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Bottom dark fade gradient (4-band fallback)
  bottomFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 220,
    zIndex: 5,
  },
  bottomFadeBand: {
    flex: 1,
    backgroundColor: '#000',
  },

  // Refresh pill
  refreshPill: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    zIndex: 40,
    ...(Platform.OS === 'web'
      ? { backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)' }
      : {}),
  },
  refreshText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    marginLeft: 8,
  },

  // First-time hint
  hintWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 35,
  },
  hintArrow: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.6)',
  },
  hintArrowGlyph: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '800',
    lineHeight: 24,
  },
  hintBubble: {
    backgroundColor: 'rgba(0,0,0,0.62)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(124,58,237,0.55)',
  },
  hintText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
});
