import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, Linking, StyleSheet, Share, Platform, Dimensions, Image as RNImage } from 'react-native';
import { IconMapPin } from './Icons';
import { boraStaticMapUrl } from './BoraMap';

// Bubble width — used so Image gets explicit pixel dimensions instead of
// percentage. RN Image with width:'100%' on a parent that briefly measures
// 0 during scroll/recycle can collapse to 0×0 and never re-fetch even
// after the parent resolves real width. Pixel dimensions sidestep that.
const BUBBLE_WIDTH = Math.min(Dimensions.get('window').width - 80, 280);
const BUBBLE_HEIGHT = 160;

// [2026-06-24] Google Maps REMOVIDO. Mapa do balão vem do nosso tile server
// self-hosted (BoraUm / OpenStreetMap) via boraStaticMapUrl — zero billing Google,
// zero chave. O styleId é escolhido por país automaticamente (coverageStyleFor).

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
  const [tileLoaded, setTileLoaded] = useState(false);
  const [tileProvider, setTileProvider] = useState('bora'); // 'bora' | 'failed'

  useEffect(() => {
    try {
      const loc = typeof content === 'string' ? JSON.parse(content) : content;
      setLocation(loc);
      // Reset tile state when location changes (new message in same component)
      setTileError(false);
      setTileLoaded(false);
      setTileProvider('bora');
    } catch (err) {
      console.warn('LocationMessage parse error:', err);
    }
  }, [content]);

  // Watchdog: some Android RN Image instances NEVER fire onLoad nor onError
  // (silent network stall, SSL handshake hang, image loader pool exhausted,
  // or the Image getting recycled out of the list before either callback
  // fires). Without this the bubble stays gray forever — the visual symptom
  // users keep reporting.
  //
  // [2026-05-26] Tightened from 6s→4s per step, and once we're on the 2nd
  // provider (osm) a single timeout drops straight to the solid fallback
  // instead of stretching the worst case to ~12s of gray. We also clear the
  // pending timer on unmount via the returned cleanup so a recycled cell
  // doesn't leave a dangling setState-after-unmount.
  useEffect(() => {
    if (!location || tileLoaded || tileError || tileProvider === 'failed') return undefined;
    const id = setTimeout(() => {
      if (!tileLoaded && !tileError) {
        // Único provider agora (BoraUm). Se travou, cai direto pro fallback sólido.
        setTileProvider('failed');
        setTileError(true);
      }
    }, 4000);
    return () => clearTimeout(id);
  }, [location, tileLoaded, tileError, tileProvider]);

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
    return boraStaticMapUrl(location.latitude, location.longitude, 15, BUBBLE_WIDTH, BUBBLE_HEIGHT);
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

  // [2026-06-24] Google Maps REMOVIDO. O balão usa a Static Image API do nosso
  // tile server self-hosted (BoraUm / OpenStreetMap). Sem chave, sem billing.
  // O tileserver NÃO desenha o pin server-side → desenhamos um pin sobreposto
  // centralizado (a imagem é centrada nas coords, então o centro = a localização).
  const tileUrl = hasCoords
    ? boraStaticMapUrl(lat, lng, 15, BUBBLE_WIDTH, BUBBLE_HEIGHT)
    : null;

  const handleTileError = (err) => {
    console.warn('LocationMessage tile failed:', tileUrl, err?.nativeEvent || err);
    setTileProvider('failed');
    setTileError(true);
  };

  // [2026-06-24] Web e native agora usam a MESMA imagem estática do BoraUm
  // (single <Image> + pin sobreposto). O mosaico de tiles (buildTileGrid) foi
  // aposentado — grid fica null pra cair sempre no caminho da imagem única.
  const grid = null;

  // Tile image renderer — picks expo-image (native) or RN Image (web/fallback).
  // expo-image gets a recyclingKey so when the URL changes (provider fallback,
  // cache-bust bump) it forces a fresh fetch instead of reusing a stale slot.
  // Explicit width/height (not %) on the inner Image to avoid any layout race
  // where the tile renders 0×0 before the parent measures.
  const renderTileImage = (uri, style) => {
    if (!uri) return null;
    return (
      <RNImage
        key={uri}
        source={{ uri }}
        style={style}
        resizeMode="cover"
        onError={(e) => {
          // Surface the failure to console — visible in Xcode/Android logs.
          // Many "gray map" reports trace back to silent network errors.
          try { console.warn('[LocationMessage] tile failed:', uri, e?.nativeEvent?.error || e); } catch {}
          handleTileError(e);
        }}
        onLoad={() => {
          setTileLoaded(true);
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
          /* [2026-06-24] Imagem estática única do BoraUm (OSM self-hosted).
             Inner View sem backgroundColor pra a imagem aparecer (bg cinza era
             o sintoma do "mapa cinza"). O tileserver NÃO desenha pin, então
             sobrepomos um pin centralizado — a imagem é centrada nas coords. */
          <View style={[styles.mapContainerInner, { overflow: 'hidden' }]}>
            {renderTileImage(tileUrl, styles.mapTileImage)}
            <View style={styles.pinOverlay} pointerEvents="none">
              <View style={[styles.pinCircle, { backgroundColor: '#dc2626' }]}>
                <IconMapPin size={18} color="#fff" />
              </View>
              <View style={[styles.pinTail, { borderTopColor: '#dc2626' }]} />
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
