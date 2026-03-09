import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { translations, DEFAULT_LANGUAGE } from '../i18n';

const LanguageContext = createContext(null);

// Map browser/device locale codes to our supported language codes
function detectLanguage() {
  try {
    let locales = [];
    if (Platform.OS === 'web') {
      // navigator.languages gives ordered preference list, navigator.language is primary
      locales = navigator.languages ? [...navigator.languages] : [navigator.language || ''];
    } else {
      // React Native: use expo-localization if available
      try {
        const { getLocales } = require('expo-localization');
        const deviceLocales = getLocales();
        locales = deviceLocales.map(l => l.languageTag);
      } catch {
        // Fallback: no expo-localization
      }
    }

    // Map of locale prefixes to our supported codes
    const LOCALE_MAP = {
      'pt': 'pt-BR', 'en': 'en', 'es': 'es', 'ja': 'ja', 'fr': 'fr',
      'de': 'de', 'it': 'it', 'zh': 'zh-CN', 'ko': 'ko', 'ar': 'ar',
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

    for (const locale of locales) {
      const code = locale.toLowerCase();
      // First try exact match (e.g. pt-BR)
      if (translations[code]) return code;
      // Then try case-insensitive match
      const exactKey = Object.keys(translations).find(k => k.toLowerCase() === code);
      if (exactKey) return exactKey;
      // Then try language prefix (e.g. "pt" from "pt-PT", "en" from "en-US")
      const prefix = code.split('-')[0];
      if (LOCALE_MAP[prefix] && translations[LOCALE_MAP[prefix]]) return LOCALE_MAP[prefix];
    }
  } catch {}
  return DEFAULT_LANGUAGE;
}

export function LanguageProvider({ children }) {
  const [language, setLanguage] = useState(DEFAULT_LANGUAGE);

  useEffect(() => {
    const loadLanguage = async () => {
      let saved = null;

      // Try to load saved preference
      if (Platform.OS === 'web') {
        try {
          if (typeof localStorage !== 'undefined') {
            saved = localStorage.getItem('app_language');
          }
        } catch {}
      } else {
        try {
          saved = await AsyncStorage.getItem('app_language');
        } catch {}
      }

      if (saved && translations[saved]) {
        // User has a saved preference — use it
        setLanguage(saved);
      } else {
        // No saved preference — auto-detect from browser/device
        const detected = detectLanguage();
        setLanguage(detected);
        // Save the detected language so we don't re-detect every time
        if (Platform.OS === 'web') {
          try { if (typeof localStorage !== 'undefined') localStorage.setItem('app_language', detected); } catch {}
        } else {
          AsyncStorage.setItem('app_language', detected).catch(() => {});
        }
      }
    };
    loadLanguage();
  }, []);

  const changeLanguage = useCallback((code) => {
    if (!translations[code]) return;
    setLanguage(code);
    if (Platform.OS === 'web') {
      try { if (typeof localStorage !== 'undefined') localStorage.setItem('app_language', code); } catch {}
    } else {
      AsyncStorage.setItem('app_language', code).catch(() => {});
    }
  }, []);

  const t = useCallback((key, params) => {
    let str = translations[language]?.[key] ?? translations[DEFAULT_LANGUAGE]?.[key] ?? key;
    // For arrays (like time.days), return as-is
    if (Array.isArray(str)) return str;
    // Interpolate {param} placeholders
    if (params && typeof str === 'string') {
      Object.keys(params).forEach(k => {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), params[k]);
      });
    }
    return str;
  }, [language]);

  return (
    <LanguageContext.Provider value={{ language, changeLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be inside LanguageProvider');
  return ctx;
}
