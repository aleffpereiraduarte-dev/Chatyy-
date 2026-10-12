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
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';

export default function ProfileLegacyRedirect() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { user, loading } = useAuth();
  const { colors } = useTheme();

  useEffect(() => {
    if (loading) return;
    // [2026-10-11 settings-unify] Honra os parâmetros que callers ainda mandam:
    //   ?edit=1           → /edit-profile (a única tela de edição)
    //   ?section=X        → hub /settings na seção X
    //   ?email= / ?handle= de OUTRA pessoa → /u/<pessoa> (antes caía no
    //   MEU perfil: meeting-detail e o @menção do chat abriam o perfil errado).
    const one = (v) => (Array.isArray(v) ? v[0] : v);
    const other = String(one(params?.email) || one(params?.handle) || one(params?.username) || '').trim().replace(/^@/, '');
    if (!user?.email) { router.replace('/login'); return; }
    if (one(params?.edit) === '1' || one(params?.edit) === 'true') { router.replace('/edit-profile'); return; }
    if (one(params?.section)) { router.replace(`/settings?section=${encodeURIComponent(one(params.section))}`); return; }
    if (other && other.toLowerCase() !== String(user.email).toLowerCase()) {
      router.replace(`/u/${encodeURIComponent(other)}`);
      return;
    }
    if (user?.email) {
      router.replace(`/u/${encodeURIComponent(user.email)}`);
    } else {
      router.replace('/login');
    }
  }, [user, loading, router, params?.email, params?.handle, params?.username, params?.edit, params?.section]);

  return (
    // redirect loader: monochrome brand spinner (colors.primary), theme bg
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors?.background, padding: 24 }}>
      <ActivityIndicator size="large" color={colors?.primary || '#111111'} />
    </View>
  );
}
