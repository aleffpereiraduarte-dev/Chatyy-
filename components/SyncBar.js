/**
 * SyncBar — WhatsApp-style connection status
 * Only shows when ACTUALLY disconnected (3s grace period)
 * Shows sync progress during initial sync
 */
import { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing } from '../constants/theme';
let mailWs = null;
try { mailWs = require('../services/websocket').default; } catch (e) { console.warn('[SyncBar] websocket module not available:', e.message); }
import useIsMounted from '../hooks/useIsMounted';

export default function SyncBar() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [status, setStatus] = useState('hidden'); // hidden | connecting | syncing | offline | bootstrap
  const [progress, setProgress] = useState(0);
  // Bootstrap-only state: counts of conversations downloaded vs total. We
  // surface this as "Sincronizando histórico • 42/127 conversas" so the user
  // can SEE that all their old chats are being pulled into the device, like
  // WhatsApp's first-time message restore. (#1194)
  const [bootConvDone, setBootConvDone] = useState(0);
  const [bootConvTotal, setBootConvTotal] = useState(0);
  const slideAnim = useRef(new Animated.Value(-36)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;
  const dotAnim = useRef(new Animated.Value(0)).current;
  const graceTimer = useRef(null);
  const connectingTimeout = useRef(null);
  const syncStallTimer = useRef(null);
  const mountedRef = useIsMounted();
  // [WA-parity 2026-05-31] Track the DEVICE's own internet reachability,
  // separate from the WS/server state. This lets us be honest like WhatsApp:
  //   • device offline        → "Aguardando rede" / "Sem internet"
  //   • device online, WS down → "Conectando…" (server unreachable, keep trying)
  // Without this we'd conflate a flaky local radio with a server outage and
  // show the wrong copy (e.g. "Conectando…" forever while in airplane mode).
  const deviceOnlineRef = useRef(true);
  // [2026-06-28] handleBootstrap lives inside the deps:[] effect below, so any
  // `status` it reads is captured at mount (always 'hidden') — the guard
  // `status === 'hidden'` was therefore ALWAYS true. Track the live value in a
  // ref kept current by an effect so the guard reflects the real status.
  const statusRef = useRef('hidden');
  useEffect(() => { statusRef.current = status; }, [status]);

  // Dot pulse for connecting/offline
  useEffect(() => {
    if (status === 'connecting' || status === 'offline') {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(dotAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
          Animated.timing(dotAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
  }, [status]);

  // Auto-hide "Connecting..." after 3s on web (was 7s) to avoid the bar
  // lingering past a brief WS reconnect — WhatsApp Web hides it after ~2s of
  // a flap. Native keeps the 7s ceiling because backgrounded reconnects on
  // mobile data can legitimately take that long.
  // 2026-05-18 (#1131): web auto-hide tightened.
  useEffect(() => {
    clearTimeout(connectingTimeout.current);
    if (status === 'connecting') {
      const ceiling = Platform.OS === 'web' ? 3000 : 7000;
      connectingTimeout.current = setTimeout(() => {
        if (!mountedRef.current) return;
        Animated.timing(slideAnim, { toValue: -36, duration: 300, useNativeDriver: true }).start(() => {
          if (mountedRef.current) setStatus('hidden');
        });
      }, ceiling);
    }
    return () => clearTimeout(connectingTimeout.current);
  }, [status]);

  useEffect(() => {
    const show = (s) => {
      if (!mountedRef.current) return;
      setStatus(s);
      Animated.timing(slideAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start();
    };
    const hide = () => {
      if (!mountedRef.current) return;
      Animated.timing(slideAnim, { toValue: -36, duration: 200, useNativeDriver: true }).start(() => {
        if (mountedRef.current) setStatus('hidden');
      });
    };

    const handleConnection = ({ status: s }) => {
      clearTimeout(graceTimer.current);
      if (s === 'authenticated' || s === 'connected') {
        // Connected — hide after tiny delay
        graceTimer.current = setTimeout(hide, 500);
      } else if (s === 'disconnected') {
        // Only show "Connecting..." after a grace period of being disconnected
        // so brief reconnects don't flash a banner at the user. Web uses a
        // longer grace (5s) because reconnects there are sub-second in 95%
        // of cases (WS just resumes on next tick). Native keeps 3s because
        // backgrounded radios legitimately take a moment.
        // 2026-05-18 (#1131): bumped web grace to 5s.
        const grace = Platform.OS === 'web' ? 5000 : 3000;
        graceTimer.current = setTimeout(() => {
          if (mountedRef.current && !mailWs?.authenticated) {
            // [WA-parity 2026-05-31] Honest copy: only say "Conectando…" when
            // the device actually has internet and it's the server we can't
            // reach. If the device itself is offline, surface "Sem internet"
            // instead so we don't blame the server for a local radio drop.
            show(deviceOnlineRef.current ? 'connecting' : 'offline');
          }
        }, grace);
      }
    };

    const armStallTimer = () => {
      clearTimeout(syncStallTimer.current);
      // If no progress event for 4s, assume sync silently completed and hide.
      // Without this, "Finishing..." stays forever if the WS never emits `done`.
      // 2026-05-18 (#1131): tightened 8s → 4s. Users were seeing the bar linger
      // for 5-8s on healthy networks where progress events trickled slowly
      // between phases — felt like the app was stuck.
      syncStallTimer.current = setTimeout(() => {
        if (mountedRef.current) hide();
      }, 4000);
    };
    const handleSync = ({ phase, progress: p }) => {
      clearTimeout(graceTimer.current);
      // [2026-06-29] Fully SILENT history sync on ALL platforms (founder:
      // "toda hora aparece em cima, deveria ser mais no background sem o
      // cliente ver"). The routine initial/delta sync runs every cold start;
      // surfacing a "Sincronizando…" bar each time felt like the app was
      // stuck. The sync ENGINE (services/initialSync + fullHistorySync) is
      // unaffected — it keeps running in the background; we just never paint
      // the progress bar. The cached chat list shows instantly and messages
      // fill in as the sync completes, exactly like WhatsApp. Only genuine
      // connectivity states (offline / connecting) still surface, and those
      // are NOT "toda hora" — they only appear after a real disconnect grace.
      return;
      if (phase === 'start') {
        show('syncing');
        setProgress(0);
        armStallTimer();
      } else if (phase === 'progress') {
        setProgress(p || 0);
        if ((p || 0) >= 100) {
          clearTimeout(syncStallTimer.current);
          setTimeout(hide, 800);
        } else {
          armStallTimer();
        }
      } else if (phase === 'done' || phase === 'error') {
        // Treat error identically to done — the bar is informational, not
        // an error surface; a separate loadError banner handles retries.
        clearTimeout(syncStallTimer.current);
        setTimeout(hide, phase === 'error' ? 200 : 800);
      }
    };

    // Per-conversation full-history bootstrap progress (#1194). Distinct
    // from the 8-phase initial sync above: this runs ONCE on first login
    // and walks every conversation's history into local SQLite. Shows a
    // thin pill "Sincronizando histórico • N/M conversas" that auto-hides
    // when the bootstrap reports phase=done.
    const handleBootstrap = ({ phase, convDone = 0, convTotal = 0 }) => {
      // [2026-06-29] SILENT history restore (founder request). The full-history
      // bootstrap on a new device / reinstall now runs entirely in the
      // background with NO visible bar — the chat list paints from the server
      // list immediately and each conversation's history streams into SQLite
      // invisibly. (The engine in services/fullHistorySync.js is unchanged and
      // keeps running; we just stop driving the UI bar.) Kept registered as a
      // no-op so re-enabling later is a one-line revert.
      return;
      // eslint-disable-next-line no-unreachable
      if (Platform.OS === 'web') return; // SQLite-only feature
      if (phase === 'start') {
        setBootConvDone(0);
        setBootConvTotal(convTotal || 0);
        // Don't show immediately on start when there are 0 convs — that
        // means the user is brand new and has nothing to download.
        if ((convTotal || 0) > 0) show('bootstrap');
      } else if (phase === 'conv') {
        setBootConvDone(convDone || 0);
        setBootConvTotal(convTotal || 0);
        if ((convTotal || 0) > 0 && statusRef.current === 'hidden') show('bootstrap');
      } else if (phase === 'done') {
        setBootConvDone(convDone || 0);
        // Brief "done" frame then slide out
        setTimeout(() => { if (mountedRef.current) hide(); }, 1200);
      }
    };

    mailWs?.on?.('connection', handleConnection);
    mailWs?.on?.('sync_progress', handleSync);
    mailWs?.on?.('chat_bootstrap_progress', handleBootstrap);

    // [WA-parity 2026-05-31] Network reachability detection. We keep
    // deviceOnlineRef in sync so handleConnection can pick honest copy, and
    // we drive the bar directly on transitions:
    //   device → offline : "Sem internet" (sync.offline)
    //   device → online  : if WS already authed, hide; else "Conectando…"
    //                       (server now reachable — we're retrying the WS).
    let netUnsub;
    if (Platform.OS === 'web') {
      const onOff = () => { deviceOnlineRef.current = false; show('offline'); };
      const onOn = () => {
        deviceOnlineRef.current = true;
        if (mailWs?.authenticated) hide();
        else show('connecting');
      };
      window.addEventListener('offline', onOff);
      window.addEventListener('online', onOn);
      deviceOnlineRef.current = !!navigator.onLine;
      if (!navigator.onLine) show('offline');
      netUnsub = () => {
        window.removeEventListener('offline', onOff);
        window.removeEventListener('online', onOn);
      };
    } else {
      try {
        const NetInfo = require('@react-native-community/netinfo').default;
        netUnsub = NetInfo.addEventListener(st => {
          // isInternetReachable can be null (unknown) right after connecting —
          // treat null as "assume reachable" to avoid a false offline flash,
          // but a hard false (connected to wifi w/ no internet) IS offline.
          const online = !!st.isConnected && st.isInternetReachable !== false;
          deviceOnlineRef.current = online;
          if (!online) show('offline');
          else if (mailWs?.authenticated) hide();
          else show('connecting');
        });
      } catch {}
    }

    return () => {
      clearTimeout(graceTimer.current);
      clearTimeout(connectingTimeout.current);
      clearTimeout(syncStallTimer.current);
      mailWs?.off?.('connection', handleConnection);
      mailWs?.off?.('sync_progress', handleSync);
      mailWs?.off?.('chat_bootstrap_progress', handleBootstrap);
      netUnsub?.();
    };
  }, []);

  // Progress bar
  useEffect(() => {
    Animated.timing(progressAnim, { toValue: progress / 100, duration: 200, useNativeDriver: true }).start();
  }, [progress]);

  if (status === 'hidden') return null;

  const isOffline = status === 'offline';
  const isBootstrap = status === 'bootstrap';
  const bgColor = isOffline ? (isDark ? '#7f1d1d' : '#fef2f2') : (isDark ? '#1e3a5f' : '#F5F3FF');
  const textColor = isOffline ? (isDark ? '#fca5a5' : '#dc2626') : (isDark ? '#93c5fd' : '#7C3AED');

  let label;
  if (status === 'offline') label = t('sync.offline') || 'No internet';
  else if (status === 'connecting') label = t('sync.connecting') || 'Connecting...';
  else if (isBootstrap) {
    const tmpl = t('sync.history') || 'Syncing history';
    if (bootConvTotal > 0) label = `${tmpl} • ${bootConvDone}/${bootConvTotal}`;
    else label = tmpl;
  }
  else if (progress < 15) label = t('sync.conversations') || 'Loading conversations...';
  else if (progress < 55) label = t('sync.messages') || 'Downloading messages...';
  else if (progress < 65) label = t('sync.contacts') || 'Syncing contacts...';
  else if (progress < 75) label = t('sync.emails') || 'Caching emails...';
  else if (progress < 85) label = t('sync.calendar') || 'Syncing calendar...';
  else label = t('sync.finishing') || 'Finishing...';

  const progressW = progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  const bootProgressPct = bootConvTotal > 0 ? bootConvDone / bootConvTotal : 0;
  const bootProgressW = `${Math.max(0, Math.min(1, bootProgressPct)) * 100}%`;

  return (
    <Animated.View style={[s.bar, { backgroundColor: bgColor, transform: [{ translateY: slideAnim }] }]}>
      <View style={s.row}>
        <Animated.View style={[s.dot, { backgroundColor: textColor, opacity: dotAnim.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }]} />
        <Text style={[s.text, { color: textColor }]}>{label}</Text>
      </View>
      {status === 'syncing' && (
        <View style={[s.track, { backgroundColor: textColor + '20' }]}>
          <Animated.View style={[s.fill, { backgroundColor: textColor, width: progressW }]} />
        </View>
      )}
      {isBootstrap && bootConvTotal > 0 && (
        <View style={[s.track, { backgroundColor: textColor + '20' }]}>
          <View style={[s.fill, { backgroundColor: textColor, width: bootProgressW }]} />
        </View>
      )}
    </Animated.View>
  );
}

const s = StyleSheet.create({
  bar: { paddingHorizontal: Spacing.lg, paddingVertical: 5, zIndex: 99 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  text: { fontSize: FontSize.xs, fontWeight: '500' },
  track: { height: 2, borderRadius: 1, marginTop: 3, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 1 },
});
