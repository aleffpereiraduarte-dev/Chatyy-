// modules/expo-status-studio — [2026-10-15 native-status-studio]
//
// Criador de STATUS nativo (nível Instagram/WhatsApp), estética P&B do app:
//   • Status de TEXTO: fundo cor/gradiente (toque troca), 5 fontes do sistema
//     (as mesmas do visualizador), auto-ajuste, alinhamento, fundo da letra,
//     prévia idêntica ao visualizador nativo (expo-media-viewer story).
//   • Foto/vídeo: camadas de texto/emoji/local (arrastar, pinçar, girar, guia
//     de centro, lixeira), figurinhas interativas (menção, link, enquete,
//     pergunta, contagem, música) que geram o MESMO JSON de overlay que o
//     servidor e os visualizadores já entendem, desenho com pincéis e filtros
//     (as mesmas matrizes 4x5 do statusFilters.js).
//   • Público + legenda; o upload continua no JS (services/statusPublishQueue).
//
// Binário sem o módulo (antigo / Expo Go / web) ou kill switch
// globalThis.__chatyy_native_status_studio === false → isAvailable() false e o
// chamador segue no estúdio JS (components/status/StatusStudio.js).

import { requireOptionalNativeModule } from 'expo-modules-core';

export type StudioMediaItem = {
  uri: string;
  type: 'image' | 'video';
  width?: number;
  height?: number;
  filter?: string;
  boomerang?: boolean;
};

export type StudioTrack = {
  id?: string | number;
  title: string;
  artist?: string;
  previewUrl?: string;
  coverUrl?: string;
  durationSec?: number;
};

export type StudioMusic = { title: string; artist?: string; previewUrl?: string; coverUrl?: string; startMs?: number };

export type StudioOptions = {
  mode: 'text' | 'media';
  items?: StudioMediaItem[];
  labels?: Record<string, string>;
  filters?: { id: string; label: string; m: number[] }[];
  textBackgrounds?: { value: string; colors: string[] }[];
  textBgIndex?: number;
  fonts?: { id: string; label: string }[];
  textMax?: number;
  palette?: string[];
  emojis?: string[];
  contacts?: { email: string; name: string }[];
  musicCatalog?: StudioTrack[];
  music?: StudioMusic | null;
  audience?: 'all' | 'contacts' | 'close_friends' | 'except';
  closeFriendsCount?: number;
  exceptCount?: number;
  canCamera?: boolean;
  canGallery?: boolean;
};

export type StudioSticker = Record<string, any> & { type: string; id: string; x: number; y: number };

export type StudioOutItem = {
  kind: 'image' | 'video';
  uri: string;
  width?: number;
  height?: number;
  mime?: string;
  filter?: string;
  boomerang?: boolean;
  stickers?: StudioSticker[];
  textOverlays?: { text: string; x: number; y: number; color: string }[];
  drawPaths?: { color: string; points: { x: number; y: number }[] }[];
  mentions?: string[];
};

export type StudioResult =
  | { action: 'cancel' }
  | { action: 'camera' }
  | { action: 'editAudience'; which: 'close_friends' | 'except' }
  | { action: 'error'; error?: string }
  | {
    action: 'publish';
    audience: 'all' | 'contacts' | 'close_friends' | 'except';
    caption?: string;
    music?: StudioMusic | null;
    text?: { text: string; bg: string; font: string };
    items?: StudioOutItem[];
  };

export type StudioRequest = { reqId: number; kind: 'musicSearch' | 'gallery' | 'location'; q?: string };

type NativeMod = {
  apiVersion(): number;
  open(options: StudioOptions): Promise<StudioResult | null>;
  respond(reqId: number, data: Record<string, any>): Promise<boolean>;
  close(): Promise<boolean>;
  addListener(name: 'onRequest', cb: (e: StudioRequest) => void): { remove(): void };
};

let _mod: NativeMod | null | undefined;

function killed(): boolean {
  try {
    return (globalThis as any).__chatyy_native_status_studio === false;
  } catch {
    return false;
  }
}

function mod(): NativeMod | null {
  if (killed()) return null;
  if (_mod !== undefined) return _mod;
  _mod = null;
  try {
    _mod = (requireOptionalNativeModule('ChatyyStatusStudio') as any) || null;
  } catch {
    _mod = null;
  }
  return _mod;
}

export function isAvailable(): boolean {
  const m = mod();
  return !!m && typeof m.open === 'function';
}

export function apiVersion(): number {
  const m = mod();
  if (!m || typeof m.apiVersion !== 'function') return 0;
  try { return Number(m.apiVersion()) || 0; } catch { return 0; }
}

/** Nunca lança: falha → { action: 'error' }; null = não apresentou (o chamador usa o JS). */
export async function open(options: StudioOptions): Promise<StudioResult | null> {
  const m = mod();
  if (!m) return null;
  try {
    const r = await m.open(options);
    if (r == null) return null;
    if (typeof r !== 'object' || !(r as any).action) return { action: 'error', error: 'bad_result' };
    return r;
  } catch (e: any) {
    return { action: 'error', error: String(e?.message || e || 'failed') };
  }
}

export function respond(reqId: number, data: Record<string, any>): void {
  const m = mod();
  if (!m) return;
  try {
    const p: any = m.respond(Number(reqId) || 0, data || {});
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {}
}

export async function close(): Promise<void> {
  const m = mod();
  if (!m) return;
  try { await m.close(); } catch {}
}

export function addRequestListener(cb: (e: StudioRequest) => void): { remove(): void } {
  const m = mod();
  if (!m || typeof m.addListener !== 'function') return { remove() {} };
  try {
    return m.addListener('onRequest', cb);
  } catch {
    return { remove() {} };
  }
}

export default { isAvailable, apiVersion, open, respond, close, addRequestListener };
