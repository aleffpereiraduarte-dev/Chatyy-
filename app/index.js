import { useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import AnimatedSplash from '../components/AnimatedSplash';

export default function Index() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [splashDone, setSplashDone] = useState(false);
  const [authReady, setAuthReady] = useState(false);

  // Track when auth check completes
  useEffect(() => {
    if (!loading) setAuthReady(true);
  }, [loading]);

  // Navigate only after both splash animation and auth check are done
  useEffect(() => {
    if (splashDone && authReady) {
      router.replace(user ? '/inbox' : '/login');
    }
  }, [splashDone, authReady, user]);

  return (
    <View style={s.container}>
      <AnimatedSplash onFinish={() => setSplashDone(true)} />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
});
