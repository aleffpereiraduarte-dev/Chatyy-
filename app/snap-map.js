// Snap Map — friends-on-a-map screen, Snapchat / Find-My-Friends style.
//
// Why this file
// -------------
// Three pillars from the spec:
//   1. Render a single map with every friend who's currently sharing
//      their location with me (chat_friends_map_shares).
//   2. Each pin = circular avatar + name floating above. Tap → bottom
//      sheet with "Conversar" / "Como chegar" / "Parar de receber".
//   3. Live updates via WS `location_update` + `location_share_revoked`
//      events; the 30s poll is a fallback for WS reconnects.
//
// Rendering: MapLibre GL JS + BoraUm self-hosted OSM tiles inside a WebView
// --------------------------------------------------------------------------
// 2026-06-24 DE-GOOGLE: this screen used to inject the Google Maps JS API
// (billing-gated, paid) with a Leaflet/CartoCDN fallback. We ripped Google out
// entirely and now render with MapLibre GL JS (loaded via the unpkg CDN inside
// the WebView) reading a style.json from our OWN tile server, the BoraUm
// tileserver (OpenStreetMap data): https://boraum.com.br/maptiles/. No Google
// key, no billing, no third-party tile CDN.
//
//   - The style is chosen per the map center by coverageStyleFor(lng, lat) in
//     components/BoraMap.js: inside BR/US/PH/PT/CO → the country style; else
//     the neutral global 'world-cinza' style. Dark mode forces 'world-cinza'.
//   - Each friend pin is a DOM avatar (new maplibregl.Marker({element})); the
//     "you are here" blue dot is a second, non-interactive marker.
//   - The postMessage protocol (RN ⇄ WebView) is UNCHANGED from the old
//     renderers — RNbridge/__renderPins/__renderMe/__panTo + map_ready/pin_tap.
//
// Why WebView (MapLibre via CDN) and not @maplibre/maplibre-react-native:
//   The RN MapLibre module is a NATIVE dependency → TestFlight build + Play
//   re-submit on every change, and risks the use_frameworks landmine. MapLibre
//   GL JS over a CDN <script> inside the existing WebView is pure OTA.
//
// Why WebView and not react-native-maps:
//   react-native-maps is a NATIVE module → TestFlight build + Play re-submit
//   on every change. WebView is core-bundled with react-native-webview
//   (already installed, used by ~15 screens) and ships as OTA.
//
// Privacy contract (matches backend chat.php BEGIN FRIEND_LOCATION_TRACKING):
//   - Backend never returns shares without an active grant. Frontend
//     never persists a pin past a `location_share_revoked` event.
//   - "Parar de receber" hits chat_friend_location_revoke (delete grant
//     on either side); WS revoke is broadcast and listeners drop the pin.

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform,
  ScrollView, Dimensions, Modal, Pressable, ActivityIndicator, Alert,
  Linking, StatusBar, AppState,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { triggerLocationRequestModal } from '../components/LocationRequestModal';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import AvatarCircle from '../components/AvatarCircle';
import { getAvatarUrlForEmail } from '../services/api';
import { coverageStyleFor, boraStyleUrl, boraMapHtml } from '../components/BoraMap';
import {
  IconArrowLeft, IconMapPin, IconUser, IconMessageSquare, IconX, IconNavigation,
  IconPhone, IconEyeOff, IconClock, IconRefresh, IconFilter,
} from '../components/Icons';

// 2026-06-24 DE-GOOGLE: arrancamos o Google Maps (Maps JS API + billing pago)
// e passamos a usar o tile server self-hosted do BoraUm (OpenStreetMap data,
// MapLibre GL JS). O style é escolhido por coverageStyleFor(lng, lat) — dentro
// de BR/US/PH/PT/CO usa o style do país; senão cai no 'world-cinza'. Tudo OTA:
// MapLibre roda por CDN (unpkg) DENTRO do WebView/iframe que já existe — ZERO
// dependência nativa (sem @maplibre/maplibre-react-native). Não há mais chave
// Google nem leitura de app.json extra.GOOGLE_MAPS_KEY neste arquivo.

// mailWs is the singleton WS bridge — re-uses the connection chat-conv
// holds, so subscribing here is essentially free. The module is
// `services/websocket` (there is no `services/mailWs` — the old path
// silently resolved to null, leaving the location_update subscription dead,
// so real-time pin updates never fired and the map only refreshed on the
// 30s poll). chat-conversation.js uses this exact module + `.on(event)` API.
let mailWs = null;
try { mailWs = require('../services/websocket').default; } catch {}

const { width: SW, height: SH } = Dimensions.get('window');

const DEFAULT_ZOOM = 14;

// Build the HTML document that runs MapLibre GL JS (CDN unpkg) reading the
// BoraUm self-hosted style.json + a custom DOM avatar marker per friend.
// Each pin is a real DOM node (rounded avatar img + name label) anchored to
// lng/lat via `new maplibregl.Marker({element})` — exactly the Snapchat /
// Find-My-Friends look the spec asks for, which a plain symbol layer can't
// render. The "you are here" blue dot is a second marker with pointer-events
// off so taps fall through to the map.
//
// Pins/myLocation are passed as JSON literals on first render and patched
// live via `window.RNbridge(jsonString)` (native injectJavaScript) /
// `window.postMessage` (web iframe). `pin_tap` events flow back via
// `window.ReactNativeWebView.postMessage` (native) or `window.parent
// .postMessage` (web). The protocol is byte-identical to the old gmaps/leaflet
// renderers — only the tile/map engine changed.
//
// Dark mode: there are no per-country dark styles on the BoraUm tileserver, so
// dark mode just uses the global 'world-cinza' style (clean gray base) — the
// avatar rings + pulses carry the visual language regardless of basemap.
function buildMapHtml({ center, zoom, isDark, initialPins, initialMe }) {
  const pinsJson = JSON.stringify(initialPins || []);
  const meJson = JSON.stringify(initialMe || null);
  // Style is picked by the BoraUm coverage helper. coverageStyleFor() takes
  // (lon, lat) — longitude first. In dark mode we force 'world-cinza' (the
  // neutral gray global style) so the basemap reads as "dark-ish" everywhere.
  const styleUrl = isDark
    ? 'https://boraum.com.br/maptiles/styles/world-cinza/style.json'
    : boraStyleUrl(center.lng, center.lat);
  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<link href="https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.css" rel="stylesheet"/>
<script src="https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.js"></script>
<style>
  html,body,#map{margin:0;padding:0;width:100%;height:100%;background:${isDark ? '#0d0d0d' : '#e5e7eb'};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
  /* MapLibre positions the marker element via its anchor; the pin itself just
     lays out its inner avatar + labels in a column (no absolute transform). */
  .pin{display:flex;flex-direction:column;align-items:center;cursor:pointer;pointer-events:auto;user-select:none}
  /* Gradient ring around the avatar — same look as Snapchat / Find-My.
     Live (fresh) = green gradient, unlimited = purple gradient, stale =
     desaturated gray. We use a two-layer box-shadow trick so the ring has
     both an outer halo + a hairline white separator inside, matching the
     iOS Find-My pin design. */
  .pin .ring{width:52px;height:52px;border-radius:26px;background:linear-gradient(135deg,#22c55e,#16a34a);padding:3px;box-sizing:border-box;box-shadow:0 4px 14px rgba(0,0,0,0.45),0 0 0 2px rgba(255,255,255,0.95) inset;position:relative}
  .pin.unlimited .ring{background:linear-gradient(135deg,#a855f7,#7C3AED)}
  .pin.stale .ring{background:linear-gradient(135deg,#9ca3af,#6b7280);opacity:0.85}
  .pin .ring img{width:100%;height:100%;border-radius:50%;display:block;object-fit:cover;background:#7C3AED}
  .pin .ring .ini{width:100%;height:100%;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:18px;background:#7C3AED}
  /* Live breathing pulse — only shown for fresh (non-stale) sharers. The
     ring radiates a soft green glow that fades, signaling "this person is
     ACTIVE right now". Stale pins skip the animation so the eye is drawn
     to the live ones. */
  .pin:not(.stale) .ring::after{content:'';position:absolute;inset:-4px;border-radius:50%;border:2px solid rgba(34,197,94,0.55);animation:pinPulse 2.4s ease-out infinite;pointer-events:none}
  .pin.unlimited:not(.stale) .ring::after{border-color:rgba(124,58,237,0.6)}
  @keyframes pinPulse{0%{transform:scale(1);opacity:.7}100%{transform:scale(1.45);opacity:0}}
  .pin .label{margin-top:5px;background:rgba(0,0,0,0.82);color:#fff;font-size:10px;font-weight:700;padding:3px 9px;border-radius:11px;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;backdrop-filter:blur(8px)}
  /* "há Xmin" badge stacked under the name label so users can eyeball at a
     glance whether a friend just updated or has been stale for a while.
     Rendered ONLY when ago_label is set so old/missing rows degrade. */
  .pin .ago{margin-top:2px;background:rgba(255,255,255,0.92);color:#111;font-size:9px;font-weight:600;padding:1px 7px;border-radius:9px;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pin.stale .ago{background:rgba(239,68,68,0.92);color:#fff}
  /* MapLibre centers this marker (anchor:'center'); no absolute transform. */
  .me{pointer-events:none}
  .me .dot{width:18px;height:18px;border-radius:50%;background:#3B82F6;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.4);position:relative}
  /* WhatsApp/Google-style breathing pulse around the blue dot. The outer
     ring expands+fades to telegraph "you are here, GPS live". */
  .me .dot::before{content:'';position:absolute;left:50%;top:50%;width:18px;height:18px;border-radius:50%;background:rgba(59,130,246,0.35);transform:translate(-50%,-50%);animation:mePulse 2s ease-out infinite;z-index:-1}
  .me .dot::after{content:'';position:absolute;left:50%;top:50%;width:18px;height:18px;border-radius:50%;background:rgba(59,130,246,0.25);transform:translate(-50%,-50%);animation:mePulse 2s ease-out infinite 1s;z-index:-1}
  @keyframes mePulse{0%{transform:translate(-50%,-50%) scale(1);opacity:.7}100%{transform:translate(-50%,-50%) scale(4);opacity:0}}
</style>
</head><body>
<div id="map"></div>
<script>
var INITIAL_CENTER = ${JSON.stringify(center)};
var INITIAL_ZOOM = ${zoom};
var INITIAL_PINS = ${pinsJson};
var INITIAL_ME = ${meJson};
var STYLE_URL = ${JSON.stringify(styleUrl)};

var __map = null;
var __overlays = {};       // email → maplibregl.Marker (avatar pin)
var __meMarker = null;     // maplibregl.Marker ("you are here" blue dot)
var __ready = false;

// Send a message back to the RN host. Native uses ReactNativeWebView,
// web iframe uses parent postMessage.
function rnPost(obj) {
  try {
    var msg = JSON.stringify(obj);
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(msg);
    } else if (window.parent && window.parent !== window) {
      window.parent.postMessage(msg, '*');
    }
  } catch (e) {}
}

function pinHtml(pin) {
  var initial = (pin.name || pin.email || '?').trim().charAt(0).toUpperCase();
  var img = pin.avatar_url
    ? '<img src="' + pin.avatar_url + '" onerror="this.style.display=\\'none\\';this.nextElementSibling&&(this.nextElementSibling.style.display=\\'flex\\')"/><div class="ini" style="display:none">' + initial + '</div>'
    : '<div class="ini">' + initial + '</div>';
  var name = (pin.name || (pin.email ? pin.email.split('@')[0] : '?'));
  var nameShort = name.split(' ')[0];
  // ago_label is a short relative-time string ("agora", "há 5min", "há 2h")
  // computed in RN-land via the ago() helper. We render it inside the pin
  // so users see at a glance how fresh the position is — the dominant
  // user feedback ("ta desconectando") was actually peers seeing stale pins
  // and assuming the share died, when it's still live just heartbeat-quiet.
  var agoHtml = pin.ago_label
    ? '<div class="ago">' + escapeHtml(pin.ago_label) + '</div>'
    : '';
  return '<div class="ring">' + img + '</div><div class="label">' + escapeHtml(nameShort) + '</div>' + agoHtml;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});
}

// ──────────────────────────── MapLibre GL backend (BoraUm tiles) ───────────
// The single production renderer for snap-map. style.json is served by the
// BoraUm self-hosted tileserver (OpenStreetMap data) — no Google, no key, no
// billing. Each friend is a DOM avatar marker (new maplibregl.Marker with a
// custom element). The protocol back to RN (map_ready/pin_tap) and the globals
// the RN side calls (__renderPins/__renderMe/__panTo) are byte-identical to
// the old gmaps/leaflet renderers, so nothing on the RN side had to change.

// Build the DOM element for a friend's avatar pin. We reuse the same pinHtml()
// inner markup the old renderers used, so the stale ring + ago badge stay
// consistent. Anchor is the bottom-center of the bubble (the avatar "drops"
// onto the coordinate, Find-My style).
function makePinEl(pin) {
  var el = document.createElement('div');
  el.className = 'pin' + (pin.is_unlimited ? ' unlimited' : '') + (pin.is_stale ? ' stale' : '');
  el.innerHTML = pinHtml(pin);
  return el;
}

// Smoothly glide a marker from its current lng/lat to a new one over ~700ms
// instead of teleporting. A real-time WS location_update should look like the
// friend *walking* to the new spot, not blinking there. We interpolate per
// animation frame; if a newer update arrives mid-glide we cancel and re-aim
// from the live position. easeInOutQuad for a natural settle — same curve the
// old gmaps/leaflet renderers used.
function glideMarker(marker, toLng, toLat) {
  try {
    if (marker.__glideRAF) { cancelAnimationFrame(marker.__glideRAF); marker.__glideRAF = null; }
    var from = marker.getLngLat();
    var fLng = from.lng, fLat = from.lat;
    var dLng = toLng - fLng, dLat = toLat - fLat;
    // First placement or a long jump (>~2km) → snap, don't animate.
    if (!isFinite(fLat) || !isFinite(fLng) || Math.abs(dLat) > 0.02 || Math.abs(dLng) > 0.02 || (dLat === 0 && dLng === 0)) {
      marker.setLngLat([toLng, toLat]);
      return;
    }
    var dur = 700, start = (window.performance && performance.now) ? performance.now() : Date.now();
    function step(now) {
      var t = Math.min(1, ((now || Date.now()) - start) / dur);
      var e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // easeInOutQuad
      marker.setLngLat([fLng + dLng * e, fLat + dLat * e]);
      if (t < 1) { marker.__glideRAF = requestAnimationFrame(step); }
      else { marker.setLngLat([toLng, toLat]); marker.__glideRAF = null; }
    }
    marker.__glideRAF = requestAnimationFrame(step);
  } catch (e) { try { marker.setLngLat([toLng, toLat]); } catch (e2) {} }
}

function bootMap() {
  __map = new maplibregl.Map({
    container: 'map',
    style: STYLE_URL,
    center: [INITIAL_CENTER.lng, INITIAL_CENTER.lat],
    zoom: INITIAL_ZOOM,
    attributionControl: false,
  });
  // Zoom buttons (top-left, like the old zoomControl:true). No compass —
  // snap-map never rotates.
  try { __map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left'); } catch (e) {}

  // Re-create / update every friend avatar marker. Markers we no longer see
  // are removed (privacy: a revoked share drops the pin immediately).
  window.__renderPins = function(pins) {
    var seen = {};
    pins.forEach(function(p){
      if (!isFinite(p.lat) || !isFinite(p.lng)) return;
      seen[p.email] = true;
      var existing = __overlays[p.email];
      if (existing) {
        // Update visual chrome (ring/stale/badge + click handler) in place,
        // then glide to the new coords so a live tick animates.
        existing.getElement().className = 'pin' + (p.is_unlimited ? ' unlimited' : '') + (p.is_stale ? ' stale' : '');
        existing.getElement().innerHTML = pinHtml(p);
        glideMarker(existing, p.lng, p.lat);
      } else {
        var el = makePinEl(p);
        (function(em){
          el.addEventListener('click', function(){ rnPost({ type: 'pin_tap', email: em }); });
        })(p.email);
        var m = new maplibregl.Marker({ element: el, anchor: 'bottom' })
          .setLngLat([p.lng, p.lat])
          .addTo(__map);
        __overlays[p.email] = m;
      }
    });
    Object.keys(__overlays).forEach(function(em){
      if (!seen[em]) { try { __overlays[em].remove(); } catch(_){} delete __overlays[em]; }
    });
  };

  // "You are here" blue dot — a non-interactive centered marker so taps fall
  // through to the map underneath.
  window.__renderMe = function(me) {
    if (!me || !isFinite(me.lat) || !isFinite(me.lng)) {
      if (__meMarker) { try { __meMarker.remove(); } catch(_){} __meMarker = null; }
      return;
    }
    if (__meMarker) {
      __meMarker.setLngLat([me.lng, me.lat]);
    } else {
      var el = document.createElement('div');
      el.className = 'me';
      el.innerHTML = '<div class="dot"></div>';
      __meMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([me.lng, me.lat])
        .addTo(__map);
    }
  };

  window.__panTo = function(lat, lng) {
    try { __map.panTo([lng, lat]); } catch (e) {}
  };

  // Surface "tiles drawn" so the host can dismiss its loading spinner + flush
  // any pins that landed before the map was ready. 'load' fires once the style
  // + first tiles are in; we also guard with a one-shot flag.
  __map.on('load', function(){
    if (__ready) return;
    __ready = true;
    window.__renderPins(INITIAL_PINS);
    if (INITIAL_ME) window.__renderMe(INITIAL_ME);
    rnPost({ type: 'map_ready' });
  });
}

// ──────────────────────────── RN → WebView bridge ────────────────────────
// Native: parent calls webRef.injectJavaScript("window.RNbridge('{...}')")
// Web:    parent posts {raw:'{...}'} via iframe.contentWindow.postMessage
window.RNbridge = function(json) {
  try {
    var msg = typeof json === 'string' ? JSON.parse(json) : json;
    if (msg.type === 'pins' && window.__renderPins) window.__renderPins(msg.pins || []);
    else if (msg.type === 'me' && window.__renderMe) window.__renderMe(msg.me);
    else if (msg.type === 'pan' && window.__panTo) window.__panTo(msg.lat, msg.lng);
  } catch (e) {}
};
window.addEventListener('message', function(ev) {
  var d = ev && ev.data;
  if (typeof d === 'string') { try { window.RNbridge(d); } catch(e){} }
  else if (d && d.raw) { try { window.RNbridge(d.raw); } catch(e){} }
});

// ──────────────────────────── Loader ─────────────────────────────────────
// MapLibre GL JS loads from the unpkg CDN <script> in <head>. If that already
// evaluated by the time this inline script runs, boot immediately; otherwise
// wait for window load. No external map keys, no billing, no fallbacks needed.
(function bootWhenReady() {
  if (typeof maplibregl !== 'undefined') { try { bootMap(); } catch (e) {} return; }
  window.addEventListener('load', function(){
    if (typeof maplibregl !== 'undefined') { try { bootMap(); } catch (e) {} }
  });
})();
</script>
</body></html>`;
}

// Great-circle distance between two lat/lng pairs (Haversine). Returns
// meters. Used by the Apple-style friends list to show "1.2km" / "240m"
// next to each share row. We only render it when both me + the friend
// have coords, since otherwise the value is meaningless.
function haversineMeters(aLat, aLng, bLat, bLng) {
  if (![aLat, aLng, bLat, bLng].every(Number.isFinite)) return null;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const a = s1 * s1 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
function formatDistance(m) {
  if (m === null || !Number.isFinite(m)) return '';
  if (m < 100) return `${Math.round(m)} m`;
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  if (m < 10000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

// Format `now` as the poll's UTC "YYYY-MM-DD HH:MM:SS" so a live WS patch's
// updated_at parses identically to backend rows (which lack a 'Z' and get one
// appended by the readers). Keeps freshness math consistent across both paths.
function wsUtcStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function ago(updatedAt) {
  if (!updatedAt) return '';
  let ts = 0;
  try { ts = new Date(updatedAt.replace(' ', 'T') + 'Z').getTime(); } catch {}
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'agora';
  if (s < 60) return `há ${s}s`;
  if (s < 3600) return `há ${Math.round(s / 60)}min`;
  if (s < 86400) return `há ${Math.round(s / 3600)}h`;
  return `há ${Math.round(s / 86400)}d`;
}

// [WAVE 49 2026-05-21] Active sessions chip. Renders ONLY when the user is
// actively sharing their location OUT to one or more people. We hide it in
// ghost mode (a separate banner takes over) and on first paint until the
// grants data has loaded — flashing an empty chip is worse than waiting.
//
// Tap → opens the grants modal where each session can be revoked
// individually. The chip text adapts to the count: "Compartilhando com Ana"
// for 1, "Compartilhando com Ana + 2" for many.
function ActiveSessionsChip({ grantsData, isDark, colors, t, ghostMode, onOpen, onLoad }) {
  useEffect(() => { try { onLoad?.(); } catch {} }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (ghostMode) return null;
  const outgoing = grantsData?.sharing_with || [];
  if (outgoing.length === 0) return null;
  const first = outgoing[0];
  const firstName = (first?.name || first?.email || '').split(' ')[0] || first?.email?.split('@')[0] || '';
  // Find the soonest-expiring session (excluding unlimited). Surfaces
  // "expira em Xmin" right on the chip — the user previously had to dig
  // into the grants modal to know how much time was left, which is the
  // kind of friction that made them think shares were "desconectando".
  let earliestExp = null;
  for (const g of outgoing) {
    if (g.is_unlimited) continue;
    if (g.expires_at && (earliestExp === null || g.expires_at < earliestExp)) earliestExp = g.expires_at;
  }
  let timeLabel = '';
  if (earliestExp !== null) {
    const secs = Math.max(0, earliestExp - Date.now() / 1000);
    // Clock-skew grace: client/server clocks drift a couple seconds, so a
    // session that's actually still live can momentarily compute secs≈0 and
    // flash "0s restantes" before the next poll bumps it back up. Floor the
    // seconds bucket at 3s so we never flash a bare "0s" for a session the
    // backend still considers active. Once it's genuinely expired the chip
    // is removed entirely (outgoing list empties), so this only smooths the
    // tail, it doesn't lie about a finished share.
    if (secs > 3600) timeLabel = `${Math.round(secs / 3600)}h ${t?.('snapmap.remaining') || 'restantes'}`;
    else if (secs > 60) timeLabel = `${Math.round(secs / 60)}min ${t?.('snapmap.remaining') || 'restantes'}`;
    else timeLabel = `${Math.max(3, Math.round(secs))}s ${t?.('snapmap.remaining') || 'restantes'}`;
  } else {
    timeLabel = '∞ ' + (t?.('snapmap.alwaysOn') || 'sempre ativo');
  }
  return (
    <Pressable
      onPress={onOpen}
      style={{
        marginHorizontal: 12, marginTop: 8, marginBottom: 4,
        paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14,
        backgroundColor: isDark ? 'rgba(124,58,237,0.18)' : 'rgba(124,58,237,0.10)',
        borderWidth: 1, borderColor: 'rgba(124,58,237,0.40)',
        flexDirection: 'row', alignItems: 'center', gap: 10,
      }}
      accessibilityRole="button"
      accessibilityLabel={t?.('snapmap.activeSessionsA11y') || 'Ver sessões ativas'}
    >
      <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: '#7C3AED', alignItems: 'center', justifyContent: 'center' }}>
        <IconMapPin size={16} color="#fff" />
      </View>
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ color: colors.text, fontSize: 13, fontWeight: '700' }}>
          {outgoing.length === 1
            ? `${t?.('snapmap.sharingChipOne') || 'Compartilhando com'} ${firstName}`
            : `${t?.('snapmap.sharingChipMany') || 'Compartilhando com'} ${firstName} + ${outgoing.length - 1}`}
        </Text>
        <Text numberOfLines={1} style={{ color: colors.textSecondary, fontSize: 11, marginTop: 1 }}>
          {timeLabel} · {t?.('snapmap.tapToManage') || 'toque pra gerenciar'}
        </Text>
      </View>
    </Pressable>
  );
}

export default function SnapMapScreen() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const router = useRouter();
  // User feedback 2026-05-18 ("no android mapa de amigos tá muito encima ai
  // tá cortando"): hardcoded paddingTop:14 on Android sat under the translucent
  // status bar, clipping the back button + title. iOS was fine because we used
  // 50. Use real insets here, falling back to StatusBar.currentHeight on
  // Android where insets.top can come back 0 with a translucent status bar.
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'android'
    ? Math.max(insets.top || 0, StatusBar.currentHeight || 0)
    : (insets.top || 0);
  // `incoming_request` is set when the user lands here from tapping a
  // location-request push (see services/pushNotifications.js). We auto-show
  // the global accept/decline sheet once on mount; further requests during
  // the same session use the in-screen pending banner instead.
  const params = useLocalSearchParams();
  const incomingHandledRef = useRef(false);
  useEffect(() => {
    const reqEmail = typeof params?.incoming_request === 'string' ? params.incoming_request : null;
    if (!reqEmail || incomingHandledRef.current) return;
    incomingHandledRef.current = true;
    try {
      triggerLocationRequestModal({
        requester_email: reqEmail,
        requester_name: typeof params?.requester_name === 'string' ? params.requester_name : '',
        message: typeof params?.message === 'string' ? params.message : '',
      });
    } catch {}
  }, [params?.incoming_request, params?.requester_name, params?.message]);

  const [shares, setShares] = useState([]);   // friends sharing with me
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [myLocation, setMyLocation] = useState(null);
  const [selected, setSelected] = useState(null); // bottom sheet pin
  const [pendingReqs, setPendingReqs] = useState([]); // incoming requests
  // [WAVE 69 2026-05-21] IP-based fallback location + permission state.
  // ipLocation = result of `geo_locate_ip` (Cloudflare or ipapi.co). Used
  // ONLY when GPS unavailable. usingIpFallback drives the banner that
  // explains to the user why we picked their city without permission.
  const [ipLocation, setIpLocation] = useState(null);
  const [usingIpFallback, setUsingIpFallback] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [grantsOpen, setGrantsOpen] = useState(false);
  const [grantsData, setGrantsData] = useState(null);
  // Apple Find-My-style friends list panel — when expanded the list of
  // people sharing covers ~55% of the map (collapsed = ~110px peek with
  // avatars + count). Two-position toggle keeps gesture surface tiny and
  // avoids fighting with the WebView's native pan/zoom touches.
  const [listExpanded, setListExpanded] = useState(false);

  // [WAVE 49 2026-05-21] Filter pills above the map — Snapchat-style.
  // 'all'      = everyone I have a grant from
  // 'nearby'   = friends within 5km of me (needs myLocation)
  // 'live'     = friends with fresh updates (last_seen < 2min)
  // 'always'   = "sempre ativo" sessions only (is_unlimited)
  // Filter state is intentionally local — it doesn't persist across mounts
  // because the right filter depends on context (just-opened vs deep-link).
  const [filter, setFilter] = useState('all');

  // Ghost mode — when ON, the user is hidden from snap-map peers. We don't
  // wipe their existing share session; we just flip a local flag the chat-
  // conversation heartbeat reads to skip its tick. The peer's pin will go
  // stale after ~2min and eventually expire. UI source-of-truth for the
  // toggle is `ghost_mode_on` in AsyncStorage so the heartbeat (lives in
  // chat-conversation.js) can read it without prop-drilling.
  const [ghostMode, setGhostMode] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        const v = await AsyncStorage.getItem('snap_map_ghost_mode');
        if (alive) setGhostMode(v === '1');
      } catch {}
    })();
    return () => { alive = false; };
  }, []);
  const toggleGhostMode = useCallback(async () => {
    const next = !ghostMode;
    setGhostMode(next);
    try {
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      await AsyncStorage.setItem('snap_map_ghost_mode', next ? '1' : '0');
    } catch {}
  }, [ghostMode]);

  // Now-tick: drives the "há Xs/Xmin" labels + stale ring re-renders. We
  // re-render every 10s so the per-pin freshness badge reads "atualizado
  // agora" → "há 10s" → "há 20s" responsively while a share is active,
  // instead of looking frozen for half a minute (which users read as a
  // "disconnect" — the pin stuck with an old timestamp). 10s is cheap: it
  // only re-runs the pinsPayload useMemo, the WebView diff is a no-op when
  // coords/labels are unchanged.
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 10000);
    return () => clearInterval(t);
  }, []);

  const sharesRef = useRef([]);
  sharesRef.current = shares;

  // Manual refresh for the friends panel — pulls shares + grants in
  // parallel without touching the GPS / map. Used by pull-to-refresh in
  // the Apple-style list AND by the small refresh chip in the empty
  // state. Surfacing the network state so the spinner shows briefly
  // even when the request resolves instantly (avoids the user wondering
  // if the tap registered).
  const refreshShares = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await api.friendsMapShares?.();
      if (r?.success && r.data) {
        setShares(Array.isArray(r.data.shares) ? r.data.shares : []);
      }
    } catch {}
    try {
      const g = await api.friendLocationGrants?.();
      if (g?.success && g.data) {
        setPendingReqs(g.data.pending_incoming || []);
      }
    } catch {}
    // Guarantee the spinner is visible for at least ~400ms; instant
    // resolutions feel unresponsive otherwise.
    setTimeout(() => setRefreshing(false), 400);
  }, []);

  // ── Initial load: my GPS + friends + pending requests ─────────────
  // [WAVE 69 2026-05-21] Smart fallback chain so a brand-new user (no GPS
  // permission, no cache) still sees a map centered near their actual city
  // instead of Cuiabá (the Brazil geographic centroid). Order:
  //   1. Fresh GPS (best — sub-100m)
  //   2. Last-known cached GPS (WAVE 65/66 — minutes-to-hours old)
  //   3. IP geolocate via backend `geo_locate_ip` (Cloudflare → ipapi.co)
  //   4. First friend's pin (group context > nothing)
  //   5. Brazil centroid (very last resort)
  //
  // `permissionDenied` + `usingIpFallback` drive the explanatory banner
  // (Fix C) — user gets an actionable "Ativar localização" CTA instead of
  // wondering why the map shows the wrong city.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      // My own location for centering. We DON'T auto-share — that's a
      // separate explicit user action (in-chat live-location bubble or
      // an accepted request).
      let gotFreshGps = false;
      if (Platform.OS !== 'web') {
        try {
          const Location = require('expo-location');
          // Check existing status BEFORE asking — never re-prompt if user
          // already denied (iOS shows a dead alert; Android shows nothing).
          let { status } = await Location.getForegroundPermissionsAsync();
          if (status !== 'granted' && status !== 'denied') {
            // Only ask if status is undetermined.
            const res = await Location.requestForegroundPermissionsAsync();
            status = res.status;
          }
          if (alive) setPermissionDenied(status === 'denied');
          if (status === 'granted') {
            const pos = await Location.getLastKnownPositionAsync({ maxAge: 60000 });
            if (alive && pos?.coords) {
              setMyLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
              gotFreshGps = true;
            }
            try {
              const fresh = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
              if (alive && fresh?.coords) {
                setMyLocation({ lat: fresh.coords.latitude, lng: fresh.coords.longitude });
                gotFreshGps = true;
              }
            } catch {}
          }
        } catch {}
      } else if (typeof navigator !== 'undefined' && navigator.geolocation) {
        // Web: navigator.geolocation has no separate "check" call. We have
        // to wrap getCurrentPosition in a promise so we know whether we
        // need to kick off the IP fallback below.
        try {
          const webPos = await new Promise((resolve) => {
            try {
              navigator.geolocation.getCurrentPosition(
                (pos) => resolve(pos),
                (err) => {
                  if (alive && err && (err.code === 1 || err.PERMISSION_DENIED === 1)) {
                    setPermissionDenied(true);
                  }
                  resolve(null);
                },
                { maximumAge: 60000, timeout: 6000 },
              );
            } catch { resolve(null); }
          });
          if (alive && webPos?.coords) {
            setMyLocation({ lat: webPos.coords.latitude, lng: webPos.coords.longitude });
            gotFreshGps = true;
          }
        } catch {}
      }

      // Fallback chain. Only fire IP geo if we still have nothing — saves
      // a network round-trip when GPS works. Cache result so subsequent
      // cold-starts skip the backend hop entirely.
      if (alive && !gotFreshGps) {
        try {
          const AsyncStorage = require('@react-native-async-storage/async-storage').default;
          // a) cached IP loc from previous session (≤ 7 days)
          const ipRaw = await AsyncStorage.getItem('snap_map_ip_loc:v1');
          if (ipRaw) {
            try {
              const cached = JSON.parse(ipRaw);
              if (cached && Number.isFinite(cached.lat) && Number.isFinite(cached.lng)
                  && (Date.now() - (cached.ts || 0)) < 7 * 24 * 3600 * 1000) {
                if (alive) {
                  setIpLocation({ lat: cached.lat, lng: cached.lng, city: cached.city, source: cached.source });
                  setUsingIpFallback(true);
                }
              }
            } catch {}
          }
          // b) live IP geolocate via backend (if no cache or expired)
          if (!ipRaw) {
            try {
              const r = await api.geoLocateIp?.();
              if (alive && r?.success && r.data && Number.isFinite(r.data.lat) && Number.isFinite(r.data.lng)) {
                const payload = { lat: r.data.lat, lng: r.data.lng, city: r.data.city, source: r.data.source, ts: Date.now() };
                setIpLocation(payload);
                setUsingIpFallback(true);
                try { await AsyncStorage.setItem('snap_map_ip_loc:v1', JSON.stringify(payload)); } catch {}
              }
            } catch {}
          }
        } catch {}
      }

      try {
        const r = await api.friendsMapShares?.();
        if (alive && r?.success && r.data) {
          setShares(Array.isArray(r.data.shares) ? r.data.shares : []);
        }
      } catch {}
      try {
        const g = await api.friendLocationGrants?.();
        if (alive && g?.success && g.data) {
          setPendingReqs(g.data.pending_incoming || []);
        }
      } catch {}
      if (alive) setLoading(false);
    };
    load();
    const t1 = setInterval(load, 30000); // 30s poll fallback
    return () => { alive = false; clearInterval(t1); };
  }, []);

  // ── WS live patches ────────────────────────────────────────────────
  // Subscribes to two events:
  //   - location_update: patch one pin without re-rendering the whole
  //     map (avatars + tile stay; only the affected marker moves).
  //   - location_share_revoked: drop the pin immediately (privacy).
  useEffect(() => {
    if (!mailWs?.on) return;
    const subUpdate = mailWs.on('location_update', (data) => {
      if (!data || !data.sharer_email) return;
      setShares((prev) => {
        const i = prev.findIndex((p) => (p.email || '').toLowerCase() === data.sharer_email.toLowerCase());
        // Stamp in the SAME shape the poll returns ("YYYY-MM-DD HH:MM:SS",
        // implicitly UTC) so ago()/pinsPayload — which parse via
        // `.replace(' ','T') + 'Z'` — read it correctly. Using
        // toISOString() here would produce "...Z" and the parser would
        // append a 2nd Z → Invalid Date → the freshness badge silently
        // vanishes on exactly the live-WS-update path. wsUtcStamp() avoids that.
        const patched = { ...(i >= 0 ? prev[i] : {}), ...data, email: data.sharer_email, updated_at: wsUtcStamp() };
        if (i >= 0) {
          const next = prev.slice();
          next[i] = patched;
          return next;
        }
        // New sharer appeared (just granted to me). Pin will show after
        // the next poll fetches the grant join; in the meantime we can
        // optimistically inject if we have lat/lng.
        if (Number.isFinite(data.latitude) && Number.isFinite(data.longitude)) {
          return [patched, ...prev];
        }
        return prev;
      });
    });
    const subRevoke = mailWs.on('location_share_revoked', (data) => {
      if (!data?.sharer_email) return;
      setShares((prev) => prev.filter((p) => (p.email || '').toLowerCase() !== data.sharer_email.toLowerCase()));
    });
    const subReq = mailWs.on('location_share_request', (data) => {
      if (!data?.requester_email) return;
      setPendingReqs((prev) => {
        if (prev.find((r) => r.email === data.requester_email)) return prev;
        return [{ email: data.requester_email, name: data.requester_name, message: data.message }, ...prev];
      });
    });
    return () => {
      try { subUpdate?.(); } catch {}
      try { subRevoke?.(); } catch {}
      try { subReq?.(); } catch {}
    };
  }, []);

  // [WAVE 49 2026-05-21 snap-map-disconnect-fix]
  // AppState foreground re-sync. The other half of the "disconnect" bug:
  // when the user backgrounds the app, JS timers freeze (30s poll dies) AND
  // WS bridge tears down on most OSes after ~60s. Without this listener,
  // returning to the foreground left the map showing the same shares from
  // 10min ago — peers who had stopped sharing meanwhile still showed pins,
  // and new sharers were missing. Tap-the-app-icon → screen surfaced with
  // a snapshot of the past, looking like "everything desyncs".
  //
  // Fix: on every active→foreground transition, force-refresh shares +
  // grants. The WS layer will auto-reconnect on its own; this just bridges
  // the gap until that completes.
  useEffect(() => {
    let lastState = AppState.currentState;
    const sub = AppState.addEventListener('change', (next) => {
      const wasInactive = lastState !== 'active';
      lastState = next;
      if (next === 'active' && wasInactive) {
        // Fire-and-forget; the API helper already swallows errors.
        try { refreshShares(); } catch {}
      }
    });
    return () => { try { sub?.remove?.(); } catch {} };
  }, [refreshShares]);

  // Center: prefer my GPS; cached last-known location; first friend's pin; final fallback Brazil center (not Brasília specifically).
  // [WAVE 65 2026-05-21] Read sync cached last-known location from AsyncStorage
  // (set every time we obtain a fresh fix) so cold-start paints near the user
  // instead of Brasília while expo-location warms up.
  const [cachedHomeLoc, setCachedHomeLoc] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        const raw = await AsyncStorage.getItem('snap_map_last_loc:v1');
        if (alive && raw) {
          const parsed = JSON.parse(raw);
          if (parsed && Number.isFinite(parsed.lat) && Number.isFinite(parsed.lng)) setCachedHomeLoc(parsed);
        }
      } catch {}
    })();
    return () => { alive = false; };
  }, []);
  // Persist every fresh fix so next cold-start has a near-real seed.
  useEffect(() => {
    if (myLocation && Number.isFinite(myLocation.lat) && Number.isFinite(myLocation.lng)) {
      try {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        AsyncStorage.setItem('snap_map_last_loc:v1', JSON.stringify({ lat: myLocation.lat, lng: myLocation.lng, ts: Date.now() })).catch(() => {});
      } catch {}
    }
  }, [myLocation?.lat, myLocation?.lng]);
  // First paint: prefer fresh GPS → cached last-known → IP geo → first
  // friend's pin → Brazil-centroid fallback.
  // [WAVE 69 2026-05-21] Inserted IP geo step between cache and friend-pin
  // because a brand-new user (no GPS perm yet, no cached fix) was seeing
  // Cuiabá. IP geo gives city-precision before GPS warms up.
  // After mount, panning is preserved (we don't re-center on every update).
  const initialCenter = useMemo(() => {
    if (myLocation) return myLocation;
    if (cachedHomeLoc) return cachedHomeLoc;
    if (ipLocation && Number.isFinite(ipLocation.lat)) return { lat: ipLocation.lat, lng: ipLocation.lng };
    if (shares[0] && Number.isFinite(shares[0].latitude)) return { lat: shares[0].latitude, lng: shares[0].longitude };
    return { lat: -14.235, lng: -51.925 }; // Brazil geographic centroid (Cuiabá-ish) — neutral, not Brasília
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cachedHomeLoc ? 1 : 0, ipLocation ? 1 : 0]);   // re-seed once when cache OR ip-loc loads

  // [WAVE 49 2026-05-21] Apply the filter pill before computing the pin
  // payload. We compute it here (vs inside pinsPayload) so the list panel
  // below also reflects the same filter — visual + tabular states stay in
  // lockstep.
  const filteredShares = useMemo(() => {
    if (filter === 'all') return shares;
    return shares.filter((s) => {
      if (filter === 'nearby') {
        if (!myLocation) return false;
        const lat = Number(s.latitude), lng = Number(s.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
        const d = haversineMeters(myLocation.lat, myLocation.lng, lat, lng);
        return d !== null && d <= 5000;
      }
      if (filter === 'live') {
        // "live" = last update within 2min — the same threshold the pin
        // uses to flip into the stale state below. This way 'live' filter
        // shows exactly the green/purple non-stale pins.
        if (!s.updated_at) return false;
        let ts = 0;
        try { ts = new Date(s.updated_at.replace(' ', 'T') + 'Z').getTime(); } catch {}
        if (!ts) return false;
        return (nowTick - ts) < 2 * 60 * 1000;
      }
      if (filter === 'always') return !!s.is_unlimited;
      return true;
    });
  }, [shares, filter, myLocation, nowTick]);

  // Build the pin payload the WebView understands. avatar_url is the
  // backend's /get_avatar endpoint so the map shows the friend's actual
  // profile photo instead of just initials.
  //
  // is_stale + ago_label power the new stale visual state in the WebView
  // pin (gray ring + red "há Xh" badge) — telling the user at a glance
  // that the share is alive on the backend but hasn't sent a fresh tick
  // recently. This is the user-facing answer to "ta desconectando": the
  // pin stays visible with an explicit "stale" UI instead of vanishing.
  const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2min without a tick → stale
  const pinsPayload = useMemo(() => (
    filteredShares
      .filter((s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude))
      .map((s) => {
        let ageMs = null;
        if (s.updated_at) {
          try {
            const ts = new Date(s.updated_at.replace(' ', 'T') + 'Z').getTime();
            if (ts) ageMs = Math.max(0, nowTick - ts);
          } catch {}
        }
        const isStale = ageMs !== null && ageMs > STALE_THRESHOLD_MS;
        return {
          email: s.email,
          name: s.name || s.email?.split('@')[0] || '',
          lat: Number(s.latitude),
          lng: Number(s.longitude),
          is_unlimited: !!s.is_unlimited,
          is_stale: isStale,
          ago_label: ageMs !== null ? ago(s.updated_at) : '',
          avatar_url: s.email ? getAvatarUrlForEmail(s.email) : null,
        };
      })
  ), [filteredShares, nowTick]);

  // [7181 fix 2026-05-22] Wake stale sharers. When iOS sleeps a friend's
  // app or Android force-stops it, the location row sits frozen in PG and
  // we render a "Sem atualização há 23h" badge. Fire a silent push to the
  // sharer so their app wakes, re-runs getCurrentPosition, and posts a
  // fresh chat_update_live_location — receiver's map then updates real-time
  // via WS broadcast. Frontend throttles 90s per (sharer) to avoid burning
  // APNs background quota. Backend has a 60s server-side throttle too.
  const lastPingedRef = useRef({});
  useEffect(() => {
    const STALE_PING_MS = 5 * 60 * 1000; // wake after 5min of silence
    const COOLDOWN_MS = 90 * 1000;
    const now = Date.now();
    pinsPayload.forEach((p) => {
      if (!p.is_stale || !p.email) return;
      // Skip pinging self (you can't wake your own app from your own app).
      if (user?.email && p.email.toLowerCase() === user.email.toLowerCase()) return;
      // Re-derive age from updated_at since pinsPayload only kept ago_label.
      const share = filteredShares.find((s) => s.email === p.email);
      if (!share?.updated_at) return;
      let ageMs = 0;
      try { ageMs = now - new Date(share.updated_at.replace(' ', 'T') + 'Z').getTime(); } catch { return; }
      if (ageMs < STALE_PING_MS) return;
      const last = lastPingedRef.current[p.email] || 0;
      if (now - last < COOLDOWN_MS) return;
      lastPingedRef.current[p.email] = now;
      // Fire-and-forget; backend handles throttle + grant check.
      api.friendLocationPing(p.email).catch(() => {});
    });
  }, [pinsPayload, filteredShares, user]);

  // [2026-05-26 stale-pin foreground nudge] The effect above only fires the
  // wake-ping when a pin crosses the 5min stale threshold *while the app is
  // foregrounded and the poll is ticking*. But JS timers freeze in the
  // background, so a pin that went stale overnight (e.g. "sem atualização há
  // 23h") never gets nudged when the user re-opens the map — it just sits
  // there gray. On every active→foreground transition, walk the current
  // shares and ping any pin older than 10min so the sharer's app gets a
  // chance to wake and post a fresh fix. Same per-sharer cooldown ref as the
  // poll-driven path so we don't double-ping. We read shares from a ref so
  // this listener isn't torn down/recreated on every shares update.
  const sharesForPingRef = useRef(filteredShares);
  sharesForPingRef.current = filteredShares;
  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    const RESUME_STALE_MS = 10 * 60 * 1000; // 10min
    const COOLDOWN_MS = 90 * 1000;
    let lastState = AppState.currentState;
    const sub = AppState.addEventListener('change', (next) => {
      const wasInactive = lastState !== 'active';
      lastState = next;
      if (next !== 'active' || !wasInactive) return;
      const now = Date.now();
      (sharesForPingRef.current || []).forEach((s) => {
        if (!s?.email) return;
        if (user?.email && s.email.toLowerCase() === user.email.toLowerCase()) return;
        if (!s.updated_at) return;
        let ageMs = 0;
        try { ageMs = now - new Date(String(s.updated_at).replace(' ', 'T') + 'Z').getTime(); } catch { return; }
        if (ageMs < RESUME_STALE_MS) return;
        const last = lastPingedRef.current[s.email] || 0;
        if (now - last < COOLDOWN_MS) return;
        lastPingedRef.current[s.email] = now;
        api.friendLocationPing(s.email).catch(() => {});
      });
    });
    return () => { try { sub?.remove?.(); } catch {} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const mePayload = useMemo(() => (
    myLocation ? { lat: myLocation.lat, lng: myLocation.lng } : null
  ), [myLocation]);

  // HTML built once per mount. We avoid rebuilding on state change
  // because rebuilding the `source.html` would tear down the WebView
  // and remount MapLibre from scratch (slow, jittery, loses user
  // pan/zoom). All pin/me updates flow through injectJavaScript.
  const mapHtml = useMemo(() => buildMapHtml({
    center: initialCenter,
    zoom: DEFAULT_ZOOM,
    isDark,
    initialPins: pinsPayload,
    initialMe: mePayload,
  }), [initialCenter, isDark]);  // eslint-disable-line react-hooks/exhaustive-deps

  // WebView refs — native uses ref.injectJavaScript, web posts to iframe.
  const webRef = useRef(null);
  const iframeRef = useRef(null);
  const mapReadyRef = useRef(false);

  // Push updates to the map without remounting. `__pendingPins` queue
  // is needed because shares can land BEFORE the map's tiles finish
  // loading — we flush on `map_ready`.
  const pendingPinsRef = useRef(null);
  const pendingMeRef = useRef(null);

  const pushToMap = useCallback((msg) => {
    const raw = JSON.stringify(msg);
    if (Platform.OS === 'web') {
      try { iframeRef.current?.contentWindow?.postMessage({ raw }, '*'); } catch {}
    } else {
      // Wrap in try/catch — if the WebView is mid-reload the call throws.
      const js = `try{window.RNbridge(${JSON.stringify(raw)});}catch(e){};true;`;
      try { webRef.current?.injectJavaScript(js); } catch {}
    }
  }, []);

  useEffect(() => {
    if (!mapReadyRef.current) { pendingPinsRef.current = pinsPayload; return; }
    pushToMap({ type: 'pins', pins: pinsPayload });
  }, [pinsPayload, pushToMap]);
  useEffect(() => {
    if (!mapReadyRef.current) { pendingMeRef.current = mePayload; return; }
    pushToMap({ type: 'me', me: mePayload });
  }, [mePayload, pushToMap]);

  // [WAVE 69 2026-05-21] Pan to IP-fallback location when it arrives AFTER
  // the map already mounted. initialCenter only seeds the HTML — without
  // this, a user who opens snap-map with no GPS sees Brazil-centroid for
  // ~300-1500ms (until the backend round-trip resolves) before the map
  // would otherwise stay frozen on Brazil. We pan once, gently, and only
  // if the user hasn't already received a real GPS fix.
  const ipPannedRef = useRef(false);
  useEffect(() => {
    if (ipPannedRef.current) return;
    if (!ipLocation || !Number.isFinite(ipLocation.lat) || !Number.isFinite(ipLocation.lng)) return;
    if (myLocation || cachedHomeLoc) return; // GPS won — don't override.
    if (!mapReadyRef.current) return;
    ipPannedRef.current = true;
    pushToMap({ type: 'pan', lat: ipLocation.lat, lng: ipLocation.lng });
  }, [ipLocation, myLocation, cachedHomeLoc, pushToMap]);

  // Bridge messages from the WebView (pin tap → open bottom sheet,
  // map_ready → flush pending pins + dismiss loading spinner).
  const onWebMessage = useCallback((raw) => {
    try {
      const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (msg.type === 'map_ready') {
        mapReadyRef.current = true;
        if (pendingPinsRef.current) {
          pushToMap({ type: 'pins', pins: pendingPinsRef.current });
          pendingPinsRef.current = null;
        }
        if (pendingMeRef.current) {
          pushToMap({ type: 'me', me: pendingMeRef.current });
          pendingMeRef.current = null;
        }
      } else if (msg.type === 'pin_tap') {
        const found = sharesRef.current.find((s) => (s.email || '').toLowerCase() === (msg.email || '').toLowerCase());
        if (found) setSelected(found);
      }
    } catch {}
  }, [pushToMap]);

  // Web: window message bridge from iframe. Native uses WebView.onMessage.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const handler = (ev) => {
      if (!ev || ev.source !== iframeRef.current?.contentWindow) return;
      onWebMessage(ev.data);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onWebMessage]);

  // ── Pending request handling ───────────────────────────────────────
  const respondToRequest = (req, accept) => {
    if (accept) {
      Alert.alert(
        t?.('snapmap.acceptTitle') || 'Compartilhar localização',
        (t?.('snapmap.acceptBody') || 'Por quanto tempo compartilhar com {name}?').replace('{name}', req.name || req.email),
        [
          { text: '1 hora', onPress: () => doAccept(req.email, 3600) },
          { text: '8 horas', onPress: () => doAccept(req.email, 8 * 3600) },
          { text: 'Sempre', onPress: () => doAccept(req.email, -1), style: 'destructive' },
          { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
        ],
      );
    } else {
      api.friendLocationDecline?.(req.email).catch(() => {});
      setPendingReqs((prev) => prev.filter((r) => r.email !== req.email));
    }
  };
  const doAccept = async (email, dur) => {
    try {
      await api.friendLocationAccept?.(email, dur);
    } catch {}
    setPendingReqs((prev) => prev.filter((r) => r.email !== email));
  };

  const openGrants = async () => {
    setGrantsOpen(true);
    try {
      const g = await api.friendLocationGrants?.();
      if (g?.success && g.data) setGrantsData(g.data);
    } catch {}
  };

  const revokeGrant = async (email) => {
    Alert.alert(
      t?.('snapmap.revokeTitle') || 'Cancelar compartilhamento',
      (t?.('snapmap.revokeBody') || 'Parar de compartilhar localização com {name}?').replace('{name}', email),
      [
        { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
        {
          text: t?.('snapmap.revoke') || 'Cancelar',
          style: 'destructive',
          onPress: async () => {
            try { await api.friendLocationRevoke?.(email); } catch {}
            const g = await api.friendLocationGrants?.().catch(() => null);
            if (g?.success) setGrantsData(g.data);
          },
        },
      ],
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: isDark ? '#0d0d0d' : '#fff' }}>
      {/* Header — title + ghost-mode toggle + privacy shortcut.
          [WAVE 49 2026-05-21] The subtitle now surfaces TWO pieces of state:
          (1) the count of friends currently visible to me, and (2) my own
          ghost-mode status. Users had no way to tell at a glance whether
          they were broadcasting, which directly fed the "ta desconectando"
          confusion (you can't tell if YOU stopped showing up to them). */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: topInset + 8, paddingBottom: 14, backgroundColor: isDark ? '#0d0d0d' : '#fff', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)', zIndex: 10 }}>
        <TouchableOpacity onPress={() => router.back()} style={{ padding: 8 }} accessibilityLabel="Voltar">
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 8 }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>
            {t?.('snapmap.title') || 'Amigos no Mapa'}
          </Text>
          <Text style={{ fontSize: 12, color: ghostMode ? '#f59e0b' : colors.textSecondary, marginTop: 2 }}>
            {ghostMode
              ? (t?.('snapmap.ghostStatus') || 'Modo invisível — ninguém te vê')
              : `${shares.length} ${shares.length === 1 ? (t?.('snapmap.sharingNowOne') || 'compartilhando agora') : (t?.('snapmap.sharingNow') || 'compartilhando agora')}`}
          </Text>
        </View>
        <TouchableOpacity
          onPress={toggleGhostMode}
          style={{
            padding: 8,
            borderRadius: 14,
            backgroundColor: ghostMode ? 'rgba(245,158,11,0.18)' : 'transparent',
            marginRight: 4,
          }}
          accessibilityLabel={ghostMode ? (t?.('snapmap.ghostOff') || 'Sair do modo invisível') : (t?.('snapmap.ghostOn') || 'Modo invisível')}
        >
          <IconEyeOff size={20} color={ghostMode ? '#f59e0b' : colors.text} />
        </TouchableOpacity>
        <TouchableOpacity onPress={openGrants} style={{ padding: 8 }} accessibilityLabel="Privacidade">
          <IconUser size={22} color={colors.text} />
        </TouchableOpacity>
      </View>

      {/* [WAVE 49] Filter pills — horizontal scrollable row of Snapchat-style
          chips. Active filter has accent fill, inactive has subtle surface.
          We only render this when there are >=2 shares so single-friend or
          empty screens stay clean. */}
      {shares.length >= 2 && (
        <View style={{ backgroundColor: isDark ? '#0d0d0d' : '#fff', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 4 }}>
            {[
              { id: 'all', label: t?.('snapmap.filterAll') || 'Todos', icon: null },
              { id: 'live', label: t?.('snapmap.filterLive') || 'Ao vivo', icon: 'live' },
              { id: 'nearby', label: t?.('snapmap.filterNearby') || 'Próximos', icon: null },
              { id: 'always', label: t?.('snapmap.filterAlways') || 'Sempre ativo', icon: null },
            ].map((p) => {
              const active = filter === p.id;
              return (
                <TouchableOpacity
                  key={p.id}
                  onPress={() => setFilter(p.id)}
                  style={{
                    paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16,
                    backgroundColor: active ? '#7C3AED' : (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)'),
                    flexDirection: 'row', alignItems: 'center', gap: 6,
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  {p.icon === 'live' && (
                    <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: active ? '#fff' : '#22c55e' }} />
                  )}
                  <Text style={{ color: active ? '#fff' : colors.text, fontSize: 12, fontWeight: '700' }}>
                    {p.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* [WAVE 49] Active sessions chip — shows when I'M actively sharing
          OUT to people. Tapping opens the grants modal where I can revoke
          individual sessions. The chip pulls from grantsData (lazy-loaded);
          if it's not loaded yet we fetch it on mount via the same effect
          that populates pendingReqs. Hidden when ghostMode is on (then the
          ghost banner above already tells the story). */}
      <ActiveSessionsChip
        grantsData={grantsData}
        isDark={isDark}
        colors={colors}
        t={t}
        ghostMode={ghostMode}
        onOpen={openGrants}
        onLoad={async () => {
          try {
            const g = await api.friendLocationGrants?.();
            if (g?.success && g.data) setGrantsData(g.data);
          } catch {}
        }}
      />

      {/* Pending-request banner */}
      {pendingReqs.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 90 }} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8, gap: 8 }}>
          {pendingReqs.map((r) => (
            <View key={r.email} style={{
              backgroundColor: isDark ? '#1a1a1a' : '#f3f4f6',
              borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10,
              flexDirection: 'row', alignItems: 'center', gap: 10,
              borderWidth: 1, borderColor: '#7C3AED',
            }}>
              <AvatarCircle name={r.name || r.email} email={r.email} size={32} />
              <View style={{ maxWidth: 160 }}>
                <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }} numberOfLines={1}>
                  {r.name || r.email}
                </Text>
                <Text style={{ color: colors.textSecondary, fontSize: 11 }} numberOfLines={1}>
                  {t?.('snapmap.wantsToSee') || 'Quer ver sua localização'}
                </Text>
              </View>
              <TouchableOpacity onPress={() => respondToRequest(r, true)} style={{ backgroundColor: '#7C3AED', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14 }}>
                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>{t?.('common.accept') || 'Aceitar'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => respondToRequest(r, false)} style={{ padding: 6 }}>
                <IconX size={18} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      )}

      {/* Map — MapLibre GL JS (BoraUm self-hosted OSM tiles) inside the
          WebView/iframe. Tap on a pin posts `pin_tap` back to RN which opens
          the bottom sheet below. Real pan/zoom comes for free; we keep the
          loading + empty overlays absolutely-positioned on top of the WebView. */}
      <View style={{ flex: 1, position: 'relative', backgroundColor: isDark ? '#1a1a1a' : '#e5e7eb' }}>
        {Platform.OS === 'web' ? (
          <iframe
            ref={iframeRef}
            srcDoc={mapHtml}
            style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
            allow="geolocation"
            title="snap-map"
          />
        ) : (
          <WebView
            ref={webRef}
            source={{ html: mapHtml, baseUrl: 'https://chatyy.com.br/' }}
            originWhitelist={['*']}
            javaScriptEnabled
            domStorageEnabled
            allowsInlineMediaPlayback
            mixedContentMode="always"
            onMessage={(ev) => onWebMessage(ev?.nativeEvent?.data)}
            style={{ flex: 1, backgroundColor: isDark ? '#0d0d0d' : '#e5e7eb' }}
          />
        )}

        {/* Loading badge */}
        {loading && (
          <View style={{ position: 'absolute', top: 14, alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.7)', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ActivityIndicator size="small" color="#fff" />
            <Text style={{ color: '#fff', fontSize: 13 }}>{t?.('common.loading') || 'Carregando…'}</Text>
          </View>
        )}

        {/* [WAVE 69 2026-05-21] Location-permission banner.
            Surfaces a clear CTA when we couldn't get GPS — either because
            the user denied permission or because the OS hasn't returned a
            fix yet but we're using the IP fallback. Without this banner
            the user sees a map centered on their (approximate) city and
            has no idea WHY it's not pinpoint-accurate. The CTA opens app
            settings on a denied state; on the fallback state it asks the
            OS for permission. */}
        {!myLocation && (permissionDenied || usingIpFallback) && (
          <View pointerEvents="box-none" style={{ position: 'absolute', top: 14, left: 12, right: 12, alignItems: 'center' }}>
            <View style={{
              flexDirection: 'row', alignItems: 'center', gap: 10,
              backgroundColor: 'rgba(0,0,0,0.82)',
              paddingHorizontal: 14, paddingVertical: 10,
              borderRadius: 14, maxWidth: 460,
              shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 8,
              shadowOffset: { width: 0, height: 4 }, elevation: 5,
            }}>
              <IconMapPin size={18} color="#fbbf24" />
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }} numberOfLines={1}>
                  {permissionDenied
                    ? (t?.('snapmap.locationDenied') || 'Localização desativada')
                    : (t?.('snapmap.locationFromIp') || 'Mostrando localização aproximada')}
                </Text>
                <Text style={{ color: 'rgba(255,255,255,0.78)', fontSize: 11, marginTop: 1 }} numberOfLines={2}>
                  {permissionDenied
                    ? (t?.('snapmap.locationDeniedHint') || 'Ative pra ver amigos perto de você')
                    : (ipLocation?.city
                        ? `~ ${ipLocation.city}`
                        : (t?.('snapmap.locationFromIpHint') || 'Toque pra usar GPS preciso'))}
                </Text>
              </View>
              <TouchableOpacity
                onPress={async () => {
                  if (permissionDenied) {
                    try { Linking.openSettings(); } catch {}
                  } else if (Platform.OS !== 'web') {
                    try {
                      const Location = require('expo-location');
                      const { status } = await Location.requestForegroundPermissionsAsync();
                      if (status === 'granted') {
                        setPermissionDenied(false);
                        try {
                          const fresh = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
                          if (fresh?.coords) setMyLocation({ lat: fresh.coords.latitude, lng: fresh.coords.longitude });
                        } catch {}
                      } else {
                        setPermissionDenied(true);
                      }
                    } catch {}
                  } else if (typeof navigator !== 'undefined' && navigator.geolocation) {
                    navigator.geolocation.getCurrentPosition(
                      (pos) => setMyLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
                      () => setPermissionDenied(true),
                      { maximumAge: 0, timeout: 8000 },
                    );
                  }
                }}
                style={{
                  paddingHorizontal: 12, paddingVertical: 7,
                  borderRadius: 14,
                  backgroundColor: '#22c55e',
                }}
                accessibilityLabel={t?.('snapmap.enableLocation') || 'Ativar localização'}
              >
                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>
                  {t?.('snapmap.enableLocation') || 'Ativar'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* "Centralize-me" FAB — WhatsApp/Maps-style. Pan/zooms the map to
            the user's current GPS. Pulls a fresh fix on tap so even if the
            initial reading was stale the user gets the latest location. */}
        {myLocation && (
          <TouchableOpacity
            onPress={async () => {
              try {
                let target = myLocation;
                if (Platform.OS !== 'web') {
                  try {
                    const Location = require('expo-location');
                    const fresh = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
                    if (fresh?.coords) {
                      target = { lat: fresh.coords.latitude, lng: fresh.coords.longitude };
                      setMyLocation(target);
                    }
                  } catch {}
                }
                pushToMap({ type: 'pan', lat: target.lat, lng: target.lng });
              } catch {}
            }}
            style={{
              position: 'absolute', right: 16, bottom: 24,
              width: 52, height: 52, borderRadius: 26,
              backgroundColor: colors.surface,
              alignItems: 'center', justifyContent: 'center',
              shadowColor: '#000', shadowOpacity: 0.25,
              shadowRadius: 8, shadowOffset: { width: 0, height: 4 },
              elevation: 6,
              borderWidth: 1, borderColor: colors.border || 'rgba(0,0,0,0.08)',
            }}
            accessibilityLabel={t?.('snapmap.centerOnMe') || 'Minha localização'}
          >
            <IconNavigation size={22} color={colors.primary} />
          </TouchableOpacity>
        )}

        {/* Empty state */}
        {!loading && shares.length === 0 && (
          <View pointerEvents="box-none" style={{ position: 'absolute', top: 60, left: 0, right: 0, alignItems: 'center' }}>
            <View style={{ backgroundColor: 'rgba(0,0,0,0.78)', padding: 22, borderRadius: 18, maxWidth: 320, marginHorizontal: 16 }}>
              <IconMapPin size={36} color="#fff" style={{ alignSelf: 'center' }} />
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700', textAlign: 'center', marginTop: 12 }}>
                {t?.('snapmap.empty') || 'Nenhum amigo dividindo localização'}
              </Text>
              <Text style={{ color: 'rgba(255,255,255,0.82)', fontSize: 13, textAlign: 'center', marginTop: 6, lineHeight: 18 }}>
                {t?.('snapmap.emptyHint') || 'Peça pra um amigo no chat compartilhar a localização ao vivo, ou ative o seu para eles te verem aqui.'}
              </Text>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 14, alignSelf: 'center' }}>
                <TouchableOpacity
                  onPress={refreshShares}
                  style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.16)' }}
                  accessibilityLabel={t?.('common.refresh') || 'Atualizar'}
                >
                  <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>
                    {refreshing ? '…' : (t?.('common.refresh') || 'Atualizar')}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => router.push('/chat-new')}
                  style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, backgroundColor: '#7C3AED' }}
                  accessibilityLabel={t?.('snapmap.inviteFriend') || 'Convidar amigo'}
                >
                  <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>
                    {t?.('snapmap.inviteFriend') || 'Convidar amigo'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}

        {/* Apple Find-My-style friends list panel —
            Bottom-pinned sheet that lists every friend currently sharing
            with avatar + name + "há Xmin" + distance. Two states:
              - peek (default): ~110px showing horizontal avatar strip + count
              - expanded: ~55% of screen, vertical list, scrollable
            Tap a row → pan map to that friend + open the action sheet
            (same handler as tapping their pin). Pull-to-refresh in the
            expanded list triggers a full reload of shares + grants.
            Hidden entirely when shares.length === 0 — the empty-state
            cloud above stays in charge of the "no one is sharing" UI. */}
        {shares.length > 0 && (
          <View
            pointerEvents="box-none"
            style={{
              position: 'absolute', left: 0, right: 0, bottom: 0,
              maxHeight: listExpanded ? SH * 0.6 : 130,
              backgroundColor: isDark ? '#0d0d0d' : '#fff',
              borderTopLeftRadius: 22, borderTopRightRadius: 22,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)',
              shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 12, shadowOffset: { width: 0, height: -3 },
              elevation: 12,
            }}
          >
            {/* Drag handle + tap-to-toggle header — handle has a 36×4 pill
                like Apple's sheets, and the whole header is a Pressable so
                tap anywhere in the row toggles expand. Title shows
                "N amigos ao vivo" so users know what they're seeing
                without expanding. */}
            <Pressable
              onPress={() => setListExpanded((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel={listExpanded ? (t?.('snapmap.collapseList') || 'Recolher lista') : (t?.('snapmap.expandList') || 'Expandir lista')}
              style={{ paddingTop: 8, paddingBottom: 6, alignItems: 'center' }}
            >
              <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: isDark ? 'rgba(255,255,255,0.30)' : 'rgba(0,0,0,0.18)' }} />
              <View style={{ flexDirection: 'row', alignItems: 'center', width: '100%', paddingHorizontal: 16, marginTop: 6 }}>
                <Text style={{ flex: 1, color: colors.text, fontSize: 15, fontWeight: '700' }}>
                  {shares.length === 1
                    ? (t?.('snapmap.oneFriendLive') || '1 amigo ao vivo')
                    : (t?.('snapmap.friendsLive') || '{n} amigos ao vivo').replace('{n}', shares.length)}
                </Text>
                <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                  {listExpanded ? (t?.('snapmap.tapToCollapse') || 'Recolher') : (t?.('snapmap.tapToExpand') || 'Ver todos')}
                </Text>
              </View>
            </Pressable>

            {/* Peek view (collapsed): horizontal avatar strip. Tap to pan
                + open action sheet, just like tapping the pin on the map. */}
            {!listExpanded && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 4, paddingBottom: 14, gap: 14 }}
              >
                {shares.map((s) => {
                  const dist = myLocation && Number.isFinite(s.latitude) && Number.isFinite(s.longitude)
                    ? haversineMeters(myLocation.lat, myLocation.lng, Number(s.latitude), Number(s.longitude))
                    : null;
                  return (
                    <TouchableOpacity
                      key={'peek-' + s.email}
                      onPress={() => {
                        if (Number.isFinite(s.latitude) && Number.isFinite(s.longitude)) {
                          pushToMap({ type: 'pan', lat: Number(s.latitude), lng: Number(s.longitude) });
                        }
                        setSelected(s);
                      }}
                      style={{ alignItems: 'center', width: 72 }}
                      accessibilityLabel={`${s.name || s.email}, ${ago(s.updated_at)}`}
                    >
                      <View style={{ borderWidth: 2, borderColor: s.is_unlimited ? '#7C3AED' : '#22c55e', borderRadius: 30, padding: 2 }}>
                        <AvatarCircle name={s.name || s.email} email={s.email} size={50} />
                      </View>
                      <Text numberOfLines={1} style={{ color: colors.text, fontSize: 11, fontWeight: '600', marginTop: 4, maxWidth: 70, textAlign: 'center' }}>
                        {(s.name || s.email?.split('@')[0] || '').split(' ')[0]}
                      </Text>
                      <Text numberOfLines={1} style={{ color: colors.textSecondary, fontSize: 10, maxWidth: 70, textAlign: 'center' }}>
                        {dist !== null ? formatDistance(dist) : ago(s.updated_at)}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}

            {/* Expanded list view — vertical FlatList-style rows with
                avatar/name/distance/last-update. Pull-down to refresh
                via the inline chip (RN's RefreshControl needs a
                ScrollView/FlatList in vertical mode which fights the
                bottom-sheet height clamp on web). */}
            {listExpanded && (
              <ScrollView
                style={{ maxHeight: SH * 0.55 }}
                contentContainerStyle={{ paddingBottom: 24 }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 16, paddingVertical: 4 }}>
                  <TouchableOpacity
                    onPress={refreshShares}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }}
                    accessibilityLabel={t?.('common.refresh') || 'Atualizar'}
                  >
                    {refreshing ? <ActivityIndicator size="small" color={colors.primary} /> : null}
                    <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '700' }}>
                      {t?.('common.refresh') || 'Atualizar'}
                    </Text>
                  </TouchableOpacity>
                </View>
                {shares.map((s) => {
                  const dist = myLocation && Number.isFinite(s.latitude) && Number.isFinite(s.longitude)
                    ? haversineMeters(myLocation.lat, myLocation.lng, Number(s.latitude), Number(s.longitude))
                    : null;
                  return (
                    <TouchableOpacity
                      key={'row-' + s.email}
                      onPress={() => {
                        if (Number.isFinite(s.latitude) && Number.isFinite(s.longitude)) {
                          pushToMap({ type: 'pan', lat: Number(s.latitude), lng: Number(s.longitude) });
                        }
                        setSelected(s);
                        setListExpanded(false);
                      }}
                      style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 12 }}
                      accessibilityRole="button"
                    >
                      <View style={{ borderWidth: 2, borderColor: s.is_unlimited ? '#7C3AED' : '#22c55e', borderRadius: 28, padding: 2 }}>
                        <AvatarCircle name={s.name || s.email} email={s.email} size={46} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text numberOfLines={1} style={{ color: colors.text, fontSize: 15, fontWeight: '700' }}>
                          {s.name || s.email}
                        </Text>
                        <Text numberOfLines={1} style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                          {ago(s.updated_at)}
                          {s.is_unlimited ? ` · ∞ ${t?.('snapmap.alwaysOn') || 'sempre ativo'}` : ''}
                        </Text>
                      </View>
                      {dist !== null && (
                        <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }}>
                          <Text style={{ color: colors.text, fontSize: 12, fontWeight: '700' }}>
                            {formatDistance(dist)}
                          </Text>
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                })}
                {/* Spacer + manage privacy CTA so the user can reach the
                    grants modal even with the panel expanded. */}
                <TouchableOpacity
                  onPress={() => { setListExpanded(false); openGrants(); }}
                  style={{ marginTop: 6, marginHorizontal: 16, paddingVertical: 12, borderRadius: 14, alignItems: 'center', backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }}
                >
                  <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '700' }}>
                    {t?.('snapmap.managePrivacy') || 'Gerenciar privacidade'}
                  </Text>
                </TouchableOpacity>
              </ScrollView>
            )}
          </View>
        )}
      </View>

      {/* Pin bottom-sheet — "what can I do with this friend" */}
      <Modal visible={!!selected} transparent animationType="slide" onRequestClose={() => setSelected(null)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' }} onPress={() => setSelected(null)}>
          <View style={{ flex: 1 }} />
          <Pressable onPress={(e) => e.stopPropagation?.()} style={{ backgroundColor: colors.surface, padding: 22, borderTopLeftRadius: 24, borderTopRightRadius: 24 }}>
            {selected && (() => {
              // [WAVE 49 2026-05-21] Compute freshness for the bottom sheet
              // so the "Atualizado há Xmin" line can flip into a red
              // staleness warning when the peer hasn't ticked in a while.
              // This is the explicit answer to the user's "ta
              // desconectando" feedback at the bottom-sheet level: instead
              // of the pin silently vanishing, the user now SEES a
              // "Sem atualização há Xh" red label and understands the
              // share is alive but the peer hasn't moved/heartbeat'd.
              let ageMs = null;
              if (selected.updated_at) {
                try { ageMs = Math.max(0, nowTick - new Date(String(selected.updated_at).replace(' ', 'T') + 'Z').getTime()); } catch {}
              }
              const isStale = ageMs !== null && ageMs > 2 * 60 * 1000;
              const dist = myLocation && Number.isFinite(selected.latitude) && Number.isFinite(selected.longitude)
                ? haversineMeters(myLocation.lat, myLocation.lng, Number(selected.latitude), Number(selected.longitude))
                : null;
              const midLat = myLocation && Number.isFinite(selected.latitude)
                ? (myLocation.lat + Number(selected.latitude)) / 2 : null;
              const midLng = myLocation && Number.isFinite(selected.longitude)
                ? (myLocation.lng + Number(selected.longitude)) / 2 : null;
              return (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                  <View style={{ borderWidth: 3, borderColor: isStale ? '#9ca3af' : (selected.is_unlimited ? '#7C3AED' : '#22c55e'), borderRadius: 36, padding: 2 }}>
                    <AvatarCircle name={selected.name || selected.email} email={selected.email} size={60} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700' }} numberOfLines={1}>
                      {selected.name || selected.email}
                    </Text>
                    <Text style={{ color: isStale ? '#ef4444' : colors.textSecondary, fontSize: 12, marginTop: 3, fontWeight: isStale ? '700' : '400' }}>
                      {isStale
                        ? `${t?.('snapmap.staleHeader') || 'Sem atualização'} ${ago(selected.updated_at)}`
                        : `${t?.('snapmap.updated') || 'Atualizado'} ${ago(selected.updated_at)}`}
                      {selected.is_unlimited ? ` · ∞ ${t?.('snapmap.alwaysOn') || 'sempre ativo'}` : ''}
                    </Text>
                    {dist !== null && (
                      <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                        {formatDistance(dist)} {t?.('snapmap.awayFromYou') || 'de você'}
                      </Text>
                    )}
                  </View>
                </View>

                {/* Primary actions row — Chat + Call. Call jumps to chat-
                    conversation with autoCall=1 so the existing call flow
                    fires (same handler Live tab uses). Kept inline so the
                    user reaches the most common verbs in one tap. */}
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
                  <TouchableOpacity
                    onPress={() => { setSelected(null); router.push(`/chat-conversation?email=${encodeURIComponent(selected.email)}`); }}
                    style={{ flex: 1, paddingVertical: 14, borderRadius: 22, backgroundColor: colors.primary, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}
                  >
                    <IconMessageSquare size={18} color="#fff" />
                    <Text style={{ color: '#fff', fontWeight: '700' }}>{t?.('snapmap.message') || 'Conversar'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => { setSelected(null); router.push(`/chat-conversation?email=${encodeURIComponent(selected.email)}&autoCall=1`); }}
                    style={{ paddingVertical: 14, paddingHorizontal: 18, borderRadius: 22, backgroundColor: '#22c55e', alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}
                    accessibilityLabel={t?.('snapmap.call') || 'Ligar'}
                  >
                    <IconPhone size={18} color="#fff" />
                  </TouchableOpacity>
                </View>

                {/* Secondary row — Directions to friend + Meet halfway.
                    Meet-halfway opens maps centered between me and the
                    friend with a search for "café/restaurant" — the
                    canonical "find somewhere to meet up" pattern from
                    Find-My-Friends. Only rendered when I have my own GPS
                    (otherwise the midpoint is meaningless). */}
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
                  <TouchableOpacity
                    onPress={() => {
                      const url = `https://www.google.com/maps/dir/?api=1&destination=${selected.latitude},${selected.longitude}`;
                      Linking.openURL(url).catch(() => {});
                    }}
                    style={{ flex: 1, paddingVertical: 12, borderRadius: 18, backgroundColor: colors.border + '50', alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}
                  >
                    <IconNavigation size={16} color={colors.text} />
                    <Text style={{ color: colors.text, fontWeight: '600', fontSize: 13 }}>{t?.('snapmap.directions') || 'Como chegar'}</Text>
                  </TouchableOpacity>
                  {myLocation && midLat !== null && midLng !== null && (
                    <TouchableOpacity
                      onPress={() => {
                        const url = `https://www.google.com/maps/search/?api=1&query=cafe&query_place_id=&center=${midLat},${midLng}&zoom=15`;
                        Linking.openURL(url).catch(() => {});
                      }}
                      style={{ flex: 1, paddingVertical: 12, borderRadius: 18, backgroundColor: colors.border + '50', alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}
                    >
                      <IconMapPin size={16} color={colors.text} />
                      <Text style={{ color: colors.text, fontWeight: '600', fontSize: 13 }}>{t?.('snapmap.meetHalfway') || 'Local intermediário'}</Text>
                    </TouchableOpacity>
                  )}
                </View>

                <TouchableOpacity
                  onPress={() => {
                    const peer = selected.email;
                    setSelected(null);
                    Alert.alert(
                      t?.('snapmap.stopReceiving') || 'Parar de receber',
                      (t?.('snapmap.stopReceivingBody') || 'Você não verá mais a localização de {name} aqui.').replace('{name}', peer),
                      [
                        { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
                        { text: t?.('common.confirm') || 'Confirmar', style: 'destructive', onPress: async () => {
                          try { await api.friendLocationRevoke?.(peer); } catch {}
                          setShares((p) => p.filter((s) => s.email !== peer));
                        } },
                      ],
                    );
                  }}
                  style={{ marginTop: 12, alignItems: 'center', paddingVertical: 12 }}
                >
                  <Text style={{ color: '#ef4444', fontSize: 14, fontWeight: '600' }}>
                    {t?.('snapmap.stopReceiving') || 'Parar de receber localização'}
                  </Text>
                </TouchableOpacity>
              </>
              );
            })()}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Privacy / grants modal */}
      <Modal visible={grantsOpen} transparent animationType="slide" onRequestClose={() => setGrantsOpen(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <View style={{ flex: 1 }} />
          <View style={{ backgroundColor: colors.surface, padding: 22, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: SH * 0.78 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
              <Text style={{ flex: 1, fontSize: 18, fontWeight: '700', color: colors.text }}>
                {t?.('snapmap.privacyTitle') || 'Privacidade de localização'}
              </Text>
              <TouchableOpacity onPress={() => setGrantsOpen(false)} style={{ padding: 8 }}>
                <IconX size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <ScrollView>
              <Text style={{ color: colors.textSecondary, fontSize: 12, fontWeight: '700', marginBottom: 8 }}>
                {(t?.('snapmap.sharingWith') || 'COMPARTILHANDO COM').toUpperCase()}
              </Text>
              {(grantsData?.sharing_with || []).length === 0 ? (
                <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 18 }}>
                  {t?.('snapmap.noShares') || 'Você não está compartilhando com ninguém.'}
                </Text>
              ) : (
                (grantsData?.sharing_with || []).map((g) => (
                  <View key={'s-' + g.email} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 12 }}>
                    <AvatarCircle name={g.name || g.email} email={g.email} size={36} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>{g.name || g.email}</Text>
                      <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
                        {g.is_unlimited ? '∞ sempre ativo' : (g.expires_at ? `expira em ${Math.max(0, Math.round((g.expires_at - Date.now() / 1000) / 60))}min` : '')}
                      </Text>
                    </View>
                    <TouchableOpacity onPress={() => revokeGrant(g.email)} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: '#ef444420' }}>
                      <Text style={{ color: '#ef4444', fontSize: 12, fontWeight: '700' }}>{t?.('snapmap.stop') || 'Parar'}</Text>
                    </TouchableOpacity>
                  </View>
                ))
              )}

              <Text style={{ color: colors.textSecondary, fontSize: 12, fontWeight: '700', marginTop: 18, marginBottom: 8 }}>
                {(t?.('snapmap.receivingFrom') || 'RECEBENDO DE').toUpperCase()}
              </Text>
              {(grantsData?.receiving_from || []).length === 0 ? (
                <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
                  {t?.('snapmap.noReceives') || 'Você não está recebendo localização de ninguém.'}
                </Text>
              ) : (
                (grantsData?.receiving_from || []).map((g) => (
                  <View key={'r-' + g.email} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 12 }}>
                    <AvatarCircle name={g.name || g.email} email={g.email} size={36} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>{g.name || g.email}</Text>
                      <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
                        {g.is_unlimited ? '∞ sempre ativo' : ''}
                      </Text>
                    </View>
                    <TouchableOpacity onPress={() => revokeGrant(g.email)} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: '#ef444420' }}>
                      <Text style={{ color: '#ef4444', fontSize: 12, fontWeight: '700' }}>{t?.('snapmap.stop') || 'Parar'}</Text>
                    </TouchableOpacity>
                  </View>
                ))
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}
