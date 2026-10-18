// modules/expo-native-tabbar — [2026-10-15 native-tabs]
//
// Barra de abas inferior da home (app/chat.js) NATIVA.
//   iOS: UITabBar real (material translúcido do sistema / Liquid Glass no
//        iOS 26, SF Symbols, badges do sistema, bounce com mola, haptic).
//   Android: barra Material 3 desenhada com Views (pílula animada, ripple,
//        ícones vetoriais preenchidos quando ativos, badge, overshoot, haptic).
//
// Binário sem o módulo (build antigo, Expo Go, web) → isAvailable() === false
// e o chamador usa a barra JS (TabBarItem). Kill switch (OTA/console):
//   globalThis.__chatyy_native_tabs = false

import { requireOptionalNativeModule } from 'expo-modules-core';

export type NativeTabItem = {
  key: string;
  label: string;
  /** iOS: SF Symbol (inativo / ativo). */
  sfSymbol: string;
  sfSymbolActive?: string;
  /** Android: chats | email | reels | calls | apps | you (api 2+) (vetores do módulo). */
  androidIcon?: string;
  badge?: number;
  dot?: boolean;
  /** Emite onTabLongPress (ex.: Chats → câmera do status). */
  longPress?: boolean;
  /** false = nunca fica marcada (ex.: Email abre outra tela). */
  selectable?: boolean;
  /** [2026-10-18 you-tab-avatar] api 3+: foto redonda no lugar do ícone (http(s)/file://). */
  avatarUrl?: string | null;
  /** Cabeçalhos do download da foto (ex.: Authorization). */
  avatarHeaders?: Record<string, string> | null;
};

export type NativeTabTheme = {
  dark?: boolean;
  /** Cores já passadas por processColor() (número ARGB). */
  active?: number | null;
  inactive?: number | null;
  background?: number | null;
  hairline?: number | null;
  badgeBackground?: number | null;
  badgeText?: number | null;
  pill?: number | null;
  ripple?: number | null;
};

let _probed = false;
let _view: any = null;

function killSwitchOff(): boolean {
  try { return (globalThis as any).__chatyy_native_tabs === false; } catch { return false; }
}

/**
 * `requireNativeView` não lança para view inexistente (só falha ao renderizar),
 * então o probe confere o módulo opcional + a view config (JSI síncrono).
 */
export function getNativeTabBarView(): any {
  if (_probed) return _view;
  _probed = true;
  _view = null;
  try {
    const mod = requireOptionalNativeModule('ChatyyTabBar');
    if (!mod) return null;
    const g: any = globalThis as any;
    const cfg = g?.expo?.getViewConfig ? g.expo.getViewConfig('ChatyyTabBar') : null;
    if (!cfg) return null;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { requireNativeView } = require('expo');
    _view = requireNativeView('ChatyyTabBar');
  } catch {
    _view = null;
  }
  return _view;
}

export function isAvailable(): boolean {
  if (killSwitchOff()) return false;
  return !!getNativeTabBarView();
}

/** [2026-10-18 you-tab] Versão do contrato nativo (0 = desconhecida). Android 2+ = ícone "you".
 *  3+ (iOS e Android) = items[].avatarUrl (foto na aba Você). */
export function apiVersion(): number {
  try {
    const mod: any = requireOptionalNativeModule('ChatyyTabBar');
    const v = mod && typeof mod.apiVersion === 'function' ? Number(mod.apiVersion()) : 0;
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

export default { isAvailable, getNativeTabBarView, apiVersion };
