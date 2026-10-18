// [2026-10-17 settings-light] Tela LEVE de UMA categoria das Configurações
// (rota /settings-section?section=<cat>[&anchor=<bloco>], e /settings?section=
// no nativo para links antigos).
//
// Antes cada categoria era um push de /settings?section=<cat> → montava o hub
// INTEIRO de novo só p/ mostrar uma categoria: hero (perfil/cartões), carteira
// (useWallet + refresh), perfil (revalida no foco), 5 assinaturas do
// settingsCache com revalidação em rede (privacy/notif/referral/storage/
// settings), índice de busca (buildSearchIndex de todas as categorias), linhas
// da lista nativa, AccountSwitcherSheet… = "tocar em Ajuda e sobre demora".
// Aqui monta só: header nativo + ScrollView + o componente da categoria (que já
// assina/revalida o que ele mesmo mostra) + o contexto do hub que as
// categorias usam (registerAnchor/openCategory/openAccountSwitcher).
//
// [2026-10-18 settings-sub-native] Categorias só-de-linhas (Privacidade,
// Notificações, Acessibilidade, Ajuda, Convidar, Bia) desenhadas pela MESMA
// lista nativa da raiz (ChatyySettingsList api ≥ 2: cartões agrupados, valor à
// direita, check, interruptor nativo, rodapés). A categoria JS segue montada
// numa árvore invisível em "modo coleta" (components/settings/nativeCollect.js)
// → estado/folhas/handlers são os mesmos. Conteúdo fora do kit, erro nativo
// ou kill switch (globalThis.__chatyy_native_settings_sub = false) → volta
// sozinho para a tela JS abaixo.
// [2026-10-18 settings-sub-native-2] + Conta, Conversas, E-mail, Idioma e
// Armazenamento (campos → folha SettingsFormSheet; header `nativeHeaderBare`
// = conteúdo RN sem o cartão em volta). Aparência segue JS.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, Platform, BackHandler, StyleSheet } from 'react-native';
import { useRouter, useLocalSearchParams, useFocusEffect, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ErrorBoundary from '../ErrorBoundary';
import UIRefreshControl from '../ui/RefreshControl';
import { HapticsCompat as Haptics } from '../../services/haptics';
import { pushOnce, useReleaseNavLockOnFocus } from '../../services/navOnce';
import * as settingsCache from '../../services/settingsCache';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { useResponsive } from '../../utils/responsive';
import { USE_NATIVE_HEADER, nativeHeaderOptions, HeaderBackButton, useBlurHeaderInset, nativeListLargeTitleOn } from '../nativeHeader';
import NativeSettingsList from './NativeSettingsList';
import { SettingsCollectContext, createCollector, nativeSettingsCategoryOn, markNativeCategoryFailed, NativeHeaderBare } from './nativeCollect';
import { SettingsSearchContext, useGroupedColors } from './SettingsKit';
import { categoryTitle, sectionToCategory, getCategoryComponent } from './categories';
import { SettingsHostContext, emitSettingsRefresh } from './categories/shared';
import { Spacing, BorderRadius } from '../../constants/theme';

const IOS_AUTO_INSET = USE_NATIVE_HEADER && Platform.OS === 'ios';

function CategoryBody({ cat }) {
  // Fixo por montagem (nativo: require síncrono; web: lazy).
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

let _AccountSwitcherSheet = null;
function LazyAccountSwitcher({ visible, onClose }) {
  if (!_AccountSwitcherSheet) _AccountSwitcherSheet = require('../AccountSwitcherSheet').default;
  const C = _AccountSwitcherSheet;
  return <C visible={visible} onClose={onClose} />;
}

function SettingsCategoryScreenInner() {
  const { colors, isDark } = useTheme();
  const gc = useGroupedColors();
  const { t } = useLanguage();
  const router = useRouter();
  const params = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const { contentMaxWidth } = useResponsive();
  const blurTopRaw = useBlurHeaderInset(USE_NATIVE_HEADER);
  const blurTopRef = useRef(0);
  blurTopRef.current = IOS_AUTO_INSET ? blurTopRaw : 0;

  const section = typeof params?.section === 'string' ? params.section : '';
  // Categoria fixa por montagem (a rota é por categoria).
  const [cat] = useState(() => sectionToCategory(section));
  useReleaseNavLockOnFocus();

  // ── Lista nativa (sub-página) ─────────────────────────────────────────
  const [startNative] = useState(() => nativeSettingsCategoryOn(cat));
  const [native, setNative] = useState(startNative);
  const nativeRef = useRef(native);
  nativeRef.current = native;
  const [nat, setNat] = useState({ rows: [], headers: [] });
  const [scrollToId, setScrollToId] = useState('');
  const collectorRef = useRef(null);
  const dropNative = useCallback((why) => {
    if (!nativeRef.current) return;
    markNativeCategoryFailed(cat, why);
    try { collectorRef.current?.dispose(); } catch {}
    nativeRef.current = false;
    setNative(false);
  }, [cat]);
  if (startNative && !collectorRef.current) {
    collectorRef.current = createCollector({
      onChange: (snap) => {
        if (snap.failed) { dropNative(snap.failed); return; }
        setNat({ rows: snap.rows, headers: snap.headers });
      },
    });
  }
  useEffect(() => () => { try { collectorRef.current?.dispose(); } catch {} }, []);

  // ── Âncora: só quando pedida (busca → bloco; link antigo ?section=<bloco>).
  // Abrir a categoria pela lista NÃO rola: antes ?section=<cat> virava âncora
  // da própria categoria (1º bloco) → scrollTo({y:0}) com inset automático do
  // título grande = conteúdo POR BAIXO do header (1ª linha — "Idioma do app" —
  // ficava sob a barra de navegação e o toque caía no header).
  const anchorParam = typeof params?.anchor === 'string' && params.anchor ? params.anchor : null;
  const initialAnchor = anchorParam || (section && section !== cat ? section : null);
  const [pendingAnchor, setPendingAnchor] = useState(initialAnchor);
  const pendingAnchorRef = useRef(pendingAnchor);
  pendingAnchorRef.current = pendingAnchor;
  const scrollRef = useRef(null);
  const registerAnchor = useCallback((key) => {
    if (!key || key !== pendingAnchorRef.current) return undefined;
    if (nativeRef.current) {
      // Nativo: âncora → 1ª linha do 1º grupo dela → a lista nativa rola até lá.
      return (node) => {
        if (!node) return;
        setTimeout(async () => {
          let rid = null;
          try { rid = await collectorRef.current?.resolveAnchor(node); } catch {}
          setPendingAnchor((cur) => (cur === key ? null : cur));
          if (rid) setScrollToId(`${rid}|${Date.now()}`);
        }, 160);
      };
    }
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
              setPendingAnchor((cur) => (cur === key ? null : cur));
              // Já visível logo abaixo do header → não mexe (scrollTo do RN
              // clampa em 0 e esconderia o topo sob o header translúcido).
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

  const openCategory = useCallback((key, anchor) => {
    if (!key) return;
    if (key === cat) {
      if (anchor) setPendingAnchor(anchor);
      return;
    }
    try { Haptics.selectionAsync?.(); } catch {}
    try {
      pushOnce(router, { pathname: '/settings-section', params: anchor && anchor !== key ? { section: key, anchor } : { section: key } });
    } catch {}
  }, [cat, router]);

  // Seletor de contas: só carrega/monta no 1º uso (Conta → "Trocar conta");
  // depois fica montado e alterna visible (sem desmontar um Modal aberto).
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherMounted, setSwitcherMounted] = useState(false);
  const openAccountSwitcher = useCallback(() => { try { Haptics.selectionAsync?.(); } catch {} setSwitcherMounted(true); setSwitcherOpen(true); }, []);
  const hostValue = useMemo(() => ({ registerAnchor, openCategory, openAccountSwitcher, twoPane: false }), [registerAnchor, openCategory, openAccountSwitcher]);

  let canGoBackNow = true;
  try { canGoBackNow = !!router.canGoBack?.(); } catch {}
  const exit = useCallback(() => {
    try { if (router.canGoBack?.()) { router.back(); return; } } catch {}
    try { router.replace('/settings'); } catch {}
  }, [router]);
  useFocusEffect(useCallback(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      try { if (!router.canGoBack?.()) { router.replace('/settings'); return true; } } catch {}
      return false;
    });
    return () => { try { sub.remove(); } catch {} };
  }, [router]));

  // Puxar p/ baixo: avisa a categoria (useSettingsRefresh) + revalida o cache.
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    emitSettingsRefresh();
    settingsCache.prefetchAll({ force: true }).finally(() => setRefreshing(false));
  }, []);

  // Seção desconhecida → hub.
  const invalid = !cat;
  useFocusEffect(useCallback(() => {
    if (invalid) { try { router.replace('/settings'); } catch {} }
    return undefined;
  }, [invalid, router]));

  const title = cat ? categoryTitle(t, cat) : (t('settings.title') || 'Configurações');
  const bottomPad = IOS_AUTO_INSET ? 40 : 80 + insets.bottom;
  // iOS: título grande só na tela JS (lista nativa como content scroll view do
  // título grande = loop de layout, watchdog 0x8BADF00D build 704 — mesma regra
  // da raiz). Decidido na montagem (= _layout), sem troca de header depois.
  const largeTitle = Platform.OS === 'ios' && (!startNative || nativeListLargeTitleOn());
  const nativeAutoInset = IOS_AUTO_INSET && largeTitle && native;
  const body = useMemo(() => (cat ? <CategoryBody cat={cat} /> : null), [cat]);
  const onNativeRowPress = useCallback((id) => { try { collectorRef.current?.press(id); } catch {} }, []);
  const onNativeToggle = useCallback((id, v) => { try { collectorRef.current?.toggle(id, v); } catch {} }, []);
  const onNativeFailure = useCallback((msg) => dropNative('native: ' + String(msg || '')), [dropNative]);
  const nativeHeaderNode = nat.headers.length ? (
    <View>
      {nat.headers.map((el, i) => (el && el.type === NativeHeaderBare
        ? <View key={i}>{el}</View>
        : <View key={i} style={[st.headCard, { backgroundColor: gc.cardBg }]}>{el}</View>
      ))}
    </View>
  ) : <View />;

  return (
    <View style={[st.container, { backgroundColor: gc.pageBg, paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }]}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({
          colors,
          isDark,
          blur: false,
          title,
          gestureEnabled: true,
          fullScreenGestureEnabled: true,
          contentStyle: { backgroundColor: gc.pageBg },
          ...(largeTitle ? {
            headerLargeTitle: true,
            headerLargeTitleShadowVisible: false,
            headerLargeStyle: { backgroundColor: gc.pageBg },
            headerLargeTitleStyle: { color: colors.text },
          } : (Platform.OS === 'ios' ? { headerLargeTitle: false, headerShadowVisible: false, headerStyle: { backgroundColor: gc.pageBg } } : {})),
          ...(!canGoBackNow ? {
            headerLeft: () => <HeaderBackButton onPress={exit} color={colors.text} accessibilityLabel={t('common.back') || 'Voltar'} />,
            headerBackVisible: false,
          } : { headerLeft: undefined, headerBackVisible: true }),
          headerSearchBarOptions: undefined,
        })} />
      ) : (
        <View style={[st.webHeader, { backgroundColor: gc.pageBg, borderBottomColor: colors.border }]}>
          <HeaderBackButton onPress={exit} color={colors.text} accessibilityLabel={t('common.back') || 'Voltar'} />
          <Text style={[st.webTitle, { color: colors.text }]} numberOfLines={1} accessibilityRole="header">{title}</Text>
        </View>
      )}
      <SettingsHostContext.Provider value={hostValue}>
        <SettingsSearchContext.Provider value="">
          <View style={st.flex1}>
            {cat && native ? (
              <>
                <NativeSettingsList
                  rows={nat.rows}
                  header={nativeHeaderNode}
                  isDark={isDark}
                  palette={gc}
                  maxWidth={contentMaxWidth}
                  bottomInset={nativeAutoInset ? 40 : 40 + insets.bottom}
                  autoInset={nativeAutoInset}
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                  onRowPress={onNativeRowPress}
                  onToggle={onNativeToggle}
                  onFailure={onNativeFailure}
                  scrollToId={scrollToId}
                />
                {/* Árvore da categoria em modo coleta: fora da tela, sem toque, fora do leitor de tela. */}
                <View
                  pointerEvents="none"
                  collapsable={false}
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  style={st.collect}
                  ref={(n) => { if (n) collectorRef.current?.setContainer(n); }}
                  onLayout={(e) => collectorRef.current?.setContainerHeight(e?.nativeEvent?.layout?.height || 0)}
                >
                  <SettingsCollectContext.Provider value={collectorRef.current}>
                    {body}
                  </SettingsCollectContext.Provider>
                </View>
              </>
            ) : cat ? (
              <ScrollViewHost
                scrollRef={scrollRef}
                bottomPad={bottomPad}
                maxWidth={contentMaxWidth}
                refreshing={refreshing}
                onRefresh={onRefresh}
                tint={gc.secondary}
                primary={colors.primary}
              >
                {body}
              </ScrollViewHost>
            ) : null}
          </View>
        </SettingsSearchContext.Provider>
      </SettingsHostContext.Provider>
      {switcherMounted ? <LazyAccountSwitcher visible={switcherOpen} onClose={() => setSwitcherOpen(false)} /> : null}
    </View>
  );
}

// ScrollView simples (mesmo layout da categoria no hub: padding 16, inset
// automático no iOS por baixo do título grande, teclado interativo).
function ScrollViewHost({ scrollRef, bottomPad, maxWidth, refreshing, onRefresh, tint, primary, children }) {
  return (
    <ScrollView
      ref={scrollRef}
      style={st.flex1}
      contentInsetAdjustmentBehavior={IOS_AUTO_INSET ? 'automatic' : undefined}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      contentContainerStyle={[st.scroll, { paddingBottom: bottomPad, maxWidth, width: '100%', alignSelf: 'center' }]}
      refreshControl={Platform.OS === 'web' ? undefined : <UIRefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={tint} colors={[primary]} />}
    >
      {children}
    </ScrollView>
  );
}

const st = StyleSheet.create({
  container: { flex: 1 },
  flex1: { flex: 1 },
  scroll: { paddingHorizontal: 16, paddingTop: Spacing.md, paddingBottom: 80 },
  webTitle: { flex: 1, fontSize: 20, fontWeight: '700', marginLeft: 4 },
  webHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth },
  // Fora da tela (não opacidade 0: Modal/folha aberta pela categoria continua visível).
  collect: { position: 'absolute', left: 0, right: 0, top: 0, transform: [{ translateX: -100000 }] },
  headCard: { borderRadius: BorderRadius.card, overflow: 'hidden', marginBottom: 24 },
});

export default function SettingsCategoryScreen() {
  return <ErrorBoundary><SettingsCategoryScreenInner /></ErrorBoundary>;
}
