// [central-moderacao 2026-10-14] Folha única de denúncia com motivos padronizados (mesmos códigos do
// servidor: api/moderation_core.php → modReasons). Use em qualquer superfície:
//   <ReportSheet visible={open} onClose={() => setOpen(false)}
//     target={{ content_type: 'profile', content_id: email }} />
// Chat privado: passe target.message_ids + target.evidence_texts (texto já decifrado no aparelho) — só isso
// vai como evidência; o servidor nunca lê o resto da conversa.
import React, { useCallback, useEffect, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, Pressable, ScrollView, TextInput, ActivityIndicator, Platform, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconCheckCircle, IconAlertTriangle } from './Icons';
import * as api from '../services/api';

// ordem = gravidade (o servidor prioriza a fila pelo motivo)
export const REPORT_REASONS = ['csam', 'threat', 'self_harm', 'non_consensual', 'hate', 'doxxing', 'harassment', 'violence', 'sexual', 'scam', 'impersonation', 'spam', 'misinformation', 'ip', 'other'];

export default function ReportSheet({ visible, onClose, target, title }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [reason, setReason] = useState(null);
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // null | { reason }
  const [err, setErr] = useState('');

  useEffect(() => { if (visible) { setReason(null); setDetails(''); setDone(null); setErr(''); setBusy(false); } }, [visible]);

  const submit = useCallback(async () => {
    if (!reason || busy || !target?.content_type) return;
    setBusy(true); setErr('');
    try {
      const r = await api.modReport({ ...target, reason, description: details.trim() });
      if (r && r.success === false) throw new Error(r.message || 'fail');
      setDone({ reason });
    } catch (e) {
      setErr(t('mod.failed'));
    } finally { setBusy(false); }
  }, [reason, busy, target, details, t]);

  const goMine = useCallback(() => { onClose?.(); setTimeout(() => { try { router.push('/my-reports'); } catch {} }, 50); }, [onClose, router]);

  return (
    <Modal visible={!!visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={st.backdrop} onPress={onClose}>
        <Pressable style={[st.sheet, { backgroundColor: colors.surface || colors.background, paddingBottom: 16 + insets.bottom }]} onPress={() => {}}>
          <View style={[st.grab, { backgroundColor: colors.border }]} />
          {done ? (
            <View style={{ alignItems: 'center', paddingVertical: 12 }}>
              <IconCheckCircle size={40} color={colors.success || colors.primary} />
              <Text style={[st.title, { color: colors.text, marginTop: 10 }]}>{t('mod.sent')}</Text>
              <Text style={[st.sub, { color: colors.textSecondary, textAlign: 'center' }]}>{t('mod.sentBody')}</Text>
              {done.reason === 'self_harm' ? (
                <Text style={[st.help, { color: colors.text, borderColor: colors.border }]}>{t('mod.selfHarmHelp')}</Text>
              ) : null}
              {done.reason === 'csam' ? (
                <Text style={[st.help, { color: colors.text, borderColor: colors.border }]}>{t('mod.csamNote')}</Text>
              ) : null}
              <TouchableOpacity onPress={goMine} style={[st.btn, { backgroundColor: colors.primary, marginTop: 16 }]} accessibilityRole="button">
                <Text style={[st.btnTxt, { color: colors.onPrimary || '#fff' }]}>{t('mod.viewMine')}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={onClose} style={{ paddingVertical: 12 }} accessibilityRole="button">
                <Text style={{ color: colors.textSecondary, fontSize: 15 }}>{t('common.close')}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <Text style={[st.title, { color: colors.text }]}>{title || t('mod.reportTitle')}</Text>
              <Text style={[st.sub, { color: colors.textSecondary }]}>{t('mod.reportSub')}</Text>
              <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
                {REPORT_REASONS.map((code) => {
                  const on = reason === code;
                  return (
                    <TouchableOpacity key={code} onPress={() => setReason(code)} accessibilityRole="radio" accessibilityState={{ selected: on }}
                      style={[st.row, { borderColor: on ? colors.primary : colors.borderLight || colors.border, backgroundColor: on ? (colors.primaryLight || 'transparent') : 'transparent' }]}>
                      <View style={[st.radio, { borderColor: on ? colors.primary : colors.textTertiary || colors.border }]}>
                        {on ? <View style={[st.dot, { backgroundColor: colors.primary }]} /> : null}
                      </View>
                      <Text style={{ color: colors.text, fontSize: 15, flex: 1 }}>{t('mod.reason.' + code)}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
              {reason === 'self_harm' ? <Text style={[st.help, { color: colors.text, borderColor: colors.border }]}>{t('mod.selfHarmHelp')}</Text> : null}
              {reason === 'csam' ? <Text style={[st.help, { color: colors.text, borderColor: colors.border }]}>{t('mod.csamNote')}</Text> : null}
              <TextInput value={details} onChangeText={setDetails} placeholder={t('mod.detailsPlaceholder')} placeholderTextColor={colors.textTertiary}
                maxLength={1000} multiline style={[st.input, { color: colors.text, borderColor: colors.border }]} />
              {err ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}>
                  <IconAlertTriangle size={16} color={colors.error || '#ef4444'} />
                  <Text style={{ color: colors.error || '#ef4444', fontSize: 13 }}>{err}</Text>
                </View>
              ) : null}
              <TouchableOpacity onPress={submit} disabled={!reason || busy} accessibilityRole="button"
                style={[st.btn, { backgroundColor: colors.error || '#ef4444', opacity: !reason || busy ? 0.5 : 1, marginTop: 12 }]}>
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={[st.btnTxt, { color: '#fff' }]}>{t('mod.send')}</Text>}
              </TouchableOpacity>
              <TouchableOpacity onPress={onClose} style={{ alignItems: 'center', paddingVertical: 12 }} accessibilityRole="button">
                <Text style={{ color: colors.textSecondary, fontSize: 15 }}>{t('mod.cancel')}</Text>
              </TouchableOpacity>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const st = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingHorizontal: 16, paddingTop: 8, maxWidth: 640, width: '100%', alignSelf: 'center' },
  grab: { width: 38, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 10, opacity: 0.7 },
  title: { fontSize: 18, fontWeight: '700', marginBottom: 4 },
  sub: { fontSize: 13.5, marginBottom: 10, lineHeight: 19 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, paddingHorizontal: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, marginBottom: 6 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, minHeight: 60, marginTop: 8, fontSize: 14, textAlignVertical: 'top', ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null) },
  help: { fontSize: 13.5, lineHeight: 19, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, marginTop: 10 },
  btn: { borderRadius: 12, paddingVertical: 13, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' },
  btnTxt: { fontSize: 15.5, fontWeight: '700' },
});
