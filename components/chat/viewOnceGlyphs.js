// components/chat/viewOnceGlyphs.js — [2026-10-21 view-once ícone WA]
//
// Glifos da "Visualização única" como paths SVG crus (viewBox 24), SEM
// componente React: a lista nativa recebe pelo iconPaths() (nada de chamar
// componente fora do render) e o JS/web desenha os MESMOS paths com
// react-native-svg (ViewOnceMessage). Visual WhatsApp:
//   • 'one'    → "1" dentro de círculo TRACEJADO (enviada não aberta / recebida não aberta)
//   • 'opened' → círculo cheio-contorno com ✓ (Aberta / expirada)
//   • ring(p)  → anel de progresso do envio (trilho + arco a partir do topo)
// Puro (sem import de RN) → testável no node.

const CX = 12; const CY = 12; const R = 9.25;
const _f = (n) => Math.round(n * 100) / 100;
function _pt(deg, r = R) {
  const a = (deg - 90) * Math.PI / 180; // 0° = topo, sentido horário
  return [_f(CX + r * Math.cos(a)), _f(CY + r * Math.sin(a))];
}
function _arc(d0, d1, r = R) {
  const [x0, y0] = _pt(d0, r); const [x1, y1] = _pt(d1, r);
  const large = (d1 - d0) > 180 ? 1 : 0;
  return `M${x0} ${y0}A${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}

// Círculo tracejado: 10 traços de 24° com folga de 12° (começa levemente
// girado p/ não ter traço cortado no topo, como o do WhatsApp).
const DASHED = (() => {
  let d = '';
  for (let i = 0; i < 10; i++) { const a = i * 36 + 6; d += _arc(a, a + 24); }
  return d;
})();
const FULL = `M${CX - R} ${CY}A${R} ${R} 0 1 0 ${CX + R} ${CY}A${R} ${R} 0 1 0 ${CX - R} ${CY}Z`;
const ONE = 'M10.1 9.35L12.45 7.8V16.3';
const CHECK = 'M8.3 12.35L10.8 14.85L15.75 9.6';

/** Paths do glifo (cores CSS) p/ iconPaths() / react-native-svg. */
export function viewOncePaths(kind, color, w = 1.8) {
  if (kind === 'opened') return [{ d: FULL, k: color, w }, { d: CHECK, k: color, w }];
  return [{ d: DASHED, k: color, w }, { d: ONE, k: color, w: w + 0.2 }];
}

/** Anel de progresso (0..1). trackColor = trilho translúcido. */
export function viewOnceRingPaths(p, color, trackColor, w = 2.2) {
  const v = Math.max(0, Math.min(1, Number(p) || 0));
  const out = [{ d: FULL, k: trackColor, w }];
  if (v >= 0.995) out.push({ d: FULL, k: color, w });
  else if (v > 0.01) out.push({ d: _arc(0, v * 360), k: color, w });
  out.push({ d: ONE, k: color, w: 1.9 }); // "1" no miolo: anel nunca fica vazio
  return out;
}

/**
 * Estado visual da bolha view-once (fonte única p/ nativo e JS).
 *   own: 'sending' | 'sent' | 'opened'   ·   recebida: 'unopened' | 'opened'
 *   pct: 0..1 ou null (indeterminado) quando 'sending'.
 */
export function viewOnceState(m, own, locked, anyViewed) {
  if (!m) return { st: own ? 'sent' : 'unopened', pct: null };
  if (own) {
    const tmp = typeof m.id === 'string' && m.id.startsWith('tmp');
    const sending = !m._failed && (m._uploading || m._compressing || ((m._pending || m._queued) && tmp));
    if (sending) {
      const raw = Number(m._uploadPct);
      return { st: 'sending', pct: Number.isFinite(raw) ? Math.max(0, Math.min(1, raw / 100)) : null };
    }
    return { st: (anyViewed || m.expired_at) ? 'opened' : 'sent', pct: null };
  }
  return { st: locked ? 'opened' : 'unopened', pct: null };
}
