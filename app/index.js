import { useEffect, useState } from 'react';
import { View, StyleSheet, Platform, Dimensions } from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth, isChildAccount } from '../context/AuthContext';
import AnimatedSplash from '../components/AnimatedSplash';
import OnboardingFlow from '../components/OnboardingFlow';

export default function Index() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [splashDone, setSplashDone] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingChecked, setOnboardingChecked] = useState(false);

  // Check onboarding status
  useEffect(() => {
    AsyncStorage.getItem('onboarding_complete').then((val) => {
      if (val !== '1') {
        setShowOnboarding(true);
      }
      setOnboardingChecked(true);
    }).catch(() => {
      // Falha de leitura → mostrar onboarding por segurança em vez de pular.
      setShowOnboarding(true);
      setOnboardingChecked(true);
    });
  }, []);

  // Track when auth check completes
  useEffect(() => {
    if (!loading) setAuthReady(true);
  }, [loading]);

  // Navigate only after splash, auth, and onboarding are done
  useEffect(() => {
    if (splashDone && authReady && onboardingChecked && !showOnboarding) {
      if (!user) { router.replace('/login'); return; }
      // INCOMPLETE ACCOUNT: force phone verification before allowing app access.
      // Server returns needs_phone_verification=true when verified_phone is missing.
      if (user.needs_phone_verification === true) {
        router.replace('/verify-phone-required');
        return;
      }
      // Child accounts always go to chat (Chatyy Kids).
      if (isChildAccount()) { router.replace('/chat'); return; }
      // Mobile-first vs desktop split usa só largura — antes "Platform!=web"
      // mandava todo nativo (incluindo iPad) pra /chat.
      const w = Dimensions.get('window').width;
      const isMobile = w < 768;
      router.replace(isMobile ? '/chat' : '/inbox');
    }
  }, [splashDone, authReady, onboardingChecked, showOnboarding, user]);

  const handleOnboardingFinish = async () => {
    try { await AsyncStorage.setItem('onboarding_complete', '1'); } catch {}
    setShowOnboarding(false);
  };

  return (
    <View style={s.container}>
      <AnimatedSplash onFinish={() => setSplashDone(true)} />
      {splashDone && (
        <OnboardingFlow visible={showOnboarding} onFinish={handleOnboardingFinish} />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
});

// trigger: github actions OTA test 1777564995

// trigger: github actions OTA test 2 1777565350
