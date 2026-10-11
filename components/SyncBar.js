/**
 * SyncBar — WhatsApp-style connection status
 * Only shows when ACTUALLY disconnected (3s grace period)
 * Shows sync progress during initial sync
 */
import { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Platform, AppState } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing } from '../constants/theme';
let mailWs = null;
try { mailWs = require('../services/websocket').default; } catch (e) { console.warn('[SyncBar] websocket module not available:', e.message); }
import useIsMounted from '../hooks/useIsMounted';
import { setActiveInterval } from '../utils/activeInterval'; // [2026-10-10 perf-battery]

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
  // WhatsApp-parity: the INITIAL cold-start WS connect must be SILENT. Only
  // after the socket has connected at least once this session does a later
  // 'disconnected' count as a real reconnect worth surfacing.
  const hasConnectedOnceRef = useRef(false);

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

    // [2026-10-01 WA-parity cold-start flash fix] The SINGLE place that may
    // ever surface "Conectando…". It NEVER shows synchronously — it only arms
    // a grace timer and, when that timer fires, shows the bar IFF we are still
    // not authenticated (and the device still has internet). This is what makes
    // a normal cold start silent: the WS authenticates within 1-5s (incl. the
    // BR→NY handshake), which clears this timer long before it fires.
    //
    // Grace length is cold-start-aware:
    //   • first connect of the session (hasConnectedOnceRef === false): 12s —
    //     a normal cold open must NEVER flash the banner, so we wait out the
    //     whole realistic handshake window.
    //   • a real reconnect after a prior success: 3s native / 5s web — brief
    //     flaps (sub-second on web, a moment on mobile radios) stay invisible.
    //
    // CRITICAL: callers must NOT call show('connecting') directly. Both the WS
    // 'disconnected' event AND the network-came-online path funnel through here
    // so neither can bypass the cold-start grace (the old bug: the NetInfo
    // listener fired on mount and painted 'connecting' instantly, before the
    // socket had any chance to connect silently).
    const scheduleConnecting = () => {
      clearTimeout(graceTimer.current);
      // Already authed? nothing to announce — and clear any stale offline bar.
      if (mailWs?.authenticated) { if (statusRef.current === 'offline') hide(); return; }
      // [2026-10-05 iOS foreground] Native grace 3000→8000: ao voltar do 2º
      // plano no iOS o rádio precisa acordar e o socket reconectar+reautenticar
      // (1-5s), e o grace de 3s pintava "Conectando" em TODA volta. 8s tolera o
      // reconnect do foreground em silêncio (o cache já está na tela), alinhado
      // à paciência de 9s do banner da conversa. Só surge num problema REAL.
      // [2026-10-05] Grace base + BUMP pós-foreground: ao acordar do 2º plano o
      // rádio iOS renegocia 1-2s ANTES do WS tentar handshake+auth (BR→NY ~150ms
      // em cellular frio), estourando os 8s → SÓ o banner do topo (SyncBar)
      // pintava "Conectando" enquanto ChatListTab(15s) e a conversa(9s) ficavam
      // quietos. Alinha ao bump de 15s do ChatListTab nos primeiros 3s pós-wake.
      const base = hasConnectedOnceRef.current ? (Platform.OS === 'web' ? 5000 : 8000) : 12000;
      const sinceFg = Date.now() - (_lastForegroundTs || 0);
      const grace = base + (Platform.OS !== 'web' && sinceFg < 3000 ? 7000 : 0);
      graceTimer.current = setTimeout(() => {
        if (!mountedRef.current || mailWs?.authenticated) return;
        // [WA-parity 2026-05-31] Honest copy: only say "Conectando…" when the
        // device actually has internet and it's the server we can't reach. If
        // the device itself is offline, surface "Sem internet" instead so we
        // don't blame the server for a local radio drop.
        show(deviceOnlineRef.current ? 'connecting' : 'offline');
      }, grace);
    };

    const handleConnection = ({ status: s }) => {
      clearTimeout(graceTimer.current);
      if (s === 'authenticated' || s === 'connected') {
        hasConnectedOnceRef.current = true;
        // Connected — hide after tiny delay
        graceTimer.current = setTimeout(hide, 500);
      } else if (s === 'disconnected') {
        scheduleConnecting();
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
    let offlineDebounce;
    if (Platform.OS === 'web') {
      const onOff = () => { clearTimeout(graceTimer.current); deviceOnlineRef.current = false; show('offline'); };
      const onOn = () => {
        deviceOnlineRef.current = true;
        // Server not reachable yet → arm the SAME grace path instead of
        // flashing 'connecting' instantly, so a fast reconnect stays silent.
        if (mailWs?.authenticated) hide();
        else scheduleConnecting();
      };
      window.addEventListener('offline', onOff);
      window.addEventListener('online', onOn);
      deviceOnlineRef.current = !!navigator.onLine;
      // Initial prime: only a genuinely-offline device surfaces anything on
      // mount. An online cold start stays silent — the WS connects in the
      // background and scheduleConnecting() (if ever armed) is grace-gated.
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
          if (!online) {
            // [false-offline fix 2026-10-03] NetInfo's reachability probe
            // (Google generate_204) false-negatives on good wifi: isInternet-
            // Reachable comes back `false` while the socket is perfectly
            // healthy, and the RED "Sem internet" then STUCK because no further
            // NetInfo event arrived and nothing re-checked. Debounce the banner
            // ~4s and, at fire time, suppress it when the WS is actually
            // authenticated. Mirrors the OfflineNotice.js fix.
            clearTimeout(graceTimer.current);
            clearTimeout(offlineDebounce);
            offlineDebounce = setTimeout(() => {
              if (!mountedRef.current) return;
              if (mailWs?.authenticated) { if (statusRef.current === 'offline') hide(); return; }
              if (!deviceOnlineRef.current) show('offline');
            }, 4000);
          } else {
            clearTimeout(offlineDebounce);
            if (mailWs?.authenticated) hide();
            // [2026-10-01] WAS `show('connecting')` — NetInfo fires this listener
            // immediately on subscribe (cold-start mount) with online=true and
            // WS not yet authed, which painted "Conectando" instantly every open.
            // Funnel through the grace timer instead so the cold-start handshake
            // (1-5s) stays silent and only a genuinely stuck connect surfaces.
            else scheduleConnecting();
          }
        });
      } catch {}
    }

    // [2026-10-05 "Conectando toda vez que abro o app"] Reset the connecting
    // state across background→foreground. iOS kills the socket ~30s into
    // background; the grace armed on that disconnect EXPIRES WHILE BACKGROUNDED,
    // so status was already 'connecting' the instant the user reopened the app
    // — a guaranteed "Conectando…" flash on EVERY open until the fresh reconnect
    // authenticated (~0.5-1s later). Fix: on background, clear timers + drop any
    // connecting banner (nothing is visible anyway); on foreground, if already
    // authed hide immediately, else give the reconnect a FRESH grace window from
    // now (so the quick foreground reconnect stays silent — WhatsApp parity).
    let _lastAppState = AppState.currentState;
    // [2026-10-05] timestamp da última volta do 2º plano — scheduleConnecting
    // usa p/ estender o grace (rádio iOS leva 1-2s só pra renegociar antes do
    // WS sequer tentar handshake+auth, estourando 8s na acordada).
    let _lastForegroundTs = 0;
    const appStateSub = AppState.addEventListener('change', (next) => {
      if (!mountedRef.current) return;
      if (next === 'inactive') return; // ignore transient (iOS/Android quirk)
      if (next === 'background') {
        clearTimeout(graceTimer.current);
        if (statusRef.current === 'connecting') hide();
        _lastAppState = next;
        return;
      }
      if (next === 'active' && _lastAppState !== 'active') {
        _lastAppState = next;
        _lastForegroundTs = Date.now();
        if (mailWs?.authenticated) { hide(); return; }
        // Not yet authed on reopen: clear any stale 'connecting' and re-arm a
        // fresh grace so a sub-second reconnect never paints the bar.
        if (statusRef.current === 'connecting') hide();
        clearTimeout(graceTimer.current);
        scheduleConnecting();
      }
    });

    // [false-offline fix 2026-10-03] "Live socket wins" safety poll: if the WS
    // is authenticated but a stale 'offline' banner is still up (NetInfo never
    // sent a recovery event — the classic stuck-banner case), clear it. Same
    // 1s pattern OfflineNotice.js uses.
    // [2026-10-10 perf-battery] paused while backgrounded (utils/activeInterval).
    const stopSocketPoll = setActiveInterval(() => {
      if (!mountedRef.current) return;
      // [2026-10-05] Cura banner preso em 'offline' OU 'connecting': se o socket
      // já autenticou mas o banner ficou pintado (o evento connected/authenticated
      // chegou ANTES do banner, então nenhum novo evento virá escondê-lo), derruba
      // em ~1s em vez de esperar o teto de 7s.
      if (mailWs?.authenticated && (statusRef.current === 'offline' || statusRef.current === 'connecting')) {
        deviceOnlineRef.current = true;
        hide();
      }
    }, 1000);

    return () => {
      clearTimeout(graceTimer.current);
      clearTimeout(connectingTimeout.current);
      clearTimeout(syncStallTimer.current);
      clearTimeout(offlineDebounce);
      stopSocketPoll();
      appStateSub?.remove?.();
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
  const bgColor = isOffline ? (isDark ? '#7f1d1d' : '#fef2f2') : (isDark ? '#1e3a5f' : '#F1F3F5');
  const textColor = isOffline ? (isDark ? '#fca5a5' : '#dc2626') : (isDark ? '#93c5fd' : '#111111');

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
