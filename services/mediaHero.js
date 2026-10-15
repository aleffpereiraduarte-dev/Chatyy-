// [2026-10-15 hero] Transição "hero" bolha ↔ visualizador nativo (Telegram/WhatsApp).
//
// As miniaturas de foto/vídeo das bolhas registram o próprio nó por messageId
// (heroRef). O ChatMediaViewer mede (measureInWindow) a miniatura da mídia que
// abre — o viewer nativo anima a foto saindo dela — e, a cada troca de página,
// a da página atual — para a foto voltar à bolha certa ao fechar.
//
// Nó desmontado / fora da tela → null (o viewer fecha com o fade normal).
// Kill switch OTA/console: globalThis.__chatyy_hero = false.
import { Dimensions, Platform } from 'react-native';

const _nodes = new Map(); // id -> { node, radius }
const _refCbs = new Map(); // `${id}|${radius}` -> callback ref estável

export function heroEnabled() {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false;
  try { if (globalThis.__chatyy_hero === false) return false; } catch {}
  return true;
}

/**
 * Callback ref estável para a miniatura da mensagem `id` (raio dos cantos em pt/dp).
 * Uso: <View ref={heroRef(msg.id, 12)} collapsable={false}>…</View>
 */
export function heroRef(id, radius = 0) {
  if (id == null || id === '' || !heroEnabled()) return undefined;
  const key = String(id);
  const ck = key + '|' + (Number(radius) || 0);
  let cb = _refCbs.get(ck);
  if (cb) return cb;
  cb = (node) => {
    if (node) {
      _nodes.set(key, { node, radius: Number(radius) || 0, owner: cb });
    } else {
      const cur = _nodes.get(key);
      if (cur && cur.owner === cb) _nodes.delete(key);
    }
  };
  // Mapa de callbacks cresce com as mensagens vistas — corta em lote.
  if (_refCbs.size > 3000) _refCbs.clear();
  _refCbs.set(ck, cb);
  return cb;
}

// [2026-10-15 native-list hero] Lista de mensagens NATIVA (sem nós RN por
// miniatura): o dono registra um resolvedor (id → Promise<{x,y,width,height,
// radius}|null>, via ref.mediaFrame do ChatyyMessageList) e, no toque, uma
// dica com o frame exato da miniatura tocada (sem ida-e-volta ao nativo).
let _resolver = null;
const _hints = new Map(); // id -> { rect, radius, at }
const _lastRadius = new Map(); // id -> raio da última resolução
/** Registra o resolvedor da lista nativa; devolve a função que o remove. */
export function setHeroResolver(fn) {
  _resolver = typeof fn === 'function' ? fn : null;
  return () => { if (_resolver === fn) _resolver = null; };
}
/** Frame (janela) da miniatura tocada na lista nativa — vale ~2 s. */
export function setHeroHint(id, rect, radius = 0) {
  if (id == null || !rect) return;
  _hints.set(String(id), { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, radius: Number(radius) || 0, at: Date.now() });
  _lastRadius.set(String(id), Number(radius) || 0);
  if (_hints.size > 20) _hints.clear();
}

/** Raio registrado para a miniatura `id` (0 se nenhuma). */
export function heroRadius(id) {
  if (id == null) return 0;
  const e = _nodes.get(String(id));
  if (e) return e.radius;
  return _lastRadius.get(String(id)) || 0;
}

function _resolveExternal(id) {
  const key = String(id);
  const h = _hints.get(key);
  if (h) {
    _hints.delete(key);
    if (Date.now() - h.at < 2000) return Promise.resolve(h.rect);
  }
  if (!_resolver) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const t = setTimeout(() => finish(null), 150);
    try {
      Promise.resolve(_resolver(id)).then((r) => {
        clearTimeout(t);
        if (!r || !(r.width > 1) || !(r.height > 1)) { finish(null); return; }
        _lastRadius.set(key, Number(r.radius) || 0);
        if (_lastRadius.size > 400) _lastRadius.clear();
        finish({ x: r.x, y: r.y, width: r.width, height: r.height });
      }, () => { clearTimeout(t); finish(null); });
    } catch { clearTimeout(t); finish(null); }
  });
}

/**
 * Mede a miniatura `id` na janela → Promise<{x,y,width,height}|null>.
 * null se não montada, sem tamanho ou totalmente fora da tela.
 */
export function measureHero(id) {
  return new Promise((resolve) => {
    if (id == null || !heroEnabled()) { resolve(null); return; }
    const e = _nodes.get(String(id));
    const node = e && e.node;
    if (!node || typeof node.measureInWindow !== 'function') { _resolveExternal(id).then(resolve, () => resolve(null)); return; }
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const t = setTimeout(() => finish(null), 120);
    try {
      node.measureInWindow((x, y, width, height) => {
        clearTimeout(t);
        if (![x, y, width, height].every((n) => typeof n === 'number' && isFinite(n)) || width < 2 || height < 2) {
          finish(null);
          return;
        }
        try {
          const win = Dimensions.get('window');
          if (y + height <= 0 || x + width <= 0 || y >= win.height || x >= win.width) { finish(null); return; }
        } catch {}
        finish({ x, y, width, height });
      });
    } catch {
      clearTimeout(t);
      finish(null);
    }
  });
}

export default { heroEnabled, heroRef, heroRadius, measureHero, setHeroResolver, setHeroHint };
