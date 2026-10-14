// [paridade-wa 2026-10-14] Prompt de nome p/ listas personalizadas da home de chats.
// Android não tem Alert.prompt → antes a lista nascia "Lista N" e não dava p/ renomear.
// Uso: <ListNamePromptModal prompt={{ title, initial, resolve }} onDone={() => setPrompt(null)} />
import React, { useEffect, useState } from 'react';
import { Modal, View, Text, TextInput, Pressable, Platform, KeyboardAvoidingView, StyleSheet } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';

export default function ListNamePromptModal({ prompt, onDone }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [value, setValue] = useState('');
  useEffect(() => { setValue(prompt?.initial || ''); }, [prompt]);
  if (!prompt) return null;
  const finish = (v) => {
    try { prompt.resolve?.(v); } catch {}
    onDone?.();
  };
  const fg = colors?.text || (isDark ? '#fff' : '#111');
  const sub = colors?.textSecondary || (isDark ? 'rgba(235,235,245,0.6)' : '#6b7280');
  const card = colors?.surface || (isDark ? '#1c1c1e' : '#fff');
  const border = colors?.border || (isDark ? '#3a3a3c' : '#e5e7eb');
  const accent = colors?.primary || (isDark ? '#fff' : '#111');
  const trimmed = String(value || '').trim();
  return (
    <Modal transparent animationType="fade" visible onRequestClose={() => finish(null)}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={st.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => finish(null)} accessibilityRole="button" accessibilityLabel={t('common.cancel') || 'Cancelar'} />
        <View style={[st.card, { backgroundColor: card }]}>
          <Text style={[st.title, { color: fg }]} accessibilityRole="header">{prompt.title || (t('chat.newListName') || 'Nome da lista')}</Text>
          <TextInput
            value={value}
            onChangeText={setValue}
            autoFocus
            maxLength={40}
            placeholder={t('chat.newListName') || 'Nome da lista'}
            placeholderTextColor={sub}
            onSubmitEditing={() => { if (trimmed) finish(trimmed); }}
            returnKeyType="done"
            style={[st.input, { color: fg, borderColor: border }]}
            accessibilityLabel={t('chat.newListName') || 'Nome da lista'}
          />
          <View style={st.row}>
            <Pressable onPress={() => finish(null)} style={st.btn} accessibilityRole="button">
              <Text style={[st.btnTxt, { color: sub }]}>{t('common.cancel') || 'Cancelar'}</Text>
            </Pressable>
            <Pressable onPress={() => { if (trimmed) finish(trimmed); }} disabled={!trimmed} style={st.btn} accessibilityRole="button" accessibilityState={{ disabled: !trimmed }}>
              <Text style={[st.btnTxt, { color: accent, opacity: trimmed ? 1 : 0.4, fontWeight: '600' }]}>{t('common.save') || 'Salvar'}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const st = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  card: { width: '100%', maxWidth: 360, borderRadius: 16, padding: 20 },
  title: { fontSize: 17, fontWeight: '600', marginBottom: 14 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: Platform.OS === 'ios' ? 12 : 8, fontSize: 16 },
  row: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 16, gap: 8 },
  btn: { paddingHorizontal: 14, paddingVertical: 10, minHeight: 44, justifyContent: 'center' },
  btnTxt: { fontSize: 16 },
});
