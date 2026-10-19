// [2026-10-15 native-tabs] Ponte JS da barra de abas NATIVA da home
// (modules/expo-native-tabbar: UITabBar no iOS / barra M3 em Views no Android).
//
// - Só iOS/Android. Web e binário sem o módulo → nativeTabsAvailable() false e
//   app/chat.js usa a barra JS (TabBarItem) exatamente como antes.
// - Kill switch (OTA/console): globalThis.__chatyy_native_tabs = false.
// - A view só desenha e entrega toques; o que cada aba faz continua no chat.js
//   (handleTabPress / requestNewStatus). Haptic e bounce saem do nativo.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform, processColor } from 'react-native';

let _mod; // undefined = não resolvido; null = indisponível
function nativeMod() {
  if (_mod !== undefined) return _mod;
  _mod = null;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try { _mod = require('../modules/expo-native-tabbar'); } catch { _mod = null; }
  return _mod;
}

export function nativeTabsAvailable() {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false;
  try { if (globalThis.__chatyy_native_tabs === false) return false; } catch {}
  const m = nativeMod();
  try { return !!(m && m.isAvailable && m.isAvailable()); } catch { return false; }
}

// [2026-10-18 you-tab] Versão do módulo nativo (0 = sem módulo / desconhecida).
// Android api 2+ desenha o ícone "you" (aba Você); antes disso o chat.js usa a barra JS.
export function nativeTabsApi() {
  const m = nativeMod();
  try { return Number(m && m.apiVersion ? m.apiVersion() : 0) || 0; } catch { return 0; }
}

// [2026-10-18 you-tab-avatar] Foto do próprio usuário na aba "Você" (api 3+).
// MESMA fonte do AvatarCircle: URL canônica (services/avatar buildAvatarUrl, com o
// `v=` do store de versões) + cópia em disco do services/avatarCache (baixada com
// Bearer). Entrega ao nativo o file:// quando já está no disco → zero rede; se o
// cache não conseguir (foto restrita/erro), a URL remota + Authorization e o nativo
// baixa sozinho. Enquanto o disco não responde: null (= SF Symbol / vetor "you"),
// sem baixar a mesma foto 2×. Upload novo / WS avatar_updated → nova versão →
// nova URL → o nativo redesenha.
export function useNativeTabAvatar(email, name, enabled) {
  const on = !!enabled && typeof email === 'string' && email.indexOf('@') > 0;
  const [ver, setVer] = useState(0);
  useEffect(() => {
    if (!on) return undefined;
    let unsub = null;
    try { unsub = require('../services/avatarVersions').subscribeAvatarVersion(email, () => setVer((v) => v + 1)); } catch {}
    return () => { try { unsub && unsub(); } catch {} };
  }, [on, email]);
  const remote = useMemo(() => {
    if (!on) return null;
    try { return require('../services/avatar').buildAvatarUrl(email, { name }) || null; } catch { return null; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, email, name, ver]);
  const [resolved, setResolved] = useState(null); // { for: remote, email, uri }
  useEffect(() => {
    if (!remote) return undefined;
    let alive = true;
    let cache = null;
    try { cache = require('../services/avatarCache'); } catch { cache = null; }
    // [2026-10-19 tabbar-fix] NÃO confiar no índice síncrono: depois de instalar um
    // build novo o iOS troca o UUID do sandbox e o índice (MMKV) ainda aponta p/ o
    // Documents ANTIGO → o nativo lia um arquivo inexistente, falhava (back-off 60 s)
    // e a aba "Você" ficava no ícone p/ sempre (build 728). cacheAvatar() confere se
    // o arquivo existe (getInfoAsync) e rebaixa se preciso; falhou → URL remota.
    if (!cache || !cache.cacheAvatar) { setResolved({ for: remote, email, uri: remote }); return undefined; }
    Promise.resolve(cache.cacheAvatar(remote)).then((r) => {
      if (!alive) return;
      let uri = (typeof r === 'string' && r) ? r : remote;
      // Caminho absoluto sem esquema → file:// (o nativo aceita os dois; normaliza).
      if (uri.charAt(0) === '/') uri = 'file://' + uri;
      setResolved({ for: remote, email, uri });
    }).catch(() => { if (alive) setResolved({ for: remote, email, uri: remote }); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote]);
  // Versão nova baixando → continua mostrando a foto anterior (mesma conta), sem piscar o ícone.
  return useMemo(() => {
    if (!remote || !resolved || resolved.email !== email) return null;
    const uri = resolved.uri;
    if (!/^https?:/i.test(uri)) return { uri, headers: null };
    let headers = null;
    try { headers = require('../services/avatar').avatarAuthHeaders(uri) || null; } catch { headers = null; }
    return { uri, headers };
  }, [remote, resolved, email]);
}

// Altura do conteúdo (sem a área do home indicator / gestos):
// iOS = UITabBar 49 pt; Android = mesma altura da barra JS (10 + 56).
const CONTENT_H = Platform.OS === 'ios' ? 49 : 66;

function color(c) {
  if (c == null) return null;
  try { const v = processColor(c); return typeof v === 'number' ? v : null; } catch { return null; }
}

// [2026-10-19 tabbar-fix] Barra nativa que lança no render → o chat.js troca p/ a
// barra JS (nunca fica sem barra embaixo).
class NativeTabBarBoundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e) {
    try { this.props.onFail && this.props.onFail('throw ' + String((e && e.message) || e).slice(0, 80)); } catch {}
  }
  render() { return this.state.failed ? null : this.props.children; }
}

export default function NativeHomeTabBar(props) {
  return (
    <NativeTabBarBoundary onFail={props.onNativeFail}>
      <NativeHomeTabBarInner {...props} />
    </NativeTabBarBoundary>
  );
}

// Prazo p/ a barra nativa provar que montou (onPreferredHeight no iOS / onLayout
// com altura). Só conta com o app em primeiro plano (sem janela não há evento).
const MOUNT_DEADLINE_MS = 2500;

function NativeHomeTabBarInner({
  items, selectedKey, isDark, translucent, bottomInset = 0,
  activeColor, inactiveColor, backgroundColor, hairlineColor,
  onTabPress, onTabLongPress, style, onLayout, onNativeFail, onNativeReady,
}) {
  const NativeView = nativeMod()?.getNativeTabBarView?.() || null;
  const [prefH, setPrefH] = useState(0);
  const readyRef = useRef(false);
  const failRef = useRef(onNativeFail);
  failRef.current = onNativeFail;
  const readyCbRef = useRef(onNativeReady);
  readyCbRef.current = onNativeReady;
  const markReady = useCallback((how) => {
    if (readyRef.current) return;
    readyRef.current = true;
    try { readyCbRef.current && readyCbRef.current(how); } catch {}
  }, []);
  // [2026-10-19 tabbar-fix] Watchdog: a view nativa não montou (sem onLayout/altura
  // em 2,5 s com o app ativo) → avisa o chat.js, que cai p/ a barra JS.
  useEffect(() => {
    if (!NativeView) return undefined;
    let timer = null;
    const arm = () => {
      if (readyRef.current || timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (readyRef.current) return;
        if (AppState.currentState !== 'active') return; // sem janela: espera voltar
        try { failRef.current && failRef.current('no_mount'); } catch {}
      }, MOUNT_DEADLINE_MS);
    };
    if (AppState.currentState === 'active') arm();
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') arm(); });
    return () => { if (timer) clearTimeout(timer); try { sub && sub.remove && sub.remove(); } catch {} };
  }, [NativeView]);

  const theme = useMemo(() => ({
    dark: !!isDark,
    active: color(activeColor),
    inactive: color(inactiveColor),
    background: color(backgroundColor),
    hairline: color(hairlineColor),
    // Badge P&B invertido (igual ao PulseBadge JS).
    badgeBackground: color(activeColor),
    badgeText: color(isDark ? '#0b0b0b' : '#ffffff'),
    pill: color(isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.07)'),
    ripple: color(isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)'),
  }), [isDark, activeColor, inactiveColor, backgroundColor, hairlineColor]);

  const handlePress = useCallback((e) => {
    const key = e?.nativeEvent?.key;
    if (key && onTabPress) onTabPress(key);
  }, [onTabPress]);
  const handleLongPress = useCallback((e) => {
    const key = e?.nativeEvent?.key;
    if (key && onTabLongPress) onTabLongPress(key);
  }, [onTabLongPress]);
  const handlePreferredHeight = useCallback((e) => {
    const h = Number(e?.nativeEvent?.height) || 0;
    if (h >= 40 && h <= 160) {
      setPrefH((prev) => (Math.abs(prev - h) < 0.5 ? prev : h));
      markReady('pref');
    }
  }, [markReady]);
  const handleLayout = useCallback((e) => {
    const h = Number(e?.nativeEvent?.layout?.height) || 0;
    const w = Number(e?.nativeEvent?.layout?.width) || 0;
    // iOS só vale o onPreferredHeight (prova que o UITabBar está numa janela);
    // Android: a barra é toda em Views → layout com altura basta.
    if (Platform.OS !== 'ios' && h >= 40 && w > 0) markReady('layout');
    if (onLayout) onLayout(e);
  }, [onLayout, markReady]);

  if (!NativeView) return null;
  // Android: mesmo respiro da barra JS (mín. 12 dp acima da barra de gestos).
  const inset = Platform.OS === 'android' ? Math.max(bottomInset, 12) : bottomInset;
  // [2026-10-19 tabbar-fix] iOS: NUNCA menor que 49 + home indicator. O sizeThatFits
  // do UITabBar medido antes da safe area chegar devolve só 49 → a barra ficava com
  // 49 pt colada embaixo, os ícones espremidos em ~15 pt sob a safe area de 34 pt
  // (no iOS 26 o vidro some junto) = "às vezes não aparece a barra embaixo".
  const minH = CONTENT_H + inset;
  const height = Platform.OS === 'ios' && prefH > 0 ? Math.max(prefH, minH) : minH;
  return (
    <NativeView
      style={[{ height, alignSelf: 'stretch' }, style]}
      items={items}
      selectedKey={selectedKey || null}
      theme={theme}
      translucent={!!translucent}
      bottomInset={inset}
      bounce
      onTabPress={handlePress}
      onTabLongPress={handleLongPress}
      onPreferredHeight={handlePreferredHeight}
      onLayout={handleLayout}
    />
  );
}
