// components/wallpaper/wallpaperSpec.js — [2026-10-15 native-wallpaper]
//
// Fonte ÚNICA (JS) dos temas/padrões do papel de parede da conversa, do formato
// do valor sincronizado e da resolução valor → o que desenhar. O nativo
// (modules/expo-chat-wallpaper) é "burro": recebe cores/padrão/foto já
// resolvidos por modo (claro/escuro) e só desenha. O fallback JS
// (ChatWallpaper.js / SVG) usa o MESMO resultado.
//
// FORMATO DO VALOR (chat_set_wallpaper / chat_update_settings.wallpaper,
// ≤ 500 chars no servidor). Valores antigos continuam iguais:
//   'none' | '#RRGGBB' | 'grad:<id>' | '<uri>'
// Novo (v2):  'wp2:' + JSON
//   { t:'<temaId>', p:'<padrãoId>'|'' , m:1 }      tema animado (4 cores)
//   { img:'<url>', bl:1, m:1 }                    foto (desfoque, paralaxe)
//   { v:'<valor antigo>', m:1 }                   cor/gradiente antigo c/ paralaxe
//   { L:{…}, D:{…} }                              claro e escuro separados
//   (bb:0 = não tingir as bolhas próprias com a cor do tema)

// ── Glifos (traço, caixa 24×24) ─────────────────────────────────────────────
// Subconjunto SVG: M L H V C Q Z (absolutos) — o parser nativo entende só isso.
const K = 0.5523;
function circ(cx, cy, r) {
  const k = +(r * K).toFixed(2);
  const f = (n) => +n.toFixed(2);
  return `M${f(cx - r)} ${f(cy)} C${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)} `
    + `C${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)} `
    + `C${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)} `
    + `C${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)} Z`;
}

export const GLYPHS = {
  heart: 'M12 20.5 C12 20.5 3 14.8 3 8.9 C3 6 5.2 4 7.8 4 C9.6 4 11.1 5 12 6.5 C12.9 5 14.4 4 16.2 4 C18.8 4 21 6 21 8.9 C21 14.8 12 20.5 12 20.5 Z',
  star: 'M12 3 L14.6 8.6 L20.6 9.3 L16.1 13.4 L17.4 19.4 L12 16.3 L6.6 19.4 L7.9 13.4 L3.4 9.3 L9.4 8.6 Z',
  chat: 'M4 5.5 C4 4.7 4.7 4 5.5 4 L18.5 4 C19.3 4 20 4.7 20 5.5 L20 14.5 C20 15.3 19.3 16 18.5 16 L10 16 L6 20 L6 16 L5.5 16 C4.7 16 4 15.3 4 14.5 Z',
  note: `M9 18 L9 5 L19 3 L19 16 ${circ(6.5, 18, 2.5)} ${circ(16.5, 16, 2.5)}`,
  plane: 'M3 11 L21 3 L14 21 L11 13 Z M11 13 L21 3',
  smile: `${circ(12, 12, 9)} M8.5 14.5 C9.5 16 10.6 16.6 12 16.6 C13.4 16.6 14.5 16 15.5 14.5 M9 9.5 L9 10.3 M15 9.5 L15 10.3`,
  cloud: 'M7 18 C4.8 18 3 16.3 3 14.2 C3 12.2 4.6 10.6 6.6 10.4 C7.2 7.9 9.4 6 12 6 C14.9 6 17.2 8.2 17.5 11 C19.5 11.2 21 12.8 21 14.6 C21 16.5 19.4 18 17.5 18 Z',
  moon: 'M20 14.5 C18.9 15 17.7 15.2 16.5 15.2 C11.8 15.2 8 11.4 8 6.7 C8 5.5 8.2 4.4 8.7 3.4 C5.3 4.7 3 8 3 11.8 C3 16.9 7.1 21 12.2 21 C15.8 21 18.9 18.8 20 14.5 Z',
  coffee: 'M4 8 L16 8 L16 15 C16 17.8 13.8 20 11 20 L9 20 C6.2 20 4 17.8 4 15 Z M16 10 L18 10 C19.7 10 21 11.3 21 13 C21 14.7 19.7 16 18 16 L16 16 M8 2.5 L8 5 M12 2.5 L12 5',
  sparkle: 'M12 3 C12.6 8.5 15.5 11.4 21 12 C15.5 12.6 12.6 15.5 12 21 C11.4 15.5 8.5 12.6 3 12 C8.5 11.4 11.4 8.5 12 3 Z',
  leaf: 'M5 19 C5 10 10 5 20 4 C19 14 14 19 5 19 Z M5 19 L13 11',
  gift: 'M4 10 L20 10 L20 20 L4 20 Z M3 7 L21 7 L21 10 L3 10 Z M12 7 L12 20 M12 7 C10 3 6.5 4 8 7 M12 7 C14 3 17.5 4 16 7',
  bolt: 'M13 2 L4 14 L11 14 L10 22 L20 9 L13 9 Z',
  camera: `M3 8 C3 7.2 3.7 6.5 4.5 6.5 L7.5 6.5 L9 4 L15 4 L16.5 6.5 L19.5 6.5 C20.3 6.5 21 7.2 21 8 L21 18 C21 18.8 20.3 19.5 19.5 19.5 L4.5 19.5 C3.7 19.5 3 18.8 3 18 Z ${circ(12, 12.8, 3.6)}`,
  phone: 'M5 4 L9 4 L10.5 8.5 L8.2 10 C9.3 12.4 11.6 14.7 14 15.8 L15.5 13.5 L20 15 L20 19 C20 19.6 19.6 20 19 20 C10.7 20 4 13.3 4 5 C4 4.4 4.4 4 5 4 Z',
  ring: circ(12, 12, 3.2),
  tri: 'M12 4.5 L20 18.5 L4 18.5 Z',
  square: 'M6.5 6.5 L17.5 6.5 L17.5 17.5 L6.5 17.5 Z',
  plus: 'M12 6 L12 18 M6 12 L18 12',
  wave: 'M3 12 C5 9 7 9 9 12 C11 15 13 15 15 12 C17 9 19 9 21 12',
  planet: `${circ(12, 12, 5)} M4.2 15.4 C2.4 17.6 3.6 18.6 7 17.5 C10.4 16.4 14.6 14 17.6 11.4 C20.4 9 21.4 7.1 19.6 6.6 C19.1 6.5 18.5 6.6 17.8 6.8`,
};

// ── Padrões (azulejo determinístico, emendas tratadas no desenho) ────────────
const PATTERN_GLYPHS = {
  doodles: ['chat', 'heart', 'star', 'note', 'plane', 'smile', 'cloud', 'moon', 'coffee', 'sparkle', 'leaf', 'gift', 'bolt', 'camera', 'phone'],
  love: ['heart', 'sparkle', 'heart', 'smile', 'star', 'ring', 'heart', 'chat'],
  space: ['star', 'sparkle', 'moon', 'planet', 'ring', 'star', 'sparkle', 'cloud'],
  geo: ['tri', 'square', 'ring', 'plus', 'wave'],
};
export const PATTERN_IDS = ['doodles', 'love', 'space', 'geo'];
const TILE = 300;

function rng(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _patternCache = {};
/** { key, tile, stroke, items:[{d,x,y,s,r}] } — x/y = centro do glifo no azulejo. */
export function patternById(id) {
  if (!id || !PATTERN_GLYPHS[id]) return null;
  if (_patternCache[id]) return _patternCache[id];
  const r = rng(`chatyy-wp-${id}`);
  const glyphs = PATTERN_GLYPHS[id];
  const cells = 5;
  const cell = TILE / cells;
  const items = [];
  let gi = Math.floor(r() * glyphs.length);
  for (let row = 0; row < cells; row++) {
    for (let col = 0; col < cells; col++) {
      // linhas alternadas deslocadas (quincôncio) = menos "grade"
      const ox = (row % 2) * cell * 0.5;
      const x = (col * cell + cell / 2 + ox + (r() - 0.5) * cell * 0.36) % TILE;
      const y = row * cell + cell / 2 + (r() - 0.5) * cell * 0.36;
      const name = glyphs[gi % glyphs.length]; gi += 1 + Math.floor(r() * 2);
      items.push({ d: GLYPHS[name], x: +x.toFixed(1), y: +y.toFixed(1), s: +(0.95 + r() * 0.4).toFixed(2), r: Math.round((r() - 0.5) * 56) });
    }
  }
  _patternCache[id] = { key: id, tile: TILE, stroke: 1.5, items };
  return _patternCache[id];
}

// ── Temas (4 cores, estilo Telegram) ─────────────────────────────────────────
// light: gradiente no claro (e, no escuro COM padrão, as cores que "acendem" o
// padrão sobre o preto — máscara); dark: gradiente no escuro SEM padrão.
// bubble: cor das bolhas próprias derivada [claro, escuro]; null = P&B (identidade).
export const THEMES = [
  { id: 'mono',     light: ['#E9E9EB', '#D6D6DA', '#F5F5F6', '#CBCBD0'], dark: ['#1C1C1E', '#2A2A2D', '#121214', '#343437'], pattern: 'doodles', bubble: null },
  { id: 'noir',     light: ['#FFFFFF', '#F1F1F1', '#E4E4E4', '#FAFAFA'], dark: ['#050505', '#0E0E0E', '#161616', '#000000'], pattern: 'geo', bubble: null },
  { id: 'paper',    light: ['#EFE9DF', '#E2D8C7', '#F6F1E8', '#D8CDBA'], dark: ['#1E1B17', '#29241E', '#141210', '#322B23'], pattern: 'doodles', bubble: null },
  { id: 'aurora',   light: ['#DBDDBB', '#6BA587', '#D5D88D', '#88B884'], dark: ['#0E2A1F', '#1F4A36', '#0B1F17', '#2E5A40'], pattern: 'doodles', bubble: ['#2E7D5B', '#25664A'] },
  { id: 'ocean',    light: ['#94DAE9', '#A6C8F0', '#B6D7F5', '#7BB6E8'], dark: ['#0B2238', '#163A5C', '#0A1A2B', '#1F4C73'], pattern: 'space', bubble: ['#2B6CB0', '#24527F'] },
  { id: 'lavender', light: ['#D8C9F2', '#B9A6EC', '#E8D9F7', '#C6B3F0'], dark: ['#1E1533', '#33245A', '#140E24', '#3F2C6B'], pattern: 'love', bubble: ['#6B4FCF', '#55409F'] },
  { id: 'sunset',   light: ['#FFD3A5', '#FD9A8B', '#FFC3A0', '#F7A6B7'], dark: ['#331A14', '#4A2420', '#24120F', '#5C2E2A'], pattern: 'doodles', bubble: ['#C4553F', '#A3473A'] },
  { id: 'rose',     light: ['#F9D2DD', '#F2A9BE', '#FBE1E8', '#E995AE'], dark: ['#2E121B', '#4A1D2C', '#200C13', '#5A2537'], pattern: 'love', bubble: ['#C2416B', '#9C3557'] },
  { id: 'mint',     light: ['#CFF3E4', '#A8E6CF', '#E0F7EE', '#8FD8BC'], dark: ['#0D2620', '#16403A', '#0A1C17', '#1D5048'], pattern: 'geo', bubble: ['#1F8F73', '#197560'] },
  { id: 'sand',     light: ['#F2E6C9', '#E6D2A1', '#F7EED8', '#DCC48E'], dark: ['#2A2213', '#40341C', '#1D170D', '#4D3F22'], pattern: 'doodles', bubble: ['#94742B', '#7E6325'] },
  { id: 'night',    light: ['#C9D3E6', '#A9B6D3', '#DCE3F0', '#9AA8C9'], dark: ['#0B0F1A', '#141B2D', '#070A12', '#1C2540'], pattern: 'space', bubble: ['#3B4C7A', '#34436B'] },
];
export function themeById(id) { return THEMES.find((t) => t.id === id) || null; }

// ── Valor ⇄ objeto ──────────────────────────────────────────────────────────
export function isV2(v) { return typeof v === 'string' && v.startsWith('wp2:'); }

export function parseV2(v) {
  if (!isV2(v)) return null;
  try {
    const o = JSON.parse(v.slice(4));
    return o && typeof o === 'object' ? o : null;
  } catch { return null; }
}

function cleanSpec(s) {
  if (!s || typeof s !== 'object') return null;
  const o = {};
  if (typeof s.t === 'string' && themeById(s.t)) o.t = s.t;
  else if (typeof s.img === 'string' && /^https?:\/\//i.test(s.img)) o.img = s.img;
  else if (typeof s.v === 'string' && s.v && !isV2(s.v)) o.v = s.v;
  else return null;
  if (o.t && typeof s.p === 'string' && (s.p === '' || PATTERN_GLYPHS[s.p])) o.p = s.p;
  if (o.img && s.bl) o.bl = 1;
  if (s.m) o.m = 1;
  if (o.t && s.bb === 0) o.bb = 0;
  return o;
}

/** spec (ou {L,D}) → valor a gravar. Sem opções novas → valor antigo puro. */
export function buildValue(spec) {
  if (!spec) return 'none';
  if (spec.L || spec.D) {
    const L = cleanSpec(spec.L); const D = cleanSpec(spec.D);
    if (L && D && JSON.stringify(L) === JSON.stringify(D)) return buildValue(L);
    const o = {};
    if (L) o.L = L; if (D) o.D = D;
    return Object.keys(o).length ? `wp2:${JSON.stringify(o)}` : 'none';
  }
  const s = cleanSpec(spec);
  if (!s) return 'none';
  if (s.v && !s.m) return s.v; // antigo puro = idêntico ao de antes
  if (s.img && !s.bl && !s.m) return s.img;
  return `wp2:${JSON.stringify(s)}`;
}

/** valor → spec do modo pedido ({t|img|v,…}) ou null (= 'none'). */
export function specFor(value, isDark) {
  if (!value || value === 'none' || value === '__global__') return null;
  if (!isV2(value)) return { v: value };
  const o = parseV2(value);
  if (!o) return null;
  let s;
  if (o.L || o.D) s = cleanSpec(isDark ? (o.D || o.L) : (o.L || o.D));
  else s = cleanSpec(o);
  // {v:'none'} = "este modo sem fundo" (aplicado só no outro modo)
  return s && s.v === 'none' ? null : s;
}

/** valor → { L, D } (para o seletor editar um modo sem perder o outro). */
export function splitModes(value) {
  return { L: specFor(value, false), D: specFor(value, true) };
}

// ── Resolução → o que desenhar ──────────────────────────────────────────────
// kind: 'none' | 'legacy' (renderer JS antigo, idêntico) | 'native'
// native: { colors[], baseColor, pattern, patternIntensity, patternMode,
//           patternColor, imageUri, blur, dim, motion, animate }
export function resolve(value, isDark) {
  const s = specFor(value, isDark);
  if (!s) return { kind: 'none' };
  if (s.v) {
    if (!s.m) return { kind: 'legacy', value: s.v };
    // antigo + paralaxe → o JS antigo desenha; o nativo só move (motion)
    return { kind: 'legacy', value: s.v, motion: true };
  }
  if (s.img) {
    return {
      kind: 'native', imageUri: s.img, blur: s.bl ? 22 : 0,
      dim: isDark ? 0.42 : 0, colors: [], baseColor: isDark ? '#000000' : '#FFFFFF',
      pattern: null, patternIntensity: 0, patternMode: 'overlay', patternColor: '#000000',
      motion: !!s.m, animate: false,
    };
  }
  const th = themeById(s.t);
  if (!th) return { kind: 'none' };
  const pid = typeof s.p === 'string' ? s.p : th.pattern;
  const pattern = pid ? patternById(pid) : null;
  if (isDark && pattern) {
    // Telegram: preto + o gradiente "aceso" só através do padrão (máscara).
    return {
      kind: 'native', colors: th.light, baseColor: '#000000', pattern, patternIntensity: 0.55,
      patternMode: 'mask', patternColor: '#FFFFFF', imageUri: '', blur: 0, dim: 0,
      motion: !!s.m, animate: true,
    };
  }
  return {
    kind: 'native', colors: isDark ? th.dark : th.light, baseColor: isDark ? '#000000' : '#FFFFFF',
    pattern, patternIntensity: isDark ? 0.07 : 0.11, patternMode: 'overlay',
    patternColor: isDark ? '#FFFFFF' : '#000000', imageUri: '', blur: 0, dim: 0,
    motion: !!s.m, animate: true,
  };
}

/** Bolhas próprias derivadas do tema (null = P&B padrão). */
export function bubbleFor(value, isDark) {
  const s = specFor(value, isDark);
  if (!s || !s.t || s.bb === 0) return null;
  const th = themeById(s.t);
  if (!th || !th.bubble) return null;
  return {
    bg: th.bubble[isDark ? 1 : 0],
    text: '#FFFFFF',
    meta: 'rgba(255,255,255,0.68)',
  };
}

/** Cor média (fallback do gradiente / bolinhas do seletor). */
export function averageColor(colors) {
  if (!colors || !colors.length) return '#000000';
  let r = 0, g = 0, b = 0;
  for (const c of colors) {
    const n = parseInt(String(c).replace('#', '').slice(0, 6), 16) || 0;
    r += (n >> 16) & 255; g += (n >> 8) & 255; b += n & 255;
  }
  const k = colors.length;
  const h = (x) => Math.round(x / k).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

// Posições base do gradiente de 4 cores (fase 0) — iguais às do nativo.
export const GRADIENT_POSITIONS = [
  [0.80, 0.10], [0.60, 0.20], [0.35, 0.25], [0.25, 0.60],
  [0.20, 0.90], [0.40, 0.80], [0.65, 0.75], [0.75, 0.40],
];

/** Valor final ao aplicar `spec` em 'both' | 'light' | 'dark', preservando o
 *  outro modo do valor atual. spec null = padrão Chatyy (sem fundo). */
export function composeValue(currentValue, spec, target) {
  const none = { v: 'none' };
  const s = spec || none;
  if (target !== 'light' && target !== 'dark') return buildValue(s);
  const cur = splitModes(currentValue);
  const L = target === 'light' ? s : (cur.L || none);
  const D = target === 'dark' ? s : (cur.D || none);
  return buildValue({ L, D });
}
