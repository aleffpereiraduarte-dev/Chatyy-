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

// [2026-10-19 me-cover] Topo "Você" imersivo: capa por baixo da status bar e
// voltar · buscar · QR · Editar numa linha só (header nativo da raiz de
// /settings escondido). Mesmo gate no app/_layout.js (opções antes do 1º
// frame) e no app/settings.js. Desligar por OTA: globalThis.__chatyy_me_hero_immersive = false.
export function meHeroImmersiveOn() {
  if (Platform.OS === 'web') return false;
  try { return globalThis.__chatyy_me_hero_immersive !== false; } catch { return true; }
}

// [2026-10-19 me-cover] Editor do perfil salvou (capa/nome/foto…) → grava no
// MESMO cache que o topo "Você" lê (settingsCache 'profile', assinado pelo
// app/settings.js) → a capa nova aparece na hora, sem esperar a revalidação.
// Só para a conta ativa (perfil de outra pessoa nunca entra aqui).
export function patchMyProfileCache(next, email) {
  try {
    if (!next || typeof next !== 'object') return;
    const sc = require('./settingsCache');
    const me = String(sc.activeAccount?.() || '').toLowerCase();
    const who = String(email || '').toLowerCase();
    if (!me || (who && who !== me)) return;
    const p = { ...next };
    if (p.cover_url !== undefined) p.cover_url = normalizeCoverUrl(p.cover_url);
    sc.patch('profile', p);
    if (p.cover_url) prefetchCover(p.cover_url);
  } catch {}
}

// Aquece o cache em disco do expo-image (capa pinta no 1º frame do "Você").
export function prefetchCover(url) {
  const u = normalizeCoverUrl(url);
  if (!u || Platform.OS === 'web' || !/^https?:/i.test(u)) return;
  try { const I = require('expo-image').Image; I?.prefetch?.(u, 'memory-disk'); } catch {}
}
