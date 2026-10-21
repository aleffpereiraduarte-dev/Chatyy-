// [e2ee5 WP-14 2026-10-21] /e2ee-backup-restore — celular novo/reinstalado com backup no servidor.
//
// Aberta pelo e2ee5.ensureSession() (via services/e2ee/backup.offerRestore) ANTES de criar uma
// identidade nova, ou por Ajustes → Privacidade → "Restaurar do backup". Restaurar com a chave de
// recuperação ou a senha devolve a MESMA identidade (o código de segurança não muda para os
// contatos) e o histórico. "Pular" = aparelho novo: as conversas protegidas antigas não abrem aqui e
// os contatos veem "o código de segurança mudou" (como no WhatsApp).
import React, { useState } from 'react';
import { View, Text, ScrollView, TextInput, Pressable, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconRotateCcw } from '../components/Icons';
import { useGroupedColors, SettingsIconTile } from '../components/settings/SettingsKit';
import { LockGlyph, tx } from '../components/e2ee/e2eeUi';
import * as backup from '../services/e2ee/backup';

function confirmAsk(title, body, okLabel, cancelLabel) {
  return new Promise((res) => {
    if (Platform.OS === 'web') { try { res(!!window.confirm(`${title}\n\n${body}`)); } catch { res(false); } return; }
    Alert.alert(title, body, [{ text: cancelLabel, style: 'cancel', onPress: () => res(false) }, { text: okLabel, style: 'destructive', onPress: () => res(true) }]);
  });
}

export default function E2eeBackupRestoreScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const g = useGroupedColors();
  const { t } = useLanguage();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);

  const leave = () => { try { router.back(); } catch { router.replace('/chat'); } };

  const doRestore = async () => {
    if (!input.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await backup.restore(input);
      setInput('');
      setDone(r);
    } catch (e) {
      setErr((e && e.code) || 'failed');
    }
    setBusy(false);
  };

  const skip = async () => {
    const ok = await confirmAsk(
      tx(t, 'e2ee5.backup.skip_title', 'Continuar sem restaurar?'),
      tx(t, 'e2ee5.backup.skip_body', 'Este celular começa como um aparelho novo: as conversas protegidas antigas não abrem aqui e seus contatos verão que o seu código de segurança mudou.'),
      tx(t, 'e2ee5.backup.skip', 'Continuar sem restaurar'),
      tx(t, 'common.cancel', 'Cancelar'),
    );
    if (!ok) return;
    setBusy(true);
    try { await backup.declineRestore(); } catch {}
    setBusy(false);
    leave();
  };

  const errText = (() => {
    switch (err) {
      case 'wrong_key': return tx(t, 'e2ee5.backup.wrong_key', 'Chave de recuperação ou senha incorreta. Confira e tente de novo.');
      case 'rate_limited': return tx(t, 'e2ee5.backup.rate_limited', 'Muitas tentativas. Espere um pouco e tente de novo.');
      case 'no_backup': return tx(t, 'e2ee5.backup.no_backup', 'Não há backup nesta conta. O celular vai começar como um aparelho novo.');
      case 'network': return tx(t, 'e2ee5.backup.err_network', 'Sem conexão. Verifique a internet e tente de novo.');
      case null: return '';
      default: return tx(t, 'e2ee5.backup.err_failed', 'Não foi possível concluir. Tente de novo.');
    }
  })();

  return (
    <View style={[st.root, { backgroundColor: g.pageBg, paddingTop: insets.top }]}>
      <View style={st.header}>
        <TouchableOpacity onPress={leave} style={st.backBtn} accessibilityRole="button" accessibilityLabel={tx(t, 'common.back', 'Voltar')}>
          <IconArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={[st.scroll, { paddingBottom: 32 + insets.bottom }]} keyboardShouldPersistTaps="handled">
        <View style={[st.card, { backgroundColor: g.cardBg }]} testID="e2ee5-restore">
          <SettingsIconTile Icon={IconRotateCcw} size={48} />
          {done ? (
            <>
              <Text style={[st.cardTitle, { color: g.text }]} accessibilityRole="header">{tx(t, 'e2ee5.backup.restored', 'Conversas restauradas')}</Text>
              <Text style={[st.cardBody, { color: g.secondary }]}>
                {done.imported > 0
                  ? tx(t, 'e2ee5.backup.restored_n', 'As chaves de {n} sessões voltaram. As mensagens protegidas aparecem conforme as conversas carregam.', { n: done.imported })
                  : tx(t, 'e2ee5.backup.restored_0', 'Sua identidade foi restaurada. Não havia histórico protegido no backup.')}
              </Text>
              <Pressable onPress={leave} accessibilityRole="button" style={({ pressed }) => [st.cta, { backgroundColor: g.ink, opacity: pressed ? 0.85 : 1 }]} testID="e2ee5-restore-done">
                <Text style={[st.ctaText, { color: g.onInk }]}>{tx(t, 'common.ok', 'OK')}</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={[st.cardTitle, { color: g.text }]} accessibilityRole="header">{tx(t, 'e2ee5.backup.restore', 'Restaurar do backup')}</Text>
              <Text style={[st.cardBody, { color: g.secondary }]}>
                {tx(t, 'e2ee5.backup.restore_body', 'Sua conta tem um backup das conversas protegidas. Digite a chave de recuperação (48 caracteres) ou a senha do backup.')}
              </Text>
              <TextInput
                style={[st.input, { color: g.text, borderColor: err ? g.destructive : g.separator, backgroundColor: g.pageBg }]}
                value={input}
                onChangeText={(v) => { setInput(v); setErr(null); }}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry={false}
                multiline
                placeholder={tx(t, 'e2ee5.backup.restore_ph', 'Chave de recuperação ou senha')}
                placeholderTextColor={g.secondary}
                testID="e2ee5-restore-input"
                accessibilityLabel={tx(t, 'e2ee5.backup.restore_ph', 'Chave de recuperação ou senha')}
              />
              {!!errText && <Text style={[st.hint, { color: g.destructive }]} accessibilityLiveRegion="polite">{errText}</Text>}
              <Pressable onPress={doRestore} accessibilityRole="button" accessibilityState={{ disabled: !input.trim() || busy }} testID="e2ee5-restore-go"
                style={({ pressed }) => [st.cta, { backgroundColor: g.ink, opacity: !input.trim() || busy ? 0.4 : pressed ? 0.85 : 1 }]}>
                {busy ? <ActivityIndicator color={g.onInk} /> : <Text style={[st.ctaText, { color: g.onInk }]}>{tx(t, 'e2ee5.backup.restore_btn', 'Restaurar')}</Text>}
              </Pressable>
              <Pressable onPress={busy ? undefined : skip} style={st.ghost} accessibilityRole="button" testID="e2ee5-restore-skip">
                <Text style={[st.ghostText, { color: g.text }]}>{tx(t, 'e2ee5.backup.skip', 'Continuar sem restaurar')}</Text>
              </Pressable>
            </>
          )}
        </View>
        <View style={st.lockRow}>
          <LockGlyph size={11} color={g.secondary} />
          <Text style={[st.lockText, { color: g.secondary }]}>{tx(t, 'e2ee5.backup.lock_note', 'A chave e a senha nunca saem deste aparelho. O Chatyy não consegue abrir o backup.')}</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6 },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  scroll: { paddingHorizontal: 16, paddingTop: 8, width: '100%', maxWidth: 720, alignSelf: 'center' },
  card: { borderRadius: 22, padding: 20, marginBottom: 16, alignItems: 'center' },
  cardTitle: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3, textAlign: 'center', marginTop: 12 },
  cardBody: { fontSize: 14.5, lineHeight: 20, textAlign: 'center', marginTop: 6 },
  input: { alignSelf: 'stretch', borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 72, fontSize: 16, marginTop: 16, textAlignVertical: 'top' },
  hint: { alignSelf: 'stretch', fontSize: 13, marginTop: 8 },
  cta: { alignSelf: 'stretch', minHeight: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
  ctaText: { fontSize: 16, fontWeight: '600' },
  ghost: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  ghostText: { fontSize: 15.5, fontWeight: '600' },
  lockRow: { flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center', paddingHorizontal: 12 },
  lockText: { fontSize: 12, textAlign: 'center' },
});
