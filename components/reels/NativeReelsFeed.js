// components/reels/NativeReelsFeed.js — [2026-10-15 native-reels]
//
// Feed vertical de Reels 100% NATIVO (TikTok-style), view `ChatyyReelsFeed`
// do módulo local modules/expo-reels-feed:
//   iOS     = UICollectionView paginada + pool de 3 AVPlayer (anterior/atual/
//             próximo) com pré-buffer; os 2 seguintes baixados p/ disco.
//   Android = RecyclerView + PagerSnapHelper + pool de 3 ExoPlayer (Media3) +
//             SimpleCache com pré-gravação dos 2 seguintes.
// Gestos nativos: toque = mudo/som, segurar = pausa (tela limpa), duplo toque
// = curtir (coração animado), arrastar a barra fina = buscar. O trilho
// (curtir/comentar/presente/compartilhar/salvar/…) é nativo e só EMITE eventos;
// comentários, presentes, compartilhar e o menu abrem as sheets JS de sempre.
//
// O JS manda DIFFS (applyItems): reset (troca de aba/refresh), append
// (paginação), update (curtidas/contadores/salvo), remove ("não tenho
// interesse") — nunca a lista inteira a cada render.
//
// Desligar (OTA/console): globalThis.__chatyy_native_reels = false
// [2026-10-16 reels-rail-v2] Trilho redesenhado (ícones de linha do app, contadores
// "1,2 mil", "+" seguir animado, disco com capa, "… mais", buffer na barra fina no
// lugar do spinner central) só em binário com apiVersion ≥ 2. Voltar ao trilho
// antigo sem build: globalThis.__chatyy_reels_rail_v2 = false
// Fallback automático p/ a FlatList JS: erro nativo (onNativeError), view que
// não ficou pronta em 3 s, ou crash do processo com o feed montado (2× →
// desliga até a próxima versão do bundle).
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { Platform, StyleSheet } from 'react-native';

const READY_TIMEOUT_MS = 3000;
const CRASH_KEY = 'native_reels_guard_v1';

// ─── disponibilidade ────────────────────────────────────────────────────────
let _viewChecked = false;
let _NativeView = null;
let _sessionDisabled = false;
let _api = 0;

function _getNativeView() {
  if (_viewChecked) return _NativeView;
  _viewChecked = true;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    const expo = require('expo');
    const mod = typeof expo.requireOptionalNativeModule === 'function'
      ? expo.requireOptionalNativeModule('ChatyyReelsFeed')
      : null;
    if (!mod || typeof mod.apiVersion !== 'function') return null;
    let api = 0;
    try { api = Number(mod.apiVersion()) || 0; } catch { api = 0; }
    if (api < 1) return null;
    _api = api;
    // requireNativeView não lança quando a view não existe — confirma pela
    // config registrada no binário (mesma técnica de nativeThreadList).
    const g = globalThis;
    const cfg = g && g.expo && typeof g.expo.getViewConfig === 'function' ? g.expo.getViewConfig('ChatyyReelsFeed') : null;
    if (!cfg) return null;
    _NativeView = expo.requireNativeView('ChatyyReelsFeed');
  } catch {
    _NativeView = null;
  }
  return _NativeView;
}

let _guardChecked = false;
let _guardTripped = false;
function _storage() {
  try { return require('../../services/mmkv'); } catch { return null; }
}
function _bundleTag() {
  try {
    const U = require('expo-updates');
    return String((U && (U.updateId || U.runtimeVersion)) || 'embedded');
  } catch { return 'embedded'; }
}
function _readGuard() {
  const s = _storage();
  if (!s || typeof s.getJSON !== 'function') return null;
  try { return s.getJSON(CRASH_KEY); } catch { return null; }
}
function _writeGuard(v) {
  const s = _storage();
  if (!s || typeof s.setJSON !== 'function') return;
  try { s.setJSON(CRASH_KEY, v); } catch {}
}
function _checkGuardOnce() {
  if (_guardChecked) return _guardTripped;
  _guardChecked = true;
  const tag = _bundleTag();
  const g = _readGuard();
  if (!g || typeof g !== 'object') return false;
  if (g.tag !== tag) { _writeGuard({ tag, crashes: 0, mounted: 0 }); return false; }
  let crashes = Number(g.crashes) || 0;
  if (g.mounted) crashes += 1;
  _writeGuard({ tag, crashes, mounted: 0 });
  _guardTripped = crashes >= 2;
  if (_guardTripped) _beacon('crash_guard', 'crashes=' + crashes);
  return _guardTripped;
}
function _markMounted(on) {
  const tag = _bundleTag();
  const g = _readGuard() || {};
  const crashes = g.tag === tag ? (Number(g.crashes) || 0) : 0;
  _writeGuard({ tag, crashes: on ? crashes : 0, mounted: on ? 1 : 0 });
}

function _beacon(step, info) {
  try {
    require('../../services/nativeTelemetry').nativeBeacon('native_reels', step, info); // [wave7]
  } catch {}
}

/** true quando o binário tem o feed nativo e nada o desligou nesta sessão. */
export function isNativeReelsAvailable() {
  if (_sessionDisabled) return false;
  try { if (globalThis.__chatyy_native_reels === false) return false; } catch {}
  if (!_getNativeView()) return false;
  if (_checkGuardOnce()) return false;
  return true;
}

/** apiVersion do binário (0 = sem feed nativo). */
export function getNativeReelsApi() {
  _getNativeView();
  return _api;
}

/** Trilho v2: binário api ≥ 2 e kill switch não desligado. */
function _railV2() {
  try { if (globalThis.__chatyy_reels_rail_v2 === false) return false; } catch {}
  return _api >= 2;
}

export function disableNativeReelsForSession(reason) {
  if (_sessionDisabled) return;
  _sessionDisabled = true;
  _beacon('disabled', String(reason || ''));
}

// ─── diff ───────────────────────────────────────────────────────────────────
function _sig(it) {
  try { return JSON.stringify(it); } catch { return String(Math.random()); }
}

function _call(view, payload) {
  if (!view || typeof view.applyItems !== 'function') return false;
  try {
    const p = view.applyItems(payload);
    if (p && typeof p.catch === 'function') p.catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Props:
 *   items        [{ id, videoUrl, hlsUrl, thumb, avatar, author, caption, music, credit,
 *                   likes, comments, liked, saved, durationMs, canGift, canFollow,
 *                   commentsDisabled, live, width, height, subtitles,
 *                   shares, saves, verified, musicCover (api ≥ 2) }]  (já normalizados)
 *   resetKey     muda → reset completo (troca de aba / feed por som)
 *   startIndex   índice inicial no reset
 *   muted, paused, rate, captionsEnabled, labels, insets {top,bottom}, imageHeaders,
 *   refreshEnabled, refreshing
 *   onIndexChange(index, id), onLike(e), onSave(e), onComment(id), onGift(id), onShare(id),
 *   onMore(id), onAuthorPress(id), onFollow(id), onMusicPress(id), onCreditPress(id),
 *   onLikersPress(e) (toque no número de curtidas),
 *   onNeedMore(), onViewProgress(e), onMuteChange(muted), onRefresh(), onPlaybackError(id),
 *   onFallback(reason)
 * Ref: play(), pause(), scrollTo(index, animated)
 */
const NativeReelsFeed = forwardRef(function NativeReelsFeed(props, ref) {
  const {
    items, resetKey, startIndex = 0, muted, paused, rate = 1, captionsEnabled = true,
    labels, insets, imageHeaders, refreshEnabled = false, refreshing = false, style,
  } = props;
  const NativeView = _getNativeView();
  const railStyle = _railV2() ? 2 : 1;
  // railStyle viaja dentro de labels (binário v1 ignora a chave → zero risco).
  const mergedLabels = React.useMemo(
    () => (railStyle >= 2 ? { ...(labels || {}), railStyle } : labels),
    [labels, railStyle],
  );
  const viewRef = useRef(null);
  const sentRef = useRef({ key: undefined, ids: [], sigs: new Map() });
  const currentIdRef = useRef(null);
  const readyRef = useRef(false);
  const propsRef = useRef(props);
  propsRef.current = props;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const startRef = useRef(startIndex);
  startRef.current = startIndex;
  const fellBackRef = useRef(false);

  const fallback = useCallback((reason) => {
    if (fellBackRef.current) return;
    fellBackRef.current = true;
    disableNativeReelsForSession(reason);
    try { propsRef.current.onFallback?.(reason); } catch {}
  }, []);

  const flush = useCallback((forceReset) => {
    const view = viewRef.current;
    if (!view) return;
    const list = Array.isArray(itemsRef.current) ? itemsRef.current : [];
    const prev = sentRef.current;
    const ids = list.map((x) => x.id);
    const sigs = new Map();
    for (const it of list) sigs.set(it.id, _sig(it));
    const commit = () => { sentRef.current = { key: propsRef.current.resetKey, ids, sigs }; };

    const sameKey = prev.key === propsRef.current.resetKey;
    if (forceReset || !sameKey || prev.ids.length === 0) {
      let start = Number(startRef.current) || 0;
      if (sameKey && currentIdRef.current != null) {
        const j = ids.indexOf(currentIdRef.current);
        if (j >= 0) start = j;
      }
      if (_call(view, { op: 'reset', items: list, startIndex: start })) commit();
      return;
    }
    // prefixo igual → updates + append
    const isPrefix = ids.length >= prev.ids.length && prev.ids.every((id, i) => ids[i] === id);
    if (isPrefix) {
      const upd = [];
      for (let i = 0; i < prev.ids.length; i++) {
        const it = list[i];
        if (prev.sigs.get(it.id) !== sigs.get(it.id)) upd.push(it);
      }
      let ok = true;
      if (upd.length) ok = _call(view, { op: 'update', items: upd }) && ok;
      if (ids.length > prev.ids.length) ok = _call(view, { op: 'append', items: list.slice(prev.ids.length) }) && ok;
      if (ok) commit();
      return;
    }
    // só remoções (ordem do resto intacta) → remove + updates
    const now = new Set(ids);
    const removed = prev.ids.filter((id) => !now.has(id));
    const remaining = prev.ids.filter((id) => now.has(id));
    if (removed.length && remaining.length === ids.length && remaining.every((id, i) => ids[i] === id)) {
      let ok = _call(view, { op: 'remove', ids: removed });
      const upd = list.filter((it) => prev.sigs.get(it.id) !== sigs.get(it.id));
      if (upd.length) ok = _call(view, { op: 'update', items: upd }) && ok;
      if (ok) commit();
      return;
    }
    // qualquer outra mudança (refresh mesclado, reordenação) → reset mantendo o reel atual
    let start = 0;
    if (currentIdRef.current != null) {
      const j = ids.indexOf(currentIdRef.current);
      if (j >= 0) start = j;
    }
    if (_call(view, { op: 'reset', items: list, startIndex: start })) commit();
  }, []);

  useEffect(() => { flush(false); }, [items, resetKey, flush]);

  // Guarda de crash + timeout de prontidão.
  useEffect(() => {
    _markMounted(true);
    const timer = setTimeout(() => {
      if (!readyRef.current) fallback('ready_timeout');
    }, READY_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
      _markMounted(false);
    };
  }, [fallback]);

  useImperativeHandle(ref, () => ({
    play() { try { viewRef.current?.play?.()?.catch?.(() => {}); } catch {} },
    pause() { try { viewRef.current?.pause?.()?.catch?.(() => {}); } catch {} },
    scrollTo(index, animated = true) {
      try { viewRef.current?.scrollTo?.(Number(index) || 0, !!animated)?.catch?.(() => {}); } catch {}
    },
  }), []);

  const ev = (name) => (e) => {
    const n = e && e.nativeEvent ? e.nativeEvent : {};
    try { propsRef.current[name]?.(n); } catch {}
  };
  const onReady = useCallback(() => {
    readyRef.current = true;
    if (!sentRef.current.ids.length) flush(true);
  }, [flush]);
  const onNativeError = useCallback((e) => {
    fallback('native_error ' + String(e?.nativeEvent?.message || '').slice(0, 200));
  }, [fallback]);
  const onIndexChange = useCallback((e) => {
    const n = e?.nativeEvent || {};
    currentIdRef.current = n.id != null ? String(n.id) : null;
    try { propsRef.current.onIndexChange?.(Number(n.index) || 0, currentIdRef.current); } catch {}
  }, []);
  const onMuteChange = useCallback((e) => {
    try { propsRef.current.onMuteChange?.(!!e?.nativeEvent?.muted); } catch {}
  }, []);

  if (!NativeView) return null;
  return (
    <NativeView
      ref={viewRef}
      style={style || StyleSheet.absoluteFill}
      labels={mergedLabels}
      muted={!!muted}
      paused={!!paused}
      rate={Number(rate) || 1}
      captionsEnabled={!!captionsEnabled}
      insets={insets}
      imageHeaders={imageHeaders || undefined}
      refreshEnabled={!!refreshEnabled}
      refreshing={!!refreshing}
      onReady={onReady}
      onNativeError={onNativeError}
      onIndexChange={onIndexChange}
      onMuteChange={onMuteChange}
      onLike={ev('onLike')}
      onSave={ev('onSave')}
      onComment={ev('onComment')}
      onGift={ev('onGift')}
      onShare={ev('onShare')}
      onMore={ev('onMore')}
      onAuthorPress={ev('onAuthorPress')}
      onFollow={ev('onFollow')}
      onMusicPress={ev('onMusicPress')}
      onCreditPress={ev('onCreditPress')}
      onLikersPress={ev('onLikersPress')}
      onNeedMore={ev('onNeedMore')}
      onViewProgress={ev('onViewProgress')}
      onRefresh={ev('onRefresh')}
      onPlaybackError={ev('onPlaybackError')}
    />
  );
});

export default NativeReelsFeed;
