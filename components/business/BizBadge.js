// [conta-empresarial 2026-10-24] Rótulo "Conta comercial" (cabeçalho da conversa, perfil) a partir de
// biz_public_batch (cache 10 min em services/business). Conta pessoal / servidor sem o recurso = nada.
import { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { publicCardShort, publicCardPeek, bizEnabledSync } from '../../services/business';

export function useBizCard(email) {
  const [card, setCard] = useState(() => (email ? publicCardPeek(email) || null : null));
  useEffect(() => {
    let alive = true;
    if (!email || !bizEnabledSync()) { setCard(null); return undefined; }
    publicCardShort(email).then((c) => { if (alive) setCard(c || null); }).catch(() => {});
    return () => { alive = false; };
  }, [email]);
  return card;
}

export function openBizProfile(email) {
  try { require('expo-router').router.push({ pathname: '/business-account', params: { view: 'public', email: String(email || '') } }); } catch {}
}

/** pill pequena ao lado do nome no cabeçalho da conversa */
export default function BizBadge({ email, t, colors }) {
  const card = useBizCard(email);
  if (!card) return null;
  const label = card.assistant_active ? t('biz.badge.assistant', 'Comercial · assistente') : t('biz.label', 'Conta comercial');
  return (
    <Pressable onPress={() => openBizProfile(email)} hitSlop={6} accessibilityRole="button" accessibilityLabel={label}>
      <View style={[s.pill, { borderColor: (colors && colors.textSecondary) || '#8E8E93' }]}>
        <Text style={[s.txt, { color: (colors && colors.textSecondary) || '#8E8E93' }]} numberOfLines={1}>{label}</Text>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  pill: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 },
  txt: { fontSize: 10, fontWeight: '600' },
});
