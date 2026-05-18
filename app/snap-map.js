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
// Why a static-map image instead of react-native-maps
// ---------------------------------------------------
// react-native-maps is a NATIVE module and adding it triggers a TestFlight
// build + Play Store re-submit. To keep the feature shippable as OTA we
// render a Geoapify static tile + absolute-positioned avatar overlays,
// projecting lat/lng → screen pixels via a Web-Mercator approximation.
// It's not pan-zoom but it shows pins, names, and refreshes in real time
// — enough for v1. Phase 2 swap-in is `react-native-webview` w/ Leaflet,
// no native rebuild required.
//
// Privacy contract (matches backend chat.php BEGIN FRIEND_LOCATION_TRACKING):
//   - Backend never returns shares without an active grant. Frontend
//     never persists a pin past a `location_share_revoked` event.
//   - "Parar de receber" hits chat_friend_location_revoke (delete grant
//     on either side); WS revoke is broadcast and listeners drop the pin.

import { useState, useEffect, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Image,
  ScrollView, Dimensions, Modal, Pressable, ActivityIndicator, Alert,
  Linking,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { triggerLocationRequestModal } from '../components/LocationRequestModal';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import AvatarCircle from '../components/AvatarCircle';
import {
  IconArrowLeft, IconMapPin, IconUser, IconMessageSquare, IconX,
} from '../components/Icons';

// mailWs is the singleton WS bridge — re-uses the connection chat-conv
// holds, so subscribing here is essentially free.
let mailWs = null;
try { mailWs = require('../services/mailWs').default; } catch {}

const { width: SW, height: SH } = Dimensions.get('window');

// Tile served by Geoapify free tier (60K hits/month, already in use
// across the app for static map previews — see chatyy/static_map.php
// notes). Switch to chatyy.com.br/api/static_map.php for self-hosted
// when traffic grows.
const STATIC_MAP_KEY = '0457440ba1db4f5a80840e87a1a2fd60';
const ZOOM = 12;

// Web-Mercator pixel projection. Given a tile zoom + the map center, we
// can map any (lat,lng) within the visible viewport to (x,y) screen px.
// Same math the gmaps JS uses; just rolled by hand so we don't ship
// google's API key + iframe overhead.
function project(lat, lng, centerLat, centerLng, mapW, mapH, zoom) {
  const worldSize = 256 * Math.pow(2, zoom);
  const toX = (l) => ((l + 180) / 360) * worldSize;
  const toY = (lt) => {
    const sin = Math.sin((lt * Math.PI) / 180);
    return (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * worldSize;
  };
  const cx = toX(centerLng);
  const cy = toY(centerLat);
  const px = toX(lng);
  const py = toY(lat);
  return {
    x: mapW / 2 + (px - cx),
    y: mapH / 2 + (py - cy),
  };
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
  const center = useMemo(() => {
    if (myLocation) return myLocation;
    if (shares[0] && Number.isFinite(shares[0].latitude)) return { lat: shares[0].latitude, lng: shares[0].longitude };
    return { lat: -15.77, lng: -47.92 };
  }, [myLocation, shares]);

  // Map viewport in pixels. Header eats ~60px on top + 64px on bottom
  // for the chip row. Math is approximate but the projection only needs
  // the *render* width/height, not the device.
  const mapW = SW;
  const mapH = SH - 60 - 64;

  const mapUrl = `https://maps.geoapify.com/v1/staticmap?style=osm-bright${isDark ? '-smooth' : ''}&width=${Math.min(mapW * 2, 1200)}&height=${Math.min(mapH * 2, 1200)}&center=lonlat:${center.lng},${center.lat}&zoom=${ZOOM}&apiKey=${STATIC_MAP_KEY}`;

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
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: Platform.OS === 'ios' ? 50 : 14, paddingBottom: 14, backgroundColor: isDark ? '#0d0d0d' : '#fff', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)', zIndex: 10 }}>
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

      {/* Map */}
      <View style={{ flex: 1, position: 'relative', backgroundColor: isDark ? '#1a1a1a' : '#e5e7eb' }}>
        <Image source={{ uri: mapUrl }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />

        {/* Friend pins — projected from lat/lng via Web-Mercator */}
        {shares.map((loc) => {
          if (!Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) return null;
          const { x, y } = project(loc.latitude, loc.longitude, center.lat, center.lng, mapW, mapH, ZOOM);
          if (x < -50 || x > mapW + 50 || y < -50 || y > mapH + 50) return null;
          return (
            <TouchableOpacity
              key={loc.email}
              onPress={() => setSelected(loc)}
              style={{ position: 'absolute', left: x - 26, top: y - 30, alignItems: 'center' }}
            >
              <View style={{
                borderWidth: 3,
                borderColor: loc.is_unlimited ? '#7C3AED' : '#22c55e',
                borderRadius: 28,
                padding: 2,
                backgroundColor: '#fff',
                ...(Platform.OS === 'web' ? { boxShadow: '0 3px 12px rgba(0,0,0,0.35)' } : {}),
                ...(Platform.OS !== 'web' ? { shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 6, shadowOffset: { width: 0, height: 3 }, elevation: 6 } : {}),
              }}>
                <AvatarCircle name={loc.name || loc.email} email={loc.email} size={44} />
              </View>
              <View style={{ backgroundColor: 'rgba(0,0,0,0.78)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, marginTop: 3, maxWidth: 110 }}>
                <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }} numberOfLines={1}>
                  {(loc.name || loc.email?.split('@')[0] || '?')}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}

        {/* My location dot — pinned to map center */}
        {myLocation && (
          <View style={{ position: 'absolute', left: mapW / 2 - 18, top: mapH / 2 - 18, alignItems: 'center', pointerEvents: 'none' }}>
            <View style={{
              borderWidth: 3, borderColor: '#3B82F6', borderRadius: 22, padding: 2, backgroundColor: '#fff',
              ...(Platform.OS === 'web' ? { boxShadow: '0 0 24px rgba(59,130,246,0.55)' } : {}),
            }}>
              <AvatarCircle name={user?.name} email={user?.email} size={32} />
            </View>
            <View style={{ backgroundColor: '#3B82F6', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, marginTop: 3 }}>
              <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>{t?.('snapmap.you') || 'Você'}</Text>
            </View>
          </View>
        )}

        {/* Loading badge */}
        {loading && (
          <View style={{ position: 'absolute', top: 14, alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.7)', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ActivityIndicator size="small" color="#fff" />
            <Text style={{ color: '#fff', fontSize: 13 }}>{t?.('common.loading') || 'Carregando…'}</Text>
          </View>
        )}

        {/* Empty state */}
        {!loading && shares.length === 0 && (
          <View style={{ position: 'absolute', top: mapH * 0.32, alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.78)', padding: 22, borderRadius: 18, maxWidth: 320, marginHorizontal: 16 }}>
            <IconMapPin size={36} color="#fff" style={{ alignSelf: 'center' }} />
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700', textAlign: 'center', marginTop: 12 }}>
              {t?.('snapmap.empty') || 'Nenhum amigo dividindo localização'}
            </Text>
            <Text style={{ color: 'rgba(255,255,255,0.82)', fontSize: 13, textAlign: 'center', marginTop: 6, lineHeight: 18 }}>
              {t?.('snapmap.emptyHint') || 'Peça pra um amigo no chat compartilhar a localização ao vivo, ou ative o seu para eles te verem aqui.'}
            </Text>
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
