// [2026-10-13 video-studio] Reanimated + Gesture Handler com guarda de OTA
// (mesma sonda do PhotoEditor: só usa se o binário já tem Worklets/Reanimated).
// Sem eles (web / binário antigo) os componentes caem em PanResponder.
import { Platform } from 'react-native';
import { KEYBOARD_CONTROLLER_ACTIVE } from '../../utils/threadKeyboard';

let Rea = null;
let GH = null;
if (Platform.OS !== 'web' && KEYBOARD_CONTROLLER_ACTIVE) {
  try {
    // eslint-disable-next-line global-require
    Rea = require('react-native-reanimated');
    // eslint-disable-next-line global-require
    GH = require('react-native-gesture-handler');
  } catch { Rea = null; GH = null; }
}

export const REA_OK = !!(
  Rea && Rea.default && Rea.useSharedValue && Rea.useAnimatedStyle && Rea.runOnJS
  && GH && GH.Gesture && GH.GestureDetector
);
export { Rea, GH };
export const RAnimated = Rea ? Rea.default : null;
export const runOnJS = Rea ? Rea.runOnJS : null;
