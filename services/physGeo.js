// ─── [geo-fisica 2026-10-22] Posição FÍSICA aproximada p/ o balanceamento (client-lb) ───
// O país/posição do Cloudflare vêm do IP — em roaming com "home routing" (chip chileno nos
// EUA, chip dos EUA no Chile…) ou VPN o IP mente. Se o usuário JÁ deu permissão de localização
// ao app (mapa de amigos, enviar localização…), a última posição conhecida do SO diz onde o
// aparelho está de fato → a região mais perto dela entra PRIMEIRO nas candidatas medidas.
//
//  • NUNCA pede permissão (só getForegroundPermissionsAsync; sem "granted" → nada).
//  • NUNCA liga o GPS: só getLastKnownPositionAsync (cache do SO, custo ~0).
//  • Guardada ARREDONDADA a 0,5° (~55 km) só neste aparelho (MMKV); ao servidor vai apenas o
//    id da região mais perto (beacon "pg"), nunca coordenadas.
//  • Validade 12 h (viagem de avião troca de continente; posição velha não vale).
//  • Kill: globalThis.__chatyy_lb_phys_geo = false (OTA/local).
import { Platform } from 'react-native';

const KEY = 'client_lb_phys_geo_v1';
const TTL_MS = 12 * 60 * 60 * 1000;          // posição guardada vale 12 h
const OS_MAX_AGE_MS = 6 * 60 * 60 * 1000;     // última posição do SO aceita até 6 h
const REFRESH_GAP_MS = 30 * 60 * 1000;        // consulta o SO no máx. 1×/30 min
const ROUND = 0.5;

let _mem = null;
let _loaded = false;
let _lastTry = 0;
let _busy = null;

function _mm() { try { return require('./mmkv'); } catch { return null; } }
function _off() {
  try { if (globalThis.__chatyy_lb_phys_geo === false) return true; } catch {}
  try { if (Platform.OS === 'web') return true; } catch {}
  return false;
}
const _r = (v) => Math.round(v / ROUND) * ROUND;

function _valid(p) {
  return !!(p && typeof p.lat === 'number' && typeof p.lon === 'number' && isFinite(p.lat) && isFinite(p.lon)
    && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 && !(p.lat === 0 && p.lon === 0));
}

function _load() {
  if (_loaded) return _mem;
  _loaded = true;
  try {
    const raw = _mm()?.getString(KEY);
    const p = raw ? JSON.parse(raw) : null;
    if (_valid(p) && typeof p.at === 'number') _mem = { lat: p.lat, lon: p.lon, at: p.at };
  } catch {}
  return _mem;
}

/** Posição física aproximada { lat, lon, at } se fresca (≤12 h), senão null. Síncrona. */
export function getPhysGeo() {
  if (_off()) return null;
  const p = _load();
  if (!p || Date.now() - p.at > TTL_MS) return null;
  return { lat: p.lat, lon: p.lon, at: p.at };
}

/** Atualiza a partir da última posição do SO, SÓ com permissão já concedida. Nunca lança. */
export function refreshPhysGeo({ force = false } = {}) {
  if (_off()) return Promise.resolve(null);
  if (_busy) return _busy;
  if (!force && Date.now() - _lastTry < REFRESH_GAP_MS) return Promise.resolve(getPhysGeo());
  _lastTry = Date.now();
  _busy = (async () => {
    try {
      let Location = null;
      try { Location = require('expo-location'); } catch { return getPhysGeo(); }
      if (!Location || typeof Location.getForegroundPermissionsAsync !== 'function') return getPhysGeo();
      const perm = await Location.getForegroundPermissionsAsync().catch(() => null);
      if (!perm || perm.status !== 'granted') return getPhysGeo(); // sem permissão: não pede, não usa
      const pos = await Location.getLastKnownPositionAsync({ maxAge: OS_MAX_AGE_MS }).catch(() => null);
      const c = pos && pos.coords;
      if (!c || typeof c.latitude !== 'number' || typeof c.longitude !== 'number') return getPhysGeo();
      const ts = typeof pos.timestamp === 'number' && pos.timestamp > 0 ? Math.min(pos.timestamp, Date.now()) : Date.now();
      if (Date.now() - ts > OS_MAX_AGE_MS) return getPhysGeo();
      const p = { lat: _r(c.latitude), lon: _r(c.longitude), at: ts };
      if (!_valid(p)) return getPhysGeo();
      _mem = p; _loaded = true;
      try { _mm()?.setString(KEY, JSON.stringify(p)); } catch {}
      return { ...p };
    } catch { return getPhysGeo(); } finally { _busy = null; }
  })();
  return _busy;
}

export default { getPhysGeo, refreshPhysGeo };
