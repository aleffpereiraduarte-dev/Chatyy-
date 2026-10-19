// [2026-10-15 native-tabs] Ponte JS da barra de abas NATIVA da home
// (modules/expo-native-tabbar: UITabBar no iOS / barra M3 em Views no Android).
//
// - Só iOS/Android. Web e binário sem o módulo → nativeTabsAvailable() false e
//   app/chat.js usa a barra JS (TabBarItem) exatamente como antes.
// - Kill switch (OTA/console): globalThis.__chatyy_native_tabs = false.
// - A view só desenha e entrega toques; o que cada aba faz continua no chat.js
//   (handleTabPress / requestNewStatus). Haptic e bounce saem do nativo.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Dimensions, Platform, processColor } from 'react-native';

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
  // [2026-10-18 tabbar-invisivel] iOS build 728 (api 3, aba Você c/ foto): a barra
  // nativa monta mas some às vezes → usa a barra JS (já mostra a foto) até um build
  // com api ≥ 4. Forçar a nativa: globalThis.__chatyy_native_tabs = true.
  // [2026-10-19 tabbar-api5] build 729 (api 4) também some (founder: "sumiu de novo",
  // conectado ou não) e a autochecagem do api 4 não pega → api 3 E 4 no iOS = barra
  // JS (cápsula iOS 26, com a foto). Volta a nativa no build com api 5 (foto por
  // cima do ícone, sem trocar imagem de UITabBarItem; checagem de visibilidade real).
  try {
    if (Platform.OS === 'ios' && globalThis.__chatyy_native_tabs !== true
      && m && m.apiVersion && (Number(m.apiVersion()) >= 3 && Number(m.apiVersion()) <= 5)) return false;
  } catch {}
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
// [2026-10-19 tabbar-avatar] (histórico) opts.remote (iOS api 5): entregava a URL https + Bearer
// direto (o nativo tem cache de memória + URLCache próprios) — nada de file:// do
// Documents, que muda de UUID a cada build instalado. opts.retry: nonce que o
// chat.js sobe quando o nativo avisa onAvatarState failed → URL nova (&ntbr=N),
// fura o back-off/dedupe do loader nativo.
// [2026-10-19 tabbar-offline] opts.api >= 6 (iOS/Android): OFFLINE-FIRST como
// WhatsApp/Instagram — devolve { uri: URL https, headers, localPath, key }:
//   - key = e-mail (chave ESTÁVEL da conta): o nativo guarda a última foto boa em
//     disco e mostra NA MONTAGEM, antes de qualquer rede;
//   - localPath = cópia em disco do avatarCache (síncrono: índice da URL atual ou a
//     última foto boa da pessoa, qualquer versão) — o nativo mostra antes da rede;
//   - uri/headers = remota, revalida em 2º plano (falha nunca volta ao ícone).
// api < 6: compatível — file:// se já existe em disco, senão a remota (o
// cacheAvatar() confere o arquivo e troca p/ file:// quando o download termina).
export function useNativeTabAvatar(email, name, enabled, opts) {
  const api = (opts && Number(opts.api)) || 0;
  const offlineFirst = api >= 6;
  const retry = (opts && Number(opts.retry)) || 0;
  const on = !!enabled && typeof email === 'string' && email.indexOf('@') > 0;
  const key = on ? email.trim().toLowerCase() : '';
  const [ver, setVer] = useState(0);
  useEffect(() => {
    if (!on) return undefined;
    let unsub = null;
    try { unsub = require('../services/avatarVersions').subscribeAvatarVersion(email, () => setVer((v) => v + 1)); } catch {}
    return () => { try { unsub && unsub(); } catch {} };
  }, [on, email]);
  const remote = useMemo(() => {
    if (!on) return null;
    let u = null;
    try { u = require('../services/avatar').buildAvatarUrl(email, { name }) || null; } catch { u = null; }
    if (u && retry > 0) u += (u.indexOf('?') >= 0 ? '&' : '?') + 'ntbr=' + retry;
    return u;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, email, name, ver, retry]);
  // URL sem o &ntbr= (o índice do avatarCache é por URL canônica).
  const canon = remote ? remote.replace(/[?&]ntbr=\d+/, '') : null;
  // Cópia em disco SÍNCRONA (zero I/O): índice da URL atual → última foto boa da pessoa.
  const syncLocal = useMemo(() => {
    if (!canon) return null;
    let p = null;
    try {
      const c = require('../services/avatarCache');
      p = (c.getCachedAvatarUriOrNull && c.getCachedAvatarUriOrNull(canon))
        || (c.getLastGoodAvatarUri && c.getLastGoodAvatarUri(key)) || null;
    } catch { p = null; }
    if (p && p.charAt(0) === '/') p = 'file://' + p;
    return p;
  }, [canon, key]);
  // Download/conferência em disco (cacheAvatar confere se o arquivo existe — no iOS o
  // UUID do container muda a cada build instalado) → caminho local verificado.
  const [verified, setVerified] = useState(null); // { for: canon, path }
  useEffect(() => {
    if (!canon) return undefined;
    let alive = true;
    let cache = null;
    try { cache = require('../services/avatarCache'); } catch { cache = null; }
    if (!cache || !cache.cacheAvatar) return undefined;
    Promise.resolve(cache.cacheAvatar(canon)).then((r) => {
      if (!alive) return;
      let p = (typeof r === 'string' && r && !/^https?:/i.test(r)) ? r : null;
      if (p && p.charAt(0) === '/') p = 'file://' + p;
      setVerified({ for: canon, path: p });
    }).catch(() => { if (alive) setVerified({ for: canon, path: null }); });
    return () => { alive = false; };
  }, [canon]);
  return useMemo(() => {
    if (!remote) return null;
    const vf = verified && verified.for === canon ? verified : null;
    // api 6: a conferência falhou (offline) → segue a cópia síncrona (última foto boa).
    // api < 6: o resultado conferido manda (caminho velho do índice não vai ao nativo).
    const local = offlineFirst ? ((vf && vf.path) || syncLocal || null) : (vf ? vf.path : syncLocal);
    let headers = null;
    try { headers = require('../services/avatar').avatarAuthHeaders(remote) || null; } catch { headers = null; }
    if (offlineFirst) return { uri: remote, headers, localPath: local, key };
    // api < 6: file:// se existe em disco, senão a remota.
    if (local) return { uri: local, headers: null, localPath: null, key: null };
    return { uri: remote, headers, localPath: null, key: null };
  }, [remote, canon, verified, syncLocal, offlineFirst, key]);
}

// [2026-10-19 tabbar-api5] Diagnóstico `tabbar_probe` / `tabbar_avatar` → nativeTelemetry
// (nativeBeacon: teto 12/prefixo/sessão) + throttle próprio (1 a cada 15 s).
let _probeLastAt = 0;
export function sendTabbarProbe(step, info) {
  const now = Date.now();
  if (now - _probeLastAt < 15000 && !/^fail|offscreen/.test(String(step))) return;
  _probeLastAt = now;
  try { require('../services/nativeTelemetry').nativeBeacon('tabbar_probe', String(step || '-').slice(0, 24), String(info || '').slice(0, 360)); } catch {}
}
const _avatarSent = new Set();
export function noteTabbarAvatarState(state, reason, scheme) {
  const k = `${state}|${reason || ''}`;
  if (_avatarSent.has(k)) return; // 1× por sessão por estado/motivo
  _avatarSent.add(k);
  try { require('../services/nativeTelemetry').nativeBeacon('tabbar_avatar', String(state || '-'), `reason=${reason || '-'} scheme=${scheme || '-'} api=${nativeTabsApi()}`); } catch {}
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
  onAvatarState, probeExtra,
}) {
  const NativeView = nativeMod()?.getNativeTabBarView?.() || null;
  const viewRef = useRef(null);
  const layoutRef = useRef({ w: 0, h: 0 });
  const extraRef = useRef(probeExtra);
  extraRef.current = probeExtra;
  const avatarCbRef = useRef(onAvatarState);
  avatarCbRef.current = onAvatarState;
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
    // [2026-10-19 accent-real] badge na cor de destaque → tinta legível por cima.
    badgeText: color((() => {
      try {
        const T = require('../context/ThemeContext');
        if (T.getAccentSnapshot().on && /^#[0-9a-f]{6}$/i.test(String(activeColor || ''))) return T.onAccentFor(activeColor);
      } catch {}
      return isDark ? '#0b0b0b' : '#ffffff';
    })()),
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
  // [2026-10-18 tabbar-invisivel] api 4+: o nativo checa a própria saúde ao entrar
  // na janela / voltar ao 1º plano (frame, hidden/alpha, itens) e, se não conseguir
  // reparar, avisa → o chat.js cai p/ a barra JS (nunca fica sem barra embaixo).
  const handleBarFail = useCallback((e) => {
    const why = String(e?.nativeEvent?.reason || 'unknown').slice(0, 40);
    try { failRef.current && failRef.current('native_' + why); } catch {}
  }, []);
  // [2026-10-19 tabbar-api5] api 5: diagnóstico nativo (frame/janela/itens/ícones)
  // + o lado JS (layout, altura, extra do chat.js) num beacon só.
  const handleBarProbe = useCallback((e) => {
    const n = e?.nativeEvent || {};
    const nat = `n:${n.reason || '-'} fr=${n.frame || '-'} wf=${n.winFrame || '-'} wb=${n.winBounds || '-'} win=${n.win ? 1 : 0}`
      + ` hid=${n.hidden ? 1 : 0} a=${n.alpha != null ? Number(n.alpha).toFixed(2) : '-'} anc=${n.hiddenAncestor || '-'} sup=${n.sup || '-'}`
      + ` bar=${n.bar || '-'} it=${n.items ?? '-'}/${n.records ?? '-'} ic=${n.icons ?? '-'} ct=${n.content ? 1 : 0} ih=${n.ih != null ? Math.round(n.ih) : '-'}`
      + ` app=${n.app || '-'} hl=${n.health || '-'} av=${n.avatar || '-'}`;
    let extra = '';
    try { extra = extraRef.current ? String(extraRef.current() || '') : ''; } catch {}
    sendTabbarProbe(String(n.reason || 'native'), `${nat} | js lh=${Math.round(layoutRef.current.h)} ${extra}`);
  }, []);
  const handleAvatarState = useCallback((e) => {
    const n = e?.nativeEvent || {};
    try { avatarCbRef.current && avatarCbRef.current(String(n.state || ''), String(n.reason || ''), String(n.scheme || '')); } catch {}
  }, []);
  // JS: 2 s depois de montar e a cada volta ao 1º plano mede a barra na janela.
  // Fora da tela (embaixo da borda / altura < 40) → cai p/ a barra JS (vale
  // também p/ binários api < 5, que não se autochecam nisso).
  useEffect(() => {
    if (!NativeView) return undefined;
    let timer = null;
    const probe = (why) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (AppState.currentState !== 'active') return;
        const v = viewRef.current;
        if (!v || typeof v.measureInWindow !== 'function') return;
        try {
          v.measureInWindow((x, y, w, h) => {
            const scr = Dimensions.get('window');
            const sh = Number(scr && scr.height) || 0;
            let extra = '';
            try { extra = extraRef.current ? String(extraRef.current() || '') : ''; } catch {}
            const geo = `m=${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)} sh=${Math.round(sh)} lh=${Math.round(layoutRef.current.h)} api=${nativeTabsApi()}`;
            if (!(w > 0) && !(h > 0)) { sendTabbarProbe('js_' + why, `${geo} unattached ${extra}`); return; }
            // Android edge-to-edge: window.height pode excluir a barra de gestos → só iOS.
            const off = Platform.OS === 'ios' && sh > 0 && (h < 40 || y >= sh - 20 || y + h > sh + 4);
            sendTabbarProbe(off ? 'offscreen_js' : 'js_' + why, `${geo} ${extra}`);
            if (off) { try { failRef.current && failRef.current('js_offscreen'); } catch {} }
          });
        } catch {}
      }, why === 'boot' ? 2000 : 1500);
    };
    probe('boot');
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') probe('fg'); });
    return () => { if (timer) clearTimeout(timer); try { sub && sub.remove && sub.remove(); } catch {} };
  }, [NativeView]);
  const handleLayout = useCallback((e) => {
    const h = Number(e?.nativeEvent?.layout?.height) || 0;
    const w = Number(e?.nativeEvent?.layout?.width) || 0;
    layoutRef.current = { w, h };
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
      ref={viewRef}
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
      onBarFail={handleBarFail}
      onBarProbe={handleBarProbe}
      onAvatarState={handleAvatarState}
      onLayout={handleLayout}
    />
  );
}
