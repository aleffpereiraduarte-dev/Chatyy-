// modules/expo-chat-attach — [2026-10-15 native-attach]
//
// Folha de anexos + câmera do chat em NATIVO (nível Telegram/WhatsApp),
// estética P&B do app (SF Symbols / vetores, sem emoji).
//
//   iOS:     PhotoKit (PHCachingImageManager) + AVCaptureSession única
//            pré-aquecida (tile ao vivo na folha → câmera cheia "quente").
//   Android: MediaStore + Glide + CameraX 1.5.1 (mesmos artefatos do
//            expo-camera — zero dependência nova).
//
// Binário sem o módulo (antigo / Expo Go / web) → isAvailable() === false e o
// chamador mantém o caminho JS atual. Kill switch OTA/console:
//   globalThis.__chatyy_native_attach = false  → folha E câmera nativas off
//   globalThis.__chatyy_native_camera = false  → só a câmera nativa off
//
// API
//   openSheet(opts)  → Promise<SheetResult | null>   (null = não apresentou)
//   openCamera(opts) → Promise<CameraResult | null>
//   prewarmCamera(), releaseCamera(), dismiss()

import { requireOptionalNativeModule } from 'expo-modules-core';

export type AttachItem = {
  /** file:// local, pronto para o pipeline de envio (mediaSendQueue). */
  uri: string;
  name: string;
  /** MIME (image/jpeg, image/heic, video/quicktime, video/mp4…). */
  type: string;
  size: number;
  width: number;
  height: number;
  /** Segundos (vídeo) ou null. */
  duration: number | null;
  mediaType: 'image' | 'video';
};

export type AttachAction = { key: string; label: string };

export type AttachColors = {
  bg?: string; surface?: string; text?: string; textSecondary?: string; border?: string; chip?: string;
};

export type AttachOptions = {
  /** Botões da barra (Galeria, Arquivo, Localização, Contato, Enquete, Música…). */
  actions?: AttachAction[];
  labels?: Record<string, string>;
  dark?: boolean;
  colors?: AttachColors;
  /** Máximo de itens selecionáveis (padrão 30). */
  maxSelect?: number;
  /** Estado inicial do chip HD. */
  hdDefault?: boolean;
  /** 1º quadrado = câmera ao vivo (e o botão 'camera' some da barra). */
  allowCamera?: boolean;
  /** Câmera: duração máxima do vídeo em segundos (padrão 60). */
  maxVideoSec?: number;
  /** Câmera: grava áudio (false durante ligação). */
  withAudio?: boolean;
};

export type SheetResult =
  | { action: 'send'; items: AttachItem[]; caption: string; hd: boolean; asFile: boolean }
  | { action: 'preview'; items: AttachItem[] }
  | { action: 'action'; key: string }
  | { action: 'cancel' };

export type CameraResult =
  | { action: 'capture'; items: AttachItem[] }
  | { action: 'pick'; items: AttachItem[] }
  | { action: 'gallery' }
  | { action: 'cancel' };

type NativeMod = {
  apiVersion(): number;
  isCameraSupported(): boolean;
  prewarmCamera(): Promise<boolean>;
  releaseCamera(): Promise<boolean>;
  openSheet(options: AttachOptions): Promise<SheetResult | null>;
  openCamera(options: AttachOptions): Promise<CameraResult | null>;
  dismiss(): Promise<boolean>;
};

let _mod: NativeMod | null | undefined;

function mod(): NativeMod | null {
  if (_mod !== undefined) return _mod;
  _mod = null;
  try {
    _mod = (requireOptionalNativeModule('ChatyyAttach') as any) || null;
  } catch {
    _mod = null;
  }
  return _mod;
}

function killed(): boolean {
  try { return (globalThis as any).__chatyy_native_attach === false; } catch { return false; }
}

/** Folha de anexos nativa disponível neste binário. */
export function isAvailable(): boolean {
  if (killed()) return false;
  const m = mod();
  return !!m && typeof m.openSheet === 'function';
}

/** Câmera nativa disponível (módulo + aparelho com câmera + kill switches). */
export function isCameraAvailable(): boolean {
  if (killed()) return false;
  try { if ((globalThis as any).__chatyy_native_camera === false) return false; } catch {}
  const m = mod();
  if (!m || typeof m.openCamera !== 'function') return false;
  try { return m.isCameraSupported ? !!m.isCameraSupported() : true; } catch { return false; }
}

export async function prewarmCamera(): Promise<boolean> {
  const m = mod();
  if (!m || killed()) return false;
  try { return !!(await m.prewarmCamera()); } catch { return false; }
}

export async function releaseCamera(): Promise<boolean> {
  const m = mod();
  if (!m) return false;
  try { return !!(await m.releaseCamera()); } catch { return false; }
}

/** Lança em erro nativo (o chamador cai no fallback JS). */
export async function openSheet(options: AttachOptions): Promise<SheetResult | null> {
  const m = mod();
  if (!m || killed()) return null;
  return (await m.openSheet(options || {})) || null;
}

/** Lança em erro nativo (o chamador cai no fallback JS). */
export async function openCamera(options: AttachOptions): Promise<CameraResult | null> {
  const m = mod();
  if (!m || killed()) return null;
  return (await m.openCamera(options || {})) || null;
}

export async function dismiss(): Promise<boolean> {
  const m = mod();
  if (!m) return false;
  try { return !!(await m.dismiss()); } catch { return false; }
}
