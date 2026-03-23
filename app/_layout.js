import { GestureHandlerRootView } from "react-native-gesture-handler";
// ─── Sentry crash reporting ───
import { initSentry } from '../services/sentry';
initSentry();

// ─── Global crash reporter — catches fatal errors before app closes ───
import { Platform, Linking, Alert } from 'react-native';
if (typeof ErrorUtils !== 'undefined') {
  const _prev = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    try {
      const msg = error?.message || String(error);
      const stack = error?.stack || '';
      // Send crash report to server
      fetch('https://chatyy.com.br/api/email.php?action=crash_report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: msg,
          stack: stack.substring(0, 2000),
          fatal: isFatal,
          platform: Platform.OS,
          timestamp: new Date().toISOString(),
        }),
      }).catch(() => {});
      // Also show alert so user can see what crashed
      if (isFatal && Platform.OS !== 'web') {
        Alert.alert(
          'Erro - Debug',
          msg + '\n\n' + stack.substring(0, 500),
          [{ text: 'OK' }]
        );
      }
    } catch (e) {}
    // Call previous handler
    if (_prev) _prev(error, isFatal);
  });
}
// ─── End crash reporter ───

import { useEffect, useRef, useState, useCallback } from 'react';
import { Stack, useRouter, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '../services/queryClient';
import { AuthProvider } from '../context/AuthContext';
import { MailProvider } from '../context/MailContext';
import { ThemeProvider } from '../context/ThemeContext';
import { LanguageProvider } from '../context/LanguageContext';
import { BiometricProvider } from '../context/BiometricContext';
import { PhotosProvider } from '../context/PhotosContext';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import ErrorBoundary from '../components/ErrorBoundary';
import OfflineNotice from '../components/OfflineNotice';
import NotificationToast from '../components/NotificationToast';
import IncomingCallListener from '../components/IncomingCallListener';
import ActiveCallBar from '../components/ActiveCallBar';
import LoginChallengePrompt from '../components/LoginChallengePrompt';
import { registerBackgroundSync } from '../services/backgroundSync';
import { initAutoBackup } from '../services/autoBackup';
import { trackPageview, trackAppOpen } from '../services/analytics';
import { prefetch, warmCache } from '../services/cache';

// Keep the native splash screen visible until our AnimatedSplash component is mounted and ready.
// This prevents any flash of white/icon between the native splash hiding and React rendering.
SplashScreen.preventAutoHideAsync().catch(() => {});

// Initialize native services
if (Platform.OS !== 'web') {
  registerBackgroundSync().catch(() => {});
}

// Handles mailto: deep links on native — routes to compose screen
function useMailtoLinking() {
  const router = useRouter();

  const handleMailtoUrl = useCallback((url) => {
    if (!url) return;
    try {
      // Accept both bare mailto: links and onemundomail:// deep links that wrap a mailto
      const mailtoMatch = url.match(/(mailto:[^)]*)/i) || (url.startsWith('mailto:') ? [url, url] : null);
      if (!mailtoMatch) return;
      const mailto = mailtoMatch[1];
      router.push('/compose?mailto=' + encodeURIComponent(mailto));
    } catch {}
  }, [router]);

  useEffect(() => {
    if (Platform.OS === 'web') return;

    // Handle cold-start URL (app opened from a mailto: link)
    Linking.getInitialURL().then((url) => {
      if (url && url.toLowerCase().startsWith('mailto:')) handleMailtoUrl(url);
    }).catch(() => {});

    // Handle warm-start URL (app already running, user taps mailto: link)
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (url && url.toLowerCase().startsWith('mailto:')) handleMailtoUrl(url);
    });

    return () => sub.remove();
  }, [handleMailtoUrl]);
}

function AppInit({ onNotification }) {
  const cleanupRef = useRef(null);
  const pathname = usePathname();
  const pathnameRef = useRef(null);
  const prefetchedRef = useRef(false);
  useMailtoLinking();

  // Pre-fetch key data after login so screens load instantly from cache
  useEffect(() => {
    if (prefetchedRef.current) return;
    prefetchedRef.current = true;
    // Warm memory cache from persistent storage first
    warmCache(['contacts', 'calendar_events', 'files_root', 'notes', 'one_conversations']).catch(() => {});
    // Then pre-fetch fresh data in background (low priority, staggered)
    const doPreload = async () => {
      try {
        const apiMod = await import('../services/api');
        // Stagger requests to avoid slamming server
        setTimeout(() => prefetch('contacts', () => apiMod.getContactsList(), 600000).catch(() => {}), 1000);
        setTimeout(() => {
          const now = new Date();
          const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          const end = new Date(now.getFullYear(), now.getMonth() + 2, 0);
          const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T00:00:00`;
          prefetch('calendar_events', () => apiMod.calEvents(fmt(start), fmt(end)), 600000).catch(() => {});
        }, 2000);
        setTimeout(() => prefetch('files_root', () => apiMod.fileList(null), 600000).catch(() => {}), 3000);
        setTimeout(() => prefetch('notes', () => apiMod.notesList({}), 600000).catch(() => {}), 4000);
      } catch {}
    };
    // Delay pre-fetch to not compete with initial inbox load
    setTimeout(doPreload, 3000);
  }, []);

  // Track screen navigation changes
  useEffect(() => {
    if (pathname && pathname !== pathnameRef.current) {
      pathnameRef.current = pathname;
      try { trackPageview(pathname); } catch {}
    }
  }, [pathname]);

  useEffect(() => {
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
          @keyframes shimmerSlide { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
          @keyframes pulseGlow { 0%,100%{box-shadow:0 0 0 0 rgba(37,99,235,0)} 50%{box-shadow:0 0 0 12px rgba(37,99,235,0.12)} }
          @keyframes badgeBounce { 0%{transform:scale(0.3)} 60%{transform:scale(1.15)} 100%{transform:scale(1)} }
          @keyframes smoothSlideIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
          @keyframes folderHighlight { from{background-color:transparent} to{background-color:rgba(37,99,235,0.08)} }
          @keyframes starGlow { 0%{filter:drop-shadow(0 0 0 rgba(245,158,11,0))} 50%{filter:drop-shadow(0 0 8px rgba(245,158,11,0.6))} 100%{filter:drop-shadow(0 0 0 rgba(245,158,11,0))} }
          input:-webkit-autofill { -webkit-box-shadow: 0 0 0 30px white inset !important; }
          * { -webkit-tap-highlight-color: transparent; box-sizing: border-box; }
          html { scroll-behavior: smooth; }
          body { overscroll-behavior: none; }
          ::-webkit-scrollbar { width: 6px; height: 6px; }
          ::-webkit-scrollbar-track { background: transparent; }
          ::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.15); border-radius: 6px; }
          ::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,0.3); }
          @media (min-width: 900px) {
            ::-webkit-scrollbar { width: 8px; }
          }
          /* Smooth transitions on interactive elements */
          [data-pressable], [role="button"] { transition: transform 0.15s ease, opacity 0.15s ease, background-color 0.18s ease; }
          /* Selection color */
          ::selection { background: rgba(37,99,235,0.2); color: inherit; }
          /* Focus ring for keyboard navigation */
          :focus-visible { outline: 2px solid rgba(37,211,102,0.6); outline-offset: 2px; border-radius: 4px; }
          /* Smooth image loading */
          img { transition: opacity 0.3s ease; }
          /* Desktop chat message hover */
          @media (min-width: 900px) {
            @keyframes msgHover { from { background-color: transparent; } to { background-color: rgba(128,128,128,0.04); } }
          }
          /* Tooltip styles */
          [data-tooltip] { position: relative; }
          [data-tooltip]:hover::after { content: attr(data-tooltip); position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); padding: 4px 10px; border-radius: 6px; font-size: 11px; white-space: nowrap; background: rgba(0,0,0,0.8); color: #fff; pointer-events: none; animation: fadeIn 0.15s ease; z-index: 999; }
        `;
        document.head.appendChild(style);
      }
    }

    let mounted = true;

    // Analytics tracking — app_open for native only (web pageviews tracked by pathname useEffect)
    try {
      if (Platform.OS !== 'web') { trackAppOpen(); }
    } catch {}

    // Set foreground notification handler for in-app toast (works on all platforms)
    (async () => {
      try {
        const { setForegroundNotificationHandler } = await import('../services/pushNotifications');
        setForegroundNotificationHandler((notif) => {
          if (mounted) onNotification?.(notif);
        });
      } catch {}
    })();

    // Listen for login_challenge events via WebSocket (all platforms including web)
    let wsLoginUnsub = null;
    (async () => {
      try {
        const ws = (await import('../services/websocket')).default;
        const { triggerLoginChallengePrompt } = await import('../components/LoginChallengePrompt');
        wsLoginUnsub = ws.on('login_challenge', (data) => {
          if (data?.challenge_id) triggerLoginChallengePrompt(data);
        });
      } catch {}
    })();

    if (Platform.OS === 'web') return () => { mounted = false; if (wsLoginUnsub) wsLoginUnsub(); };

    (async () => {
      try {
        const {
          registerForPushNotifications,
          sendTokenToBackend,
          setupNotificationListeners,
          clearBadge,
        } = await import('../services/pushNotifications');

        if (!mounted) return;

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

    // Setup CallKit + VoIP Push (iOS only)
    (async () => {
      try {
        const { setupCallKeep } = await import('../services/callkeep');
        if (mounted) await setupCallKeep();
      } catch {}
    })();

    // Sync phone contacts in background (so server knows which contacts we have, for new user notifications)
    if (Platform.OS !== 'web') {
      setTimeout(async () => {
        try {
          const Contacts = await import('expo-contacts');
          const { status } = await Contacts.getPermissionAsync();
          if (status === 'granted') {
            const { syncContacts } = await import('../services/contactSync');
            await syncContacts();
          }
        } catch {}
      }, 5000); // Delay 5s to not block app startup
    }

    // Initialize auto photo backup (global, not tied to Photos screen)
    // Listens for new photos (MediaLibrary) and app foreground (AppState)
    if (Platform.OS !== 'web') {
      setTimeout(() => {
        initAutoBackup().catch(() => {});
      }, 2000); // Start backup quickly (was 10s - too slow, user minimizes before)
    }

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
      if (wsLoginUnsub) wsLoginUnsub();
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
    <GestureHandlerRootView style={{ flex: 1 }}>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
        <ThemeProvider>
          <LanguageProvider>
          <BiometricProvider>
            <AuthProvider>
              <MailProvider>
                <PhotosProvider>
                <AppInit onNotification={handleNotification} />
                <OfflineNotice />
                <StatusBar style="auto" />
                <Stack screenOptions={{
                  headerShown: false,
                  animation: 'fade',
                  animationDuration: 150,
                }}>
                  <Stack.Screen name="index" options={{ animation: 'none' }} />
                  <Stack.Screen name="login" options={{ animation: 'fade', animationDuration: 150 }} />
                  <Stack.Screen name="signup" options={{ animation: 'slide_from_right', animationDuration: 150 }} />
                  <Stack.Screen name="inbox" options={{ animation: 'fade', animationDuration: 100 }} />
                  <Stack.Screen name="compose" options={{ presentation: 'modal', animation: 'slide_from_bottom', animationDuration: 180 }} />
                  <Stack.Screen name="read" options={{ presentation: 'modal', animation: 'slide_from_right', animationDuration: 150 }} />
                  <Stack.Screen name="profile" options={{ presentation: 'modal', animation: 'slide_from_bottom', animationDuration: 180 }} />
                  <Stack.Screen name="settings" options={{ presentation: 'modal', animation: 'slide_from_bottom', animationDuration: 180 }} />
                  <Stack.Screen name="meet/[id]" options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade', animationDuration: 120 }} />
                  <Stack.Screen name="call" options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade', animationDuration: 120, gestureEnabled: false, freezeOnBlur: false }} />
                  <Stack.Screen name="meetings" options={{ presentation: 'card', animation: 'fade', animationDuration: 150 }} />
                  <Stack.Screen name="meeting-create" options={{ presentation: 'card', animation: 'slide_from_bottom', animationDuration: 180 }} />
                  <Stack.Screen name="meeting-detail" options={{ presentation: 'card', animation: 'slide_from_right', animationDuration: 150 }} />
                  <Stack.Screen name="meeting-recap" options={{ presentation: 'card', animation: 'slide_from_right', animationDuration: 150 }} />
                  <Stack.Screen name="files" options={{ presentation: 'card', animation: 'fade', animationDuration: 150 }} />
                  <Stack.Screen name="calendar" options={{ presentation: 'card', animation: 'fade', animationDuration: 150, gestureEnabled: false }} />
                  <Stack.Screen name="event-detail" options={{ presentation: 'card', animation: 'slide_from_right', animationDuration: 150 }} />
                  <Stack.Screen name="chat" options={{ presentation: 'card', animation: 'fade', animationDuration: 120 }} />
                  <Stack.Screen name="chat-conversation" options={{ presentation: 'card', animation: 'slide_from_right', animationDuration: 150, gestureEnabled: false }} />
                  <Stack.Screen name="chat-new" options={{ presentation: 'card', animation: 'slide_from_bottom', animationDuration: 180 }} />
                  <Stack.Screen name="documentos" options={{ presentation: 'card', animation: 'fade', animationDuration: 150 }} />
                  <Stack.Screen name="one" options={{ presentation: 'card', animation: 'fade', animationDuration: 150 }} />
                  <Stack.Screen name="drive" options={{ presentation: 'card', animation: 'fade', animationDuration: 150 }} />
                  <Stack.Screen name="photos" options={{ presentation: 'card', animation: 'fade', animationDuration: 150 }} />
                  <Stack.Screen name="live-broadcast" options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade', animationDuration: 120 }} />
                  <Stack.Screen name="live-viewer" options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade', animationDuration: 120 }} />
                  <Stack.Screen name="notes" options={{ presentation: 'card', animation: 'fade', animationDuration: 150 }} />
                  <Stack.Screen name="notebook-editor" options={{ presentation: 'card', animation: 'slide_from_right', animationDuration: 150, gestureEnabled: false }} />
                  <Stack.Screen name="plans" options={{ presentation: 'card', animation: 'fade', animationDuration: 150 }} />
                  <Stack.Screen name="backup" options={{ presentation: 'card', animation: 'fade', animationDuration: 150 }} />
                  <Stack.Screen name="contacts" options={{ presentation: 'card', animation: 'slide_from_right', animationDuration: 150 }} />
                  <Stack.Screen name="forgot" options={{ animation: 'slide_from_right', animationDuration: 150 }} />
                </Stack>
                <ActiveCallBar />
                <IncomingCallListener />
                <LoginChallengePrompt />
                <NotificationToast
                  notification={toastNotif}
                  onDismiss={() => setToastNotif(null)}
                />
              </PhotosProvider>
              </MailProvider>
            </AuthProvider>
          </BiometricProvider>
          </LanguageProvider>
        </ThemeProvider>
      </SafeAreaProvider>
      </QueryClientProvider>
    </ErrorBoundary>
    </GestureHandlerRootView>
  );
}
