/**
 * /reels-sound — Reels P0 "Use this sound" screen.
 *
 * Loaded when a viewer taps the music row / disc on a reel. Renders a
 * ReelsViewer instance scoped to a single `sound_id` so every clip using
 * that audio plays back-to-back in the same vertical pager.
 */
import React, { useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import ReelsViewer from '../components/ReelsViewer';
import { IconChevronLeft, IconMusic } from '../components/Icons';

export default function ReelsSoundScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { user } = useAuth();
  const { t } = useLanguage();

  const soundId = String(params?.sound_id || '');
  const soundLabel = String(params?.label || '');

  const goBack = useCallback(() => {
    try { router.back(); } catch {}
  }, [router]);

  return (
    <View style={styles.root}>
      <ReelsViewer
        colors={colors}
        isDark={isDark}
        t={t}
        user={user}
        router={router}
        soundId={soundId}
        soundLabel={soundLabel}
        feedMode="foryou"
        showLiveRing
      />

      {/* Top bar — back + sound label, transparent glass overlay. */}
      <View style={[styles.topBar, { paddingTop: (insets.top || 0) + 6 }]} pointerEvents="box-none">
        <View pointerEvents="none" style={styles.glass} />
        <TouchableOpacity onPress={goBack} style={styles.backBtn} hitSlop={10}>
          <IconChevronLeft size={26} color="#fff" />
        </TouchableOpacity>
        <View style={styles.titleRow}>
          <IconMusic size={14} color="#fff" />
          <Text style={styles.title} numberOfLines={1}>
            {soundLabel || (t?.('feed.useThisSound') || 'Som')}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  topBar: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    paddingBottom: 10,
    zIndex: 30,
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  glass: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.32)',
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)' } : {}),
  },
  backBtn: { paddingHorizontal: 14, paddingVertical: 6 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, paddingRight: 14 },
  title: { color: '#fff', fontSize: 15, fontWeight: '700', flex: 1 },
});
