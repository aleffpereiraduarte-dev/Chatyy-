// friendMapCore — regras puras do Mapa de amigos v2 (sem React, testáveis em node)
// ================================================================================
// [2026-10-24 mapa-v2] Nível Snap Map / Find My:
//   • envio ADAPTATIVO: parado = raro (keepalive), andando = frequente;
//   • rótulo "há X" GROSSO no pino (agora / N min / N h / N d) — o fino ("há 20s")
//     mudava a cada 10 s e o iOS recriava a anotação inteira (avatar piscando);
//   • agrupamento (clusters) dos marcadores do mapa NATIVO em JS (o WebView já tinha);
//   • bateria do amigo (quando o servidor/binário mandarem).
// Kill geral (OTA/local): globalThis.__chatyy_fmap_v2 = false → comportamento anterior.

export function fmapV2() {
  try { return globalThis.__chatyy_fmap_v2 !== false; } catch { return true; }
}

// ── Frescor ────────────────────────────────────────────────────────────────
// Com envio adaptativo um amigo PARADO publica só a cada ~10 min; o anel cinza
// ("sem atualização") passa a valer só depois de 15 min (igual ao `stale` do
// servidor). "Ao vivo" (anel pulsando) = atualizado nos últimos 2 min.
export const LIVE_MS = 2 * 60 * 1000;
export const STALE_MS_V2 = 15 * 60 * 1000;
export const STALE_MS_V1 = 2 * 60 * 1000;
export function staleThresholdMs() { return fmapV2() ? STALE_MS_V2 : STALE_MS_V1; }
// Acordar o celular do amigo (push silencioso) só depois de 20 min sem nada
// (antes 5 min — com envio adaptativo isso acordaria quem só está parado).
export function wakePingAfterMs() { return fmapV2() ? 20 * 60 * 1000 : 5 * 60 * 1000; }

/** updated_at do backend ("YYYY-MM-DD HH:MM:SS" UTC) ou ISO → epoch ms | 0. */
export function parseUpdatedAt(v) {
  if (!v) return 0;
  const s = String(v);
  try {
    const hasTz = /[zZ]|[+-]\d\d:?\d\d$/.test(s);
    const t = new Date(s.replace(' ', 'T') + (hasTz ? '' : 'Z')).getTime();
    return Number.isFinite(t) ? t : 0;
  } catch { return 0; }
}

/** "agora" · "5 min" · "2 h" · "3 d" — muda no máx. 1×/min (estável p/ o pino nativo). */
export function agoShort(updatedAt, now = Date.now(), t = null) {
  const ts = parseUpdatedAt(updatedAt);
  if (!ts) return '';
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  const tr = (k, vars, fb) => {
    try { const v = t?.(k, vars); if (v && v !== k) return v; } catch {}
    return fb;
  };
  if (s < 120) return tr('mural.time.now', null, 'agora');
  if (s < 3600) { const n = Math.floor(s / 60); return tr('mural.time.min', { n }, `${n} min`); }
  if (s < 86400) { const n = Math.floor(s / 3600); return tr('mural.time.h', { n }, `${n} h`); }
  const n = Math.floor(s / 86400);
  return tr('mural.time.d', { n }, `${n} d`);
}

// ── Bateria ────────────────────────────────────────────────────────────────
/** {level 0-100, charging} | null a partir da linha do servidor. */
export function batteryOf(row) {
  if (!row) return null;
  const lv = Number(row.battery);
  if (!Number.isFinite(lv) || lv < 0 || lv > 100) return null;
  const ch = row.charging === true || row.charging === 1 || row.charging === '1' || row.charging === 't' || row.charging === 'true';
  return { level: Math.round(lv), charging: ch };
}
export function batteryLow(b) { return !!b && !b.charging && b.level <= 20; }

/** Lê a bateria do aparelho pelo módulo nativo (binário novo) — null no antigo. */
export function readDeviceBattery() {
  try {
    const { requireOptionalNativeModule } = require('expo-modules-core');
    const m = requireOptionalNativeModule?.('ChatyyFriendLocation');
    if (!m || typeof m.getBattery !== 'function') return null;
    const r = m.getBattery();
    const lv = Number(r?.level);
    if (!Number.isFinite(lv) || lv < 0) return null;
    return { battery: Math.round(Math.min(100, lv)), charging: !!r?.charging };
  } catch { return null; }
}

// ── Envio adaptativo ───────────────────────────────────────────────────────
export function distanceMeters(aLat, aLng, bLat, bLng) {
  if (![aLat, aLng, bLat, bLng].every((v) => Number.isFinite(Number(v)))) return null;
  const R = 6371000;
  const toR = (d) => (Number(d) * Math.PI) / 180;
  const dLat = toR(bLat - aLat);
  const dLng = toR(bLng - aLng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Intervalos (ms). `live` = localização ao vivo DA CONVERSA (o outro lado some
// em 2 min sem atualização → keepalive 90 s); `friend` = Mapa de amigos.
export const ADAPTIVE = {
  live:   { moving: 30 * 1000, still: 90 * 1000 },
  friend: { moving: 45 * 1000, still: 10 * 60 * 1000 },
  moveMinM: 40,       // deslocamento mínimo p/ contar como "andou"
  speedMovingMs: 1.0, // ≥ 1 m/s (≈ 3,6 km/h) = em movimento
};

/**
 * Decide se publica agora.
 * @param {{reason:'live'|'friend', pos:{lat,lng,accuracy?,speed?}, last:{lat,lng,at}|null, now?:number}} p
 * @returns {{publish:boolean, moving:boolean, movedM:number|null, gapMs:number}}
 */
export function shouldPublish({ reason, pos, last, now = Date.now() }) {
  const cfg = ADAPTIVE[reason === 'live' ? 'live' : 'friend'];
  if (!pos || !Number.isFinite(Number(pos.lat)) || !Number.isFinite(Number(pos.lng))) {
    return { publish: false, moving: false, movedM: null, gapMs: cfg.still };
  }
  if (!last || !last.at || !Number.isFinite(Number(last.lat))) {
    return { publish: true, moving: false, movedM: null, gapMs: cfg.moving };
  }
  const movedM = distanceMeters(last.lat, last.lng, pos.lat, pos.lng);
  const acc = Number(pos.accuracy);
  const minMove = Math.max(ADAPTIVE.moveMinM, Number.isFinite(acc) ? Math.min(acc, 150) : 0);
  const spd = Number(pos.speed);
  const moving = (movedM !== null && movedM >= minMove) || (Number.isFinite(spd) && spd >= ADAPTIVE.speedMovingMs);
  const gapMs = moving ? cfg.moving : cfg.still;
  return { publish: now - Number(last.at) >= gapMs, moving, movedM, gapMs };
}

// ── Agrupamento (clusters) p/ o mapa nativo ───────────────────────────────
// Projeção Web Mercator em pixels no zoom atual (256 px/tile, mesma escala do
// MapLibre; o MapKit usa a mesma convenção no nosso span(for:zoom)).
function project(lat, lng, zoom) {
  const scale = 256 * Math.pow(2, zoom);
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return {
    x: ((lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale,
  };
}

/**
 * Junta marcadores `kind:'avatar'` a menos de `radiusPx` na tela. Devolve a lista
 * final (avatares soltos + 1 marcador de grupo por cluster + os demais tipos).
 * Grupo: id "__cl:<ids>", rótulo "Ana +2", foto do 1º, iniciais = contagem.
 * Acima de `maxZoom` ninguém agrupa (todo mundo individual).
 */
export function clusterAvatarMarkers(markers, zoom, { radiusPx = 58, maxZoom = 16, keepId = null } = {}) {
  const list = Array.isArray(markers) ? markers : [];
  const z = Number(zoom);
  const av = list.filter((m) => m && m.kind === 'avatar' && m.id !== keepId);
  const rest = list.filter((m) => !(m && m.kind === 'avatar' && m.id !== keepId));
  if (!Number.isFinite(z) || z >= maxZoom || av.length < 2) return { markers: list, groups: {} };
  const pts = av.map((m) => ({ m, p: project(Number(m.latitude), Number(m.longitude), z) }));
  const used = new Set();
  const out = [];
  const groups = {};
  const R2 = radiusPx * radiusPx;
  for (let i = 0; i < pts.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const grp = [pts[i]];
    for (let j = i + 1; j < pts.length; j++) {
      if (used.has(j)) continue;
      const dx = pts[i].p.x - pts[j].p.x; const dy = pts[i].p.y - pts[j].p.y;
      if (dx * dx + dy * dy <= R2) { grp.push(pts[j]); used.add(j); }
    }
    if (grp.length === 1) { out.push(grp[0].m); continue; }
    // Ordem estável (id) → o mesmo grupo gera o MESMO marcador (sem recriar no nativo).
    grp.sort((a, b) => String(a.m.id).localeCompare(String(b.m.id)));
    const ids = grp.map((g) => g.m.id);
    const lat = grp.reduce((s, g) => s + Number(g.m.latitude), 0) / grp.length;
    const lng = grp.reduce((s, g) => s + Number(g.m.longitude), 0) / grp.length;
    const lead = grp.find((g) => !g.m.stale) || grp[0];
    const id = `__cl:${ids.join(',')}`;
    groups[id] = grp.map((g) => g.m);
    out.push({
      ...lead.m,
      id,
      latitude: lat,
      longitude: lng,
      label: `${String(lead.m.label || '').split(' ')[0]} +${grp.length - 1}`,
      sublabel: '',
      initials: String(grp.length),
      stale: grp.every((g) => g.m.stale),
      pulse: grp.some((g) => g.m.pulse),
      highlight: false,
    });
  }
  return { markers: [...out, ...rest], groups };
}

/** Caixa que cobre um grupo (p/ "aproximar no grupo"). */
export function boundsOf(list) {
  let minLat = 90; let minLng = 180; let maxLat = -90; let maxLng = -180;
  (list || []).forEach((m) => {
    const la = Number(m.latitude); const lo = Number(m.longitude);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return;
    minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la);
    minLng = Math.min(minLng, lo); maxLng = Math.max(maxLng, lo);
  });
  if (minLat > maxLat) return null;
  return { minLat, minLng, maxLat, maxLng, lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
}
