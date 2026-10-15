// modules/expo-chat-profile — [2026-10-15 native-profile]
//
// "Dados do contato / grupo" com cabeçalho NATIVO estilo Telegram. TODAS as
// ações continuam no JS (app/chat-conversation.js via
// components/chat/NativeProfileBridge.js) — o nativo só desenha e emite keys.
//
//   ChatyyProfileHeader (container): recebe como filho o <ScrollView> RN da
//     folha (com paddingTop = expandedHeight). Por cima desenha o cabeçalho:
//     avatar grande, nome, subtítulo, linha de ações. Observa o contentOffset
//     do ScrollView RN (sem mexer na geometria dele — toques/measure intactos):
//       • rolar p/ cima → avatar encolhe e sobe para a barra (ao lado do título)
//         e as ações somem; solto no meio → assenta com spring;
//       • puxar p/ baixo → avatar estica (rubber band); passou do limite ao
//         soltar → galeria de fotos em tela cheia (hero do avatar, paginação,
//         arrastar p/ baixo fecha).
//   ChatyyProfileMedia: abas Mídia | Links | Arquivos com grade nativa de
//     miniaturas (tamanho próprio → onHeightChange + setStyleSize).
//   ChatyyProfileList: lista nativa (membros / grupos em comum) com avatar,
//     selo, link e botões por linha → onRowAction{key, action}.
//
// Binário sem o módulo (build antigo, Expo Go, web) → isAvailable() === false
// e a folha JS de antes é usada. Kill switch: globalThis.__chatyy_native_profile = false.

import { requireOptionalNativeModule } from 'expo-modules-core';

export type ProfileImage = { uri: string; headers?: Record<string, string> | null };

export type ProfileTheme = {
  dark?: boolean;
  /** processColor() → número ARGB. */
  background?: number | null;
  surface?: number | null;
  card?: number | null;
  cardBorder?: number | null;
  text?: number | null;
  secondaryText?: number | null;
  tertiaryText?: number | null;
  accent?: number | null;
  hairline?: number | null;
  destructive?: number | null;
};

export type ProfileAction = {
  key: string;
  label: string;
  /** message | call | video | search | mute | unmute | more | camera | link | leave */
  icon: string;
  active?: boolean;
};

export type ProfileHeaderEvents = {
  onClose: Record<string, never>;
  onAction: { key: string };
  onAvatarPress: Record<string, never>;
  onGallery: { open: boolean };
};

export type ProfileMediaEvents = {
  onHeightChange: { height: number };
  onItem: { tab: string; key: string };
  onSeeAll: { tab: string };
  onTabChange: { tab: string };
};

export type ProfileListRow = {
  key: string;
  title: string;
  subtitle?: string;
  avatar?: ProfileImage | null;
  initials?: string;
  avatarColor?: number | null;
  badge?: string;
  link?: { key: string; label: string } | null;
  buttons?: { key: string; label?: string; style?: 'pill' | 'remove' }[];
  chevron?: boolean;
};

export type ProfileListEvents = {
  onHeightChange: { height: number };
  onRowAction: { key: string; action: string };
};

const _probed: Record<string, boolean> = {};
const _views: Record<string, any> = {};

function killSwitchOff(): boolean {
  try { return (globalThis as any).__chatyy_native_profile === false; } catch { return false; }
}

function probe(name: string): any {
  if (_probed[name]) return _views[name] || null;
  _probed[name] = true;
  _views[name] = null;
  try {
    const mod = requireOptionalNativeModule(name);
    if (!mod) return null;
    const g: any = globalThis as any;
    const cfg = g?.expo?.getViewConfig ? g.expo.getViewConfig(name) : null;
    if (!cfg) return null;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { requireNativeView } = require('expo');
    _views[name] = requireNativeView(name);
  } catch {
    _views[name] = null;
  }
  return _views[name] || null;
}

export function getProfileHeaderView(): any { return probe('ChatyyProfileHeader'); }
export function getProfileMediaView(): any { return probe('ChatyyProfileMedia'); }
export function getProfileListView(): any { return probe('ChatyyProfileList'); }

/** As 3 views existem no binário e o kill switch não está desligado. */
export function isAvailable(): boolean {
  if (killSwitchOff()) return false;
  return !!(getProfileHeaderView() && getProfileMediaView() && getProfileListView());
}

export default { isAvailable, getProfileHeaderView, getProfileMediaView, getProfileListView };
