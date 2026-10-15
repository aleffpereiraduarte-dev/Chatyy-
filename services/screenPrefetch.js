// screenPrefetch — aquece em 2º plano as telas mais abertas (offline-first).
//
// [2026-10-14 offline-first] Depois do 1º paint (boot/login), com rede boa e
// bateria ok, busca e SALVA no aparelho (hooks/useCachedAction → services/cache)
// os dados das telas mais usadas: perfil próprio, carteira, notificações,
// contatos (Configurações já são aquecidas por settingsCache.prefetchAll).
// Assim a 1ª abertura dessas telas já pinta com dado real, sem skeleton.
//
// Telas registram { key, fetch, ttl } em services/screenData.js (o mesmo par
// key/fetch que a tela usa no useCachedAction — uma fonte só).
import { Platform } from 'react-native';
import { prefetchCached } from '../hooks/useCachedAction';
import { hasCacheUser } from './cache';

const START_DELAY_MS = 9000;   // depois do chat (sync/WS/mídia) assentar
const GAP_MS = 350;            // uma tela por vez, sem rajada
let _timer = null;
let _runFor = '';

async function _conditionsOk() {
  try {
    if (Platform.OS === 'web') {
      if (typeof navigator !== 'undefined') {
        if (navigator.onLine === false) return false;
        const c = navigator.connection;
        if (c && (c.saveData || /(^|-)2g$/.test(String(c.effectiveType || '')))) return false;
        if (typeof navigator.getBattery === 'function') {
          const b = await navigator.getBattery().catch(() => null);
          if (b && !b.charging && b.level < 0.2) return false;
        }
      }
      return true;
    }
    const NetInfo = require('@react-native-community/netinfo').default;
    const s = await NetInfo.fetch();
    if (!s || s.isConnected === false || s.isInternetReachable === false) return false;
    if (s.details && s.details.isConnectionExpensive && s.type === 'cellular' && /2g/i.test(String(s.details.cellularGeneration || ''))) return false;
    try {
      const Battery = require('expo-battery');
      if (Battery && Battery.getBatteryLevelAsync) {
        const [lvl, st] = await Promise.all([Battery.getBatteryLevelAsync(), Battery.getBatteryStateAsync?.()]);
        const charging = st === 2 || st === 3; // CHARGING | FULL
        if (!charging && lvl >= 0 && lvl < 0.2) return false;
        if (Battery.isLowPowerModeEnabledAsync && (await Battery.isLowPowerModeEnabledAsync())) return false;
      }
    } catch {}
    return true;
  } catch { return true; }
}

/** Agenda o aquecimento para a conta (idempotente por conta). */
export function scheduleScreenPrefetch(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || _runFor === e) return;
  _runFor = e;
  if (_timer) { try { clearTimeout(_timer); } catch {} }
  _timer = setTimeout(async () => {
    _timer = null;
    try {
      if (!hasCacheUser() || !(await _conditionsOk())) { _runFor = ''; return; }
      let list = [];
      try { list = require('./screenData').PREFETCH_SCREENS || []; } catch { list = []; }
      for (const s of list) {
        if (_runFor !== e) return; // trocou de conta / saiu
        try {
          let acct = '';
          try { acct = String(require('./api').getActiveAccountEmail?.() || '').trim().toLowerCase(); } catch {}
          if (acct !== e) { _runFor = ''; return; }
          const key = typeof s.key === 'function' ? s.key(e) : s.key;
          await prefetchCached(key, () => s.fetch(e), { ttl: s.ttl || 5 * 60 * 1000 });
        } catch {}
        await new Promise((r) => setTimeout(r, GAP_MS));
      }
    } catch {}
  }, START_DELAY_MS);
}

/** Cancela (logout / troca de conta). */
export function cancelScreenPrefetch() {
  _runFor = '';
  if (_timer) { try { clearTimeout(_timer); } catch {} _timer = null; }
}
