// modules/expo-chat-effects/liveStage.js — [2026-10-15 native-live]
//
// Palco NATIVO do visualizador de live (iOS ChatyyLiveStageView / Android
// ChatyyLiveStageView): swipe vertical entre lives (Reels) com prévia nativa,
// corações por toque / remotos e presentes animados nativos, botão de mudo.
// Os tiles de vídeo do LiveKit entram como FILHOS; o chat continua JS por cima.
//
// Binário sem a view (antigo / Expo Go / web) ou globalThis.__chatyy_native_live
// === false → getLiveStageView() null e o live-viewer usa o caminho JS de sempre.
import { Platform } from 'react-native';

let _probed = false;
let _view = null;

export function getLiveStageView() {
  if (_probed) return _view;
  _probed = true;
  _view = null;
  if (Platform.OS === 'web') return null;
  try {
    // eslint-disable-next-line global-require
    const { requireOptionalNativeModule } = require('expo-modules-core');
    const mod = requireOptionalNativeModule('ChatyyLiveStage');
    if (!mod || typeof mod.apiVersion !== 'function' || mod.apiVersion() < 1) return null;
    const cfg = globalThis?.expo?.getViewConfig ? globalThis.expo.getViewConfig('ChatyyLiveStage') : null;
    if (!cfg) return null;
    // eslint-disable-next-line global-require
    const { requireNativeView } = require('expo');
    _view = requireNativeView('ChatyyLiveStage');
  } catch {
    _view = null;
  }
  return _view;
}

export function isLiveStageAvailable() {
  try { if (globalThis.__chatyy_native_live === false) return false; } catch {}
  return !!getLiveStageView();
}

/** Iniciais p/ o avatar da prévia. */
export function initialsOf(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  const parts = s.split(/[\s._@-]+/).filter(Boolean);
  const a = parts[0] ? parts[0][0] : '';
  const b = parts.length > 1 ? parts[1][0] : '';
  return (a + b).toUpperCase();
}

/** Tipo de presente (gift_type do hub) → kind nativo. */
export function giftKind(type) {
  const t = String(type || '').toLowerCase();
  return ['rose', 'heart', 'star', 'crown', 'fire', 'rocket'].includes(t) ? t : 'heart';
}

export default { getLiveStageView, isLiveStageAvailable, initialsOf, giftKind };
