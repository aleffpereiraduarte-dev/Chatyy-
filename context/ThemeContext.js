import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Platform, useColorScheme, InteractionManager, Appearance, AppState, DeviceEventEmitter, Animated, Easing, Image, StyleSheet } from 'react-native';
import { isReduceMotionEnabled } from '../components/reducedMotion'; // [2026-10-15 nav-motion]
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

// DENSIDADE 2026 (nível Gmail web): o default `comfortable` ficou bem mais
// enxuto (linhas ~60px, menos padding vertical, avatar 40) pra caber MAIS
// e-mails por tela sem perder o preview/snippet. Quem quiser mais respiro
// escolhe `spacious` nas configurações; quem quiser ainda mais denso, `compact`.
export const DENSITY_CONFIG = {
  compact: { rowMinHeight: 42, paddingV: 4, avatarSize: 28, showPreview: false, fontSize: 13 },
  comfortable: { rowMinHeight: 54, paddingV: 7, avatarSize: 38, showPreview: true, fontSize: 14 },
  spacious: { rowMinHeight: 76, paddingV: 12, avatarSize: 44, showPreview: true, fontSize: 15 },
};

// NEUTRAL 2026: default accent is the sober WhatsApp-style action green (was
// purple #A582F7). The first preset — historically 'purple' — now carries the
// action green so the default swatch and the base palette agree. Key names are
// kept so the settings picker + i18n labels still resolve; only hexes changed
// off violet. This accent overrides `primary`/`chatPrimary` in `colors` below,
// so it MUST match constants/theme.js `primary` (light #111111) — otherwise the
// override would re-introduce a different hue.
export const ACCENT_PRESETS = [
  { key: 'green',  hex: '#111111' },
  { key: 'teal',   hex: '#111111' },
  { key: 'blue',   hex: '#3B82F6' },
  { key: 'orange', hex: '#F59E0B' },
  { key: 'slate',  hex: '#64748B' },
];

// ── [2026-10-19 accent-real] COR DO DESTAQUE de verdade ─────────────────────
// Antes: o seletor gravava `theme_accent`, mas só `primary/chatPrimary` eram
// trocados — barra de abas, switches, botão enviar, ✓✓ lido, badges e chips
// usam tinta P&B fixa ou tokens (badge/chipActiveBg/unreadAccent) que nunca
// eram tocados → "não faz nada". Agora:
//   • Paleta curada (11 cores com nome, tom próprio p/ claro e p/ escuro) +
//     "Personalizada" (qualquer #RRGGBB; no escuro clareia se ficar escura demais).
//   • Grafite (padrão) = o P&B premium de sempre (nada muda para quem não escolhe).
//   • `colors` ganha accent/onAccent/accentSoft/accentOn e as superfícies de AÇÃO
//     (primary, badge, chips ativos, checkbox, foco, links, ✓✓ lido) passam a usar
//     o destaque. Fundo/texto/bolhas continuam neutros.
//   • Persistido POR CONTA (theme_accent@<conta>) + espelho global (conta nova
//     herda o último), sincronizado ao vivo entre aparelhos via WS (user_setting_update).
// Valor gravado: chave da paleta ('blue') ou hex ('#12AB34' = personalizada).
export const ACCENT_PALETTE = [
  { key: 'graphite', light: '#111111', dark: null,      i18n: 'settings.accent.graphite', fb: 'Grafite' },
  { key: 'blue',     light: '#0A6CFF', dark: '#3D8BFF', i18n: 'settings.accent.blue',     fb: 'Azul' },
  { key: 'indigo',   light: '#4F46E5', dark: '#7C83FF', i18n: 'settings.accent.indigo',   fb: 'Índigo' },
  { key: 'purple',   light: '#8B3FD9', dark: '#B67CF5', i18n: 'settings.accent.purple',   fb: 'Roxo' },
  { key: 'pink',     light: '#DB2E72', dark: '#FF6FA3', i18n: 'settings.accent.pink',     fb: 'Rosa' },
  { key: 'red',      light: '#DC2F35', dark: '#FF6266', i18n: 'settings.accent.red',      fb: 'Vermelho' },
  { key: 'orange',   light: '#E35D0E', dark: '#FF8A3D', i18n: 'settings.accent.orange',   fb: 'Laranja' },
  { key: 'amber',    light: '#B87300', dark: '#FFB224', i18n: 'settings.accent.amber',    fb: 'Âmbar' },
  { key: 'green',    light: '#15803D', dark: '#3DD178', i18n: 'settings.accent.green',    fb: 'Verde' },
  { key: 'mint',     light: '#0B9488', dark: '#3FD9C6', i18n: 'settings.accent.mint',     fb: 'Menta' },
  { key: 'petrol',   light: '#0E5A6B', dark: '#4BA3B8', i18n: 'settings.accent.petrol',   fb: 'Petróleo' },
];
const _PALETTE_BY_KEY = Object.fromEntries(ACCENT_PALETTE.map(p => [p.key, p]));
const _HEX6 = /^#[0-9a-f]{6}$/i;
// Hex antigos (seletor de 5 bolinhas) → chave nova.
const _LEGACY_HEX = { '#111111': 'graphite', '#3B82F6': 'blue', '#F59E0B': 'amber' };

/** Normaliza o valor gravado: chave da paleta ou '#RRGGBB'. Inválido → 'graphite'. */
export function normalizeAccent(v) {
  const s = String(v || '').trim();
  if (_PALETTE_BY_KEY[s]) return s;
  if (_HEX6.test(s)) {
    const up = s.toUpperCase();
    return _LEGACY_HEX[up] || up;
  }
  return 'graphite';
}
function _isValidAccentValue(v) {
  const s = String(v || '').trim();
  return !!_PALETTE_BY_KEY[s] || _HEX6.test(s);
}

function _rgb(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function _hex(r, g, b) {
  const c = (x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
  return ('#' + c(r) + c(g) + c(b)).toUpperCase();
}
/** Luminância relativa WCAG (0–1). */
export function luminance(hex) {
  if (!_HEX6.test(String(hex || ''))) return 0;
  const f = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
  const [r, g, b] = _rgb(hex);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function _mix(hex, withHex, t) {
  const a = _rgb(hex); const b = _rgb(withHex);
  return _hex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
}
/** Texto/ícone sobre o destaque: branco, ou tinta escura quando o destaque é claro. */
export function onAccentFor(hex) {
  return luminance(hex) > 0.3 ? '#111111' : '#FFFFFF'; // ~ponto de contraste igual (branco x tinta)
}
/** Resolve a cor de destaque p/ o modo atual. null = Grafite (P&B do tema). */
export function resolveAccent(value, isDark) {
  const v = normalizeAccent(value);
  const p = _PALETTE_BY_KEY[v];
  if (p) return isDark ? p.dark : (p.key === 'graphite' ? null : p.light);
  // personalizada
  let hex = v;
  const L = luminance(hex);
  if (L < 0.012) return null; // praticamente preto = Grafite
  if (isDark && L < 0.16) hex = _mix(hex, '#FFFFFF', Math.min(0.55, (0.16 - L) * 3.2 + 0.18));
  if (!isDark && L > 0.62) hex = _mix(hex, '#000000', Math.min(0.5, (L - 0.62) * 1.4 + 0.12));
  return hex;
}
/** Rótulo (i18n) da cor gravada. */
export function accentLabel(value, t) {
  const v = normalizeAccent(value);
  const p = _PALETTE_BY_KEY[v];
  const tx = (k, fb) => { try { const r = t ? t(k) : null; return r && r !== k ? r : fb; } catch { return fb; } };
  return p ? tx(p.i18n, p.fb) : tx('settings.accent.custom', 'Personalizada');
}

// Fora do React (lista nativa, helpers de módulo): última cor resolvida.
let _accentSnap = { value: 'graphite', hex: null, on: false, onAccent: '#FFFFFF', isDark: false };
export function getAccentSnapshot() { return _accentSnap; }

function _acctKey() {
  try {
    const a = String(require('../services/api').getActiveAccountEmail?.() || '').trim().toLowerCase();
    return a ? 'theme_accent@' + a : '';
  } catch { return ''; }
}
function _readKey(k) {
  if (!k) return null;
  try {
    if (Platform.OS === 'web') return typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null;
    const { getString } = require('../services/mmkv');
    return getString ? getString(k) : null;
  } catch { return null; }
}
function _writeKey(k, v) {
  if (!k) return;
  try {
    if (Platform.OS === 'web') { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); return; }
    const { setString } = require('../services/mmkv');
    setString && setString(k, v);
  } catch {}
}
/** Valor salvo (conta ativa > global). acct=true quando veio da conta. */
function _readAccentSync() {
  const a = _readKey(_acctKey());
  if (a && _isValidAccentValue(a)) return { value: normalizeAccent(a), acct: true };
  const g = _readKey('theme_accent');
  if (g && _isValidAccentValue(g)) return { value: normalizeAccent(g), acct: false };
  return { value: 'graphite', acct: false };
}

// Valid 3-state theme modes. 'system' derives isDark live from the OS
// color scheme; 'light'/'dark' force the value. Persisted under `theme_mode`
// (the key settings.js writes) so the picker's "Sistema" option finally has
// a consumer.
const THEME_MODES = new Set(['light', 'dark', 'system']);

// Near-black hex (#000000–#2f2f2f): the default ink accent. Used to keep the
// dark palette's inverted (white) primary — see ThemeProvider + useAuthTheme.
const _NEAR_BLACK = /^#(0[0-9a-f]|1[0-9a-f]|2[0-9a-f])(0[0-9a-f]|1[0-9a-f]|2[0-9a-f])(0[0-9a-f]|1[0-9a-f]|2[0-9a-f])$/i;

// [2026-10-13 piscada] iOS tira o snapshot do app switcher nos DOIS esquemas
// (claro e escuro) ao ir pro fundo → o RN emite appearanceChanged light↔dark e o
// useColorScheme() repinta a árvore inteira (fundo do Stack, headers nativos,
// cores) — ao voltar, a tela "pisca" com o tema errado. Aqui ignoramos mudanças
// fora do 'active' e reconferimos o esquema real logo depois de voltar.
// Web: segue o useColorScheme normal.
function _readScheme() {
  try { return Appearance.getColorScheme() || null; } catch { return null; }
}
export function useStableColorScheme() {
  const live = useColorScheme();
  const [stable, setStable] = useState(_readScheme);
  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    let t = null;
    const apply = (cs) => { if (cs === 'light' || cs === 'dark') setStable((p) => (p === cs ? p : cs)); };
    let subA = null;
    let subS = null;
    try {
      subA = Appearance.addChangeListener(({ colorScheme }) => {
        if (AppState.currentState !== 'active') return;
        apply(colorScheme);
      });
    } catch {}
    try {
      subS = AppState.addEventListener('change', (st) => {
        if (t) { clearTimeout(t); t = null; }
        // Pequena espera: o evento de "volta ao esquema real" pode chegar logo
        // após o 'active'; uma troca genuína feita no fundo aplica-se aqui.
        if (st === 'active') t = setTimeout(() => { t = null; apply(_readScheme()); }, 300);
      });
    } catch {}
    return () => {
      if (t) clearTimeout(t);
      try { subA && subA.remove && subA.remove(); } catch {}
      try { subS && subS.remove && subS.remove(); } catch {}
    };
  }, []);
  return Platform.OS === 'web' ? live : (stable || live);
}

// [2026-10-14 piscada-android] Ponte com o RootLayout (app/_layout.js), que fica
// ACIMA deste provider e pinta o fundo do navegador/raiz:
//  - primeThemeMode(): o RootLayout já lê `theme_mode` do storage enquanto o gate
//    de cache segura o 1º frame; semeando aqui, o provider nasce no modo salvo
//    (antes: nascia 'system' e só aplicava o modo forçado após InteractionManager
//    → claro→escuro (ou vice-versa) já com a lista na tela = piscada no boot).
//  - APP_THEME_DARK_EVENT: trocar o tema em Ajustes atualiza o fundo do stack na
//    hora (antes o RootLayout só relia o storage quando o tema do SO mudava →
//    transições pintavam a cor do tema ANTERIOR até reiniciar o app).
export const APP_THEME_DARK_EVENT = 'chatyy:appThemeDark';
let _primedThemeMode = null;
export function primeThemeMode(mode) {
  if (THEME_MODES.has(mode)) _primedThemeMode = mode;
}

// [vanish 2026-10-19] montagem das cores extraída (pura) p/ o ForceDarkTheme reusar.
function _composeThemeColors(baseColors, accentHex, isDark, _hc) {
  let c = baseColors;
  const ink = c.primary;
  if (accentHex) {
    const on = onAccentFor(accentHex);
    const [r, g, b] = _rgb(accentHex);
    c = {
      ...c,
      primary: accentHex, chatPrimary: accentHex, primaryDark: accentHex,
      onPrimary: on, textOnPrimary: on,
      badge: accentHex, onBadge: on, unreadAccent: accentHex,
      chipActiveBg: accentHex, chipActiveText: on,
      selectedCheckbox: accentHex, focusBorder: accentHex,
      composeBg: accentHex, composeText: on,
      accentSoft: `rgba(${r},${g},${b},${isDark ? 0.22 : 0.12})`,
    };
  } else {
    c = { ...c, accentSoft: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(17,17,17,0.07)' };
  }
  c.accent = accentHex || ink;
  c.onAccent = accentHex ? onAccentFor(accentHex) : c.onPrimary;
  c.accentOn = !!accentHex;
  // ✓✓ lido: destaque quando há cor; Grafite mantém o azul clássico.
  c.tickRead = accentHex || '#53BDEB';
  if (_hc) {
    c = {
      ...c,
      textSecondary: isDark ? '#D1D1D6' : '#3A3A3F',
      textTertiary: isDark ? '#AEAEB2' : '#55555B',
      chipText: isDark ? '#D1D1D6' : '#3A3A3F',
      border: isDark ? '#545458' : '#B8B8BE',
      borderLight: isDark ? '#3A3A3C' : '#D1D1D6',
      divider: isDark ? '#48484A' : '#C6C6C8',
      headerBorder: isDark ? '#48484A' : '#C6C6C8',
      starEmpty: isDark ? '#8E8E93' : '#8E8E93',
      highContrast: true,
    };
  }
  return c;
}

export function ThemeProvider({ children }) {
  // Nativo: semeia do SO já no 1º frame (antes: false → 1 frame claro no escuro).
  const [systemIsDark, setSystemIsDark] = useState(() => Platform.OS !== 'web' && _readScheme() === 'dark');
  // 3-state source of truth. Defaults to 'system' so a fresh install follows
  // the OS until the user explicitly forces light/dark. Backward compat: the
  // hydrate effect below maps a legacy `theme_dark` value into a mode when no
  // `theme_mode` key exists yet.
  const [themeMode, setThemeModeState] = useState(() => _primedThemeMode || 'system');
  // Só emite APP_THEME_DARK_EVENT depois de hidratar (o valor inicial pode ser o
  // default 'system' e sobrescreveria o que o RootLayout já resolveu do storage).
  const _hydratedRef = useRef(Platform.OS === 'web');
  const [density, setDensityState] = useState('comfortable');
  const [inboxType, setInboxTypeState] = useState('default');
  const [accentValue, setAccentValueState] = useState(() => _readAccentSync().value); // [2026-10-19 accent-real] chave da paleta ou #hex
  const _acctAccentRef = useRef(_readAccentSync().acct); // achou valor DA CONTA → hidrate global não sobrescreve
  const _accentAcctRef = useRef(_acctKey());
  const [a11y, setA11yState] = useState(() => { try { return require('../services/a11yPrefs').getA11y(); } catch { return null; } });
  useEffect(() => {
    try { return require('../services/a11yPrefs').subscribeA11y(setA11yState); } catch { return undefined; }
  }, []);
  const systemScheme = useStableColorScheme();

  // Load saved theme, density, inboxType
  useEffect(() => {
    if (Platform.OS === 'web') {
      try {
        if (typeof localStorage !== 'undefined') {
          const savedMode = localStorage.getItem('theme_mode');
          const saved = localStorage.getItem('theme_dark');
          // Seed systemIsDark from the OS so 'system' mode is correct on first
          // paint. isDark itself is DERIVED from themeMode + systemIsDark (see
          // below) — we never set it directly here, which is what used to race
          // with the systemScheme watcher and leave forced-dark rendering light.
          try {
            const mq = window.matchMedia('(prefers-color-scheme: dark)');
            setSystemIsDark(mq.matches);
          } catch {}
          if (savedMode && THEME_MODES.has(savedMode)) {
            // Explicit 3-state mode wins.
            setThemeModeState(savedMode);
          } else if (saved !== null) {
            // Legacy install: only theme_dark exists → map it to a forced mode.
            setThemeModeState(saved === 'true' ? 'dark' : 'light');
          } else {
            // No preference at all → follow system.
            setThemeModeState('system');
          }
          const savedDensity = localStorage.getItem('density');
          if (savedDensity && DENSITY_CONFIG[savedDensity]) setDensityState(savedDensity);
          const savedInbox = localStorage.getItem('inbox_type');
          if (savedInbox) setInboxTypeState(savedInbox);
          const _ra = _readAccentSync(); // [2026-10-19 accent-real] conta > global
          setAccentValueState(_ra.value);
          _acctAccentRef.current = _ra.acct;
        }
      } catch {}
    } else {
      // [COLD-START 2026-09-30] These ~5 AsyncStorage reads hit the native
      // bridge at mount and compete with AuthContext for it during the cold
      // start. First paint already uses the in-memory DEFAULT theme (isDark
      // starts false / themeMode 'system'), so the persisted values are pure
      // hydration — nothing renders waiting on them. Defer them behind
      // InteractionManager so auth/routing get the bridge first; the stored
      // theme then applies a beat later (masked by the branded splash overlay,
      // so no visible flash). Persistence on CHANGE is untouched (setThemeMode
      // et al. still write synchronously). The handle is cancelled on unmount.
      const task = InteractionManager.runAfterInteractions(() => {
        Promise.all([
          AsyncStorage.getItem('theme_mode'),
          AsyncStorage.getItem('theme_dark'),
          AsyncStorage.getItem('density'),
          AsyncStorage.getItem('inbox_type'),
          AsyncStorage.getItem('theme_accent'),
        ]).then(([savedMode, saved, savedDensity, savedInbox, savedAccent]) => {
          if (systemScheme) setSystemIsDark(systemScheme === 'dark');
          if (savedMode && THEME_MODES.has(savedMode)) {
            setThemeModeState(savedMode);
          } else if (saved !== null) {
            // Legacy install: map the old boolean override to a forced mode.
            setThemeModeState(saved === 'true' ? 'dark' : 'light');
          } else {
            setThemeModeState('system');
          }
          if (savedDensity && DENSITY_CONFIG[savedDensity]) setDensityState(savedDensity);
          if (savedInbox) setInboxTypeState(savedInbox);
          if (!_acctAccentRef.current && savedAccent && _isValidAccentValue(savedAccent)) setAccentValueState(normalizeAccent(savedAccent));
          _hydratedRef.current = true;
        }).catch(() => {});
        try {
          const _ra = _readAccentSync(); // [2026-10-19 accent-real] conta > global (mmkv síncrono)
          if (_ra.acct || _ra.value !== 'graphite') { setAccentValueState(_ra.value); _acctAccentRef.current = _ra.acct; }
        } catch {}
      });
      return () => { try { task && task.cancel && task.cancel(); } catch {} };
    }
  }, []);

  // Watch system color scheme changes. Only drives isDark when the active mode
  // is 'system' (or, for legacy web installs, when no explicit pref is saved).
  // Track the OS color scheme into `systemIsDark`. isDark is DERIVED from
  // themeMode + systemIsDark, so this only changes rendering when the active
  // mode is 'system'. Tracking it unconditionally (instead of gating on
  // themeMode and calling setIsDark) removes the first-mount race where this
  // watcher clobbered a freshly-hydrated forced-dark value back to light.
  useEffect(() => {
    if (Platform.OS === 'web') {
      try {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        setSystemIsDark(mq.matches);
        const handler = (e) => setSystemIsDark(e.matches);
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
      if (systemScheme) setSystemIsDark(systemScheme === 'dark');
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

  const _persistMode = useCallback((mode) => {
    if (Platform.OS === 'web') {
      try { if (typeof localStorage !== 'undefined') localStorage.setItem('theme_mode', mode); } catch {}
    } else {
      AsyncStorage.setItem('theme_mode', mode).catch(() => {});
    }
  }, []);

  // ── [2026-10-15 nav-motion] Troca de tema ANIMADA (Telegram) ─────────────
  // Antes: a troca claro↔escuro era um corte seco (todas as telas repintam no
  // mesmo frame, às vezes com 1-2 frames de re-render pesado visíveis). Agora:
  // snapshot da tela (react-native-view-shot, já no binário) → overlay com a
  // imagem por cima → aplica o tema por baixo → fade 1→0 nativo. O re-render
  // pesado fica escondido sob o snapshot. Web, Reduce Motion, binário sem
  // view-shot ou kill switch `globalThis.__chatyy_theme_fade = false` → corte
  // seco como antes. Só nas trocas feitas pelo usuário (setThemeMode/toggle);
  // mudança do sistema/sync remoto continua direta.
  const _isDarkRef = useRef(false);
  const _sysDarkRef = useRef(false);
  const [_snap, _setSnap] = useState(null); // { uri, apply }
  const _snapAnim = useRef(new Animated.Value(0)).current;
  const _snapBusy = useRef(false);
  const _snapShotMod = useRef(null);
  const _snapEnd = useCallback((uri) => {
    _snapBusy.current = false;
    _setSnap(null);
    if (uri) { try { _snapShotMod.current?.releaseCapture?.(uri); } catch {} }
  }, []);
  const _runThemeFade = useCallback((nextDark, apply) => {
    let shot = null;
    try {
      if (Platform.OS !== 'web' && nextDark !== _isDarkRef.current && !_snapBusy.current
        && globalThis.__chatyy_theme_fade !== false && !isReduceMotionEnabled()) {
        shot = require('react-native-view-shot');
      }
    } catch { shot = null; }
    if (!shot || typeof shot.captureScreen !== 'function') { apply(); return; }
    _snapShotMod.current = shot;
    _snapBusy.current = true;
    let done = false;
    const giveUp = () => { if (done) return; done = true; _snapBusy.current = false; apply(); };
    const tm = setTimeout(giveUp, 280); // captura lenta → troca seca (nunca atrasa o toque)
    let p;
    try { p = shot.captureScreen({ format: 'jpg', quality: 0.9, result: 'tmpfile' }); } catch { clearTimeout(tm); giveUp(); return; }
    Promise.resolve(p).then((uri) => {
      if (done) { try { uri && shot.releaseCapture?.(uri); } catch {} return; }
      done = true; clearTimeout(tm);
      if (!uri) { _snapBusy.current = false; apply(); return; }
      _snapAnim.setValue(1);
      _setSnap({ uri, apply });
    }).catch(() => { clearTimeout(tm); giveUp(); });
  }, [_snapAnim]);
  // Snapshot pintado → aplica o tema por baixo → 2 frames p/ o re-render
  // assentar → fade nativo. Guarda: se o onLoad não vier, aplica mesmo assim.
  const _snapApplied = useRef(null);
  const _onSnapReady = useCallback(() => {
    const cur = _snap;
    if (!cur || _snapApplied.current === cur.uri) return;
    _snapApplied.current = cur.uri;
    requestAnimationFrame(() => {
      try { cur.apply(); } catch {}
      requestAnimationFrame(() => requestAnimationFrame(() => {
        Animated.timing(_snapAnim, { toValue: 0, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true })
          .start(() => _snapEnd(cur.uri));
      }));
    });
  }, [_snap, _snapAnim, _snapEnd]);
  useEffect(() => {
    if (!_snap) return undefined;
    const t = setTimeout(_onSnapReady, 350);
    return () => clearTimeout(t);
  }, [_snap, _onSnapReady]);

  // Drive the 3-state mode. 'light'/'dark' force isDark and persist a
  // matching theme_dark override for backward compat; 'system' clears the
  // manual override so the useColorScheme() watcher above takes over.
  // Exposed so settings.js can call setThemeMode('system'|'light'|'dark').
  const setThemeMode = useCallback((mode) => {
    if (!THEME_MODES.has(mode)) return;
    // [2026-10-15 nav-motion] troca de tema com crossfade (snapshot da tela).
    const _nextDark = mode === 'system' ? _sysDarkRef.current : mode === 'dark';
    _runThemeFade(_nextDark, () => setThemeModeState(mode));
    _persistMode(mode);
    if (mode === 'system') {
      // No manual override — let the system scheme decide. Drop the legacy
      // theme_dark key so old-style consumers can't re-pin a stale value.
      if (Platform.OS === 'web') {
        try { if (typeof localStorage !== 'undefined') localStorage.removeItem('theme_dark'); } catch {}
      } else {
        AsyncStorage.removeItem('theme_dark').catch(() => {});
      }
    } else {
      // isDark is derived from themeMode; only the legacy mirror needs writing.
      _persistDark(mode === 'dark');
    }
    if (!_suppressBroadcast.current) _broadcastSetting('theme', mode === 'system' ? 'system' : (mode === 'dark' ? 'dark' : 'light'));
  }, [_persistMode, _persistDark, _runThemeFade]);

  // Legacy boolean toggle — now expressed in terms of the 3-state mode so the
  // two never drift. Toggling always lands on a FORCED light/dark (never
  // 'system'), matching the prior behavior where toggle pinned theme_dark.
  const toggle = useCallback(() => {
    _runThemeFade(!_isDarkRef.current, () => setThemeModeState(prevMode => {
      const prevDark = prevMode === 'system' ? systemIsDark : prevMode === 'dark';
      const next = !prevDark;
      const mode = next ? 'dark' : 'light';
      _persistMode(mode);
      _persistDark(next);
      if (!_suppressBroadcast.current) _broadcastSetting('theme', mode);
      return mode;
    }));
  }, [_persistDark, _persistMode, systemIsDark, _runThemeFade]);

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

  // [2026-10-19 accent-real] grava POR CONTA + espelho global; aceita chave da
  // paleta ('blue') ou '#RRGGBB' (personalizada). setAccentColor = nome antigo.
  const _persistAccent = useCallback((v) => {
    _writeKey(_acctKey(), v);
    _writeKey('theme_accent', v);
    if (Platform.OS !== 'web') AsyncStorage.setItem('theme_accent', v).catch(() => {});
    _acctAccentRef.current = true;
  }, []);
  const setAccent = useCallback((value) => {
    if (!_isValidAccentValue(value)) return;
    const v = normalizeAccent(value);
    setAccentValueState(v);
    _persistAccent(v);
    if (!_suppressBroadcast.current) _broadcastSetting('theme_accent', v);
  }, [_persistAccent]);
  const setAccentColor = setAccent;
  // Troca de conta → relê a cor DAQUELA conta (checagem barata só com o app ativo).
  useEffect(() => {
    let timer = null;
    const check = () => {
      const k = _acctKey();
      if (k === _accentAcctRef.current) return;
      _accentAcctRef.current = k;
      const ra = _readAccentSync();
      _acctAccentRef.current = ra.acct;
      setAccentValueState((prev) => (prev === ra.value ? prev : ra.value));
    };
    const arm = () => { if (!timer) timer = setInterval(check, 4000); };
    const disarm = () => { if (timer) { clearInterval(timer); timer = null; } };
    if (AppState.currentState === 'active' || Platform.OS === 'web') arm();
    let sub = null;
    try { sub = AppState.addEventListener('change', (st) => { if (st === 'active') { check(); arm(); } else disarm(); }); } catch {}
    return () => { disarm(); try { sub && sub.remove && sub.remove(); } catch {} };
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
              } else {
                const next = value === 'dark' || value === true || value === 'true';
                setThemeModeState(next ? 'dark' : 'light');
                _persistMode(next ? 'dark' : 'light');
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
            } else if (key === 'theme_accent' && typeof value === 'string' && _isValidAccentValue(value)) {
              const v = normalizeAccent(value);
              setAccentValueState(v);
              _persistAccent(v);
            }
          } finally {
            _suppressBroadcast.current = false;
          }
        } catch {}
      });
    } catch {}
    return () => { try { off && off(); } catch {} };
  }, [_persistDark, _persistMode, systemScheme, _persistAccent]);

  // Override primary-related keys with the user-picked accent so all surfaces
  // (FABs, links, badges) re-tint live without touching every consumer.
  // isDark is DERIVED — single source of truth is themeMode (+ systemIsDark for
  // 'system'). This eliminates the setIsDark races between the hydrate effect
  // and the OS-scheme watcher that left web rendering light under forced dark.
  const isDark = themeMode === 'system' ? systemIsDark : themeMode === 'dark';
  _isDarkRef.current = isDark; // [2026-10-15 nav-motion]
  _sysDarkRef.current = !!systemIsDark;
  try { globalThis.__chatyy_app_is_dark = !!isDark; } catch {} // [2026-10-15 native-browser] services/openLink tinge o navegador interno c/ o tema do APP (não o do SO)
  useEffect(() => {
    if (Platform.OS === 'web' || !_hydratedRef.current) return;
    try { DeviceEventEmitter.emit(APP_THEME_DARK_EVENT, isDark); } catch {}
  }, [isDark]);
  const baseColors = isDark ? DarkColors : Colors;
  // [2026-10-08 dark-black] Grafite (padrão) = tinta P&B do tema: #111 no claro,
  // branco invertido no escuro (DarkColors). [2026-10-19 accent-real] Cor de
  // destaque escolhida → TODAS as superfícies de ação usam o destaque (com tom
  // próprio p/ o escuro e tinta legível por cima); estrutura/bolhas seguem neutras.
  // [2026-10-19 a11y-complete] Aumentar contraste → textos secundários e
  // divisórias mais escuros (claro) / mais claros (escuro).
  const accentHex = resolveAccent(accentValue, isDark);
  const _hc = !!(a11y && a11y.highContrast);
  const colors = useMemo(() => _composeThemeColors(baseColors, accentHex, isDark, _hc), [baseColors, accentHex, isDark, _hc]);
  _accentSnap = { value: accentValue, hex: accentHex, on: !!accentHex, onAccent: colors.onAccent, isDark: !!isDark };
  try { globalThis.__chatyy_accent = _accentSnap; } catch {}
  // compat: consumidores antigos (lista nativa → listAccentHex) esperam #111 p/ "sem cor".
  const accentColor = accentHex || '#111111';
  const densityConfig = DENSITY_CONFIG[density];

  // Memoize context value to prevent re-renders in all consumers when an
  // unrelated state update fires inside ThemeProvider.
  const contextValue = useMemo(() => ({
    colors, isDark, toggle, themeMode, setThemeMode,
    density, setDensity, densityConfig, inboxType, setInboxType,
    accentColor, setAccentColor,
    accent: accentValue, setAccent, accentOn: !!accentHex, a11y,
  }), [colors, isDark, toggle, themeMode, setThemeMode, density, setDensity, densityConfig, inboxType, setInboxType, accentColor, setAccentColor, accentValue, setAccent, accentHex, a11y]);

  return (
    <ThemeContext.Provider value={contextValue}>
      {children}
      {_snap ? (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: _snapAnim, zIndex: 99999, elevation: 99999 }]}>
          <Image source={{ uri: _snap.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" fadeDuration={0} onLoad={_onSnapReady} onError={_onSnapReady} />
        </Animated.View>
      ) : null}
    </ThemeContext.Provider>
  );
}

/**
 * [vanish 2026-10-19] Força o tema escuro só para um pedaço da árvore (modo
 * temporário da conversa, estilo Instagram). Mesmo destaque/contraste do app.
 */
export function ForceDarkTheme({ active, children }) {
  const ctx = useContext(ThemeContext);
  const on = !!active && !!ctx && !ctx.isDark;
  const accentV = ctx ? ctx.accent : null;
  const hc = !!(ctx && ctx.a11y && ctx.a11y.highContrast);
  const value = useMemo(() => {
    if (!on) return ctx;
    const colors = _composeThemeColors(DarkColors, resolveAccent(accentV, true), true, hc);
    return { ...ctx, isDark: true, colors };
  }, [on, ctx, accentV, hc]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be inside ThemeProvider');
  return ctx;
}

// [2026-10-06 UX] Auth screens (login / forgot / signup-*) sit on `authBg`
// (#000 in dark). The brand accent `primary` is near-black ink (#111111 in BOTH
// modes — see ACCENT_PRESETS), so every `colors.primary` text/link/CTA on those
// screens was black-on-black on web dark mode (wordmark "Chatyy", "Criar
// conta", "Esqueceu a senha?", "Próximo"...). This hook returns the same theme
// context but, in dark mode with a near-black accent, remaps the accent family
// to the `authAccent` tokens (white ink) so the ~170 existing `colors.primary`
// usages in those files light up without touching the rest of the app.
export function useAuthTheme() {
  const ctx = useTheme();
  const { colors, isDark } = ctx;
  const authColors = useMemo(() => {
    if (!isDark || !_NEAR_BLACK.test(String(colors.primary || ''))) return colors;
    const accent = colors.authAccent || '#ffffff';
    return {
      ...colors,
      primary: accent,
      primaryDark: colors.authBtnGradientEnd || accent,
      brandSecondary: accent,
      onPrimary: colors.authOnAccent || '#111111',
      textOnPrimary: colors.authOnAccent || '#111111',
    };
  }, [colors, isDark]);
  return useMemo(() => ({ ...ctx, colors: authColors }), [ctx, authColors]);
}
