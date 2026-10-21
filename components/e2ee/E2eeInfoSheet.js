// [e2ee5 WP-15 2026-10-21] Folha "Saiba mais" da criptografia de ponta a ponta.
//
// mode:
//   'learn'    — o que é a criptografia (aviso do topo, divisor, cadeado do cabeçalho)
//   'waiting'  — "Aguardando esta mensagem" (balão UTD retentável)
//   'changed'  — "O código de segurança de {name} mudou"
//   'blocked'  — contato VERIFICADO trocou de código: confirmar antes de enviar (IdentityViolation)
// Ações: onVerify (abre SafetyNumberScreen), onAccept (blocked: pin_identity e segue), onClose.
// Só desenha com isE2eeUiEnabled().
import React from 'react';
import { Modal, View, Text, Pressable, StyleSheet, Linking, ScrollView } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { isE2eeUiEnabled, LockGlyph, ClockGlyph, ShieldGlyph, E2EE_LEARN_URL, tx } from './e2eeUi';

export default function E2eeInfoSheet({ visible, mode = 'learn', name = '', onClose, onVerify, onAccept }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  if (!visible || !isE2eeUiEnabled()) return null;
  const accent = colors.accent || colors.primary;
  const p = { name: name || tx(t, 'e2ee5.common.contact', 'o contato') };

  let title; let body; let Icon = LockGlyph;
  if (mode === 'waiting') {
    Icon = ClockGlyph;
    title = tx(t, 'e2ee5.msg.waiting_title', 'Aguardando mensagem');
    body = [tx(t, 'e2ee5.msg.waiting_body', 'Esta mensagem está protegida com criptografia de ponta a ponta e a chave para abri-la ainda não chegou a este aparelho. Ela aparece sozinha assim que chegar. Pedir para a pessoa abrir o Chatyy costuma resolver.')];
  } else if (mode === 'changed' || mode === 'blocked') {
    Icon = ShieldGlyph;
    title = tx(t, 'e2ee5.safety.changed_title', 'O código de segurança mudou');
    body = [tx(t, 'e2ee5.safety.changed_body', 'Isso costuma acontecer quando {name} reinstala o Chatyy, troca de celular ou adiciona um aparelho. As mensagens continuam protegidas. Se quiser, verifique o novo código com {name}.', p)];
    if (mode === 'blocked') body.push(tx(t, 'e2ee5.safety.changed_verified_block', 'Você tinha verificado o código de {name}. Para continuar enviando mensagens, confirme o código novo.', p));
  } else {
    title = tx(t, 'e2ee5.learn.title', 'Criptografia de ponta a ponta');
    body = [
      tx(t, 'e2ee5.learn.body1', 'As mensagens desta conversa são protegidas com criptografia de ponta a ponta. Só você e as pessoas da conversa têm as chaves para ler.'),
      tx(t, 'e2ee5.learn.body2', 'Nem o Chatyy consegue ler o conteúdo: textos, fotos, vídeos, áudios, documentos e localização ficam só entre vocês.'),
      tx(t, 'e2ee5.learn.body3', 'Você pode comparar o código de segurança para confirmar que está falando com a pessoa certa.'),
    ];
  }

  const close = () => { try { onClose && onClose(); } catch {} };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
      <Pressable style={st.backdrop} onPress={close} accessibilityRole="button" accessibilityLabel={tx(t, 'e2ee5.common.close', 'Fechar')}>
        <Pressable style={[st.card, { backgroundColor: colors.surface || colors.background }]} onPress={() => {}} accessible={false}>
          <ScrollView bounces={false} contentContainerStyle={st.inner}>
            <View style={[st.iconWrap, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }]}>
              <Icon size={28} color={colors.text} filled={false} />
            </View>
            <Text style={[st.title, { color: colors.text }]} accessibilityRole="header">{title}</Text>
            {body.map((b, i) => <Text key={i} style={[st.body, { color: colors.textSecondary }]}>{b}</Text>)}
            {mode === 'learn' ? (
              <Pressable onPress={() => { try { Linking.openURL(E2EE_LEARN_URL); } catch {} }} accessibilityRole="link" hitSlop={8}>
                <Text style={[st.link, { color: accent }]}>{tx(t, 'e2ee5.learn.more_link', 'Saiba mais sobre a criptografia no Chatyy')}</Text>
              </Pressable>
            ) : null}
          </ScrollView>
          <View style={[st.actions, { borderTopColor: colors.divider || colors.border }]}>
            {mode === 'blocked' && onAccept ? (
              <Pressable style={st.btn} onPress={() => { close(); onAccept(); }} accessibilityRole="button">
                <Text style={[st.btnText, { color: accent }]}>{tx(t, 'e2ee5.safety.accept', 'Continuar')}</Text>
              </Pressable>
            ) : null}
            {onVerify && mode !== 'waiting' ? (
              <Pressable style={st.btn} onPress={() => { close(); onVerify(); }} accessibilityRole="button">
                <Text style={[st.btnText, { color: accent }]}>{tx(t, 'e2ee5.safety.verify_now', 'Verificar código de segurança')}</Text>
              </Pressable>
            ) : null}
            <Pressable style={st.btn} onPress={close} accessibilityRole="button">
              <Text style={[st.btnText, { color: colors.text, fontWeight: '600' }]}>{tx(t, 'e2ee5.common.ok', 'OK')}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const st = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 },
  card: { width: '100%', maxWidth: 420, borderRadius: 18, overflow: 'hidden', maxHeight: '86%' },
  inner: { paddingHorizontal: 22, paddingTop: 24, paddingBottom: 12, alignItems: 'center' },
  iconWrap: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  title: { fontSize: 18, fontWeight: '700', textAlign: 'center', marginBottom: 10 },
  body: { fontSize: 15, lineHeight: 21, textAlign: 'center', marginBottom: 10 },
  link: { fontSize: 15, fontWeight: '600', textAlign: 'center', marginTop: 4, marginBottom: 6 },
  actions: { borderTopWidth: StyleSheet.hairlineWidth },
  btn: { paddingVertical: 14, alignItems: 'center' },
  btnText: { fontSize: 16 },
});
