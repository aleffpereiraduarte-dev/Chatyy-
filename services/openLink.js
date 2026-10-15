// [2026-10-15 native-browser] Helper ÚNICO para abrir links tocados no chat,
// e-mail, feed, status, canais e bots (WhatsApp/Telegram: o link abre num
// navegador DENTRO do app, com a cor do tema e o botão nativo "abrir no
// Safari/Chrome").
//
//   openLink(url, { router, colors, isDark })
//
// Ordem de decisão:
//   1. mailto: / tel: / sms: / facetime: / geo: / maps: / esquemas próprios
//      → sistema (Linking.openURL).
//   2. Links do próprio Chatyy que o app sabe abrir (utils/universalLinks.js:
//      /u/…, /@handle, /g/ e /j/ convites de grupo, /meet/…, /call/…, /live/…,
//      /ch/…, /feed/…, /chat/…, /stickers/store) → navegação INTERNA, sem
//      navegador nenhum. chatyy.com.br/docs/… → visualizador de documentos.
//   3. http(s) qualquer → SFSafariViewController (iOS, page sheet) / Chrome
//      Custom Tabs (Android) via utils/inAppBrowser.openInApp (expo-web-browser,
//      que já está no binário). "Abrir no navegador" = botão nativo do próprio
//      SFSafariViewController (bússola) / menu ⋮ do Custom Tab.
//   4. Qualquer falha → Linking.openURL (comportamento antigo). Nunca lança.
//
// Kill switch (OTA): globalThis.__chatyy_native_browser = false → volta ao
// comportamento anterior (Linking.openURL direto, só o atalho de /docs/ fica).
// Puro JS: binário antigo idêntico (expo-web-browser já vinha linkado).
import { Platform, Linking } from 'react-native';
import { resolveUniversalLink } from '../utils/universalLinks';

const SYSTEM_SCHEMES = /^(mailto|tel|telprompt|sms|smsto|mms|facetime|facetime-audio|geo|maps|comgooglemaps|market|itms-apps|itms-services|whatsapp|tg):/i;
const DOCS_RE = /^https?:\/\/(www\.)?chatyy\.com\.br\/docs\//i;

export function isNativeBrowserEnabled() {
  try { return globalThis.__chatyy_native_browser !== false; } catch { return true; }
}

/** Normaliza o que veio do texto: espaços, "www.", pontuação final colada. */
export function normalizeLink(raw) {
  let u = String(raw == null ? '' : raw).trim();
  if (!u) return '';
  // Pontuação de frase grudada no fim ("veja https://x.com/a." / "(https://x.com)").
  if (/^(https?:\/\/|www\.)/i.test(u)) {
    u = u.replace(/[.,;:!?…]+$/u, '');
    if (u.endsWith(')') && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length) u = u.slice(0, -1);
  }
  if (/^www\./i.test(u)) u = 'https://' + u;
  return u;
}

function _sys(u) {
  try { return Promise.resolve(Linking.openURL(u)).then(() => true, () => false); } catch { return Promise.resolve(false); }
}

function _router(opts) {
  if (opts && opts.router && typeof opts.router.push === 'function') return opts.router;
  try { return require('expo-router').router; } catch { return null; }
}

// [2026-10-15 app-links] Links que abrem NO APP do serviço quando instalado
// (WhatsApp faz igual). iOS: universal link only (ExpoChatyySystem.
// openUniversalLink → UIApplication.open(.universalLinksOnly)); Android:
// ACTION_VIEW preso ao pacote (openInAppPackage). Não instalado / binário
// antigo sem a função → navegador interno (comportamento anterior).
// Kill switch (OTA): globalThis.__chatyy_app_links = false.
export const APP_HOSTS = [
  { id: 'ytmusic', re: /^music\.youtube\.com$/i, android: 'com.google.android.apps.youtube.music' },
  { id: 'youtube', re: /^(www\.|m\.)?(youtube\.com|youtu\.be)$/i, android: 'com.google.android.youtube' },
  { id: 'spotify', re: /^(open\.)?spotify\.com$|^spotify\.link$/i, android: 'com.spotify.music' },
  { id: 'applemusic', re: /^(music|itunes)\.apple\.com$/i, android: 'com.apple.android.music' },
];

function _hostOf(u) {
  const m = /^https?:\/\/([^/?#:]+)/i.exec(u);
  return m ? m[1].toLowerCase() : '';
}

export function appHostFor(u) {
  const h = _hostOf(String(u || ''));
  if (!h) return null;
  for (const e of APP_HOSTS) { if (e.re.test(h)) return e; }
  return null;
}

let _sysMod;
function _systemMod() {
  if (_sysMod !== undefined) return _sysMod;
  try { _sysMod = require('expo').requireOptionalNativeModule('ExpoChatyySystem') || null; } catch { _sysMod = null; }
  return _sysMod;
}

/** true = abriu no app do serviço. Nunca lança. */
export async function tryOpenInServiceApp(u) {
  try {
    if (globalThis.__chatyy_app_links === false) return false;
    if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false;
    const entry = appHostFor(u);
    if (!entry) return false;
    const mod = _systemMod();
    if (!mod) return false;
    if (Platform.OS === 'ios') {
      if (typeof mod.openUniversalLink !== 'function') return false;
      return (await mod.openUniversalLink(u)) === true;
    }
    if (!entry.android || typeof mod.openInAppPackage !== 'function') return false;
    return (await mod.openInAppPackage(u, entry.android)) === true;
  } catch { return false; }
}

let _lastKey = '';
let _lastAt = 0;

/**
 * Abre um link do jeito nativo. Retorna Promise<boolean> (true = tratado).
 * opts: { router?, colors?, isDark?, fallback?: 'system'|'inapp' }
 */
export async function openLink(raw, opts = {}) {
  const u = normalizeLink(raw);
  if (!u) return false;
  // Toque duplo / onPress disparado 2x pelo Text aninhado → abre uma vez só.
  const now = Date.now();
  if (u === _lastKey && now - _lastAt < 900) return true;
  _lastKey = u; _lastAt = now;

  const router = _router(opts);

  // /docs/ sempre foi interno (antes do helper) — mantém mesmo com o kill switch.
  if (DOCS_RE.test(u) && router) {
    try { router.push({ pathname: '/documentos-viewer', params: { url: u } }); return true; } catch {}
  }

  if (!isNativeBrowserEnabled() || Platform.OS === 'web') {
    // Telas que JÁ usavam o navegador interno antes do helper (e-mail) passam
    // fallback: 'inapp' → o kill switch devolve exatamente o que elas faziam.
    if (Platform.OS !== 'web' && opts.fallback === 'inapp' && /^https?:\/\//i.test(u)) {
      try { await require('../utils/inAppBrowser').openInApp(u, { colors: opts.colors || null, isDark: opts.isDark }); return true; } catch {}
    }
    if (Platform.OS === 'web' && /^https?:\/\//i.test(u)) {
      try { window.open(u, '_blank', 'noopener'); return true; } catch {}
    }
    return _sys(u);
  }

  if (SYSTEM_SCHEMES.test(u) || !/^https?:\/\//i.test(u)) return _sys(u);

  // Deep link do próprio Chatyy → tela do app.
  let hit = null;
  try { hit = resolveUniversalLink(u); } catch { hit = null; }
  if (hit && hit.href) {
    try {
      if (hit.owner === 'layout') {
        require('./openConversation').openConversation(hit.href, { source: 'link' });
        return true;
      }
      if (router) { router.push(hit.href); return true; }
    } catch {}
  }

  // YouTube/Spotify/Apple Music → app do serviço se instalado.
  if (await tryOpenInServiceApp(u)) return true;

  try {
    const { openInApp } = require('../utils/inAppBrowser');
    let isDark = opts.isDark;
    if (isDark == null) {
      try { if (typeof globalThis.__chatyy_app_is_dark === 'boolean') isDark = globalThis.__chatyy_app_is_dark; } catch {}
    }
    await openInApp(u, { colors: opts.colors || null, isDark });
    return true;
  } catch {
    return _sys(u);
  }
}

export default openLink;

/**
 * [2026-10-15 native-location] "Abrir no app de mapas" SEM Google:
 * iOS → Apple Maps (maps.apple.com abre o app Mapas); Android → intent geo:
 * (o usuário escolhe o app de mapas instalado); falha → OpenStreetMap no
 * navegador interno. Kill switch: globalThis.__chatyy_native_location = false
 * → link do Google Maps de antes.
 */
export async function openInMaps(lat, lng, label = '', { directions = false } = {}) {
  const la = Number(lat); const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return false;
  const name = encodeURIComponent(String(label || '').slice(0, 120) || `${la},${lo}`);
  let legacy = false;
  try { legacy = globalThis.__chatyy_native_location === false; } catch {}
  if (Platform.OS === 'web') {
    try { window.open(`https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=17/${la}/${lo}`, '_blank', 'noopener'); return true; } catch { return false; }
  }
  if (legacy) return _sys(`https://www.google.com/maps/search/?api=1&query=${la},${lo}`);
  const url = Platform.OS === 'ios'
    ? (directions ? `http://maps.apple.com/?daddr=${la},${lo}&q=${name}` : `http://maps.apple.com/?ll=${la},${lo}&q=${name}`)
    : `geo:${la},${lo}?q=${la},${lo}(${name})`;
  const ok = await _sys(url);
  if (ok) return true;
  try {
    await require('../utils/inAppBrowser').openInApp(`https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=17/${la}/${lo}`, {});
    return true;
  } catch { return false; }
}
