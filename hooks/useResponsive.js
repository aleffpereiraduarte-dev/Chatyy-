// hooks/useResponsive.js — ponto de entrada ÚNICO de responsividade.
//
// A implementação real vive em utils/responsive.js (histórica, usada pela
// escala de fonte estática). Este arquivo re-exporta tudo pra que telas novas
// importem do lugar "esperado" (hooks/) sem duplicar lógica:
//
//   import { useResponsive } from '../hooks/useResponsive';
//   const { width, isTablet, isDesktop, isLandscape, contentMaxWidth } = useResponsive();
//
// E pra StyleSheet estático (snapshot no load):
//   import { isTablet, CONTENT_MAX_WIDTH } from '../hooks/useResponsive';
//
// Padrão pra centralizar uma superfície rolável em tablet/desktop/web sem
// ramificar por plataforma — em telefone contentMaxWidth === width (sem corte):
//   contentContainerStyle={{ maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' }}
export {
  useResponsive,
  isTablet,
  isDesktop,
  isSmallDevice,
  computeContentMaxWidth,
  CONTENT_MAX_WIDTH,
  SCALE,
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  scaleSize,
  moderateScale,
} from '../utils/responsive';

export { useResponsive as default } from '../utils/responsive';
