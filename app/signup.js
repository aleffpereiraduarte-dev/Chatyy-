// [bia-convite 2026-10-19] /signup?ref=CODE — link de convite ("Convidar amigos").
// Grava o código pendente (1º link vale, 30 dias; ver services/pendingReferral)
// e segue para o cadastro por telefone. Já logado → tenta aplicar o convite
// (fallback apply_referral) e volta para o app. Web e nativo (deep link).
import { useEffect, useRef } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { storePendingRef, applyPendingReferral } from '../services/pendingReferral';

export default function SignupRefRedirect() {
  const router = useRouter();
  const params = useLocalSearchParams();
  let auth = null;
  try { auth = useAuth(); } catch {}
  let colors = null;
  try { colors = useTheme()?.colors || null; } catch {}
  const done = useRef(false);
  const authLoading = !!auth?.loading;
  const loggedIn = !!auth?.user?.email;
  const ref = Array.isArray(params?.ref) ? params.ref[0] : params?.ref;

  useEffect(() => {
    if (done.current || authLoading) return;
    done.current = true;
    (async () => {
      try { if (ref) await storePendingRef(String(ref)); } catch {}
      if (loggedIn) {
        try { applyPendingReferral().catch(() => {}); } catch {}
        try { router.replace('/chat'); } catch {}
        return;
      }
      try { router.replace('/signup-phone'); } catch {}
    })();
  }, [authLoading, loggedIn, ref, router]);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors?.background || undefined }}>
      <Stack.Screen options={{ headerShown: false }} />
      <ActivityIndicator color={colors?.text || undefined} />
    </View>
  );
}
