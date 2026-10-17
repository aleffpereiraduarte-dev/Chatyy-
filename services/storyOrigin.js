// [2026-10-16 motion] Origem do story (Telegram): o anel tocado registra o
// próprio nó (heroRef, por superfície + e-mail); no toque marca qual anel foi
// e o nativeStories mede o frame antes do open — o viewer nativo cresce do
// anel e volta para ele ao fechar (mesma pessoa).
// Kill switches: globalThis.__chatyy_motion_story_origin = false (e as do
// mediaHero: __chatyy_hero = false desliga o registro de nós).
import { heroRef, measureHero } from './mediaHero';

let _pending = null; // { key, email, at }

function _key(surface, email) {
  return 'story:' + String(surface || '') + ':' + String(email || '').toLowerCase();
}

function _off() {
  try {
    const g = globalThis;
    return g.__chatyy_motion_story_origin === false || g.__chatyy_motion_story === false || g.__chatyy_motion === false;
  } catch { return false; }
}

/** Callback ref estável p/ o contêiner do anel (use com collapsable={false}). */
export function storyOriginRef(surface, email) {
  if (!email || _off()) return undefined;
  return heroRef(_key(surface, email), 999);
}

/** Chame no onPress do anel, antes de abrir o viewer. */
export function markStoryOrigin(surface, email) {
  if (!email || _off()) { _pending = null; return; }
  _pending = { key: _key(surface, email), email: String(email).toLowerCase(), at: Date.now() };
}

/**
 * Lista NATIVA (sem nós RN): o evento do toque traz o frame do avatar em
 * coordenadas de janela (pt/dp) → vale como a marca acima.
 */
export function setStoryOriginHint(email, rect) {
  if (!email || !rect || _off()) return;
  const x = Number(rect.x), y = Number(rect.y), width = Number(rect.width), height = Number(rect.height);
  if (![x, y, width, height].every(Number.isFinite) || width < 2 || height < 2) return;
  _pending = { rect: { x, y, width, height }, email: String(email).toLowerCase(), at: Date.now() };
}

/**
 * Frame do anel marcado se for desta pessoa (≤1,5 s) → Promise<rect|null>;
 * null síncrono quando não há marca (o open não espera nada).
 */
export function takeStoryOrigin(email) {
  const p = _pending;
  _pending = null;
  if (!p || _off()) return null;
  if (Date.now() - p.at > 1500) return null;
  if (email && String(email).toLowerCase() !== p.email) return null;
  if (p.rect) return Promise.resolve(p.rect);
  return measureHero(p.key).catch(() => null);
}
