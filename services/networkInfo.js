/**
 * Network Info Service
 * Detects connectivity state (online/offline/wifi/cellular)
 * Uses @react-native-community/netinfo on native, navigator.onLine on web
 */
import { Platform } from 'react-native';

let NetInfo = null;
if (Platform.OS !== 'web') {
  try {
    NetInfo = require('@react-native-community/netinfo').default;
  } catch {}
}

let _listeners = new Set();
let _currentState = {
  isConnected: true,
  type: 'unknown',
  isWifi: false,
  // `isExpensive` mirrors NetInfo's `details.isConnectionExpensive` — set by
  // the OS when the carrier signals metered/roaming. Used as our roaming
  // heuristic since RN's NetInfo doesn't expose a dedicated `isRoaming` flag.
  isExpensive: false,
};

function _notify() {
  for (const cb of _listeners) { try { cb(_currentState); } catch {} }
}

function _normalize(s) {
  if (!s) return _currentState;
  const wifi = s.type === 'wifi' || s.type === 'ethernet';
  // `details.isConnectionExpensive` is iOS+Android-supported on cellular.
  // Wi-Fi can also flag expensive (personal hotspot) — we honor it as roaming.
  const isExpensive = !!(s.details && s.details.isConnectionExpensive);
  return {
    isConnected: !!s.isConnected,
    type: s.type || 'unknown', // 'wifi' | 'cellular' | 'ethernet' | 'none' | 'unknown'
    isWifi: wifi,
    isExpensive,
    // [2026-10-09 net-resilience] antes era descartado → o perfil de imagem
    // 2G/3G do mediaSendQueue (e qualquer timeout adaptativo) nunca ativava.
    cellularGeneration: (s.details && s.details.cellularGeneration) || null,
  };
}

// Initialize on native — guard against duplicate subscriptions in Fast Refresh.
if (NetInfo && !globalThis.__netinfo_unsub) {
  // Seed state with current connectivity so the first render isn't optimistic.
  try { NetInfo.fetch().then(s => {
    if (s) { _currentState = _normalize(s); _notify(); }
  }).catch(() => {}); } catch {}
  globalThis.__netinfo_unsub = NetInfo.addEventListener(state => {
    _currentState = _normalize(state);
    _notify();
  });
}

// Initialize on web — guard against duplicate listeners in Fast Refresh.
if (Platform.OS === 'web' && typeof window !== 'undefined') {
  _currentState.isConnected = !!navigator.onLine;
  if (!window.__netinfo_online) {
    window.__netinfo_online = () => {
      _currentState = { isConnected: true, type: 'unknown', isWifi: false };
      _notify();
    };
    window.addEventListener('online', window.__netinfo_online);
  }
  if (!window.__netinfo_offline) {
    window.__netinfo_offline = () => {
      _currentState = { isConnected: false, type: 'none', isWifi: false };
      _notify();
    };
    window.addEventListener('offline', window.__netinfo_offline);
  }
}

export function getNetworkState() {
  return { ..._currentState };
}

export function onNetworkChange(callback) {
  _listeners.add(callback);
  // Fire immediately so caller doesn't have to wait for the first event.
  try { callback(_currentState); } catch {}
  return () => _listeners.delete(callback);
}

export function isConnected() {
  return !!_currentState.isConnected;
}

export function isWifi() {
  return !!_currentState.isWifi;
}

/**
 * Classify the current connection into one of the WhatsApp auto-download
 * matrix columns: 'wifi' | 'mobile' | 'roaming' | 'none'.
 *
 *   - 'none'    → no connectivity at all (NetInfo says disconnected).
 *   - 'wifi'    → Wi-Fi or wired Ethernet AND not flagged expensive.
 *   - 'roaming' → ANY connection (wifi or cellular) the OS flagged as
 *                 expensive (personal hotspot, carrier roaming). We prefer
 *                 this over 'mobile' because the user opted into the
 *                 stricter column.
 *   - 'mobile'  → cellular AND not expensive.
 *
 * Returns 'wifi' for web (no cellular concept) and 'unknown' before NetInfo
 * has probed — callers map 'unknown' to whichever column is most conservative
 * for the bucket in question.
 */
export function getNetworkType() {
  if (!_currentState.isConnected) return 'none';
  if (Platform.OS === 'web') return 'wifi';
  // Expensive flag wins — even Wi-Fi can be a personal hotspot the user is
  // paying for, and we want to behave like roaming there.
  if (_currentState.isExpensive) return 'roaming';
  if (_currentState.isWifi) return 'wifi';
  if (_currentState.type === 'cellular') return 'mobile';
  return 'unknown';
}

// ─── [2026-10-09 net-resilience] qualidade do enlace ───────────────────────
// RTT suavizado (EWMA, igual TCP srtt) alimentado pelos pongs do WebSocket.
// Usado p/ deadlines e timeouts ADAPTATIVOS: em
// 2G/satélite/Ásia (RTT 600-1500ms, perda) os prazos fixos de 2-10s davam
// falso "morto" → reconexão em loop.
let _srtt = 0;
let _rttSamples = [];
export function reportRtt(ms) {
  const v = Number(ms);
  if (!(v > 0) || v > 3000) return; // [2026-10-09 tf653] >3s = JS suspenso/ocupado, não é RTT
  // [2026-10-09 tf653] RTT = MÍNIMO das últimas 4 amostras (não EWMA): no
  // celular o "RTT" medido no JS inclui a thread JS ocupada (boot, lista,
  // backup) — 1 pico de 1-3s jogava o enlace p/ 'medium'/'slow' por minutos e
  // a detecção de socket morto ia de 6s p/ 9-12s. Enlace lento de verdade
  // deixa TODAS as amostras altas → o mínimo continua alto.
  _rttSamples.push(Math.round(v));
  if (_rttSamples.length > 4) _rttSamples.shift();
  _srtt = Math.min(..._rttSamples);
}
export function getSrtt() { return _srtt; }
// [2026-10-09 tf653] foreground/troca de rede: descarta o histórico (volta ao padrão 'fast' até novos pongs).
export function resetRtt() { _srtt = 0; _rttSamples = []; }

function _webEffectiveType() {
  try {
    if (Platform.OS !== 'web' || typeof navigator === 'undefined') return null;
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return (c && c.effectiveType) ? String(c.effectiveType) : null;
  } catch { return null; }
}

// Banda estimada pelo navegador (Network Information API, Mbps) — 3G "rápido"
// em RTT (300ms) mas com 750 kbps ainda é enlace médio p/ upload/concorrência.
function _webDownlinkMbps() {
  try {
    if (Platform.OS !== 'web' || typeof navigator === 'undefined') return null;
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const v = c && Number(c.downlink);
    return (v > 0) ? v : null;
  } catch { return null; }
}

// 'slow' | 'medium' | 'fast' — pior sinal entre geração celular, effectiveType
// do navegador e RTT medido.
export function getLinkClass() {
  const gen = _currentState.cellularGeneration;
  const et = _webEffectiveType();
  const dl = _webDownlinkMbps();
  if (gen === '2g' || et === 'slow-2g' || et === '2g' || _srtt > 1000 || (dl != null && dl < 0.3)) return 'slow';
  if (gen === '3g' || et === '3g' || _srtt > 450 || (dl != null && dl < 1.2)) return 'medium';
  return 'fast';
}
export function isSlowLink() { return getLinkClass() !== 'fast'; }
// Multiplicador de timeouts/deadlines (1 = rede boa).
export function timeoutScale() {
  const c = getLinkClass();
  // Teto 2×: na bancada, timeouts muito longos (×2.5 → GET de 62s) seguravam
  // request preso em conexão morta por tempo demais antes do retry.
  return c === 'slow' ? 2 : (c === 'medium' ? 1.5 : 1);
}
