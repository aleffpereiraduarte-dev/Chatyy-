import React, { Suspense } from "react";
import { Platform, View as RNView, Linking, Alert } from 'react-native';
let GestureHandlerRootView;
if (Platform.OS !== 'web') {
  try { GestureHandlerRootView = require('react-native-gesture-handler').GestureHandlerRootView; } catch {}
}
if (!GestureHandlerRootView) GestureHandlerRootView = ({ children, style }) => React.createElement(RNView, { style }, children);
// ─── Sentry crash reporting ───
import { initSentry } from '../services/sentry';
import { BASE_URL } from '../services/api';

// Deferred initialization — called once from useEffect in AppInit to avoid
// global side-effects at import time (HIGH severity audit finding).
let _globalInitDone = false;
function initGlobalErrorHandlers() {
  if (_globalInitDone) return;
  _globalInitDone = true;

  initSentry();

  // Global crash reporter — catches fatal errors before app closes
  if (typeof ErrorUtils !== 'undefined') {
    const _prev = ErrorUtils.getGlobalHandler();
    ErrorUtils.setGlobalHandler((error, isFatal) => {
      try {
        const msg = error?.message || String(error);
        const stack = error?.stack || '';
        // Send crash report to server (telemetry only)
        fetch(`${BASE_URL}/api/email.php?action=crash_report`, {
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
        // Show friendly message only — stack trace sent to telemetry above
        if (isFatal && Platform.OS !== 'web') {
          Alert.alert(
            'Erro inesperado',
            'O aplicativo encontrou um problema e precisa ser reiniciado.',
            [{ text: 'OK' }]
          );
        }
      } catch (e) {}
      // Call previous handler
      if (_prev) _prev(error, isFatal);
    });
  }
}
// ─── End crash reporter ───

import { useEffect, useRef, useState, useCallback } from 'react';
import { Stack, useRouter, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '../services/queryClient';
import { AuthProvider } from '../context/AuthContext';
import ChildRestrictionGuard from '../components/ChildRestrictionGuard';
import { MailProvider } from '../context/MailContext';
import { ThemeProvider } from '../context/ThemeContext';
import { LanguageProvider } from '../context/LanguageContext';
import { BiometricProvider } from '../context/BiometricContext';
import { PhotosProvider } from '../context/PhotosContext';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import ErrorBoundary from '../components/ErrorBoundary';
import OfflineNotice from '../components/OfflineNotice';
import NotificationToast from '../components/NotificationToast';
import { CallProvider } from '../context/CallContext';
import CallStatusBar from '../components/CallStatusBar';

// Lazy-load call components to break circular dependency
const IncomingCallListener = React.lazy(() => import('../components/IncomingCallListener'));
const ActiveCallBar = React.lazy(() => import('../components/ActiveCallBar'));
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

// Handles deep links: mailto:, chat, email, and other app URLs
function useDeepLinking() {
  const router = useRouter();

  const handleUrl = useCallback((url) => {
    if (!url) return;
    try {
      // mailto: links → compose screen
      const mailtoMatch = url.match(/(mailto:[^)]*)/i) || (url.startsWith('mailto:') ? [url, url] : null);
      if (mailtoMatch) {
        router.push('/compose?mailto=' + encodeURIComponent(mailtoMatch[1]));
        return;
      }

      // Parse chatyy.com.br deep links and onemundomail:// scheme
      // Patterns: chatyy.com.br/chat/123, chatyy.com.br/email/456
      let pathname = null;
      try {
        if (url.includes('chatyy.com.br') || url.includes('mail.onemundo.com.br')) {
          const parsed = new URL(url);
          pathname = parsed.pathname;
        } else if (url.startsWith('onemundomail://')) {
          pathname = '/' + url.replace('onemundomail://', '').split('?')[0];
        }
      } catch {}

      if (!pathname) return;

      // /chat/:id → open chat conversation
      const chatMatch = pathname.match(/^\/chat\/(\d+)/);
      if (chatMatch) {
        router.push('/chat-conversation?id=' + chatMatch[1]);
        return;
      }

      // /email/:id → open email
      const emailMatch = pathname.match(/^\/email\/(\d+)/);
      if (emailMatch) {
        router.push('/read?uid=' + emailMatch[1]);
        return;
      }

      // /meet/:id → open meeting room
      const meetMatch = pathname.match(/^\/meet\/([a-zA-Z0-9_-]+)/);
      if (meetMatch) {
        router.push('/meet/' + meetMatch[1]);
        return;
      }
    } catch {}
  }, [router]);

  useEffect(() => {
    // Web: check URL hash/search params on load for deep link routing
    if (Platform.OS === 'web') {
      try {
        const hash = window.location.hash;
        if (hash && hash.length > 1) {
          const path = hash.substring(1); // remove #
          const chatMatch = path.match(/^\/chat\/(\d+)/);
          if (chatMatch) {
            setTimeout(() => router.push('/chat-conversation?id=' + chatMatch[1]), 500);
          }
          const emailMatch = path.match(/^\/email\/(\d+)/);
          if (emailMatch) {
            setTimeout(() => router.push('/read?uid=' + emailMatch[1]), 500);
          }
        }
      } catch {}
      return;
    }

    // Native: handle cold-start and warm-start URLs
    Linking.getInitialURL().then((url) => {
      if (url) handleUrl(url);
    }).catch(() => {});

    const sub = Linking.addEventListener('url', ({ url }) => {
      if (url) handleUrl(url);
    });

    return () => sub.remove();
  }, [handleUrl]);
}

function AppInit({ onNotification }) {
  const cleanupRef = useRef(null);
  const pathname = usePathname();
  const pathnameRef = useRef(null);
  const prefetchedRef = useRef(false);
  useDeepLinking();

  // Check for OTA updates on app open (since checkAutomatically may be ON_ERROR_RECOVERY)
  useEffect(() => {
    if (Platform.OS === 'web') return;
    (async () => {
      try {
        const Updates = require('expo-updates');
        if (!Updates?.checkForUpdateAsync) return;
        const update = await Updates.checkForUpdateAsync();
        if (update.isAvailable) {
          await Updates.fetchUpdateAsync();
          Updates.reloadAsync();
        }
      } catch (e) { /* silent — OTA check is best-effort */ }
    })();
  }, []);

  // Pre-fetch key data after login so screens load instantly from cache
  useEffect(() => {
    if (prefetchedRef.current) return;
    prefetchedRef.current = true;
    // Warm memory cache from persistent storage first
    warmCache(['contacts', 'calendar_events', 'files_root', 'notes', 'one_conversations']).catch(() => {});
    // Bootstrap: ONE request gets ALL data (Redis-cached on server = instant)
    const doPreload = async () => {
      try {
        const apiMod = await import('../services/api');
        const { cacheConversations, cacheMessages } = await import('../services/chatCache');

        // Call bootstrap first (returns everything in 1 request, cached 60s on server)
        try {
          const boot = await apiMod.bootstrap();
          if (boot?.success && boot.data?.conversations) {
            cacheConversations(boot.data.conversations).catch(() => {});
          }
        } catch {}

        // Then prefetch remaining data in parallel
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const end = new Date(now.getFullYear(), now.getMonth() + 2, 0);
        const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T00:00:00`;

        // Fire all in parallel
        Promise.all([
          prefetch('contacts', () => apiMod.getContactsList(), 600000).catch(() => {}),
          prefetch('calendar_events', () => apiMod.calEvents(fmt(start), fmt(end)), 600000).catch(() => {}),
          prefetch('files_root', () => apiMod.fileList(null), 600000).catch(() => {}),
          prefetch('notes', () => apiMod.notesList({}), 600000).catch(() => {}),
        ]).catch(() => {});

        // Chat conversations + messages
        (async () => {
          try {
            const convRes = await apiMod.chatConversations();
            if (convRes?.success) {
              const convs = convRes.data?.conversations || convRes.data?.chats || [];
              cacheConversations(convs).catch(() => {});

              // Pre-cache last 30 messages for top 15 conversations (background, staggered)
              const topConvs = convs.slice(0, 15);
              for (let i = 0; i < topConvs.length; i++) {
                setTimeout(async () => {
                  try {
                    const msgRes = await apiMod.chatMessages(topConvs[i].id, 30);
                    if (msgRes?.success) {
                      cacheMessages(topConvs[i].id, msgRes.data?.messages || []).catch(() => {});
                    }
                  } catch {}
                }, i * 500); // 500ms between each to not slam server
              }
            }
          } catch {}
        }, 5000);

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
    // Initialize global error handlers (Sentry + crash reporter) on first mount
    initGlobalErrorHandlers();

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
    // SKIP on web to avoid TDZ issues in callkeep module
    if (Platform.OS !== 'web') {
      (async () => {
        try {
          const { setupCallKeep } = await import('../services/callkeep');
          if (mounted) await setupCallKeep();
        } catch (e) {
          console.warn('[CallKeep] Setup failed:', e.message);
        }
      })();
    }

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

    // OTA disabled in app — updates via TestFlight/Play Store builds only
    // OTA was causing app to slow down and crash with too many stacked updates
    // See: https://github.com/expo/expo/issues/26231

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
              <CallProvider>
              <MailProvider>
                <PhotosProvider>
                <AppInit onNotification={handleNotification} />
                <OfflineNotice />
                <StatusBar style="auto" />
                <ChildRestrictionGuard>
                <Stack screenOptions={{
                  headerShown: false,
                  animation: 'fade',
                  animationDuration: 150,
                }}>
                  <Stack.Screen name="index" options={{ animation: 'none' }} />
                  <Stack.Screen name="login" options={{ animation: 'fade', animationDuration: 150 }} />
                  <Stack.Screen name="signup" options={{ animation: 'slide_from_right', animationDuration: 150 }} />
                  <Stack.Screen name="verify-phone-required" options={{ animation: 'fade', animationDuration: 150, gestureEnabled: false }} />
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
                  <Stack.Screen name="chat-conversation" options={{ presentation: 'card', animation: 'slide_from_right', animationDuration: 150, gestureEnabled: true }} />
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
                  <Stack.Screen name="user-profile" options={{ presentation: 'card', animation: 'slide_from_right', animationDuration: 150 }} />
                  <Stack.Screen name="contacts" options={{ presentation: 'card', animation: 'slide_from_right', animationDuration: 150 }} />
                  <Stack.Screen name="parental" options={{ presentation: 'card', animation: 'slide_from_right', animationDuration: 150 }} />
                  <Stack.Screen name="parental-monitor" options={{ presentation: 'card', animation: 'slide_from_right', animationDuration: 150 }} />
                  <Stack.Screen name="parental-child-chat" options={{ presentation: 'card', animation: 'slide_from_right', animationDuration: 150 }} />
                  <Stack.Screen name="kids-learn" options={{ presentation: 'card', animation: 'slide_from_right', animationDuration: 150 }} />
                  <Stack.Screen name="forgot" options={{ animation: 'slide_from_right', animationDuration: 150 }} />
                </Stack>
                </ChildRestrictionGuard>
                <Suspense fallback={null}>
                  <ActiveCallBar />
                </Suspense>
                <CallStatusBar />
                <Suspense fallback={null}>
                  <IncomingCallListener />
                </Suspense>
                <LoginChallengePrompt />
                <NotificationToast
                  notification={toastNotif}
                  onDismiss={() => setToastNotif(null)}
                />
              </PhotosProvider>
              </MailProvider>
              </CallProvider>
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
