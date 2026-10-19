// components/chatlist/listDensity.js — [2026-10-18 compact-list]
//
// Founder/usuários: "muito espaço vazio entre as coisas" na lista de conversas.
// Ritmo compacto nível WhatsApp/Telegram (linha 72 / avatar 52 / vão 12,
// cabeçalho/filtros/status/fixadas mais justos) — tudo controlado pelo JS
// (OTA). Lista nativa: prop `density` (iOS api >= 8 / Android api >= 9);
// binário antigo segue 76 / 54 no nativo e o resto (header RN) já fica compacto.
//
// Kill switch: globalThis.__chatyy_compact_list = false → espaçamento antigo.
// Lido a cada render (não no import) para o flag remoto valer sem reiniciar.

const REGULAR = Object.freeze({
  compact: false,
  avatar: 54, rowMinH: 74, rowPadV: 10, avatarGap: 14, sepInset: 16 + 54 + 14,
  // chips (filtros)
  chipsH: 46, chipsPadTop: 4, chipsPadBottom: 10,
  // título grande
  largeTitlePadBottom: 8,
  // faixa de status
  storyOwn: 56, storyOther: 54, storyItemW: 70, storyOtherW: 68, storyGap: 16,
  storyPadTop: 14, storyPadBottom: 12, storyLabelGap: 7,
  // fixadas
  pinPadTop: 16, pinPadBottom: 8, pinPadBottomJs: 18, pinLabel: true, pinLabelGap: 6,
  // notas (faixa antiga)
  notesH: 98,
});

const COMPACT = Object.freeze({
  compact: true,
  avatar: 52, rowMinH: 72, rowPadV: 9, avatarGap: 12, sepInset: 16 + 52 + 12,
  chipsH: 42, chipsPadTop: 2, chipsPadBottom: 8,
  largeTitlePadBottom: 4,
  storyOwn: 52, storyOther: 50, storyItemW: 64, storyOtherW: 64, storyGap: 12,
  storyPadTop: 8, storyPadBottom: 8, storyLabelGap: 4,
  pinPadTop: 8, pinPadBottom: 2, pinPadBottomJs: 10, pinLabel: false, pinLabelGap: 2,
  notesH: 86,
});

export function compactListOn() {
  try { return globalThis.__chatyy_compact_list !== false; } catch { return true; }
}

/** Métricas do ritmo vertical da lista (objeto congelado e estável por modo). */
export function listMetrics() {
  return compactListOn() ? COMPACT : REGULAR;
}

// [2026-10-19 tg-list] Linhas da lista NATIVA no ritmo Telegram iOS (linha 78,
// avatar 58, texto/separador em 80, prévia em 2 linhas, ✓✓ junto da hora,
// remetente do grupo em linha própria, alfinete no lugar do contador,
// "digitando…" na cor de destaque, "Rascunho:" em vermelho). Só no binário
// com density "telegram" (iOS api >= 9 / Android api >= 10); antigo segue
// "compact". Kill switch: globalThis.__chatyy_tg_list = false.
export function tgListOn() {
  try { return globalThis.__chatyy_tg_list !== false; } catch { return true; }
}

/** Destaque p/ a lista nativa: "#RRGGBB" de cor de verdade; preto-tinta = '' (cor do texto). */
export function listAccentHex(accent) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(accent || '').trim());
  if (!m) return '';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (r < 0x30 && g < 0x30 && b < 0x30) return '';
  return '#' + m[1].toUpperCase();
}
