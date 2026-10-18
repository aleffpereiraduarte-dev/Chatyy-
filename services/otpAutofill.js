// =============================================================================
// [2026-10-18 otp-autofill] Código do WhatsApp se preenche sozinho (nível
// WhatsApp/Telegram). Complementa services/smsOtp.js (SMS User Consent).
//
// Desde 18/10 o código chega por um template de autenticação do Twilio Verify
// no WhatsApp (remetente +55 21 2391-5682) com botão "Copiar código".
//
//  1. Android, binário NOVO (ExpoWaOtp apiVersion >= 1): handshake one-tap /
//     zero-tap do WhatsApp (SDK OTP da Meta). Se o template tiver o botão
//     one_tap configurado p/ com.onemundo.mail, o WhatsApp entrega o código
//     direto no app (evento onWaOtp / consumePending). Sem template one-tap →
//     o WhatsApp mostra "Copiar código" e cai no item 2.
//  2. Área de transferência ao VOLTAR p/ o app (AppState → active) com a tela
//     do código esperando e exatamente UM código de 4-8 dígitos copiado:
//     - Android: lê direto (sem prompt). Binário novo só aceita texto copiado
//       DEPOIS do pedido do código (ClipDescription.getTimestamp) → nunca envia
//       um número velho; binário antigo usa expo-clipboard.
//     - iOS: ler o clipboard dispara o prompt de colar do sistema → NÃO lê
//       sozinho. hasStringAsync() (sem prompt) decide se mostra o botão nativo
//       de colar (UIPasteControl via expo-clipboard ClipboardPasteButton, iOS
//       16+, sem prompt) ou, sem ele, o botão "Colar código" (lê só no toque).
//  3. "Abrir WhatsApp" na tela do código quando o canal foi o WhatsApp.
//
// Tudo é feature-detected e preguiçoso (require em tempo de chamada): binário
// sem o módulo / web → no-op. Kill switch: globalThis.__chatyy_otp_assist = false.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform } from 'react-native';

// Remetente do template Twilio Verify (WhatsApp). Outros provedores (Baileys)
// usam outro número → abre só o WhatsApp.
export const OTP_WA_SENDER = '552123915682';

const MIN_LEN = 4;
const MAX_LEN = 8;

function killed() {
  return globalThis.__chatyy_otp_assist === false;
}

// ── extração ────────────────────────────────────────────────────────────────
/**
 * Devolve o código se o texto tiver EXATAMENTE um código de 4-8 dígitos
 * ("482913", "482 913", "482-913", "Seu código: 482913"); senão null.
 * Rejeita textos longos e textos com outros números grandes (telefones etc.).
 */
export function extractOtpCode(text, len) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (!s || s.length > 200) return null;
  const grouped = s.match(/^(\d{3,4})[\s-](\d{3,4})$/);
  let code = null;
  if (grouped) {
    code = grouped[1] + grouped[2];
  } else {
    const runs = s.match(/\d+/g) || [];
    if (runs.some((r) => r.length > MAX_LEN)) return null;
    const cands = runs.filter((r) => r.length >= MIN_LEN && r.length <= MAX_LEN);
    if (cands.length !== 1) return null;
    code = cands[0];
  }
  if (code.length < MIN_LEN || code.length > MAX_LEN) return null;
  if (len && code.length !== len) return null;
  return code;
}

// ── módulos nativos (preguiçosos) ───────────────────────────────────────────
let _clip; // undefined = não resolvido; null = indisponível
function getClipboard() {
  if (_clip !== undefined) return _clip;
  _clip = null;
  if (Platform.OS === 'web') return _clip;
  try { _clip = require('expo-clipboard') || null; } catch { _clip = null; }
  return _clip;
}

let _wa;
function getWaModule() {
  if (_wa !== undefined) return _wa;
  _wa = null;
  if (Platform.OS !== 'android') return _wa;
  try {
    const { requireOptionalNativeModule } = require('expo');
    const m = requireOptionalNativeModule('ExpoWaOtp');
    let v = 0;
    try { v = Number(m?.apiVersion?.()) || 0; } catch { v = 0; }
    _wa = m && v >= 1 ? m : null;
  } catch { _wa = null; }
  return _wa;
}

export function isWaOneTapSupported() {
  return !!getWaModule();
}

/** iOS 16+: botão nativo de colar (UIPasteControl) sem prompt de permissão. */
export function isNativePasteButtonAvailable() {
  if (Platform.OS !== 'ios') return false;
  try { return !!getClipboard()?.isPasteButtonAvailable; } catch { return false; }
}

/** Componente ClipboardPasteButton do expo-clipboard (ou null). */
export function getNativePasteButton() {
  if (!isNativePasteButtonAvailable()) return null;
  try { return getClipboard()?.ClipboardPasteButton || null; } catch { return null; }
}

// ── handshake one-tap (Android) ─────────────────────────────────────────────
let _lastPrime = 0;
/**
 * Chamar ANTES de pedir o código ao servidor (o handshake precisa existir
 * quando a mensagem chega no WhatsApp; vale 10 min). Barato e idempotente.
 */
export function primeWhatsAppOtp() {
  if (killed()) return false;
  const m = getWaModule();
  if (!m) return false;
  const now = Date.now();
  if (now - _lastPrime < 2000) return true;
  _lastPrime = now;
  try { return !!m.startHandshake?.(); } catch { return false; }
}

// ── abrir o WhatsApp ────────────────────────────────────────────────────────
export async function openWhatsAppForOtp(provider) {
  const toSender = provider === 'twilio' || provider == null;
  const urls = toSender
    ? [`whatsapp://send?phone=${OTP_WA_SENDER}`, `https://wa.me/${OTP_WA_SENDER}`]
    : ['whatsapp://', 'https://wa.me/'];
  for (const u of urls) {
    try { await Linking.openURL(u); return true; } catch {}
  }
  return false;
}

// ── hook ────────────────────────────────────────────────────────────────────
/**
 * @param {object} o
 * @param {boolean} o.active        tela do código esperando
 * @param {boolean} o.viaWhatsapp   último envio foi pelo WhatsApp
 * @param {string}  [o.provider]    'twilio' | 'baileys' | 'local' (verify_send)
 * @param {number}  [o.length=6]    tamanho do código das células
 * @param {(code:string)=>void} o.onCode  preenche + envia (mesmo handler do SMS)
 * @param {any}     [o.rearmKey]    muda a cada (re)envio → novo handshake/baseline
 */
export function useOtpAutofillAssist({ active, viaWhatsapp, provider, length = 6, onCode, rearmKey }) {
  const cbRef = useRef(onCode);
  cbRef.current = onCode;
  const viaWaRef = useRef(viaWhatsapp);
  viaWaRef.current = viaWhatsapp;
  const usedRef = useRef(new Set());
  const sinceRef = useRef(0);
  const leftRef = useRef(false);
  const [pasteVisible, setPasteVisible] = useState(false);

  const deliver = useCallback((raw) => {
    const code = extractOtpCode(String(raw || ''), length);
    if (!code || usedRef.current.has(code)) return false;
    usedRef.current.add(code);
    setPasteVisible(false);
    try { cbRef.current?.(code); } catch {}
    return true;
  }, [length]);

  // Novo envio: novo handshake + só aceita clipboard copiado daqui p/ frente.
  useEffect(() => {
    if (!active || killed() || Platform.OS === 'web') return;
    sinceRef.current = Date.now() - 120000; // folga: código pedido instantes antes da tela
    primeWhatsAppOtp();
  }, [active, rearmKey]);

  // One-tap / zero-tap (Android, binário novo).
  useEffect(() => {
    if (!active || killed()) return undefined;
    const m = getWaModule();
    if (!m) return undefined;
    let sub = null;
    try {
      sub = m.addListener?.('onWaOtp', (e) => {
        if (e && e.status === 'code') {
          try { m.consumePending?.(); } catch {}
          deliver(e.code);
        }
      }) || null;
    } catch { sub = null; }
    try { const p = m.consumePending?.(); if (p?.code) deliver(p.code); } catch {}
    return () => { try { sub?.remove?.(); } catch {} };
  }, [active, deliver]);

  // Volta do WhatsApp (ou de qualquer app) → clipboard.
  useEffect(() => {
    if (!active || killed() || Platform.OS === 'web') { setPasteVisible(false); return undefined; }
    let alive = true;
    const timers = [];
    const tryAndroid = async () => {
      const wa = getWaModule();
      try { const p = wa?.consumePending?.(); if (p?.code && deliver(p.code)) return true; } catch {}
      let txt = null;
      if (wa && typeof wa.getClipboardTextSince === 'function') {
        try { txt = wa.getClipboardTextSince(sinceRef.current); } catch { txt = null; }
      } else if (viaWaRef.current) {
        // Binário antigo (sem idade do clipboard): só quando o código foi pelo
        // WhatsApp, p/ não enviar um número qualquer copiado antes.
        const C = getClipboard();
        try { if (C && (await C.hasStringAsync())) txt = await C.getStringAsync(); } catch { txt = null; }
      }
      return alive && txt ? deliver(txt) : false;
    };
    const onReturn = async () => {
      if (Platform.OS === 'android') {
        // Android 10+ só libera o clipboard com a janela focada (vem logo
        // depois do 'active') → tenta algumas vezes.
        for (const ms of [120, 600, 1500]) {
          timers.push(setTimeout(() => { if (alive) tryAndroid().catch(() => {}); }, ms));
        }
        return;
      }
      if (Platform.OS === 'ios' && viaWaRef.current) {
        const C = getClipboard();
        let has = false;
        try { has = !!(C && (await C.hasStringAsync())); } catch { has = false; }
        if (alive) setPasteVisible(has);
      }
    };
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'background') { leftRef.current = true; return; }
      if (st === 'active' && leftRef.current) {
        leftRef.current = false;
        onReturn();
      }
    });
    return () => {
      alive = false;
      timers.forEach(clearTimeout);
      try { sub?.remove?.(); } catch {}
    };
  }, [active, deliver]);

  useEffect(() => { if (!active) { usedRef.current = new Set(); leftRef.current = false; } }, [active]);

  // iOS sem UIPasteControl: lê só no toque explícito (prompt do sistema).
  const onPasteTap = useCallback(async () => {
    const C = getClipboard();
    if (!C) return false;
    let txt = null;
    try { txt = await C.getStringAsync(); } catch { txt = null; }
    const ok = deliver(txt);
    if (!ok) setPasteVisible(false);
    return ok;
  }, [deliver]);

  // iOS 16+: evento do ClipboardPasteButton (já é o texto colado, sem prompt).
  const onNativePaste = useCallback((data) => {
    const ok = data && data.type === 'text' ? deliver(data.text) : false;
    if (!ok) setPasteVisible(false);
  }, [deliver]);

  const openWhatsApp = useCallback(() => {
    leftRef.current = true;
    return openWhatsAppForOtp(provider);
  }, [provider]);

  return {
    showOpenWhatsApp: !!active && !!viaWhatsapp && Platform.OS !== 'web' && !killed(),
    openWhatsApp,
    pasteVisible: !!active && pasteVisible && Platform.OS === 'ios',
    nativePaste: isNativePasteButtonAvailable(),
    onPasteTap,
    onNativePaste,
  };
}
