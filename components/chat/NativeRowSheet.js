// components/chat/NativeRowSheet.js — [2026-10-16 native-cover]
//
// Folha que mostra a versão JS de UMA linha da conversa quando a lista nativa
// (ChatyyMessageList) desenhou só o cartão-resumo dela (fallback por LINHA:
// tipo raro/complexo — correio de voz, figurinha animada, texto muito longo,
// JSON desconhecido, mídia sem URL…). O resto da conversa segue nativo.
//
// O chamador passa o render da linha como children (MemoizedMessageRow do
// chat-conversation → MESMO visual/ações do caminho JS).
import React from 'react';
import { Modal, View, Text, Pressable, ScrollView, StyleSheet, Platform, Dimensions } from 'react-native';
import { IconX } from '../Icons';

import { a11yLabel } from '../../utils/a11yLabel'; // [2026-10-20 a11y] rótulos dos botões só-ícone
let _GHRoot = null;
function _ghRoot() {
  if (_GHRoot) return _GHRoot;
  try { _GHRoot = require('react-native-gesture-handler').GestureHandlerRootView || null; } catch { _GHRoot = null; }
  if (!_GHRoot) _GHRoot = ({ children, style }) => <View style={style}>{children}</View>;
  return _GHRoot;
}

export default function NativeRowSheet({ visible, onClose, title, isDark, wallBg, bottomInset = 0, children }) {
  if (!visible) return null;
  const Root = _ghRoot();
  const bg = wallBg || (isDark ? '#000000' : '#FFFFFF');
  const ink = isDark ? '#F5F5F7' : '#111111';
  const sub = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)';
  const maxH = Math.round((Dimensions.get('window').height || 700) * 0.82);
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Root style={s.fill}>
        <Pressable style={[s.fill, s.dim]} onPress={onClose} accessibilityRole="button" accessibilityLabel={title || ''} />
        <View style={[s.panel, { backgroundColor: bg, maxHeight: maxH, paddingBottom: Math.max(12, bottomInset) }]}>
          <View style={s.grabWrap}><View style={[s.grab, { backgroundColor: sub }]} /></View>
          <View style={s.head}>
            <Text style={[s.title, { color: ink }]} numberOfLines={1}>{title || ''}</Text>
            <Pressable accessibilityLabel={a11yLabel('common.close', 'Fechar')} onPress={onClose} hitSlop={12} style={[s.close, { backgroundColor: sub }]} accessibilityRole="button">
              <IconX size={16} color={ink} />
            </Pressable>
          </View>
          <ScrollView style={s.scroll} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </View>
      </Root>
    </Modal>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  dim: { backgroundColor: 'rgba(0,0,0,0.45)' },
  panel: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    borderTopLeftRadius: 16, borderTopRightRadius: 16, overflow: 'hidden',
    ...Platform.select({ ios: { shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 12, shadowOffset: { width: 0, height: -2 } }, android: { elevation: 12 }, default: {} }),
  },
  grabWrap: { alignItems: 'center', paddingTop: 8 },
  grab: { width: 36, height: 5, borderRadius: 3 },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 6, paddingBottom: 8 },
  title: { flex: 1, fontSize: 16, fontWeight: '700' },
  close: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  scroll: { flexGrow: 0 },
  content: { paddingBottom: 8 },
});
