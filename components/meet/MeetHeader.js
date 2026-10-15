// [2026-10-15 meet-v2] Cabeçalho da reunião: título, cronômetro, qualidade da rede,
// trava/gravação e botão de participantes. Fundo em degradê preto (legível sobre vídeo).
import { memo, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import { IconUsers, IconLock, IconChevronDown } from '../Icons';

// degradê preto→transparente atrás do cabeçalho (legível sobre qualquer vídeo)
function Scrim() {
  if (Platform.OS === 'web') return null;
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none" preserveAspectRatio="none" width="100%" height="100%">
      <Defs>
        <LinearGradient id="mh" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#000" stopOpacity="0.8" />
          <Stop offset="1" stopColor="#000" stopOpacity="0" />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#mh)" />
    </Svg>
  );
}

function fmt(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

function NetBars({ level }) {
  const n = level === 'poor' ? 1 : level === 'fair' ? 2 : 3;
  return (
    <View style={s.bars}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={[s.bar, { height: 4 + i * 3, opacity: i < n ? 1 : 0.28 }]} />
      ))}
    </View>
  );
}

function MeetHeader({ t, topInset = 0, title, startedAt, net, locked, recording, count, onParticipants, onMinimize, visible = true }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  if (!visible) return null;
  const elapsed = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  const netLabel = net === 'poor' || net === 'fair' ? t('meet.networkWarning') : '';

  return (
    <View style={[s.wrap, { paddingTop: topInset + 6 }]} pointerEvents="box-none">
      <Scrim />
      <View style={s.row}>
        {onMinimize ? (
          <Pressable onPress={onMinimize} hitSlop={10} style={({ pressed }) => [s.iconBtn, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel={t('meetScreen.leave')}>
            <IconChevronDown size={20} color="#fff" />
          </Pressable>
        ) : null}
        <View style={s.center} accessibilityRole="header">
          <View style={s.titleRow}>
            {locked ? <IconLock size={13} color="#fff" /> : null}
            <Text style={s.title} numberOfLines={1}>{title || t('meet.title')}</Text>
          </View>
          <View style={s.metaRow}>
            {recording ? (
              <View style={s.rec}><View style={s.recDot} /><Text style={s.recText}>REC</Text></View>
            ) : null}
            {startedAt ? <Text style={s.meta} accessibilityLabel={fmt(elapsed)}>{fmt(elapsed)}</Text> : null}
            {net ? <NetBars level={net} /> : null}
            {netLabel ? <Text style={[s.meta, { color: '#fff' }]} numberOfLines={1}>{netLabel}</Text> : null}
          </View>
        </View>
        <Pressable
          onPress={onParticipants}
          hitSlop={8}
          style={({ pressed }) => [s.pill, pressed && { opacity: 0.75 }]}
          accessibilityRole="button"
          accessibilityLabel={`${t('meet.participants')}: ${count}`}
        >
          <IconUsers size={15} color="#fff" />
          <Text style={s.pillText}>{count}</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default memo(MeetHeader);

const s = StyleSheet.create({
  wrap: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 90, paddingHorizontal: 12, paddingBottom: 14,
    ...Platform.select({
      web: { backgroundImage: 'linear-gradient(to bottom, rgba(0,0,0,0.85), rgba(0,0,0,0))' },
      default: {},
    }),
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  iconBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' },
  center: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: -0.2, flexShrink: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  meta: { color: 'rgba(255,255,255,0.65)', fontSize: 12.5, fontVariant: ['tabular-nums'] },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 10 },
  bar: { width: 3, borderRadius: 1, backgroundColor: '#fff' },
  rec: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#FF3B30', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
  recDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' },
  recText: { color: '#fff', fontSize: 10.5, fontWeight: '800', letterSpacing: 0.6 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 12, borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  pillText: { color: '#fff', fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
