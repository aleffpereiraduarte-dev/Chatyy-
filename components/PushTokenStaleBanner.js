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
import { Platform, View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Linking, AppState, Pressable } from 'react-native';
import { usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconX, IconBell } from './Icons';
import { useTheme } from '../context/ThemeContext';
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

// [2026-10-14 redesign] Era uma faixa amarela colada no topo de TODAS as telas
// (founder: "feia"). Agora é um cartão flutuante P&B, só na home (lista de
// conversas), acima da barra de abas — não empurra o layout nem cobre headers.
const HOME_PATHS = new Set(['/', '/chat']);

export default function PushTokenStaleBanner() {
  const { t } = useLanguage();
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
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

  if (!HOME_PATHS.has(pathname || '')) return null;

  const title = openSettingsMode ? t('pushBanner.offTitle') : t('pushBanner.staleTitle');
  const sub = retrying ? t('pushBanner.retrying') : t('pushBanner.sub');
  const cta = openSettingsMode ? t('pushBanner.ctaSettings') : t('pushBanner.ctaRetry');
  const fg = colors.text;
  const muted = colors.textSecondary;

  return (
    <View pointerEvents="box-none" style={[s.wrap, { bottom: (insets.bottom || 0) + 74 }]}>
      <View
        style={[s.card, {
          backgroundColor: isDark ? '#1c1c1e' : '#ffffff',
          borderColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)',
        }]}
        accessibilityLiveRegion="polite"
      >
        <View style={[s.iconWrap, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }]}>
          {IconBell ? <IconBell size={18} color={fg} /> : null}
        </View>
        <View style={s.textCol}>
          <Text style={[s.title, { color: fg }]} numberOfLines={1}>{title}</Text>
          <Text style={[s.sub, { color: muted }]} numberOfLines={2}>{sub}</Text>
        </View>
        <Pressable
          onPress={onRetry}
          disabled={retrying}
          style={({ pressed }) => [s.cta, { backgroundColor: colors.primary, opacity: pressed ? 0.8 : 1 }]}
          accessibilityRole="button"
          accessibilityLabel={t('pushBanner.a11y')}
        >
          {retrying
            ? <ActivityIndicator size="small" color={colors.onPrimary} />
            : <Text style={[s.ctaText, { color: colors.onPrimary }]} numberOfLines={1}>{cta}</Text>}
        </Pressable>
        <TouchableOpacity
          onPress={() => {
            try { if (globalThis.__chatyy_push_denied) _markDeniedDismissed(); } catch {}
            setDismissed(true);
          }}
          style={s.closeBtn}
          accessibilityLabel={t('pushBanner.dismiss')}
          accessibilityRole="button"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          {IconX ? <IconX size={14} color={muted} /> : <Text style={{ color: muted, fontSize: 14 }}>x</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', paddingHorizontal: 12, zIndex: 9999 },
  card: {
    width: '100%', maxWidth: 520, flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 12, paddingLeft: 12, paddingRight: 8, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 8,
  },
  iconWrap: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  textCol: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, fontWeight: '600', letterSpacing: -0.1 },
  sub: { fontSize: 12.5, marginTop: 2, lineHeight: 16 },
  cta: { paddingHorizontal: 14, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', minWidth: 64 },
  ctaText: { fontSize: 13, fontWeight: '600' },
  closeBtn: { padding: 6 },
});
