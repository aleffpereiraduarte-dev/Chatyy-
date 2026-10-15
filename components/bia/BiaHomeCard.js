// [2026-10-15 bia-design] Card da Bia no topo da lista de conversas: mini-orb vivo,
// "Bia · IA", sugestão do momento (muda com a hora do dia) e atalho direto p/ o
// modo voz. Mesmo footprint das linhas (minHeight 74) — layout da lista não muda.
import React, { memo, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import BiaOrb from './BiaOrb';
import { BiaPressScale, GlyphWave } from './BiaUI';

function suggestion(t) {
  const h = new Date().getHours();
  if (h < 12) return { hello: t('one.goodMorning'), tip: t('one.todaySummary') };
  if (h < 18) return { hello: t('one.goodAfternoon'), tip: t('one.unreadEmails') };
  return { hello: t('one.goodEvening'), tip: t('one.tomorrowAgenda') };
}

function BiaHomeCard({ isDark, t, router, P, avatarSize = 54, nameStyle, previewStyle }) {
  const sug = useMemo(() => suggestion(t), [t]);
  const open = (q) => { try { router.push(q ? `/one?${q}` : '/one'); } catch {} };
  return (
    <BiaPressScale onPress={() => open()} scaleTo={0.985} accessibilityLabel={`${t('one.title')}, ${sug.tip}`} style={hc.row}>
      <BiaOrb size={avatarSize} lite isDark={isDark} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={hc.titleRow}>
          <Text maxFontSizeMultiplier={1.35} style={[nameStyle, { flex: 0, color: P.text }]}>{t('one.title')}</Text>
          <View style={[hc.badge, { backgroundColor: P.chipBg }]}>
            <Text maxFontSizeMultiplier={1.1} style={[hc.badgeText, { color: P.sub }]}>{t('chat.aiBadge')}</Text>
          </View>
        </View>
        <Text maxFontSizeMultiplier={1.3} style={[previewStyle, { color: P.sub, marginTop: 3, marginRight: 0 }]} numberOfLines={1}>
          <Text style={{ color: P.text, fontWeight: '500' }}>{sug.hello}</Text>
          {` · ${sug.tip}`}
        </Text>
      </View>
      <BiaPressScale
        onPress={() => open('voice=1')}
        scaleTo={0.9}
        hitSlop={8}
        accessibilityLabel={t('one.voiceConversation')}
        style={[hc.voice, { backgroundColor: isDark ? '#FFFFFF' : '#0D0D0D' }]}
      >
        <GlyphWave size={16} color={isDark ? '#000000' : '#FFFFFF'} />
      </BiaPressScale>
    </BiaPressScale>
  );
}

const hc = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 10, minHeight: 74 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  badge: { borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1 },
  badgeText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  voice: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
});

export default memo(BiaHomeCard);
