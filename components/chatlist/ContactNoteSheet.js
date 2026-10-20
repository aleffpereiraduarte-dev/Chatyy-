// [2026-10-20 nota2] Folha da NOTA de um contato (Instagram Notes): toque no
// balão do carrossel da lista de conversas (ou na nota do perfil /u).
//   avatar · nome · há quanto tempo · a nota no balão
//   campo "Responder a {nome}..." → vira mensagem na conversa direta citando a
//   nota ("Respondeu à sua nota: “...”" + resposta). "Abrir conversa" embaixo.
// O toque na bolinha do carrossel continua o de antes (status/conversa).
import React, { useEffect, useState } from 'react';
import { Modal, View, Text, TextInput, Pressable, Platform, StyleSheet, KeyboardAvoidingView, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import useDragToDismiss, { DragSheetRoot, DragPanel, DragBackdrop } from '../ui/useDragToDismiss';
import AvatarCircle from '../AvatarCircle';
import { tc } from './HomeCarousel';

function _ago(t, iso) {
  const ms = Date.now() - (Date.parse(iso || '') || Date.now());
  const h = Math.floor(ms / 3600000);
  if (h < 1) {
    const m = Math.max(1, Math.floor(ms / 60000));
    return tc(t, 'notes.minutesAgo', 'há {n} min').replace('{n}', String(m));
  }
  return tc(t, 'notes.hoursAgo', 'há {n} h').replace('{n}', String(h));
}

async function _convFor(note) {
  if (note && note.conversation_id) return note.conversation_id;
  const api = require('../../services/api'); // eslint-disable-line global-require
  const r = await api.chatCreate([note.email], '', 'direct');
  return r?.data?.conversation_id || r?.data?.id || null;
}

export default function ContactNoteSheet({ visible, note, onClose, t, isDark, router }) {
  const insets = useSafeAreaInsets();
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const drag = useDragToDismiss({ visible, onDismiss: () => { if (typeof onClose === 'function') onClose(); } });
  useEffect(() => { if (visible) { setReply(''); setBusy(false); setSent(false); } }, [visible, note?.email]);
  if (!visible || !note) return null;

  const name = String(note.name || '').trim() || String(note.email || '').split('@')[0];
  const first = name.split(/\s+/)[0] || name;
  const bg = isDark ? '#1C1C1E' : '#FFFFFF';
  const ink = isDark ? '#F5F5F7' : '#111111';
  const sub = isDark ? '#8E8E93' : '#8A8A8E';
  const fill = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(118,118,128,0.12)';
  const bubbleBg = isDark ? '#2C2C2E' : '#F2F2F7';
  const canSend = !!reply.trim() && !busy;

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    try {
      const cid = await _convFor(note);
      if (!cid) throw new Error('no_conv');
      const prefix = tc(t, 'notes.replyPrefix', 'Respondeu à sua nota');
      const content = `${prefix}: “${note.content}”\n${reply.trim()}`;
      const api = require('../../services/api'); // eslint-disable-line global-require
      const r = await api.chatSend(cid, content, 'text');
      if (r && r.success === false && !r._deferred && !r.queued) throw new Error('send_failed');
      setSent(true);
      setReply('');
      setTimeout(() => { try { onClose?.(); } catch {} }, 700);
    } catch {
      try { require('react-native').Alert.alert(tc(t, 'notes.replyError', 'Não foi possível enviar. Tente de novo.')); } catch {} // eslint-disable-line global-require
    } finally { setBusy(false); }
  };

  const openChat = async () => {
    try {
      const cid = await _convFor(note);
      onClose?.();
      if (!cid) return;
      require('../../services/openConversation').openConversation( // eslint-disable-line global-require
        `/chat-conversation?id=${cid}&name=${encodeURIComponent(name)}&type=direct&email=${encodeURIComponent(note.email)}`, { router });
    } catch {}
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <DragSheetRoot>
        <Pressable style={st.overlay} onPress={onClose}>
          <DragBackdrop drag={drag} color="rgba(0,0,0,0.45)" />
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ width: '100%' }}>
            <DragPanel drag={drag} onStartShouldSetResponder={() => true}
              style={[st.sheet, { backgroundColor: bg, paddingBottom: Math.max(insets.bottom, 12) + 8 }]}>
              <View style={[st.handle, { backgroundColor: sub }]} />
              <View style={st.center}>
                <View style={[st.bubble, { backgroundColor: bubbleBg }]}>
                  <Text style={[st.bubbleText, { color: ink }]} maxFontSizeMultiplier={1.4} testID="contact-note-text">{note.content}</Text>
                </View>
                <View style={[st.tail1, { backgroundColor: bubbleBg }]} />
                <View style={[st.tail2, { backgroundColor: bubbleBg }]} />
                <AvatarCircle name={name} email={note.email} size={64} />
                <Text style={[st.name, { color: ink }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>{name}</Text>
                <Text style={[st.time, { color: sub }]} maxFontSizeMultiplier={1.3}>{_ago(t, note.created_at)}</Text>
              </View>
              {sent ? (
                <Text style={[st.sent, { color: sub }]} maxFontSizeMultiplier={1.3}>{tc(t, 'notes.replySent', 'Resposta enviada')}</Text>
              ) : (
                <View style={[st.replyRow, { backgroundColor: fill }]}>
                  <TextInput
                    value={reply}
                    onChangeText={setReply}
                    placeholder={tc(t, 'notes.replyTo', 'Responder a {name}...').replace('{name}', first)}
                    placeholderTextColor={sub}
                    style={[st.input, { color: ink }]}
                    maxLength={1000}
                    returnKeyType="send"
                    onSubmitEditing={send}
                    editable={!busy}
                    testID="contact-note-reply"
                    maxFontSizeMultiplier={1.4}
                  />
                  <Pressable onPress={send} disabled={!canSend} hitSlop={8} accessibilityRole="button" testID="contact-note-send"
                    style={[st.sendBtn, { backgroundColor: canSend ? ink : 'transparent' }]}>
                    {busy ? <ActivityIndicator size="small" color={bg} /> : (
                      <Text style={[st.sendText, { color: canSend ? bg : sub }]} maxFontSizeMultiplier={1.3}>{tc(t, 'common.send', 'Enviar')}</Text>
                    )}
                  </Pressable>
                </View>
              )}
              <Pressable onPress={openChat} accessibilityRole="button" style={({ pressed }) => [st.open, { opacity: pressed ? 0.6 : 1 }]} testID="contact-note-open-chat">
                <Text style={[st.openText, { color: ink }]} maxFontSizeMultiplier={1.3}>{tc(t, 'homeCarousel.openChat', 'Abrir conversa')}</Text>
              </Pressable>
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
  handle: { width: 36, height: 5, borderRadius: 3, alignSelf: 'center', marginBottom: 14, opacity: 0.5 },
  center: { alignItems: 'center' },
  bubble: { borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, maxWidth: '86%' },
  bubbleText: { fontSize: 16, lineHeight: 21, textAlign: 'center' },
  tail1: { width: 10, height: 10, borderRadius: 5, marginTop: 3, marginLeft: -18 },
  tail2: { width: 5, height: 5, borderRadius: 3, marginTop: 2, marginBottom: 6, marginLeft: -26 },
  name: { fontSize: 16, fontWeight: '600', marginTop: 8, maxWidth: '80%' },
  time: { fontSize: 13, marginTop: 2 },
  replyRow: { flexDirection: 'row', alignItems: 'center', borderRadius: 22, paddingLeft: 14, paddingRight: 5, marginTop: 16, minHeight: 44 },
  input: { flex: 1, fontSize: 15.5, paddingVertical: 10 },
  sendBtn: { paddingHorizontal: 14, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', minWidth: 64 },
  sendText: { fontSize: 14.5, fontWeight: '600' },
  sent: { textAlign: 'center', fontSize: 14, marginTop: 18, marginBottom: 6 },
  open: { alignItems: 'center', paddingVertical: 14, marginTop: 4 },
  openText: { fontSize: 15.5, fontWeight: '500' },
});
