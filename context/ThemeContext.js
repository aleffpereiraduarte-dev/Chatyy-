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

// Valid 3-state theme modes. 'system' derives isDark live from the OS
// color scheme; 'light'/'dark' force the value. Persisted under `theme_mode`
// (the key settings.js writes) so the picker's "Sistema" option finally has
// a consumer.
const THEME_MODES = new Set(['light', 'dark', 'system']);

export function ThemeProvider({ children }) {
  const [isDark, setIsDark] = useState(false);
  // 3-state source of truth. Defaults to 'system' so a fresh install follows
  // the OS until the user explicitly forces light/dark. Backward compat: the
  // hydrate effect below maps a legacy `theme_dark` value into a mode when no
  // `theme_mode` key exists yet.
  const [themeMode, setThemeModeState] = useState('system');
  const [density, setDensityState] = useState('comfortable');
  const [inboxType, setInboxTypeState] = useState('default');
  const [accentColor, setAccentColorState] = useState('#7C3AED');
  const systemScheme = useColorScheme();

  // Load saved theme, density, inboxType
  useEffect(() => {
    if (Platform.OS === 'web') {
      try {
        if (typeof localStorage !== 'undefined') {
          const savedMode = localStorage.getItem('theme_mode');
          const saved = localStorage.getItem('theme_dark');
          if (savedMode && THEME_MODES.has(savedMode)) {
            // Explicit 3-state mode wins.
            setThemeModeState(savedMode);
            if (savedMode === 'system') {
              const mq = window.matchMedia('(prefers-color-scheme: dark)');
              setIsDark(mq.matches);
            } else {
              setIsDark(savedMode === 'dark');
            }
          } else if (saved !== null) {
            // Legacy install: only theme_dark exists → map it to a forced mode.
            setThemeModeState(saved === 'true' ? 'dark' : 'light');
            setIsDark(saved === 'true');
          } else {
            // No preference at all → follow system.
            setThemeModeState('system');
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
        AsyncStorage.getItem('theme_mode'),
        AsyncStorage.getItem('theme_dark'),
        AsyncStorage.getItem('density'),
        AsyncStorage.getItem('inbox_type'),
        AsyncStorage.getItem('theme_accent'),
      ]).then(([savedMode, saved, savedDensity, savedInbox, savedAccent]) => {
        if (savedMode && THEME_MODES.has(savedMode)) {
          setThemeModeState(savedMode);
          if (savedMode === 'system') setIsDark(systemScheme === 'dark');
          else setIsDark(savedMode === 'dark');
        } else if (saved !== null) {
          // Legacy install: map the old boolean override to a forced mode.
          setThemeModeState(saved === 'true' ? 'dark' : 'light');
          setIsDark(saved === 'true');
        } else {
          setThemeModeState('system');
          setIsDark(systemScheme === 'dark');
        }
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

  // Watch system color scheme changes. Only drives isDark when the active mode
  // is 'system' (or, for legacy web installs, when no explicit pref is saved).
  useEffect(() => {
    if (themeMode !== 'system') return;
    if (Platform.OS === 'web') {
      try {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        // Apply current value immediately so a mode switch to 'system' picks
        // up the OS scheme without waiting for the next change event.
        setIsDark(mq.matches);
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
      // Native: useColorScheme() re-runs this effect on every OS scheme flip.
      if (systemScheme) setIsDark(systemScheme === 'dark');
    }
  }, [systemScheme, themeMode]);

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

  const _persistMode = useCallback((mode) => {
    if (Platform.OS === 'web') {
      try { if (typeof localStorage !== 'undefined') localStorage.setItem('theme_mode', mode); } catch {}
    } else {
      AsyncStorage.setItem('theme_mode', mode).catch(() => {});
    }
  }, []);

  // Drive the 3-state mode. 'light'/'dark' force isDark and persist a
  // matching theme_dark override for backward compat; 'system' clears the
  // manual override so the useColorScheme() watcher above takes over.
  // Exposed so settings.js can call setThemeMode('system'|'light'|'dark').
  const setThemeMode = useCallback((mode) => {
    if (!THEME_MODES.has(mode)) return;
    setThemeModeState(mode);
    _persistMode(mode);
    if (mode === 'system') {
      // No manual override — let the system scheme decide. Drop the legacy
      // theme_dark key so old-style consumers can't re-pin a stale value.
      if (Platform.OS === 'web') {
        try { if (typeof localStorage !== 'undefined') localStorage.removeItem('theme_dark'); } catch {}
      } else {
        AsyncStorage.removeItem('theme_dark').catch(() => {});
      }
      setIsDark(systemScheme === 'dark');
    } else {
      const next = mode === 'dark';
      setIsDark(next);
      _persistDark(next);
    }
    if (!_suppressBroadcast.current) _broadcastSetting('theme', mode === 'system' ? 'system' : (mode === 'dark' ? 'dark' : 'light'));
  }, [_persistMode, _persistDark, systemScheme]);

  // Legacy boolean toggle — now expressed in terms of the 3-state mode so the
  // two never drift. Toggling always lands on a FORCED light/dark (never
  // 'system'), matching the prior behavior where toggle pinned theme_dark.
  const toggle = useCallback(() => {
    setIsDark(prev => {
      const next = !prev;
      const mode = next ? 'dark' : 'light';
      setThemeModeState(mode);
      _persistMode(mode);
      _persistDark(next);
      if (!_suppressBroadcast.current) _broadcastSetting('theme', mode);
      return next;
    });
  }, [_persistDark, _persistMode]);

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
              if (value === 'system') {
                // Mirror a remote switch to "Sistema" — clear the override and
                // follow this device's OS scheme.
                setThemeModeState('system');
                _persistMode('system');
                if (Platform.OS === 'web') {
                  try { if (typeof localStorage !== 'undefined') localStorage.removeItem('theme_dark'); } catch {}
                } else {
                  AsyncStorage.removeItem('theme_dark').catch(() => {});
                }
                setIsDark(systemScheme === 'dark');
              } else {
                const next = value === 'dark' || value === true || value === 'true';
                setThemeModeState(next ? 'dark' : 'light');
                _persistMode(next ? 'dark' : 'light');
                setIsDark(next);
                _persistDark(next);
              }
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
  }, [_persistDark, _persistMode, systemScheme]);

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
    colors, isDark, toggle, themeMode, setThemeMode,
    density, setDensity, densityConfig, inboxType, setInboxType,
    accentColor, setAccentColor,
  }), [colors, isDark, toggle, themeMode, setThemeMode, density, setDensity, densityConfig, inboxType, setInboxType, accentColor, setAccentColor]);

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
