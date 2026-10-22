// components/chat/GroupInfoEditor.js — [2026-10-18 chat-info-native]
//
// Tela de edição do NOME ou da DESCRIÇÃO do grupo (WhatsApp: "Descrição do
// grupo" com contador e Salvar). Abre por cima de "Dados do grupo" (nativa
// ou JS). `onSave(value)` → Promise<boolean> (true fecha).
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import KeyboardSafeView from '../ui/KeyboardSafeView'; // [2026-10-22 kb-uniforme]
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';

export default function GroupInfoEditor({ visible, mode = 'description', initial = '', onClose, onSave, t }) {
  const { colors, isDark } = useTheme() || {};
  const insets = useSafeAreaInsets();
  const [value, setValue] = useState(String(initial || ''));
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);
  const isName = mode === 'name';
  const max = isName ? 60 : 500;
  const tr = (k, fb) => { try { const v = t ? t(k) : ''; return v && v !== k ? v : fb; } catch { return fb; } };

  useEffect(() => {
    if (visible) {
      setValue(String(initial || ''));
      setSaving(false);
      const id = setTimeout(() => { try { inputRef.current?.focus(); } catch {} }, 350);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [visible, initial]);

  const trimmed = value.trim();
  const dirty = trimmed !== String(initial || '').trim();
  const canSave = !saving && dirty && (!isName || trimmed.length > 0);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    let ok = false;
    try { ok = !!(await onSave?.(trimmed)); } catch { ok = false; }
    setSaving(false);
    if (ok) onClose?.();
  };

  // [2026-10-21 polish-conv] Grafite: fundo/cartão/subtítulo do tema (eram cinzas iOS fixos).
  const _v2 = !!colors?.themeV2;
  const bg = _v2 ? colors.background : (isDark ? (colors?.background || '#000000') : '#F3F3F6');
  const card = _v2 ? colors.surface : (isDark ? '#1C1C1E' : '#FFFFFF');
  const text = colors?.text || (isDark ? '#F5F5F7' : '#111111');
  const sub = _v2 ? colors.textSecondary : (isDark ? '#8E8E93' : '#8A8A8E');
  const sep = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(60,60,67,0.16)';

  return (
    <Modal visible={!!visible} animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined} onRequestClose={onClose} transparent={false}>
      <View style={[styles.root, { backgroundColor: bg, paddingTop: Platform.OS === 'ios' ? 0 : insets.top }]}>
        <View style={[styles.bar, { borderBottomColor: sep }]}>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" style={styles.barBtn}>
            <Text style={[styles.barTxt, { color: text }]}>{tr('common.cancel', 'Cancelar')}</Text>
          </Pressable>
          <Text style={[styles.title, { color: text }]} numberOfLines={1}>
            {isName ? tr('chatInfo.editNameTitle', 'Nome do grupo') : tr('chatInfo.editDescTitle', 'Descrição do grupo')}
          </Text>
          <Pressable onPress={save} disabled={!canSave} hitSlop={10} accessibilityRole="button" accessibilityState={{ disabled: !canSave }} style={[styles.barBtn, { alignItems: 'flex-end' }]}>
            {saving ? <ActivityIndicator size="small" color={text} /> : (
              <Text style={[styles.barTxt, { color: canSave ? text : sub, fontWeight: '600' }]}>{tr('common.save', 'Salvar')}</Text>
            )}
          </Pressable>
        </View>
        <KeyboardSafeView style={{ flex: 1 }}>
          <View style={[styles.card, { backgroundColor: card }]}>
            <TextInput
              ref={inputRef}
              value={value}
              onChangeText={(v) => setValue(v.slice(0, max))}
              placeholder={isName ? tr('chatConv.groupName', 'Nome do grupo') : tr('chatInfo.descPlaceholder', 'Adicionar descrição do grupo')}
              placeholderTextColor={sub}
              multiline={!isName}
              maxLength={max}
              style={[styles.input, { color: text, minHeight: isName ? 44 : 120 }]}
              returnKeyType={isName ? 'done' : 'default'}
              onSubmitEditing={isName ? save : undefined}
              keyboardAppearance={isDark ? 'dark' : 'light'}
              textAlignVertical={isName ? 'center' : 'top'}
            />
            <Text style={[styles.counter, { color: sub }]}>{`${value.length}/${max}`}</Text>
          </View>
          {!isName && (
            <Text style={[styles.hint, { color: sub }]}>
              {tr('chatInfo.descHint', 'A descrição fica visível para todos os membros e para quem abrir o link de convite.')}
            </Text>
          )}
        </KeyboardSafeView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  bar: { height: 54, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  barBtn: { minWidth: 72, height: 44, justifyContent: 'center' },
  barTxt: { fontSize: 17 },
  title: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600' },
  card: { marginHorizontal: 16, marginTop: 20, borderRadius: 20, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8 },
  input: { fontSize: 17, paddingVertical: 6 },
  counter: { alignSelf: 'flex-end', fontSize: 12, marginTop: 4 },
  hint: { marginHorizontal: 32, marginTop: 8, fontSize: 13, lineHeight: 18 },
});
