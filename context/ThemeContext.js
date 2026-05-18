import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Platform, useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Colors, DarkColors, FontFamily } from '../constants/theme';

const ThemeContext = createContext(null);

// Per-provider device id used as the `origin` envelope on outgoing
// user_setting_update frames. Receiving listener compares against this
// to ignore its own echo and prevent broadcast loops. Random per app
// session is fine — we only need uniqueness within the same-email fanout.
const THEME_DEVICE_ID = `t_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;

// Fan an updated setting out to other devices on the same account via WS.
// Fire-and-forget; if WS is offline the local change still persists in
// AsyncStorage/localStorage and the other devices simply won't get the
// nudge until they reconnect (and read the value back from the server
// next time settings are surfaced — out of scope for this hook).
function _broadcastSetting(key, value) {
  try {
    const mod = require('../services/websocket');
    const ws = mod?.default;
    if (ws && typeof ws.send === 'function' && ws.isConnected) {
      ws.send({ type: 'user_setting_update', key, value, origin: THEME_DEVICE_ID });
    }
  } catch {}
}

export const DENSITY_CONFIG = {
  compact: { rowMinHeight: 48, paddingV: 6, avatarSize: 28, showPreview: false, fontSize: 13 },
  // Wave 5 polish 2026-05-08: avatar default bumpado 40→46 pra alinhar com
  // ChatList (50). Antes parecia que email row era de outro app por ter
  // avatares menores. Spacious 44→50 = paridade total.
  comfortable: { rowMinHeight: 76, paddingV: 14, avatarSize: 46, showPreview: true, fontSize: 14 },
  spacious: { rowMinHeight: 96, paddingV: 18, avatarSize: 50, showPreview: true, fontSize: 15 },
};

export const ACCENT_PRESETS = [
  { key: 'purple', hex: '#7C3AED' },
  { key: 'blue',   hex: '#3B82F6' },
  { key: 'green',  hex: '#10B981' },
  { key: 'orange', hex: '#F59E0B' },
  { key: 'pink',   hex: '#EC4899' },
];
const ACCENT_HEX_SET = new Set(ACCENT_PRESETS.map(p => p.hex));

export function ThemeProvider({ children }) {
  const [isDark, setIsDark] = useState(false);
  const [density, setDensityState] = useState('comfortable');
  const [inboxType, setInboxTypeState] = useState('default');
  const [accentColor, setAccentColorState] = useState('#7C3AED');
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
          const savedAccent = localStorage.getItem('theme_accent');
          if (savedAccent && ACCENT_HEX_SET.has(savedAccent)) setAccentColorState(savedAccent);
        }
      } catch {}
    } else {
      Promise.all([
        AsyncStorage.getItem('theme_dark'),
        AsyncStorage.getItem('density'),
        AsyncStorage.getItem('inbox_type'),
        AsyncStorage.getItem('theme_accent'),
      ]).then(([saved, savedDensity, savedInbox, savedAccent]) => {
        if (saved !== null) setIsDark(saved === 'true');
        else setIsDark(systemScheme === 'dark');
        if (savedDensity && DENSITY_CONFIG[savedDensity]) setDensityState(savedDensity);
        if (savedInbox) setInboxTypeState(savedInbox);
        if (savedAccent && ACCENT_HEX_SET.has(savedAccent)) setAccentColorState(savedAccent);
      }).catch(() => {});
      try {
        const { getString } = require('../services/mmkv');
        const mmkvAccent = getString?.('theme_accent');
        if (mmkvAccent && ACCENT_HEX_SET.has(mmkvAccent)) setAccentColorState(mmkvAccent);
      } catch {}
    }
  }, []);

  // Watch system color scheme changes and update if no user preference saved
  useEffect(() => {
    if (Platform.OS === 'web') {
      try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem('theme_dark') !== null) return;
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const handler = (e) => setIsDark(e.matches);
        // Safari <14 só tem addListener/removeListener — usar fallback
        // pra evitar TypeError no boot do app em iOS antigo.
        if (mq.addEventListener) mq.addEventListener('change', handler);
        else if (mq.addListener) mq.addListener(handler);
        return () => {
          if (mq.removeEventListener) mq.removeEventListener('change', handler);
          else if (mq.removeListener) mq.removeListener(handler);
        };
      } catch {}
    } else {
      // Native: if no saved preference, follow system scheme
      AsyncStorage.getItem('theme_dark').then((saved) => {
        if (saved === null && systemScheme) {
          setIsDark(systemScheme === 'dark');
        }
      }).catch(() => {});
    }
  }, [systemScheme]);

  // Inject Inter font + anti-aliasing for web
  useEffect(() => {
    if (Platform.OS === 'web') {
      const link = document.createElement('link');
      link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
      link.rel = 'stylesheet';
      document.head.appendChild(link);

      document.body.style.fontFamily = FontFamily.base;
      // Camel-case do CSSStyleDeclaration prefixa o vendor com maiúscula
      // (WebkitFontSmoothing, MozOsxFontSmoothing) — antes ficava no-op.
      document.body.style.WebkitFontSmoothing = 'antialiased';
      document.body.style.MozOsxFontSmoothing = 'grayscale';
    }
  }, []);

  // When applying a remote setting received over WS, we MUST suppress the
  // outbound broadcast — otherwise device A's change pings device B, B
  // applies and re-broadcasts back to A, A re-broadcasts to B… loop.
  // Refs (not state) so the gate stays synchronous within a single tick.
  const _suppressBroadcast = useRef(false);

  const _persistDark = useCallback((next) => {
    if (Platform.OS === 'web') {
      try { if (typeof localStorage !== 'undefined') localStorage.setItem('theme_dark', String(next)); } catch {}
    } else {
      AsyncStorage.setItem('theme_dark', String(next)).catch(() => {});
    }
  }, []);

  const toggle = useCallback(() => {
    setIsDark(prev => {
      const next = !prev;
      _persistDark(next);
      if (!_suppressBroadcast.current) _broadcastSetting('theme', next ? 'dark' : 'light');
      return next;
    });
  }, [_persistDark]);

  const setDensity = useCallback((d) => {
    if (!DENSITY_CONFIG[d]) return;
    setDensityState(d);
    if (Platform.OS === 'web') {
      try { if (typeof localStorage !== 'undefined') localStorage.setItem('density', d); } catch {}
    } else {
      AsyncStorage.setItem('density', d).catch(() => {});
    }
    if (!_suppressBroadcast.current) _broadcastSetting('density', d);
  }, []);

  const setInboxType = useCallback((type) => {
    setInboxTypeState(type);
    if (Platform.OS === 'web') {
      try { if (typeof localStorage !== 'undefined') localStorage.setItem('inbox_type', type); } catch {}
    } else {
      AsyncStorage.setItem('inbox_type', type).catch(() => {});
    }
    if (!_suppressBroadcast.current) _broadcastSetting('inbox_type', type);
  }, []);

  const setAccentColor = useCallback((hex) => {
    if (!hex || !ACCENT_HEX_SET.has(hex)) return;
    setAccentColorState(hex);
    if (Platform.OS === 'web') {
      try { if (typeof localStorage !== 'undefined') localStorage.setItem('theme_accent', hex); } catch {}
    } else {
      AsyncStorage.setItem('theme_accent', hex).catch(() => {});
      try {
        const { setString } = require('../services/mmkv');
        setString?.('theme_accent', hex);
      } catch {}
    }
    if (!_suppressBroadcast.current) _broadcastSetting('theme_accent', hex);
  }, []);

  // Subscribe to incoming user_setting_update frames from the WS relay so
  // a change on web shows up on mobile (and vice-versa) without a relaunch.
  // The `origin` envelope is matched against this provider's device id —
  // if it's our own echo, ignore. Otherwise apply locally with the
  // _suppressBroadcast gate raised so the apply doesn't fire a new outbound
  // frame (which would otherwise loop forever between the two devices).
  useEffect(() => {
    let off = null;
    try {
      const ws = require('../services/websocket').default;
      if (!ws || typeof ws.on !== 'function') return;
      off = ws.on('user_setting_update', (frame) => {
        try {
          if (!frame || frame.origin === THEME_DEVICE_ID) return;
          const { key, value } = frame;
          _suppressBroadcast.current = true;
          try {
            if (key === 'theme') {
              const next = value === 'dark' || value === true || value === 'true';
              setIsDark(next);
              _persistDark(next);
            } else if (key === 'density' && DENSITY_CONFIG[value]) {
              setDensityState(value);
              if (Platform.OS === 'web') {
                try { if (typeof localStorage !== 'undefined') localStorage.setItem('density', value); } catch {}
              } else {
                AsyncStorage.setItem('density', value).catch(() => {});
              }
            } else if (key === 'inbox_type' && typeof value === 'string') {
              setInboxTypeState(value);
              if (Platform.OS === 'web') {
                try { if (typeof localStorage !== 'undefined') localStorage.setItem('inbox_type', value); } catch {}
              } else {
                AsyncStorage.setItem('inbox_type', value).catch(() => {});
              }
            } else if (key === 'theme_accent' && typeof value === 'string' && ACCENT_HEX_SET.has(value)) {
              setAccentColorState(value);
              if (Platform.OS === 'web') {
                try { if (typeof localStorage !== 'undefined') localStorage.setItem('theme_accent', value); } catch {}
              } else {
                AsyncStorage.setItem('theme_accent', value).catch(() => {});
                try {
                  const { setString } = require('../services/mmkv');
                  setString?.('theme_accent', value);
                } catch {}
              }
            }
          } finally {
            _suppressBroadcast.current = false;
          }
        } catch {}
      });
    } catch {}
    return () => { try { off && off(); } catch {} };
  }, [_persistDark]);

  // Override primary-related keys with the user-picked accent so all surfaces
  // (FABs, links, badges) re-tint live without touching every consumer.
  const baseColors = isDark ? DarkColors : Colors;
  const colors = useMemo(() => ({
    ...baseColors,
    primary: accentColor,
    chatPrimary: accentColor,
  }), [baseColors, accentColor]);
  const densityConfig = DENSITY_CONFIG[density];

  // Memoize context value to prevent re-renders in all consumers when an
  // unrelated state update fires inside ThemeProvider.
  const contextValue = useMemo(() => ({
    colors, isDark, toggle, density, setDensity, densityConfig, inboxType, setInboxType,
    accentColor, setAccentColor,
  }), [colors, isDark, toggle, density, setDensity, densityConfig, inboxType, setInboxType, accentColor, setAccentColor]);

  return (
    <ThemeContext.Provider value={contextValue}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be inside ThemeProvider');
  return ctx;
}
