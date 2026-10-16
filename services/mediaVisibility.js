// services/mediaVisibility.js — [2026-10-15 media-visibility]
//
// "Salvar na galeria" (WhatsApp: Android "Visibilidade da mídia" / iOS
// "Salvar no Rolo da Câmera"). Decide se uma foto/vídeo RECEBIDO que acabou de
// ser baixado (auto-download ou toque) também vai para o app Fotos do aparelho
// (álbum "Chatyy"). Desligado = mídia fica só no armazenamento do app.
//
//   • Global por CONTA: chat_settings.save_media_to_gallery (bool), sincronizado
//     pelo chat_update_settings (blob livre) via settingsCache (snapshot por
//     conta + commit otimista + fila offline).
//   • Por conversa: chat_settings.save_media_to_gallery_convs = { "c<id>": true|false }
//     (ausente = "Padrão", segue o global). Chave com prefixo "c" para o PHP
//     nunca transformar o mapa em lista no json_encode.
//   • Padrão (sem valor na conta): a chave antiga do APARELHO
//     ('autoSaveMediaToGallery', mediaCache) → mantém o comportamento de hoje
//     (LIGADO, se o usuário nunca mexeu) — ninguém é surpreendido.
//
// Quem chama: mediaCache.maybeAutoSaveToGallery / _runGallerySave (gate),
// Configurações → Conversas (global) e Dados do contato/grupo (por conversa).
import { Platform } from 'react-native';

const SECTION = 'chat_settings';
export const KEY_GLOBAL = 'save_media_to_gallery';
export const KEY_CONVS = 'save_media_to_gallery_convs';
const MAX_CONV_OVERRIDES = 500;

function _sc() { try { return require('./settingsCache'); } catch { return null; } }

function _bool(v) {
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  return null;
}

function _snapshot(acct) {
  const sc = _sc();
  if (!sc) return null;
  try {
    const v = acct ? sc.peekFor(SECTION, acct) : sc.peek(SECTION);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

function _convMap(snap) {
  const m = snap && snap[KEY_CONVS];
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}

function _ck(cid) {
  if (cid == null || cid === '') return null;
  return 'c' + String(cid);
}

/** Conta ativa (e-mail minúsculo) — '' sem conta. */
export function activeAccount() {
  const sc = _sc();
  try { return sc ? sc.activeAccount() : ''; } catch { return ''; }
}

function _legacyDevice() {
  try { return !!require('./mediaCache').isAutoSaveMediaToGalleryOn(); } catch { return true; }
}

// [2026-10-16 media-vis-compiler] Versões PURAS (recebem o snapshot da seção).
// Telas React DEVEM usar estas com o snapshot vindo de um hook (useSection /
// estado): o React Compiler (app.json experiments.reactCompiler) memoiza para
// sempre uma chamada sem dependência reativa — `mv.isGlobalOn()` virava
// constante do 1º render e o interruptor "Salvar no Rolo da Câmera" voltava
// para LIGADO a cada toque (gravava false no servidor, mas a tela não mudava).
/** Snapshot atual da seção chat_settings (conta ativa) — ou null. */
export function snapshot(acct) { return _snapshot(acct); }

/** Global a partir de um snapshot (sem valor na conta → chave antiga do aparelho). */
export function isGlobalOnIn(snap) {
  const s = snap && typeof snap === 'object' && !Array.isArray(snap) ? snap : null;
  const b = _bool(s?.[KEY_GLOBAL]);
  return b != null ? b : _legacyDevice();
}

/** 'default' | 'on' | 'off' para a conversa, a partir de um snapshot. */
export function getConvModeIn(snap, cid) {
  const k = _ck(cid);
  if (!k) return 'default';
  const s = snap && typeof snap === 'object' && !Array.isArray(snap) ? snap : null;
  const b = _bool(_convMap(s)[k]);
  return b == null ? 'default' : (b ? 'on' : 'off');
}

/** Global da conta (true/false). */
export function isGlobalOn(acct) {
  return isGlobalOnIn(_snapshot(acct));
}

/** 'default' | 'on' | 'off' para a conversa. */
export function getConvMode(cid, acct) {
  return getConvModeIn(_snapshot(acct), cid);
}

/** Decisão final: a conversa sobrescreve o global. */
export function shouldSaveToGallery(cid, acct) {
  if (Platform.OS === 'web') return false;
  const mode = getConvMode(cid, acct);
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return isGlobalOn(acct);
}

/** Configurações → Conversas. */
export function setGlobal(on) {
  const sc = _sc();
  const v = !!on;
  // Religar limpa o "permissão negada" da sessão (mediaCache). A chave antiga
  // do APARELHO não é tocada (vale p/ todas as contas; só serve de migração).
  if (v) { try { require('./mediaCache').resetAutoSavePermLatch?.(); } catch {} }
  if (!sc || !activeAccount()) return Promise.resolve({ ok: false });
  return sc.commit(SECTION, {
    patch: { [KEY_GLOBAL]: v },
    action: 'chat_update_settings',
    params: { settings: { [KEY_GLOBAL]: v } },
  }).catch(() => ({ ok: false }));
}

/** Dados do contato/grupo: mode = 'default' | 'on' | 'off'. */
export function setConvMode(cid, mode) {
  const sc = _sc();
  const k = _ck(cid);
  if (!sc || !k || !activeAccount()) return Promise.resolve({ ok: false });
  const next = { ..._convMap(_snapshot()) };
  delete next[k];
  if (mode === 'on') next[k] = true;
  else if (mode === 'off') next[k] = false;
  // Teto (mais antigos saem primeiro — ordem de inserção).
  const keys = Object.keys(next);
  if (keys.length > MAX_CONV_OVERRIDES) {
    for (const kk of keys.slice(0, keys.length - MAX_CONV_OVERRIDES)) delete next[kk];
  }
  if (mode === 'on' || mode === 'off') {
    // Reinsere no fim (mais recente) p/ o teto acima não descartá-la.
    const v = next[k]; delete next[k]; next[k] = v;
  }
  return sc.commit(SECTION, {
    patch: { [KEY_CONVS]: next },
    action: 'chat_update_settings',
    params: { settings: { [KEY_CONVS]: next } },
  }).catch(() => ({ ok: false }));
}

/** Assina mudanças (snapshot da seção) — devolve unsubscribe. */
export function subscribe(fn) {
  const sc = _sc();
  if (!sc) return () => {};
  try { return sc.subscribe(SECTION, () => { try { fn(); } catch {} }); } catch { return () => {}; }
}

/** Garante o snapshot fresco (2º plano). */
export function revalidate() {
  const sc = _sc();
  try { sc && sc.revalidate(SECTION).catch(() => {}); } catch {}
}

// ── Backup de fotos: excluir o que o Chatyy salvou ─────────────────────────
// O motor nativo (modules/expo-photos-backup) já ignora o álbum/pastas
// "Chatyy". Este helper cobre o fluxo JS antigo (binários sem o motor nativo):
// ids dos assets do álbum "Chatyy" (iOS: álbum; Android: Pictures/Chatyy e
// Movies/Chatyy = 2 "álbuns" com o mesmo nome). Cache de 5 min.
let _albumIdsCache = null;
let _albumIdsAt = 0;
export async function getChatyyAlbumAssetIds() {
  if (Platform.OS === 'web') return new Set();
  if (_albumIdsCache && Date.now() - _albumIdsAt < 5 * 60 * 1000) return _albumIdsCache;
  const ids = new Set();
  try {
    const ML = require('expo-media-library');
    let album = null;
    try { album = require('./mediaCache').GALLERY_ALBUM || 'Chatyy'; } catch { album = 'Chatyy'; }
    const albums = await ML.getAlbumsAsync().catch(() => []);
    for (const a of (albums || [])) {
      if (!a || a.title !== album) continue;
      let after; let guard = 50;
      while (guard-- > 0) {
        const page = await ML.getAssetsAsync({ album: a, first: 1000, after, mediaType: [ML.MediaType.photo, ML.MediaType.video] });
        for (const x of (page?.assets || [])) if (x && x.id) ids.add(x.id);
        if (!page?.hasNextPage || !page.endCursor) break;
        after = page.endCursor;
      }
    }
  } catch {}
  _albumIdsCache = ids;
  _albumIdsAt = Date.now();
  return ids;
}
