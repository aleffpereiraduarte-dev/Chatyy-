import { useState, useRef, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet, Platform, KeyboardAvoidingView } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import { IconX, IconSend } from './Icons';

export default function MeetChatPanel({ messages, onSend, onClose, visible }) {
  const { colors } = useTheme();
  const [text, setText] = useState('');
  const listRef = useRef(null);

  useEffect(() => {
    if (messages.length > 0 && listRef.current) {
      setTimeout(() => listRef.current?.scrollToEnd?.({ animated: true }), 100);
    }
  }, [messages.length]);

  if (!visible) return null;

  const handleSend = () => {
    if (!text.trim()) return;
    onSend(text.trim());
    setText('');
  };

  const renderMessage = ({ item }) => {
    const time = new Date(item.timestamp || Date.now());
    return (
      <View style={s.msgContainer}>
        <View style={s.msgHeader}>
          <Text style={[s.sender, { color: '#60a5fa' }]}>{item.displayName || 'User'}</Text>
          <Text style={[s.time, { color: '#64748b' }]}>
            {time.getHours().toString().padStart(2, '0')}:{time.getMinutes().toString().padStart(2, '0')}
          </Text>
        </View>
        <Text style={[s.msgText, { color: '#e2e8f0' }]}>{item.message}</Text>
      </View>
    );
  };

  return (
    <View style={[s.panel, Platform.OS === 'web' && s.panelGlass]}>
      {/* Header */}
      <View style={s.header}>
        <Text style={s.headerTitle}>Chat</Text>
        <TouchableOpacity onPress={onClose} style={s.closeBtn}>
          <IconX size={18} color="#94a3b8" />
        </TouchableOpacity>
      </View>

      {/* Messages */}
      <FlatList
        ref={listRef}
        data={messages}
        renderItem={renderMessage}
        keyExtractor={(_, i) => String(i)}
        style={s.messageList}
        contentContainerStyle={s.messageListContent}
      />

      {/* Input */}
      <View style={s.inputArea}>
        <TextInput
          style={s.input}
          value={text}
          onChangeText={setText}
          placeholder="Digite uma mensagem..."
          placeholderTextColor="#64748b"
          onSubmitEditing={handleSend}
          returnKeyType="send"
        />
        <TouchableOpacity onPress={handleSend} style={s.sendBtn} activeOpacity={0.7}>
          <IconSend size={16} color="#fff" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  panel: {
    position: 'absolute', top: 0, right: 0, bottom: 0, width: 320,
    backgroundColor: 'rgba(17, 24, 39, 0.95)',
    borderLeftWidth: 1, borderLeftColor: 'rgba(255,255,255,0.1)',
    zIndex: 150,
  },
  panelGlass: Platform.OS === 'web' ? {
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  } : {},
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  headerTitle: { color: '#fff', fontSize: FontSize.lg, fontWeight: '600' },
  closeBtn: { padding: 4 },
  messageList: { flex: 1 },
  messageListContent: { padding: 12 },
  msgContainer: { marginBottom: 14 },
  msgHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  sender: { fontSize: 12, fontWeight: '600' },
  time: { fontSize: 11 },
  msgText: { fontSize: 14, lineHeight: 20 },
  inputArea: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 12, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.1)',
  },
  input: {
    flex: 1, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: 'rgba(255,255,255,0.05)', color: '#fff', fontSize: 14,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  sendBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#3b82f6',
    alignItems: 'center', justifyContent: 'center',
  },
});
