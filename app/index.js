import { useEffect, useState } from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth, isChildAccount } from '../context/AuthContext';
import AnimatedSplash from '../components/AnimatedSplash';

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

  return (
    <View style={s.container}>
      <AnimatedSplash onFinish={() => setSplashDone(true)} />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F7F7FA' },
});
