// [status-rever 2026-10-14] Anel de status em volta de um avatar (lista de
// conversas, cabeçalho, perfil) — padrão WhatsApp: um segmento por status;
// NÃO visto = traço grosso em destaque (branco no escuro, preto no claro),
// visto = traço fino cinza. Só desenho (pointerEvents none): quem chama
// decide o toque (avatar abre o status, linha abre a conversa).
import React from 'react';
import { View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import { THEME_V2, statusRingStops } from '../../constants/theme';

// [2026-10-20 grafite] não visto = anel prateado (gradiente grafite↔prata).
const _OFFS = [0, 0.3, 0.55, 0.78, 1];

// inset = margem do avatar dentro do contêiner (o anel centraliza nele).
export default function AvatarStatusRing({ size, ring, isDark, gap = 3, inset = 0, testID = 'avatar-status-ring' }) {
  if (!ring || !(ring.count > 0)) return null;
  const outer = size + gap * 2 + 4;
  const sw = 2.5;
  const r = (outer - sw) / 2;
  const C = 2 * Math.PI * r;
  const n = Math.max(1, Math.min(ring.count, 30));
  const viewed = Array.from({ length: n }, (_, i) => (ring.viewed ? !!ring.viewed[i] : !!ring.allViewed));
  // [2026-10-21 pitada-azul] não visto = azul claro → azul mais escuro (kill → prateado).
  const _stops = THEME_V2 ? statusRingStops(isDark) : null;
  const _gid = THEME_V2 ? `asr_v2${isDark ? 'd' : 'l'}${String(_stops[0] || '').replace(/[^0-9a-z]/gi, '')}_${Math.round(outer)}` : null;
  const hot = _gid ? `url(#${_gid})` : (isDark ? '#FFFFFF' : '#111111');
  const cold = isDark ? 'rgba(255,255,255,0.32)' : 'rgba(0,0,0,0.25)';
  const gapLen = n > 1 ? Math.min(C * 0.04, 6) : 0;
  const seg = C / n - gapLen;
  return (
    <View pointerEvents="none" testID={testID}
      style={{ position: 'absolute', top: inset - (gap + 2), left: inset - (gap + 2), width: outer, height: outer }}>
      <Svg width={outer} height={outer} style={{ transform: [{ rotate: '-90deg' }] }}>
        {_gid ? (
          <Defs>
            <LinearGradient id={_gid} x1="0" y1="1" x2="1" y2="0">
              {_stops.map((c, i) => <Stop key={i} offset={String(_OFFS[i])} stopColor={c} />)}
            </LinearGradient>
          </Defs>
        ) : null}
        {viewed.map((v, i) => (
          <Circle
            key={i}
            cx={outer / 2} cy={outer / 2} r={r}
            fill="none"
            stroke={v ? cold : hot}
            strokeWidth={v ? 1.5 : sw}
            strokeDasharray={n > 1 ? `${seg} ${C - seg}` : undefined}
            strokeDashoffset={n > 1 ? -(i * (seg + gapLen)) : undefined}
            strokeLinecap={n > 1 ? 'round' : 'butt'}
          />
        ))}
      </Svg>
    </View>
  );
}
