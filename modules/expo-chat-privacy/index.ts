// modules/expo-chat-privacy — [2026-10-14 adv-privacy]
//
// iOS: janela opaca por cima de tudo enquanto a tela está sendo gravada ou
// espelhada (UIScreen.isCaptured) e alguma tela protegida segura o "escudo".
// Android: não tem módulo — FLAG_SECURE vem do expo-screen-capture (já no
// binário). Binário sem o módulo / web → isAvailable() === false e o JS segue
// sem o escudo (o resto da privacidade avançada continua valendo).
//
// API:
//   isAvailable(), isCaptured(), setShield(tag, enabled, { title, subtitle }),
//   clearShields(), addCaptureListener(cb) → { remove() }
//
// [2026-10-15 screen-protect-all] apiVersion 2 (iOS + Android): proteção de
// captura do APP INTEIRO — setAppProtection / getAppProtection / setLocalTag /
// reassert + eventos onProtectChange / onScreenshotBlocked. Quem decide e
// chama é services/screenProtect.js (direto no módulo nativo). Android agora
// também tem o módulo, mas o escudo de gravação (setShield) continua só iOS:
// services/chatPrivacy.js só usa este wrapper no iOS.

import { requireOptionalNativeModule } from 'expo-modules-core';

type NativeMod = {
  apiVersion(): number;
  isCaptured(): boolean;
  setShield(tag: string, enabled: boolean, title: string, subtitle: string): Promise<boolean>;
  clearShields(): Promise<boolean>;
  addListener(name: 'onCaptureChange', cb: (e: { captured: boolean }) => void): { remove(): void };
};

let _mod: NativeMod | null | undefined;

function mod(): NativeMod | null {
  if (_mod !== undefined) return _mod;
  _mod = null;
  try {
    // Kill switch OTA/console: globalThis.__chatyy_capture_shield = false
    if ((globalThis as any).__chatyy_capture_shield === false) return null;
  } catch {}
  try {
    _mod = (requireOptionalNativeModule('ExpoChatPrivacy') as any) || null;
  } catch {
    _mod = null;
  }
  return _mod;
}

export function isAvailable(): boolean {
  const m = mod();
  return !!m && typeof m.setShield === 'function';
}

export function isCaptured(): boolean {
  const m = mod();
  if (!m) return false;
  try { return !!m.isCaptured(); } catch { return false; }
}

export function setShield(tag: string, enabled: boolean, labels?: { title?: string; subtitle?: string }): void {
  const m = mod();
  if (!m) return;
  try {
    const r: any = m.setShield(String(tag || 'default'), !!enabled, String(labels?.title || ''), String(labels?.subtitle || ''));
    if (r && r.catch) r.catch(() => {});
  } catch {}
}

export function clearShields(): void {
  const m = mod();
  if (!m) return;
  try { const r: any = m.clearShields(); if (r && r.catch) r.catch(() => {}); } catch {}
}

export function addCaptureListener(cb: (captured: boolean) => void): { remove(): void } {
  const m = mod();
  if (!m || typeof m.addListener !== 'function') return { remove() {} };
  try {
    const sub = m.addListener('onCaptureChange', (e) => { try { cb(!!(e && e.captured)); } catch {} });
    return { remove() { try { sub.remove(); } catch {} } };
  } catch {
    return { remove() {} };
  }
}

// ─── [2026-10-19 secure-view] <ChatyySecureView> (iOS, apiVersion ≥ 3) ─────
// O que está dentro some de print/gravação/espelhamento e no lugar sai o aviso
// "Captura de tela bloqueada" (camada segura do UITextField). Binário antigo,
// Android, web ou kill switch globalThis.__chatyy_secure_view === false → null
// (o JS segue com o comportamento de antes).
let _secureView: any; // componente | null
export function getSecureView(): any {
  if (_secureView !== undefined) return _secureView;
  _secureView = null;
  try {
    if ((globalThis as any).__chatyy_secure_view === false) return null;
  } catch {}
  const m: any = mod();
  if (!m) return null;
  let api = 0;
  try { api = typeof m.apiVersion === 'function' ? Number(m.apiVersion()) || 0 : 0; } catch { api = 0; }
  if (api < 3) return null;
  try { if (typeof m.secureViewSupported === 'function' && m.secureViewSupported() === false) return null; } catch {}
  try {
    const g: any = globalThis as any;
    if (g?.expo?.getViewConfig && !g.expo.getViewConfig('ExpoChatPrivacy')) return null;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const core = require('expo-modules-core');
    const req = core.requireNativeViewManager || core.requireNativeView;
    if (typeof req === 'function') _secureView = req('ExpoChatPrivacy') || null;
  } catch {
    _secureView = null;
  }
  return _secureView;
}
