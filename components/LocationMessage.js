import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, Linking, StyleSheet, Share, Platform, Dimensions } from 'react-native';
import { IconMapPin } from './Icons';

// Always use stock RN Image — expo-image was caching a stale empty/failed
// response and refusing to re-fetch even with cache-bust query params,
// keeping the bubble gray on user devices. Stock Image with
// `cache: 'reload'` forces a fresh fetch every mount and works reliably
// across iOS/Android/web with no native-module dependency.
const RNImage = require('react-native').Image;

// Bubble width — used so Image gets explicit pixel dimensions instead of
// percentage. RN Image with width:'100%' on a parent that briefly measures
// 0 during scroll/recycle can collapse to 0×0 and never re-fetch even
// after the parent resolves real width. Pixel dimensions sidestep that.
const BUBBLE_WIDTH = Math.min(Dimensions.get('window').width - 80, 280);
const BUBBLE_HEIGHT = 160;

// Google Maps Static API key (from app.json extra). Falls back to OSM tile if absent.
let GMAPS_KEY = '';
try { GMAPS_KEY = require('expo-constants').default?.expoConfig?.extra?.GOOGLE_MAPS_KEY || ''; } catch {}

// Cache-bust query string. Bump this when switching tile providers so any
// previously-cached failed responses (e.g. 403 from tile.openstreetmap.org)
// get evicted and re-fetched against the new URL.
const TILE_CACHE_BUST = 'v20';

/**
 * Location Message Component
 * Renders real map preview (Google Static Maps if key, else OpenStreetMap fallback) + address.
 * Parses JSON content: { latitude, longitude, address, is_live, accuracy }
 */
export default function LocationMessage({ content, isOwn, colors = {}, onOpenMap, t }) {
  const safeColors = {
    surface: '#fff',
    border: '#e0e0e0',
    primary: '#007AFF',
    textTertiary: '#999',
    textSecondary: '#666',
    text: '#000',
    ...colors,
  };

  const [location, setLocation] = useState(null);
  const [tileError, setTileError] = useState(false);
  const [tileProvider, setTileProvider] = useState('carto'); // 'carto' | 'osm' | 'failed'

  useEffect(() => {
    try {
      const loc = typeof content === 'string' ? JSON.parse(content) : content;
      setLocation(loc);
      // Reset tile state when location changes (new message in same component)
      setTileError(false);
      setTileProvider('carto');
    } catch (err) {
      console.warn('LocationMessage parse error:', err);
    }
  }, [content]);

  // Pre-warm the image cache the moment we know the tile URL — guarantees
  // the bytes are downloaded before <Image> mounts. Without this, the first
  // render of a recycled list cell can show empty while the fetch is still
  // in flight; with prefetch the Image hits an already-warm cache.
  useEffect(() => {
    if (!hasCoordsForPrefetch) return;
    const url = computeTileUrlForPrefetch();
    if (!url) return;
    try { RNImage.prefetch(url).catch(() => {}); } catch {}
  }, [location?.latitude, location?.longitude, tileProvider]);

  function computeTileUrlForPrefetch() {
    if (location?.latitude == null || location?.longitude == null) return null;
    const z = 15;
    const lat = Number(location.latitude);
    const lng = Number(location.longitude);
    const n = Math.pow(2, z);
    const x = Math.floor(((lng + 180) / 360) * n);
    const latRad = (lat * Math.PI) / 180;
    const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
    const cb = `?v=${TILE_CACHE_BUST}-${z}-${x}-${y}`;
    if (tileProvider === 'osm') return `https://tile.openstreetmap.org/${z}/${x}/${y}.png${cb}`;
    return `https://basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png${cb}`;
  }
  const hasCoordsForPrefetch = location?.latitude != null && location?.longitude != null;

  const handleOpenMap = () => {
    if (!location) return;
    const lat = location.latitude;
    const lng = location.longitude;
    if (lat == null || lng == null) return;
    const url = `https://maps.google.com/?q=${lat},${lng}`;
    Linking.openURL(url).catch(() => {});
    if (typeof onOpenMap === 'function') {
      onOpenMap({ lat, lng, label: location.address || 'Location', isLive: location.is_live || false });
    }
  };

  const handleShare = async () => {
    if (!location) return;
    const lat = location.latitude;
    const lng = location.longitude;
    if (lat == null || lng == null) return;
    const text = `📍 ${location.address || 'Location'}\nhttps://maps.google.com/?q=${lat},${lng}`;
    try {
      if (Platform.OS !== 'web') {
        await Share.share({ message: text, title: 'Localização' });
      } else if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ text, title: 'Localização' });
      } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      }
    } catch (err) {
      if (err.message !== 'User did not share') console.warn('Share error:', err);
    }
  };

  if (!location) {
    return (
      <View style={[styles.container, { backgroundColor: safeColors.surface }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <IconMapPin size={16} color={safeColors.textTertiary} />
          <Text style={{ color: safeColors.textTertiary }}>{t?.('chatConv.invalidLocation') || 'Invalid location'}</Text>
        </View>
      </View>
    );
  }

  const hasCoords = location.latitude != null && location.longitude != null;
  const lat = hasCoords ? Number(location.latitude) : null;
  const lng = hasCoords ? Number(location.longitude) : null;

  // Google Static Maps requires Cloud Billing enabled (returned 403 on prod).
  // Disabled for now — OSM tile mosaic (web) + single OSM tile (native) work
  // without any key/billing and look clean for chat-bubble previews.
  const gmapsUrl = null;

  // Tile coords formula (Web Mercator). Verified for São Paulo
  // lat=-23.55, lng=-46.63 @ z15 → x≈12104, y≈18213 (correct).
  // Negative coords are handled correctly because (lng + 180) keeps x ≥ 0
  // and tan(latRad) for negative lat is also negative — the formula is
  // symmetric across the equator.
  const computeTile = (latitude, longitude, zoom) => {
    const n = Math.pow(2, zoom);
    const x = Math.floor(((longitude + 180) / 360) * n);
    const latRad = (latitude * Math.PI) / 180;
    const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
    return { x, y };
  };

  // Native single tile @ z15. Provider chain: carto → osm → solid-pin fallback.
  const tileUrl = hasCoords ? (() => {
    const zoom = 15;
    const { x, y } = computeTile(lat, lng, zoom);
    const cb = `?v=${TILE_CACHE_BUST}-${zoom}-${x}-${y}`;
    if (tileProvider === 'carto') {
      return `https://basemaps.cartocdn.com/light_all/${zoom}/${x}/${y}.png${cb}`;
    }
    if (tileProvider === 'osm') {
      return `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png${cb}`;
    }
    return null;
  })() : null;

  const handleTileError = (err) => {
    console.warn('LocationMessage tile failed:', tileUrl, err?.nativeEvent || err);
    if (tileProvider === 'carto') {
      setTileProvider('osm');
    } else if (tileProvider === 'osm') {
      setTileProvider('failed');
      setTileError(true);
    }
  };

  // Web: build a 3x2 OSM tile mosaic for a richer, larger map preview.
  const buildTileGrid = () => {
    if (!hasCoords) return null;
    const zoom = 16;
    const tileSize = 256;
    const cols = 3, rows = 2;
    const x = (lng + 180) / 360 * Math.pow(2, zoom);
    const latRad = lat * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, zoom);
    const tileX = Math.floor(x);
    const tileY = Math.floor(y);
    const fracX = x - tileX;
    const fracY = y - tileY;
    const tiles = [];
    for (let dy = -Math.floor(rows/2); dy <= Math.floor(rows/2); dy++) {
      for (let dx = -Math.floor(cols/2); dx <= Math.floor(cols/2); dx++) {
        const tx = tileX + dx;
        const ty = tileY + dy;
        if (tx < 0 || ty < 0) continue;
        tiles.push({
          url: `https://basemaps.cartocdn.com/light_all/${zoom}/${tx}/${ty}.png?v=${TILE_CACHE_BUST}`,
          left: (dx + Math.floor(cols/2)) * tileSize,
          top: (dy + Math.floor(rows/2)) * tileSize,
        });
      }
    }
    const pinLeft = Math.floor(cols/2) * tileSize + fracX * tileSize;
    const pinTop = Math.floor(rows/2) * tileSize + fracY * tileSize;
    return { tiles, pinLeft, pinTop, gridW: cols * tileSize, gridH: rows * tileSize };
  };
  const grid = (Platform.OS === 'web' && hasCoords) ? buildTileGrid() : null;

  // Tile image renderer — picks expo-image (native) or RN Image (web/fallback).
  // expo-image gets a recyclingKey so when the URL changes (provider fallback,
  // cache-bust bump) it forces a fresh fetch instead of reusing a stale slot.
  // Explicit width/height (not %) on the inner Image to avoid any layout race
  // where the tile renders 0×0 before the parent measures.
  const renderTileImage = (uri, style) => {
    if (!uri) return null;
    return (
      <RNImage
        // `key` forces React to dismount + re-fetch when URL changes (e.g. when
        // tileProvider falls back from carto → osm).
        key={uri}
        // `cache: 'reload'` bypasses NSURLCache entirely on iOS — fixes the
        // poisoned-cache scenario where a stale 403/empty response from a
        // previous build was being re-served forever for the same URL.
        source={{ uri, cache: 'reload' }}
        style={style}
        resizeMode="cover"
        onError={(e) => {
          // Surface the failure to console — visible in Xcode/Android logs.
          // Many "gray map" reports trace back to silent network errors.
          try { console.warn('[LocationMessage] tile failed:', uri, e?.nativeEvent?.error || e); } catch {}
          handleTileError(e);
        }}
        onLoad={() => {
          try { console.log('[LocationMessage] tile loaded:', uri); } catch {}
        }}
      />
    );
  };

  const showSolidFallback = !hasCoords || tileError || tileProvider === 'failed';

  return (
    <TouchableOpacity
      activeOpacity={0.92}
      onPress={handleOpenMap}
      style={[styles.container, {
        backgroundColor: isOwn ? 'rgba(0,0,0,0.06)' : safeColors.surface,
        ...(Platform.OS === 'web' ? {
          boxShadow: '0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)',
        } : {}),
      }]}
    >
      {/* Map Preview */}
      <View style={styles.mapContainer}>
        {showSolidFallback ? (
          /* Final fallback: solid bg + centered pin */
          <View style={[styles.mapContainerInner, { backgroundColor: isOwn ? '#7C3AED' : safeColors.primary, justifyContent: 'center', alignItems: 'center' }]}>
            <IconMapPin size={36} color="#fff" />
          </View>
        ) : Platform.OS === 'web' && grid ? (
          <View style={[styles.mapContainerInner, { overflow: 'hidden', backgroundColor: '#e5e7eb' }]}>
            {/* Centered tile grid */}
            <View style={{
              position: 'absolute',
              left: '50%', top: '50%',
              width: grid.gridW, height: grid.gridH,
              marginLeft: -grid.gridW / 2,
              marginTop: -grid.gridH / 2,
            }}>
              {grid.tiles.map((tile, i) => (
                renderTileImage(tile.url, { position: 'absolute', left: tile.left, top: tile.top, width: 256, height: 256 })
              ))}
              {/* Pin centered on coordinates */}
              <View style={{
                position: 'absolute',
                left: grid.pinLeft, top: grid.pinTop,
                marginLeft: -18, marginTop: -36,
                pointerEvents: 'none',
              }}>
                <View style={[styles.pinCircle, { backgroundColor: '#dc2626' }]}>
                  <IconMapPin size={18} color="#fff" />
                </View>
                <View style={[styles.pinTail, { borderTopColor: '#dc2626' }]} />
              </View>
            </View>
            {/* Subtle gradient at bottom for legibility */}
            <View style={{
              position: 'absolute', left: 0, right: 0, bottom: 0, height: 40,
              ...(Platform.OS === 'web' ? {
                background: 'linear-gradient(to top, rgba(0,0,0,0.25), transparent)',
              } : {}),
              pointerEvents: 'none',
            }} />
          </View>
        ) : tileUrl ? (
          /* Native: single CartoCDN/OSM tile as background. Inner View has NO
             backgroundColor so the tile shows through — the cinza bg used to
             cover the tile was the visual "gray map" symptom on the user's
             screen. Solid bg only kicks in via showSolidFallback above. */
          <View style={[styles.mapContainerInner, { overflow: 'hidden' }]}>
            {renderTileImage(tileUrl, styles.mapTileImage)}
            {/* Pin no centro */}
            <View style={styles.pinOverlay} pointerEvents="none">
              <View style={[styles.pinCircle, { backgroundColor: isOwn ? '#7C3AED' : safeColors.primary }]}>
                <IconMapPin size={18} color="#fff" />
              </View>
              <View style={[styles.pinTail, { borderTopColor: isOwn ? '#7C3AED' : safeColors.primary }]} />
            </View>
          </View>
        ) : (
          <View style={[styles.mapContainerInner, { backgroundColor: isOwn ? '#7C3AED' : safeColors.primary, justifyContent: 'center', alignItems: 'center' }]}>
            <IconMapPin size={36} color="#fff" />
          </View>
        )}

        {/* Badge AO VIVO */}
        {location.is_live && (
          <View style={styles.liveBadge}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText}>{t?.('chatConv.liveLocation') || 'AO VIVO'}</Text>
          </View>
        )}
      </View>

      {/* Info */}
      <View style={styles.infoContainer}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.addressText, { color: isOwn ? '#fff' : safeColors.text }]} numberOfLines={2}>
            {String(location.address || (hasCoords ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : 'Localização'))}
          </Text>
          <Text style={{ fontSize: 10, color: isOwn ? 'rgba(255,255,255,0.55)' : safeColors.textTertiary, marginTop: 2 }}>
            {location.accuracy != null ? `±${Math.round(location.accuracy)}m · ` : ''}{t?.('chatConv.tapToOpenMap') || 'Toque para abrir'}
          </Text>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {hasCoords && (
            <TouchableOpacity onPress={handleShare} style={styles.iconBtn}>
              <Text style={{ fontSize: 14, color: isOwn ? 'rgba(255,255,255,0.7)' : safeColors.textSecondary }}>↗</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    minWidth: 240,
    maxWidth: 280,
    borderRadius: 14,
    overflow: 'hidden',
    marginBottom: 8,
  },
  mapContainer: {
    width: BUBBLE_WIDTH,
    height: BUBBLE_HEIGHT,
    position: 'relative',
    // No backgroundColor here — tile image fills the space. If we set
    // a gray bg, on slow networks (or if tile fetch races layout) the
    // tile would mount on top, but if any layout glitch shrinks the
    // Image to 0×0, gray would leak through. Keeping this transparent
    // forces the issue to be visible (we'd see the parent bubble bg)
    // instead of being hidden under "looks like gray map loading".
  },
  mapContainerInner: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
  },
  mapTileImage: {
    position: 'absolute',
    top: 0, left: 0,
    // Fixed pixel dimensions — `width: '100%'` collapses to 0 if the parent
    // measures 0 mid-recycle on FlatList scroll, leaving the bubble gray.
    width: BUBBLE_WIDTH,
    height: BUBBLE_HEIGHT,
  },
  pinOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pinCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 4,
    elevation: 5,
    borderWidth: 2,
    borderColor: '#fff',
  },
  pinTail: {
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderTopWidth: 8,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    marginTop: -1,
  },
  liveBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 4,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#EF4444',
  },
  liveText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#fff',
  },
  infoContainer: {
    flexDirection: 'row',
    padding: 10,
    alignItems: 'center',
    gap: 8,
  },
  addressText: {
    fontSize: 13,
    fontWeight: '600',
  },
  iconBtn: {
    padding: 4,
  },
  btnOpen: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
