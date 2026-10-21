// [e2ee5 WP-12 2026-10-21] Web logada SEM vínculo (entrou por senha): as conversas protegidas só
// abrem depois de conectar este navegador pelo celular (D4). Faixa discreta com "Conectar" que abre
// /link-web (QR). Invisível fora da web, com a flag desligada ou quando o navegador já está vinculado.
//
// Onde plugar (WP-08c): no topo da conversa com e2ee_mode=1 e no topo da lista de conversas da web.
//   <LinkWebNeeded />            (decide sozinho se aparece)
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { LockGlyph, noticePalette, tx } from './e2eeUi';
import * as link from '../../services/e2ee/link';

export default function LinkWebNeeded({ style }) {
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const [need, setNeed] = useState(() => link.webNeedsLinkSync());
  useEffect(() => {
    if (Platform.OS !== 'web' || !link.isOn()) return undefined;
    let alive = true;
    const tick = () => { if (alive) setNeed(link.webNeedsLinkSync()); };
    tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  if (!need) return null;
  const p = noticePalette(isDark);
  return (
    <View style={[st.wrap, { backgroundColor: p.bg, borderColor: p.border }, style]} testID="e2ee5-link-needed">
      <LockGlyph size={13} color={p.icon} />
      <Text style={[st.text, { color: p.fg }]}>
        {tx(t, 'e2ee5.link.need_phone', 'Para ler as conversas protegidas neste navegador, conecte-o pelo Chatyy do seu celular.')}
      </Text>
      <Pressable onPress={() => router.push('/link-web')} accessibilityRole="button" hitSlop={8}>
        <Text style={[st.cta, { color: p.fg }]}>{tx(t, 'e2ee5.link.need_phone_cta', 'Conectar')}</Text>
      </Pressable>
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 9, marginHorizontal: 12, marginVertical: 6 },
  text: { flex: 1, fontSize: 13, lineHeight: 18 },
  cta: { fontSize: 13.5, fontWeight: '700' },
});
