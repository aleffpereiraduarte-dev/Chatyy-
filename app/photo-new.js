// =============================================================================
// /photo-new — Instagram-style preview/edit/publish screen
//
// Entered via the FAB on /photos after multi-selecting 1..10 assets from the
// device library (expo-image-picker, allowsMultipleSelection). Reads the
// staged list from AsyncStorage key `photoNew.pending` so we don't have to
// serialize file URIs through router params.
//
// UX flow:
//   1. Read items on mount.
//   2. Show horizontal carousel of selected media (snap-to-page).
//   3. Dot indicators bottom.
//   4. Per-item: Edit (opens PhotoEditor for crop/filter), Remove (X).
//   5. Thumbnails strip below — tap to jump, "+" tile re-opens picker.
//   6. Reorder via long-press swap (tap a thumb then tap target = swap).
//   7. Caption TextInput.
//   8. "Publicar" → feed_create_post via api.feedCreatePost (same path the
//      feed CreatePostModal uses).
//
// Edge cases:
//   - User opens /photo-new directly with no pending items → router.back().
//   - Picker permission denied on "add more" → safeAlert.
//   - Empty caption → still publishes (Instagram parity).
//   - Publishing in flight → button disabled, spinner.
// =============================================================================

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, TextInput,
  ActivityIndicator, Platform, Animated, KeyboardAvoidingView, ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';

import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { Spacing, FontSize, BorderRadius, Shadow } from '../constants/theme';
import * as api from '../services/api';
import { safeAlert } from '../services/alerts';
import { setCache, getCached } from '../services/cache';
import {
  IconArrowLeft, IconX, IconEdit, IconPlus, IconPlay,
} from '../components/Icons';
import PhotoEditor from '../components/PhotoEditor';
import Svg, { Path } from 'react-native-svg';

const MAX_ITEMS = 10;
const MAX_CAPTION = 2200;

function IconCheckBig({ size = 22, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M20 6L9 17l-5-5" />
    </Svg>
  );
}

export default function PhotoNew() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();

  const [items, setItems] = useState([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [caption, setCaption] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [editorOpenForIdx, setEditorOpenForIdx] = useState(-1);
  const [reorderFromIdx, setReorderFromIdx] = useState(-1);

  const carouselRef = useRef(null);
  const [carouselWidth, setCarouselWidth] = useState(0);

  // ----- Hydrate pending list -----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('photoNew.pending');
        if (!raw) {
          if (!cancelled) router.back();
          return;
        }
        const list = JSON.parse(raw);
        if (!Array.isArray(list) || list.length === 0) {
          if (!cancelled) router.back();
          return;
        }
        if (!cancelled) setItems(list);
        // Clear the staging key so a back-navigation + re-pick doesn't replay.
        // We keep a copy in state.
        AsyncStorage.removeItem('photoNew.pending').catch(() => {});
      } catch {
        if (!cancelled) router.back();
      }
    })();
    return () => { cancelled = true; };
  }, [router]);

  // ----- Carousel scroll -----
  const handleScrollEnd = useCallback((e) => {
    const w = e.nativeEvent.layoutMeasurement.width || carouselWidth || 1;
    const idx = Math.round(e.nativeEvent.contentOffset.x / w);
    setActiveIndex(idx);
  }, [carouselWidth]);

  const jumpTo = useCallback((idx) => {
    if (!carouselRef.current || carouselWidth === 0) return;
    carouselRef.current.scrollToOffset({ offset: idx * carouselWidth, animated: true });
    setActiveIndex(idx);
  }, [carouselWidth]);

  // ----- Remove / add / reorder -----
  const removeAt = useCallback((idx) => {
    setItems(prev => {
      const next = prev.filter((_, i) => i !== idx);
      if (next.length === 0) {
        // No items left → bounce back to photos.
        setTimeout(() => router.back(), 0);
        return next;
      }
      // Keep activeIndex in range.
      setActiveIndex(curr => Math.min(curr, next.length - 1));
      return next;
    });
  }, [router]);

  const addMore = useCallback(async () => {
    if (items.length >= MAX_ITEMS) {
      safeAlert(
        t('photoNew.maxReached') || 'Limite atingido',
        (t('photoNew.maxReachedDesc') || 'Máximo {max} itens.').replace('{max}', MAX_ITEMS),
      );
      return;
    }
    try {
      const ImagePicker = await import('expo-image-picker');
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
      const remaining = MAX_ITEMS - items.length;
      const pick = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.All,
        allowsMultipleSelection: true,
        selectionLimit: remaining,
        quality: 0.9,
        orderedSelection: true,
      });
      if (pick.canceled || !pick.assets?.length) return;
      const newOnes = pick.assets.slice(0, remaining).map((a, idx) => {
        const isVid = (a.type === 'video') || (a.mimeType || '').startsWith('video');
        return {
          id: `${Date.now()}_add_${idx}_${Math.random().toString(36).slice(2, 7)}`,
          uri: a.uri,
          type: isVid ? 'video' : 'image',
          width: a.width,
          height: a.height,
          duration: a.duration,
          fileName: a.fileName || `media_${Date.now()}_${idx}.${isVid ? 'mp4' : 'jpg'}`,
          mimeType: a.mimeType || (isVid ? 'video/mp4' : 'image/jpeg'),
        };
      });
      setItems(prev => [...prev, ...newOnes]);
    } catch (e) {
      safeAlert(t('common.error') || 'Erro', e?.message || '');
    }
  }, [items.length, t]);

  // Tap-to-swap reorder: first tap on thumb = source, second = target.
  // Simpler than drag, works without extra gesture deps.
  const onThumbPress = useCallback((idx) => {
    if (reorderFromIdx === -1) {
      jumpTo(idx);
      return;
    }
    if (reorderFromIdx === idx) {
      setReorderFromIdx(-1);
      return;
    }
    setItems(prev => {
      const next = [...prev];
      const tmp = next[reorderFromIdx];
      next[reorderFromIdx] = next[idx];
      next[idx] = tmp;
      return next;
    });
    setReorderFromIdx(-1);
    setActiveIndex(idx);
  }, [reorderFromIdx, jumpTo]);

  const onThumbLongPress = useCallback((idx) => {
    setReorderFromIdx(idx);
  }, []);

  // ----- Edit handler -----
  const openEditor = useCallback((idx) => {
    if (items[idx]?.type === 'video') {
      safeAlert(t('photoNew.editVideoNote') || 'Edição', t('photoNew.editVideoNoteDesc') || 'Edição de vídeo não suportada.');
      return;
    }
    setEditorOpenForIdx(idx);
  }, [items, t]);

  const handleEditorSave = useCallback((newUri) => {
    if (editorOpenForIdx < 0) { setEditorOpenForIdx(-1); return; }
    setItems(prev => {
      const next = [...prev];
      if (next[editorOpenForIdx]) {
        next[editorOpenForIdx] = { ...next[editorOpenForIdx], uri: newUri };
      }
      return next;
    });
    setEditorOpenForIdx(-1);
  }, [editorOpenForIdx]);

  // ----- Publish -----
  const publish = useCallback(async () => {
    if (publishing || items.length === 0) return;
    setPublishing(true);
    try {
      const formData = new FormData();
      formData.append('caption', caption.trim());
      const hasVideo = items.some(it => it.type === 'video');
      formData.append('media_type', hasVideo ? 'video' : 'image');
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (Platform.OS === 'web') {
          // Native picker on web returns blob URIs; need to fetch into Blob.
          try {
            const res = await fetch(it.uri);
            const blob = await res.blob();
            formData.append('media[]', blob, it.fileName);
          } catch {
            // Skip if fetch fails; better to publish remaining than abort all.
          }
        } else {
          formData.append('media[]', {
            uri: it.uri,
            name: it.fileName,
            type: it.mimeType,
          });
        }
      }
      const r = await api.feedCreatePost(formData);
      if (r?.success) {
        // [bug-fix #photo-new-disappears] User reported "novo eu adiciono
        // foto e ele some" — they published a post, navigated back to feed/
        // photos, and couldn't find it. Two root causes:
        //   1. Backend was NOT broadcasting `feed_new_post` via WS, so the
        //      ChatFeedTab listener never prepended the post and the next
        //      poll cycle was up to 60s away (now fixed in email.php).
        //   2. The local `feed_posts` IndexedDB cache (90-day TTL) holds the
        //      pre-publish snapshot. Even after focusing the feed tab,
        //      ChatFeedTab hydrates from that stale cache before the API
        //      delta lands. Invalidate it here so the next visit forces a
        //      fresh fetch.
        const postId = r?.data?.post?.id;
        const newPost = r?.data?.post;
        try {
          if (newPost) {
            const cached = (await getCached('feed_posts').catch(() => null)) || [];
            const dedup = Array.isArray(cached) ? cached.filter(p => p?.id !== newPost.id) : [];
            // Prepend optimistically so the timeline shows it the moment the
            // user navigates back, even if the WS event hasn't arrived yet.
            const merged = [{ ...newPost, created_at: new Date().toISOString() }, ...dedup].slice(0, 200);
            await setCache('feed_posts', merged, 7776000000);
          } else {
            // No post returned — just drop the cache so the feed re-fetches.
            await setCache('feed_posts', [], 0).catch(() => {});
          }
        } catch {}

        // After publish: navigate to /feed/[id] (Instagram-style standalone
        // viewer). The route is auth-aware — logged-in viewers see counts +
        // actions, anonymous viewers see a Sign-in CTA. We replace() instead
        // of push() so the back-button takes them out of /photo-new (the
        // staging key is already cleared on mount).
        if (postId) {
          router.replace(`/feed/${postId}`);
        } else {
          // Fallback: backend didn't return an id (shouldn't happen with the
          // post-create handler, but defensive). Keep the legacy behaviour
          // so we never leave the user stuck on a spinner — surface a clear
          // success message so they don't think it failed.
          safeAlert(
            t('photoNew.published') || 'Publicado',
            t('photoNew.publishedDesc') || 'Sua publicação foi enviada.',
          );
          router.back();
        }
      } else {
        setPublishing(false);
        safeAlert(
          t('common.error') || 'Erro',
          r?.error || r?.message || (t('photoNew.publishError') || 'Falha ao publicar.'),
        );
      }
    } catch (e) {
      setPublishing(false);
      safeAlert(t('common.error') || 'Erro', e?.message || '');
    }
  }, [publishing, items, caption, router, t]);

  // ----- Styles -----
  const s = useMemo(() => StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: Spacing.md, paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
    },
    headerBtn: { padding: 8, minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
    headerTitle: { fontSize: FontSize.lg, fontWeight: '600', color: colors.text },
    publishBtn: {
      paddingHorizontal: 14, paddingVertical: 8, borderRadius: BorderRadius.lg,
      backgroundColor: colors.primary, minWidth: 90, alignItems: 'center',
    },
    publishBtnDisabled: { opacity: 0.5 },
    publishText: { color: '#fff', fontWeight: '700', fontSize: FontSize.sm },
    carouselWrap: { width: '100%', aspectRatio: 1, backgroundColor: '#000' },
    slide: { width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center' },
    slideMedia: { width: '100%', height: '100%' },
    perItemBtns: {
      // Anchor inside the slide with a safe-margin so the X never sits under the
      // notch / header divider. Each button is 44pt (WCAG hit-target min) which
      // visually nudges the row down naturally without breaking the carousel.
      position: 'absolute', top: 16, right: 16, flexDirection: 'row', gap: 10,
      zIndex: 50, elevation: 50,
    },
    iconBtn: {
      width: 44, height: 44, borderRadius: 22,
      backgroundColor: 'rgba(0,0,0,0.6)',
      justifyContent: 'center', alignItems: 'center',
      ...Shadow.sm,
    },
    videoBadge: {
      position: 'absolute', bottom: 12, left: 12,
      backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 10, paddingVertical: 4,
      borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 4,
    },
    videoBadgeText: { color: '#fff', fontSize: 12, fontWeight: '600' },
    dotsRow: {
      flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
      paddingVertical: 10, gap: 6,
    },
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: isDark ? '#3f3f46' : '#d4d4d8' },
    dotActive: { backgroundColor: colors.primary, width: 16 },
    thumbsStrip: {
      paddingHorizontal: Spacing.md, paddingVertical: 10, gap: 8,
    },
    thumb: {
      width: 60, height: 60, borderRadius: 8, backgroundColor: '#222',
      borderWidth: 2, borderColor: 'transparent',
      overflow: 'hidden',
    },
    thumbActive: { borderColor: colors.primary },
    thumbReorder: { borderColor: '#F59E0B', borderWidth: 2 },
    thumbImg: { width: '100%', height: '100%' },
    addMoreTile: {
      width: 60, height: 60, borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth * 3, borderStyle: 'dashed',
      borderColor: isDark ? '#52525b' : '#a1a1aa',
      justifyContent: 'center', alignItems: 'center',
      backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
    },
    captionWrap: {
      flexDirection: 'row', alignItems: 'flex-start',
      paddingHorizontal: Spacing.md, paddingVertical: Spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
    },
    captionInput: {
      flex: 1, color: colors.text, fontSize: FontSize.md,
      minHeight: 60, maxHeight: 160, paddingTop: 0,
    },
    counter: {
      fontSize: 11, color: colors.textTertiary, marginTop: 2, textAlign: 'right',
    },
    reorderHint: {
      paddingHorizontal: Spacing.md, paddingBottom: 4,
      fontSize: 12, color: '#F59E0B', fontWeight: '600',
    },
  }), [colors, isDark]);

  const captionRemaining = MAX_CAPTION - caption.length;

  return (
    <View style={[s.root, { paddingTop: insets.top + 4 }]}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.headerBtn} accessibilityLabel={t('common.close') || 'Fechar'} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <IconX size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>{t('photoNew.title') || 'Nova publicação'}</Text>
        <TouchableOpacity
          onPress={publish}
          disabled={publishing || items.length === 0}
          style={[s.publishBtn, (publishing || items.length === 0) && s.publishBtnDisabled]}
          accessibilityLabel={t('photoNew.publish') || 'Publicar'}
        >
          {publishing ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={s.publishText}>{t('photoNew.publish') || 'Publicar'}</Text>
          )}
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top + 50}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}>
          {/* Carousel */}
          <View
            style={s.carouselWrap}
            onLayout={e => setCarouselWidth(e.nativeEvent.layout.width)}
          >
            {carouselWidth > 0 && items.length > 0 && (
              <FlatList
                ref={carouselRef}
                data={items}
                horizontal
                pagingEnabled
                showsHorizontalScrollIndicator={false}
                keyExtractor={(item) => item.id}
                onMomentumScrollEnd={handleScrollEnd}
                renderItem={({ item, index }) => (
                  <View style={[s.slide, { width: carouselWidth }]}>
                    <ExpoImage
                      source={{ uri: item.uri }}
                      style={s.slideMedia}
                      contentFit="contain"
                    />
                    {item.type === 'video' && (
                      <View style={s.videoBadge}>
                        <IconPlay size={12} color="#fff" />
                        <Text style={s.videoBadgeText}>{t('chat.video') || 'Vídeo'}</Text>
                      </View>
                    )}
                    <View style={s.perItemBtns}>
                      <TouchableOpacity
                        style={s.iconBtn}
                        onPress={() => openEditor(index)}
                        accessibilityLabel={t('photoNew.edit') || 'Editar'}
                      >
                        <IconEdit size={18} color="#fff" />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={s.iconBtn}
                        onPress={() => removeAt(index)}
                        accessibilityLabel={t('photoNew.remove') || 'Remover'}
                      >
                        <IconX size={20} color="#fff" />
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              />
            )}
          </View>

          {/* Dots */}
          {items.length > 1 && (
            <View style={s.dotsRow}>
              {items.map((it, i) => (
                <View key={it.id} style={[s.dot, i === activeIndex && s.dotActive]} />
              ))}
            </View>
          )}

          {/* Thumbs strip (tap to jump, long-press to reorder, + to add more) */}
          {reorderFromIdx >= 0 && (
            <Text style={s.reorderHint}>
              {t('photoNew.reorderHint') || 'Toque em outra foto para trocar de posição'}
            </Text>
          )}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.thumbsStrip}
          >
            {items.map((it, i) => (
              <TouchableOpacity
                key={it.id}
                style={[
                  s.thumb,
                  i === activeIndex && s.thumbActive,
                  i === reorderFromIdx && s.thumbReorder,
                ]}
                onPress={() => onThumbPress(i)}
                onLongPress={() => onThumbLongPress(i)}
                accessibilityLabel={`Item ${i + 1}`}
              >
                <ExpoImage source={{ uri: it.uri }} style={s.thumbImg} contentFit="cover" />
              </TouchableOpacity>
            ))}
            {items.length < MAX_ITEMS && (
              <TouchableOpacity
                style={s.addMoreTile}
                onPress={addMore}
                accessibilityLabel={t('photoNew.addMore') || 'Adicionar mais'}
              >
                <IconPlus size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            )}
          </ScrollView>

          {/* Caption */}
          <View style={s.captionWrap}>
            <TextInput
              value={caption}
              onChangeText={(v) => v.length <= MAX_CAPTION && setCaption(v)}
              placeholder={t('photoNew.captionPlaceholder') || 'Escreva uma legenda...'}
              placeholderTextColor={colors.textTertiary}
              multiline
              style={s.captionInput}
            />
          </View>
          <Text style={[s.counter, { paddingHorizontal: Spacing.md }]}>
            {captionRemaining}
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Editor (per-item) */}
      <PhotoEditor
        visible={editorOpenForIdx >= 0}
        imageUri={editorOpenForIdx >= 0 ? items[editorOpenForIdx]?.uri : null}
        onSave={handleEditorSave}
        onClose={() => setEditorOpenForIdx(-1)}
      />
    </View>
  );
}
