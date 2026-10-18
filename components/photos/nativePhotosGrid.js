// components/photos/nativePhotosGrid.js — [2026-10-15 photos-native]
//
// Wrapper React da grade de Fotos NATIVA (view `ChatyyPhotosGrid`, que mora em
// modules/expo-media-viewer: iOS UICollectionView com layout analítico,
// Android RecyclerView + GridLayoutManager).
//
// O nativo enumera SOZINHO as fotos/vídeos do aparelho (nada de 30k itens na
// ponte). Daqui vão só:
//   • itens da NUVEM (drive_photos_index, compacto, URLs assinadas — a mídia
//     do Drive é privada no CDN): { id, n, t, w, h, v, u, f, x };
//   • status de backup por item: snapshot do motor nativo (expo-photos-backup)
//     ou, no fluxo antigo, o mapa @chatyy_backup/backed_up_map;
//   • tema, idioma, rótulos, insets.
// Toque → visualizador nativo (expo-media-viewer) com hero a partir da célula.
//
// Contrato completo (props/eventos/funções): ver cabeçalho de
// modules/expo-media-viewer/ios/PGGridView.swift e o SPEC no relatório.
// Kill switch OTA/console: globalThis.__chatyy_native_photos = false → a tela
// usa a SectionList JS de sempre. Erro nativo/sem onReady em 4 s → idem.
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { Platform, StyleSheet } from 'react-native';

let _NativeView;
let _gridMod;
let _gridApi = 0;
// [2026-10-15 photos-flicker] apiVersion 1 (build 692) recarregava a grade inteira
// (reloadData) a cada aviso de metadados do Fotos/iCloud — o backup baixando
// originais dispara vários por segundo → miniaturas "piscando". A correção é
// nativa (apiVersion 2). Com binário v1 a tela usa a lista JS de sempre;
// globalThis.__chatyy_native_photos = true força a grade v1 (QA).
const MIN_GRID_API = 2;

function gridModule() {
  if (_gridMod !== undefined) return _gridMod;
  _gridMod = null;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    const { requireOptionalNativeModule } = require('expo-modules-core');
    const m = requireOptionalNativeModule('ChatyyPhotosGrid');
    if (m && typeof m.apiVersion === 'function') {
      _gridApi = Number(m.apiVersion()) || 0;
      if (_gridApi >= 1) _gridMod = m;
    }
  } catch { _gridMod = null; }
  return _gridMod;
}

/**
 * [2026-10-18 photos-native-always] Grade com LISTA ARBITRÁRIA vinda do JS (prop
 * `items`: busca, favoritos, filtros/memórias, aba Fotos do Drive). Já funciona com
 * a API atual (includeLocal=false + setCloudItems); só a miniatura de arquivo do
 * aparelho (file:// / content://) no Android precisa da apiVersion 3.
 * Kill switch OTA/console: globalThis.__chatyy_photos_native_always = false.
 */
export function isNativePhotosDatasetAvailable(hasDeviceFiles = false) {
  try { if (globalThis.__chatyy_photos_native_always === false) return false; } catch {}
  if (!isNativePhotosGridAvailable()) return false;
  if (hasDeviceFiles && Platform.OS === 'android') return _gridApi >= 3;
  return true;
}

export function isNativePhotosGridAvailable() {
  let force = false;
  try {
    if (globalThis.__chatyy_native_photos === false) return false;
    force = globalThis.__chatyy_native_photos === true;
  } catch {}
  if (!gridModule()) return false;
  return force || _gridApi >= MIN_GRID_API;
}

function NativeView() {
  if (_NativeView !== undefined) return _NativeView;
  _NativeView = null;
  try {
    const expo = require('expo');
    _NativeView = expo.requireNativeView('ChatyyPhotosGrid');
  } catch { _NativeView = null; }
  return _NativeView;
}

// ─── índice da nuvem (cache em memória por conta + sig) ───────────────────
const _cloudCache = new Map(); // email → { sig, at, items }
const CLOUD_TTL_MS = 6 * 3600 * 1000; // URLs assinadas valem 24–30 h

function rowToItem(r) {
  // [id, nome, t(ms), w, h, video, thumb, full, indisponível]
  return {
    id: r[0], n: r[1] || '', t: Number(r[2]) || 0, w: r[3] || 0, h: r[4] || 0,
    v: r[5] === 1 || r[5] === true, u: r[6] || '', f: r[7] || '', x: r[8] === 1 || r[8] === true,
  };
}

function legacyFileToItem(p) {
  const isVideo = p.icon_type === 'video' || p.media_type === 'video';
  const t = Date.parse(p.taken_at || p.created_at || p.uploaded_at || '') || 0;
  const full = p.cdn_url || p.stream_url || '';
  let thumb = p.thumbnail_url || '';
  if (isVideo && thumb === full) thumb = ''; // a URL do vídeo não serve de miniatura
  return { id: p.id, n: p.name || '', t, w: p.width || 0, h: p.height || 0, v: isVideo, u: thumb, f: full !== thumb ? full : '', x: !!p.unavailable };
}

/**
 * Carrega o índice da nuvem em páginas; `onChunk(items, replace)` a cada página.
 * Servidor sem drive_photos_index (fallback) → drive_photos paginado (até 2000).
 */
async function loadCloudIndex(email, onChunk, isAlive) {
  const api = require('../../services/api');
  const cached = _cloudCache.get(email);
  let first;
  try { first = await api.apiCall('drive_photos_index', { cursor: 0, limit: 1000 }); } catch { first = null; }
  if (!isAlive()) return;
  const d = first && first.success ? first.data : null;
  if (!d || !Array.isArray(d.rows)) {
    // fallback: servidor antigo
    let all = [];
    for (let page = 1; page <= 10; page++) {
      let r;
      try { r = await api.filePhotos('all', page, 200); } catch { r = null; }
      if (!isAlive()) return;
      const files = r?.data?.files || r?.files || [];
      const items = files.map(legacyFileToItem);
      all = all.concat(items);
      onChunk(items, page === 1);
      if (files.length < 200) break;
    }
    _cloudCache.set(email, { sig: '', at: Date.now(), items: all });
    return;
  }
  if (cached && cached.sig && cached.sig === d.sig && Date.now() - cached.at < CLOUD_TTL_MS) {
    onChunk(cached.items, true);
    return;
  }
  let all = d.rows.map(rowToItem);
  onChunk(all, true);
  let cursor = d.next_cursor || 0;
  let guard = 0;
  while (cursor > 0 && guard++ < 200) {
    let r;
    try { r = await api.apiCall('drive_photos_index', { cursor, limit: 2000 }); } catch { r = null; }
    if (!isAlive()) return;
    const dd = r && r.success ? r.data : null;
    if (!dd || !Array.isArray(dd.rows)) break;
    const items = dd.rows.map(rowToItem);
    all = all.concat(items);
    onChunk(items, false);
    cursor = dd.next_cursor || 0;
  }
  _cloudCache.set(email, { sig: d.sig || '', at: Date.now(), items: all });
}

export function invalidateCloudIndex(email) {
  if (email) _cloudCache.delete(email); else _cloudCache.clear();
}

// ─── status de backup ─────────────────────────────────────────────────────
async function loadLegacyBackedUp() {
  try {
    const bs = require('../../services/backup/backupStorage');
    const m = await bs.getBackedUpMap();
    return m && typeof m === 'object' ? Object.keys(m) : [];
  } catch { return []; }
}

function hexColor(c, fallback) {
  if (typeof c !== 'string') return fallback;
  const s = c.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s) || /^#[0-9a-fA-F]{8}$/.test(s)) return s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) return '#' + s.slice(1).split('').map((x) => x + x).join('');
  return fallback;
}


// [2026-10-16 motion] Kill switches __chatyy_motion_* do pacote de mídia (check em mola).
function _syncMotion() {
  try { require('../../modules/expo-media-viewer/motion').syncMotion(); } catch {}
}

const NativePhotosGridInner = forwardRef(function NativePhotosGrid(props, ref) {
  useEffect(() => { if (Platform.OS === 'ios' || Platform.OS === 'android') _syncMotion(); }, []);
  const {
    colors = {}, isDark = false, t, locale = 'pt-BR', insetTop = 0, insetBottom = 0,
    userEmail = '', backupEnabled = false, includeLocal = true, zoomLevel,
    onSelectionChange, onSelectionMode, onZoomChange, onFail, onReady: onReadyProp, onPermissionNeeded,
    style,
    // [2026-10-18 photos-native-always] modo LISTA: itens compactos { id, n, t, w, h, v, d, u, f, x }
    // (u = miniatura https/ph:///file://; f = original). Sem nuvem/selos/aparelho próprios.
    items, onItemPress,
  } = props;
  const dataset = Array.isArray(items);
  const V = NativeView();
  const viewRef = useRef(null);
  const aliveRef = useRef(true);
  const readyRef = useRef(false);
  const readyWaiters = useRef([]);
  const whenReady = useCallback(() => (readyRef.current ? Promise.resolve() : new Promise((r) => readyWaiters.current.push(r))), []);
  const failedRef = useRef(false);
  const tRef = useRef(t);
  tRef.current = t;
  // [2026-10-15 photos-flicker] callbacks do pai (arrows novas a cada render) via ref:
  // handlers da view ficam estáveis e o React.memo abaixo corta re-render da view
  // nativa quando a tela re-renderiza (progresso do backup etc.).
  const cbRef = useRef({});
  cbRef.current = { onSelectionChange, onSelectionMode, onZoomChange, onFail, onReadyProp, onPermissionNeeded, onItemPress };
  const askedPermRef = useRef(false);
  const openingRef = useRef(false);

  useEffect(() => () => { aliveRef.current = false; }, []);

  const tr = useCallback((k, fb) => {
    try { const v = typeof tRef.current === 'function' ? tRef.current(k) : null; return v && v !== k ? v : fb; } catch { return fb; }
  }, []);

  const fail = useCallback((why) => {
    if (failedRef.current) return;
    failedRef.current = true;
    try { const f = cbRef.current.onFail; f && f(why); } catch {}
  }, []);

  // sem onReady em 4 s → JS assume (binário quebrado/sem a view)
  useEffect(() => {
    const tm = setTimeout(() => { if (!readyRef.current) fail('no_ready'); }, 4000);
    return () => clearTimeout(tm);
  }, [fail]);

  const call = useCallback((fn, ...args) => {
    const v = viewRef.current;
    if (!v || typeof v[fn] !== 'function') return Promise.resolve(null);
    try { const r = v[fn](...args); return r && r.then ? r.catch(() => null) : Promise.resolve(r); } catch { return Promise.resolve(null); }
  }, []);

  // ─── nuvem ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!V || !userEmail || dataset) return undefined;
    let alive = true;
    const isAlive = () => alive && aliveRef.current;
    // só depois do 1º onReady (as AsyncFunctions da view precisam dela montada)
    whenReady().then(() => {
      if (!isAlive()) return;
      loadCloudIndex(userEmail, (items, replace) => { call('setCloudItems', items, !!replace); }, isAlive).catch(() => {});
    });
    return () => { alive = false; };
  }, [V, userEmail, call, whenReady, dataset]);

  // ─── modo lista (dataset) ─────────────────────────────────────────────
  useEffect(() => {
    if (!V || !dataset) return undefined;
    let alive = true;
    whenReady().then(() => { if (alive && aliveRef.current) call('setCloudItems', items, true); });
    return () => { alive = false; };
  }, [V, dataset, items, call, whenReady]);

  // ─── status de backup ─────────────────────────────────────────────────
  useEffect(() => {
    if (!V || dataset) return undefined;
    let alive = true;
    let unsub = () => {};
    let pending = { cloud: [], uploading: [], pending: [], failed: [] };
    let flushTm = null;
    const flush = () => {
      flushTm = null;
      const p = pending;
      pending = { cloud: [], uploading: [], pending: [], failed: [] };
      if (p.cloud.length + p.uploading.length + p.pending.length + p.failed.length) call('setStatuses', p, false);
    };
    (async () => {
      await whenReady();
      if (!alive) return;
      let pbn = null;
      try { pbn = require('../../services/photosBackupNative'); } catch {}
      if (pbn && pbn.nativeBackupOwns()) {
        const snap = await pbn.getNativeSnapshot();
        if (!alive) return;
        if (snap) call('setStatuses', snap, true);
        unsub = pbn.subscribeNative((ev, e) => {
          if (ev !== 'onItem' || !e || !e.localId) return;
          const k = e.state === 'cloud' ? 'cloud' : (e.state === 'uploading' ? 'uploading' : (e.state === 'failed' ? 'failed' : 'pending'));
          pending[k].push(String(e.localId));
          if (!flushTm) flushTm = setTimeout(flush, 300);
        });
      } else {
        const ids = await loadLegacyBackedUp();
        if (!alive) return;
        call('setStatuses', { cloud: ids }, true);
      }
    })();
    return () => { alive = false; unsub(); if (flushTm) clearTimeout(flushTm); };
  }, [V, call, userEmail, whenReady, dataset]);

  // ─── visualizador nativo ──────────────────────────────────────────────
  const openViewer = useCallback(async (e) => {
    let NV = null;
    try { const m = require('../../modules/expo-media-viewer'); if (m.isAvailable()) NV = m; } catch {}
    if (!NV) return;
    // toque duplo/rápido abria 2 viewers (o 1º fechado "em silêncio" no meio da
    // apresentação) → um por vez.
    if (openingRef.current) return;
    openingRef.current = true;
    setTimeout(() => { openingRef.current = false; }, 700);
    const idx = Number(e.index) || 0;
    const from = Math.max(0, idx - 150);
    const win = (await call('getItems', from, 300)) || [];
    const start = win.findIndex((x) => x.key === e.key);
    if (start < 0 || win.length === 0) return;
    const items = win.map((x) => ({
      uri: x.uri || '',
      thumbUri: x.thumbUri || '',
      type: x.type === 'video' ? 'video' : 'image',
      messageId: x.key,
      createdAt: x.createdAt,
      width: x.width || 0,
      height: x.height || 0,
    }));
    const sid = await NV.open({
      items,
      index: start,
      labels: {
        close: tr('nativeViewer.close'), share: tr('nativeViewer.share'), save: tr('nativeViewer.save'),
        play: tr('nativeViewer.play'), pause: tr('nativeViewer.pause'),
        loadFailed: tr('nativeViewer.loadFailed'), retry: tr('nativeViewer.retry'),
      },
      allowShare: true,
      allowSave: true,
      allowForward: false,
      allowStar: false,
      ...(e.frame ? { sourceRect: e.frame, sourceRadius: 0 } : {}),
    });
    if (!sid) return;
    const subs = [];
    const same = (ev) => ev && ev.session === sid;
    const cleanup = () => subs.forEach((s) => { try { s.remove(); } catch {} });
    subs.push(NV.addListener('onIndexChange', async (ev) => {
      if (!same(ev)) return;
      const it = win[ev.index];
      if (!it) return;
      call('scrollToKey', it.key, false);
      setTimeout(async () => {
        const r = await call('frameForKey', it.key);
        NV.setReturnRect(ev.index, r || null, 0);
      }, 60);
    }));
    subs.push(NV.addListener('onAction', async (ev) => {
      if (!same(ev)) return;
      const it = win[ev.index];
      if (!it) return;
      if (ev.action === 'share') {
        NV.setActionState('share', 'busy');
        try { await shareGridItem(it); } catch {}
        NV.setActionState('share', 'idle');
      } else if (ev.action === 'save') {
        NV.setActionState('save', 'busy');
        let ok = false;
        try { ok = await saveGridItem(it); } catch {}
        NV.setActionState('save', ok ? 'done' : 'idle');
      }
    }));
    subs.push(NV.addListener('onClose', (ev) => { if (same(ev)) cleanup(); }));
  }, [call, tr]);

  // ─── eventos da view ──────────────────────────────────────────────────
  const onReady = useCallback((e) => {
    if (!readyRef.current) {
      readyRef.current = true;
      const w = readyWaiters.current; readyWaiters.current = [];
      w.forEach((r) => { try { r(); } catch {} });
    }
    const d = (e && e.nativeEvent) || {};
    const cb = cbRef.current;
    // pede a permissão UMA vez por montagem (onReady chega a cada recarga; antes
    // podia virar laço pedir→recarregar→onReady→pedir)
    if (d.permission === 'notDetermined' && cb.onPermissionNeeded && !askedPermRef.current) {
      askedPermRef.current = true;
      Promise.resolve(cb.onPermissionNeeded()).then((granted) => { if (granted) call('reloadLocal'); }).catch(() => {});
    }
    try { cb.onReadyProp && cb.onReadyProp(d); } catch {}
  }, [call]);

  const onPress = useCallback((e) => {
    const d = (e && e.nativeEvent) || {};
    const f = cbRef.current.onItemPress;
    if (f) { try { f(d); } catch {} return; }
    openViewer(d);
  }, [openViewer]);
  const onSel = useCallback((e) => { const d = (e && e.nativeEvent) || {}; const f = cbRef.current.onSelectionChange; f && f(d.count || 0, d.keys || []); }, []);
  const onSelMode = useCallback((e) => { const f = cbRef.current.onSelectionMode; f && f(!!(e && e.nativeEvent && e.nativeEvent.active)); }, []);
  const onZoom = useCallback((e) => { const f = cbRef.current.onZoomChange; f && f(e && e.nativeEvent ? e.nativeEvent.level : 3); }, []);
  const onErr = useCallback(() => fail('native_error'), [fail]);

  useImperativeHandle(ref, () => ({
    setSelectionMode: (on) => call('setSelectionMode', !!on),
    clearSelection: () => call('clearSelection'),
    selectAll: () => call('selectAll'),
    getSelection: () => call('getSelection'),
    scrollToTop: (animated = true) => call('scrollToTop', !!animated),
    scrollToKey: (key, animated = false) => call('scrollToKey', String(key), !!animated),
    frameForKey: (key) => call('frameForKey', String(key)),
    reloadLocal: () => call('reloadLocal'),
    reloadCloud: () => {
      invalidateCloudIndex(userEmail);
      return loadCloudIndex(userEmail, (items, replace) => { call('setCloudItems', items, !!replace); }, () => aliveRef.current);
    },
    /** chaves → descritores (para ações em lote da seleção) */
    resolveKeys: async (keys) => {
      const want = new Set(keys || []);
      const out = [];
      if (!want.size) return out;
      for (let from = 0; from < 200000 && out.length < want.size; from += 2000) {
        const chunk = (await call('getItems', from, 2000)) || [];
        if (!chunk.length) break;
        for (const x of chunk) if (want.has(x.key)) out.push(x);
      }
      return out;
    },
  }), [call, userEmail]);

  const theme = useMemo(() => ({
    background: hexColor(colors.background, isDark ? '#000000' : '#FFFFFF'),
    text: hexColor(colors.text, isDark ? '#FFFFFF' : '#111111'),
    textSecondary: hexColor(colors.textSecondary, isDark ? '#A1A1AA' : '#6B7280'),
    accent: hexColor(colors.primary, '#2563EB'),
    header: hexColor(colors.background, isDark ? '#000000' : '#FFFFFF'),
    check: hexColor(colors.primary, '#2563EB'),
  }), [colors.background, colors.text, colors.textSecondary, colors.primary, isDark]);

  const labels = useMemo(() => ({
    today: tr('photosNative.today', 'Hoje'),
    yesterday: tr('photosNative.yesterday', 'Ontem'),
  }), [tr, t]);

  const viewStyle = useMemo(() => [styles.fill, style], [style]);

  if (!V) return null;
  return (
    <V
      ref={viewRef}
      style={viewStyle}
      theme={theme}
      dark={!!isDark}
      locale={locale}
      labels={labels}
      contentInsetTop={insetTop}
      contentInsetBottom={insetBottom}
      includeLocal={dataset ? false : !!includeLocal}
      backupEnabled={dataset ? false : !!backupEnabled}
      showBadges={!dataset}
      {...(zoomLevel != null ? { zoomLevel } : {})}
      onReady={onReady}
      onPress={onPress}
      onSelectionChange={onSel}
      onSelectionMode={onSelMode}
      onZoomChange={onZoom}
      onNativeError={onErr}
    />
  );
});

// ─── ações do viewer ──────────────────────────────────────────────────────
async function localFileFor(it) {
  if (!it || !it.local) return null;
  if (String(it.uri || '').startsWith('content://')) return it.uri;
  try {
    const ML = require('expo-media-library');
    const info = await ML.getAssetInfoAsync(it.localId || String(it.uri || '').replace(/^ph:\/\//, ''));
    return info?.localUri || info?.uri || null;
  } catch { return null; }
}

async function shareGridItem(it) {
  const { shareMediaFile } = require('../../utils/mediaNativeActions');
  if (it.local) {
    const f = await localFileFor(it);
    if (!f) return false;
    const Sharing = require('expo-sharing');
    await Sharing.shareAsync(f);
    return true;
  }
  return shareMediaFile({ url: it.uri, fileName: it.name || '' });
}

/** Salvar na galeria: só faz sentido p/ item que está SÓ na nuvem. Nunca apaga nada. */
async function saveGridItem(it) {
  if (it.local) return true;
  const { ensureLocalFile } = require('../../utils/mediaNativeActions');
  const f = await ensureLocalFile(it.uri, it.name || '');
  if (!f) return false;
  const ML = require('expo-media-library');
  const perm = await ML.requestPermissionsAsync(false);
  if (perm.status !== 'granted') return false;
  await ML.saveToLibraryAsync(f);
  return true;
}

const styles = StyleSheet.create({ fill: { flex: 1 } });

// [2026-10-15 photos-flicker] re-render só quando muda o que a view usa — callbacks
// do pai são lidos por ref (cbRef), então mudança só de função não conta.
const DATA_PROPS = ['colors', 'isDark', 't', 'locale', 'insetTop', 'insetBottom', 'userEmail', 'backupEnabled', 'includeLocal', 'zoomLevel', 'style', 'items'];
function sameGridProps(a, b) {
  for (const k of DATA_PROPS) {
    if (k === 'colors') {
      const x = a.colors || {}, y = b.colors || {};
      if (x !== y && (x.background !== y.background || x.text !== y.text || x.textSecondary !== y.textSecondary || x.primary !== y.primary)) return false;
    } else if (a[k] !== b[k]) return false;
  }
  return true;
}
const NativePhotosGrid = React.memo(NativePhotosGridInner, sameGridProps);

export default NativePhotosGrid;
