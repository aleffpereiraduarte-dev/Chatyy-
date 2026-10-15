// [2026-10-14 motion] Chave única das animações "nível Telegram" da conversa.
//   globalThis.__chatyy_motion = false  → desliga (volta ao comportamento antigo)
//   Reduzir movimento (iOS/Android/web)  → desliga
// Todas as animações daqui rodam com native driver (UI thread) no nativo: só
// transform/opacity, nunca layout — não brigam com o pin do fim da lista.
import { Platform } from 'react-native';
import { isReduceMotionEnabled } from '../../reducedMotion';

export const MOTION_ND = Platform.OS !== 'web';

export function motionOn() {
  try { if (typeof globalThis !== 'undefined' && globalThis.__chatyy_motion === false) return false; } catch {}
  try { return !isReduceMotionEnabled(); } catch { return true; }
}

// Molas (RN Animated: stiffness/damping/mass). ~250 ms até assentar.
export const SPRING_SEND = { stiffness: 340, damping: 28, mass: 1 };
export const SPRING_IN = { stiffness: 300, damping: 26, mass: 1 };
export const SPRING_POP = { stiffness: 420, damping: 18, mass: 0.8 };
export const SPRING_FAB = { stiffness: 380, damping: 26, mass: 1 };
