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

function gridModule() {
  if (_gridMod !== undefined) return _gridMod;
  _gridMod = null;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    const { requireOptionalNativeModule } = require('expo-modules-core');
    const m = requireOptionalNativeModule('ChatyyPhotosGrid');
    if (m && typeof m.apiVersion === 'function' && Number(m.apiVersion()) >= 1) _gridMod = m;
  } catch { _gridMod = null; }
  return _gridMod;
}

export function isNativePhotosGridAvailable() {
  try { if (globalThis.__chatyy_native_photos === false) return false; } catch {}
  return !!gridModule();
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

const NativePhotosGrid = forwardRef(function NativePhotosGrid(props, ref) {
  const {
    colors = {}, isDark = false, t, locale = 'pt-BR', insetTop = 0, insetBottom = 0,
    userEmail = '', backupEnabled = false, includeLocal = true, zoomLevel,
    onSelectionChange, onSelectionMode, onZoomChange, onFail, onReady: onReadyProp, onPermissionNeeded,
    style,
  } = props;
  const V = NativeView();
  const viewRef = useRef(null);
  const aliveRef = useRef(true);
  const readyRef = useRef(false);
  const readyWaiters = useRef([]);
  const whenReady = useCallback(() => (readyRef.current ? Promise.resolve() : new Promise((r) => readyWaiters.current.push(r))), []);
  const failedRef = useRef(false);
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => () => { aliveRef.current = false; }, []);

  const tr = useCallback((k, fb) => {
    try { const v = typeof tRef.current === 'function' ? tRef.current(k) : null; return v && v !== k ? v : fb; } catch { return fb; }
  }, []);

  const fail = useCallback((why) => {
    if (failedRef.current) return;
    failedRef.current = true;
    try { onFail && onFail(why); } catch {}
  }, [onFail]);

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
    if (!V || !userEmail) return undefined;
    let alive = true;
    const isAlive = () => alive && aliveRef.current;
    // só depois do 1º onReady (as AsyncFunctions da view precisam dela montada)
    whenReady().then(() => {
      if (!isAlive()) return;
      loadCloudIndex(userEmail, (items, replace) => { call('setCloudItems', items, !!replace); }, isAlive).catch(() => {});
    });
    return () => { alive = false; };
  }, [V, userEmail, call, whenReady]);

  // ─── status de backup ─────────────────────────────────────────────────
  useEffect(() => {
    if (!V) return undefined;
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
  }, [V, call, userEmail, whenReady]);

  // ─── visualizador nativo ──────────────────────────────────────────────
  const openViewer = useCallback(async (e) => {
    let NV = null;
    try { const m = require('../../modules/expo-media-viewer'); if (m.isAvailable()) NV = m; } catch {}
    if (!NV) return;
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
    if (d.permission === 'notDetermined' && onPermissionNeeded) {
      Promise.resolve(onPermissionNeeded()).then((granted) => { if (granted) call('reloadLocal'); }).catch(() => {});
    }
    try { onReadyProp && onReadyProp(d); } catch {}
  }, [call, onPermissionNeeded, onReadyProp]);

  const onPress = useCallback((e) => { openViewer((e && e.nativeEvent) || {}); }, [openViewer]);
  const onSel = useCallback((e) => { const d = (e && e.nativeEvent) || {}; onSelectionChange && onSelectionChange(d.count || 0, d.keys || []); }, [onSelectionChange]);
  const onSelMode = useCallback((e) => { onSelectionMode && onSelectionMode(!!(e && e.nativeEvent && e.nativeEvent.active)); }, [onSelectionMode]);
  const onZoom = useCallback((e) => { onZoomChange && onZoomChange(e && e.nativeEvent ? e.nativeEvent.level : 3); }, [onZoomChange]);
  const onErr = useCallback(() => fail('native_error'), [fail]);

  useImperativeHandle(ref, () => ({
    setSelectionMode: (on) => call('setSelectionMode', !!on),
    clearSelection: () => call('clearSelection'),
    selectAll: () => call('selectAll'),
    getSelection: () => call('getSelection'),
    scrollToTop: (animated = true) => call('scrollToTop', !!animated),
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

  if (!V) return null;
  return (
    <V
      ref={viewRef}
      style={[styles.fill, style]}
      theme={theme}
      dark={!!isDark}
      locale={locale}
      labels={labels}
      contentInsetTop={insetTop}
      contentInsetBottom={insetBottom}
      includeLocal={!!includeLocal}
      backupEnabled={!!backupEnabled}
      showBadges
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

export default NativePhotosGrid;
