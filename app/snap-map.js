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
// Rendering: Leaflet + CartoCDN tiles inside a WebView
// ----------------------------------------------------
// User feedback 2026-05-18: "amigos no mapa não tá abrindo o google maps".
// Investigation showed that:
//   1. The in-chat location bubble (LocationMessage.js + chat-conversation
//      live-location modal) is NOT actually Google Maps either — it's our
//      own backend proxy `api/static_map.php` that composes **CartoCDN**
//      OSM tiles. The user perceives it as Google because the look is
//      similar, but no Google billing is consumed by chat.
//   2. The configured GOOGLE_MAPS_KEY (app.json) is bound to a GCP
//      project where billing is **disabled**. Probed via curl:
//        Static Maps → 403 "You must enable Billing on the Google
//                       Cloud Project"
//        JS API      → 200 OK but renders the diagonal
//                       "For development purposes only" watermark.
//      No WebView/referrer trick fixes this — it's a Cloud Console toggle.
//
// So this screen uses Leaflet (no key, no billing) layered over **the same
// CartoCDN tile source the chat bubble uses**, so the visual language
// matches across the app. When the user eventually turns billing on we
// can flip the loader at the bottom of buildMapHtml() to use bootGmaps()
// — the AvatarOverlay/MeOverlay code paths are kept ready.
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
  Linking, StatusBar,
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
import {
  IconArrowLeft, IconMapPin, IconUser, IconMessageSquare, IconX, IconNavigation,
} from '../components/Icons';

// Google Maps JS API key. Read from app.json `extra.GOOGLE_MAPS_KEY` —
// same source LocationMessage.js and chat-conversation.js use, so all three
// stay in lockstep when the key rotates.
let GMAPS_KEY = '';
try { GMAPS_KEY = require('expo-constants').default?.expoConfig?.extra?.GOOGLE_MAPS_KEY || ''; } catch {}

// mailWs is the singleton WS bridge — re-uses the connection chat-conv
// holds, so subscribing here is essentially free.
let mailWs = null;
try { mailWs = require('../services/mailWs').default; } catch {}

const { width: SW, height: SH } = Dimensions.get('window');

const DEFAULT_ZOOM = 14;

// Dark-mode Google Maps styles. Same palette WhatsApp uses on the live-
// location screen — desaturated, low-contrast roads so the friend avatars
// pop. Light mode uses Google's default styling (passes `styles: []`).
const DARK_MAP_STYLES = [
  { elementType: 'geometry', stylers: [{ color: '#1a1a1a' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8a8a8a' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1a1a1a' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2c2c2c' }] },
  { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3a3a3a' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0d0d0d' }] },
];

// Build the HTML document that runs Google Maps JS API + a custom
// `AvatarOverlay` class. The overlay extends `google.maps.OverlayView` so
// each pin is a real DOM node (rounded avatar img + name label) anchored
// to lat/lng — exactly the Snapchat / Find-My-Friends look the spec asks
// for, which the default Marker icon can't render.
//
// Pins/myLocation are passed as JSON literals on first render and patched
// live via `window.RNbridge(jsonString)` (native injectJavaScript) /
// `window.postMessage` (web iframe). `pin_tap` events flow back via
// `window.ReactNativeWebView.postMessage` (native) or `window.parent
// .postMessage` (web).
function buildMapHtml({ apiKey, center, zoom, isDark, initialPins, initialMe }) {
  const stylesJson = isDark ? JSON.stringify(DARK_MAP_STYLES) : '[]';
  const pinsJson = JSON.stringify(initialPins || []);
  const meJson = JSON.stringify(initialMe || null);
  // If the key is missing OR Google rejects it at runtime, we silently
  // swap in Leaflet — see `bootLeaflet()` below. Same fallback path the
  // in-chat live-location modal uses, so styling stays consistent.
  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<style>
  html,body,#map{margin:0;padding:0;width:100%;height:100%;background:${isDark ? '#0d0d0d' : '#e5e7eb'};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
  .pin{position:absolute;transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;cursor:pointer;pointer-events:auto;user-select:none}
  .pin .ring{width:48px;height:48px;border-radius:24px;background:#fff;padding:3px;box-sizing:border-box;box-shadow:0 3px 10px rgba(0,0,0,0.35);border:3px solid #22c55e}
  .pin.unlimited .ring{border-color:#7C3AED}
  .pin .ring img{width:100%;height:100%;border-radius:50%;display:block;object-fit:cover;background:#7C3AED}
  .pin .ring .ini{width:100%;height:100%;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:18px;background:#7C3AED}
  .pin .label{margin-top:3px;background:rgba(0,0,0,0.78);color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .me{position:absolute;transform:translate(-50%,-50%);pointer-events:none}
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
var API_KEY = ${JSON.stringify(apiKey || '')};
var INITIAL_CENTER = ${JSON.stringify(center)};
var INITIAL_ZOOM = ${zoom};
var INITIAL_PINS = ${pinsJson};
var INITIAL_ME = ${meJson};
var STYLES = ${stylesJson};
var USE_DARK = ${isDark ? 'true' : 'false'};

var __map = null;
var __overlays = {};       // email → AvatarOverlay
var __meOverlay = null;
var __backend = null;      // 'gmaps' | 'leaflet'

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
  return '<div class="ring">' + img + '</div><div class="label">' + escapeHtml(name) + '</div>';
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});
}

// ──────────────────────────── Google Maps backend ────────────────────────
function bootGmaps() {
  __backend = 'gmaps';
  __map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: INITIAL_CENTER.lat, lng: INITIAL_CENTER.lng },
    zoom: INITIAL_ZOOM,
    disableDefaultUI: true,
    zoomControl: true,
    gestureHandling: 'greedy',
    clickableIcons: false,
    styles: STYLES,
  });

  // Custom AvatarOverlay — a real DOM node positioned over the map. We
  // extend OverlayView (not AdvancedMarkerElement) because the latter
  // needs Maps JS v3 beta + Map ID provisioning we don't have.
  function AvatarOverlay(pin) {
    this.pin = pin;
    this.div = null;
    this.setMap(__map);
  }
  AvatarOverlay.prototype = new google.maps.OverlayView();
  AvatarOverlay.prototype.onAdd = function() {
    var div = document.createElement('div');
    div.className = 'pin' + (this.pin.is_unlimited ? ' unlimited' : '');
    div.innerHTML = pinHtml(this.pin);
    var self = this;
    div.addEventListener('click', function(){ rnPost({ type: 'pin_tap', email: self.pin.email }); });
    this.div = div;
    this.getPanes().floatPane.appendChild(div);
  };
  AvatarOverlay.prototype.draw = function() {
    if (!this.div) return;
    var proj = this.getProjection();
    if (!proj) return;
    var p = proj.fromLatLngToDivPixel(new google.maps.LatLng(this.pin.lat, this.pin.lng));
    if (!p) return;
    this.div.style.left = p.x + 'px';
    this.div.style.top = p.y + 'px';
  };
  AvatarOverlay.prototype.onRemove = function() {
    if (this.div && this.div.parentNode) this.div.parentNode.removeChild(this.div);
    this.div = null;
  };
  AvatarOverlay.prototype.update = function(pin) {
    this.pin = pin;
    if (this.div) {
      this.div.className = 'pin' + (pin.is_unlimited ? ' unlimited' : '');
      this.div.innerHTML = pinHtml(pin);
      var self = this;
      this.div.addEventListener('click', function(){ rnPost({ type: 'pin_tap', email: self.pin.email }); });
    }
    this.draw();
  };

  // Same OverlayView contract for the "you are here" blue dot — pointer-
  // events:none so taps fall through to the map underneath.
  function MeOverlay(pos) {
    this.pos = pos;
    this.div = null;
    this.setMap(__map);
  }
  MeOverlay.prototype = new google.maps.OverlayView();
  MeOverlay.prototype.onAdd = function() {
    var div = document.createElement('div');
    div.className = 'me';
    div.innerHTML = '<div class="dot"></div>';
    this.div = div;
    this.getPanes().overlayLayer.appendChild(div);
  };
  MeOverlay.prototype.draw = function() {
    if (!this.div) return;
    var proj = this.getProjection();
    if (!proj) return;
    var p = proj.fromLatLngToDivPixel(new google.maps.LatLng(this.pos.lat, this.pos.lng));
    if (!p) return;
    this.div.style.left = p.x + 'px';
    this.div.style.top = p.y + 'px';
  };
  MeOverlay.prototype.onRemove = function() {
    if (this.div && this.div.parentNode) this.div.parentNode.removeChild(this.div);
    this.div = null;
  };
  MeOverlay.prototype.update = function(pos) {
    this.pos = pos;
    this.draw();
  };

  // Surface tiles loaded so the host can dismiss its loading spinner.
  google.maps.event.addListenerOnce(__map, 'tilesloaded', function(){
    rnPost({ type: 'map_ready' });
  });

  // Initial render.
  window.__renderPins = function(pins) {
    var seen = {};
    pins.forEach(function(p){
      if (!isFinite(p.lat) || !isFinite(p.lng)) return;
      seen[p.email] = true;
      if (__overlays[p.email]) __overlays[p.email].update(p);
      else __overlays[p.email] = new AvatarOverlay(p);
    });
    Object.keys(__overlays).forEach(function(em){
      if (!seen[em]) { __overlays[em].setMap(null); delete __overlays[em]; }
    });
  };
  window.__renderMe = function(me) {
    if (!me || !isFinite(me.lat) || !isFinite(me.lng)) {
      if (__meOverlay) { __meOverlay.setMap(null); __meOverlay = null; }
      return;
    }
    if (__meOverlay) __meOverlay.update(me);
    else __meOverlay = new MeOverlay(me);
  };
  window.__panTo = function(lat, lng) {
    try { __map.panTo({ lat: lat, lng: lng }); } catch (e) {}
  };

  window.__renderPins(INITIAL_PINS);
  if (INITIAL_ME) window.__renderMe(INITIAL_ME);
}

// ──────────────────────────── Leaflet (CartoCDN tiles) ─────────────────────
// This is the production renderer for snap-map.
//
// Why not Google Maps:
//   The configured key (app.json extra.GOOGLE_MAPS_KEY) is bound to a GCP
//   project where **billing is disabled**. Probed 2026-05-18:
//     - Static Maps  → HTTP 403 "You must enable Billing on the Google
//       Cloud Project at https://console.cloud.google.com/project/_/billing/enable"
//     - Maps JS API  → HTTP 200 but renders the "For development purposes
//       only" diagonal watermark + a "This page can't load Google Maps
//       correctly" red overlay at runtime (gm_authFailure signal).
//   No referrer/restriction fix in code can bypass billing — it's a Cloud
//   Console toggle. Until billing is turned on we MUST use a non-Google
//   tile provider.
//
// Why CartoCDN 'light_all'/'dark_all' (not raw OSM):
//   This is the SAME tile source the in-chat location bubble uses (via the
//   backend 'static_map.php' proxy → CartoCDN). Using it here makes the
//   snap-map background visually match what users see in chat — which is
//   what the user asked for ("o google maps tá funcionando no chat"; in
//   reality chat is CartoCDN, not Google, but the look is the same and
//   that's what matters).
//   CartoCDN is free, no key, no billing, CORS-friendly, has light + dark
//   variants we can theme-switch, and renders {a,b,c,d} subdomains.
//   Falls back to tile.openstreetmap.org if Carto is blocked.
function bootLeaflet() {
  if (__backend) return;  // gmaps won the race — skip
  __backend = 'leaflet';
  var css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  document.head.appendChild(css);
  var js = document.createElement('script');
  js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
  js.onload = function() {
    var map = L.map('map', { zoomControl: true, attributionControl: false })
      .setView([INITIAL_CENTER.lat, INITIAL_CENTER.lng], INITIAL_ZOOM);
    // Theme-aware Carto tiles. light_all = clean white/gray base used by
    // static_map.php (the chat bubble preview proxy). dark_all swaps in
    // the inverted palette so dark-mode users get a coherent look.
    var tileBase = USE_DARK
      ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'
      : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png';
    var carto = L.tileLayer(tileBase, {
      maxZoom: 19,
      subdomains: 'abcd',
      // 404 → swap to OSM. Carto rate-limits very aggressively if the
      // referrer is missing (which the WebView srcDoc case hits); OSM
      // accepts wider traffic and is the safety net.
      errorTileUrl: '',
    }).addTo(map);
    carto.on('tileerror', function() {
      try {
        map.removeLayer(carto);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19, subdomains: 'abc',
        }).addTo(map);
      } catch (e) {}
    });

    var lOverlays = {};
    var lMe = null;
    function makePinIcon(pin) {
      var initial = (pin.name || pin.email || '?').trim().charAt(0).toUpperCase();
      var img = pin.avatar_url
        ? '<img src="' + pin.avatar_url + '" onerror="this.style.display=\\'none\\';this.nextElementSibling&&(this.nextElementSibling.style.display=\\'flex\\')"/><div class="ini" style="display:none">' + initial + '</div>'
        : '<div class="ini">' + initial + '</div>';
      var name = (pin.name || (pin.email ? pin.email.split('@')[0] : '?'));
      return L.divIcon({
        className: '',
        iconSize: [120, 80],
        iconAnchor: [60, 80],
        html: '<div class="pin' + (pin.is_unlimited ? ' unlimited' : '') + '"><div class="ring">' + img + '</div><div class="label">' + escapeHtml(name) + '</div></div>',
      });
    }
    window.__renderPins = function(pins) {
      var seen = {};
      pins.forEach(function(p){
        if (!isFinite(p.lat) || !isFinite(p.lng)) return;
        seen[p.email] = true;
        if (lOverlays[p.email]) {
          lOverlays[p.email].setLatLng([p.lat, p.lng]);
          lOverlays[p.email].setIcon(makePinIcon(p));
        } else {
          var m = L.marker([p.lat, p.lng], { icon: makePinIcon(p) }).addTo(map);
          (function(em){
            m.on('click', function(){ rnPost({ type: 'pin_tap', email: em }); });
          })(p.email);
          lOverlays[p.email] = m;
        }
      });
      Object.keys(lOverlays).forEach(function(em){
        if (!seen[em]) { map.removeLayer(lOverlays[em]); delete lOverlays[em]; }
      });
    };
    window.__renderMe = function(me) {
      if (!me || !isFinite(me.lat) || !isFinite(me.lng)) {
        if (lMe) { map.removeLayer(lMe); lMe = null; }
        return;
      }
      var icon = L.divIcon({ className: '', iconSize: [18,18], iconAnchor: [9,9], html: '<div class="me"><div class="dot"></div></div>' });
      if (lMe) { lMe.setLatLng([me.lat, me.lng]); lMe.setIcon(icon); }
      else lMe = L.marker([me.lat, me.lng], { icon: icon, interactive: false }).addTo(map);
    };
    window.__panTo = function(lat, lng) { try { map.panTo([lat, lng]); } catch (e) {} };

    window.__renderPins(INITIAL_PINS);
    if (INITIAL_ME) window.__renderMe(INITIAL_ME);
    rnPost({ type: 'map_ready' });
  };
  document.body.appendChild(js);
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
// Google Maps JS API path — billing was enabled 2026-05-18. The script
// tag is injected at runtime so we can fall back to Leaflet if the
// network blocks googleapis.com or the key is mid-rotation.
function initMap() { try { bootGmaps(); } catch (e) { bootLeaflet(); } }

(function loadGoogleMaps() {
  if (!API_KEY) { bootLeaflet(); return; }
  var s = document.createElement('script');
  s.async = true;
  s.defer = true;
  s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(API_KEY) + '&callback=initMap&loading=async';
  s.onerror = function() { bootLeaflet(); };
  document.head.appendChild(s);
  // Safety net: if Google never calls initMap within 6s (CDN block,
  // network flake), fall back to Leaflet so the user isn't stuck on a
  // blank map.
  setTimeout(function(){ if (__backend === null) bootLeaflet(); }, 6000);
})();

// gm_authFailure is the runtime signal Google fires when the JS API
// loads but is rejected for billing/quota. Kept defensive in case
// someone flips the loader on prematurely — we tear down whatever
// half-rendered gmaps state exists and fall back to Leaflet.
window.gm_authFailure = function() {
  Object.keys(__overlays).forEach(function(e){ try { __overlays[e].setMap(null); } catch(_){} });
  __overlays = {};
  if (__meOverlay) { try { __meOverlay.setMap(null); } catch(_){} __meOverlay = null; }
  __map = null; __backend = null;
  document.getElementById('map').innerHTML = '';
  bootLeaflet();
};
</script>
</body></html>`;
}

function ago(updatedAt) {
  if (!updatedAt) return '';
  let ts = 0;
  try { ts = new Date(updatedAt.replace(' ', 'T') + 'Z').getTime(); } catch {}
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `há ${s}s`;
  if (s < 3600) return `há ${Math.round(s / 60)}min`;
  if (s < 86400) return `há ${Math.round(s / 3600)}h`;
  return `há ${Math.round(s / 86400)}d`;
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
  const [myLocation, setMyLocation] = useState(null);
  const [selected, setSelected] = useState(null); // bottom sheet pin
  const [pendingReqs, setPendingReqs] = useState([]); // incoming requests
  const [grantsOpen, setGrantsOpen] = useState(false);
  const [grantsData, setGrantsData] = useState(null);

  const sharesRef = useRef([]);
  sharesRef.current = shares;

  // ── Initial load: my GPS + friends + pending requests ─────────────
  useEffect(() => {
    let alive = true;
    const load = async () => {
      // My own location for centering. We DON'T auto-share — that's a
      // separate explicit user action (in-chat live-location bubble or
      // an accepted request).
      if (Platform.OS !== 'web') {
        try {
          const Location = require('expo-location');
          const { status } = await Location.requestForegroundPermissionsAsync();
          if (status === 'granted') {
            const pos = await Location.getLastKnownPositionAsync({ maxAge: 60000 });
            if (alive && pos?.coords) setMyLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
            try {
              const fresh = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
              if (alive && fresh?.coords) setMyLocation({ lat: fresh.coords.latitude, lng: fresh.coords.longitude });
            } catch {}
          }
        } catch {}
      } else if (typeof navigator !== 'undefined' && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition((pos) => {
          if (alive) setMyLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        }, () => {}, { maximumAge: 60000, timeout: 8000 });
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
        const patched = { ...(i >= 0 ? prev[i] : {}), ...data, email: data.sharer_email, updated_at: new Date().toISOString() };
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

  // Center: prefer my GPS; fall back to first friend; final fallback Brazil.
  // We only compute center ONCE — on mount — to seed the WebView HTML.
  // After mount, the user is free to pan/zoom; we don't yank them back to
  // center every time `myLocation` updates. New pins arrive via
  // injectJavaScript, not a full HTML re-render.
  const initialCenter = useMemo(() => {
    if (myLocation) return myLocation;
    if (shares[0] && Number.isFinite(shares[0].latitude)) return { lat: shares[0].latitude, lng: shares[0].longitude };
    return { lat: -15.77, lng: -47.92 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);   // ← intentionally empty; first paint only

  // Build the pin payload the WebView understands. avatar_url is the
  // backend's /get_avatar endpoint so the map shows the friend's actual
  // profile photo instead of just initials.
  const pinsPayload = useMemo(() => (
    shares
      .filter((s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude))
      .map((s) => ({
        email: s.email,
        name: s.name || s.email?.split('@')[0] || '',
        lat: Number(s.latitude),
        lng: Number(s.longitude),
        is_unlimited: !!s.is_unlimited,
        avatar_url: s.email ? getAvatarUrlForEmail(s.email) : null,
      }))
  ), [shares]);
  const mePayload = useMemo(() => (
    myLocation ? { lat: myLocation.lat, lng: myLocation.lng } : null
  ), [myLocation]);

  // HTML built once per mount. We avoid rebuilding on state change
  // because rebuilding the `source.html` would tear down the WebView
  // and remount Google Maps from scratch (slow, jittery, loses user
  // pan/zoom). All pin/me updates flow through injectJavaScript.
  const mapHtml = useMemo(() => buildMapHtml({
    apiKey: GMAPS_KEY,
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
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: topInset + 8, paddingBottom: 14, backgroundColor: isDark ? '#0d0d0d' : '#fff', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)', zIndex: 10 }}>
        <TouchableOpacity onPress={() => router.back()} style={{ padding: 8 }} accessibilityLabel="Voltar">
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 8 }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>
            {t?.('snapmap.title') || 'Amigos no Mapa'}
          </Text>
          <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
            {shares.length} {t?.('snapmap.sharingNow') || 'compartilhando agora'}
          </Text>
        </View>
        <TouchableOpacity onPress={openGrants} style={{ padding: 8 }} accessibilityLabel="Privacidade">
          <IconUser size={22} color={colors.text} />
        </TouchableOpacity>
      </View>

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

      {/* Map — Google Maps JS inside WebView/iframe. Tap on a pin posts
          `pin_tap` back to RN which opens the bottom sheet below. Real
          pan/zoom comes for free; we keep the loading + empty overlays
          absolutely-positioned on top of the WebView. */}
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
            </View>
          </View>
        )}
      </View>

      {/* Pin bottom-sheet — "what can I do with this friend" */}
      <Modal visible={!!selected} transparent animationType="slide" onRequestClose={() => setSelected(null)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' }} onPress={() => setSelected(null)}>
          <View style={{ flex: 1 }} />
          <Pressable onPress={(e) => e.stopPropagation?.()} style={{ backgroundColor: colors.surface, padding: 22, borderTopLeftRadius: 24, borderTopRightRadius: 24 }}>
            {selected && (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                  <AvatarCircle name={selected.name || selected.email} email={selected.email} size={56} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700' }} numberOfLines={1}>
                      {selected.name || selected.email}
                    </Text>
                    <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                      {t?.('snapmap.updated') || 'Atualizado'} {ago(selected.updated_at)}
                      {selected.is_unlimited ? ` · ∞ ${t?.('snapmap.alwaysOn') || 'sempre ativo'}` : ''}
                    </Text>
                  </View>
                </View>

                <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
                  <TouchableOpacity
                    onPress={() => { setSelected(null); router.push(`/chat-conversation?email=${encodeURIComponent(selected.email)}`); }}
                    style={{ flex: 1, paddingVertical: 14, borderRadius: 22, backgroundColor: colors.primary, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}
                  >
                    <IconMessageSquare size={18} color="#fff" />
                    <Text style={{ color: '#fff', fontWeight: '700' }}>{t?.('snapmap.message') || 'Conversar'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => {
                      const url = `https://www.google.com/maps/dir/?api=1&destination=${selected.latitude},${selected.longitude}`;
                      Linking.openURL(url).catch(() => {});
                    }}
                    style={{ flex: 1, paddingVertical: 14, borderRadius: 22, backgroundColor: colors.border + '50', alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}
                  >
                    <IconMapPin size={18} color={colors.text} />
                    <Text style={{ color: colors.text, fontWeight: '700' }}>{t?.('snapmap.directions') || 'Como chegar'}</Text>
                  </TouchableOpacity>
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
            )}
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
