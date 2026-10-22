// [2026-10-22 stkmake] "Fazer figurinha" no menu da mensagem (JS e lista nativa).
//
//   • image   → abre o StickerMaker já com a foto (recorte/contorno/texto) → salva em
//               "Minhas figurinhas" pelo fluxo do próprio maker (chat_sticker_create normalize=1).
//   • gif     → figurinha ANIMADA: o arquivo vai ao servidor (chat_sticker_create_animated,
//               crop=1 → WebP animado 512×512 corte central, ≤ 3 s, ≤ 500 KB) e entra no
//               pacote pessoal.
//   • sticker → animada: salva no pacote pessoal (stickerSave); estática: abre o maker.
//
// Conversa E2EE: a mídia vem SEMPRE decifrada do aparelho (e2ee5.mediaFileFor) — nunca a URL
// cifrada. Kill (OTA): globalThis.__chatyy_sticker_make = false.
import { Platform } from 'react-native';

function _tf(t, k, fb) {
  try { const v = t ? t(k) : ''; return v && v !== k ? v : fb; } catch { return fb; }
}
function _isViewOnce(m) {
  const v = m && (m.is_view_once ?? m.isViewOnce ?? m.view_once);
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}
function _httpContent(m) {
  const c = typeof m?.content === 'string' ? m.content.trim() : '';
  return /^https?:\/\//i.test(c) ? c : '';
}
function _isE2ee(m) { return !!(m && m._e5Media && !m.file_url); }

export function stickerMakeOn() {
  try { return globalThis.__chatyy_sticker_make !== false; } catch { return true; }
}

/** 'image' | 'gif' | 'sticker' | null — se a mensagem oferece "Fazer figurinha". */
export function stickerMakeKind(m) {
  if (!m || m.deleted_at || !stickerMakeOn() || _isViewOnce(m) || m._uploading) return null;
  const ty = String(m.type || m.message_type || '').toLowerCase();
  if (ty !== 'image' && ty !== 'gif' && ty !== 'sticker') return null;
  if (!(m.file_url || _httpContent(m) || _isE2ee(m))) return null;
  if (ty === 'image' && !m.file_url && !_isE2ee(m)) return null;
  return ty;
}

async function _resolveSrc(m, api) {
  if (_isE2ee(m)) {
    const l = m._localUri;
    if (typeof l === 'string' && /^(file|content|blob):/i.test(l)) return l;
    try {
      const r = await require('../../services/e2ee/e2ee5').mediaFileFor(m);
      return (r && r.uri) || null;
    } catch { return null; }
  }
  const u = m.file_url || _httpContent(m);
  if (!u) return null;
  try { return api.getMediaUrl ? api.getMediaUrl(u) : u; } catch { return u; }
}

function _isAnimatedSticker(m, src) {
  if (m.is_animated === true || m.is_animated === 1 || m.is_animated === 't') return true;
  return /\.(gif|mp4|webm)(\?|$)/i.test(String(src || ''));
}

/**
 * Executa "Fazer figurinha". ctx: { api, t, openMaker(src), alert(title, body) }.
 * openMaker já deve esperar o menu fechar (iOS: nunca Modal sobre Modal).
 */
export async function makeStickerFromMessage(m, ctx) {
  const kind = stickerMakeKind(m);
  if (!kind || !ctx) return;
  const { api, t } = ctx;
  const alert = (a, b) => { try { ctx.alert && ctx.alert(a, b); } catch {} };
  const fail = () => alert(_tf(t, 'stickerMake.failTitle', 'Figurinha'), _tf(t, 'stickerMake.failed', 'Não foi possível fazer a figurinha. Tente de novo.'));
  const savedOk = () => alert(_tf(t, 'stickerMake.savedTitle', 'Figurinha criada'), _tf(t, 'stickerMake.saved', 'Salva em Minhas figurinhas.'));
  const src = await _resolveSrc(m, api);
  if (!src) { fail(); return; }

  if (kind === 'image' || (kind === 'sticker' && (_isE2ee(m) || !_isAnimatedSticker(m, src)))) {
    try { ctx.openMaker(src); } catch { fail(); }
    return;
  }

  if (kind === 'sticker') {
    try {
      const mid = Number(m.id);
      const r = await api.stickerSave({ messageId: Number.isFinite(mid) && mid > 0 ? mid : null, url: Number.isFinite(mid) && mid > 0 ? '' : (m.file_url || _httpContent(m)) });
      if (r && r.success !== false) savedOk(); else fail();
    } catch { fail(); }
    return;
  }

  // GIF → figurinha animada no servidor (ffmpeg: corte central, ≤ 3 s, ≤ 500 KB).
  try {
    const isVid = /\.(mp4|webm|mov)(\?|$)/i.test(String(src));
    const name = isVid ? 'sticker.mp4' : 'sticker.gif';
    const type = isVid ? 'video/mp4' : 'image/gif';
    let uri = src;
    if (Platform.OS !== 'web' && /^https?:\/\//i.test(src)) {
      const FS = require('expo-file-system/legacy');
      const dest = `${FS.cacheDirectory}stkmake-${Date.now()}.${isVid ? 'mp4' : 'gif'}`;
      const d = await FS.downloadAsync(src, dest);
      uri = d && d.status >= 200 && d.status < 300 ? d.uri : null;
    }
    if (!uri) { fail(); return; }
    const r = await api.chatStickerCreateAnimated({ uri, name, type }, { crop: true });
    const d = (r && (r.data || r)) || {};
    if (r && r.success !== false && d.url) { savedOk(); return; }
    if (d && d.reason === 'too_large') {
      alert(_tf(t, 'stickerMake.failTitle', 'Figurinha'), _tf(t, 'stickerMake.tooLarge', 'Este GIF ficou grande demais para virar figurinha (máx. 500 KB).'));
      return;
    }
    fail();
  } catch { fail(); }
}
