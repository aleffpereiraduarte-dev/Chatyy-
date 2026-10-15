// modules/expo-media-editor — [2026-10-15 native-editor]
//
// Editor de foto/vídeo NATIVO antes de enviar (chat e status), nível
// Telegram/WhatsApp, estética P&B (ícones vetoriais / SF Symbols, sem emoji na UI):
//   Foto: recortar + girar (Livre/Original/1:1/4:3/3:4/16:9/9:16), desenhar
//         (8 cores, 3 espessuras, desfazer), texto (5 fontes, cor, fundo;
//         arrastar/pinçar/girar; lixeira), figurinhas (emoji como objeto),
//         filtros = as MESMAS matrizes 4x5 do status (statusFilters.js) via
//         ColorMatrix (Android) / CIColorMatrix (iOS).
//   Vídeo: aparar com trilho de miniaturas (MediaMetadataRetriever /
//         AVAssetImageGenerator), mudo, capa. Corte/mudo SEM re-encode
//         (MediaExtractor+MediaMuxer / AVMutableComposition passthrough).
//   Modo 'compose': legenda + ver uma vez + HD + enviar. Modo 'edit': Concluir.
//
// Binário sem o módulo (build antigo, Expo Go, web) ou kill switch
// globalThis.__chatyy_native_editor === false → isAvailable() false e o
// chamador segue no editor JS (comportamento idêntico ao de antes).

import { requireOptionalNativeModule } from 'expo-modules-core';

export type MediaEditorFilter = {
  id: string;
  label: string;
  /** Matriz 4x5 linha a linha, translação normalizada 0..1 (formato do statusFilters.js). */
  m?: number[] | null;
};

export type MediaEditorLabels = Partial<Record<
  | 'close' | 'cancel' | 'undo' | 'crop' | 'filters' | 'stickers' | 'text' | 'draw' | 'rotate' | 'reset'
  | 'ratioFree' | 'ratioOriginal' | 'done' | 'send' | 'captionPlaceholder' | 'viewOnce' | 'viewOnceHint'
  | 'hdOn' | 'hdOff' | 'soundOn' | 'soundOff' | 'cover' | 'coverHint' | 'discardTitle' | 'discard'
  | 'processing' | 'saveFailed' | 'textPlaceholder' | 'font' | 'textBackground' | 'brushSize'
  | 'fontClassic' | 'fontModern' | 'fontSerif' | 'fontMono' | 'fontStrong' | 'filterOriginal',
  string
>>;

export type MediaEditorOptions = {
  uri: string;
  type: 'image' | 'video';
  /** 'compose' = legenda + enviar (default) · 'edit' = só Concluir (devolve o arquivo). */
  mode?: 'compose' | 'edit';
  caption?: string;
  captionMax?: number;
  viewOnce?: boolean;
  allowViewOnce?: boolean;
  hd?: boolean;
  allowHd?: boolean;
  filters?: MediaEditorFilter[];
  /** Figurinhas (emoji) que viram objetos na foto. Vazio = lista padrão do nativo. */
  stickers?: string[];
  labels?: MediaEditorLabels;
  /** Lado maior da foto exportada (padrão 3072; HD 4096). */
  maxDim?: number;
  hdMaxDim?: number;
  /** JPEG 0..1 (padrão 0.92 — mesma qualidade do editor JS). */
  quality?: number;
  /** FLAG_SECURE (Android) / tela preta durante gravação (iOS). */
  secure?: boolean;
  /** Liga/desliga ferramentas (todas true por padrão). */
  tools?: Partial<Record<'crop' | 'draw' | 'text' | 'stickers' | 'filters' | 'trim' | 'mute' | 'cover', boolean>>;
};

export type MediaEditorResult = {
  action: 'send' | 'done' | 'cancel' | 'error';
  error?: string;
  uri?: string;
  type?: 'image' | 'video';
  mimeType?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  size?: number;
  caption?: string;
  viewOnce?: boolean;
  hd?: boolean;
  /** Vídeo: JPEG do quadro escolhido como capa (relativo ao arquivo devolvido). */
  coverUri?: string;
  coverMs?: number;
  edits?: {
    changed: boolean;
    rotate?: number;
    crop?: { x: number; y: number; w: number; h: number };
    filter?: string;
    strokes?: number;
    objects?: number;
    texts?: number;
    stickers?: number;
    trimStartMs?: number;
    trimEndMs?: number;
    muted?: boolean;
    /** Vídeo: corte/mudo nativo falhou → `uri` é o ORIGINAL; o JS pode tentar o trimVideo. */
    exportFailed?: boolean;
  };
};

type NativeMod = {
  apiVersion(): number;
  open(options: MediaEditorOptions): Promise<MediaEditorResult>;
  close(): Promise<boolean>;
};

let _mod: NativeMod | null | undefined;

function killed(): boolean {
  try {
    return (globalThis as any).__chatyy_native_editor === false;
  } catch {
    return false;
  }
}

function mod(): NativeMod | null {
  if (killed()) return null;
  if (_mod !== undefined) return _mod;
  try {
    _mod = (requireOptionalNativeModule('ChatyyMediaEditor') as any) || null;
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

/** Nunca lança: falha → { action: 'error' } (o chamador cai no editor JS). */
export async function open(options: MediaEditorOptions): Promise<MediaEditorResult> {
  const m = mod();
  if (!m) return { action: 'error', error: 'unavailable' };
  try {
    const r = await m.open(options);
    if (!r || typeof r !== 'object' || !r.action) return { action: 'error', error: 'bad_result' };
    return r;
  } catch (e: any) {
    return { action: 'error', error: String(e?.message || e || 'failed') };
  }
}

export async function close(): Promise<void> {
  const m = mod();
  if (!m) return;
  try { await m.close(); } catch {}
}

export default { isAvailable, apiVersion, open, close };
