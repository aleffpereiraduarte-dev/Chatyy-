// [2026-10-15 native-attach] Ponte JS ↔ modules/expo-chat-attach.
//
// • <NativeAttachSheet/>: quando o AttachmentMenu (app/chat-conversation.js)
//   fica visível, abre a folha NATIVA (grade de recentes + câmera ao vivo +
//   seleção numerada + legenda/HD/arquivo) e traduz o resultado para os MESMOS
//   handlers do sheet JS: onPick(key) (Arquivo, Localização, Contato, Enquete,
//   Música, Câmera…), onSendMedia(files) (toque longo → MediaPreview) e
//   onSendDirect(files, { caption, hd, asFile }) (Enviar direto da folha →
//   mesmo envio do MediaPreview → uploadAndSendFile → mediaSendQueue).
//   Erro / não apresentou → onFail() e o chamador mostra o sheet JS.
// • openNativeCamera(): câmera nativa (foto/vídeo segurando/zoom/flash/flip/
//   recentes). null = indisponível ou falhou → chamador usa a câmera JS.
//
// Binário sem o módulo / web / globalThis.__chatyy_native_attach === false →
// nativeAttachUsable() === false e nada aqui é usado (comportamento idêntico).
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

let _na; // undefined = não tentou, null = indisponível
function getNA() {
  if (_na !== undefined) return _na;
  _na = null;
  if (Platform.OS === 'web') return _na;
  try {
    // eslint-disable-next-line global-require
    const m = require('../../modules/expo-chat-attach');
    if (m && typeof m.isAvailable === 'function') _na = m;
  } catch { _na = null; }
  return _na;
}

export function nativeAttachUsable() {
  try {
    if (globalThis.__chatyy_native_attach === false) return false;
    const m = getNA();
    return !!(m && m.isAvailable());
  } catch { return false; }
}

export function nativeCameraUsable() {
  try {
    if (globalThis.__chatyy_native_attach === false || globalThis.__chatyy_native_camera === false) return false;
    const m = getNA();
    return !!(m && m.isCameraAvailable());
  } catch { return false; }
}

function tt(t, key, fallback) {
  try {
    const v = typeof t === 'function' ? t(key) : null;
    return (typeof v === 'string' && v && v !== key) ? v : fallback;
  } catch { return fallback; }
}

function isInCall() {
  try {
    if (globalThis.__chatyyNativeCallActive) return true;
    // eslint-disable-next-line global-require
    const cs = require('../../services/callState');
    const s = cs.getCallState && cs.getCallState();
    return s === 'active' || s === 'answered' || s === 'ringing';
  } catch { return false; }
}

function isDarkColors(colors) {
  const bg = String((colors && (colors.background || colors.surface)) || '#ffffff').replace('#', '');
  if (bg.length < 6) return false;
  const r = parseInt(bg.slice(0, 2), 16), g = parseInt(bg.slice(2, 4), 16), b = parseInt(bg.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) < 96;
}

function hex(c, fallback) {
  const s = typeof c === 'string' ? c.trim() : '';
  return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s) ? s : fallback;
}

/** Textos já traduzidos para o nativo (chaves = as que o Swift/Kotlin leem). */
export function nativeAttachLabels(t) {
  return {
    close: tt(t, 'common.close', 'Fechar'),
    recents: tt(t, 'chat.nattach.recents', 'Recentes'),
    selectedCount: tt(t, 'chat.nattach.selectedCount', '{count} selecionados'),
    limited: tt(t, 'chat.nattach.limited', 'Você permitiu acesso a algumas fotos.'),
    manage: tt(t, 'chat.nattach.manage', 'Gerenciar'),
    permPrompt: tt(t, 'chat.nattach.permPrompt', 'Permita o acesso às fotos para enviar as mais recentes com um toque.'),
    permAllow: tt(t, 'chat.nattach.permAllow', 'Permitir acesso'),
    permDenied: tt(t, 'chat.nattach.permDenied', 'O acesso às fotos está desativado. Ative nos Ajustes para ver suas fotos aqui.'),
    permSettings: tt(t, 'chat.nattach.permSettings', 'Abrir Ajustes'),
    hd: 'HD',
    asFile: tt(t, 'chat.nattach.asFile', 'Enviar como arquivo'),
    caption: tt(t, 'chatConv.addCaption', 'Adicionar legenda...'),
    send: tt(t, 'common.send', 'Enviar'),
    camera: tt(t, 'chatConv.camera', 'Câmera'),
    gallery: tt(t, 'chatConv.gallery', 'Galeria'),
    photo: tt(t, 'chat.nattach.photo', 'Foto'),
    video: tt(t, 'chat.nattach.video', 'Vídeo'),
    flashOn: tt(t, 'chat.nattach.flashOn', 'Flash ligado'),
    flashOff: tt(t, 'chat.nattach.flashOff', 'Flash desligado'),
    flashAuto: tt(t, 'chat.nattach.flashAuto', 'Flash automático'),
    flip: tt(t, 'chat.nattach.flip', 'Trocar câmera'),
    hint: tt(t, 'chat.nattach.hint', 'Segure para vídeo, toque para foto'),
    shutter: tt(t, 'chat.nattach.hint', 'Segure para vídeo, toque para foto'),
    permCamTitle: tt(t, 'chat.nattach.permCamTitle', 'Permita o acesso à câmera'),
    permCamBody: tt(t, 'chat.nattach.permCamBody', 'Para tirar fotos e gravar vídeos no chat, ative a câmera nos Ajustes.'),
  };
}

function themeFor(colors) {
  const dark = isDarkColors(colors);
  const c = colors || {};
  return {
    dark,
    colors: {
      // Mesmo fundo do sheet JS (overlayColors.sheetBg) — P&B.
      bg: dark ? '#1c1c1e' : '#ffffff',
      surface: dark ? '#2c2c2e' : '#f4f4f5',
      text: hex(c.text, dark ? '#F5F5F7' : '#111111'),
      textSecondary: hex(c.textSecondary, dark ? '#8E8E93' : '#667781'),
      border: dark ? '#FFFFFF1A' : '#00000014',
      chip: dark ? '#2c2c2e' : '#f2f2f4',
    },
  };
}

/** Item nativo → descritor de arquivo igual ao do handleGallery. */
function toFiles(items, extra) {
  return (Array.isArray(items) ? items : []).filter((it) => it && it.uri).map((it) => ({
    uri: it.uri,
    name: it.name || `media_${Date.now()}.${it.mediaType === 'video' ? 'mp4' : 'jpg'}`,
    type: it.type || (it.mediaType === 'video' ? 'video/mp4' : 'image/jpeg'),
    size: Number(it.size) || 0,
    blob: null,
    width: Number(it.width) || undefined,
    height: Number(it.height) || undefined,
    duration: it.duration != null ? Number(it.duration) : undefined,
    ...(extra || null),
  }));
}

/**
 * Câmera nativa. Resolve { action, files } ou null (indisponível / erro →
 * o chamador usa a câmera JS). action: 'capture' | 'pick' | 'gallery' | 'cancel'.
 */
export async function openNativeCamera(t, opts = {}) {
  const m = getNA();
  if (!m || !nativeCameraUsable()) return null;
  try {
    const r = await m.openCamera({
      labels: nativeAttachLabels(t),
      dark: true,
      maxVideoSec: opts.maxVideoSec || 60,
      maxSelect: 30,
      withAudio: opts.withAudio != null ? !!opts.withAudio : !isInCall(),
    });
    if (!r || !r.action) return null;
    return { action: r.action, files: toFiles(r.items) };
  } catch (e) {
    if (__DEV__) console.warn('[native-camera] failed', e?.message || e);
    return null;
  }
}

export default function NativeAttachSheet({
  visible, onClose, onPick, onSendMedia, onSendDirect, onFail, colors, items, t,
}) {
  const openRef = useRef(false);
  const propsRef = useRef(null);
  propsRef.current = { onClose, onPick, onSendMedia, onSendDirect, onFail, colors, items, t };

  // Sessão de câmera pré-configurada: abrir a câmera/tile depois é "quente".
  useEffect(() => {
    const m = getNA();
    if (!m) return undefined;
    const id = setTimeout(() => { try { m.prewarmCamera(); } catch {} }, 1500);
    return () => {
      clearTimeout(id);
      try { m.releaseCamera(); } catch {}
    };
  }, []);

  useEffect(() => {
    if (!visible || openRef.current) return;
    const m = getNA();
    if (!m) { try { propsRef.current.onFail && propsRef.current.onFail(); } catch {} return; }
    openRef.current = true;
    const p = propsRef.current;
    const th = themeFor(p.colors);
    const actions = (Array.isArray(p.items) ? p.items : [])
      .filter((it) => it && it.key)
      .map((it) => ({ key: String(it.key), label: String(it.label || it.key) }));
    (async () => {
      let r = null;
      try {
        r = await m.openSheet({
          actions,
          labels: nativeAttachLabels(p.t),
          dark: th.dark,
          colors: th.colors,
          maxSelect: 30,
          hdDefault: false,
          allowCamera: true,
          // [2026-10-16 motion-attach] botões em cascata; kill switch OTA
          // globalThis.__chatyy_motion_attach = false (chave ausente = ligado).
          ...((() => { try { return globalThis.__chatyy_motion_attach === false || globalThis.__chatyy_motion === false; } catch { return false; } })() ? { motion: false } : null),
        });
      } catch (e) {
        if (__DEV__) console.warn('[native-attach] openSheet failed', e?.message || e);
        r = null;
      }
      openRef.current = false;
      const cur = propsRef.current;
      if (!r || !r.action) { try { cur.onFail && cur.onFail(); } catch {} return; }
      try { cur.onClose && cur.onClose(); } catch {}
      try {
        if (r.action === 'action' && r.key) {
          cur.onPick && cur.onPick(r.key);
        } else if (r.action === 'send') {
          // HD desligado = qualidade padrão do app (vídeo segue a preferência
          // salva); ligado = força HD. "Como arquivo" = original, sem compressão.
          const files = toFiles(r.items, { ...(r.hd ? { _hd: true } : null), ...(r.asFile ? { _asFile: true } : null) });
          if (typeof cur.onSendDirect === 'function') cur.onSendDirect(files, { caption: r.caption || '', hd: !!r.hd, asFile: !!r.asFile });
          else if (typeof cur.onSendMedia === 'function') cur.onSendMedia(files);
        } else if (r.action === 'preview') {
          const files = toFiles(r.items);
          if (files.length && typeof cur.onSendMedia === 'function') cur.onSendMedia(files);
        }
      } catch (e) {
        if (__DEV__) console.warn('[native-attach] result handler failed', e?.message || e);
      }
    })();
  }, [visible]);

  // O pai fechou enquanto a folha nativa estava aberta (troca de tela etc.).
  useEffect(() => {
    if (visible || !openRef.current) return;
    const m = getNA();
    try { m && m.dismiss(); } catch {}
  }, [visible]);

  return null;
}
