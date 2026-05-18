/**
 * /reels-drafts — 3-column grid of persisted reel drafts.
 *
 * Drafts live in AsyncStorage under `reel_drafts` (newest first, cap 5,
 * written by app/reels-recorder.js handleComplete). Each draft references
 * recorded clip URIs on local storage — the thumb cell renders the first
 * clip's URI via expo-video poster fallback or expo-video-thumbnails (best
 * effort) and falls back to a solid color tile when no thumbnail is ready.
 *
 * Tap → restore globalThis.__pendingReelDraft + router.back() so the
 * caller (chat composer / reels feed) can resume from where the user left
 * off. Long-press → delete.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Dimensions,
  ActivityIndicator,
  Image,
  Alert,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLanguage } from '../context/LanguageContext';
import { IconX, IconTrash } from '../components/Icons';
import { REEL_DRAFTS_KEY } from './reels-recorder';

const { width: SCREEN_W } = Dimensions.get('window');
const TILE_GAP = 4;
const TILE_W = (SCREEN_W - TILE_GAP * 4) / 3;
const TILE_H = TILE_W * 1.6; // reel 9:16 aspect

function fmtAgo(ts, t) {
  const diff = Date.now() - (ts || 0);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return t?.('time.now') || 'agora';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function ReelsDraftsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const [drafts, setDrafts] = useState(null); // null = loading, [] = empty

  const load = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(REEL_DRAFTS_KEY);
      const list = raw ? JSON.parse(raw) : [];
      setDrafts(Array.isArray(list) ? list : []);
    } catch {
      setDrafts([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const resumeDraft = useCallback((draft) => {
    if (!draft) return;
    try {
      // eslint-disable-next-line no-undef
      globalThis.__pendingReelDraft = {
        clips: draft.clips || [],
        music: draft.music || null,
        totalDurationMs: draft.totalDurationMs || 0,
      };
    } catch {}
    try { router.back(); } catch {}
  }, [router]);

  const deleteDraft = useCallback(async (draftId) => {
    try {
      const raw = await AsyncStorage.getItem(REEL_DRAFTS_KEY);
      const list = raw ? JSON.parse(raw) : [];
      const next = (Array.isArray(list) ? list : []).filter(d => d.id !== draftId);
      await AsyncStorage.setItem(REEL_DRAFTS_KEY, JSON.stringify(next));
      setDrafts(next);
    } catch {}
  }, []);

  const confirmDelete = useCallback((draft) => {
    if (Platform.OS === 'web') {
      // eslint-disable-next-line no-undef
      if (typeof confirm !== 'undefined' && confirm(t('reels.draftDeleteConfirm') || 'Excluir rascunho?')) {
        deleteDraft(draft.id);
      }
      return;
    }
    Alert.alert(
      t('reels.draftDeleteTitle') || 'Excluir rascunho',
      t('reels.draftDeleteConfirm') || 'Tem certeza?',
      [
        { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
        { text: t('common.delete') || 'Excluir', style: 'destructive', onPress: () => deleteDraft(draft.id) },
      ]
    );
  }, [deleteDraft, t]);

  const renderTile = useCallback(({ item }) => {
    const firstClip = (item.clips || [])[0];
    const thumbUri = firstClip?.uri || null;
    return (
      <TouchableOpacity
        onPress={() => resumeDraft(item)}
        onLongPress={() => confirmDelete(item)}
        style={styles.tile}
        activeOpacity={0.8}
      >
        {thumbUri ? (
          // expo-image / Image attempts the first frame for native video URIs;
          // when that fails (different platforms have different behavior) we
          // just show a dark tile with the metadata overlay.
          <Image source={{ uri: thumbUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: '#1f1f1f' }]} />
        )}
        <View style={styles.tileOverlay}>
          <Text style={styles.tileDuration}>{fmtDuration(item.totalDurationMs)}</Text>
          <Text style={styles.tileAge}>{fmtAgo(item.savedAt, t)}</Text>
        </View>
        <TouchableOpacity
          onPress={() => confirmDelete(item)}
          style={styles.tileDelete}
          hitSlop={8}
        >
          <IconTrash size={14} color="#fff" />
        </TouchableOpacity>
      </TouchableOpacity>
    );
  }, [resumeDraft, confirmDelete, t]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>
          {t('reels.drafts') || 'Rascunhos'}
        </Text>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={styles.closeBtn}>
          <IconX size={22} color="#fff" />
        </TouchableOpacity>
      </View>

      {drafts === null ? (
        <View style={styles.center}>
          <ActivityIndicator color="#fff" />
        </View>
      ) : drafts.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTxt}>
            {t('reels.draftsEmpty') || 'Nenhum rascunho salvo'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={drafts}
          keyExtractor={(item) => item.id}
          numColumns={3}
          renderItem={renderTile}
          columnWrapperStyle={{ gap: TILE_GAP, paddingHorizontal: TILE_GAP }}
          ItemSeparatorComponent={() => <View style={{ height: TILE_GAP }} />}
          contentContainerStyle={{ paddingTop: TILE_GAP, paddingBottom: insets.bottom + 20 }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: { color: '#fff', fontSize: 18, fontWeight: '800' },
  closeBtn: {
    width: 36, height: 36,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyTxt: { color: '#fff', opacity: 0.7, fontSize: 14 },
  tile: {
    width: TILE_W,
    height: TILE_H,
    backgroundColor: '#1f1f1f',
    borderRadius: 8,
    overflow: 'hidden',
  },
  tileOverlay: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  tileDuration: { color: '#fff', fontSize: 11, fontWeight: '700' },
  tileAge: { color: '#fff', fontSize: 10, opacity: 0.75 },
  tileDelete: {
    position: 'absolute',
    top: 4, right: 4,
    width: 24, height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center',
  },
});
