// [7181 fix 2026-05-22 / WAVE 133 bulletproof] LiveLocationPingListener
// ====================================================================
// When a friend opens snap-map and sees your pin stale, the snap-map
// fires chat_friend_location_ping → backend relays `location_ping_request`
// over WS to your devices. This listener re-runs getCurrentPosition and
// posts a fresh location so receivers' maps update real-time.
//
// CRITICAL: Triple-bulletproofed because the previous WAVE 131 + WAVE 132
// versions crashed Android with "Cannot read property 'on' of undefined"
// at startup — different module-load order on Hermes vs JSC made the
// require()-inside-useEffect pattern still throw before the guard fired.
// Now we wrap THE ENTIRE useEffect body in try/catch so even an unhandled
// throw can't bring down the whole app tree. Side-effect of dead listener
// is just "stale snap-map pins don't auto-refresh" — not a crash.
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

export default function LiveLocationPingListener() {
  const lastRunRef = useRef(0);

  useEffect(() => {
    // OUTER try/catch — last-resort guard so ANY exception inside the
    // listener wiring cannot crash the root layout. If something throws
    // we silently degrade to "no listener installed" instead of red screen.
    let unsub = null;
    try {
      if (Platform.OS === 'web') return;

      // Defer-and-guard module loads: require() can throw if the module
      // is missing OR returns undefined when import-cycle resolved late.
      let mailWs = null;
      let api = null;
      let useAuthHook = null;
      try { mailWs = require('../services/websocket')?.default || null; } catch { mailWs = null; }
      try { api    = require('../services/api') || null; } catch { api = null; }

      if (!mailWs || typeof mailWs.on !== 'function') return;
      if (!api  || typeof api.apiCall !== 'function')   return;

      unsub = mailWs.on('location_ping_request', async () => {
        try {
          const now = Date.now();
          if (now - lastRunRef.current < 60_000) return;
          lastRunRef.current = now;

          let Location;
          try { Location = require('expo-location'); } catch { return; }
          if (!Location?.requestForegroundPermissionsAsync) return;

          const fg = await Location.requestForegroundPermissionsAsync().catch(() => ({ status: 'denied' }));
          if (fg?.status !== 'granted') return;

          const loc = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy?.Balanced ?? 3,
          }).catch(() => null);
          if (!loc?.coords) return;

          await api.apiCall('chat_friend_location_share_update', {
            latitude:  loc.coords.latitude,
            longitude: loc.coords.longitude,
            accuracy:  loc.coords.accuracy || null,
            heading:   loc.coords.heading ?? null,
            speed:     loc.coords.speed ?? null,
          }, 'POST').catch(() => {});
        } catch { /* swallow — never crash on a ping reply */ }
      });
    } catch { /* swallow — listener wiring failure must not crash root */ }

    return () => { try { unsub?.(); } catch {} };
  }, []);

  return null;
}
