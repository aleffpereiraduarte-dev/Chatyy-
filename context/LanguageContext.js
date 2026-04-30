import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { Platform, NativeModules } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { translations, DEFAULT_LANGUAGE } from '../i18n';
import { setUserLanguage as apiSetUserLanguage } from '../services/api';

const LanguageContext = createContext(null);

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
  // Exact match (pt-BR, en, etc.)
  if (translations[tag]) return tag;
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

export function LanguageProvider({ children }) {
  const [language, setLanguage] = useState(DEFAULT_LANGUAGE);

  // Propagate the selected language to the API layer so every backend call
  // carries an X-User-Language header. AI prompts read this to respond in
  // the user's actual language instead of defaulting to pt-BR.
  useEffect(() => {
    apiSetUserLanguage((language || '').slice(0, 2));
  }, [language]);

  useEffect(() => {
    const loadLanguage = async () => {
      let manualChoice = null;

      // Only respect saved preference if user explicitly chose a language
      if (Platform.OS === 'web') {
        try {
          if (typeof localStorage !== 'undefined') {
            manualChoice = localStorage.getItem('app_language_manual');
          }
        } catch {}
      } else {
        try {
          manualChoice = await AsyncStorage.getItem('app_language_manual');
        } catch {}
      }

      if (manualChoice && translations[manualChoice]) {
        // User explicitly chose this language — respect it
        setLanguage(manualChoice);
      } else {
        // Auto-detect from device locale (always re-detect, never cache)
        const detected = detectLanguage();
        setLanguage(detected);
      }
    };
    loadLanguage();
  }, []);

  const changeLanguage = useCallback((code) => {
    if (!translations[code]) return;
    setLanguage(code);
    // Save as manual choice (user explicitly selected)
    if (Platform.OS === 'web') {
      try { if (typeof localStorage !== 'undefined') localStorage.setItem('app_language_manual', code); } catch {}
    } else {
      AsyncStorage.setItem('app_language_manual', code).catch(() => {});
    }
  }, []);

  const t = useCallback((key, params) => {
    let str = translations[language]?.[key] ?? translations[DEFAULT_LANGUAGE]?.[key] ?? key;
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
  }, [language]);

  // Memoize context value — `t` is already stable (useCallback on language),
  // so this only creates a new object when language actually changes.
  const contextValue = useMemo(() => ({ language, changeLanguage, t }), [language, changeLanguage, t]);

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
