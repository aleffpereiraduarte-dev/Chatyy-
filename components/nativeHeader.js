// [2026-10-07 app-feel-nav] Header NATIVO (react-native-screens) p/ telas
// pushadas — UINavigationBar no iOS (título anima JUNTO com o push, back
// chevron do sistema com menu de long-press, swipe-back sincronizado) e
// Toolbar Material no Android. Antes cada tela desenhava um <View> com
// TouchableOpacity + texto (header de site: sobe junto com o conteúdo na
// transição, altura fixa, sombra web).
//
// Web continua com o header custom de cada tela (USE_NATIVE_HEADER=false):
// o native-stack no web renderiza um header JS genérico que não combina.
//
// Uso:
//   import { USE_NATIVE_HEADER, nativeHeaderOptions, HeaderIconButton } from '../components/nativeHeader';
//   {USE_NATIVE_HEADER && <Stack.Screen options={nativeHeaderOptions({ colors, title, headerRight: () => ... })} />}
//   <View style={{ paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }}>
import React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaListener } from 'react-native-safe-area-context'; // [2026-10-08 header-inset-all] JS-only (usa o RNCSafeAreaProvider nativo já no binário)
import { HeaderHeightContext } from '@react-navigation/elements'; // [2026-10-07 native-ui-build] (dep do expo-router, cópia única)
import { haptic } from '../constants/theme';
import { IconChevronLeft, IconArrowLeft } from './Icons';

export const USE_NATIVE_HEADER = Platform.OS !== 'web';

// [2026-10-07 native-ui-build] Header de VIDRO no iOS: UINavigationBar
// transparente + UIBlurEffect do sistema (headerBlurEffect do
// react-native-screens — é nativo do RNS, NÃO depende do expo-blur, então
// funciona em qualquer binário). O conteúdo rola POR BAIXO do header.
// Android: header sólido (Material não usa vidro + blur custa GPU).
export const USE_BLUR_HEADER = Platform.OS === 'ios';

// Altura do header nativo p/ telas com header transparente (iOS blur). Usamos
// padding no contentContainer (e não contentInsetAdjustmentBehavior) porque
// ScrollView.scrollTo do RN clampa em -contentInset.top (ignora o inset
// ajustado) → scrollTo({y:0}) deixaria o topo escondido sob o header.
// Retorna 0 quando o blur não está ativo (Android/web) ou fora de um stack.
export function useBlurHeaderInset(enabled = true) {
  const h = React.useContext(HeaderHeightContext);
  if (!enabled || !USE_BLUR_HEADER) return 0;
  return typeof h === 'number' && h > 0 ? h : 0;
}

// [2026-10-08 header-inset-all] Conteúdo CORTADO sob o header nativo no iOS.
// O native-stack marca o header como `translucent` sempre que há busca nativa
// (headerSearchBarOptions), título grande (headerLargeTitle) ou vidro
// (headerTransparent/blur) → o RNS põe edgesForExtendedLayout=All e a view da
// tela começa em y=0, POR BAIXO de status bar + nav bar + barra de busca
// (~176pt num iPhone com Dynamic Island). Nenhum padding em JS acerta isso: o
// HeaderHeightContext NÃO inclui a barra de busca e a altura muda quando o
// título grande colapsa. Regra: o scrollable PRINCIPAL da tela (primeiro
// filho, encostado no topo) usa contentInsetAdjustmentBehavior="automatic" →
// o UIKit calcula o inset exato (e acompanha o colapso/expansão do header), e
// a tela NÃO soma paddingTop manual. Também ajusta o inset de baixo (home
// indicator) → não somar insets.bottom no paddingBottom.
// Consequências:
//  - estados sem lista (skeleton/erro/vazio) também ficam sob o header →
//    usar <NativeInsetView> (ScrollView travado c/ o mesmo inset);
//  - voltar ao topo: NÃO usar scrollTo({y:0}) (o RN clampa em -contentInset
//    "cru" e ignora o ajustado → topo escondido); remonte a lista (key) ou
//    use scrollToOffset({offset:-inset}).
// Header opaco sem busca/título grande (translucent=false): a tela já começa
// abaixo do header → o inset ajustado no topo é 0 (inofensivo); fica só o de
// baixo. Android (Toolbar sólida) e web: no-op.
export const IOS_NATIVE_INSET = USE_NATIVE_HEADER && Platform.OS === 'ios';
export function nativeScrollInsetProps(enabled = true) {
  if (!enabled || !IOS_NATIVE_INSET) return null;
  return {
    contentInsetAdjustmentBehavior: 'automatic',
    automaticallyAdjustsScrollIndicatorInsets: true,
  };
}
// Container p/ conteúdo NÃO rolável que fica no topo de uma tela com header
// translúcido (skeleton, erro, estado vazio): ScrollView travado com o mesmo
// inset automático, conteúdo com flexGrow 1 (centraliza igual a um View
// flex:1). Fora do iOS nativo é um View flex:1 comum.
export function NativeInsetView({ children, style, contentContainerStyle, enabled = true }) {
  if (!enabled || !IOS_NATIVE_INSET) {
    return <View style={[{ flex: 1 }, style, contentContainerStyle]}>{children}</View>;
  }
  return (
    <ScrollView
      style={[{ flex: 1 }, style]}
      contentContainerStyle={[{ flexGrow: 1 }, contentContainerStyle]}
      scrollEnabled={false}
      {...nativeScrollInsetProps()}
    >
      {children}
    </ScrollView>
  );
}

// Telas cujo TOPO é chrome FIXO (abas, chips, barra de ações) acima da lista —
// o inset automático do scroll não alcança esse chrome. Este wrapper é um
// SafeAreaListener (view nativa RNCSafeAreaProvider, JS-only → vale p/ OTA)
// que lê o safeAreaInsets.top DA PRÓPRIA VIEW: no UIKit isso já inclui status
// bar + nav bar + barra de busca (e acompanha a busca ativando / título
// grande colapsando). Aplica como marginTop num View interno (margin, não
// padding → filhos position:absolute — menus, toasts — também ficam abaixo do
// header) — sem loop (o listener mede a si mesmo, não o filho) e sem poluir o
// contexto de safe-area dos filhos (useSafeAreaInsets() continua o da raiz).
// Fora do iOS nativo é um View flex:1 comum. Header opaco (sem busca/título grande): top medido = 0.
export function NativeHeaderSafeArea({ children, style, enabled = true }) {
  const [top, setTop] = React.useState(0);
  const onChange = React.useCallback((e) => {
    const t = Math.max(0, Math.round(e?.insets?.top || 0));
    setTop((p) => (p === t ? p : t));
  }, []);
  if (!enabled || !IOS_NATIVE_INSET || !SafeAreaListener) {
    return <View style={[{ flex: 1 }, style]}>{children}</View>;
  }
  return (
    <SafeAreaListener style={[{ flex: 1 }, style]} onChange={onChange}>
      <View style={{ flex: 1, marginTop: top }}>{children}</View>
    </SafeAreaListener>
  );
}

// Opções comuns de header nativo, preto&branco (tint = cor do texto, sem azul).
// - headerBackButtonDisplayMode 'minimal': só o chevron (a tela anterior,
//   /chat, não tem título → senão apareceria "Voltar"/"chat").
// - search: SearchBarProps do RNS (UISearchController / SearchView Material).
export function nativeHeaderOptions({
  colors = {},
  title = '',
  headerRight,
  headerLeft,
  search,
  largeTitle = false,
  blur = false, // [2026-10-07 native-ui-build] iOS: header translúcido c/ blur do sistema
  isDark,
  ...rest
} = {}) {
  const bg = colors.headerBgSolid || colors.surface || colors.background;
  const fg = colors.text;
  const opts = {
    headerShown: true,
    title: title || '',
    headerTintColor: fg,
    headerTitleStyle: { color: fg },
    headerStyle: bg ? { backgroundColor: bg } : undefined,
    headerShadowVisible: true,
    headerBackButtonDisplayMode: 'minimal',
    headerTitleAlign: Platform.OS === 'ios' ? 'center' : 'left',
    ...(colors.background ? { contentStyle: { backgroundColor: colors.background } } : {}),
  };
  if (largeTitle && Platform.OS === 'ios') {
    opts.headerLargeTitle = true;
    opts.headerLargeTitleShadowVisible = false;
    opts.headerLargeStyle = bg ? { backgroundColor: bg } : undefined;
    opts.headerLargeTitleStyle = { color: fg };
  }
  if (blur && USE_BLUR_HEADER) {
    opts.headerTransparent = true;
    opts.headerBlurEffect = (isDark ?? colors.isDark)
      ? 'systemChromeMaterialDark'
      : (isDark === false ? 'systemChromeMaterialLight' : 'systemChromeMaterial');
    opts.headerStyle = { backgroundColor: 'transparent' };
    if (opts.headerLargeTitle) opts.headerLargeStyle = { backgroundColor: 'transparent' };
  }
  if (headerRight) opts.headerRight = headerRight;
  if (headerLeft) { opts.headerLeft = headerLeft; opts.headerBackVisible = false; }
  if (search) {
    opts.headerSearchBarOptions = {
      hideWhenScrolling: false,
      autoCapitalize: 'none',
      ...(Platform.OS === 'ios' ? { placement: 'stacked' } : {}),
      textColor: fg,
      tintColor: fg,
      headerIconColor: fg,
      hintTextColor: colors.textTertiary || colors.textSecondary,
      ...search,
    };
  }
  return { ...opts, ...rest };
}

// Botão de ícone p/ headerLeft/headerRight: ripple borderless no Android,
// opacidade no iOS, haptic leve, hitSlop generoso (44pt).
export function HeaderIconButton({ onPress, children, accessibilityLabel, disabled, style, testID }) {
  return (
    <Pressable
      onPress={(e) => { try { haptic.light?.(); } catch {} onPress && onPress(e); }}
      disabled={disabled}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      android_ripple={{ borderless: true, radius: 22 }}
      style={({ pressed }) => [{
        width: 36, height: 36, alignItems: 'center', justifyContent: 'center',
        opacity: disabled ? 0.4 : (pressed && Platform.OS === 'ios' ? 0.5 : 1),
      }, style]}
    >
      {children}
    </Pressable>
  );
}

// Back custom (p/ quando a tela tem sub-navegação interna, ex. categorias do
// /settings): chevron iOS 28pt / seta Material 24dp, como o back do sistema.
export function HeaderBackButton({ onPress, color, accessibilityLabel = 'Voltar' }) {
  return (
    <HeaderIconButton onPress={onPress} accessibilityLabel={accessibilityLabel} style={Platform.OS === 'ios' ? { marginLeft: -8 } : null}>
      {Platform.OS === 'ios'
        ? <IconChevronLeft size={28} color={color} />
        : <IconArrowLeft size={24} color={color} />}
    </HeaderIconButton>
  );
}
