// services/nativeMediaOpen.js — [2026-10-18 photos-native-always]
//
// Abre fotos/vídeos de Fotos e do Drive (Cloud) SEMPRE no visualizador NATIVO
// (modules/expo-media-viewer: pager + zoom + vídeo nativos, nível Telegram /
// Google Fotos). O visualizador JS de cada tela fica só como reserva: binário
// sem o módulo, web, open() falhou → o chamador recebe 0 e segue no JS.
//
// Kill switch OTA/console: globalThis.__chatyy_photos_native_always = false →
// Fotos/Drive voltam ao visualizador JS (o viewer nativo do chat não muda;
// esse tem o próprio __chatyy_native_viewer).
//
// Janela: a lista inteira vai para o pager quando cabe (≤ MAX_ITEMS); acima
// disso, uma janela centrada no item tocado. Os índices dos eventos voltam
// já traduzidos para a lista ORIGINAL do chamador.
import { Platform } from 'react-native';

const MAX_ITEMS = 400;

let _NV;
function nv() {
  if (_NV !== undefined) return _NV;
  _NV = null;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try { _NV = require('../modules/expo-media-viewer'); } catch { _NV = null; }
  return _NV;
}

/** true = Fotos/Drive devem abrir no viewer nativo (binário tem o módulo + sem kill switch). */
export function nativeMediaAlways() {
  try { if (globalThis.__chatyy_photos_native_always === false) return false; } catch {}
  const m = nv();
  try { return !!(m && m.isAvailable && m.isAvailable()); } catch { return false; }
}

function tr(t, k, fb) {
  try { const v = typeof t === 'function' ? t(k) : null; return v && v !== k ? v : fb; } catch { return fb; }
}

export function nativeViewerLabels(t) {
  return {
    close: tr(t, 'nativeViewer.close', 'Fechar'),
    share: tr(t, 'nativeViewer.share', 'Compartilhar'),
    save: tr(t, 'nativeViewer.save', 'Salvar'),
    star: tr(t, 'nativeViewer.star', 'Favoritar'),
    unstar: tr(t, 'nativeViewer.unstar', 'Desfavoritar'),
    play: tr(t, 'nativeViewer.play', 'Reproduzir'),
    pause: tr(t, 'nativeViewer.pause', 'Pausar'),
    loadFailed: tr(t, 'nativeViewer.loadFailed', 'Não foi possível carregar'),
    retry: tr(t, 'nativeViewer.retry', 'Tentar novamente'),
    delete: tr(t, 'nativeViewer.delete', 'Apagar'),
    speed: tr(t, 'nativeViewer.speed', 'Velocidade'),
    mute: tr(t, 'nativeViewer.mute', 'Sem som'),
    unmute: tr(t, 'nativeViewer.unmute', 'Ativar som'),
  };
}

export function setNativeActionState(action, state) {
  const m = nv();
  try { m && m.setActionState(action, state); } catch {}
}

export function setNativeReturnRect(index, rect) {
  const m = nv();
  try { m && m.setReturnRect && m.setReturnRect(index, rect || null, 0); } catch {}
}

/**
 * Abre `list[index]` no viewer nativo.
 *   list      — lista ORIGINAL do chamador (fotos, arquivos…)
 *   toItem(x) — x → MediaViewerItem ({ uri, thumbUri, type, … }) ou null (não é mídia)
 *   onAction(ev, srcIndex, srcItem) / onIndexChange(srcIndex, srcItem) / onClose(srcIndex)
 * Devolve o session id (0 = não abriu → use o visualizador JS).
 */
export async function openNativeMediaList({
  list, index = 0, toItem, t, sourceRect,
  allowShare = true, allowSave = true, allowStar = false, allowDelete = false,
  secure = false, // [2026-10-22 print-local] FLAG_SECURE no Dialog (Android) / escudo (iOS)
  onAction, onIndexChange, onClose,
}) {
  if (!nativeMediaAlways()) return 0;
  const NV = nv();
  if (!NV || !Array.isArray(list) || list.length === 0) return 0;
  const at = Math.max(0, Math.min(list.length - 1, Number(index) || 0));
  let from = 0, to = list.length;
  if (list.length > MAX_ITEMS) {
    from = Math.max(0, Math.min(at - Math.floor(MAX_ITEMS / 2), list.length - MAX_ITEMS));
    to = from + MAX_ITEMS;
  }
  const items = [];
  const srcIdx = [];
  let start = -1;
  for (let i = from; i < to; i++) {
    let it = null;
    try { it = toItem(list[i], i); } catch { it = null; }
    if (!it || !it.uri) continue;
    if (i === at) start = items.length;
    items.push(it);
    srcIdx.push(i);
  }
  if (start < 0 || items.length === 0) return 0;
  let sid = 0;
  try {
    sid = await NV.open({
      items,
      index: start,
      labels: nativeViewerLabels(t),
      allowShare: !!allowShare,
      allowSave: !!allowSave,
      allowForward: false,
      allowStar: !!allowStar,
      ...(allowDelete ? { allowDelete: true } : {}),
      ...(secure ? { secure: true } : {}),
      ...(sourceRect ? { sourceRect, sourceRadius: 0 } : {}),
    });
  } catch { sid = 0; }
  if (!sid) return 0;
  const subs = [];
  const same = (ev) => ev && ev.session === sid;
  const map = (i) => { const k = Number(i) || 0; return srcIdx[Math.max(0, Math.min(srcIdx.length - 1, k))]; };
  const cleanup = () => { subs.forEach((s) => { try { s.remove(); } catch {} }); subs.length = 0; };
  subs.push(NV.addListener('onIndexChange', (ev) => {
    if (!same(ev) || !onIndexChange) return;
    const si = map(ev.index);
    try { onIndexChange(si, list[si], ev.index); } catch {}
  }));
  subs.push(NV.addListener('onAction', (ev) => {
    if (!same(ev) || !onAction) return;
    const si = map(ev.index);
    try { onAction(ev, si, list[si]); } catch {}
  }));
  subs.push(NV.addListener('onClose', (ev) => {
    if (!same(ev)) return;
    cleanup();
    try { onClose && onClose(map(ev.index)); } catch {}
  }));
  return sid;
}

export function closeNativeMedia() {
  const m = nv();
  try { m && m.close(); } catch {}
}
