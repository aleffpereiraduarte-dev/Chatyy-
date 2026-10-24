// modules/expo-media-viewer/story.ts — [2026-10-15 native-story]
//
// Visualizador de STATUS (stories) NATIVO. Mesmo pacote do visualizador de
// mídia (reaproveita o carregador de imagem / player de vídeo nativos).
//   iOS: UIViewController tela cheia + pager UIScrollView entre PESSOAS com
//        transição em cubo 3D (CATransform3D) + player de segmentos por pessoa
//        (barras CADisplayLink, foto MVImageLoader, vídeo AVPlayer com
//        pré-buffer do próximo, texto com auto-ajuste real).
//   Android: Dialog tela cheia + ViewPager2 (PageTransformer cubo) + Glide +
//        Media3 ExoPlayer (pré-buffer do próximo).
// Binário sem o módulo (build antigo / Expo Go / web) → isAvailable() false.
// Kill switch OTA/console: globalThis.__chatyy_native_story = false.
//
// O lado JS (components/status/nativeStories.js) normaliza os grupos e liga
// os eventos às APIs (status_view, status_react, status_reply_dm…).

import { requireOptionalNativeModule } from 'expo-modules-core';
import { syncMotion } from './motion';

export type StoryItem = {
  id: string;
  /** 'voice' (apiVersion >= 2) = status de voz: áudio em music.url. */
  type: 'image' | 'video' | 'text' | 'voice';
  uri?: string;
  localUri?: string;
  thumb?: string;
  text?: string;
  caption?: string;
  /** Cor sólida (#hex) do status de texto. */
  bg?: string;
  /** Gradiente (2+ #hex) — opcional. */
  bgColors?: string[];
  /** sans | serif | mono | script | condensed */
  font?: string;
  /** ms (foto/texto). Vídeo usa a duração real. */
  duration?: number;
  timeLabel?: string;
  viewed?: boolean;
  viewsCount?: number;
  myReaction?: string;
  music?: { title?: string; artist?: string; url?: string; startMs?: number } | null;
  link?: { url: string; label?: string } | null;
  // ── apiVersion >= 2 ──
  /** Entrada de texto: none | fade | bounce | typewriter. */
  textAnim?: string;
  /** Boomerang: vídeo em loop por `duration` ms. */
  loop?: boolean;
  /** Legenda traduzível (menu "Traduzir") / já traduzida ("Ver original"). */
  translatable?: boolean;
  translated?: boolean;
  /** Camada de blocos (stickers/texto/GIF/enquete…) no espaço de pontos da tela. x/y < 0 = centralizado. */
  overlays?: StoryOverlay[];
  /** Desenho livre: points = [x0,y0,x1,y1,…]. */
  paths?: { color: string; width?: number; points: number[] }[];
  // ── apiVersion >= 5 ──
  /** [status-zoom 2026-10-23] Foto: original em alta, trocado quando o zoom passa de 1.5x. */
  hires?: string;
};

export type StoryOverlay = {
  kind: 'text' | 'emoji' | 'gif' | 'mention' | 'poll' | 'question' | 'countdown' | 'slider';
  id?: string;
  x: number;
  y: number;
  text?: string;
  color?: string;
  url?: string;
  w?: number;
  h?: number;
  email?: string;
  question?: string;
  options?: string[];
  counts?: number[];
  myVote?: number;
  correct?: number;
  votable?: boolean;
  hint?: string;
  targetMs?: number;
  ended?: string;
  emoji?: string;
  value?: number;
  avg?: number;
};

/** itemFlag: só aparece se o item tiver a flag (ex.: 'translatable'); labelAlt: rótulo quando item.translated. */
export type StoryMenuEntry = { id: string; label: string; destructive?: boolean; confirm?: string; labelAlt?: string; itemFlag?: string };

export type StoryGroup = {
  key?: string;
  owner: { email: string; name: string; avatar?: string };
  isSelf?: boolean;
  startItem?: number;
  items: StoryItem[];
  menu?: StoryMenuEntry[];
};

export type StoryReaction = { emoji: string; kind: 'heart' | 'flame' | 'laugh' | 'wow' | 'sad' | 'clap' | 'thumbs' };

/** [2026-10-17 status-reacoes] Grade completa do "+" (components/chat/nativeEmojiData.js). */
export type StoryEmojiPicker = { cats: { t: string; e: string[]; k: string[] }[] };

export type StoryOpenOptions = {
  groups: StoryGroup[];
  startGroup?: number;
  startItem?: number;
  labels?: Record<string, string>;
  reactions?: StoryReaction[];
  /** apiVersion >= 4: segurar o coração abre a bolha de reações (deslizar + soltar). */
  reactionHold?: boolean;
  /** [status-zoom 2026-10-23] apiVersion >= 5: pinça até 4x + duplo toque (foto/vídeo); false = desliga. */
  zoom?: boolean;
  /** apiVersion >= 4: "+" na fileira/bolha abre esta grade (busca por palavras). */
  reactionPicker?: StoryEmojiPicker;
  transition?: 'cube' | 'slide';
  /** Há mais pessoas depois/antes das enviadas → onNeedMore. */
  hasMoreNext?: boolean;
  hasMorePrev?: boolean;
  /**
   * [2026-10-16 motion] Frame do anel tocado (coordenadas de JANELA, pt/dp do
   * RN): o story cresce dele e volta para ele ao fechar. apiVersion >= 3.
   */
  originRect?: { x: number; y: number; width: number; height: number } | null;
};

/** reaction = kind (ícone vetorial, binários antigos); emoji = emoji real (apiVersion >= 4). */
export type StoryViewerRow = { email: string; name?: string; avatar?: string; time?: string; reaction?: string; emoji?: string };

type Base = { session: number };
export type StoryEvents = {
  onItemShown: (e: Base & { id: string; ownerEmail: string; groupIndex: number; itemIndex: number; isSelf: boolean }) => void;
  onItemCompleted: (e: Base & { id: string; ownerEmail: string }) => void;
  onGroupChange: (e: Base & { groupIndex: number; ownerEmail: string; key: string }) => void;
  onReply: (e: Base & { id: string; ownerEmail: string; text: string }) => void;
  onReact: (e: Base & { id: string; ownerEmail: string; emoji: string; active: boolean }) => void;
  onOpenViewers: (e: Base & { id: string }) => void;
  onCloseViewers: (e: Base & { id: string }) => void;
  onViewerPress: (e: Base & { id: string; email: string }) => void;
  onMenu: (e: Base & { id: string; action: string; ownerEmail: string }) => void;
  onLink: (e: Base & { url: string; id: string }) => void;
  onSticker: (e: Base & { id: string; ownerEmail: string; kind: string; stickerId: string; index?: number; value?: number; text?: string; email?: string }) => void;
  onNeedMore: (e: Base & { direction: 'next' | 'prev'; groupIndex: number; ownerEmail: string }) => void;
  onClose: (e: Base & { reason: string; groupIndex: number; itemIndex: number; id: string; ownerEmail: string }) => void;
};

export type StoryItemPatch = {
  viewed?: boolean;
  viewsCount?: number;
  myReaction?: string;
  // apiVersion >= 2
  caption?: string;
  translated?: boolean;
  overlay?: { id: string; counts?: number[]; myVote?: number; value?: number; avg?: number };
};

type NativeMod = {
  apiVersion(): number;
  open(options: StoryOpenOptions): Promise<number>;
  close(): Promise<boolean>;
  pause(): Promise<boolean>;
  resume(): Promise<boolean>;
  updateItem(id: string, patch: StoryItemPatch): Promise<boolean>;
  removeItem(id: string): Promise<boolean>;
  appendGroup(group: StoryGroup, direction: 'next' | 'prev'): Promise<boolean>;
  setHasMore(next: boolean, prev: boolean): Promise<boolean>;
  setViewers(id: string, rows: StoryViewerRow[], loading: boolean): Promise<boolean>;
  showToast(text: string): Promise<boolean>;
  addListener<K extends keyof StoryEvents>(name: K, cb: StoryEvents[K]): { remove(): void };
};

let _mod: NativeMod | null | undefined;

function killed(): boolean {
  try {
    return (globalThis as any).__chatyy_native_story === false;
  } catch {
    return false;
  }
}

function mod(): NativeMod | null {
  if (killed()) return null;
  if (_mod !== undefined) return _mod;
  _mod = null;
  try {
    _mod = (requireOptionalNativeModule('ChatyyStoryViewer') as any) || null;
  } catch {
    _mod = null;
  }
  return _mod;
}

export function isAvailable(): boolean {
  const m = mod();
  return !!m && typeof m.open === 'function';
}

/** 1 = build 2026-10-15 (foto/vídeo/texto); 2 = blocos/voz/enquete/boomerang/duplo toque/menu por item;
 *  3 = originRect; 4 = reações livres (bolha ao segurar o coração, "+" com grade de emojis, emoji real na lista);
 *  5 = zoom (pinça/duplo toque, pausa enquanto ampliado, `hires` acima de 1.5x). */
export function apiVersion(): number {
  const m = mod();
  if (!m || typeof m.apiVersion !== 'function') return 0;
  try {
    const v = Number(m.apiVersion());
    return Number.isFinite(v) ? v : 1;
  } catch {
    return 1;
  }
}

export async function open(options: StoryOpenOptions): Promise<number> {
  const m = mod();
  if (!m) return 0;
  syncMotion(); // [2026-10-16 motion] kill switches __chatyy_motion_*
  try {
    let opts: any = options;
    if (opts && 'originRect' in opts) {
      const { originRect, ...rest } = opts;
      opts = rest;
      const r: any = originRect;
      const ok = r && [r.x, r.y, r.width, r.height].every((n: any) => typeof n === 'number' && Number.isFinite(n)) && r.width >= 2 && r.height >= 2;
      if (ok && apiVersion() >= 3) opts.originRect = { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    const sid = await m.open(opts);
    return typeof sid === 'number' ? sid : 0;
  } catch {
    return 0;
  }
}

function fire(p: any) {
  try { if (p && typeof p.catch === 'function') p.catch(() => {}); } catch {}
}

export function close(): void { const m = mod(); if (m) { try { fire(m.close()); } catch {} } }
export function pause(): void { const m = mod(); if (m) { try { fire(m.pause()); } catch {} } }
export function resume(): void { const m = mod(); if (m) { try { fire(m.resume()); } catch {} } }
export function updateItem(id: string, patch: StoryItemPatch): void {
  const m = mod(); if (m && id) { try { fire(m.updateItem(String(id), patch || {})); } catch {} }
}
export function removeItem(id: string): void { const m = mod(); if (m && id) { try { fire(m.removeItem(String(id))); } catch {} } }
export function appendGroup(group: StoryGroup, direction: 'next' | 'prev' = 'next'): void {
  const m = mod(); if (m && group) { try { fire(m.appendGroup(group, direction === 'prev' ? 'prev' : 'next')); } catch {} }
}
export function setHasMore(next: boolean, prev: boolean): void {
  const m = mod(); if (m) { try { fire(m.setHasMore(!!next, !!prev)); } catch {} }
}
export function setViewers(id: string, rows: StoryViewerRow[], loading = false): void {
  const m = mod(); if (m && id) { try { fire(m.setViewers(String(id), Array.isArray(rows) ? rows : [], !!loading)); } catch {} }
}
export function showToast(text: string): void { const m = mod(); if (m && text) { try { fire(m.showToast(String(text))); } catch {} } }

export function addListener<K extends keyof StoryEvents>(name: K, cb: StoryEvents[K]): { remove(): void } {
  const m = mod();
  if (!m || typeof m.addListener !== 'function') return { remove() {} };
  try {
    return m.addListener(name, cb);
  } catch {
    return { remove() {} };
  }
}

export default { isAvailable, apiVersion, open, close, pause, resume, updateItem, removeItem, appendGroup, setHasMore, setViewers, showToast, addListener };
