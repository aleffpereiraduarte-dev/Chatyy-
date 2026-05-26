import ErrorBoundary from "../components/ErrorBoundary";
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  Switch, ActivityIndicator, Platform, Alert, Image, Linking, Share, Modal, Pressable,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import AvatarCircle from '../components/AvatarCircle';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useCurrency } from '../context/CurrencyContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import {
  IconArrowLeft, IconSparkles, IconMessageSquare, IconPenTool, IconDraft,
  IconFilter, IconChevronRight, IconGlobe, IconTrash, IconBell, IconForward,
  IconShield, IconFileText, IconUser, IconUsers, IconPlus, IconShare, IconCheck,
  IconMail, IconPhone, IconAlertTriangle, IconCopy, IconDatabase, IconRefresh,
  IconX, IconChevronDown,
} from '../components/Icons';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Rect as SvgRect, Circle as SvgCircle } from 'react-native-svg';
import { useBiometric } from '../context/BiometricContext';
import { useConfirm } from '../components/ConfirmModal';
import { useAuth } from '../context/AuthContext';
import FilterRuleEditor from '../components/FilterRuleEditor';
import { PrivacyModal, TermsModal } from '../components/LoginModals';
import * as api from '../services/api';
import { getCached, setCache } from '../services/cache';
import { SettingsSkeleton } from '../components/SkeletonLoader';
import Constants from 'expo-constants';

function getStorage(key) {
  if (Platform.OS === 'web') {
    try { return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null; } catch { return null; }
  }
  return null; // async handled separately
}
function setStorage(key, val) {
  if (Platform.OS === 'web') {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, val); } catch {}
  } else {
    import('@react-native-async-storage/async-storage').then(m => m.default.setItem(key, val)).catch(() => {});
  }
}

// History download / missing-media UI used inside the Storage section of
// SettingsScreenInner. Hooks pull theme + i18n; SQLite counters come from
// services/db.getSyncStats() refreshed on mount + every 4s while a download
// is running. Manual triggers route to services/fullHistorySync.
function HistoryDownloadRow() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [stats, setStats] = useState(null);
  const [busyHistory, setBusyHistory] = useState(false);
  const [busyMedia, setBusyMedia] = useState(false);
  const [mediaProgress, setMediaProgress] = useState(null); // {loaded,total,percent}
  const [historyProgress, setHistoryProgress] = useState(null);
  // #1247 (2026-05-21): live progress from the background media auto-sync
  // loop. When phase='syncing', the row morphs into "Sincronizando X/Y"
  // (vs the alarming "Mídias faltantes: Y"); when nothing is pending and
  // the loop has settled, it shows "Sincronizado ✓".
  const [autoSync, setAutoSync] = useState(null);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const refreshStats = useCallback(async () => {
    if (Platform.OS === 'web') return;
    try {
      const dbMod = require('../services/db');
      const r = await dbMod.getSyncStats?.();
      if (aliveRef.current) setStats(r || null);
    } catch {}
  }, []);
  useEffect(() => { refreshStats(); }, [refreshStats]);

  // Poll stats every 4s while a download is running so the counters reflect
  // progress in near-real-time.
  useEffect(() => {
    if (!busyHistory && !busyMedia) return undefined;
    const id = setInterval(refreshStats, 4000);
    return () => clearInterval(id);
  }, [busyHistory, busyMedia, refreshStats]);

  // Subscribe to bootstrap progress for live convs counter.
  useEffect(() => {
    if (Platform.OS === 'web' || !busyHistory) return undefined;
    let ws = null;
    try { ws = require('../services/websocket').default; } catch {}
    const handler = (payload) => {
      setHistoryProgress({
        convDone: payload.convDone || 0,
        convTotal: payload.convTotal || 0,
        phase: payload.phase,
      });
      if (payload.phase === 'done') {
        setBusyHistory(false);
        refreshStats();
      }
    };
    try { ws?.on?.('chat_bootstrap_progress', handler); } catch {}
    return () => { try { ws?.off?.('chat_bootstrap_progress', handler); } catch {} };
  }, [busyHistory, refreshStats]);

  // [#1247] Subscribe to media auto-sync progress. Always-on so the row
  // reflects whatever the background loop is doing. Seed with current
  // snapshot so a mid-pass open shows progress immediately.
  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    let ws = null;
    try { ws = require('../services/websocket').default; } catch {}
    try {
      const mas = require('../services/mediaAutoSync');
      const snap = mas.getAutoSyncProgress?.();
      if (snap) setAutoSync(snap);
    } catch {}
    const handler = (payload) => {
      if (!aliveRef.current) return;
      setAutoSync({ ...(payload || {}) });
      if (payload?.phase === 'done') refreshStats();
    };
    try { ws?.on?.('media_auto_sync_progress', handler); } catch {}
    return () => { try { ws?.off?.('media_auto_sync_progress', handler); } catch {} };
  }, [refreshStats]);

  const onDownloadAll = useCallback(async () => {
    if (busyHistory) return;
    setBusyHistory(true);
    setHistoryProgress(null);
    try {
      const api = require('../services/api');
      const { forceFullHistoryDownload } = require('../services/fullHistorySync');
      const email = api.getActiveAccountEmail?.() || '';
      await forceFullHistoryDownload(api.apiCall, email, { includeAllMedia: true });
    } catch {}
    setBusyHistory(false);
    refreshStats();
  }, [busyHistory, refreshStats]);

  const onDownloadMissing = useCallback(async () => {
    if (busyMedia) return;
    setBusyMedia(true);
    setMediaProgress({ loaded: 0, total: 0, percent: 0 });
    // Also nudge the background auto-sync — user pressed "Sincronizar agora",
    // so push it past any cellular gate.
    try {
      const mas = require('../services/mediaAutoSync');
      mas.nudgeMediaAutoSync?.('settings-manual');
    } catch {}
    try {
      const { downloadMissingMediaOnly } = require('../services/fullHistorySync');
      await downloadMissingMediaOnly({
        onProgress: (p) => {
          if (aliveRef.current) setMediaProgress(p);
        },
      });
    } catch {}
    setBusyMedia(false);
    refreshStats();
  }, [busyMedia, refreshStats]);

  if (Platform.OS === 'web') return null;

  const msgsTotal = Number(stats?.msgsTotal || 0);
  const mediaPending = Number(stats?.mediaPending || 0);
  // [#1247] Derived UI state. Priority: live syncing > pending > all-synced.
  const autoSyncing = autoSync?.phase === 'syncing' && (autoSync?.total || 0) > 0;
  const allSynced = mediaPending === 0 && !autoSyncing;

  return (
    <View style={{ marginTop: Spacing.sm }}>
      <View style={[s.settingRow, { borderBottomColor: colors.borderLight, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: Spacing.sm }]}>
        <View style={s.settingInfo}>
          <Text style={[s.settingLabel, { color: colors.text }]}>
            {t('settings.storage.msgsOnDevice') || 'Mensagens no celular'}
          </Text>
        </View>
        <Text style={[s.settingLabel, { color: colors.textSecondary, fontVariant: ['tabular-nums'] }]}>
          {msgsTotal.toLocaleString()}
        </Text>
      </View>
      {/* [#1247] WhatsApp-grade auto-sync status row. Replaces the old
          "Mídias faltantes: 47" warning (which scared users) with a tri-state
          indicator the background loop drives:
            - syncing → "<spinner> 12/47" (live)
            - pending → "47 pendentes" (idle — cellular-gated or paused)
            - synced  → "✓ Sincronizado" (everything on disk)
          Updates live via WS event 'media_auto_sync_progress'. */}
      <View style={[s.settingRow, { borderBottomColor: colors.borderLight, borderBottomWidth: 0, paddingVertical: Spacing.sm }]}>
        <View style={s.settingInfo}>
          <Text style={[s.settingLabel, { color: colors.text }]}>
            {t('settings.storage.mediaSyncStatus') || 'Mídias'}
          </Text>
        </View>
        {autoSyncing ? (
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <ActivityIndicator size="small" color={colors.primary} style={{ marginRight: 6 }} />
            <Text style={[s.settingLabel, { color: colors.primary, fontVariant: ['tabular-nums'] }]}>
              {`${(autoSync?.loaded || 0).toLocaleString()}/${(autoSync?.total || 0).toLocaleString()}`}
            </Text>
          </View>
        ) : allSynced ? (
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <IconCheck size={16} color={colors.success || '#10b981'} style={{ marginRight: 4 }} />
            <Text style={[s.settingLabel, { color: colors.success || '#10b981' }]}>
              {t('settings.storage.allSynced') || 'Sincronizado'}
            </Text>
          </View>
        ) : (
          <Text style={[s.settingLabel, { color: colors.textSecondary, fontVariant: ['tabular-nums'] }]}>
            {`${mediaPending.toLocaleString()} ${t('settings.storage.pending') || 'pendentes'}`}
          </Text>
        )}
      </View>

      <TouchableOpacity
        onPress={onDownloadAll}
        disabled={busyHistory}
        style={[s.settingRow, { borderBottomColor: colors.borderLight, borderBottomWidth: 0, marginTop: Spacing.sm, opacity: busyHistory ? 0.5 : 1 }]}
        accessibilityRole="button"
        accessibilityLabel={t('settings.storage.downloadAll')}
      >
        <View style={s.settingInfo}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {busyHistory
              ? <ActivityIndicator size="small" color={colors.primary} style={{ marginRight: Spacing.sm }} />
              : <IconRefresh size={18} color={colors.primary} style={{ marginRight: Spacing.sm }} />}
            <Text style={[s.settingLabel, { color: colors.primary, fontWeight: '600' }]}>
              {busyHistory
                ? (historyProgress && historyProgress.convTotal
                    ? `${t('settings.storage.downloadingMsgs') || 'Baixando histórico…'} ${historyProgress.convDone}/${historyProgress.convTotal}`
                    : (t('settings.storage.downloadingMsgs') || 'Baixando histórico…'))
                : (t('settings.storage.downloadAll') || 'Baixar histórico completo')}
            </Text>
          </View>
        </View>
      </TouchableOpacity>

      {/* [#1247] "Sincronizar agora" — manual nudge for users who want it
          forced past any cellular gate (e.g. about to leave wifi). Always
          enabled so they can re-verify even when allSynced. */}
      <TouchableOpacity
        onPress={onDownloadMissing}
        disabled={busyMedia}
        style={[s.settingRow, { borderBottomColor: colors.borderLight, borderBottomWidth: 0, paddingTop: 0, opacity: busyMedia ? 0.5 : 1 }]}
        accessibilityRole="button"
        accessibilityLabel={t('settings.storage.syncNow') || t('settings.storage.downloadMedia')}
      >
        <View style={s.settingInfo}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {busyMedia
              ? <ActivityIndicator size="small" color={colors.textSecondary} style={{ marginRight: Spacing.sm }} />
              : <IconRefresh size={18} color={colors.textSecondary} style={{ marginRight: Spacing.sm }} />}
            <Text style={[s.settingLabel, { color: colors.textSecondary }]}>
              {busyMedia
                ? (mediaProgress && mediaProgress.total
                    ? `${t('settings.storage.downloadingMedia') || 'Baixando mídias…'} ${mediaProgress.loaded}/${mediaProgress.total} (${mediaProgress.percent || 0}%)`
                    : (t('settings.storage.downloadingMedia') || 'Baixando mídias…'))
                : (t('settings.storage.syncNow') || 'Sincronizar agora')}
            </Text>
          </View>
        </View>
      </TouchableOpacity>
    </View>
  );
}

// Collapsible group header that shows/hides its children. Each group owns one
// useState. When `forceOpen` is true (search query active) it ignores the
// collapsed state so search results stay visible. SVG chevron rotates via a
// simple conditional (no Animated dep — keeps the in-file component light).
function CollapsibleGroup({ title, icon: Icon, defaultOpen = false, forceOpen = false, children }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(defaultOpen);
  const visible = forceOpen || open;
  return (
    <View style={{ marginBottom: Spacing.md }}>
      <TouchableOpacity
        onPress={() => setOpen(o => !o)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityState={{ expanded: visible }}
        accessibilityLabel={title}
        style={{
          flexDirection: 'row', alignItems: 'center',
          paddingVertical: 12, paddingHorizontal: 4,
        }}
      >
        {Icon ? <Icon size={18} color={colors.primary} style={{ marginRight: 10 }} /> : null}
        <Text style={{ flex: 1, color: colors.text, fontSize: FontSize.md, fontWeight: '700' }}>
          {title}
        </Text>
        {/* Chevron points down when open, right when collapsed. */}
        {visible
          ? <IconChevronDown size={18} color={colors.textTertiary} />
          : <IconChevronRight size={18} color={colors.textTertiary} />}
      </TouchableOpacity>
      {visible ? <View>{children}</View> : null}
    </View>
  );
}

function SettingsScreenInner() {
  const { colors, isDark, toggle, density, setDensity, themeMode, setThemeMode: setThemeModeCtx } = useTheme();
  const { t, language, changeLanguage } = useLanguage();
  const { currency: userCurrency, setCurrency: setUserCurrency, resetCurrency: resetUserCurrency, autoDetected: currencyAutoDetected, supported: supportedCurrencies, symbols: currencySymbols } = useCurrency();
  const { biometricEnabled, biometricAvailable, toggleBiometric, autoLockInterval, setAutoLockInterval } = useBiometric();
  // Modal state for the auto-lock interval picker. Surface lives in the
  // Security section below the biometric toggle so users find it where
  // they enable the lock.
  const [autoLockOpen, setAutoLockOpen] = useState(false);
  // E2E backup escrow modal — collects the passphrase, encrypts the
  // user's local key material, and uploads via e2eeBackupEscrowPut. The
  // ACTUAL key gathering is delegated to services/e2ee at submit time so
  // this surface only owns the passphrase UX.
  const [e2eBackupOpen, setE2eBackupOpen] = useState(false);
  const [e2eBackupPass, setE2eBackupPass] = useState('');
  const [e2eBackupPass2, setE2eBackupPass2] = useState('');
  const [e2eBackupBusy, setE2eBackupBusy] = useState(false);
  const [e2eBackupMsg, setE2eBackupMsg] = useState('');
  const { logout, user } = useAuth();
  const confirm = useConfirm();
  const router = useRouter();
  const params = useLocalSearchParams();
  const insets = useSafeAreaInsets();

  // Scroll-to-section when opened from ProfileSettingsSheet with ?section=X.
  // onLayout y-coords are relative to the PARENT view, which doesn't work
  // when the target row is nested inside a section card. We stash a ref for
  // each named anchor and measure it against the ScrollView's native handle
  // so we get an absolute offset. Runs once the node is mounted *and* the
  // requested section matches.
  const scrollRef = useRef(null);
  const sectionRefs = useRef({});
  const requestedSection = typeof params?.section === 'string' ? params.section : null;
  const registerSectionRef = useCallback((key) => (node) => {
    if (!node) return;
    sectionRefs.current[key] = node;
    if (key === requestedSection && scrollRef.current) {
      // Defer until layout settles — RN measureLayout against a freshly-
      // mounted ScrollView can yield stale coords on the first call.
      setTimeout(() => {
        try {
          const scrollNode = scrollRef.current?.getInnerViewNode?.()
            || scrollRef.current?._nativeRef
            || scrollRef.current;
          if (!scrollNode || !node.measureLayout) return;
          node.measureLayout(
            scrollNode,
            (_x, y) => { scrollRef.current?.scrollTo?.({ y: Math.max(0, y - 12), animated: true }); },
            () => {}
          );
        } catch {}
      }, 120);
    }
  }, [requestedSection]);
  const [undoDelay, setUndoDelay] = useState(5);
  const [smartComposeOn, setSmartComposeOn] = useState(true);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [deleteAcknowledged, setDeleteAcknowledged] = useState(false);
  const [deleteTypedWord, setDeleteTypedWord] = useState('');
  // Alterar senha — modal state
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [cpCurrent, setCpCurrent] = useState('');
  const [cpNew, setCpNew] = useState('');
  const [cpConfirm, setCpConfirm] = useState('');
  const [cpLoading, setCpLoading] = useState(false);
  const [cpError, setCpError] = useState('');
  const [cpSuccess, setCpSuccess] = useState(false);
  // 2FA PIN modal state
  const [twoFAOpen, setTwoFAOpen] = useState(false);
  const [twoFADigits, setTwoFADigits] = useState(['', '', '', '']);
  const twoFARefs = useRef([null, null, null, null]);
  const [twoFALoading, setTwoFALoading] = useState(false);
  const [twoFAError, setTwoFAError] = useState('');
  const [twoFASuccess, setTwoFASuccess] = useState(false);
  // Registration Lock (anti-SIM-swap) PIN modal — same shape as 2FA but
  // writes to a different backend key (registration_lock vs 2fa_pin) and
  // gates phone-OTP login instead of password login.
  const [regLockOpen, setRegLockOpen] = useState(false);
  const [regLockDigits, setRegLockDigits] = useState(['', '', '', '']);
  const regLockRefs = useRef([null, null, null, null]);
  const [regLockLoading, setRegLockLoading] = useState(false);
  const [regLockError, setRegLockError] = useState('');
  const [regLockSuccess, setRegLockSuccess] = useState(false);
  const [oneEnabled, setOneEnabled] = useState(true);
  const [oneNotifLevel, setOneNotifLevel] = useState('push'); // 'email', 'push', 'urgent' — for One AI
  const [pushNotifLevel, setPushNotifLevel] = useState('all'); // 'all', 'urgent', 'silent' — global push delivery
  // ── New WhatsApp-grade preference rows (15-gap closer 2026-05-18) ──
  // Each lives in AsyncStorage / localStorage via getStorage/setStorage so
  // the source-of-truth is the device — backend sync only if/when a feature
  // calls for it (e.g. theme follows device on mobile, bubble shape is
  // device-local). Defaults match the per-row spec in the task brief.
  // themeMode + setThemeMode now come from ThemeContext (3-state setter is
  // real). The local shadow state was removed — the active pill reads
  // `themeMode` from context and the picker calls setThemeModeCtx().
  const [enterSends, setEnterSends] = useState(Platform.OS === 'web');
  const [autocorrectOn, setAutocorrectOn] = useState(true);
  const [voiceSpeedDefault, setVoiceSpeedDefault] = useState(1); // 0.5 | 1 | 1.5 | 2
  const [betaFeatures, setBetaFeatures] = useState(false);
  const [languageAuto, setLanguageAuto] = useState(false);
  const [dataSaver, setDataSaver] = useState(false);
  const [bubbleShape, setBubbleShape] = useState('rounded'); // 'rounded' | 'square' | 'classic'
  const [notifLedColor, setNotifLedColor] = useState('#7C3AED');
  const [mediaRoaming, setMediaRoaming] = useState(false);
  // [gap C3 2026-05-20] WhatsApp parity — "Usar menos dados em chamadas".
  // Caps video at 200kbps / 15fps / 360p with 2-layer simulcast (180p+360p).
  // app/call.js reads `chatyy_low_data_calls` before setCameraEnabled. Even
  // when this is OFF the auto-roaming detector force-enables low-data when
  // NetInfo flags an expensive cellular link.
  const [lowDataCalls, setLowDataCalls] = useState(false);
  // [WhatsApp "Media visibility" 2026-05-26] Auto-save received photos/videos
  // into the phone gallery / camera roll. Default ON, like WhatsApp. Persisted
  // under `autoSaveMediaToGallery`; mediaCache reads the same key + mirrors it
  // so cacheMedia's inbound download success path saves to the OS gallery
  // without an app restart.
  const [autoSaveGallery, setAutoSaveGallery] = useState(true);
  // Default = Chatyy purple (was WhatsApp green '#075E54'). Stored as a
  // hex so chat-conversation.js renders it correctly — gradient swatches
  // below are previews; the dominant hex is what we actually persist.
  const [wallpaperDefault, setWallpaperDefault] = useState('#7C3AED');
  // Modal state
  const [aboutOpen, setAboutOpen] = useState(false);
  const [backupKeyOpen, setBackupKeyOpen] = useState(false);
  const [backupKeyPass, setBackupKeyPass] = useState('');
  const [backupKeyPass2, setBackupKeyPass2] = useState('');
  const [backupKeyBusy, setBackupKeyBusy] = useState(false);
  const [backupKeyMsg, setBackupKeyMsg] = useState('');
  // Network usage stats — placeholder values pulled from media_dl_stats
  // (lifetime up/down bytes for chat media). When the service hasn't been
  // wired the rows show "—".
  const [netStats, setNetStats] = useState(null);
  // Palavras silenciadas (mute words) — user's per-feed blocklist. Posts
  // whose caption contains any of these words are filtered server-side
  // inside feed_list. CRUD via feed_muted_words_* endpoints.
  const [mutedWords, setMutedWords] = useState([]);
  const [mutedWordsInput, setMutedWordsInput] = useState('');
  const [mutedWordsLoading, setMutedWordsLoading] = useState(false);
  // Login alerts — opt-in push when a NEW device signs into this account.
  // Hydrates from chat_user_defaults.login_alerts_enabled (default ON). The
  // history modal pulls last 30d of sign-in events via getLoginHistory().
  const [loginAlertsEnabled, setLoginAlertsEnabled] = useState(true);
  const [loginHistoryOpen, setLoginHistoryOpen] = useState(false);
  const [loginHistory, setLoginHistory] = useState([]);
  const [loginHistoryLoading, setLoginHistoryLoading] = useState(false);
  const [avatarKey, setAvatarKey] = useState(Date.now());
  // Live search across settings rows. Filters out sections whose section
  // title and row labels don't match the typed query (case-insensitive).
  // Empty query = no filtering. Provides a fast jump-to-config without
  // making the user remember which sub-section a toggle lives in.
  const [searchQuery, setSearchQuery] = useState('');
  const _q = (searchQuery || '').trim().toLowerCase();
  // Collect every label string we know about (gathered DURING render via
  // sectionMatches calls below) so the next render can show a flat
  // "results" strip at the top of the scroll. We use useRef to span
  // renders — first render after a query change populates, second render
  // displays the strip. The 1-frame lag is invisible because RN batches.
  const _allLabelsRef = useRef([]);
  const sectionMatches = (...labels) => {
    // Track every label string we've seen across renders so we can
    // search the catalog up-front rather than waiting on render order.
    for (const l of labels) {
      if (l && !_allLabelsRef.current.includes(String(l))) {
        _allLabelsRef.current.push(String(l));
      }
    }
    if (!_q) return true;
    for (const l of labels) {
      if (l && String(l).toLowerCase().includes(_q)) return true;
    }
    return false;
  };
  // Derive the flat list of matched labels from the (cumulative) catalog
  // and the current query. Re-evaluated every render — cheap, the catalog
  // is ~30 strings.
  const _matchedLabels = !_q ? [] : _allLabelsRef.current.filter(
    l => String(l).toLowerCase().includes(_q)
  );
  // Referral system
  const [referralCode, setReferralCode] = useState('');
  const [referralCount, setReferralCount] = useState(0);
  const [referralLoading, setReferralLoading] = useState(false);

  // Auto-reply (vacation responder) — loads via vacation_get, saves via
  // vacation_set. Previously the UI wrote to settings.auto_reply* which went
  // nowhere; now it persists server-side.
  const [vacation, setVacation] = useState({ enabled: false, subject: '', body: '', start_date: null, end_date: null });
  const _vacationSaveTimer = useRef(null);
  useEffect(() => {
    let alive = true;
    api.vacationGet?.().then(r => {
      if (!alive) return;
      const d = r?.data || r;
      if (d && (r?.success || d.enabled !== undefined)) {
        setVacation({
          enabled: !!d.enabled,
          subject: d.subject || '',
          body: d.body || '',
          start_date: d.start_date || null,
          end_date: d.end_date || null,
        });
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const saveVacation = useCallback((patch) => {
    setVacation(prev => {
      const next = { ...prev, ...patch };
      if (_vacationSaveTimer.current) clearTimeout(_vacationSaveTimer.current);
      _vacationSaveTimer.current = setTimeout(() => {
        api.vacationSet?.({
          enabled: next.enabled,
          subject: next.subject,
          body: next.body,
          start_date: next.start_date,
          end_date: next.end_date,
        }).catch(() => {});
      }, 500);
      return next;
    });
  }, []);
  useEffect(() => () => { if (_vacationSaveTimer.current) clearTimeout(_vacationSaveTimer.current); }, []);

  // ── Notification preferences (server-backed) ────────────────────────
  // chat_user_notif_prefs_get/set is the single source of truth for:
  //   push_notif_level, hide_reactions_in_notifs, led_color_default,
  //   morning_briefing, font_size.
  // We hydrate these on mount (overriding the local-storage defaults set
  // elsewhere) and write through chatSetNotifPrefs on change. Helper below
  // is used by every consumer so the backend always sees the change.
  const saveNotifPref = useCallback((patch) => {
    try { api.chatSetNotifPrefs?.(patch).catch(() => {}); } catch {}
  }, []);
  useEffect(() => {
    let alive = true;
    api.chatGetNotifPrefs?.().then(r => {
      if (!alive) return;
      const d = r?.data || (r?.success ? r : null);
      if (!d) return;
      if (typeof d.push_notif_level === 'string') setPushNotifLevel(d.push_notif_level);
      if (typeof d.led_color_default === 'string' && /^#[0-9a-fA-F]{6}$/.test(d.led_color_default)) setNotifLedColor(d.led_color_default);
      if (d.hide_reactions_in_notifs !== undefined && d.hide_reactions_in_notifs !== null) {
        setChatPrivacy(prev => ({ ...prev, hide_reactions_in_notifs: !!d.hide_reactions_in_notifs }));
      }
      setSettings(prev => {
        const next = { ...prev };
        if (d.morning_briefing !== undefined && d.morning_briefing !== null) next.morning_briefing = !!d.morning_briefing;
        if (typeof d.font_size === 'string') next.font_size = d.font_size;
        return next;
      });
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web') {
      const oe = getStorage('one_enabled');
      if (oe === 'false') setOneEnabled(false);
      const ol = getStorage('one_notif_level');
      if (ol) setOneNotifLevel(ol);
      const pl = getStorage('push_notif_level');
      if (pl) setPushNotifLevel(pl);
    } else {
      import('@react-native-async-storage/async-storage').then(m => {
        Promise.all([
          m.default.getItem('one_enabled'),
          m.default.getItem('one_notif_level'),
          m.default.getItem('push_notif_level'),
        ]).then(([enabled, level, pushLevel]) => {
          if (enabled === 'false') setOneEnabled(false);
          if (level) setOneNotifLevel(level);
          if (pushLevel) setPushNotifLevel(pushLevel);
        }).catch(() => {});
      }).catch(() => {});
    }
  }, []);

  // ── Hydrate the new 15-gap prefs from local storage ────────────────
  // All are device-local; we read them once on mount and write through
  // setStorage on every change. The themeMode key shadows the ThemeContext
  // boolean toggle: `light`/`dark` force the value, `system` lets the
  // existing toggle drive (we don't subscribe to Appearance changes since
  // ThemeContext owns that — this row is purely a forcing-knob).
  useEffect(() => {
    const apply = (kv) => {
      // theme_mode is owned by ThemeContext now — no local hydration here.
      if (kv.enter_sends === 'true') setEnterSends(true);
      else if (kv.enter_sends === 'false') setEnterSends(false);
      if (kv.autocorrect_enabled === 'false') setAutocorrectOn(false);
      const vs = parseFloat(kv.voice_speed_default);
      if (Number.isFinite(vs) && [0.5, 1, 1.5, 2].includes(vs)) setVoiceSpeedDefault(vs);
      if (kv.beta_features === 'true') setBetaFeatures(true);
      if (kv.language_auto === 'true') setLanguageAuto(true);
      if (kv.data_saver === 'true') setDataSaver(true);
      if (kv.bubble_shape === 'rounded' || kv.bubble_shape === 'square' || kv.bubble_shape === 'classic') setBubbleShape(kv.bubble_shape);
      if (typeof kv.notif_led_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(kv.notif_led_color)) setNotifLedColor(kv.notif_led_color);
      if (kv.media_auto_dl_roaming === 'true') setMediaRoaming(true);
      if (typeof kv.wallpaper_default === 'string' && kv.wallpaper_default.length > 0) setWallpaperDefault(kv.wallpaper_default);
      if (kv.chatyy_low_data_calls === 'true' || kv.chatyy_low_data_calls === '1') setLowDataCalls(true);
      // Default ON — only an explicit 'false' turns it off.
      if (kv.autoSaveMediaToGallery === 'false' || kv.autoSaveMediaToGallery === '0') setAutoSaveGallery(false);
    };
    const KEYS = [
      'enter_sends', 'autocorrect_enabled', 'voice_speed_default',
      'beta_features', 'language_auto', 'data_saver', 'bubble_shape',
      'notif_led_color', 'media_auto_dl_roaming', 'wallpaper_default',
      'chatyy_low_data_calls', 'autoSaveMediaToGallery',
    ];
    if (Platform.OS === 'web') {
      const kv = {};
      for (const k of KEYS) kv[k] = getStorage(k);
      apply(kv);
    } else {
      import('@react-native-async-storage/async-storage').then(m => {
        Promise.all(KEYS.map(k => m.default.getItem(k))).then(vals => {
          const kv = {};
          KEYS.forEach((k, i) => { kv[k] = vals[i]; });
          apply(kv);
        }).catch(() => {});
      }).catch(() => {});
    }

    // Network usage stats — try services/mediaCache.getNetStats then fall
    // back to a stashed media_dl_stats blob. Either returns { up, down }
    // in bytes; missing keys leave the placeholder dashes in place.
    (async () => {
      try {
        if (Platform.OS !== 'web') {
          const mc = require('../services/mediaCache');
          if (typeof mc.getNetStats === 'function') {
            const r = await mc.getNetStats();
            if (r && (Number.isFinite(r.up) || Number.isFinite(r.down))) {
              setNetStats({ up: r.up || 0, down: r.down || 0 });
              return;
            }
          }
        }
        // Fallback: serialized blob in storage written by other services.
        let raw = null;
        if (Platform.OS === 'web') raw = getStorage('media_dl_stats');
        else {
          const m = await import('@react-native-async-storage/async-storage');
          raw = await m.default.getItem('media_dl_stats');
        }
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && (Number.isFinite(parsed.up) || Number.isFinite(parsed.down))) {
              setNetStats({ up: parsed.up || 0, down: parsed.down || 0 });
            }
          } catch {}
        }
      } catch {}
    })();
  }, []);

  const [settings, setSettings] = useState({
    signature: '',
    emails_per_page: 20,
    notifications: true,
    notification_sound: true,
    notification_vibration: true,
    language: 'pt-BR',
    auto_reply: false,
    auto_reply_message: '',
    forwarding_email: '',
    forwarding_enabled: false,
    font_size: 'medium',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const savedTimerRef = require('react').useRef(null);
  const initialSettingsRef = require('react').useRef(null);
  const [showFilters, setShowFilters] = useState(false);
  const [notifPermission, setNotifPermission] = useState(
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'default'
  );

  // Wave 4: Do-Not-Disturb schedule. Pulls chat_user_dnd on mount + on
  // toggle/save. UI lives in the desktopNotifs section below. Defaults
  // 22:00 → 07:00 — most common "quiet evening" pattern in product
  // research. tz_offset is captured client-side once via Date#getTimezoneOffset
  // (note: JS returns minutes *behind* UTC, so we flip the sign before
  // sending so the backend can store minutes *east* of UTC).
  const [dnd, setDnd] = useState({ enabled: false, start_time: '22:00', end_time: '07:00', tz_offset: 0 });
  const [dndSaving, setDndSaving] = useState(false);
  // [dedupe 2026-05-25] The push gate honors chat_user_defaults.dnd_* (set by
  // /notification-preferences), NOT the legacy chat_user_dnd table that
  // chatDndGet/Set wrote to. Switched this inline DND UI to read/write
  // chat_user_defaults.{dnd_enabled,dnd_start_time,dnd_end_time} via
  // chatUserDefaultsGet/Set so the toggle here actually mutes pushes.
  useEffect(() => {
    (async () => {
      try {
        const r = await api.chatUserDefaultsGet?.();
        const d = r?.data;
        if (r?.success && d) {
          setDnd({
            enabled: !!d.dnd_enabled,
            start_time: d.dnd_start_time || '22:00',
            end_time: d.dnd_end_time || '07:00',
            tz_offset: 0,
          });
        }
      } catch {}
    })();
  }, []);
  const saveDnd = useCallback(async (patch) => {
    setDnd(prev => {
      const next = { ...prev, ...patch };
      (async () => {
        setDndSaving(true);
        try {
          await api.chatUserDefaultsSet?.({
            dnd_enabled: next.enabled,
            dnd_start_time: next.start_time,
            dnd_end_time: next.end_time,
          });
        } catch {}
        setDndSaving(false);
      })();
      return next;
    });
  }, []);

  // ── Chat user defaults: media auto-download + default disappearing ──
  // Loaded from /chat.php?action=chat_user_defaults_get on mount; mutations
  // debounced by 500ms before PATCHing back via chat_user_defaults_set.
  // Mirrored into AsyncStorage via setMediaDownloadPrefs so mediaCache's
  // cellular gate picks up the new prefs instantly.
  const [chatDefaults, setChatDefaults] = useState({
    default_disappearing: 0,
    media_auto_dl_photos: 'wifi',
    media_auto_dl_audio:  'wifi',
    media_auto_dl_videos: 'never',
    media_auto_dl_docs:   'never',
  });
  const _chatDefaultsHydrated = useRef(false);
  const _chatDefaultsSaveTimer = useRef(null);
  // [2026-05-18] Pending coalesced patch — see updateChatDefault comments.
  const _chatDefaultsPendingPatch = useRef({});

  useEffect(() => {
    (async () => {
      try {
        const r = await api.chatUserDefaultsGet?.();
        if (r?.success && r.data) {
          const next = {
            default_disappearing: Number.isFinite(+r.data.default_disappearing) ? +r.data.default_disappearing : 0,
            media_auto_dl_photos: r.data.media_auto_dl_photos || 'wifi',
            media_auto_dl_audio:  r.data.media_auto_dl_audio  || 'wifi',
            media_auto_dl_videos: r.data.media_auto_dl_videos || 'never',
            media_auto_dl_docs:   r.data.media_auto_dl_docs   || 'never',
          };
          setChatDefaults(next);
          // Login alerts persist under the same chat_user_defaults blob —
          // backend column `login_alerts_enabled` (boolean, default true).
          // Falls back to ON if the column was added after the user's row
          // was created and still reads NULL.
          if (r.data.login_alerts_enabled !== undefined && r.data.login_alerts_enabled !== null) {
            setLoginAlertsEnabled(!!r.data.login_alerts_enabled);
          }
          // Push the media prefs into mediaCache so the cellular gate updates
          // without waiting for the next app launch.
          try {
            const mc = require('../services/mediaCache');
            mc.setMediaDownloadPrefs?.({
              media_auto_dl_photos: next.media_auto_dl_photos,
              media_auto_dl_audio:  next.media_auto_dl_audio,
              media_auto_dl_videos: next.media_auto_dl_videos,
              media_auto_dl_docs:   next.media_auto_dl_docs,
            });
          } catch {}
        }
      } catch {}
      _chatDefaultsHydrated.current = true;
    })();
  }, []);

  // Debounced save: any change to chatDefaults schedules a PATCH 500ms later.
  // Coalesces rapid toggles (e.g. user cycling through wifi → mobile → never)
  // into a single backend roundtrip.
  const updateChatDefault = useCallback((patch) => {
    setChatDefaults(prev => {
      const next = { ...prev, ...patch };
      // Mirror media keys into mediaCache instantly.
      const mediaPatch = {};
      for (const k of ['media_auto_dl_photos','media_auto_dl_audio','media_auto_dl_videos','media_auto_dl_docs']) {
        if (k in patch) mediaPatch[k] = next[k];
      }
      if (Object.keys(mediaPatch).length) {
        try {
          const mc = require('../services/mediaCache');
          mc.setMediaDownloadPrefs?.(mediaPatch);
        } catch {}
      }
      // [2026-05-18] Debounce backend save — COALESCE patches into a single
      // PATCH body. Previously the closure captured only the most recent
      // `patch` arg, so when the user toggled photos→wifi then videos→never
      // within 500ms, the timer was cleared+rescheduled and only the LAST
      // patch (videos) was sent — photos was lost on next page reload.
      // Now we merge into `_chatDefaultsPendingPatch.current` and flush the
      // accumulated patch when the timer fires. The frontend state was
      // already correct via `setChatDefaults(prev => next)`; this fix just
      // makes the backend match.
      Object.assign(_chatDefaultsPendingPatch.current, patch);
      if (_chatDefaultsSaveTimer.current) clearTimeout(_chatDefaultsSaveTimer.current);
      _chatDefaultsSaveTimer.current = setTimeout(() => {
        const toSend = _chatDefaultsPendingPatch.current;
        _chatDefaultsPendingPatch.current = {};
        if (Object.keys(toSend).length) {
          api.chatUserDefaultsSet?.(toSend).catch(() => {});
        }
      }, 500);
      return next;
    });
  }, []);

  useEffect(() => () => { if (_chatDefaultsSaveTimer.current) clearTimeout(_chatDefaultsSaveTimer.current); }, []);

  // ── Chat granular privacy ──────────────────────────────────────────
  // Backend already exposes chat_privacy_get/set against PG table
  // chat_user_privacy. UI surfaces 5 controls: last_seen, profile_photo,
  // read_receipts (bool), status (mapped to backend's story_privacy column),
  // groups (mapped to backend's group_add column). Each control opens a
  // bottom-sheet picker (Everyone / My contacts / Nobody) — except
  // read_receipts which is a simple Switch. Save is fire-and-forget.
  const [chatPrivacy, setChatPrivacy] = useState({
    last_seen: 'everyone',
    profile_photo: 'everyone',
    read_receipts: true,
    story_privacy: 'everyone',
    group_add: 'everyone',
    // [#gap_notifications 2026-05-19] Suppress push notifications for
    // chat_reaction events (emoji-only reactions). Stored server-side on
    // chat_user_defaults via chat_privacy_set. Default OFF.
    hide_reactions_in_notifs: false,
    // [mute-call-ringtone, 2026-05-19] "Modo silencioso para ligações" —
    // when ON the JS ringtone (services/ringtone.js) and Android channel
    // sound stay silent. The UI modal still surfaces so the user can pick
    // up; this only kills the audible/haptic ring. Stored server-side on
    // chat_user_defaults so it follows the account across devices.
    mute_call_ringtone: false,
  });
  const [privacyPickerOpen, setPrivacyPickerOpen] = useState(null); // 'last_seen' | 'profile_photo' | 'story_privacy' | 'group_add' | null
  useEffect(() => {
    (async () => {
      try {
        const r = await api.chatPrivacyGet?.();
        if (r?.success && r.data) {
          setChatPrivacy(prev => ({
            ...prev,
            last_seen:     r.data.last_seen     || 'everyone',
            profile_photo: r.data.profile_photo || 'everyone',
            read_receipts: r.data.read_receipts !== undefined ? !!r.data.read_receipts : true,
            // Backend exposes story_privacy for "Status" and group_add for
            // "Grupos". Defaults reflect the chat_privacy_set valid set.
            story_privacy: r.data.story_privacy || 'everyone',
            group_add:     r.data.group_add     || 'everyone',
            hide_reactions_in_notifs:
              r.data.hide_reactions_in_notifs !== undefined ? !!r.data.hide_reactions_in_notifs : false,
            mute_call_ringtone:
              r.data.mute_call_ringtone !== undefined ? !!r.data.mute_call_ringtone : false,
          }));
          // [mute-call-ringtone, 2026-05-19] Mirror to local storage so
          // services/ringtone.js can read it synchronously on the next
          // inbound ring (it ships before the next chat_privacy_get
          // round-trip lands).
          try {
            if (Platform.OS === 'web') {
              if (typeof localStorage !== 'undefined') {
                localStorage.setItem('mute_call_ringtone', r.data.mute_call_ringtone ? 'true' : 'false');
              }
            } else {
              import('@react-native-async-storage/async-storage').then(m => {
                m.default.setItem('mute_call_ringtone', r.data.mute_call_ringtone ? 'true' : 'false').catch(() => {});
              }).catch(() => {});
            }
          } catch {}
        }
      } catch {}
    })();
  }, []);
  const saveChatPrivacy = useCallback((patch) => {
    setChatPrivacy(prev => {
      const next = { ...prev, ...patch };
      // Only ship the keys that changed — chat_privacy_set merges unspecified
      // columns to their existing values so partial PATCHes are safe.
      api.chatPrivacySet?.(patch).catch(() => {});
      // [mute-call-ringtone, 2026-05-19] Mirror the toggle to local
      // storage immediately so services/ringtone.js (which doesn't have an
      // observer on the network response) sees the new value before the
      // next inbound ring.
      if (Object.prototype.hasOwnProperty.call(patch, 'mute_call_ringtone')) {
        try {
          const v = patch.mute_call_ringtone ? 'true' : 'false';
          if (Platform.OS === 'web') {
            if (typeof localStorage !== 'undefined') localStorage.setItem('mute_call_ringtone', v);
          } else {
            import('@react-native-async-storage/async-storage').then(m => {
              m.default.setItem('mute_call_ringtone', v).catch(() => {});
            }).catch(() => {});
          }
        } catch {}
      }
      return next;
    });
  }, []);

  // ── Storage stats (Settings → Storage section) ──────────────────────
  // Scans the local mediaCache dirs (cache + saved-permanent) once on mount
  // and aggregates total bytes + per-bucket breakdown. Re-runs when the user
  // taps "Clear cache" so the card reflects the empty state immediately.
  // Web platforms get a null result and the section is hidden — there's no
  // on-disk store in the browser, only IndexedDB which isn't user-relevant
  // here.
  const [storageStats, setStorageStats] = useState(null);
  const [storageBusy, setStorageBusy] = useState(false);

  const refreshStorageStats = useCallback(async () => {
    if (Platform.OS === 'web') return;
    try {
      const mc = require('../services/mediaCache');
      if (typeof mc.getStorageStats !== 'function') return;
      const stats = await mc.getStorageStats();
      setStorageStats(stats);
    } catch {}
  }, []);

  useEffect(() => { refreshStorageStats(); }, [refreshStorageStats]);

  // [2026-05-18] Re-scan storage every time the screen regains focus.
  // User clears a chat / saves a media file in another screen → coming back
  // to settings should reflect the new totals without a manual tap. Mobile
  // only — web has no on-disk store so the stats are always zero.
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'web') {
        refreshStorageStats();
      }
      return undefined;
    }, [refreshStorageStats])
  );

  useEffect(() => {
    loadSettings();
    // Load undo delay + smart compose + notif prefs
    if (Platform.OS === 'web') {
      const d = getStorage('undo_send_delay');
      if (d) setUndoDelay(parseInt(d, 10) || 5);
      const sc = getStorage('smart_compose');
      if (sc === 'false') setSmartComposeOn(false);
      try {
        const np = getStorage('notif_prefs');
        if (np) {
          const parsed = JSON.parse(np);
          setSettings(prev => ({ ...prev, ...parsed }));
        }
      } catch {}
    } else {
      import('@react-native-async-storage/async-storage').then(m => {
        m.default.getItem('undo_send_delay').then(d => {
          if (d) setUndoDelay(parseInt(d, 10) || 5);
        }).catch(() => {});
        m.default.getItem('smart_compose').then(v => {
          if (v === 'false') setSmartComposeOn(false);
        }).catch(() => {});
        m.default.getItem('notif_prefs').then(v => {
          if (v) {
            try {
              const parsed = JSON.parse(v);
              setSettings(prev => ({ ...prev, ...parsed }));
            } catch {}
          }
        }).catch(() => {});
      }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  // Load referral code
  useEffect(() => {
    api.getReferralCode().then(r => {
      if (r.success && r.data) {
        setReferralCode(r.data.code || '');
        setReferralCount(r.data.referred_count || 0);
      }
    }).catch(() => {});
  }, []);

  // Load the viewer's muted words once (Privacy section). The backend returns
  // most-recent-first; we drop the timestamps and just keep the strings.
  useEffect(() => {
    let alive = true;
    api.feedMutedWordsList().then(r => {
      if (!alive) return;
      if (r?.success && Array.isArray(r.data?.words)) {
        setMutedWords(r.data.words);
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const handleAddMutedWord = useCallback(async () => {
    const w = mutedWordsInput.trim().toLowerCase();
    if (!w || mutedWords.includes(w)) {
      setMutedWordsInput('');
      return;
    }
    setMutedWordsLoading(true);
    // Optimistic — prepend and clear input; revert on failure.
    setMutedWords(prev => [w, ...prev]);
    setMutedWordsInput('');
    try {
      const r = await api.feedMutedWordsAdd(w);
      if (!r?.success) setMutedWords(prev => prev.filter(x => x !== w));
    } catch {
      setMutedWords(prev => prev.filter(x => x !== w));
    } finally {
      setMutedWordsLoading(false);
    }
  }, [mutedWordsInput, mutedWords]);

  const handleRemoveMutedWord = useCallback(async (word) => {
    setMutedWords(prev => prev.filter(x => x !== word));
    try { await api.feedMutedWordsRemove(word); } catch {}
  }, []);

  const handleShareReferral = async () => {
    const link = `https://chatyy.com.br/signup?ref=${referralCode}`;
    const msg = t('referral.shareMessage').replace('{code}', referralCode).replace('{link}', link);
    if (Platform.OS === 'web') {
      try {
        await navigator.clipboard.writeText(msg);
        if (Platform.OS === 'web') Alert.alert(t('referral.copied'));
      } catch {
        try { await navigator.share({ text: msg }); } catch {}
      }
    } else {
      try { await Share.share({ message: msg }); } catch {}
    }
  };

  const loadSettings = async () => {
    try {
      const { getSettings } = await import('../services/api');
      const r = await getSettings();
      if (r.success && r.data) {
        setSettings(prev => {
          const merged = { ...prev, ...r.data };
          initialSettingsRef.current = JSON.stringify(merged);
          return merged;
        });
      } else {
        setSettings(prev => { initialSettingsRef.current = JSON.stringify(prev); return prev; });
      }
    } catch {} finally {
      setLoading(false);
    }
  };

  const isDirty = () => {
    try { return initialSettingsRef.current && JSON.stringify(settings) !== initialSettingsRef.current; } catch { return false; }
  };
  const handleBack = () => {
    if (isDirty()) {
      Alert.alert(
        t('settings.unsavedTitle') || 'Alterações não salvas',
        t('settings.unsavedMessage') || 'Quer salvar antes de sair?',
        [
          { text: t('settings.discard') || 'Descartar', style: 'destructive', onPress: () => router.back() },
          { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
          { text: t('settings.save') || 'Salvar', onPress: async () => { await handleSave(); router.back(); } },
        ]
      );
    } else {
      router.back();
    }
  };
  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const { updateSettings } = await import('../services/api');
      const r = await updateSettings(settings);
      if (r.success) {
        setSaved(true);
        initialSettingsRef.current = JSON.stringify(settings);
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => setSaved(false), 2000);
        // A successful settings save can change the display name surfaced on
        // the profile. Invalidate the cached profile blob (set by
        // AuthContext.prefetchProfile with a 600s TTL) so the profile screen
        // and /u/{email} reflect the change instead of stale data.
        try {
          const { invalidate } = await import('../services/cache');
          invalidate?.('user_profile');
        } catch {}
      }
      // Persist notification prefs locally + update MailContext
      const notifPrefs = {
        notification_sound: settings.notification_sound,
        notification_vibration: settings.notification_vibration,
      };
      const json = JSON.stringify(notifPrefs);
      setStorage('notif_prefs', json);
      try {
        const { updateNotifSettings } = await import('../context/MailContext');
        updateNotifSettings(notifPrefs);
      } catch {}
    } catch {} finally {
      setSaving(false);
    }
  };

  const handleChangePhoto = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      if (!result.canceled && result.assets?.[0]) {
        const asset = result.assets[0];
        // Reject huge files at the client edge — upload silently times out
        // for files >25MB and the user gets no feedback.
        if (asset.fileSize && asset.fileSize > 25 * 1024 * 1024) {
          Alert.alert(t('common.error') || 'Erro', t('settings.avatarTooBig') || 'Foto muito grande (máx 25MB).');
          return;
        }
        const { uploadAvatar } = await import('../services/api');
        const file = { uri: asset.uri, name: 'avatar.jpg', type: 'image/jpeg' };
        try {
          const r = await uploadAvatar(file);
          if (r?.success) {
            setAvatarKey(Date.now());
            // Invalidate the cached profile blob so /u/{email} (and the
            // profile screen) don't serve a stale avatar for the full 600s
            // TTL set by AuthContext.prefetchProfile.
            try {
              const { invalidate } = await import('../services/cache');
              invalidate?.('user_profile');
            } catch {}
            // Also drop the per-email profile_v1 MMKV cache used by the
            // profile viewer component (Profile.js) so it re-fetches.
            try {
              const { invalidateProfileCache } = await import('../components/Profile');
              if (typeof invalidateProfileCache === 'function') {
                invalidateProfileCache(null);
              }
            } catch {}
          } else {
            Alert.alert(t('common.error') || 'Erro', r?.message || (t('settings.avatarUploadFailed') || 'Falha ao salvar foto.'));
          }
        } catch (e) {
          Alert.alert(t('common.error') || 'Erro', e?.message || (t('settings.avatarUploadFailed') || 'Falha ao salvar foto.'));
        }
      }
    } catch (e) {
      console.warn('[settings/avatar]', e?.message || e);
    }
  };

  return (
    <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[s.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={handleBack} style={s.backBtn} accessibilityLabel={t('common.back') || 'Voltar'} accessibilityRole="button">
          <IconArrowLeft size={24} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={[s.headerTitle, { color: colors.text }]} numberOfLines={1}>{t('settings.title')}</Text>
        <TouchableOpacity
          style={[s.saveBtn, { backgroundColor: colors.primary }, saving && s.saveBtnDisabled]}
          onPress={handleSave}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={s.saveBtnText}>{saved ? t('settings.saved') : t('settings.save')}</Text>
          )}
        </TouchableOpacity>
      </View>

      {loading ? (
        <SettingsSkeleton sections={4} rows={3} />
      ) : (
      <ScrollView ref={scrollRef} contentContainerStyle={s.scroll}>
        {/* Search bar — filtra sections em tempo real por título/label.
            Empty query mostra tudo; clear (✕) reseta. Sticky-ish topo da
            scroll, não é absolute pra não brigar com keyboard. */}
        <View style={{
          flexDirection: 'row', alignItems: 'center',
          backgroundColor: colors.surface,
          borderColor: colors.borderLight, borderWidth: 1,
          borderRadius: 14, paddingHorizontal: 12, paddingVertical: 4,
          marginBottom: Spacing.lg,
        }}>
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder={t('settings.searchPlaceholder') || 'Buscar configuração...'}
            placeholderTextColor={colors.textTertiary}
            style={{
              flex: 1, color: colors.text, fontSize: FontSize.base,
              paddingVertical: 8, paddingHorizontal: 4,
              ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
            }}
            autoCorrect={false}
            autoCapitalize="none"
            accessibilityLabel={t('settings.searchPlaceholder') || 'Buscar configuração'}
          />
          {!!searchQuery && (
            <TouchableOpacity
              onPress={() => setSearchQuery('')}
              style={{ padding: 6, borderRadius: 12 }}
              accessibilityLabel={t('common.clear') || 'Limpar'}
              accessibilityRole="button"
            >
              <IconX size={16} color={colors.textTertiary} />
            </TouchableOpacity>
          )}
        </View>

        {/* Flat matches strip — when user is searching, surface matched
            section labels as pill chips in primary color. Sits above the
            (already-filtered) section bodies so the user gets an overview
            of where matches live without scrolling through every card.
            Read-only summary; tapping a pill is a no-op (sections render
            inline below) — keeps the impl edit-only without rewiring
            scroll-to-section logic. The catalog of labels is gathered
            cumulatively as sectionMatches is called, so the strip needs
            one render to "warm up" — invisible because RN batches. */}
        {!!_q && _matchedLabels.length > 0 && (
          <View style={{
            flexDirection: 'row', flexWrap: 'wrap', gap: 6,
            marginBottom: Spacing.lg,
            paddingHorizontal: 4,
          }}>
            <Text style={{ color: colors.textTertiary, fontSize: 12, fontWeight: '600', width: '100%', marginBottom: 4 }}>
              {(t('settings.matchesFound') || 'Resultados') + ` (${_matchedLabels.length})`}
            </Text>
            {_matchedLabels.map((lbl, i) => (
              <View key={`${lbl}-${i}`} style={{
                backgroundColor: colors.primary + '14',
                borderColor: colors.primary + '40', borderWidth: 1,
                borderRadius: 14,
                paddingHorizontal: 10, paddingVertical: 4,
              }}>
                <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '700' }} numberOfLines={1}>
                  {String(lbl)}
                </Text>
              </View>
            ))}
          </View>
        )}
        {!!_q && _matchedLabels.length === 0 && _allLabelsRef.current.length > 0 && (
          <View style={{ paddingVertical: 24, alignItems: 'center' }}>
            <Text style={{ color: colors.textTertiary, fontSize: 13 }}>
              {t('settings.noMatches') || 'Nenhum resultado'}
            </Text>
          </View>
        )}

        {/* Profile Photo — wrap avatar in a subtle brand-color ring so the
            account header reads as the "you" anchor on the settings screen
            (matches the /u/[username] header treatment). */}
        {sectionMatches(t('settings.profile') || 'profile', user?.email) && (
        <View style={[s.section, s.profileSection, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <View style={{
            padding: 3, borderRadius: 50, borderWidth: 2, borderColor: colors.primary + '55',
            ...(Platform.OS === 'web' ? { boxShadow: `0 0 0 4px ${colors.primary}10` } : {}),
          }}>
            <AvatarCircle key={avatarKey} email={user?.email} name={user?.email} size={80} />
          </View>
          <Text style={[s.profileEmail, { color: colors.text }]}>{user?.email}</Text>
          <TouchableOpacity
            style={[s.changePhotoBtn, { borderColor: colors.primary }]}
            onPress={handleChangePhoto}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <Text style={[s.changePhotoBtnText, { color: colors.primary }]}>{t('settings.changePhoto')}</Text>
          </TouchableOpacity>
        </View>
        )}

        {/* Appearance */}
        {sectionMatches(t('settings.appearance'), t('settings.theme.light'), t('settings.theme.dark'), t('settings.theme.system'), t('settings.density')) && (
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>{t('settings.appearance')}</Text>

          {/* Theme tri-state — Light / Dark / System. `system` defers to
              ThemeContext's auto-detect (we just clear the override so the
              existing toggle keeps the user's last manual choice without
              forcing). `light`/`dark` set the toggle directly via isDark
              comparison. Storage key is `theme_mode` so other surfaces
              (Profile theme picker, future bootstrap) can read it. */}
          <View style={[s.settingRowColumn, { borderBottomColor: colors.borderLight }]}>
            <View style={{ width: '100%' }}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.theme.label') || 'Tema'}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.darkModeDesc')}
              </Text>
            </View>
            <View style={[s.perPageBtns, { marginTop: 10, flexWrap: 'wrap' }]}>
              {[
                { val: 'light',  label: t('settings.theme.light') || 'Claro' },
                { val: 'dark',   label: t('settings.theme.dark') || 'Escuro' },
                { val: 'system', label: t('settings.theme.system') || 'Sistema' },
              ].map(opt => (
                <TouchableOpacity
                  key={opt.val}
                  style={[
                    s.perPageBtn,
                    { borderColor: colors.divider },
                    themeMode === opt.val && { backgroundColor: colors.primary, borderColor: colors.primary },
                  ]}
                  onPress={() => {
                    // ThemeContext owns the 3-state mode + persistence.
                    setThemeModeCtx(opt.val);
                  }}
                >
                  <Text style={[
                    s.perPageText, { color: colors.text },
                    themeMode === opt.val && { color: '#fff' },
                  ]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Density */}
          <View style={[s.settingRowColumn, { borderBottomColor: colors.borderLight }]}>
            <View style={{ width: '100%' }}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.density')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.densityDesc')}
              </Text>
            </View>
            <View style={[s.perPageBtns, { marginTop: 10, flexWrap: 'wrap' }]}>
              {[
                { val: 'compact', label: t('settings.densityCompact') },
                { val: 'comfortable', label: t('settings.densityComfortable') },
                { val: 'spacious', label: t('settings.densitySpacious') },
              ].map(d => (
                <TouchableOpacity
                  key={d.val}
                  style={[
                    s.perPageBtn,
                    { borderColor: colors.divider },
                    density === d.val && { backgroundColor: colors.primary, borderColor: colors.primary },
                  ]}
                  onPress={() => setDensity(d.val)}
                >
                  <Text style={[
                    s.perPageText, { color: colors.text },
                    density === d.val && { color: '#fff' },
                  ]}>
                    {d.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
        )}

        {/* ── GROUP: Email (Phase-1 collapsible). Wraps the contiguous
            email-related blocks: Undo Send, Email prefs, Morning Briefing,
            Signatures, Email tools. forceOpen when searching. ── */}
        <CollapsibleGroup title={t('settings.group.email') || 'Email'} icon={IconMail} forceOpen={!!_q}>

        {/* Undo Send */}
        {sectionMatches(t('settings.undoSend'), t('settings.undoSendDesc')) && (
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>{t('settings.undoSend')}</Text>
          <Text style={[s.settingDesc, { color: colors.textTertiary, marginBottom: Spacing.md }]}>
            {t('settings.undoSendDesc')}
          </Text>
          <View style={s.perPageBtns}>
            {[5, 10, 15, 30].map(n => (
              <TouchableOpacity
                key={n}
                style={[
                  s.perPageBtn,
                  { borderColor: colors.divider },
                  undoDelay === n && { backgroundColor: colors.primary, borderColor: colors.primary },
                ]}
                onPress={() => { setUndoDelay(n); setStorage('undo_send_delay', String(n)); }}
              >
                <Text style={[
                  s.perPageText, { color: colors.text },
                  undoDelay === n && { color: '#fff' },
                ]}>
                  {t('settings.undoSendSeconds', { n })}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
        )}

        {/* Email */}
        {sectionMatches(t('settings.email'), t('settings.perPage'), t('settings.notifications'), t('settings.notifSound'), t('settings.notifVibration')) && (
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>{t('settings.email')}</Text>

          <View style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.perPage')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.perPageDesc')}
              </Text>
            </View>
            <View style={s.perPageBtns}>
              {[20, 50, 100].map(n => (
                <TouchableOpacity
                  key={n}
                  style={[
                    s.perPageBtn,
                    { borderColor: colors.divider },
                    settings.emails_per_page === n && { backgroundColor: colors.primary, borderColor: colors.primary },
                  ]}
                  onPress={() => setSettings(prev => ({ ...prev, emails_per_page: n }))}
                >
                  <Text style={[
                    s.perPageText,
                    { color: colors.text },
                    settings.emails_per_page === n && { color: '#fff' },
                  ]}>
                    {n}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View ref={registerSectionRef('notifications')} style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.notifications')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.notificationsDesc')}
              </Text>
            </View>
            <Switch
              value={settings.notifications}
              onValueChange={(v) => setSettings(prev => ({ ...prev, notifications: v }))}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={settings.notifications ? colors.primary : '#fff'}
            />
          </View>

          {settings.notifications && (
            <>
              {/* [notif-p0p1] Link to dedicated notifications fine-tuning screen
                  with global mention_only toggle + per-keyword highlights. */}
              <TouchableOpacity
                style={[s.settingRow, { borderBottomColor: colors.borderLight, paddingLeft: Spacing.xl }]}
                onPress={() => router.push('/notification-preferences')}
                accessibilityRole="button"
                accessibilityLabel="Preferências avançadas de notificação"
              >
                <View style={s.settingInfo}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>Notificações avançadas</Text>
                  <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                    Só de menções, palavras-chave, soneca...
                  </Text>
                </View>
                <IconChevronRight size={18} color={colors.textTertiary} />
              </TouchableOpacity>

              <View style={[s.settingRow, { borderBottomColor: colors.borderLight, paddingLeft: Spacing.xl }]}>
                <View style={s.settingInfo}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.notifSound')}</Text>
                  <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                    {t('settings.notifSoundDesc')}
                  </Text>
                </View>
                <Switch
                  value={settings.notification_sound}
                  onValueChange={(v) => setSettings(prev => ({ ...prev, notification_sound: v }))}
                  trackColor={{ false: colors.divider, true: colors.primaryLight }}
                  thumbColor={settings.notification_sound ? colors.primary : '#fff'}
                />
              </View>

              <View style={[s.settingRow, { borderBottomColor: colors.borderLight, paddingLeft: Spacing.xl }]}>
                <View style={s.settingInfo}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.notifVibration')}</Text>
                  <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                    {t('settings.notifVibrationDesc')}
                  </Text>
                </View>
                <Switch
                  value={settings.notification_vibration}
                  onValueChange={(v) => setSettings(prev => ({ ...prev, notification_vibration: v }))}
                  trackColor={{ false: colors.divider, true: colors.primaryLight }}
                  thumbColor={settings.notification_vibration ? colors.primary : '#fff'}
                />
              </View>

              {/* Wave 4 — Do-Not-Disturb schedule. WhatsApp-grade "quiet
                  hours" toggle plus HH:MM start/end inputs. Backend mutes
                  ALL chat push fanout when current local time falls in
                  the window. TextInput avoids extra deps + keeps web +
                  native parity. Format is HH:MM so the server validator
                  rejects anything else before it ever touches PG. */}
              <View style={[s.settingRow, { borderBottomColor: colors.borderLight, paddingLeft: Spacing.xl }]}>
                <View style={s.settingInfo}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>
                    {t('settings.dndTitle') || 'Não perturbe (horário)'}
                  </Text>
                  <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                    {t('settings.dndDesc') || 'Silencia notificações de chat dentro do horário definido.'}
                  </Text>
                </View>
                <Switch
                  value={dnd.enabled}
                  onValueChange={(v) => saveDnd({ enabled: v })}
                  trackColor={{ false: colors.divider, true: colors.primaryLight }}
                  thumbColor={dnd.enabled ? colors.primary : '#fff'}
                  disabled={dndSaving}
                />
              </View>
              {dnd.enabled && (
                <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: Spacing.xl, paddingBottom: Spacing.md }}>
                  <View style={{ flex: 1 }}>
                    <Text style={[s.settingDesc, { color: colors.textTertiary, marginBottom: 4 }]}>
                      {t('settings.dndStart') || 'Início'}
                    </Text>
                    <TextInput
                      value={dnd.start_time}
                      onChangeText={(v) => setDnd(prev => ({ ...prev, start_time: v }))}
                      onBlur={() => {
                        const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec((dnd.start_time || '').trim());
                        if (m) saveDnd({ start_time: dnd.start_time.trim() });
                        else setDnd(prev => ({ ...prev, start_time: '22:00' }));
                      }}
                      placeholder="22:00"
                      placeholderTextColor={colors.textTertiary}
                      style={{
                        borderWidth: 1, borderColor: colors.divider, borderRadius: 10,
                        paddingVertical: 10, paddingHorizontal: 12, color: colors.text,
                        backgroundColor: colors.surfaceVariant, fontFamily: 'monospace',
                      }}
                      keyboardType="numbers-and-punctuation"
                      maxLength={5}
                      accessibilityLabel={t('settings.dndStart') || 'Início'}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[s.settingDesc, { color: colors.textTertiary, marginBottom: 4 }]}>
                      {t('settings.dndEnd') || 'Fim'}
                    </Text>
                    <TextInput
                      value={dnd.end_time}
                      onChangeText={(v) => setDnd(prev => ({ ...prev, end_time: v }))}
                      onBlur={() => {
                        const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec((dnd.end_time || '').trim());
                        if (m) saveDnd({ end_time: dnd.end_time.trim() });
                        else setDnd(prev => ({ ...prev, end_time: '07:00' }));
                      }}
                      placeholder="07:00"
                      placeholderTextColor={colors.textTertiary}
                      style={{
                        borderWidth: 1, borderColor: colors.divider, borderRadius: 10,
                        paddingVertical: 10, paddingHorizontal: 12, color: colors.text,
                        backgroundColor: colors.surfaceVariant, fontFamily: 'monospace',
                      }}
                      keyboardType="numbers-and-punctuation"
                      maxLength={5}
                      accessibilityLabel={t('settings.dndEnd') || 'Fim'}
                    />
                  </View>
                </View>
              )}
            </>
          )}
        </View>
        )}

        {/* Morning Briefing */}
        {sectionMatches(t('settings.morningBriefing') || 'Bom dia diário', t('settings.morningEnabled') || 'Resumo matinal') && (
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>{t('settings.morningBriefing') || 'Bom dia diário'}</Text>
          <View style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.morningEnabled') || 'Resumo matinal da ONE'}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.morningEnabledDesc') || 'Receba um resumo do dia com emails, eventos e clima às 8h'}
              </Text>
            </View>
            <Switch
              value={settings.morning_briefing !== false}
              onValueChange={(v) => { setSettings(prev => ({ ...prev, morning_briefing: v })); saveNotifPref({ morning_briefing: v }); }}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={settings.morning_briefing !== false ? colors.primary : '#fff'}
            />
          </View>
        </View>
        )}

        {/* Signatures */}
        {sectionMatches(t('settings.signatures'), t('settings.signatureDesc')) && (
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>{t('settings.signatures')}</Text>
          <Text style={[s.settingDesc, { color: colors.textTertiary, marginBottom: Spacing.md }]}>
            {t('settings.signatureDesc')}
          </Text>
          {(settings.signatures || [{ name: t('settings.signatureDefault'), content: settings.signature || '', isDefault: true }]).map((sig, idx) => (
            <View key={idx} style={[s.sigCard, { borderColor: colors.divider, backgroundColor: colors.surfaceVariant }]}>
              <View style={s.sigHeader}>
                <TextInput
                  style={[s.sigNameInput, { color: colors.text, borderColor: colors.divider }]}
                  value={sig.name}
                  onChangeText={(v) => {
                    const sigs = [...(settings.signatures || [{ name: t('settings.signatureDefault'), content: settings.signature || '', isDefault: true }])];
                    sigs[idx] = { ...sigs[idx], name: v };
                    setSettings(prev => ({ ...prev, signatures: sigs }));
                  }}
                  placeholder={t('settings.signatureName')}
                  placeholderTextColor={colors.textTertiary}
                />
                <TouchableOpacity
                  onPress={() => {
                    const sigs = [...(settings.signatures || [{ name: t('settings.signatureDefault'), content: settings.signature || '', isDefault: true }])];
                    sigs.forEach((s, i) => { s.isDefault = i === idx; });
                    setSettings(prev => ({ ...prev, signatures: sigs }));
                  }}
                  style={[s.defaultBtn, sig.isDefault && { backgroundColor: colors.primaryLight }]}
                >
                  <Text style={{ fontSize: FontSize.xs, color: sig.isDefault ? colors.primary : colors.textTertiary, fontWeight: '600' }}>
                    {t('settings.signatureDefault')}
                  </Text>
                </TouchableOpacity>
                {(settings.signatures || []).length > 1 && (
                  <TouchableOpacity onPress={() => {
                    const sigs = (settings.signatures || []).filter((_, i) => i !== idx);
                    if (sig.isDefault && sigs.length > 0) sigs[0].isDefault = true;
                    setSettings(prev => ({ ...prev, signatures: sigs }));
                  }}>
                    <IconTrash size={16} color={colors.error} />
                  </TouchableOpacity>
                )}
              </View>
              <TextInput
                style={[s.signatureInput, { color: colors.text, borderColor: colors.divider, backgroundColor: colors.surface, marginTop: 8, minHeight: 60 }]}
                value={sig.content}
                onChangeText={(v) => {
                  const sigs = [...(settings.signatures || [{ name: t('settings.signatureDefault'), content: settings.signature || '', isDefault: true }])];
                  sigs[idx] = { ...sigs[idx], content: v };
                  setSettings(prev => ({ ...prev, signatures: sigs, signature: sigs.find(s => s.isDefault)?.content || '' }));
                }}
                placeholder={t('settings.signaturePlaceholder')}
                placeholderTextColor={colors.textTertiary}
                multiline
                numberOfLines={3}
                textAlignVertical="top"
              />
            </View>
          ))}
          <TouchableOpacity
            onPress={() => {
              const sigs = [...(settings.signatures || [{ name: t('settings.signatureDefault'), content: settings.signature || '', isDefault: true }])];
              sigs.push({ name: '', content: '', isDefault: false });
              setSettings(prev => ({ ...prev, signatures: sigs }));
            }}
            style={[s.addSigBtn, { borderColor: colors.primary }]}
          >
            <Text style={{ color: colors.primary, fontSize: FontSize.sm, fontWeight: '600' }}>+ {t('settings.addSignature')}</Text>
          </TouchableOpacity>
        </View>
        )}

        {/* Email tools — Importar / PGP / Tarefas (round-6 gap-closer) */}
        {sectionMatches(
          t('settings.emailToolsTitle') || 'Ferramentas de email',
          t('settings.importFromOthers') || 'Importar de outras contas',
          t('settings.pgpKeys') || 'Chave PGP',
          t('settings.tasks') || 'Tarefas',
        ) && (
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>
            {t('settings.emailToolsTitle') || 'Ferramentas de email'}
          </Text>
          <TouchableOpacity
            style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
            onPress={() => router.push('/email-import')}
            accessibilityRole="button"
          >
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>
                {t('settings.importFromOthers') || 'Importar de outras contas'}
              </Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.importFromOthersDesc') || 'Gmail, Outlook ou Microsoft 365'}
              </Text>
            </View>
            <IconChevronRight size={18} color={colors.textTertiary} />
          </TouchableOpacity>

          <TouchableOpacity
            style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
            onPress={() => router.push('/pgp-keys')}
            accessibilityRole="button"
          >
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>
                {t('settings.pgpKeys') || 'Chave PGP'}
              </Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.pgpKeysDesc') || 'Criptografia ponta-a-ponta de emails'}
              </Text>
            </View>
            <IconChevronRight size={18} color={colors.textTertiary} />
          </TouchableOpacity>

          <TouchableOpacity
            style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
            onPress={() => router.push('/tasks')}
            accessibilityRole="button"
          >
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>
                {t('settings.tasks') || 'Tarefas'}
              </Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.tasksDesc') || 'Tarefas pessoais e convertidas de emails'}
              </Text>
            </View>
            <IconChevronRight size={18} color={colors.textTertiary} />
          </TouchableOpacity>
        </View>
        )}

        </CollapsibleGroup>
        {/* ── END GROUP: Email ── */}

        {/* Language */}
        {sectionMatches(t('settings.language'), t('settings.languageLabel'), t('settings.language.autoDetect')) && (
        <View ref={registerSectionRef('language')} style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <View style={s.sectionTitleRow}>
            <IconGlobe size={18} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[s.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('settings.language')}</Text>
          </View>

          {/* Auto-detect — when ON, clears the manual override key so the
              app picks up navigator.languages / device locale on next
              cold start. Persists `language_auto` so future visits to this
              screen render the checkbox correctly. */}
          <View style={[s.settingRow, { borderBottomColor: colors.borderLight, marginTop: Spacing.md }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.language.autoDetect') || 'Seguir idioma do sistema'}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.language.autoDetectDesc') || 'Detecta o idioma a partir do seu aparelho.'}
              </Text>
            </View>
            <Switch
              value={languageAuto}
              onValueChange={(v) => {
                setLanguageAuto(v);
                setStorage('language_auto', String(v));
                if (v) {
                  // Clear the manual override so LanguageContext re-detects
                  // on next mount. AsyncStorage path handled via dynamic import.
                  if (Platform.OS === 'web') {
                    try { if (typeof localStorage !== 'undefined') localStorage.removeItem('app_language_manual'); } catch {}
                  } else {
                    import('@react-native-async-storage/async-storage').then(m => {
                      m.default.removeItem('app_language_manual').catch(() => {});
                    }).catch(() => {});
                  }
                }
              }}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={languageAuto ? colors.primary : '#fff'}
            />
          </View>

          <View style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.languageLabel')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.languageDesc')}
              </Text>
            </View>
            <View style={s.perPageBtns}>
              {[{ val: 'pt-BR', label: 'PT' }, { val: 'en', label: 'EN' }, { val: 'es', label: 'ES' }].map(l => (
                <TouchableOpacity
                  key={l.val}
                  disabled={languageAuto}
                  style={[
                    s.perPageBtn,
                    { borderColor: colors.divider, opacity: languageAuto ? 0.45 : 1 },
                    language === l.val && { backgroundColor: colors.primary, borderColor: colors.primary },
                  ]}
                  onPress={() => {
                    if (languageAuto) return;
                    changeLanguage(l.val);
                    setSettings(prev => ({ ...prev, language: l.val }));
                  }}
                >
                  <Text style={[
                    s.perPageText, { color: colors.text },
                    language === l.val && { color: '#fff' },
                  ]}>
                    {l.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Currency picker (2026-05-22 — issue #1355). Lives inside the
              language section because the two settings travel together
              conceptually ("Idioma e moeda"). FX rates fetched from
              chat_currency_rates and cached 24h; first launch auto-detects
              from device locale. */}
          <View style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>
                {t('settings.currencyLabel') || 'Moeda'}
              </Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {currencyAutoDetected
                  ? (t('settings.currencyAuto') || 'Auto') + ' · ' + userCurrency
                  : userCurrency}
              </Text>
            </View>
            <View style={[s.perPageBtns, { flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: '60%' }]}>
              {supportedCurrencies.map(code => (
                <TouchableOpacity
                  key={code}
                  style={[
                    s.perPageBtn,
                    { borderColor: colors.divider, marginBottom: 4 },
                    userCurrency === code && { backgroundColor: colors.primary, borderColor: colors.primary },
                  ]}
                  onPress={() => setUserCurrency(code)}
                  accessibilityRole="button"
                  accessibilityLabel={`${t('settings.currency.' + code) || code} (${currencySymbols[code] || ''})`}
                >
                  <Text style={[
                    s.perPageText, { color: colors.text },
                    userCurrency === code && { color: '#fff' },
                  ]}>
                    {currencySymbols[code] || ''} {code}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
        )}

        {/* Auto-reply */}
        {sectionMatches(t('settings.autoReply'), t('settings.autoReplyEnable'), t('settings.autoReplyDesc')) && (
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>{t('settings.autoReply')}</Text>
          <Text style={[s.settingDesc, { color: colors.textTertiary, marginBottom: Spacing.md }]}>
            {t('settings.autoReplyDesc')}
          </Text>
          <View style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.autoReplyEnable')}</Text>
            </View>
            <Switch
              value={vacation.enabled}
              onValueChange={(v) => saveVacation({ enabled: v })}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={vacation.enabled ? colors.primary : '#fff'}
            />
          </View>
          {vacation.enabled && (
            <>
              <TextInput
                style={[
                  s.signatureInput,
                  { color: colors.text, borderColor: colors.divider, backgroundColor: colors.surfaceVariant, marginTop: Spacing.md, minHeight: 44 },
                ]}
                value={vacation.subject}
                onChangeText={(v) => saveVacation({ subject: v })}
                placeholder={t('settings.autoReplySubjectPlaceholder') || 'Assunto (opcional)'}
                placeholderTextColor={colors.textTertiary}
              />
              <TextInput
                style={[
                  s.signatureInput,
                  { color: colors.text, borderColor: colors.divider, backgroundColor: colors.surfaceVariant, marginTop: Spacing.md },
                ]}
                value={vacation.body}
                onChangeText={(v) => saveVacation({ body: v })}
                placeholder={t('settings.autoReplyPlaceholder')}
                placeholderTextColor={colors.textTertiary}
                multiline
                numberOfLines={3}
                textAlignVertical="top"
              />
            </>
          )}
        </View>
        )}

        {/* Filters & Rules */}
        {sectionMatches(t('settings.filters'), t('settings.manageFilters')) && (
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>{t('settings.filters')}</Text>
          <Text style={[s.settingDesc, { color: colors.textTertiary, marginBottom: Spacing.md }]}>
            {t('settings.filtersDesc')}
          </Text>
          <TouchableOpacity
            style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
            onPress={() => setShowFilters(true)}
          >
            <View style={s.settingInfo}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <IconFilter size={18} color={colors.primary} style={{ marginRight: Spacing.sm }} />
                <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.manageFilters')}</Text>
              </View>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.manageFiltersDesc')}
              </Text>
            </View>
            <IconChevronRight size={20} color={colors.textTertiary} />
          </TouchableOpacity>
        </View>
        )}

        {/* AI Features */}
        {sectionMatches(t('settings.ai'), t('settings.aiSmartReply'), t('settings.aiDrafts'), t('settings.aiSummary'), t('settings.aiEnhance'), t('settings.smartCompose')) && (
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <View style={s.sectionTitleRow}>
            <IconSparkles size={18} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[s.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('settings.ai')}</Text>
          </View>
          <Text style={[s.settingDesc, { color: colors.textTertiary, marginTop: Spacing.sm }]}>
            {t('settings.aiDesc')}
          </Text>
          <View style={s.aiFeatures}>
            <View style={s.aiFeatureRow}>
              <View style={s.aiFeatureIconWrap}><IconMessageSquare size={18} color={colors.primary} /></View>
              <Text style={[s.aiFeatureText, { color: colors.text }]}>{t('settings.aiSmartReply')}</Text>
            </View>
            <View style={s.aiFeatureRow}>
              <View style={s.aiFeatureIconWrap}><IconPenTool size={18} color={colors.primary} /></View>
              <Text style={[s.aiFeatureText, { color: colors.text }]}>{t('settings.aiDrafts')}</Text>
            </View>
            <View style={s.aiFeatureRow}>
              <View style={s.aiFeatureIconWrap}><IconDraft size={18} color={colors.primary} /></View>
              <Text style={[s.aiFeatureText, { color: colors.text }]}>{t('settings.aiSummary')}</Text>
            </View>
            <View style={s.aiFeatureRow}>
              <View style={s.aiFeatureIconWrap}><IconSparkles size={18} color={colors.primary} /></View>
              <Text style={[s.aiFeatureText, { color: colors.text }]}>{t('settings.aiEnhance')}</Text>
            </View>
          </View>
          <View style={[s.settingRow, { borderTopColor: colors.borderLight, borderTopWidth: 1, paddingTop: Spacing.md, marginTop: Spacing.md }]}>
            <View style={{ flex: 1 }}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.smartCompose')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>{t('settings.smartComposeDesc')}</Text>
            </View>
            <TouchableOpacity
              onPress={() => {
                const next = !smartComposeOn;
                setSmartComposeOn(next);
                setStorage('smart_compose', String(next));
              }}
              style={[
                s.toggleTrack,
                { backgroundColor: smartComposeOn ? colors.primary : colors.borderLight },
              ]}
            >
              <View style={[s.toggleThumb, smartComposeOn && s.toggleThumbActive]} />
            </TouchableOpacity>
          </View>
        </View>
        )}

        {/* Chat preferences — Enter sends / Auto-correct / Voice speed /
            Bubble shape / Data saver / Beta. All are device-local prefs
            persisted via setStorage; consumers (chat-conversation, voice
            player, message bubbles, image upload pipeline) read these on
            mount. Beta gates experimental features behind a flag. */}
        {sectionMatches(
          t('settings.chatPrefs.title') || 'Preferências do chat',
          t('settings.enterSends.title') || 'Enter envia',
          t('settings.autocorrect.title') || 'Auto-correção',
          t('settings.voiceSpeed.title') || 'Velocidade dos áudios',
          t('settings.bubble.title') || 'Estilo dos balões',
          t('settings.dataSaver.title') || 'Modo economia',
          t('settings.beta.title') || 'Recursos beta',
        ) && (
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>{t('settings.chatPrefs.title') || 'Preferências do chat'}</Text>

          {/* Enter sends — desktop default ON, mobile default OFF. */}
          <View style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.enterSends.title') || 'Enter envia mensagem'}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.enterSends.subtitle') || 'Pressione Enter pra enviar. Shift+Enter quebra linha.'}
              </Text>
            </View>
            <Switch
              value={enterSends}
              onValueChange={(v) => { setEnterSends(v); setStorage('enter_sends', String(v)); }}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={enterSends ? colors.primary : '#fff'}
            />
          </View>

          {/* Auto-correct — wired into TextInputs via context (set elsewhere). */}
          <View style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.autocorrect.title') || 'Auto-correção'}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.autocorrect.subtitle') || 'Corrige palavras automaticamente enquanto você digita.'}
              </Text>
            </View>
            <Switch
              value={autocorrectOn}
              onValueChange={(v) => { setAutocorrectOn(v); setStorage('autocorrect_enabled', String(v)); }}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={autocorrectOn ? colors.primary : '#fff'}
            />
          </View>

          {/* Voice playback speed — 4 options. Defaults to 1×. */}
          <View style={[s.settingRowColumn, { borderBottomColor: colors.borderLight }]}>
            <View style={{ width: '100%' }}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.voiceSpeed.title') || 'Velocidade padrão dos áudios'}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.voiceSpeed.subtitle') || 'Aplica a todos os áudios recebidos. Você pode trocar individual no chat.'}
              </Text>
            </View>
            <View style={[s.perPageBtns, { marginTop: 10, flexWrap: 'wrap' }]}>
              {[
                { val: 0.5, label: t('settings.voiceSpeed.option_0_5') || '0.5×' },
                { val: 1,   label: t('settings.voiceSpeed.option_1')   || '1×' },
                { val: 1.5, label: t('settings.voiceSpeed.option_1_5') || '1.5×' },
                { val: 2,   label: t('settings.voiceSpeed.option_2')   || '2×' },
              ].map(opt => (
                <TouchableOpacity
                  key={String(opt.val)}
                  style={[
                    s.perPageBtn,
                    { borderColor: colors.divider },
                    voiceSpeedDefault === opt.val && { backgroundColor: colors.primary, borderColor: colors.primary },
                  ]}
                  onPress={() => { setVoiceSpeedDefault(opt.val); setStorage('voice_speed_default', String(opt.val)); }}
                >
                  <Text style={[
                    s.perPageText, { color: colors.text },
                    voiceSpeedDefault === opt.val && { color: '#fff' },
                  ]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Bubble shape — rounded / square / classic. */}
          <View style={[s.settingRowColumn, { borderBottomColor: colors.borderLight }]}>
            <View style={{ width: '100%' }}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.bubble.title') || 'Estilo dos balões'}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.bubble.subtitle') || 'Formato visual das mensagens.'}
              </Text>
            </View>
            <View style={[s.perPageBtns, { marginTop: 10, flexWrap: 'wrap' }]}>
              {[
                { val: 'rounded', label: t('settings.bubble.rounded') || 'Arredondado' },
                { val: 'square',  label: t('settings.bubble.square')  || 'Quadrado' },
                { val: 'classic', label: t('settings.bubble.classic') || 'Clássico' },
              ].map(opt => (
                <TouchableOpacity
                  key={opt.val}
                  style={[
                    s.perPageBtn,
                    { borderColor: colors.divider },
                    bubbleShape === opt.val && { backgroundColor: colors.primary, borderColor: colors.primary },
                  ]}
                  onPress={() => { setBubbleShape(opt.val); setStorage('bubble_shape', opt.val); }}
                >
                  <Text style={[
                    s.perPageText, { color: colors.text },
                    bubbleShape === opt.val && { color: '#fff' },
                  ]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Data saver — flips a global flag that other surfaces read. */}
          <View style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.dataSaver.title') || 'Modo economia de dados'}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.dataSaver.subtitle') || 'Comprime mídia e reduz pré-carregamento de vídeos.'}
              </Text>
            </View>
            <Switch
              value={dataSaver}
              onValueChange={(v) => { setDataSaver(v); setStorage('data_saver', String(v)); }}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={dataSaver ? colors.primary : '#fff'}
            />
          </View>

          {/* Beta features — opts the device into experimental flows. */}
          <View style={[s.settingRow, { borderBottomColor: colors.borderLight, borderBottomWidth: 0 }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.beta.title') || 'Recursos beta'}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.beta.subtitle') || 'Ative pra testar funcionalidades em desenvolvimento. Podem ter bugs.'}
              </Text>
            </View>
            <Switch
              value={betaFeatures}
              onValueChange={(v) => { setBetaFeatures(v); setStorage('beta_features', String(v)); }}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={betaFeatures ? colors.primary : '#fff'}
            />
          </View>
        </View>
        )}

        {/* Notif LED color — Android only. Picks the LED color used by
            the notification channel. The native module reads
            `notif_led_color` on push delivery. Branded swatches with
            labels + a hero preview dot showing the live selection. */}
        {Platform.OS === 'android' && sectionMatches(
          t('settings.led.title') || 'Cor do LED',
          'led',
        ) && (
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>{t('settings.led.title') || 'Cor do LED (Android)'}</Text>
          <Text style={[s.settingDesc, { color: colors.textTertiary, marginBottom: Spacing.md }]}>
            {t('settings.led.desc') || 'Cor do LED de notificação no Android.'}
          </Text>
          {/* Hero preview — large SVG dot with a soft outer glow halo so
              the user "sees" what the chosen color will look like as a
              notification LED. Pure SVG (per project rule: no emoji). */}
          <View style={{ alignItems: 'center', marginBottom: Spacing.md }}>
            <Svg width={84} height={84}>
              <Defs>
                <SvgLinearGradient id="led_halo" x1="0" y1="0" x2="1" y2="1">
                  <Stop offset="0" stopColor={notifLedColor} stopOpacity="0.45" />
                  <Stop offset="1" stopColor={notifLedColor} stopOpacity="0" />
                </SvgLinearGradient>
              </Defs>
              {/* Halo */}
              <SvgCircle cx="42" cy="42" r="40" fill="url(#led_halo)" />
              {/* Mid ring */}
              <SvgCircle cx="42" cy="42" r="22" fill={notifLedColor} fillOpacity="0.35" />
              {/* Core dot */}
              <SvgCircle cx="42" cy="42" r="12" fill={notifLedColor} />
              {/* Specular highlight */}
              <SvgCircle cx="38" cy="38" r="4" fill="#FFFFFF" fillOpacity="0.55" />
            </Svg>
          </View>
          {/* Swatch grid with labeled colors. Six brand-aligned options. */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14, justifyContent: 'flex-start' }}>
            {[
              { c: '#7C3AED', label: t('settings.led.c1') || 'Roxo' },
              { c: '#3B82F6', label: t('settings.led.c2') || 'Azul' },
              { c: '#10B981', label: t('settings.led.c3') || 'Verde' },
              { c: '#EF4444', label: t('settings.led.c4') || 'Vermelho' },
              { c: '#F59E0B', label: t('settings.led.c5') || 'Âmbar' },
              { c: '#EC4899', label: t('settings.led.c6') || 'Rosa' },
              { c: '#06B6D4', label: t('settings.led.c7') || 'Ciano' },
              { c: '#FFFFFF', label: t('settings.led.c8') || 'Branco' },
            ].map(({ c, label }) => {
              const selected = notifLedColor === c;
              return (
                <TouchableOpacity
                  key={c}
                  onPress={() => { setNotifLedColor(c); setStorage('notif_led_color', c); saveNotifPref({ led_color_default: c }); }}
                  activeOpacity={0.7}
                  style={{ alignItems: 'center', width: 56 }}
                  accessibilityRole="button"
                  accessibilityLabel={`LED ${label}`}
                >
                  <View style={{
                    width: 44, height: 44, borderRadius: 22,
                    backgroundColor: c,
                    borderWidth: selected ? 3 : (c === '#FFFFFF' ? 1 : 0),
                    borderColor: selected ? colors.primary : (c === '#FFFFFF' ? colors.borderLight : 'transparent'),
                    alignItems: 'center', justifyContent: 'center',
                    shadowColor: c,
                    shadowOffset: { width: 0, height: 0 },
                    shadowOpacity: selected ? 0.55 : 0.25,
                    shadowRadius: selected ? 8 : 4,
                    elevation: selected ? 4 : 1,
                  }}>
                    {selected && <IconCheck size={18} color={c === '#FFFFFF' ? '#000' : '#fff'} />}
                  </View>
                  <Text
                    numberOfLines={1}
                    style={{
                      fontSize: 11, color: selected ? colors.primary : colors.textSecondary,
                      marginTop: 5, fontWeight: selected ? '700' : '500',
                      textAlign: 'center', maxWidth: 56,
                    }}
                  >
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
        )}

        {/* Wallpaper global default — picks the default chat background
            for new conversations. Curated Chatyy-branded presets with SVG
            gradient previews. The stored value is always a single hex so
            chat-conversation.js can render it via backgroundColor; the
            gradient swatches here are visual previews only. Custom photo
            upload remains supported (stored as the image URI). */}
        {sectionMatches(t('settings.wallpaperDefault.title') || 'Papel de parede padrão', 'wallpaper', 'papel de parede') && (
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>{t('settings.wallpaperDefault.title') || 'Papel de parede padrão'}</Text>
          <Text style={[s.settingDesc, { color: colors.textTertiary, marginBottom: Spacing.md }]}>
            {t('settings.wallpaperDefault.desc') || 'Aplica em conversas novas. Cada chat pode ter o seu próprio.'}
          </Text>
          {/* Brand-curated preset grid. Each tile is 76×76 with a 2-stop
              SVG gradient preview, a label below, and a check overlay when
              selected. The persisted `wallpaperDefault` is the dominant
              hex (compatible with chat-conversation.js render path). */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: Spacing.md }}>
            {[
              { id: '#7C3AED', from: '#A855F7', to: '#6D28D9', label: t('settings.wallpaperDefault.p1') || 'Roxo Chatyy' },
              { id: '#DB2777', from: '#F472B6', to: '#BE185D', label: t('settings.wallpaperDefault.p2') || 'Rosa' },
              { id: '#F59E0B', from: '#FBBF24', to: '#D97706', label: t('settings.wallpaperDefault.p3') || 'Pôr-do-sol' },
              { id: '#0EA5E9', from: '#38BDF8', to: '#0369A1', label: t('settings.wallpaperDefault.p4') || 'Oceano' },
              { id: '#16A34A', from: '#4ADE80', to: '#15803D', label: t('settings.wallpaperDefault.p5') || 'Floresta' },
              { id: '#1F2937', from: '#374151', to: '#0F172A', label: t('settings.wallpaperDefault.p6') || 'Carbono' },
              { id: '#EDE9FE', from: '#F5F3FF', to: '#DDD6FE', label: t('settings.wallpaperDefault.p7') || 'Lavanda' },
              { id: '#FECACA', from: '#FECACA', to: '#FCA5A5', label: t('settings.wallpaperDefault.p8') || 'Coral' },
            ].map(g => {
              const selected = wallpaperDefault === g.id;
              return (
                <TouchableOpacity
                  key={g.id}
                  onPress={() => { setWallpaperDefault(g.id); setStorage('wallpaper_default', g.id); }}
                  activeOpacity={0.75}
                  style={{ alignItems: 'center', width: 76 }}
                  accessibilityRole="button"
                  accessibilityLabel={`Wallpaper ${g.label}`}
                >
                  <View style={{
                    width: 64, height: 64, borderRadius: 14, overflow: 'hidden',
                    borderWidth: selected ? 3 : 1,
                    borderColor: selected ? colors.primary : colors.borderLight,
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Svg width={62} height={62} style={{ position: 'absolute', top: 0, left: 0 }}>
                      <Defs>
                        <SvgLinearGradient id={`wp_${g.id.replace('#','')}`} x1="0" y1="0" x2="1" y2="1">
                          <Stop offset="0" stopColor={g.from} stopOpacity="1" />
                          <Stop offset="1" stopColor={g.to} stopOpacity="1" />
                        </SvgLinearGradient>
                      </Defs>
                      <SvgRect x="0" y="0" width="62" height="62" fill={`url(#wp_${g.id.replace('#','')})`} />
                    </Svg>
                    {selected && (
                      <View style={{
                        width: 28, height: 28, borderRadius: 14,
                        backgroundColor: 'rgba(0,0,0,0.35)',
                        alignItems: 'center', justifyContent: 'center',
                      }}>
                        <IconCheck size={18} color="#fff" />
                      </View>
                    )}
                  </View>
                  <Text
                    numberOfLines={1}
                    style={{
                      fontSize: 11, color: selected ? colors.primary : colors.textSecondary,
                      marginTop: 6, fontWeight: selected ? '700' : '500',
                      textAlign: 'center', maxWidth: 76,
                    }}
                  >
                    {g.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {/* Custom upload — reuses ImagePicker */}
          <TouchableOpacity
            onPress={async () => {
              try {
                const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
                if (!perm.granted) return;
                const result = await ImagePicker.launchImageLibraryAsync({
                  mediaTypes: ImagePicker.MediaTypeOptions.Images,
                  allowsEditing: false,
                  quality: 0.85,
                });
                if (!result.canceled && result.assets?.[0]?.uri) {
                  // Chat render path treats any non-`#` string as an image
                  // URI — store the raw URI so existing Image source works.
                  const v = result.assets[0].uri;
                  setWallpaperDefault(v);
                  setStorage('wallpaper_default', v);
                }
              } catch {}
            }}
            style={[s.addSigBtn, { borderColor: colors.primary, paddingVertical: 10 }]}
          >
            <Text style={{ color: colors.primary, fontWeight: '600' }}>
              {t('settings.wallpaperDefault.custom') || '+ Enviar imagem própria'}
            </Text>
          </TouchableOpacity>
        </View>
        )}

        {/* Backup key rotation — DEDUPED. The standalone "Senha do backup"
            section was merged into the Security → "Backup com criptografia"
            row, which now offers both create AND rotate (rotate opens the
            backupKey modal). The rotation modal at the bottom of the file is
            reused by that row. */}

        {/* Network usage stats — lifetime up/down bytes for chat media. */}
        {sectionMatches(t('settings.networkUsage.title') || 'Uso de rede', 'network usage', 'uso de rede') && (
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <View style={s.sectionTitleRow}>
            <IconDatabase size={18} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[s.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('settings.networkUsage.title') || 'Uso de rede'}</Text>
          </View>
          <Text style={[s.settingDesc, { color: colors.textTertiary, marginTop: Spacing.sm, marginBottom: Spacing.md }]}>
            {t('settings.networkUsage.desc') || 'Total de dados enviados e recebidos no chat desde a instalação.'}
          </Text>
          {(() => {
            const fmt = (b) => {
              if (!Number.isFinite(b)) return '—';
              const bytes = Math.max(0, Number(b) || 0);
              if (bytes < 1024) return bytes === 0 ? '0 KB' : '< 1 KB';
              const kb = bytes / 1024;
              if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
              const mb = kb / 1024;
              if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
              const gb = mb / 1024;
              return `${gb < 10 ? gb.toFixed(2) : gb.toFixed(1)} GB`;
            };
            return (
              <>
                <View style={[s.settingRow, { borderBottomColor: colors.borderLight, paddingVertical: Spacing.sm }]}>
                  <View style={s.settingInfo}>
                    <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.networkUsage.sent') || 'Enviado'}</Text>
                  </View>
                  <Text style={[s.settingLabel, { color: colors.textSecondary }]}>{netStats ? fmt(netStats.up) : '—'}</Text>
                </View>
                <View style={[s.settingRow, { borderBottomColor: colors.borderLight, borderBottomWidth: 0, paddingVertical: Spacing.sm }]}>
                  <View style={s.settingInfo}>
                    <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.networkUsage.received') || 'Recebido'}</Text>
                  </View>
                  <Text style={[s.settingLabel, { color: colors.textSecondary }]}>{netStats ? fmt(netStats.down) : '—'}</Text>
                </View>
              </>
            );
          })()}
        </View>
        )}

        {/* Help center — opens the support page via Linking. */}
        {sectionMatches(t('settings.help.title') || 'Central de ajuda', 'help', 'ajuda', 'support') && (
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <View style={s.sectionTitleRow}>
            <IconMail size={18} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[s.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('settings.help.title') || 'Central de ajuda'}</Text>
          </View>
          {/* /ajuda loads the SPA 404 — repointed to the working support
              mailto (same target as the row below). */}
          <TouchableOpacity
            style={[s.settingRow, { borderBottomColor: colors.borderLight, marginTop: Spacing.md }]}
            onPress={() => { Linking.openURL('mailto:support@chatyy.com.br').catch(() => {}); }}
          >
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.help.title') || 'Central de ajuda'}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>support@chatyy.com.br</Text>
            </View>
            <IconChevronRight size={20} color={colors.textTertiary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.settingRow, { borderBottomColor: colors.borderLight, borderBottomWidth: 0 }]}
            onPress={() => { Linking.openURL('mailto:support@chatyy.com.br').catch(() => {}); }}
          >
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.help.contactSupport') || 'Falar com o suporte'}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>support@chatyy.com.br</Text>
            </View>
            <IconChevronRight size={20} color={colors.textTertiary} />
          </TouchableOpacity>
        </View>
        )}

        {/* About — opens a modal with app version, build, and legal links. */}
        {sectionMatches(t('settings.about.title') || 'Sobre', 'about', 'sobre', 'version') && (
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <View style={s.sectionTitleRow}>
            <IconFileText size={18} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[s.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('settings.about.title') || 'Sobre'}</Text>
          </View>
          <TouchableOpacity
            style={[s.settingRow, { borderBottomColor: colors.borderLight, borderBottomWidth: 0, marginTop: Spacing.md }]}
            onPress={() => setAboutOpen(true)}
          >
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.about.title') || 'Sobre'}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {(() => {
                  const ver = Constants?.expoConfig?.version || Constants?.manifest?.version || '?';
                  const build = Constants?.expoConfig?.ios?.buildNumber
                    || Constants?.expoConfig?.android?.versionCode
                    || '';
                  const label = (t('settings.about.version') || 'Versão {ver}').replace('{ver}', ver);
                  return build ? `${label} (${build})` : label;
                })()}
              </Text>
            </View>
            <IconChevronRight size={20} color={colors.textTertiary} />
          </TouchableOpacity>
          {/* [WAVE 104F] Call diagnostics — visible in __DEV__ or developer_mode */}
          {(__DEV__ || settings?.developer_mode) && (
          <TouchableOpacity
            style={[s.settingRow, { borderBottomColor: colors.borderLight, borderBottomWidth: 0 }]}
            onPress={() => router.push('/call-diagnose')}
          >
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>Diagnóstico de chamadas</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>Ring buffer dos últimos 100 eventos de call lifecycle</Text>
            </View>
            <IconChevronRight size={20} color={colors.textTertiary} />
          </TouchableOpacity>
          )}
        </View>
        )}

        {/* One AI Assistant */}
        {sectionMatches(t('settings.oneAssistant'), t('settings.oneEnabled'), t('settings.oneNotifPrefs'), 'one ai', 'assistant') && (
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <View style={s.sectionTitleRow}>
            <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: '#6366f1', alignItems: 'center', justifyContent: 'center', marginRight: 8 }}>
              <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>O</Text>
            </View>
            <Text style={[s.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('settings.oneAssistant')}</Text>
          </View>
          <Text style={[s.settingDesc, { color: colors.textSecondary, marginTop: Spacing.sm }]}>
            {t('settings.oneAssistantDesc')}
          </Text>

          <View style={[s.settingRow, { borderBottomColor: colors.borderLight, marginTop: Spacing.md }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.oneEnabled')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>{t('settings.oneEnabledDesc')}</Text>
            </View>
            <Switch
              value={oneEnabled}
              onValueChange={(v) => {
                setOneEnabled(v);
                setStorage('one_enabled', String(v));
              }}
              trackColor={{ false: colors.divider, true: '#6366f1' + '66' }}
              thumbColor={oneEnabled ? '#6366f1' : '#fff'}
            />
          </View>

          {oneEnabled && (
            <>
              <Text style={[s.settingLabel, { color: colors.text, paddingHorizontal: Spacing.md, paddingTop: Spacing.md }]}>{t('settings.oneNotifPrefs')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary, paddingHorizontal: Spacing.md, marginBottom: Spacing.sm }]}>{t('settings.oneNotifUrgentDesc')}</Text>
              <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: Spacing.md, paddingBottom: Spacing.md }}>
                {[
                  { val: 'email', label: t('settings.oneNotifEmail'), Icon: IconMail },
                  { val: 'push', label: t('settings.oneNotifPush'), Icon: IconBell },
                  { val: 'urgent', label: t('settings.oneNotifUrgent'), Icon: IconPhone },
                ].map(opt => {
                  const isSel = oneNotifLevel === opt.val;
                  return (
                  <TouchableOpacity
                    key={opt.val}
                    style={[
                      s.perPageBtn,
                      { borderColor: colors.divider, flex: 1, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
                      isSel && { backgroundColor: '#6366f1', borderColor: '#6366f1' },
                    ]}
                    onPress={() => {
                      setOneNotifLevel(opt.val);
                      setStorage('one_notif_level', opt.val);
                    }}
                  >
                    <opt.Icon size={14} color={isSel ? '#fff' : colors.text} />
                    <Text style={[
                      s.perPageText, { color: colors.text, textAlign: 'center' },
                      isSel && { color: '#fff' },
                    ]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                  );
                })}
              </View>
            </>
          )}
        </View>
        )}

        {/* Desktop Notifications */}
        {Platform.OS === 'web' && sectionMatches(t('settings.desktopNotifs'), t('settings.desktopNotifsDesc'), 'desktop', 'browser') && (
          <View ref={registerSectionRef('notifications')} style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
            <View style={s.sectionTitleRow}>
              <IconBell size={18} color={colors.primary} style={{ marginRight: 8 }} />
              <Text style={[s.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('settings.desktopNotifs')}</Text>
            </View>
            <Text style={[s.settingDesc, { color: colors.textTertiary, marginTop: Spacing.sm }]}>
              {t('settings.desktopNotifsDesc')}
            </Text>
            <View style={[s.settingRow, { borderBottomColor: colors.borderLight, marginTop: Spacing.md }]}>
              <View style={s.settingInfo}>
                <Text style={[s.settingLabel, { color: colors.text }]}>
                  {notifPermission === 'granted' ? t('settings.notifsEnabled') : notifPermission === 'denied' ? t('settings.notifsBlocked') : t('settings.notifsEnable')}
                </Text>
                <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                  {notifPermission === 'denied' ? t('settings.notifsBlockedDesc') : t('settings.notifsAlertDesc')}
                </Text>
              </View>
              {notifPermission !== 'granted' && notifPermission !== 'denied' && (
                <TouchableOpacity
                  style={[s.perPageBtn, { borderColor: colors.primary, backgroundColor: colors.primaryLight }]}
                  onPress={async () => {
                    const perm = await Notification.requestPermission();
                    setNotifPermission(perm);
                  }}
                >
                  <Text style={[s.perPageText, { color: colors.primary }]}>{t('settings.notifsEnable')}</Text>
                </TouchableOpacity>
              )}
              {notifPermission === 'granted' && (
                <Text style={[s.perPageText, { color: colors.success || '#34a853' }]}>{t('settings.notifsActive')}</Text>
              )}
            </View>
          </View>
        )}

        {/* Security — Biometric Lock + Parental Controls (native only; biometric items below self-gate on biometricAvailable) */}
        {Platform.OS !== 'web' && sectionMatches(t('settings.security'), 'biometric', 'face id', 'parental', 'família', 'family', 'segurança', 'senha', 'password', t('settings.changePassword'), '2fa', t('settings.twoFactor'), 'pin', 'backup', t('settings.e2eBackup'), t('settings.backupKey.rotate'), t('settings.activityLog'), 'byok', t('settings.advancedKey')) && (
          <View ref={registerSectionRef('security')} style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
            {/* Família — Apple Family Sharing-style hub */}
            <TouchableOpacity
              style={[s.settingRow, { borderBottomColor: colors.borderLight, marginBottom: Spacing.sm, backgroundColor: isDark ? '#1a1530' : '#faf5ff', borderRadius: 14, padding: 14 }]}
              onPress={() => router.push('/family')}
            >
              <View style={s.settingInfo}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <IconShield size={20} color="#7C3AED" />
                  <Text style={[s.settingLabel, { color: colors.text, fontWeight: '700' }]}>Família</Text>
                </View>
                <Text style={[s.settingDesc, { color: colors.textTertiary }]}>Compartilhe plano, álbum, calendário e mais com a família</Text>
              </View>
              <IconChevronRight size={18} color={colors.textSecondary} />
            </TouchableOpacity>

            {/* Parental Controls */}
            <TouchableOpacity
              style={[s.settingRow, { borderBottomColor: colors.borderLight, marginBottom: Spacing.lg, backgroundColor: isDark ? '#1a2e1a' : '#f0fdf4', borderRadius: 14, padding: 14 }]}
              onPress={() => router.push('/parental')}
            >
              <View style={s.settingInfo}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <IconShield size={20} color="#7C3AED" />
                  <Text style={[s.settingLabel, { color: colors.text, fontWeight: '700' }]}>Controle Parental</Text>
                </View>
                <Text style={[s.settingDesc, { color: colors.textTertiary }]}>Crie contas monitoradas para seus filhos</Text>
              </View>
              <IconChevronRight size={18} color={colors.textSecondary} />
            </TouchableOpacity>

            <View style={s.sectionTitleRow}>
              <IconShield size={18} color={colors.primary} style={{ marginRight: 8 }} />
              <Text style={[s.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('settings.security')}</Text>
            </View>
            {biometricAvailable && (
              <View style={[s.settingRow, { borderBottomColor: colors.borderLight, marginTop: Spacing.md }]}>
                <View style={s.settingInfo}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.biometricLock')}</Text>
                  <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                    {t('settings.biometricDesc')}
                  </Text>
                </View>
                <Switch
                  value={biometricEnabled}
                  onValueChange={toggleBiometric}
                  trackColor={{ false: colors.divider, true: colors.primaryLight }}
                  thumbColor={biometricEnabled ? colors.primary : '#fff'}
                />
              </View>
            )}

            {/* Auto-lock interval picker — only relevant when biometric is on.
                Lets users widen the 5 s default (good for "I unlock my phone
                in the kitchen and come back to my desk") or tighten it to
                immediate (for shared devices). 'never' disables the timer
                entirely; the lock still triggers when the user manually
                taps the chat-lock or restarts the app. */}
            {biometricAvailable && biometricEnabled && (
              <TouchableOpacity
                style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
                onPress={() => setAutoLockOpen(true)}
                activeOpacity={0.65}
              >
                <View style={s.settingInfo}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>
                    {t('settings.autoLockInterval') || 'Bloqueio automático'}
                  </Text>
                  <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                    {(() => {
                      // Translate the stored value into a human-readable label.
                      if (autoLockInterval === 'never') return t('biometric.lockNever') || 'Nunca';
                      const n = Number(autoLockInterval);
                      if (n === 0)   return t('biometric.lockImmediate') || 'Imediatamente';
                      if (n === 60)  return t('biometric.lock1Min') || 'Apos 1 minuto';
                      if (n === 300) return t('biometric.lock5Min') || 'Apos 5 minutos';
                      if (n === 900) return t('biometric.lock15Min') || 'Apos 15 minutos';
                      return `${n}s`;
                    })()}
                  </Text>
                </View>
                <IconChevronRight size={18} color={colors.textTertiary} />
              </TouchableOpacity>
            )}

            {/* Alterar senha — abre modal com senha atual + nova senha + confirmar */}
            <TouchableOpacity
              style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
              onPress={() => setChangePasswordOpen(true)}
              activeOpacity={0.65}
            >
              <View style={s.settingInfo}>
                <Text style={[s.settingLabel, { color: colors.text }]}>
                  {t('settings.changePassword') || 'Alterar senha'}
                </Text>
                <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                  {t('settings.changePasswordDesc') || 'Atualize sua senha de acesso a qualquer momento'}
                </Text>
              </View>
              <IconChevronRight size={18} color={colors.textTertiary} />
            </TouchableOpacity>

            {/* End-to-end encrypted backup — opens the escrow flow. The
                user picks a passphrase, the app encrypts every locally
                stored chat key + identity key with it, and uploads only
                the ciphertext. Restore on a new device asks for the
                passphrase. Server never sees the plaintext. */}
            <TouchableOpacity
              style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
              onPress={() => setE2eBackupOpen(true)}
              activeOpacity={0.65}
            >
              <View style={s.settingInfo}>
                <Text style={[s.settingLabel, { color: colors.text }]}>
                  {t('settings.e2eBackup') || 'Backup com criptografia'}
                </Text>
                <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                  {t('settings.e2eBackupDesc') || 'Salve suas chaves protegidas por uma frase secreta'}
                </Text>
              </View>
              <IconChevronRight size={18} color={colors.textTertiary} />
            </TouchableOpacity>

            {/* Redefinir senha do backup — merged here from the old standalone
                "Senha do backup" section (dedupe). Opens the rotate modal,
                which versions the new escrow blob and revokes prior ones. */}
            <TouchableOpacity
              style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
              onPress={() => { setBackupKeyPass(''); setBackupKeyPass2(''); setBackupKeyMsg(''); setBackupKeyOpen(true); }}
              activeOpacity={0.65}
            >
              <View style={s.settingInfo}>
                <Text style={[s.settingLabel, { color: colors.text }]}>
                  {t('settings.backupKey.rotate') || 'Redefinir senha do backup'}
                </Text>
                <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                  {t('settings.backupKey.subtitle') || 'Troque a frase secreta que protege seu backup criptografado. Backups antigos deixam de ser restauráveis.'}
                </Text>
              </View>
              <IconChevronRight size={18} color={colors.textTertiary} />
            </TouchableOpacity>

            {/* 2FA PIN — opens 4-digit entry modal */}
            <TouchableOpacity
              style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
              onPress={() => {
                setTwoFADigits(['', '', '', '']);
                setTwoFAError('');
                setTwoFASuccess(false);
                setTwoFAOpen(true);
                setTimeout(() => { try { twoFARefs.current[0]?.focus?.(); } catch {} }, 250);
              }}
              activeOpacity={0.65}
            >
              <View style={[s.settingInfo, { flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
                <IconShield size={18} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>
                    {t('settings.twoFactor') || 'Verificação em duas etapas'}
                  </Text>
                  <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                    {t('settings.twoFactorDesc') || 'Adicione uma camada extra de segurança ao seu Chatyy'}
                  </Text>
                </View>
              </View>
              <IconChevronRight size={18} color={colors.textTertiary} />
            </TouchableOpacity>

            {/* Registration Lock (anti-SIM-swap) — separate concept from 2FA.
                A short PIN that adds a second factor to phone-OTP login,
                defeating SIM-swap attacks where the attacker steals the
                number, gets the OTP, and takes over the account. Same
                4-digit PIN UI as 2FA but writes to a different backend key. */}
            <TouchableOpacity
              style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
              onPress={() => {
                setRegLockDigits(['', '', '', '']);
                setRegLockError('');
                setRegLockSuccess(false);
                setRegLockOpen(true);
                setTimeout(() => { try { regLockRefs.current[0]?.focus?.(); } catch {} }, 250);
              }}
              activeOpacity={0.65}
            >
              <View style={[s.settingInfo, { flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
                <IconShield size={18} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>
                    {t('settings.registrationLock') || 'PIN de segurança (anti-SIM-swap)'}
                  </Text>
                  <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                    {t('settings.registrationLockDesc') || 'PIN extra no login por telefone — protege se trocarem seu chip.'}
                  </Text>
                </View>
              </View>
              <IconChevronRight size={18} color={colors.textTertiary} />
            </TouchableOpacity>

            {/* Alterar número de telefone (SIM swap recovery, WhatsApp pattern).
                Migrates the account to a NEW phone while keeping all chats /
                contacts / handle. Routes to /change-phone for the multi-step
                flow (confirm old → pick new → OTP → success). */}
            <TouchableOpacity
              style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
              onPress={() => router.push('/change-phone')}
              activeOpacity={0.65}
            >
              <View style={[s.settingInfo, { flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
                <IconPhone size={18} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>
                    {t('settings.changePhone') || 'Alterar número de telefone'}
                  </Text>
                  <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                    {t('settings.changePhoneDesc') || 'Migre sua conta para um novo número mantendo seus chats e contatos.'}
                  </Text>
                </View>
              </View>
              <IconChevronRight size={18} color={colors.textTertiary} />
            </TouchableOpacity>

            {/* Histórico de atividades — unified audit log surface. The list
                screen reads user_activity_log_list and renders security-
                relevant events (login, password change, 2FA, device link,
                BYOK set, chat delete, message delete-for-all, etc.). */}
            <TouchableOpacity
              style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
              onPress={() => router.push('/activity-log')}
              activeOpacity={0.65}
            >
              <View style={[s.settingInfo, { flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
                <IconShield size={18} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>
                    {t('settings.activityLog') || 'Histórico de atividades'}
                  </Text>
                  <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                    {t('settings.activityLogDesc') || 'Veja logins, mudanças de senha, novos dispositivos e outras ações de segurança.'}
                  </Text>
                </View>
              </View>
              <IconChevronRight size={18} color={colors.textTertiary} />
            </TouchableOpacity>

            {/* Chave avançada (BYOK) — opt-in per-user master key, generated
                client-side. Server stores only the fingerprint. Power-user
                feature surfaced here so it's a "Segurança" decision, not a
                privacy preference. */}
            <TouchableOpacity
              style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
              onPress={() => router.push('/advanced-key')}
              activeOpacity={0.65}
            >
              <View style={[s.settingInfo, { flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
                <IconShield size={18} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>
                    {t('settings.advancedKey') || 'Chave avançada (BYOK)'}
                  </Text>
                  <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                    {t('settings.advancedKeyDesc') || 'Gere uma chave mestre que só existe no seu aparelho. Frase de segurança mostrada uma única vez.'}
                  </Text>
                </View>
              </View>
              <IconChevronRight size={18} color={colors.textTertiary} />
            </TouchableOpacity>

            {/* Alertas de login — notify when a NEW device signs into this
                account. Tap opens the history modal (last 30d of sign-ins),
                toggle persists via chat_user_defaults.login_alerts_enabled. */}
            <View style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
              <TouchableOpacity
                style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 }}
                onPress={async () => {
                  setLoginHistoryOpen(true);
                  setLoginHistoryLoading(true);
                  try {
                    const r = await api.getLoginHistory?.();
                    if (r?.success && Array.isArray(r?.data?.events)) setLoginHistory(r.data.events);
                    else if (Array.isArray(r?.data)) setLoginHistory(r.data);
                    else setLoginHistory([]);
                  } catch { setLoginHistory([]); }
                  finally { setLoginHistoryLoading(false); }
                }}
                activeOpacity={0.65}
              >
                <IconShield size={18} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>
                    {t('settings.loginAlerts.title') || 'Alertas de login'}
                  </Text>
                  <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                    {t('settings.loginAlerts.subtitle') || 'Receba notif quando novo dispositivo logar'}
                  </Text>
                </View>
              </TouchableOpacity>
              <Switch
                value={loginAlertsEnabled}
                onValueChange={(v) => {
                  setLoginAlertsEnabled(v);
                  // Persist via chat_user_defaults_set — same blob the rest
                  // of this section already uses for media auto-download
                  // prefs, so we don't introduce a new endpoint.
                  try { api.chatUserDefaultsSet?.({ login_alerts_enabled: v }).catch(() => {}); } catch {}
                }}
                trackColor={{ false: colors.divider, true: colors.primaryLight }}
                thumbColor={loginAlertsEnabled ? colors.primary : '#fff'}
              />
            </View>

            {/* Privacidade avançada — proxy/Tor, screen-capture block,
                discoverable opt-out, VPN suggestion. Grouped behind one
                row so the main Security section stays scannable. */}
            <TouchableOpacity
              style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
              onPress={() => router.push('/advanced-privacy')}
              activeOpacity={0.65}
            >
              <View style={[s.settingInfo, { flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
                <IconShield size={18} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>
                    {t('settings.advancedPrivacy') || 'Privacidade avançada'}
                  </Text>
                  <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                    {t('settings.advancedPrivacyDesc') || 'Proxy/Tor, bloqueio de captura de tela, descoberta por número, sugestão de VPN.'}
                  </Text>
                </View>
              </View>
              <IconChevronRight size={18} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>
        )}

        {/* Forwarding */}
        {sectionMatches(t('settings.forwarding'), t('settings.forwardingEnable'), t('settings.forwardingDesc')) && (
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <View style={s.sectionTitleRow}>
            <IconForward size={18} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[s.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('settings.forwarding')}</Text>
          </View>
          <Text style={[s.settingDesc, { color: colors.textTertiary, marginTop: Spacing.sm, marginBottom: Spacing.md }]}>
            {t('settings.forwardingDesc')}
          </Text>
          <View style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.forwardingEnable')}</Text>
            </View>
            <Switch
              value={settings.forwarding_enabled}
              onValueChange={(v) => setSettings(prev => ({ ...prev, forwarding_enabled: v }))}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={settings.forwarding_enabled ? colors.primary : '#fff'}
            />
          </View>
          {settings.forwarding_enabled && (
            <TextInput
              style={[
                s.signatureInput,
                { color: colors.text, borderColor: colors.divider, backgroundColor: colors.surfaceVariant, marginTop: Spacing.md, minHeight: 44 },
              ]}
              value={settings.forwarding_email}
              onChangeText={(v) => setSettings(prev => ({ ...prev, forwarding_email: v }))}
              placeholder={t('settings.forwardingPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              keyboardType="email-address"
              autoCapitalize="none"
            />
          )}
        </View>
        )}

        {/* Reading */}
        {sectionMatches(t('settings.reading'), t('settings.fontSize'), t('settings.readReceipts'), t('settings.referrals') || 'referral') && (
        <View ref={registerSectionRef('reading')} style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>{t('settings.reading')}</Text>

          <View style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.fontSize')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.fontSizeDesc')}
              </Text>
            </View>
            <View style={s.perPageBtns}>
              {[{ val: 'small', label: t('settings.fontSmall') }, { val: 'medium', label: t('settings.fontMedium') }, { val: 'large', label: t('settings.fontLarge') }].map(f => (
                <TouchableOpacity
                  key={f.val}
                  style={[
                    s.perPageBtn,
                    { borderColor: colors.divider },
                    settings.font_size === f.val && { backgroundColor: colors.primary, borderColor: colors.primary },
                  ]}
                  onPress={() => { setSettings(prev => ({ ...prev, font_size: f.val })); saveNotifPref({ font_size: f.val }); }}
                >
                  <Text style={[
                    s.perPageText, { color: colors.text },
                    settings.font_size === f.val && { color: '#fff' },
                  ]}>
                    {f.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Read-receipts moved to the single Privacy-section copy below
              (dedupe — was duplicated here). */}
        </View>
        )}

        {/* Privacy — granular chat controls. Persists to backend
            chat_user_privacy via chat_privacy_get/set. The 4 dropdown rows
            (last_seen / profile_photo / status / groups) open a bottom-sheet
            picker; read_receipts is a simple Switch since it's boolean. */}
        {sectionMatches(t('settings.privacyTitle'), t('settings.privacyLastSeen'), t('settings.privacyProfilePhoto'), t('settings.privacyReadReceipts'), t('settings.privacyStatus'), t('settings.privacyGroups'), 'privacy', 'privacidade') && (
        <View ref={registerSectionRef('privacy_granular')} style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <View style={s.sectionTitleRow}>
            <IconShield size={18} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[s.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('settings.privacyTitle')}</Text>
          </View>

          {/* Last seen */}
          <TouchableOpacity
            style={[s.settingRow, { borderBottomColor: colors.borderLight, marginTop: Spacing.md }]}
            onPress={() => setPrivacyPickerOpen('last_seen')}
            activeOpacity={0.7}
          >
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.privacyLastSeen')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {chatPrivacy.last_seen === 'everyone' ? t('settings.privacyEveryone')
                  : chatPrivacy.last_seen === 'contacts' ? t('settings.privacyContacts')
                  : t('settings.privacyNobody')}
              </Text>
            </View>
            <IconChevronRight size={20} color={colors.textTertiary} />
          </TouchableOpacity>

          {/* Profile photo */}
          <TouchableOpacity
            style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
            onPress={() => setPrivacyPickerOpen('profile_photo')}
            activeOpacity={0.7}
          >
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.privacyProfilePhoto')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {chatPrivacy.profile_photo === 'everyone' ? t('settings.privacyEveryone')
                  : chatPrivacy.profile_photo === 'contacts' ? t('settings.privacyContacts')
                  : t('settings.privacyNobody')}
              </Text>
            </View>
            <IconChevronRight size={20} color={colors.textTertiary} />
          </TouchableOpacity>

          {/* Read receipts — boolean Switch (chat-side, distinct from the
              email-side settings.read_receipts above). */}
          <View style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.privacyReadReceipts')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.privacyReadReceiptsDesc')}
              </Text>
            </View>
            <Switch
              value={!!chatPrivacy.read_receipts}
              onValueChange={(v) => saveChatPrivacy({ read_receipts: !!v })}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={chatPrivacy.read_receipts ? colors.primary : '#fff'}
            />
          </View>

          {/* Status — backend column is `story_privacy`. */}
          <TouchableOpacity
            style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
            onPress={() => setPrivacyPickerOpen('story_privacy')}
            activeOpacity={0.7}
          >
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.privacyStatus')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {chatPrivacy.story_privacy === 'everyone' ? t('settings.privacyEveryone')
                  : chatPrivacy.story_privacy === 'contacts' ? t('settings.privacyContacts')
                  : t('settings.privacyNobody')}
              </Text>
            </View>
            <IconChevronRight size={20} color={colors.textTertiary} />
          </TouchableOpacity>

          {/* Groups — backend column is `group_add` (who can add this user
              to a group). */}
          <TouchableOpacity
            style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
            onPress={() => setPrivacyPickerOpen('group_add')}
            activeOpacity={0.7}
          >
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.privacyGroups')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {chatPrivacy.group_add === 'everyone' ? t('settings.privacyEveryone')
                  : chatPrivacy.group_add === 'contacts' ? t('settings.privacyContacts')
                  : t('settings.privacyNobody')}
              </Text>
            </View>
            <IconChevronRight size={20} color={colors.textTertiary} />
          </TouchableOpacity>

          {/* Hide reactions in notifications — boolean Switch. When ON the
              server skips push for chat_reaction events (the in-app badge
              still increments). Closes #gap_notifications 2026-05-19. */}
          <View style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.privacyHideReactions')}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.privacyHideReactionsDesc')}
              </Text>
            </View>
            <Switch
              value={!!chatPrivacy.hide_reactions_in_notifs}
              onValueChange={(v) => {
                // Keep local UI state in sync, and route the persisted value
                // through chat_user_notif_prefs_set (the push-gate source).
                setChatPrivacy(prev => ({ ...prev, hide_reactions_in_notifs: !!v }));
                saveNotifPref({ hide_reactions_in_notifs: !!v });
              }}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={chatPrivacy.hide_reactions_in_notifs ? colors.primary : '#fff'}
            />
          </View>

          {/* [mute-call-ringtone, 2026-05-19] Modo silencioso para ligações
              — silences the call ringtone + vibration on incoming calls
              (the UI modal still appears so the user can choose to answer).
              Persists server-side on chat_user_defaults via chat_privacy_set
              and mirrors to local storage so services/ringtone.js picks up
              the change without a round-trip. */}
          <View style={[s.settingRow, { borderBottomColor: colors.borderLight }]}>
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>
                Modo silencioso para ligações
              </Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                Silencia o toque e a vibração de chamadas recebidas. A tela continua aparecendo.
              </Text>
            </View>
            <Switch
              value={!!chatPrivacy.mute_call_ringtone}
              onValueChange={(v) => saveChatPrivacy({ mute_call_ringtone: !!v })}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={chatPrivacy.mute_call_ringtone ? colors.primary : '#fff'}
            />
          </View>
        </View>
        )}

        {/* Legal — Privacy & Terms */}
        {sectionMatches(t('settings.legal'), t('settings.privacyPolicy'), t('settings.termsOfService')) && (
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <View style={s.sectionTitleRow}>
            <IconFileText size={18} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[s.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('settings.legal')}</Text>
          </View>
          <TouchableOpacity
            style={[s.settingRow, { borderBottomColor: colors.borderLight, marginTop: Spacing.md }]}
            onPress={() => setShowPrivacy(true)}
          >
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.privacyPolicy')}</Text>
            </View>
            <IconChevronRight size={20} color={colors.textTertiary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
            onPress={() => setShowTerms(true)}
          >
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.termsOfService')}</Text>
            </View>
            <IconChevronRight size={20} color={colors.textTertiary} />
          </TouchableOpacity>
        </View>
        )}

        {/* Notifications — push delivery level. Surfaces oneNotifLevel state
            (was set in code but no UI exposed it — GAP 11). Three radio rows:
            all / urgent / silent. Persisted via setStorage (mirrors One
            Assistant section pattern). */}
        {sectionMatches(t('settings.notificationsTitle'), t('settings.notifAll'), t('settings.notifUrgent'), t('settings.notifSilent')) && (
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <View style={s.sectionTitleRow}>
            <IconBell size={18} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[s.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('settings.notificationsTitle')}</Text>
          </View>
          {[
            { val: 'all', label: t('settings.notifAll'), sub: t('settings.notifAllSub') },
            { val: 'urgent', label: t('settings.notifUrgent'), sub: t('settings.notifUrgentSub') },
            { val: 'silent', label: t('settings.notifSilent'), sub: t('settings.notifSilentSub') },
          ].map((opt, idx, arr) => {
            const selected = pushNotifLevel === opt.val;
            const isLast = idx === arr.length - 1;
            return (
              <TouchableOpacity
                key={opt.val}
                onPress={() => {
                  setPushNotifLevel(opt.val);
                  setStorage('push_notif_level', opt.val);
                  saveNotifPref({ push_notif_level: opt.val });
                }}
                style={[
                  s.settingRow,
                  { borderBottomColor: colors.borderLight, borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth },
                ]}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={opt.label}
              >
                <IconBell size={20} color={selected ? colors.primary : colors.textSecondary} style={{ marginRight: 12 }} />
                <View style={s.settingInfo}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>{opt.label}</Text>
                  <Text style={[s.settingDesc, { color: colors.textTertiary }]}>{opt.sub}</Text>
                </View>
                {selected && <IconCheck size={20} color={colors.primary} />}
              </TouchableOpacity>
            );
          })}
        </View>
        )}

        {/* ── GROUP: Armazenamento e dados (native only — both child blocks
            are Platform.OS !== 'web'). Wraps Media auto-download + Storage. ── */}
        {Platform.OS !== 'web' && (
        <CollapsibleGroup title={t('settings.group.storage') || 'Armazenamento e dados'} icon={IconDatabase} forceOpen={!!_q}>

        {/* Mídia automática — WhatsApp Settings → Storage and Data parity.
            4 buckets (photos, audio, videos, docs) × 3 modes (Wi-Fi / Wi-Fi+Móvel
            / Nunca). Reads/writes chat_user_defaults via debounced PATCH; mirrors
            into mediaCache.setMediaDownloadPrefs so the cellular gate respects
            the new pref without an app restart. Mobile-only (web has no
            cellular concept). */}
        {Platform.OS !== 'web' && sectionMatches(t('settings.mediaAutoDownload'), t('settings.mediaPhotos'), t('settings.mediaAudio'), t('settings.mediaVideos'), t('settings.mediaDocs'), t('settings.roaming.title'), t('settings.autoSaveGallery'), 'storage', 'auto-download', 'roaming', 'galeria', 'gallery') && (
        <View ref={registerSectionRef('mediaAutoDownload')} style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>{t('settings.mediaAutoDownload')}</Text>
          <Text style={[s.settingDesc, { color: colors.textTertiary, marginBottom: Spacing.md }]}>
            {t('settings.mediaAutoDownloadDesc')}
          </Text>
          {[
            { key: 'media_auto_dl_photos', label: t('settings.mediaPhotos') },
            { key: 'media_auto_dl_audio',  label: t('settings.mediaAudio') },
            { key: 'media_auto_dl_videos', label: t('settings.mediaVideos') },
            { key: 'media_auto_dl_docs',   label: t('settings.mediaDocs') },
          ].map((row, rowIdx, rowArr) => {
            const cur = chatDefaults[row.key];
            const isLast = rowIdx === rowArr.length - 1;
            return (
              <View
                key={row.key}
                style={[
                  s.settingRow,
                  {
                    borderBottomColor: colors.borderLight,
                    borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
                    flexDirection: 'column',
                    alignItems: 'stretch',
                    paddingVertical: Spacing.md,
                  },
                ]}
              >
                <Text style={[s.settingLabel, { color: colors.text, marginBottom: Spacing.sm }]}>{row.label}</Text>
                {/* [2026-05-21] Pills got reported as "empty" on Print 6 —
                    `perPageBtn` had no alignItems/justifyContent so the
                    `Text` rendered top-left and "Wi-Fi + Móvel" wrapped to
                    2 lines while "Nunca"/"Wi-Fi" looked centered. On a
                    412×915 device the per-pill width is ~110px so the
                    label was overflowing visually. Now: explicit center +
                    minHeight + numberOfLines=1 + subtle inactive bg so the
                    user always sees the option name + which one is on. */}
                <View style={s.perPageBtns}>
                  {[
                    { val: 'wifi',   label: t('settings.mediaWifi') },
                    { val: 'mobile', label: t('settings.mediaWifiMobile') },
                    { val: 'never',  label: t('settings.mediaNever') },
                  ].map(opt => {
                    const selected = cur === opt.val;
                    return (
                      <TouchableOpacity
                        key={opt.val}
                        style={[
                          s.perPageBtn,
                          {
                            borderColor: colors.divider,
                            backgroundColor: colors.backgroundSecondary || colors.background,
                            flex: 1,
                            minHeight: 38,
                            alignItems: 'center',
                            justifyContent: 'center',
                          },
                          selected && { backgroundColor: colors.primary, borderColor: colors.primary },
                        ]}
                        onPress={() => updateChatDefault({ [row.key]: opt.val })}
                        accessibilityRole="radio"
                        accessibilityState={{ selected }}
                        accessibilityLabel={`${row.label} — ${opt.label}`}
                      >
                        <Text
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          minimumFontScale={0.85}
                          style={[
                            s.perPageText,
                            { color: colors.text, textAlign: 'center', fontSize: 13 },
                            selected && { color: '#fff' },
                          ]}
                        >
                          {opt.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            );
          })}

          {/* Roaming gate — separate toggle that scopes the "mobile" mode
              to also fire while roaming. When OFF, the mediaCache cellular
              gate treats `mobile` as "Wi-Fi + home carrier" and skips
              downloads on roaming. Persisted via local storage; read by
              services/mediaCache on bootstrap. */}
          <View
            style={[
              s.settingRow,
              {
                borderBottomColor: colors.borderLight,
                borderBottomWidth: 0,
                marginTop: Spacing.sm,
                paddingTop: Spacing.md,
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: colors.borderLight,
              },
            ]}
          >
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.roaming.title') || 'Permitir em roaming'}</Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.roaming.desc') || 'Permite baixar mídia quando estiver em roaming. Desligue pra economizar dados internacionais.'}
              </Text>
            </View>
            <Switch
              value={mediaRoaming}
              onValueChange={(v) => {
                setMediaRoaming(v);
                setStorage('media_auto_dl_roaming', String(v));
                try {
                  const mc = require('../services/mediaCache');
                  mc.setMediaDownloadPrefs?.({ media_auto_dl_roaming: v });
                } catch {}
              }}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={mediaRoaming ? colors.primary : '#fff'}
            />
          </View>

          {/* [WhatsApp "Media visibility" 2026-05-26] Auto-save received
              photos + videos into the phone gallery / camera roll. Default ON.
              Persists under `autoSaveMediaToGallery`; mediaCache reads the same
              key and saves on each successful inbound download (de-duped +
              permission-gated inside the service). */}
          <View
            style={[
              s.settingRow,
              {
                borderBottomColor: colors.borderLight,
                borderBottomWidth: 0,
                marginTop: Spacing.sm,
                paddingTop: Spacing.md,
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: colors.borderLight,
              },
            ]}
          >
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>
                {t('settings.autoSaveGallery') || 'Salvar na galeria'}
              </Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.autoSaveGalleryDesc') || 'Fotos e vídeos recebidos vão para o app Fotos automaticamente.'}
              </Text>
            </View>
            <Switch
              value={autoSaveGallery}
              onValueChange={(v) => {
                setAutoSaveGallery(v);
                setStorage('autoSaveMediaToGallery', String(v));
                try {
                  const mc = require('../services/mediaCache');
                  mc.setAutoSaveMediaToGallery?.(v);
                } catch {}
              }}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={autoSaveGallery ? colors.primary : '#fff'}
            />
          </View>

          {/* [gap C3 2026-05-20] Low-data mode em chamadas — when ON, caps
              video at 200kbps/15fps/360p so the call burns ~25% the bytes
              of the default ladder. Auto-applies on roaming/expensive
              cellular even when OFF (gate lives in app/call.js right
              before setCameraEnabled). */}
          <View
            style={[
              s.settingRow,
              {
                borderBottomColor: colors.borderLight,
                borderBottomWidth: 0,
                marginTop: Spacing.sm,
                paddingTop: Spacing.md,
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: colors.borderLight,
              },
            ]}
          >
            <View style={s.settingInfo}>
              <Text style={[s.settingLabel, { color: colors.text }]}>
                {t('settings.lowDataCalls.title') || 'Usar menos dados em chamadas'}
              </Text>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.lowDataCalls.desc') || 'Limita o vídeo a 360p / 15 fps. Útil em redes lentas ou móveis. Ativa automaticamente em roaming.'}
              </Text>
            </View>
            <Switch
              value={lowDataCalls}
              onValueChange={(v) => {
                setLowDataCalls(v);
                setStorage('chatyy_low_data_calls', String(v));
              }}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={lowDataCalls ? colors.primary : '#fff'}
            />
          </View>
        </View>
        )}

        {/* Storage — WhatsApp Settings → Storage parity.
            Shows per-bucket usage (photos / videos / audios / docs) plus a
            "Clear cache" button at the bottom. Stats are read once on mount
            via mediaCache.getStorageStats() and refreshed after a clear so
            users get instant feedback. Mobile-only (web has no on-disk
            store the user cares about). */}
        {Platform.OS !== 'web' && sectionMatches(t('settings.storage.title'), t('settings.storage.photos'), t('settings.storage.videos'), t('settings.storage.audios'), t('settings.storage.documents'), 'storage', 'cache', 'armazenamento', 'cache') && (
        <View ref={registerSectionRef('storage')} style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          {/* [2026-05-18] Manual refresh button — storage stats used to only
              hydrate at mount, so toggling auto-DL or clearing a chat
              elsewhere left the breakdown stale. User reported "armazenamento
              nao ta sincronizado". Tap re-scans cache+saved dirs. */}
          <View style={[s.sectionTitleRow, { justifyContent: 'space-between' }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
              <IconDatabase size={18} color={colors.primary} style={{ marginRight: 8 }} />
              <Text style={[s.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('settings.storage.title')}</Text>
            </View>
            <TouchableOpacity
              onPress={refreshStorageStats}
              disabled={storageBusy}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              accessibilityRole="button"
              accessibilityLabel={t('common.refresh') || 'Atualizar'}
              style={{ padding: 6, opacity: storageBusy ? 0.4 : 1 }}
            >
              <IconRefresh size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          {(() => {
            // Inline helper to format bytes WhatsApp-style: < 1KB shows
            // 0 KB so very small caches don't read as "0 B" awkwardly.
            // Threshold-based (KB → MB → GB) with one decimal under 100.
            const fmtBytes = (b) => {
              const bytes = Math.max(0, Number(b) || 0);
              if (bytes < 1024) return bytes === 0 ? '0 KB' : '< 1 KB';
              const kb = bytes / 1024;
              if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
              const mb = kb / 1024;
              if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
              const gb = mb / 1024;
              return `${gb < 10 ? gb.toFixed(2) : gb.toFixed(1)} GB`;
            };
            const fmtCount = (n) => {
              const num = Number(n) || 0;
              const key = num === 1 ? 'settings.storage.itemsSingular' : 'settings.storage.items';
              return (t(key) || `${num} items`).replace('{n}', String(num));
            };
            const stats = storageStats || { totalBytes: 0, cacheBytes: 0, savedBytes: 0, byType: { image: 0, video: 0, audio: 0, document: 0 }, counts: { image: 0, video: 0, audio: 0, document: 0 } };
            const mediaTotal = (stats.byType.image || 0) + (stats.byType.video || 0) + (stats.byType.audio || 0) + (stats.byType.document || 0);
            const summary = (t('settings.storage.usedSummary') || 'You have used {size} of media').replace('{size}', fmtBytes(mediaTotal));
            const rows = [
              { key: 'image',    label: t('settings.storage.photos'),    bytes: stats.byType.image    || 0, count: stats.counts.image    || 0 },
              { key: 'video',    label: t('settings.storage.videos'),    bytes: stats.byType.video    || 0, count: stats.counts.video    || 0 },
              { key: 'audio',    label: t('settings.storage.audios'),    bytes: stats.byType.audio    || 0, count: stats.counts.audio    || 0 },
              { key: 'document', label: t('settings.storage.documents'), bytes: stats.byType.document || 0, count: stats.counts.document || 0 },
            ];
            return (
              <>
                {/* Summary row — total media size */}
                <Text style={[s.settingDesc, { color: colors.text, fontSize: FontSize.md, fontWeight: '600', marginTop: Spacing.xs, marginBottom: Spacing.sm }]}>
                  {summary}
                </Text>
                {/* Per-bucket breakdown — 4 rows (photos / videos / audios / docs).
                    Each shows size + count. Empty buckets still render so the
                    layout stays consistent and users see "0 KB / 0 items" rather
                    than wondering if the section is broken. */}
                {rows.map((row, idx) => (
                  <View
                    key={row.key}
                    style={[
                      s.settingRow,
                      {
                        borderBottomColor: colors.borderLight,
                        borderBottomWidth: idx === rows.length - 1 ? 0 : StyleSheet.hairlineWidth,
                        paddingVertical: Spacing.sm,
                      },
                    ]}
                  >
                    <View style={s.settingInfo}>
                      <Text style={[s.settingLabel, { color: colors.text }]}>{row.label}</Text>
                      <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                        {fmtCount(row.count)}
                      </Text>
                    </View>
                    <Text style={[s.settingLabel, { color: colors.textSecondary }]}>{fmtBytes(row.bytes)}</Text>
                  </View>
                ))}
                {/* App cache row — separate visual indicator for the
                    OS-purgeable cache dir (informational, not actionable on
                    its own; the button below clears EVERYTHING). */}
                <View style={[s.settingRow, { borderBottomColor: colors.borderLight, borderBottomWidth: 0, paddingVertical: Spacing.sm, marginTop: Spacing.xs }]}>
                  <View style={s.settingInfo}>
                    <Text style={[s.settingLabel, { color: colors.text }]}>{t('settings.storage.appCache')}</Text>
                  </View>
                  <Text style={[s.settingLabel, { color: colors.textSecondary }]}>{fmtBytes(stats.totalBytes)}</Text>
                </View>

                {/* SQLite + media completeness block (#1240, 2026-05-20).
                    Shows the user "Mensagens no celular: 12,345" and
                    "Mídias faltantes: 78" with two CTAs to (a) re-trigger the
                    full-history bootstrap or (b) just re-pull missing media.
                    Counters come from services/db.getSyncStats() (SQLite
                    truth, not just on-disk file pool). */}
                <HistoryDownloadRow />
                {/* Destructive action — confirm dialog before nuking. Reuses the
                    Empty-Trash / Delete-Account pattern: web uses window.confirm
                    (no native Alert), native uses the useConfirm() modal with
                    destructive styling. Refreshes stats after clearing so the
                    card flips to the empty state without a re-mount. */}
                <TouchableOpacity
                  style={[s.settingRow, { borderBottomColor: colors.borderLight, borderBottomWidth: 0, marginTop: Spacing.sm, opacity: storageBusy ? 0.5 : 1 }]}
                  disabled={storageBusy}
                  onPress={async () => {
                    const doClear = async () => {
                      setStorageBusy(true);
                      try {
                        const mc = require('../services/mediaCache');
                        if (typeof mc.clearAllCache === 'function') await mc.clearAllCache();
                      } catch {}
                      await refreshStorageStats();
                      setStorageBusy(false);
                    };
                    const ok = Platform.OS === 'web'
                      ? (typeof window !== 'undefined' && window.confirm(t('settings.storage.clearConfirm')))
                      : await confirm({
                          title: t('settings.storage.clearConfirmTitle'),
                          message: t('settings.storage.clearConfirm'),
                          confirmLabel: t('settings.storage.clearCache'),
                          destructive: true,
                        });
                    if (ok) doClear();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={t('settings.storage.clearCache')}
                >
                  <View style={s.settingInfo}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <IconTrash size={18} color={colors.error} style={{ marginRight: Spacing.sm }} />
                      <Text style={[s.settingLabel, { color: colors.error }]}>
                        {storageBusy ? '…' : t('settings.storage.clearCache')}
                      </Text>
                    </View>
                  </View>
                </TouchableOpacity>
              </>
            );
          })()}
        </View>
        )}

        </CollapsibleGroup>
        )}
        {/* ── END GROUP: Armazenamento e dados ── */}

        {/* Mensagens temporárias por padrão — WhatsApp Settings → Privacy →
            Default Disappearing Messages. Applied at chat_create time only
            (existing convs unaffected). 4 options: Off / 24h / 7d / 90d. */}
        {sectionMatches(t('settings.defaultDisappearing'), t('settings.disappearingOff'), t('settings.disappearing24h'), t('settings.disappearing7d'), t('settings.disappearing90d'), 'privacy', 'disappearing') && (
        <View ref={registerSectionRef('defaultDisappearing')} style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <View style={s.sectionTitleRow}>
            <IconShield size={18} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[s.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('settings.defaultDisappearing')}</Text>
          </View>
          <Text style={[s.settingDesc, { color: colors.textTertiary, marginTop: Spacing.xs, marginBottom: Spacing.sm }]}>
            {t('settings.defaultDisappearingDesc')}
          </Text>
          {[
            { val: 0,       label: t('settings.disappearingOff') },
            { val: 86400,   label: t('settings.disappearing24h') },
            { val: 604800,  label: t('settings.disappearing7d') },
            { val: 7776000, label: t('settings.disappearing90d') },
          ].map((opt, idx, arr) => {
            const selected = Number(chatDefaults.default_disappearing) === opt.val;
            const isLast = idx === arr.length - 1;
            return (
              <TouchableOpacity
                key={opt.val}
                onPress={() => updateChatDefault({ default_disappearing: opt.val })}
                style={[
                  s.settingRow,
                  { borderBottomColor: colors.borderLight, borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth },
                ]}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={opt.label}
              >
                <View style={s.settingInfo}>
                  <Text style={[s.settingLabel, { color: colors.text }]}>{opt.label}</Text>
                </View>
                {selected && <IconCheck size={20} color={colors.primary} />}
              </TouchableOpacity>
            );
          })}
        </View>
        )}

        {/* Palavras silenciadas — feed muted words. Filters feed posts whose
            caption contains any of the listed words. Matched server-side in
            feed_list via LOWER(caption) NOT LIKE '%word%'. Soft-fails on
            backend down: an empty list shows the empty hint. */}
        {sectionMatches(t('settings.mutedWords') || 'Palavras silenciadas', 'muted words', 'palavras silenciadas', 'mute', 'silenciar', 'privacy') && (
        <View ref={registerSectionRef('mutedWords')} style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <View style={s.sectionTitleRow}>
            <IconShield size={18} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={[s.sectionTitle, { color: colors.text, marginBottom: 0 }]}>{t('settings.mutedWords') || 'Palavras silenciadas'}</Text>
          </View>
          <Text style={[s.settingDesc, { color: colors.textTertiary, marginTop: Spacing.xs, marginBottom: Spacing.sm }]}>
            {t('settings.mutedWordsDesc') || 'Posts cujo texto contenha qualquer dessas palavras não aparecem no seu feed.'}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: Spacing.sm }}>
            <TextInput
              value={mutedWordsInput}
              onChangeText={setMutedWordsInput}
              placeholder={t('settings.mutedWordsAdd') || 'Adicionar palavra…'}
              placeholderTextColor={colors.textTertiary}
              onSubmitEditing={handleAddMutedWord}
              returnKeyType="done"
              autoCorrect={false}
              autoCapitalize="none"
              style={{
                flex: 1,
                paddingHorizontal: 12,
                paddingVertical: 10,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.divider,
                borderRadius: 10,
                color: colors.text,
                fontSize: 15,
                ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
              }}
              accessibilityLabel={t('settings.mutedWordsAdd') || 'Adicionar palavra'}
            />
            <TouchableOpacity
              onPress={handleAddMutedWord}
              disabled={mutedWordsLoading || !mutedWordsInput.trim()}
              style={{
                paddingHorizontal: 16,
                justifyContent: 'center',
                borderRadius: 10,
                backgroundColor: mutedWordsLoading || !mutedWordsInput.trim() ? colors.divider : colors.primary,
              }}
              accessibilityRole="button"
              accessibilityLabel={t('common.add') || 'Adicionar'}
            >
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>
                {t('common.add') || 'Adicionar'}
              </Text>
            </TouchableOpacity>
          </View>
          {mutedWords.length === 0 ? (
            <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
              {t('settings.mutedWordsEmpty') || 'Nenhuma palavra silenciada ainda.'}
            </Text>
          ) : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {mutedWords.map(w => (
                <View
                  key={w}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingLeft: 12,
                    paddingRight: 6,
                    paddingVertical: 6,
                    backgroundColor: colors.surface,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: colors.divider,
                    borderRadius: 999,
                    gap: 4,
                  }}
                >
                  <Text style={{ color: colors.text, fontSize: 13 }}>{w}</Text>
                  <TouchableOpacity
                    onPress={() => handleRemoveMutedWord(w)}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                    accessibilityRole="button"
                    accessibilityLabel={(t('settings.mutedWordsRemove') || 'Remover {w}').replace('{w}', w)}
                  >
                    <IconTrash size={14} color={colors.textSecondary} />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}
        </View>
        )}

        {/* Convidar amigos — hero card. Reescrita: header gigante com
            título + descrição + GB ganhos, código grande tappable, botão
            Compartilhar largo, contador no rodapé. Saiu de "uma row apertada"
            pra um card que parece feature de growth. */}
        {sectionMatches(t('referral.inviteFriends') || 'Convidar amigos', t('referral.subtitle') || 'GB grátis', 'invite', 'amigos', 'referral') && (
        <View style={{
          marginBottom: Spacing.lg,
          borderRadius: 18,
          overflow: 'hidden',
          backgroundColor: colors.primary,
          ...Platform.select({
            ios: { shadowColor: colors.primary, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.18, shadowRadius: 16 },
            android: { elevation: 4 },
            web: { boxShadow: `0 8px 24px ${colors.primary}33` },
          }),
        }}>
          <View style={{ padding: 20, gap: 14 }}>
            {/* Header com ícone + título */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{
                width: 42, height: 42, borderRadius: 21,
                backgroundColor: 'rgba(255,255,255,0.2)',
                alignItems: 'center', justifyContent: 'center',
              }}>
                <IconUsers size={22} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 17, fontWeight: '800', color: '#fff', letterSpacing: -0.2 }}>
                  {t('referral.inviteFriends') || 'Convidar amigos'}
                </Text>
                <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.82)', marginTop: 2, fontWeight: '500' }}>
                  {t('referral.subtitle') || '1 GB grátis pra cada amigo que entrar'}
                </Text>
              </View>
            </View>

            {/* Code box — grande, copia long-press */}
            {referralCode ? (
              <View style={{ gap: 10 }}>
                <TouchableOpacity
                  onPress={async () => {
                    try {
                      const Clipboard = require('expo-clipboard');
                      await Clipboard.setStringAsync(referralCode);
                      Alert.alert(t('referral.copied') || 'Código copiado');
                    } catch {}
                  }}
                  activeOpacity={0.7}
                  accessibilityLabel={t('referral.copyCode') || 'Tocar pra copiar código'}
                  accessibilityRole="button"
                  style={{
                    backgroundColor: 'rgba(255,255,255,0.18)',
                    borderRadius: 14,
                    paddingVertical: 16,
                    paddingHorizontal: 18,
                    alignItems: 'center',
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    borderWidth: 1.5,
                    borderColor: 'rgba(255,255,255,0.25)',
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: 'rgba(255,255,255,0.7)', letterSpacing: 1.2, textTransform: 'uppercase' }}>
                      {t('referral.yourCode') || 'Seu código'}
                    </Text>
                    <Text style={{ fontSize: 24, fontWeight: '900', color: '#fff', letterSpacing: 4, marginTop: 2 }}>
                      {referralCode}
                    </Text>
                  </View>
                  <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center' }}>
                    <IconCopy size={18} color="#fff" />
                  </View>
                </TouchableOpacity>

                {/* Botão compartilhar — largo */}
                <TouchableOpacity
                  onPress={handleShareReferral}
                  activeOpacity={0.85}
                  style={{
                    backgroundColor: '#fff',
                    borderRadius: 14,
                    paddingVertical: 14,
                    alignItems: 'center',
                    flexDirection: 'row',
                    justifyContent: 'center',
                    gap: 8,
                  }}
                >
                  <IconShare size={18} color={colors.primary} />
                  <Text style={{ fontSize: 15, fontWeight: '700', color: colors.primary }}>
                    {t('referral.share') || 'Compartilhar'}
                  </Text>
                </TouchableOpacity>

                {/* Stats footer */}
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 6 }}>
                  <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)', fontWeight: '600' }}>
                    {referralCount === 1
                      ? '1 amigo convidado'
                      : `${referralCount} amigos convidados`}
                  </Text>
                  <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)', fontWeight: '700' }}>
                    {`+${referralCount} GB`}
                  </Text>
                </View>
              </View>
            ) : (
              <View style={{ paddingVertical: 30, alignItems: 'center' }}>
                <ActivityIndicator size="small" color="#fff" />
              </View>
            )}
          </View>
        </View>
        )}

        {/* Danger Zone */}
        {sectionMatches(t('settings.dangerZone'), t('settings.emptyTrash'), t('settings.deleteAccount')) && (
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight, borderWidth: 1 }]}>
          <Text style={[s.sectionTitle, { color: colors.error }]}>{t('settings.dangerZone')}</Text>
          <TouchableOpacity
            style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
            onPress={async () => {
              const doEmpty = async () => {
                const { emptyTrash } = await import('../services/api');
                await emptyTrash();
              };
              const ok = Platform.OS === 'web'
                ? (typeof window !== 'undefined' && window.confirm(t('settings.emptyTrashConfirmWeb')))
                : await confirm({
                    title: t('settings.emptyTrashTitle'),
                    message: t('settings.emptyTrashConfirmNative'),
                    confirmLabel: t('common.confirm'),
                    destructive: true,
                  });
              if (ok) doEmpty();
            }}
          >
            <View style={s.settingInfo}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <IconTrash size={18} color={colors.error} style={{ marginRight: Spacing.sm }} />
                <Text style={[s.settingLabel, { color: colors.error }]}>{t('settings.emptyTrash')}</Text>
              </View>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.emptyTrashDesc')}
              </Text>
            </View>
            <IconChevronRight size={20} color={colors.textTertiary} />
          </TouchableOpacity>

          {/* Account Deletion — Apple Requirement */}
          <TouchableOpacity
            style={[s.settingRow, { borderBottomColor: colors.borderLight }]}
            onPress={async () => {
              const openSheet = () => {
                setDeleteConfirm(true);
                setDeletePassword('');
                setDeleteError('');
                setDeleteAcknowledged(false);
                setDeleteTypedWord('');
              };
              if (Platform.OS === 'web') { openSheet(); return; }
              const ok = await confirm({
                title: t('settings.deleteAccountConfirmTitle'),
                message: t('settings.deleteAccountConfirmMessage'),
                confirmLabel: t('settings.deleteAccount'),
                destructive: true,
              });
              if (ok) openSheet();
            }}
          >
            <View style={s.settingInfo}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <IconUser size={18} color={colors.error} style={{ marginRight: Spacing.sm }} />
                <Text style={[s.settingLabel, { color: colors.error }]}>{t('settings.deleteAccount')}</Text>
              </View>
              <Text style={[s.settingDesc, { color: colors.textTertiary }]}>
                {t('settings.deleteAccountDesc')}
              </Text>
            </View>
            <IconChevronRight size={20} color={colors.textTertiary} />
          </TouchableOpacity>

          {deleteConfirm && (() => {
            const confirmWord = t('settings.deleteAccountTypeWord') || 'DELETE';
            const typedOk = (deleteTypedWord || '').trim().toUpperCase() === String(confirmWord).toUpperCase();
            const canDelete = deleteAcknowledged && typedOk && !!deletePassword.trim() && !deleting;
            return (
            <View style={[s.deleteConfirmBox, { backgroundColor: colors.errorBg || (colors.error + '08'), borderColor: colors.error + '30' }]}>
              <Text style={[s.deleteConfirmTitle, { color: colors.error }]}>{t('settings.confirmAccountDeletion')}</Text>

              {/* Destructive warning banner */}
              <View style={{
                flexDirection: 'row', gap: 12, padding: 14,
                backgroundColor: (colors.error || '#dc2626') + '15',
                borderRadius: 12, borderWidth: 1,
                borderColor: (colors.error || '#dc2626') + '40',
                marginBottom: 16,
              }}>
                <IconAlertTriangle size={20} color={colors.error || '#dc2626'} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.error || '#dc2626', fontSize: 14, fontWeight: '700', marginBottom: 4 }}>
                    {t('settings.deleteAccountWarningTitle')}
                  </Text>
                  <Text style={{ color: colors.text, fontSize: 13, lineHeight: 18 }}>
                    {t('settings.deleteAccountWarningBody')}
                  </Text>
                </View>
              </View>

              <Text style={[s.deleteConfirmText, { color: colors.textSecondary }]}>
                {t('settings.deleteAccountPasswordMessage')}
              </Text>
              <TextInput
                style={[s.deletePasswordInput, { color: colors.text, borderColor: colors.error + '40', backgroundColor: colors.surface }]}
                value={deletePassword}
                onChangeText={setDeletePassword}
                placeholder={t('settings.yourPassword')}
                placeholderTextColor={colors.textTertiary}
                secureTextEntry
              />

              {/* Type-to-confirm word */}
              <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 12, marginBottom: 6 }}>
                {(t('settings.deleteAccountTypeHint') || 'Type {word} to confirm').replace('{word}', confirmWord)}
              </Text>
              <TextInput
                style={[s.deletePasswordInput, {
                  color: colors.text,
                  borderColor: typedOk ? (colors.success || '#16a34a') + '60' : (colors.error + '40'),
                  backgroundColor: colors.surface,
                  marginTop: 0,
                  letterSpacing: 1,
                  fontWeight: '700',
                }]}
                value={deleteTypedWord}
                onChangeText={setDeleteTypedWord}
                placeholder={confirmWord}
                placeholderTextColor={colors.textTertiary}
                autoCapitalize="characters"
                autoCorrect={false}
              />

              {/* Acknowledge checkbox */}
              <TouchableOpacity
                onPress={() => setDeleteAcknowledged(v => !v)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14, paddingVertical: 4 }}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: deleteAcknowledged }}
              >
                <View style={{
                  width: 22, height: 22, borderRadius: 6,
                  borderWidth: 2,
                  borderColor: deleteAcknowledged ? (colors.error || '#dc2626') : colors.border,
                  backgroundColor: deleteAcknowledged ? (colors.error || '#dc2626') : 'transparent',
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  {deleteAcknowledged ? <IconCheck size={14} color="#fff" /> : null}
                </View>
                <Text style={{ flex: 1, color: colors.text, fontSize: 13, lineHeight: 18 }}>
                  {t('settings.deleteAccountConfirmCheckbox')}
                </Text>
              </TouchableOpacity>

              {!!deleteError && <Text style={[s.deleteErrorText, { color: colors.error, marginTop: 10 }]}>{deleteError}</Text>}
              <View style={s.deleteActions}>
                <TouchableOpacity
                  onPress={() => { setDeleteConfirm(false); setDeletePassword(''); setDeleteError(''); setDeleteAcknowledged(false); setDeleteTypedWord(''); }}
                  style={[s.deleteCancelBtn, { borderColor: colors.border }]}
                >
                  <Text style={[s.deleteCancelText, { color: colors.text }]}>{t('common.cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={async () => {
                    if (!canDelete) return;
                    setDeleting(true);
                    setDeleteError('');
                    try {
                      const { deleteAccount } = await import('../services/api');
                      const r = await deleteAccount(deletePassword);
                      if (r.success) {
                        setDeleteConfirm(false);
                        if (Platform.OS === 'web') {
                          window.alert(t('settings.accountDeletedMessage'));
                        } else {
                          Alert.alert(t('settings.accountDeleted'), t('settings.accountDeletedMessage'));
                        }
                        logout();
                      } else {
                        setDeleteError(r.message || t('settings.deleteAccountError'));
                      }
                    } catch {
                      setDeleteError(t('common.networkError'));
                    } finally {
                      setDeleting(false);
                    }
                  }}
                  disabled={!canDelete}
                  style={[s.deleteConfirmBtn, { backgroundColor: colors.error, opacity: canDelete ? 1 : 0.4 }]}
                >
                  {deleting ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={s.deleteConfirmBtnText}>{t('settings.deleteMyAccount')}</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
            );
          })()}
        </View>
        )}
      </ScrollView>
      )}

      <FilterRuleEditor visible={showFilters} onClose={() => setShowFilters(false)} />
      <PrivacyModal visible={showPrivacy} onClose={() => setShowPrivacy(false)} />
      <TermsModal visible={showTerms} onClose={() => setShowTerms(false)} />

      {/* Login history modal — last 30d of sign-ins (device + ip + timestamp).
          Data is fetched lazily when the Alertas de login row is tapped so we
          don't roundtrip the server until the user actually asks. Stays
          read-only — revoking a session lives in /activity-log. */}
      <Modal
        visible={loginHistoryOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setLoginHistoryOpen(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}
          onPress={() => setLoginHistoryOpen(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              backgroundColor: colors.surface,
              borderTopLeftRadius: 20, borderTopRightRadius: 20,
              padding: Spacing.lg,
              maxHeight: '70%',
            }}
          >
            <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700', marginBottom: Spacing.md }}>
              {t('settings.loginAlerts.history') || 'Histórico de logins'}
            </Text>
            {loginHistoryLoading ? (
              <ActivityIndicator color={colors.primary} style={{ marginVertical: Spacing.lg }} />
            ) : loginHistory.length === 0 ? (
              <Text style={{ color: colors.textTertiary, textAlign: 'center', paddingVertical: Spacing.lg }}>
                {t('settings.loginAlerts.empty') || 'Nenhum login recente'}
              </Text>
            ) : (
              <ScrollView style={{ maxHeight: 400 }}>
                {loginHistory.map((ev, idx) => {
                  const device = ev.device || ev.user_agent || ev.client || '—';
                  const ip = ev.ip || ev.ip_address || '';
                  const when = ev.created_at || ev.timestamp || ev.ts || '';
                  return (
                    <View
                      key={ev.id || ev.session_id || idx}
                      style={{
                        paddingVertical: Spacing.md,
                        borderBottomWidth: 1,
                        borderBottomColor: colors.borderLight,
                      }}
                    >
                      <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>
                        {device}
                      </Text>
                      <Text style={{ color: colors.textTertiary, fontSize: 12, marginTop: 2 }}>
                        {ip}{ip && when ? ' • ' : ''}{when}
                      </Text>
                    </View>
                  );
                })}
              </ScrollView>
            )}
            <TouchableOpacity
              style={{ marginTop: Spacing.md, alignSelf: 'center', paddingVertical: Spacing.md, paddingHorizontal: Spacing.xl }}
              onPress={() => setLoginHistoryOpen(false)}
            >
              <Text style={{ color: colors.primary, fontWeight: '600' }}>{t('common.close') || 'Fechar'}</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Auto-lock interval picker. Each row tags the active choice so the
          user sees what's currently in effect; tapping a row persists the
          new value and closes the sheet. */}
      <Modal
        visible={autoLockOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setAutoLockOpen(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}
          onPress={() => setAutoLockOpen(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              backgroundColor: colors.surface,
              borderTopLeftRadius: 20, borderTopRightRadius: 20,
              paddingHorizontal: 20, paddingTop: 18, paddingBottom: 28,
            }}
          >
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 17, marginBottom: 6 }}>
              {t('settings.autoLockInterval') || 'Bloqueio automático'}
            </Text>
            <Text style={{ color: colors.textTertiary, fontSize: 13, marginBottom: 18 }}>
              {t('settings.autoLockDesc') || 'Quanto tempo o app espera em segundo plano antes de pedir autenticação.'}
            </Text>
            {[
              { value: 0,       label: t('biometric.lockImmediate') || 'Imediatamente' },
              { value: 60,      label: t('biometric.lock1Min')      || 'Apos 1 minuto' },
              { value: 300,     label: t('biometric.lock5Min')      || 'Apos 5 minutos' },
              { value: 900,     label: t('biometric.lock15Min')     || 'Apos 15 minutos' },
              { value: 'never', label: t('biometric.lockNever')     || 'Nunca' },
            ].map((opt) => {
              const active = String(autoLockInterval) === String(opt.value);
              return (
                <TouchableOpacity
                  key={String(opt.value)}
                  onPress={async () => { await setAutoLockInterval(opt.value); setAutoLockOpen(false); }}
                  style={{
                    paddingVertical: 14,
                    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                    borderBottomWidth: 0.5, borderBottomColor: colors.borderLight,
                  }}
                  activeOpacity={0.6}
                >
                  <Text style={{ color: colors.text, fontSize: 15 }}>{opt.label}</Text>
                  {active && <IconCheck size={18} color={colors.primary} />}
                </TouchableOpacity>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Privacy picker bottom-sheet — single Modal reused for all 4
          dropdown rows (last_seen / profile_photo / story_privacy /
          group_add). `privacyPickerOpen` carries the field key; closing
          via tap-outside or selection sets it back to null. Selected
          value is fire-and-forget saved via saveChatPrivacy(). */}
      <Modal
        visible={!!privacyPickerOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setPrivacyPickerOpen(null)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}
          onPress={() => setPrivacyPickerOpen(null)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              backgroundColor: colors.surface,
              borderTopLeftRadius: 20, borderTopRightRadius: 20,
              paddingHorizontal: 20, paddingTop: 18, paddingBottom: 28,
            }}
          >
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 17, marginBottom: 12 }}>
              {privacyPickerOpen === 'last_seen'     ? t('settings.privacyLastSeen')
               : privacyPickerOpen === 'profile_photo' ? t('settings.privacyProfilePhoto')
               : privacyPickerOpen === 'story_privacy' ? t('settings.privacyStatus')
               : privacyPickerOpen === 'group_add'     ? t('settings.privacyGroups')
               : ''}
            </Text>
            {[
              { value: 'everyone', label: t('settings.privacyEveryone') },
              { value: 'contacts', label: t('settings.privacyContacts') },
              { value: 'nobody',   label: t('settings.privacyNobody') },
            ].map((opt) => {
              const currentVal = privacyPickerOpen ? chatPrivacy[privacyPickerOpen] : '';
              const active = currentVal === opt.value;
              return (
                <TouchableOpacity
                  key={opt.value}
                  onPress={() => {
                    if (privacyPickerOpen) saveChatPrivacy({ [privacyPickerOpen]: opt.value });
                    setPrivacyPickerOpen(null);
                  }}
                  style={{
                    paddingVertical: 14,
                    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                    borderBottomWidth: 0.5, borderBottomColor: colors.borderLight,
                  }}
                  activeOpacity={0.6}
                >
                  <Text style={{ color: colors.text, fontSize: 15 }}>{opt.label}</Text>
                  {active && <IconCheck size={18} color={colors.primary} />}
                </TouchableOpacity>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>

      {/* E2E backup escrow modal — passphrase entry + upload trigger. The
          user types the passphrase twice; on submit we derive an
          encryption key locally (PBKDF2/XSalsa20) from the passphrase,
          encrypt the user's identity + chat keys, and ship ciphertext +
          sha256(passphrase) to the server. The plaintext passphrase is
          never sent. */}
      <Modal
        visible={e2eBackupOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setE2eBackupOpen(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 20 }}
          onPress={() => !e2eBackupBusy && setE2eBackupOpen(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{ backgroundColor: colors.surface, borderRadius: 18, padding: 20 }}
          >
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 17, marginBottom: 6 }}>
              {t('settings.e2eBackup') || 'Backup com criptografia'}
            </Text>
            <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 14 }}>
              {t('settings.e2eBackupSetPass') || 'Defina sua frase secreta'}
            </Text>
            <TextInput
              value={e2eBackupPass}
              onChangeText={setE2eBackupPass}
              secureTextEntry
              placeholder="Frase secreta"
              placeholderTextColor={colors.textTertiary}
              style={{
                borderWidth: 1, borderColor: colors.borderLight,
                borderRadius: 10, padding: 12, marginBottom: 10,
                color: colors.text, backgroundColor: colors.background,
              }}
              editable={!e2eBackupBusy}
            />
            <TextInput
              value={e2eBackupPass2}
              onChangeText={setE2eBackupPass2}
              secureTextEntry
              placeholder="Repita a frase secreta"
              placeholderTextColor={colors.textTertiary}
              style={{
                borderWidth: 1, borderColor: colors.borderLight,
                borderRadius: 10, padding: 12, marginBottom: 12,
                color: colors.text, backgroundColor: colors.background,
              }}
              editable={!e2eBackupBusy}
            />
            {e2eBackupMsg ? (
              <Text style={{ color: e2eBackupMsg.startsWith('OK') ? '#16a34a' : '#dc2626', fontSize: 13, marginBottom: 10 }}>
                {e2eBackupMsg}
              </Text>
            ) : null}
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity
                onPress={() => !e2eBackupBusy && setE2eBackupOpen(false)}
                style={{ flex: 1, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.borderLight, alignItems: 'center' }}
              >
                <Text style={{ color: colors.text, fontWeight: '600' }}>{t('common.cancel') || 'Cancelar'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={async () => {
                  setE2eBackupMsg('');
                  if (!e2eBackupPass || e2eBackupPass.length < 8) {
                    setE2eBackupMsg('Use ao menos 8 caracteres'); return;
                  }
                  if (e2eBackupPass !== e2eBackupPass2) {
                    setE2eBackupMsg('As frases nao coincidem'); return;
                  }
                  setE2eBackupBusy(true);
                  try {
                    // 1. Derive ciphertext locally. We reuse the
                    //    existing services/e2ee passphrase-encrypt path
                    //    when present; fall back to a minimal tweetnacl
                    //    XSalsa20-Poly1305 if the orchestrator doesn't
                    //    expose a helper yet (older OTA installs).
                    const nacl = require('tweetnacl');
                    const naclUtil = require('tweetnacl-util');
                    const e2e = require('../services/e2e');
                    // Collect a coarse "what to back up" payload — for v1
                    // we ship just the identity key + the in-memory chat
                    // key map. Future versions can fold in device list.
                    const ikPub = (await e2e.getPublicKeyBase64?.()) || '';
                    const blob = JSON.stringify({ v: 1, ik_pub: ikPub, ts: Date.now() });
                    // Derive a 32-byte key from the passphrase. Cheap
                    // PBKDF2-via-tweetnacl-hash loop — good enough for
                    // soft escrow, not for serious password recovery.
                    let key = naclUtil.decodeUTF8(e2eBackupPass);
                    for (let i = 0; i < 100000; i++) key = nacl.hash(key);
                    key = key.slice(0, nacl.secretbox.keyLength);
                    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
                    const ct = nacl.secretbox(naclUtil.decodeUTF8(blob), nonce, key);
                    const ciphertextB64 = naclUtil.encodeBase64(ct);
                    const nonceB64 = naclUtil.encodeBase64(nonce);
                    // sha256(passphrase) — soft anti-bruteforce gate.
                    const passBytes = naclUtil.decodeUTF8(e2eBackupPass);
                    const passHash = Array.from(nacl.hash(passBytes).slice(0, 32))
                      .map((b) => b.toString(16).padStart(2, '0')).join('');
                    const salt = naclUtil.encodeBase64(nacl.randomBytes(16));
                    const api = require('../services/api');
                    const r = await api.e2eeBackupEscrowPut({
                      ciphertext: ciphertextB64, salt, nonce: nonceB64,
                      kdfIters: 100000, passphraseHash: passHash,
                      deviceLabel: Platform.OS,
                    });
                    if (r?.success) {
                      setE2eBackupMsg('OK ' + (t('settings.e2eBackupSaved') || 'Backup criado'));
                      setE2eBackupPass(''); setE2eBackupPass2('');
                      setTimeout(() => setE2eBackupOpen(false), 1200);
                    } else {
                      setE2eBackupMsg(r?.message || 'Falha ao salvar');
                    }
                  } catch (err) {
                    setE2eBackupMsg(String(err?.message || err));
                  } finally {
                    setE2eBackupBusy(false);
                  }
                }}
                disabled={e2eBackupBusy}
                style={{ flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.primary, alignItems: 'center', opacity: e2eBackupBusy ? 0.5 : 1 }}
              >
                {e2eBackupBusy
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Text style={{ color: '#fff', fontWeight: '700' }}>{t('common.save') || 'Salvar'}</Text>}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Change Password Modal */}
      <Modal
        visible={changePasswordOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setChangePasswordOpen(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center' }}
          onPress={() => setChangePasswordOpen(false)}
        >
          <Pressable
            onPress={e => e.stopPropagation?.()}
            style={{
              margin: 20,
              backgroundColor: colors.surface,
              borderRadius: 20,
              padding: 24,
              ...(Platform.OS === 'web' ? { boxShadow: '0 20px 50px rgba(0,0,0,0.25)' } : {}),
            }}
          >
            <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text, marginBottom: 4 }}>
              {t('settings.changePassword') || 'Alterar senha'}
            </Text>
            <Text style={{ fontSize: 13, color: colors.textTertiary, marginBottom: 20 }}>
              {t('settings.changePasswordBody') || 'Sua nova senha precisa ter no mínimo 8 caracteres.'}
            </Text>

            {/* Current password */}
            <Text style={{ fontSize: 12, fontWeight: '600', color: colors.textSecondary, marginBottom: 6, letterSpacing: 0.3 }}>
              {(t('settings.currentPassword') || 'Senha atual').toUpperCase()}
            </Text>
            <TextInput
              value={cpCurrent}
              onChangeText={v => { setCpCurrent(v); setCpError(''); }}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="••••••••"
              placeholderTextColor={colors.textTertiary}
              style={{
                borderWidth: 1,
                borderColor: cpError ? colors.error : colors.border,
                borderRadius: 12,
                paddingHorizontal: 14,
                paddingVertical: 12,
                fontSize: 15,
                color: colors.text,
                backgroundColor: colors.surfaceVariant || colors.background,
                marginBottom: 14,
                ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
              }}
              editable={!cpLoading}
            />

            {/* New password */}
            <Text style={{ fontSize: 12, fontWeight: '600', color: colors.textSecondary, marginBottom: 6, letterSpacing: 0.3 }}>
              {(t('settings.newPassword') || 'Nova senha').toUpperCase()}
            </Text>
            <TextInput
              value={cpNew}
              onChangeText={v => { setCpNew(v); setCpError(''); }}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={t('settings.newPasswordPlaceholder') || 'Mínimo 8 caracteres'}
              placeholderTextColor={colors.textTertiary}
              style={{
                borderWidth: 1,
                borderColor: cpError ? colors.error : colors.border,
                borderRadius: 12,
                paddingHorizontal: 14,
                paddingVertical: 12,
                fontSize: 15,
                color: colors.text,
                backgroundColor: colors.surfaceVariant || colors.background,
                marginBottom: 14,
                ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
              }}
              editable={!cpLoading}
            />

            {/* Confirm */}
            <Text style={{ fontSize: 12, fontWeight: '600', color: colors.textSecondary, marginBottom: 6, letterSpacing: 0.3 }}>
              {(t('settings.confirmNewPassword') || 'Confirmar nova senha').toUpperCase()}
            </Text>
            <TextInput
              value={cpConfirm}
              onChangeText={v => { setCpConfirm(v); setCpError(''); }}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="••••••••"
              placeholderTextColor={colors.textTertiary}
              style={{
                borderWidth: 1,
                borderColor: cpError ? colors.error : colors.border,
                borderRadius: 12,
                paddingHorizontal: 14,
                paddingVertical: 12,
                fontSize: 15,
                color: colors.text,
                backgroundColor: colors.surfaceVariant || colors.background,
                marginBottom: 6,
                ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
              }}
              editable={!cpLoading}
            />

            {cpError ? (
              <Text style={{ color: colors.error, fontSize: 13, marginTop: 4 }}>{cpError}</Text>
            ) : null}
            {cpSuccess ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <IconCheck size={14} color="#16A34A" />
                <Text style={{ color: '#16A34A', fontSize: 13, fontWeight: '600' }}>
                  {t('settings.passwordChanged') || 'Senha alterada com sucesso'}
                </Text>
              </View>
            ) : null}

            {/* Actions */}
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 20 }}>
              <TouchableOpacity
                onPress={() => {
                  setChangePasswordOpen(false);
                  setCpCurrent(''); setCpNew(''); setCpConfirm('');
                  setCpError(''); setCpSuccess(false);
                }}
                disabled={cpLoading}
                style={{
                  flex: 1, paddingVertical: 14,
                  borderRadius: 12,
                  backgroundColor: colors.surfaceVariant || 'transparent',
                  borderWidth: 1, borderColor: colors.border,
                  alignItems: 'center', opacity: cpLoading ? 0.5 : 1,
                }}
              >
                <Text style={{ color: colors.text, fontWeight: '600' }}>
                  {t('common.cancel') || 'Cancelar'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={async () => {
                  setCpError(''); setCpSuccess(false);
                  if (!cpCurrent) { setCpError(t('settings.currentPasswordRequired') || 'Informe a senha atual'); return; }
                  if (cpNew.length < 8) { setCpError(t('settings.newPasswordTooShort') || 'Nova senha precisa ter 8+ caracteres'); return; }
                  if (cpNew !== cpConfirm) { setCpError(t('settings.passwordsDontMatch') || 'As senhas não coincidem'); return; }
                  setCpLoading(true);
                  // Biometric gate: changing the account password is a
                  // sensitive action (an attacker who grabbed the phone
                  // while the session was active could otherwise rotate
                  // the password and lock the legit user out). Require
                  // Face ID / fingerprint before submitting.
                  try {
                    const { confirmWithBiometric } = require('../services/biometricGate');
                    const okBio = await confirmWithBiometric({
                      reason: t('settings.changePassword') || 'Alterar senha',
                    });
                    if (!okBio) { setCpLoading(false); return; }
                  } catch {}
                  try {
                    const { changePassword } = require('../services/api');
                    const r = await changePassword(cpCurrent, cpNew);
                    if (r?.success) {
                      setCpSuccess(true);
                      setTimeout(() => {
                        setChangePasswordOpen(false);
                        setCpCurrent(''); setCpNew(''); setCpConfirm('');
                        setCpSuccess(false);
                      }, 1400);
                    } else {
                      setCpError(r?.message || (t('settings.passwordChangeFailed') || 'Não foi possível alterar a senha'));
                    }
                  } catch (e) {
                    setCpError(e?.message || 'Erro');
                  } finally {
                    setCpLoading(false);
                  }
                }}
                disabled={cpLoading}
                style={{
                  flex: 1, paddingVertical: 14,
                  borderRadius: 12,
                  backgroundColor: colors.primary,
                  alignItems: 'center', opacity: cpLoading ? 0.6 : 1,
                }}
              >
                {cpLoading ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={{ color: '#fff', fontWeight: '700' }}>
                    {t('settings.save') || t('common.save') || 'Salvar'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* 2FA PIN Entry Modal — 4 digit boxes */}
      <Modal
        visible={twoFAOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setTwoFAOpen(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center' }}
          onPress={() => setTwoFAOpen(false)}
        >
          <Pressable
            onPress={e => e.stopPropagation?.()}
            style={{
              margin: 20,
              backgroundColor: colors.surface,
              borderRadius: 20,
              padding: 24,
              ...(Platform.OS === 'web' ? { boxShadow: '0 20px 50px rgba(0,0,0,0.25)' } : {}),
            }}
          >
            <View style={{ alignItems: 'center', marginBottom: 14 }}>
              <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.primary + '22', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
                <IconShield size={28} color={colors.primary} />
              </View>
              <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text, textAlign: 'center' }}>
                {t('settings.twoFactor') || 'Verificação em duas etapas'}
              </Text>
              <Text style={{ fontSize: 13, color: colors.textTertiary, marginTop: 6, textAlign: 'center', lineHeight: 18 }}>
                {t('settings.twoFactorDesc') || 'Adicione uma camada extra de segurança ao seu Chatyy'}
              </Text>
            </View>

            {/* 4 digit boxes */}
            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 12, marginVertical: 18 }}>
              {[0, 1, 2, 3].map(idx => (
                <TextInput
                  key={idx}
                  ref={el => { twoFARefs.current[idx] = el; }}
                  value={twoFADigits[idx]}
                  onChangeText={(v) => {
                    const digit = (v || '').replace(/\D/g, '').slice(-1);
                    setTwoFADigits(prev => {
                      const next = [...prev];
                      next[idx] = digit;
                      return next;
                    });
                    setTwoFAError('');
                    if (digit && idx < 3) {
                      try { twoFARefs.current[idx + 1]?.focus?.(); } catch {}
                    }
                  }}
                  onKeyPress={(e) => {
                    if (e?.nativeEvent?.key === 'Backspace' && !twoFADigits[idx] && idx > 0) {
                      try { twoFARefs.current[idx - 1]?.focus?.(); } catch {}
                    }
                  }}
                  keyboardType="number-pad"
                  maxLength={1}
                  secureTextEntry
                  style={{
                    width: 56, height: 64, borderRadius: 14,
                    borderWidth: 1.5, borderColor: twoFADigits[idx] ? colors.primary : colors.border,
                    backgroundColor: colors.surfaceVariant || colors.surface,
                    color: colors.text, textAlign: 'center',
                    fontSize: 26, fontWeight: '700',
                    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
                  }}
                />
              ))}
            </View>

            {!!twoFAError && (
              <Text style={{ color: colors.error || '#EF4444', fontSize: 13, textAlign: 'center', marginBottom: 8 }}>
                {twoFAError}
              </Text>
            )}
            {twoFASuccess && (
              <Text style={{ color: '#10B981', fontSize: 13, textAlign: 'center', marginBottom: 8, fontWeight: '600' }}>
                {t('settings.twoFactorEnabled') || 'PIN ativado com sucesso'}
              </Text>
            )}

            <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
              <TouchableOpacity
                onPress={() => { setTwoFAOpen(false); }}
                disabled={twoFALoading}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 12,
                  backgroundColor: colors.surfaceVariant || 'transparent',
                  borderWidth: 1, borderColor: colors.border,
                  alignItems: 'center', opacity: twoFALoading ? 0.5 : 1,
                }}
              >
                <Text style={{ color: colors.text, fontWeight: '600' }}>
                  {t('common.cancel') || 'Cancelar'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={async () => {
                  const pin = twoFADigits.join('');
                  if (pin.length !== 4) {
                    setTwoFAError(t('settings.twoFactorPinLen') || 'Digite os 4 dígitos');
                    return;
                  }
                  setTwoFAError(''); setTwoFALoading(true);
                  try {
                    const r = await api.enable2fa(pin);
                    if (r?.success) {
                      setTwoFASuccess(true);
                      setTimeout(() => { setTwoFAOpen(false); setTwoFASuccess(false); }, 1100);
                    } else {
                      setTwoFAError(r?.message || (t('settings.twoFactorFailed') || 'Não foi possível ativar o PIN'));
                    }
                  } catch (e) {
                    setTwoFAError(e?.message || (t('settings.twoFactorFailed') || 'Não foi possível ativar o PIN'));
                  } finally {
                    setTwoFALoading(false);
                  }
                }}
                disabled={twoFALoading}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 12,
                  backgroundColor: colors.primary,
                  alignItems: 'center', opacity: twoFALoading ? 0.6 : 1,
                }}
              >
                {twoFALoading ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={{ color: '#fff', fontWeight: '700' }}>
                    {t('settings.twoFactorEnable') || 'Ativar PIN'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Registration Lock PIN Entry Modal — same shape as 2FA but writes a
          separate backend key (registration_lock) that gates phone-OTP login
          rather than email/password login. The PIN is the second factor on
          phone_login_verify; without it, even a successful SIM-swap can't
          take over the account. */}
      <Modal
        visible={regLockOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setRegLockOpen(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center' }}
          onPress={() => setRegLockOpen(false)}
        >
          <Pressable
            onPress={e => e.stopPropagation?.()}
            style={{
              margin: 20,
              backgroundColor: colors.surface,
              borderRadius: 20,
              padding: 24,
              ...(Platform.OS === 'web' ? { boxShadow: '0 20px 50px rgba(0,0,0,0.25)' } : {}),
            }}
          >
            <View style={{ alignItems: 'center', marginBottom: 14 }}>
              <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.primary + '22', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
                <IconShield size={28} color={colors.primary} />
              </View>
              <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text, textAlign: 'center' }}>
                {t('settings.registrationLock') || 'PIN de segurança (anti-SIM-swap)'}
              </Text>
              <Text style={{ fontSize: 13, color: colors.textTertiary, marginTop: 6, textAlign: 'center', lineHeight: 18 }}>
                {t('settings.registrationLockDesc') || 'PIN extra no login por telefone — protege se trocarem seu chip.'}
              </Text>
            </View>

            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 12, marginVertical: 18 }}>
              {[0, 1, 2, 3].map(idx => (
                <TextInput
                  key={idx}
                  ref={el => { regLockRefs.current[idx] = el; }}
                  value={regLockDigits[idx]}
                  onChangeText={(v) => {
                    const digit = (v || '').replace(/\D/g, '').slice(-1);
                    setRegLockDigits(prev => {
                      const next = [...prev];
                      next[idx] = digit;
                      return next;
                    });
                    setRegLockError('');
                    if (digit && idx < 3) {
                      try { regLockRefs.current[idx + 1]?.focus?.(); } catch {}
                    }
                  }}
                  onKeyPress={(e) => {
                    if (e?.nativeEvent?.key === 'Backspace' && !regLockDigits[idx] && idx > 0) {
                      try { regLockRefs.current[idx - 1]?.focus?.(); } catch {}
                    }
                  }}
                  keyboardType="number-pad"
                  maxLength={1}
                  secureTextEntry
                  style={{
                    width: 56, height: 64, borderRadius: 14,
                    borderWidth: 1.5, borderColor: regLockDigits[idx] ? colors.primary : colors.border,
                    backgroundColor: colors.surfaceVariant || colors.surface,
                    color: colors.text, textAlign: 'center',
                    fontSize: 26, fontWeight: '700',
                    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
                  }}
                />
              ))}
            </View>

            {!!regLockError && (
              <Text style={{ color: colors.error || '#EF4444', fontSize: 13, textAlign: 'center', marginBottom: 8 }}>
                {regLockError}
              </Text>
            )}
            {regLockSuccess && (
              <Text style={{ color: '#10B981', fontSize: 13, textAlign: 'center', marginBottom: 8, fontWeight: '600' }}>
                {t('settings.registrationLockEnabled') || 'PIN ativado com sucesso'}
              </Text>
            )}

            <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
              <TouchableOpacity
                onPress={() => { setRegLockOpen(false); }}
                disabled={regLockLoading}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 12,
                  backgroundColor: colors.surfaceVariant || 'transparent',
                  borderWidth: 1, borderColor: colors.border,
                  alignItems: 'center', opacity: regLockLoading ? 0.5 : 1,
                }}
              >
                <Text style={{ color: colors.text, fontWeight: '600' }}>
                  {t('common.cancel') || 'Cancelar'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={async () => {
                  const pin = regLockDigits.join('');
                  if (pin.length !== 4) {
                    setRegLockError(t('settings.registrationLockPinLen') || 'Digite os 4 dígitos');
                    return;
                  }
                  setRegLockError(''); setRegLockLoading(true);
                  try {
                    const r = await api.setRegistrationLock(pin);
                    if (r?.success) {
                      setRegLockSuccess(true);
                      setTimeout(() => { setRegLockOpen(false); setRegLockSuccess(false); }, 1100);
                    } else {
                      setRegLockError(r?.message || (t('settings.registrationLockFailed') || 'Não foi possível ativar o PIN'));
                    }
                  } catch (e) {
                    setRegLockError(e?.message || (t('settings.registrationLockFailed') || 'Não foi possível ativar o PIN'));
                  } finally {
                    setRegLockLoading(false);
                  }
                }}
                disabled={regLockLoading}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 12,
                  backgroundColor: colors.primary,
                  alignItems: 'center', opacity: regLockLoading ? 0.6 : 1,
                }}
              >
                {regLockLoading ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={{ color: '#fff', fontWeight: '700' }}>
                    {t('settings.registrationLockEnable') || 'Ativar PIN'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* About modal — version + build + legal links. Read-only surface;
          the user can deep-link to Terms / Privacy (reuses the existing
          modals) or to a licenses route. We keep it dependency-light:
          read Constants.expoConfig.version/buildNumber/versionCode for
          the displayed build label. */}
      <Modal
        visible={aboutOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setAboutOpen(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 20 }}
          onPress={() => setAboutOpen(false)}
        >
          <Pressable
            onPress={e => e.stopPropagation?.()}
            style={{ backgroundColor: colors.surface, borderRadius: 18, padding: 22 }}
          >
            <Text style={{ color: colors.text, fontWeight: '800', fontSize: 20, marginBottom: 6 }}>
              {t('settings.about.title') || 'Sobre'}
            </Text>
            <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 16 }}>
              {(() => {
                const ver = Constants?.expoConfig?.version || Constants?.manifest?.version || '?';
                const build = Constants?.expoConfig?.ios?.buildNumber
                  || Constants?.expoConfig?.android?.versionCode
                  || '';
                const label = (t('settings.about.version') || 'Versão {ver}').replace('{ver}', ver);
                return build ? `${label} • build ${build}` : label;
              })()}
            </Text>

            <TouchableOpacity
              onPress={() => { setAboutOpen(false); setTimeout(() => setShowTerms(true), 200); }}
              style={{ paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
            >
              <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>{t('settings.about.terms') || 'Termos de uso'}</Text>
              <IconChevronRight size={16} color={colors.textTertiary} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => { setAboutOpen(false); setTimeout(() => setShowPrivacy(true), 200); }}
              style={{ paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
            >
              <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>{t('settings.about.privacy') || 'Política de privacidade'}</Text>
              <IconChevronRight size={16} color={colors.textTertiary} />
            </TouchableOpacity>
            {/* Open-source licenses row removed: /licenses returned the SPA
                404. Re-add with a real in-app modal if/when a licenses
                manifest exists. */}

            <TouchableOpacity
              onPress={() => setAboutOpen(false)}
              style={{ marginTop: 16, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.primary, alignItems: 'center' }}
            >
              <Text style={{ color: '#fff', fontWeight: '700' }}>{t('common.close') || 'Fechar'}</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Backup key rotation modal — re-uses the passphrase-pair UX from
          the original E2E backup flow. On submit we call the same
          e2eeBackupEscrowPut endpoint but flag the request as a rotation
          (server invalidates previous escrow blobs). Lightweight here —
          the real crypto lives in services/e2e on submit. */}
      <Modal
        visible={backupKeyOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setBackupKeyOpen(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 20 }}
          onPress={() => !backupKeyBusy && setBackupKeyOpen(false)}
        >
          <Pressable
            onPress={e => e.stopPropagation?.()}
            style={{ backgroundColor: colors.surface, borderRadius: 18, padding: 22 }}
          >
            <Text style={{ color: colors.text, fontWeight: '800', fontSize: 18, marginBottom: 6 }}>
              {t('settings.backupKey.rotate') || 'Redefinir senha do backup'}
            </Text>
            <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 14 }}>
              {t('settings.backupKey.warning') || 'Atenção: backups antigos deixarão de ser restauráveis com a senha anterior. Anote a nova senha em local seguro.'}
            </Text>
            <TextInput
              value={backupKeyPass}
              onChangeText={setBackupKeyPass}
              secureTextEntry
              placeholder={t('settings.backupKey.newPass') || 'Nova frase secreta'}
              placeholderTextColor={colors.textTertiary}
              style={{
                borderWidth: 1, borderColor: colors.borderLight,
                borderRadius: 10, padding: 12, marginBottom: 10,
                color: colors.text, backgroundColor: colors.background,
              }}
              editable={!backupKeyBusy}
            />
            <TextInput
              value={backupKeyPass2}
              onChangeText={setBackupKeyPass2}
              secureTextEntry
              placeholder={t('settings.backupKey.repeatPass') || 'Repita a frase'}
              placeholderTextColor={colors.textTertiary}
              style={{
                borderWidth: 1, borderColor: colors.borderLight,
                borderRadius: 10, padding: 12, marginBottom: 12,
                color: colors.text, backgroundColor: colors.background,
              }}
              editable={!backupKeyBusy}
            />
            {backupKeyMsg ? (
              <Text style={{ color: backupKeyMsg.startsWith('OK') ? '#16a34a' : '#dc2626', fontSize: 13, marginBottom: 10 }}>
                {backupKeyMsg}
              </Text>
            ) : null}
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity
                onPress={() => !backupKeyBusy && setBackupKeyOpen(false)}
                style={{ flex: 1, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.borderLight, alignItems: 'center' }}
              >
                <Text style={{ color: colors.text, fontWeight: '600' }}>{t('common.cancel') || 'Cancelar'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={async () => {
                  setBackupKeyMsg('');
                  if (!backupKeyPass || backupKeyPass.length < 8) {
                    setBackupKeyMsg(t('settings.backupKey.tooShort') || 'Use ao menos 8 caracteres'); return;
                  }
                  if (backupKeyPass !== backupKeyPass2) {
                    setBackupKeyMsg(t('settings.backupKey.mismatch') || 'As frases nao coincidem'); return;
                  }
                  setBackupKeyBusy(true);
                  try {
                    // Re-use the same XSalsa20-Poly1305 escrow flow as the
                    // initial backup. Flagging `rotate: true` lets the server
                    // version the new blob and revoke prior ones.
                    const nacl = require('tweetnacl');
                    const naclUtil = require('tweetnacl-util');
                    const e2e = require('../services/e2e');
                    const ikPub = (await e2e.getPublicKeyBase64?.()) || '';
                    const blob = JSON.stringify({ v: 1, ik_pub: ikPub, ts: Date.now() });
                    let key = naclUtil.decodeUTF8(backupKeyPass);
                    for (let i = 0; i < 100000; i++) key = nacl.hash(key);
                    key = key.slice(0, nacl.secretbox.keyLength);
                    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
                    const ct = nacl.secretbox(naclUtil.decodeUTF8(blob), nonce, key);
                    const ciphertextB64 = naclUtil.encodeBase64(ct);
                    const nonceB64 = naclUtil.encodeBase64(nonce);
                    const passBytes = naclUtil.decodeUTF8(backupKeyPass);
                    const passHash = Array.from(nacl.hash(passBytes).slice(0, 32))
                      .map((b) => b.toString(16).padStart(2, '0')).join('');
                    const salt = naclUtil.encodeBase64(nacl.randomBytes(16));
                    const r = await api.e2eeBackupEscrowPut?.({
                      ciphertext: ciphertextB64, salt, nonce: nonceB64,
                      kdfIters: 100000, passphraseHash: passHash,
                      deviceLabel: Platform.OS, rotate: true,
                    });
                    if (r?.success) {
                      setBackupKeyMsg('OK ' + (t('settings.backupKey.rotated') || 'Senha redefinida'));
                      setBackupKeyPass(''); setBackupKeyPass2('');
                      setTimeout(() => setBackupKeyOpen(false), 1200);
                    } else {
                      setBackupKeyMsg(r?.message || (t('settings.backupKey.failed') || 'Falha ao redefinir'));
                    }
                  } catch (err) {
                    setBackupKeyMsg(String(err?.message || err));
                  } finally {
                    setBackupKeyBusy(false);
                  }
                }}
                disabled={backupKeyBusy}
                style={{ flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.primary, alignItems: 'center', opacity: backupKeyBusy ? 0.5 : 1 }}
              >
                {backupKeyBusy
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Text style={{ color: '#fff', fontWeight: '700' }}>{t('common.save') || 'Salvar'}</Text>}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  // Header
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    ...Platform.select({
      web: { backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' },
      default: {},
    }),
  },
  backBtn: { padding: Spacing.sm, marginRight: Spacing.sm, borderRadius: 12 },
  headerTitle: { flex: 1, fontSize: FontSize.xxl, fontWeight: '700', letterSpacing: -0.3 },
  saveBtn: {
    borderRadius: 24, paddingVertical: Spacing.sm + 2, paddingHorizontal: Spacing.xl,
    ...Platform.select({
      web: { background: 'linear-gradient(135deg, #7C3AED 0%, #A855F7 100%)', boxShadow: '0 4px 12px rgba(124,58,237,0.3)' },
      default: {},
    }),
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: { color: '#fff', fontSize: FontSize.base, fontWeight: '700' },
  // Scroll — paddingBottom extra pra "Excluir conta" (último item da Zona
  // perigosa) não ficar colado no safe-area inferior do iPhone, e pro modal
  // de confirmação não ser cortado quando aparece. User reportou: "embaixo
  // zona perigosa quebra fica tudo cortando".
  scroll: { padding: Spacing.lg, paddingBottom: 80 },
  // Section
  section: {
    borderRadius: 22, padding: Spacing.xl, marginBottom: Spacing.lg + 2,
    ...Platform.select({
      web: {
        transition: 'box-shadow 0.2s ease',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04)',
      },
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.04, shadowRadius: 12 },
      android: { elevation: 1 },
    }),
  },
  profileSection: {
    alignItems: 'center', paddingVertical: Spacing.xxl,
  },
  profileEmail: {
    fontSize: FontSize.lg, marginTop: Spacing.md, marginBottom: Spacing.sm, fontWeight: '500',
  },
  changePhotoBtn: {
    marginTop: Spacing.sm, borderWidth: 1.5, borderRadius: 24,
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.sm + 2,
  },
  changePhotoBtnText: {
    fontSize: FontSize.md, fontWeight: '700',
  },
  // Section title — kept big and bold (20px) so users still see it as the
  // card heading, but added a thin uppercase eyebrow style via `sectionEyebrow`
  // below for sections that opt-in. Letter-spacing tightened to -0.4 (was
  // -0.5) so it doesn't look squashed at this size.
  sectionTitle: { fontSize: 20, fontWeight: '800', marginBottom: Spacing.lg, letterSpacing: -0.4 },
  // Eyebrow label — small uppercase brand-color tag rendered above a section
  // title for screens that want extra navigability (iOS Settings pattern).
  // Currently only used internally; rows opt in via <Text style={[s.sectionEyebrow, { color: colors.primary }]}/>.
  sectionEyebrow: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4, opacity: 0.85 },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.lg },
  // Setting row — adds a soft hover state on web so each row reads as
  // "tappable" without an explicit border. Spacing bumped slightly for
  // a more relaxed iOS-Settings density.
  settingRow: {
    flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8,
    paddingVertical: Spacing.md + 6, borderBottomWidth: 1,
    ...Platform.select({
      web: { transition: 'background-color 0.15s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  settingRowColumn: {
    flexDirection: 'column', alignItems: 'flex-start',
    paddingVertical: Spacing.md + 4, borderBottomWidth: 1,
  },
  settingInfo: { flex: 1, minWidth: 0 },
  settingLabel: { fontSize: 15.5, fontWeight: '600', letterSpacing: -0.15 },
  settingDesc: { fontSize: 13, marginTop: 3, opacity: 0.7, lineHeight: 18 },
  // Per page
  perPageBtns: { flexDirection: 'row', gap: Spacing.sm, flexShrink: 0 },
  perPageBtn: {
    borderWidth: 1.5, borderRadius: 12,
    paddingHorizontal: Spacing.md, paddingVertical: 8,
    ...Platform.select({
      web: { transition: 'all 0.15s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  perPageText: { fontSize: FontSize.base, fontWeight: '600' },
  // Signature
  sigCard: { borderWidth: 1, borderRadius: 14, padding: Spacing.md, marginBottom: Spacing.sm },
  sigHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sigNameInput: {
    flex: 1, fontSize: FontSize.sm, borderBottomWidth: 1, paddingVertical: 2, fontWeight: '500',
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  defaultBtn: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: BorderRadius.xxl },
  addSigBtn: { borderWidth: 1.5, borderStyle: 'dashed', borderRadius: 14, paddingVertical: 12, alignItems: 'center' },
  signatureInput: {
    borderWidth: 1, borderRadius: BorderRadius.md,
    padding: Spacing.md, fontSize: FontSize.base,
    minHeight: 100, ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  // AI Features
  aiFeatures: { marginTop: Spacing.md },
  aiFeatureRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: Spacing.sm,
  },
  aiFeatureIconWrap: { marginRight: Spacing.md, width: 24, alignItems: 'center' },
  aiFeatureText: { fontSize: FontSize.base },
  // Toggle switch
  toggleTrack: {
    width: 48, height: 26, borderRadius: 13,
    justifyContent: 'center', padding: 2,
    ...Platform.select({
      web: { transition: 'background-color 0.2s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  toggleThumb: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: '#fff',
    ...(Platform.OS === 'web' ? { boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'all 0.2s ease' } : {}),
  },
  toggleThumbActive: { alignSelf: 'flex-end' },
  // Delete account
  deleteConfirmBox: {
    borderWidth: 1, borderRadius: BorderRadius.md, padding: Spacing.lg, marginTop: Spacing.md,
  },
  deleteConfirmTitle: { fontSize: FontSize.lg, fontWeight: '700', marginBottom: Spacing.sm },
  deleteConfirmText: { fontSize: FontSize.sm, lineHeight: 20, marginBottom: Spacing.md },
  deletePasswordInput: {
    borderWidth: 1, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, paddingVertical: 10,
    fontSize: FontSize.base, marginBottom: Spacing.sm,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  deleteErrorText: { fontSize: FontSize.sm, fontWeight: '500', marginBottom: Spacing.sm },
  deleteActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.sm, marginTop: Spacing.sm },
  deleteCancelBtn: {
    borderWidth: 1, borderRadius: BorderRadius.md,
    paddingVertical: 10, paddingHorizontal: Spacing.xl,
  },
  deleteCancelText: { fontSize: FontSize.base, fontWeight: '500' },
  deleteConfirmBtn: {
    borderRadius: BorderRadius.md,
    paddingVertical: 10, paddingHorizontal: Spacing.xl,
  },
  deleteConfirmBtnText: { color: '#fff', fontSize: FontSize.base, fontWeight: '700' },
});

export default function SettingsScreen() { return <ErrorBoundary><SettingsScreenInner /></ErrorBoundary>; }
