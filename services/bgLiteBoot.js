// [2026-10-16 wave10-C boot] Boot "leve" em 2º plano.
//
// Medido (coldstart_marks): 82% dos boots iOS medidos começam em 2º plano —
// push, VoIP/PushKit, BG fetch — e montavam o RN INTEIRO (todos os providers,
// AuthContext, MailContext + WS, Stack com as rotas, engines pós-paint) com
// ninguém olhando; layout em ~4,2 s, CPU/bateria e risco de watchdog no
// orçamento de ~30 s do iOS. No Android o mesmo vale p/ tasks headless (FCM
// data → expo-notifications task, WorkManager do bgJournal, BG fetch).
//
// Agora (app/_layout.js): quando o processo nasce com AppState 'background'
// (services/bootTrace.isBgLiteBoot) a árvore React NÃO monta. Aqui liga só o
// que precisa funcionar sem tela:
//   • listeners de notificação (ações Responder / Marcar lida / Recusar
//     ligação / lembretes — services/pushNotifications.setupNotificationListeners)
//   • CallKit/VoIP (services/callkeep.setupCallKeep → token VoIP, eventos
//     nativos; a chamada em si é 100% nativa: CallViewController/CallActivity)
//   • agendamento das tarefas de 2º plano (backgroundSync, bgJournal) e o
//     backup automático (as TaskManager.defineTask seguem no top-level dos
//     módulos importados pelo _layout — headless continua funcionando).
// As tasks headless de push (services/pushDeliveryTask) continuam importadas no
// topo do _layout, como antes.
//
// A UI monta no 1º 'active' (evento do AppState + sondagem curta de segurança).
// Até lá, navegações imperativas (toque na notificação, onOpenChat da ligação)
// ficam numa fila e são reaplicadas depois que a raiz montou E a 1ª tela pintou
// (index.js faz router.replace('/chat') ao montar — empurrar antes disso faria
// o replace engolir a conversa). Trocar de conta pelo toque (push p/ conta
// secundária) espera o handler real do AuthContext (AppInit).
//
// Kill switch (OTA): globalThis.__chatyy_bg_lite_boot = false (lido no load de
// services/bootTrace.js) → comportamento antigo (monta tudo em 2º plano).
import { Platform, AppState, Linking, DeviceEventEmitter } from 'react-native';
import {
  isBgLiteBoot, isBootHeld, releaseBootHold, mark, hasFirstPaint,
} from './bootTrace';

let _started = false;
let _notifInstalled = false;
let _uiMounted = false;
const _activeListeners = new Set();

export function bgLiteActive() { return isBgLiteBoot(); }
// AppInit pergunta antes de instalar os listeners de notificação de novo.
export function liteNotifListenersInstalled() { return _notifInstalled; }
// RootLayout: a UI pode montar? (false só enquanto bg-lite segura)
export function uiAllowed() { return !isBootHeld(); }

// Assina o 1º 'active'. Chama já se a UI já foi liberada. Retorna unsubscribe.
export function onUiAllowed(fn) {
  if (typeof fn !== 'function') return () => {};
  if (!isBootHeld()) { try { fn(); } catch {} return () => {}; }
  _activeListeners.add(fn);
  return () => { _activeListeners.delete(fn); };
}

function _release(reason) {
  if (!isBootHeld()) return;
  _unpatchNav();
  releaseBootHold(reason);
  const fns = Array.from(_activeListeners);
  _activeListeners.clear();
  for (const fn of fns) { try { fn(); } catch {} }
}

// ─── Fila de navegação enquanto não há navegador ───────────────────────────
// expo-router lança "Attempted to navigate before mounting the Root Layout" se
// router.push/replace/navigate rodam sem o Stack montado. Só enquanto bg-lite:
// os métodos do objeto `router` (o mesmo que openConversation/pushNotifications
// importam) enfileiram; na liberação, reaplica e devolve os originais.
const NAV_METHODS = ['push', 'replace', 'navigate'];
const NAV_MAX_AGE_MS = 30000;
let _navPatched = null; // { router, orig: {m: fn} }
const _navQueue = [];

function _navReady() {
  try {
    const { store } = require('expo-router/build/global-state/router-store');
    return !!(store && store.navigationRef && typeof store.navigationRef.isReady === 'function' && store.navigationRef.isReady());
  } catch { return false; }
}

function _installNavHold() {
  if (_navPatched) return;
  try {
    const router = require('expo-router').router;
    if (!router) return;
    const orig = {};
    for (const m of NAV_METHODS) {
      if (typeof router[m] !== 'function') continue;
      orig[m] = router[m];
      router[m] = function (...args) {
        _navQueue.push({ m, args, at: Date.now() });
        // Só o último destino importa (toques repetidos / onOpenChat + toque).
        while (_navQueue.length > 3) _navQueue.shift();
        try { mark('bg_lite_nav_queued'); } catch {}
      };
    }
    _navPatched = { router, orig };
  } catch {}
}

// Devolve os métodos originais. Roda na LIBERAÇÃO (antes de a árvore montar):
// o useRouter() do expo-router devolve este MESMO objeto, então o replace do
// index.js / qualquer navegação da UI nunca pode cair na fila.
let _navOrig = null;
function _unpatchNav() {
  const p = _navPatched;
  if (!p) return;
  _navPatched = null;
  _navOrig = p;
  for (const m of Object.keys(p.orig)) { try { p.router[m] = p.orig[m]; } catch {} }
}

// Reaplica SÓ o último destino enfileirado (já com os métodos originais).
function _replayNav() {
  const p = _navOrig;
  const items = _navQueue.splice(0, _navQueue.length).filter((it) => Date.now() - it.at < NAV_MAX_AGE_MS);
  if (!p || !items.length) return;
  const last = items[items.length - 1];
  try { mark('bg_lite_nav_flush'); } catch {}
  try { p.router[last.m](...last.args); } catch {}
}

// Depois da raiz montar: espera o navegador ficar pronto e a 1ª tela pintar
// (ou 2,5 s), +250 ms — o mesmo respiro do replay de cold start (700 ms após o
// setup dos listeners) — e então reaplica a navegação enfileirada.
// ─── Deep link que chega com a UI segurada ─────────────────────────────────
// Link universal / esquema do app com o processo vivo em bg-lite: o iOS entrega
// o openURL/continueUserActivity ANTES do didBecomeActive → o evento 'url' do
// Linking sai sem ninguém ouvindo (nem o NavigationContainer do expo-router nem
// o useDeepLinking do AppInit) e o getInitialURL do processo é null. Guarda o
// último e re-emite no mesmo emissor (RCTDeviceEventEmitter, que o Linking usa
// nas 2 plataformas) quando a 1ª tela pintou.
let _pendingUrl = null;
let _urlSub = null;
function _installUrlBuffer() {
  if (_urlSub) return;
  try {
    _urlSub = Linking.addEventListener('url', (ev) => {
      try {
        if (!isBootHeld() || !ev || !ev.url) return;
        _pendingUrl = { url: String(ev.url), at: Date.now() };
        mark('bg_lite_url_queued');
      } catch {}
    });
  } catch {}
}
function _replayUrl() {
  const u = _pendingUrl;
  _pendingUrl = null;
  try { _urlSub && _urlSub.remove && _urlSub.remove(); } catch {}
  _urlSub = null;
  if (!u || Date.now() - u.at > NAV_MAX_AGE_MS) return;
  try { mark('bg_lite_url_flush'); } catch {}
  try { DeviceEventEmitter.emit('url', { url: u.url }); } catch {}
}

function _flushNavWhenReady() {
  _unpatchNav();
  if (!_navQueue.length && !_pendingUrl) {
    try { _urlSub && _urlSub.remove && _urlSub.remove(); } catch {}
    _urlSub = null;
    return;
  }
  const t0 = Date.now();
  const tick = () => {
    const ready = _navReady();
    const painted = hasFirstPaint();
    if (ready && (painted || Date.now() - t0 > 2500)) {
      // Link tem prioridade sobre a fila de navegação (é o gesto mais recente
      // que trouxe o app pra frente); os dois juntos = só o link.
      setTimeout(() => { if (_pendingUrl) { _navQueue.length = 0; _replayUrl(); } else { _replayUrl(); _replayNav(); } }, 250);
      return;
    }
    if (Date.now() - t0 > 8000) { if (_pendingUrl) { _navQueue.length = 0; _replayUrl(); } else { _replayNav(); } return; }
    setTimeout(tick, 100);
  };
  setTimeout(tick, 0);
}

// RootLayout chama quando a árvore completa montou (UI liberada).
export function noteUiMounted() {
  if (_uiMounted) return;
  _uiMounted = true;
  _flushNavWhenReady();
}

// ─── Troca de conta pelo toque, sem AuthContext montado ────────────────────
let _realSwitch = null;
const _switchWaiters = [];
// AppInit repassa o switchAccount real do AuthContext.
export function provideSwitchAccountHandler(fn) {
  _realSwitch = typeof fn === 'function' ? fn : null;
  if (!_realSwitch) return;
  const ws = _switchWaiters.splice(0, _switchWaiters.length);
  for (const w of ws) { try { w(_realSwitch); } catch {} }
}
function _deferredSwitchHandler(email) {
  if (_realSwitch) return _realSwitch(email);
  return new Promise((resolve) => {
    const tmo = setTimeout(() => resolve({ success: false, error: 'bg_lite_timeout' }), 20000);
    _switchWaiters.push((fn) => {
      clearTimeout(tmo);
      Promise.resolve().then(() => fn(email)).then(resolve, () => resolve({ success: false }));
    });
  });
}

// ─── Serviços mínimos de 2º plano ──────────────────────────────────────────
function _startLiteServices() {
  // 1) Listeners de notificação (ações em 2º plano + rotação de token).
  _notifInstalled = true;
  (async () => {
    try {
      const pn = await import('./pushNotifications');
      try { pn.setSwitchAccountHandler?.(_deferredSwitchHandler); } catch {}
      await pn.setupNotificationListeners();
      mark('bg_lite_notif');
    } catch {}
  })();

  // Ação SEM abrir o app (Recusar ligação) manda call_end pelo WS — sem o
  // MailContext montado ninguém conecta o socket. Garante a conexão só quando
  // chega uma resposta de ação (não no toque normal).
  (async () => {
    try {
      const Notifications = await import('expo-notifications');
      Notifications.addNotificationResponseReceivedListener?.((resp) => {
        try {
          if (!isBootHeld()) return;
          const a = String(resp?.actionIdentifier || '');
          if (!a || a === Notifications.DEFAULT_ACTION_IDENTIFIER || a.indexOf('DEFAULT') >= 0) return;
          const ws = require('./websocket').default;
          if (ws && !ws.isConnected) {
            if (typeof ws.ensureConnected === 'function') ws.ensureConnected('bg_lite_action', { urgent: true });
            else if (typeof ws.connect === 'function') {
              const tok = require('./api').getToken?.();
              if (tok) ws.connect(tok);
            }
          }
        } catch {}
      });
    } catch {}
  })();

  // 2) CallKit / VoIP (token VoIP, eventos nativos). Single-flight com AppInit.
  setupCallKeepOnce();

  // 3) Tarefas de 2º plano: só o agendamento (idempotente). As defineTask já
  //    rodaram no import do _layout. Antes iam pela fila pós-paint (que agora
  //    fica segurada até o 'active').
  setTimeout(() => {
    try { require('./backgroundSync').registerBackgroundSync?.().catch?.(() => {}); } catch {}
    try {
      const bj = require('./bgJournal');
      bj.scheduleBackgroundSync?.(true);
      bj.exportSyncConfig?.();
    } catch {}
  }, 1500);
  // 4) Backup automático (o motor nativo assume quando existe).
  setTimeout(() => {
    try { require('./autoBackup').initAutoBackup?.().catch?.(() => {}); } catch {}
  }, 4000);
}

let _ckPromise = null;
export function setupCallKeepOnce() {
  if (Platform.OS === 'web') return Promise.resolve();
  if (_ckPromise) return _ckPromise;
  _ckPromise = (async () => {
    try {
      const { setupCallKeep } = await import('./callkeep');
      await setupCallKeep();
    } catch (e) {
      try { console.warn('[CallKeep] Setup failed:', e?.message); } catch {}
    }
  })();
  return _ckPromise;
}

// Chamado UMA vez no load do app/_layout.js.
export function startBgLiteBootIfNeeded() {
  if (_started || Platform.OS === 'web') return false;
  _started = true;
  if (!isBgLiteBoot()) return false;
  mark('bg_lite');
  _installNavHold();
  _installUrlBuffer();
  _startLiteServices();

  // 1º 'active' → libera a UI.
  let sub = null;
  const check = (st) => {
    if (st === 'active') {
      try { sub && sub.remove && sub.remove(); } catch {}
      _release('appstate');
    }
  };
  try { sub = AppState.addEventListener('change', check); } catch {}
  // Rede de segurança: evento perdido entre a leitura inicial e o subscribe /
  // estado inicial desatualizado. Sonda curta nos primeiros 15 s, depois só o
  // evento (não mantém o JS acordado num processo headless).
  let n = 0;
  const poll = () => {
    if (!isBootHeld()) return;
    try { if (AppState.currentState === 'active') { check('active'); return; } } catch {}
    if (++n < 30) setTimeout(poll, 500);
  };
  setTimeout(poll, 500);
  // Android: 'focus' chega quando a Activity ganha foco (cobre um 'change'
  // atrasado depois de um headless que virou abertura do app).
  if (Platform.OS === 'android') {
    try { AppState.addEventListener('focus', () => check('active')); } catch {}
  }
  return true;
}
