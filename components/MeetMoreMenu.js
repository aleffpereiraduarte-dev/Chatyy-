// [2026-10-15 meet-v2] Sheet "Mais" da reunião: P&B, ícones SVG, safe-area, badges,
// estado (ligado/desligado) à direita. Abre de baixo com animação.
import { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Platform, Pressable, ScrollView, Animated } from 'react-native';

export default function MeetMoreMenu({ visible, onClose, options, bottomInset = 0, title }) {
  const y = useRef(new Animated.Value(40)).current;
  const o = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!visible) { y.setValue(40); o.setValue(0); return; }
    const nd = Platform.OS !== 'web';
    Animated.parallel([
      Animated.spring(y, { toValue: 0, useNativeDriver: nd, speed: 22, bounciness: 3 }),
      Animated.timing(o, { toValue: 1, duration: 160, useNativeDriver: nd }),
    ]).start();
  }, [visible, y, o]);

  if (!visible || !options?.length) return null;

  const sections = [];
  const bySec = {};
  options.forEach((opt) => {
    const sec = opt.section || '';
    if (!bySec[sec]) { bySec[sec] = []; sections.push([sec, bySec[sec]]); }
    bySec[sec].push(opt);
  });

  return (
    <Animated.View style={[s.backdrop, { opacity: o }]}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="close" />
      <Animated.View style={[s.sheet, { paddingBottom: Math.max(bottomInset, 12) + 8, transform: [{ translateY: y }] }]} accessibilityViewIsModal>
        <View style={s.handleWrap}><View style={s.handle} /></View>
        {title ? <Text style={s.sheetTitle} numberOfLines={1}>{title}</Text> : null}
        <ScrollView style={s.scrollArea} showsVerticalScrollIndicator={false} bounces={false}>
          {sections.map(([sectionName, items], si) => (
            <View key={sectionName || si}>
              {sectionName && sections.length > 1 ? <Text style={s.sectionTitle}>{sectionName}</Text> : null}
              <View style={s.group}>
                {items.map((opt, i) => {
                  const IC = opt.icon;
                  return (
                    <Pressable
                      key={opt.key || opt.label}
                      style={({ pressed }) => [s.row, i > 0 && s.rowBorder, pressed && { backgroundColor: 'rgba(255,255,255,0.06)' }]}
                      onPress={() => { onClose?.(); opt.onPress?.(); }}
                      accessibilityRole="button"
                      accessibilityLabel={opt.label}
                      accessibilityState={opt.active != null ? { selected: !!opt.active } : undefined}
                    >
                      <View style={[s.iconWrap, opt.active && s.iconWrapOn]}>
                        {IC ? <IC size={19} color={opt.active ? '#000' : '#fff'} /> : null}
                      </View>
                      <Text style={[s.label, opt.destructive && s.destructive]} numberOfLines={1}>{opt.label}</Text>
                      {opt.badge ? <View style={s.badge}><Text style={s.badgeText}>{opt.badge}</Text></View> : null}
                      {opt.value ? <Text style={s.value} numberOfLines={1}>{opt.value}</Text> : null}
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))}
        </ScrollView>
      </Animated.View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject, zIndex: 300, justifyContent: 'flex-end', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  sheet: {
    backgroundColor: '#111', borderTopLeftRadius: 24, borderTopRightRadius: 24,
    width: '100%', maxWidth: 520, maxHeight: '78%',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.10)', borderBottomWidth: 0,
    ...(Platform.OS === 'web' ? { boxShadow: '0 -8px 32px rgba(0,0,0,0.6)' } : { elevation: 12 }),
  },
  handleWrap: { alignItems: 'center', paddingTop: 10, paddingBottom: 6 },
  handle: { width: 38, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.22)' },
  sheetTitle: { color: '#fff', fontSize: 15, fontWeight: '700', textAlign: 'center', paddingBottom: 6 },
  scrollArea: { paddingHorizontal: 14 },
  sectionTitle: {
    color: 'rgba(255,255,255,0.5)', fontSize: 12, fontWeight: '600', letterSpacing: 0.4,
    paddingHorizontal: 6, paddingTop: 14, paddingBottom: 6,
  },
  group: { backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 16, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 12, minHeight: 52 },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.08)' },
  iconWrap: { width: 34, height: 34, borderRadius: 17, marginRight: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.10)' },
  iconWrapOn: { backgroundColor: '#fff' },
  label: { color: '#fff', fontSize: 15.5, fontWeight: '500', flex: 1 },
  value: { color: 'rgba(255,255,255,0.5)', fontSize: 14, marginLeft: 8, maxWidth: '40%' },
  destructive: { color: '#FF453A' },
  badge: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', marginLeft: 8 },
  badgeText: { color: '#000', fontSize: 11, fontWeight: '800' },
});
