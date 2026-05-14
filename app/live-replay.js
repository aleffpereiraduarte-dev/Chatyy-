// /live-replay?id=X — full-screen HLS playback of a recorded live.
//
// Pulls metadata + URLs from `live_recording_get` (auth-gated to host/saved
// viewers/open-link). Renders via expo-video with native controls. Header
// floats over the video with title, host, and quick actions (Share +
// Download MP4). Tap-anywhere → toggle controls visibility (Instagram/
// TikTok pattern).
//
// Web playback: uses an HTMLVideoElement with the HLS URL — hls.js polyfill
// isn't bundled, but Safari/iOS-web has native HLS support, and Chrome/
// desktop sniffs the MP4 fallback URL automatically (CF Stream serves both).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Platform,
  Share, Alert, StatusBar,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as api from '../services/api';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconShare, IconDownload, IconTrash } from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';

function _loadExpoVideo() {
  try { return require('expo-video'); } catch { return null; }
}

function ReplayNativePlayer({ uri, onReady, onError }) {
  const mod = _loadExpoVideo();
  if (!mod) {
    useEffect(() => { onError?.(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]} />;
  }
  const { useVideoPlayer, VideoView } = mod;
  const player = useVideoPlayer(uri, (p) => {
    try { p.loop = false; p.muted = false; p.play(); } catch {}
  });
  useEffect(() => {
    const sub = player.addListener?.('statusChange', (s) => {
      if (s?.error) { onError?.(s.error); return; }
      if (s?.status === 'readyToPlay' || s?.status === 'playing') onReady?.();
    });
    return () => { try { sub?.remove?.(); } catch {} };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    try { player.pause?.(); } catch {}
    try { player.replace?.(null); } catch {}
    try { player.release?.(); } catch {}
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <VideoView
      player={player}
      style={StyleSheet.absoluteFill}
      contentFit="contain"
      nativeControls
      allowsPictureInPicture
    />
  );
}

export default function LiveReplayScreen() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();

  const sessionId = Array.isArray(id) ? id[0] : id;
  const [rec, setRec] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [videoError, setVideoError] = useState(false);

  useEffect(() => {
    if (!sessionId) { setLoading(false); setError('Missing id'); return; }
    let alive = true;
    (async () => {
      try {
        const res = await api.liveRecordingGet(sessionId);
        if (!alive) return;
        if (res?.success && res.data) {
          if (!res.data.recording_ready || !res.data.recording_url) {
            setError(t('liveReplay.processing') || 'Replay ainda processando');
          }
          setRec(res.data);
        } else {
          setError(res?.message || 'Failed to load');
        }
      } catch (e) {
        if (alive) setError(e?.message || 'Failed to load');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [sessionId, t]);

  const onShare = useCallback(async () => {
    if (!sessionId) return;
    try {
      const url = `https://chatyy.com.br/live-replay?id=${encodeURIComponent(sessionId)}`;
      const msg = `${rec?.title || 'Live'} — ${rec?.host_name || ''}`;
      await Share.share({ title: msg, message: `${msg}\n${url}`, url });
    } catch {}
  }, [sessionId, rec]);

  const onDownload = useCallback(async () => {
    if (!rec?.recording_mp4) {
      Alert.alert(t('liveReplay.processing') || 'Ainda processando');
      return;
    }
    if (Platform.OS === 'web') {
      try { window.open(rec.recording_mp4, '_blank'); } catch {}
      return;
    }
    try {
      const FS = require('expo-file-system');
      const ML = require('expo-media-library');
      const target = `${FS.cacheDirectory}live-${sessionId}.mp4`;
      const dl = FS.createDownloadResumable(rec.recording_mp4, target);
      const { uri } = await dl.downloadAsync();
      const perm = await ML.requestPermissionsAsync();
      if (perm?.granted) {
        await ML.saveToLibraryAsync(uri);
        Alert.alert(t('liveReplay.downloaded') || 'Baixado',
                    t('liveReplay.downloadedHint') || 'Vídeo salvo na galeria.');
      }
    } catch (e) {
      Alert.alert(t('liveReplay.downloadFailed') || 'Falha', String(e?.message || e));
    }
  }, [rec, sessionId, t]);

  const onDelete = useCallback(() => {
    if (!sessionId || !rec) return;
    const isHost = !!rec.is_host;
    Alert.alert(
      isHost ? (t('liveReplay.deleteTitle') || 'Excluir replay?')
             : (t('liveReplay.unsaveTitle') || 'Remover dos salvos?'),
      isHost ? (t('liveReplay.deleteConfirm') || 'Vai apagar permanentemente.')
             : (t('liveReplay.unsaveConfirm') || 'Replay vai sair dos salvos.'),
      [
        { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
        {
          text: isHost ? (t('liveReplay.deleteConfirmBtn') || 'Excluir')
                       : (t('liveReplay.unsave') || 'Remover'),
          style: 'destructive',
          onPress: async () => {
            try {
              const res = isHost
                ? await api.liveRecordingDelete(sessionId)
                : await api.liveUnsaveReplay(sessionId);
              if (res?.success) router.back();
              else Alert.alert(t('common.error') || 'Erro', res?.message || '');
            } catch (e) {
              Alert.alert(t('common.error') || 'Erro', String(e?.message || e));
            }
          },
        },
      ]
    );
  }, [sessionId, rec, router, t]);

  // On web we render a native <video> tag — expo-video on web doesn't speak
  // HLS reliably across browsers (no hls.js in the bundle yet). Safari has
  // native HLS; Chrome + Firefox fall back to recording_mp4 via the source
  // selection. This sidesteps the polyfill weight for now.
  const videoUrl = useMemo(() => {
    if (!rec) return null;
    return rec.recording_url || rec.recording_mp4 || null;
  }, [rec]);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      {loading ? (
        <View style={styles.centered}><ActivityIndicator color="#fff" /></View>
      ) : !rec || !videoUrl || videoError || !rec.recording_ready ? (
        <View style={styles.centered}>
          <Text style={styles.err}>
            {error || (t('liveReplay.processing') || 'Replay ainda processando — tente daqui a pouco.')}
          </Text>
          <TouchableOpacity onPress={() => router.back()} style={styles.errBack} accessibilityRole="button">
            <Text style={styles.errBackTxt}>{t('common.back') || 'Voltar'}</Text>
          </TouchableOpacity>
        </View>
      ) : Platform.OS === 'web' ? (
        // eslint-disable-next-line react/no-unknown-property
        <video
          src={rec.recording_mp4 || videoUrl}
          poster={rec.thumbnail_url || undefined}
          controls
          autoPlay
          playsInline
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', backgroundColor: '#000' }}
          onError={() => setVideoError(true)}
        />
      ) : (
        <ReplayNativePlayer
          uri={videoUrl}
          onReady={() => {}}
          onError={() => setVideoError(true)}
        />
      )}

      {/* Floating header — back + title + actions. paddingTop respects the
          notch so the row clears the status bar without nudging the video. */}
      {rec && (
        <View style={[styles.header, { paddingTop: (insets.top || 0) + 6 }]} pointerEvents="box-none">
          <TouchableOpacity onPress={() => router.back()} style={styles.headBtn}
                            accessibilityLabel={t('common.back') || 'Voltar'}>
            <IconArrowLeft size={22} color="#fff" />
          </TouchableOpacity>

          <View style={styles.headTitleWrap} pointerEvents="none">
            <Text style={styles.headTitle} numberOfLines={1}>
              {rec.title || t('live.title') || 'Live'}
            </Text>
            <View style={styles.headSubRow}>
              <AvatarCircle name={rec.host_name} email={rec.host_email} size={16} />
              <Text style={styles.headSub} numberOfLines={1}>
                {rec.host_name || rec.host_email}
              </Text>
            </View>
          </View>

          <View style={styles.headActions}>
            <TouchableOpacity onPress={onShare} style={styles.headBtn}
                              accessibilityLabel={t('liveReplay.shareLink') || 'Share'}>
              <IconShare size={20} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity onPress={onDownload} style={styles.headBtn}
                              accessibilityLabel={t('liveReplay.download') || 'Baixar'}>
              <IconDownload size={20} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity onPress={onDelete} style={styles.headBtn}
                              accessibilityLabel={rec.is_host
                                ? (t('liveReplay.delete') || 'Excluir')
                                : (t('liveReplay.unsave') || 'Remover')}>
              <IconTrash size={20} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  err: { color: '#fff', fontSize: 14, textAlign: 'center', marginBottom: 18 },
  errBack: {
    paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  errBackTxt: { color: '#fff', fontSize: 14, fontWeight: '600' },
  header: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingBottom: 10,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  headBtn: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
    marginHorizontal: 2,
  },
  headTitleWrap: { flex: 1, marginHorizontal: 8 },
  headTitle: { color: '#fff', fontSize: 15, fontWeight: '600' },
  headSubRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  headSub: { color: 'rgba(255,255,255,0.85)', fontSize: 12, marginLeft: 6 },
  headActions: { flexDirection: 'row', alignItems: 'center' },
});
