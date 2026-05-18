// LocationPickerSheet — WhatsApp-style bottom sheet for sharing GPS.
//
// Why this exists
// ---------------
// User reported that the old flow (tap → fetchGPS → send) was a black box:
// if GPS took 12s+ they saw nothing, and the only feedback on failure was a
// generic "Não foi possível obter a localização" alert AFTER the timeout.
//
// WhatsApp's pattern is to open a sheet FIRST: user sees a spinner while
// GPS resolves, then a small preview map + the address, with one explicit
// "Enviar localização atual" CTA. That's what we mirror here.
//
// We don't have `react-native-maps` (would require a native rebuild) so we
// route through the backend's `static_map.php` endpoint (CartoCDN tiles
// composed server-side into a single PNG with red pin overlay, 7d edge
// cache). Original implementation used Google Maps Static API directly,
// but that returns 403 without an API key — leaving an empty grey box in
// the share preview. Static-map proxy renders reliably across web + RN.
//
// Props
// -----
//   visible    boolean
//   onClose    () => void
//   onSend     ({ latitude, longitude, address }) => void
//   colors     ThemeContext colors
//   t          i18n t() function

import React, { useEffect, useState, useRef } from 'react';
import {
  View, Text, TouchableOpacity, Modal, Pressable, ActivityIndicator,
  Image, Platform, KeyboardAvoidingView, TextInput,
} from 'react-native';
import { IconMapPin, IconX } from './Icons';
import * as api from '../services/api';

// Server-side static map proxy. CartoCDN tiles + red pin overlay, 7d edge
// cache. No API key needed (server side handles the upstream).
const STATIC_MAP_PATH = '/api/static_map.php';

const LIVE_DURATIONS = [
  { key: '15m', label: '15 min', seconds: 15 * 60 },
  { key: '1h',  label: '1 hora', seconds: 60 * 60 },
  { key: '8h',  label: '8 horas', seconds: 8 * 60 * 60 },
];

export default function LocationPickerSheet({ visible, onClose, onSend, onLiveStart, colors, t }) {
  const [loading, setLoading] = useState(true);
  const [coords, setCoords] = useState(null); // { latitude, longitude, accuracy }
  const [address, setAddress] = useState('');
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  // WhatsApp-style live-share confirmation: after the user taps a duration
  // chip we DON'T immediately start broadcasting. We swap the sheet body
  // for a confirmation view (map preview + selected duration + privacy
  // note + big primary "Compartilhar ao vivo" CTA). Set back to null to
  // return to the chips. Caption is optional and gets passed to onLiveStart
  // so the parent can include it in the live-location WS payload.
  const [liveConfirm, setLiveConfirm] = useState(null); // { seconds, label }
  const [liveCaption, setLiveCaption] = useState('');
  const cancelRef = useRef(false);

  // Reset confirm step + caption when sheet closes/reopens so a previous
  // selection doesn't bleed into the next session.
  useEffect(() => {
    if (!visible) {
      setLiveConfirm(null);
      setLiveCaption('');
      setSending(false);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    cancelRef.current = false;
    setLoading(true);
    setError(null);
    setCoords(null);
    setAddress('');

    (async () => {
      try {
        const Location = require('expo-location');
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (!active || cancelRef.current) return;
        if (status !== 'granted') {
          setError(t?.('chatConv.locationPermission') || 'Permita o acesso à localização nas configurações.');
          setLoading(false);
          return;
        }

        // Track the best coords we've obtained in this run via local var
        // (not React state) so the stale-closure problem doesn't fire a
        // false "não foi possível obter localização" when the cache hit
        // worked but the fresh fix failed. The `coords` state still drives
        // the UI; this is purely for control-flow decisions in this effect.
        let bestCoords = null;

        // 1) Try cached last-known position first — instant.
        try {
          const cached = await Location.getLastKnownPositionAsync({ maxAge: 60000, requiredAccuracy: 200 });
          if (!active || cancelRef.current) return;
          if (cached?.coords) {
            bestCoords = cached.coords;
            setCoords(cached.coords);
            // We still attempt a fresh read below for accuracy, but the user
            // already sees a preview.
          }
        } catch {}

        // 2) Fresh fix with timeout (Balanced ~5s typical).
        const withTimeout = (p, ms) => Promise.race([
          p,
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
        ]);
        let fresh = null;
        try {
          fresh = await withTimeout(
            Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
            10000,
          );
        } catch {
          try {
            fresh = await withTimeout(
              Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
              12000,
            );
          } catch {}
        }
        if (!active || cancelRef.current) return;
        if (fresh?.coords) {
          bestCoords = fresh.coords;
          setCoords(fresh.coords);
        } else if (!bestCoords) {
          // Both fresh attempts failed AND we have no cache either.
          setError(t?.('chatConv.locationUnavailable') || 'Não foi possível obter sua localização. Verifique se o GPS está ligado.');
          setLoading(false);
          return;
        }

        // 3) Best-effort reverse geocode (don't block on it).
        const target = fresh?.coords || bestCoords;
        if (target) {
          try {
            const places = await Location.reverseGeocodeAsync({
              latitude: target.latitude,
              longitude: target.longitude,
            });
            if (active && !cancelRef.current && places?.[0]) {
              const p = places[0];
              const line = [p.street, p.streetNumber].filter(Boolean).join(', ');
              const sub = [p.district || p.subregion, p.city, p.region].filter(Boolean).join(' · ');
              setAddress([line, sub].filter(Boolean).join(' — '));
            }
          } catch {}
        }

        setLoading(false);
      } catch (e) {
        if (!active || cancelRef.current) return;
        setError(String(e?.message || e));
        setLoading(false);
      }
    })();

    return () => { active = false; cancelRef.current = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const handleSend = () => {
    if (!coords || sending) return;
    setSending(true);
    onSend?.({
      latitude: coords.latitude,
      longitude: coords.longitude,
      address: address || '',
    });
    // Parent closes the sheet; we keep `sending` true to lock the button.
  };

  const mapUrl = coords
    ? `${(api?.BASE_URL || 'https://chatyy.com.br')}${STATIC_MAP_PATH}?lat=${coords.latitude}&lng=${coords.longitude}&z=16&w=640&h=320`
    : null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior="padding"
        style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' }}
      >
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View style={{
          backgroundColor: colors.surface,
          borderTopLeftRadius: 24, borderTopRightRadius: 24,
          paddingHorizontal: 18, paddingTop: 16, paddingBottom: 28,
        }}>
          {/* Drag handle */}
          <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: 14 }} />

          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
            <IconMapPin size={20} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={{ flex: 1, fontSize: 18, fontWeight: '700', color: colors.text }}>
              {t?.('chatConv.locationShare') || 'Compartilhar localização'}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}>
              <IconX size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Body: loading / error / preview */}
          {loading && !coords && (
            <View style={{ height: 200, alignItems: 'center', justifyContent: 'center' }}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={{ marginTop: 12, color: colors.textSecondary, fontSize: 14 }}>
                {t?.('chatConv.locationFetching') || 'Buscando sua localização…'}
              </Text>
            </View>
          )}

          {error && !coords && (
            <View style={{ paddingVertical: 24, alignItems: 'center' }}>
              <Text style={{ fontSize: 14, color: '#ef4444', textAlign: 'center', marginBottom: 16, lineHeight: 20 }}>
                {error}
              </Text>
              <TouchableOpacity
                onPress={onClose}
                style={{ paddingHorizontal: 20, paddingVertical: 12, borderRadius: 24, backgroundColor: colors.border + '40' }}
              >
                <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>
                  {t?.('common.close') || 'Fechar'}
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {coords && !liveConfirm && (
            <>
              {/* Map preview */}
              <View style={{ borderRadius: 14, overflow: 'hidden', backgroundColor: colors.border + '20', marginBottom: 14 }}>
                {mapUrl ? (
                  <Image
                    source={{ uri: mapUrl }}
                    style={{ width: '100%', height: 180 }}
                    resizeMode="cover"
                  />
                ) : null}
              </View>

              {/* Address line */}
              <Text style={{ fontSize: 14, color: colors.text, marginBottom: 4, fontWeight: '600' }} numberOfLines={2}>
                {address || (t?.('chatConv.locationCurrent') || 'Sua localização atual')}
              </Text>
              <Text style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 18 }}>
                {coords.latitude.toFixed(5)}, {coords.longitude.toFixed(5)}
                {coords.accuracy ? ` · ±${Math.round(coords.accuracy)}m` : ''}
                {loading ? ` · ${t?.('chatConv.locationRefining') || 'refinando…'}` : ''}
              </Text>

              {/* Send button */}
              <TouchableOpacity
                onPress={handleSend}
                disabled={sending}
                style={{
                  backgroundColor: colors.primary,
                  borderRadius: 26,
                  paddingVertical: 14,
                  alignItems: 'center',
                  opacity: sending ? 0.6 : 1,
                  flexDirection: 'row', justifyContent: 'center', gap: 8,
                }}
              >
                <IconMapPin size={18} color="#fff" />
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
                  {sending
                    ? (t?.('common.sending') || 'Enviando…')
                    : (t?.('chatConv.locationSend') || 'Enviar localização atual')}
                </Text>
              </TouchableOpacity>

              {/* Live location chips — picking a duration jumps to the
                  confirm step instead of starting broadcast immediately
                  (WhatsApp parity: avoids accidental "I just shared my
                  live location with 2 hours of tracking" taps). */}
              {onLiveStart && (
                <View style={{ marginTop: 18 }}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textSecondary, marginBottom: 8, letterSpacing: 0.5 }}>
                    {(t?.('chatConv.liveLocation') || 'COMPARTILHAR AO VIVO').toUpperCase()}
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    {LIVE_DURATIONS.map(d => (
                      <TouchableOpacity
                        key={d.key}
                        onPress={() => {
                          if (sending) return;
                          setLiveConfirm({ seconds: d.seconds, label: d.label });
                        }}
                        disabled={sending}
                        style={{
                          flex: 1,
                          paddingVertical: 12,
                          borderRadius: 22,
                          borderWidth: 1,
                          borderColor: colors.primary + '50',
                          backgroundColor: colors.primary + '10',
                          alignItems: 'center',
                          opacity: sending ? 0.5 : 1,
                        }}
                      >
                        <Text style={{ color: colors.primary, fontSize: 14, fontWeight: '700' }}>
                          {d.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              )}
            </>
          )}

          {/* Live-share confirmation step — WhatsApp-grade screen the user
              sees BEFORE we actually start broadcasting. Map preview at the
              top + selected duration row (tap to switch) + optional caption
              input + privacy reminder + big primary "Compartilhar ao vivo"
              CTA. Back arrow returns to the chips. */}
          {coords && liveConfirm && (
            <>
              <View style={{ borderRadius: 14, overflow: 'hidden', backgroundColor: colors.border + '20', marginBottom: 14 }}>
                {mapUrl ? (
                  <Image
                    source={{ uri: mapUrl }}
                    style={{ width: '100%', height: 160 }}
                    resizeMode="cover"
                  />
                ) : null}
              </View>

              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14, gap: 8 }}>
                <View style={{
                  width: 36, height: 36, borderRadius: 18,
                  backgroundColor: colors.primary + '15',
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  <IconMapPin size={18} color={colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }} numberOfLines={1}>
                    {address || (t?.('chatConv.locationCurrent') || 'Sua localização atual')}
                  </Text>
                  <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                    {t?.('chatConv.liveDurationLabel') || 'Atualizando por'}: {liveConfirm.label}
                  </Text>
                </View>
              </View>

              {/* Duration switcher — pre-selected pill highlighted */}
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
                {LIVE_DURATIONS.map(d => {
                  const active = d.seconds === liveConfirm.seconds;
                  return (
                    <TouchableOpacity
                      key={d.key}
                      onPress={() => setLiveConfirm({ seconds: d.seconds, label: d.label })}
                      disabled={sending}
                      style={{
                        flex: 1,
                        paddingVertical: 10,
                        borderRadius: 18,
                        borderWidth: 1.5,
                        borderColor: active ? colors.primary : colors.border + '60',
                        backgroundColor: active ? colors.primary + '15' : 'transparent',
                        alignItems: 'center',
                      }}
                    >
                      <Text style={{ color: active ? colors.primary : colors.textSecondary, fontSize: 13, fontWeight: '700' }}>
                        {d.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Optional caption — parent decides whether to use it (most
                  chat callers ignore it; group chats render it under the
                  bubble). */}
              <TextInput
                value={liveCaption}
                onChangeText={setLiveCaption}
                placeholder={t?.('chatConv.liveCommentPlaceholder') || 'Adicionar comentário (opcional)'}
                placeholderTextColor={colors.textSecondary}
                maxLength={120}
                style={{
                  backgroundColor: colors.border + '20',
                  borderRadius: 14,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  fontSize: 14,
                  color: colors.text,
                  marginBottom: 12,
                }}
              />

              {/* Privacy reminder — WhatsApp does this and it actually
                  helps adoption since users worry about who sees their
                  pin. */}
              <Text style={{ fontSize: 11, color: colors.textSecondary, lineHeight: 16, marginBottom: 16 }}>
                {t?.('chatConv.livePrivacyNote') || 'Apenas pessoas desta conversa veem sua localização. Você pode parar a qualquer momento.'}
              </Text>

              {/* Primary CTA + secondary back */}
              <TouchableOpacity
                onPress={() => {
                  if (sending) return;
                  setSending(true);
                  onLiveStart?.(liveConfirm.seconds, {
                    caption: liveCaption.trim() || null,
                    latitude: coords.latitude,
                    longitude: coords.longitude,
                    address: address || null,
                  });
                }}
                disabled={sending}
                style={{
                  backgroundColor: colors.primary,
                  borderRadius: 26,
                  paddingVertical: 14,
                  alignItems: 'center',
                  opacity: sending ? 0.6 : 1,
                  flexDirection: 'row', justifyContent: 'center', gap: 8,
                  marginBottom: 8,
                }}
              >
                <IconMapPin size={18} color="#fff" />
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
                  {sending
                    ? (t?.('common.sending') || 'Enviando…')
                    : (t?.('chatConv.liveShareConfirm') || 'Compartilhar ao vivo')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setLiveConfirm(null)}
                disabled={sending}
                style={{ paddingVertical: 10, alignItems: 'center' }}
              >
                <Text style={{ color: colors.textSecondary, fontSize: 14, fontWeight: '600' }}>
                  {t?.('common.back') || 'Voltar'}
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
