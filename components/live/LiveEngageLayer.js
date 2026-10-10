/**
 * LiveEngageLayer — montagem única das camadas de engajamento sobre a live
 * (viewer e host): banners de presente com combo, presente de tela cheia,
 * cartão da pergunta destacada e os sheets (top fãs, Q&A, presentes).
 *
 * Também exporta LiveLikesChip (total de curtidas do hub) e
 * LiveHostEngageBar (faixa do host: curtidas + top fãs + Q&A com badge).
 */
import { memo, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, Dimensions, Platform } from 'react-native';
import { useLanguage } from '../../context/LanguageContext';
import { IconHeart, IconHelpCircle } from '../Icons';
import LiveGiftBanners from './LiveGiftBanners';
import LiveGiftFullscreen from './LiveGiftFullscreen';
import LiveGiftSheet from './LiveGiftSheet';
import { LiveTopFansSheet, LiveTopFansStack } from './LiveTopFans';
import { LiveQASheet, LiveQAHighlightCard } from './LiveQA';
import { LIVE_GIFTS_ENABLED, humanizeCount } from './liveEngageConfig';
import { useEngageSelector, selLikesTotal, selQaSupported, selQaUnseen } from './liveEngageStore';

export const LiveLikesChip = memo(function LiveLikesChip({ engage, style }) {
  const { t } = useLanguage();
  const total = useEngageSelector(engage, selLikesTotal);
  const scale = useRef(new Animated.Value(1)).current;
  const prev = useRef(total);
  useEffect(() => {
    if (total != null && prev.current != null && total > prev.current) {
      scale.setValue(1.15);
      Animated.spring(scale, { toValue: 1, friction: 5, tension: 220, useNativeDriver: true }).start();
    }
    prev.current = total;
  }, [total, scale]);
  if (total == null || total <= 0) return null;
  return (
    <Animated.View
      style={[styles.likesChip, style, { transform: [{ scale }] }]}
      accessibilityLabel={`${total} ${t('liveEng.likes')}`}
    >
      <IconHeart size={10} color="#fff" />
      <Text style={styles.likesText}>{humanizeCount(total)}</Text>
    </Animated.View>
  );
});

export const LiveQAButton = memo(function LiveQAButton({ engage, style, size = 48, iconSize = 22 }) {
  const { t } = useLanguage();
  const supported = useEngageSelector(engage, selQaSupported);
  const unseen = useEngageSelector(engage, selQaUnseen);
  if (!supported) return null;
  return (
    <TouchableOpacity
      onPress={() => engage?.openSheet('qa')}
      style={[styles.qaBtn, { width: size, height: size, borderRadius: size / 2 }, style]}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={t('liveEng.qaTitle')}
    >
      <IconHelpCircle size={iconSize} color="#fff" />
      {unseen > 0 ? (
        <View style={styles.badge}><Text style={styles.badgeText}>{unseen > 99 ? '99+' : unseen}</Text></View>
      ) : null}
    </TouchableOpacity>
  );
});

/** Faixa do host, logo abaixo da top bar da transmissão. */
export const LiveHostEngageBar = memo(function LiveHostEngageBar({ engage, top, side = 'right' }) {
  return (
    <View pointerEvents="box-none" style={[styles.hostBar, { top }, side === 'right' ? styles.hostBarRight : styles.hostBarLeft]}>
      <LiveLikesChip engage={engage} style={styles.hostLikes} />
      <LiveTopFansStack engage={engage} size={24} />
      <LiveQAButton engage={engage} size={36} iconSize={18} />
    </View>
  );
});

function LiveEngageLayer({ engage, isHost = false, topInset = 0, cardTop }) {
  const H = Dimensions.get('window').height;
  return (
    <>
      <LiveQAHighlightCard engage={engage} isHost={isHost} top={cardTop != null ? cardTop : topInset + 64} />
      {LIVE_GIFTS_ENABLED ? <LiveGiftBanners engage={engage} top={Math.round(H * 0.36)} /> : null}
      {LIVE_GIFTS_ENABLED ? <LiveGiftFullscreen engage={engage} /> : null}
      <LiveTopFansSheet engage={engage} />
      <LiveQASheet engage={engage} isHost={isHost} />
      {LIVE_GIFTS_ENABLED && !isHost ? <LiveGiftSheet engage={engage} /> : null}
    </>
  );
}

export default memo(LiveEngageLayer);

const styles = StyleSheet.create({
  likesChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 2,
    backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  },
  likesText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  qaBtn: {
    backgroundColor: 'rgba(0,0,0,0.45)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)' } : {}),
  },
  badge: {
    position: 'absolute', top: -2, right: -2, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4,
    backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: '#000',
  },
  badgeText: { color: '#000', fontSize: 10, fontWeight: '900' },
  hostBar: { position: 'absolute', zIndex: 26, flexDirection: 'row', alignItems: 'center', gap: 8 },
  hostBarRight: { right: 12, flexDirection: 'row-reverse' },
  hostBarLeft: { left: 12 },
  hostLikes: { height: 28, paddingHorizontal: 10, borderRadius: 14 },
});
