import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, Linking, StyleSheet, Share, Platform, Image } from 'react-native';
import { IconMapPin } from './Icons';

// Google Maps Static API key (from app.json extra). Falls back to OSM tile if absent.
let GMAPS_KEY = '';
try { GMAPS_KEY = require('expo-constants').default?.expoConfig?.extra?.GOOGLE_MAPS_KEY || ''; } catch {}

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
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    try {
      const loc = typeof content === 'string' ? JSON.parse(content) : content;
      setLocation(loc);
    } catch (err) {
      console.warn('LocationMessage parse error:', err);
    }
  }, [content]);

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
  // without any key/billing and look clean for chat-bubble previews. To
  // re-enable: enable billing in Google Cloud project, then flip this guard.
  const gmapsUrl = null;

  // Fallback: single OSM tile at zoom 15 (no key required).
  const tileUrl = hasCoords ? (() => {
    const zoom = 15;
    const x = Math.floor((lng + 180) / 360 * Math.pow(2, zoom));
    const latRad = lat * Math.PI / 180;
    const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, zoom));
    return `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
  })() : null;

  // Web: build a 3x3 OSM tile mosaic for a richer, larger map preview.
  // Static composition (no iframe) → no flicker, no JS, no border issues.
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
          url: `https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`,
          left: (dx + Math.floor(cols/2)) * tileSize,
          top: (dy + Math.floor(rows/2)) * tileSize,
        });
      }
    }
    // Pin position relative to the grid (centered on coords)
    const pinLeft = Math.floor(cols/2) * tileSize + fracX * tileSize;
    const pinTop = Math.floor(rows/2) * tileSize + fracY * tileSize;
    return { tiles, pinLeft, pinTop, gridW: cols * tileSize, gridH: rows * tileSize };
  };
  const grid = (Platform.OS === 'web' && hasCoords) ? buildTileGrid() : null;

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
      <View style={[styles.mapContainer]}>
        {/* Best path: Google Static Maps (single image, marker baked in) */}
        {gmapsUrl ? (
          <Image
            source={{ uri: gmapsUrl }}
            style={styles.mapTileImage}
            resizeMode="cover"
            onError={() => {}}
          />
        ) : Platform.OS === 'web' && grid ? (
          <View style={[styles.mapContainer, { overflow: 'hidden', backgroundColor: '#e5e7eb' }]}>
            {/* Centered tile grid */}
            <View style={{
              position: 'absolute',
              left: '50%', top: '50%',
              width: grid.gridW, height: grid.gridH,
              marginLeft: -grid.gridW / 2,
              marginTop: -grid.gridH / 2,
            }}>
              {grid.tiles.map((tile, i) => (
                <Image
                  key={i}
                  source={{ uri: tile.url }}
                  style={{ position: 'absolute', left: tile.left, top: tile.top, width: 256, height: 256 }}
                  resizeMode="cover"
                />
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
        ) : hasCoords && tileUrl ? (
          /* Native: usar tile OSM como imagem de fundo */
          <View style={[styles.mapContainer, { overflow: 'hidden' }]}>
            <Image
              source={{ uri: tileUrl }}
              style={styles.mapTileImage}
              resizeMode="cover"
              onError={() => {}}
            />
            {/* Pin no centro */}
            <View style={styles.pinOverlay}>
              <View style={[styles.pinCircle, { backgroundColor: isOwn ? '#7C3AED' : safeColors.primary }]}>
                <IconMapPin size={18} color="#fff" />
              </View>
              <View style={[styles.pinTail, { borderTopColor: isOwn ? '#7C3AED' : safeColors.primary }]} />
            </View>
          </View>
        ) : (
          /* Fallback */
          <View style={[styles.mapContainer, { backgroundColor: isOwn ? '#7C3AED' : safeColors.primary, justifyContent: 'center', alignItems: 'center' }]}>
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
            {String(location.address || (hasCoords ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : 'Localiza\u00E7\u00E3o'))}
          </Text>
          <Text style={{ fontSize: 10, color: isOwn ? 'rgba(255,255,255,0.55)' : safeColors.textTertiary, marginTop: 2 }}>
            {location.accuracy != null ? `\u00B1${Math.round(location.accuracy)}m \u00B7 ` : ''}{t?.('chatConv.tapToOpenMap') || 'Toque para abrir'}
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
    width: '100%',
    height: 160,
    position: 'relative',
  },
  mapOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'transparent',
  },
  mapTileImage: {
    width: '100%',
    height: '100%',
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
