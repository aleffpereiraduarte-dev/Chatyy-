// [2026-10-15 apps-v3] Painel "Apps" (aba Apps do /chat) — extraído de app/chat.js.
//
// Redesenho nível iOS 26 / Telegram, P&B premium:
//   • cartão da Bia com o ORB vivo (BiaOrb/Skia) + sugestão do momento + atalho voz;
//   • "Recentes" = faixa horizontal (fixados primeiro, depois MRU); resto em grade 4 col;
//   • ícones em squircle (borderCurve contínuo) com gradiente monocromático + brilho
//     de vidro no topo + sombra suave; seções com título pequeno em CAIXA ALTA;
//   • badge aparece UMA vez (na faixa Recentes se o app estiver lá; senão na grade);
//   • motion (components/apps/appsMotion*): cascata por linha ao abrir (spring,
//     escala 0.92→1 + fade), micro-bounce + haptic no toque, badges com pop, busca
//     reorganiza com Layout Animations (spring), tecla limpar com pop, segurar um app
//     = modo editar com tremor (tocar fixa/tira de Recentes). Reduzir Movimento ok.
//     Web = keyframes CSS + FLIP via Web Animations API (sem loop JS).
// Rotas/ações idênticas ao drawer anterior (chat.js 2026-10-07 apps-menu).
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet, Platform, Animated, Dimensions, TextInput, Modal, Pressable, KeyboardAvoidingView, PanResponder, Keyboard, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import {
  IconSearch, IconMail, IconCalendar, IconFolder, IconFileText, IconStickyNote, IconUsers,
  IconImage, IconVideo, IconSparkles, IconUser, IconSettings, IconBell, IconShield, IconGrid,
  IconMapPin, IconCreditCard, IconMegaphone, IconUsersSmall, IconReels, IconBroadcast,
  IconCheckCircle, IconX as IconClose, IconPlus,
} from '../Icons';
import PressableScale from '../PressableScale';
import { WALLET_ENABLED } from '../../constants/featureFlags';
import { haptic } from '../../constants/theme';
import { Springs, Durations, Easings, Gestures, motionEnabled } from '../../constants/motion'; // [2026-10-16 motion]
import { USE_NATIVE_SHEETS, NativeSheet, NativeSheetKeyboardView, nativeSheetBottomPad, nativeSheetBoundedOn } from '../NativeSheet';
import BiaOrb from '../bia/BiaOrb';
import { GlyphWave } from '../bia/BiaUI';
import { AppsItem, Jiggle, Pop, TilePress, prepareLayoutChange } from './appsMotion';

// ── Persistência local (MMKV nativo / localStorage web) ─────────────────────
// MRU dos apps abertos + contador de uso (ordena cada seção) + fixados.
const RECENT_APPS_KEY = 'apps_recent_v1';
const APP_USAGE_KEY = 'apps_usage_v1';
const PINNED_APPS_KEY = 'apps_pinned_v1';
const _readJSON = (key, fallback) => {
  try {
    let raw = null;
    if (Platform.OS === 'web') raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    else raw = require('../../services/mmkv').getString(key); // eslint-disable-line global-require
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
};
const _writeJSON = (key, val) => {
  try {
    const v = JSON.stringify(val);
    if (Platform.OS === 'web') { if (typeof localStorage !== 'undefined') localStorage.setItem(key, v); }
    else require('../../services/mmkv').setString(key, v); // eslint-disable-line global-require
  } catch {}
};
const _readRecentApps = () => { const v = _readJSON(RECENT_APPS_KEY, []); return Array.isArray(v) ? v : []; };
const _readAppUsage = () => { const v = _readJSON(APP_USAGE_KEY, {}); return v && typeof v === 'object' ? v : {}; };
const _readPinned = () => { const v = _readJSON(PINNED_APPS_KEY, []); return Array.isArray(v) ? v : []; };
const _bumpRecentApp = (key) => {
  const cur = _readRecentApps().filter(k => k !== key);
  cur.unshift(key);
  _writeJSON(RECENT_APPS_KEY, cur.slice(0, 8));
  try { const u = _readAppUsage(); u[key] = (u[key] || 0) + 1; _writeJSON(APP_USAGE_KEY, u); } catch {}
};

// Accent/diacritic-insensitive lowercase ("vídeo" ≈ "video").
const _norm = (s) => {
  try { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  catch { return String(s || '').toLowerCase(); }
};

const TILE = 60;
const STRIP_MAX = 8;
const COLS = 4;
const SIDE = 16; // inset horizontal das seções (faixa Recentes alinha com a grade)

// [2026-10-17 apps-drag] Arrastar-p/-fechar em QUALQUER ponto da folha (iOS/Android):
// RNGH Gesture.Pan simultâneo com o ScrollView (Gesture.Native) — a lista rola até o
// topo e, no MESMO gesto, a folha passa a descer 1:1. RNGH já está no binário (import
// estático em NotificationToast); callbacks no JS (runOnJS) movendo Animated nativo.
// Web: alça/cabeçalho via PanResponder (como antes). Kill: __chatyy_motion_sheet_drag=false.
let _GH = null;
if (Platform.OS !== 'web') {
  try { _GH = require('react-native-gesture-handler'); } catch { _GH = null; } // eslint-disable-line global-require
}
const GH_OK = !!(_GH && _GH.Gesture && _GH.Gesture.Pan && _GH.Gesture.Native && _GH.GestureDetector && _GH.GestureHandlerRootView);

function biaSuggestion(t, emailUnread) {
  const h = new Date().getHours();
  const hello = h < 12 ? t('one.goodMorning') : h < 18 ? t('one.goodAfternoon') : t('one.goodEvening');
  if (emailUnread > 0) return { hello, tip: t('one.todaySummary') };
  return { hello, tip: h < 12 ? t('one.todaySummary') : h < 18 ? t('one.unreadEmails') : t('one.tomorrowAgenda') };
}

// Squircle monocromático: gradiente vertical + brilho de vidro no topo.
const AppIcon = React.memo(function AppIcon({ Comp, isDark, size = TILE }) {
  const gid = isDark ? 'appsTileD' : 'appsTileL';
  const r = Math.round(size * 0.3);
  return (
    <View style={[st.icon, {
      width: size, height: size, borderRadius: r,
      backgroundColor: isDark ? '#1A1A1C' : '#F6F6F8',
      borderColor: isDark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.06)',
      ...(isDark ? null : { shadowColor: '#000', shadowOpacity: 0.09, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 2 }),
      ...(Platform.OS === 'web' ? { boxShadow: isDark ? 'inset 0 1px 0 rgba(255,255,255,0.08)' : '0 4px 12px rgba(0,0,0,0.07), 0 1px 2px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.9)' } : null),
    }]}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          <LinearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={isDark ? '#2E2E32' : '#FFFFFF'} stopOpacity="1" />
            <Stop offset="0.55" stopColor={isDark ? '#1E1E21' : '#F7F7F9'} stopOpacity="1" />
            <Stop offset="1" stopColor={isDark ? '#141416' : '#ECEDF0'} stopOpacity="1" />
          </LinearGradient>
          <LinearGradient id={`${gid}h`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#FFFFFF" stopOpacity={isDark ? '0.07' : '0.7'} />
            <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width={size} height={size} rx={r} ry={r} fill={`url(#${gid})`} />
        <Rect x="1" y="1" width={size - 2} height={size * 0.55} rx={r - 1} ry={r - 1} fill={`url(#${gid}h)`} />
      </Svg>
      {/* Glifo num View posicionado: no web um <svg> estático pintaria ATRÁS do fundo absoluto. */}
      <View style={{ position: 'relative' }} pointerEvents="none">
        <Comp size={Math.round(size * 0.44)} color={isDark ? '#F5F5F7' : '#111111'} />
      </View>
    </View>
  );
});

// Um app (faixa Recentes ou grade). Badge com pop; modo editar = tremor + marcador.
const _tileOuter = { alignSelf: 'stretch' };
const AppTile = React.memo(function AppTile({ item, badge, onPress, onLongPress, isDark, t, textColor, editing, pinned, seed, width, singleLine }) {
  const shown = badge > 99 ? '99+' : String(badge || '');
  const a11y = item.label + (badge ? ', ' + t('apps.badgeNew', { count: shown }) : '')
    + (editing ? ', ' + (pinned ? t('apps.unpin') : t('apps.pin')) : '');
  return (
    <View style={{ width, alignItems: 'center', paddingVertical: 8 }}>
      <TilePress
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={380}
        scaleTo={0.88}
        outerStyle={_tileOuter}
        style={{ alignItems: 'center', width: '100%' }}
        accessibilityRole="button"
        accessibilityLabel={a11y}
        testID={'apps-tile-' + item.key}
      >
        <Jiggle active={editing} seed={seed}>
          <View style={{ width: TILE, height: TILE }}>
            <AppIcon Comp={item.ic.Comp} isDark={isDark} />
            {!!badge && !editing && (
              <Pop popKey={shown} style={[st.badge, {
                backgroundColor: isDark ? '#FFFFFF' : '#0B0B0C',
                borderColor: isDark ? '#000000' : '#FFFFFF',
              }]}>
                <Text style={{ color: isDark ? '#000000' : '#FFFFFF', fontSize: 11, fontWeight: '800', letterSpacing: -0.2 }} numberOfLines={1}>{shown}</Text>
              </Pop>
            )}
            {editing && (
              <Pop popKey={pinned ? 'p' : 'u'} style={[st.editMark, {
                backgroundColor: pinned ? (isDark ? '#FFFFFF' : '#0B0B0C') : (isDark ? '#3A3A3E' : '#D9DADF'),
                borderColor: isDark ? '#000000' : '#FFFFFF',
              }]}>
                {pinned
                  ? <View style={{ width: 10, height: 2.2, borderRadius: 1.1, backgroundColor: isDark ? '#000000' : '#FFFFFF' }} />
                  : <IconPlus size={12} color={isDark ? '#FFFFFF' : '#111111'} />}
              </Pop>
            )}
          </View>
        </Jiggle>
        <Text style={[st.label, { color: textColor }]} numberOfLines={singleLine ? 1 : 2} ellipsizeMode="tail">{item.label}</Text>
      </TilePress>
    </View>
  );
});

function SectionTitle({ children, isDark }) {
  return (
    <Text style={[st.sectionTitle, { color: isDark ? '#8E8E93' : '#86868B' }]} accessibilityRole="header">
      {String(children || '').toUpperCase()}
    </Text>
  );
}

function AppsSheet({ visible, onClose, router, colors, isDark, t, userEmail, onOpenFeed, onOpenReels, onOpenChannels, onOpenCommunities, badges }) {
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(false);
  const [recentKeys, setRecentKeys] = useState(() => _readRecentApps());
  const [usageMap, setUsageMap] = useState(() => _readAppUsage());
  const [pinnedKeys, setPinnedKeys] = useState(() => _readPinned());
  // Cascata só na abertura: depois disso, item que surge (busca) entra sem atraso.
  const [openSeq, setOpenSeq] = useState(0);
  const introRef = useRef(false);
  useEffect(() => {
    if (visible) {
      setRecentKeys(_readRecentApps());
      setUsageMap(_readAppUsage());
      setPinnedKeys(_readPinned());
      setOpenSeq(n => n + 1);
      introRef.current = true;
      const tm = setTimeout(() => { introRef.current = false; }, 900);
      return () => clearTimeout(tm);
    }
    setQ('');
    setEditing(false);
    return undefined;
  }, [visible]);
  const delayFor = (ms) => (introRef.current ? Math.min(ms, 520) : 0);

  const I = (Comp, c) => ({ Comp, c });
  // [2026-10-15 native-sheets-v2] Sheet nativo: o pop da rota do sheet sai no
  // commit do onClose; o push vem logo depois — nunca empilhar EM CIMA do formSheet.
  const _afterClose = useCallback((fn) => { if (USE_NATIVE_SHEETS) setTimeout(fn, 60); else fn(); }, []);
  const go = useCallback((path) => () => { onClose(); _afterClose(() => { try { router.push(path); } catch (e) { console.warn('[apps] router.push failed:', e); } }); }, [onClose, router, _afterClose]);

  // `kw` = palavras extras de busca (pt/en/es). `featured` = vai no cartão (fica buscável).
  const sections = useMemo(() => ([
    {
      key: 'communication',
      title: t('apps.communication'),
      items: [
        { key: 'email',       label: t('apps.email'),        ic: I(IconMail),       route: '/inbox',     kw: 'email mail inbox caixa entrada correo' },
        { key: 'meet',        label: t('sidebar.meetings'),  ic: I(IconVideo),      route: '/meetings',  kw: 'meet reuniao meeting video chamada call reunion' },
        { key: 'channels',    label: t('channel.title'),     ic: I(IconMegaphone),  action: onOpenChannels,    kw: 'canais channels canales broadcast' },
        { key: 'communities', label: t('community.title'),   ic: I(IconUsersSmall), action: onOpenCommunities, kw: 'comunidades communities grupos groups' },
      ],
    },
    {
      key: 'social',
      title: t('apps.social'),
      items: [
        { key: 'reels',   label: t('apps.reels'),   ic: I(IconReels),     action: onOpenReels,  kw: 'reels videos curtos shorts tiktok video' },
        { key: 'feed',    label: t('apps.feed'),    ic: I(IconGrid),      action: onOpenFeed,   kw: 'feed posts publicacoes timeline' },
        { key: 'live',    label: t('apps.goLive'),  ic: I(IconBroadcast), route: '/live-broadcast', kw: 'live ao vivo transmissao stream en vivo' },
        { key: 'snapmap', label: t('snapmap.tile'), ic: I(IconMapPin),    route: '/snap-map',   kw: 'mapa map amigos friends localizacao location' },
      ],
    },
    {
      key: 'tools',
      title: t('apps.tools'),
      items: [
        { key: 'one',      label: 'Bia',                  ic: I(IconSparkles),   route: '/one', featured: true, kw: 'bia ia ai assistente assistant one' },
        { key: 'calendar', label: t('sidebar.calendar'),  ic: I(IconCalendar),   route: '/calendar',   kw: 'agenda calendario calendar eventos events' },
        { key: 'contacts', label: t('sidebar.contacts'),  ic: I(IconUsers),      route: '/contacts',   kw: 'contatos contacts agenda contactos' },
        { key: 'files',    label: t('sidebar.files'),     ic: I(IconFolder),     route: '/files',      kw: 'arquivos files cloud drive nuvem archivos' },
        { key: 'docs',     label: t('sidebar.documents'), ic: I(IconFileText),   route: '/documentos', kw: 'docs documentos documents planilhas sheets' },
        { key: 'notes',    label: t('sidebar.notes'),     ic: I(IconStickyNote), route: '/notes',      kw: 'notas notes anotacoes' },
        { key: 'tasks',    label: t('tasks.title'),       ic: I(IconCheckCircle), route: '/tasks',     kw: 'tarefas tasks todo afazeres pendentes tareas' },
        { key: 'photos',   label: t('sidebar.photos'),    ic: I(IconImage),      route: '/photos',     kw: 'fotos photos galeria gallery imagens' },
      ],
    },
    {
      key: 'account',
      title: t('apps.account'),
      items: [
        { key: 'profile', label: t('sidebar.profile'), ic: I(IconUser), kw: 'perfil profile conta account',
          action: () => { onClose(); if (userEmail) _afterClose(() => { try { router.push(`/u/${encodeURIComponent(userEmail)}`); } catch (e) { console.warn('[apps] router.push failed:', e); } }); } },
        // [2026-05-22 monetization-pause] wallet só com WALLET_ENABLED.
        ...(WALLET_ENABLED ? [{ key: 'wallet', label: t('apps.wallet'), ic: I(IconCreditCard), route: '/wallet', kw: 'carteira wallet saldo pagamentos' }] : []),
        { key: 'notifications', label: t('sidebar.notifications'), ic: I(IconBell),     route: '/notifications', kw: 'alertas notificacoes notifications' },
        { key: 'backup',        label: t('sidebar.backup'),        ic: I(IconShield),   route: '/backup',        kw: 'backup copia seguranca' },
        { key: 'settings',      label: t('sidebar.settings'),      ic: I(IconSettings), action: go('/settings'), kw: 'configuracoes settings ajustes preferencias' },
      ],
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ]), [t, onOpenFeed, onOpenReels, onOpenChannels, onOpenCommunities, onClose, router, userEmail, go]);

  const qn = _norm(q.trim());
  const filteredSections = useMemo(() => {
    const score = (k) => (usageMap?.[k] || 0);
    const base = qn
      ? sections.map(s => {
          const secHit = _norm(s.title).includes(qn);
          return { ...s, items: s.items.filter(i => secHit || _norm(i.label).includes(qn) || _norm(i.kw).includes(qn)) };
        })
      : sections.map(s => ({ ...s, items: s.items.filter(i => !i.featured) }));
    return base.filter(s => s.items.length > 0).map(s => ({ ...s, items: [...s.items].sort((a, b) => score(b.key) - score(a.key)) }));
  }, [qn, sections, usageMap]);

  const itemByKey = useMemo(() => {
    const m = new Map();
    for (const s of sections) for (const it of s.items) m.set(it.key, it);
    return m;
  }, [sections]);
  // Faixa Recentes: fixados primeiro (na ordem em que foram fixados), depois MRU.
  const stripItems = useMemo(() => {
    const out = []; const seen = new Set();
    for (const k of [...(pinnedKeys || []), ...(recentKeys || [])]) {
      if (seen.has(k)) continue;
      const it = itemByKey.get(k);
      if (!it) continue;
      seen.add(k); out.push(it);
      if (out.length >= STRIP_MAX) break;
    }
    return out;
  }, [pinnedKeys, recentKeys, itemByKey]);
  const pinnedSet = useMemo(() => new Set(pinnedKeys || []), [pinnedKeys]);
  const showStrip = !qn && stripItems.length > 0;
  // Badge só UMA vez: na faixa Recentes se o app estiver lá, senão na grade.
  const stripSet = useMemo(() => new Set(showStrip ? stripItems.map(i => i.key) : []), [showStrip, stripItems]);

  const setQuery = useCallback((v) => {
    prepareLayoutChange();
    if (v) setEditing(false);
    setQ(v);
  }, []);

  const togglePin = useCallback((key) => {
    try { haptic.select(); } catch {}
    prepareLayoutChange();
    setPinnedKeys((cur) => {
      const has = cur.includes(key);
      const next = has ? cur.filter(k => k !== key) : [...cur, key].slice(-STRIP_MAX);
      _writeJSON(PINNED_APPS_KEY, next);
      return next;
    });
  }, []);

  const enterEdit = useCallback(() => {
    try { haptic.medium(); } catch {}
    setEditing(true);
  }, []);

  const handlePress = useCallback((it) => {
    try { _bumpRecentApp(it.key); setUsageMap(_readAppUsage()); } catch {}
    if (it.action) { it.action(); return; }
    onClose();
    // [2026-10-12 snapmap-speed] start the friends query on TAP, not on mount.
    if (it.route === '/snap-map') { try { require('../../services/snapMapPrefetch').prefetchSnapMap(); } catch {} } // eslint-disable-line global-require
    _afterClose(() => { try { router.push(it.route); } catch (e) { console.warn('[apps] router.push failed:', e); } });
  }, [onClose, router, _afterClose]);

  const onTile = useCallback((it) => {
    if (editing) { togglePin(it.key); return; }
    handlePress(it);
  }, [editing, togglePin, handlePress]);

  // ── Apresentação do Modal JS (web / kill-switch do sheet nativo) ──────────
  // [hotfix-3] → [2026-10-16 wave7] volta ao formSheet nativo no iOS quando a
  // altura limitada ao detent está ativa (nativeSheetBoundedOn: binário wave 7+).
  // Força: globalThis.__chatyy_apps_native_sheet = true/false.
  const _NATIVE_SHEET = USE_NATIVE_SHEETS && (() => {
    try {
      const g = globalThis.__chatyy_apps_native_sheet;
      if (g === true || g === false) return g;
    } catch {}
    return false; // [2026-10-16 hotfix] modal próprio (folha nativa cortava no 697)
  })();
  const _winH = Dimensions.get('window').height || 800;
  const [mounted, setMounted] = useState(!!visible);
  const [openTick, setOpenTick] = useState(0);
  const backdropA = useRef(new Animated.Value(0)).current;
  const sheetY = useRef(new Animated.Value(_winH)).current;
  const dragY = useRef(new Animated.Value(0)).current;
  const sheetHRef = useRef(_winH);
  const closingByDragRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (_NATIVE_SHEET) return;
    if (visible) { closingByDragRef.current = false; setMounted(true); setOpenTick(n => n + 1); return; }
    if (!mounted) return;
    if (closingByDragRef.current) { sheetY.setValue(sheetHRef.current); dragY.setValue(0); setMounted(false); return; }
    Animated.parallel([
      Animated.timing(backdropA, { toValue: 0, duration: motionEnabled() ? Durations.exit : 0, easing: Easings.fadeOut, useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(sheetY, { toValue: sheetHRef.current, duration: motionEnabled() ? 220 : 0, easing: Easings.accelerate, useNativeDriver: Platform.OS !== 'web' }),
    ]).start(({ finished }) => { if (finished) setMounted(false); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  useEffect(() => {
    if (_NATIVE_SHEET || !mounted || !visible) return;
    dragY.setValue(0);
    Animated.parallel([
      Animated.timing(backdropA, { toValue: 1, duration: motionEnabled() ? 220 : 0, easing: Easings.fadeIn, useNativeDriver: Platform.OS !== 'web' }),
      motionEnabled()
        ? Animated.spring(sheetY, { toValue: 0, ...Springs.sheet, useNativeDriver: Platform.OS !== 'web' })
        : Animated.timing(sheetY, { toValue: 0, duration: 0, useNativeDriver: Platform.OS !== 'web' }),
    ]).start();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, openTick]);
  // Solta o arrasto: passou do limiar (distância/velocidade) → fecha com mola seguindo o
  // dedo; senão volta com mola. dy em px, vy em px/ms (mesma unidade do PanResponder).
  const settleDrag = useCallback((dy, vy) => {
    const useNative = Platform.OS !== 'web';
    if (dy > Gestures.sheetDismissDistance || vy > Gestures.sheetDismissVelocity) {
      closingByDragRef.current = true;
      try { haptic.light?.(); } catch {}
      // [2026-10-16 motion] continua com a velocidade do dedo (mola sem overshoot).
      Animated.parallel([
        Animated.spring(dragY, { toValue: sheetHRef.current, velocity: Math.max(0, vy) * 1000, ...Springs.sheet, overshootClamping: true, restDisplacementThreshold: 2, restSpeedThreshold: 40, useNativeDriver: useNative }),
        Animated.timing(backdropA, { toValue: 0, duration: 200, easing: Easings.fadeOut, useNativeDriver: useNative }),
      ]).start(() => { try { onCloseRef.current?.(); } catch {} });
    } else {
      Animated.spring(dragY, { toValue: 0, ...Springs.sheet, velocity: vy * 1000, useNativeDriver: useNative }).start();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Fallback (web / sem RNGH / kill switch): só alça + cabeçalho arrastam.
  const dragResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx) * 1.2,
    onPanResponderGrant: () => { dragY.stopAnimation(); },
    onPanResponderMove: (_e, g) => { dragY.setValue(Math.max(0, g.dy)); },
    onPanResponderRelease: (_e, g) => { settleDrag(Math.max(0, g.dy), g.vy); },
    onPanResponderTerminate: () => {
      Animated.spring(dragY, { toValue: 0, ...Springs.sheet, useNativeDriver: Platform.OS !== 'web' }).start();
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);
  // Folha inteira arrastável (nativo). Toque começado na alça/cabeçalho/busca arrasta
  // sempre; dentro da lista, só quando ela está no topo (scrollY<=0) e o dedo desce —
  // se a lista estava rolada, ela sobe até o topo e a folha assume no mesmo gesto.
  const scrollYRef = useRef(0);
  const topBlockHRef = useRef(0);
  const panStateRef = useRef({ active: false, base: 0, prev: 0, header: false });
  const sheetGesture = useMemo(() => {
    if (!GH_OK || !motionEnabled('sheet_drag')) return null;
    try {
      const native = _GH.Gesture.Native();
      const springBack = () => Animated.spring(dragY, { toValue: 0, ...Springs.sheet, useNativeDriver: true }).start();
      const pan = _GH.Gesture.Pan()
        .runOnJS(true)
        .activeOffsetY([-8, 8])
        .failOffsetX([-14, 14])
        .simultaneousWithExternalGesture(native)
        .onBegin((e) => {
          const g = panStateRef.current;
          g.active = false; g.base = 0; g.prev = 0;
          g.header = (e?.y ?? 0) < 8 + topBlockHRef.current; // paddingTop 8 + alça/cabeçalho/busca
        })
        .onUpdate((e) => {
          const g = panStateRef.current;
          const ty = e?.translationY || 0;
          if (!g.active && ty > g.prev && (g.header || scrollYRef.current <= 0.5)) {
            g.active = true;
            g.base = g.prev;
            dragY.stopAnimation();
            try { Keyboard.dismiss(); } catch {}
          }
          if (g.active) dragY.setValue(Math.max(0, ty - g.base));
          g.prev = ty;
        })
        .onEnd((e) => {
          const g = panStateRef.current;
          if (!g.active) return;
          g.active = false;
          settleDrag(Math.max(0, (e?.translationY || 0) - g.base), (e?.velocityY || 0) / 1000);
        })
        .onFinalize(() => {
          const g = panStateRef.current;
          if (g.active) { g.active = false; springBack(); } // cancelado (ex.: interrompido pelo sistema)
        });
      return { pan, native };
    } catch { return null; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Fundo esmaece proporcional à translação (0 → altura da folha = 1 → 0).
  const [sheetH, setSheetH] = useState(() => Math.round(_winH * 0.9));
  const backdropOpacity = Animated.multiply(backdropA, dragY.interpolate({ inputRange: [0, Math.max(200, sheetH)], outputRange: [1, 0], extrapolate: 'clamp' }));
  // Altura útil: a lista recebe maxHeight explícito (Yoga não encolhe filho só com
  // maxHeight no pai → a última fileira vazava abaixo da tela, sem rótulo).
  const [containerH, setContainerH] = useState(_winH);
  const [topBlockH, setTopBlockH] = useState(0);
  const listMaxH = Math.max(160, Math.floor(containerH * 0.9) - 8 - topBlockH);
  const { width: _winW } = useWindowDimensions();
  const stripCellW = Math.floor((Math.min(_winW || 375, 640) - SIDE * 2) / COLS);

  // Preto verdadeiro no escuro.
  const sheetBg = isDark ? '#000000' : '#FFFFFF';
  const fieldBg = isDark ? '#1C1C1E' : '#F0F0F2';
  const muted = isDark ? '#8E8E93' : '#86868B';
  const textColor = colors.text || (isDark ? '#F5F5F7' : '#111111');
  const emailUnread = Number(badges?.email || 0);
  const sug = useMemo(() => biaSuggestion(t, emailUnread), [t, emailUnread]);

  const headerEl = (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14, paddingHorizontal: 4 }}>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 30, fontWeight: '800', letterSpacing: -0.8, color: textColor }} accessibilityRole="header">
          {t('chat.apps')}
        </Text>
        <Text style={{ fontSize: 13.5, color: muted, marginTop: 1, letterSpacing: -0.1 }} numberOfLines={1}>
          {editing ? t('apps.editHint') : t('apps.subtitle')}
        </Text>
      </View>
      {editing ? (
        <Pop popKey="done">
          <PressableScale
            onPress={() => { try { haptic.select(); } catch {} setEditing(false); }}
            scaleTo={0.92}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t('common.done')}
            style={{ height: 34, paddingHorizontal: 16, borderRadius: 17, backgroundColor: isDark ? '#FFFFFF' : '#0B0B0C', alignItems: 'center', justifyContent: 'center' }}
          >
            <Text style={{ color: isDark ? '#000000' : '#FFFFFF', fontSize: 15, fontWeight: '700' }}>{t('common.done')}</Text>
          </PressableScale>
        </Pop>
      ) : (
        <PressableScale
          onPress={onClose}
          scaleTo={0.9}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
          style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: fieldBg, alignItems: 'center', justifyContent: 'center' }}
        >
          <IconClose size={17} color={isDark ? '#C7C7CC' : '#3A3A3C'} />
        </PressableScale>
      )}
    </View>
  );

  const searchEl = (
    <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: fieldBg, borderRadius: 14, paddingHorizontal: 12, height: 44, marginBottom: 16, ...(Platform.OS === 'ios' ? { borderCurve: 'continuous' } : null) }}>
      <IconSearch size={17} color={muted} />
      <TextInput
        value={q}
        onChangeText={setQuery}
        placeholder={t('apps.searchPlaceholder')}
        placeholderTextColor={muted}
        style={{ flex: 1, paddingVertical: 0, paddingHorizontal: 8, color: textColor, fontSize: 16, height: 44, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) }}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        accessibilityLabel={t('apps.searchPlaceholder')}
        testID="apps-search"
      />
      {!!q && (
        <Pop popKey="clear">
          <Pressable onPress={() => setQuery('')} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('apps.clearSearch')}
            style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: isDark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.25)', alignItems: 'center', justifyContent: 'center' }}>
            <IconClose size={11} color={isDark ? '#000000' : '#FFFFFF'} />
          </Pressable>
        </Pop>
      )}
    </View>
  );

  // Cartão da Bia — orb vivo + sugestão do momento + atalho de voz. Escuro nos 2 temas.
  const biaCardEl = (
    <AppsItem key="bia" enterDelay={delayFor(30)} style={{ marginBottom: 22 }}>
      <PressableScale
        onPress={() => { const one = itemByKey.get('one'); if (one) handlePress(one); }}
        scaleTo={0.975}
        style={{
          flexDirection: 'row', alignItems: 'center', gap: 14,
          backgroundColor: isDark ? '#141416' : '#0E0E10',
          borderRadius: 24, paddingVertical: 14, paddingLeft: 14, paddingRight: 14,
          borderWidth: isDark ? StyleSheet.hairlineWidth : 0, borderColor: 'rgba(255,255,255,0.10)',
          ...(Platform.OS === 'ios' ? { borderCurve: 'continuous' } : null),
          ...(isDark ? null : { shadowColor: '#000', shadowOpacity: 0.14, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 4 }),
        }}
        accessibilityRole="button"
        accessibilityLabel={`Bia, ${sug.hello}, ${sug.tip}`}
        testID="apps-bia-card"
      >
        <BiaOrb size={50} isDark />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
            <Text style={{ fontSize: 17, fontWeight: '700', color: '#FFFFFF', letterSpacing: -0.3 }}>Bia</Text>
            <View style={{ backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
              <Text style={{ fontSize: 9.5, fontWeight: '800', letterSpacing: 0.6, color: 'rgba(255,255,255,0.85)' }}>{t('chat.aiBadge') || 'IA'}</Text>
            </View>
          </View>
          <Text style={{ fontSize: 13.5, color: 'rgba(255,255,255,0.62)', marginTop: 3, letterSpacing: -0.1 }} numberOfLines={1}>
            <Text style={{ color: 'rgba(255,255,255,0.92)', fontWeight: '600' }}>{sug.hello}</Text>
            {` · ${sug.tip}`}
          </Text>
        </View>
        <PressableScale
          onPress={() => { try { _bumpRecentApp('one'); } catch {} go('/one?voice=1')(); }}
          scaleTo={0.88}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('one.voiceConversation')}
          style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' }}
        >
          <GlyphWave size={17} color="#000000" />
        </PressableScale>
      </PressableScale>
    </AppsItem>
  );

  const renderList = (nativeMode) => {
    let row = 0; // cursor de linha da cascata
    const rowDelay = () => 70 + (row++) * 55;
    const stripBase = showStrip ? rowDelay() : 0;
    const dragAll = !nativeMode && !!sheetGesture;
    const list = (
      <ScrollView
        key={'apps-list-' + openSeq}
        style={nativeMode ? { flex: 1 } : { flexGrow: 0, flexShrink: 1, maxHeight: listMaxH }}
        showsVerticalScrollIndicator={false}
        // [2026-10-17] paddingHorizontal AQUI (não no pai): a lista vai de borda a borda e a faixa
        // Recentes pode sangrar até a borda sem ser recortada; respiro inferior p/ a última fileira.
        contentContainerStyle={{ paddingHorizontal: SIDE, paddingBottom: nativeMode ? nativeSheetBottomPad(insets, 28) : Math.max(insets.bottom, 12) + 32 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        onScroll={(e) => { scrollYRef.current = e?.nativeEvent?.contentOffset?.y || 0; }}
        scrollEventThrottle={16}
        // No topo, puxar p/ baixo arrasta a FOLHA (não estica a lista).
        bounces={dragAll ? false : undefined}
        overScrollMode={dragAll ? 'never' : undefined}
      >
        {/* [2026-10-15 hotfix-2] No formSheet nativo, cabeçalho + busca ficam DENTRO da rolagem (uma coluna só):
            irmãos fora do ScrollView eram sobrepostos pela lista no iPhone (título sumia, busca por cima de Recentes). */}
        {nativeMode && headerEl}
        {nativeMode && searchEl}
        {!qn && biaCardEl}
        {showStrip && (
          <AppsItem key="strip" enterDelay={delayFor(stripBase - 20)} style={{ marginBottom: 14 }}>
            <SectionTitle isDark={isDark}>{t('apps.recent')}</SectionTitle>
            {/* Borda a borda (o pai rolável tem paddingHorizontal SIDE e não recorta além da folha);
                1º item alinha com a 1ª coluna da grade. Antes: margem -16 fora do recorte da lista → "lapa de amigos". */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ marginHorizontal: -SIDE }}
              contentContainerStyle={{ paddingHorizontal: SIDE }}
            >
              {stripItems.map((it, i) => (
                <AppsItem key={it.key} enterDelay={delayFor(stripBase + i * 28)}>
                  <AppTile
                    item={it}
                    badge={editing ? 0 : (badges?.[it.key] || 0)}
                    onPress={() => onTile(it)}
                    onLongPress={editing ? undefined : enterEdit}
                    isDark={isDark}
                    t={t}
                    textColor={textColor}
                    editing={editing}
                    pinned={pinnedSet.has(it.key)}
                    seed={i}
                    width={stripCellW}
                    singleLine
                  />
                </AppsItem>
              ))}
            </ScrollView>
          </AppsItem>
        )}
        {filteredSections.length === 0 ? (
          <AppsItem key="empty" style={{ alignItems: 'center', paddingVertical: 44 }}>
            <View style={{ width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', backgroundColor: fieldBg, marginBottom: 12 }}>
              <IconSearch size={26} color={muted} />
            </View>
            <Text style={{ color: muted, fontSize: 15 }}>{t('apps.noResults')}</Text>
          </AppsItem>
        ) : filteredSections.map((section) => {
          const secRow = row;
          const rows = Math.ceil(section.items.length / COLS);
          const delays = section.items.map((_, i) => 70 + (secRow + Math.floor(i / COLS)) * 55 + (i % COLS) * 22);
          row += rows;
          return (
            <AppsItem key={'sec-' + section.key} enterDelay={delayFor(70 + secRow * 55 - 30)} style={{ marginBottom: 14 }}>
              <SectionTitle isDark={isDark}>{section.title}</SectionTitle>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{/* [polish3] sem margem -4: a 4ª coluna vazava 4 px além do recorte e cortava o rótulo ("Mapa de amigo|s") */}
                {section.items.map((it, i) => (
                  <AppsItem key={it.key} enterDelay={delayFor(delays[i])} style={{ width: '25%' }}>
                    <AppTile
                      item={it}
                      badge={stripSet.has(it.key) ? 0 : (editing ? 0 : (badges?.[it.key] || 0))}
                      onPress={() => onTile(it)}
                      onLongPress={editing ? undefined : enterEdit}
                      isDark={isDark}
                      t={t}
                      textColor={textColor}
                      editing={editing}
                      pinned={pinnedSet.has(it.key)}
                      seed={i + secRow * COLS}
                      width="100%"
                    />
                  </AppsItem>
                ))}
              </View>
            </AppsItem>
          );
        })}
      </ScrollView>
    );
    return dragAll ? <_GH.GestureDetector gesture={sheetGesture.native}>{list}</_GH.GestureDetector> : list;
  };

  // [2026-10-15 hotfix-3] formSheet nativo: lista sumia (painel branco) / sobrepunha no iPhone →
  // painel volta ao modal próprio (caminho testado). Religar p/ teste: globalThis.__chatyy_apps_native_sheet = true.
  if (_NATIVE_SHEET) {
    return (
      <NativeSheet visible={!!visible} onClose={onClose} detents={[0.62, 1]} backgroundColor={sheetBg}>
        <NativeSheetKeyboardView style={{ flex: 1, paddingTop: 22, backgroundColor: sheetBg }}>
          {renderList(true)}
        </NativeSheetKeyboardView>
      </NativeSheet>
    );
  }

  if (!mounted) return null;

  const sheetEl = (
    <Animated.View
      onLayout={(e) => {
        const h = e?.nativeEvent?.layout?.height;
        if (h > 0) { sheetHRef.current = h + 40; if (Math.abs(h - sheetH) > 1) setSheetH(h); }
      }}
      style={{
        transform: [{ translateY: Animated.add(sheetY, dragY) }],
        backgroundColor: sheetBg,
        borderTopLeftRadius: 30,
        borderTopRightRadius: 30,
        paddingTop: 8,
        maxHeight: '90%',
        width: '100%', maxWidth: 640, alignSelf: 'center',
        ...(isDark ? { borderTopWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.10)' } : null),
        ...(Platform.OS === 'web' ? { boxShadow: '0 -8px 32px rgba(0,0,0,0.18)' } : {}),
      }}
      accessibilityViewIsModal
    >
      {/* Alça + cabeçalho + busca (inset SIDE). Sem RNGH: alça/cabeçalho = PanResponder;
          com RNGH a folha INTEIRA arrasta (GestureDetector abaixo). */}
      <View
        style={{ paddingHorizontal: SIDE }}
        onLayout={(e) => {
          const h = e?.nativeEvent?.layout?.height;
          if (h > 0) { topBlockHRef.current = h; if (Math.abs(h - topBlockH) > 1) setTopBlockH(h); }
        }}
      >
        <View {...(sheetGesture ? null : dragResponder.panHandlers)}>
          <View style={{ alignItems: 'center', marginBottom: 10, paddingTop: 2, paddingBottom: 2 }}>
            <View style={{ width: 38, height: 5, borderRadius: 3, backgroundColor: isDark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.14)' }} />
          </View>
          {headerEl}
        </View>
        {searchEl}
      </View>
      {renderList(false)}
    </Animated.View>
  );
  const Root = GH_OK ? _GH.GestureHandlerRootView : View;

  return (
    <Modal visible={mounted} transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <Root style={{ flex: 1 }}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <View
            style={{ flex: 1, justifyContent: 'flex-end' }}
            onLayout={(e) => { const h = e?.nativeEvent?.layout?.height; if (h > 0 && Math.abs(h - containerH) > 1) setContainerH(h); }}
          >
            <Animated.View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: backdropOpacity }}>
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel={t('common.close')}
                style={{
                  position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                  backgroundColor: isDark ? 'rgba(0,0,0,0.66)' : 'rgba(10,10,18,0.38)',
                  ...(Platform.OS === 'web' ? { backdropFilter: 'blur(8px) saturate(120%)', WebkitBackdropFilter: 'blur(8px) saturate(120%)', cursor: 'default' } : {}),
                }}
              />
            </Animated.View>
            {sheetGesture ? <_GH.GestureDetector gesture={sheetGesture.pan}>{sheetEl}</_GH.GestureDetector> : sheetEl}
          </View>
        </KeyboardAvoidingView>
      </Root>
    </Modal>
  );
}

const st = StyleSheet.create({
  icon: {
    alignItems: 'center', justifyContent: 'center', overflow: Platform.OS === 'web' ? 'hidden' : 'visible',
    borderWidth: StyleSheet.hairlineWidth,
    ...(Platform.OS === 'ios' ? { borderCurve: 'continuous' } : null),
  },
  badge: {
    position: 'absolute', top: -6, right: -9,
    minWidth: 22, height: 22, paddingHorizontal: 6,
    borderRadius: 11, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  editMark: {
    position: 'absolute', top: -7, left: -7,
    width: 24, height: 24, borderRadius: 12, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  label: { width: '100%', fontSize: 12, lineHeight: 15, fontWeight: '500', textAlign: 'center', marginTop: 8, paddingHorizontal: 2, letterSpacing: -0.1 },
  sectionTitle: { fontSize: 12, fontWeight: '600', letterSpacing: 0.9, marginBottom: 6, paddingHorizontal: 6 },
});

export default React.memo(AppsSheet);
