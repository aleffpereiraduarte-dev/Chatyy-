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
