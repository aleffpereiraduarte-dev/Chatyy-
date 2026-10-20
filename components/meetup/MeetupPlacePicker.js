// [encontro 2026-10-19] "Onde" da folha Marcar encontro, nível WhatsApp/Apple.
//
//  - Busca de endereço via PROXY do servidor (email.php places_autocomplete/_details/_reverse):
//    Google Places (New) c/ session token quando GOOGLE_PLACES_KEY existe; senão Photon/OSM.
//    A chave nunca vem pro app. Servidor velho/offline → Nominatim direto (searchPlaces).
//  - Passo MAPA dentro da MESMA folha (sem Modal sobre Modal): ChatyyMapView nativo
//    (MapKit iOS / MapLibre Android, já no binário), pino central fixo que levanta ao
//    arrastar, botão "minha localização" e endereço reverso do ponto (geocoder do
//    aparelho → servidor).
//  - Sem ChatyyMapView (web/binário antigo/kill switch) → só a busca (o botão de mapa some).
//
// Kill switch OTA: globalThis.__chatyy_meetup_map = false → esconde o passo mapa.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, Platform, Keyboard } from 'react-native';
import Svg, { Path, Circle, Ellipse } from 'react-native-svg';
import { apiCall } from '../../services/api';
import { IconMapPin, IconSearch, IconX } from '../Icons';
import { ChatyyMap, isNativeMapAvailable, nativeMapStyleUrl, searchPlaces } from '../NativeMap';
import { MapFab, IconLocate } from '../MapControls';

const DEFAULT_CENTER = { latitude: -23.5505, longitude: -46.6333 }; // São Paulo (sem GPS e sem escolha)

export function meetupMapAvailable() {
  try { if (globalThis.__chatyy_meetup_map === false) return false; } catch {}
  return Platform.OS !== 'web' && isNativeMapAvailable();
}

export function newPlacesSession() {
  const r = () => Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}${r()}${r()}`.slice(0, 36);
}

function langOf(t) {
  let l = '';
  try { l = (t && t('_locale')) || ''; } catch {}
  if (!l || l === '_locale') l = 'pt-BR';
  return String(l).replace('_', '-');
}

/** Sugestões (proxy → fallback Nominatim). Item: {id, title, subtitle, lat?, lng?}. */
export async function placesSearch(q, { lang, session, bias } = {}) {
  const query = String(q || '').trim();
  if (query.length < 2) return [];
  try {
    const params = { q: query, lang, session };
    if (bias && Number.isFinite(bias.latitude)) { params.lat = bias.latitude.toFixed(3); params.lng = bias.longitude.toFixed(3); }
    const r = await apiCall('places_autocomplete', params, 'GET');
    if (r && r.success && r.data && Array.isArray(r.data.items)) return r.data.items;
  } catch {}
  try {
    const list = await searchPlaces(query, { lang });
    return list.map((p) => ({ id: p.id, title: p.title, subtitle: p.subtitle, lat: p.latitude, lng: p.longitude }));
  } catch { return []; }
}

/** Item → {title, address, lat, lng} (Google exige Place Details; OSM já vem com coords). */
export async function placesResolve(item, { lang, session } = {}) {
  if (!item) return null;
  if (Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lng))) {
    return { title: item.title || '', address: item.subtitle || '', lat: Number(item.lat), lng: Number(item.lng) };
  }
  try {
    const r = await apiCall('places_details', { id: item.id, lang, session }, 'GET');
    const d = r && r.success ? r.data : null;
    if (d && Number.isFinite(Number(d.lat))) {
      return { title: d.title || item.title || '', address: d.address || item.subtitle || '', lat: Number(d.lat), lng: Number(d.lng) };
    }
  } catch {}
  return null;
}

/** Endereço do ponto: geocoder do aparelho (Apple/Android, grátis) → servidor (Photon/Nominatim). */
export async function placesReverse(lat, lng, { lang } = {}) {
  try {
    const Location = require('expo-location');
    const res = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
    const p = res && res[0];
    if (p) {
      const street = [p.street, p.streetNumber].filter(Boolean).join(', ');
      const title = (p.name && p.name !== p.streetNumber && !/^\d+$/.test(String(p.name)) ? p.name : '') || street || p.district || p.city || '';
      const sub = [title === street ? '' : street, p.district || p.subregion, p.city, p.region].filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i && v !== title).join(', ');
      if (title) return { title, address: sub, lat, lng };
    }
  } catch {}
  try {
    const r = await apiCall('places_reverse', { lat: lat.toFixed(6), lng: lng.toFixed(6), lang }, 'GET');
    const d = r && r.success ? r.data : null;
    if (d && d.title) return { title: d.title, address: d.address || '', lat, lng };
  } catch {}
  return { title: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, address: '', lat, lng };
}

async function currentPosition({ ask = true } = {}) {
  try {
    const Location = require('expo-location');
    let perm = await Location.getForegroundPermissionsAsync();
    if (perm?.status !== 'granted' && ask) perm = await Location.requestForegroundPermissionsAsync();
    if (perm?.status !== 'granted') return null;
    const last = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60000 }).catch(() => null);
    if (last?.coords && !ask) return { latitude: last.coords.latitude, longitude: last.coords.longitude };
    const fresh = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise((res) => setTimeout(() => res(null), 8000)),
    ]).catch(() => null);
    const c = fresh?.coords || last?.coords;
    return c ? { latitude: c.latitude, longitude: c.longitude } : null;
  } catch { return null; }
}

// ─── busca com sugestões (formulário e passo mapa) ──────────────────────────
export function PlaceSearchField({ colors, t, session, bias, onResolved, autoFocus, placeholder, compact }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState(null);
  const [focused, setFocused] = useState(false);
  const seqRef = useRef(0);
  const timerRef = useRef(null);
  const lang = langOf(t);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const text = q.trim();
    if (text.length < 2) { setItems([]); setBusy(false); return undefined; }
    const seq = ++seqRef.current;
    setBusy(true);
    timerRef.current = setTimeout(async () => {
      const list = await placesSearch(text, { lang, session: session && session.current, bias });
      if (seq !== seqRef.current) return;
      setItems(list || []);
      setBusy(false);
    }, 280);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async (it) => {
    setResolving(it.id);
    const place = await placesResolve(it, { lang, session: session && session.current });
    setResolving(null);
    if (!place) return;
    // Google: a sessão termina no Details → próxima busca abre sessão nova.
    if (session) session.current = newPlacesSession();
    seqRef.current++;
    setItems([]);
    setQ('');
    try { Keyboard.dismiss(); } catch {}
    onResolved && onResolved(place);
  };

  return (
    <View>
      <View style={{
        flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surfaceVariant, borderRadius: compact ? 12 : 14,
        borderWidth: 1, borderColor: focused ? colors.text : colors.border, paddingHorizontal: 12, minHeight: compact ? 42 : 48,
      }}>
        <IconSearch size={17} color={colors.textSecondary} />
        <TextInput
          style={{ flex: 1, paddingVertical: compact ? 9 : 12, marginLeft: 8, fontSize: 15, color: colors.text }}
          placeholder={placeholder || (t && t('chatConv.meetupSearchPlace')) || 'Buscar lugar ou endereço'}
          placeholderTextColor={colors.textTertiary}
          value={q}
          onChangeText={setQ}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          autoFocus={autoFocus}
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel={(t && t('chatConv.meetupSearchPlace')) || 'Buscar lugar ou endereço'}
        />
        {busy ? <ActivityIndicator size="small" color={colors.textSecondary} /> : null}
        {!busy && q.length > 0 ? (
          <TouchableOpacity onPress={() => setQ('')} hitSlop={10} accessibilityRole="button" accessibilityLabel={(t && t('common.clear')) || 'Limpar'}>
            <IconX size={16} color={colors.textSecondary} />
          </TouchableOpacity>
        ) : null}
      </View>
      {items.length > 0 ? (
        <View style={{ marginTop: 6, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, overflow: 'hidden' }}>
          {items.map((it, idx) => (
            <TouchableOpacity
              key={String(it.id) + idx}
              onPress={() => pick(it)}
              activeOpacity={0.6}
              accessibilityRole="button"
              style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 11, gap: 10, borderTopWidth: idx ? 0.5 : 0, borderTopColor: colors.border }}
            >
              <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: colors.surfaceVariant, alignItems: 'center', justifyContent: 'center' }}>
                <IconMapPin size={15} color={colors.text} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14.5, fontWeight: '600', color: colors.text }} numberOfLines={1}>{it.title}</Text>
                {it.subtitle ? <Text style={{ fontSize: 12.5, color: colors.textSecondary, marginTop: 1 }} numberOfLines={1}>{it.subtitle}</Text> : null}
              </View>
              {resolving === it.id ? <ActivityIndicator size="small" color={colors.textSecondary} /> : null}
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function CenterPin({ ink, onInk }) {
  return (
    <Svg width={40} height={52} viewBox="0 0 40 52">
      <Ellipse cx="20" cy="49" rx="6" ry="2.4" fill="rgba(0,0,0,0.25)" />
      <Path d="M20 2C10.6 2 3 9.4 3 18.6 3 31 20 48 20 48s17-17 17-29.4C37 9.4 29.4 2 20 2z" fill={ink} />
      <Circle cx="20" cy="18.5" r="6.2" fill={onInk} />
    </Svg>
  );
}

// ─── passo mapa ─────────────────────────────────────────────────────────────
export function MeetupMapStep({ colors, t, isDark, initial, session, mapHeight = 340, onConfirm }) {
  const lang = langOf(t);
  const ink = isDark ? '#F5F5F7' : '#111111';
  const onInk = isDark ? '#111111' : '#FFFFFF';
  const startRef = useRef(initial && Number.isFinite(initial.lat)
    ? { latitude: initial.lat, longitude: initial.lng }
    : null);
  const [center, setCenter] = useState(startRef.current);
  const [camera, setCamera] = useState(() => (startRef.current
    ? { ...startRef.current, zoom: 16, seq: 1 }
    : { ...DEFAULT_CENTER, zoom: 11, seq: 1 }));
  const [me, setMe] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [place, setPlace] = useState(initial && Number.isFinite(initial.lat) ? initial : null);
  const [geoBusy, setGeoBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const seqRef = useRef(1);
  const geoSeqRef = useRef(0);
  const geoTimerRef = useRef(null);
  const lockRef = useRef(initial && Number.isFinite(initial.lat) ? initial : null); // lugar escolhido na busca: não sobrescrever pelo reverso

  const goTo = useCallback((lat, lng, zoom = 16) => {
    seqRef.current += 1;
    setCamera({ latitude: lat, longitude: lng, zoom, animated: true, seq: seqRef.current });
  }, []);

  const reverse = useCallback((lat, lng) => {
    const seq = ++geoSeqRef.current;
    if (geoTimerRef.current) clearTimeout(geoTimerRef.current);
    setGeoBusy(true);
    geoTimerRef.current = setTimeout(async () => {
      const p = await placesReverse(lat, lng, { lang });
      if (seq !== geoSeqRef.current) return;
      setPlace(p);
      setGeoBusy(false);
    }, 380);
  }, [lang]);

  // Sem local escolhido: centra na posição atual (pede permissão uma vez).
  useEffect(() => {
    let alive = true;
    (async () => {
      const pos = await currentPosition({ ask: !startRef.current });
      if (!alive || !pos) return;
      setMe(pos);
      if (!startRef.current) { goTo(pos.latitude, pos.longitude, 16); }
    })();
    return () => { alive = false; if (geoTimerRef.current) clearTimeout(geoTimerRef.current); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onRegionDidChange = useCallback((r) => {
    setDragging(false);
    const la = Number(r?.latitude); const lo = Number(r?.longitude);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return;
    setCenter({ latitude: la, longitude: lo });
    const lk = lockRef.current;
    if (lk && !r?.gesture && Math.abs(lk.lat - la) < 0.0002 && Math.abs(lk.lng - lo) < 0.0002) {
      setPlace(lk); setGeoBusy(false); return;
    }
    if (r?.gesture) lockRef.current = null;
    reverse(la, lo);
  }, [reverse]);

  const locateMe = async () => {
    setLocating(true);
    const pos = await currentPosition({ ask: true });
    setLocating(false);
    if (!pos) return;
    setMe(pos);
    lockRef.current = null;
    goTo(pos.latitude, pos.longitude, 17);
  };

  const markers = useMemo(() => (me ? [{ id: 'me', latitude: me.latitude, longitude: me.longitude, kind: 'dot', color: '#3B82F6' }] : []), [me]);
  const styleUrl = useMemo(() => nativeMapStyleUrl(camera.latitude, camera.longitude, isDark), [isDark]); // eslint-disable-line react-hooks/exhaustive-deps
  const canConfirm = !!center && !!place && !geoBusy && !dragging;

  return (
    <View>
      <PlaceSearchField
        colors={colors}
        t={t}
        compact
        session={session}
        bias={center || me}
        onResolved={(p) => { lockRef.current = p; setPlace(p); setGeoBusy(false); goTo(p.lat, p.lng, 17); }}
      />
      <View style={{ height: mapHeight, borderRadius: 18, overflow: 'hidden', marginTop: 10, backgroundColor: isDark ? '#1c1c1e' : '#ECECEE', borderWidth: 1, borderColor: colors.border }}>
        <ChatyyMap
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          dark={isDark}
          styleUrl={styleUrl}
          camera={camera}
          markers={markers}
          rotateEnabled={false}
          onRegionWillChange={(e) => { if (e?.gesture) { setDragging(true); geoSeqRef.current++; } }}
          onRegionDidChange={onRegionDidChange}
        />
        {/* ponta do pino (y=48 do SVG 40x52) exatamente no centro do mapa; levanta ao arrastar */}
        <View pointerEvents="none" style={{ position: 'absolute', top: '50%', left: '50%', marginLeft: -20, marginTop: -48, transform: [{ translateY: dragging ? -10 : 0 }] }}>
          <CenterPin ink={ink} onInk={onInk} />
        </View>
        <View pointerEvents="box-none" style={{ position: 'absolute', right: 10, bottom: 10 }}>
          <MapFab isDark={isDark} size={42} onPress={locateMe} accessibilityLabel={(t && t('chatConv.meetupUseMyLocation')) || 'Usar minha localização'}>
            {locating ? <ActivityIndicator size="small" color={ink} /> : <IconLocate size={19} color={isDark ? '#fff' : '#111'} />}
          </MapFab>
        </View>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12, minHeight: 48, gap: 12 }}>
        <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surfaceVariant, alignItems: 'center', justifyContent: 'center' }}>
          <IconMapPin size={18} color={colors.text} />
        </View>
        <View style={{ flex: 1 }}>
          {(geoBusy || dragging || !place) ? (
            <Text style={{ fontSize: 14, color: colors.textSecondary }}>
              {dragging ? ((t && t('chatConv.meetupMoveMap')) || 'Solte o pino no local do encontro') : ((t && t('chatConv.meetupFindingAddress')) || 'Buscando endereço...')}
            </Text>
          ) : (
            <>
              <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }} numberOfLines={1}>{place.title}</Text>
              {place.address ? <Text style={{ fontSize: 12.5, color: colors.textSecondary, marginTop: 1 }} numberOfLines={2}>{place.address}</Text> : null}
            </>
          )}
        </View>
      </View>

      <TouchableOpacity
        onPress={() => { if (canConfirm) onConfirm && onConfirm({ ...place, lat: lockRef.current ? place.lat : center.latitude, lng: lockRef.current ? place.lng : center.longitude }); }}
        disabled={!canConfirm}
        activeOpacity={0.85}
        accessibilityRole="button"
        style={{ marginTop: 14, backgroundColor: canConfirm ? colors.text : colors.border, borderRadius: 14, paddingVertical: 15, alignItems: 'center' }}
      >
        <Text style={{ color: canConfirm ? (colors.background || colors.surface) : colors.textTertiary, fontSize: 16, fontWeight: '700' }}>
          {(t && t('chatConv.meetupConfirmPlace')) || 'Confirmar local'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}
