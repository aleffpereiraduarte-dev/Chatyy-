// [2026-10-07 email-instant-send] Global "Enviando… / Enviado · Desfazer"
// snackbar for e-mail, mounted once in app/_layout.js. The composer closes
// right after the server queues the message; this bar keeps the undo window.
import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLanguage } from '../context/LanguageContext';
import { subscribeEmailUndo, getEmailUndo, undoEmailSend, dismissEmailUndo } from '../services/emailUndo';

export default function EmailUndoBar() {
  const [st, setSt] = useState(getEmailUndo());
  const [, setTick] = useState(0);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();

  useEffect(() => subscribeEmailUndo(setSt), []);
  useEffect(() => {
    if (!st || st.phase !== 'pending') return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [st]);

  if (!st) return null;
  const pending = st.phase === 'pending';
  const left = Math.max(0, Math.ceil((st.until - Date.now()) / 1000));

  const onUndo = async () => {
    const ok = await undoEmailSend();
    if (ok) {
      try { router.push({ pathname: '/compose', params: { restore_undo: '1' } }); } catch {}
    }
  };

  return (
    <View pointerEvents="box-none" style={[st_.wrap, { bottom: Math.max(insets.bottom, 12) + 64 }]}>
      <View style={st_.bar} accessibilityLiveRegion="polite">
        <Text style={st_.text} numberOfLines={1}>
          {pending ? (t('compose.sendingUndo') || 'Enviando…') : (t('compose.sentToast') || 'E-mail enviado')}
        </Text>
        {pending ? (
          <TouchableOpacity onPress={onUndo} hitSlop={10} accessibilityRole="button" style={st_.btn}>
            <Text style={st_.btnText}>{(t('undo.button') || 'Desfazer') + (left > 0 ? ` (${left})` : '')}</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={dismissEmailUndo} hitSlop={10} accessibilityRole="button" style={st_.btn}>
            <Text style={st_.btnText}>OK</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const st_ = StyleSheet.create({
  wrap: { position: 'absolute', left: 12, right: 12, alignItems: 'center', zIndex: 9999, elevation: 30 },
  bar: {
    width: '100%', maxWidth: 520, flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#111111', borderRadius: 12, paddingLeft: 16, paddingRight: 6, minHeight: 48,
    ...(Platform.OS === 'web' ? { boxShadow: '0 6px 24px rgba(0,0,0,0.25)' } : { shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } }),
  },
  text: { flex: 1, color: '#ffffff', fontSize: 15, fontWeight: '500' },
  btn: { paddingHorizontal: 12, paddingVertical: 10 },
  btnText: { color: '#ffffff', fontSize: 15, fontWeight: '700' },
});
