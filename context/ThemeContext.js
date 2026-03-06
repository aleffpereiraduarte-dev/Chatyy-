import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { Platform, useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Colors, DarkColors, FontFamily } from '../constants/theme';

const ThemeContext = createContext(null);

export const DENSITY_CONFIG = {
  compact: { rowMinHeight: 48, paddingV: 6, avatarSize: 28, showPreview: false, fontSize: 13 },
  comfortable: { rowMinHeight: 72, paddingV: 14, avatarSize: 40, showPreview: true, fontSize: 14 },
  spacious: { rowMinHeight: 92, paddingV: 18, avatarSize: 44, showPreview: true, fontSize: 15 },
};

export function ThemeProvider({ children }) {
  const [isDark, setIsDark] = useState(false);
  const [density, setDensityState] = useState('comfortable');
  const [inboxType, setInboxTypeState] = useState('default');
  const systemScheme = useColorScheme();

  // Load saved theme, density, inboxType
  useEffect(() => {
    if (Platform.OS === 'web') {
      try {
        if (typeof localStorage !== 'undefined') {
          const saved = localStorage.getItem('theme_dark');
          if (saved !== null) {
            setIsDark(saved === 'true');
          } else {
            const mq = window.matchMedia('(prefers-color-scheme: dark)');
            setIsDark(mq.matches);
          }
          const savedDensity = localStorage.getItem('density');
          if (savedDensity && DENSITY_CONFIG[savedDensity]) setDensityState(savedDensity);
          const savedInbox = localStorage.getItem('inbox_type');
          if (savedInbox) setInboxTypeState(savedInbox);
        }
      } catch {}
    } else {
      Promise.all([
        AsyncStorage.getItem('theme_dark'),
        AsyncStorage.getItem('density'),
        AsyncStorage.getItem('inbox_type'),
      ]).then(([saved, savedDensity, savedInbox]) => {
        if (saved !== null) setIsDark(saved === 'true');
        else setIsDark(systemScheme === 'dark');
        if (savedDensity && DENSITY_CONFIG[savedDensity]) setDensityState(savedDensity);
        if (savedInbox) setInboxTypeState(savedInbox);
      }).catch(() => {});
    }
  }, []);

  // Inject Inter font + anti-aliasing for web
  useEffect(() => {
    if (Platform.OS === 'web') {
      const link = document.createElement('link');
      link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
      link.rel = 'stylesheet';
      document.head.appendChild(link);

      document.body.style.fontFamily = FontFamily.base;
      document.body.style.webkitFontSmoothing = 'antialiased';
      document.body.style.mozOsxFontSmoothing = 'grayscale';
    }
  }, []);

  const toggle = useCallback(() => {
    setIsDark(prev => {
      const next = !prev;
      if (Platform.OS === 'web') {
        try { if (typeof localStorage !== 'undefined') localStorage.setItem('theme_dark', String(next)); } catch {}
      } else {
        AsyncStorage.setItem('theme_dark', String(next)).catch(() => {});
      }
      return next;
    });
  }, []);

  const setDensity = useCallback((d) => {
    if (!DENSITY_CONFIG[d]) return;
    setDensityState(d);
    if (Platform.OS === 'web') {
      try { if (typeof localStorage !== 'undefined') localStorage.setItem('density', d); } catch {}
    } else {
      AsyncStorage.setItem('density', d).catch(() => {});
    }
  }, []);

  const setInboxType = useCallback((type) => {
    setInboxTypeState(type);
    if (Platform.OS === 'web') {
      try { if (typeof localStorage !== 'undefined') localStorage.setItem('inbox_type', type); } catch {}
    } else {
      AsyncStorage.setItem('inbox_type', type).catch(() => {});
    }
  }, []);

  const colors = isDark ? DarkColors : Colors;
  const densityConfig = DENSITY_CONFIG[density];

  return (
    <ThemeContext.Provider value={{ colors, isDark, toggle, density, setDensity, densityConfig, inboxType, setInboxType }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be inside ThemeProvider');
  return ctx;
}
