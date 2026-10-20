// [reels-v1 2026-10-13] Aba "Reels" da barra de baixo (founder: "as pessoas gostam de scroll").
// Tela cheia vertical com snap (ReelsViewer): autoplay do visível, pausa ao sair da aba/app,
// pré-carrega os próximos, mudo/som lembrado, curtir (duplo toque), comentar, compartilhar no
// chat, salvar, "não tenho interesse", seguir autor — e o "Para você" vem do ranking do servidor.
// Montado com display:none quando outra aba está ativa → `tabActive` é o que pausa o áudio.
import React, { useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import ReelPublishProgress from './ReelPublishProgress';

const ReelsViewer = React.lazy(() => import('./ReelsViewer'));

// [tabs-v2 2026-10-20] hideHeaderTabs: dentro do Mural o segmento (voltar | Para você | Seguindo | Reels)
// fica por cima do vídeo → o ReelsViewer não desenha as abas próprias dele.
export default function ReelsHomeTab({ colors, isDark, t, user, router, tabActive, hideHeaderTabs = false }) {
  const insets = useSafeAreaInsets();
  const active = tabActive === 'reels';
  const onCreate = useCallback(() => { try { router?.push('/video-studio/camera'); } catch {} }, [router]);
  return (
    <View style={styles.root}>
      {/* [2026-10-13 reels-visual] vídeo começa atrás da status bar → relógio/bateria claros */}
      {active ? <StatusBar style="light" /> : null}
      <React.Suspense fallback={<View style={styles.root} />}>
        <ReelsViewer colors={colors} isDark={isDark} t={t} user={user} router={router}
          parentActive={active} onCreate={onCreate} recommended hideHeaderTabs={hideHeaderTabs} />
      </React.Suspense>
      <ReelPublishProgress email={user?.email} t={t} top={insets.top + 52} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
});
