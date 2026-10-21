// [2026-10-21 tg3] Bateria: batida da localização ao vivo da CONVERSA
// (setInterval de 10 s em app/chat-conversation.js).
//   - só com o app em 1º plano (em 2º plano o timer JS acordava o GPS a cada
//     10 s; a tarefa de localização do SO/LiveLocationHeartbeat cobre o resto);
//   - bateria baixa (<20 %, sem carregar) → 1 batida a cada 30 s;
//     modo economia do SO → idem.
// Síncrono (chamado dentro do tick): o nível da bateria fica em cache e é
// relido em segundo plano no máximo a cada 60 s. Nunca lança.
// Kill: globalThis.__chatyy_liveloc_tick_gate = false (batida de 10 s de antes).
import { AppState, Platform } from 'react-native';

const LOW_BATTERY = 0.2;
const LOW_BATTERY_GAP_MS = 30000;
const BATTERY_TTL_MS = 60000;

let _lvl = null;
let _charging = false;
let _lowPower = false;
let _readAt = 0;
let _reading = false;
let _lastRun = 0;

function _refreshBattery() {
  if (_reading || Platform.OS === 'web') return;
  if (Date.now() - _readAt < BATTERY_TTL_MS) return;
  _reading = true;
  (async () => {
    try {
      const B = require('expo-battery');
      if (B?.getBatteryLevelAsync) _lvl = await B.getBatteryLevelAsync();
      if (B?.getBatteryStateAsync) {
        const st = await B.getBatteryStateAsync();
        _charging = st === B.BatteryState?.CHARGING || st === B.BatteryState?.FULL;
      }
      if (B?.isLowPowerModeEnabledAsync) _lowPower = !!(await B.isLowPowerModeEnabledAsync());
    } catch {}
    _readAt = Date.now();
    _reading = false;
  })();
}

export function isLowBatteryNow() {
  _refreshBattery();
  if (_charging) return false;
  if (_lowPower) return true;
  return typeof _lvl === 'number' && _lvl >= 0 && _lvl < LOW_BATTERY;
}

/** true = esta batida deve rodar (GPS + envio). */
export function shouldRunLiveLocTick() {
  try {
    if (globalThis.__chatyy_liveloc_tick_gate === false) return true;
  } catch {}
  try {
    if (Platform.OS !== 'web' && AppState.currentState && AppState.currentState !== 'active') return false;
  } catch {}
  const now = Date.now();
  if (isLowBatteryNow() && now - _lastRun < LOW_BATTERY_GAP_MS - 1000) return false;
  _lastRun = now;
  return true;
}

export default shouldRunLiveLocTick;
