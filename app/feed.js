import React, { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';

export default function FeedRedirect() {
  const router = useRouter();
  const { colors } = useTheme();

  useEffect(() => {
    router.replace('/chat?tab=feed');
  }, [router]);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors?.background }}>
      <ActivityIndicator color="#7C3AED" />
    </View>
  );
}
