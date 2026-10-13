// [WAVE 133+ smart-heartbeat] LiveLocationHeartbeat
// ====================================================
// User report 2026-05-22: "suporte's phone is here, charged, online, app
// running — but snap-map shows last update 1 day ago". Root cause: the
// app only refreshed live-location coords on the snap-map screen itself
// or inside the chat where the share was opened. Anywhere else (chat list,
// inbox, settings, photos) → no fresh GPS pushes → receivers see stale.
//
// This component is mounted at the root layout and runs a Find-My-style
// heartbeat (30s foreground / 60s background) AS LONG AS:
//   1. The device flag `live_location_active=1` is set (persisted in
//      AsyncStorage when the user starts a live share, cleared on stop).
//   2. Foreground or background — cadence switches on AppState so pins
//      stay fresh while watched and stay battery-reasonable while not.
// AppState transitions to 'active' fire an immediate tick so resuming
// the app from background instantly refreshes the pin.
//
// Posts go to the pure-global endpoint chat_friend_location_share_update
// (added in the snap-map ping wave) which mirrors into
// chat_friend_location_shares — the table snap-map reads. Receivers see
// their friends' pins move in (near) real-time even if the friend is
// browsing chats elsewhere in the app.
//
// Battery: 30/60s interval with Balanced accuracy + a 15s overlap guard.
// In background the OS will usually suspend our JS interval anyway; the
// OS-managed updates in reconcileBackground keep the share alive there.
//
// FULLY DEFENSIVE: every module load, GPS call, and HTTP post is wrapped
// in try/catch so a missing module or denied permission downgrades to
// "no heartbeat" instead of crashing the root layout (lesson from the
// LiveLocationPingListener crash on Android Hermes earlier today).
import { useEffect, useRef } from 'react';
import { Platform, AppState } from 'react-native';

// Find-My-style cadence: tight enough that friends' pins never look stale.
// Foreground = 30s (you're watching, friends are watching you), background
// = 60s (OS may suspend us anyway, but while we're alive keep it fresh).
// The previous 5-min cadence made pins look "1 day ago" on long sessions.
const HEARTBEAT_FG_MS = 30 * 1000; // 30s while app is in foreground
const HEARTBEAT_BG_MS = 60 * 1000; // 60s while app is backgrounded
const MIN_POST_GAP_MS = 15 * 1000; // safety floor against overlapping posts

export default function LiveLocationHeartbeat() {
  const intervalRef  = useRef(null);
  const intervalMsRef = useRef(0);
  const appStateRef  = useRef(AppState.currentState);
  const lastPostRef  = useRef(0);

  useEffect(() => {
    if (Platform.OS === 'web') return;

    // Lazy-required to mirror LiveLocationPingListener's bulletproofing.
    // Hermes import-order surprises hurt us before; do not import at module top.
    let AsyncStorage = null;
    let api = null;
    try { AsyncStorage = require('@react-native-async-storage/async-storage').default; } catch {}
    try { api = require('../services/api'); } catch {}
    if (!api || typeof api.apiCall !== 'function') return;

    let stopped = false;
    let bgWasStarted = false;

    // Background OS-managed updates module (lazy) — survives app suspend.
    let bgMod = null;
    try { bgMod = require('../services/backgroundLocationTask'); } catch {}
    // Side-effect register the TaskManager task at boot so OS-restored
    // task wake-ups have a handler (no-op if not native).
    try { bgMod?.registerBackgroundLocationTask?.(); } catch {}

    // [2026-10-12 mapa-amigos] Duas razões para publicar: localização ao vivo
    // da conversa (`live_location_active`) OU ≥1 grant ativo no Mapa de amigos
    // (`friend_map_share_active`, reconciliado por services/friendMapShare).
    // Modo fantasma desliga as duas. Só para quando NENHUMA está ativa.
    let fms = null;
    try { fms = require('../services/friendMapShare'); } catch {}
    async function shareReasons() {
      try {
        if (fms?.getShareReasons) return await fms.getShareReasons();
        if (!AsyncStorage) return { live: false, friend: false, ghost: false, any: false };
        const v = await AsyncStorage.getItem('live_location_active');
        const live = v === '1' || v === 'true';
        return { live, friend: false, ghost: false, any: live };
      } catch { return { live: false, friend: false, ghost: false, any: false }; }
    }

    // Reconcile OS background updates with the share reasons every tick.
    // Consulta o estado REAL da tarefa (start é no-op se já rodando) — antes um
    // stop externo (ex.: "Parar" da conversa) deixava bgWasStarted=true e a
    // tarefa nunca religava para a razão do mapa.
    async function reconcileBackground() {
      try {
        // [2026-10-12 find-my] Fonte única: friendMapShare decide entre o
        // envio NATIVO (iOS mudança significativa / ping) e a tarefa contínua
        // do expo-location (só ao vivo da conversa no iOS com módulo nativo).
        if (fms?.reconcileBackgroundUpdates) {
          const r0 = await shareReasons();
          bgWasStarted = !!(await fms.reconcileBackgroundUpdates({ prompt: !!r0.live }));
          return;
        }
        if (!bgMod) return;
        const r = await shareReasons();
        if (r.any) {
          // Só a localização ao vivo da conversa pode pedir "Sempre" aqui
          // (comportamento antigo); a razão do mapa pede só ao aceitar.
          const ok = await bgMod.startBackgroundLocationUpdates({ prompt: !!r.live });
          bgWasStarted = !!ok;
        } else {
          // stop é no-op se a tarefa não está rodando (checa hasStarted).
          await bgMod.stopBackgroundLocationUpdates();
          bgWasStarted = false;
        }
      } catch {}
    }

    async function tick() {
      try {
        if (stopped) return;
        await reconcileBackground();
        const now = Date.now();
        if (now - lastPostRef.current < MIN_POST_GAP_MS) return; // overlap guard
        const reasons = await shareReasons();
        if (!reasons.any) return;
        // Só o Mapa de amigos (sem ao vivo na conversa): ~2 min entre envios,
        // compartilhado com o envio ao abrir o app / tarefa em 2º plano.
        if (!reasons.live && fms?.lastPublishedAt) {
          const lastPub = await fms.lastPublishedAt();
          if (now - lastPub < (fms.FRIEND_PUBLISH_GAP_MS || 120000)) return;
        }

        let Location;
        try { Location = require('expo-location'); } catch { return; }
        if (!Location?.getCurrentPositionAsync) return;

        // Don't ask for permission — we only run if the user already
        // shared live (so the share-flow already asked for foreground
        // permission). If the user revoked permission since, we silently
        // skip ticks until restored.
        const perm = await Location.getForegroundPermissionsAsync().catch(() => ({ status: 'denied' }));
        if (perm?.status !== 'granted') return;

        const loc = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy?.Balanced ?? 3,
        }).catch(() => null);
        if (!loc?.coords) return;

        lastPostRef.current = now;
        try { await fms?.markPublished?.(); } catch {}
        await api.apiCall('chat_friend_location_share_update', {
          latitude:  loc.coords.latitude,
          longitude: loc.coords.longitude,
          accuracy:  loc.coords.accuracy || null,
          heading:   loc.coords.heading ?? null,
          speed:     loc.coords.speed ?? null,
        }, 'POST').catch(() => {});
      } catch { /* swallow */ }
    }

    function stopInterval() {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
        intervalMsRef.current = 0;
      }
    }
    // (Re)start the loop at the cadence for the current AppState. Guards
    // against overlapping timers: if an interval at the desired period is
    // already running, it's a no-op; otherwise the old one is cleared first.
    function startInterval() {
      const desired = appStateRef.current === 'active' ? HEARTBEAT_FG_MS : HEARTBEAT_BG_MS;
      if (intervalRef.current && intervalMsRef.current === desired) return;
      stopInterval();
      intervalMsRef.current = desired;
      intervalRef.current = setInterval(() => { tick().catch(() => {}); }, desired);
    }

    // AppState: switch cadence on transition and fire an immediate tick on
    // resume so returning from background refreshes the pin in <1s.
    const sub = AppState.addEventListener('change', (next) => {
      appStateRef.current = next;
      // Re-arm the interval at the cadence matching the new state (foreground
      // = 30s, background = 60s). We keep ticking in background while alive;
      // the OS-managed task in reconcileBackground handles true suspension.
      startInterval();
      if (next === 'active') {
        // Reconcilia a razão do mapa (cacheado 10 min) antes do tick.
        Promise.resolve(fms?.syncFriendMapShare?.()).catch(() => {}).then(() => tick().catch(() => {}));
      }
    });

    // Initial start.
    startInterval();
    // One delayed first tick so we don't fire before the app is ready
    // (e.g. AsyncStorage hydrating).
    setTimeout(() => {
      try { fms?.ensureGhostSyncedToServer?.(); } catch {}
      Promise.resolve(fms?.syncFriendMapShare?.()).catch(() => {}).then(() => tick().catch(() => {}));
    }, 2000);

    return () => {
      stopped = true;
      stopInterval();
      try { sub.remove(); } catch {}
      // Don't stop background updates on unmount — root layout unmount
      // = app teardown, and we want OS-managed updates to keep firing
      // until the user explicitly stops sharing. stopBackgroundLocationUpdates
      // is called from chat-conversation.js when the user taps "Parar
      // compartilhamento".
    };
  }, []);

  return null;
}
