// [status-texto 2026-10-14] Status de TEXTO nível WhatsApp — fonte única.
//
// Compositor (StatusStudio, modo texto), viewers (ChatStatusTab →
// AnimatedStatusText, StoryViewer) e miniaturas da lista leem daqui a paleta,
// as fontes, o auto-ajuste do tamanho, a detecção de links e a duração. O
// servidor (status_create) valida a mesma paleta/lista de fontes — manter em
// sincronia com /root/status-texto-patcher.py.
//
// Fundo: hex sólido da paleta (novo) OU `gradient:<id>` (status antigos —
// textGradients.js). Fonte: meta.font_style ∈ TEXT_STATUS_FONTS (+ legados
// 'normal'/'classic' = sans). Só fontes do sistema (nada baixado).
import React from 'react';
import { Linking, Platform, Text, View } from 'react-native';
import { resolveTextGradient } from './textGradients';

export const TEXT_STATUS_MAX = 700;

// 12 cores sólidas — o texto é sempre branco, então todas são escuras/saturadas
// o bastante p/ contraste AA com #FFF. Conteúdo do usuário: pode ser colorido.
export const TEXT_STATUS_COLORS = [
  '#111111', '#54656F', '#0F766E', '#15803D', '#0E7490', '#2563EB',
  '#4F46E5', '#7C3AED', '#C026D3', '#DB2777', '#DC2626', '#EA580C',
];

export const TEXT_STATUS_FONTS = [
  { id: 'sans', labelKey: 'status.text.fontSans' },
  { id: 'serif', labelKey: 'status.text.fontSerif' },
  { id: 'mono', labelKey: 'status.text.fontMono' },
  { id: 'script', labelKey: 'status.text.fontScript' },
  { id: 'condensed', labelKey: 'status.text.fontCondensed' },
];

export function normalizeTextFont(id) {
  const v = String(id || '').toLowerCase();
  if (v === 'serif' || v === 'mono' || v === 'script' || v === 'condensed') return v;
  return 'sans'; // 'normal' | 'classic' | vazio | desconhecido
}

// Estilo de fonte por plataforma — só famílias que já vêm no sistema.
export function textStatusFontStyle(id) {
  const f = normalizeTextFont(id);
  const ios = Platform.OS === 'ios';
  const web = Platform.OS === 'web';
  switch (f) {
    case 'serif':
      return { fontFamily: ios ? 'Georgia' : web ? 'Georgia, "Times New Roman", Times, serif' : 'serif', fontWeight: '700' };
    case 'mono':
      return { fontFamily: ios ? 'Menlo' : web ? 'ui-monospace, Menlo, Consolas, "Courier New", monospace' : 'monospace', fontWeight: '700' };
    case 'script':
      // iOS: Noteworthy (sistema). Android: alias 'cursive' (Dancing Script do AOSP).
      return ios ? { fontFamily: 'Noteworthy-Bold' }
        : web ? { fontFamily: '"Segoe Script", "Bradley Hand", "Noteworthy", "Comic Sans MS", cursive', fontWeight: '700' }
          : { fontFamily: 'cursive', fontWeight: '700' };
    case 'condensed':
      return ios ? { fontFamily: 'AvenirNextCondensed-Bold' }
        : web ? { fontFamily: '"Arial Narrow", "Roboto Condensed", "Helvetica Neue", sans-serif', fontWeight: '800', letterSpacing: -0.5, textTransform: 'uppercase' }
          : { fontFamily: 'sans-serif-condensed', fontWeight: '700' };
    default:
      return { fontWeight: '700' };
  }
}

// Cor de fundo pintável: hex da paleta/legado ou primeira cor do gradiente.
export function textStatusSolid(bg) {
  const g = resolveTextGradient(bg);
  if (g) return g.colors[g.colors.length - 1];
  if (typeof bg === 'string' && /^(#|rgb|hsl)/i.test(bg.trim())) return bg.trim();
  return '#111111';
}

// Auto-ajuste: maior fonte (max→min, passo 2) em que o texto, quebrado na
// largura disponível, ainda cabe em ~78% da altura. Estimativa por largura
// média de glifo (0.56em) — determinística, sem medir layout (mesmo resultado
// no compositor e no viewer, proporcional ao tamanho de cada um).
// Largura média de glifo (em) por fonte — mono/serif negrito são mais largas;
// com folga p/ quebra de palavra (a quebra real desperdiça ~10% da linha).
const GLYPH_EM = { sans: 0.6, serif: 0.62, mono: 0.66, script: 0.62, condensed: 0.52 };
function _glyph(font) { return GLYPH_EM[normalizeTextFont(font)] || 0.6; }

export function autoFitFontSize(text, { width = 360, height = 640, max = 42, min = 16, pad = 48, font } = {}) {
  const s = String(text || '');
  if (!s.trim()) return max;
  const lines = s.split('\n');
  const usableW = Math.max(80, width - pad);
  const g = _glyph(font);
  for (let fs = max; fs >= min; fs -= 2) {
    const cpl = Math.max(1, Math.floor(usableW / (fs * g)));
    let total = 0;
    for (const l of lines) total += Math.max(1, Math.ceil(Array.from(l).length / cpl));
    if (total * fs * 1.28 <= height * 0.78) return fs;
  }
  return min;
}

// Linhas estimadas do texto quebrado na largura (mesma conta do auto-ajuste).
export function estimateTextLines(text, { width = 360, fontSize = 32, pad = 48, font } = {}) {
  const usableW = Math.max(80, width - pad);
  const cpl = Math.max(1, Math.floor(usableW / (fontSize * _glyph(font))));
  let total = 0;
  for (const l of String(text || '').split('\n')) total += Math.max(1, Math.ceil(Array.from(l).length / cpl));
  return total;
}

// Duração proporcional ao texto: 5 s + ~40 ms/caractere, teto 10 s.
export function textStatusDurationMs(text) {
  const n = Array.from(String(text || '')).length;
  return Math.max(5000, Math.min(10000, 5000 + n * 40));
}

// Links: http(s)://…, www.… e domínio.tld/… simples (chatyy.com.br/x).
const LINK_RE = /((?:https?:\/\/|www\.)[^\s<>"']+|\b[a-z0-9][a-z0-9-]{0,62}(?:\.[a-z0-9-]{1,63})*\.(?:com|net|org|br|io|app|me|dev|co|info|tv|gov|edu|pt|us|uk|de|fr|es|it)(?:\.[a-z]{2})?(?:\/[^\s<>"']*)?)/gi;

function _trimTrail(u) {
  let s = u;
  while (/[.,;:!?)\]}'"]$/.test(s)) {
    if (s.endsWith(')') && (s.match(/\(/g) || []).length >= (s.match(/\)/g) || []).length) break;
    s = s.slice(0, -1);
  }
  return s;
}

// Divide o texto em partes [{ text, url? }]. E-mails (a@b.com) não viram link.
export function splitLinks(text) {
  const s = String(text || '');
  const out = [];
  let last = 0;
  LINK_RE.lastIndex = 0;
  let m;
  while ((m = LINK_RE.exec(s))) {
    const start = m.index;
    if (start > 0 && s[start - 1] === '@') continue;
    const raw = _trimTrail(m[0]);
    if (!raw) continue;
    if (start > last) out.push({ text: s.slice(last, start) });
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    out.push({ text: raw, url });
    last = start + raw.length;
    LINK_RE.lastIndex = last;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}

export function firstLink(text) {
  const p = splitLinks(text).find(x => x.url);
  return p ? p.url : null;
}

export function openTextStatusLink(url) {
  if (!url || !/^https?:\/\//i.test(url)) return;
  try {
    if (Platform.OS === 'web' && typeof window !== 'undefined') { window.open(url, '_blank', 'noopener,noreferrer'); return; }
    require('../../services/openLink').openLink(url); // [2026-10-15 native-browser]
  } catch {}
}

// Texto com links tocáveis (sublinhados). Usado dentro de um <Text> estilizado.
export function LinkifiedText({ text, style, linkStyle, onLinkPress, ...rest }) {
  const parts = splitLinks(text);
  return (
    <Text style={style} {...rest}>
      {parts.map((p, i) => (p.url ? (
        <Text
          key={i}
          style={[{ textDecorationLine: 'underline' }, linkStyle]}
          onPress={() => { (onLinkPress || openTextStatusLink)(p.url); }}
          accessibilityRole="link"
          suppressHighlighting
        >{p.text}</Text>
      ) : p.text))}
    </Text>
  );
}

// Primeiras palavras p/ a miniatura (até ~28 caracteres, sem quebrar palavra).
export function textStatusSnippet(text, max = 28) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (Array.from(s).length <= max) return s;
  const cut = Array.from(s).slice(0, max).join('');
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.5 ? cut.slice(0, sp) : cut).trim()}…`;
}

// Miniatura circular: fundo da cor do status + primeiras palavras.
export function TextStatusThumb({ text, bg, font, size = 52, style }) {
  return (
    <View
      style={[{
        width: size, height: size, borderRadius: size / 2, overflow: 'hidden',
        backgroundColor: textStatusSolid(bg), alignItems: 'center', justifyContent: 'center', padding: size * 0.1,
      }, style]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text
        numberOfLines={3}
        style={[{ color: '#FFFFFF', fontSize: Math.max(7, Math.round(size * 0.15)), lineHeight: Math.max(9, Math.round(size * 0.19)), textAlign: 'center' }, textStatusFontStyle(font)]}
      >{textStatusSnippet(text)}</Text>
    </View>
  );
}

// Item de status é de texto puro (sem mídia)?
export function isTextStatusItem(it) {
  if (!it || it.type !== 'text') return false;
  const m = it.media_url || '';
  return !m;
}

export function itemFontStyle(it) {
  return it?.font_style || it?.meta?.font_style || 'sans';
}
export function itemBg(it) {
  return it?.bg_color || it?.background || it?.bgColor || '#111111';
}

// { text, bg, font } da miniatura p/ o item mais recente de um grupo (item real
// do status_list ou prévia do status_manifest), ou null se não for texto.
export function textPreviewOf(items) {
  const arr = Array.isArray(items) ? items : [];
  const it = arr[arr.length - 1];
  if (!it) return null;
  if (isTextStatusItem(it) && !it._placeholder && it.content) return { text: it.content, bg: itemBg(it), font: itemFontStyle(it) };
  if (it._preview_text) return { text: it._preview_text, bg: it._preview_bg, font: it._preview_font };
  return null;
}
