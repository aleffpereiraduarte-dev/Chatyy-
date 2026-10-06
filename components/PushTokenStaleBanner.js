/**
 * Push-token stale banner.
 *
 * Shows a discreet warning at the top of the app when push-token
 * registration has failed 2+ times in a row (services/pushNotifications.js
 * sets globalThis.__chatyy_push_token_stale = true). The user is the
 * receiver in this case — without a fresh server-side token, incoming
 * calls and chat pushes never wake the device. Tapping the banner forces
 * a re-registration attempt (bypassing the 6h throttle).
 *
 * Polls the global flag once per second, mirroring PhoneOfflineBanner so
 * we don't need a dedicated event bus for a single boolean. Hidden on web
 * (web uses Service Worker for push and doesn't go through this path).
 */
import React, { useEffect, useState } from 'react';
import { Platform, View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Linking } from 'react-native';
import { IconX } from './Icons';
import { useLanguage } from '../context/LanguageContext';

const POLL_MS = 5000; // [perf 2026-10-06] was 1000 — the flag flips rarely; a 5s pickup is invisible to the user

export default function PushTokenStaleBanner() {
  const { t } = useLanguage();
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // When the OS will NEVER show the permission dialog again (user denied once
  // on iOS, or denied on Android 13+), re-requesting is a dead end — the only
  // way back is the system Settings app. We detect that whenever the banner
  // is shown and switch the CTA to deep-link into Settings instead.
  const [openSettingsMode, setOpenSettingsMode] = useState(false);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    let mounted = true;
    const tick = () => {
      if (!mounted) return;
      let flag = false;
      try { flag = !!globalThis.__chatyy_push_token_stale; } catch {}
      setVisible(flag);
      // Auto-clear local dismiss state when the flag flips back to false
      // so a future recurrence shows the banner again.
      if (!flag) setDismissed(false);
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { mounted = false; clearInterval(id); };
  }, []);

  // Resolve the permission state once the banner becomes visible so we know
  // whether a retry can even re-prompt. getPermissionsAsync is cheap and only
  // runs on the (rare) transition into the visible state.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (!visible || dismissed) return;
    let alive = true;
    (async () => {
      try {
        const Notifications = require('expo-notifications');
        const perm = await Notifications.getPermissionsAsync();
        if (alive) {
          setOpenSettingsMode(!!perm && perm.status !== 'granted' && perm.canAskAgain === false);
        }
      } catch {}
    })();
    return () => { alive = false; };
  }, [visible, dismissed]);

  if (Platform.OS === 'web') return null;
  if (!visible || dismissed) return null;

  const onRetry = async () => {
    if (retrying) return;
    // Permission permanently denied → re-requesting silently no-ops on iOS.
    // Send the user straight to the system Settings app where they can flip
    // notifications back on. openSettings() is cross-platform.
    if (openSettingsMode) {
      try { await Linking.openSettings(); } catch {}
      setDismissed(true);
      return;
    }
    setRetrying(true);
    try {
      const { retryPushTokenRegistration } = require('../services/pushNotifications');
      const r = await retryPushTokenRegistration();
      // Also re-send VoIP token on iOS — the same incident drops both.
      if (Platform.OS === 'ios') {
        try {
          const { retryVoipTokenRegistration } = require('../services/callkeep');
          await retryVoipTokenRegistration();
        } catch {}
      }
      if (r?.ok) {
        setDismissed(true);
      }
    } catch {}
    setRetrying(false);
  };

  const label = retrying
    ? t('pushBanner.retrying')
    : (openSettingsMode ? t('pushBanner.openSettings') : t('pushBanner.stale'));

  return (
    <TouchableOpacity
      onPress={onRetry}
      activeOpacity={0.85}
      style={s.bar}
      accessibilityRole="button"
      accessibilityLabel={t('pushBanner.a11y')}
      accessibilityLiveRegion="polite"
    >
      <Text style={s.text} numberOfLines={2}>
        {label}
      </Text>
      {retrying ? (
        <ActivityIndicator size="small" color="#7c5e00" />
      ) : (
        <TouchableOpacity
          onPress={(e) => { e?.stopPropagation?.(); setDismissed(true); }}
          style={s.closeBtn}
          accessibilityLabel={t('pushBanner.dismiss')}
          accessibilityRole="button"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          {IconX ? <IconX size={14} color="#7c5e00" /> : <Text style={{ color: '#7c5e00', fontSize: 14 }}>x</Text>}
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#fff4c2',
    borderBottomWidth: 1,
    borderBottomColor: '#e5d27a',
    paddingHorizontal: 14,
    paddingVertical: 8,
    width: '100%',
    zIndex: 9999,
  },
  text: {
    flex: 1,
    fontSize: 13,
    color: '#5a4500',
    fontWeight: '500',
  },
  closeBtn: {
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
});
