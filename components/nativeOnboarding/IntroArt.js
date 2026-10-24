// [2026-10-24 intro-v2] Ilustrações próprias (SVG, sem emoji, sem imagens de
// terceiros) do carrossel de boas-vindas. Monocromáticas na tinta do tema
// (fg) sobre o papel (bg) → funcionam no claro e no escuro sem paleta extra,
// no mesmo P&B da marca. Cada arte desenha num quadro 240×240 (viewBox) e
// escala para `size`. Só a 1ª (Chatyy) usa o ícone real do app
// (assets/icon.png) por cima do SVG.
import React from 'react';
import { View, Image, StyleSheet } from 'react-native';
import Svg, { Defs, RadialGradient, LinearGradient, Stop, Rect, Circle, Path, G, Text as SvgText } from 'react-native-svg';

const APP_ICON = require('../../assets/icon.png');

// Luminância simples p/ saber se o papel é escuro (cartões ganham outro tom).
function isDarkColor(c) {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(c || '').trim());
  if (!m) return false;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  const n = parseInt(h, 16);
  const r = (n >> 16) & 255; const g = (n >> 8) & 255; const b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 110;
}

function palette(fg, bg) {
  const dark = isDarkColor(bg);
  return {
    ink: fg,
    paper: bg,
    card: dark ? '#1C1C1E' : '#FFFFFF',
    line: fg,
    dark,
  };
}

// Fundo comum: halo radial suave + anel fino (profundidade sem cor).
function Backdrop({ id, p }) {
  return (
    <>
      <Defs>
        <RadialGradient id={`${id}-halo`} cx="120" cy="120" r="118" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={p.ink} stopOpacity={p.dark ? 0.16 : 0.09} />
          <Stop offset="0.7" stopColor={p.ink} stopOpacity={p.dark ? 0.05 : 0.03} />
          <Stop offset="1" stopColor={p.ink} stopOpacity="0" />
        </RadialGradient>
        <LinearGradient id={`${id}-inkg`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={p.ink} stopOpacity="1" />
          <Stop offset="1" stopColor={p.ink} stopOpacity={p.dark ? 0.82 : 0.86} />
        </LinearGradient>
      </Defs>
      <Circle cx="120" cy="120" r="118" fill={`url(#${id}-halo)`} />
      <Circle cx="120" cy="120" r="96" fill="none" stroke={p.ink} strokeOpacity={p.dark ? 0.12 : 0.07} strokeWidth="1" />
      <Circle cx="120" cy="120" r="66" fill="none" stroke={p.ink} strokeOpacity={p.dark ? 0.08 : 0.05} strokeWidth="1" />
    </>
  );
}

// Cartão com "sombra" (um retângulo deslocado em tinta bem clara) + contorno.
function Card({ x, y, w, h, r = 14, p, rotate = 0, children }) {
  const cx = x + w / 2; const cy = y + h / 2;
  return (
    <G transform={rotate ? `rotate(${rotate} ${cx} ${cy})` : undefined}>
      <Rect x={x + 1} y={y + 4} width={w} height={h} rx={r} fill={p.ink} fillOpacity={p.dark ? 0.35 : 0.07} />
      <Rect x={x} y={y} width={w} height={h} rx={r} fill={p.card} stroke={p.ink} strokeOpacity={p.dark ? 0.16 : 0.1} strokeWidth="1" />
      {children}
    </G>
  );
}

function Mountain({ x, y, w, h, p }) {
  // foto genérica: sol + 2 montanhas dentro do retângulo (x,y,w,h)
  return (
    <>
      <Circle cx={x + w * 0.72} cy={y + h * 0.3} r={Math.min(w, h) * 0.11} fill={p.ink} fillOpacity="0.35" />
      <Path d={`M${x} ${y + h} L${x + w * 0.36} ${y + h * 0.45} L${x + w * 0.62} ${y + h * 0.82} L${x + w * 0.74} ${y + h * 0.66} L${x + w} ${y + h} Z`} fill={p.ink} fillOpacity="0.55" />
    </>
  );
}

// ── 1. Chatyy: ícone real ao centro + balões (texto, foto, áudio, vídeo) ──
function ArtChat({ p }) {
  const id = 'ia1';
  return (
    <>
      <Backdrop id={id} p={p} />
      {/* recebida (texto) */}
      <Card x={20} y={44} w={86} h={38} r={19} p={p} rotate={-4}>
        <Rect x={36} y={56} width={52} height={5} rx={2.5} fill={p.ink} fillOpacity="0.55" />
        <Rect x={36} y={66} width={34} height={5} rx={2.5} fill={p.ink} fillOpacity="0.25" />
      </Card>
      {/* foto */}
      <Card x={150} y={26} w={66} h={58} r={14} p={p} rotate={6}>
        <G>
          <Rect x={156} y={32} width={54} height={46} rx={9} fill={p.ink} fillOpacity="0.08" />
          <Mountain x={156} y={38} w={54} h={40} p={p} />
        </G>
      </Card>
      {/* vídeo */}
      <Card x={22} y={152} w={68} h={50} r={14} p={p} rotate={-7}>
        <Circle cx={56} cy={177} r={13} fill={p.ink} />
        <Path d="M52 170.5 L62.5 177 L52 183.5 Z" fill={p.paper} />
      </Card>
      {/* áudio (enviada = tinta cheia) */}
      <G transform="rotate(4 186 174)">
        <Rect x={143} y={159} width={88} height={34} rx={17} fill={p.ink} fillOpacity={p.dark ? 0.35 : 0.08} transform="translate(1 4)" />
        <Rect x={143} y={159} width={88} height={34} rx={17} fill={`url(#${id}-inkg)`} />
        <Path d="M156 170 L164 176 L156 182 Z" fill={p.paper} />
        {[5, 11, 7, 14, 9, 12, 6, 10, 4].map((hh, i) => (
          <Rect key={i} x={171 + i * 6} y={176 - hh / 2} width={3} height={hh} rx={1.5} fill={p.paper} fillOpacity={i < 4 ? 1 : 0.5} />
        ))}
      </G>
      {/* faíscas */}
      <Circle cx={120} cy={22} r={3} fill={p.ink} fillOpacity="0.3" />
      <Circle cx={212} cy={118} r={2.5} fill={p.ink} fillOpacity="0.25" />
      <Circle cx={30} cy={118} r={2} fill={p.ink} fillOpacity="0.25" />
    </>
  );
}

// ── 2. Privacidade: escudo com cadeado protegendo uma conversa e uma foto ──
function ArtPrivacy({ p }) {
  const id = 'ia2';
  return (
    <>
      <Backdrop id={id} p={p} />
      <Card x={30} y={70} w={70} h={88} r={14} p={p} rotate={-12}>
        <Rect x={37} y={77} width={56} height={56} rx={9} fill={p.ink} fillOpacity="0.08" />
        <Mountain x={37} y={89} w={56} h={44} p={p} />
        <Rect x={38} y={141} width={36} height={5} rx={2.5} fill={p.ink} fillOpacity="0.25" />
      </Card>
      <Card x={142} y={64} w={74} h={40} r={20} p={p} rotate={10}>
        <Rect x={157} y={77} width={44} height={5} rx={2.5} fill={p.ink} fillOpacity="0.5" />
        <Rect x={157} y={87} width={28} height={5} rx={2.5} fill={p.ink} fillOpacity="0.22" />
      </Card>
      <Card x={146} y={150} w={64} h={34} r={17} p={p} rotate={-6}>
        {[0, 1, 2, 3, 4].map((i) => <Circle key={i} cx={161 + i * 9} cy={167} r={2.6} fill={p.ink} fillOpacity="0.55" />)}
      </Card>
      {/* escudo */}
      <Path d="M120 46 L170 64 V114 C170 148 148 172 120 186 C92 172 70 148 70 114 V64 Z" fill={p.ink} fillOpacity={p.dark ? 0.35 : 0.08} transform="translate(1 5)" />
      <Path d="M120 46 L170 64 V114 C170 148 148 172 120 186 C92 172 70 148 70 114 V64 Z" fill={`url(#${id}-inkg)`} />
      <Path d="M120 58 L160 72.5 V114 C160 141 143 160 120 172.5" fill="none" stroke={p.paper} strokeOpacity="0.18" strokeWidth="2" strokeLinecap="round" />
      {/* cadeado */}
      <Path d="M106 112 V102 a14 14 0 0 1 28 0 V112" fill="none" stroke={p.paper} strokeWidth="6" strokeLinecap="round" />
      <Rect x={98} y={110} width={44} height={36} rx={9} fill={p.paper} />
      <Circle cx={120} cy={124} r={4.5} fill={p.ink} />
      <Rect x={118} y={126} width={4} height={10} rx={2} fill={p.ink} />
      <Circle cx={120} cy={24} r={3} fill={p.ink} fillOpacity="0.3" />
      <Circle cx={216} cy={124} r={2.5} fill={p.ink} fillOpacity="0.25" />
    </>
  );
}

// ── 3. Chamadas: tela de ligação + grade de grupo + ondas de som ──
function ArtCalls({ p }) {
  const id = 'ia3';
  return (
    <>
      <Backdrop id={id} p={p} />
      {/* grupo (atrás) */}
      <Card x={128} y={56} w={92} h={92} r={18} p={p} rotate={8}>
        {[[0, 0], [1, 0], [0, 1], [1, 1]].map(([cx, cy], i) => (
          <G key={i}>
            <Rect x={135 + cx * 40} y={63 + cy * 40} width={36} height={36} rx={9} fill={p.ink} fillOpacity={0.07 + i * 0.03} />
            <Circle cx={153 + cx * 40} cy={77 + cy * 40} r={6} fill={p.ink} fillOpacity="0.45" />
            <Path d={`M${143 + cx * 40} ${96 + cy * 40} a10 8 0 0 1 20 0`} fill={p.ink} fillOpacity="0.45" />
          </G>
        ))}
      </Card>
      {/* aparelho */}
      <Rect x={53} y={42} width={92} height={160} rx={22} fill={p.ink} fillOpacity={p.dark ? 0.35 : 0.08} transform="translate(1 5)" />
      <Rect x={53} y={42} width={92} height={160} rx={22} fill={`url(#${id}-inkg)`} />
      <Rect x={86} y={50} width={26} height={5} rx={2.5} fill={p.paper} fillOpacity="0.25" />
      <Circle cx={99} cy={96} r={22} fill={p.paper} fillOpacity="0.16" />
      <Circle cx={99} cy={90} r={8} fill={p.paper} fillOpacity="0.85" />
      <Path d="M85 110 a14 11 0 0 1 28 0" fill={p.paper} fillOpacity="0.85" />
      <Rect x={79} y={126} width={40} height={5} rx={2.5} fill={p.paper} fillOpacity="0.6" />
      <Rect x={87} y={136} width={24} height={4} rx={2} fill={p.paper} fillOpacity="0.3" />
      {/* botões */}
      <Circle cx={75} cy={176} r={10} fill={p.paper} fillOpacity="0.18" />
      <Path d="M71 172 h5 l5 -4 v16 l-5 -4 h-5 z" fill={p.paper} fillOpacity="0.9" />
      <Circle cx={99} cy={176} r={10} fill={p.paper} fillOpacity="0.18" />
      <Rect x={92.5} y={171.5} width={10} height={9} rx={2} fill={p.paper} fillOpacity="0.9" />
      <Path d="M103 174.5 l4 -2.5 v8 l-4 -2.5 z" fill={p.paper} fillOpacity="0.9" />
      <Circle cx={123} cy={176} r={10} fill={p.paper} />
      <Path d="M116.5 177.5 c4 -4 9 -4 13 0 l-1.8 2.4 l-2.8 -1.3 v-2 c-1.3 -.5 -2.8 -.5 -4 0 v2 l-2.8 1.3 z" fill={p.ink} />
      {/* ondas */}
      <Path d="M36 104 a28 28 0 0 0 0 40" fill="none" stroke={p.ink} strokeOpacity="0.35" strokeWidth="3" strokeLinecap="round" />
      <Path d="M26 94 a42 42 0 0 0 0 60" fill="none" stroke={p.ink} strokeOpacity="0.18" strokeWidth="3" strokeLinecap="round" />
      <Card x={150} y={160} w={64} h={30} r={15} p={p} rotate={-5}>
        {[6, 12, 8, 14, 7, 11, 5].map((hh, i) => <Rect key={i} x={163 + i * 6} y={175 - hh / 2} width={3} height={hh} rx={1.5} fill={p.ink} fillOpacity="0.55" />)}
      </Card>
    </>
  );
}

// ── 4. E-mail: envelope com carta + selo "@" + endereço @chatyy.app ──
function ArtMail({ p }) {
  const id = 'ia4';
  return (
    <>
      <Backdrop id={id} p={p} />
      {/* carta saindo */}
      <Card x={70} y={40} w={100} h={92} r={10} p={p} rotate={-3}>
        <Rect x={84} y={56} width={48} height={6} rx={3} fill={p.ink} fillOpacity="0.55" />
        <Rect x={84} y={70} width={72} height={5} rx={2.5} fill={p.ink} fillOpacity="0.2" />
        <Rect x={84} y={81} width={64} height={5} rx={2.5} fill={p.ink} fillOpacity="0.2" />
        <Rect x={84} y={92} width={70} height={5} rx={2.5} fill={p.ink} fillOpacity="0.2" />
      </Card>
      {/* envelope */}
      <Rect x={44} y={96} width={152} height={98} rx={16} fill={p.ink} fillOpacity={p.dark ? 0.35 : 0.08} transform="translate(1 5)" />
      <Rect x={44} y={96} width={152} height={98} rx={16} fill={`url(#${id}-inkg)`} />
      <Path d="M48 104 L120 152 L192 104" fill="none" stroke={p.paper} strokeOpacity="0.55" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
      <Path d="M50 188 L102 142 M190 188 L138 142" stroke={p.paper} strokeOpacity="0.22" strokeWidth="2.5" strokeLinecap="round" />
      {/* selo @ */}
      <Circle cx={190} cy={92} r={24} fill={p.ink} fillOpacity={p.dark ? 0.35 : 0.08} transform="translate(1 4)" />
      <Circle cx={190} cy={92} r={24} fill={p.card} stroke={p.ink} strokeOpacity="0.14" />
      <Circle cx={190} cy={92} r={6.5} fill="none" stroke={p.ink} strokeWidth="3.4" />
      <Path d="M196.5 92 v3 a4.5 4.5 0 0 0 9 0 v-3 a15.5 15.5 0 1 0 -6 12.2" fill="none" stroke={p.ink} strokeWidth="3.4" strokeLinecap="round" />
      {/* endereço */}
      <Card x={58} y={204} w={124} h={26} r={13} p={p}>
        <SvgText x={120} y={221.5} fontSize="12" fontWeight="700" fill={p.ink} textAnchor="middle">@chatyy.app</SvgText>
      </Card>
      <Circle cx={34} cy={70} r={3} fill={p.ink} fillOpacity="0.3" />
      <Circle cx={214} cy={150} r={2.5} fill={p.ink} fillOpacity="0.25" />
    </>
  );
}

// ── 5. Nuvem: fotos/arquivos subindo para a nuvem com selo de ok ──
function ArtCloud({ p }) {
  const id = 'ia5';
  const CLOUD = 'M78 150 a32 32 0 0 1 6 -63 a44 44 0 0 1 84 -6 a36 36 0 0 1 4 69 z';
  return (
    <>
      <Backdrop id={id} p={p} />
      <Path d={CLOUD} fill={p.ink} fillOpacity={p.dark ? 0.35 : 0.08} transform="translate(1 5)" />
      <Path d={CLOUD} fill={`url(#${id}-inkg)`} />
      {/* seta para cima */}
      <Path d="M126 132 V96 M111 110 L126 95 L141 110" fill="none" stroke={p.paper} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      {/* cartões: foto, documento, vídeo */}
      <Card x={36} y={160} w={56} h={56} r={12} p={p} rotate={-9}>
        <Rect x={42} y={166} width={44} height={44} rx={8} fill={p.ink} fillOpacity="0.08" />
        <Mountain x={42} y={176} w={44} h={34} p={p} />
      </Card>
      <Card x={96} y={166} w={50} h={60} r={10} p={p} rotate={2}>
        <Path d="M128 166 v12 h12" fill="none" stroke={p.ink} strokeOpacity="0.25" strokeWidth="2" />
        <Rect x={105} y={186} width={30} height={4} rx={2} fill={p.ink} fillOpacity="0.45" />
        <Rect x={105} y={195} width={24} height={4} rx={2} fill={p.ink} fillOpacity="0.2" />
        <Rect x={105} y={204} width={28} height={4} rx={2} fill={p.ink} fillOpacity="0.2" />
      </Card>
      <Card x={150} y={158} w={56} h={52} r={12} p={p} rotate={9}>
        <Circle cx={178} cy={184} r={12} fill={p.ink} />
        <Path d="M174.5 178 L184 184 L174.5 190 Z" fill={p.paper} />
      </Card>
      {/* ok */}
      <Circle cx={184} cy={60} r={16} fill={p.card} stroke={p.ink} strokeOpacity="0.14" />
      <Path d="M176.5 60.5 L182 66 L192 55.5" fill="none" stroke={p.ink} strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx={40} cy={64} r={3} fill={p.ink} fillOpacity="0.3" />
      <Circle cx={216} cy={124} r={2.5} fill={p.ink} fillOpacity="0.25" />
    </>
  );
}

const ARTS = { chat: ArtChat, privacy: ArtPrivacy, calls: ArtCalls, mail: ArtMail, cloud: ArtCloud };

export default function IntroArt({ kind, size = 220, fg = '#111111', bg = '#ffffff' }) {
  const Art = ARTS[kind] || ArtChat;
  const p = palette(fg, bg);
  const icon = Math.round(size * 0.36);
  return (
    <View style={{ width: size, height: size, direction: 'ltr' }} accessible={false} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <Svg width={size} height={size} viewBox="0 0 240 240" fill="none">
        <Art p={p} />
      </Svg>
      {kind === 'chat' ? (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, st.center]}>
          <View
            style={[
              st.iconShadow,
              {
                width: icon, height: icon, borderRadius: icon * 0.225,
                borderColor: p.dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)',
                shadowColor: '#000', shadowOpacity: p.dark ? 0.5 : 0.18,
              },
            ]}
          >
            <Image source={APP_ICON} style={{ width: icon, height: icon, borderRadius: icon * 0.225 }} resizeMode="cover" />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  iconShadow: { borderWidth: 1, overflow: 'visible', backgroundColor: '#fff', shadowOffset: { width: 0, height: 10 }, shadowRadius: 22, elevation: 10 },
});
