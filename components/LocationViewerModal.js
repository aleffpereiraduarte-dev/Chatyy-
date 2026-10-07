// LocationViewerModal — [2026-10-07 native-maps] full-screen location viewer
// (static pin or LIVE location) on the native ChatyyMapView.
//
// Same props as chat-conversation's MapModal + `Fallback`: when the binary has
// no native map (web / older builds) we render <Fallback {...props}/> — i.e.
// the existing MapLibre-GL-JS WebView MapModal, byte-for-byte unchanged.
//
// Native extras over the WebView version:
//   - live marker glides natively on every `live_location_update` WS tick and
//     the camera follows it until the user pans (then a "recenter" FAB shows);
//   - "my location" FAB (only if location permission is ALREADY granted — we
//     never prompt from a viewer) fits me + the shared point, with distance;
//   - "Como chegar" opens the user's own maps app (geo: / maps.apple.com).

import React from 'react';
import { View, Text, TouchableOpacity, Modal, Platform, Linking, StatusBar } from 'react-native';
import { IconArrowLeft, IconNavigation, IconMapPin } from './Icons';
import { useLanguage } from '../context/LanguageContext';
import { useTheme } from '../context/ThemeContext';
import { ChatyyMap, isNativeMapAvailable, nativeMapStyleUrl } from './NativeMap';
import { IconLocate, MapFab } from './MapControls';

function haversine(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(bLat - aLat);
  const dLng = toR(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function fmtDistance(m) {
  if (!Number.isFinite(m)) return '';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
}

function NativeLocationViewer({ visible, onClose, lat, lng, label, isLive, liveUntil, isUnlimited, messageId }) {
  const { t } = useLanguage();
  const theme = useTheme() || {};
  const isDark = !!theme.isDark;
  const numLat = Number(lat);
  const numLng = Number(lng);
  const safeLabel = String(label || '').replace(/[<>'"`\\]/g, '').slice(0, 200);

  const [pos, setPos] = React.useState({ lat: numLat, lng: numLng });
  const [me, setMe] = React.useState(null);
  const [following, setFollowing] = React.useState(true);
  const [camera, setCamera] = React.useState(() => ({ latitude: numLat, longitude: numLng, zoom: 16, seq: 1 }));
  const seqRef = React.useRef(1);
  const followingRef = React.useRef(true);
  followingRef.current = following;

  // Reset when a different location is opened.
  React.useEffect(() => {
    if (!visible) return;
    setPos({ lat: numLat, lng: numLng });
    setFollowing(true);
    seqRef.current += 1;
    setCamera({ latitude: numLat, longitude: numLng, zoom: 16, seq: seqRef.current });
  }, [visible, numLat, numLng]);

  const [nowSec, setNowSec] = React.useState(() => Math.floor(Date.now() / 1000));
  React.useEffect(() => {
    if (!visible || !isLive) return undefined;
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 5000);
    return () => clearInterval(id);
  }, [visible, isLive]);
  const effUnlimited = !!isUnlimited || (isLive && liveUntil && (Number(liveUntil) - nowSec) > (365 * 24 * 3600));
  const isStillLive = !!(isLive && (effUnlimited || (liveUntil && nowSec < Number(liveUntil))));

  // Live ticks (same WS contract MapModal uses; filtered by message_id).
  React.useEffect(() => {
    if (!visible || !isStillLive || !messageId) return undefined;
    let mailWs;
    try { mailWs = require('../services/websocket').default; } catch { return undefined; }
    if (!mailWs?.on) return undefined;
    const unsub = mailWs.on('live_location_update', (data) => {
      if (String(data?.message_id ?? '') !== String(messageId)) return;
      const nLat = Number(data?.latitude);
      const nLng = Number(data?.longitude);
      if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return;
      setPos({ lat: nLat, lng: nLng });
      if (followingRef.current) {
        seqRef.current += 1;
        setCamera((c) => ({ latitude: nLat, longitude: nLng, zoom: c?.zoom || 16, animated: true, seq: seqRef.current }));
      }
    });
    return () => { try { unsub?.(); } catch {} };
  }, [visible, isStillLive, messageId]);

  // "Me" dot — only when permission is already granted (never prompt here).
  React.useEffect(() => {
    if (!visible) return undefined;
    let alive = true;
    (async () => {
      try {
        const Location = require('expo-location');
        const perm = await Location.getForegroundPermissionsAsync();
        if (!alive || perm?.status !== 'granted') return;
        const last = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60 * 1000 });
        if (alive && last?.coords) setMe({ lat: last.coords.latitude, lng: last.coords.longitude });
      } catch {}
    })();
    return () => { alive = false; };
  }, [visible]);

  const markers = React.useMemo(() => {
    const list = [];
    if (me) list.push({ id: 'me', latitude: me.lat, longitude: me.lng, kind: 'dot', color: '#3B82F6' });
    list.push(isStillLive
      ? { id: 'target', latitude: pos.lat, longitude: pos.lng, kind: 'live', color: '#22C55E' }
      : { id: 'target', latitude: pos.lat, longitude: pos.lng, kind: 'pin', color: '#DC2626' });
    return list;
  }, [me, pos.lat, pos.lng, isStillLive]);

  const recenter = () => {
    setFollowing(true);
    seqRef.current += 1;
    setCamera({ latitude: pos.lat, longitude: pos.lng, zoom: 16, animated: true, seq: seqRef.current });
  };

  const fitMe = async () => {
    let mine = me;
    try {
      const Location = require('expo-location');
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm?.status === 'granted') {
        const fresh = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (fresh?.coords) { mine = { lat: fresh.coords.latitude, lng: fresh.coords.longitude }; setMe(mine); }
      }
    } catch {}
    if (!mine) return;
    setFollowing(false);
    seqRef.current += 1;
    setCamera({
      latitude: pos.lat, longitude: pos.lng, zoom: 15, animated: true, seq: seqRef.current,
      minLatitude: Math.min(mine.lat, pos.lat), minLongitude: Math.min(mine.lng, pos.lng),
      maxLatitude: Math.max(mine.lat, pos.lat), maxLongitude: Math.max(mine.lng, pos.lng),
      padding: 80, maxZoom: 16,
    });
  };

  const openDirections = () => {
    const name = encodeURIComponent(safeLabel || 'Local');
    const url = Platform.OS === 'ios'
      ? `http://maps.apple.com/?daddr=${pos.lat},${pos.lng}&q=${name}`
      : `geo:${pos.lat},${pos.lng}?q=${pos.lat},${pos.lng}(${name})`;
    Linking.openURL(url).catch(() => {
      Linking.openURL(`https://www.openstreetmap.org/?mlat=${pos.lat}&mlon=${pos.lng}#map=17/${pos.lat}/${pos.lng}`).catch(() => {});
    });
  };

  if (!visible || !Number.isFinite(numLat) || !Number.isFinite(numLng)) return null;

  const distance = me ? fmtDistance(haversine(me.lat, me.lng, pos.lat, pos.lng)) : '';
  const remainingLabel = (() => {
    if (!isStillLive || effUnlimited || !liveUntil) return '';
    const remaining = Math.max(0, Number(liveUntil) - nowSec);
    const m = Math.floor(remaining / 60);
    if (m >= 60) { const h = Math.floor(m / 60); return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : ''); }
    return m + 'm';
  })();
  const cardBg = isDark ? 'rgba(20,21,26,0.95)' : 'rgba(255,255,255,0.98)';
  const fg = isDark ? '#fff' : '#111';
  const sub = isDark ? 'rgba(255,255,255,0.65)' : '#6b7280';

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: isDark ? '#000' : '#e5e7eb' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: Platform.OS === 'ios' ? 50 : ((StatusBar.currentHeight || 24) + 10), paddingHorizontal: 12, paddingBottom: 10, backgroundColor: isStillLive ? '#16a34a' : '#111111' }}>
          <TouchableOpacity onPress={onClose} style={{ padding: 8 }} accessibilityLabel={t('common.close') || 'Fechar'} accessibilityRole="button">
            <IconArrowLeft size={22} color="#fff" />
          </TouchableOpacity>
          <View style={{ flex: 1, marginLeft: 8 }}>
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }} numberOfLines={1}>
              {safeLabel || (t('chatConv.location') || 'Localização')}
            </Text>
            {isStillLive ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
                <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: '#fff' }} />
                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700', letterSpacing: 0.4 }}>
                  {t('chatConv.liveBadge') || 'AO VIVO'}
                </Text>
                {effUnlimited ? (
                  <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 11 }}>
                    · ∞ {t('snapmap.alwaysOn') || 'sempre ativo'}
                  </Text>
                ) : remainingLabel ? (
                  <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 11 }}>· {remainingLabel}</Text>
                ) : null}
              </View>
            ) : isLive ? (
              <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 12 }}>
                {t('chatConv.liveLocationEnded') || 'Encerrada'}
              </Text>
            ) : null}
          </View>
          <TouchableOpacity onPress={openDirections} style={{ padding: 8 }} accessibilityLabel={t('chatConv.openMaps') || 'Abrir no mapa'} accessibilityRole="button">
            <IconNavigation size={20} color="#fff" />
          </TouchableOpacity>
        </View>

        <View style={{ flex: 1 }}>
          <ChatyyMap
            style={{ flex: 1 }}
            dark={isDark}
            styleUrl={nativeMapStyleUrl(numLat, numLng, isDark)}
            camera={camera}
            markers={markers}
            onRegionWillChange={(e) => { if (e?.gesture) setFollowing(false); }}
          />

          <View pointerEvents="box-none" style={{ position: 'absolute', right: 14, bottom: 120, gap: 12 }}>
            {!following ? (
              <MapFab isDark={isDark} onPress={recenter} accessibilityLabel={t('maps.recenter') || 'Centralizar'}>
                <IconMapPin size={20} color={isStillLive ? '#16a34a' : '#DC2626'} />
              </MapFab>
            ) : null}
            <MapFab isDark={isDark} onPress={fitMe} accessibilityLabel={t('maps.myLocation') || 'Minha localização'}>
              <IconLocate size={20} color={isDark ? '#fff' : '#111'} />
            </MapFab>
          </View>

          <View style={{
            position: 'absolute', left: 14, right: 14, bottom: Platform.OS === 'ios' ? 34 : 18,
            backgroundColor: cardBg, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 12,
            flexDirection: 'row', alignItems: 'center', gap: 12,
            shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 6,
          }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: fg, fontSize: 15, fontWeight: '700' }} numberOfLines={1}>
                {safeLabel || (t('chatConv.location') || 'Localização')}
              </Text>
              <Text style={{ color: sub, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                {pos.lat.toFixed(5)}, {pos.lng.toFixed(5)}{distance ? ` · ${distance}` : ''}
              </Text>
            </View>
            <TouchableOpacity
              onPress={openDirections}
              style={{ backgroundColor: '#16a34a', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 9, flexDirection: 'row', alignItems: 'center', gap: 6 }}
              accessibilityRole="button"
            >
              <IconNavigation size={15} color="#fff" />
              <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>{t('maps.directions') || 'Como chegar'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export default function LocationViewerModal({ Fallback, ...props }) {
  if (!props.visible) return null;
  if (!isNativeMapAvailable()) return Fallback ? <Fallback {...props} /> : null;
  return <NativeLocationViewer {...props} />;
}
