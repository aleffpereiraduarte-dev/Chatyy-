// modules/expo-chat-composer — [2026-10-14 native-composer]
//
// Composer da conversa NATIVO (nível Telegram/iMessage). A view só captura e
// entrega; envio/fila/rascunho/menções continuam no JS
// (components/chat/NativeComposerBridge.js ↔ app/chat-conversation.js).
//
//   iOS: UITextView auto-crescente (até maxLines), placeholder, colar imagem,
//        menções destacadas, ditado/seleção nativos; botão enviar ⇄ mic com
//        morph; gravação AVAudioRecorder (AAC m4a mono) segurando o mic com
//        deslizar p/ cancelar / p/ cima travar + onda ao vivo + haptics;
//        barra de resposta/edição animada.
//   Android: EditText + OnReceiveContentListener (colar / GIF do teclado),
//        MediaRecorder AAC, WindowInsetsAnimationCompat (opt-in), haptics.
//
// Binário sem o módulo (build antigo, Expo Go, web) → isAvailable() === false
// e o chamador usa o composer JS. Kill switch: globalThis.__chatyy_native_composer = false.

import { requireOptionalNativeModule } from 'expo-modules-core';

export type ComposerTheme = {
  dark?: boolean;
  /** Todas as cores já passadas por processColor() (número ARGB). */
  surface?: number | null;
  pill?: number | null;
  pillBorder?: number | null;
  text?: number | null;
  secondaryText?: number | null;
  placeholder?: number | null;
  icon?: number | null;
  iconActive?: number | null;
  action?: number | null;
  actionIcon?: number | null;
  hairline?: number | null;
  accent?: number | null;
  mention?: number | null;
  replyCard?: number | null;
  replyCardBorder?: number | null;
  recording?: number | null;
};

export type ComposerReplyPreview = {
  kind: 'reply' | 'edit';
  key: string;
  title: string;
  text: string;
  italic?: boolean;
  thumbUri?: string | null;
  thumbRound?: boolean;
  // [reply-v2]
  color?: number | null;
  icon?: string;
  lines?: number;
  focus?: boolean;
  pop?: boolean;
  iconVb?: number;
  iconPaths?: { d: string; fill?: number; w?: number }[];
};

export type ComposerMentionCandidate = { token: string; email: string };
export type ComposerMenuItem = { key: string; label: string };

export type VoiceState =
  | 'recording' | 'locked' | 'sent' | 'cancelled' | 'tooShort' | 'tapHint'
  | 'blocked' | 'error' | 'permissionGranted';

export type ComposerEvents = {
  onChangeText: { text: string };
  onSend: { text: string; mentions: string[] };
  onVoiceRecorded: { uri: string; durationMs: number; sizeBytes: number; waveform: number[]; mimeType: string; name: string };
  onVoiceState: { state: VoiceState; reason?: string };
  onHeightChange: { height: number };
  onSelectionChange: { start: number; end: number };
  onPasteImage: { uri: string; mimeType: string; name: string; width: number; height: number; size: number };
  onFocusChange: { focused: boolean };
  onSendMenu: { key: string };
  onKeyboardFrame: { height: number; lift: number };
};

export type ComposerHandle = {
  focus(): Promise<void>;
  blur(): Promise<void>;
  setText(text: string): Promise<void>;
  clear(): Promise<void>;
  setSelection(start: number, end: number): Promise<void>;
  cancelVoice(): Promise<void>;
};

let _probed = false;
let _view: any = null;

function killSwitchOff(): boolean {
  try { return (globalThis as any).__chatyy_native_composer === false; } catch { return false; }
}

/**
 * `requireNativeView` não lança para view inexistente (só falha ao renderizar),
 * então o probe lê a view config exposta pelo core do Expo (JSI síncrono) e o
 * módulo opcional. Chamar sempre de forma preguiçosa (render/efeito).
 */
export function getNativeComposerView(): any {
  if (_probed) return _view;
  _probed = true;
  _view = null;
  try {
    const mod = requireOptionalNativeModule('ChatyyComposer');
    if (!mod) return null;
    const g: any = globalThis as any;
    const cfg = g?.expo?.getViewConfig ? g.expo.getViewConfig('ChatyyComposer') : null;
    if (!cfg) return null;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { requireNativeView } = require('expo');
    _view = requireNativeView('ChatyyComposer');
  } catch {
    _view = null;
  }
  return _view;
}

export function isAvailable(): boolean {
  if (killSwitchOff()) return false;
  return !!getNativeComposerView();
}

/** Versão do contrato nativo (0 = sem módulo). 2 = cartão de resposta iOS corrigido. */
let _api: number | null = null;
export function apiVersion(): number {
  if (_api != null) return _api;
  try {
    const mod: any = requireOptionalNativeModule('ChatyyComposer');
    const v = mod && typeof mod.apiVersion === 'function' ? Number(mod.apiVersion()) : 0;
    _api = Number.isFinite(v) ? v : 0;
  } catch {
    _api = 0;
  }
  return _api;
}

export default { isAvailable, getNativeComposerView, apiVersion };
