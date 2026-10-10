/**
 * LiveGiftGlyph — arte dos presentes da live em SVG puro (sem emoji, sem
 * imagem remota). Linguagem P&B premium: prata/branco com contorno grafite,
 * brilho especular sutil. Mesma arte no sheet, nos banners e na animação de
 * tela cheia (escala vetorial).
 */
import { memo } from 'react';
import Svg, {
  Defs, LinearGradient, RadialGradient, Stop, Path, Circle, Polygon, Ellipse, G,
} from 'react-native-svg';

const INK = '#1a1a1a';

function Grad({ id }) {
  return (
    <Defs>
      <LinearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1">
        <Stop offset="0" stopColor="#ffffff" />
        <Stop offset="0.55" stopColor="#d9d9d9" />
        <Stop offset="1" stopColor="#8a8a8a" />
      </LinearGradient>
      <RadialGradient id={`${id}g`} cx="0.5" cy="0.5" r="0.5">
        <Stop offset="0" stopColor="#ffffff" stopOpacity="0.9" />
        <Stop offset="1" stopColor="#ffffff" stopOpacity="0" />
      </RadialGradient>
    </Defs>
  );
}

function LiveGiftGlyph({ icon, size = 40 }) {
  const id = 'lg' + String(icon || 'x');
  const fill = `url(#${id}s)`;
  let body;
  switch (icon) {
    case 'rose':
      body = (
        <G>
          <Path d="M24 6c-6 0-10 4-10 10 0 4 2 7 5 9-3 2-5 5-5 9 0 6 4 10 10 10s10-4 10-10c0-4-2-7-5-9 3-2 5-5 5-9 0-6-4-10-10-10Z" fill={fill} stroke={INK} strokeWidth={1.4} />
          <Path d="M24 26c3 0 5-2 5-5s-2-5-5-5-5 2-5 5 2 5 5 5Z" fill="none" stroke={INK} strokeWidth={1.2} />
          <Path d="M24 44v-4M20 42c-2 0-3-2-3-3" stroke={INK} strokeWidth={1.6} strokeLinecap="round" fill="none" />
        </G>
      );
      break;
    case 'heart':
      body = <Path d="M24 42S10 33 6 24C3 17 7 9 14 9c4 0 7 2 10 6 3-4 6-6 10-6 7 0 11 8 8 15-4 9-18 18-18 18Z" fill={fill} stroke={INK} strokeWidth={1.4} />;
      break;
    case 'star':
      body = <Polygon points="24,4 29.5,17 43,18 32.5,27 36,41 24,33.5 12,41 15.5,27 5,18 18.5,17" fill={fill} stroke={INK} strokeWidth={1.4} strokeLinejoin="round" />;
      break;
    case 'crown':
      body = (
        <G>
          <Path d="M6 16l9 9 9-14 9 14 9-9-4 22H10L6 16Z" fill={fill} stroke={INK} strokeWidth={1.4} strokeLinejoin="round" />
          <Path d="M10 38h28" stroke={INK} strokeWidth={1.4} />
          <Circle cx="6" cy="16" r="2.4" fill="#fff" stroke={INK} strokeWidth={1.2} />
          <Circle cx="42" cy="16" r="2.4" fill="#fff" stroke={INK} strokeWidth={1.2} />
          <Circle cx="24" cy="11" r="2.4" fill="#fff" stroke={INK} strokeWidth={1.2} />
        </G>
      );
      break;
    case 'fire':
      body = (
        <G>
          <Path d="M24 4c2 8 10 10 10 20 0 9-6 16-14 16-7 0-12-5-12-12 0-4 2-6 4-8 0 4 2 6 4 6 0-6 2-12 8-22Z" fill={fill} stroke={INK} strokeWidth={1.4} />
          <Path d="M22 26c2 4 6 4 6 10 0 4-2 6-5 6-4 0-6-2-6-6 0-2 1-4 2-5 0 2 1 3 3 3 0-3-1-5 0-8Z" fill="#fff" stroke={INK} strokeWidth={1.1} />
        </G>
      );
      break;
    case 'rocket':
      body = (
        <G>
          <Path d="M24 4c8 4 12 12 12 20v6l-4 4H16l-4-4v-6c0-8 4-16 12-20Z" fill={fill} stroke={INK} strokeWidth={1.4} />
          <Circle cx="24" cy="18" r="4" fill="#fff" stroke={INK} strokeWidth={1.3} />
          <Path d="M14 34l-6 8 6-2 2 4 2-6M34 34l6 8-6-2-2 4-2-6" fill="#fff" stroke={INK} strokeWidth={1.2} strokeLinejoin="round" />
          <Path d="M21 38c0 3 1 6 3 8 2-2 3-5 3-8" fill="#fff" stroke={INK} strokeWidth={1.1} />
        </G>
      );
      break;
    case 'galaxy':
      body = (
        <G>
          <Circle cx="24" cy="24" r="20" fill={`url(#${id}g)`} />
          <Ellipse cx="24" cy="24" rx="20" ry="7" fill="none" stroke="#fff" strokeWidth={1.6} transform="rotate(-24 24 24)" />
          <Circle cx="24" cy="24" r="9" fill={fill} stroke={INK} strokeWidth={1.4} />
          <Circle cx="9" cy="12" r="1.4" fill="#fff" />
          <Circle cx="39" cy="9" r="1" fill="#fff" />
          <Circle cx="40" cy="37" r="1.4" fill="#fff" />
          <Circle cx="11" cy="38" r="1" fill="#fff" />
        </G>
      );
      break;
    case 'legend':
      body = (
        <G>
          <Circle cx="24" cy="24" r="21" fill={`url(#${id}g)`} />
          <Path d="M24 6l14 8v14c0 8-6 13-14 16-8-3-14-8-14-16V14l14-8Z" fill={fill} stroke={INK} strokeWidth={1.4} strokeLinejoin="round" />
          <Polygon points="24,14 27,21 34,21.5 28.5,26 30.5,33 24,29 17.5,33 19.5,26 14,21.5 21,21" fill="#fff" stroke={INK} strokeWidth={1.1} strokeLinejoin="round" />
        </G>
      );
      break;
    default:
      body = (
        <G>
          <Path d="M8 20h32v22H8z" fill={fill} stroke={INK} strokeWidth={1.4} />
          <Path d="M6 14h36v6H6zM24 14v28" fill="none" stroke={INK} strokeWidth={1.4} />
          <Path d="M24 14c-4-8-12-6-10-1 1 2 6 1 10 1 4 0 9 1 10-1 2-5-6-7-10 1Z" fill="#fff" stroke={INK} strokeWidth={1.2} />
        </G>
      );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Grad id={id} />
      {body}
    </Svg>
  );
}

export default memo(LiveGiftGlyph);
