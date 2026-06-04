// Background Location Task — runs when app is minimized
// =======================================================
// User report 2026-05-22: "até mesmo o app minimizado mas conectado na
// net deveria atualizar a loc". The foreground-only heartbeat
// (LiveLocationHeartbeat.js) can't fire when iOS/Android suspend the JS
// runtime. expo-location's startLocationUpdatesAsync hands off the work
// to the OS, which delivers GPS updates to a registered TaskManager
// task — even while the app is fully backgrounded or the screen is off.
//
// Lifecycle:
//   • LiveLocationHeartbeat starts the task when it sees
//     `live_location_active=1` in AsyncStorage. The user already opted in
//     via "Share Live Location" → permission prompt → "Always".
//   • The OS calls TASK_NAME every ~5 min OR on a significant change
//     (e.g. user moves 100m). iOS coalesces and may delay; Android with
//     foreground service is more predictable.
//   • The task posts to chat_friend_location_share_update — same endpoint
//     the foreground heartbeat uses. Receivers see fresh pins in the
//     snap-map even while sender's phone is in their pocket.
//   • LiveLocationHeartbeat clears the task when share is stopped or
//     user revokes permission.
//
// Apple review note: NSLocationAlwaysAndWhenInUseUsageDescription in
// app.json explicitly states this is ONLY for active live-location
// shares with a friend. The task is gated on `live_location_active=1`
// — if user stops sharing, AsyncStorage flag clears and even if the OS
// keeps the task registered for a few minutes, our handler returns
// immediately without posting. Apple's reviewers can verify by tapping
// "Stop Sharing" and watching the GPS calls stop.
//
// Android foreground-service notification (set via expo-location plugin
// in app.json) shows the user a persistent "Chatyy is sharing your
// location" banner — required by Google for ACCESS_BACKGROUND_LOCATION
// since Android 10.

import { Platform } from 'react-native';

export const BACKGROUND_LOCATION_TASK = 'chatyy-live-location';

// Define the task only on native — web/Hermes-on-server-render skips.
// Wrapped in try/catch because TaskManager isn't available at all on
// web and may throw on Hermes-on-load if the native module is missing
// (would crash root layout like the LiveLocationPingListener bug).
let _registered = false;
export function registerBackgroundLocationTask() {
  if (_registered) return;
  if (Platform.OS === 'web') return;

  try {
    const TaskManager = require('expo-task-manager');
    if (!TaskManager?.defineTask) return;

    TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
      try {
        if (error) return;
        if (!data?.locations || !Array.isArray(data.locations)) return;

        // Cheap kill-switch: if the user stopped sharing while the OS
        // had pending updates queued, drop them. The task gets unregistered
        // by LiveLocationHeartbeat shortly after; this catches the gap.
        let AsyncStorage = null;
        try { AsyncStorage = require('@react-native-async-storage/async-storage').default; } catch {}
        if (AsyncStorage) {
          const flag = await AsyncStorage.getItem('live_location_active').catch(() => null);
          if (flag !== '1' && flag !== 'true') return;
          // Ghost/invisible mode (snap-map `snap_map_ghost_mode`='1'): MUST
          // suppress background location POSTs, else the user stays trackable
          // after enabling "invisível" — privacy breach. Bug-hunt P1 (2026-05-30).
          const ghost = await AsyncStorage.getItem('snap_map_ghost_mode').catch(() => null);
          if (ghost === '1' || ghost === 'true') return;
        }

        // Post the newest fix (data.locations[] is ordered oldest→newest).
        const last = data.locations[data.locations.length - 1];
        if (!last?.coords) return;

        let api = null;
        try { api = require('./api'); } catch {}
        if (!api?.apiCall) return;

        await api.apiCall('chat_friend_location_share_update', {
          latitude:  last.coords.latitude,
          longitude: last.coords.longitude,
          accuracy:  last.coords.accuracy || null,
          heading:   last.coords.heading ?? null,
          speed:     last.coords.speed ?? null,
        }, 'POST').catch(() => {});
      } catch { /* swallow — never throw from a TaskManager task */ }
    });

    _registered = true;
  } catch { /* swallow */ }
}

// Helper: start / stop the OS-managed background updates. Called by
// LiveLocationHeartbeat when the user toggles "Share Live Location"
// or by the app boot if the flag was persisted from a prior session.
export async function startBackgroundLocationUpdates() {
  if (Platform.OS === 'web') return false;
  // [Play compliance 2026-06-04] Android: ACCESS_BACKGROUND_LOCATION foi
  // REMOVIDA do manifest (Google tirou o app da loja por falta de prominent
  // disclosure + vídeo de declaração). requestBackgroundPermissionsAsync sem
  // a permissão no manifest rejeita/craseia silenciosamente em alguns OEMs —
  // curto-circuito explícito: live location no Android segue só em foreground
  // (LiveLocationHeartbeat). iOS continua com Always (aprovado pela Apple).
  if (Platform.OS === 'android') return false;
  try {
    registerBackgroundLocationTask();
    const Location = require('expo-location');
    if (!Location?.startLocationUpdatesAsync) return false;

    // Need "Always" permission (foreground + background). Foreground
    // alone won't deliver updates while suspended. We ask only if not
    // already granted — never blanket-prompt at app start.
    const fg = await Location.getForegroundPermissionsAsync().catch(() => ({ status: 'denied' }));
    if (fg?.status !== 'granted') return false;
    let bg = await Location.getBackgroundPermissionsAsync().catch(() => ({ status: 'denied' }));
    if (bg?.status !== 'granted') {
      const ask = await Location.requestBackgroundPermissionsAsync().catch(() => ({ status: 'denied' }));
      if (ask?.status !== 'granted') return false;
      bg = ask;
    }

    const already = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => false);
    if (already) return true;

    await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
      accuracy: Location.Accuracy?.Balanced ?? 3,
      timeInterval: 5 * 60 * 1000, // 5 min — Android-only hint
      distanceInterval: 100, // 100m — fire on significant move
      deferredUpdatesInterval: 5 * 60 * 1000, // iOS batching window
      deferredUpdatesDistance: 100,
      // Required on Android 10+ for ACCESS_BACKGROUND_LOCATION. Foreground
      // service runs with a persistent notification the user can see and
      // dismiss by stopping the share. Google requires the visible banner.
      foregroundService: {
        notificationTitle: 'Chatyy compartilhando localização',
        notificationBody: 'Seu amigo pode ver onde você está. Toque para parar.',
        notificationColor: '#7c3aed',
        killServiceOnDestroy: false,
      },
      pausesUpdatesAutomatically: false, // iOS: keep firing on slow walks
      activityType: Location.ActivityType?.Other ?? 1,
      showsBackgroundLocationIndicator: true, // iOS blue bar while active
    });
    return true;
  } catch {
    return false;
  }
}

export async function stopBackgroundLocationUpdates() {
  if (Platform.OS === 'web') return;
  try {
    const Location = require('expo-location');
    if (!Location?.hasStartedLocationUpdatesAsync) return;
    const running = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => false);
    if (running) {
      await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => {});
    }
  } catch { /* swallow */ }
}
