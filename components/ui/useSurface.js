// useSurface — tokens de superfície do tema ativo (claro/escuro), memoizados.
// const s = useSurface(); s.bg, s.surface, s.separator, s.text, s.textSecondary…
import { useMemo } from 'react';
import { useTheme } from '../../context/ThemeContext';
import { surfaceColors } from '../../constants/theme';

export default function useSurface() {
  const { colors, isDark } = useTheme() || {};
  return useMemo(() => ({ ...surfaceColors(colors, !!isDark), isDark: !!isDark }), [colors, isDark]);
}
