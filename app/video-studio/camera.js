// [2026-10-13 video-studio] /video-studio/camera — câmera de criação (nível TikTok/Reels).
// Params (todos opcionais):
//   ?draft=<id>                         retoma um rascunho (services/videoStudio/draftStore)
//   ?music_id=&music_url=&music_start=&music_title=   som pré-selecionado (ou draftStore.setPendingMusic)
//   ?sound_id=&sound_url=&sound_title=  compat c/ o deep link "Usar este som" de /reels-sound
// "Próximo" → router.push('/video-studio/editor?draft=<id>') com a EDL v1 já salva no draftStore.
import React, { useCallback, useEffect, useMemo } from 'react';
import { Platform, View, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useLanguage } from '../../context/LanguageContext';
import { takePendingMusic } from '../../services/videoStudio/draftStore';

const Studio = Platform.OS === 'web'
  ? require('../../components/videoStudio/WebCameraStudio').default
  : require('../../components/videoStudio/CameraStudio').default;

const one = (v) => (Array.isArray(v) ? v[0] : v);

export default function VideoStudioCameraScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { t } = useLanguage();

  const draftId = one(params?.draft) ? String(one(params.draft)) : null;
  const initialMusic = useMemo(() => {
    const url = one(params?.music_url) || one(params?.sound_url);
    const id = one(params?.music_id) || one(params?.sound_id);
    if (url || id) {
      return {
        id: id ? String(id) : null,
        url: url ? String(url) : '',
        start: Number(one(params?.music_start)) || 0,
        title: String(one(params?.music_title) || one(params?.sound_title) || ''),
        volume: 0.6,
      };
    }
    return takePendingMusic();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // [2026-10-24] rascunhos passaram do limite de espaço → pergunta (sem apagar sozinho) ao abrir a câmera.
  useEffect(() => {
    const tm = setTimeout(() => { try { require('../../services/videoStudio/draftSpace').confirmDraftSpace({ t, excludeId: draftId }); } catch {} }, 1500);
    return () => clearTimeout(tm);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onNext = useCallback((id) => {
    try { router.push(`/video-studio/editor?draft=${encodeURIComponent(id)}`); } catch {}
  }, [router]);

  const onClose = useCallback(() => {
    try {
      if (router.canGoBack?.()) router.back();
      else router.replace('/chat');
    } catch {}
  }, [router]);

  return (
    <View style={styles.root}>
      <Studio t={t} draftId={draftId} initialMusic={initialMusic} onNext={onNext} onClose={onClose} />
    </View>
  );
}

const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: '#000' } });
