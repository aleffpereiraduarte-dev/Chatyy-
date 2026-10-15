// modules/expo-media-viewer — [2026-10-14 native-viewer]
//
// Visualizador de mídia NATIVO (fotos + vídeos) usado pelo
// components/ChatMediaViewer.js no iOS/Android. Binário sem o módulo (build
// antigo, Expo Go, web) → isAvailable() === false e o chamador usa o pager JS.
//
//   iOS: UICollectionView paginada (12 pt entre páginas) + UIScrollView zoom
//        (1…4, duplo toque) + AVPlayerLayer; arrastar vertical fecha.
//   Android: Dialog tela cheia + ViewPager2 + ImageView com Matrix (pinça /
//        duplo toque) + Media3 ExoPlayer; mesmos gestos.
//
// API:
//   open({ items, index, labels, allowShare, allowSave, allowForward, allowStar })
//     → Promise<number> (session id; 0 = não abriu)
//   close(), setActionState(action, 'busy' | 'done' | 'idle'), prefetch(uris)
//   addListener('onIndexChange' | 'onAction' | 'onClose', cb)
//   Todos os eventos trazem `session` — ignore os de sessões antigas.

import { requireOptionalNativeModule } from 'expo-modules-core';

export type MediaViewerItem = {
  /** URL remota (https) ou file:// — fonte principal. */
  uri: string;
  /** file:// já baixado no aparelho (preferido quando existe). */
  localUri?: string | null;
  /** Miniatura/placeholder (https, file:// ou data:image/...;base64) mostrada antes da grande. */
  thumbUri?: string | null;
  type: 'image' | 'video';
  messageId?: string | number | null;
  caption?: string;
  senderName?: string;
  /** Já formatado no JS (i18n). Se vazio, o nativo formata createdAt. */
  dateLabel?: string;
  createdAt?: string | number | null;
  width?: number;
  height?: number;
  starred?: boolean;
};

export type MediaViewerLabels = {
  close?: string;
  share?: string;
  save?: string;
  forward?: string;
  star?: string;
  unstar?: string;
  play?: string;
  pause?: string;
  loadFailed?: string;
  retry?: string;
};

export type MediaViewerOpenOptions = {
  items: MediaViewerItem[];
  index?: number;
  labels?: MediaViewerLabels;
  allowShare?: boolean;
  allowSave?: boolean;
  allowForward?: boolean;
  allowStar?: boolean;
};

export type MediaViewerAction = 'share' | 'save' | 'forward' | 'star';

export type MediaViewerEvents = {
  onIndexChange: (e: { session: number; index: number }) => void;
  onAction: (e: { session: number; action: MediaViewerAction; index: number; messageId?: string; starred?: boolean }) => void;
  onClose: (e: { session: number; index: number; reason: string }) => void;
};

type NativeMod = {
  apiVersion(): number;
  open(options: MediaViewerOpenOptions): Promise<number>;
  close(): Promise<boolean>;
  setActionState(action: MediaViewerAction, state: 'busy' | 'done' | 'idle'): Promise<boolean>;
  prefetch(uris: string[]): Promise<boolean>;
  addListener<K extends keyof MediaViewerEvents>(name: K, cb: MediaViewerEvents[K]): { remove(): void };
};

let _mod: NativeMod | null | undefined;

function mod(): NativeMod | null {
  if (_mod !== undefined) return _mod;
  _mod = null;
  try {
    // Kill switch OTA/console: globalThis.__chatyy_native_viewer = false
    if ((globalThis as any).__chatyy_native_viewer === false) return null;
  } catch {}
  try {
    _mod = (requireOptionalNativeModule('ChatyyMediaViewer') as any) || null;
  } catch {
    _mod = null;
  }
  return _mod;
}

export function isAvailable(): boolean {
  try {
    if ((globalThis as any).__chatyy_native_viewer === false) return false;
  } catch {}
  const m = mod();
  return !!m && typeof m.open === 'function';
}

export async function open(options: MediaViewerOpenOptions): Promise<number> {
  const m = mod();
  if (!m) return 0;
  try {
    const sid = await m.open(options);
    return typeof sid === 'number' ? sid : 0;
  } catch {
    return 0;
  }
}

export async function close(): Promise<void> {
  const m = mod();
  if (!m) return;
  try { await m.close(); } catch {}
}

export function setActionState(action: MediaViewerAction, state: 'busy' | 'done' | 'idle'): void {
  const m = mod();
  if (!m) return;
  try { const r: any = m.setActionState(action, state); if (r && r.catch) r.catch(() => {}); } catch {}
}

export function prefetch(uris: string[]): void {
  const m = mod();
  if (!m || !Array.isArray(uris) || uris.length === 0) return;
  try { const r: any = m.prefetch(uris.filter(Boolean)); if (r && r.catch) r.catch(() => {}); } catch {}
}

export function addListener<K extends keyof MediaViewerEvents>(name: K, cb: MediaViewerEvents[K]): { remove(): void } {
  const m = mod();
  if (!m || typeof m.addListener !== 'function') return { remove() {} };
  try {
    return m.addListener(name, cb);
  } catch {
    return { remove() {} };
  }
}

export default { isAvailable, open, close, setActionState, prefetch, addListener };
