// friendMapShare — envio da MINHA localização para o Mapa de amigos
// ===================================================================
// [2026-10-12 mapa-amigos] Bug do founder: amigo aparecia em "Recebendo de"
// mas nunca no mapa. Causa: o envio em 2º plano (backgroundLocationTask +
// LiveLocationHeartbeat) só ligava com `live_location_active=1`, que só é
// setado pela localização ao vivo DENTRO de uma conversa. Aceitar um pedido
// pelo mapa nunca ligava o envio → o celular do amigo só publicava com o
// mapa aberto e a posição dele ficava dias velha.
//
// Agora existem DUAS razões independentes para publicar:
//   • 'live_location_active'     — localização ao vivo da conversa (chat-conversation.js)
//   • 'friend_map_share_active'  — tenho ≥1 grant ATIVO como sharer
//                                  (sharing_with de chat_friend_location_grants)
// A tarefa em 2º plano / heartbeat publicam se QUALQUER uma estiver ligada (e
// o modo fantasma estiver desligado) e só param quando nenhuma estiver.
//
// A razão do mapa é reconciliada: ao aceitar um pedido, ao abrir o app
// (boot / AppState active — throttle 10 min, cacheado) e ao revogar.
import { Platform, Alert, Linking } from 'react-native';

export const FRIEND_SHARE_FLAG = 'friend_map_share_active';
export const LIVE_SHARE_FLAG = 'live_location_active';
export const GHOST_FLAG = 'snap_map_ghost_mode';
const LAST_PUBLISH_KEY = 'friend_map_last_publish_ts';
const LAST_SYNC_KEY = 'friend_map_grants_sync_ts';
const GHOST_SYNCED_KEY = 'snap_map_ghost_server_synced';

export const FRIEND_PUBLISH_GAP_MS = 2 * 60 * 1000; // publica no máx. a cada ~2 min
const SYNC_TTL_MS = 10 * 60 * 1000; // relê os grants no máx. a cada 10 min

function AS() {
  try { return require('@react-native-async-storage/async-storage').default; } catch { return null; }
}
async function getItem(k) { try { return (await AS()?.getItem(k)) ?? null; } catch { return null; } }
async function setItem(k, v) { try { await AS()?.setItem(k, v); } catch {} }
async function removeItem(k) { try { await AS()?.removeItem(k); } catch {} }
const truthy = (v) => v === '1' || v === 'true';

/** Grants de saída ainda válidos (ilimitado, sem validade ou não expirado). */
export function activeSharingGrants(grantsData) {
  const list = Array.isArray(grantsData?.sharing_with) ? grantsData.sharing_with : [];
  const now = Date.now() / 1000;
  return list.filter((g) => g && g.email && (g.is_unlimited || g.expires_at == null || Number(g.expires_at) > now));
}

export async function isGhostMode() { return truthy(await getItem(GHOST_FLAG)); }
export async function isFriendShareActive() { return truthy(await getItem(FRIEND_SHARE_FLAG)); }
export async function isLiveShareActive() { return truthy(await getItem(LIVE_SHARE_FLAG)); }

/** { live, friend, ghost, any } — `any` = deve publicar. */
export async function getShareReasons() {
  const [live, friend, ghost] = await Promise.all([isLiveShareActive(), isFriendShareActive(), isGhostMode()]);
  return { live, friend, ghost, any: (live || friend) && !ghost };
}

function bgMod() {
  try { return require('./backgroundLocationTask'); } catch { return null; }
}

/**
 * Estado da permissão "Sempre": 'granted' | 'denied' | 'undetermined' |
 * 'unsupported' (web / Android — o manifest Android não tem
 * ACCESS_BACKGROUND_LOCATION, ver backgroundLocationTask.js).
 */
export async function getBackgroundPermissionStatus() {
  if (Platform.OS !== 'ios') return 'unsupported';
  try {
    const Location = require('expo-location');
    const fg = await Location.getForegroundPermissionsAsync().catch(() => null);
    if (fg?.status !== 'granted') return fg?.status === 'denied' ? 'denied' : 'undetermined';
    const bg = await Location.getBackgroundPermissionsAsync().catch(() => null);
    if (bg?.status === 'granted') return 'granted';
    // iOS: depois que o usuário respondeu, canAskAgain=false → só pelos Ajustes.
    if (bg?.canAskAgain === false || bg?.status === 'denied') return 'denied';
    return 'undetermined';
  } catch { return 'unsupported'; }
}

/** Liga a OS-managed task se houver razão; desliga só se nenhuma razão restar. */
export async function reconcileBackgroundUpdates({ prompt = false } = {}) {
  const m = bgMod();
  if (!m) return false;
  const r = await getShareReasons();
  if (r.any) {
    // A localização ao vivo da conversa mantém o comportamento antigo (pede
    // "Sempre" se ainda não tiver). Só a razão do mapa nunca pede sozinha.
    return !!(await m.startBackgroundLocationUpdates({ prompt: prompt || r.live }).catch(() => false));
  }
  await m.stopBackgroundLocationUpdates().catch(() => {});
  return false;
}

async function setFriendFlag(on) {
  if (on) await setItem(FRIEND_SHARE_FLAG, '1');
  else await removeItem(FRIEND_SHARE_FLAG);
}

let _syncInflight = null;
/**
 * Lê chat_friend_location_grants (ou usa `grantsData` já carregado) e liga/
 * desliga a razão do mapa. Barato: throttle de 10 min salvo `force`.
 * Falha de rede mantém o estado anterior.
 */
export async function syncFriendMapShare({ force = false, grantsData = null } = {}) {
  if (Platform.OS === 'web') return null;
  if (_syncInflight) return _syncInflight;
  _syncInflight = (async () => {
    try {
      let data = grantsData;
      if (!data) {
        if (!force) {
          const last = Number(await getItem(LAST_SYNC_KEY)) || 0;
          if (Date.now() - last < SYNC_TTL_MS) return isFriendShareActive();
        }
        let api = null;
        try { api = require('./api'); } catch {}
        const g = await api?.friendLocationGrants?.().catch(() => null);
        if (!g?.success || !g.data) return isFriendShareActive();
        data = g.data;
      }
      await setItem(LAST_SYNC_KEY, String(Date.now()));
      const on = activeSharingGrants(data).length > 0;
      await setFriendFlag(on);
      await reconcileBackgroundUpdates({ prompt: false });
      return on;
    } catch { return isFriendShareActive(); }
    finally { setTimeout(() => { _syncInflight = null; }, 0); }
  })();
  return _syncInflight;
}

let _pubInflight = false;
/**
 * Publica a posição atual (1º plano) se houver razão ativa. Throttle ~2 min
 * (persistido) salvo `force`. Nunca pede permissão; nunca lança.
 */
export async function publishMyLocationNow({ force = false } = {}) {
  if (Platform.OS === 'web' || _pubInflight) return false;
  _pubInflight = true;
  try {
    const r = await getShareReasons();
    if (!r.any) return false;
    if (!force) {
      const last = Number(await getItem(LAST_PUBLISH_KEY)) || 0;
      if (Date.now() - last < FRIEND_PUBLISH_GAP_MS) return false;
    }
    const Location = require('expo-location');
    const perm = await Location.getForegroundPermissionsAsync().catch(() => null);
    if (perm?.status !== 'granted') return false;
    let loc = await Location.getLastKnownPositionAsync({ maxAge: 60 * 1000, requiredAccuracy: 200 }).catch(() => null);
    if (!loc?.coords) {
      loc = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy?.Balanced ?? 3 }),
        new Promise((resolve) => setTimeout(() => resolve(null), 12000)),
      ]).catch(() => null);
    }
    if (!loc?.coords) return false;
    await setItem(LAST_PUBLISH_KEY, String(Date.now()));
    const api = require('./api');
    await api.apiCall('chat_friend_location_share_update', {
      latitude: loc.coords.latitude,
      longitude: loc.coords.longitude,
      accuracy: loc.coords.accuracy || null,
      heading: loc.coords.heading ?? null,
      speed: loc.coords.speed ?? null,
    }, 'POST').catch(() => {});
    return true;
  } catch { return false; }
  finally { _pubInflight = false; }
}

/** Marca o último envio (o heartbeat usa para respeitar o mesmo throttle). */
export async function markPublished() { await setItem(LAST_PUBLISH_KEY, String(Date.now())); }
export async function lastPublishedAt() { return Number(await getItem(LAST_PUBLISH_KEY)) || 0; }

function tr(t, key, fb) {
  try { const v = t?.(key); if (v && v !== key) return v; } catch {}
  return fb;
}

/**
 * Chamar DEPOIS de aceitar um pedido de localização: liga a razão do mapa,
 * publica a posição já e (iOS) explica + pede "Sempre". Se o usuário ficar só
 * com "Durante o uso", seguimos publicando em 1º plano e o mapa mostra o aviso.
 */
export async function onFriendShareAccepted(t) {
  if (Platform.OS === 'web') return;
  await setFriendFlag(true);
  await setItem(LAST_SYNC_KEY, String(Date.now()));
  publishMyLocationNow({ force: true }).catch(() => {});
  const status = await getBackgroundPermissionStatus();
  if (status === 'unsupported' || status === 'granted') {
    await reconcileBackgroundUpdates({ prompt: false });
    return;
  }
  await new Promise((resolve) => {
    const title = tr(t, 'fmap.alwaysTitle', 'Compartilhar com o app fechado');
    const body = tr(t, 'fmap.alwaysBody', 'Para seus amigos verem onde você está mesmo com o Chatyy fechado, escolha "Permitir sempre". Você pode parar quando quiser no Mapa de amigos.');
    const later = { text: tr(t, 'fmap.notNow', 'Agora não'), style: 'cancel', onPress: () => resolve() };
    if (status === 'denied') {
      Alert.alert(title, body, [later, {
        text: tr(t, 'fmap.openSettings', 'Abrir Ajustes'),
        onPress: () => { try { Linking.openSettings(); } catch {} resolve(); },
      }], { cancelable: true, onDismiss: () => resolve() });
      return;
    }
    Alert.alert(title, body, [later, {
      text: tr(t, 'fmap.continue', 'Continuar'),
      onPress: async () => { await reconcileBackgroundUpdates({ prompt: true }).catch(() => {}); resolve(); },
    }], { cancelable: true, onDismiss: () => resolve() });
  });
  await reconcileBackgroundUpdates({ prompt: false });
}

/**
 * Modo fantasma: pausa meu envio para todos SEM apagar os grants. Local
 * (para heartbeat/tarefa/ping) + servidor (apaga a minha última posição para
 * ninguém ver um pin velho; ação nova chat_friend_location_ghost — servidor
 * antigo responde erro e seguimos só com o local).
 */
export async function setGhostMode(on) {
  await setItem(GHOST_FLAG, on ? '1' : '0');
  try {
    const api = require('./api');
    const r = await api.apiCall('chat_friend_location_ghost', { on: on ? 1 : 0 }, 'POST').catch(() => null);
    await setItem(GHOST_SYNCED_KEY, r?.success ? (on ? '1' : '0') : '');
  } catch {}
  if (on) {
    await bgMod()?.stopBackgroundLocationUpdates?.().catch?.(() => {});
  } else {
    await reconcileBackgroundUpdates({ prompt: false });
    publishMyLocationNow({ force: true }).catch(() => {});
  }
}

/** Garante que o servidor saiba do fantasma ligado antes deste app (1x). */
export async function ensureGhostSyncedToServer() {
  try {
    if (!(await isGhostMode())) return;
    if ((await getItem(GHOST_SYNCED_KEY)) === '1') return;
    const api = require('./api');
    const r = await api.apiCall('chat_friend_location_ghost', { on: 1 }, 'POST').catch(() => null);
    if (r?.success) await setItem(GHOST_SYNCED_KEY, '1');
  } catch {}
}

// ── Nome curto do lugar (bairro/cidade) — Photon/OSM reverse, cache + fila ──
const _placeCache = new Map(); // "lat3,lng3" → string ('' = sem resultado)
const _placeQueue = [];
let _placeBusy = false;
function _placeKey(lat, lng) { return `${Number(lat).toFixed(3)},${Number(lng).toFixed(3)}`; }
export function placeNameSync(lat, lng) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return '';
  return _placeCache.get(_placeKey(lat, lng)) || '';
}
async function _drainPlaces() {
  if (_placeBusy) return;
  _placeBusy = true;
  try {
    while (_placeQueue.length) {
      const job = _placeQueue.shift();
      const key = _placeKey(job.lat, job.lng);
      if (_placeCache.has(key)) { job.resolve(_placeCache.get(key)); continue; }
      let name = '';
      try {
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const to = setTimeout(() => { try { ctrl?.abort(); } catch {} }, 6000);
        const l2 = String(job.lang || '').slice(0, 2).toLowerCase();
        const langParam = ['en', 'de', 'fr'].includes(l2) ? `&lang=${l2}` : '';
        const res = await fetch(`https://photon.komoot.io/reverse?lat=${job.lat}&lon=${job.lng}&limit=1${langParam}`, {
          headers: { Accept: 'application/json' }, signal: ctrl?.signal,
        });
        clearTimeout(to);
        if (res.ok) {
          const p = (await res.json())?.features?.[0]?.properties || {};
          const area = p.district || p.locality || p.suburb || '';
          const city = p.city || p.town || p.village || p.county || '';
          name = [area, city].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
        }
      } catch {}
      if (_placeCache.size > 300) _placeCache.clear();
      _placeCache.set(key, name);
      job.resolve(name);
      await new Promise((r) => setTimeout(r, 1100)); // ~1 req/s (limite do serviço público)
    }
  } finally { _placeBusy = false; }
}
/** Promise<string> — '' quando não há nome. Limite: fila com no máx. 20 itens. */
export function placeName(lat, lng, lang) {
  const la = Number(lat); const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return Promise.resolve('');
  const key = _placeKey(la, lo);
  if (_placeCache.has(key)) return Promise.resolve(_placeCache.get(key));
  if (_placeQueue.length >= 20) return Promise.resolve('');
  return new Promise((resolve) => { _placeQueue.push({ lat: la, lng: lo, lang, resolve }); _drainPlaces(); });
}

/** Abre o app de mapas do aparelho com rota até o ponto. */
export function openDirections(lat, lng, label = '') {
  const la = Number(lat); const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return;
  let url;
  if (Platform.OS === 'ios') url = `http://maps.apple.com/?daddr=${la},${lo}&dirflg=d`;
  else if (Platform.OS === 'android') url = `geo:${la},${lo}?q=${la},${lo}(${encodeURIComponent(label || 'Chatyy')})`;
  else url = `https://www.openstreetmap.org/directions?route=%3B${la}%2C${lo}#map=15/${la}/${lo}`;
  Linking.openURL(url).catch(() => {
    Linking.openURL(`https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=16/${la}/${lo}`).catch(() => {});
  });
}
