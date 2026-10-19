// components/chat/NativeEmojiPanelBridge.js — [2026-10-15 native-emoji]
//
// Ponte entre a conversa (app/chat-conversation.js) e o painel NATIVO
// Emoji | Figurinhas | GIF (modules/expo-chat-emoji). O nativo só desenha e
// entrega toques; aqui ficam: inserir/apagar no texto (feito pela tela via
// onEmoji/onBackspace), dados das figurinhas (mesmas fontes do StickerPicker
// JS: recentes locais, favoritas, minhas, pacotes da loja) e a busca de GIFs
// (api.chatSearchGifs — mesmo endpoint/filtro do GifPicker).
//
// Altura (troca teclado ⇄ painel sem pulo): o painel mede SEMPRE a altura do
// último teclado e, com react-native-keyboard-controller, a altura visível é
//   max(compacto, alvo·aberto − max(0, teclado − padComposer))
// no UI thread — o MESMO valor que o ThreadKeyboardAvoider usa p/ levantar a
// conversa. Teclado descendo = painel crescendo na mesma proporção (e vice-versa).
//
// Segurança: binário sem o módulo / web / kill switch
// (globalThis.__chatyy_native_emoji = false) → shouldUseNativeEmojiPanel() =
// false e a tela usa StickerPicker/GifPicker JS como antes. Erro de render →
// ErrorBoundary desliga o nativo pelo resto da sessão (onFatal).
//
// [2026-10-16 sticker-panel v2] Binário apiVersion ≥ 2 → richStickers: pacote
// do mascote (Lottie) como 1º pacote, figurinhas Lottie tocando na grade,
// prévia grande ao segurar e "voo" até a conversa. Kill switch das abas
// Figurinhas/GIF nativas: globalThis.__chatyy_native_sticker_panel = false →
// a tela volta ao StickerPicker/GifPicker JS (shouldUseNativeStickerPanel()).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Platform, processColor, View } from 'react-native';
import { useThreadKeyboardHeight, getThreadReanimated } from '../../utils/threadKeyboard';

let _failed = false;

function _nativeModule() {
  if (Platform.OS === 'web') return null;
  try {
    return require('../../modules/expo-chat-emoji');
  } catch {
    return null;
  }
}

/** true quando o binário instalado tem o painel nativo e ele não foi desligado. */
export function shouldUseNativeEmojiPanel() {
  if (Platform.OS === 'web' || _failed) return false;
  try { if (globalThis.__chatyy_native_emoji === false) return false; } catch {}
  const m = _nativeModule();
  let ok = false;
  try { ok = !!(m && m.isAvailable && m.isAvailable()); } catch { ok = false; }
  // Memória da altura do teclado só quando o painel nativo existe (binário
  // antigo: nenhum listener extra).
  if (ok) _listenKb();
  return ok;
}

/** Figurinhas/GIF no painel nativo (false = kill switch → pickers JS). */
export function shouldUseNativeStickerPanel() {
  try { if (globalThis.__chatyy_native_sticker_panel === false) return false; } catch {}
  return true;
}

/** apiVersion ≥ 2: Lottie na grade + prévia + voo. */
function _richStickers() {
  if (!shouldUseNativeStickerPanel()) return false;
  const m = _nativeModule();
  try { return !!(m && m.getApiVersion && m.getApiVersion() >= 2); } catch { return false; }
}

function _tr(t, key, fb, vars) {
  try {
    const v = t ? t(key, vars) : null;
    if (typeof v === 'string' && v && v !== key) return v;
  } catch {}
  return fb;
}

function _pc(c) {
  if (c == null) return null;
  try {
    const v = processColor(c);
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

// ── Altura do teclado (memória) ─────────────────────────────────────────────
// iOS: endCoordinates.height já inclui o home indicator. Android: o RN exclui a
// barra de navegação → quem lê soma o inset inferior.
const KB_KEY = 'chatyy_kb_height_v1';
let _kbH = 0;
let _kbListening = false;
function _loadKb() {
  try {
    const mmkv = require('../../services/mmkv');
    const raw = mmkv.getString?.(KB_KEY);
    const n = raw ? Number(raw) : 0;
    if (n > 120 && n < 700) _kbH = n;
  } catch {}
}
function _listenKb() {
  if (_kbListening || Platform.OS === 'web') return;
  _kbListening = true;
  _loadKb();
  try {
    Keyboard.addListener('keyboardDidShow', (e) => {
      const h = Number(e?.endCoordinates?.height) || 0;
      if (h > 120 && h < 700 && Math.abs(h - _kbH) >= 1) {
        _kbH = h;
        try { require('../../services/mmkv').setString?.(KB_KEY, String(Math.round(h))); } catch {}
      }
    });
  } catch {}
}

/** Altura total do painel (equivale ao teclado), já com o inset inferior. */
export function getPanelKeyboardHeight(insetBottom = 0, windowHeight = 800) {
  let h = _kbH;
  if (h > 0 && Platform.OS === 'android') h += Math.max(0, insetBottom || 0);
  if (!(h > 0)) {
    // 1ª vez sem teclado medido: ~ teclado padrão do sistema.
    h = Math.round(Math.min(380, Math.max(260, windowHeight * 0.36))) + (Platform.OS === 'android' ? Math.max(0, insetBottom || 0) : Math.max(0, insetBottom || 0) * 0.6);
  }
  return Math.round(h);
}

// ── Dados das figurinhas (mesmas fontes do StickerPicker JS) ───────────────
const RECENT_KEY = '@chatyy_recent_stickers';
const FAV_KEY = '@chatyy_fav_stickers';
const MINE_KEY = '@chatyy_my_stickers';
// Recentes Lottie à parte: o StickerPicker JS (mesma RECENT_KEY) não desenha .json.
const RECENT_LOTTIE_KEY = '@chatyy_recent_stickers_lottie';

// [2026-10-19 sticker-cache] Listas POR CONTA no KV do stickerCache (as chaves
// AsyncStorage antigas eram globais → migrateLegacyStickerLists adota e apaga).
// Imagens vão p/ o nativo como file:// quando já estão no disco (EPImageLoader /
// Glide aceitam caminho local) — painel abre instantâneo e offline.
function _stk() { try { return require('../../services/stickerCache'); } catch { return null; } }
const _META_OF = { [RECENT_KEY]: 'st_recent', [FAV_KEY]: 'st_fav', [MINE_KEY]: 'st_mine_urls', [RECENT_LOTTIE_KEY]: 'st_recent_lottie' };
function _metaSync(key) {
  try { const v = _stk()?.getStickerMeta(_META_OF[key] || key); return Array.isArray(v) ? v : []; } catch { return []; }
}
async function _storageGet(key) {
  try { await _stk()?.migrateLegacyStickerLists(); } catch {}
  return _metaSync(key);
}
async function _storageSet(key, value) {
  try { _stk()?.setStickerMeta(_META_OF[key] || key, Array.isArray(value) ? value : []); } catch {}
}
function _packItemsSync(packs) {
  const out = {};
  const st = _stk();
  if (!st) return out;
  for (const p of packs || []) {
    const id = p?.id ?? p?.pack_id;
    if (id == null) continue;
    const v = st.getStickerMeta('pack_' + id);
    if (Array.isArray(v)) out[id] = v;
  }
  return out;
}

const _isImg = (s) => typeof s === 'string' && (/^https?:\/\//.test(s) || s.startsWith('/data/'));
const _isLottie = (s) => typeof s === 'string' && /\.json(?:[?#].*)?$/i.test(s);

// Pacote do mascote (public/stickers → https://chatyy.com.br/stickers/). Nova
// pose gerada por scripts/build-mascot-lottie.js → acrescentar aqui.
function _mascotPack() {
  try {
    const M = require('../mascot/ChatyyMascot');
    const base = M.MASCOT_STICKER_BASE || 'https://chatyy.com.br/stickers/';
    const files = ['chatyy-aceno'];
    return {
      key: 'chatyy',
      title: 'Chatyy',
      icon: 'pack',
      coverUri: M.MASCOT_GREETING_PNG || (base + 'chatyy-aceno.png'),
      items: files.map((f) => ({ key: base + f + '.json', uri: base + f + '.json', lottie: true })),
    };
  } catch {
    return null;
  }
}
/** Imagem p/ o nativo: file:// já baixado ou URL (e agenda o download p/ o disco). */
function _disp(api, s, kick) {
  const abs = _resolve(api, s);
  if (!abs || _isLottie(abs)) return abs;
  try { const st = _stk(); if (st) return st.stickerDisplayUri(abs, kick === false ? { kick: false } : undefined) || abs; } catch {}
  return abs;
}
function _resolve(api, s) {
  if (typeof s !== 'string') return '';
  if (/^https?:\/\//.test(s)) return s;
  if (s.startsWith('/data/')) {
    try { return api.getMediaUrl(s); } catch { return 'https://chatyy.com.br' + s; }
  }
  return s;
}

function useStickerSections(enabled, t, rich) {
  const [recents, setRecents] = useState(() => _metaSync(RECENT_KEY));
  const [recentsLottie, setRecentsLottie] = useState(() => _metaSync(RECENT_LOTTIE_KEY)); // [{u, ts}]
  const [favorites, setFavorites] = useState(() => _metaSync(FAV_KEY));
  const [mine, setMine] = useState(() => _metaSync(MINE_KEY));
  const [packs, setPacks] = useState(() => _metaSync('mkt_packs'));
  const [packItems, setPackItems] = useState(() => _packItemsSync(_metaSync('mkt_packs')));
  const loadingPacks = useRef(new Set());
  const loadedOnce = useRef(false);

  useEffect(() => {
    if (!enabled || loadedOnce.current) return;
    loadedOnce.current = true;
    let alive = true;
    const api = require('../../services/api');
    _storageGet(RECENT_KEY).then((v) => { if (alive) setRecents((p) => (p.length ? p : v)); });
    if (rich) {
      _storageGet(RECENT_LOTTIE_KEY).then((v) => {
        if (alive && v.length) setRecentsLottie(v);
      });
    }
    _storageGet(FAV_KEY).then((v) => { if (alive) setFavorites((p) => (p.length ? p : v)); });
    _storageGet(MINE_KEY).then((v) => { if (alive) setMine((p) => (p.length ? p : v)); });
    // [2026-10-19 sticker-cache] revalida no servidor (diff) e pré-busca p/ o disco.
    void api;
    (async () => {
      const st = _stk();
      if (!st) return;
      const pull = (name) => {
        if (!alive) return;
        if (name === 'st_fav' || name === '*') setFavorites(_metaSync(FAV_KEY));
        if (name === 'st_mine' || name === '*') {
          const full = st.getStickerMeta('st_mine');
          const urls = Array.isArray(full) ? full.map((x) => x && x.url).filter(Boolean) : [];
          if (urls.length) { setMine(urls); _storageSet(MINE_KEY, urls); }
        }
        if (name === 'mkt_packs' || name === '*') setPacks(_metaSync('mkt_packs'));
        if (name === '*' || (typeof name === 'string' && name.startsWith('pack_'))) {
          setPackItems((prev) => ({ ...prev, ..._packItemsSync(_metaSync('mkt_packs')) }));
        }
      };
      try { await st.syncStickerLibrary({ onChange: pull }); } catch {}
    })();
    return () => { alive = false; };
  }, [enabled]);

  const loadPack = useCallback((key) => {
    if (typeof key !== 'string' || !key.startsWith('mkt-')) return;
    const id = parseInt(key.slice(4), 10);
    const st = _stk();
    const fresh = !!(st && st.packItemsFresh && st.packItemsFresh(id));
    if (!id || (packItems[id] && fresh) || loadingPacks.current.has(id)) return;
    loadingPacks.current.add(id);
    (async () => {
      try {
        // [2026-10-19 sticker-cache] KV já está na tela; servidor só se mudou.
        const items = st ? await st.revalidatePackItems(id, () => {
          setPackItems((prev) => ({ ...prev, [id]: st.getStickerMeta('pack_' + id) || [] }));
        }) : null;
        if (Array.isArray(items)) {
          setPackItems((prev) => (prev[id] ? prev : { ...prev, [id]: items }));
          try { st.prefetchStickers(items.map((it) => it && it.url).filter(Boolean)); } catch {}
        } else {
          setPackItems((prev) => (prev[id] ? prev : { ...prev, [id]: [] }));
        }
      } catch {
        setPackItems((prev) => (prev[id] ? prev : { ...prev, [id]: [] }));
      }
      loadingPacks.current.delete(id);
    })();
  }, [packItems]);

  const pushRecent = useCallback((item) => {
    if (_isLottie(item)) {
      setRecentsLottie((prev) => {
        const next = [{ u: item, ts: Date.now() }, ...prev.filter((r) => r?.u !== item)].slice(0, 20);
        _storageSet(RECENT_LOTTIE_KEY, next);
        return next;
      });
      return;
    }
    setRecents((prev) => {
      const next = [item, ...prev.filter((r) => r !== item)].slice(0, 40);
      _storageSet(RECENT_KEY, next);
      return next;
    });
    try { _stk()?.ensureStickerCached(item, { priority: 'high' }).catch(() => {}); } catch {}
  }, []);

  const sections = useMemo(() => {
    const api = require('../../services/api');
    // binário sem Lottie (apiVersion 1): figurinha .json não desenha → fora.
    // kick=false (pacotes): o arquivo vai p/ o disco pela pré-busca do Wi-Fi (syncStickerLibrary).
    const toItems = (list, kick) => (list || []).filter(_isImg).filter((u) => rich || !_isLottie(u)).slice(0, 120)
      .map((u) => (_isLottie(u) ? { key: u, uri: _resolve(api, u), lottie: true } : { key: u, uri: _disp(api, u, kick) }));
    const out = [];
    const mascot = rich ? _mascotPack() : null;
    // recentes = imagens + Lottie (mais novos primeiro; Lottie só com rich)
    const lot = rich ? (recentsLottie || []).filter((r) => r && typeof r.u === 'string') : [];
    const rec = toItems(lot.length ? [...lot.map((r) => r.u), ...recents].slice(0, 40) : recents);
    if (rec.length) out.push({ key: 'recent', title: _tr(t, 'chat.npanel.recent', 'Recentes'), icon: 'recent', items: rec });
    const fav = toItems(favorites);
    if (fav.length) out.push({ key: 'favorites', title: _tr(t, 'chat.npanel.favorites', 'Favoritas'), icon: 'favorites', items: fav });
    const mn = toItems(mine);
    if (mn.length) out.push({ key: 'mine', title: _tr(t, 'chat.npanel.mine', 'Minhas'), icon: 'mine', items: mn });
    // mascote = 1º pacote (logo depois das abas pessoais)
    if (mascot) out.push(mascot);
    for (const p of packs || []) {
      const id = p?.id ?? p?.pack_id;
      if (id == null) continue;
      const key = 'mkt-' + id;
      const raw = packItems[id];
      const items = Array.isArray(raw)
        ? toItems(raw.map((it) => it?.url || it?.image_url || it?.sticker_id), false)
        : [];
      const cover = p?.cover_url || p?.cover || p?.thumb_url || p?.icon_url || p?.preview_url || '';
      out.push({
        key,
        title: String(p?.name || p?.title || ''),
        icon: 'pack',
        coverUri: cover ? _disp(api, cover, false) : null,
        loading: !Array.isArray(raw),
        items,
      });
    }
    return out;
  }, [recents, recentsLottie, favorites, mine, packs, packItems, t, rich]);

  return { sections, loadPack, pushRecent };
}

// ── GIFs (mesmo endpoint/filtro do GifPicker) ───────────────────────────────
const _gifCache = new Map();
function useGifs(enabled) {
  const [gifs, setGifs] = useState([]);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);
  const started = useRef(false);
  const byKey = useRef(new Map());

  const load = useCallback(async (q) => {
    const my = ++reqId.current;
    const ck = q || '__trending__';
    const st = _stk();
    const apply = (list0) => {
      const m = new Map();
      const rows = [];
      // [2026-10-19 sticker-cache] aba inicial: favoritos + recentes primeiro.
      let list = list0;
      if (!q && st) {
        try {
          const pin = st.getGifPinnedList();
          if (pin.length) {
            const seen = new Set();
            list = [];
            for (const g of [...pin, ...list0]) { const id = String(g?.id || g?.medium || g?.preview || ''); if (!id || seen.has(id)) continue; seen.add(id); list.push(g); }
          }
        } catch {}
      }
      list.forEach((g, i) => {
        let uri = g?.preview || g?.tiny || g?.url;
        if (!uri) return;
        try { const loc = st && st.getStickerLocalSync(uri); if (loc) uri = loc; } catch {}
        const key = String(g?.id || i) + ':' + i;
        m.set(key, g);
        rows.push({ key, uri, width: Number(g?.width) || 1, height: Number(g?.height) || 1 });
      });
      byKey.current = m;
      setGifs(rows);
    };
    if (_gifCache.has(ck)) { apply(_gifCache.get(ck)); setLoading(false); return; }
    // [2026-10-19 sticker-cache] JSON salvo por conta (TTL): na hora; vencido → 2º plano.
    let stale = null;
    try { stale = st && st.getGifQueryCache(q); } catch {}
    if (stale && Array.isArray(stale.gifs) && stale.gifs.length) {
      _gifCache.set(ck, stale.gifs);
      apply(stale.gifs);
      setLoading(false);
      if (stale.fresh) return;
    } else if (!q && st && st.getGifPinnedList().length) {
      apply([]);
      setLoading(true);
    } else {
      setLoading(true);
    }
    try {
      const api = require('../../services/api');
      const r = await api.chatSearchGifs(q);
      if (my !== reqId.current) return;
      if (r?.success) {
        const MAX = 8 * 1024 * 1024;
        const list = (r.data?.gifs || []).filter((g) => {
          const b = Number(g?.size || g?.bytes || g?.media_size || 0);
          return b === 0 || b <= MAX;
        });
        _gifCache.set(ck, list);
        if (_gifCache.size > 40) _gifCache.delete(_gifCache.keys().next().value);
        try { if (st) { st.setGifQueryCache(q, list); st.prefetchGifPreviews(list.slice(0, 24)); } } catch {}
        apply(list);
      }
    } catch {}
    if (my === reqId.current) setLoading(false);
  }, []);

  useEffect(() => {
    if (enabled && !started.current) { started.current = true; load(''); }
  }, [enabled, load]);

  const getGif = useCallback((key) => byKey.current.get(key) || null, []);
  return { gifs, loading, load, getGif };
}

// ── Boundary ────────────────────────────────────────────────────────────────
class NativeEmojiBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err) {
    _failed = true;
    try { console.warn('[native-emoji] fallback to JS panels:', err?.message || err); } catch {}
    try { require('../../services/crashReporter').reportNativeFallback('native_emoji', err); } catch {}
    try { this.props.onFatal?.(err); } catch {}
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

// ── Casca com altura animada ────────────────────────────────────────────────
const _Rea = getThreadReanimated();

function KCPanelShell({ visible, fullHeight, compactHeight, composerPad, background, children }) {
  const kbHeight = useThreadKeyboardHeight();
  const open = _Rea.useSharedValue(0);
  const full = _Rea.useSharedValue(fullHeight);
  const minH = _Rea.useSharedValue(compactHeight);
  const pad = _Rea.useSharedValue(composerPad);

  useEffect(() => { full.value = fullHeight; }, [fullHeight, full]);
  useEffect(() => { pad.value = composerPad; }, [composerPad, pad]);
  useEffect(() => {
    minH.value = compactHeight > 0 ? compactHeight : _Rea.withTiming(0, { duration: 160 });
  }, [compactHeight, minH]);
  useEffect(() => {
    let kbOpen = false;
    try { kbOpen = !!Keyboard.isVisible?.(); } catch {}
    if (visible) {
      // Teclado aberto: o painel nasce "atrás" dele e cresce conforme ele desce.
      open.value = kbOpen ? 1 : _Rea.withSpring(1, { damping: 26, stiffness: 260, mass: 0.9 });
    } else {
      open.value = _Rea.withTiming(0, { duration: 200 });
    }
  }, [visible, open]);

  const style = _Rea.useAnimatedStyle(() => {
    'worklet';
    const k = kbHeight ? Math.max(0, -kbHeight.value) : 0;
    const lift = Math.max(0, k - pad.value);
    const h = Math.max(minH.value, full.value * open.value - lift);
    return { height: Math.max(0, h) };
  }, [kbHeight]);

  const AnimatedView = _Rea.default.View;
  return <AnimatedView style={[{ overflow: 'hidden', backgroundColor: background }, style]}>{children}</AnimatedView>;
}

function PlainPanelShell({ visible, fullHeight, compactHeight, background, children }) {
  return <View style={{ height: visible ? (compactHeight > 0 ? compactHeight : fullHeight) : 0, overflow: 'hidden', backgroundColor: background }}>{children}</View>;
}

const PanelShell = _Rea ? KCPanelShell : PlainPanelShell;

const COMPACT_EMOJI = 96;
const COMPACT_GIF = 152;

/**
 * <NativeEmojiPanel visible tab onTabChange … />
 * Fica montado enquanto `visible` (e ~260 ms depois, p/ a animação de saída).
 */
function NativeEmojiPanelInner(props) {
  const {
    visible,
    tab = 'emoji',
    onTabChange,
    isDark,
    colors = {},
    t,
    insetBottom = 0,
    composerPad = 0,
    composerGap = 8,
    windowHeight = 800,
    showStickers: showStickersProp = true,
    showGifs: showGifsProp = true,
  } = props;
  const stickerPanelOn = shouldUseNativeStickerPanel();
  const showStickers = !!showStickersProp && stickerPanelOn;
  const showGifs = !!showGifsProp && stickerPanelOn;
  const rich = useMemo(() => _richStickers(), []);

  const NativeView = useMemo(() => {
    const m = _nativeModule();
    return m && m.getNativeEmojiPanelView ? m.getNativeEmojiPanelView() : null;
  }, []);
  if (!NativeView) throw new Error('ChatyyEmojiPanel view unavailable');

  const cbRef = useRef(props);
  cbRef.current = props;
  const nativeRef = useRef(null);
  const [compact, setCompact] = useState(false);
  const [mounted, setMounted] = useState(!!visible);
  const searchFocusedRef = useRef(false);

  useEffect(() => {
    if (visible) { setMounted(true); return undefined; }
    const tm = setTimeout(() => setMounted(false), 260);
    try { nativeRef.current?.resetSearch?.()?.catch?.(() => {}); } catch {}
    setCompact(false);
    return () => clearTimeout(tm);
  }, [visible]);

  // Avisa a tela quando o painel já está montado (ela derruba o teclado AGORA:
  // o painel cresce enquanto o teclado desce, sem frame com os dois/nenhum).
  useEffect(() => {
    if (!visible || !mounted) return undefined;
    let raf = null;
    try {
      raf = requestAnimationFrame(() => { raf = null; try { cbRef.current.onShown?.(); } catch {} });
    } catch {
      try { cbRef.current.onShown?.(); } catch {}
    }
    return () => { if (raf != null) { try { cancelAnimationFrame(raf); } catch {} } };
  }, [visible, mounted]);

  // Busca do painel: compacto enquanto o teclado (da busca) estiver aberto.
  useEffect(() => {
    if (!compact) return undefined;
    const sub = Keyboard.addListener('keyboardDidHide', () => {
      if (!searchFocusedRef.current) setCompact(false);
    });
    return () => { try { sub.remove(); } catch {} };
  }, [compact]);

  const stickersOn = mounted && showStickers;
  const gifsOn = mounted && showGifs && tab === 'gif';
  const { sections, loadPack, pushRecent } = useStickerSections(stickersOn && tab === 'stickers', t, rich);
  const { gifs, loading: gifLoading, load: loadGifs, getGif } = useGifs(gifsOn);

  const themeKey = JSON.stringify([isDark, colors?.text, colors?.textSecondary]);
  const theme = useMemo(() => ({
    dark: !!isDark,
    background: _pc(isDark ? '#0b0b0b' : '#ffffff'),
    surface: _pc(isDark ? '#1c1c1e' : '#f0f0f2'),
    text: _pc(isDark ? '#f2f2f7' : '#111111'),
    secondaryText: _pc(colors?.textSecondary || (isDark ? '#a1a1a6' : '#6e6e73')),
    icon: _pc(isDark ? '#a1a1a6' : '#6e6e73'),
    iconActive: _pc(isDark ? '#ffffff' : '#111111'),
    accent: _pc(isDark ? '#ffffff' : '#111111'),
    hairline: _pc(isDark ? '#262628' : 'rgba(0,0,0,0.10)'),
    selection: _pc(isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.07)'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [themeKey]);

  const labels = useMemo(() => ({
    emoji: _tr(t, 'chat.npanel.emoji', 'Emoji'),
    stickers: _tr(t, 'chatConv.stickers', 'Figurinhas'),
    gif: 'GIF',
    search: _tr(t, 'chat.npanel.searchEmoji', 'Buscar emoji'),
    gifSearch: _tr(t, 'gif.search', 'Buscar GIF'),
    noResults: _tr(t, 'chat.npanel.noResults', 'Nenhum resultado'),
    recent: _tr(t, 'chat.npanel.recent', 'Recentes'),
    favorites: _tr(t, 'chat.npanel.favorites', 'Favoritas'),
    mine: _tr(t, 'chat.npanel.mine', 'Minhas'),
    backspace: _tr(t, 'chat.npanel.backspace', 'Apagar'),
    more: _tr(t, 'common.more', 'Mais'),
    cat0: _tr(t, 'chat.npanel.catSmileys', 'Smileys e pessoas'),
    cat1: _tr(t, 'chat.npanel.catAnimals', 'Animais e natureza'),
    cat2: _tr(t, 'chat.npanel.catFood', 'Comidas e bebidas'),
    cat3: _tr(t, 'chat.npanel.catActivity', 'Atividades'),
    cat4: _tr(t, 'chat.npanel.catTravel', 'Viagens e lugares'),
    cat5: _tr(t, 'chat.npanel.catObjects', 'Objetos'),
    cat6: _tr(t, 'chat.npanel.catSymbols', 'Símbolos'),
    cat7: _tr(t, 'chat.npanel.catFlags', 'Bandeiras'),
  }), [t]);

  const _onEmoji = useCallback((e) => {
    const s = String(e?.nativeEvent?.emoji || '');
    if (s) { try { cbRef.current.onEmoji?.(s); } catch {} }
  }, []);
  const _onBackspace = useCallback(() => { try { cbRef.current.onBackspace?.(); } catch {} }, []);
  const _onSticker = useCallback((e) => {
    const key = String(e?.nativeEvent?.key || '');
    if (!key) return;
    pushRecent(key);
    const api = require('../../services/api');
    const toSend = _resolve(api, key) || String(e?.nativeEvent?.uri || '');
    // Lottie (mascote / .json) vai como lottie_sticker (bolha toca a animação).
    const lottie = !!e?.nativeEvent?.lottie || _isLottie(key);
    try { cbRef.current.onSendSticker?.(toSend, lottie ? 'lottie_sticker' : undefined); } catch {}
  }, [pushRecent]);
  const _onGif = useCallback((e) => {
    const g = getGif(String(e?.nativeEvent?.key || ''));
    if (!g) return;
    // [2026-10-19 sticker-cache] recente por conta + prévia e o arquivo ENVIADO
    // (medium) no disco — antes baixava o original gigante (g.url).
    let _disk = false;
    try { const st = _stk(); if (st) { st.pushGifRecent(g); _disk = st.stickerCacheOn(); } } catch {}
    if (!_disk) { try { const sent = g.medium || g.tiny || g.url; if (sent) require('../../services/mediaCache').cacheMedia(sent).catch(() => {}); } catch {} }
    try { cbRef.current.onSendGif?.(g); } catch {}
  }, [getGif]);
  const _onGifQuery = useCallback((e) => { loadGifs(String(e?.nativeEvent?.query || '')); }, [loadGifs]);
  const _onSection = useCallback((e) => { loadPack(String(e?.nativeEvent?.key || '')); }, [loadPack]);
  const _onTabChange = useCallback((e) => {
    const tb = String(e?.nativeEvent?.tab || 'emoji');
    try { cbRef.current.onTabChange?.(tb); } catch {}
  }, []);
  const _onMore = useCallback(() => { try { cbRef.current.onOpenStickerManager?.(); } catch {} }, []);
  const _onSearchFocus = useCallback((e) => {
    const f = !!e?.nativeEvent?.focused;
    searchFocusedRef.current = f;
    if (f) setCompact(true);
    // ao perder o foco: continua compacto até o teclado terminar de descer
    // (keyboardDidHide acima) — o painel cresce junto com o teclado.
    else {
      let open = false;
      try { open = !!Keyboard.isVisible?.(); } catch {}
      if (!open) setCompact(false);
    }
    try { cbRef.current.onSearchFocusChange?.(f); } catch {}
  }, []);

  if (!mounted) return null;

  const fullHeight = Math.max(200, getPanelKeyboardHeight(insetBottom, windowHeight) - composerGap);
  const compactHeight = compact ? ((tab === 'gif' ? COMPACT_GIF : COMPACT_EMOJI) + Math.max(0, composerPad)) : 0;
  // compacto: a faixa de baixo (composerPad) fica atrás do teclado — o nativo a desconta.
  const panelBottom = compact ? Math.max(0, composerPad) : Math.max(0, insetBottom);

  return (
    <PanelShell visible={!!visible} fullHeight={fullHeight} compactHeight={compactHeight} composerPad={composerPad} background={isDark ? '#0b0b0b' : '#ffffff'}>
      <NativeView
        ref={nativeRef}
        style={{ height: compact ? compactHeight : fullHeight, width: '100%' }}
        theme={theme}
        labels={labels}
        tab={tab}
        bottomInset={panelBottom}
        compact={compact}
        showStickers={!!showStickers}
        showGifs={!!showGifs}
        stickerSections={sections}
        gifs={gifs}
        gifLoading={gifLoading}
        {...(rich ? { richStickers: true } : null)}
        onEmoji={_onEmoji}
        onBackspace={_onBackspace}
        onSticker={_onSticker}
        onGif={_onGif}
        onGifQuery={_onGifQuery}
        onSection={_onSection}
        onTabChange={_onTabChange}
        onMore={_onMore}
        onSearchFocus={_onSearchFocus}
      />
    </PanelShell>
  );
}

export default function NativeEmojiPanel(props) {
  return (
    <NativeEmojiBoundary onFatal={props.onFatal}>
      <NativeEmojiPanelInner {...props} />
    </NativeEmojiBoundary>
  );
}

// ── Texto: inserir / apagar no cursor ───────────────────────────────────────
let _graphemeRe = null;
try {
  // Hermes ≥ 0.12 tem \p{…} com /u; sem suporte cai no Array.from abaixo.
  // eslint-disable-next-line prefer-regex-literals
  _graphemeRe = new RegExp('(?:\\p{RI}\\p{RI}|\\p{Extended_Pictographic}(?:\\uFE0F|\\p{EMod})?(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\p{EMod})?)*(?:\\uFE0F)?|[\\s\\S])$', 'u');
} catch { _graphemeRe = null; }

/** Remove o último "caractere visível" (emoji inteiro com ZWJ/tom/bandeira) antes do cursor. */
export function deleteBackward(text, sel) {
  const s = String(text || '');
  let start = Math.max(0, Math.min(s.length, Number(sel?.start ?? s.length)));
  let end = Math.max(start, Math.min(s.length, Number(sel?.end ?? start)));
  if (end > start) return { text: s.slice(0, start) + s.slice(end), cursor: start };
  if (start === 0) return { text: s, cursor: 0 };
  const before = s.slice(0, start);
  let cut = 1;
  try {
    const m = _graphemeRe ? before.match(_graphemeRe) : null;
    if (m && m[0]) cut = m[0].length;
    else {
      const arr = Array.from(before);
      cut = (arr[arr.length - 1] || ' ').length;
    }
  } catch {
    cut = 1;
  }
  const ns = start - cut;
  return { text: s.slice(0, ns) + s.slice(end), cursor: ns };
}

/** Insere `emoji` na seleção atual. */
export function insertAtSelection(text, sel, emoji) {
  const s = String(text || '');
  const start = Math.max(0, Math.min(s.length, Number(sel?.start ?? s.length)));
  const end = Math.max(start, Math.min(s.length, Number(sel?.end ?? start)));
  const ns = s.slice(0, start) + emoji + s.slice(end);
  return { text: ns, cursor: start + emoji.length };
}
