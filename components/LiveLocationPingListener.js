// [7181 fix 2026-05-22] LiveLocationPingListener
// =================================================
// When a friend opens the snap-map and sees your pin "stale há 23h", the
// snap-map fires `chat_friend_location_ping(sharer=you)` → backend relays
// `location_ping_request` over WS to your devices. This listener wakes the
// JS location task: it re-runs getCurrentPosition and posts a fresh
// chat_friend_location_share_global so all receivers' maps update in
// real-time.
//
// Backgrounded apps with WS still alive (iOS recent-background, Android
// foreground service or recent activity) get this event instantly. Killed
// apps need the silent push path (fcmSendSilentSync → native FCM/APNs
// handler), which lives in native code and ships with v2.4.9.
//
// Throttle: 60s per request — multiple receivers asking at once shouldn't
// burn battery. The backend already has its own 60s throttle on the
// requester side; this is defensive.
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as api from '../services/api';
import { useAuth } from '../context/AuthContext';

export default function LiveLocationPingListener() {
  const { user } = useAuth() || {};
  const lastRunRef = useRef(0);

  useEffect(() => {
    if (!user?.email) return;
    if (Platform.OS === 'web') return; // web doesn't background-share

    // mailWs is a default export of services/websocket.js, NOT named from
    // services/api.js. Use require() inside the effect so a missing module
    // throws here instead of at module load (otherwise root layout crashes
    // with "Cannot read property 'on' of undefined").
    let mailWs;
    try { mailWs = require('../services/websocket').default; } catch { return; }
    if (!mailWs || typeof mailWs.on !== 'function') return;

    const unsub = mailWs.on('location_ping_request', async () => {
      const now = Date.now();
      if (now - lastRunRef.current < 60_000) return;
      lastRunRef.current = now;

      try {
        const Location = require('expo-location');
        const fg = await Location.requestForegroundPermissionsAsync();
        if (fg.status !== 'granted') return;
        const loc = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (!loc?.coords) return;
        // Push to the global snap-map table directly. The legacy
        // chat_update_live_location requires a conversation_id and returns
        // 400 without one — useless from a WS-wake context where we only
        // have GPS. chat_friend_location_share_update is the pure-global
        // path: writes only to chat_friend_location_shares, preserves the
        // user's existing is_unlimited/expires_at flags.
        await api.apiCall('chat_friend_location_share_update', {
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          accuracy: loc.coords.accuracy || null,
          heading: loc.coords.heading ?? null,
          speed: loc.coords.speed ?? null,
        }, 'POST').catch(() => {});
      } catch {}
    });

    return () => { try { unsub?.(); } catch {} };
  }, [user?.email]);

  return null;
}
