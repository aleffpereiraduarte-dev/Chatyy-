// LocationViewerV2 — [2026-10-16 mapa-chat] tela cheia de localização
// (fixa ou AO VIVO), repaginada estilo "Buscar"/Apple Maps, P&B do app.
//
// Founder (prints 16/10): cabeçalho VERDE fora da marca, mapa plano, botão
// verde, nome cortado e coordenadas cruas "-33.40187, -70.79265 · 0 m".
// Agora:
//   - mapa ocupa a tela toda; botões flutuantes translúcidos (blur no iOS),
//     nada de barra colorida;
//   - pino = foto da pessoa com anel P&B (ao vivo; o pulso do anel no mapa vem
//     no próximo build nativo — campo `pulse` é ignorado por binários velhos)
//     ou pino preto (fixa);
//   - cartão inferior arrastável: nome, endereço legível (geocodificação
//     reversa: CLGeocoder/Geocoder do aparelho → Photon/OSM), distância de
//     você, "atualizado há X s", "Como chegar" (Apple Maps / Google Maps /
//     Waze), "Compartilhar"; coordenadas só em "Copiar coordenadas";
//   - centralizar + minha localização; mapa escuro no tema escuro.
// Motor de mapa: ChatyyMapView nativo (iOS MapKit / Android MapLibre) quando o
// binário tem; senão (web / binário velho) MapLibre GL JS num WebView/iframe
// com o MESMO visual. Kill switch OTA: globalThis.__chatyy_loc_viewer_v2 = false
// → volta ao viewer antigo (LocationViewerModal).

import React from 'react';
import {
  View, Text, TouchableOpacity, Modal, Platform, StatusBar, Animated, Easing,
  PanResponder, LayoutAnimation, Share, Linking, StyleSheet, Image,
} from 'react-native';
import { useLanguage } from '../context/LanguageContext';
import { useTheme } from '../context/ThemeContext';
import { ChatyyMap, isNativeMapAvailable, nativeMapStyleUrl } from './NativeMap';
import { resolveBoraStyleUrl } from './BoraMap';
import { IconLocate } from './MapControls';
import { IconChevronDown, IconShare, IconNavigation, IconCopy, IconMapPin, IconChevronRight } from './Icons';
import { getNativeBlurView } from './NativeBlur';

const MAPLIBRE_VER = '5.6.0';
const useND = Platform.OS !== 'web';

// ─── utilidades ────────────────────────────────────────────────────────────
function haversine(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(bLat - aLat);
  const dLng = toR(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function fmtDistance(m, lang) {
  if (!Number.isFinite(m)) return '';
  if (m < 1000) return `${Math.round(m / 10) * 10 || Math.round(m)} m`;
  const km = m / 1000;
  const digits = km < 10 ? 1 : 0;
  try { return `${km.toLocaleString(lang || undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })} km`; } catch {}
  return `${km.toFixed(digits)} km`;
}

function fmtAgo(sec) {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min`;
  return `${Math.floor(sec / 3600)} h`;
}

function fmtRemaining(sec) {
  const m = Math.max(0, Math.floor(sec / 60));
  if (m >= 60) { const h = Math.floor(m / 60); const r = m % 60; return r ? `${h} h ${r} min` : `${h} h`; }
  return `${Math.max(1, m)} min`;
}

function looksLikeCoords(s) {
  return /^\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$/.test(String(s || ''));
}

function initialsOf(name) {
  const parts = String(name || '').replace(/@.*/, '').trim().split(/[\s._-]+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

// Geocodificação reversa: aparelho (CLGeocoder / Android Geocoder via
// expo-location — sem permissão) → Photon (OSM). Memo por ~11 m.
const _geoMemo = new Map();
export async function reverseGeocode(lat, lng, lang) {
  const la = Number(lat); const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  const key = `${la.toFixed(4)},${lo.toFixed(4)}`;
  if (_geoMemo.has(key)) return _geoMemo.get(key);
  let out = null;
  if (Platform.OS !== 'web') {
    try {
      const Location = require('expo-location');
      const arr = await Location.reverseGeocodeAsync({ latitude: la, longitude: lo });
      const a = Array.isArray(arr) ? arr[0] : null;
      if (a) {
        const street = [a.street, a.streetNumber].filter(Boolean).join(', ');
        const area = [a.district || a.subregion, a.city].filter((x, i, l) => x && l.indexOf(x) === i).join(', ');
        const name = a.name && a.name !== a.streetNumber && a.name !== street ? a.name : '';
        out = { name, line: [street || a.name, area].filter(Boolean).join(' · '), city: a.city || a.region || '', country: a.country || '' };
      }
    } catch {}
  }
  if (!out || !out.line) {
    try {
      const l2 = String(lang || '').slice(0, 2).toLowerCase();
      const lp = ['en', 'de', 'fr'].includes(l2) ? l2 : 'default';
      const r = await fetch(`https://photon.komoot.io/reverse?lat=${la}&lon=${lo}&limit=1&lang=${lp}`, { headers: { Accept: 'application/json' } });
      if (r.ok) {
        const j = await r.json();
        const p = (j && j.features && j.features[0] && j.features[0].properties) || null;
        if (p) {
          const street = [p.street, p.housenumber].filter(Boolean).join(', ');
          const area = [p.district || p.locality, p.city || p.county].filter((x, i, l) => x && l.indexOf(x) === i).join(', ');
          out = { name: p.name && p.name !== p.street ? p.name : '', line: [street || p.name, area].filter(Boolean).join(' · '), city: p.city || p.state || '', country: p.country || '' };
        }
      }
    } catch {}
  }
  if (out && !out.line) out = null;
  _geoMemo.set(key, out);
  if (_geoMemo.size > 200) _geoMemo.delete(_geoMemo.keys().next().value);
  return out;
}

// ─── pequenos componentes ──────────────────────────────────────────────────
function usePulse(active) {
  const v = React.useRef(new Animated.Value(0)).current;
  React.useEffect(() => {
    if (!active) { v.stopAnimation(); v.setValue(0); return undefined; }
    const loop = Animated.loop(Animated.timing(v, { toValue: 1, duration: 1600, easing: Easing.out(Easing.ease), useNativeDriver: useND }));
    loop.start();
    return () => loop.stop();
  }, [active, v]);
  return v;
}

function PulseDot({ color, size = 8, active = true }) {
  const p = usePulse(active);
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {active ? (
        <Animated.View style={{
          position: 'absolute', width: size, height: size, borderRadius: size / 2, backgroundColor: color,
          opacity: p.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
          transform: [{ scale: p.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] }) }],
        }} />
      ) : null}
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
    </View>
  );
}

function Glass({ isDark, style, children, radius = 22 }) {
  const BlurView = getNativeBlurView();
  const base = [{ borderRadius: radius, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.08)' }, style];
  if (BlurView) {
    return (
      <BlurView intensity={70} tint={isDark ? 'systemThickMaterialDark' : 'systemThickMaterialLight'} style={base}>
        {children}
      </BlurView>
    );
  }
  return <View style={[base, { backgroundColor: isDark ? 'rgba(28,28,30,0.92)' : 'rgba(255,255,255,0.94)' }]}>{children}</View>;
}

function RoundGlassButton({ isDark, onPress, children, label, size = 44 }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.75} accessibilityRole="button" accessibilityLabel={label} hitSlop={6}
      style={{ shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 5, borderRadius: size / 2 }}>
      <Glass isDark={isDark} radius={size / 2} style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        {children}
      </Glass>
    </TouchableOpacity>
  );
}

function Ago({ ts, render }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!ts) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ts]);
  if (!ts) return null;
  return render(Math.max(0, (now - ts) / 1000));
}

function AvatarBadge({ uri, name, size = 46, live, isDark, fg }) {
  const [failed, setFailed] = React.useState(false);
  const p = usePulse(!!live);
  const ring = isDark ? '#FFFFFF' : '#111111';
  return (
    <View style={{ width: size + 8, height: size + 8, alignItems: 'center', justifyContent: 'center' }}>
      {live ? (
        <Animated.View style={{
          position: 'absolute', width: size + 8, height: size + 8, borderRadius: (size + 8) / 2, borderWidth: 2, borderColor: ring,
          opacity: p.interpolate({ inputRange: [0, 1], outputRange: [0.7, 0] }),
          transform: [{ scale: p.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.35] }) }],
        }} />
      ) : null}
      <View style={{ width: size + 4, height: size + 4, borderRadius: (size + 4) / 2, borderWidth: 2, borderColor: live ? ring : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
        {uri && !failed ? (
          <Image source={{ uri }} onError={() => setFailed(true)} style={{ width: size - 2, height: size - 2, borderRadius: (size - 2) / 2, backgroundColor: isDark ? '#2C2C2E' : '#E5E5EA' }} />
        ) : (
          <View style={{ width: size - 2, height: size - 2, borderRadius: (size - 2) / 2, backgroundColor: isDark ? '#2C2C2E' : '#111111', alignItems: 'center', justifyContent: 'center' }}>
            {name ? <Text style={{ color: '#fff', fontWeight: '700', fontSize: size * 0.36 }}>{initialsOf(name)}</Text> : <IconMapPin size={size * 0.46} color={fg || '#fff'} />}
          </View>
        )}
      </View>
    </View>
  );
}

// ─── mapa web/WebView (binário sem ChatyyMapView, ou web) ──────────────────
function webMapHtml({ lat, lng, styleUrl, dark, live, avatarUrl, initials }) {
  const ring = dark ? '#FFFFFF' : '#111111';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<link href="https://unpkg.com/maplibre-gl@${MAPLIBRE_VER}/dist/maplibre-gl.css" rel="stylesheet"/>
<script src="https://unpkg.com/maplibre-gl@${MAPLIBRE_VER}/dist/maplibre-gl.js"></script>
<style>
html,body,#map{margin:0;padding:0;width:100%;height:100%;background:${dark ? '#1c1c1e' : '#e9e9ec'}}
.maplibregl-ctrl-bottom-left,.maplibregl-ctrl-bottom-right{display:none}
.av{position:relative;width:52px;height:52px}
.av .ring{position:absolute;inset:0;border-radius:50%;background:${ring};box-shadow:0 3px 10px rgba(0,0,0,.35)}
.av .img{position:absolute;inset:3px;border-radius:50%;background:#111 center/cover no-repeat;color:#fff;font:700 18px -apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;border:2px solid ${dark ? '#111' : '#fff'}}
.av .pulse{position:absolute;inset:0;border-radius:50%;border:2px solid ${ring};animation:p 1.8s ease-out infinite}
@keyframes p{0%{transform:scale(1);opacity:.7}100%{transform:scale(1.9);opacity:0}}
.me{width:16px;height:16px;border-radius:50%;background:#0A84FF;border:3px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.35)}
</style></head><body><div id="map"></div><script>
var post=function(o){try{var s=JSON.stringify(o);if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(s);else if(window.parent)window.parent.postMessage({__lv2:1,data:o},'*');}catch(e){}};
var map=new maplibregl.Map({container:'map',style:${JSON.stringify(styleUrl)},center:[${lng},${lat}],zoom:16,attributionControl:false,dragRotate:false,pitchWithRotate:false});
map.touchZoomRotate.disableRotation();
var el;
${live || avatarUrl ? `el=document.createElement('div');el.className='av';el.innerHTML=${JSON.stringify(live ? '<div class="pulse"></div>' : '')}+'<div class="ring"></div><div class="img"></div>';
var im=el.querySelector('.img');im.textContent=${JSON.stringify(initials || '')};
${avatarUrl ? `(function(){var i=new Image();i.onload=function(){im.textContent='';im.style.backgroundImage='url("'+i.src+'")';};i.src=${JSON.stringify(avatarUrl)};})();` : ''}
var marker=new maplibregl.Marker({element:el,anchor:'center'}).setLngLat([${lng},${lat}]).addTo(map);`
    : `el=document.createElement('div');el.innerHTML='<svg width="34" height="44" viewBox="0 0 34 44"><path d="M17 42.5c-.6 0-1.1-.3-1.4-.8C10.2 33.6 3 25.6 3 17.3 3 9.4 9.3 3 17 3s14 6.4 14 14.3c0 8.3-7.2 16.3-12.6 24.4-.3.5-.8.8-1.4.8z" fill="#111" stroke="#fff" stroke-width="2.5"/><circle cx="17" cy="17" r="5.2" fill="#fff"/></svg>';el.style.filter='drop-shadow(0 2px 3px rgba(0,0,0,.35))';
var marker=new maplibregl.Marker({element:el,anchor:'bottom'}).setLngLat([${lng},${lat}]).addTo(map);`}
var meMk=null;
map.on('dragstart',function(){post({type:'drag'});});
map.on('load',function(){post({type:'ready'});});
function onMsg(e){try{var d=e&&e.data;if(typeof d==='string')d=JSON.parse(d);if(!d)return;
 if(d.type==='updatePos'){marker.setLngLat([d.lng,d.lat]);if(d.follow)map.easeTo({center:[d.lng,d.lat],duration:600});}
 else if(d.type==='center'){map.easeTo({center:[d.lng,d.lat],zoom:d.zoom||16,duration:600});}
 else if(d.type==='me'){if(!meMk){var m=document.createElement('div');m.className='me';meMk=new maplibregl.Marker({element:m}).setLngLat([d.lng,d.lat]).addTo(map);}else meMk.setLngLat([d.lng,d.lat]);}
 else if(d.type==='fit'){map.fitBounds([[Math.min(d.a[1],d.b[1]),Math.min(d.a[0],d.b[0])],[Math.max(d.a[1],d.b[1]),Math.max(d.a[0],d.b[0])]],{padding:{top:110,bottom:260,left:60,right:60},maxZoom:16,duration:700});}
 else if(d.type==='style'){map.setStyle(d.url);}
}catch(_){}}
window.addEventListener('message',onMsg);document.addEventListener('message',onMsg);
</script></body></html>`;
}

// Web: MapLibre direto no DOM da página. (Num <iframe srcdoc> sob a origem
// chatyy.com.br os workers do MapLibre nunca entregam os tiles → mapa cinza;
// medido 16/10 no Playwright. Fora de iframe funciona.)
let _mlPromise = null;
function ensureMaplibreWeb() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (_mlPromise) return _mlPromise;
  _mlPromise = new Promise((resolve, reject) => {
    try {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = `https://unpkg.com/maplibre-gl@${MAPLIBRE_VER}/dist/maplibre-gl.css`;
      document.head.appendChild(l);
      const sc = document.createElement('script');
      sc.src = `https://unpkg.com/maplibre-gl@${MAPLIBRE_VER}/dist/maplibre-gl.js`;
      sc.async = true;
      sc.onload = () => (window.maplibregl ? resolve(window.maplibregl) : reject(new Error('maplibre missing')));
      sc.onerror = () => { _mlPromise = null; reject(new Error('maplibre load failed')); };
      document.head.appendChild(sc);
    } catch (e) { _mlPromise = null; reject(e); }
  });
  return _mlPromise;
}

const PIN_SVG = '<svg width="34" height="44" viewBox="0 0 34 44"><path d="M17 42.5c-.6 0-1.1-.3-1.4-.8C10.2 33.6 3 25.6 3 17.3 3 9.4 9.3 3 17 3s14 6.4 14 14.3c0 8.3-7.2 16.3-12.6 24.4-.3.5-.8.8-1.4.8z" fill="#111" stroke="#fff" stroke-width="2.5"/><circle cx="17" cy="17" r="5.2" fill="#fff"/></svg>';

function DomMap({ opts, onEvent, apiRef }) {
  const divRef = React.useRef(null);
  const onEventRef = React.useRef(onEvent);
  onEventRef.current = onEvent;
  React.useEffect(() => {
    let alive = true; let map = null; let styleEl = null;
    ensureMaplibreWeb().then((ml) => {
      if (!alive || !divRef.current) return;
      const ring = opts.dark ? '#FFFFFF' : '#111111';
      styleEl = document.createElement('style');
      styleEl.textContent = `.lv2-av{position:relative;width:52px;height:52px}.lv2-av .ring{position:absolute;inset:0;border-radius:50%;background:${ring};box-shadow:0 3px 10px rgba(0,0,0,.35)}.lv2-av .img{position:absolute;inset:3px;border-radius:50%;background:#111 center/cover no-repeat;color:#fff;font:700 18px -apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;border:2px solid ${opts.dark ? '#111' : '#fff'}}.lv2-av .pulse{position:absolute;inset:0;border-radius:50%;border:2px solid ${ring};animation:lv2p 1.8s ease-out infinite}@keyframes lv2p{0%{transform:scale(1);opacity:.7}100%{transform:scale(1.9);opacity:0}}.lv2-me{width:16px;height:16px;border-radius:50%;background:#0A84FF;border:3px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.35)}.lv2 .maplibregl-ctrl-bottom-left,.lv2 .maplibregl-ctrl-bottom-right{display:none}`;
      document.head.appendChild(styleEl);
      map = new ml.Map({ container: divRef.current, style: opts.styleUrl, center: [opts.lng, opts.lat], zoom: 16, attributionControl: false, dragRotate: false, pitchWithRotate: false });
      try { map.touchZoomRotate.disableRotation(); } catch {}
      let el; let marker;
      if (opts.live || opts.avatarUrl) {
        el = document.createElement('div'); el.className = 'lv2-av';
        el.innerHTML = (opts.live ? '<div class="pulse"></div>' : '') + '<div class="ring"></div><div class="img"></div>';
        const im = el.querySelector('.img'); im.textContent = opts.initials || '';
        if (opts.avatarUrl) { const i = new window.Image(); i.onload = () => { im.textContent = ''; im.style.backgroundImage = `url("${i.src}")`; }; i.src = opts.avatarUrl; }
        marker = new ml.Marker({ element: el, anchor: 'center' }).setLngLat([opts.lng, opts.lat]).addTo(map);
      } else {
        el = document.createElement('div'); el.innerHTML = PIN_SVG; el.style.filter = 'drop-shadow(0 2px 3px rgba(0,0,0,.35))';
        marker = new ml.Marker({ element: el, anchor: 'bottom' }).setLngLat([opts.lng, opts.lat]).addTo(map);
      }
      let meMk = null;
      map.on('dragstart', () => { try { onEventRef.current && onEventRef.current({ type: 'drag' }); } catch {} });
      apiRef.current = {
        send(d) {
          try {
            if (d.type === 'updatePos') { marker.setLngLat([d.lng, d.lat]); if (d.follow) map.easeTo({ center: [d.lng, d.lat], duration: 600 }); }
            else if (d.type === 'center') map.easeTo({ center: [d.lng, d.lat], zoom: d.zoom || 16, duration: 600 });
            else if (d.type === 'me') {
              if (!meMk) { const m = document.createElement('div'); m.className = 'lv2-me'; meMk = new ml.Marker({ element: m }).setLngLat([d.lng, d.lat]).addTo(map); } else meMk.setLngLat([d.lng, d.lat]);
            } else if (d.type === 'fit') {
              map.fitBounds([[Math.min(d.a[1], d.b[1]), Math.min(d.a[0], d.b[0])], [Math.max(d.a[1], d.b[1]), Math.max(d.a[0], d.b[0])]], { padding: { top: 110, bottom: 260, left: 60, right: 60 }, maxZoom: 16, duration: 700 });
            } else if (d.type === 'style') map.setStyle(d.url);
          } catch {}
        },
      };
    }).catch(() => {});
    return () => {
      alive = false; apiRef.current = null;
      try { map && map.remove(); } catch {}
      try { styleEl && styleEl.remove(); } catch {}
    };
  // opts muda só por tema/estilo/ao vivo — recria o mapa
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.styleUrl, opts.dark, opts.live, opts.avatarUrl]);
  return <div ref={divRef} className="lv2" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', background: opts.dark ? '#1c1c1e' : '#e9e9ec' }} />;
}

const WebMap = React.forwardRef(function WebMap({ html, onEvent, isDark, webOpts }, ref) {
  const domApiRef = React.useRef(null);
  const webRef = React.useRef(null);
  const iframeRef = React.useRef(null);
  React.useImperativeHandle(ref, () => ({
    send(o) {
      try { if (webRef.current?.injectJavaScript) webRef.current.injectJavaScript(`try{onMsg({data:${JSON.stringify(JSON.stringify(o))}})}catch(e){};true;`); } catch {}
      try { iframeRef.current?.contentWindow?.postMessage(o, '*'); } catch {}
      try { domApiRef.current?.send(o); } catch {}
    },
  }), []);
  React.useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const h = (e) => {
      try {
        if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
        if (e.data && e.data.__lv2) onEvent && onEvent(e.data.data);
      } catch {}
    };
    window.addEventListener('message', h);
    return () => window.removeEventListener('message', h);
  }, [onEvent]);
  if (Platform.OS === 'web' && webOpts) return <DomMap opts={webOpts} onEvent={onEvent} apiRef={domApiRef} />;
  if (Platform.OS === 'web') {
    return <iframe ref={iframeRef} title="map" srcDoc={html} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none', display: 'block', background: isDark ? '#1c1c1e' : '#e9e9ec' }} allow="geolocation" />;
  }
  let WebView = null;
  try { WebView = require('react-native-webview').WebView; } catch { WebView = null; }
  if (!WebView) return null;
  return (
    <WebView
      ref={webRef}
      source={{ html, baseUrl: 'https://boraum.com.br/' }}
      style={{ flex: 1, backgroundColor: isDark ? '#1c1c1e' : '#e9e9ec' }}
      javaScriptEnabled
      domStorageEnabled
      originWhitelist={['*']}
      onMessage={(e) => { try { onEvent && onEvent(JSON.parse(e.nativeEvent.data)); } catch {} }}
    />
  );
});

// ─── viewer ────────────────────────────────────────────────────────────────
export default function LocationViewerV2({
  visible, onClose, lat, lng, label, isLive, liveUntil, isUnlimited, messageId,
  senderEmail, senderName, isOwn, updatedAt,
}) {
  const { t, language } = useLanguage();
  const theme = useTheme() || {};
  const isDark = !!theme.isDark;
  const tr = React.useCallback((k, fb, p) => {
    let v = null;
    try { v = t(k, p); } catch {}
    if (!v || v === k) {
      v = fb;
      if (p) Object.keys(p).forEach((x) => { v = v.replace(new RegExp(`\\{${x}\\}`, 'g'), String(p[x])); });
    }
    return v;
  }, [t]);

  let insets = { top: Platform.OS === 'ios' ? 47 : (StatusBar.currentHeight || 24), bottom: Platform.OS === 'ios' ? 34 : 16 };
  try {
    // eslint-disable-next-line global-require
    const sa = require('react-native-safe-area-context').useSafeAreaInsets();
    if (sa && (sa.top || sa.bottom)) insets = { top: Math.max(sa.top, Platform.OS === 'android' ? (StatusBar.currentHeight || 0) : 0), bottom: Math.max(sa.bottom, 12) };
  } catch {}

  const numLat = Number(lat);
  const numLng = Number(lng);
  const native = isNativeMapAvailable();
  const safeLabel = String(label || '').replace(/[<>`\\]/g, '').slice(0, 200);

  const [pos, setPos] = React.useState({ lat: numLat, lng: numLng });
  const [lastTs, setLastTs] = React.useState(() => {
    const p = Date.parse(updatedAt || '');
    return Number.isFinite(p) ? p : null;
  });
  const [me, setMe] = React.useState(null);
  const [following, setFollowing] = React.useState(true);
  const [expanded, setExpanded] = React.useState(false);
  const [geo, setGeo] = React.useState(null);
  const [copied, setCopied] = React.useState(false);
  const [styleUrl, setStyleUrl] = React.useState(() => nativeMapStyleUrl(numLat, numLng, isDark));
  // web/WebView: só monta o mapa com o style já resolvido (cobertura real) — ou após 1,5 s
  const [styleReady, setStyleReady] = React.useState(false);
  const seqRef = React.useRef(1);
  const [camera, setCamera] = React.useState(() => ({ latitude: numLat, longitude: numLng, zoom: 16, seq: 1 }));
  const followingRef = React.useRef(true);
  followingRef.current = following;
  const webMapRef = React.useRef(null);

  // relógio p/ "termina em" / expirar
  const [nowSec, setNowSec] = React.useState(() => Math.floor(Date.now() / 1000));
  React.useEffect(() => {
    if (!visible || !isLive) return undefined;
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 15000);
    return () => clearInterval(id);
  }, [visible, isLive]);
  const effUnlimited = !!isUnlimited || !!(isLive && liveUntil && (Number(liveUntil) - nowSec) > 365 * 24 * 3600);
  const isStillLive = !!(isLive && (effUnlimited || (liveUntil && nowSec < Number(liveUntil))));

  // reset ao abrir outra localização
  React.useEffect(() => {
    if (!visible) return;
    setPos({ lat: numLat, lng: numLng });
    setFollowing(true);
    setExpanded(false);
    seqRef.current += 1;
    setCamera({ latitude: numLat, longitude: numLng, zoom: 16, seq: seqRef.current });
  }, [visible, numLat, numLng]);

  // style certo (cobertura real; Android/web — iOS MapKit ignora styleUrl)
  React.useEffect(() => {
    if (!visible || !Number.isFinite(numLat)) return undefined;
    let alive = true;
    const tm = setTimeout(() => { if (alive) setStyleReady(true); }, 1500);
    resolveBoraStyleUrl(numLat, numLng, isDark).then((u) => {
      if (!alive || !u) return;
      setStyleUrl(u);
      setStyleReady(true);
    }).catch(() => { if (alive) setStyleReady(true); });
    return () => { alive = false; clearTimeout(tm); };
  }, [visible, numLat, numLng, isDark]);

  // ticks ao vivo (mesmo contrato WS do viewer antigo)
  React.useEffect(() => {
    if (!visible || !isStillLive || !messageId) return undefined;
    let ws;
    try { ws = require('../services/websocket').default; } catch { return undefined; }
    if (!ws?.on) return undefined;
    const unsub = ws.on('live_location_update', (data) => {
      if (String(data?.message_id ?? '') !== String(messageId)) return;
      const nLat = Number(data?.latitude);
      const nLng = Number(data?.longitude);
      if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return;
      setPos({ lat: nLat, lng: nLng });
      const ts = Date.parse(data?.updated_at || '');
      setLastTs(Number.isFinite(ts) ? Math.min(ts, Date.now()) : Date.now());
      if (followingRef.current) {
        seqRef.current += 1;
        setCamera((c) => ({ latitude: nLat, longitude: nLng, zoom: c?.zoom || 16, animated: true, seq: seqRef.current }));
      }
      try { webMapRef.current?.send({ type: 'updatePos', lat: nLat, lng: nLng, follow: followingRef.current }); } catch {}
    });
    return () => { try { unsub?.(); } catch {} };
  }, [visible, isStillLive, messageId]);

  // minha posição — só se a permissão JÁ existe (não pede ao abrir)
  React.useEffect(() => {
    if (!visible) return undefined;
    let alive = true;
    (async () => {
      try {
        if (Platform.OS === 'web') return;
        const Location = require('expo-location');
        const perm = await Location.getForegroundPermissionsAsync();
        if (!alive || perm?.status !== 'granted') return;
        const last = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60 * 1000 });
        if (alive && last?.coords) setMe({ lat: last.coords.latitude, lng: last.coords.longitude });
      } catch {}
    })();
    return () => { alive = false; };
  }, [visible]);
  React.useEffect(() => { if (me) { try { webMapRef.current?.send({ type: 'me', lat: me.lat, lng: me.lng }); } catch {} } }, [me]);

  // endereço legível (re-geocodifica ao vivo se andou > 120 m)
  const geoAtRef = React.useRef(null);
  React.useEffect(() => {
    if (!visible || !Number.isFinite(pos.lat)) return undefined;
    const g = geoAtRef.current;
    if (g && haversine(g.lat, g.lng, pos.lat, pos.lng) < 120) return undefined;
    geoAtRef.current = { lat: pos.lat, lng: pos.lng };
    let alive = true;
    reverseGeocode(pos.lat, pos.lng, language).then((r) => { if (alive && r) setGeo(r); }).catch(() => {});
    return () => { alive = false; };
  }, [visible, pos.lat, pos.lng, language]);

  const avatarUrl = React.useMemo(() => {
    if (!senderEmail) return null;
    try { return require('../services/avatar').buildAvatarUrl(senderEmail, { name: senderName }); } catch { return null; }
  }, [senderEmail, senderName]);
  const personName = isOwn ? tr('common.you', 'Você') : (senderName || (senderEmail ? String(senderEmail).split('@')[0] : ''));

  const markers = React.useMemo(() => {
    const list = [];
    if (me && !(isOwn && isStillLive)) list.push({ id: 'me', latitude: me.lat, longitude: me.lng, kind: 'dot', color: '#0A84FF' });
    if (isStillLive) {
      list.push({ id: 'target', latitude: pos.lat, longitude: pos.lng, kind: 'avatar', imageUrl: avatarUrl || undefined, initials: initialsOf(senderName || senderEmail || '?'), color: isDark ? '#FFFFFF' : '#111111', pulse: true, highlight: true });
    } else {
      list.push({ id: 'target', latitude: pos.lat, longitude: pos.lng, kind: 'pin', color: '#111111' });
    }
    return list;
  }, [me, pos.lat, pos.lng, isStillLive, avatarUrl, senderName, senderEmail, isDark, isOwn]);

  const webHtml = React.useMemo(() => ((native || !styleReady) ? null : webMapHtml({
    lat: numLat, lng: numLng, styleUrl, dark: isDark, live: isStillLive,
    avatarUrl: isStillLive ? avatarUrl : null, initials: initialsOf(senderName || senderEmail || '?'),
  // pos muda via postMessage — não recria o WebView
  // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [native, styleReady, styleUrl, numLat, numLng, isDark, isStillLive, avatarUrl]);

  const webOpts = React.useMemo(() => ((Platform.OS !== 'web' || !styleReady) ? null : {
    lat: numLat, lng: numLng, styleUrl, dark: isDark, live: isStillLive,
    avatarUrl: isStillLive ? avatarUrl : null, initials: initialsOf(senderName || senderEmail || '?'),
  }), [styleReady, styleUrl, numLat, numLng, isDark, isStillLive, avatarUrl, senderName, senderEmail]);

  const recenter = () => {
    setFollowing(true);
    seqRef.current += 1;
    setCamera({ latitude: pos.lat, longitude: pos.lng, zoom: 16, animated: true, seq: seqRef.current });
    try { webMapRef.current?.send({ type: 'center', lat: pos.lat, lng: pos.lng, zoom: 16 }); } catch {}
  };

  const fitMe = async () => {
    let mine = me;
    try {
      if (Platform.OS === 'web') {
        mine = await new Promise((res) => {
          try { navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res(null), { timeout: 8000 }); } catch { res(null); }
        });
      } else {
        const Location = require('expo-location');
        const perm = await Location.requestForegroundPermissionsAsync();
        if (perm?.status === 'granted') {
          const fresh = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          if (fresh?.coords) mine = { lat: fresh.coords.latitude, lng: fresh.coords.longitude };
        }
      }
    } catch {}
    if (!mine) return;
    setMe(mine);
    setFollowing(false);
    seqRef.current += 1;
    setCamera({
      latitude: pos.lat, longitude: pos.lng, zoom: 15, animated: true, seq: seqRef.current,
      minLatitude: Math.min(mine.lat, pos.lat), minLongitude: Math.min(mine.lng, pos.lng),
      maxLatitude: Math.max(mine.lat, pos.lat), maxLongitude: Math.max(mine.lng, pos.lng),
      padding: 90, maxZoom: 16,
    });
    try { webMapRef.current?.send({ type: 'me', lat: mine.lat, lng: mine.lng }); webMapRef.current?.send({ type: 'fit', a: [mine.lat, mine.lng], b: [pos.lat, pos.lng] }); } catch {}
  };

  // título/linhas do cartão
  const placeName = (!looksLikeCoords(safeLabel) && safeLabel) || geo?.name || geo?.line?.split(' · ')[0] || tr('chatConv.location', 'Localização');
  const title = isLive ? (personName || tr('chatConv.liveLocation', 'Localização ao vivo')) : placeName;
  const addressLine = (() => {
    const l = geo?.line || '';
    if (isLive) return l || (looksLikeCoords(safeLabel) ? '' : safeLabel);
    if (!l) return '';
    return l === placeName ? [geo?.city, geo?.country].filter(Boolean).join(', ') : l;
  })();
  const remaining = isStillLive && !effUnlimited && liveUntil ? Number(liveUntil) - nowSec : 0;
  const distanceM = me && !(isOwn && isLive) ? haversine(me.lat, me.lng, pos.lat, pos.lng) : NaN;
  const distanceTxt = Number.isFinite(distanceM) && distanceM >= 15 ? tr('maps.awayFrom', 'a {d} de você', { d: fmtDistance(distanceM, language) }) : '';

  const fg = isDark ? '#FFFFFF' : '#111111';
  const sub = isDark ? 'rgba(235,235,245,0.62)' : 'rgba(60,60,67,0.66)';
  const hair = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
  const sheetBg = isDark ? '#1C1C1E' : '#FFFFFF';
  const primaryBg = isDark ? '#FFFFFF' : '#111111';
  const primaryFg = isDark ? '#111111' : '#FFFFFF';
  const secondaryBg = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)';

  const toggle = React.useCallback((v) => {
    try { LayoutAnimation.configureNext(LayoutAnimation.create(220, 'easeInEaseOut', 'opacity')); } catch {}
    setExpanded((e) => (typeof v === 'boolean' ? v : !e));
  }, []);
  const pan = React.useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 8 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderRelease: (_e, g) => {
      if (g.dy < -24) toggle(true);
      else if (g.dy > 24) toggle(false);
    },
  }), [toggle]);

  const openApp = async (app) => {
    const la = pos.lat; const lo = pos.lng;
    const name = encodeURIComponent((isLive ? personName : placeName) || `${la},${lo}`);
    const tryOpen = async (urls) => {
      for (const u of urls) {
        try {
          if (Platform.OS === 'web') { window.open(u, '_blank', 'noopener'); return; }
          await Linking.openURL(u); return;
        } catch {}
      }
    };
    if (app === 'apple') return tryOpen([`http://maps.apple.com/?daddr=${la},${lo}&q=${name}`]);
    if (app === 'google') {
      return tryOpen(Platform.OS === 'ios'
        ? [`comgooglemaps://?daddr=${la},${lo}&directionsmode=driving`, `https://www.google.com/maps/dir/?api=1&destination=${la},${lo}`]
        : [`https://www.google.com/maps/dir/?api=1&destination=${la},${lo}`]);
    }
    if (app === 'waze') return tryOpen([`waze://?ll=${la},${lo}&navigate=yes`, `https://waze.com/ul?ll=${la},${lo}&navigate=yes`]);
    if (app === 'osm') return tryOpen([`https://www.openstreetmap.org/directions?to=${la},${lo}#map=16/${la}/${lo}`]);
    try { return require('../services/openLink').openInMaps(la, lo, isLive ? personName : placeName, { directions: true }); } catch { return undefined; }
  };

  const doShare = async () => {
    const la = pos.lat.toFixed(6); const lo = pos.lng.toFixed(6);
    const link = `https://maps.google.com/?q=${la},${lo}`;
    const text = [isLive ? personName : placeName, addressLine, link].filter(Boolean).join('\n');
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.share) { await navigator.share({ text }); return; }
      await Share.share(Platform.OS === 'ios' ? { message: text } : { message: text, title: placeName });
    } catch {}
  };

  const copyCoords = async () => {
    const s = `${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)}`;
    try {
      if (Platform.OS === 'web') await navigator.clipboard.writeText(s);
      else await require('expo-clipboard').setStringAsync(s);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  };

  if (!visible || !Number.isFinite(numLat) || !Number.isFinite(numLng)) return null;

  const statusLine = isStillLive
    ? (effUnlimited
      ? `${tr('chatConv.liveBadge', 'AO VIVO')} · ∞ ${tr('snapmap.alwaysOn', 'sempre ativo')}`
      : `${tr('chatConv.liveBadge', 'AO VIVO')} · ${tr('chatConv.liveEndsIn', 'Encerra em')} ${fmtRemaining(remaining)}`)
    : (isLive ? tr('chatConv.liveLocationEnded', 'Localização ao vivo encerrada') : '');

  const appRows = [
    Platform.OS === 'ios' ? ['apple', 'Apple Maps'] : null,
    ['google', 'Google Maps'],
    ['waze', 'Waze'],
    Platform.OS === 'android' ? ['system', tr('maps.otherApps', 'Outro app de mapas')] : null,
    Platform.OS === 'web' ? ['osm', 'OpenStreetMap'] : null,
  ].filter(Boolean);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent presentationStyle="fullScreen">
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <View style={{ flex: 1, backgroundColor: isDark ? '#1c1c1e' : '#e9e9ec' }}>
        <View style={StyleSheet.absoluteFill}>
          {native ? (
            <ChatyyMap
              style={{ flex: 1 }}
              dark={isDark}
              styleUrl={styleUrl}
              camera={camera}
              markers={markers}
              rotateEnabled={false}
              showsPOI
              appearance="muted"
              onRegionWillChange={(e) => { if (e?.gesture) setFollowing(false); }}
            />
          ) : !webHtml ? null : (
            <WebMap ref={webMapRef} html={webHtml} isDark={isDark} webOpts={webOpts} onEvent={(ev) => { if (ev?.type === 'drag') setFollowing(false); }} />
          )}
        </View>

        {/* topo: fechar + selo AO VIVO + compartilhar (vidro, sem barra colorida) */}
        <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + 8, left: 14, right: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <RoundGlassButton isDark={isDark} onPress={onClose} label={tr('common.close', 'Fechar')}>
            <IconChevronDown size={22} color={fg} />
          </RoundGlassButton>
          {isStillLive ? (
            <Glass isDark={isDark} radius={18} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, height: 36 }}>
              <PulseDot color={fg} size={8} />
              <Text style={{ color: fg, fontSize: 13, fontWeight: '800', letterSpacing: 0.6 }}>{tr('chatConv.liveBadge', 'AO VIVO')}</Text>
              {!effUnlimited && remaining > 0 ? <Text style={{ color: sub, fontSize: 13, fontWeight: '600' }}>{fmtRemaining(remaining)}</Text> : null}
            </Glass>
          ) : <View />}
          <RoundGlassButton isDark={isDark} onPress={doShare} label={tr('common.share', 'Compartilhar')}>
            <IconShare size={19} color={fg} />
          </RoundGlassButton>
        </View>

        {/* cartão inferior arrastável + botões do mapa */}
        <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
          <View pointerEvents="box-none" style={{ alignItems: 'flex-end', paddingHorizontal: 14, marginBottom: 12, gap: 10 }}>
            {!following ? (
              <RoundGlassButton isDark={isDark} onPress={recenter} label={tr('maps.recenter', 'Centralizar')}>
                <IconNavigation size={19} color={fg} />
              </RoundGlassButton>
            ) : null}
            {Platform.OS !== 'web' || (typeof navigator !== 'undefined' && navigator.geolocation) ? (
              <RoundGlassButton isDark={isDark} onPress={fitMe} label={tr('maps.myLocation', 'Minha localização')}>
                <IconLocate size={20} color={fg} />
              </RoundGlassButton>
            ) : null}
          </View>

          <View
            {...pan.panHandlers}
            style={{
              backgroundColor: sheetBg, borderTopLeftRadius: 26, borderTopRightRadius: 26,
              paddingHorizontal: 18, paddingTop: 8, paddingBottom: insets.bottom + 10,
              shadowColor: '#000', shadowOpacity: 0.16, shadowRadius: 18, shadowOffset: { width: 0, height: -4 }, elevation: 16,
            }}
          >
            <TouchableOpacity onPress={() => toggle()} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={tr('chatConv.openMaps', 'Abrir no mapa')}
              style={{ alignSelf: 'center', paddingVertical: 6, paddingHorizontal: 30, marginBottom: 6 }}>
              <View style={{ width: 38, height: 5, borderRadius: 3, backgroundColor: isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.18)' }} />
            </TouchableOpacity>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              {isLive ? (
                <AvatarBadge uri={avatarUrl} name={senderName || senderEmail} size={46} live={isStillLive} isDark={isDark} />
              ) : (
                <View style={{ width: 50, height: 50, borderRadius: 25, backgroundColor: primaryBg, alignItems: 'center', justifyContent: 'center' }}>
                  <IconMapPin size={24} color={primaryFg} />
                </View>
              )}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: fg, fontSize: 20, fontWeight: '700', letterSpacing: -0.3 }} numberOfLines={2}>{title}</Text>
                {statusLine ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
                    {isStillLive ? <PulseDot color={fg} size={7} /> : null}
                    <Text style={{ color: isStillLive ? fg : sub, fontSize: 13, fontWeight: isStillLive ? '700' : '500', letterSpacing: isStillLive ? 0.2 : 0 }} numberOfLines={1}>{statusLine}</Text>
                  </View>
                ) : null}
              </View>
            </View>

            {addressLine ? (
              <Text style={{ color: sub, fontSize: 15, lineHeight: 20, marginTop: 12 }} numberOfLines={expanded ? 3 : 2}>{addressLine}</Text>
            ) : null}
            {(distanceTxt || (isStillLive && lastTs)) ? (
              <Text style={{ color: sub, fontSize: 13, marginTop: 4 }} numberOfLines={1}>
                {distanceTxt}
                {isStillLive && lastTs ? (
                  <Ago ts={lastTs} render={(s) => `${distanceTxt ? ' · ' : ''}${s < 10 ? tr('maps.updatedNow', 'Atualizado agora') : tr('maps.updatedAgo', 'Atualizado há {t}', { t: fmtAgo(s) })}`} />
                ) : null}
              </Text>
            ) : null}

            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <TouchableOpacity onPress={() => toggle(!expanded)} activeOpacity={0.8} accessibilityRole="button"
                style={{ flex: 1, height: 50, borderRadius: 14, backgroundColor: primaryBg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                <IconNavigation size={17} color={primaryFg} />
                <Text style={{ color: primaryFg, fontSize: 16, fontWeight: '700' }}>{tr('maps.directions', 'Como chegar')}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={doShare} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel={tr('common.share', 'Compartilhar')}
                style={{ flex: 1, height: 50, borderRadius: 14, backgroundColor: secondaryBg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                <IconShare size={17} color={fg} />
                <Text style={{ color: fg, fontSize: 16, fontWeight: '600' }}>{tr('common.share', 'Compartilhar')}</Text>
              </TouchableOpacity>
            </View>

            {expanded ? (
              <View style={{ marginTop: 14, borderRadius: 14, backgroundColor: secondaryBg, overflow: 'hidden' }}>
                <Text style={{ color: sub, fontSize: 12, fontWeight: '600', letterSpacing: 0.4, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 4, textTransform: 'uppercase' }}>{tr('maps.openIn', 'Abrir em')}</Text>
                {appRows.map(([id, name]) => (
                  <TouchableOpacity key={id} onPress={() => openApp(id)} activeOpacity={0.7} accessibilityRole="button"
                    style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, height: 46, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: hair }}>
                    <Text style={{ flex: 1, color: fg, fontSize: 16 }}>{name}</Text>
                    <IconChevronRight size={16} color={sub} />
                  </TouchableOpacity>
                ))}
                <TouchableOpacity onPress={copyCoords} activeOpacity={0.7} accessibilityRole="button"
                  style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, height: 52, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: hair, gap: 10 }}>
                  <IconCopy size={17} color={fg} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: fg, fontSize: 16 }}>{copied ? tr('common.copied', 'Copiado') : tr('maps.copyCoords', 'Copiar coordenadas')}</Text>
                    <Text style={{ color: sub, fontSize: 12, marginTop: 1, fontVariant: ['tabular-nums'] }}>{pos.lat.toFixed(5)}, {pos.lng.toFixed(5)}</Text>
                  </View>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}
