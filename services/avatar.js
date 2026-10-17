// [2026-10-14 avatar-instant] URL CANÔNICA ÚNICA da foto de perfil + prefetch da
// versão grande.
//
// Antes o MESMO avatar saía com várias URLs (com/sem `av=2|3`, com/sem `v=`,
// `name=` antes/depois do `v=`, host chatyy.com.br vs api-br/api-eu, `d=AAAAMMDD`
// que mudava todo dia) → baixava 2× (lista ≠ visualizador) e o cache inteiro
// expirava à meia-noite UTC. Agora TODA URL get_avatar do app passa por aqui:
//
//   lista/headers : {API_URL}?action=get_avatar&email=<lower>&v=<versão>&viewer=<eu>
//   tela cheia    : ...&v=<versão>&size=1024&viewer=<eu>
//   sem versão    : ...&email=<lower>&av=3[&name=<nome>]&viewer=<eu>   (iniciais geradas)
//
// - `v=` = versão da foto (avatar_version do servidor / WS avatar_updated, store
//   services/avatarVersions.js) → com o patch de servidor vira cache imutável.
// - Sem `d=`: foto nova muda o `v=`; desenho das iniciais muda o `av=`.
// - `name=` só sem `v=` (só afeta as iniciais geradas; com foto real é ruído
//   que fragmentava o cache).
// - Parâmetros em ordem FIXA → a lista, o cabeçalho, o perfil e o visualizador
//   pedem byte-a-byte a mesma URL (cache de memória/disco do expo-image e do
//   navegador acertam na hora).
import { Platform } from 'react-native';
import { getAvatarVersion, emailFromAvatarUrl, normAvatarVersion } from './avatarVersions';

// Versão do DESENHO das iniciais geradas no servidor (antes: AVATAR_INITIALS_RENDER_V
// em services/api.js = 3 e `av=2` hardcoded no AvatarCircle — 2 URLs p/ o mesmo PNG).
export const AVATAR_INITIALS_RENDER_V = 3;
// Lado da versão "grande" (servidor: size=96|256|1024; sem size = 256).
export const AVATAR_FULL_SIZE = 1024;
// [avatar-ai 2026-10-17] Versão da "foto grande" (size=1024). Entre 14/10 e 17/10 o servidor
// respondia a 256 antiga como `immutable` p/ size=1024; agora fotos antigas ganham versão
// grande melhorada por IA (Real-ESRGAN no NOSSO servidor) SEM mudar o `v=` da lista.
// `fv=` muda só a URL grande → aparelhos que guardaram a 256 imutável buscam a nova.
export const AVATAR_FULL_RENDER_V = 2;

const FALLBACK_API = 'https://chatyy.com.br/api/email.php';
let _apiMod = null;
function _api() {
  if (_apiMod) return _apiMod;
  try { _apiMod = require('./api'); } catch { _apiMod = null; }
  return _apiMod;
}

function _normEmail(email) {
  if (!email || typeof email !== 'string') return '';
  let e = email.trim().toLowerCase();
  const m = e.match(/<([^>]+@[^>]+)>/);
  if (m) e = m[1].trim();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : '';
}

function _param(url, name) {
  const m = String(url).match(new RegExp('[?&]' + name + '=([^&#]*)'));
  if (!m) return '';
  try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch { return m[1]; }
}

/**
 * URL canônica da foto de perfil de `email`.
 * opts.size    'list' (padrão, 256 no servidor) | 'full' (1024)
 * opts.name    nome exibido (só entra quando não há versão → iniciais)
 * opts.version versão vinda de uma URL do servidor (usa a MAIOR entre esta e o store)
 * opts.nofallback  mantém o `nofallback=1` (mosaico de grupo)
 */
export function buildAvatarUrl(email, opts = {}) {
  const e = _normEmail(email);
  if (!e) return null;
  const api = _api();
  let base = FALLBACK_API;
  try { base = (api && typeof api.getApiUrl === 'function' && api.getApiUrl()) || FALLBACK_API; } catch {}
  let viewer = '';
  try { viewer = (api && typeof api.getAvatarViewerEmail === 'function' && api.getAvatarViewerEmail()) || ''; } catch {}
  let v = getAvatarVersion(e) || 0;
  const ov = Number(opts.version) || 0;
  if (ov > 0 && normAvatarVersion(ov) > normAvatarVersion(v)) v = ov;
  let u = `${base}?action=get_avatar&email=${encodeURIComponent(e)}`;
  if (v) {
    u += `&v=${v}`;
  } else {
    u += `&av=${AVATAR_INITIALS_RENDER_V}`;
    // `name=` só p/ remetentes EXTERNOS ("Google" → GO em vez de "no-reply" → NO).
    // Contas Chatyy/OneMundo: o servidor tira as iniciais do usuário — o nome só
    // criava uma 2ª URL (com/sem name) p/ o mesmo PNG (medido no boot: 2 contatos ×2).
    const n = typeof opts.name === 'string' ? opts.name.trim() : '';
    const own = /@(chatyy|onemundo)\.com\.br$/.test(e);
    if (n && !own && n.indexOf('@') === -1) u += `&name=${encodeURIComponent(n.slice(0, 40))}`;
  }
  if (opts.size === 'full') u += `&size=${AVATAR_FULL_SIZE}&fv=${AVATAR_FULL_RENDER_V}`;
  if (opts.nofallback) u += '&nofallback=1';
  if (viewer) u += `&viewer=${encodeURIComponent(viewer)}`;
  return u;
}

export function isAvatarUrl(url) {
  return typeof url === 'string' && url.indexOf('get_avatar') !== -1;
}

// ── Credencial nas requisições de avatar [avatar-privacy-auth 2026-10-14] ──
// O servidor decide a foto RESTRITA ("meus contatos"/"ninguém"/exceções) pela
// identidade AUTENTICADA — o `viewer=` da URL virou só chave de cache (era
// forjável). Nativo: manda o Bearer (expo-image `source.headers`, prefetch e o
// download do avatarCache). Web: `<img>`/`new Image()` levam o cookie de sessão
// PHP do host da API (mesmo site chatyy.com.br) — nada a fazer aqui.
// Fotos públicas continuam idênticas (o Cloudflare ignora Authorization na chave
// e a resposta pública segue imutável); só host nosso recebe o token.
const _OUR_API_HOST_RE = /^https:\/\/([a-z0-9-]+\.)*chatyy\.com\.br\//i;
export function avatarAuthHeaders(url) {
  if (Platform.OS === 'web') return null;
  if (typeof url !== 'string' || !isAvatarUrl(url) || !_OUR_API_HOST_RE.test(url)) return null;
  const api = _api();
  let tok = null;
  try { tok = api && typeof api.getAuthToken === 'function' ? api.getAuthToken() : null; } catch { tok = null; }
  return tok ? { Authorization: `Bearer ${tok}` } : null;
}

/** `source` do expo-image p/ uma URL de avatar (com Bearer quando for get_avatar nosso). */
export function avatarSource(uri) {
  if (!uri) return { uri };
  const h = avatarAuthHeaders(uri);
  return h ? { uri, headers: h } : { uri };
}

/**
 * Normaliza QUALQUER URL get_avatar (relativa do servidor, outro host, com
 * `d=`/`av=`/`v=` velho) para a canônica. Outras URLs (foto de grupo em /data,
 * R2, file://, data:) passam intactas — só ganham host absoluto se relativas.
 */
export function canonicalAvatarUrl(url, opts = {}) {
  if (!url || typeof url !== 'string') return url || null;
  if (!isAvatarUrl(url)) {
    if (/^(https?:|file:|data:|blob:|content:|ph:|assets-library:)/i.test(url)) return url;
    return `https://chatyy.com.br${url.startsWith('/') ? '' : '/'}${url}`;
  }
  const e = emailFromAvatarUrl(url);
  if (!e) return url;
  const vRaw = Number(_param(url, 'v')) || 0;
  const name = opts.name !== undefined ? opts.name : _param(url, 'name');
  const nofb = opts.nofallback !== undefined ? opts.nofallback : /[?&]nofallback=(1|true)/.test(url);
  return buildAvatarUrl(e, { size: opts.size, name, version: vRaw, nofallback: nofb });
}

/**
 * Par {thumb, full} para o visualizador: `thumb` é EXATAMENTE a URL que a
 * lista/cabeçalho já pintou (cache quente), `full` a versão 1024.
 * Para fotos que não são get_avatar (grupo), thumb === full.
 */
export function avatarViewerSources({ email, uri, name } = {}) {
  const e = _normEmail(email) || (isAvatarUrl(uri) ? emailFromAvatarUrl(uri) : '');
  if (e) {
    const vRaw = isAvatarUrl(uri) ? (Number(_param(uri, 'v')) || 0) : 0;
    return {
      email: e,
      thumb: buildAvatarUrl(e, { name, version: vRaw }),
      full: buildAvatarUrl(e, { name, version: vRaw, size: 'full' }),
    };
  }
  const u = typeof uri === 'string' && uri ? canonicalAvatarUrl(uri) : null;
  return { email: '', thumb: u, full: u };
}

// ── Prefetch da versão grande ──────────────────────────────────────────
// Chamado quando a conversa/perfil abre (AvatarCircle prefetchFull) e no
// onPressIn de qualquer avatar tocável (~100-150 ms de vantagem antes do onPress).
const _prefetched = new Map(); // url → ts
const _webHold = []; // segura referências <img> pra o decode não ser coletado
export function prefetchAvatarFull(emailOrUrl, opts = {}) {
  let url = null;
  try {
    if (isAvatarUrl(emailOrUrl)) url = canonicalAvatarUrl(emailOrUrl, { size: 'full', name: opts.name });
    else if (_normEmail(emailOrUrl)) url = buildAvatarUrl(emailOrUrl, { size: 'full', name: opts.name });
    else if (typeof emailOrUrl === 'string' && emailOrUrl) url = canonicalAvatarUrl(emailOrUrl);
  } catch { url = null; }
  if (!url) return null;
  // Sem versão = iniciais geradas: não vale gastar banda com a "grande".
  if (isAvatarUrl(url) && !/[?&]v=/.test(url)) return null;
  const now = Date.now();
  const last = _prefetched.get(url);
  if (last && now - last < 10 * 60 * 1000) return url;
  _prefetched.set(url, now);
  if (_prefetched.size > 300) { const k = _prefetched.keys().next().value; _prefetched.delete(k); }
  try {
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined' || typeof window.Image !== 'function') return url;
      const img = new window.Image();
      try { img.decoding = 'async'; } catch {}
      try { img.fetchPriority = opts.high ? 'high' : 'low'; } catch {}
      img.src = url;
      try { img.decode?.().catch(() => {}); } catch {}
      _webHold.push(img);
      if (_webHold.length > 12) _webHold.shift();
    } else {
      const ExpoImage = require('expo-image').Image;
      // [avatar-privacy-auth 2026-10-14] prefetch(urls, { cachePolicy, headers }) — Bearer p/ foto restrita.
      const headers = avatarAuthHeaders(url);
      ExpoImage?.prefetch?.(url, headers ? { cachePolicy: 'memory-disk', headers } : 'memory-disk')?.catch?.(() => {});
    }
  } catch {}
  return url;
}
