import { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Animated } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import { IconWifiOff, IconRefresh } from './Icons';
import { useLanguage } from '../context/LanguageContext';

// [2026-10-01] Cruza a conectividade com o socket real: um WS conectado+
// autenticado é PROVA de que o device tem internet funcionando, mesmo quando o
// NetInfo/NWPathMonitor reporta "offline" por engano (sonda de alcançabilidade
// bloqueada, VPN, captive-portal). Usado pra suprimir um falso "sem conexão"
// (founder: "apareceu sem conexão mas o wifi não tinha caído").
let mailWs = null;
try { mailWs = require('../services/websocket').default; } catch {}

export default function OfflineNotice() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [isOffline, setIsOffline] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const [slideAnim] = useState(new Animated.Value(-60));
  const wasOffline = useRef(false);

  useEffect(() => {
    // [2026-09-30 WhatsApp-invisible-reconnect] Debounce SHOWING the offline
    // bar. A brief network blip (carrier handoff, AP roam, radio sleep/wake,
    // a single slow request) must NOT flash "sem conexão" — WhatsApp silently
    // rides out sub-few-second outages. So we only paint the bar after the
    // connection has been down for a SUSTAINED window; hiding is INSTANT so
    // reconnect feels immediate (and so the offline-queue replay effect — which
    // keys off `isOffline` going false — still fires the moment we're back).
    const OFFLINE_SHOW_DELAY_MS = 4000;
    let offlineTimer = null;
    let wsUnsub = null;
    let wsPoll = null;
    const applyConnectivity = (online) => {
      if (online) {
        // Back online → hide immediately + cancel any pending show.
        if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; } if (wsUnsub) { try { wsUnsub(); } catch {} wsUnsub = null; } if (wsPoll) { clearInterval(wsPoll); wsPoll = null; }
        setIsOffline(false);
      } else {
        // Went offline → arm the sustained-outage timer (don't stack timers
        // if one is already pending; don't reset it on repeat offline events).
        if (offlineTimer) return;
        offlineTimer = setTimeout(() => {
          offlineTimer = null;
          // O socket vivo sobrepõe um falso-offline do NetInfo/NWPathMonitor
          // (wifi ok, mas a sonda de alcançabilidade falhou). Só pinta "sem
          // conexão" se o socket real TAMBÉM estiver caído.
          if (mailWs && mailWs.authenticated) return;
          setIsOffline(true);
        }, OFFLINE_SHOW_DELAY_MS);
      }
    };

    // [2026-10-02] Continuous "live socket == real internet" override. The old
    // code checked mailWs.authenticated only ONCE (when the 4s timer fired), so
    // if the socket reconnected AFTER the bar was already shown, the bar stayed
    // STUCK — NetInfo/NWPathMonitor never sends an "online" event on a false
    // offline (blocked reachability probe / captive portal / VPN), so nothing
    // hid it. Founder: "às vezes fica 'sem internet' na home mesmo com net."
    // Now: the instant the WS authenticates we hide the bar, AND we poll the
    // live socket every 1s so a healthy socket ALWAYS wins over a false offline.
    try {
      if (mailWs && typeof mailWs.on === 'function') {
        wsUnsub = mailWs.on('connection', (e) => {
          if (e && (e.status === 'authenticated'
            || ((e.status === 'connected' || e.status === 'pong') && mailWs.authenticated))) {
            applyConnectivity(true);
          }
        });
      }
    } catch {}
    wsPoll = setInterval(() => {
      try { if (mailWs && mailWs.authenticated) applyConnectivity(true); } catch {}
    }, 1000);

    if (Platform.OS === 'web') {
      const handleOnline = () => applyConnectivity(true);
      const handleOffline = () => applyConnectivity(false);
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
      applyConnectivity(navigator.onLine);
      return () => {
        if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; } if (wsUnsub) { try { wsUnsub(); } catch {} wsUnsub = null; } if (wsPoll) { clearInterval(wsPoll); wsPoll = null; }
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
      };
    } else {
      // ⭐ Native NWPathMonitor (iOS) — instant, sub-100ms detection
      // (vs NetInfo polling which can take 1-2s). The toolkit module
      // also exposes isOnlineSync so we can prime the initial state
      // without waiting for the first event.
      let NativeToolkit = null;
      if (Platform.OS === 'ios') {
        try { NativeToolkit = require('../modules/expo-native-toolkit').Toolkit; } catch {}
      }
      if (NativeToolkit?.isOnlineSync) {
        applyConnectivity(NativeToolkit.isOnlineSync());
      }
      let NetInfo;
      try {
        NetInfo = require('@react-native-community/netinfo').default;
      } catch {
        return () => { if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; } if (wsUnsub) { try { wsUnsub(); } catch {} wsUnsub = null; } if (wsPoll) { clearInterval(wsPoll); wsPoll = null; } };
      }
      const unsub = NetInfo.addEventListener(state => {
        // Use the native value when available — more accurate than NetInfo's
        // event timing. NetInfo still drives the listener (event-based).
        if (NativeToolkit?.isOnlineSync) {
          applyConnectivity(NativeToolkit.isOnlineSync());
        } else {
          // [2026-06-28] Align with SyncBar: a radio that's "connected" to wifi
          // with no internet (isInternetReachable === false) IS offline. null
          // (unknown, right after connect) is treated as reachable to avoid a
          // false offline flash.
          const online = !!state.isConnected && state.isInternetReachable !== false;
          applyConnectivity(online);
        }
      });
      return () => {
        if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; } if (wsUnsub) { try { wsUnsub(); } catch {} wsUnsub = null; } if (wsPoll) { clearInterval(wsPoll); wsPoll = null; }
        unsub();
      };
    }
  }, []);

  // Auto-replay offline queue when coming back online
  useEffect(() => {
    if (isOffline) {
      wasOffline.current = true;
      // Show pending actions count
      try {
        const { getOfflineQueue } = require('../services/offlineCache');
        getOfflineQueue().then(q => setQueueCount(q.length)).catch(() => {});
      } catch {}
    } else if (wasOffline.current) {
      wasOffline.current = false;
      // Back online — replay queued actions
      try {
        const { replayOfflineQueue } = require('../services/offlineCache');
        const api = require('../services/api');
        replayOfflineQueue(api).then(({ replayed }) => {
          if (replayed > 0) console.log(`[Offline] Replayed ${replayed} queued actions`);
          setQueueCount(0);
        }).catch(() => {});
      } catch {}
    }
  }, [isOffline]);

  useEffect(() => {
    Animated.timing(slideAnim, {
      toValue: isOffline ? 0 : -60,
      duration: 300,
      useNativeDriver: false,
    }).start();
  }, [isOffline]);

  if (!isOffline) return null;

  // WhatsApp-style: slim, neutral-gray bar — NOT a loud yellow alert. The
  // user already knows they're offline (system status bar shows airplane /
  // wifi-off icon). Our job is a subtle reminder that pending actions are
  // queued. No retry button: auto-reconnect drains the outbox naturally.
  const bg = isDarkMode(colors) ? 'rgba(202,210,217,0.10)' : '#f0f2f5';
  const fg = isDarkMode(colors) ? 'rgba(202,210,217,0.92)' : '#3b4a54';
  return (
    <Animated.View style={[s.container, { backgroundColor: bg, transform: [{ translateY: slideAnim }] }]}>
      <IconWifiOff size={13} color={fg} />
      <Text style={[s.text, { color: fg }]} numberOfLines={1}>
        {t('offline.noConnection')}{queueCount > 0 ? ` · ${queueCount}` : ''}
      </Text>
    </Animated.View>
  );
}

// Cheap dark-mode detector — most ThemeContexts expose `isDark` but the
// shared ones pass only `colors`. Fall back to luminance of the background.
function isDarkMode(colors) {
  if (colors?.background) {
    const hex = (colors.background || '').replace('#', '');
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return lum < 0.5;
    }
  }
  return false;
}

const s = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: 5,
    gap: 6,
    zIndex: 100,
  },
  text: { fontSize: 12, fontWeight: '500', letterSpacing: 0.1 },
});
