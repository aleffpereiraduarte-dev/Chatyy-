/**
 * /u/[username] — unified full-screen profile route.
 * Accepts either a plain username ("duarte") or a full email
 * ("duarte@chatyy.com.br"); the Profile component resolves either.
 */
import React, { useCallback } from 'react';
import { View, StyleSheet, TouchableOpacity, Platform, StatusBar } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import Profile from '../../components/Profile';
import { IconArrowLeft } from '../../components/Icons';

export default function UserProfileScreen() {
  const { username } = useLocalSearchParams();
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { logout } = useAuth();
  const insets = useSafeAreaInsets();

  // username param may be an email (we encode before push) or a plain handle
  const raw = Array.isArray(username) ? username[0] : (username || '');
  const identifier = decodeURIComponent(raw);

  const handleChat = useCallback((email) => {
    if (!email) return;
    router.push(`/chat-conversation?name=${encodeURIComponent(email.split('@')[0])}&email=${encodeURIComponent(email)}`);
  }, [router]);

  const handleCall = useCallback((email, isVideo) => {
    if (!email) return;
    // Existing call entrypoint is through the chat conversation; open there.
    router.push(`/chat-conversation?email=${encodeURIComponent(email)}&startCall=${isVideo ? 'video' : 'audio'}`);
  }, [router]);

  const handleEmail = useCallback((email) => {
    if (!email) return;
    router.push(`/compose?to=${encodeURIComponent(email)}`);
  }, [router]);

  // Top padding = safe-area notch + breathing room so avatar/name don't
  // touch the status bar (Instagram/TikTok pattern).
  const topPad = (insets.top || 0) + 12;

  return (
    // The back button is absolute-positioned at left:14 (38px wide, so right edge ~52px).
    // Previously the container had `paddingLeft: 48` to clear it, but that also shifted
    // the posts grid off-screen on mobile widths. Better: add a matching spacer only to
    // the Profile header's first row. We do that here by passing a prop that Profile.js
    // respects (`headerLeadingSpace`). The container itself stays edge-to-edge so the
    // posts/reels grid gets full width.
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      {/* Minimal back button — no clutter header */}
      <TouchableOpacity
        onPress={() => router.back()}
        style={[styles.backBtn, { top: topPad + 2, backgroundColor: isDark ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.8)' }]}
        accessibilityLabel={t?.('common.back') || 'Back'}
        accessibilityRole="button"
      >
        <IconArrowLeft size={22} color={colors.text} />
      </TouchableOpacity>

      <Profile
        mode="full"
        email={identifier.includes('@') ? identifier : undefined}
        username={!identifier.includes('@') ? identifier : undefined}
        colors={colors}
        isDark={isDark}
        t={t}
        router={router}
        headerLeadingSpace={48}
        onOpenChat={handleChat}
        onOpenCall={handleCall}
        onOpenEmail={handleEmail}
        onLogout={async () => { try { await logout?.(); router.replace('/login'); } catch {} }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  backBtn: {
    position: 'absolute',
    // `top` now set inline via insets — fallback below if inset=0 (web)
    left: 14,
    zIndex: 10,
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 4 },
      android: { elevation: 2 },
      web: { boxShadow: '0 2px 6px rgba(0,0,0,0.12)' },
    }),
  },
});
