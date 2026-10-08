// LocationPickerSheet — WhatsApp-style bottom sheet for sharing GPS.
//
// Why this exists
// ---------------
// User reported that the old flow (tap → fetchGPS → send) was a black box:
// if GPS took 12s+ they saw nothing, and the only feedback on failure was a
// generic "Não foi possível obter a localização" alert AFTER the timeout.
//
// WhatsApp's pattern is to open a sheet FIRST: user sees a spinner while
// GPS resolves, then a small preview map + the address, with one explicit
// "Enviar localização atual" CTA. That's what we mirror here.
//
// Visual redesign (2026-10-05)
// ----------------------------
// Presentation-only refresh to match the parallel chat-sheet redesign:
// rounded-top sheet with grab handle, a tinted WhatsApp-green pin badge in the
// header, a close "X" in a soft circle, a premium map-preview card with a
// stylized center pin (halo + shadow), a full-width green CTA, and the live
// chips as a clean 2×2 grid. NONE of the GPS/send/live/API logic changed.
//
// Map preview (the "gray box" fix)
// --------------------------------
// We don't have `react-native-maps` (native rebuild) so the preview uses our
// self-hosted BoraUm tileserver (OpenStreetMap, MapLibre GL JS) inside a
// WebView — see components/BoraMap.js. The OLD preview rendered as a gray box
// with a lone red dot: the simple boraMapHtml never called `map.resize()`, so
// inside a sliding <Modal> the WebView was laid out AFTER MapLibre grabbed a
// 0×0 drawing buffer → the canvas painted nothing (gray), while the marker DOM
// still positioned (the red dot). This is the exact WKWebView race snap-map.js
// already works around. Our `mapPreviewHtml` below mirrors snap-map's fix:
// deferred `map.resize()` calls + a style-reload watchdog, and it posts
// ready/error back so we can fall through to a gorgeous gradient placeholder
// (never a flat gray box) when tiles can't paint. The centered pin is drawn in
// RN as an overlay (the preview is non-interactive and centered on the coords),
// so it looks identical whether the real map paints or the placeholder shows.
//
// Props
// -----
//   visible    boolean
//   onClose    () => void
//   onSend     ({ latitude, longitude, address }) => void
//   colors     ThemeContext colors
//   t          i18n t() function

import React, { useEffect, useState, useRef } from 'react';
import {
  View, Text, TouchableOpacity, Modal, Pressable, ActivityIndicator,
  Platform, KeyboardAvoidingView, TextInput,
} from 'react-native';
import { WebView } from 'react-native-webview';
import Svg, { Defs, RadialGradient, LinearGradient, Stop, Rect, Circle, Path, Ellipse, G } from 'react-native-svg';
import { IconMapPin, IconX, IconClock, IconNavigation } from './Icons';
import * as api from '../services/api';
import { boraStyleUrl } from './BoraMap';
// [2026-10-07 native-maps] native map (iOS MapKit / Android MapLibre Native) when
// the binary ships ChatyyMapView; otherwise the WebView preview below is used.
import { ChatyyMap, isNativeMapAvailable, nativeMapStyleUrl } from './NativeMap';
import { MapFab, MapSearchBar, IconLocate } from './MapControls';

// [2026-10-08 chat-fix-composer-location] P&B premium. O verde WhatsApp
// (#25D366 no badge, CTA, chips e pin) saiu: o sheet agora usa a tinta do app
// — colors.primary/onPrimary (preto no claro, branco no escuro neutro). A cor
// é resolvida por render via `inkOf(colors)`; nenhum acento colorido sobra
// além do vermelho de "parar ao vivo" e do âmbar de "aproximada".
const inkOf = (colors, isDark) => (colors?.primary || (isDark ? '#F5F5F7' : '#111111'));
const onInkOf = (colors, isDark) => (colors?.onPrimary || (isDark ? '#000000' : '#ffffff'));

// Alpha helper so we can tint the accent without hardcoding every rgba.
const tint = (hex, a) => {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

// Robust dark-mode detection: ThemeContext may not always expose `isDark`, so
// fall back to sniffing the (near-black) background hex — same heuristic the
// old dup-session card used.
const themeIsDark = (colors) =>
  !!colors?.isDark || (colors?.background && /^#0|^#1|^#2/.test(String(colors.background)));

// Non-interactive MapLibre preview HTML with the WKWebView resize fix. Marker
// is intentionally NOT drawn here — RN overlays a styled pin at dead center.
function mapPreviewHtml({ lat, lng, isDark }) {
  const la = Number(lat) || 0;
  const lo = Number(lng) || 0;
  // Dark mode gets the purpose-built dark style (same one snap-map uses); light
  // mode uses the per-country coverage style picker.
  const styleUrl = isDark
    ? 'https://boraum.com.br/maptiles/styles/boraum-mapa-escuro/style.json'
    : boraStyleUrl(lo, la);
  const styleJson = JSON.stringify(styleUrl);
  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<link href="https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.css" rel="stylesheet"/>
<script src="https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.js"></script>
<style>html,body{margin:0;padding:0;width:100%;height:100%;background:transparent}
#map{position:absolute;inset:0;opacity:0;transition:opacity .35s ease}</style>
</head><body>
<div id="map"></div>
<script>
  function post(o){try{if(window.ReactNativeWebView&&window.ReactNativeWebView.postMessage){window.ReactNativeWebView.postMessage(JSON.stringify(o));}}catch(_){}}
  if(typeof maplibregl==='undefined'){ post({type:'map_error',stage:'no_lib'}); }
  else{
    var ready=false;
    var map=new maplibregl.Map({container:'map',style:${styleJson},center:[${lo},${la}],zoom:16,attributionControl:false,interactive:false});
    try{map.scrollZoom.disable();map.dragPan.disable();map.doubleClickZoom.disable();map.touchZoomRotate.disable();map.keyboard.disable();}catch(_){}
    function reveal(){ if(ready)return; ready=true; var el=document.getElementById('map'); if(el)el.style.opacity='1'; post({type:'map_ready'}); }
    map.on('load', function(){ try{map.resize();}catch(_){} });
    map.on('idle', reveal);
    map.on('error', function(e){ var m=(e&&e.error&&(e.error.message||e.error))||'err'; post({type:'map_error',stage:'maplibre',message:String(m)}); });
    // WKWebView lays the WebView out AFTER the map is constructed, so MapLibre
    // grabs a 0×0 drawing buffer and paints gray. Deferred resizes re-measure
    // once the modal slide-in settles — zero-risk no-op if size was correct.
    setTimeout(function(){try{map.resize();}catch(_){}},350);
    setTimeout(function(){try{map.resize();}catch(_){}},1200);
    setTimeout(function(){try{map.resize();}catch(_){}},2500);
    // Watchdog: if tiles never reach 'idle', reload the style a couple of times
    // (flaky CDN/tiles) before giving up so the RN host can show the placeholder.
    var tries=0;
    function wd(){ if(ready)return; tries++; if(tries<=2){ try{map.setStyle(${styleJson});}catch(_){} setTimeout(function(){try{map.resize();}catch(_){}},300); setTimeout(wd,6000);} else { post({type:'map_error',stage:'timeout'}); } }
    setTimeout(wd,7000);
  }
</script>
</body></html>`;
}

// Premium gradient placeholder shown behind the live map (during load) and in
// place of it if tiles can't paint — a soft themed gradient with faint "street"
// hints, NOT a flat gray box.
function MapCanvasBackdrop({ isDark }) {
  const c = isDark
    ? { c0: '#1c1c1e', c1: '#111113', street: 'rgba(255,255,255,0.05)', block: 'rgba(255,255,255,0.035)', green: 'rgba(255,255,255,0.04)' }
    : { c0: '#f4f4f5', c1: '#e7e7ea', street: 'rgba(255,255,255,0.8)', block: 'rgba(17,17,17,0.035)', green: 'rgba(17,17,17,0.04)' };
  return (
    <Svg width="100%" height="100%" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice">
      <Defs>
        <RadialGradient id="bg" cx="50%" cy="42%" r="75%">
          <Stop offset="0%" stopColor={c.c0} />
          <Stop offset="100%" stopColor={c.c1} />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width="320" height="180" fill="url(#bg)" />
      {/* faint park/block + water tints for map texture */}
      <Rect x="18" y="20" width="78" height="52" rx="10" fill={c.green} />
      <Rect x="222" y="104" width="86" height="62" rx="10" fill={c.block} />
      <Rect x="18" y="120" width="60" height="44" rx="10" fill={c.block} />
      {/* faint streets */}
      <G stroke={c.street} strokeWidth="6" strokeLinecap="round" fill="none">
        <Path d="M-10 60 H 330" />
        <Path d="M-10 128 H 330" />
        <Path d="M120 -10 V 190" />
        <Path d="M232 -10 V 190" />
        <Path d="M-10 160 L 120 128 L 232 160" strokeWidth="4" />
      </G>
    </Svg>
  );
}

// Stylized center pin overlay (halo + head + white dot + ground shadow).
// Rendered on top of the map/placeholder, perfectly centered on the coords.
// [2026-10-08 chat-fix-composer-location] pin monocromático: preto com aro
// branco (sobre o mapa claro e o escuro — contraste garantido nos dois).
function CenterPin({ pulse, isDark }) {
  // No escuro o mapa é escuro → pin BRANCO com aro preto; no claro, o inverso.
  const ink = isDark ? '#F5F5F7' : '#111111';
  const rim = isDark ? '#111111' : '#ffffff';
  return (
    <Svg width={74} height={82} viewBox="0 0 74 82">
      {/* ground shadow */}
      <Ellipse cx="37" cy="70" rx="12" ry="3.5" fill="rgba(0,0,0,0.25)" />
      {/* soft halo */}
      <Circle cx="37" cy="31" r={pulse ? 30 : 26} fill={isDark ? 'rgba(255,255,255,0.08)' : 'rgba(17,17,17,0.08)'} />
      <Circle cx="37" cy="31" r="20" fill={isDark ? 'rgba(255,255,255,0.10)' : 'rgba(17,17,17,0.10)'} />
      {/* pin head (teardrop) with white rim */}
      <Path
        d="M37 67 C 27 51 21 42 21 31 A 16 16 0 1 1 53 31 C 53 42 47 51 37 67 Z"
        fill={ink}
        stroke={rim}
        strokeWidth="2.5"
      />
      {/* inner dot */}
      <Circle cx="37" cy="31" r="6" fill={rim} />
    </Svg>
  );
}

// Infinity glyph (SVG — nunca emoji/texto "∞") p/ a opção "Sempre".
function IconInfinity({ size = 20, color = '#111', strokeWidth = 2 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4Zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4Z" />
    </Svg>
  );
}

function IconChevronRightSm({ size = 16, color = '#999' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M9 6l6 6-6 6" />
    </Svg>
  );
}

// The full map-preview card: real MapLibre WebView with a graceful premium
// placeholder fallback + centered styled pin + optional accuracy chip.
function MapPreviewCard({ lat, lng, accuracy, height, radius = 18, colors, isDark, t }) {
  const [failed, setFailed] = useState(false);
  // [2026-10-07 native-maps] lite native snapshot (no WebView) when available.
  const nativeMap = isNativeMapAvailable();
  const liteCamera = React.useMemo(() => ({ latitude: lat, longitude: lng, zoom: 16, seq: 1 }), [lat, lng]);
  const onMsg = (ev) => {
    try {
      const d = JSON.parse(ev?.nativeEvent?.data || '{}');
      if (d.type === 'map_error') setFailed(true);
      else if (d.type === 'map_ready') setFailed(false);
    } catch { /* ignore */ }
  };
  return (
    <View style={{
      height, borderRadius: radius, overflow: 'hidden', marginBottom: 16,
      borderWidth: 1, borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(17,27,33,0.06)',
      backgroundColor: isDark ? '#1c1c1e' : '#f4f4f5',
    }}>
      {/* premium gradient backdrop — always behind the map */}
      <View style={{ position: 'absolute', inset: 0 }}>
        <MapCanvasBackdrop isDark={isDark} />
      </View>

      {/* [2026-10-07 native-maps] native lite snapshot */}
      {nativeMap && !failed && (
        <ChatyyMap
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          lite
          interactive={false}
          dark={isDark}
          styleUrl={nativeMapStyleUrl(lat, lng, isDark)}
          camera={liteCamera}
          onMapError={() => setFailed(true)}
        />
      )}

      {/* real map — fades itself in once tiles paint; stays hidden on failure */}
      {!nativeMap && !failed && (
        <WebView
          key={`${lat.toFixed(5)},${lng.toFixed(5)},${isDark ? 'd' : 'l'}`}
          source={{ html: mapPreviewHtml({ lat, lng, isDark }), baseUrl: 'https://boraum.com.br/' }}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'transparent' }}
          originWhitelist={['*']}
          scrollEnabled={false}
          pointerEvents="none"
          androidLayerType="hardware"
          mixedContentMode="always"
          javaScriptEnabled
          domStorageEnabled
          onMessage={onMsg}
        />
      )}

      {/* subtle top sheen for depth */}
      <Svg width="100%" height="40" style={{ position: 'absolute', top: 0, left: 0 }} viewBox="0 0 100 40" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor="rgba(0,0,0,0.12)" />
            <Stop offset="100%" stopColor="rgba(0,0,0,0)" />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100" height="40" fill="url(#sheen)" />
      </Svg>

      {/* centered styled pin */}
      <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }} pointerEvents="none">
        {/* nudge up so the pin TIP sits on the center point */}
        <View style={{ marginTop: -22 }}>
          <CenterPin isDark={isDark} />
        </View>
      </View>

      {/* accuracy chip */}
      {accuracy ? (
        <View style={{
          position: 'absolute', left: 10, bottom: 10,
          flexDirection: 'row', alignItems: 'center', gap: 5,
          backgroundColor: isDark ? 'rgba(13,22,27,0.82)' : 'rgba(255,255,255,0.92)',
          borderRadius: 11, paddingHorizontal: 9, paddingVertical: 5,
          borderWidth: 1, borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(17,27,33,0.06)',
        }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.text }} />
          <Text style={{ fontSize: 11, fontWeight: '700', color: colors.text }}>
            ±{Math.round(accuracy)}m
          </Text>
        </View>
      ) : null}
    </View>
  );
}

// [2026-10-07 native-maps] Interactive picker map (native binaries only):
// pan the map under a fixed center pin (lifts while dragging), "my location"
// FAB, and an OSM place search whose result gets its own labeled pin. Reports
// the map center through onPick({ latitude, longitude, isGps }).
function NativePickerMap({ gps, height, colors, isDark, t, onPick }) {
  const [camera, setCamera] = useState(() => ({ latitude: gps.latitude, longitude: gps.longitude, zoom: 16, seq: 1 }));
  const [dragging, setDragging] = useState(false);
  const [searchPin, setSearchPin] = useState(null);
  const seqRef = useRef(1);
  const userMovedRef = useRef(false);
  const lastGpsRef = useRef(gps);

  // A refined GPS fix re-centers only while the user hasn't moved the map.
  useEffect(() => {
    const prev = lastGpsRef.current;
    lastGpsRef.current = gps;
    if (userMovedRef.current) return;
    if (prev && prev.latitude === gps.latitude && prev.longitude === gps.longitude) return;
    seqRef.current += 1;
    setCamera({ latitude: gps.latitude, longitude: gps.longitude, zoom: 16, animated: true, seq: seqRef.current });
  }, [gps.latitude, gps.longitude]); // eslint-disable-line react-hooks/exhaustive-deps

  const goTo = (lat, lng, zoom = 16) => {
    seqRef.current += 1;
    setCamera({ latitude: lat, longitude: lng, zoom, animated: true, seq: seqRef.current });
  };

  const markers = React.useMemo(() => {
    const list = [{ id: 'me', latitude: gps.latitude, longitude: gps.longitude, kind: 'dot', color: '#3B82F6' }];
    if (searchPin) list.push({ id: 'search', latitude: searchPin.latitude, longitude: searchPin.longitude, kind: 'search', color: isDark ? '#F5F5F7' : '#111111', label: searchPin.title });
    return list;
  }, [gps.latitude, gps.longitude, searchPin, isDark]);

  const onRegionDidChange = React.useCallback((r) => {
    setDragging(false);
    const la = Number(r?.latitude);
    const lo = Number(r?.longitude);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return;
    if (r?.gesture) userMovedRef.current = true;
    const g = lastGpsRef.current;
    // ~8m tolerance → still "my current location"
    const isGps = !!g && Math.abs(la - g.latitude) < 0.00008 && Math.abs(lo - g.longitude) < 0.00008;
    onPick?.({ latitude: la, longitude: lo, isGps });
  }, [onPick]);

  return (
    <View style={{
      height, borderRadius: 18, overflow: 'hidden', marginBottom: 14,
      borderWidth: 1, borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(17,27,33,0.06)',
      backgroundColor: isDark ? '#1c1c1e' : '#f4f4f5',
    }}>
      <ChatyyMap
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        dark={isDark}
        styleUrl={nativeMapStyleUrl(gps.latitude, gps.longitude, isDark)}
        camera={camera}
        markers={markers}
        onRegionWillChange={(e) => { if (e?.gesture) setDragging(true); }}
        onRegionDidChange={onRegionDidChange}
        onMarkerPress={(e) => { if (e?.id === 'search' && searchPin) goTo(searchPin.latitude, searchPin.longitude, 17); }}
      />

      {/* fixed center pin — tip on the exact map center; lifts while dragging */}
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }} pointerEvents="none">
        <View style={{ marginTop: -22, transform: [{ translateY: dragging ? -10 : 0 }] }}>
          <CenterPin pulse={dragging} isDark={isDark} />
        </View>
      </View>

      <MapSearchBar
        style={{ position: 'absolute', top: 10, left: 10, right: 10 }}
        isDark={isDark}
        colors={colors}
        t={t}
        onSelect={(p) => {
          setSearchPin(p);
          userMovedRef.current = true;
          goTo(p.latitude, p.longitude, 17);
        }}
        onClear={() => setSearchPin(null)}
      />

      <View pointerEvents="box-none" style={{ position: 'absolute', right: 10, bottom: 10 }}>
        <MapFab
          isDark={isDark}
          size={42}
          onPress={() => { userMovedRef.current = false; goTo(lastGpsRef.current.latitude, lastGpsRef.current.longitude, 16); }}
          accessibilityLabel={t?.('maps.myLocation') || 'Minha localização'}
        >
          <IconLocate size={19} color={isDark ? '#fff' : '#111'} />
        </MapFab>
      </View>
    </View>
  );
}

const LIVE_DURATIONS = [
  { key: '15m', label: '15 min', seconds: 15 * 60 },
  { key: '1h',  label: '1 hora', seconds: 60 * 60 },
  { key: '8h',  label: '8 horas', seconds: 8 * 60 * 60 },
  // Snap-Map style "always on" — broadcasts until user manually stops.
  // Backend interprets seconds === -1 as unlimited (sentinel ~10y).
  { key: 'inf', label: 'Sempre', seconds: -1 },
];

// Format remaining ms as a human-readable countdown for the dup-session
// guard card. Mirrors WhatsApp's "47min restantes" style: minutes when the
// session has more than 1h left, "Xh Ymin" when shorter, "<1min" near the
// tail. We don't sub-second update — caller re-renders every 1s and we
// recompute. Sentinel `isUnlimited` returns null so the caller can render
// the dedicated "Compartilhamento ilimitado" string instead of a number.
function formatRemaining(activeLive) {
  if (!activeLive) return '';
  if (activeLive.isUnlimited) return null;
  const ms = (activeLive.expiresAt || 0) - Date.now();
  if (ms <= 0) return '';
  const totalMin = Math.ceil(ms / 60000);
  if (totalMin >= 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m > 0 ? `${h}h ${m}min` : `${h}h`;
  }
  return `${Math.max(1, totalMin)}min`;
}

export default function LocationPickerSheet({ visible, onClose, onSend, onLiveStart, activeLive, onStopLive, colors, t }) {
  const [loading, setLoading] = useState(true);
  const [coords, setCoords] = useState(null); // { latitude, longitude, accuracy }
  const [address, setAddress] = useState('');
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  // True while the only fix we have is an aged cached position (no fresh
  // GPS read returned yet AND the cache is older than ~30s). Drives a
  // subtle "localização aproximada" hint so we don't present a stale fix
  // as exact. Cleared the moment a fresh fix lands.
  const [approxOnly, setApproxOnly] = useState(false);
  // WhatsApp-style live-share confirmation: after the user taps a duration
  // chip we DON'T immediately start broadcasting. We swap the sheet body
  // for a confirmation view (map preview + selected duration + privacy
  // note + big primary "Compartilhar ao vivo" CTA). Set back to null to
  // return to the chips. Caption is optional and gets passed to onLiveStart
  // so the parent can include it in the live-location WS payload.
  const [liveConfirm, setLiveConfirm] = useState(null); // { seconds, label }
  const [liveCaption, setLiveCaption] = useState('');
  const cancelRef = useRef(false);
  // [2026-10-07 native-maps] Point chosen by panning / search on the native
  // picker map. null = "my current location" (GPS coords). Live sharing always
  // uses GPS — only the one-shot "send" honours a picked point.
  const [picked, setPicked] = useState(null); // { latitude, longitude }
  const [pickedAddress, setPickedAddress] = useState('');
  const geoSeqRef = useRef(0);
  const geoTimerRef = useRef(null);
  const nativeMap = isNativeMapAvailable();
  // 1s tick to repaint the dup-session guard's countdown. We only spin the
  // interval while the sheet is visible AND a live session is active —
  // otherwise it's a wasted setInterval keeping the JS thread busy.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (!visible || !activeLive || activeLive.isUnlimited) return undefined;
    const id = setInterval(() => setNowTick(n => (n + 1) % 1_000_000), 1000);
    return () => clearInterval(id);
  }, [visible, activeLive]);

  // Reset confirm step + caption when sheet closes/reopens so a previous
  // selection doesn't bleed into the next session.
  useEffect(() => {
    if (!visible) {
      setLiveConfirm(null);
      setLiveCaption('');
      setSending(false);
      setPicked(null);
      setPickedAddress('');
      geoSeqRef.current++;
      if (geoTimerRef.current) { clearTimeout(geoTimerRef.current); geoTimerRef.current = null; }
    }
  }, [visible]);

  // Reverse-geocode the picked point (debounced, last-wins).
  const handlePick = React.useCallback(({ latitude, longitude, isGps }) => {
    if (isGps) {
      geoSeqRef.current++;
      setPicked(null);
      setPickedAddress('');
      return;
    }
    setPicked({ latitude, longitude });
    setPickedAddress('');
    const seq = ++geoSeqRef.current;
    if (geoTimerRef.current) clearTimeout(geoTimerRef.current);
    geoTimerRef.current = setTimeout(async () => {
      try {
        const Location = require('expo-location');
        const places = await Location.reverseGeocodeAsync({ latitude, longitude });
        if (seq !== geoSeqRef.current || !places?.[0]) return;
        const p = places[0];
        const line = [p.street, p.streetNumber].filter(Boolean).join(', ') || p.name || '';
        const sub = [p.district || p.subregion, p.city, p.region].filter(Boolean).join(' · ');
        setPickedAddress([line, sub].filter(Boolean).join(' — '));
      } catch {}
    }, 450);
  }, []);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    cancelRef.current = false;
    setLoading(true);
    setError(null);
    setCoords(null);
    setAddress('');
    setApproxOnly(false);

    (async () => {
      try {
        const Location = require('expo-location');
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (!active || cancelRef.current) return;
        if (status !== 'granted') {
          setError(t?.('chatConv.locationPermission') || 'Permita o acesso à localização nas configurações.');
          setLoading(false);
          return;
        }

        // Track the best coords we've obtained in this run via local var
        // (not React state) so the stale-closure problem doesn't fire a
        // false "não foi possível obter localização" when the cache hit
        // worked but the fresh fix failed. The `coords` state still drives
        // the UI; this is purely for control-flow decisions in this effect.
        let bestCoords = null;

        // 1) Try cached last-known position first — instant. Tightened
        //    maxAge from 60s to 10s so a long-stale fix isn't shown as
        //    "current". We still accept an older cache as a preview seed
        //    (so the user sees *something* immediately), but if that fix
        //    is older than ~30s we flag it `approxOnly` and surface a
        //    subtle "localização aproximada" hint rather than presenting
        //    it as exact. A fresh GPS read below clears the flag.
        try {
          const cached = await Location.getLastKnownPositionAsync({ maxAge: 10000, requiredAccuracy: 200 });
          if (!active || cancelRef.current) return;
          if (cached?.coords) {
            bestCoords = cached.coords;
            setCoords(cached.coords);
            const cachedTs = cached.timestamp || 0;
            const cacheAge = cachedTs ? (Date.now() - cachedTs) : 0;
            // Only mark approximate if the cache is meaningfully old (>30s).
            if (cacheAge > 30000) setApproxOnly(true);
            // We still attempt a fresh read below for accuracy, but the user
            // already sees a preview.
          }
        } catch {}

        // 2) Fresh fix with timeout (Balanced ~5s typical).
        const withTimeout = (p, ms) => Promise.race([
          p,
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
        ]);
        let fresh = null;
        try {
          fresh = await withTimeout(
            Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
            10000,
          );
        } catch {
          try {
            fresh = await withTimeout(
              Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
              12000,
            );
          } catch {}
        }
        if (!active || cancelRef.current) return;
        if (fresh?.coords) {
          bestCoords = fresh.coords;
          setCoords(fresh.coords);
          setApproxOnly(false); // fresh fix supersedes the aged cache
        } else if (!bestCoords) {
          // Both fresh attempts failed AND we have no cache either.
          setError(t?.('chatConv.locationUnavailable') || 'Não foi possível obter sua localização. Verifique se o GPS está ligado.');
          setLoading(false);
          return;
        }

        // 3) Best-effort reverse geocode (don't block on it).
        const target = fresh?.coords || bestCoords;
        if (target) {
          try {
            const places = await Location.reverseGeocodeAsync({
              latitude: target.latitude,
              longitude: target.longitude,
            });
            if (active && !cancelRef.current && places?.[0]) {
              const p = places[0];
              const line = [p.street, p.streetNumber].filter(Boolean).join(', ');
              const sub = [p.district || p.subregion, p.city, p.region].filter(Boolean).join(' · ');
              setAddress([line, sub].filter(Boolean).join(' — '));
            }
          } catch {}
        }

        setLoading(false);
      } catch (e) {
        if (!active || cancelRef.current) return;
        setError(String(e?.message || e));
        setLoading(false);
      }
    })();

    return () => { active = false; cancelRef.current = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const handleSend = () => {
    if (!coords || sending) return;
    setSending(true);
    if (picked) {
      onSend?.({
        latitude: picked.latitude,
        longitude: picked.longitude,
        address: pickedAddress || '',
      });
      return;
    }
    onSend?.({
      latitude: coords.latitude,
      longitude: coords.longitude,
      address: address || '',
    });
    // Parent closes the sheet; we keep `sending` true to lock the button.
  };

  const isDark = themeIsDark(colors);
  const gutter = 20;
  // [2026-10-08 chat-fix-composer-location] tokens P&B do sheet.
  const ink = inkOf(colors, isDark);
  const onInk = onInkOf(colors, isDark);
  const hairline = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(17,17,17,0.08)';
  const groupBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(17,17,17,0.035)';
  const tileBg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(17,17,17,0.05)';
  const liveSubtitle = (d) => (d.seconds === -1
    ? (t?.('chatConv.liveRowUnlimited') || 'Até você parar')
    : null);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' }}
      >
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View style={{
          backgroundColor: colors.surface,
          borderTopLeftRadius: 24, borderTopRightRadius: 24,
          paddingHorizontal: gutter, paddingTop: 10,
          paddingBottom: 28 + (Platform.OS === 'ios' ? 12 : 0),
        }}>
          {/* Grab handle */}
          <View style={{ alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(17,27,33,0.14)', marginBottom: 18 }} />

          {/* Header: tinted pin badge + big title + soft close */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 18 }}>
            <View style={{
              width: 40, height: 40, borderRadius: 12,
              backgroundColor: tileBg,
              alignItems: 'center', justifyContent: 'center', marginRight: 12,
            }}>
              <IconMapPin size={21} color={colors.text} />
            </View>
            <Text style={{ flex: 1, fontSize: 20, fontWeight: '700', color: colors.text, letterSpacing: -0.4 }} numberOfLines={1}>
              {t?.('chatConv.locationShare') || 'Compartilhar localização'}
            </Text>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
              style={{
                width: 34, height: 34, borderRadius: 17,
                backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(17,27,33,0.05)',
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              <IconX size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Dup-session guard — WhatsApp parity. When `activeLive` is set
              the caller already has a running live broadcast in this chat,
              so we render a red-tinted card with countdown + "Parar"
              instead of letting the user start a 2nd session. The static
              "Enviar localização atual" CTA below remains tappable — it's
              an orthogonal one-shot pin, not the continuous broadcast.
              The live-duration chips section further down is hidden via
              the `!activeLive` gate. */}
          {activeLive && (() => {
            const remaining = formatRemaining(activeLive);
            const subtitle = activeLive.isUnlimited
              ? (t?.('chatConv.liveUnlimited') || 'Compartilhamento ilimitado')
              : (remaining
                  ? (t?.('chatConv.liveTimeLeft', { mins: remaining }) || `${remaining} restantes`)
                  : '');
            // Theme-aware bg/text — we keep the red/burgundy palette
            // because the card communicates "ongoing broadcast, action
            // required to stop". Light: rose-100. Dark: rose-900-ish.
            const bg = isDark ? '#7F1D1D33' : '#FEE2E2';
            const fg = isDark ? '#FECACA' : '#7F1D1D';
            return (
              <View style={{
                flexDirection: 'row', alignItems: 'center',
                backgroundColor: bg, borderRadius: 16,
                paddingHorizontal: 14, paddingVertical: 12,
                marginBottom: 18,
              }}>
                <View style={{
                  width: 34, height: 34, borderRadius: 17,
                  backgroundColor: isDark ? '#991B1B66' : '#FCA5A580',
                  alignItems: 'center', justifyContent: 'center', marginRight: 12,
                }}>
                  <IconMapPin size={18} color={fg} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: fg, fontSize: 13.5, fontWeight: '700' }} numberOfLines={1}>
                    {t?.('chatConv.liveAlreadySharing') || 'Você já está dividindo localização ao vivo'}
                  </Text>
                  {!!subtitle && (
                    <Text style={{ color: fg, fontSize: 12, opacity: 0.85, marginTop: 2 }} numberOfLines={1}>
                      {subtitle}
                    </Text>
                  )}
                </View>
                <TouchableOpacity
                  onPress={() => onStopLive?.()}
                  hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                  style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 12, backgroundColor: isDark ? 'rgba(239,68,68,0.16)' : 'rgba(239,68,68,0.12)' }}
                  accessibilityRole="button"
                  accessibilityLabel={t?.('chatConv.liveStop') || 'Parar'}
                >
                  <Text style={{ color: '#EF4444', fontSize: 14, fontWeight: '700' }}>
                    {t?.('chatConv.liveStop') || 'Parar'}
                  </Text>
                </TouchableOpacity>
              </View>
            );
          })()}

          {/* Body: loading / error / preview */}
          {loading && !coords && (
            <View style={{ height: 220, alignItems: 'center', justifyContent: 'center' }}>
              <View style={{
                width: 60, height: 60, borderRadius: 30,
                backgroundColor: tileBg,
                alignItems: 'center', justifyContent: 'center', marginBottom: 16,
              }}>
                <ActivityIndicator size="large" color={colors.text} />
              </View>
              <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>
                {t?.('chatConv.locationFetching') || 'Buscando sua localização…'}
              </Text>
            </View>
          )}

          {error && !coords && (
            <View style={{ paddingVertical: 28, alignItems: 'center' }}>
              <View style={{
                width: 60, height: 60, borderRadius: 30,
                backgroundColor: isDark ? 'rgba(239,68,68,0.16)' : 'rgba(239,68,68,0.10)',
                alignItems: 'center', justifyContent: 'center', marginBottom: 16,
              }}>
                <IconMapPin size={26} color="#ef4444" />
              </View>
              <Text style={{ fontSize: 14.5, color: colors.text, textAlign: 'center', marginBottom: 20, lineHeight: 21, paddingHorizontal: 8 }}>
                {error}
              </Text>
              <TouchableOpacity
                onPress={onClose}
                style={{ paddingHorizontal: 28, paddingVertical: 13, borderRadius: 14, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(17,27,33,0.06)' }}
              >
                <Text style={{ color: colors.text, fontSize: 15, fontWeight: '700' }}>
                  {t?.('common.close') || 'Fechar'}
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {coords && !liveConfirm && (
            <>
              {/* Map — [2026-10-07 native-maps] interactive native picker when
                  available (pan + center pin + search + my-location), else the
                  WebView preview. */}
              {nativeMap ? (
                <NativePickerMap
                  gps={coords}
                  height={280}
                  colors={colors}
                  isDark={isDark}
                  t={t}
                  onPick={handlePick}
                />
              ) : (
                <MapPreviewCard
                  lat={coords.latitude}
                  lng={coords.longitude}
                  accuracy={coords.accuracy}
                  height={190}
                  colors={colors}
                  isDark={isDark}
                  t={t}
                />
              )}

              {/* Address line */}
              {/* eyebrow só quando há endereço resolvido (senão o título já é
                  "Sua localização atual" e o rótulo ficaria duplicado) */}
              {!!(picked ? pickedAddress : address) && (
              <Text style={{ fontSize: 11.5, fontWeight: '600', color: colors.textSecondary, letterSpacing: 0.6, marginBottom: 4 }}>
                {(picked
                  ? (t?.('maps.selectedPlace') || 'Local selecionado')
                  : (t?.('chatConv.locationCurrent') || 'Sua localização atual')).toUpperCase()}
              </Text>
              )}
              <Text style={{ fontSize: 16, color: colors.text, marginBottom: 3, fontWeight: '600', letterSpacing: -0.25, lineHeight: 21 }} numberOfLines={2}>
                {picked
                  ? (pickedAddress || (t?.('maps.selectedPlace') || 'Local selecionado'))
                  : (address || (t?.('chatConv.locationCurrent') || 'Sua localização atual'))}
              </Text>
              <Text style={{ fontSize: 12.5, color: colors.textSecondary, marginBottom: approxOnly && !picked ? 6 : 18, fontVariant: ['tabular-nums'] }}>
                {(picked || coords).latitude.toFixed(5)}, {(picked || coords).longitude.toFixed(5)}
                {!picked && coords.accuracy ? ` · ±${Math.round(coords.accuracy)}m` : ''}
                {!picked && loading ? ` · ${t?.('chatConv.locationRefining') || 'refinando…'}` : ''}
              </Text>
              {/* Subtle approximate-location hint: shown when the only fix
                  we have is an aged cache (>30s) and a fresh GPS read hasn't
                  returned yet. Sending is still allowed. */}
              {approxOnly && !picked && (
                <Text style={{ fontSize: 11.5, color: '#D97706', marginBottom: 20, fontWeight: '700' }} numberOfLines={1}>
                  {t?.('chatConv.locationApprox') || 'Localização aproximada'}
                </Text>
              )}

              {/* Send button */}
              <TouchableOpacity
                onPress={handleSend}
                disabled={sending}
                activeOpacity={0.85}
                style={{
                  backgroundColor: ink,
                  borderRadius: 14,
                  height: 52,
                  alignItems: 'center',
                  opacity: sending ? 0.6 : 1,
                  flexDirection: 'row', justifyContent: 'center', gap: 9,
                }}
              >
                <IconNavigation size={17} color={onInk} />
                <Text style={{ color: onInk, fontSize: 16, fontWeight: '600', letterSpacing: -0.1 }}>
                  {sending
                    ? (t?.('common.sending') || 'Enviando…')
                    : picked
                      ? (t?.('maps.sendThisLocation') || 'Enviar esta localização')
                      : (t?.('chatConv.locationSend') || 'Enviar localização atual')}
                </Text>
              </TouchableOpacity>

              {/* Live location chips — picking a duration jumps to the
                  confirm step instead of starting broadcast immediately
                  (WhatsApp parity: avoids accidental "I just shared my
                  live location with 2 hours of tracking" taps).
                  Snap-Map 2026-05-18: "Sempre" chip = unlimited until
                  user stops manually. */}
              {onLiveStart && !activeLive && (
                <View style={{ marginTop: 22 }}>
                  {/* [2026-10-08 chat-fix-composer-location] chips verdes → lista
                      agrupada P&B (iOS Settings / WhatsApp iOS): ícone SVG em
                      tile neutro + rótulo + subtítulo + chevron, hairlines. */}
                  <Text style={{ fontSize: 11.5, fontWeight: '600', color: colors.textSecondary, marginBottom: 8, marginLeft: 4, letterSpacing: 0.6 }}>
                    {(t?.('chatConv.liveLocation') || 'COMPARTILHAR AO VIVO').toUpperCase()}
                  </Text>
                  <View style={{ borderRadius: 14, backgroundColor: groupBg, overflow: 'hidden' }}>
                    {LIVE_DURATIONS.map((d, idx) => {
                      const inf = d.seconds === -1;
                      return (
                        <TouchableOpacity
                          key={d.key}
                          onPress={() => {
                            if (sending) return;
                            setLiveConfirm({ seconds: d.seconds, label: d.label, unlimited: inf });
                          }}
                          disabled={sending}
                          activeOpacity={0.6}
                          accessibilityRole="button"
                          accessibilityLabel={`${t?.('chatConv.liveLocation') || 'Compartilhar ao vivo'}: ${d.label}`}
                          style={{
                            flexDirection: 'row', alignItems: 'center',
                            paddingHorizontal: 14, minHeight: 52,
                            opacity: sending ? 0.5 : 1,
                          }}
                        >
                          <View style={{ width: 30, height: 30, borderRadius: 9, backgroundColor: tileBg, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                            {inf ? <IconInfinity size={17} color={colors.text} /> : <IconClock size={16} color={colors.text} />}
                          </View>
                          <View style={{
                            flex: 1, flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch',
                            borderBottomWidth: idx < LIVE_DURATIONS.length - 1 ? 0.5 : 0, borderBottomColor: hairline,
                            paddingVertical: 9,
                          }}>
                            <View style={{ flex: 1 }}>
                              <Text style={{ color: colors.text, fontSize: 15.5, fontWeight: '500' }}>{d.label}</Text>
                              {!!liveSubtitle(d) && (
                                <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 1 }} numberOfLines={1}>{liveSubtitle(d)}</Text>
                              )}
                            </View>
                            <IconChevronRightSm size={16} color={colors.textTertiary || colors.textSecondary} />
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              )}
            </>
          )}

          {/* Live-share confirmation step — WhatsApp-grade screen the user
              sees BEFORE we actually start broadcasting. Map preview at the
              top + selected duration row (tap to switch) + optional caption
              input + privacy reminder + big primary "Compartilhar ao vivo"
              CTA. Back arrow returns to the chips. */}
          {coords && liveConfirm && (
            <>
              <MapPreviewCard
                lat={coords.latitude}
                lng={coords.longitude}
                accuracy={coords.accuracy}
                height={168}
                colors={colors}
                isDark={isDark}
                t={t}
              />

              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16, gap: 12 }}>
                <View style={{
                  width: 40, height: 40, borderRadius: 12,
                  backgroundColor: tileBg,
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  {liveConfirm.unlimited ? <IconInfinity size={20} color={colors.text} /> : <IconClock size={19} color={colors.text} />}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15.5, fontWeight: '700', color: colors.text, letterSpacing: -0.2 }} numberOfLines={1}>
                    {address || (t?.('chatConv.locationCurrent') || 'Sua localização atual')}
                  </Text>
                  <Text style={{ fontSize: 12.5, color: colors.textSecondary, marginTop: 2 }}>
                    {t?.('chatConv.liveDurationLabel') || 'Atualizando por'}: {liveConfirm.label}
                  </Text>
                </View>
              </View>

              {/* Duration switcher — [2026-10-08 chat-fix-composer-location]
                  segmented control P&B (trilho neutro + segmento selecionado
                  em superfície com sombra leve), sem verde. */}
              <View style={{ flexDirection: 'row', backgroundColor: groupBg, borderRadius: 12, padding: 3, marginBottom: 16 }}>
                {LIVE_DURATIONS.map(d => {
                  const sel = d.seconds === liveConfirm.seconds;
                  const inf = d.seconds === -1;
                  return (
                    <TouchableOpacity
                      key={d.key}
                      onPress={() => setLiveConfirm({ seconds: d.seconds, label: d.label, unlimited: inf })}
                      disabled={sending}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityState={{ selected: sel }}
                      style={{
                        flex: 1,
                        height: 34,
                        borderRadius: 9,
                        backgroundColor: sel ? (isDark ? '#2c2c2e' : '#ffffff') : 'transparent',
                        alignItems: 'center', justifyContent: 'center',
                        flexDirection: 'row', gap: 4,
                        ...(sel ? { shadowColor: '#000', shadowOpacity: isDark ? 0 : 0.08, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 } : null),
                      }}
                    >
                      {inf ? <IconInfinity size={14} color={sel ? colors.text : colors.textSecondary} strokeWidth={2.2} /> : null}
                      <Text style={{ color: sel ? colors.text : colors.textSecondary, fontSize: 13, fontWeight: sel ? '600' : '500' }} numberOfLines={1}>
                        {d.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Optional caption — parent decides whether to use it (most
                  chat callers ignore it; group chats render it under the
                  bubble). */}
              <TextInput
                value={liveCaption}
                onChangeText={setLiveCaption}
                placeholder={t?.('chatConv.liveCommentPlaceholder') || 'Adicionar comentário (opcional)'}
                placeholderTextColor={colors.textSecondary}
                maxLength={120}
                style={{
                  backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(17,27,33,0.04)',
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(17,27,33,0.05)',
                  paddingHorizontal: 15,
                  paddingVertical: 12,
                  fontSize: 14.5,
                  color: colors.text,
                  marginBottom: 14,
                }}
              />

              {/* Privacy reminder — WhatsApp does this and it actually
                  helps adoption since users worry about who sees their
                  pin. Snap-Map 2026-05-18: "Sempre" mode gets a stronger
                  warning because there's no auto-expiry. */}
              <View style={{
                flexDirection: 'row', gap: 10, alignItems: 'flex-start',
                backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(17,27,33,0.03)',
                borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 18,
              }}>
                <View style={{ marginTop: 1 }}>
                  <IconMapPin size={16} color={liveConfirm.unlimited ? '#D97706' : colors.textSecondary} />
                </View>
                <Text style={{ flex: 1, fontSize: 12, color: colors.textSecondary, lineHeight: 17, fontWeight: liveConfirm.unlimited ? '600' : '400' }}>
                  {liveConfirm.unlimited
                    ? (t?.('chatConv.livePrivacyUnlimited') || 'Sempre ativo: sua localização continua sendo compartilhada até você desligar manualmente. Toque na bolha para parar.')
                    : (t?.('chatConv.livePrivacyNote') || 'Apenas pessoas desta conversa veem sua localização. Você pode parar a qualquer momento.')}
                </Text>
              </View>

              {/* Primary CTA + secondary back */}
              <TouchableOpacity
                onPress={() => {
                  if (sending) return;
                  setSending(true);
                  onLiveStart?.(liveConfirm.seconds, {
                    caption: liveCaption.trim() || null,
                    latitude: coords.latitude,
                    longitude: coords.longitude,
                    address: address || null,
                  });
                }}
                disabled={sending}
                activeOpacity={0.85}
                style={{
                  backgroundColor: ink,
                  borderRadius: 14,
                  height: 52,
                  alignItems: 'center',
                  opacity: sending ? 0.6 : 1,
                  flexDirection: 'row', justifyContent: 'center', gap: 9,
                  marginBottom: 6,
                }}
              >
                <IconNavigation size={17} color={onInk} />
                <Text style={{ color: onInk, fontSize: 16, fontWeight: '600', letterSpacing: -0.1 }}>
                  {sending
                    ? (t?.('common.sending') || 'Enviando…')
                    : (t?.('chatConv.liveShareConfirm') || 'Compartilhar ao vivo')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setLiveConfirm(null)}
                disabled={sending}
                style={{ paddingVertical: 12, alignItems: 'center' }}
              >
                <Text style={{ color: colors.textSecondary, fontSize: 14.5, fontWeight: '700' }}>
                  {t?.('common.back') || 'Voltar'}
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
