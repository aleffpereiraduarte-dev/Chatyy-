// modules/expo-chat-emoji — [2026-10-15 native-emoji]
//
// Painel do composer NATIVO (nível Telegram): Emoji | Figurinhas | GIF.
// A view só desenha e entrega toques; inserir o emoji no texto, enviar a
// figurinha / o GIF e buscar GIFs continuam no JS
// (components/chat/NativeEmojiPanelBridge.js ↔ app/chat-conversation.js).
//
//   Emoji: grade com categorias (barra de ícones que acompanha a rolagem),
//          recentes (salvos no aparelho), busca por nome, tons de pele
//          (segurar o emoji → balão com 5 tons; o escolhido vira padrão),
//          apagar (backspace) com repetição ao segurar.
//   Figurinhas: seções vindas do JS (recentes/favoritas/minhas/pacotes) com
//          abas de capa; WebP/GIF animados (ImageIO no iOS, Glide no Android).
//   GIF: grade em mosaico com os resultados que o JS buscou (api.chatSearchGifs);
//          o campo de busca emite onGifQuery.
//   compact = modo busca (campo de busca com o teclado aberto): o painel
//          encolhe para campo + 1 faixa horizontal de resultados.
//
// Binário sem o módulo (build antigo, Expo Go, web) → isAvailable() === false
// e o chamador usa os painéis JS. Kill switch: globalThis.__chatyy_native_emoji = false.
//
// [2026-10-16 sticker-panel v2] apiVersion 2 (prop richStickers=true):
//   • figurinhas Lottie (item.lottie ou URL .json) tocando na grade — só as
//     visíveis tocam (pausa fora da tela / aba / painel fechado);
//   • segurar figurinha = prévia grande + haptic (arrastar troca a prévia);
//   • toque = figurinha "voa" da grade até a conversa (snapshot nativo);
//   • onSticker ganha `lottie` (true → JS envia como lottie_sticker).
// Binário apiVersion 1 ignora a prop e o JS não manda itens Lottie.
// Kill switch das figurinhas/GIF nativos: globalThis.__chatyy_native_sticker_panel = false.

import { requireOptionalNativeModule } from 'expo-modules-core';

export type EmojiPanelTab = 'emoji' | 'stickers' | 'gif';

export type EmojiPanelTheme = {
  dark?: boolean;
  /** processColor() → número ARGB. */
  background?: number | null;
  surface?: number | null;
  text?: number | null;
  secondaryText?: number | null;
  icon?: number | null;
  iconActive?: number | null;
  accent?: number | null;
  hairline?: number | null;
  selection?: number | null;
};

export type StickerSection = {
  key: string;
  title?: string;
  /** 'recent' | 'favorites' | 'mine' | 'pack' — ícone da aba (pack usa coverUri). */
  icon?: string;
  coverUri?: string | null;
  loading?: boolean;
  items: { key: string; uri: string; lottie?: boolean }[];
};

export type GifItem = { key: string; uri: string; width?: number; height?: number };

export type EmojiPanelEvents = {
  onEmoji: { emoji: string };
  onBackspace: Record<string, never>;
  onSticker: { key: string; uri: string; section: string; lottie?: boolean };
  onGif: { key: string };
  onGifQuery: { query: string };
  onSection: { key: string };
  onTabChange: { tab: EmojiPanelTab };
  onMore: { tab: EmojiPanelTab };
  onSearchFocus: { focused: boolean; tab: EmojiPanelTab };
};

let _probed = false;
let _view: any = null;

function killSwitchOff(): boolean {
  try { return (globalThis as any).__chatyy_native_emoji === false; } catch { return false; }
}

/** Mesmo probe do composer nativo: view config via JSI + módulo opcional. */
export function getNativeEmojiPanelView(): any {
  if (_probed) return _view;
  _probed = true;
  _view = null;
  try {
    const mod = requireOptionalNativeModule('ChatyyEmojiPanel');
    if (!mod) return null;
    const g: any = globalThis as any;
    const cfg = g?.expo?.getViewConfig ? g.expo.getViewConfig('ChatyyEmojiPanel') : null;
    if (!cfg) return null;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { requireNativeView } = require('expo');
    _view = requireNativeView('ChatyyEmojiPanel');
  } catch {
    _view = null;
  }
  return _view;
}

export function isAvailable(): boolean {
  if (killSwitchOff()) return false;
  return !!getNativeEmojiPanelView();
}

let _apiVersion: number | null = null;
/** 1 = painel 2026-10-15; 2 = Lottie + prévia + voo (richStickers). 0 = sem módulo. */
export function getApiVersion(): number {
  if (_apiVersion != null) return _apiVersion;
  let v = 0;
  try {
    const mod: any = requireOptionalNativeModule('ChatyyEmojiPanel');
    const n = mod && typeof mod.apiVersion === 'function' ? Number(mod.apiVersion()) : 0;
    v = Number.isFinite(n) ? n : 0;
  } catch {
    v = 0;
  }
  _apiVersion = v;
  return v;
}

export default { isAvailable, getNativeEmojiPanelView, getApiVersion };
