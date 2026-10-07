// NativeMap — [2026-10-07 native-maps] JS facade for the native `ChatyyMapView`
// (modules/expo-native-toolkit: iOS = Apple MapKit, Android = MapLibre Native on
// our self-hosted BoraUm OSM tiles). ZERO Google on both platforms.
//
// Feature detection (old binaries keep the WebView/MapLibre-GL-JS path):
//   - LAZY: nothing is probed at import time. The first call to
//     getNativeMapView() asks `requireOptionalNativeModule('ChatyyMapView')`
//     (reads the Expo JSI module registry — never throws, NOT a
//     TurboModuleRegistry probe) and only then resolves the view.
//   - The legacy iOS `ExpoNativeMapView` (MKMapView, lat/lng only) is NOT used:
//     the new view has its own module name precisely so that binaries without
//     it fall back cleanly.
//   - Kill switch: flip NATIVE_MAPS_ENABLED to false in an OTA to force the
//     WebView path everywhere without a rebuild.
//
// Props (see ChatyyMap below): styleUrl, dark, lite, interactive, rotateEnabled,
// camera {latitude, longitude, zoom, animated, seq, minLatitude, minLongitude,
// maxLatitude, maxLongitude, padding, maxZoom}, markers [{id, latitude,
// longitude, kind: pin|search|dot|live|me|avatar, color, label, sublabel,
// imageUrl, initials, stale, highlight}].
// Callbacks receive the PLAIN payload (nativeEvent already unwrapped):
// onMapReady, onRegionWillChange({gesture}), onRegionDidChange({latitude,
// longitude, zoom, gesture}), onMarkerPress({id}), onMapPress({latitude,
// longitude}), onMapError({message}).

import React from 'react';
import { Platform } from 'react-native';
import { boraStyleUrl } from './BoraMap';

export const NATIVE_MAPS_ENABLED = true;

export const BORA_DARK_STYLE_URL = 'https://boraum.com.br/maptiles/styles/boraum-mapa-escuro/style.json';

/** Same style choice the WebView paths make: dark → dedicated dark basemap, else per-country. */
export function nativeMapStyleUrl(lat, lng, isDark) {
  if (isDark) return BORA_DARK_STYLE_URL;
  return boraStyleUrl(Number(lng), Number(lat));
}

let _checked = false;
let _NativeView = null;

/** Returns the native host component, or null (web / old binary / kill switch). */
export function getNativeMapView() {
  if (_checked) return _NativeView;
  _checked = true;
  if (!NATIVE_MAPS_ENABLED || Platform.OS === 'web') return null;
  try {
    const expo = require('expo');
    const mod = typeof expo.requireOptionalNativeModule === 'function'
      ? expo.requireOptionalNativeModule('ChatyyMapView')
      : null;
    if (mod && typeof expo.requireNativeView === 'function') {
      _NativeView = expo.requireNativeView('ChatyyMapView');
    }
  } catch {
    _NativeView = null;
  }
  return _NativeView;
}

export function isNativeMapAvailable() {
  return !!getNativeMapView();
}

const unwrap = (fn) => (fn ? (e) => { try { fn(e?.nativeEvent ?? e ?? {}); } catch {} } : undefined);

/**
 * <ChatyyMap> — renders the native map. Caller MUST gate with
 * isNativeMapAvailable() (returns null otherwise so a stray render can't crash).
 */
export const ChatyyMap = React.memo(function ChatyyMap({
  onMapReady, onRegionWillChange, onRegionDidChange, onMarkerPress, onMapPress, onMapError,
  markers, camera, ...rest
}) {
  const Native = getNativeMapView();
  const handlers = React.useMemo(() => ({
    onMapReady: unwrap(onMapReady),
    onRegionWillChange: unwrap(onRegionWillChange),
    onRegionDidChange: unwrap(onRegionDidChange),
    onMarkerPress: unwrap(onMarkerPress),
    onMapPress: unwrap(onMapPress),
    onMapError: unwrap(onMapError),
  }), [onMapReady, onRegionWillChange, onRegionDidChange, onMarkerPress, onMapPress, onMapError]);
  if (!Native) return null;
  return (
    <Native
      {...rest}
      camera={camera || undefined}
      markers={Array.isArray(markers) ? markers : []}
      {...handlers}
    />
  );
});

/** Nominatim (OSM) place search — same endpoint snap-map's WebView search uses. */
export async function searchPlaces(query, { limit = 6, lang = 'pt-BR', signal } = {}) {
  const q = String(query || '').trim();
  if (q.length < 3) return [];
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=${limit}&addressdetails=0&accept-language=${encodeURIComponent(lang)}&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) return [];
  const list = await res.json();
  if (!Array.isArray(list)) return [];
  return list
    .map((it) => ({
      id: String(it.place_id ?? `${it.lat},${it.lon}`),
      latitude: parseFloat(it.lat),
      longitude: parseFloat(it.lon),
      title: String(it.display_name || '').split(',')[0].trim(),
      subtitle: String(it.display_name || '').split(',').slice(1, 4).join(',').trim(),
      displayName: String(it.display_name || ''),
    }))
    .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
}
