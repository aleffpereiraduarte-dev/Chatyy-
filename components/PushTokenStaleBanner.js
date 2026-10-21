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
// [2026-10-18 push-coverage] Aviso "notificações desativadas": no máximo 1×
// a cada 3 dias e 5 vezes no total por aparelho (era: some 7 dias ao fechar,
// sem teto). Uma "vez" = uma sessão do app em que o aviso apareceu; dentro
// dela continua visível até fechar. Sessão = processo JS (módulo).
// [2026-10-18 notif-perm-card] o aviso de "negado" virou o CARTÃO no topo da lista de
// conversas (NotifPermissionCard abaixo, mesmo limitador): no máximo 1× a cada 7 dias.
// O cartão flutuante deste arquivo ficou só p/ o token velho (stale).
const DENIED_RATE_KEY = 'push_denied_banner_v2';
const DENIED_EVERY_MS = 7 * 24 * 3600e3;
const DENIED_MAX_SHOWS = 5;
let _deniedShownThisSession = false;
let _deniedClosedThisSession = false;
function _deniedAllowed() {
  if (_deniedClosedThisSession) return false;
  if (_deniedShownThisSession) return true;
  try {
    const { getJSON } = require('../services/mmkv');
    const st = getJSON(DENIED_RATE_KEY, null) || {};
    const n = Number(st.n) || 0;
    const at = Number(st.at) || 0;
    return n < DENIED_MAX_SHOWS && (!at || Date.now() - at >= DENIED_EVERY_MS);
  } catch { return false; }
}
function _markDeniedShown() {
  if (_deniedShownThisSession) return;
  _deniedShownThisSession = true;
  try {
    const { getJSON, setJSON } = require('../services/mmkv');
    const st = getJSON(DENIED_RATE_KEY, null) || {};
    setJSON(DENIED_RATE_KEY, { n: (Number(st.n) || 0) + 1, at: Date.now() });
  } catch {}
}
function _markDeniedDismissed() {
  _deniedClosedThisSession = true;
}
// Permissão voltou (Ajustes / diálogo)? limpa o flag e re-registra o token na hora.
async function _healIfGranted() {
  try {
    const Notifications = require('expo-notifications');
    const perm = await Notifications.getPermissionsAsync();
    if (perm?.status === 'granted') {
      try { globalThis.__chatyy_push_denied = false; } catch {}
      try {
        const { retryPushTokenRegistration } = require('../services/pushNotifications');
        retryPushTokenRegistration().catch(() => {});
      } catch {}
      return { granted: true, perm };
    }
    return { granted: false, perm };
  } catch { return { granted: false, perm: null }; }
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
      // [2026-10-18 notif-perm-card] "negado" agora é o NotifPermissionCard (topo da lista).
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
        const r = await _healIfGranted();
        if (r.granted && mounted) setVisible(false);
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
          // [2026-10-18 push-coverage] Android ainda deixa pedir (canAskAgain) →
          // "Ativar" mostra o diálogo do SO; só iOS negado / Android bloqueado vão aos Ajustes.
          setOpenSettingsMode(!!perm && perm.status !== 'granted' && (perm.canAskAgain === false || (Platform.OS === 'ios' && deniedFlag)));
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

  const _deniedMode = false; // [2026-10-18 notif-perm-card] negado → NotifPermissionCard
  const title = (openSettingsMode || _deniedMode) ? t('pushBanner.offTitle') : t('pushBanner.staleTitle');
  const sub = retrying ? t('pushBanner.retrying') : (_deniedMode ? t('pushBanner.offSub') : t('pushBanner.sub'));
  const cta = t('pushBanner.ctaRetry');
  const fg = colors.text;
  const muted = colors.textSecondary;

  return (
    <View pointerEvents="box-none" style={[s.wrap, { bottom: (insets.bottom || 0) + 74 }]}>
      <View
        style={[s.card, {
          backgroundColor: colors.surface,
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

// ── [2026-10-18 notif-perm-card] Cartão discreto no TOPO da lista de conversas ──
// ~11% Android / ~20% iOS com notificações negadas. Explica o porquê e:
//   • Android 13+ com canAskAgain → mostra o diálogo do SO de novo;
//   • senão (iOS negado, Android bloqueado/<13) → Linking.openSettings().
// Mesmo limitador do aviso antigo (1× a cada 7 dias, teto por aparelho);
// "fechar" some na sessão. Sem emoji (ícone SVG).
export function NotifPermissionCard({ always = false } = {}) {
  const { t } = useLanguage();
  const { colors, isDark } = useTheme();
  const [visible, setVisible] = useState(false);
  const [askMode, setAskMode] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    let mounted = true;
    const tick = () => {
      if (!mounted) return;
      let on = false;
      // [entregue 2026-10-20] always = tela de Ajustes > Notificações (sem limitador).
      try { on = !!globalThis.__chatyy_push_denied && (always || _deniedAllowed()); } catch {}
      setVisible((v) => (v === on ? v : on));
    };
    tick();
    const stopPoll = setActiveInterval(tick, POLL_MS);
    let sub = null;
    try {
      sub = AppState.addEventListener('change', async (st) => {
        if (st !== 'active' || !mounted) return;
        let denied = false;
        try { denied = !!globalThis.__chatyy_push_denied; } catch {}
        if (!denied) return;
        const r = await _healIfGranted();
        if (r.granted && mounted) setVisible(false);
      });
    } catch {}
    return () => { mounted = false; stopPoll(); try { sub?.remove?.(); } catch {} };
  }, []);

  useEffect(() => {
    if (!visible) return undefined;
    if (!always) _markDeniedShown();
    let alive = true;
    (async () => {
      const r = await _healIfGranted();
      if (!alive) return;
      if (r.granted) { setVisible(false); return; }
      const canAsk = Platform.OS === 'android' && Number(Platform.Version) >= 33 && r.perm?.canAskAgain !== false;
      setAskMode(!!canAsk);
    })();
    return () => { alive = false; };
  }, [visible]);

  if (Platform.OS === 'web' || !visible) return null;

  const tr = (k, fb) => { const v = t(k); return v && v !== k ? v : fb; };
  const onPress = async () => {
    if (busy) return;
    if (askMode) {
      setBusy(true);
      try {
        const Notifications = require('expo-notifications');
        const res = await Notifications.requestPermissionsAsync();
        if (res?.status === 'granted') {
          await _healIfGranted();
          setVisible(false);
        } else if (res?.canAskAgain === false) {
          setAskMode(false); // SO bloqueou de vez → próximo toque vai aos Ajustes
        }
      } catch {}
      setBusy(false);
      return;
    }
    try { await Linking.openSettings(); } catch {}
  };
  const onClose = () => { _markDeniedDismissed(); setVisible(false); };
  const fg = colors.text;
  const muted = colors.textSecondary;

  return (
    <View style={s.inlineWrap}>
      <View
        style={[s.inlineCard, {
          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
          borderColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)',
        }]}
        accessibilityLiveRegion="polite"
      >
        <View style={[s.iconWrap, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }]}>
          {IconBell ? <IconBell size={18} color={fg} /> : null}
        </View>
        <View style={s.textCol}>
          <Text style={[s.title, { color: fg }]} numberOfLines={1}>{tr('notifCard.title', 'Notificações desativadas')}</Text>
          <Text style={[s.sub, { color: muted }]} numberOfLines={3}>
            {tr('notifCard.body', 'Ative para receber mensagens e chamadas na hora, mesmo com o app fechado.')}
          </Text>
          <Pressable
            onPress={onPress}
            disabled={busy}
            style={({ pressed }) => [s.inlineCta, { backgroundColor: colors.primary, opacity: pressed ? 0.8 : 1 }]}
            accessibilityRole="button"
            accessibilityLabel={askMode ? tr('notifCard.allow', 'Ativar notificações') : tr('notifCard.openSettings', 'Abrir ajustes')}
          >
            {busy
              ? <ActivityIndicator size="small" color={colors.onPrimary} />
              : <Text style={[s.ctaText, { color: colors.onPrimary }]} numberOfLines={1}>
                  {askMode ? tr('notifCard.allow', 'Ativar notificações') : tr('notifCard.openSettings', 'Abrir ajustes')}
                </Text>}
          </Pressable>
        </View>
        <TouchableOpacity
          onPress={onClose}
          style={s.closeBtn}
          accessibilityLabel={tr('pushBanner.dismiss', 'Fechar')}
          accessibilityRole="button"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          {IconX ? <IconX size={14} color={muted} /> : null}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  inlineWrap: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 6 },
  inlineCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    paddingVertical: 12, paddingLeft: 12, paddingRight: 6, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth,
  },
  inlineCta: { alignSelf: 'flex-start', marginTop: 10, paddingHorizontal: 14, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', minWidth: 96 },
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
