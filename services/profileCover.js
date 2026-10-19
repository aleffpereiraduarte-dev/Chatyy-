// [capa-2026-10-19] Foto de capa do perfil — helpers compartilhados.
//
// Bug: o servidor gravava a capa como https://chatyy.com.br/profile-covers/...
// (o nginx responde o SPA → 404 text/html) em vez do bucket público
// https://media.chatyy.com.br/... — a capa subia mas nunca aparecia.
// O servidor foi corrigido; normalizeCoverUrl() conserta valores antigos
// já gravados/cacheados e resolve o fallback local relativo (/api/...).
//
// prepareCoverFile(): converte qualquer seleção (HEIC/PNG/12 MP) em JPEG
// com no máx. 1600 px de largura, bem abaixo do limite de 6 MB do servidor.
import { Platform } from 'react-native';

const WRONG_HOST_RE = /^https?:\/\/(?:www\.)?chatyy\.com\.br\/profile-covers\//i;
const MEDIA_PREFIX = 'https://media.chatyy.com.br/profile-covers/';

export function normalizeCoverUrl(u, base) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (WRONG_HOST_RE.test(s)) return s.replace(WRONG_HOST_RE, MEDIA_PREFIX);
  if (/^(https?|file|content|ph|assets-library|blob|data):/i.test(s)) return s;
  if (s.startsWith('/')) {
    let b = base;
    if (!b) { try { b = require('./api').BASE_URL; } catch {} }
    return String(b || 'https://chatyy.com.br').replace(/\/+$/, '') + s;
  }
  return s;
}

const MAX_W = 1600;

// file: { uri, width?, height? } (asset do expo-image-picker) ou File/Blob na web.
// Retorna { uri, name, type } pronto para api.uploadCover (ou o próprio File
// na web quando a conversão não estiver disponível).
export async function prepareCoverFile(asset) {
  if (!asset) return null;
  if (Platform.OS === 'web' && typeof File !== 'undefined' && asset instanceof File) {
    // Na web o servidor aceita JPG/PNG/WebP; HEIC (Safari exporta JPEG) e
    // arquivos grandes passam pelo manipulador quando possível.
    try {
      const IM = require('expo-image-manipulator');
      const url = URL.createObjectURL(asset);
      const r = await IM.manipulateAsync(url, [{ resize: { width: MAX_W } }], { compress: 0.82, format: IM.SaveFormat.JPEG });
      if (r?.uri) {
        const blob = await fetch(r.uri).then((x) => x.blob());
        return { blob, uri: r.uri, name: 'cover.jpg', type: 'image/jpeg' };
      }
    } catch {}
    return asset;
  }
  const uri = asset.uri;
  if (!uri) return null;
  try {
    const IM = require('expo-image-manipulator');
    const w = Number(asset.width) || 0;
    const actions = (!w || w > MAX_W) ? [{ resize: { width: MAX_W } }] : [];
    const r = await IM.manipulateAsync(uri, actions, { compress: 0.82, format: IM.SaveFormat.JPEG });
    if (r?.uri) return { uri: r.uri, name: 'cover.jpg', type: 'image/jpeg', width: r.width, height: r.height };
  } catch {}
  // Sem o manipulador (não deveria acontecer): envia o original como JPEG.
  return { uri, name: 'cover.jpg', type: 'image/jpeg' };
}
