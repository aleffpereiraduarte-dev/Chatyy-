// nativeFriendLocation — ponte para o módulo nativo "ChatyyFriendLocation"
// ======================================================================
// [2026-10-12 find-my] Mapa de amigos com o app FECHADO.
//   iOS:     FriendLocationAgent.swift — mudança significativa de localização
//            + visitas (o iOS relança o app em 2º plano mesmo depois de
//            encerrado pelo sistema) + resposta nativa ao push silencioso
//            "Pedir atualização". POST em Swift, sem depender do JS.
//   Android: FriendLocationPinger.kt — responde ao push "Pedir atualização"
//            nativamente (só entrega posição com o app em uso enquanto não
//            houver ACCESS_BACKGROUND_LOCATION — ver comentário no .kt).
//
// Binário antigo (sem o módulo) → isAvailable() = false e o app segue com o
// comportamento anterior (expo-location + heartbeat + handler JS do ping).
import { Platform } from 'react-native';

let _mod; // undefined = ainda não procurado; null = ausente
function mod() {
  if (_mod !== undefined) return _mod;
  _mod = null;
  if (Platform.OS === 'web') return _mod;
  try {
    const { requireOptionalNativeModule } = require('expo-modules-core');
    const m = requireOptionalNativeModule?.('ChatyyFriendLocation') || null;
    if (m && typeof m.start === 'function' && typeof m.stop === 'function') _mod = m;
  } catch { _mod = null; }
  return _mod;
}

export function isAvailable() { return !!mod(); }

let _lastKey = '';
let _lastAt = 0;
const RESTART_EVERY_MS = 10 * 60 * 1000; // idempotente no nativo; reafirma de vez em quando

/** Liga o envio nativo (persistido no lado nativo; sobrevive a relançamento). */
export async function startNative(acct) {
  const m = mod();
  if (!m) return false;
  const key = `on:${String(acct || '').toLowerCase()}`;
  const now = Date.now();
  if (key === _lastKey && now - _lastAt < RESTART_EVERY_MS) return true;
  try {
    await m.start(String(acct || ''));
    _lastKey = key; _lastAt = now;
    return true;
  } catch { return false; }
}

export async function stopNative() {
  const m = mod();
  if (!m) return false;
  if (_lastKey === 'off' && Date.now() - _lastAt < RESTART_EVERY_MS) return true;
  try {
    await m.stop();
    _lastKey = 'off'; _lastAt = Date.now();
    return true;
  } catch { return false; }
}

/** { enabled, monitoring, auth, lastPostAt, lastResult, ... } | null */
export function getNativeStatus() {
  const m = mod();
  if (!m?.getStatus) return null;
  try { return m.getStatus() || null; } catch { return null; }
}

/** Publica uma posição agora pelo caminho nativo (diagnóstico). */
export async function requestOnceNative() {
  const m = mod();
  if (!m?.requestOnce) return false;
  try { return !!(await m.requestOnce()); } catch { return false; }
}
