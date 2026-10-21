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

// [toque 2026-10-21] Notificações NEGADAS (Android 13+) ou canal "incoming_calls"
// bloqueado/rebaixado: o FCM de alta prioridade chega, mas a notificação da
// ligação (e a tela cheia dela) não aparece — o celular não toca. Medido
// 21/10: 4 de 16 Android ativos com notif_perm=denied. Só 'denied' (o pedido
// inicial é do fluxo normal de push; 'undetermined' não é tocado aqui).
const CALL_CHANNEL_ID = 'incoming_calls';
const IMPORTANCE_DEFAULT = 5; // expo AndroidImportance (NONE=2, MIN=3, LOW=4, DEFAULT=5, HIGH=6)
async function _notifState() {
  let N = null;
  try { N = require('expo-notifications'); } catch { return null; }
  const out = { denied: false, canAskAgain: false, channelLow: false };
  try {
    const p = await N.getPermissionsAsync();
    out.denied = !!p && p.granted !== true && p.status === 'denied';
    out.canAskAgain = !!p && p.canAskAgain === true;
  } catch {}
  if (!out.denied && typeof N.getNotificationChannelAsync === 'function') {
    try {
      const ch = await N.getNotificationChannelAsync(CALL_CHANNEL_ID);
      const imp = Number(ch?.importance) || 0;
      out.channelLow = imp > 1 && imp < IMPORTANCE_DEFAULT;
    } catch {}
  }
  return out;
}

async function _openNotifSettings() {
  try {
    const { Linking } = require('react-native');
    let pkg = '';
    try { pkg = require('expo-application').applicationId || ''; } catch {}
    if (!pkg) pkg = 'com.onemundo.mail'; // app.json android.package
    if (pkg && typeof Linking.sendIntent === 'function') {
      try {
        await Linking.sendIntent('android.settings.APP_NOTIFICATION_SETTINGS', [
          { key: 'android.provider.extra.APP_PACKAGE', value: pkg },
        ]);
        return;
      } catch {}
    }
    await Linking.openSettings();
  } catch {}
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

    // [toque 2026-10-21] Sem notificação não há tela de chamada — vem antes da tela cheia.
    let ns = null;
    try { if (globalThis.__chatyy_android_readiness_notif !== false) ns = await _notifState(); } catch {}
    // [toque 2026-10-21] 1 foto por sessão (só flags) → mede no servidor quantos
    // Android estão sem tela cheia / bateria restrita / notificação negada
    // (/var/mail/_native_diag, prefixo call_ready).
    try {
      const b = (v) => (v === true ? 1 : v === false ? 0 : '-');
      require('./nativeTelemetry').nativeBeacon('call_ready', 'android',
        `sdk=${sdk} fsi=${b(h.canUseFullScreenIntent)} ign_batt=${b(h.ignoringBatteryOptimizations)} restricted=${b(h.backgroundRestricted)}`
        + ` bucket=${Number(h.standbyBucket) || '-'} degraded=${Number(h.degradedAt) > 0 ? 1 : 0} notif_denied=${b(ns?.denied)} ch_low=${b(ns?.channelLow)}`);
    } catch {}
    if (ns && (ns.denied || ns.channelLow)) {
      const st = await _canAsk('notif');
      if (st) {
        _askedThisSession = true;
        await _mark('notif', st);
        return _alert(
          _tr(t, 'androidReady.notifTitle', 'Ligações não estão tocando'),
          ns.denied
            ? _tr(t, 'androidReady.notifBody', 'As notificações do Chatyy estão desativadas, então quando alguém liga o seu celular não toca. Ative as notificações para receber ligações e mensagens, como no WhatsApp.')
            : _tr(t, 'androidReady.notifChannelBody', 'As notificações de ligação do Chatyy estão silenciadas, então o celular não toca quando alguém liga. Em "Chamadas recebidas", ative som e pop-up.'),
          ns.denied && ns.canAskAgain ? _tr(t, 'androidReady.allow', 'Permitir') : _tr(t, 'androidReady.openSettings', 'Abrir configurações'),
          _tr(t, 'androidReady.later', 'Agora não'),
          () => {
            if (ns.denied && ns.canAskAgain) {
              try {
                require('expo-notifications').requestPermissionsAsync()
                  .then((r) => { if (r?.granted !== true && r?.canAskAgain === false) _openNotifSettings(); })
                  .catch(() => _openNotifSettings());
                return;
              } catch {}
            }
            _openNotifSettings();
          },
        );
      }
    }

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
