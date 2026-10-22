// [2026-10-15 apps-v3] Painel "Apps" (aba Apps do /chat) — extraído de app/chat.js.
//
// [2026-10-18 apps-compact] Redesenho estilo Outlook mobile (pedido do founder:
// "tira Recentes, deixa menor, mais compacto e mais bonito"):
//   • folha compacta = só a altura do conteúdo (alça + "Apps" pequeno + fechar);
//   • UMA grade 4 colunas, ordem fixa (memória muscular), sem títulos de seção;
//   • sem faixa Recentes, sem cartão grande da Bia (Bia = ladrilho normal com o orb),
//     sem busca (20 apps cabem numa tela), sem modo editar/fixar;
//   • ladrilho 48 pt em squircle suave P&B + rótulo 12 pt; badge = pílula pequena (99+);
//   • motion: cascata leve ao abrir + micro-bounce no toque (components/apps/appsMotion*).
// Nativo (ChatyyAppsGrid api ≥ 2) desenha a mesma grade; binário antigo (api 1, que
// ainda tinha Bia/Recentes) cai nesta grade JS. Rotas/ações iguais às de antes.
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet, Platform, Animated, Dimensions, Modal, Pressable, PanResponder, Keyboard } from 'react-native';
import KeyboardSafeView from '../ui/KeyboardSafeView'; // [2026-10-22 kb-uniforme]
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import {
  IconMail, IconCalendar, IconFolder, IconFileText, IconStickyNote,
  IconImage, IconVideo, IconUser, IconGrid,
  IconMapPin, IconMegaphone, IconUsersSmall, IconReels, IconBroadcast,
  IconCheckCircle, IconX as IconClose,
} from '../Icons';
import PressableScale from '../PressableScale';
import { haptic } from '../../constants/theme';
import { Springs, Durations, Easings, Gestures, motionEnabled } from '../../constants/motion'; // [2026-10-16 motion]
import { USE_NATIVE_SHEETS, NativeSheet, NativeSheetKeyboardView, nativeSheetBottomPad } from '../NativeSheet';
import { AppsItem, Pop, TilePress } from './appsMotion';
// [2026-10-18 native-apps-grid] Grade NATIVA (UICollectionView / RecyclerView) quando o
// binário tem a view ChatyyAppsGrid (api ≥ 2). Kill: globalThis.__chatyy_native_apps = false.
import NativeAppsGrid, { nativeAppsEnabled, markNativeAppsFailed } from './NativeAppsGrid';

const TILE = 48;
const COLS = 4;
const SIDE = 16;
const NATIVE_TILE_H = 90; // = tileH do ChatyyAppsGridView (iOS/Android)

// [2026-10-17 apps-drag] Arrastar-p/-fechar em QUALQUER ponto da folha (iOS/Android):
// RNGH Gesture.Pan simultâneo com o ScrollView (Gesture.Native). Web: alça/cabeçalho
// via PanResponder. Kill: __chatyy_motion_sheet_drag=false.
let _GH = null;
if (Platform.OS !== 'web') {
  try { _GH = require('react-native-gesture-handler'); } catch { _GH = null; } // eslint-disable-line global-require
}
const GH_OK = !!(_GH && _GH.Gesture && _GH.Gesture.Pan && _GH.Gesture.Native && _GH.GestureDetector && _GH.GestureHandlerRootView);

// Squircle monocromático suave: gradiente vertical + brilho de vidro no topo.
const AppIcon = React.memo(function AppIcon({ Comp, isDark, size = TILE }) {
  const gid = isDark ? 'appsTileD' : 'appsTileL';
  const r = Math.round(size * 0.29);
  return (
    <View style={[st.icon, {
      width: size, height: size, borderRadius: r,
      backgroundColor: isDark ? '#1A1A1C' : '#F6F6F8',
      borderColor: isDark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.06)',
      ...(isDark ? null : { shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 1 }),
      ...(Platform.OS === 'web' ? { boxShadow: isDark ? 'inset 0 1px 0 rgba(255,255,255,0.08)' : '0 2px 6px rgba(0,0,0,0.06), 0 1px 1px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.9)' } : null),
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
        {Comp.__fillsTile
          ? <Comp size={Math.round(size * 0.56)} />
          : <Comp size={Math.round(size * 0.42)} color={isDark ? '#F5F5F7' : '#111111'} />}
      </View>
    </View>
  );
});

// Um app da grade. Badge = pílula pequena com pop.
const _tileOuter = { alignSelf: 'stretch' };
const AppTile = React.memo(function AppTile({ item, badge, onPress, isDark, t, textColor }) {
  const shown = badge > 99 ? '99+' : String(badge || '');
  const a11y = item.label + (badge ? ', ' + t('apps.badgeNew', { count: shown }) : '');
  return (
    <View style={{ width: '100%', alignItems: 'center', paddingTop: 6, paddingBottom: 4 }}>
      <TilePress
        onPress={onPress}
        scaleTo={0.92}
        outerStyle={_tileOuter}
        style={{ alignItems: 'center', width: '100%' }}
        accessibilityRole="button"
        accessibilityLabel={a11y}
        testID={'apps-tile-' + item.key}
      >
        <View style={{ width: TILE, height: TILE }}>
          <AppIcon Comp={item.ic.Comp} isDark={isDark} />
          {!!badge && (
            <Pop popKey={shown} style={[st.badge, {
              backgroundColor: isDark ? '#FFFFFF' : '#0B0B0C',
              borderColor: isDark ? '#000000' : '#FFFFFF',
            }]}>
              <Text style={{ color: isDark ? '#000000' : '#FFFFFF', fontSize: 10, fontWeight: '700', letterSpacing: -0.2 }} numberOfLines={1}>{shown}</Text>
            </Pop>
          )}
        </View>
        <Text style={[st.label, { color: textColor }]} numberOfLines={2} ellipsizeMode="tail">{item.label}</Text>
      </TilePress>
    </View>
  );
});

function AppsSheet({ visible, onClose, router, colors, isDark, t, userEmail, desktop, onOpenFeed, onOpenReels, onOpenChannels, onOpenCommunities, badges, tabsV2 = false }) {
  const insets = useSafeAreaInsets();
  // Cascata só na abertura.
  const [openSeq, setOpenSeq] = useState(0);
  const introRef = useRef(false);
  useEffect(() => {
    if (!visible) return undefined;
    setOpenSeq(n => n + 1);
    introRef.current = true;
    const tm = setTimeout(() => { introRef.current = false; }, 700);
    return () => clearTimeout(tm);
  }, [visible]);
  const delayFor = (ms) => (introRef.current ? Math.min(ms, 360) : 0);

  const I = (Comp) => ({ Comp });
  // [2026-10-15 native-sheets-v2] Sheet nativo: o pop da rota do sheet sai no
  // commit do onClose; o push vem logo depois — nunca empilhar EM CIMA do formSheet.
  const _afterClose = useCallback((fn) => { if (USE_NATIVE_SHEETS) setTimeout(fn, 60); else fn(); }, []);
  const go = useCallback((path) => () => { onClose(); _afterClose(() => { try { router.push(path); } catch (e) { console.warn('[apps] router.push failed:', e); } }); }, [onClose, router, _afterClose]);

  // [2026-10-18 apps-compact] Lista ÚNICA, ordem fixa: mais usados primeiro
  // (comunicação → produtividade → arquivos → social → conta).
  // [2026-10-18 apps-lean] founder: o Apps NÃO repete o que já está a 1 toque
  // em outro lugar. Fora no celular: E-mail + Reels (barra de baixo), Bia (card
  // na home), Comunidades + Canais (pílulas da home / chip "Canais" / "+"),
  // Contatos ("+" → Novo contato; sidebar do e-mail), Perfil + Ajustes +
  // Carteira + Backup (tudo na tela "Você" = /settings, avatar da home),
  // Notificações (sino do Feed). No desktop web a barra lateral só tem
  // Conversas/Ligações/Feed e não há avatar/pílulas → lá ficam E-mail, Reels,
  // Canais, Comunidades e "Você" (→ /settings); Feed sai (já é aba).
  const items = useMemo(() => (desktop ? [
    { key: 'email',       label: t('apps.email'),        ic: I(IconMail),        route: '/inbox' },
    { key: 'calendar',    label: t('sidebar.calendar'),  ic: I(IconCalendar),    route: '/calendar' },
    { key: 'meet',        label: t('sidebar.meetings'),  ic: I(IconVideo),       route: '/meetings' },
    { key: 'files',       label: t('sidebar.files'),     ic: I(IconFolder),      route: '/files' },
    { key: 'photos',      label: t('sidebar.photos'),    ic: I(IconImage),       route: '/photos' },
    { key: 'docs',        label: t('sidebar.documents'), ic: I(IconFileText),    route: '/documentos' },
    { key: 'notes',       label: t('sidebar.notes'),     ic: I(IconStickyNote),  route: '/notes' },
    { key: 'tasks',       label: t('tasks.title'),       ic: I(IconCheckCircle), route: '/tasks' },
    { key: 'channels',    label: t('channel.title'),     ic: I(IconMegaphone),   action: onOpenChannels },
    { key: 'communities', label: t('community.title'),   ic: I(IconUsersSmall),  action: onOpenCommunities },
    { key: 'reels',       label: t('apps.reels'),        ic: I(IconReels),       action: onOpenReels },
    { key: 'live',        label: t('apps.goLive'),       ic: I(IconBroadcast),   route: '/live-broadcast' },
    { key: 'snapmap',     label: t('snapmap.tile'),      ic: I(IconMapPin),      route: '/snap-map' },
    { key: 'profile',     label: t('sidebar.profile'),   ic: I(IconUser),        action: go('/settings') },
  ] : [
    // [tabs-v2 2026-10-20] Opção A: Email saiu da barra de baixo → 1º da grade, com o selo de não lidos.
    ...(tabsV2 ? [{ key: 'email', label: t('apps.email'), ic: I(IconMail), route: '/inbox' }] : []),
    { key: 'calendar',    label: t('sidebar.calendar'),  ic: I(IconCalendar),    route: '/calendar' },
    { key: 'meet',        label: t('sidebar.meetings'),  ic: I(IconVideo),       route: '/meetings' },
    { key: 'files',       label: t('sidebar.files'),     ic: I(IconFolder),      route: '/files' },
    // [2026-10-18] Fotos sai do Apps no celular: já tem atalho no topo da home.
    { key: 'docs',        label: t('sidebar.documents'), ic: I(IconFileText),    route: '/documentos' },
    { key: 'notes',       label: t('sidebar.notes'),     ic: I(IconStickyNote),  route: '/notes' },
    { key: 'tasks',       label: t('tasks.title'),       ic: I(IconCheckCircle), route: '/tasks' },
    // [tabs-v2 2026-10-20] com a aba Mural na barra, o Feed antigo sai da grade.
    ...(tabsV2 ? [] : [{ key: 'feed', label: t('apps.feed'), ic: I(IconGrid), action: onOpenFeed }]),
    // [2026-10-19 home-clean] Comunidades + Canais saíram das pílulas do topo da home → aqui.
    { key: 'communities', label: t('community.title'),   ic: I(IconUsersSmall),  action: onOpenCommunities },
    { key: 'channels',    label: t('channel.title'),     ic: I(IconMegaphone),   action: onOpenChannels },
    { key: 'live',        label: t('apps.goLive'),       ic: I(IconBroadcast),   route: '/live-broadcast' },
    { key: 'snapmap',     label: t('snapmap.tile'),      ic: I(IconMapPin),      route: '/snap-map' },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ]), [t, desktop, tabsV2, onOpenFeed, onOpenReels, onOpenChannels, onOpenCommunities, go]);

  const itemByKey = useMemo(() => {
    const m = new Map();
    for (const it of items) m.set(it.key, it);
    return m;
  }, [items]);

  const handlePress = useCallback((it) => {
    if (it.action) { it.action(); return; }
    onClose();
    // [2026-10-12 snapmap-speed] start the friends query on TAP, not on mount.
    if (it.route === '/snap-map') { try { require('../../services/snapMapPrefetch').prefetchSnapMap(); } catch {} } // eslint-disable-line global-require
    _afterClose(() => { try { router.push(it.route); } catch (e) { console.warn('[apps] router.push failed:', e); } });
  }, [onClose, router, _afterClose]);

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

  // Preto verdadeiro no escuro.
  const sheetBg = isDark ? '#000000' : '#FFFFFF';
  const fieldBg = isDark ? '#1C1C1E' : '#F0F0F2';
  const textColor = colors.text || (isDark ? '#F5F5F7' : '#111111');

  // ── [2026-10-18 native-apps-grid] Grade nativa ─────────────────────────────
  // Só a grade vem da view nativa; aqui fica a folha (Modal, alça, cabeçalho).
  // Falhou → volta p/ a grade JS na hora.
  const [nativeOk, setNativeOk] = useState(() => nativeAppsEnabled());
  const useNativeGrid = nativeOk && !_NATIVE_SHEET;
  const [nativeH, setNativeH] = useState(0);
  const onNativeFailure = useCallback((msg) => { markNativeAppsFailed(msg); setNativeOk(false); }, []);
  const nativeSections = useMemo(() => {
    if (!useNativeGrid) return null;
    return [{
      key: 'all',
      title: '', // sem cabeçalho (api 2 só desenha título não-vazio)
      items: items.map((it) => ({
        id: it.key, t: it.label, n: it.label, feat: (tabsV2 && it.key === 'email') ? 1 : 0, // [tabs-v2 2026-10-20]
        // [2026-10-18 bia-orb-icon] Bia = orb pelo id 'one' (sf = fallback).
        ...(it.key === 'one' ? { sf: 'circle.fill' } : null),
      })),
    }];
  }, [useNativeGrid, items]);
  const nativeLabels = useMemo(() => ({
    noResults: t('apps.noResults'),
    badgeNew: t('apps.badgeNew', { count: '{count}' }),
  }), [t]);
  const nativeBadges = useMemo(() => {
    const out = {};
    if (badges && typeof badges === 'object') {
      for (const k of Object.keys(badges)) { const n = Number(badges[k]) || 0; if (n > 0) out[k] = n; }
    }
    return out;
  }, [badges]);
  const onNativeApp = useCallback((id, voice) => {
    if (voice) { go('/one?voice=1')(); return; }
    const it = itemByKey.get(id);
    if (it) handlePress(it);
  }, [itemByKey, handlePress, go]);
  const nativeBottom = Math.max(insets.bottom, 12) + 4;
  // Altura estimada até o 1º onContentHeight (mesmas medidas do nativo: linhas × 90 +
  // respiro da seção 6 + inset + 8).
  const nativeEstH = Math.ceil(items.length / COLS) * NATIVE_TILE_H + 6 + nativeBottom + 8;
  const _noop = useCallback(() => {}, []);

  const headerEl = (
    <View style={{ flexDirection: 'row', alignItems: 'center', height: 36, marginBottom: 4, paddingHorizontal: 4 }}>
      <Text style={{ flex: 1, fontSize: 17, fontWeight: '700', letterSpacing: -0.3, color: textColor }} accessibilityRole="header">
        {t('chat.apps')}
      </Text>
      <PressableScale
        onPress={onClose}
        scaleTo={0.9}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={t('common.close')}
        style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: fieldBg, alignItems: 'center', justifyContent: 'center' }}
      >
        <IconClose size={15} color={isDark ? '#C7C7CC' : '#3A3A3C'} />
      </PressableScale>
    </View>
  );

  const renderList = (nativeMode) => {
    const dragAll = !nativeMode && !!sheetGesture;
    const list = (
      <ScrollView
        key={'apps-list-' + openSeq}
        style={nativeMode ? { flex: 1 } : { flexGrow: 0, flexShrink: 1, maxHeight: listMaxH }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: SIDE - 4, paddingBottom: nativeMode ? nativeSheetBottomPad(insets, 20) : Math.max(insets.bottom, 12) + 8 }}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        onScroll={(e) => { scrollYRef.current = e?.nativeEvent?.contentOffset?.y || 0; }}
        scrollEventThrottle={16}
        // No topo, puxar p/ baixo arrasta a FOLHA (não estica a lista).
        bounces={dragAll ? false : undefined}
        overScrollMode={dragAll ? 'never' : undefined}
      >
        {/* [2026-10-15 hotfix-2] No formSheet nativo o cabeçalho fica DENTRO da rolagem (uma coluna só). */}
        {nativeMode && <View style={{ paddingHorizontal: 4 }}>{headerEl}</View>}
        {/* [polish3] sem margem negativa: a 4ª coluna vazava e cortava o rótulo. */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {items.map((it, i) => (
            <AppsItem key={it.key} enterDelay={delayFor(30 + Math.floor(i / COLS) * 40 + (i % COLS) * 16)} style={{ width: '25%' }}>
              <AppTile
                item={it}
                badge={badges?.[it.key] || 0}
                onPress={() => handlePress(it)}
                isDark={isDark}
                t={t}
                textColor={textColor}
              />
            </AppsItem>
          ))}
        </View>
      </ScrollView>
    );
    return dragAll ? <_GH.GestureDetector gesture={sheetGesture.native}>{list}</_GH.GestureDetector> : list;
  };

  // [2026-10-15 hotfix-3] formSheet nativo só por flag (globalThis.__chatyy_apps_native_sheet = true).
  if (_NATIVE_SHEET) {
    return (
      <NativeSheet visible={!!visible} onClose={onClose} detents={[0.62, 1]} backgroundColor={sheetBg}>
        <NativeSheetKeyboardView style={{ flex: 1, paddingTop: 18, backgroundColor: sheetBg }}>
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
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        paddingTop: 6,
        maxHeight: '90%',
        width: '100%', maxWidth: 560, alignSelf: 'center',
        ...(Platform.OS === 'ios' ? { borderCurve: 'continuous' } : null),
        ...(isDark ? { borderTopWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.10)' } : null),
        ...(Platform.OS === 'web' ? { boxShadow: '0 -8px 32px rgba(0,0,0,0.18)' } : {}),
      }}
      accessibilityViewIsModal
    >
      {/* Alça + cabeçalho. Sem RNGH: alça/cabeçalho = PanResponder; com RNGH a folha
          INTEIRA arrasta (GestureDetector abaixo). */}
      <View
        style={{ paddingHorizontal: SIDE }}
        onLayout={(e) => {
          const h = e?.nativeEvent?.layout?.height;
          if (h > 0) { topBlockHRef.current = h; if (Math.abs(h - topBlockH) > 1) setTopBlockH(h); }
        }}
      >
        <View {...(sheetGesture && !useNativeGrid ? null : dragResponder.panHandlers)}>
          <View style={{ alignItems: 'center', marginBottom: 4, paddingTop: 2, paddingBottom: 2 }}>
            <View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: isDark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.14)' }} />
          </View>
          {headerEl}
        </View>
      </View>
      {useNativeGrid ? (
        <NativeAppsGrid
          style={{ width: '100%', height: Math.max(120, Math.min(nativeH || nativeEstH, listMaxH)) }}
          sections={nativeSections}
          recent={[]}
          pinned={[]}
          badges={nativeBadges}
          labels={nativeLabels}
          isDark={isDark}
          editing={false}
          bottomInset={nativeBottom}
          resetSeq={openSeq}
          searchEnabled={false}
          onAppPress={onNativeApp}
          onEditingChange={_noop}
          onPinnedChange={_noop}
          onContentHeight={setNativeH}
          onPullDismiss={onClose}
          onFailure={onNativeFailure}
        />
      ) : renderList(false)}
    </Animated.View>
  );
  const Root = GH_OK ? _GH.GestureHandlerRootView : View;

  return (
    <Modal visible={mounted} transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <Root style={{ flex: 1 }}>
        <KeyboardSafeView style={{ flex: 1 }}>
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
                  backgroundColor: isDark ? 'rgba(0,0,0,0.6)' : 'rgba(10,10,18,0.32)',
                  ...(Platform.OS === 'web' ? { backdropFilter: 'blur(6px) saturate(120%)', WebkitBackdropFilter: 'blur(6px) saturate(120%)', cursor: 'default' } : {}),
                }}
              />
            </Animated.View>
            {sheetGesture && !useNativeGrid ? <_GH.GestureDetector gesture={sheetGesture.pan}>{sheetEl}</_GH.GestureDetector> : sheetEl}
          </View>
        </KeyboardSafeView>
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
    position: 'absolute', top: -5, right: -8,
    minWidth: 18, height: 18, paddingHorizontal: 5,
    borderRadius: 9, borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center',
  },
  label: { width: '100%', fontSize: 12, lineHeight: 15, fontWeight: '500', textAlign: 'center', marginTop: 6, paddingHorizontal: 2, letterSpacing: -0.1 },
});

export default React.memo(AppsSheet);
