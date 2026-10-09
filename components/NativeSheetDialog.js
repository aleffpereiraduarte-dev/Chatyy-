// [2026-10-09 native-sheets] Troca drop-in p/ o padrão repetido
//   <Modal transparent> <Pressable backdrop onPress=close> <Pressable panel stopPropagation> ...
// iOS/Android: sheet do SISTEMA (components/NativeSheet → rota /native-sheet:
// detents, grabber, arrastar p/ fechar, fundo escurecido nativo). O painel perde
// width/borderRadius/position (o sistema desenha) e ganha padding inferior seguro.
// Web (ou kill-switch): renderiza EXATAMENTE o Modal + backdrop + painel antigos.
import React from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { USE_NATIVE_SHEETS, NativeSheet, nativeSheetBottomPad } from './NativeSheet';

const DEFAULT_OVERLAY = { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' };

// Props de estilo que só fazem sentido p/ o painel "flutuante" JS.
const DROP = ['width', 'maxWidth', 'minWidth', 'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius',
  'position', 'bottom', 'top', 'left', 'right', 'maxHeight', 'shadowColor', 'shadowOffset', 'shadowOpacity',
  'shadowRadius', 'elevation', 'boxShadow', 'alignSelf', 'margin', 'marginHorizontal', 'marginBottom'];

export default function NativeSheetDialog({
  visible,
  onClose,
  children,
  panelStyle,
  overlayStyle = DEFAULT_OVERLAY,
  animationType = 'fade',
  detents = 'fitToContents',
  nativePanelStyle,
  stopPropagation = true,
}) {
  const insets = useSafeAreaInsets();
  if (USE_NATIVE_SHEETS) {
    const flat = StyleSheet.flatten(panelStyle) || {};
    const native = {};
    Object.keys(flat).forEach((k) => { if (!DROP.includes(k)) native[k] = flat[k]; });
    const basePad = typeof flat.paddingBottom === 'number' ? flat.paddingBottom
      : (typeof flat.paddingVertical === 'number' ? flat.paddingVertical
        : (typeof flat.padding === 'number' ? flat.padding : 16));
    native.paddingBottom = nativeSheetBottomPad(insets, basePad);
    if (typeof native.paddingTop !== 'number' && typeof native.paddingVertical !== 'number') {
      native.paddingTop = Math.max(typeof flat.padding === 'number' ? flat.padding : 0, 22); // espaço p/ o grabber do sistema
    }
    return (
      <NativeSheet visible={!!visible} onClose={onClose} detents={detents} backgroundColor={flat.backgroundColor}>
        <View style={[native, nativePanelStyle]}>{children}</View>
      </NativeSheet>
    );
  }
  return (
    <Modal visible={!!visible} transparent animationType={animationType} onRequestClose={onClose}>
      <Pressable style={overlayStyle} onPress={onClose}>
        <Pressable style={panelStyle} onPress={stopPropagation ? (e) => { try { e.stopPropagation(); } catch {} } : () => {}}>
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
