/**
 * LiveSystemChipStack — left-bottom floating column for system events like
 * "@maria entrou", "@joao saiu". Glass chips with mini avatar + bold name +
 * body, slide-in from below with spring entrance, auto-dismiss after 4s.
 *
 * Pure presentation — parent feeds `items: [{ id, email, name, text, ts }]`,
 * and we stack the latest 4 with column-reverse so newest sits on top.
 * Each chip drives its own animated entrance/exit (no re-render storms).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Platform, Animated,
} from 'react-native';
import AvatarCircle from '../AvatarCircle';
import { useLanguage } from '../../context/LanguageContext';

const ACCENT = '#111111';

function Chip({ item, onDismiss }) {
  const anim = useRef(new Animated.Value(0)).current;
  const dismissedRef = useRef(false);

  useEffect(() => {
    // Spring in
    Animated.spring(anim, {
      toValue: 1,
      friction: 7,
      tension: 130,
      useNativeDriver: true,
    }).start();

    // Auto-dismiss after 4s — fade + slide-up, then unmount.
    const t = setTimeout(() => {
      if (dismissedRef.current) return;
      dismissedRef.current = true;
      Animated.timing(anim, {
        toValue: 2,
        duration: 320,
        useNativeDriver: true,
      }).start(() => onDismiss?.(item.id));
    }, 4000);

    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.chip,
        {
          opacity: anim.interpolate({ inputRange: [0, 1, 2], outputRange: [0, 1, 0] }),
          transform: [{
            translateY: anim.interpolate({ inputRange: [0, 1, 2], outputRange: [22, 0, -12] }),
          }, {
            scale: anim.interpolate({ inputRange: [0, 1, 2], outputRange: [0.88, 1, 0.96] }),
          }],
        },
      ]}
    >
      <AvatarCircle name={item.name} email={item.email} size={22} />
      <Text style={styles.text} numberOfLines={1}>
        <Text style={styles.name}>{item.name}</Text>
        <Text style={styles.body}>{` ${item.text}`}</Text>
      </Text>
    </Animated.View>
  );
}

// [lives-engage 2026-10-10] Entradas com vazão controlada (TikTok): no
// máximo 1 chip novo a cada PUMP_MS; entradas que chegam no intervalo viram
// "Fulano e mais N entraram". Live cheia não vira cascata de chips.
const PUMP_MS = 1400;
const MAX_VISIBLE = 2;

export default function LiveSystemChipStack({ items = [], bottom, onDismiss }) {
  const { t } = useLanguage();
  const [shown, setShown] = useState([]);
  const seenRef = useRef(new Set());
  const pendingRef = useRef([]);
  const timerRef = useRef(null);
  const lastPumpRef = useRef(0);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const tRef = useRef(t);
  tRef.current = t;

  const pump = useRef(() => {
    timerRef.current = null;
    const batch = pendingRef.current;
    if (!batch.length) return;
    pendingRef.current = [];
    lastPumpRef.current = Date.now();
    const head = batch[batch.length - 1];
    const extra = batch.length - 1;
    const chip = extra > 0
      ? { ...head, id: head.id + '_agg' + extra, text: tRef.current('liveEng.andOthersJoined').replace('{n}', String(extra)) }
      : head;
    setShown(prev => [...prev, chip].slice(-MAX_VISIBLE));
    // O pai só precisa do array enxuto — avisa que os itens foram consumidos.
    batch.forEach(it => { try { onDismissRef.current?.(it.id); } catch {} });
  }).current;

  useEffect(() => {
    let added = false;
    for (const it of items) {
      if (!it || seenRef.current.has(it.id)) continue;
      seenRef.current.add(it.id);
      pendingRef.current.push(it);
      added = true;
    }
    if (seenRef.current.size > 500) seenRef.current = new Set(items.map(i => i.id));
    if (!added || timerRef.current) return;
    const wait = Math.max(0, PUMP_MS - (Date.now() - lastPumpRef.current));
    timerRef.current = setTimeout(pump, wait);
  }, [items, pump]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const dismissShown = useCallback((id) => {
    setShown(prev => prev.filter(x => x.id !== id));
  }, []);

  return (
    <View
      pointerEvents="none"
      style={[styles.stack, { bottom }]}
    >
      {shown.map(it => (
        <Chip key={it.id} item={it} onDismiss={dismissShown} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    position: 'absolute',
    left: 12,
    gap: 6,
    zIndex: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 18,
    backgroundColor: 'rgba(17, 17, 17,0.42)',
    borderWidth: 1,
    borderColor: 'rgba(17, 17, 17,0.45)',
    alignSelf: 'flex-start',
    maxWidth: 260,
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      boxShadow: '0 2px 12px rgba(17, 17, 17,0.3)',
    } : {}),
  },
  text: {
    flex: 1,
    fontSize: 12,
  },
  name: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
  },
  body: {
    color: 'rgba(255,255,255,0.92)',
    fontSize: 12,
    fontWeight: '500',
  },
});
