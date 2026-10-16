// modules/expo-inapp-banner — [2026-10-16 native-toast]
//
// Banner de notificação DENTRO do app, 100% nativo (estilo iOS/WhatsApp):
// desce do topo sob a Dynamic Island/status bar com avatar + nome + prévia;
// arrastar p/ cima dispensa, p/ baixo expande com resposta rápida (canReply),
// toque abre. Animação e gestos na UI thread (não travam com o JS).
//
//   iOS: UIWindow própria (deixa passar toques fora do banner) + molas UIKit.
//   Android: view no decorView da Activity + ViewPropertyAnimator.
//
// Binário sem o módulo (build antigo, Expo Go, web) → isAvailable() === false e
// components/NotificationToast.js desenha o toast JS (native driver).
// Kill switch: globalThis.__chatyy_native_toast = false.

import { requireOptionalNativeModule } from 'expo-modules-core';

export type InAppBannerOptions = {
  id: string;
  title: string;
  body?: string;
  /** Texto curto à direita do nome (ex.: "agora"). */
  meta?: string;
  avatarUrl?: string;
  initials?: string;
  /** "#RRGGBB" */
  avatarColor?: string;
  accent?: string;
  dark?: boolean;
  urgent?: boolean;
  durationMs?: number;
  /** Arrastar p/ baixo abre campo de resposta → evento onBannerReply. */
  canReply?: boolean;
  replyPlaceholder?: string;
  /** Pílula de ação à direita (ex.: "Entrar" numa live) — toque = onBannerPress. */
  actionLabel?: string;
  closeLabel?: string;
};

export type InAppBannerEvent = { id: string; reason?: string; text?: string };

type NativeMod = {
  apiVersion(): number;
  show(o: InAppBannerOptions): Promise<boolean>;
  dismiss(id?: string | null): Promise<void>;
  addListener(ev: string, cb: (e: InAppBannerEvent) => void): { remove(): void };
};

let _mod: NativeMod | null | undefined;

function mod(): NativeMod | null {
  if (_mod !== undefined) return _mod;
  try {
    _mod = (requireOptionalNativeModule('ChatyyInAppBanner') as any) || null;
  } catch {
    _mod = null;
  }
  return _mod;
}

export function apiVersion(): number {
  const m = mod();
  if (!m || typeof m.apiVersion !== 'function') return 0;
  try { return Number(m.apiVersion()) || 0; } catch { return 0; }
}

export function isAvailable(): boolean {
  try { if ((globalThis as any).__chatyy_native_toast === false) return false; } catch {}
  return apiVersion() >= 1;
}

export async function show(o: InAppBannerOptions): Promise<boolean> {
  const m = mod();
  if (!m || !isAvailable()) return false;
  try { return !!(await m.show(o)); } catch { return false; }
}

export function dismiss(id?: string | null): void {
  const m = mod();
  if (!m) return;
  try { m.dismiss(id || null)?.catch?.(() => {}); } catch {}
}

export function addListener(
  ev: 'onBannerPress' | 'onBannerDismiss' | 'onBannerReply' | 'onBannerExpand',
  cb: (e: InAppBannerEvent) => void,
): { remove(): void } {
  const m = mod();
  if (!m || typeof m.addListener !== 'function') return { remove() {} };
  try { return m.addListener(ev, cb); } catch { return { remove() {} }; }
}

export default { isAvailable, apiVersion, show, dismiss, addListener };
