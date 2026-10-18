// /settings — hub das Configurações.
//
// [2026-10-15 settings-split] A raiz agora só renderiza o HERO (perfil +
// cartões Chatyy One/Carteira/Contas/Dispositivos) e a LISTA de categorias
// (+ busca). Cada categoria é um componente em components/settings/categories/
// carregado sob demanda, com estado LOCAL — antes este arquivo tinha 5 mil
// linhas e 104 useState num componente só (qualquer toggle re-renderizava a
// tela inteira; a abertura montava todas as categorias escondidas).
//
// Lista da raiz NATIVA (iOS UICollectionView em cartões / Android
// RecyclerView) via modules/expo-chat-conversation-list (view
// ChatyySettingsList) — o hero continua JS como cabeçalho (filho RN), como a
// home. Desligar por OTA: globalThis.__chatyy_native_settings = false; erro
// nativo/render → volta sozinho para a lista JS (mesmo visual).
import ErrorBoundary from '../components/ErrorBoundary';
import { Suspense, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Platform, BackHandler, Animated,
} from 'react-native';
import UIRefreshControl from '../components/ui/RefreshControl'; // [2026-10-16 motion] P&B + toque soft ao armar
import { HapticsCompat as Haptics } from '../services/haptics';
import AccountSwitcherSheet from '../components/AccountSwitcherSheet';
import FadeSlideIn from '../components/FadeSlideIn';
import { SettingsGroup, SettingsRow, SettingsSearchContext, useGroupedColors } from '../components/settings/SettingsKit';
import { SettingsHero, SettingsSpecialCards } from '../components/settings/SettingsHero';
import { isReduceMotionEnabled } from '../components/reducedMotion';
import { useRouter, useLocalSearchParams, useFocusEffect, Stack } from 'expo-router';
import { USE_NATIVE_HEADER, nativeHeaderOptions, HeaderBackButton, useBlurHeaderInset, nativeListLargeTitleOn } from '../components/nativeHeader';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useResponsive } from '../utils/responsive';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../components/ConfirmModal';
import { SELECTABLE_LOCALES, LANGUAGES as I18N_LANGUAGES } from '../i18n';
import { FontSize, Spacing, BorderRadius, LetterSpacing } from '../constants/theme';
import {
  IconArrowLeft, IconSparkles, IconMessageSquare, IconGlobe, IconBell, IconShield, IconUser,
  IconMail, IconDatabase, IconX, IconHelpCircle, IconSearch, IconUserPlus, IconType,
} from '../components/Icons';
import * as settingsCache from '../services/settingsCache';
import { useWallet, refreshWallet } from '../services/diamonds';
import { WALLET_ENABLED } from '../constants/featureFlags';
import Constants from 'expo-constants';
import {
  CATEGORY_GROUPS, GROUP_HEADER_KEYS, CATEGORY_META, categoryTitle, sectionToCategory,
  getCategoryComponent, preloadCategory,
} from '../components/settings/categories';
import { SettingsHostContext, normalizePrivacy, privacyValueLabel, pushLevelOf, emitSettingsRefresh, useSection } from '../components/settings/categories/shared';
import { buildSearchIndex, filterSearchIndex } from '../components/settings/categories/searchIndex';
import NativeSettingsList, { isNativeSettingsListAvailable } from '../components/settings/NativeSettingsList';
import SettingsCategoryScreen from '../components/settings/SettingsCategoryScreen';
import { isNativeProfileEnabled } from '../components/chat/NativeChatInfo'; // [2026-10-18 profile-native]
import { pushOnce, useReleaseNavLockOnFocus } from '../services/navOnce';

const CAT_ICONS = {
  user: IconUser, shield: IconShield, message: IconMessageSquare, bell: IconBell, database: IconDatabase,
  type: IconType, globe: IconGlobe, mail: IconMail, sparkles: IconSparkles, help: IconHelpCircle, userPlus: IconUserPlus,
};

function appVersionLabel() {
  const ver = Constants?.expoConfig?.version || Constants?.manifest?.version || '?';
  const build = Constants?.expoConfig?.ios?.buildNumber || Constants?.expoConfig?.android?.versionCode || '';
  return build ? `${ver} (${build})` : String(ver);
}

// Seção do settingsCache só p/ subtítulos da raiz: revalida no TTL padrão
// (5 min) — as categorias revalidam o que mostram ao abrir (30 s).
// storage_stats é só local (o scan roda na categoria) → sem revalidar.
function usePeek(section) {
  return useSection(section, section === 'storage_stats' ? false : settingsCache.DEFAULT_TTL_MS);
}

// Categoria aberta: chunk sob demanda (web) / módulo avaliado no 1º uso (nativo).
function CategoryHost({ cat }) {
  // Fixo por montagem (o preload do web troca lazy → componente pronto).
  const [Comp] = useState(() => getCategoryComponent(cat));
  if (!Comp) return null;
  return (
    <ErrorBoundary>
      <Suspense fallback={<View style={{ minHeight: 240 }} />}>
        <Comp />
      </Suspense>
    </ErrorBoundary>
  );
}

function SettingsScreenInner() {
  const { colors, isDark, themeMode } = useTheme();
  const gc = useGroupedColors();
  const { t, language } = useLanguage();
  const { logout, user, accounts } = useAuth();
  const confirm = useConfirm();
  const router = useRouter();
  const params = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const blurTopRaw = useBlurHeaderInset(USE_NATIVE_HEADER);
  const { contentMaxWidth, width: _winW } = useResponsive();
  // Desktop/web largo: 2 painéis (categorias à esquerda, detalhe à direita).
  const twoPane = Platform.OS === 'web' && (_winW || 0) >= 900;
  const [accountSwitcherOpen, setAccountSwitcherOpen] = useState(false);
  const requestedSection = typeof params?.section === 'string' ? params.section : null;
  const [activeCategory, setActiveCategory] = useState(() => sectionToCategory(requestedSection));
  const IOS_AUTO_INSET = USE_NATIVE_HEADER && Platform.OS === 'ios';
  const blurTopRef = useRef(0);
  blurTopRef.current = IOS_AUTO_INSET ? blurTopRaw : 0;

  // ── Âncoras: ?section=X (ou resultado de busca) rola até o bloco certo ──
  const scrollRef = useRef(null);
  // [2026-10-17 swipe-back] ?anchor= (busca → categoria empurrada) rola até o bloco.
  const requestedAnchor = typeof params?.anchor === 'string' && params.anchor ? params.anchor : null;
  const [pendingAnchor, setPendingAnchor] = useState(requestedAnchor || requestedSection);
  const pendingAnchorRef = useRef(pendingAnchor);
  pendingAnchorRef.current = pendingAnchor;
  const registerAnchor = useCallback((key) => {
    if (!key || key !== pendingAnchorRef.current) return undefined;
    return (node) => {
      if (!node) return;
      setTimeout(() => {
        try {
          const sv = scrollRef.current;
          const scrollNode = sv?.getInnerViewNode?.() || sv?._nativeRef || sv;
          if (!scrollNode || !node.measureLayout) return;
          node.measureLayout(
            scrollNode,
            (_x, y) => {
              // Rola uma vez só (re-renders da categoria não puxam a tela de volta).
              setPendingAnchor((cur) => (cur === key ? null : cur));
              // [2026-10-17] Já visível no topo → não rola (scrollTo clampa em 0 e,
              // com inset automático, escondia o topo sob o header).
              const target = y - 12 - blurTopRef.current;
              if (target <= 0) return;
              sv?.scrollTo?.({ y: target, animated: true });
            },
            () => {}
          );
        } catch {}
      }, 120);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAnchor]);

  // ── Busca (web: barra inline que expande; nativo: barra do header) ──────
  const [searchQuery, setSearchQuery] = useState('');
  const _q = (searchQuery || '').trim().toLowerCase();
  const searching = !!_q;
  const [searchFocused, setSearchFocused] = useState(false);
  const searchInputRef = useRef(null);
  const searchAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const to = searchFocused || !!searchQuery ? 1 : 0;
    if (isReduceMotionEnabled()) { searchAnim.setValue(to); return; }
    Animated.spring(searchAnim, { toValue: to, useNativeDriver: false, tension: 220, friction: 24 }).start();
  }, [searchFocused, searchQuery, searchAnim]);
  const heroScrollY = useRef(new Animated.Value(0)).current;
  const onHeroScroll = useRef(Animated.event([{ nativeEvent: { contentOffset: { y: heroScrollY } } }], { useNativeDriver: true })).current;

  // ── Saldo de diamantes p/ o cartão da Carteira (some se desativado) ─────
  // [2026-10-17 carteira-sem-piscar] Antes: estado local null + fetch 500 ms
  // depois → o cartão "Carteira" BROTAVA ao lado do Chatyy One (que encolhia de
  // largura inteira p/ meia) a cada abertura = a piscada. Agora lê o store da
  // carteira (services/diamonds: saldo em cache POR CONTA, síncrono no 1º
  // quadro) e só revalida em segundo plano. Sem cache ainda: o cartão já ocupa
  // o lugar (subtítulo "Diamantes") — só some se o servidor disser desligado.
  const _wallet = useWallet();
  const walletDiamonds = !WALLET_ENABLED || (_wallet.loaded && _wallet.enabled === false)
    ? null
    : (typeof _wallet.diamonds === 'number' ? _wallet.diamonds : '');
  useEffect(() => {
    if (requestedSection || !WALLET_ENABLED) return undefined;
    const tm = setTimeout(() => { try { refreshWallet(); } catch {} }, 500);
    return () => clearTimeout(tm);
  }, [user?.email, requestedSection]);

  // ── Perfil do hero (recarrega ao voltar do /edit-profile) ───────────────
  const [myProfile, setMyProfile] = useState(() => settingsCache.peek('profile'));
  const [avatarKey, setAvatarKey] = useState(Date.now());
  useEffect(() => settingsCache.subscribe('profile', (v) => {
    if (v && typeof v === 'object') { setMyProfile(v); setAvatarKey(Date.now()); }
  }), []);
  const _profileFetchedAt = useRef(0);
  useFocusEffect(useCallback(() => {
    if (!user?.email) return undefined;
    const now = Date.now();
    if (now - _profileFetchedAt.current < 3000) return undefined;
    const force = _profileFetchedAt.current !== 0;
    _profileFetchedAt.current = now;
    settingsCache.revalidate('profile', { force }).catch(() => {});
    return undefined;
  }, [user?.email]));

  // ── Subtítulos de estado (snapshot local; sem montar as categorias) ─────
  const privData = usePeek('privacy');
  const notifData = usePeek('notif');
  const referral = usePeek('referral');
  const storageStats = usePeek('storage_stats');
  const settingsData = usePeek('settings');

  // [2026-10-17 nav-once] push NA HORA (sem esperar o próximo frame) e
  // idempotente: trava em voo + nunca empilha a mesma rota que já está no topo.
  useReleaseNavLockOnFocus();
  const safeNav = useCallback((path) => {
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
    try { pushOnce(router, path); } catch {}
  }, [router]);

  // [2026-10-17 swipe-back] Founder: "arrastar da esquerda p/ direita deveria
  // voltar". As categorias abriam DENTRO desta tela (estado activeCategory) com
  // gestureEnabled:false → nem a borda nem a tela inteira voltavam (e no Android
  // o voltar era um BackHandler JS, sem predictive back). Agora, no nativo, cada
  // categoria é uma ROTA empurrada (/settings?section=<cat>): push do
  // UINavigationController, swipe-back nativo (borda + tela inteira), voltar do
  // sistema no Android. Web/2 painéis mantêm a troca no lugar.
  // [2026-10-17 settings-light] A rota empurrada agora é a tela LEVE
  // /settings-section (components/settings/SettingsCategoryScreen.js) — antes
  // era /settings de novo = o hub inteiro remontado só p/ uma categoria
  // ("demora p/ abrir"). Push NA HORA + pushOnce (toque duplo não abre 2).
  const PUSH_CATEGORIES = Platform.OS !== 'web';
  const openCategory = useCallback((key, anchor) => {
    if (PUSH_CATEGORIES && !twoPane) {
      try { Haptics.selectionAsync?.(); } catch {}
      try { pushOnce(router, { pathname: '/settings-section', params: anchor && anchor !== key ? { section: key, anchor } : { section: key } }); } catch {}
      return;
    }
    try { Haptics.selectionAsync?.(); } catch {}
    setPendingAnchor(anchor || null);
    setSearchQuery('');
    setSearchFocused(false);
    setActiveCategory(key);
    if (!IOS_AUTO_INSET) { try { scrollRef.current?.scrollTo?.({ y: 0, animated: false }); } catch {} }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [IOS_AUTO_INSET, twoPane, router]);
  const openAccountSwitcher = useCallback(() => { try { Haptics.selectionAsync?.(); } catch {} setAccountSwitcherOpen(true); }, []);
  const hostValue = useMemo(() => ({ registerAnchor, openCategory, openAccountSwitcher, twoPane }), [registerAnchor, openCategory, openAccountSwitcher, twoPane]);

  // Web: baixa os chunks das categorias quando a raiz já está ociosa → a
  // categoria abre sem esperar a rede (a raiz continua leve no 1º paint).
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const run = () => { for (const keys of CATEGORY_GROUPS) for (const k of keys) preloadCategory(k); };
    const id = setTimeout(run, 400);
    return () => clearTimeout(id);
  }, []);

  // 2 painéis: sempre há uma categoria aberta à direita (padrão: Conta).
  useEffect(() => {
    if (twoPane && activeCategory === null) setActiveCategory('account');
  }, [twoPane, activeCategory]);

  // Voltar: dentro de uma categoria aberta pela lista → volta à lista; com
  // ?section= (link) → sai da tela; sem histórico → conversas.
  const inCategorySubpage = activeCategory !== null && !twoPane && !requestedSection;
  let canGoBackNow = true;
  try { canGoBackNow = !!router.canGoBack?.(); } catch {}
  const exitSettings = () => {
    try { if (router.canGoBack?.()) { router.back(); return; } } catch {}
    try { router.replace('/chat'); } catch {}
  };
  const handleBack = () => {
    if (inCategorySubpage) { setActiveCategory(null); setPendingAnchor(null); return; }
    exitSettings();
  };
  // Android: voltar do aparelho (useFocusEffect: sub-telas pushadas por cima
  // não podem ter o voltar capturado por esta tela escondida).
  useFocusEffect(useCallback(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (activeCategory !== null && !requestedSection) { setActiveCategory(null); setPendingAnchor(null); return true; }
      try { if (!router.canGoBack?.()) { router.replace('/chat'); return true; } } catch {}
      return false;
    });
    return () => { try { sub.remove(); } catch {} };
  }, [activeCategory, requestedSection]));

  // Puxar p/ baixo = revalida tudo (paralelo) + avisa a categoria aberta.
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const onPullRefresh = useCallback(() => {
    setPullRefreshing(true);
    emitSettingsRefresh();
    settingsCache.prefetchAll({ force: true }).finally(() => setPullRefreshing(false));
  }, []);

  const handleSettingsLogout = async () => {
    const title = t('settings.logoutConfirmTitle');
    const msg = t('settings.logoutConfirmMessage');
    let ok = false;
    if (Platform.OS === 'web') {
      try { ok = typeof window !== 'undefined' && window.confirm(`${title}\n\n${msg}`); } catch { ok = false; }
    } else {
      ok = await confirm({ title, message: msg, confirmLabel: t('settings.logout'), destructive: true });
    }
    if (!ok) return;
    try { await logout(); } catch {}
    try { router.replace('/login'); } catch {}
  };

  // ── Subtítulos ──────────────────────────────────────────────────────────
  const _fmtBytesHub = (b) => {
    const bytes = Math.max(0, Number(b) || 0);
    const mb = bytes / (1024 * 1024);
    if (mb < 1) return bytes > 0 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : '';
    if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
    const gb = mb / 1024;
    return `${(gb < 10 ? gb.toFixed(1) : Math.round(gb)).toString().replace('.', (language || '').startsWith('en') ? '.' : ',')} GB`;
  };
  const langLabel = (() => {
    if (!SELECTABLE_LOCALES.includes(language)) return '';
    return (I18N_LANGUAGES.find((l) => l.code === language) || {}).label || language;
  })();
  const fontSize = (notifData && typeof notifData.font_size === 'string') ? notifData.font_size : (settingsData?.font_size || 'medium');
  const fontLabel = fontSize === 'small' ? t('settings.fontSmall') : fontSize === 'large' ? t('settings.fontLarge') : t('settings.fontMedium');
  const themeLabel = themeMode === 'dark' ? t('settings.theme.dark') : themeMode === 'light' ? t('settings.theme.light') : t('settings.theme.system');
  const pushLevel = pushLevelOf(notifData);
  const pushLabel = pushLevel === 'urgent' ? t('settings.notifUrgent') : pushLevel === 'silent' ? t('settings.notifSilent') : t('settings.notifAll');
  const storageSub = (() => {
    if (Platform.OS !== 'web') return _fmtBytesHub(storageStats?.totalBytes);
    let q = 'hd';
    try { q = require('../services/mediaUploadQuality').getMediaUploadQuality(); } catch {}
    return `${t('settings.mediaUploadQuality.title') || ''}: ${q === 'hd' ? (t('settings.mediaUploadQuality.hd') || 'HD') : (t('settings.mediaUploadQuality.standard') || 'Padrão')}`;
  })();
  const referralCount = (referral && referral.referred_count) || 0;
  const catSubtitle = {
    account: (myProfile?.phone || user?.email || ''),
    privacy: `${t('settings.privacyLastSeen')}: ${privacyValueLabel(t, normalizePrivacy(privData), 'last_seen')}`,
    chat: `${t('settings.theme.label') || ''}: ${themeLabel}`,
    notifications: pushLabel,
    storage_data: storageSub,
    accessibility: `${t('settings.fontSize')}: ${fontLabel}`,
    language: langLabel,
    email: user?.email || '',
    bia: t('settings.cat.biaSub') || '',
    help: (t('settings.about.version') || 'Versão {ver}').replace('{ver}', appVersionLabel()),
    invite: referralCount > 0 ? String(referralCount) : '',
  };
  const activeCategoryTitle = activeCategory ? categoryTitle(t, activeCategory) : t('settings.title');

  // ── Busca: índice leve (não monta categorias) ───────────────────────────
  const searchIndex = useMemo(() => buildSearchIndex(t), [t]);
  const catTitleOf = useCallback((k) => categoryTitle(t, k), [t]);
  const results = useMemo(() => (searching ? filterSearchIndex(searchIndex, _q, catTitleOf) : []), [searching, searchIndex, _q, catTitleOf]);

  // ── Lista nativa da raiz ────────────────────────────────────────────────
  const [nativeFailed, setNativeFailed] = useState(() => !!globalThis.__chatyy_native_settings_failed);
  const useNativeRoot = Platform.OS !== 'web' && !twoPane && !nativeFailed
    && globalThis.__chatyy_native_settings !== false && isNativeSettingsListAvailable();
  const onNativeFailure = useCallback((msg) => {
    try { globalThis.__chatyy_native_settings_failed = true; console.warn('[native-settings] fallback JS:', msg); try { require('../services/crashReporter').reportNativeFallback('native_settings', msg); } catch {} } catch {}
    setNativeFailed(true);
  }, []);

  const heroNode = (
    <>
      <SettingsHero
        user={user}
        profile={myProfile}
        avatarKey={avatarKey}
        scrollY={twoPane || useNativeRoot ? null : heroScrollY}
        onEdit={() => safeNav('/edit-profile')}
        onAvatar={(Platform.OS !== 'web' && user?.email && isNativeProfileEnabled()) ? () => safeNav(`/u/${encodeURIComponent(user.email)}`) : undefined}
        onQr={() => safeNav('/profile-qr')}
        onSwitch={openAccountSwitcher}
      />
      <SettingsSpecialCards
        user={user}
        accounts={accounts}
        walletDiamonds={walletDiamonds}
        onOne={() => safeNav('/settings-one')}
        onWallet={() => safeNav('/wallet')}
        onAccounts={openAccountSwitcher}
        onDevices={() => safeNav('/linked-devices')}
        onStarred={() => safeNav('/starred-messages')}
      />
    </>
  );

  const searchBarNode = (
    <View style={s.searchWrap}>
      <Animated.View style={[s.searchBar, {
        backgroundColor: searchFocused ? gc.cardBg : gc.fill,
        borderColor: searchFocused ? gc.ring : 'transparent',
      }]}>
        <IconSearch size={17} color={searchFocused ? gc.text : gc.secondary} />
        <TextInput
          ref={searchInputRef}
          value={searchQuery}
          onChangeText={setSearchQuery}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => { if (!searchQuery) setSearchFocused(false); }}
          placeholder={t('settings.searchPlaceholder') || 'Buscar configuração...'}
          placeholderTextColor={gc.secondary}
          style={[s.searchInput, { color: colors.text }]}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          accessibilityLabel={t('settings.searchPlaceholder') || 'Buscar configuração'}
        />
        {!!searchQuery && (
          <TouchableOpacity onPress={() => setSearchQuery('')} style={{ padding: 4 }} accessibilityLabel={t('common.clear') || 'Limpar'} accessibilityRole="button">
            <IconX size={15} color={gc.secondary} />
          </TouchableOpacity>
        )}
      </Animated.View>
      <Animated.View style={{ overflow: 'hidden', maxWidth: searchAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 110] }), opacity: searchAnim }}>
        <TouchableOpacity
          onPress={() => { setSearchQuery(''); setSearchFocused(false); try { searchInputRef.current?.blur?.(); } catch {} }}
          style={s.searchCancel}
          accessibilityRole="button"
          accessibilityLabel={t('common.cancel') || 'Cancelar'}
        >
          <Text style={{ color: gc.text, fontSize: 16, fontWeight: '500' }} numberOfLines={1}>{t('common.cancel') || 'Cancelar'}</Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );

  // Resultados (lista JS): uma linha por configuração, subtítulo = categoria.
  const searchResultsNode = searching ? (
    results.length > 0 ? (
      <SettingsGroup header={(t('settings.matchesFound') || 'Resultados') + ` (${results.length})`}>
        {results.map((r) => {
          const Icon = CAT_ICONS[CATEGORY_META[r.cat]?.icon];
          return (
            <SettingsRow
              key={r.id}
              icon={Icon}
              title={r.title}
              subtitle={categoryTitle(t, r.cat)}
              subtitleLines={1}
              onPress={() => openCategory(r.cat, r.anchor)}
            />
          );
        })}
      </SettingsGroup>
    ) : (
      <View style={{ paddingVertical: 32, alignItems: 'center' }}>
        <IconSearch size={28} color={gc.tertiary} />
        <Text style={{ color: gc.secondary, fontSize: 15, marginTop: 10 }}>{t('settings.noMatches') || 'Nenhum resultado'}</Text>
      </View>
    )
  ) : null;

  const categoryGroupsNode = CATEGORY_GROUPS.map((keys, gi) => (
    <SettingsGroup key={gi} inset={62} header={t(GROUP_HEADER_KEYS[gi])}>
      {keys.map((key) => (
        <SettingsRow
          key={key}
          icon={CAT_ICONS[CATEGORY_META[key].icon]}
          title={categoryTitle(t, key)}
          subtitle={catSubtitle[key] || undefined}
          subtitleLines={1}
          titleStyle={twoPane && activeCategory === key ? { fontWeight: '700' } : undefined}
          accessibilityState={twoPane ? { selected: activeCategory === key } : undefined}
          testID={'settings-cat-' + key}
          onPress={() => openCategory(key)}
        />
      ))}
    </SettingsGroup>
  ));
  const logoutNode = (
    <SettingsGroup>
      <SettingsRow title={t('settings.logoutAccount')} destructive center onPress={handleSettingsLogout} />
    </SettingsGroup>
  );
  const homeListNode = (
    <View>
      {heroNode}
      {categoryGroupsNode}
      {logoutNode}
    </View>
  );

  // Linhas da lista nativa (categorias + resultados de busca + Sair).
  const nativeSections = useMemo(() => {
    if (!useNativeRoot) return null;
    const rows = [];
    CATEGORY_GROUPS.forEach((keys, gi) => {
      for (const key of keys) {
        rows.push({
          id: 'c:' + key, k: 'c', sid: 'g' + gi, hd: t(GROUP_HEADER_KEYS[gi]),
          title: categoryTitle(t, key), sub: catSubtitle[key] || '', icon: CATEGORY_META[key].icon,
        });
      }
    });
    rows.push({ id: 'a:logout', k: 'a', sid: 'logout', hd: '', title: t('settings.logoutAccount'), dest: true, center: true });
    for (const e of searchIndex) {
      rows.push({ id: e.id, k: 'q', sid: 'q', hd: '', title: e.title, sub: categoryTitle(t, e.cat), icon: CATEGORY_META[e.cat]?.icon || '', kw: e.kw });
    }
    return rows;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useNativeRoot, t, searchIndex, JSON.stringify(catSubtitle)]);
  const searchIndexById = useMemo(() => {
    const m = new Map();
    for (const e of searchIndex) m.set(e.id, e);
    return m;
  }, [searchIndex]);
  const onNativeRowPress = useCallback((id) => {
    if (!id) return;
    if (id === 'a:logout') { handleSettingsLogout(); return; }
    if (id.startsWith('c:')) { openCategory(id.slice(2)); return; }
    const e = searchIndexById.get(id);
    if (e) openCategory(e.cat, e.anchor);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchIndexById, openCategory]);

  const nativeLabels = useMemo(() => ({
    results: t('settings.matchesFound') || 'Resultados',
    noResults: t('settings.noMatches') || 'Nenhum resultado',
  }), [t]);
  const showNativeRoot = useNativeRoot && activeCategory === null;
  const bottomPad = IOS_AUTO_INSET ? 40 : 80 + insets.bottom;
  // [2026-10-17 settings-freeze] iOS: SEM título grande quando a raiz é a lista
  // NATIVA. Crash 704 (watchdog 0x8BADF00D, thread principal em loop):
  // UICollectionView.setContentOffset → UINavigationController acompanha o
  // scroll do título grande (_observeScrollViewDidScroll) → muda o safe area da
  // tela → SafeAreaView do react-native-screens (iOS 26 envolve cada tela)
  // despacha estado → commit/layout do Fabric → o UICollectionView reajusta o
  // contentOffset automático → … sem fim. Com header normal (não translúcido)
  // a barra tem altura FIXA (safe area estável) e a lista não é mais o
  // "content scroll view" do header (autoInset off → .never, sem ajuste
  // automático de offset). Religar por OTA: globalThis.__chatyy_native_list_large_title = true
  // (nativeListLargeTitleOn, mesmo gate do _layout → o header não troca após o 1º frame).
  const rootLargeTitle = Platform.OS === 'ios' && (!showNativeRoot || nativeListLargeTitleOn());
  const nativeAutoInset = IOS_AUTO_INSET && rootLargeTitle;
  const nativeBottomPad = nativeAutoInset ? 40 : 40 + insets.bottom;

  return (
    <View style={[s.container, { backgroundColor: gc.pageBg, paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }]}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({
          colors,
          isDark,
          blur: false,
          title: activeCategory !== null ? activeCategoryTitle : (t('settings.title') || 'Configurações'),
          // [2026-10-17 swipe-back] Sempre ligado: no nativo a categoria é rota
          // própria (inCategorySubpage só existe no web estreito).
          gestureEnabled: !inCategorySubpage,
          fullScreenGestureEnabled: !inCategorySubpage,
          contentStyle: { backgroundColor: gc.pageBg },
          // iOS: título GRANDE que colapsa ao rolar — raiz E categorias (como o
          // Ajustes do iPhone). Explícito (setOptions MESCLA) e igual ao que o
          // _layout aplica antes do 1º frame (sem salto do header).
          ...(rootLargeTitle ? {
            headerLargeTitle: true,
            headerLargeTitleShadowVisible: false,
            headerLargeStyle: { backgroundColor: gc.pageBg },
            headerLargeTitleStyle: { color: colors.text },
          } : (Platform.OS === 'ios' ? { headerLargeTitle: false, headerShadowVisible: false, headerStyle: { backgroundColor: gc.pageBg } } : {})),
          // Voltar NATIVO quando há histórico (chevron do sistema + menu de
          // toque longo); botão próprio só sem histórico (link frio → /chat)
          // ou na categoria no-lugar do web.
          ...((inCategorySubpage || !canGoBackNow) ? {
            headerLeft: () => <HeaderBackButton onPress={handleBack} color={colors.text} accessibilityLabel={t('common.back') || 'Voltar'} />,
            headerBackVisible: false,
          } : {
            headerLeft: undefined,
            headerBackVisible: true,
          }),
          // [2026-10-17 settings-search-overlap] SEM busca NATIVA no header.
          // UISearchController (placement stacked) entrava via setOptions DEPOIS
          // do 1º frame, com o título grande já montado pelo _layout + lista
          // nativa (setContentScrollView) → no iOS a barra era desenhada POR
          // CIMA do título grande e o slot dela virava um vão vazio acima do
          // avatar. A busca agora é a barra JS (searchBarNode) logo abaixo do
          // título, 1º item do conteúdo (rola junto, como o Ajustes/WhatsApp).
          // Explícito (setOptions MESCLA): nunca herdar uma busca anterior.
          headerSearchBarOptions: undefined,
        })} />
      ) : (
        <View style={[s.header, { backgroundColor: gc.pageBg, borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={handleBack} style={s.backBtn} accessibilityLabel={t('common.back') || 'Voltar'} accessibilityRole="button">
            <IconArrowLeft size={24} color={colors.text} />
          </TouchableOpacity>
          <Animated.Text
            style={[s.headerTitle, { color: colors.text },
              (activeCategory === null && !twoPane && !isReduceMotionEnabled())
                ? { opacity: heroScrollY.interpolate({ inputRange: [90, 170], outputRange: [0, 1], extrapolate: 'clamp' }) }
                : null]}
            numberOfLines={1}
            accessibilityRole="header"
          >{activeCategory !== null && !twoPane ? activeCategoryTitle : t('settings.title')}</Animated.Text>
          <View style={s.backBtn} />
        </View>
      )}

      <SettingsHostContext.Provider value={hostValue}>
        <View style={twoPane ? s.twoPaneRow : s.flex1}>
          {twoPane && (
            <Animated.ScrollView
              style={[s.twoPaneLeft, { borderRightColor: colors.border }]}
              contentContainerStyle={[s.scroll, { paddingBottom: 40 }]}
              keyboardShouldPersistTaps="handled"
              testID="settings-left-pane"
            >
              {searchBarNode}
              <SettingsSearchContext.Provider value={_q}>
                {searching ? searchResultsNode : homeListNode}
              </SettingsSearchContext.Provider>
            </Animated.ScrollView>
          )}
          <View style={s.flex1}>
            {showNativeRoot ? (
              <NativeSettingsList
                rows={nativeSections}
                query={searchQuery}
                header={<>{searchBarNode}{searching ? null : heroNode}</>}
                isDark={isDark}
                palette={gc}
                maxWidth={contentMaxWidth}
                bottomInset={nativeBottomPad}
                autoInset={nativeAutoInset}
                labels={nativeLabels}
                refreshing={pullRefreshing}
                onRefresh={onPullRefresh}
                onRowPress={onNativeRowPress}
                onFailure={onNativeFailure}
              />
            ) : (
              <FadeSlideIn style={s.flex1}>
                <SettingsSearchContext.Provider value={activeCategory === null ? _q : ''}>
                  <Animated.ScrollView
                    key={activeCategory || 'root'}
                    ref={scrollRef}
                    onScroll={activeCategory === null && !twoPane ? onHeroScroll : undefined}
                    scrollEventThrottle={16}
                    contentInsetAdjustmentBehavior={IOS_AUTO_INSET ? 'automatic' : undefined}
                    keyboardShouldPersistTaps="handled"
                    keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
                    contentContainerStyle={[s.scroll, { paddingBottom: bottomPad, maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' }]}
                    refreshControl={Platform.OS === 'web' ? undefined : <UIRefreshControl refreshing={pullRefreshing} onRefresh={onPullRefresh} tintColor={gc.secondary} colors={[colors.primary]} />}
                  >
                    {activeCategory === null && !twoPane ? (
                      <>
                        {searchBarNode}
                        {searching ? searchResultsNode : homeListNode}
                      </>
                    ) : activeCategory ? (
                      <CategoryHost key={activeCategory} cat={activeCategory} />
                    ) : null}
                  </Animated.ScrollView>
                </SettingsSearchContext.Provider>
              </FadeSlideIn>
            )}
          </View>
        </View>
      </SettingsHostContext.Provider>

      <AccountSwitcherSheet visible={accountSwitcherOpen} onClose={() => setAccountSwitcherOpen(false)} />
    </View>
  );
}

const s = StyleSheet.create({
  flex1: { flex: 1 },
  twoPaneRow: { flex: 1, flexDirection: 'row' },
  twoPaneLeft: { width: 360, flexGrow: 0, flexShrink: 0, borderRightWidth: StyleSheet.hairlineWidth },
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: Spacing.md,
    minHeight: 56,
    borderBottomWidth: StyleSheet.hairlineWidth,
    ...Platform.select({
      web: { backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' },
      default: {},
    }),
  },
  backBtn: { padding: Spacing.sm, marginRight: Spacing.xs, borderRadius: BorderRadius.md, marginLeft: -Spacing.xs },
  headerTitle: { flex: 1, fontSize: FontSize.title, fontWeight: '700', letterSpacing: LetterSpacing.tighter },
  scroll: { paddingHorizontal: 16, paddingTop: Spacing.md, paddingBottom: 80 },
  searchWrap: { flexDirection: 'row', alignItems: 'center', marginBottom: 18 },
  searchBar: { flex: 1, flexDirection: 'row', alignItems: 'center', borderRadius: 14, paddingHorizontal: 12, height: 42, gap: 8, borderWidth: 1 },
  searchInput: { flex: 1, fontSize: 16, paddingVertical: 0, height: 40, ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }) },
  searchCancel: { paddingLeft: 12, paddingVertical: 8, ...Platform.select({ web: { cursor: 'pointer' }, default: {} }) },
});

// [2026-10-17 settings-light] Nativo: link antigo /settings?section=<cat|bloco>
// abre direto a tela LEVE da categoria (sem montar o hub). Web mantém a troca
// no lugar / 2 painéis.
export default function SettingsScreen() {
  const params = useLocalSearchParams();
  const section = typeof params?.section === 'string' ? params.section : '';
  if (Platform.OS !== 'web' && section && sectionToCategory(section)) return <SettingsCategoryScreen />;
  return <ErrorBoundary><SettingsScreenInner /></ErrorBoundary>;
}
