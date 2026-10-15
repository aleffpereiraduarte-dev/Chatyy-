// modules/expo-email-native — [2026-10-15 native-email]
//
// E-mail nativo nível Apple Mail / Gmail:
//   ChatyyEmailBody   corpo do e-mail (leitor + thread)
//     iOS: WKWebView dedicado — JS do conteúdo DESLIGADO, script de medida só
//          num mundo isolado, WKContentRuleList bloqueando conteúdo remoto,
//          armazenamento não persistente, altura automática, pinça, menu de
//          link nativo (Abrir / Copiar / Compartilhar).
//     Android: WebView dedicado — sem arquivo/conteúdo/janelas/cookies de
//          terceiros, CSP script-src 'none', shouldInterceptRequest barra
//          http(s) remoto, altura automática, pinça.
//   ChatyyRichEditor  editor rico do compositor
//     iOS: UITextView (TextKit 1) + NSAttributedString
//     Android: EditText + spans
//     negrito/itálico/sublinhado/tachado/link/listas/citação; HTML entra e sai.
//
// Binário sem o módulo (build antigo, Expo Go, web) → getters devolvem null e
// as telas usam o caminho JS (WebView / contentEditable). Nada é sondado no import.
// Kill switches OTA:
//   globalThis.__chatyy_native_email_reader = false  → leitor volta ao JS
//   globalThis.__chatyy_native_compose = false       → editor volta ao WebView

import { Platform } from 'react-native';

export const EMAIL_BODY_VIEW = 'ChatyyEmailBody';
export const RICH_EDITOR_VIEW = 'ChatyyRichEditor';

const _views: Record<string, any> = {};

function _probe(name: string): any {
  if (Object.prototype.hasOwnProperty.call(_views, name)) return _views[name];
  _views[name] = null;
  if (Platform.OS === 'web') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const core = require('expo-modules-core');
    const mod = typeof core.requireOptionalNativeModule === 'function'
      ? core.requireOptionalNativeModule(name)
      : null;
    if (!mod) return null;
    let api = 0;
    try { api = typeof mod.apiVersion === 'function' ? Number(mod.apiVersion()) || 0 : 0; } catch { api = 0; }
    if (api < 1) return null;
    const g: any = globalThis as any;
    // A view precisa estar registrada (requireNativeView não lança sozinho).
    if (g?.expo?.getViewConfig && !g.expo.getViewConfig(name)) return null;
    const req = core.requireNativeViewManager || core.requireNativeView;
    if (typeof req === 'function') _views[name] = req(name);
  } catch {
    _views[name] = null;
  }
  return _views[name];
}

function _flagOff(key: string): boolean {
  try { return (globalThis as any)[key] === false; } catch { return false; }
}

/** View nativa do corpo do e-mail, ou null (binário sem o módulo / kill switch). */
export function getNativeEmailBodyView(): any {
  if (_flagOff('__chatyy_native_email_reader')) return null;
  return _probe(EMAIL_BODY_VIEW);
}

/** View nativa do editor rico, ou null (binário sem o módulo / kill switch). */
export function getNativeRichEditorView(): any {
  if (_flagOff('__chatyy_native_compose')) return null;
  return _probe(RICH_EDITOR_VIEW);
}

export function isEmailBodyAvailable(): boolean {
  return !!getNativeEmailBodyView();
}

export function isRichEditorAvailable(): boolean {
  return !!getNativeRichEditorView();
}

export default { getNativeEmailBodyView, getNativeRichEditorView, isEmailBodyAvailable, isRichEditorAvailable };
