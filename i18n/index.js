// i18n — idiomas core no bundle + idiomas remotos sob demanda (JSON do servidor).
//
// [2026-06-13 PERF] Os 63 idiomas (~26MB) eram importados estaticamente → web
// parseava 26MB no 1º load. Virou import() dinâmico por idioma.
//
// [2026-10-06 i18n-remote] O import() dinâmico SÓ faz code-split na web. No
// nativo (Hermes/Metro) os 55 idiomas "lazy" entravam no MESMO .hbc → 16.5MB
// dos 31MB do bundle (71% do JS) iam em todo OTA/APK pra <1% dos usuários.
// AGORA: só pt-BR/en/es/pt-PT (CORE_LOCALES) vão no bundle. Qualquer outro
// idioma é baixado em runtime de https://chatyy.com.br/i18n/<code>.json
// (gerado por scripts/build-i18n-json.js a partir de i18n/<code>.js, que
// continua sendo a fonte da verdade), com:
//   (a) cache em memória (translations[code]);
//   (b) cache em disco: <cacheDirectory>/i18n/<code>.<hash>.json (expo-file-system),
//       hash vem do i18n/manifest.json empacotado no bundle (gerado no build) e é
//       atualizado por um manifest remoto (TTL 24h) → idioma corrigido no servidor
//       chega sem OTA;
//   (c) fetch com timeout 6s → grava cache → aplica. Falhou? t() segue no
//       fallback en→pt-BR (nunca chave crua, nunca tela em branco) e agendamos
//       retry com backoff; ensureLocaleLoaded() resolve false (NÃO lança).
// Web: mesma URL (HTTP cache + service worker); sem FS.
// API pública preservada: translations, loadLocale, isLocaleSupported, LANGUAGES,
// DEFAULT_LANGUAGE (+ novos: ensureLocaleLoaded, onLocaleLoaded, CORE_LOCALES,
// REMOTE_LOCALES, getLocaleLoadState).
import { Platform } from 'react-native';
import ptBR from './pt-BR';
import en from './en';
import es from './es';
import ptPT from './pt-PT';
import bundledManifest from './manifest.json';

// Idiomas carregados na entrada (disponíveis sincronamente p/ o t()).
export const translations = {
  'pt-BR': ptBR,
  'en': en,
  'es': es,
  'pt-PT': ptPT,
};

// Mantém em sincronia com CORE_LOCALES em scripts/build-i18n-json.js.
export const CORE_LOCALES = ['pt-BR', 'en', 'es', 'pt-PT'];

// Idiomas servidos pelo servidor (não vão no bundle). Mesma lista de antes
// (os antigos lazyLoaders) — ml/ne/pa/si/ur são stubs e seguem fora do suporte.
export const REMOTE_LOCALES = [
  'ja', 'fr', 'de', 'it', 'zh-CN', 'ko', 'ar', 'ru', 'hi', 'tr', 'nl', 'pl',
  'sv', 'nb', 'da', 'fi', 'cs', 'ro', 'hu', 'el', 'uk', 'th', 'vi', 'id', 'ms',
  'fil', 'he', 'fa', 'bn', 'sw', 'ta', 'te', 'mr', 'gu', 'kn', 'my', 'km', 'am',
  'ka', 'hy', 'az', 'kk', 'uz', 'mn', 'lo', 'hr', 'sk', 'bg', 'sr', 'sl', 'lt',
  'lv', 'et', 'ca',
];
const REMOTE_SET = new Set(REMOTE_LOCALES);

// Origem única (US, atrás da Cloudflare). NÃO usa o edge selecionado pelo
// api.js: os JSONs só existem em /var/www/mail/i18n do US e os edges
// proxyam/404am estáticos de forma heterogênea. Overridável p/ testes.
export const I18N_ORIGIN = 'https://chatyy.com.br';
const FETCH_TIMEOUT_MS = 6000;
const MANIFEST_TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = [10000, 30000, 120000, 600000, 1800000]; // 10s,30s,2m,10m,30m
const CACHE_SUBDIR = 'i18n/';

// ── estado interno ─────────────────────────────────────────────────────────
const _inflight = {};          // code → Promise<boolean>
const _loadedHash = {};        // code → hash do JSON aplicado
const _retry = {};             // code → { attempts, timer }
const _listeners = new Set();  // fn(code)
let _remoteManifest = null;    // { locales: {code: {hash}} } (memória)
let _manifestFetchedAt = 0;
let _manifestInflight = null;

function _manifestHash(code) {
  const rm = _remoteManifest && _remoteManifest.locales && _remoteManifest.locales[code];
  if (rm && rm.hash) return String(rm.hash);
  const bm = bundledManifest && bundledManifest.locales && bundledManifest.locales[code];
  if (bm && bm.hash) return String(bm.hash);
  return 'v0';
}

function _notify(code) {
  _listeners.forEach((fn) => { try { fn(code); } catch {} });
}

function _apply(code, obj, hash) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  // Sanidade mínima: JSON vazio/corrompido NÃO substitui o fallback.
  if (Object.keys(obj).length < 10) return false;
  translations[code] = obj;
  _loadedHash[code] = hash;
  _notify(code);
  return true;
}

// Assina "idioma X ficou disponível/atualizado" (retry tardio, refresh de
// manifest). Retorna unsubscribe. O LanguageContext usa pra re-renderizar.
export function onLocaleLoaded(fn) {
  if (typeof fn !== 'function') return () => {};
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

// ── FS (nativo) ────────────────────────────────────────────────────────────
let _fs; let _fsTried = false;
function _getFS() {
  if (Platform.OS === 'web') return null;
  if (_fsTried) return _fs || null;
  _fsTried = true;
  try { _fs = require('expo-file-system/legacy'); } catch {
    try { _fs = require('expo-file-system'); } catch { _fs = null; }
  }
  if (!_fs || !_fs.cacheDirectory || typeof _fs.readAsStringAsync !== 'function') _fs = null;
  return _fs;
}
function _cacheDir() { const fs = _getFS(); return fs ? fs.cacheDirectory + CACHE_SUBDIR : null; }
function _cachePath(code, hash) { const d = _cacheDir(); return d ? `${d}${code}.${hash}.json` : null; }

async function _ensureCacheDir() {
  const fs = _getFS(); const dir = _cacheDir();
  if (!fs || !dir) return false;
  try {
    const info = await fs.getInfoAsync(dir);
    if (!info || !info.exists) await fs.makeDirectoryAsync(dir, { intermediates: true });
    return true;
  } catch { return false; }
}

async function _readCache(code, hash) {
  const fs = _getFS(); const p = _cachePath(code, hash);
  if (!fs || !p) return null;
  try {
    const info = await fs.getInfoAsync(p);
    if (!info || !info.exists) return null;
    const txt = await fs.readAsStringAsync(p);
    return JSON.parse(txt);
  } catch {
    try { await fs.deleteAsync(p, { idempotent: true }); } catch {}
    return null;
  }
}

async function _writeCache(code, hash, text) {
  const fs = _getFS(); const p = _cachePath(code, hash);
  if (!fs || !p) return;
  try {
    if (!(await _ensureCacheDir())) return;
    await fs.writeAsStringAsync(p, text);
    // Remove versões antigas do mesmo idioma (<code>.<outroHash>.json).
    try {
      const names = await fs.readDirectoryAsync(_cacheDir());
      for (const n of names) {
        if (n.startsWith(code + '.') && n.endsWith('.json') && n !== `${code}.${hash}.json`) {
          fs.deleteAsync(_cacheDir() + n, { idempotent: true }).catch(() => {});
        }
      }
    } catch {}
  } catch {}
}

// ── rede ───────────────────────────────────────────────────────────────────
async function _fetchText(url) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => { try { ctrl && ctrl.abort(); } catch {} }, FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', signal: ctrl ? ctrl.signal : undefined, headers: { Accept: 'application/json' } });
    if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
    return await res.text();
  } finally { clearTimeout(timer); }
}

function _localeUrl(code, hash) { return `${I18N_ORIGIN}/i18n/${encodeURIComponent(code)}.json?v=${encodeURIComponent(hash)}`; }

// Manifest remoto (TTL 24h, memória + disco). Nunca lança. Se o hash de um
// idioma já aplicado mudou, baixa a versão nova em background e re-aplica.
async function _refreshManifest() {
  const now = Date.now();
  if (_remoteManifest && now - _manifestFetchedAt < MANIFEST_TTL_MS) return _remoteManifest;
  if (_manifestInflight) return _manifestInflight;
  _manifestInflight = (async () => {
    const fs = _getFS();
    const diskPath = _cacheDir() ? _cacheDir() + 'manifest.json' : null;
    // 1) disco (se fresco) — evita 1 request por boot
    if (fs && diskPath && !_remoteManifest) {
      try {
        const info = await fs.getInfoAsync(diskPath);
        if (info && info.exists && info.modificationTime && (now - info.modificationTime * 1000) < MANIFEST_TTL_MS) {
          const m = JSON.parse(await fs.readAsStringAsync(diskPath));
          if (m && m.locales) { _remoteManifest = m; _manifestFetchedAt = info.modificationTime * 1000; return m; }
        }
      } catch {}
    }
    // 2) rede (cache-bust diário: o nginx/CF podem cachear a URL)
    try {
      const txt = await _fetchText(`${I18N_ORIGIN}/i18n/manifest.json?d=${Math.floor(now / MANIFEST_TTL_MS)}`);
      const m = JSON.parse(txt);
      if (m && m.locales) {
        _remoteManifest = m; _manifestFetchedAt = now;
        if (fs && diskPath) { try { if (await _ensureCacheDir()) await fs.writeAsStringAsync(diskPath, txt); } catch {} }
        // Idioma já aplicado com hash antigo? Atualiza em background.
        for (const code of Object.keys(_loadedHash)) {
          const h = _manifestHash(code);
          if (h !== _loadedHash[code] && !_inflight[code]) _download(code, h).catch(() => {});
        }
      }
    } catch {}
    return _remoteManifest;
  })();
  try { return await _manifestInflight; } finally { _manifestInflight = null; }
}

async function _download(code, hash) {
  const txt = await _fetchText(_localeUrl(code, hash));
  const obj = JSON.parse(txt);
  if (!_apply(code, obj, hash)) throw new Error('JSON inválido p/ ' + code);
  _writeCache(code, hash, txt).catch(() => {});
  return true;
}

function _scheduleRetry(code) {
  const st = _retry[code] || (_retry[code] = { attempts: 0, timer: null });
  if (st.timer) return;
  const delay = RETRY_DELAYS_MS[Math.min(st.attempts, RETRY_DELAYS_MS.length - 1)];
  if (st.attempts >= RETRY_DELAYS_MS.length) return; // desiste; próxima chamada explícita tenta de novo
  st.attempts += 1;
  st.timer = setTimeout(() => {
    st.timer = null;
    if (!translations[code]) ensureLocaleLoaded(code).catch(() => {});
  }, delay);
}

// Garante que `code` está em `translations`. Resolve true se disponível (já
// estava, veio do disco ou da rede), false se não suportado ou falhou (com
// retry agendado). NUNCA lança. Idempotente/single-flight por idioma.
export function ensureLocaleLoaded(code) {
  if (!code) return Promise.resolve(false);
  if (translations[code]) return Promise.resolve(true);
  if (!REMOTE_SET.has(code)) return Promise.resolve(false);
  if (_inflight[code]) return _inflight[code];
  _inflight[code] = (async () => {
    try {
      const hash = _manifestHash(code);
      // (b) disco
      const cached = await _readCache(code, hash);
      if (cached && _apply(code, cached, hash)) {
        _refreshManifest().catch(() => {}); // background: pega hash novo p/ próxima vez
        return true;
      }
      // (c) rede
      await _download(code, hash);
      if (_retry[code]) { clearTimeout(_retry[code].timer); _retry[code] = null; }
      _refreshManifest().catch(() => {});
      return true;
    } catch (e) {
      try { console.warn('[i18n-remote] falha ao carregar', code, e && e.message); } catch {}
      _scheduleRetry(code);
      return false;
    } finally {
      delete _inflight[code];
    }
  })();
  return _inflight[code];
}

// Compat: nome antigo usado pelo LanguageContext.
export const loadLocale = ensureLocaleLoaded;

// 'loaded' | 'loading' | 'failed' | 'idle' | 'unsupported'
export function getLocaleLoadState(code) {
  if (!code || (!translations[code] && !REMOTE_SET.has(code))) return 'unsupported';
  if (translations[code]) return 'loaded';
  if (_inflight[code]) return 'loading';
  if (_retry[code] && _retry[code].attempts > 0) return 'failed';
  return 'idle';
}

// True se o código é um idioma suportado (mesmo que ainda não carregado).
export function isLocaleSupported(code) {
  return !!code && (!!translations[code] || REMOTE_SET.has(code));
}

export const LANGUAGES = [
  { code: 'pt-BR', label: 'Português (Brasil)', flag: '🇧🇷' },
  { code: 'pt-PT', label: 'Português (Portugal)', flag: '🇵🇹' },
  { code: 'en', label: 'English', flag: '🇺🇸' },
  { code: 'es', label: 'Español', flag: '🇪🇸' },
  { code: 'fr', label: 'Français', flag: '🇫🇷' },
  { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
  { code: 'it', label: 'Italiano', flag: '🇮🇹' },
  { code: 'ja', label: '日本語', flag: '🇯🇵' },
  { code: 'zh-CN', label: '中文 (简体)', flag: '🇨🇳' },
  { code: 'ko', label: '한국어', flag: '🇰🇷' },
  { code: 'ar', label: 'العربية', flag: '🇸🇦' },
  { code: 'ru', label: 'Русский', flag: '🇷🇺' },
  { code: 'hi', label: 'हिन्दी', flag: '🇮🇳' },
  { code: 'tr', label: 'Türkçe', flag: '🇹🇷' },
  { code: 'nl', label: 'Nederlands', flag: '🇳🇱' },
  { code: 'pl', label: 'Polski', flag: '🇵🇱' },
  { code: 'sv', label: 'Svenska', flag: '🇸🇪' },
  { code: 'nb', label: 'Norsk', flag: '🇳🇴' },
  { code: 'da', label: 'Dansk', flag: '🇩🇰' },
  { code: 'fi', label: 'Suomi', flag: '🇫🇮' },
  { code: 'cs', label: 'Čeština', flag: '🇨🇿' },
  { code: 'ro', label: 'Română', flag: '🇷🇴' },
  { code: 'hu', label: 'Magyar', flag: '🇭🇺' },
  { code: 'el', label: 'Ελληνικά', flag: '🇬🇷' },
  { code: 'uk', label: 'Українська', flag: '🇺🇦' },
  { code: 'th', label: 'ไทย', flag: '🇹🇭' },
  { code: 'vi', label: 'Tiếng Việt', flag: '🇻🇳' },
  { code: 'id', label: 'Bahasa Indonesia', flag: '🇮🇩' },
  { code: 'ms', label: 'Bahasa Melayu', flag: '🇲🇾' },
  { code: 'fil', label: 'Filipino', flag: '🇵🇭' },
  { code: 'he', label: 'עברית', flag: '🇮🇱' },
  { code: 'fa', label: 'فارسی', flag: '🇮🇷' },
  { code: 'bn', label: 'বাংলা', flag: '🇧🇩' },
  { code: 'sw', label: 'Kiswahili', flag: '🇰🇪' },
  { code: 'ta', label: 'தமிழ்', flag: '🇮🇳' },
  { code: 'te', label: 'తెలుగు', flag: '🇮🇳' },
  { code: 'mr', label: 'मराठी', flag: '🇮🇳' },
  { code: 'gu', label: 'ગુજરાતી', flag: '🇮🇳' },
  { code: 'kn', label: 'ಕನ್ನಡ', flag: '🇮🇳' },
  { code: 'my', label: 'မြန်မာ', flag: '🇲🇲' },
  { code: 'km', label: 'ខ្មែរ', flag: '🇰🇭' },
  { code: 'am', label: 'አማርኛ', flag: '🇪🇹' },
  { code: 'ka', label: 'ქართული', flag: '🇬🇪' },
  { code: 'hy', label: 'Հայերեն', flag: '🇦🇲' },
  { code: 'az', label: 'Azərbaycan', flag: '🇦🇿' },
  { code: 'kk', label: 'Қазақ', flag: '🇰🇿' },
  { code: 'uz', label: "O'zbek", flag: '🇺🇿' },
  { code: 'mn', label: 'Монгол', flag: '🇲🇳' },
  { code: 'lo', label: 'ລາວ', flag: '🇱🇦' },
  { code: 'hr', label: 'Hrvatski', flag: '🇭🇷' },
  { code: 'sk', label: 'Slovenčina', flag: '🇸🇰' },
  { code: 'bg', label: 'Български', flag: '🇧🇬' },
  { code: 'sr', label: 'Srpski', flag: '🇷🇸' },
  { code: 'sl', label: 'Slovenščina', flag: '🇸🇮' },
  { code: 'lt', label: 'Lietuvių', flag: '🇱🇹' },
  { code: 'lv', label: 'Latviešu', flag: '🇱🇻' },
  { code: 'et', label: 'Eesti', flag: '🇪🇪' },
  { code: 'ca', label: 'Català', flag: '🇪🇸' },
];

export const DEFAULT_LANGUAGE = 'pt-BR';
