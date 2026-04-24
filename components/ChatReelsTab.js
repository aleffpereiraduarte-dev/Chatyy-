/**
 * ChatReelsTab.js
 * TikTok-style fullscreen vertical-swipe video feed tab for Chatyy.
 * Renders ReelsViewer using context hooks (useTheme, useAuth, useLanguage).
 */
import React from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import ReelsViewer from './ReelsViewer';

export default function ChatReelsTab() {
  const { colors, isDark } = useTheme();
  const { user } = useAuth();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  return (
    <View style={[styles.root, { paddingBottom: insets.bottom }]}>
      <ReelsViewer
        colors={colors}
        isDark={isDark}
        t={t}
        user={user}
        router={router}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
    // Tab bar sits below so we only need bottom inset offset
    ...(Platform.OS === 'web' ? {} : {}),
  },
});
