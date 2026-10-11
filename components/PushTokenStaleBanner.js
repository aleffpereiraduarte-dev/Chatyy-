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
import { Platform, View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Linking, AppState } from 'react-native';
import { IconX } from './Icons';
import { useLanguage } from '../context/LanguageContext';
import { setActiveInterval } from '../utils/activeInterval'; // [2026-10-10 perf-battery]

const POLL_MS = 5000; // [perf 2026-10-06] was 1000 — the flag flips rarely; a 5s pickup is invisible to the user
// [2026-10-09 wa-real #15] Permissão negada → em vez de pedir de novo a cada
// boot (58× num iPhone), o app pede 1× e depois só mostra ESTE aviso, que leva
// aos Ajustes. "Fechar" esconde por 7 dias (persistido).
const DENIED_DISMISS_KEY = 'push_denied_banner_dismissed_at';
const DENIED_DISMISS_MS = 7 * 24 * 3600e3;
function _deniedDismissedRecently() {
  try {
    const { getJSON } = require('../services/mmkv');
    const at = Number(getJSON(DENIED_DISMISS_KEY, 0)) || 0;
    return at > 0 && Date.now() - at < DENIED_DISMISS_MS;
  } catch { return false; }
}
function _markDeniedDismissed() {
  try { require('../services/mmkv').setJSON(DENIED_DISMISS_KEY, Date.now()); } catch {}
}

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
      try {
        if (!flag && globalThis.__chatyy_push_denied && !_deniedDismissedRecently()) flag = true;
      } catch {}
      setVisible(flag);
      // Auto-clear local dismiss state when the flag flips back to false
      // so a future recurrence shows the banner again.
      if (!flag) setDismissed(false);
    };
    tick();
    // [2026-10-10 perf-battery] paused while backgrounded (utils/activeInterval).
    const stopPoll = setActiveInterval(tick, POLL_MS);
    // Voltou dos Ajustes: se a permissão foi concedida, re-registra o token na
    // hora e some com o aviso.
    let sub = null;
    try {
      sub = AppState.addEventListener('change', async (st) => {
        if (st !== 'active' || !mounted) return;
        let denied = false;
        try { denied = !!globalThis.__chatyy_push_denied; } catch {}
        if (!denied) return;
        try {
          const Notifications = require('expo-notifications');
          const perm = await Notifications.getPermissionsAsync();
          if (perm?.status === 'granted') {
            try { globalThis.__chatyy_push_denied = false; } catch {}
            if (mounted) setVisible(false);
            const { retryPushTokenRegistration } = require('../services/pushNotifications');
            retryPushTokenRegistration().catch(() => {});
          }
        } catch {}
      });
    } catch {}
    return () => { mounted = false; stopPoll(); try { sub?.remove?.(); } catch {} };
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
          let deniedFlag = false;
          try { deniedFlag = !!globalThis.__chatyy_push_denied; } catch {}
          setOpenSettingsMode(!!perm && perm.status !== 'granted' && (perm.canAskAgain === false || deniedFlag));
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
          onPress={(e) => {
            e?.stopPropagation?.();
            try { if (globalThis.__chatyy_push_denied) _markDeniedDismissed(); } catch {}
            setDismissed(true);
          }}
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
