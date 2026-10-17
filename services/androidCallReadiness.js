// [2026-10-17 android-wa] Android "ligações e mensagens chegam na hora" —
// pedidos estilo WhatsApp, SÓ quando fazem falta:
//
//  1. Android 14+ sem permissão de TELA CHEIA (USE_FULL_SCREEN_INTENT revogada
//     / não concedida) → ligação com o celular bloqueado vira só um banner.
//     Explica e abre o toggle do app (requestFullScreenIntentPermission).
//  2. Bateria: "Restrita" (isBackgroundRestricted), bucket RESTRICTED, ou o
//     nativo viu entrega degradada (FCM high → normal / FGS recusado,
//     CallFirebaseMessagingService.markDeliveryDegraded) e o app não está
//     isento de otimização → explica e abre as configurações do app.
//     NÃO usa REQUEST_IGNORE_BATTERY_OPTIMIZATIONS (restrita pelo Play).
//
// No máximo 1 pedido por sessão; cada tipo respeita 7 dias de intervalo e
// para de pedir depois de 3 recusas. Binários sem getBackgroundHealth (antes
// desta leva) ainda recebem o pedido de tela cheia via canUseFullScreenIntent.
// Kill switch: globalThis.__chatyy_android_readiness = false.
import { Platform, AppState } from 'react-native';

const K_PREFIX = 'chatyy:androidReadiness:';
const COOLDOWN_MS = 7 * 24 * 3600 * 1000;
const MAX_ASKS = 3;
const DEGRADED_WINDOW_MS = 3 * 24 * 3600 * 1000;
const BUCKET_RESTRICTED = 45;

let _askedThisSession = false;
let _running = false;

function _native() {
  try {
    const core = require('expo-modules-core');
    if (typeof core.requireOptionalNativeModule === 'function') return core.requireOptionalNativeModule('ExpoCallKit');
  } catch {}
  return null;
}

function _storage() {
  try { return require('@react-native-async-storage/async-storage').default; } catch { return null; }
}

async function _state(kind) {
  const S = _storage();
  if (!S) return { last: 0, n: 0 };
  try {
    const raw = await S.getItem(K_PREFIX + kind);
    const j = raw ? JSON.parse(raw) : null;
    return { last: Number(j?.last) || 0, n: Number(j?.n) || 0 };
  } catch { return { last: 0, n: 0 }; }
}

async function _mark(kind, st) {
  const S = _storage();
  if (!S) return;
  try { await S.setItem(K_PREFIX + kind, JSON.stringify({ last: Date.now(), n: (st?.n || 0) + 1 })); } catch {}
}

async function _canAsk(kind) {
  const st = await _state(kind);
  if (st.n >= MAX_ASKS) return null;
  if (Date.now() - st.last < COOLDOWN_MS) return null;
  return st;
}

function _tr(t, key, fb) {
  try {
    const s = typeof t === 'function' ? t(key) : '';
    if (s && s !== key) return s;
  } catch {}
  return fb;
}

function _alert(title, body, okLabel, laterLabel, onOk) {
  try {
    const { safeAlert } = require('./alerts');
    safeAlert(title, body, [
      { text: laterLabel, style: 'cancel' },
      { text: okLabel, onPress: onOk },
    ]);
    return true;
  } catch { return false; }
}

async function _health(m) {
  if (typeof m.getBackgroundHealth === 'function') {
    try { return (await m.getBackgroundHealth()) || null; } catch {}
  }
  // Binário antigo: só sabe responder a tela cheia.
  const h = { sdk: Number(Platform.Version) || 0, canUseFullScreenIntent: true };
  if (typeof m.canUseFullScreenIntent === 'function') {
    try { h.canUseFullScreenIntent = (await m.canUseFullScreenIntent()) !== false; } catch {}
  }
  return h;
}

function _batteryNeeded(h) {
  if (!h || typeof h !== 'object') return false;
  if (h.ignoringBatteryOptimizations === true) return false;
  if (h.backgroundRestricted === true) return true;
  if (Number(h.standbyBucket) >= BUCKET_RESTRICTED) return true;
  const at = Number(h.degradedAt) || 0;
  return at > 0 && Date.now() - at < DEGRADED_WINDOW_MS;
}

/**
 * Checa e, se fizer falta, mostra UM pedido. Chamar com o app ativo e logado
 * (app/chat.js, alguns segundos após montar). `t` = useLanguage().t.
 */
export async function maybePromptAndroidCallReadiness(t) {
  if (Platform.OS !== 'android' || _askedThisSession || _running) return false;
  try { if (globalThis.__chatyy_android_readiness === false) return false; } catch {}
  if (AppState.currentState !== 'active') return false;
  const m = _native();
  if (!m) return false;
  _running = true;
  try {
    const h = await _health(m);
    if (!h) return false;
    const sdk = Number(h.sdk) || Number(Platform.Version) || 0;

    if (sdk >= 34 && h.canUseFullScreenIntent === false && typeof m.requestFullScreenIntentPermission === 'function') {
      const st = await _canAsk('fsi');
      if (st) {
        _askedThisSession = true;
        await _mark('fsi', st);
        return _alert(
          _tr(t, 'androidReady.fsiTitle', 'Ligações em tela cheia'),
          _tr(t, 'androidReady.fsiBody', 'Para ver quem está ligando com o celular bloqueado, como no WhatsApp, permita que o Chatyy mostre notificações em tela cheia.'),
          _tr(t, 'androidReady.allow', 'Permitir'),
          _tr(t, 'androidReady.later', 'Agora não'),
          () => { try { m.requestFullScreenIntentPermission().catch(() => {}); } catch {} },
        );
      }
    }

    if (_batteryNeeded(h) && typeof m.openBatterySettings === 'function') {
      const st = await _canAsk('battery');
      if (st) {
        _askedThisSession = true;
        await _mark('battery', st);
        return _alert(
          _tr(t, 'androidReady.batteryTitle', 'Receba ligações e mensagens na hora'),
          _tr(t, 'androidReady.batteryBody', 'O Android está limitando o Chatyy em segundo plano, então ligações e mensagens podem atrasar. Em Bateria, escolha "Sem restrições".'),
          _tr(t, 'androidReady.openSettings', 'Abrir configurações'),
          _tr(t, 'androidReady.later', 'Agora não'),
          () => {
            try { m.openBatterySettings().catch(() => {}); } catch {}
            try { if (typeof m.clearDeliveryDegraded === 'function') m.clearDeliveryDegraded(); } catch {}
          },
        );
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    _running = false;
  }
}
