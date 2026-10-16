// modules/expo-chat-row-zoom — [wave8 row-zoom] "A conversa cresce a partir da linha".
//
// Módulo nativo `ChatyyRowZoom` (iOS: snapshot views + máscara no key window;
// Android: PixelCopy + View no DecorView). Contrato:
//   apiVersion() → 1
//   begin({x, y, w, h, dark, radius, dim, maxWait}) → Promise<boolean>
//        x/y/w/h = frame da linha EM COORDENADAS DA JANELA, na unidade nativa
//        (iOS pt / Android px) — exatamente o `frame` que a lista nativa manda
//        no onRowPress. true = overlay montado (o JS faz o push sem animação).
//   ready()  → a casca da conversa pintou: começa a animar
//   cancel() → some com o overlay (push não aconteceu / falhou)
//   evento onZoomEnd {ok}
// Orquestração JS: services/rowZoomTransition.js.
// Binário sem o módulo (build antigo, Expo Go, web) → getRowZoomModule() null.
import { Platform } from 'react-native';

let _checked = false;
let _mod: any = null;

export function getRowZoomModule(): any {
  if (_checked) return _mod;
  _checked = true;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const core = require('expo-modules-core');
    const m = typeof core.requireOptionalNativeModule === 'function'
      ? core.requireOptionalNativeModule('ChatyyRowZoom')
      : null;
    if (!m) return null;
    let api = 0;
    try { api = typeof m.apiVersion === 'function' ? Number(m.apiVersion()) || 0 : 0; } catch { api = 0; }
    if (api < 1) return null;
    _mod = m;
  } catch {
    _mod = null;
  }
  return _mod;
}

export function isAvailable(): boolean {
  return !!getRowZoomModule();
}
