// components/native/resultListAdapter.js — [2026-10-15 native-search-notifs]
//
// Adaptador da lista de RESULTADOS nativa (ChatyyResultList em
// modules/expo-chat-conversation-list): busca global + central de notificações.
// Linhas PLANAS e curtas para a ponte (patches por id via createPatcher):
//   seção      → { id, k: 's', t, ac? }
//   linha      → { id, k: 'r', t, tl, sb, sl, tm, tiles | th(+ta) | gl(+gs),
//                  bd, pv, rt, un, b1, b1f, b1b, b2, sw, cv, hl, tap, a11y }
//   carregando → { id, k: 'l', t? }
//   aviso      → { id, k: 'n', t, gl? }
// Também usado pelo fallback JS (web / binário antigo) — snippet e destaque
// seguem a MESMA regra (sem caixa/acento) nos dois caminhos.

import { contactTile, nativeColors } from '../contacts/contactListAdapter';
import { initialsOf, gradientIndex } from '../chatlist/nativeAdapter';

export { contactTile };

/** Ladrilho a partir de uma URL de foto já resolvida (ou só iniciais). */
export function photoTile(url, name, seed) {
  const tile = { u: String(url || ''), i: initialsOf(name, seed), g: gradientIndex(name || seed || '') };
  return [tile];
}

/** Cores do ThemeContext → prop `colors` do nativo (ARGB). */
export function resultColors(colors, isDark) {
  const c = colors || {};
  return nativeColors({
    dark: !!isDark,
    bg: c.background,
    text: c.text,
    sub: c.textSecondary,
    faint: c.textTertiary || c.textSecondary,
    hair: c.borderLight || c.border,
    primary: c.primary,
    onPrimary: c.onPrimary,
    error: c.error || '#FF3B30',
    press: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
    chipBg: isDark ? '#1C1C1E' : (c.surfaceVariant || '#F0F1F3'),
    border: isDark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.16)',
    unreadBg: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(17,17,17,0.04)',
  });
}

// ── Texto: dobra sem caixa/acento mantendo índices 1:1 ──────────────────────
const _foldCache = new Map();
export function foldText(s) {
  const str = String(s || '');
  if (str.length < 64) { const hit = _foldCache.get(str); if (hit !== undefined) return hit; }
  let out = '';
  for (const ch of str) {
    let b = ch;
    try {
      const n = ch.normalize('NFD');
      b = n.length ? n[0] : ch;
      if (b.length !== ch.length) b = ch; // nunca muda o comprimento
    } catch {}
    out += b.toLowerCase().length === b.length ? b.toLowerCase() : b;
  }
  if (str.length < 64) {
    if (_foldCache.size > 500) _foldCache.clear();
    _foldCache.set(str, out);
  }
  return out;
}

/** Palavras do termo (sem #/@/aspas), já dobradas. */
export function queryTokens(q) {
  const parts = String(q || '').split(/\s+/).map((p) => p.replace(/^[#@"']+|[#@"']+$/g, '')).filter(Boolean);
  const out = [];
  for (const p of parts) { const f = foldText(p); if (f && !out.includes(f)) out.push(f); }
  return out.slice(0, 6);
}

/** Casa TODAS as palavras do termo (sem caixa/acento) em algum dos textos. */
export function matchesAll(tokens, ...texts) {
  if (!tokens || !tokens.length) return false;
  const hay = foldText(texts.filter(Boolean).join(' '));
  for (const t of tokens) if (!hay.includes(t)) return false;
  return true;
}

/**
 * Trecho em volta da 1ª ocorrência (como o WhatsApp): "…antes TERMO depois…".
 * Mantém o termo visível mesmo em mensagens longas (2 linhas).
 */
export function snippetAround(text, q, radius = 34) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const toks = queryTokens(q);
  if (!toks.length) return s;
  const f = foldText(s);
  let at = -1;
  for (const t of toks) { const i = f.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at <= radius) return s;
  let start = at - radius;
  // Começa numa palavra inteira (1º espaço depois do corte, se vier antes do termo).
  const sp = s.indexOf(' ', start);
  if (sp >= 0 && sp < at) start = sp + 1;
  return '…' + s.slice(start);
}

/** Partes {text, hit} para o destaque no fallback JS (mesma regra do nativo). */
export function highlightParts(text, q) {
  const s = String(text || '');
  const toks = queryTokens(q);
  if (!s || !toks.length) return [{ text: s, hit: false }];
  const f = foldText(s);
  const ranges = [];
  for (const t of toks) {
    let from = 0; let guard = 0;
    while (guard++ < 20) {
      const i = f.indexOf(t, from);
      if (i < 0) break;
      const e = i + t.length;
      if (!ranges.some(([a, b]) => i < b && e > a)) ranges.push([i, e]);
      from = e;
    }
  }
  if (!ranges.length) return [{ text: s, hit: false }];
  ranges.sort((a, b) => a[0] - b[0]);
  const out = [];
  let pos = 0;
  for (const [a, b] of ranges) {
    if (a > pos) out.push({ text: s.slice(pos, a), hit: false });
    out.push({ text: s.slice(a, b), hit: true });
    pos = b;
  }
  if (pos < s.length) out.push({ text: s.slice(pos), hit: false });
  return out;
}
