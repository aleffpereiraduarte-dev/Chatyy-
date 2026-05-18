// DeclineWithMessageSheet.js (2026-05-17)
//
// Post-decline quick-reply bottom sheet — surfaces ONLY on iOS, because
// CallKit doesn't allow injecting custom buttons into the system incoming
// call UI. Android's equivalent lives inline in IncomingCallActivity.kt
// where we control the entire incoming surface.
//
// Flow:
//   1. User taps the system red Decline in CallKit.
//   2. IncomingCallListener catches CXProvider.didEndCallAction with
//      reason='declined' and stashes pendingDeclineWithMessage = {
//        callId, toEmail, conversationId, ts
//      } on globalThis.__chatyyPendingDeclineWithMessage.
//   3. This component polls the global every 800ms; when it sees a fresh
//      entry (< 6s old) it shows the sheet.
//   4. Tapping a preset OR custom text triggers chatCallDeclineWithMessage
//      which inserts the message into the DM + emits standard call_end
//      (already sent at decline time, so this is just the chat insert).
//   5. Sheet auto-dismisses after send or 6s of inactivity.

import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, Pressable, Platform, StyleSheet, KeyboardAvoidingView } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';

// Window during which we still show the sheet — if the user dismissed CallKit
// over 6s ago they probably moved on and surfacing the sheet would be jarring.
const SHEET_WINDOW_MS = 6000;

export default function DeclineWithMessageSheet() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(null);
  const [customText, setCustomText] = useState('');
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);
  const lastSeenIdRef = useRef('');

  // Only relevant on iOS. The Android IncomingCallActivity handles it
  // natively before the JS bridge wakes up, so this sheet never opens there.
  if (Platform.OS !== 'ios') return null;

  useEffect(() => {
    pollRef.current = setInterval(() => {
      try {
        const p = (typeof globalThis !== 'undefined' && globalThis.__chatyyPendingDeclineWithMessage) || null;
        if (!p || !p.callId) return;
        // Skip stale entries — likely a previous decline the user already saw.
        if (Date.now() - (p.ts || 0) > SHEET_WINDOW_MS) {
          globalThis.__chatyyPendingDeclineWithMessage = null;
          return;
        }
        // De-dupe — don't reopen the sheet for the same callId.
        if (lastSeenIdRef.current === p.callId) return;
        lastSeenIdRef.current = p.callId;
        setPending(p);
        setCustomText('');
        setVisible(true);
        globalThis.__chatyyPendingDeclineWithMessage = null;
      } catch {}
    }, 800);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  const presets = [
    t('call.declinePreset1') || 'Te ligo já',
    t('call.declinePreset2') || 'Estou ocupado',
    t('call.declinePreset3') || 'Não posso falar agora',
    t('call.declinePreset4') || 'Pode mandar mensagem?',
  ];

  const onSend = async (msg) => {
    if (busy || !pending || !msg) return;
    const text = String(msg || '').trim().slice(0, 240);
    if (!text) return;
    setBusy(true);
    try {
      const { chatCallDeclineWithMessage } = require('../services/api');
      await chatCallDeclineWithMessage(
        pending.callId,
        pending.conversationId || '',
        pending.toEmail || '',
        text
      );
    } catch (e) {
      if (__DEV__) console.warn('[DeclineWithMessage]', e?.message);
    } finally {
      setBusy(false);
      setVisible(false);
      setPending(null);
    }
  };

  const onClose = () => {
    setVisible(false);
    setPending(null);
  };

  if (!visible || !pending) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <KeyboardAvoidingView behavior="padding" style={{ width: '100%' }}>
          <Pressable onPress={(e) => e.stopPropagation?.()} style={[styles.sheet, { backgroundColor: isDark ? '#1F2937' : '#fff' }]}>
            <View style={styles.handle} />
            <Text style={[styles.title, { color: colors.text }]}>
              {t('call.declineWithMessageTitle') || 'Responder com mensagem'}
            </Text>
            {presets.map((p) => (
              <TouchableOpacity
                key={p}
                onPress={() => onSend(p)}
                disabled={busy}
                style={[styles.row, { borderBottomColor: isDark ? '#374151' : '#E5E7EB' }]}
                activeOpacity={0.7}
              >
                <Text style={[styles.rowText, { color: colors.tint || '#1976d2' }]}>{p}</Text>
              </TouchableOpacity>
            ))}
            <View style={styles.customRow}>
              <TextInput
                value={customText}
                onChangeText={setCustomText}
                placeholder={t('call.declineCustomHint') || 'Mensagem personalizada'}
                placeholderTextColor={isDark ? '#9CA3AF' : '#6B7280'}
                style={[styles.input, { color: colors.text, borderColor: isDark ? '#374151' : '#D1D5DB' }]}
                maxLength={240}
                editable={!busy}
                returnKeyType="send"
                onSubmitEditing={() => onSend(customText)}
              />
              <TouchableOpacity
                onPress={() => onSend(customText)}
                disabled={busy || !customText.trim()}
                style={styles.sendBtn}
                activeOpacity={0.7}
              >
                <Text style={[styles.sendText, { color: customText.trim() ? (colors.tint || '#1976d2') : '#9CA3AF' }]}>
                  {t('common.send') || 'Enviar'}
                </Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { padding: 20, paddingBottom: 28, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(127,127,127,0.5)', alignSelf: 'center', marginBottom: 12 },
  title: { fontSize: 16, fontWeight: '600', marginBottom: 12 },
  row: { paddingVertical: 14, borderBottomWidth: 1 },
  rowText: { fontSize: 15 },
  customRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12, gap: 8 },
  input: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  sendBtn: { paddingHorizontal: 12, paddingVertical: 10 },
  sendText: { fontSize: 15, fontWeight: '600' },
});
