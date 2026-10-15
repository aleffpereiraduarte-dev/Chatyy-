// modules/expo-chat-effects — [2026-10-15 native-effects]
//
// Efeitos de TELA CHEIA das mensagens em NATIVO (nível iMessage/Telegram):
//   iOS: overlay na key window (isUserInteractionEnabled = false) com
//        Core Animation / CAEmitterLayer, 120 Hz (ProMotion), respeita
//        "Reduzir Movimento".
//   Android: View de partículas no DecorView (Canvas + Choreographer, roda na
//        taxa do display), não intercepta toques, respeita "Remover animações".
//
// Efeitos (mesmos ids do JS):
//   tela ("enviar com efeito" / chegada): echo, spotlight, balloons, confetti,
//     love, lasers, fireworks, shooting-star, celebration
//   emoji/palavra-chave ao enviar (antigo MessageEffectOverlay):
//     hearts (❤️ 💖 💗 💕), fire (🔥), party (parabéns/congrats/🎉)
//
// Uso:  ChatyyEffects.play('love', { dark, emoji, intensity, origin: {x,y,w,h} })
//   → true quando o nativo assumiu (o chamador NÃO toca o fallback JS).
// Binário sem o módulo (build antigo / Expo Go / web) ou
// globalThis.__chatyy_native_effects === false → isAvailable() false e o
// chamador usa components/MessageScreenEffect.js como antes.
import { requireOptionalNativeModule } from 'expo-modules-core';

export type EffectName =
  | 'echo' | 'spotlight' | 'balloons' | 'confetti' | 'love' | 'lasers'
  | 'fireworks' | 'shooting-star' | 'celebration'
  | 'hearts' | 'fire' | 'party';

export type EffectOptions = {
  /** Tema escuro do app (tinta clara p/ eco/coração no fundo preto). */
  dark?: boolean;
  /** Emoji que substitui os padrões (hearts/fire/party). */
  emoji?: string;
  /** 0.3…1.6 — escala a quantidade de partículas. */
  intensity?: number;
  /** Retângulo de origem (pontos/dp da janela) — eco/corações partem daqui. */
  origin?: { x: number; y: number; w: number; h: number } | null;
};

type NativeMod = {
  apiVersion(): number;
  play(name: string, opts: Record<string, unknown>): Promise<boolean>;
  stopAll(): Promise<void>;
};

export const EFFECT_NAMES: ReadonlySet<string> = new Set([
  'echo', 'spotlight', 'balloons', 'confetti', 'love', 'lasers', 'fireworks',
  'shooting-star', 'celebration', 'hearts', 'fire', 'party',
]);

let _mod: NativeMod | null | undefined;

function mod(): NativeMod | null {
  if (_mod === undefined) {
    try { _mod = requireOptionalNativeModule<NativeMod>('ChatyyEffects'); } catch { _mod = null; }
  }
  return _mod || null;
}

export function isAvailable(): boolean {
  try {
    if ((globalThis as any).__chatyy_native_effects === false) return false;
    const m = mod();
    return !!m && m.apiVersion() >= 1;
  } catch { return false; }
}

/** Toca o efeito no nativo. false = não assumiu (use o fallback JS). */
export function play(name: string, opts: EffectOptions = {}): boolean {
  if (!name || !EFFECT_NAMES.has(name) || !isAvailable()) return false;
  const m = mod();
  if (!m) return false;
  const o: Record<string, unknown> = {};
  if (typeof opts.dark === 'boolean') o.dark = opts.dark;
  if (typeof opts.emoji === 'string' && opts.emoji) o.emoji = opts.emoji;
  if (typeof opts.intensity === 'number' && isFinite(opts.intensity)) o.intensity = opts.intensity;
  const r = opts.origin;
  if (r && [r.x, r.y, r.w, r.h].every((v) => typeof v === 'number' && isFinite(v))) {
    o.x = r.x; o.y = r.y; o.w = r.w; o.h = r.h;
  }
  try {
    const p = m.play(name, o);
    if (p && typeof (p as any).catch === 'function') (p as any).catch(() => {});
    return true;
  } catch { return false; }
}

export function stopAll(): void {
  try { const p = mod()?.stopAll(); if (p && typeof (p as any).catch === 'function') (p as any).catch(() => {}); } catch {}
}

const ChatyyEffects = { isAvailable, play, stopAll, EFFECT_NAMES };
export default ChatyyEffects;
