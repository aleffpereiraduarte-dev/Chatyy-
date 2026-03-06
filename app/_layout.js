import { useEffect, useRef, useState, useCallback } from 'react';
import { Platform } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { AuthProvider } from '../context/AuthContext';
import { MailProvider } from '../context/MailContext';
import { ThemeProvider } from '../context/ThemeContext';
import { LanguageProvider } from '../context/LanguageContext';
import { BiometricProvider } from '../context/BiometricContext';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import ErrorBoundary from '../components/ErrorBoundary';
import OfflineNotice from '../components/OfflineNotice';
import NotificationToast from '../components/NotificationToast';

// Keep native splash visible while app initializes
SplashScreen.preventAutoHideAsync().catch(() => {});

function AppInit({ onNotification }) {
  const cleanupRef = useRef(null);

  useEffect(() => {
    // Hide native splash screen — our animated splash takes over
    SplashScreen.hideAsync().catch(() => {});

    // Inject CSS animations for auth background decorations
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const id = 'auth-bg-animations';
      if (!document.getElementById(id)) {
        const style = document.createElement('style');
        style.id = id;
        style.textContent = `
          @keyframes float1 { 0%,100%{transform:translate(0,0)} 33%{transform:translate(30px,20px)} 66%{transform:translate(-20px,10px)} }
          @keyframes float2 { 0%,100%{transform:translate(0,0)} 33%{transform:translate(-25px,-15px)} 66%{transform:translate(15px,-25px)} }
          @keyframes float3 { 0%,100%{transform:translate(0,0)} 50%{transform:translate(-30px,25px)} }
          @keyframes dropdownIn { from{opacity:0;transform:translateY(-8px) scale(0.96)} to{opacity:1;transform:translateY(0) scale(1)} }
          @keyframes fadeIn { from{opacity:0} to{opacity:1} }
          @keyframes slideUp { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
          @keyframes starPop { 0%{transform:scale(1)} 50%{transform:scale(1.4)} 100%{transform:scale(1)} }
          @keyframes slideInRight { from{transform:translateX(100%)} to{transform:translateX(0)} }
          @keyframes emailRowIn { from{opacity:0;transform:translateX(-12px)} to{opacity:1;transform:translateX(0)} }
          @keyframes scaleIn { from{opacity:0;transform:scale(0.92)} to{opacity:1;transform:scale(1)} }
          @keyframes ripple { 0%{transform:scale(0);opacity:0.4} 100%{transform:scale(2.5);opacity:0} }
          @keyframes shimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
          input:-webkit-autofill { -webkit-box-shadow: 0 0 0 30px white inset !important; }
          * { -webkit-tap-highlight-color: transparent; }
          ::-webkit-scrollbar { width: 6px; }
          ::-webkit-scrollbar-track { background: transparent; }
          ::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.25); border-radius: 3px; }
          ::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,0.4); }
        `;
        document.head.appendChild(style);
      }
    }

    if (Platform.OS === 'web') return;

    let mounted = true;

    (async () => {
      try {
        const {
          registerForPushNotifications,
          sendTokenToBackend,
          setupNotificationListeners,
          setForegroundNotificationHandler,
          clearBadge,
        } = await import('../services/pushNotifications');

        if (!mounted) return;

        // Set up foreground toast handler
        setForegroundNotificationHandler((notif) => {
          if (mounted) onNotification?.(notif);
        });

        cleanupRef.current = await setupNotificationListeners();

        const token = await registerForPushNotifications();
        if (token && mounted) {
          sendTokenToBackend(token);
        }

        // Clear badge when app opens
        clearBadge();
      } catch {}
    })();

    // Schedule local notifications for upcoming meetings
    (async () => {
      try {
        const { initMeetingReminders } = await import('../services/meetingReminders');
        if (mounted) await initMeetingReminders();
      } catch {}
    })();

    // Check for OTA updates (download silently, apply on next app restart — no forced reload)
    (async () => {
      try {
        const Updates = await import('expo-updates');
        if (Updates.isEnabled) {
          const update = await Updates.checkForUpdateAsync();
          if (update.isAvailable) {
            await Updates.fetchUpdateAsync();
            // Don't call reloadAsync() — update applies on next cold start
          }
        }
      } catch {}
    })();

    return () => {
      mounted = false;
      if (cleanupRef.current) cleanupRef.current();
    };
  }, []);

  return null;
}

export default function RootLayout() {
  const [toastNotif, setToastNotif] = useState(null);

  const handleNotification = useCallback((notif) => {
    setToastNotif(notif);
  }, []);

  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <ThemeProvider>
          <LanguageProvider>
          <BiometricProvider>
            <AuthProvider>
              <MailProvider>
                <AppInit onNotification={handleNotification} />
                <OfflineNotice />
                <StatusBar style="auto" />
                <Stack screenOptions={{
                  headerShown: false,
                  animation: 'fade_from_bottom',
                  animationDuration: 250,
                }}>
                  <Stack.Screen name="index" options={{ animation: 'none' }} />
                  <Stack.Screen name="login" options={{ animation: 'fade' }} />
                  <Stack.Screen name="signup" options={{ animation: 'slide_from_right' }} />
                  <Stack.Screen name="inbox" options={{ animation: 'fade' }} />
                  <Stack.Screen name="compose" options={{ presentation: 'modal', animation: 'slide_from_bottom', animationDuration: 300 }} />
                  <Stack.Screen name="read" options={{ presentation: 'modal', animation: 'slide_from_right', animationDuration: 250 }} />
                  <Stack.Screen name="profile" options={{ presentation: 'modal', animation: 'slide_from_bottom', animationDuration: 300 }} />
                  <Stack.Screen name="settings" options={{ presentation: 'modal', animation: 'slide_from_bottom', animationDuration: 300 }} />
                  <Stack.Screen name="meet/[id]" options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade', animationDuration: 200 }} />
                  <Stack.Screen name="meetings" options={{ presentation: 'modal', animation: 'slide_from_bottom', animationDuration: 300 }} />
                  <Stack.Screen name="meeting-create" options={{ presentation: 'modal', animation: 'slide_from_bottom', animationDuration: 300 }} />
                  <Stack.Screen name="meeting-detail" options={{ presentation: 'modal', animation: 'slide_from_right', animationDuration: 250 }} />
                  <Stack.Screen name="meeting-recap" options={{ presentation: 'modal', animation: 'slide_from_right', animationDuration: 250 }} />
                  <Stack.Screen name="files" options={{ presentation: 'modal', animation: 'slide_from_bottom', animationDuration: 300 }} />
                  <Stack.Screen name="calendar" options={{ presentation: 'modal', animation: 'slide_from_bottom', animationDuration: 300 }} />
                  <Stack.Screen name="event-detail" options={{ presentation: 'modal', animation: 'slide_from_right', animationDuration: 250 }} />
                  <Stack.Screen name="chat" options={{ presentation: 'modal', animation: 'slide_from_bottom', animationDuration: 300 }} />
                  <Stack.Screen name="chat-conversation" options={{ presentation: 'modal', animation: 'slide_from_right', animationDuration: 250 }} />
                  <Stack.Screen name="chat-new" options={{ presentation: 'modal', animation: 'slide_from_bottom', animationDuration: 300 }} />
                  <Stack.Screen name="documentos" options={{ presentation: 'modal', animation: 'slide_from_bottom', animationDuration: 300 }} />
                </Stack>
                <NotificationToast
                  notification={toastNotif}
                  onDismiss={() => setToastNotif(null)}
                />
              </MailProvider>
            </AuthProvider>
          </BiometricProvider>
          </LanguageProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
