// [2026-10-09 status-composer] Filtros de status nível Instagram — matemática
// pura (sem React, sem nativo), compartilhada por:
//   • prévia ao vivo no nativo (Skia <ColorMatrix>, GPU);
//   • prévia/exportação no web (canvas 2D, pixel a pixel);
//   • exportação final no nativo (Skia offscreen → JPEG).
//
// Cada filtro é uma matriz de cor 4x5 (20 números, linha a linha, formato do
// Skia: R' = m0·R + m1·G + m2·B + m3·A + m4, com a translação NORMALIZADA em
// 0..1). Os ajustes (brilho, contraste, saturação, calor, desbotar) viram
// matrizes também e são compostos depois do filtro, então prévia e arquivo
// final usam exatamente a mesma conta.
//
// "Inteligente": analyzeStats() resume uma miniatura (luz média, contraste,
// saturação, temperatura) → suggestFilter() escolhe o filtro que mais combina e
// autoEnhance() devolve ajustes de 1 toque (exposição/contraste/cor).

// ─── Álgebra ────────────────────────────────────────────────────────────────
export const IDENTITY = Object.freeze([
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
]);

// compose(a, b) = aplica `a` primeiro e depois `b` (b ∘ a).
export function compose(a, b) {
  const out = new Array(20);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 5; c++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += b[r * 5 + k] * a[k * 5 + c];
      if (c === 4) v += b[r * 5 + 4];
      out[r * 5 + c] = v;
    }
  }
  return out;
}
export function composeAll(list) {
  let m = IDENTITY;
  for (const x of list) if (x) m = compose(m, x);
  return m;
}
// Mistura linear com a identidade — "intensidade" do filtro (0 = original).
export function mix(m, amount) {
  if (amount >= 1) return m;
  if (amount <= 0) return IDENTITY;
  return m.map((v, i) => IDENTITY[i] + (v - IDENTITY[i]) * amount);
}

const LR = 0.2126, LG = 0.7152, LB = 0.0722;
export function saturation(s) {
  const a = 1 - s;
  return [
    LR * a + s, LG * a, LB * a, 0, 0,
    LR * a, LG * a + s, LB * a, 0, 0,
    LR * a, LG * a, LB * a + s, 0, 0,
    0, 0, 0, 1, 0,
  ];
}
export function contrast(c) {
  const o = (1 - c) / 2;
  return [c, 0, 0, 0, o, 0, c, 0, 0, o, 0, 0, c, 0, o, 0, 0, 0, 1, 0];
}
export function exposure(k) { // multiplica (preserva preto)
  return [k, 0, 0, 0, 0, 0, k, 0, 0, 0, 0, 0, k, 0, 0, 0, 0, 0, 1, 0];
}
export function lift(b) { // soma (levanta tudo)
  return [1, 0, 0, 0, b, 0, 1, 0, 0, b, 0, 0, 1, 0, b, 0, 0, 0, 1, 0];
}
export function temperature(w) { // w > 0 quente, w < 0 frio
  return [1, 0, 0, 0, 0.09 * w, 0, 1, 0, 0, 0.02 * w, 0, 0, 1, 0, -0.09 * w, 0, 0, 0, 1, 0];
}
export function tint(r, g, b, amount) { // empurra para uma cor (0..1)
  const k = 1 - amount;
  return [k, 0, 0, 0, r * amount, 0, k, 0, 0, g * amount, 0, 0, k, 0, b * amount, 0, 0, 0, 1, 0];
}
export function fade(f) { // preto vira cinza (look "desbotado")
  const k = 1 - 0.22 * f;
  const o = 0.11 * f;
  return [k, 0, 0, 0, o, 0, k, 0, 0, o, 0, 0, k, 0, o, 0, 0, 0, 1, 0];
}
export function sepia(a) {
  const s = [
    0.393, 0.769, 0.189, 0, 0,
    0.349, 0.686, 0.168, 0, 0,
    0.272, 0.534, 0.131, 0, 0,
    0, 0, 0, 1, 0,
  ];
  return mix(s, a);
}
// Teal & orange (cinema): sombras puxam pro azul-petróleo, luzes pro laranja.
function tealOrange(a) {
  return mix([
    1.08, 0.04, -0.06, 0, -0.02,
    0.00, 1.02, 0.00, 0, 0.00,
    -0.06, 0.04, 0.98, 0, 0.05,
    0, 0, 0, 1, 0,
  ], a);
}

// ─── Catálogo (14) ──────────────────────────────────────────────────────────
// labelKey → i18n (status.filter.<id>). `legacy` mapeia chaves antigas do
// StatusCamera (Clarendon, Moon, …) para o filtro equivalente.
export const STATUS_FILTERS = [
  { id: 'original', labelKey: 'status.filter.original', m: IDENTITY },
  { id: 'claro', labelKey: 'status.filter.claro', m: composeAll([exposure(1.12), lift(0.03), contrast(0.94), saturation(1.06)]) },
  { id: 'vivido', labelKey: 'status.filter.vivido', m: composeAll([contrast(1.14), saturation(1.42), exposure(1.03)]) },
  { id: 'quente', labelKey: 'status.filter.quente', m: composeAll([temperature(0.9), saturation(1.12), contrast(1.04)]) },
  { id: 'frio', labelKey: 'status.filter.frio', m: composeAll([temperature(-0.9), saturation(0.96), contrast(1.06)]) },
  { id: 'dourado', labelKey: 'status.filter.dourado', m: composeAll([temperature(0.55), tint(1, 0.78, 0.45, 0.07), exposure(1.05), saturation(1.1)]) },
  { id: 'cinema', labelKey: 'status.filter.cinema', m: composeAll([tealOrange(1), contrast(1.16), saturation(0.92), fade(0.18)]) },
  { id: 'drama', labelKey: 'status.filter.drama', m: composeAll([contrast(1.35), saturation(0.86), exposure(0.97)]) },
  { id: 'suave', labelKey: 'status.filter.suave', m: composeAll([contrast(0.86), lift(0.03), saturation(0.9), temperature(0.18)]) },
  { id: 'desbotado', labelKey: 'status.filter.desbotado', m: composeAll([fade(0.75), saturation(0.78), contrast(0.94)]) },
  { id: 'vintage', labelKey: 'status.filter.vintage', m: composeAll([sepia(0.32), fade(0.4), contrast(1.06), temperature(0.3), saturation(0.9)]) },
  { id: 'pb', labelKey: 'status.filter.pb', m: composeAll([saturation(0), contrast(1.08)]) },
  { id: 'noir', labelKey: 'status.filter.noir', m: composeAll([saturation(0), contrast(1.5), exposure(0.94)]) },
  { id: 'neblina', labelKey: 'status.filter.neblina', m: composeAll([fade(0.55), temperature(-0.35), saturation(0.82), exposure(1.06)]) },
];
const BY_ID = new Map(STATUS_FILTERS.map(f => [f.id, f]));
const LEGACY = {
  normal: 'original', clarendon: 'vivido', gingham: 'suave', moon: 'pb', lark: 'claro',
  reyes: 'desbotado', juno: 'vivido', slumber: 'vintage', aden: 'suave', valencia: 'quente',
  nashville: 'dourado', perpetua: 'frio', toaster: 'drama', walden: 'claro', hudson: 'frio',
  xpro2: 'cinema', rise: 'dourado', sierra: 'desbotado', inkwell: 'noir', lofi: 'drama',
  earlybird: 'vintage',
};
export function filterById(id) {
  if (!id) return STATUS_FILTERS[0];
  return BY_ID.get(id) || BY_ID.get(LEGACY[id]) || STATUS_FILTERS[0];
}
export function filterIndex(id) {
  const f = filterById(id);
  return Math.max(0, STATUS_FILTERS.indexOf(f));
}

// ─── Ajustes ────────────────────────────────────────────────────────────────
// Faixas -1..1 (fade 0..1). 0 = sem mudança.
export const DEFAULT_ADJUST = Object.freeze({ brightness: 0, contrast: 0, saturation: 0, warmth: 0, fade: 0 });
export const ADJUST_KEYS = [
  { key: 'brightness', labelKey: 'status.adjust.brightness', min: -1, max: 1 },
  { key: 'contrast', labelKey: 'status.adjust.contrast', min: -1, max: 1 },
  { key: 'saturation', labelKey: 'status.adjust.saturation', min: -1, max: 1 },
  { key: 'warmth', labelKey: 'status.adjust.warmth', min: -1, max: 1 },
  { key: 'fade', labelKey: 'status.adjust.fade', min: 0, max: 1 },
];
export function adjustMatrix(adj) {
  const a = adj || DEFAULT_ADJUST;
  const parts = [];
  if (a.brightness) parts.push(exposure(1 + a.brightness * 0.35), lift(a.brightness * 0.04));
  if (a.contrast) parts.push(contrast(1 + a.contrast * 0.45));
  if (a.saturation) parts.push(saturation(Math.max(0, 1 + a.saturation)));
  if (a.warmth) parts.push(temperature(a.warmth));
  if (a.fade) parts.push(fade(a.fade));
  return parts.length ? composeAll(parts) : IDENTITY;
}
export function isNeutralAdjust(adj) {
  if (!adj) return true;
  return !adj.brightness && !adj.contrast && !adj.saturation && !adj.warmth && !adj.fade;
}
// Matriz final = filtro (com intensidade) → ajustes.
export function finalMatrix(filterId, intensity = 1, adj) {
  const f = filterById(filterId);
  return compose(mix(f.m, intensity), adjustMatrix(adj));
}
export function isIdentity(m) {
  for (let i = 0; i < 20; i++) if (Math.abs(m[i] - IDENTITY[i]) > 1e-4) return false;
  return true;
}

// Aplica a matriz em um buffer RGBA (Uint8ClampedArray do canvas) in-place.
export function applyMatrixToRGBA(data, m) {
  const o0 = m[4] * 255, o1 = m[9] * 255, o2 = m[14] * 255;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    data[i] = m[0] * r + m[1] * g + m[2] * b + o0;
    data[i + 1] = m[5] * r + m[6] * g + m[7] * b + o1;
    data[i + 2] = m[10] * r + m[11] * g + m[12] * b + o2;
  }
  return data;
}

// ─── Inteligência ───────────────────────────────────────────────────────────
// stats a partir de pixels RGBA (miniatura ~32x32 basta).
export function analyzeStats(rgba) {
  if (!rgba || rgba.length < 4) return null;
  let n = 0, sumL = 0, sumL2 = 0, sumS = 0, sumW = 0, sr = 0, sg = 0, sb = 0, dark = 0, bright = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (a === 0) continue;
    const r = rgba[i] / 255, g = rgba[i + 1] / 255, b = rgba[i + 2] / 255;
    const L = LR * r + LG * g + LB * b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const S = mx === 0 ? 0 : (mx - mn) / mx;
    sumL += L; sumL2 += L * L; sumS += S; sumW += (r - b);
    sr += r; sg += g; sb += b;
    if (L < 0.12) dark++;
    if (L > 0.9) bright++;
    n++;
  }
  if (!n) return null;
  const lum = sumL / n;
  return {
    lum,
    contrast: Math.sqrt(Math.max(0, sumL2 / n - lum * lum)),
    sat: sumS / n,
    warmth: sumW / n,
    avg: [sr / n, sg / n, sb / n],
    darkPct: dark / n,
    brightPct: bright / n,
  };
}

// Escolhe o filtro + um motivo curto (i18n key) para o chip "Sugerido".
export function suggestFilter(st) {
  if (!st) return { id: 'vivido', reasonKey: 'status.smart.reasonDefault' };
  if (st.sat < 0.1) return { id: 'noir', reasonKey: 'status.smart.reasonMono' };
  if (st.lum < 0.3) return { id: 'claro', reasonKey: 'status.smart.reasonDark' };
  if (st.lum > 0.72 && st.contrast < 0.2) return { id: 'drama', reasonKey: 'status.smart.reasonBright' };
  if (st.warmth > 0.1) return { id: 'dourado', reasonKey: 'status.smart.reasonWarm' };
  if (st.warmth < -0.06) return { id: 'frio', reasonKey: 'status.smart.reasonCool' };
  if (st.contrast < 0.16) return { id: 'vivido', reasonKey: 'status.smart.reasonFlat' };
  if (st.sat > 0.45) return { id: 'cinema', reasonKey: 'status.smart.reasonColorful' };
  return { id: 'vivido', reasonKey: 'status.smart.reasonDefault' };
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// Auto-melhorar: leva luz média ~0.5, contraste ~0.22, cor viva sem estourar,
// neutraliza dominante forte. Valores na escala dos sliders.
export function autoEnhance(st) {
  if (!st) return { brightness: 0.12, contrast: 0.15, saturation: 0.15, warmth: 0, fade: 0 };
  const brightness = clamp((0.5 - st.lum) * 1.3, -0.35, 0.5);
  const contrastV = clamp((0.22 - st.contrast) * 2.2, -0.2, 0.45);
  const sat = clamp((0.34 - st.sat) * 0.9, -0.15, 0.35);
  const warmth = clamp(-st.warmth * 1.6, -0.35, 0.35);
  const r = (v) => Math.round(v * 100) / 100;
  return { brightness: r(brightness), contrast: r(contrastV), saturation: r(sat), warmth: r(warmth), fade: 0 };
}

// Legendas sugeridas locais (sem IA/sem chave): hora do dia + clima da foto.
// Devolve CHAVES i18n (o componente traduz).
export function suggestCaptionKeys(st, date = new Date()) {
  const h = date.getHours();
  const keys = [];
  if (h >= 5 && h < 11) keys.push('status.smart.capMorning');
  else if (h >= 11 && h < 17) keys.push('status.smart.capAfternoon');
  else if (h >= 17 && h < 20) keys.push('status.smart.capSunset');
  else keys.push('status.smart.capNight');
  if (st) {
    if (st.warmth > 0.08) keys.push('status.smart.capWarm');
    else if (st.lum > 0.62) keys.push('status.smart.capBright');
    else if (st.lum < 0.3) keys.push('status.smart.capMood');
  }
  keys.push('status.smart.capVibe');
  return Array.from(new Set(keys)).slice(0, 3);
}

// Cor de fundo do palco (fit "contain") derivada da média da foto, escurecida —
// o mesmo truque do Instagram para fotos que não são 9:16.
export function stageBackground(st) {
  if (!st?.avg) return '#0b0b0b';
  const [r, g, b] = st.avg.map(v => Math.round(clamp(v * 0.42, 0, 1) * 255));
  return `rgb(${r},${g},${b})`;
}
