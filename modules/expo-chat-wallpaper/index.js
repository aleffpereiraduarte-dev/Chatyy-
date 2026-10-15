// modules/expo-chat-wallpaper — [2026-10-15 native-wallpaper]
//
// Papel de parede NATIVO da conversa (nível Telegram):
//   iOS: gradiente de 4 cores (bitmap 60×80 ampliado pelo Core Animation,
//        recalculado só enquanto anima), padrão vetorial (cor-padrão UIKit /
//        UIView.mask no escuro), foto com CIGaussianBlur, paralaxe UIMotionEffect.
//   Android: mesmo gradiente (Bitmap + BitmapShader), padrão BitmapShader REPEAT
//        (ComposeShader DST_IN no modo máscara), foto com desfoque barato,
//        paralaxe pelo sensor de gravidade.
// Parado = zero quadros redesenhados. Respeita Reduzir Movimento / Remover animações.
//
// Binário sem o módulo (antigo / Expo Go / web) ou
// globalThis.__chatyy_native_wallpaper === false → getWallpaperView() null e
// o chamador usa o fallback JS (components/wallpaper/ChatWallpaper.js).
import { Platform } from 'react-native';

let _probed = false;
let _view = null;

export function getWallpaperView() {
  if (_probed) return _view;
  _probed = true;
  _view = null;
  if (Platform.OS === 'web') return null;
  try {
    // eslint-disable-next-line global-require
    const { requireOptionalNativeModule } = require('expo-modules-core');
    const mod = requireOptionalNativeModule('ChatyyWallpaper');
    if (!mod || typeof mod.apiVersion !== 'function' || mod.apiVersion() < 1) return null;
    const cfg = globalThis?.expo?.getViewConfig ? globalThis.expo.getViewConfig('ChatyyWallpaper') : null;
    if (!cfg) return null;
    // eslint-disable-next-line global-require
    const { requireNativeView } = require('expo');
    _view = requireNativeView('ChatyyWallpaper');
  } catch {
    _view = null;
  }
  return _view;
}

export function isNativeWallpaperAvailable() {
  try { if (globalThis.__chatyy_native_wallpaper === false) return false; } catch {}
  return !!getWallpaperView();
}

export default { getWallpaperView, isNativeWallpaperAvailable };
