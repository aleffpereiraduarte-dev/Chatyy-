// [2026-10-20 nota-perfil] Folha da nota do perfil (Instagram Notes).
// Founder (print iPhone Thalisa, app em inglês): "quando eu clicar add a note
// e trocar" — o balão abria o EDITAR PERFIL inteiro (sem campo de nota) e não
// dava p/ trocar nada ali. Agora:
//   • sem nota  → editor rápido: campo (até 60), contador, público, Compartilhar
//   • com nota  → opções: Trocar nota (editor preenchido) · Apagar nota
// Salvar é otimista (services/profileNote): o balão mostra a nota na hora;
// some sozinha em 24 h. Sem emoji (SVG/texto).
import React, { useEffect, useRef, useState } from 'react';
import {
  Modal, View, Text, TextInput, Pressable, Platform, StyleSheet, KeyboardAvoidingView, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import useDragToDismiss, { DragSheetRoot, DragPanel, DragBackdrop } from '../ui/useDragToDismiss';
import { useGroupedColors } from './SettingsKit';
import { NOTE_MAX, setNote, deleteNote } from '../../services/profileNote';

function hoursLeft(note) {
  const exp = Date.parse(note?.expires_at || '');
  if (!exp) return 24;
  return Math.max(1, Math.ceil((exp - Date.now()) / 3600000));
}

export default function ProfileNoteSheet({ visible, note, onClose, t, onError }) {
  const g = useGroupedColors();
  const insets = useSafeAreaInsets();
  const tr = (k, fb) => { try { const v = t?.(k); return v && v !== k ? v : fb; } catch { return fb; } };
  const [mode, setMode] = useState('edit'); // 'menu' | 'edit'
  const [text, setText] = useState('');
  const [aud, setAud] = useState('mutual');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const drag = useDragToDismiss({ visible, onDismiss: () => { if (typeof onClose === 'function') onClose(); } });

  useEffect(() => {
    if (!visible) return;
    setBusy(false);
    setMode(note ? 'menu' : 'edit');
    setText(note?.text || '');
    setAud(note?.audience === 'contacts' ? 'contacts' : 'mutual');
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!visible || mode !== 'edit') return undefined;
    const tm = setTimeout(() => { try { inputRef.current?.focus?.(); } catch {} }, 280);
    return () => clearTimeout(tm);
  }, [visible, mode]);

  if (!visible) return null;

  const clean = text.replace(/\s+/g, ' ').trim();
  const unchanged = !!note && clean === note.text && aud === (note.audience || 'mutual');
  const canShare = !!clean && !busy && !unchanged;

  const share = () => {
    if (!canShare) return;
    // Otimista: fecha já; o balão mostra a nota. Se o servidor recusar, volta a anterior + aviso.
    onClose?.();
    setNote(clean, aud).then((ok) => { if (!ok) onError?.(tr('me.note.saveError', 'Não foi possível compartilhar a nota. Tente de novo.')); });
  };
  const remove = () => {
    onClose?.();
    deleteNote().then((ok) => { if (!ok) onError?.(tr('me.note.deleteError', 'Não foi possível apagar a nota. Tente de novo.')); });
  };

  const AudRow = ({ value, label }) => {
    const on = aud === value;
    return (
      <Pressable
        onPress={() => setAud(value)}
        accessibilityRole="radio"
        accessibilityState={{ selected: on }}
        testID={`profile-note-aud-${value}`}
        style={({ pressed }) => [st.audRow, { opacity: pressed ? 0.6 : 1 }]}
      >
        <Text style={[st.audText, { color: g.text }]} maxFontSizeMultiplier={1.4}>{label}</Text>
        <View style={[st.radio, { borderColor: on ? g.ink : g.tertiary }]}>
          {on ? <View style={[st.radioDot, { backgroundColor: g.ink }]} /> : null}
        </View>
      </Pressable>
    );
  };

  const MenuBtn = ({ label, onPress, danger, testID }) => (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      style={({ pressed }) => [st.menuBtn, { backgroundColor: pressed ? g.fill : 'transparent', borderBottomColor: g.separator }]}
    >
      <Text style={[st.menuText, { color: danger ? g.destructive : g.text }]} maxFontSizeMultiplier={1.4}>{label}</Text>
    </Pressable>
  );

  const body = mode === 'menu' && note ? (
    <View>
      <View style={[st.preview, { backgroundColor: g.fill }]}>
        <Text style={[st.previewText, { color: g.text }]} maxFontSizeMultiplier={1.4}>{note.text}</Text>
      </View>
      <Text style={[st.meta, { color: g.secondary }]} maxFontSizeMultiplier={1.4}>
        {(note.audience === 'contacts' ? tr('me.note.audContacts', 'Contatos') : tr('me.note.audMutual', 'Seguidores que você segue de volta'))
          + '  ·  ' + tr('me.note.hoursLeft', 'Some em {h} h').replace('{h}', String(hoursLeft(note)))}
      </Text>
      <View style={[st.menuCard, { backgroundColor: g.cardBg, borderColor: g.separator }]}>
        <MenuBtn label={tr('me.note.change', 'Trocar nota')} onPress={() => setMode('edit')} testID="profile-note-change" />
        <MenuBtn label={tr('me.note.delete', 'Apagar nota')} onPress={remove} danger testID="profile-note-delete" />
      </View>
      <Pressable onPress={onClose} accessibilityRole="button" style={({ pressed }) => [st.cancel, { opacity: pressed ? 0.6 : 1 }]}>
        <Text style={[st.cancelText, { color: g.secondary }]} maxFontSizeMultiplier={1.4}>{tr('common.cancel', 'Cancelar')}</Text>
      </Pressable>
    </View>
  ) : (
    <View>
      <View style={st.headRow}>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" testID="profile-note-cancel">
          <Text style={[st.headSide, { color: g.text }]} maxFontSizeMultiplier={1.3}>{tr('common.cancel', 'Cancelar')}</Text>
        </Pressable>
        <Text style={[st.title, { color: g.text }]} maxFontSizeMultiplier={1.3}>{note ? tr('me.note.changeTitle', 'Trocar nota') : tr('me.note.newTitle', 'Nova nota')}</Text>
        <Pressable
          onPress={share}
          disabled={!canShare}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canShare }}
          testID="profile-note-share"
          style={[st.sharePill, { backgroundColor: canShare ? g.ink : g.fill }]}
        >
          {busy ? <ActivityIndicator size="small" color={g.onInk} /> : (
            <Text style={[st.shareText, { color: canShare ? g.onInk : g.secondary }]} maxFontSizeMultiplier={1.3}>{tr('me.note.share', 'Compartilhar')}</Text>
          )}
        </Pressable>
      </View>
      <View style={[st.bubble, { backgroundColor: g.fill }]}>
        <TextInput
          ref={inputRef}
          value={text}
          onChangeText={(v) => setText(String(v || '').replace(/\n/g, ' ').slice(0, NOTE_MAX))}
          placeholder={tr('me.note.placeholder', 'Compartilhe um pensamento...')}
          placeholderTextColor={g.secondary}
          maxLength={NOTE_MAX}
          multiline
          blurOnSubmit
          returnKeyType="done"
          onSubmitEditing={share}
          textAlign="center"
          style={[st.input, { color: g.text }]}
          testID="profile-note-input"
          maxFontSizeMultiplier={1.4}
        />
      </View>
      <Text style={[st.counter, { color: text.length >= NOTE_MAX ? g.destructive : g.secondary }]} maxFontSizeMultiplier={1.3}>
        {`${text.length}/${NOTE_MAX}`}
      </Text>
      <Text style={[st.section, { color: g.header }]} maxFontSizeMultiplier={1.3}>{tr('me.note.audience', 'Compartilhar com')}</Text>
      <View style={[st.menuCard, { backgroundColor: g.cardBg, borderColor: g.separator }]}>
        <AudRow value="mutual" label={tr('me.note.audMutual', 'Seguidores que você segue de volta')} />
        <View style={[st.hair, { backgroundColor: g.separator }]} />
        <AudRow value="contacts" label={tr('me.note.audContacts', 'Contatos')} />
      </View>
      <Text style={[st.meta, { color: g.secondary }]} maxFontSizeMultiplier={1.4}>
        {tr('me.note.expires', 'A nota aparece acima da sua foto e some em 24 horas.')}
      </Text>
    </View>
  );

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <DragSheetRoot>
        <Pressable style={st.overlay} onPress={onClose}>
          <DragBackdrop drag={drag} color="rgba(0,0,0,0.45)" />
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ width: '100%' }}>
            <DragPanel
              drag={drag}
              onStartShouldSetResponder={() => true}
              style={[st.sheet, { backgroundColor: g.pageBg, paddingBottom: Math.max(insets.bottom, 12) + 8 }]}
            >
              <View style={[st.handle, { backgroundColor: g.tertiary }]} />
              {body}
            </DragPanel>
          </KeyboardAvoidingView>
        </Pressable>
      </DragSheetRoot>
    </Modal>
  );
}

const st = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  sheet: { paddingHorizontal: 16, paddingTop: 8, borderTopLeftRadius: 18, borderTopRightRadius: 18 },
  handle: { width: 36, height: 5, borderRadius: 3, alignSelf: 'center', marginBottom: 10, opacity: 0.8 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, minHeight: 34 },
  headSide: { fontSize: 16 },
  title: { fontSize: 16, fontWeight: '600', position: 'absolute', left: 90, right: 90, textAlign: 'center' },
  sharePill: { paddingHorizontal: 14, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', minWidth: 64 },
  shareText: { fontSize: 14.5, fontWeight: '600' },
  bubble: { borderRadius: 22, paddingHorizontal: 18, paddingVertical: 12, minHeight: 64, justifyContent: 'center' },
  input: { fontSize: 17, lineHeight: 22, paddingVertical: 0, minHeight: 40, textAlignVertical: 'center' },
  counter: { fontSize: 12.5, textAlign: 'right', marginTop: 6, marginRight: 6 },
  section: { fontSize: 13, marginTop: 10, marginBottom: 6, marginLeft: 4 },
  menuCard: { borderRadius: 12, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  audRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 13 },
  audText: { fontSize: 15.5, flex: 1, paddingRight: 12 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 11, height: 11, borderRadius: 6 },
  hair: { height: StyleSheet.hairlineWidth, marginLeft: 14 },
  meta: { fontSize: 12.5, textAlign: 'center', marginTop: 10, marginBottom: 6, paddingHorizontal: 12 },
  preview: { borderRadius: 22, paddingHorizontal: 18, paddingVertical: 14, alignSelf: 'center', maxWidth: '90%', marginTop: 6 },
  previewText: { fontSize: 17, lineHeight: 22, textAlign: 'center' },
  menuBtn: { paddingVertical: 15, alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  menuText: { fontSize: 16 },
  cancel: { paddingVertical: 14, alignItems: 'center', marginTop: 4 },
  cancelText: { fontSize: 16 },
});
