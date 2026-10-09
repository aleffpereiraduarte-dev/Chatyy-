import { useEffect, useState, useRef } from 'react';
import { View, StyleSheet, Dimensions, useColorScheme } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth, isChildAccount } from '../context/AuthContext';
import AnimatedSplash from '../components/AnimatedSplash';
import { Colors, DarkColors } from '../constants/theme';
import { hideNativeSplash, markFirstPaintOther, mark as bootMark } from '../services/bootTrace';

// [2026-10-07 coldstart] How long auth may stay `loading` behind the native
// splash before we show the branded AnimatedSplash instead (slow checkAuth on
// a fresh install / no cached user). Returning users resolve from the offline
// cache in ~20-60 ms, far below this.
const BRAND_AFTER_MS = 600;

export default function Index() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [splashDone, setSplashDone] = useState(false);
  // [2026-10-07 coldstart] The branded JS splash (entrance 280-360 ms + fade
  // 220 ms, serialized BEFORE router.replace) is no longer played for a
  // returning logged-in user: the NATIVE splash stays up (services/bootTrace)
  // until the chat list draws its first cached rows — WhatsApp-style. It is
  // still shown when there is no session (→ /login) or when auth is slow.
  const [showBrand, setShowBrand] = useState(false);
  const routedRef = useRef(false);

  useEffect(() => {
    if (!loading) return undefined;
    const t = setTimeout(() => setShowBrand(true), BRAND_AFTER_MS);
    return () => clearTimeout(t);
  }, [loading]);

  useEffect(() => {
    if (!loading && !user) {
      // [2026-10-09 boot-native] Separates logged-out boots (→ /login) from slow
      // returning-user boots in coldstart_marks (both used to read "brand+cap").
      try { bootMark('auth_none'); } catch {}
      setShowBrand(true);
    }
  }, [loading, user]);

  // Onboarding lives on /login (SignupIntro) — the splash here just routes.
  // Two-intro duplication (OnboardingFlow on / + SignupIntro on /login) was
  // removed 2026-05-07.
  useEffect(() => {
    if (loading || routedRef.current) return;
    // Returning user: route immediately (no branded animation in between).
    // Logged-out / brand already showing: wait for the animation to finish.
    if (!user || (showBrand && !splashDone)) {
      if (!user && splashDone) {
        routedRef.current = true;
        markFirstPaintOther('login');
        router.replace('/login');
      }
      return;
    }
    routedRef.current = true;
    bootMark('route_from_index');
    // Destinations that are NOT the chat list release the native splash
    // themselves (the list hides it on its first rows otherwise).
    const _releaseSplashSoon = (why) => {
      markFirstPaintOther(why);
      try { setTimeout(() => hideNativeSplash('route:' + why), 120); } catch { hideNativeSplash('route:' + why); }
    };
    if (user.needs_phone_verification === true) {
      _releaseSplashSoon('verify');
      router.replace('/verify-phone-required');
      return;
    }
    if (isChildAccount()) { router.replace('/chat'); return; }
    const w = Dimensions.get('window').width;
    const isMobile = w < 768;
    if (!isMobile) _releaseSplashSoon('inbox');
    router.replace(isMobile ? '/chat' : '/inbox');
  }, [loading, user, showBrand, splashDone]);

  // [2026-10-04] Pinta o fundo deste container com a cor do tema. Antes era
  // Colors.background fixo (branco) — no modo escuro, o instante entre o splash
  // JS sumir (fade-out) e a rota pintar aparecia como um "flash branco". Segue
  // o esquema do SO (default do app é 'system'); a rota de destino pinta logo
  // em seguida, então qualquer divergência de tema forçado dura apenas o fade.
  const scheme = useColorScheme();
  const bg = scheme === 'dark' ? DarkColors.background : Colors.background;
  return (
    <View style={[s.container, { backgroundColor: bg }]}>
      {showBrand ? <AnimatedSplash onFinish={() => setSplashDone(true)} /> : null}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
});
