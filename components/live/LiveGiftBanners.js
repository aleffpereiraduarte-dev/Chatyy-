/**
 * LiveGiftBanners — banners "Fulano enviou X" (TikTok) com combo "x5".
 *
 *  • Até 3 banners empilhados (lado esquerdo, meia altura).
 *  • Mesmo remetente + mesmo presente em <3.5s → o banner existente sobe o
 *    contador (pop de escala no "xN") em vez de abrir outro.
 *  • Some 3.5s depois do último envio do combo.
 * Só transform/opacity com useNativeDriver; tudo pointerEvents="none".
 */
import { memo, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Platform } from 'react-native';
import { useLanguage } from '../../context/LanguageContext';
import AvatarCircle from '../AvatarCircle';
import LiveGiftGlyph from './LiveGiftGlyph';
import { giftLabel } from './liveEngageConfig';
import { useEngageSelector, selGiftBanners } from './liveEngageStore';

const HOLD_MS = 3500;

const Banner = memo(function Banner({ b, onDone, sentLabel, label }) {
  const enter = useRef(new Animated.Value(0)).current;
  const pop = useRef(new Animated.Value(1)).current;
  const doneRef = useRef(false);

  useEffect(() => {
    Animated.spring(enter, { toValue: 1, friction: 8, tension: 90, useNativeDriver: true }).start();
  }, [enter]);

  useEffect(() => {
    if (b.count > 1) {
      pop.setValue(1.6);
      Animated.spring(pop, { toValue: 1, friction: 4, tension: 200, useNativeDriver: true }).start();
    }
    const tmr = setTimeout(() => {
      if (doneRef.current) return;
      doneRef.current = true;
      Animated.timing(enter, { toValue: 2, duration: 260, useNativeDriver: true }).start(() => onDone(b.id));
    }, HOLD_MS);
    return () => clearTimeout(tmr);
  }, [b.ts, b.count, b.id, enter, pop, onDone]);

  return (
    <Animated.View
      style={[styles.banner, {
        opacity: enter.interpolate({ inputRange: [0, 1, 2], outputRange: [0, 1, 0] }),
        transform: [{ translateX: enter.interpolate({ inputRange: [0, 1, 2], outputRange: [-260, 0, -40] }) }],
      }]}
    >
      <AvatarCircle name={b.name} email={b.email} size={34} />
      <View style={styles.texts}>
        <Text style={styles.name} numberOfLines={1}>{b.name}</Text>
        <Text style={styles.sub} numberOfLines={1}>{`${sentLabel} ${label}`}</Text>
      </View>
      <View style={styles.glyph}><LiveGiftGlyph icon={b.icon} size={40} /></View>
      {b.count > 1 ? (
        <Animated.Text style={[styles.combo, { transform: [{ scale: pop }] }]}>{`x${b.count}`}</Animated.Text>
      ) : null}
    </Animated.View>
  );
});

function LiveGiftBanners({ engage, top }) {
  const { t } = useLanguage();
  const banners = useEngageSelector(engage, selGiftBanners);
  const onDone = useRef((id) => engage?.dismissGiftBanner(id)).current;
  if (!banners.length) return null;
  const sentLabel = t('liveEng.giftSent');
  return (
    <View pointerEvents="none" style={[styles.stack, { top }]}>
      {banners.map(b => (
        <Banner key={b.id} b={b} onDone={onDone} sentLabel={sentLabel} label={giftLabel(t, b.icon, b.label)} />
      ))}
    </View>
  );
}

export default memo(LiveGiftBanners);

const styles = StyleSheet.create({
  stack: { position: 'absolute', left: 10, gap: 8, zIndex: 40 },
  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingLeft: 3, paddingRight: 6, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.62)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    alignSelf: 'flex-start', maxWidth: 300,
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)' } : {}),
  },
  texts: { maxWidth: 140 },
  name: { color: '#fff', fontSize: 13, fontWeight: '800' },
  sub: { color: 'rgba(255,255,255,0.8)', fontSize: 11, fontWeight: '600' },
  glyph: { marginLeft: 2, marginTop: -8 },
  combo: {
    color: '#fff', fontSize: 24, fontWeight: '900', fontStyle: 'italic', marginLeft: 2, letterSpacing: -0.5,
    textShadowColor: 'rgba(0,0,0,0.6)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4,
  },
});
