/**
 * LiveTopFans — ranking de fãs da live (TikTok "Top viewers").
 *
 *  • LiveTopFansStack: até 3 avatares sobrepostos (top bar). Toque abre o sheet.
 *  • LiveTopFansSheet: lista completa. Fonte = hub (curtidas por pessoa,
 *    live_top_fans) + REST chat_live_top_gifters (diamantes, só com presentes
 *    ligados). Ordena por diamantes e depois curtidas.
 */
import { memo, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, Pressable, FlatList, ActivityIndicator, Platform,
} from 'react-native';
import { useLanguage } from '../../context/LanguageContext';
import AvatarCircle from '../AvatarCircle';
import { IconX, IconHeart, IconDiamond } from '../Icons';
import { humanizeCount } from './liveEngageConfig';
import {
  useEngageSelector, selTopFans, selSheet, selFans, selFansLoading, selGifters,
} from './liveEngageStore';

export const LiveTopFansStack = memo(function LiveTopFansStack({ engage, size = 26 }) {
  const { t } = useLanguage();
  const top = useEngageSelector(engage, selTopFans);
  if (!top || !top.length) return null;
  return (
    <TouchableOpacity
      onPress={() => engage?.openSheet('fans')}
      activeOpacity={0.8}
      style={styles.stack}
      hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
      accessibilityRole="button"
      accessibilityLabel={t('liveEng.topFans')}
    >
      {top.slice(0, 3).map((f, i) => (
        <View key={f.email || i} style={[styles.stackItem, { marginLeft: i ? -size * 0.32 : 0, zIndex: 3 - i }]}>
          <AvatarCircle name={f.name} email={f.email} size={size} />
          <View style={styles.rankDot}><Text style={styles.rankDotText}>{i + 1}</Text></View>
        </View>
      ))}
    </TouchableOpacity>
  );
});

const Row = memo(function Row({ item, index, t }) {
  const podium = index < 3;
  return (
    <View style={styles.row}>
      <Text style={[styles.rank, podium && styles.rankTop]}>{index + 1}</Text>
      <View style={[styles.avatarWrap, podium && styles.avatarTop]}>
        <AvatarCircle name={item.name} email={item.email} size={38} />
      </View>
      <Text style={styles.name} numberOfLines={1}>{item.name || (item.email || '').split('@')[0]}</Text>
      <View style={styles.metrics}>
        {item.diamonds > 0 ? (
          <View style={styles.metric}>
            <IconDiamond size={12} color="#fff" />
            <Text style={styles.metricText}>{humanizeCount(item.diamonds)}</Text>
          </View>
        ) : null}
        <View style={styles.metric} accessibilityLabel={`${item.likes} ${t('liveEng.likes')}`}>
          <IconHeart size={12} color="#fff" />
          <Text style={styles.metricText}>{humanizeCount(item.likes)}</Text>
        </View>
      </View>
    </View>
  );
});

export const LiveTopFansSheet = memo(function LiveTopFansSheet({ engage }) {
  const { t } = useLanguage();
  const sheet = useEngageSelector(engage, selSheet);
  const fans = useEngageSelector(engage, selFans);
  const gifters = useEngageSelector(engage, selGifters);
  const loading = useEngageSelector(engage, selFansLoading);
  const visible = sheet === 'fans';

  const data = useMemo(() => {
    const map = new Map();
    for (const f of fans || []) {
      const e = String(f.email || '').toLowerCase();
      if (!e) continue;
      map.set(e, { email: e, name: f.name, likes: Number(f.likes) || 0, diamonds: 0 });
    }
    for (const g of gifters || []) {
      const e = String(g.email || '').toLowerCase();
      if (!e) continue;
      const cur = map.get(e) || { email: e, name: g.name, likes: 0, diamonds: 0 };
      cur.diamonds = Number(g.total_diamonds) || 0;
      if (!cur.name) cur.name = g.name;
      map.set(e, cur);
    }
    return Array.from(map.values()).sort((a, b) => (b.diamonds - a.diamonds) || (b.likes - a.likes));
  }, [fans, gifters]);

  if (!visible) return null;
  const close = () => engage?.closeSheet();
  return (
    <Modal visible transparent animationType="slide" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close} accessibilityRole="button" accessibilityLabel={t('common.close')} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.header}>
          <Text style={styles.title}>{t('liveEng.topFans')}</Text>
          <TouchableOpacity onPress={close} style={styles.close} accessibilityRole="button" accessibilityLabel={t('common.close')}>
            <IconX size={18} color="#fff" />
          </TouchableOpacity>
        </View>
        <Text style={styles.hint}>{t('liveEng.topFansHint')}</Text>
        {loading && !data.length ? (
          <ActivityIndicator color="#fff" style={{ marginVertical: 28 }} />
        ) : !data.length ? (
          <Text style={styles.empty}>{t('liveEng.topFansEmpty')}</Text>
        ) : (
          <FlatList
            data={data}
            keyExtractor={(it) => it.email}
            renderItem={({ item, index }) => <Row item={item} index={index} t={t} />}
            style={{ maxHeight: 420 }}
            initialNumToRender={12}
            windowSize={5}
          />
        )}
      </View>
    </Modal>
  );
});

const styles = StyleSheet.create({
  stack: { flexDirection: 'row', alignItems: 'center', minHeight: 36, paddingHorizontal: 2 },
  stackItem: { borderRadius: 999, borderWidth: 1.5, borderColor: '#fff' },
  rankDot: {
    position: 'absolute', bottom: -3, right: -3, minWidth: 13, height: 13, borderRadius: 7,
    backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2,
  },
  rankDotText: { color: '#000', fontSize: 8, fontWeight: '900' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    backgroundColor: '#0b0b0b', borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: Platform.OS === 'ios' ? 34 : 18,
  },
  handle: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.25)', marginBottom: 6 },
  header: { flexDirection: 'row', alignItems: 'center' },
  title: { flex: 1, color: '#fff', fontSize: 16, fontWeight: '800' },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  hint: { color: 'rgba(255,255,255,0.55)', fontSize: 12, marginBottom: 10 },
  empty: { color: 'rgba(255,255,255,0.65)', fontSize: 13, textAlign: 'center', marginVertical: 28 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52 },
  rank: { width: 22, color: 'rgba(255,255,255,0.55)', fontSize: 14, fontWeight: '800', textAlign: 'center' },
  rankTop: { color: '#fff', fontSize: 16, fontWeight: '900' },
  avatarWrap: { borderRadius: 999, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  avatarTop: { borderWidth: 2, borderColor: '#fff' },
  name: { flex: 1, color: '#fff', fontSize: 14, fontWeight: '700' },
  metrics: { flexDirection: 'row', gap: 10 },
  metric: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metricText: { color: '#fff', fontSize: 12, fontWeight: '800' },
});
