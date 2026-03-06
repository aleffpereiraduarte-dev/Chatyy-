import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { translations, DEFAULT_LANGUAGE } from '../i18n';

const LanguageContext = createContext(null);

export function LanguageProvider({ children }) {
  const [language, setLanguage] = useState(DEFAULT_LANGUAGE);

  useEffect(() => {
    if (Platform.OS === 'web') {
      try {
        if (typeof localStorage !== 'undefined') {
          const saved = localStorage.getItem('app_language');
          if (saved && translations[saved]) setLanguage(saved);
        }
      } catch {}
    } else {
      AsyncStorage.getItem('app_language').then(saved => {
        if (saved && translations[saved]) setLanguage(saved);
      }).catch(() => {});
    }
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
