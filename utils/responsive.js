// responsive.js — escala adaptável pra TODOS os tamanhos de celular.
//
// [2026-06-14] Motivação: amigo do founder baixou o app num celular MENOR e o
// teclado/layout quebrava — fontes e espaçamentos fixos não cabiam. Aqui
// centralizamos um fator de escala baseado na MENOR dimensão da tela (largura
// em retrato), com a base no iPhone padrão (375pt). O tema (FontSize/Spacing)
// multiplica seus valores por esse fator → o app inteiro encolhe um tiquinho
// em telas pequenas e cresce em telas grandes, sem reescrever cada tela.
//
// Regras de segurança:
//  - CLAMP forte [0.85, 1.15]: nunca deixa a UI minúscula nem gigante.
//  - Web NÃO escala por aqui (fator 1) — no desktop a janela é larga e isso
//    inflaria tudo; o web já tem layout responsivo próprio (2 colunas etc.).
//  - Tablet (>=768) fica no teto do clamp (1.15), não vira fonte gigante.
import { Dimensions, Platform, PixelRatio, useWindowDimensions } from 'react-native';

const BASE_WIDTH = 375; // iPhone X/11/12/13/14 logical width — nosso baseline de design

// Fator calculado uma vez no load do módulo (pra StyleSheet estático). A tela
// física de um celular não muda de tamanho, então é seguro memoizar; rotação é
// tratada pelos componentes que usam o hook useResponsive().
function computeScale(width, height, isWeb) {
  if (isWeb) return 1; // web tem responsividade própria
  const shortest = Math.min(width || BASE_WIDTH, height || BASE_WIDTH);
  const raw = shortest / BASE_WIDTH;
  return Math.max(0.85, Math.min(raw, 1.15));
}

const _win = Dimensions.get('window');
const IS_WEB = Platform.OS === 'web';
export const SCALE = computeScale(_win.width, _win.height, IS_WEB);

// Largura/altura atuais (snapshot no load) — úteis pra breakpoints estáticos.
export const SCREEN_WIDTH = _win.width;
export const SCREEN_HEIGHT = _win.height;

// Breakpoints (snapshot). Pra valores reativos use useResponsive().
export const isSmallDevice = !IS_WEB && Math.min(_win.width, _win.height) < 360;
export const isTablet = Math.min(_win.width, _win.height) >= 768;

// scaleSize: escala um tamanho fixo (fonte, padding, ícone) pro tamanho da tela.
// Arredonda pro pixel físico mais próximo pra evitar texto borrado.
export function scaleSize(size) {
  if (typeof size !== 'number' || !isFinite(size)) return size;
  return PixelRatio.roundToNearestPixel(size * SCALE);
}

// moderateScale: escala PARCIAL (factor 0..1). Útil quando você quer que algo
// acompanhe a tela, mas com menos intensidade que a fonte (ex.: margens).
export function moderateScale(size, factor = 0.5) {
  if (typeof size !== 'number' || !isFinite(size)) return size;
  return PixelRatio.roundToNearestPixel(size + (size * SCALE - size) * factor);
}

// Hook reativo — re-renderiza em rotação / split-view / resize de janela.
// Retorna breakpoints + um scale() já calculado pra largura atual.
export function useResponsive() {
  const { width, height } = useWindowDimensions();
  const scale = computeScale(width, height, IS_WEB);
  const shortest = Math.min(width, height);
  return {
    width,
    height,
    scale,
    isSmall: !IS_WEB && shortest < 360,
    isMedium: shortest >= 360 && shortest < 414,
    isLarge: shortest >= 414 && shortest < 768,
    isTablet: shortest >= 768,
    isLandscape: width > height,
    // helper pra escalar dentro do componente (reativo)
    s: (n) => (typeof n === 'number' ? PixelRatio.roundToNearestPixel(n * scale) : n),
  };
}
