// BoraMap.js — mapas self-hosted (OpenStreetMap/MapLibre) via BoraUm. ZERO Google.
//
// 2026-06-24: trocamos o Google Maps (Static Maps + Maps JS, billing pago) pelo
// nosso próprio tile server self-hosted do BoraUm (OpenStreetMap data, MapLibre).
// Tudo aqui é OTA puro — não há dependência nativa (sem @maplibre/maplibre-react-native).
// Mapas estáticos (balões) usam a Static Image API do tileserver-gl; mapas
// interativos usam MapLibre GL JS via CDN dentro do WebView que já existe.
//
// REGRA DE OURO (não quebrar): os tiles do BoraUm SAEM CRUS (sem Content-Encoding
// gzip, com no-transform). Se algum dia vierem gzipados, o MapLibre fica cinza.
// Os endpoints já respeitam isso (verificado 2026-06-24). NÃO mexer no tileserver.

// Base dos tiles/styles (5 países schema OpenMapTiles + mundo schema Protomaps v4)
export const BORA_TILES_BASE = 'https://boraum.com.br/maptiles';

// Style IDs por país (verificados HTTP 200 em 2026-06-24). 'world-cinza' = fallback global.
export const BORA_STYLE_IDS = {
  BR: 'basic-preview',
  US: 'basic-preview-us',
  PH: 'philippines-style',
  PT: 'portugal-style',
  CO: 'colombia-style',
  WORLD: 'world-cinza',
};

// bbox = [minLon, minLat, maxLon, maxLat]. Polígonos não se sobrepõem → ordem
// de teste não importa. (PT cobre só continente; Açores/Madeira caem no WORLD.)
const COVERAGE = [
  ['BR', [-74.0, -33.8, -34.8, 5.3]],
  ['US', [-125.0, 24.4, -66.9, 49.4]],
  ['PH', [116.9, 4.6, 126.6, 21.1]],
  ['PT', [-9.6, 36.9, -6.2, 42.2]],
  ['CO', [-79.1, -4.2, -66.9, 12.5]],
];

/**
 * Escolhe o style do BoraUm para um ponto. Dentro de um dos 5 países → style do
 * país; senão → world-cinza. ATENÇÃO: assinatura (lon, lat) — longitude primeiro
 * (igual o BoraMap.tsx de referência e a Static Image API do tileserver-gl).
 */
export function coverageStyleFor(lon, lat) {
  const x = Number(lon);
  const y = Number(lat);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    for (const [code, [m0, m1, m2, m3]] of COVERAGE) {
      if (x >= m0 && x <= m2 && y >= m1 && y <= m3) return BORA_STYLE_IDS[code];
    }
  }
  return BORA_STYLE_IDS.WORLD;
}

/** URL do style.json para mapa interativo (MapLibre GL JS). */
export function boraStyleUrl(lon, lat) {
  return `${BORA_TILES_BASE}/styles/${coverageStyleFor(lon, lat)}/style.json`;
}

/**
 * URL de imagem estática (PNG) do mapa — substitui o Google Static Maps nos balões.
 * Formato tileserver-gl: /styles/<id>/static/<lon>,<lat>,<zoom>/<w>x<h>@2x.png
 * IMPORTANTE: ordem é LON,LAT (longitude primeiro). @2x vai ANTES do .png
 * (como query "?@2x" é ignorado pelo tileserver). Passe w/h em px CSS (base);
 * com retina o servidor devolve w*2 × h*2 px reais.
 *
 * @param {number} lat  latitude
 * @param {number} lng  longitude
 * @param {number} zoom nível de zoom (ex.: 15-16 p/ balão)
 * @param {number} w    largura CSS (base)
 * @param {number} h    altura CSS (base)
 * @param {boolean} retina  @2x (default true)
 */
// [2026-10-08 location-bubble-fast] A Static Image API do tileserver BoraUm
// morreu (404 desde 2026-10-01). Agora boraStaticMapUrl aponta pro NOSSO
// renderizador (chatyyStaticMap → api.php que gera/redireciona p/ o CDN).
// w/h/retina são ignorados (imagem canônica 600x360, use contentFit cover).
export function boraStaticMapUrl(lat, lng, zoom = 15, w = 280, h = 160, retina = true) { // eslint-disable-line no-unused-vars
  const u = chatyyStaticMap(lat, lng, { zoom });
  return u ? u.api : null;
}

/**
 * [2026-10-08 location-bubble-fast] Mapa estático do balão de localização.
 * Servidor: /api/static-map.php (renderiza no edge BR com MapLibre headless nos
 * MESMOS styles BoraUm do app, grava no R2) → imagem JPEG 600x360 (300x180 @2x)
 * com pin monocromático no centro exato (preto no claro, branco no escuro).
 * Chave estável = mesma regra do PHP (lat/lng 5 casas, zoom, tema, pin).
 * Retorna { cdn, api, key }: use `cdn` primeiro (imutável, edge-cached) e caia
 * pro `api` no onError (1º acesso a uma coordenada nunca gerada).
 */
export const CHATYY_STATIC_MAP_API = 'https://chatyy.com.br/api/static-map.php';
export const CHATYY_MEDIA_CDN = 'https://media.chatyy.com.br/';
export function chatyyStaticMap(lat, lng, { zoom = 15, dark = false, pin = true } = {}) {
  const la = Math.round(Number(lat) * 1e5) / 1e5;
  const lo = Math.round(Number(lng) * 1e5) / 1e5;
  if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 85 || Math.abs(lo) > 180) return null;
  const z = Math.max(3, Math.min(18, Math.round(Number(zoom) || 15)));
  const theme = dark ? 'dark' : 'light';
  const sLa = la.toFixed(5);
  const sLo = lo.toFixed(5);
  const key = `sm/v1/${theme}/${z}/${sLa},${sLo}${pin ? '' : '_np'}.jpg`;
  // [2026-10-16 mapa-chat] `r=2`: fura o cache do aparelho p/ as imagens que o
  // renderizador gerou CINZA VAZIAS fora do Brasil (bbox do BR engolia o Chile
  // etc.; corrigido no servidor por sonda de cobertura). O servidor ignora `r`.
  return {
    key,
    cdn: CHATYY_MEDIA_CDN + key + '?r=2',
    api: `${CHATYY_STATIC_MAP_API}?lat=${sLa}&lng=${sLo}&z=${z}&theme=${theme}&pin=${pin ? 1 : 0}&r=2`,
  };
}

// [2026-10-16 mapa-chat] Style por COBERTURA REAL de tiles (mesma regra do
// renderizador do servidor, /opt/chatyy-staticmap/coverage.js). Os bboxes dos
// países são retângulos: o do BR cobre Chile/Argentina/Paraguai..., o do US
// cobre Canadá/México — e os tiles do país vêm 204 fora do polígono → mapa
// cinza. Sonda 1 tile z14 do país; vazio → world-cinza. Memo por tile z10.
const _tplMemo = new Map();
const _probeMemo = new Map();
function _tileXY(lat, lng, z) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n);
  return [Math.max(0, Math.min(n - 1, x)), Math.max(0, Math.min(n - 1, y))];
}
async function _fetchJson(url, ms) {
  let ctrl = null; let tm = null;
  try { ctrl = new AbortController(); tm = setTimeout(() => { try { ctrl.abort(); } catch {} }, ms); } catch {}
  try {
    const r = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
    if (!r.ok) throw new Error('http ' + r.status);
    return await r.json();
  } finally { if (tm) clearTimeout(tm); }
}
function _tileTemplate(id) {
  let p = _tplMemo.get(id);
  if (!p) {
    p = (async () => {
      const st = await _fetchJson(`${BORA_TILES_BASE}/styles/${id}/style.json`, 4000);
      const src = (st && st.sources && st.sources.openmaptiles) || {};
      let tiles = src.tiles; let maxzoom = src.maxzoom;
      if (!tiles && src.url) { const tj = await _fetchJson(src.url, 4000); tiles = tj && tj.tiles; maxzoom = tj && tj.maxzoom; }
      if (!Array.isArray(tiles) || !tiles[0]) return null;
      return { tpl: tiles[0], maxzoom: Math.min(14, Number(maxzoom) || 14) };
    })().catch(() => { _tplMemo.delete(id); return null; });
    _tplMemo.set(id, p);
  }
  return p;
}
/** true quando o tileset do style `id` tem dado no ponto (sonda 1 tile). Erro de rede → true. */
export async function boraStyleHasData(id, lat, lng) {
  const la = Number(lat); const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return true;
  const [x10, y10] = _tileXY(la, lo, 10);
  const ck = `${id}|${x10}|${y10}`;
  if (_probeMemo.has(ck)) return _probeMemo.get(ck);
  const t = await _tileTemplate(id);
  if (!t) return true;
  const [x, y] = _tileXY(la, lo, t.maxzoom);
  const url = t.tpl.replace('{z}', String(t.maxzoom)).replace('{x}', String(x)).replace('{y}', String(y));
  try {
    const r = await fetch(url);
    let ok = false;
    if (r.status === 200) { const b = await r.arrayBuffer(); ok = !!(b && b.byteLength > 0); }
    _probeMemo.set(ck, ok);
    if (_probeMemo.size > 500) _probeMemo.delete(_probeMemo.keys().next().value);
    return ok;
  } catch { return true; }
}
/** style.json certo p/ o ponto: dark → mapa escuro BoraUm (base mundial); claro → país (se tem dado) ou world-cinza. */
export async function resolveBoraStyleUrl(lat, lng, isDark = false) {
  if (isDark) return `${BORA_TILES_BASE}/styles/boraum-mapa-escuro/style.json`;
  const id = coverageStyleFor(lng, lat);
  if (id !== BORA_STYLE_IDS.WORLD) {
    const ok = await boraStyleHasData(id, lat, lng);
    if (!ok) return `${BORA_TILES_BASE}/styles/${BORA_STYLE_IDS.WORLD}/style.json`;
  }
  return `${BORA_TILES_BASE}/styles/${id}/style.json`;
}

/**
 * HTML completo de um mapa interativo MapLibre GL JS (CDN) p/ injetar no WebView/iframe.
 * style escolhido por coverageStyleFor(center). Use postMessage do RN p/ atualizar.
 * Mantém os tiles crus (o style.json já aponta pros endpoints corretos do BoraUm).
 *
 * @param {{lat:number,lng:number,zoom?:number,interactive?:boolean,markerColor?:string}} opts
 */
export function boraMapHtml({ lat, lng, zoom = 15, interactive = true, markerColor = '#111111' } = {}) {
  const la = Number(lat) || 0;
  const lo = Number(lng) || 0;
  const styleUrl = boraStyleUrl(lo, la);
  const interactiveJs = interactive
    ? ''
    : 'map.scrollZoom.disable();map.dragPan.disable();map.doubleClickZoom.disable();map.touchZoomRotate.disable();map.keyboard.disable();';
  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<link href="https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.css" rel="stylesheet"/>
<script src="https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.js"></script>
<style>html,body,#map{margin:0;padding:0;width:100%;height:100%;background:#e5e7eb}</style>
</head><body>
<div id="map"></div>
<script>
  var map = new maplibregl.Map({
    container: 'map',
    style: ${JSON.stringify(styleUrl)},
    center: [${lo}, ${la}],
    zoom: ${Number(zoom) || 15},
    attributionControl: false
  });
  ${interactiveJs}
  var el = document.createElement('div');
  el.style.cssText = 'width:22px;height:22px;border-radius:50%;background:${markerColor};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)';
  var marker = new maplibregl.Marker({element: el}).setLngLat([${lo}, ${la}]).addTo(map);
  // Permite atualizar o pin via postMessage (live location): {type:'updatePos',lat,lng}
  function onMsg(e){ try{ var d = typeof e.data==='string'?JSON.parse(e.data):e.data; if(d&&d.type==='updatePos'){ marker.setLngLat([d.lng,d.lat]); map.easeTo({center:[d.lng,d.lat]}); } }catch(_){} }
  window.addEventListener('message', onMsg);
  document.addEventListener('message', onMsg);
</script>
</body></html>`;
}
