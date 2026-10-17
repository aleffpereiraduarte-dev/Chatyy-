// components/native/nativeHeaderTouchGuard.js — [2026-10-17 settings-scroll-tap]
//
// Header/rodapé RN montados DENTRO de uma lista nativa (UICollectionView /
// RecyclerView: Configurações, conversas, carteira, contatos, status,
// chamadas, canais, comunidades, feed). Numa ScrollView RN o JS rouba o
// responder no 1º evento de scroll e o Pressable sob o dedo é cancelado; a
// lista nativa NÃO manda scroll pro sistema de responder e o
// RCTSurfaceTouchHandler (Fabric) não é cancelado por pans de scroll views
// descendentes → o Pressable seguia ativo e disparava onPress ao soltar
// (rolar as Configurações abria "Aparelhos conectados").
//
// Fix JS (OTA): o slot vira "dono" do toque assim que o dedo anda na
// vertical > SLOP (mesmo papel do scrollResponder): onMoveShouldSetResponder-
// Capture=true → o Pressable recebe onResponderTerminate (sem onPress).
// Toque parado (tap) não muda nada. ScrollViews horizontais dentro do header
// recusam a transferência quando já estão rolando (não são afetadas).
// Fix nativo (build): scrollViewWillBeginDragging desliga/religa o touch
// handler (ChatyySettingsListView.swift).
import { useMemo } from 'react';

const SLOP_Y = 10;

export function createNativeHeaderTouchGuard() {
  let sx = 0;
  let sy = 0;
  let armed = false;
  const record = (e) => {
    const n = e?.nativeEvent;
    if (!n) return;
    const touches = n.touches;
    armed = !touches || touches.length <= 1;
    sx = Number(n.pageX) || 0;
    sy = Number(n.pageY) || 0;
  };
  return {
    onStartShouldSetResponderCapture: (e) => { record(e); return false; },
    onTouchStart: (e) => {
      // Fallback: alguns caminhos só entregam o touch cru.
      if (!armed) record(e);
    },
    onMoveShouldSetResponderCapture: (e) => {
      if (!armed) return false;
      const n = e?.nativeEvent;
      if (!n) return false;
      const dy = Math.abs((Number(n.pageY) || 0) - sy);
      const dx = Math.abs((Number(n.pageX) || 0) - sx);
      return dy > SLOP_Y && dy >= dx;
    },
    onResponderGrant: () => {},
    onResponderTerminationRequest: () => true,
    onResponderRelease: () => { armed = false; },
    onResponderTerminate: () => { armed = false; },
    onTouchEnd: () => { armed = false; },
    onTouchCancel: () => { armed = false; },
  };
}

export function useNativeHeaderTouchGuard() {
  return useMemo(() => createNativeHeaderTouchGuard(), []);
}
