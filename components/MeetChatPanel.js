// [2026-10-15 meet-v2] Conversa da reunião: tela cheia no celular (antes ocupava 40% = ~150 px),
// painel lateral no web largo. P&B, bolhas, safe-area e teclado.
import { useState, useRef, useEffect } from 'react';
import { View, Text, TextInput, Pressable, FlatList, StyleSheet, Platform, KeyboardAvoidingView, useWindowDimensions } from 'react-native';
import { useLanguage } from '../context/LanguageContext';
import { IconX, IconSend } from './Icons';

export default function MeetChatPanel({ messages, onSend, onClose, visible, insets }) {
  const { t } = useLanguage();
  const { width } = useWindowDimensions();
  const [text, setText] = useState('');
  const listRef = useRef(null);
  const wide = width >= 760;

  useEffect(() => {
    if (visible && messages.length > 0 && listRef.current) {
      setTimeout(() => listRef.current?.scrollToEnd?.({ animated: true }), 80);
    }
  }, [messages.length, visible]);

  if (!visible) return null;

  const handleSend = () => {
    if (!text.trim()) return;
    onSend(text.trim());
    setText('');
  };

  const renderMessage = ({ item }) => {
    const time = new Date(item.timestamp || Date.now());
    const mine = !!item.isLocal;
    return (
      <View style={[s.msg, mine && s.msgMine]}>
        {!mine ? <Text style={s.sender} numberOfLines={1}>{item.displayName || t('menu.user')}</Text> : null}
        <View style={[s.bubble, mine ? s.bubbleMine : s.bubbleOther]}>
          <Text style={[s.msgText, mine && { color: '#000' }]}>{item.message}</Text>
        </View>
        <Text style={s.time}>
          {time.getHours().toString().padStart(2, '0')}:{time.getMinutes().toString().padStart(2, '0')}
        </Text>
      </View>
    );
  };

  return (
    <View style={[s.panel, wide ? s.panelWide : s.panelFull, { paddingTop: wide ? 0 : (insets?.top || 0) }]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.header}>
          <Text style={s.headerTitle}>{t('meet.chat')}</Text>
          <Pressable onPress={onClose} style={s.closeBtn} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.close')}>
            <IconX size={18} color="#fff" />
          </Pressable>
        </View>
        <FlatList
          ref={listRef}
          data={messages}
          renderItem={renderMessage}
          keyExtractor={(m, i) => m.id || String(i)}
          style={s.messageList}
          contentContainerStyle={s.messageListContent}
          keyboardShouldPersistTaps="handled"
        />
        <View style={[s.inputArea, { paddingBottom: Math.max(insets?.bottom || 0, 10) }]}>
          <TextInput
            style={s.input}
            value={text}
            onChangeText={setText}
            placeholder={t('chatConv.messagePlaceholder')}
            placeholderTextColor="rgba(255,255,255,0.4)"
            onSubmitEditing={handleSend}
            returnKeyType="send"
            accessibilityLabel={t('chatConv.messagePlaceholder')}
          />
          <Pressable onPress={handleSend} disabled={!text.trim()} style={({ pressed }) => [s.sendBtn, !text.trim() && { opacity: 0.4 }, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel={t('common.send')}>
            <IconSend size={16} color="#000" />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const s = StyleSheet.create({
  panel: { position: 'absolute', top: 0, right: 0, bottom: 0, backgroundColor: '#0b0b0b', zIndex: 250 },
  panelFull: { left: 0 },
  panelWide: {
    width: 360, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: 'rgba(255,255,255,0.12)',
    ...Platform.select({ web: { backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)', backgroundColor: 'rgba(11,11,11,0.94)' }, default: {} }),
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)',
  },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
  closeBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' },
  messageList: { flex: 1 },
  messageListContent: { padding: 14, paddingBottom: 8 },
  msg: { marginBottom: 10, alignItems: 'flex-start', maxWidth: '86%' },
  msgMine: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  sender: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '600', marginBottom: 3, marginLeft: 4 },
  bubble: { borderRadius: 18, paddingHorizontal: 13, paddingVertical: 8 },
  bubbleOther: { backgroundColor: '#1f1f1f', borderTopLeftRadius: 6 },
  bubbleMine: { backgroundColor: '#fff', borderTopRightRadius: 6 },
  time: { color: 'rgba(255,255,255,0.35)', fontSize: 10.5, marginTop: 3, marginHorizontal: 4 },
  msgText: { color: '#fff', fontSize: 15, lineHeight: 20 },
  inputArea: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.12)',
  },
  input: {
    flex: 1, borderRadius: 20, paddingHorizontal: 14, paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    backgroundColor: '#1a1a1a', color: '#fff', fontSize: 15,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  sendBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
});
