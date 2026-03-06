import { Stack } from 'expo-router';
import { SignupProvider } from '../../context/SignupContext';

export default function SignupLayout() {
  return (
    <SignupProvider>
      <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right', animationDuration: 250 }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="step-name" />
        <Stack.Screen name="step-username" />
        <Stack.Screen name="step-password" />
        <Stack.Screen name="step-phone" />
        <Stack.Screen name="step-recovery" />
        <Stack.Screen name="step-confirm" />
      </Stack>
    </SignupProvider>
  );
}
