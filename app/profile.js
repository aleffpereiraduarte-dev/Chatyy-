/**
 * /profile — legacy route. Kept ONLY to avoid breaking existing deep links
 * and notification payloads that still point to /profile. Everything
 * redirects to the unified profile at /u/{me}.
 *
 * All the settings that used to live here (password, 2FA, sessions, caller
 * ID verify, storage, etc.) now live in <ProfileSettingsSheet>, which is
 * opened from the gear icon inside the unified profile.
 *
 * The old implementation is archived at profile.js.legacy.
 */
import React, { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';

export default function ProfileLegacyRedirect() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const { colors } = useTheme();

  useEffect(() => {
    if (loading) return;
    if (user?.email) {
      router.replace(`/u/${encodeURIComponent(user.email)}`);
    } else {
      router.replace('/login');
    }
  }, [user, loading, router]);

  return (
    // [beauty2 2026-05-31] redirect loader: larger brand-purple spinner, theme bg
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors?.background, padding: 24 }}>
      <ActivityIndicator size="large" color="#7C3AED" />
    </View>
  );
}
