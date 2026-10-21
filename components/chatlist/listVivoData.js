// components/chatlist/listVivoData.js — [2026-10-21 lista-viva]
//
// Parte PURA (sem React) da "lista viva" (mockup aprovado preview-2026/lista.html):
// chave liga/desliga, paleta quente dos avatares sem foto e a miniatura da
// última foto/vídeo. Usada pela linha JS (ChatListTab), pelo AvatarCircle e
// pelo adaptador da lista nativa (nativeAdapter.buildRow) — mesma regra nos 3.
//
// Kill switch (OTA): globalThis.__chatyy_list_vivo = false → tudo volta ao
// visual Grafite de antes (lido a cada chamada; não precisa reiniciar).
// Só vale com o tema Grafite (THEME_V2) ligado.

import { THEME_V2 } from '../../constants/theme';

export function listVivoOn() {
  if (!THEME_V2) return false;
  try { return globalThis.__chatyy_list_vivo !== false; } catch { return true; }
}

// Verde do ponto "online" do mockup (--online).
export const VIVO_ONLINE = '#2FB36B';

// ── avatar sem foto: gradiente quente estável por pessoa ────────────────────
// areia · terracota · oliva · ardósia · malva · ocre (mockup, 135°), iniciais brancas.
export const WARM_GRADIENTS = Object.freeze([
  ['#D8B89A', '#9B6F52'],
  ['#C9A28F', '#8B5A4A'],
  ['#B7B892', '#6F7350'],
  ['#A9B4BD', '#5C6873'],
  ['#C7B2C4', '#7F6680'],
  ['#BFAE8C', '#7D6B48'],
]);

// Mesmo hash do AvatarCircle/nativeAdapter (semente = nome visível em minúsculas).
function _hashInt(s) {
  let h = 0;
  const str = s || '';
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
}
/**
 * Índice 0..5 na WARM_GRADIENTS (o nativo recebe este número como `w`).
 * = (índice de 8 gradientes do adaptador nativo, `g`) % 6 — a lista nativa que
 * só conhece `g` pinta a MESMA cor que o AvatarCircle do resto do app.
 */
export function warmIndex(seed) {
  return (_hashInt(String(seed || '').toLowerCase()) % 8) % WARM_GRADIENTS.length;
}
export function warmGradient(seed) {
  const [c1, c2] = WARM_GRADIENTS[warmIndex(seed)];
  return { c1, c2, gid: `avw${c1.slice(1)}${c2.slice(1)}` };
}

// ── miniatura da última mensagem (foto / vídeo) ─────────────────────────────
// Ordem: miniatura do servidor (thumb/poster/image_variants) → arquivo local do
// envio otimista → thumb_b64 → (foto) o próprio arquivo, que o expo-image reduz
// e costuma já estar no cache da bolha. Nunca para apagada / ver-uma-vez.
// Kill: globalThis.__chatyy_list_thumb_original = false (sem cair no original).
function _iv(lm) {
  let iv = lm && lm.image_variants;
  if (typeof iv === 'string') { try { iv = JSON.parse(iv); } catch { iv = null; } }
  return iv && typeof iv === 'object' ? iv : null;
}
function _abs(u) {
  if (!u || typeof u !== 'string') return '';
  if (/^(file|content|ph|data|blob|assets-library):/i.test(u)) return u;
  try { return require('../../services/api').getMediaUrl(u) || ''; } catch { return u; }
}
export function lastMediaKind(lm) {
  if (!lm || typeof lm !== 'object') return '';
  if (lm.deleted || lm.deleted_at || lm.is_view_once || lm.view_once) return '';
  const ty = String(lm.type || '');
  return ty === 'image' || ty === 'video' ? ty : '';
}
/** URL (ou data:) da miniatura da última foto/vídeo, ou '' quando não há. */
export function lastMediaThumb(lm) {
  const kind = lastMediaKind(lm);
  if (!kind) return '';
  const iv = _iv(lm);
  let u = lm.thumb_url || lm.thumb || lm.thumbnail_url || lm.poster_url || lm.video_thumb
    || (iv && (iv.thumb || iv.t320 || iv.poster || iv.display)) || '';
  if (typeof u !== 'string') u = '';
  if (!u && lm._posterUri) u = lm._posterUri;
  if (!u && kind === 'image' && lm._localUri) u = lm._localUri;
  if (!u && lm.thumb_b64 && typeof lm.thumb_b64 === 'string') return `data:image/jpeg;base64,${lm.thumb_b64}`;
  if (!u) {
    let orig = true;
    try { orig = globalThis.__chatyy_list_thumb_original !== false; } catch {}
    const f = typeof lm.file_url === 'string' ? lm.file_url : '';
    if (orig && f) {
      if (kind === 'image') u = f;
      // pôster gerado pelo servidor ao lado do vídeo (<arquivo>.thumb.jpg); se
      // ainda não existir a miniatura mostra só o glifo de vídeo.
      else if (/\/data\/chat-files\//.test(f) && !/\.thumb\.jpg$/i.test(f)) u = `${f}.thumb.jpg`;
    }
  }
  return _abs(u);
}
