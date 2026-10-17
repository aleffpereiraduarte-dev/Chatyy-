// components/media/NativeMediaGrid.js — [2026-10-16 native-media-grid]
//
// Wrapper React da grade NATIVA genérica `ChatyyMediaGrid` (mora em
// modules/expo-media-viewer: iOS UICollectionView + MVImageLoader; Android
// RecyclerView + GridLayoutManager + Glide). Usada no perfil (posts/reels/
// lives/mídia — components/Profile.js) e em "Mídia, links e docs"
// (components/MediaGallery.js).
//
// Itens (compactos, montados pelo chamador):
//   { k: chave, u: miniatura (https/file://), vu: URL do vídeo (1º quadro +
//     duração quando não há miniatura), v: é vídeo, tl/tld: chip topo-esq. (+
//     ponto vermelho), tr: 'video'|'play'|'multi' (ícone topo-dir.), bl/blp:
//     texto baixo-esq. (+ ▶), br: chip baixo-dir. (duração), ad: duração
//     automática do vídeo, t: ms (seções por mês), create/cl: bloco "Criar",
//     a: rótulo de acessibilidade }
// Filhos: `header` rola junto acima da grade; `footer` abaixo.
// Seleção: nativa (toque alterna); entre por ref.beginSelection(key) (ex.: no
// onItemLongPress) e saia por ref.clearSelection(). onSelectionChange
// { active, keys, count }.
//
// Gate: binário com o módulo (apiVersion >= 1) e kill switch
// globalThis.__chatyy_native_media_grid !== false. Senão o chamador usa a
// FlatList/FlashList JS de sempre.
import React, { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

const MIN_API = 1;
let _mod;
let _api = 0;
let _View;

function gridModule() {
  if (_mod !== undefined) return _mod;
  _mod = null;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    const { requireOptionalNativeModule } = require('expo-modules-core');
    const m = requireOptionalNativeModule('ChatyyMediaGrid');
    if (m && typeof m.apiVersion === 'function') {
      _api = Number(m.apiVersion()) || 0;
      if (_api >= MIN_API) _mod = m;
    }
  } catch { _mod = null; }
  return _mod;
}

function nativeView() {
  if (_View !== undefined) return _View;
  _View = null;
  if (!gridModule()) return null;
  try {
    const g = globalThis;
    if (g?.expo?.getViewConfig && !g.expo.getViewConfig('ChatyyMediaGrid')) return null;
    _View = require('expo').requireNativeView('ChatyyMediaGrid');
  } catch { _View = null; }
  return _View;
}

export function isNativeMediaGridAvailable() {
  try { if (globalThis.__chatyy_native_media_grid === false) return false; } catch {}
  return !!nativeView();
}

/** "1,2K" / "15K" como no grid JS. */
export function compactCount(n) {
  const v = Number(n) || 0;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}K`;
  return v > 0 ? String(v) : '';
}

export function formatDuration(secs) {
  const d = Math.max(0, Math.round(Number(secs) || 0));
  if (!d) return '';
  if (d >= 3600) return `${Math.floor(d / 3600)}:${String(Math.floor((d % 3600) / 60)).padStart(2, '0')}:${String(d % 60).padStart(2, '0')}`;
  return `${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}`;
}


// [2026-10-16 motion] Kill switches __chatyy_motion_* do pacote de mídia (check em mola).
function _syncMotion() {
  try { require('../../modules/expo-media-viewer/motion').syncMotion(); } catch {}
}

const NativeMediaGrid = forwardRef(function NativeMediaGrid(props, ref) {
  useEffect(() => { if (Platform.OS === 'ios' || Platform.OS === 'android') _syncMotion(); }, []);
  const {
    items, header, footer, style, columns = 3, spacing = 1, radius = 0, sections = false,
    locale, maxContentWidth = 0, contentInsetBottom = 0, theme,
    onItemPress, onItemLongPress, onSelectionChange, onEndReached, onScrollBegin, onReady,
  } = props;
  const NativeView = nativeView();
  const viewRef = useRef(null);
  // callbacks por ref: o nativo recebe funções estáveis (o Fabric reaplica props).
  const cb = useRef({});
  cb.current = { onItemPress, onItemLongPress, onSelectionChange, onEndReached, onScrollBegin, onReady };

  useImperativeHandle(ref, () => ({
    beginSelection: (key) => { try { return viewRef.current?.beginSelection?.(key == null ? null : String(key)); } catch {} return null; },
    clearSelection: () => { try { return viewRef.current?.clearSelection?.(); } catch {} return null; },
    setSelectionMode: (on) => { try { return viewRef.current?.setSelectionMode?.(!!on); } catch {} return null; },
    getSelection: async () => { try { return (await viewRef.current?.getSelection?.()) || []; } catch { return []; } },
    scrollToTop: (animated = true) => { try { return viewRef.current?.scrollToTop?.(!!animated); } catch {} return null; },
  }), []);

  // Lista por função nativa (não prop): re-render do pai (cabeçalho do perfil)
  // não re-serializa os itens; o nativo ainda compara assinatura (sem reload).
  useEffect(() => {
    const v = viewRef.current;
    if (!v || typeof v.setItems !== 'function') return;
    try { const p = v.setItems(Array.isArray(items) ? items : []); p?.catch?.(() => {}); } catch {}
  }, [items, NativeView]);

  const _press = useCallback((e) => { cb.current.onItemPress?.(e?.nativeEvent || {}); }, []);
  const _long = useCallback((e) => { cb.current.onItemLongPress?.(e?.nativeEvent || {}); }, []);
  const _sel = useCallback((e) => { cb.current.onSelectionChange?.(e?.nativeEvent || {}); }, []);
  const _end = useCallback((e) => { cb.current.onEndReached?.(e?.nativeEvent || {}); }, []);
  const _begin = useCallback((e) => { cb.current.onScrollBegin?.(e?.nativeEvent || {}); }, []);
  const _ready = useCallback((e) => { cb.current.onReady?.(e?.nativeEvent || {}); }, []);

  if (!NativeView) return null;
  return (
    <NativeView
      ref={viewRef}
      style={style || styles.fill}
      columns={columns}
      spacing={spacing}
      radius={radius}
      sections={!!sections}
      locale={locale || ''}
      maxContentWidth={maxContentWidth}
      contentInsetBottom={contentInsetBottom}
      theme={theme}
      onItemPress={_press}
      onItemLongPress={_long}
      onSelectionChange={_sel}
      onEndReached={_end}
      onScrollBegin={_begin}
      onReady={_ready}
    >
      {/* 0 = cabeçalho, 1 = rodapé — sempre os dois (índices estáveis). */}
      <View collapsable={false} style={styles.slot}>{header || null}</View>
      <View collapsable={false} style={styles.slot}>{footer || null}</View>
    </NativeView>
  );
});

const styles = StyleSheet.create({
  fill: { flex: 1 },
  slot: { position: 'absolute', top: 0, left: 0, right: 0 },
});

export default memo(NativeMediaGrid);
