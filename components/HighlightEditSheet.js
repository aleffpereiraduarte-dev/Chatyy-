/**
 * HighlightEditSheet — Instagram-Pro highlight editor.
 *
 * Lets the owner of a highlight:
 *   1. Rename it inline (title input, max 60 chars).
 *   2. Pick a new cover from current Stories OR upload a custom image.
 *   3. Remove individual items from the highlight (without touching the
 *      underlying status row — same data the Stories tab still sees).
 *   4. See aggregate viewer count (distinct emails across all clips).
 *
 * Calls:
 *   - api.statusHighlightItems(id)     load current clips
 *   - api.statusList()                  load current Stories (for cover picker)
 *   - api.statusHighlightRename(id,n)
 *   - api.statusHighlightUpdateCover(id, { statusId | coverUrl })
 *   - api.statusUpload(file)            for custom cover upload
 *   - api.statusHighlightRemoveStatus(id, statusId)
 *   - api.statusHighlightStats(id)
 *
 * On close, calls onUpdated(patch) with the partial highlight shape so the
 * parent (Profile.js) can reconcile its local `highlights` state without a
 * full refetch round-trip.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Modal, Pressable, ScrollView,
  ActivityIndicator, Platform, StyleSheet, Alert, Image, Animated, Easing,
} from 'react-native';
import * as api from '../services/api';
import { IconX, IconCheck, IconCamera, IconTrash, IconEdit } from './Icons';

let _ExpoImage = null;
try { _ExpoImage = require('expo-image').Image; } catch (e) {}

const WEB = Platform.OS === 'web';

// Module-level cache keyed by highlight id, so reopening the same highlight is
// instant (Instagram-feel) instead of blanking out for a fresh round-trip.
// Invalidated implicitly: edits mutate `items`/`coverUrl` in component state and
// also patch the cache below, so the next open reflects the change.
const _hlCache = new Map(); // id -> { items, stories, stats }

function resolveMedia(url) {
  if (!url) return '';
  if (/^https?:/i.test(url)) return url;
  if (url.startsWith('/')) return `https://chatyy.com.br${url}`;
  return url;
}

export default function HighlightEditSheet({
  visible, onClose, highlight, colors, isDark, t,
  onUpdated, onDeleted,
}) {
  const [title, setTitle] = useState('');
  const [items, setItems] = useState([]);
  const [stories, setStories] = useState([]);
  const [stats, setStats] = useState({ viewers: 0, items: 0 });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [coverUrl, setCoverUrl] = useState('');
  const [tab, setTab] = useState('cover'); // 'cover' | 'items'

  const T = t || ((k, d) => d || k);
  const c = colors || {};
  const sheetBg = c.surface || (isDark ? '#1a1a1a' : '#fff');
  const txt = c.text || (isDark ? '#fff' : '#000');
  const sub = c.textSecondary || (isDark ? '#999' : '#666');
  const border = c.border || (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)');
  const accent = '#7C3AED';

  // Pull data when sheet opens. The 3 endpoints run in PARALLEL (Promise.all)
  // so the slowest one — not their sum — gates the spinner. A per-id cache
  // makes reopening the same highlight paint instantly with no refetch.
  useEffect(() => {
    if (!visible || !highlight?.id) return;
    setTitle(highlight.title || highlight.name || '');
    setCoverUrl(highlight.cover_url || '');

    const cached = _hlCache.get(highlight.id);
    let cancelled = false;
    if (cached) {
      // Instant paint from cache (Instagram-feel)...
      setItems(cached.items);
      setStories(cached.stories);
      setStats(cached.stats);
      setLoading(false);
      // ...but DON'T `return`. The old short-circuit skipped the network
      // entirely, so a clip deleted elsewhere (from the story viewer, another
      // device) reappeared here forever — the module cache was never
      // invalidated. Fall through to a background revalidate that overwrites
      // the cache + state a beat later, so external deletes/edits reflect.
    } else {
      setItems([]);
      setLoading(true);
    }
    Promise.all([
      api.statusHighlightItems?.(highlight.id).catch(() => null),
      api.statusList?.().catch(() => null),
      api.statusHighlightStats?.(highlight.id).catch(() => null),
    ]).then(([r1, r2, r3]) => {
      if (cancelled) return;
      const its = r1?.data?.items || r1?.items || [];
      const itemsArr = Array.isArray(its) ? its : [];
      setItems(itemsArr);
      // statusList returns the signed-in user's own active stories. The
      // shape is { groups: [{ email, statuses: [...] }] } or { statuses: [...] }.
      // We only want the current user's own statuses as cover candidates.
      const sList = r2?.data?.statuses || r2?.statuses
                 || (r2?.data?.groups?.[0]?.statuses) || [];
      const storiesArr = Array.isArray(sList) ? sList : [];
      setStories(storiesArr);
      const st = r3?.data || r3 || {};
      const statsObj = { viewers: Number(st.viewers || 0), items: Number(st.items || itemsArr.length || 0) };
      setStats(statsObj);
      _hlCache.set(highlight.id, { items: itemsArr, stories: storiesArr, stats: statsObj });
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [visible, highlight?.id]);

  const saveTitle = useCallback(async () => {
    const v = (title || '').trim();
    if (!v) return;
    if (v === (highlight?.title || highlight?.name || '')) return;
    setSaving(true);
    try {
      const r = await api.statusHighlightRename?.(highlight.id, v);
      if (r?.success) onUpdated?.({ id: highlight.id, title: v });
      else Alert.alert(T('common.error', 'Erro'), r?.message || 'Falhou');
    } finally { setSaving(false); }
  }, [title, highlight, onUpdated, T]);

  const pickCoverFromStory = useCallback(async (statusId) => {
    setSaving(true);
    try {
      const r = await api.statusHighlightUpdateCover?.(highlight.id, { statusId });
      if (r?.success) {
        const nu = r?.data?.cover_url || r?.cover_url || '';
        setCoverUrl(nu);
        onUpdated?.({ id: highlight.id, cover_url: nu });
      } else {
        Alert.alert(T('common.error', 'Erro'), r?.message || 'Falhou');
      }
    } finally { setSaving(false); }
  }, [highlight, onUpdated, T]);

  const pickCoverFromGallery = useCallback(async () => {
    try {
      const ImagePicker = require('expo-image-picker');
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== 'granted') {
        Alert.alert(T('common.permission', 'Permissão'), T('profile.highlightNeedPhotos', 'Libere acesso às fotos.'));
        return;
      }
      const pick = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: false,
        quality: 0.85,
      });
      if (pick.canceled || !pick.assets?.[0]?.uri) return;
      const a = pick.assets[0];
      setSaving(true);
      const up = await api.statusUpload({
        uri: a.uri,
        name: a.fileName || `cover_${Date.now()}.jpg`,
        type: a.mimeType || 'image/jpeg',
      });
      // Prefer cdn_url so the cover paints from edge immediately
      // (status_upload now returns both; relative path stays as fallback).
      const url = up?.data?.cdn_url || up?.data?.url || up?.url || '';
      if (!url) { Alert.alert(T('common.error', 'Erro'), 'upload_failed'); return; }
      const r = await api.statusHighlightUpdateCover?.(highlight.id, { coverUrl: url });
      if (r?.success) {
        const nu = r?.data?.cover_url || url;
        setCoverUrl(nu);
        onUpdated?.({ id: highlight.id, cover_url: nu });
      } else {
        Alert.alert(T('common.error', 'Erro'), r?.message || 'Falhou');
      }
    } catch (e) {
      Alert.alert(T('common.error', 'Erro'), e?.message || 'Falhou');
    } finally { setSaving(false); }
  }, [highlight, onUpdated, T]);

  const removeItem = useCallback((statusId) => {
    Alert.alert(
      T('profile.highlightRemoveTitle', 'Remover deste destaque?'),
      T('profile.highlightRemoveHint', 'O status original continua no seu perfil.'),
      [
        { text: T('common.cancel', 'Cancelar'), style: 'cancel' },
        {
          text: T('common.remove', 'Remover'), style: 'destructive',
          onPress: async () => {
            try {
              const r = await api.statusHighlightRemoveStatus?.(highlight.id, statusId);
              if (r?.success) {
                setItems(prev => {
                  const next = prev.filter(x => Number(x.id) !== Number(statusId));
                  const cached = _hlCache.get(highlight.id);
                  if (cached) _hlCache.set(highlight.id, { ...cached, items: next });
                  return next;
                });
              }
            } catch {}
          },
        },
      ]
    );
  }, [highlight, T]);

  const deleteHighlight = useCallback(() => {
    Alert.alert(
      T('profile.deleteHighlightTitle', 'Apagar destaque?'),
      T('profile.deleteHighlightHint', 'Os status originais não são afetados.'),
      [
        { text: T('common.cancel', 'Cancelar'), style: 'cancel' },
        {
          text: T('common.delete', 'Apagar'), style: 'destructive',
          onPress: async () => {
            try { await api.statusHighlightDelete?.(highlight.id); } catch {}
            _hlCache.delete(highlight.id);
            onDeleted?.(highlight.id);
            onClose?.();
          },
        },
      ]
    );
  }, [highlight, onDeleted, onClose, T]);

  // Shimmer skeleton — instead of a bare spinner, paint the same grid layout
  // (title pill + 8 tiles) pulsing, so the sheet never flashes blank. This is
  // what makes the open feel "instant" even on a cold fetch.
  const shimmer = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!visible || !loading) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(shimmer, { toValue: 0, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [visible, loading, shimmer]);

  const SkeletonGrid = () => {
    const baseBg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
    const op = shimmer.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] });
    return (
      <View>
        <Animated.View style={{ width: 180, height: 13, borderRadius: 6, backgroundColor: baseBg, opacity: op, marginBottom: 14 }} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <Animated.View key={i} style={{ width: 84, height: 84, borderRadius: 8, marginRight: 8, marginBottom: 8, backgroundColor: baseBg, opacity: op }} />
          ))}
        </View>
      </View>
    );
  };

  const Tile = ({ url, onPress, selected }) => {
    const sz = 84;
    const src = resolveMedia(url);
    return (
      <TouchableOpacity activeOpacity={0.8} onPress={onPress} style={{ marginRight: 8, marginBottom: 8 }}>
        <View style={{
          width: sz, height: sz, borderRadius: 8, overflow: 'hidden',
          borderWidth: selected ? 2 : StyleSheet.hairlineWidth,
          borderColor: selected ? accent : border, backgroundColor: '#0002',
        }}>
          {src ? (
            WEB
              ? <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : (_ExpoImage
                  ? <_ExpoImage source={{ uri: src }} style={{ width: '100%', height: '100%' }} contentFit="cover" cachePolicy="memory-disk" />
                  : <Image source={{ uri: src }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />)
          ) : null}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <Modal visible={!!visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} onPress={onClose}>
        <Pressable onPress={(e) => e.stopPropagation?.()} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, top: '15%', backgroundColor: sheetBg, borderTopLeftRadius: 18, borderTopRightRadius: 18, overflow: 'hidden' }}>
          {/* Handle */}
          <View style={{ alignItems: 'center', paddingTop: 8 }}>
            <View style={{ width: 44, height: 4, borderRadius: 2, backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)' }} />
          </View>

          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: border }}>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}>
              <IconX size={22} color={txt} />
            </TouchableOpacity>
            <Text style={{ flex: 1, textAlign: 'center', fontWeight: '700', fontSize: 16, color: txt }}>
              {T('profile.editHighlight', 'Editar destaque')}
            </Text>
            <TouchableOpacity onPress={saveTitle} disabled={saving} hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}>
              {saving ? <ActivityIndicator size="small" color={accent} /> : <Text style={{ color: accent, fontWeight: '700', fontSize: 15 }}>{T('common.done', 'OK')}</Text>}
            </TouchableOpacity>
          </View>

          {/* Title row */}
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: border, gap: 12 }}>
            <View style={{ width: 56, height: 56, borderRadius: 28, overflow: 'hidden', backgroundColor: '#7C3AED22', borderWidth: 1.5, borderColor: border }}>
              {coverUrl ? (
                WEB
                  ? <img src={resolveMedia(coverUrl)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : (_ExpoImage
                      ? <_ExpoImage source={{ uri: resolveMedia(coverUrl) }} style={{ width: '100%', height: '100%' }} contentFit="cover" cachePolicy="memory-disk" />
                      : <Image source={{ uri: resolveMedia(coverUrl) }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />)
              ) : null}
            </View>
            <View style={{ flex: 1 }}>
              <TextInput
                value={title}
                onChangeText={setTitle}
                onBlur={saveTitle}
                placeholder={T('profile.highlightTitlePh', 'Título')}
                placeholderTextColor={sub}
                maxLength={60}
                style={{ fontSize: 17, fontWeight: '600', color: txt, paddingVertical: 4 }}
              />
              <Text style={{ fontSize: 12, color: sub, marginTop: 2 }}>
                {T('profile.highlightStatsLine', '{n} status • {v} pessoas viram')
                  .replace('{n}', String(stats.items || items.length))
                  .replace('{v}', String(stats.viewers))}
              </Text>
            </View>
          </View>

          {/* Tab switcher */}
          <View style={{ flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: border }}>
            {[
              { k: 'cover', label: T('profile.highlightTabCover', 'Capa') },
              { k: 'items', label: T('profile.highlightTabItems', 'Status') },
            ].map(tb => (
              <TouchableOpacity
                key={tb.k}
                onPress={() => setTab(tb.k)}
                style={{ flex: 1, paddingVertical: 12, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: tab === tb.k ? accent : 'transparent' }}
              >
                <Text style={{ color: tab === tb.k ? txt : sub, fontWeight: tab === tb.k ? '700' : '500', fontSize: 14 }}>{tb.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 30 }}>
            {loading ? (
              <SkeletonGrid />
            ) : tab === 'cover' ? (
              <>
                <Text style={{ color: sub, fontSize: 13, fontWeight: '500', marginBottom: 8 }}>
                  {T('profile.highlightCoverFromStories', 'Escolha entre seus stories ativos')}
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                  <TouchableOpacity
                    activeOpacity={0.8}
                    onPress={pickCoverFromGallery}
                    style={{ width: 84, height: 84, borderRadius: 8, marginRight: 8, marginBottom: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: border, borderStyle: 'dashed', backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)' }}
                  >
                    <IconCamera size={22} color={txt} />
                    <Text style={{ fontSize: 11, color: sub, marginTop: 4 }}>{T('profile.highlightCustomCover', 'Galeria')}</Text>
                  </TouchableOpacity>
                  {stories.length === 0 && items.length > 0 && items.map(it => (
                    <Tile
                      key={`item-${it.id}`}
                      url={it.media_url || it.thumbnail_url}
                      onPress={() => pickCoverFromStory(it.id)}
                      selected={coverUrl && (coverUrl === it.media_url)}
                    />
                  ))}
                  {stories.map(s => (
                    <Tile
                      key={`story-${s.id}`}
                      url={s.media_url || s.thumbnail_url}
                      onPress={() => pickCoverFromStory(s.id)}
                      selected={coverUrl && (coverUrl === s.media_url)}
                    />
                  ))}
                </View>
                {stories.length === 0 && items.length === 0 ? (
                  <Text style={{ color: sub, fontSize: 13, marginTop: 12 }}>
                    {T('profile.highlightNoStoriesForCover', 'Sem stories ativos pra usar de capa. Use a Galeria.')}
                  </Text>
                ) : null}
              </>
            ) : (
              <>
                <Text style={{ color: sub, fontSize: 13, fontWeight: '500', marginBottom: 8 }}>
                  {T('profile.highlightManageItems', 'Toque pra remover um status deste destaque')}
                </Text>
                {items.length === 0 ? (
                  <Text style={{ color: sub, fontSize: 13 }}>
                    {T('profile.highlightNoItems', 'Sem status neste destaque.')}
                  </Text>
                ) : (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                    {items.map(it => (
                      <View key={it.id} style={{ position: 'relative', marginRight: 8, marginBottom: 8 }}>
                        <Tile url={it.media_url || it.thumbnail_url} onPress={() => removeItem(it.id)} />
                        <View pointerEvents="none" style={{ position: 'absolute', top: 4, right: 4, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 12, padding: 4 }}>
                          <IconTrash size={14} color="#fff" />
                        </View>
                      </View>
                    ))}
                  </View>
                )}
              </>
            )}

            {/* Danger zone — fully delete */}
            <TouchableOpacity
              onPress={deleteHighlight}
              activeOpacity={0.7}
              style={{ marginTop: 24, paddingVertical: 14, alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: '#dc2626', borderRadius: 10 }}
            >
              <Text style={{ color: '#dc2626', fontWeight: '600', fontSize: 14 }}>
                {T('profile.deleteHighlightCta', 'Apagar destaque')}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
