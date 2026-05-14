// /lives-saved — list of recorded Lives the user can replay.
//
// Two sources unioned server-side:
//   1) Lives the user hosted (auto-saved unless they opted out)
//   2) Lives saved via "Salvar live" tap on the live-viewer end-card
//
// Each row → tap opens /live-replay?id=X for full-screen playback. Long-press
// shows a contextual sheet with Share / Baixar / Excluir (host-only). The
// download path uses expo-file-system writeAsStringAsync into the device
// media library so users get a real .mp4 in their camera roll/photos.
//
// On mount we fire one liveRecordingPoll() with no session_id — this rolls
// through the user's last 20 ended sessions and finalizes any pending CF
// VOD URLs. Cheap (per-uid CF lookup, capped at 20). After the poll we
// reload the list so newly-ready replays appear without a manual refresh.
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator,
  RefreshControl, Image, Alert, Platform, Share,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as api from '../services/api';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconPlay, IconDownload, IconTrash, IconShare, IconStar } from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';

// Format seconds → "M:SS" / "H:MM:SS" for the duration chip in each row.
function formatDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

// Format ISO date → locale-aware relative (today, ontem, 3d).
function formatWhen(iso, t) {
  if (!iso) return '';
  try {
    const d = new Date(iso.includes('Z') ? iso : iso + 'Z');
    const diffMs = Date.now() - d.getTime();
    const day = 86400000;
    if (diffMs < day) return t('liveReplay.today') || 'Hoje';
    if (diffMs < 2 * day) return t('liveReplay.yesterday') || 'Ontem';
    const days = Math.floor(diffMs / day);
    if (days < 7) return `${days}${t('liveReplay.daysShort') || 'd'}`;
    return d.toLocaleDateString();
  } catch { return ''; }
}

export default function LivesSavedScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();

  const [recordings, setRecordings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  // Pull-to-refresh + initial load. The poll-then-list pattern gives newly-
  // ended lives a chance to flip recording_ready=TRUE before the list query
  // runs, so the host doesn't see "Processing…" on their own recent replay
  // if CF has already finalized.
  const load = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    setError('');
    try {
      // Fire poll first (best-effort, don't block on errors).
      try { await api.liveRecordingPoll(); } catch {}
      const res = await api.liveRecordingsList(50, 0);
      if (res?.success && Array.isArray(res.data?.recordings)) {
        setRecordings(res.data.recordings);
      } else {
        setRecordings([]);
        setError(res?.message || '');
      }
    } catch (e) {
      setError(e?.message || 'Falha ao carregar');
      setRecordings([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(true); }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load(false);
  }, [load]);

  const onOpenReplay = useCallback((rec) => {
    if (!rec?.session_id) return;
    router.push(`/live-replay?id=${encodeURIComponent(rec.session_id)}`);
  }, [router]);

  const onShare = useCallback(async (rec) => {
    if (!rec?.session_id) return;
    try {
      const url = `https://chatyy.com.br/live-replay?id=${encodeURIComponent(rec.session_id)}`;
      const msg = `${rec.title || 'Live'} — ${rec.host_name || ''}`;
      await Share.share({ title: msg, message: `${msg}\n${url}`, url });
    } catch {}
  }, []);

  // Download MP4 to camera roll. expo-file-system + expo-media-library are
  // already in the bundle (status video saver uses the same combo). On web
  // we just open the MP4 URL in a new tab — browser handles save.
  const onDownload = useCallback(async (rec) => {
    if (!rec?.recording_mp4) {
      Alert.alert(t('liveReplay.processing') || 'Ainda processando',
                  t('liveReplay.tryAgainSoon') || 'Tente daqui a pouco.');
      return;
    }
    if (Platform.OS === 'web') {
      try { window.open(rec.recording_mp4, '_blank'); } catch {}
      return;
    }
    try {
      const FS = require('expo-file-system');
      const ML = require('expo-media-library');
      const target = `${FS.cacheDirectory}live-${rec.session_id}.mp4`;
      const dl = FS.createDownloadResumable(rec.recording_mp4, target);
      const { uri } = await dl.downloadAsync();
      const perm = await ML.requestPermissionsAsync();
      if (perm?.granted) {
        await ML.saveToLibraryAsync(uri);
        Alert.alert(t('liveReplay.downloaded') || 'Baixado',
                    t('liveReplay.downloadedHint') || 'Vídeo salvo na galeria.');
      } else {
        Alert.alert(t('liveReplay.downloadDenied') || 'Permissão negada',
                    t('liveReplay.downloadDeniedHint') || 'Sem acesso à galeria.');
      }
    } catch (e) {
      Alert.alert(t('liveReplay.downloadFailed') || 'Falha no download', String(e?.message || e));
    }
  }, [t]);

  const onDelete = useCallback((rec) => {
    if (!rec?.session_id) return;
    const isHost = !!rec.is_host;
    Alert.alert(
      isHost ? (t('liveReplay.deleteTitle') || 'Excluir replay?')
             : (t('liveReplay.unsaveTitle') || 'Remover dos salvos?'),
      isHost ? (t('liveReplay.deleteConfirm') || 'Isso vai apagar permanentemente a gravação. Todos os viewers perdem acesso.')
             : (t('liveReplay.unsaveConfirm') || 'O replay vai sair da sua aba "Lives salvas".'),
      [
        { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
        {
          text: isHost ? (t('liveReplay.deleteConfirmBtn') || 'Excluir')
                       : (t('liveReplay.unsave') || 'Remover'),
          style: 'destructive',
          onPress: async () => {
            try {
              const res = isHost
                ? await api.liveRecordingDelete(rec.session_id)
                : await api.liveUnsaveReplay(rec.session_id);
              if (res?.success) {
                setRecordings(prev => prev.filter(r => r.session_id !== rec.session_id));
              } else {
                Alert.alert(t('common.error') || 'Erro', res?.message || '');
              }
            } catch (e) {
              Alert.alert(t('common.error') || 'Erro', String(e?.message || e));
            }
          },
        },
      ]
    );
  }, [t]);

  const renderItem = useCallback(({ item }) => {
    const thumb = item.thumbnail_url || '';
    return (
      <TouchableOpacity
        onPress={() => onOpenReplay(item)}
        activeOpacity={0.78}
        style={[styles.row, { backgroundColor: colors.card || (isDark ? '#1c1c1e' : '#fff') }]}
      >
        <View style={styles.thumbWrap}>
          {thumb
            ? <Image source={{ uri: thumb }} style={styles.thumb} />
            : <View style={[styles.thumb, styles.thumbPlaceholder, { backgroundColor: isDark ? '#2a2a2c' : '#eee' }]} />
          }
          <View style={styles.playOverlay}>
            <IconPlay size={24} color="#fff" />
          </View>
          {!!item.duration && (
            <View style={styles.durChip}>
              <Text style={styles.durTxt}>{formatDuration(item.duration)}</Text>
            </View>
          )}
        </View>

        <View style={styles.rowBody}>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
            {item.title || (t('live.title') || 'Live')}
          </Text>
          <View style={styles.metaRow}>
            <AvatarCircle name={item.host_name} email={item.host_email} size={18} />
            <Text style={[styles.metaTxt, { color: colors.textMuted || '#888' }]} numberOfLines={1}>
              {item.host_name || item.host_email}
            </Text>
            <Text style={[styles.metaDot, { color: colors.textMuted || '#888' }]}>·</Text>
            <Text style={[styles.metaTxt, { color: colors.textMuted || '#888' }]}>
              {formatWhen(item.ended_at || item.started_at, t)}
            </Text>
          </View>
          {item.is_host && item.saved_count > 0 && (
            <View style={styles.savedCountRow}>
              <IconStar size={11} color="#7C3AED" />
              <Text style={[styles.savedCountTxt, { color: colors.textMuted || '#888' }]}>
                {item.saved_count} {item.saved_count === 1
                  ? (t('liveReplay.savedBy1') || 'pessoa salvou')
                  : (t('liveReplay.savedByN') || 'pessoas salvaram')}
              </Text>
            </View>
          )}
        </View>

        <View style={styles.actions}>
          <TouchableOpacity onPress={() => onDownload(item)} style={styles.actionBtn}
                            accessibilityLabel={t('liveReplay.download') || 'Baixar'}>
            <IconDownload size={18} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => onShare(item)} style={styles.actionBtn}
                            accessibilityLabel={t('liveReplay.shareLink') || 'Compartilhar'}>
            <IconShare size={18} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => onDelete(item)} style={styles.actionBtn}
                            accessibilityLabel={item.is_host
                              ? (t('liveReplay.delete') || 'Excluir')
                              : (t('liveReplay.unsave') || 'Remover')}>
            <IconTrash size={18} color="#ef4444" />
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    );
  }, [colors, isDark, t, onOpenReplay, onDownload, onShare, onDelete]);

  const empty = !loading && recordings.length === 0;

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: colors.border || (isDark ? '#2a2a2c' : '#eee') }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}
                          accessibilityLabel={t('common.back') || 'Voltar'} accessibilityRole="button">
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>
          {t('liveReplay.tab') || 'Lives salvas'}
        </Text>
        <View style={{ width: 38 }} />
      </View>

      {loading ? (
        <View style={styles.centered}><ActivityIndicator color="#7C3AED" /></View>
      ) : empty ? (
        <View style={styles.empty}>
          <View style={[styles.emptyIcon, { backgroundColor: isDark ? '#222' : '#f1ecff' }]}>
            <IconStar size={36} color="#7C3AED" />
          </View>
          <Text style={[styles.emptyTitle, { color: colors.text }]}>
            {t('liveReplay.emptyTitle') || 'Nenhuma live salva'}
          </Text>
          <Text style={[styles.emptyHint, { color: colors.textMuted || '#888' }]}>
            {t('liveReplay.empty') || 'Lives que você apresentou e replays que salvar vão aparecer aqui.'}
          </Text>
          {!!error && <Text style={styles.err}>{error}</Text>}
        </View>
      ) : (
        <FlatList
          data={recordings}
          keyExtractor={(it) => String(it.session_id || it.id)}
          renderItem={renderItem}
          contentContainerStyle={{ paddingVertical: 8 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#7C3AED" />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 8, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { fontSize: 17, fontWeight: '600' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  emptyIcon: {
    width: 78, height: 78, borderRadius: 39, alignItems: 'center', justifyContent: 'center',
    marginBottom: 16,
  },
  emptyTitle: { fontSize: 18, fontWeight: '600', marginBottom: 6 },
  emptyHint: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  err: { color: '#ef4444', marginTop: 12, fontSize: 13, textAlign: 'center' },
  row: {
    flexDirection: 'row', alignItems: 'center', padding: 10, marginHorizontal: 12, marginVertical: 4,
    borderRadius: 14,
  },
  thumbWrap: { width: 96, height: 96, borderRadius: 10, overflow: 'hidden', position: 'relative' },
  thumb: { width: '100%', height: '100%' },
  thumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  playOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.25)',
  },
  durChip: {
    position: 'absolute', right: 5, bottom: 5,
    backgroundColor: 'rgba(0,0,0,0.7)', paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 6,
  },
  durTxt: { color: '#fff', fontSize: 11, fontWeight: '600' },
  rowBody: { flex: 1, marginLeft: 12 },
  title: { fontSize: 15, fontWeight: '600', marginBottom: 6 },
  metaRow: { flexDirection: 'row', alignItems: 'center' },
  metaTxt: { fontSize: 12, marginLeft: 6, maxWidth: 140 },
  metaDot: { fontSize: 12, marginHorizontal: 4 },
  savedCountRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  savedCountTxt: { fontSize: 11, marginLeft: 4 },
  actions: { flexDirection: 'column', alignItems: 'center', marginLeft: 6 },
  actionBtn: { padding: 6, marginVertical: 2 },
});
