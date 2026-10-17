// components/status/storyReactions.js — [2026-10-17 status-reacoes]
//
// Reações de STATUS estilo Instagram/WhatsApp, iguais no viewer nativo
// (iOS/Android) e no fallback JS (StoryViewer.js):
//   • fileira rápida acima do teclado ao tocar em "Responder" + "+" que abre a
//     grade completa de emojis do app (components/chat/nativeEmojiData.js);
//   • segurar o coração abre a mesma fileira numa bolha (desliza o dedo e solta);
//   • tocar no coração continua curtindo.
// Emojis aqui são CONTEÚDO (a reação enviada) — ícones de UI seguem em SVG.
// O servidor (chat.php status_react) aceita qualquer emoji de 1 grafema.
//
// Kill switch (OTA/console): globalThis.__chatyy_story_reactions
//   = false        → comportamento antigo (6 emojis fixos, sem "+", sem bolha)
//   = ['😂', '🔥'] → troca a fileira rápida (máx. 9)

export const STORY_LIKE = '❤️';

const DEFAULT_QUICK = ['\u{1F602}', '\u{1F62E}', '\u{1F60D}', '\u{1F622}', '\u{1F44F}', '\u{1F525}', '\u{1F64F}'];
const LEGACY_QUICK = ['\u{1F602}', '\u{1F62E}', '\u{1F60D}', '\u{1F622}', '\u{1F44F}', '\u{1F525}'];

// kind = ícone vetorial de reserva nos binários antigos (lista "Visualizações").
const KIND = {
  [STORY_LIKE]: 'heart', '❤': 'heart', '\u{1F60D}': 'heart', '\u{1F970}': 'heart',
  '\u{1F525}': 'flame', '\u{1F602}': 'laugh', '\u{1F923}': 'laugh', '\u{1F62E}': 'wow', '\u{1F62F}': 'wow',
  '\u{1F622}': 'sad', '\u{1F62D}': 'sad', '\u{1F44F}': 'clap', '\u{1F64F}': 'clap', '\u{1F44D}': 'thumbs',
};

function _flag() {
  try { return globalThis.__chatyy_story_reactions; } catch { return undefined; }
}

/** false = kill switch ligado (comportamento antigo). */
export function storyReactionsEnabled() {
  return _flag() !== false;
}

/** 1 grafema de emoji (mesma regra do servidor, versão leve p/ o cliente). */
export function isStoryReactionEmoji(e) {
  if (typeof e !== 'string') return false;
  const s = e.trim();
  if (!s || s.length > 32) return false;
  if (/[A-Za-z\s<>"'`]/.test(s)) return false;
  if (/^[0-9#*]$/.test(s)) return false;
  return true;
}

/** Fileira rápida (sem o coração — ele tem botão próprio). */
export function storyQuickReactions() {
  const f = _flag();
  if (f === false) return LEGACY_QUICK.slice();
  if (Array.isArray(f)) {
    const out = [];
    for (const x of f) {
      const e = typeof x === 'string' ? x.trim() : '';
      if (isStoryReactionEmoji(e) && !out.includes(e)) out.push(e);
      if (out.length >= 9) break;
    }
    if (out.length) return out;
  }
  return DEFAULT_QUICK.slice();
}

export function storyReactionKind(emoji) {
  if (!emoji) return '';
  return KIND[emoji] || 'heart';
}

/** [{ emoji, kind }] p/ o nativo (campo `reactions` do open). */
export function storyReactionDefs() {
  return storyQuickReactions().map(emoji => ({ emoji, kind: storyReactionKind(emoji) }));
}
