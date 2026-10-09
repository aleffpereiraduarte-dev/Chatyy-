import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Platform, NativeModules, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { translations, DEFAULT_LANGUAGE, ensureLocaleLoaded, onLocaleLoaded, isLocaleSupported, preloadLocale, fallbackChain } from '../i18n';
import { setUserLanguage as apiSetUserLanguage, chatUpdateSettings as apiChatUpdateSettings } from '../services/api';

// [2026-10-08 web-receipts-i18n] Idioma da CONTA. Antes o web usava SÓ o
// navigator.language (Chrome en-US → UI em inglês, "Mark as read", AM/PM) mesmo
// com o usuário usando o app em pt-BR — e o iPhone, sem escolha manual, segue o
// idioma do aparelho. Agora a ordem é:
//   1. escolha MANUAL local (app_language_manual) — a mais nova entre local e
//      conta vence (timestamps app_language_manual_at × app_language_at);
//   2. escolha explícita da CONTA (chat_get_settings.app_language, gravada por
//      qualquer aparelho ao trocar o idioma em Configurações);
//   3. idioma do APARELHO nativo da conta (chat_get_settings.device_language,
//      derivado do lang do push token) — só no web;
//   4. idioma do navegador/aparelho (detectLanguage).
// O resultado de 2/3 fica em cache local (app_language_account) p/ o 1º render
// do próximo boot já sair no idioma certo (sem piscar inglês → português).
const LANG_MANUAL_KEY = 'app_language_manual';
const LANG_MANUAL_AT_KEY = 'app_language_manual_at';
const LANG_ACCOUNT_KEY = 'app_language_account';

function _webGet(key) {
  try { return (typeof localStorage !== 'undefined') ? localStorage.getItem(key) : null; } catch { return null; }
}
function _webSet(key, val) {
  try { if (typeof localStorage !== 'undefined') { if (val == null) localStorage.removeItem(key); else localStorage.setItem(key, String(val)); } } catch {}
}
async function _kvGet(key) {
  if (Platform.OS === 'web') return _webGet(key);
  try { return await AsyncStorage.getItem(key); } catch { return null; }
}
function _kvSet(key, val) {
  if (Platform.OS === 'web') { _webSet(key, val); return; }
  try {
    if (val == null) AsyncStorage.removeItem(key).catch(() => {});
    else AsyncStorage.setItem(key, String(val)).catch(() => {});
  } catch {}
}

const LanguageContext = createContext(null);

// Per-provider device id used as the `origin` envelope on outgoing
// user_setting_update frames. Receiving listener compares against this
// to ignore its own echo and prevent broadcast loops between devices.
const LANG_DEVICE_ID = `l_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;

function _broadcastLanguage(code) {
  try {
    const mod = require('../services/websocket');
    const ws = mod?.default;
    if (ws && typeof ws.send === 'function' && ws.isConnected) {
      ws.send({ type: 'user_setting_update', key: 'language', value: code, origin: LANG_DEVICE_ID });
    }
  } catch {}
}

// Map browser/device locale codes to our supported language codes
const LOCALE_MAP = {
  'pt': 'pt-BR', 'pt-br': 'pt-BR', 'pt-pt': 'pt-PT',
  'en': 'en', 'es': 'es', 'ja': 'ja', 'fr': 'fr',
  'de': 'de', 'it': 'it', 'zh': 'zh-CN', 'zh-cn': 'zh-CN', 'ko': 'ko', 'ar': 'ar',
  'ru': 'ru', 'hi': 'hi', 'tr': 'tr', 'nl': 'nl', 'pl': 'pl',
  'sv': 'sv', 'nb': 'nb', 'no': 'nb', 'da': 'da', 'fi': 'fi',
  'cs': 'cs', 'ro': 'ro', 'hu': 'hu', 'el': 'el', 'uk': 'uk',
  'th': 'th', 'vi': 'vi', 'id': 'id', 'ms': 'ms', 'fil': 'fil',
  'tl': 'fil', 'he': 'he', 'iw': 'he', 'fa': 'fa', 'bn': 'bn',
  'sw': 'sw', 'ur': 'ur', 'ta': 'ta', 'te': 'te', 'mr': 'mr',
  'gu': 'gu', 'kn': 'kn', 'ml': 'ml', 'pa': 'pa', 'my': 'my',
  'km': 'km', 'am': 'am', 'ne': 'ne', 'si': 'si', 'ka': 'ka',
  'hy': 'hy', 'az': 'az', 'kk': 'kk', 'uz': 'uz', 'mn': 'mn',
  'lo': 'lo', 'hr': 'hr', 'sk': 'sk', 'bg': 'bg', 'sr': 'sr',
  'sl': 'sl', 'lt': 'lt', 'lv': 'lv', 'et': 'et', 'ca': 'ca',
};

function resolveLocale(tag) {
  if (!tag) return null;
  // Exact match (pt-BR, en, etc.) — checa idiomas suportados (mesmo os lazy
  // ainda não carregados), não só os que já estão em `translations`.
  if (isLocaleSupported(tag)) return tag;
  // Case-insensitive exact match
  const lower = tag.toLowerCase();
  if (LOCALE_MAP[lower]) return LOCALE_MAP[lower];
  // Language prefix (pt from pt-BR, en from en-US)
  const prefix = lower.split('-')[0];
  if (LOCALE_MAP[prefix]) return LOCALE_MAP[prefix];
  return null;
}

// Get device locale using React Native built-in APIs (no expo-localization needed)
function getNativeLocales() {
  try {
    if (Platform.OS === 'ios') {
      // iOS: SettingsManager has AppleLanguages and AppleLocale
      const settings = NativeModules.SettingsManager?.settings;
      if (settings) {
        const langs = settings.AppleLanguages;
        if (Array.isArray(langs) && langs.length > 0) return langs;
        // AppleLocale vem como en_US — normaliza pra BCP47 (en-US).
        if (settings.AppleLocale) return [String(settings.AppleLocale).replace(/_/g, '-')];
      }
    } else if (Platform.OS === 'android') {
      // Android: I18nManager has localeIdentifier (ex.: pt_BR ou en_US_POSIX)
      const locale = NativeModules.I18nManager?.localeIdentifier;
      if (locale) return [String(locale).replace(/_/g, '-')];
    }
  } catch {}
  return [];
}

function detectLanguage() {
  try {
    let locales = [];
    if (Platform.OS === 'web') {
      locales = navigator.languages ? [...navigator.languages] : [navigator.language || ''];
    } else {
      locales = getNativeLocales();
    }

    for (const locale of locales) {
      const resolved = resolveLocale(locale);
      if (resolved) return resolved;
    }
  } catch {}
  return DEFAULT_LANGUAGE;
}

// [2026-10-09 lighter-app] Idioma de boot resolvido ANTES do 1º frame.
// O _layout chama preloadBootLanguage() em paralelo à hidratação do cache
// (mesmo gate do splash): lê a escolha manual/da conta (AsyncStorage/
// localStorage), e se o idioma não está no bundle (só pt-BR/en estão) lê o
// pacote do disco (~10-40 ms) — rede só se couber no teto. Assim o 1º render
// já sai no idioma salvo, sem piscar inglês, e sem segurar o boot.
let _bootLang = null;     // idioma resolvido no preload (null = não rodou)
let _bootManual = null;   // escolha manual lida no preload
let _bootPromise = null;
export function bootLanguageNeedsPreload() {
  try {
    if (Platform.OS !== 'web') return true; // nativo: leitura async do AsyncStorage
    const m = _webGet(LANG_MANUAL_KEY);
    const a = _webGet(LANG_ACCOUNT_KEY);
    const code = (m && isLocaleSupported(m)) ? m : (a && isLocaleSupported(a)) ? a : detectLanguage();
    return !!code && !translations[code];
  } catch { return false; }
}
export function preloadBootLanguage(maxWaitMs = 900) {
  if (_bootPromise) return _bootPromise;
  _bootPromise = (async () => {
    let code = null;
    try {
      const m = await _kvGet(LANG_MANUAL_KEY);
      if (m && isLocaleSupported(m)) { code = m; _bootManual = m; }
      else {
        const a = await _kvGet(LANG_ACCOUNT_KEY);
        if (a && isLocaleSupported(a)) code = a;
      }
    } catch {}
    if (!code) { try { code = detectLanguage(); } catch { code = DEFAULT_LANGUAGE; } }
    _bootLang = code || DEFAULT_LANGUAGE;
    if (!translations[_bootLang]) { try { await preloadLocale(_bootLang, maxWaitMs); } catch {} }
    return _bootLang;
  })().catch(() => DEFAULT_LANGUAGE);
  return _bootPromise;
}

export function LanguageProvider({ children }) {
  // [perf 2026-10-06] Seed with the synchronously detected device locale
  // (detectLanguage() is sync) instead of DEFAULT_LANGUAGE → the first render
  // is already in the user's language and the post-AsyncStorage setLanguage
  // is a no-op for the ~99% without a manual override (saves one full-tree
  // re-render at boot). Manual choice still wins once read below.
  const [language, setLanguage] = useState(() => {
    // Web: localStorage é síncrono → manual/conta já no 1º render.
    if (Platform.OS === 'web') {
      const m = _webGet(LANG_MANUAL_KEY);
      if (m && isLocaleSupported(m)) return m;
      const a = _webGet(LANG_ACCOUNT_KEY);
      if (a && isLocaleSupported(a)) return a;
    }
    // Nativo: idioma salvo já resolvido pelo preloadBootLanguage() do gate.
    if (_bootLang && isLocaleSupported(_bootLang)) return _bootLang;
    try { return detectLanguage() || DEFAULT_LANGUAGE; } catch { return DEFAULT_LANGUAGE; }
  });
  // Escolha manual local vigente (null = nunca escolheu neste aparelho).
  const manualRef = useRef(Platform.OS === 'web' ? (() => { const m = _webGet(LANG_MANUAL_KEY); return (m && isLocaleSupported(m)) ? m : null; })() : _bootManual);
  // Bumped quando um idioma lazy termina de carregar → força o t() a recomputar
  // (e os consumidores a re-renderizarem) com as traduções recém-injetadas.
  const [loadedTick, setLoadedTick] = useState(0);

  // [2026-10-06 i18n-remote] Carrega o idioma ativo sob demanda. pt-BR/en/es/
  // pt-PT já estão no bundle; os outros 55 vêm do servidor (JSON + cache em
  // disco) via ensureLocaleLoaded(). A troca de idioma é imediata e, enquanto
  // o JSON não chega, o t() cai no fallback en→pt-BR (nunca chave crua, nunca
  // tela em branco). Quando chega (ou num retry tardio) o tick re-renderiza.
  const languageRef = useRef(language);
  languageRef.current = language;
  useEffect(() => {
    if (!language || translations[language]) return; // já disponível
    let alive = true;
    ensureLocaleLoaded(language).then((ok) => {
      if (alive && ok) setLoadedTick((n) => n + 1);
    }).catch(() => {});
    return () => { alive = false; };
  }, [language]);
  // Retry tardio / manifest novo → só re-renderiza se for o idioma ativo.
  useEffect(() => {
    const off = onLocaleLoaded((code) => {
      if (code === languageRef.current) setLoadedTick((n) => n + 1);
    });
    return () => { try { off && off(); } catch {} };
  }, []);
  // Voltou pro foreground ainda sem o idioma (falhou offline)? Tenta de novo.
  useEffect(() => {
    if (Platform.OS === 'web' || !AppState || typeof AppState.addEventListener !== 'function') return;
    const sub = AppState.addEventListener('change', (st) => {
      const code = languageRef.current;
      if (st === 'active' && code && !translations[code]) ensureLocaleLoaded(code).catch(() => {});
    });
    return () => { try { sub && sub.remove && sub.remove(); } catch {} };
  }, []);

  // Propagate the selected language to the API layer so every backend call
  // carries an X-User-Language header. AI prompts read this to respond in
  // the user's actual language instead of defaulting to pt-BR.
  useEffect(() => {
    apiSetUserLanguage((language || '').slice(0, 2));
  }, [language]);

  useEffect(() => {
    const loadLanguage = async () => {
      // Only respect saved preference if user explicitly chose a language
      const manualChoice = await _kvGet(LANG_MANUAL_KEY);

      if (manualChoice && isLocaleSupported(manualChoice)) {
        // User explicitly chose this language — respect it
        manualRef.current = manualChoice;
        setLanguage(manualChoice);
      } else {
        manualRef.current = null;
        // [2026-10-08 web-receipts-i18n] Web: idioma da conta (cache do último
        // chat_get_settings) antes do navegador. Nativo segue o aparelho, a
        // menos que a conta tenha escolha explícita (applyAccountLanguage).
        // [2026-10-09] Nativo: app_language_account só é gravado com escolha
        // EXPLÍCITA (conta/Configurações) → vale no boot também (sem piscar).
        const acct = await _kvGet(LANG_ACCOUNT_KEY);
        if (acct && isLocaleSupported(acct)) { setLanguage(acct); return; }
        // Auto-detect from device locale (always re-detect, never cache)
        const detected = detectLanguage();
        setLanguage(detected);
      }
    };
    loadLanguage();
  }, []);

  // Suppress outbound broadcast while applying an inbound frame. Otherwise
  // device A's change would ping B, B applies + re-broadcasts to A, looping
  // forever. Ref (not state) so the gate is synchronous within one tick.
  const _suppressBroadcast = useRef(false);

  const _persistLanguage = useCallback((code, at) => {
    manualRef.current = code;
    _kvSet(LANG_MANUAL_KEY, code);
    _kvSet(LANG_MANUAL_AT_KEY, String(Number(at) > 0 ? Number(at) : Date.now()));
  }, []);

  // [2026-10-08 web-receipts-i18n] Escolha explícita vira preferência da CONTA
  // (chat_chatyy_settings, merge parcial no servidor) → web/outros aparelhos
  // abrem no mesmo idioma mesmo com navegador em outra língua.
  const _pushAccountLanguage = useCallback((code, at) => {
    try {
      const p = apiChatUpdateSettings({ app_language: code, app_language_at: Number(at) > 0 ? Number(at) : Date.now() });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  }, []);

  const changeLanguage = useCallback((code) => {
    if (!isLocaleSupported(code)) return;
    // Dispara o download antes do setState (o effect acima só roda após o
    // render) → o JSON chega alguns ms mais cedo; idempotente/single-flight.
    ensureLocaleLoaded(code).catch(() => {});
    setLanguage(code);
    const now = Date.now();
    _persistLanguage(code, now);
    _kvSet(LANG_ACCOUNT_KEY, code);
    _pushAccountLanguage(code, now);
    if (!_suppressBroadcast.current) _broadcastLanguage(code);
  }, [_persistLanguage, _pushAccountLanguage]);

  // [2026-10-08 web-receipts-i18n] Aplica o idioma da CONTA vindo de
  // chat_get_settings ({ app_language, app_language_at, device_language }).
  // Chamado após login/troca de conta (AccountLanguageSync em _layout.js).
  const applyAccountLanguage = useCallback(async (settings) => {
    try {
      if (!settings || typeof settings !== 'object') return;
      const acct = (typeof settings.app_language === 'string' && isLocaleSupported(settings.app_language)) ? settings.app_language : null;
      const acctAt = Number(settings.app_language_at || 0) || 0;
      const localManual = manualRef.current || (await _kvGet(LANG_MANUAL_KEY));
      const localManualOk = !!(localManual && isLocaleSupported(localManual));
      const localAt = Number((await _kvGet(LANG_MANUAL_AT_KEY)) || 0) || 0;
      if (acct) {
        _kvSet(LANG_ACCOUNT_KEY, acct);
        if (!localManualOk || (acct !== localManual && acctAt > localAt)) {
          ensureLocaleLoaded(acct).catch(() => {});
          setLanguage(acct);
          if (localManualOk) _persistLanguage(acct, acctAt); // escolha mais nova veio de outro aparelho
        }
        return;
      }
      if (localManualOk) {
        // Escolha manual feita antes de existir a preferência da conta → sobe.
        _pushAccountLanguage(localManual, localAt || Date.now());
        return;
      }
      if (Platform.OS === 'web') {
        const dev = resolveLocale(settings.device_language);
        if (dev) {
          _webSet(LANG_ACCOUNT_KEY, dev);
          ensureLocaleLoaded(dev).catch(() => {});
          setLanguage(dev);
        } else {
          _webSet(LANG_ACCOUNT_KEY, null);
          setLanguage(detectLanguage());
        }
      }
    } catch {}
  }, [_persistLanguage, _pushAccountLanguage]);

  // Subscribe to incoming user_setting_update frames so a language switch
  // on web reaches mobile (and vice-versa). Ignore our own echo via the
  // origin field; suppress re-broadcast on apply to avoid loops.
  useEffect(() => {
    let off = null;
    try {
      const ws = require('../services/websocket').default;
      if (!ws || typeof ws.on !== 'function') return;
      off = ws.on('user_setting_update', (frame) => {
        try {
          if (!frame || frame.origin === LANG_DEVICE_ID) return;
          if (frame.key !== 'language' && frame.key !== 'locale') return;
          const code = frame.value;
          if (!isLocaleSupported(code)) return;
          _suppressBroadcast.current = true;
          try {
            setLanguage(code);
            _persistLanguage(code);
          } finally {
            _suppressBroadcast.current = false;
          }
        } catch {}
      });
    } catch {}
    return () => { try { off && off(); } catch {} };
  }, [_persistLanguage]);

  const t = useCallback((key, params) => {
    // Fallback chain: active language → English (universal) → pt-BR → raw key.
    // English MUST precede pt-BR so a key missing in en/es doesn't leak
    // Portuguese to non-Portuguese users. Bug-hunt P3 (2026-05-30).
    // [2026-10-09] Cadeia por idioma (pt-PT → pt-BR → en; demais → en → pt-BR):
    // idioma remoto ainda baixando nunca mostra chave crua.
    let str;
    const chain = fallbackChain(language);
    for (let i = 0; i < chain.length && str == null; i++) str = translations[chain[i]]?.[key];
    if (str == null) str = key;
    // For arrays (like time.days), return as-is
    if (Array.isArray(str)) return str;
    // Interpolate {param} placeholders.
    // Usa função como replacement — strings podem conter $/$&/$1 que o JS
    // trataria como referências de captura e quebraria a saída.
    if (params && typeof str === 'string') {
      Object.keys(params).forEach(k => {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), () => String(params[k]));
      });
    }
    return str;
  }, [language, loadedTick]);

  // Memoize context value — `t` is already stable (useCallback on language),
  // so this only creates a new object when language actually changes.
  const contextValue = useMemo(() => ({ language, changeLanguage, t, applyAccountLanguage }), [language, changeLanguage, t, applyAccountLanguage]);

  return (
    <LanguageContext.Provider value={contextValue}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be inside LanguageProvider');
  return ctx;
}
