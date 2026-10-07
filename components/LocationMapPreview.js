// LocationMapPreview — [2026-10-07 native-maps] chat location-bubble thumbnail.
//
// Native binaries with ChatyyMapView: a `lite` native map (iOS MKMapSnapshotter /
// Android MapLibre MapSnapshotter → one cached bitmap, no live GL surface and no
// WebView per bubble). Everything else (web, old binaries): renders `fallback`
// untouched (the existing MapLibre-GL-JS WebView), so old binaries behave
// exactly as before.
//
// Props: lat, lng, isDark, showPin (default true; the live bubble draws its own
// pulsing dot overlay so it passes false), zoom (default 15), fallback, style.

import React from 'react';
import { View } from 'react-native';
import { ChatyyMap, isNativeMapAvailable, nativeMapStyleUrl } from './NativeMap';

function LocationMapPreview({ lat, lng, isDark, showPin = true, zoom = 15, fallback = null, style }) {
  const la = Number(lat);
  const lo = Number(lng);
  const ok = Number.isFinite(la) && Number.isFinite(lo);
  const camera = React.useMemo(
    () => (ok ? { latitude: la, longitude: lo, zoom, seq: 1 } : null),
    [ok, la, lo, zoom],
  );
  const markers = React.useMemo(
    () => (ok && showPin ? [{ id: 'loc', latitude: la, longitude: lo, kind: 'pin', color: '#EF4444' }] : []),
    [ok, la, lo, showPin],
  );
  if (!ok || !isNativeMapAvailable()) return fallback;
  return (
    <View pointerEvents="none" style={[{ width: '100%', height: '100%' }, style]}>
      <ChatyyMap
        style={{ flex: 1 }}
        lite
        interactive={false}
        dark={!!isDark}
        styleUrl={nativeMapStyleUrl(la, lo, isDark)}
        camera={camera}
        markers={markers}
      />
    </View>
  );
}

export default React.memo(LocationMapPreview);
