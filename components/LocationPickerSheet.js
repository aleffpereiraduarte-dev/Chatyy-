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
// We don't have `react-native-maps` (would require a native rebuild) so the
// preview is a single <Image> from our self-hosted BoraUm tile server's Static
// Image API (OpenStreetMap, MapLibre) — see components/BoraMap.js. No Google,
// no API key, no billing. The tileserver doesn't draw a pin, so we overlay a
// centered red pin on top (the image is centered on the coords).
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
import { boraStaticMapUrl } from './BoraMap';

// [2026-06-24] Google Maps REMOVIDO. Preview do mapa vem da Static Image API do
// nosso tile server self-hosted (BoraUm / OpenStreetMap) — sem chave, sem billing.
// O tileserver não desenha o pin → desenhamos um pin sobreposto centralizado.

const LIVE_DURATIONS = [
  { key: '15m', label: '15 min', seconds: 15 * 60 },
  { key: '1h',  label: '1 hora', seconds: 60 * 60 },
  { key: '8h',  label: '8 horas', seconds: 8 * 60 * 60 },
  // Snap-Map style "always on" — broadcasts until user manually stops.
  // Backend interprets seconds === -1 as unlimited (sentinel ~10y).
  { key: 'inf', label: 'Sempre', seconds: -1 },
];

// Format remaining ms as a human-readable countdown for the dup-session
// guard card. Mirrors WhatsApp's "47min restantes" style: minutes when the
// session has more than 1h left, "Xh Ymin" when shorter, "<1min" near the
// tail. We don't sub-second update — caller re-renders every 1s and we
// recompute. Sentinel `isUnlimited` returns null so the caller can render
// the dedicated "Compartilhamento ilimitado" string instead of a number.
function formatRemaining(activeLive) {
  if (!activeLive) return '';
  if (activeLive.isUnlimited) return null;
  const ms = (activeLive.expiresAt || 0) - Date.now();
  if (ms <= 0) return '';
  const totalMin = Math.ceil(ms / 60000);
  if (totalMin >= 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m > 0 ? `${h}h ${m}min` : `${h}h`;
  }
  return `${Math.max(1, totalMin)}min`;
}

export default function LocationPickerSheet({ visible, onClose, onSend, onLiveStart, activeLive, onStopLive, colors, t }) {
  const [loading, setLoading] = useState(true);
  const [coords, setCoords] = useState(null); // { latitude, longitude, accuracy }
  const [address, setAddress] = useState('');
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  // True while the only fix we have is an aged cached position (no fresh
  // GPS read returned yet AND the cache is older than ~30s). Drives a
  // subtle "localização aproximada" hint so we don't present a stale fix
  // as exact. Cleared the moment a fresh fix lands.
  const [approxOnly, setApproxOnly] = useState(false);
  // WhatsApp-style live-share confirmation: after the user taps a duration
  // chip we DON'T immediately start broadcasting. We swap the sheet body
  // for a confirmation view (map preview + selected duration + privacy
  // note + big primary "Compartilhar ao vivo" CTA). Set back to null to
  // return to the chips. Caption is optional and gets passed to onLiveStart
  // so the parent can include it in the live-location WS payload.
  const [liveConfirm, setLiveConfirm] = useState(null); // { seconds, label }
  const [liveCaption, setLiveCaption] = useState('');
  // [fix 2026-07-05, QA print 20260705-032342] The static-map <Image> had no
  // onError handling: one failed tile-server response (transient render
  // timeout/network blip) left a permanently blank white box behind the pin
  // for the whole sheet session. On error we retry up to 2× with a
  // cache-busting query param (endpoint verified to accept it) so RN's image
  // cache can't pin the failure.
  const [mapRetry, setMapRetry] = useState(0);
  const cancelRef = useRef(false);
  // 1s tick to repaint the dup-session guard's countdown. We only spin the
  // interval while the sheet is visible AND a live session is active —
  // otherwise it's a wasted setInterval keeping the JS thread busy.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (!visible || !activeLive || activeLive.isUnlimited) return undefined;
    const id = setInterval(() => setNowTick(n => (n + 1) % 1_000_000), 1000);
    return () => clearInterval(id);
  }, [visible, activeLive]);

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
    setApproxOnly(false);
    setMapRetry(0);

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

        // 1) Try cached last-known position first — instant. Tightened
        //    maxAge from 60s to 10s so a long-stale fix isn't shown as
        //    "current". We still accept an older cache as a preview seed
        //    (so the user sees *something* immediately), but if that fix
        //    is older than ~30s we flag it `approxOnly` and surface a
        //    subtle "localização aproximada" hint rather than presenting
        //    it as exact. A fresh GPS read below clears the flag.
        try {
          const cached = await Location.getLastKnownPositionAsync({ maxAge: 10000, requiredAccuracy: 200 });
          if (!active || cancelRef.current) return;
          if (cached?.coords) {
            bestCoords = cached.coords;
            setCoords(cached.coords);
            const cachedTs = cached.timestamp || 0;
            const cacheAge = cachedTs ? (Date.now() - cachedTs) : 0;
            // Only mark approximate if the cache is meaningfully old (>30s).
            if (cacheAge > 30000) setApproxOnly(true);
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
          setApproxOnly(false); // fresh fix supersedes the aged cache
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

  const baseMapUrl = coords
    ? boraStaticMapUrl(coords.latitude, coords.longitude, 16, 320, 160)
    : null;
  const mapUrl = baseMapUrl
    ? (mapRetry > 0 ? `${baseMapUrl}?r=${mapRetry}` : baseMapUrl)
    : null;
  const onMapError = () => setMapRetry(r => (r < 2 ? r + 1 : r));

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
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

          {/* Dup-session guard — WhatsApp parity. When `activeLive` is set
              the caller already has a running live broadcast in this chat,
              so we render a red-tinted card with countdown + "Parar"
              instead of letting the user start a 2nd session. The static
              "Enviar localização atual" CTA below remains tappable — it's
              an orthogonal one-shot pin, not the continuous broadcast.
              The live-duration chips section further down is hidden via
              the `!activeLive` gate. */}
          {activeLive && (() => {
            const remaining = formatRemaining(activeLive);
            const subtitle = activeLive.isUnlimited
              ? (t?.('chatConv.liveUnlimited') || 'Compartilhamento ilimitado')
              : (remaining
                  ? (t?.('chatConv.liveTimeLeft', { mins: remaining }) || `${remaining} restantes`)
                  : '');
            // Theme-aware bg/text — we keep the red/burgundy palette
            // because the card communicates "ongoing broadcast, action
            // required to stop". Light: rose-100. Dark: rose-900-ish.
            const isDark = !!colors?.isDark || (colors?.background && /^#0|^#1|^#2/.test(String(colors.background)));
            const bg = isDark ? '#7F1D1D33' : '#FEE2E2';
            const fg = isDark ? '#FECACA' : '#7F1D1D';
            return (
              <View style={{
                flexDirection: 'row', alignItems: 'center',
                backgroundColor: bg, borderRadius: 12,
                paddingHorizontal: 12, paddingVertical: 10,
                marginBottom: 14,
              }}>
                <View style={{
                  width: 32, height: 32, borderRadius: 16,
                  backgroundColor: isDark ? '#991B1B66' : '#FCA5A580',
                  alignItems: 'center', justifyContent: 'center', marginRight: 10,
                }}>
                  <IconMapPin size={18} color={fg} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: fg, fontSize: 13, fontWeight: '700' }} numberOfLines={1}>
                    {t?.('chatConv.liveAlreadySharing') || 'Você já está dividindo localização ao vivo'}
                  </Text>
                  {!!subtitle && (
                    <Text style={{ color: fg, fontSize: 12, opacity: 0.85, marginTop: 2 }} numberOfLines={1}>
                      {subtitle}
                    </Text>
                  )}
                </View>
                <TouchableOpacity
                  onPress={() => onStopLive?.()}
                  hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                  style={{ paddingHorizontal: 10, paddingVertical: 6 }}
                  accessibilityRole="button"
                  accessibilityLabel={t?.('chatConv.liveStop') || 'Parar'}
                >
                  <Text style={{ color: '#EF4444', fontSize: 14, fontWeight: '700' }}>
                    {t?.('chatConv.liveStop') || 'Parar'}
                  </Text>
                </TouchableOpacity>
              </View>
            );
          })()}

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
                  <View style={{ width: '100%', height: 180, alignItems: 'center', justifyContent: 'center' }}>
                    <Image
                      key={mapUrl}
                      source={{ uri: mapUrl }}
                      style={{ width: '100%', height: 180, position: 'absolute', top: 0, left: 0 }}
                      resizeMode="cover"
                      onError={onMapError}
                    />
                    <View style={{ marginTop: -10 }} pointerEvents="none">
                      <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: '#dc2626', borderWidth: 2, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' }}>
                        <IconMapPin size={16} color="#fff" />
                      </View>
                    </View>
                  </View>
                ) : null}
              </View>

              {/* Address line */}
              <Text style={{ fontSize: 14, color: colors.text, marginBottom: 4, fontWeight: '600' }} numberOfLines={2}>
                {address || (t?.('chatConv.locationCurrent') || 'Sua localização atual')}
              </Text>
              <Text style={{ fontSize: 12, color: colors.textSecondary, marginBottom: approxOnly ? 6 : 18 }}>
                {coords.latitude.toFixed(5)}, {coords.longitude.toFixed(5)}
                {coords.accuracy ? ` · ±${Math.round(coords.accuracy)}m` : ''}
                {loading ? ` · ${t?.('chatConv.locationRefining') || 'refinando…'}` : ''}
              </Text>
              {/* Subtle approximate-location hint: shown when the only fix
                  we have is an aged cache (>30s) and a fresh GPS read hasn't
                  returned yet. Sending is still allowed. */}
              {approxOnly && (
                <Text style={{ fontSize: 11, color: '#D97706', marginBottom: 18, fontWeight: '600' }} numberOfLines={1}>
                  {t?.('chatConv.locationApprox') || 'Localização aproximada'}
                </Text>
              )}

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
                  live location with 2 hours of tracking" taps).
                  Snap-Map 2026-05-18: "Sempre" chip = unlimited until
                  user stops manually (highlighted differently so it reads
                  as a power-user choice, not a default). */}
              {onLiveStart && !activeLive && (
                <View style={{ marginTop: 18 }}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textSecondary, marginBottom: 8, letterSpacing: 0.5 }}>
                    {(t?.('chatConv.liveLocation') || 'COMPARTILHAR AO VIVO').toUpperCase()}
                  </Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {LIVE_DURATIONS.map(d => {
                      const inf = d.seconds === -1;
                      return (
                        <TouchableOpacity
                          key={d.key}
                          onPress={() => {
                            if (sending) return;
                            setLiveConfirm({ seconds: d.seconds, label: d.label, unlimited: inf });
                          }}
                          disabled={sending}
                          style={{
                            flexBasis: '47%',
                            flexGrow: 1,
                            paddingVertical: 12,
                            borderRadius: 22,
                            borderWidth: 1.5,
                            borderColor: inf ? '#7C3AED90' : colors.primary + '50',
                            backgroundColor: inf ? '#7C3AED15' : colors.primary + '10',
                            alignItems: 'center',
                            opacity: sending ? 0.5 : 1,
                          }}
                        >
                          <Text style={{ color: inf ? '#7C3AED' : colors.primary, fontSize: 14, fontWeight: '700' }}>
                            {inf ? '∞ ' : ''}{d.label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
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
                  <View style={{ width: '100%', height: 160, alignItems: 'center', justifyContent: 'center' }}>
                    <Image
                      key={mapUrl}
                      source={{ uri: mapUrl }}
                      style={{ width: '100%', height: 160, position: 'absolute', top: 0, left: 0 }}
                      resizeMode="cover"
                      onError={onMapError}
                    />
                    <View style={{ marginTop: -10 }} pointerEvents="none">
                      <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: '#dc2626', borderWidth: 2, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' }}>
                        <IconMapPin size={16} color="#fff" />
                      </View>
                    </View>
                  </View>
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
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
                {LIVE_DURATIONS.map(d => {
                  const active = d.seconds === liveConfirm.seconds;
                  const inf = d.seconds === -1;
                  return (
                    <TouchableOpacity
                      key={d.key}
                      onPress={() => setLiveConfirm({ seconds: d.seconds, label: d.label, unlimited: inf })}
                      disabled={sending}
                      style={{
                        flexBasis: '23%',
                        flexGrow: 1,
                        paddingVertical: 10,
                        borderRadius: 18,
                        borderWidth: 1.5,
                        borderColor: active ? (inf ? '#7C3AED' : colors.primary) : colors.border + '60',
                        backgroundColor: active ? (inf ? '#7C3AED15' : colors.primary + '15') : 'transparent',
                        alignItems: 'center',
                      }}
                    >
                      <Text style={{ color: active ? (inf ? '#7C3AED' : colors.primary) : colors.textSecondary, fontSize: 13, fontWeight: '700' }}>
                        {inf ? '∞ ' : ''}{d.label}
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
                  pin. Snap-Map 2026-05-18: "Sempre" mode gets a stronger
                  warning because there's no auto-expiry. */}
              <Text style={{ fontSize: 11, color: liveConfirm.unlimited ? '#7C3AED' : colors.textSecondary, lineHeight: 16, marginBottom: 16, fontWeight: liveConfirm.unlimited ? '600' : '400' }}>
                {liveConfirm.unlimited
                  ? (t?.('chatConv.livePrivacyUnlimited') || 'Sempre ativo: sua localização continua sendo compartilhada até você desligar manualmente. Toque na bolha para parar.')
                  : (t?.('chatConv.livePrivacyNote') || 'Apenas pessoas desta conversa veem sua localização. Você pode parar a qualquer momento.')}
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
