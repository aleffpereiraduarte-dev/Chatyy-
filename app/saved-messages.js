// Saved Messages — Telegram-style "chat with yourself" landing screen.
//
// Lazy-creates the user's saved-messages conversation on first open then
// redirects to /chat-conversation with `saved=1`. The conversation screen
// reads that flag to enable saved-mode features:
//   - Header label "Mensagens Salvas" + bookmark icon
//   - Tabs strip (Tudo / Fotos / Vídeos / Documentos / Áudio / Links)
//   - Composer: "Cabeçalho" insert + "Lembrar-me em" scheduler
//   - Pin-message support (acts as a TODO/important flag for the user)
//   - Search bar that filters within Saved Messages
//
// Why not duplicate chat-conversation.js? It's 21k lines — reusing the
// same screen via a flag keeps fixes/perf wins shared instead of forking.
import { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, TouchableOpacity, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import * as api from '../services/api';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';

export default function SavedMessagesScreen() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.chatSavedConv();
        if (cancelled) return;
        if (r?.success && r.data?.conversation_id) {
          const cid = r.data.conversation_id;
          const name = encodeURIComponent(t('chat.savedMessages') || 'Mensagens Salvas');
          // replace() not push() so the back button skips this loader and
          // returns straight to wherever the user came from (chat list /
          // sidebar) — Telegram-parity.
          router.replace(`/chat-conversation?id=${cid}&name=${name}&type=saved&saved=1`);
        } else {
          setErr(r?.message || 'Erro ao abrir Mensagens Salvas');
        }
      } catch (e) {
        if (!cancelled) setErr(e?.message || 'Erro ao abrir Mensagens Salvas');
      }
    })();
    return () => { cancelled = true; };
  }, [router, t]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {err ? (
        <>
          <Text style={[styles.errText, { color: colors.text }]}>{err}</Text>
          <TouchableOpacity onPress={() => router.back()} style={[styles.btn, { backgroundColor: colors.primary }]}>
            <Text style={styles.btnText}>{t('common.back') || 'Voltar'}</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <ActivityIndicator color={colors.primary} />
          <Text style={[styles.loadingText, { color: colors.textSecondary }]}>
            {t('chat.savedMessages') || 'Mensagens Salvas'}
          </Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  loadingText: { marginTop: 12, fontSize: 14 },
  errText: { fontSize: 15, marginBottom: 16, textAlign: 'center' },
  btn: { paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 },
  btnText: { color: '#fff', fontWeight: '600' },
});
