// components/chat/argb.js — [2026-10-15 native-list fase 2]
// Cor CSS → ARGB 32-bit (número) p/ a lista nativa (sem import circular).
// ARGB 32-bit (número) — o nativo não precisa interpretar strings CSS.
const _colorMemo = new Map();
export function toArgb(c, fallback = 0xff000000) {
  if (typeof c === 'number' && Number.isFinite(c)) return c >>> 0;
  if (typeof c !== 'string' || !c) return fallback >>> 0;
  const hit = _colorMemo.get(c);
  if (hit !== undefined) return hit;
  let out = fallback >>> 0;
  const s = c.trim().toLowerCase();
  try {
    if (s[0] === '#') {
      let h = s.slice(1);
      if (h.length === 3 || h.length === 4) h = h.split('').map(x => x + x).join('');
      if (h.length === 6) out = (0xff000000 | parseInt(h, 16)) >>> 0;
      else if (h.length === 8) { // CSS #rrggbbaa
        const rgb = parseInt(h.slice(0, 6), 16);
        const a = parseInt(h.slice(6, 8), 16);
        out = ((a << 24) | rgb) >>> 0;
      }
    } else {
      const m = s.match(/^rgba?\(([^)]+)\)$/);
      if (m) {
        const p = m[1].split(',').map(x => x.trim());
        const r = Math.max(0, Math.min(255, Math.round(parseFloat(p[0]) || 0)));
        const g = Math.max(0, Math.min(255, Math.round(parseFloat(p[1]) || 0)));
        const b = Math.max(0, Math.min(255, Math.round(parseFloat(p[2]) || 0)));
        const a = p.length > 3 ? Math.max(0, Math.min(1, parseFloat(p[3]))) : 1;
        out = ((Math.round((Number.isFinite(a) ? a : 1) * 255) << 24) | (r << 16) | (g << 8) | b) >>> 0;
      } else if (s === 'transparent') out = 0;
      else if (s === 'white') out = 0xffffffff;
      else if (s === 'black') out = 0xff000000;
    }
  } catch {}
  if (_colorMemo.size > 500) _colorMemo.clear();
  _colorMemo.set(c, out);
  return out;
}
