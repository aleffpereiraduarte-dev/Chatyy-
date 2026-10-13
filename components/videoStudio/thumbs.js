// [2026-10-13 video-studio] Miniaturas da linha do tempo (sem dependência nova):
// expo-video VideoPlayer.generateThumbnailsAsync (iOS/Android). Um player
// temporário por fonte, em FILA (1 por vez), resultado em cache por URI.
// Também descobre a duração da fonte (limite dos handles de corte).
// Web: só a duração (sem miniaturas → placeholder / clip.thumb).
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

const cache = new Map(); // uri → { duration, thumbs: [{ t, src }] }
const waiters = new Map(); // uri → Set<fn>
const queue = [];
let busy = false;

function done(uri, val) {
  cache.set(uri, val);
  const set = waiters.get(uri);
  waiters.delete(uri);
  set?.forEach((fn) => { try { fn(val); } catch {} });
}

function waitReady(player, ms) {
  return new Promise((resolve) => {
    let sub = null;
    const finish = (ok) => { try { sub?.remove?.(); } catch {} clearTimeout(to); resolve(ok); };
    const to = setTimeout(() => finish(player.status === 'readyToPlay'), ms);
    if (player.status === 'readyToPlay') { finish(true); return; }
    try {
      sub = player.addListener('statusChange', (e) => {
        const st = e?.status || player.status;
        if (st === 'readyToPlay') finish(true);
        else if (st === 'error') finish(false);
      });
    } catch { /* timeout resolve */ }
  });
}

async function work(uri) {
  let player = null;
  try {
    const { createVideoPlayer } = require('expo-video');
    player = createVideoPlayer({ uri });
    try { player.muted = true; } catch {}
    await waitReady(player, 10000);
    const duration = Number(player.duration) || 0;
    let thumbs = [];
    if (Platform.OS !== 'web' && duration > 0 && typeof player.generateThumbnailsAsync === 'function') {
      const n = Math.max(4, Math.min(16, Math.ceil(duration / 1.2)));
      const times = Array.from({ length: n }, (_, i) => Math.min(duration - 0.05, (i + 0.5) * (duration / n)));
      try {
        const res = await player.generateThumbnailsAsync(times, { maxWidth: 160, maxHeight: 284 });
        thumbs = (res || []).map((src, i) => ({ t: times[i], src }));
      } catch { thumbs = []; }
    }
    done(uri, { duration, thumbs });
  } catch {
    done(uri, { duration: 0, thumbs: [] });
  } finally {
    try { player?.release?.(); } catch {}
  }
}

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const uri = queue.shift();
    if (cache.has(uri)) continue;
    // eslint-disable-next-line no-await-in-loop
    await work(uri);
  }
  busy = false;
}

export function requestSource(uri, fn) {
  if (!uri) return () => {};
  if (cache.has(uri)) { fn(cache.get(uri)); return () => {}; }
  if (!waiters.has(uri)) waiters.set(uri, new Set());
  waiters.get(uri).add(fn);
  if (!queue.includes(uri)) queue.push(uri);
  pump();
  return () => { waiters.get(uri)?.delete(fn); };
}

export function getSourceInfo(uri) { return cache.get(uri) || null; }

/** { duration, thumbs } da fonte (null enquanto carrega). Fotos: thumbs = [uri]. */
export function useSourceInfo(clip) {
  const uri = clip?.uri;
  const isImage = clip?.kind === 'image';
  const [info, setInfo] = useState(() => (isImage ? { duration: 0, thumbs: [{ t: 0, src: { uri } }] } : cache.get(uri) || null));
  useEffect(() => {
    if (!uri) return undefined;
    if (isImage) { setInfo({ duration: 0, thumbs: [{ t: 0, src: { uri } }] }); return undefined; }
    let alive = true;
    const un = requestSource(uri, (v) => { if (alive) setInfo(v); });
    return () => { alive = false; un(); };
  }, [uri, isImage]);
  return info;
}

/** Miniatura mais próxima de um tempo-fonte. */
export function thumbAt(info, t) {
  const arr = info?.thumbs || [];
  if (!arr.length) return null;
  let best = arr[0];
  for (const x of arr) if (Math.abs(x.t - t) < Math.abs(best.t - t)) best = x;
  return best.src;
}
