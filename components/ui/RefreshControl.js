// RefreshControl — pull-to-refresh P&B do design system (2026-10-16 motion).
//
// Drop-in do RefreshControl do RN (mesmas props; todas repassadas, incl. os
// filhos que o ScrollView injeta no Android). O que muda:
//   • cor única P&B: spinner iOS = textSecondary; Android = tinta (ink) sobre
//     superfície elevada — nada de verde/azul por tela;
//   • toque "soft" quando o usuário ARMA o refresh (Telegram/iOS), via
//     feedback.event('refresh') — respeita "Vibração ao tocar". `haptic={false}`
//     desliga; kill switch OTA: globalThis.__chatyy_motion_refresh_haptic = false.
// Props explícitas de cor (tintColor/colors/progressBackgroundColor) vencem.
//
//   import { RefreshControl } from '../components/ui';
//   <ScrollView refreshControl={<RefreshControl refreshing={r} onRefresh={load} />} />
import React, { useCallback } from 'react';
import { RefreshControl as RNRefreshControl } from 'react-native';
import { feedback } from '../../constants/motion';
import useSurface from './useSurface';

export default function RefreshControl({ onRefresh, haptic = true, tintColor, colors, progressBackgroundColor, ...rest }) {
  const s = useSurface();
  const handleRefresh = useCallback((...args) => {
    if (haptic) {
      let on = true;
      try { if (globalThis.__chatyy_motion_refresh_haptic === false) on = false; } catch {}
      if (on) feedback.event('refresh');
    }
    return onRefresh?.(...args);
  }, [onRefresh, haptic]);
  return (
    <RNRefreshControl
      {...rest}
      onRefresh={onRefresh ? handleRefresh : undefined}
      tintColor={tintColor || s.textSecondary}
      colors={colors || [s.ink]}
      progressBackgroundColor={progressBackgroundColor || s.surfaceRaised}
    />
  );
}
