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
  return {
    key,
    cdn: CHATYY_MEDIA_CDN + key,
    api: `${CHATYY_STATIC_MAP_API}?lat=${sLa}&lng=${sLo}&z=${z}&theme=${theme}&pin=${pin ? 1 : 0}`,
  };
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
