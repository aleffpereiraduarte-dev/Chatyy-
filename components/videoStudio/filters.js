// [2026-10-13 video-studio] Filtros: prévia APROXIMADA (camadas de cor com
// mixBlendMode por cima do vídeo). O resultado fiel vem do render do servidor,
// que aplica o mesmo id (edl.filter.id) com ffmpeg.
//
// Android: o VideoView precisa de surfaceType="textureView" para as camadas
// misturarem com o vídeo (SurfaceView fica "atrás" da janela).
import React from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { FILTER_IDS } from '../../services/videoStudio/edl';

// layers: [{ color, blend, alpha }] — alpha é multiplicado pela intensidade.
const DEFS = {
  none: { labelKey: 'studio.filter.none', layers: [] },
  mono: { labelKey: 'studio.filter.mono', layers: [{ color: '#808080', blend: 'saturation', alpha: 1 }] },
  noir: { labelKey: 'studio.filter.noir', layers: [{ color: '#808080', blend: 'saturation', alpha: 1 }, { color: '#000000', blend: 'soft-light', alpha: 0.45 }, { color: '#000000', blend: 'normal', alpha: 0.08 }] },
  warm: { labelKey: 'studio.filter.warm', layers: [{ color: '#FF9A3C', blend: 'soft-light', alpha: 0.45 }, { color: '#FFB066', blend: 'normal', alpha: 0.05 }] },
  cool: { labelKey: 'studio.filter.cool', layers: [{ color: '#3C8DFF', blend: 'soft-light', alpha: 0.45 }, { color: '#9CC3FF', blend: 'normal', alpha: 0.04 }] },
  vivid: { labelKey: 'studio.filter.vivid', layers: [{ color: '#7F7F7F', blend: 'overlay', alpha: 0.35 }, { color: '#FF3B6B', blend: 'soft-light', alpha: 0.12 }] },
  fade: { labelKey: 'studio.filter.fade', layers: [{ color: '#808080', blend: 'saturation', alpha: 0.35 }, { color: '#FFFFFF', blend: 'normal', alpha: 0.16 }] },
};

export const FILTERS = FILTER_IDS.map((id) => ({ id, labelKey: (DEFS[id] || {}).labelKey || 'studio.filter.none' }));

export function filterLabelKey(id) { return (DEFS[id] || DEFS.none).labelKey; }

// mixBlendMode só existe na Nova Arquitetura (iOS + Android 10+). No web o
// CSS mix-blend-mode equivalente funciona.
const BLEND_OK = Platform.OS === 'web' || Platform.OS === 'ios' || (Platform.OS === 'android' && Platform.Version >= 29);

export function FilterLayer({ id, intensity = 1, style }) {
  const def = DEFS[id];
  if (!def || !def.layers.length) return null;
  const k = Math.max(0, Math.min(1, Number(intensity) || 0));
  if (k <= 0) return null;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      {def.layers.map((l, i) => {
        if (l.blend !== 'normal' && !BLEND_OK) {
          // Sem blend: só um véu leve da cor (melhor que nada).
          if (l.blend === 'saturation') return <View key={i} style={[StyleSheet.absoluteFill, { backgroundColor: '#7a7a7a', opacity: 0.25 * k }]} />;
          return <View key={i} style={[StyleSheet.absoluteFill, { backgroundColor: l.color, opacity: 0.12 * k }]} />;
        }
        return (
          <View
            key={i}
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: l.color, opacity: l.alpha * k },
              l.blend !== 'normal' ? { mixBlendMode: l.blend } : null,
            ]}
          />
        );
      })}
    </View>
  );
}

export default FilterLayer;
