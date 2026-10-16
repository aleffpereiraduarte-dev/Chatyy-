// [2026-10-13 video-studio] RASCUNHOS do Video Studio (draftStore persistente).
// Toque = continuar editando · toque longo = apagar · "Novo" = câmera.
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, Alert, useWindowDimensions, ActivityIndicator } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Image } from 'expo-image';
import { useLanguage } from '../../context/LanguageContext';
import { haptic } from '../../constants/theme';
import { IconArrowLeft, IconCamera, IconFilm } from '../../components/Icons';
import { C } from '../../components/videoStudio/ui';
import { useSourceInfo, thumbAt } from '../../components/videoStudio/thumbs';
import { listDrafts, loadDraft, deleteDraft } from '../../services/videoStudio/draftStore';
import { isDraftPublishing, subscribeStudioJobs, resumeStudioRenders } from '../../services/videoStudio/renderQueue';
import { fmtTime } from '../../services/videoStudio/edlOps';

function DraftThumb({ id, fallback }) {
  const [clip, setClip] = useState(null);
  useEffect(() => {
    let alive = true;
    loadDraft(id).then((d) => { if (alive) setClip(d?.edl?.clips?.[0] || null); });
    return () => { alive = false; };
  }, [id]);
  const info = useSourceInfo(clip);
  const src = clip?.kind === 'image' ? { uri: clip.uri } : (thumbAt(info, (clip?.in || 0) + 0.2) || (fallback ? { uri: fallback } : (clip?.thumb ? { uri: clip.thumb } : null)));
  return src ? <Image source={src} style={[StyleSheet.absoluteFill, clip?.mirror ? { transform: [{ scaleX: -1 }] } : null]} contentFit="cover" /> : null;
}

function fmtDate(ms) {
  try { return new Date(ms).toLocaleDateString(undefined, { day: '2-digit', month: 'short' }); } catch { return ''; }
}

export default function VideoStudioDrafts() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const { width } = useWindowDimensions();
  const [items, setItems] = useState(null);
  const [tick, setTick] = useState(0); // [2026-10-16] tick vai p/ a FlatList (React Compiler memoizava o selo 'Publicando')

  const reload = useCallback(() => { listDrafts().then((l) => setItems(l || [])).catch(() => setItems([])); }, []);
  useFocusEffect(useCallback(() => { reload(); }, [reload]));
  useEffect(() => {
    const un = subscribeStudioJobs(() => setTick((x) => x + 1));
    resumeStudioRenders().catch(() => {}); // carrega jobs persistidos (badge "Publicando")
    return un;
  }, []);

  const cols = 3;
  const gap = 3;
  const cw = Math.floor((width - gap * (cols - 1)) / cols);

  const open = (it) => {
    if (isDraftPublishing(it.id)) { Alert.alert(t('studio.drafts.title'), t('studio.drafts.publishing')); return; }
    router.push({ pathname: '/video-studio/editor', params: { draft: it.id } });
  };
  const remove = (it) => {
    if (isDraftPublishing(it.id)) return;
    try { haptic.medium(); } catch {}
    Alert.alert(t('studio.drafts.deleteTitle'), t('studio.drafts.deleteBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('studio.delete'), style: 'destructive', onPress: async () => { await deleteDraft(it.id); reload(); } },
    ]);
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <StatusBar style="light" />
      <View style={styles.top}>
        <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace('/chat'))} hitSlop={10} style={styles.topBtn} accessibilityRole="button" accessibilityLabel={t('common.back')}>
          <IconArrowLeft size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>{t('studio.drafts.title')}</Text>
        <TouchableOpacity onPress={() => router.push('/video-studio/camera')} style={styles.newBtn} accessibilityRole="button">
          <IconCamera size={16} color="#000" />
          <Text style={styles.newTxt}>{t('studio.drafts.new')}</Text>
        </TouchableOpacity>
      </View>
      {items == null ? (
        <View style={styles.center}><ActivityIndicator color="#fff" /></View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <IconFilm size={40} color={C.fg3} />
          <Text style={styles.emptyTitle}>{t('studio.drafts.emptyTitle')}</Text>
          <Text style={styles.emptyBody}>{t('studio.drafts.emptyBody')}</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          extraData={tick}
          keyExtractor={(x) => x.id}
          numColumns={cols}
          columnWrapperStyle={{ gap }}
          contentContainerStyle={{ gap, paddingBottom: insets.bottom + 20 }}
          renderItem={({ item }) => {
            const pub = isDraftPublishing(item.id);
            return (
              <TouchableOpacity onPress={() => open(item)} onLongPress={() => remove(item)} delayLongPress={350} style={[styles.cell, { width: cw, height: Math.round((cw * 16) / 9) }]} accessibilityRole="button" accessibilityHint={t('studio.drafts.hint')}>
                <DraftThumb id={item.id} fallback={item.thumb} />
                <View style={styles.cellShade} />
                {pub && <View style={styles.badge}><Text style={styles.badgeTxt}>{t('studio.drafts.publishingBadge')}</Text></View>}
                <View style={styles.meta}>
                  <Text style={styles.metaTxt}>{fmtTime(item.duration || 0)}</Text>
                  <Text style={styles.metaTxt}>{fmtDate(item.updatedAt)}</Text>
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  top: { height: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 },
  topBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, color: '#fff', fontSize: 17, fontWeight: '800', marginLeft: 4 },
  newBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 14, borderRadius: 17, backgroundColor: '#fff' },
  newTxt: { color: '#000', fontWeight: '800', fontSize: 13 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 32 },
  emptyTitle: { color: '#fff', fontSize: 16, fontWeight: '800' },
  emptyBody: { color: C.fg2, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  cell: { backgroundColor: '#1a1a1a', overflow: 'hidden' },
  cellShade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 40, backgroundColor: 'rgba(0,0,0,0.35)' },
  meta: { position: 'absolute', left: 6, right: 6, bottom: 6, flexDirection: 'row', justifyContent: 'space-between' },
  metaTxt: { color: '#fff', fontSize: 11, fontWeight: '700' },
  badge: { position: 'absolute', top: 6, left: 6, backgroundColor: '#fff', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  badgeTxt: { color: '#000', fontSize: 10, fontWeight: '800' },
});
