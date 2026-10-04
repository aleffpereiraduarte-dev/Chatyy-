import { useEffect, useState } from 'react';
import { View, StyleSheet, Dimensions, useColorScheme } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth, isChildAccount } from '../context/AuthContext';
import AnimatedSplash from '../components/AnimatedSplash';
import { Colors, DarkColors } from '../constants/theme';

export default function Index() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [splashDone, setSplashDone] = useState(false);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    if (!loading) setAuthReady(true);
  }, [loading]);

  // Onboarding lives on /login (SignupIntro) — the splash here just routes.
  // Two-intro duplication (OnboardingFlow on / + SignupIntro on /login) was
  // removed 2026-05-07.
  useEffect(() => {
    if (splashDone && authReady) {
      if (!user) { router.replace('/login'); return; }
      if (user.needs_phone_verification === true) {
        router.replace('/verify-phone-required');
        return;
      }
      if (isChildAccount()) { router.replace('/chat'); return; }
      const w = Dimensions.get('window').width;
      const isMobile = w < 768;
      router.replace(isMobile ? '/chat' : '/inbox');
    }
  }, [splashDone, authReady, user]);

  // [2026-10-04] Pinta o fundo deste container com a cor do tema. Antes era
  // Colors.background fixo (branco) — no modo escuro, o instante entre o splash
  // JS sumir (fade-out) e a rota pintar aparecia como um "flash branco". Segue
  // o esquema do SO (default do app é 'system'); a rota de destino pinta logo
  // em seguida, então qualquer divergência de tema forçado dura apenas o fade.
  const scheme = useColorScheme();
  const bg = scheme === 'dark' ? DarkColors.background : Colors.background;
  return (
    <View style={[s.container, { backgroundColor: bg }]}>
      <AnimatedSplash onFinish={() => setSplashDone(true)} />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
});
