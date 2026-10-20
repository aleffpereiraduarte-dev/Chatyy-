// components/games/GamePlaySheet.js — [jogos 2026-10-19 inline] a partida numa FOLHA por cima da conversa.
// iOS: UISheetPresentationController (detent grande + grabber do sistema) · Android: BottomSheet do
// react-native-screens — os dois via components/NativeSheet (rota-ponte /native-sheet; a tela da conversa
// continua montada embaixo → fechar volta exatamente para a mesma posição da rolagem).
// Web / kill __chatyy_native_sheets === false: folha deslizante (Modal RN) com 92% da altura.
//
// Uso (tela da conversa, 1× por tela): <GamePlaySheetHost conversationId={cid} />
// Abrir: services/gamesInline.openGameInChat(gid, cid, router) — o host se registra lá.
// Rematch / "ver revanche" dentro da folha troca o jogo no lugar (sem fechar/reabrir).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { USE_NATIVE_SHEETS, NativeSheet, nativeSheetsOpenCount, runAfterNativeSheet } from '../NativeSheet';
import { useTheme } from '../../context/ThemeContext';
import { registerGameSheetHost, gamesDockOn } from '../../services/gamesInline';
import { gamePalette } from './fx';
import GamePlay from './GamePlay';

export function GamePlaySheetHost({ conversationId }) {
  const { colors, isDark } = useTheme();
  const pal = gamePalette(colors || {}, !!isDark);
  const [gid, setGid] = useState(0);
  const cidRef = useRef(conversationId);
  cidRef.current = conversationId;
  const { height } = useWindowDimensions();
  const ins = useSafeAreaInsets();

  // [jogos 2026-10-20 dock] painel embutido ativo (components/games/GameDock) → esta folha fica só de reserva
  useEffect(() => (gamesDockOn() ? undefined : registerGameSheetHost((id, cid) => {
    if (cid && cidRef.current && String(cid) !== String(cidRef.current)) return false; // jogo de outra conversa → rota
    // já há outra folha nativa aberta/descendo (seletor de jogos, menu) → espera ela sair: nunca folha sobre folha
    if (USE_NATIVE_SHEETS && nativeSheetsOpenCount() > 0) { runAfterNativeSheet(() => setGid(Number(id) || 0)); return true; }
    setGid(Number(id) || 0);
    return true;
  })), []);
  const close = useCallback(() => setGid(0), []);
  const swap = useCallback((id) => setGid(Number(id) || 0), []);

  if (!gid) return null;
  const body = <GamePlay key={gid} gid={gid} cid={conversationId} embedded onClose={close} onOpenGame={swap} />;
  if (USE_NATIVE_SHEETS) {
    return (
      <NativeSheet visible onClose={close} detents={[1]} backgroundColor={pal.bg} expandsOnScroll={false}>
        <View style={{ flex: 1, backgroundColor: pal.bg }}>{body}</View>
      </NativeSheet>
    );
  }
  return (
    <Modal visible transparent animationType="slide" onRequestClose={close} statusBarTranslucent>
      <Pressable style={st.backdrop} onPress={close} accessibilityRole="button" accessibilityLabel="close" />
      <View style={[st.sheet, { backgroundColor: pal.bg, height: Math.round(height * 0.92) - Math.min(ins.top, 20), paddingBottom: Math.max(ins.bottom, 8) }]}>
        <View style={st.grab} />
        <View style={{ flex: 1 }}>{body}</View>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.42)' },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingTop: 8, width: '100%', maxWidth: 720, alignSelf: 'center', overflow: 'hidden' },
  grab: { alignSelf: 'center', width: 38, height: 5, borderRadius: 3, backgroundColor: 'rgba(127,127,127,0.4)', marginBottom: 2 },
});

export default GamePlaySheetHost;
