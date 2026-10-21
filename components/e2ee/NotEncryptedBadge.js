// [e2ee5 WP-15 2026-10-21] Selo "Não criptografado" dos recursos que ficam FORA do E2EE
// (DECISÕES DO FOUNDER 6 e 7; PLANO §2.10 legenda F):
//   kind: 'kids' (conta supervisionada) · 'game' · 'watch' (assistir/ouvir junto) · 'gift' ·
//         'channel' · 'community' · 'bot' · 'bridge' (contato de outro app) · 'status' · 'mural'
// variant: 'pill' (selo no cartão/cabeçalho) · 'inline' (só ícone + texto curto, em linha)
// Toque → explicação curta (Alert nativo / confirm na web). onPress substitui.
// Plugar: cartões de jogo/assistir (WP-09, só o selo), cabeçalho de canal/comunidade/bot,
// cabeçalho de conversa com conta Kids (blocked_reason=kids em e2ee5_conversation_state).
import React, { memo } from 'react';
import { Pressable, Text, StyleSheet, Alert, Platform } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { isE2eeUiEnabled, LockOffGlyph, tx } from './e2eeUi';

const EXPLAIN = {
  kids: ['e2ee5.badge.kids', 'Esta conversa é com uma conta supervisionada do Chatyy Kids e não tem criptografia de ponta a ponta. O responsável pela conta pode ver as mensagens.'],
  game: ['e2ee5.badge.game', 'As jogadas e o placar não são criptografados de ponta a ponta. As mensagens da conversa continuam protegidas.'],
  watch: ['e2ee5.badge.watch', 'O que vocês assistem ou ouvem juntos não é criptografado de ponta a ponta. As mensagens da conversa continuam protegidas.'],
  gift: ['e2ee5.badge.gift', 'Presentes não são criptografados de ponta a ponta.'],
  channel: ['e2ee5.badge.channel', 'Canais não são criptografados de ponta a ponta. As publicações são públicas para quem segue o canal.'],
  community: ['e2ee5.badge.community', 'Os avisos da comunidade não são criptografados de ponta a ponta.'],
  bot: ['e2ee5.badge.bot', 'Conversas com bots e integrações não são criptografadas de ponta a ponta.'],
  bridge: ['e2ee5.badge.bridge', 'Mensagens com contatos de outro aplicativo não são criptografadas de ponta a ponta.'],
  status: ['e2ee5.badge.status', 'O status não é criptografado de ponta a ponta.'],
  mural: ['e2ee5.badge.mural', 'Publicações do Mural não são criptografadas de ponta a ponta.'],
};

export function notEncryptedExplanation(t, kind) {
  const e = EXPLAIN[kind] || ['e2ee5.badge.generic', 'Este recurso não é criptografado de ponta a ponta.'];
  return tx(t, e[0], e[1]);
}

function NotEncryptedBadge({ kind = 'game', variant = 'pill', onPress, color, style }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  if (!isE2eeUiEnabled()) return null;
  const label = tx(t, 'e2ee5.badge.not_encrypted', 'Não criptografado');
  const fg = color || colors.textSecondary;
  const show = () => {
    if (onPress) { onPress(); return; }
    const msg = notEncryptedExplanation(t, kind);
    if (Platform.OS === 'web') { try { window.alert(msg); } catch {} return; }
    Alert.alert(label, msg, [{ text: tx(t, 'e2ee5.common.ok', 'OK') }]);
  };
  const pill = variant !== 'inline';
  return (
    <Pressable
      onPress={show}
      hitSlop={8}
      style={({ pressed }) => [pill ? s.pill : s.inline, pill ? { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' } : null, { opacity: pressed ? 0.7 : 1 }, style]}
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${notEncryptedExplanation(t, kind)}`}
    >
      <LockOffGlyph size={pill ? 11 : 12} color={fg} />
      <Text style={[s.text, { color: fg }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  inline: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
  text: { fontSize: 11.5, fontWeight: '600', marginLeft: 4 },
});

export default memo(NotEncryptedBadge);
