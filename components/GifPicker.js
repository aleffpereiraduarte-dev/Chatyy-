import React, { useState, useEffect, useRef, useCallback, memo } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, FlatList, Platform, ActivityIndicator, StyleSheet, ScrollView,
} from 'react-native';
import { haptic } from '../constants/theme';
import { IconX, IconSearch, IconStarFilled } from './Icons';
import * as api from '../services/api';
import { cacheMedia, getLocalUriSyncJs, preCacheUrls } from '../services/mediaCache';
import useIsMounted from '../hooks/useIsMounted';
import { Overlay } from '../constants/theme';
// [2026-10-19 sticker-cache] JSON das buscas (TTL) + recentes/favoritos POR CONTA
// e as prévias no disco durável (LRU) — não mais no store de mídia das conversas.
import * as stkCache from '../services/stickerCache';

import { a11yLabel } from '../utils/a11yLabel'; // [2026-10-20 a11y] rótulos dos botões só-ícone
let ExpoImage = null;
try { ExpoImage = require('expo-image').Image; } catch {}
const Img = ExpoImage || require('react-native').Image;
// [2026-10-13 P2-9] Desktop web (mouse + teclado físico).
const _GIF_DESKTOP_WEB = (() => {
  if (Platform.OS !== 'web') return false;
  try { return !!(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches); } catch { return false; }
})();

const CATEGORIES = [
  { emoji: '😂', q: 'funny' },
  { emoji: '❤️', q: 'love' },
  { emoji: '👍', q: 'thumbs up' },
  { emoji: '😢', q: 'sad' },
  { emoji: '🎉', q: 'celebrate' },
  { emoji: '😮', q: 'shocked' },
  { emoji: '🔥', q: 'fire' },
  { emoji: '👏', q: 'clap' },
  { emoji: '🤣', q: 'lol' },
  { emoji: '💪', q: 'strong' },
];

// Cache GIF results — in-memory Map + persisted to mmkv so it survives app
// restarts. Tenor trending/categories barely change, 6h TTL is fine.
const gifCache = new Map();
const GIF_CACHE_KEY = 'gif_cache_v2';
const GIF_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
try {
  const mmkv = require('../services/mmkv');
  const raw = mmkv.getString?.(GIF_CACHE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    const now = Date.now();
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        if (v && v.ts && (now - v.ts) < GIF_CACHE_TTL_MS && Array.isArray(v.gifs)) {
          gifCache.set(k, v.gifs);
        }
      }
    }
  }
} catch {}
const persistGifCache = () => {
  try {
    const mmkv = require('../services/mmkv');
    const obj = {};
    const now = Date.now();
    for (const [k, gifs] of gifCache.entries()) obj[k] = { ts: now, gifs };
    mmkv.setString?.(GIF_CACHE_KEY, JSON.stringify(obj));
  } catch {}
};
let _persistTimer = null;
const schedulePersist = () => {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => { _persistTimer = null; persistGifCache(); }, 1500);
};

const GifItem = memo(({ item, onSelect, onLongPress, fav, colors }) => {
  // Prefer local file:// URI when mediaCache has downloaded this GIF to disk.
  // Guarantees offline availability + avoids re-downloading across picker opens.
  let localUri = null;
  if (Platform.OS !== 'web') {
    try { localUri = stkCache.getStickerLocalSync(item.preview); } catch {}
    if (!localUri) localUri = getLocalUriSyncJs?.(item.preview) || null;
  }
  const src = localUri || item.preview;
  return (
    <TouchableOpacity
      onPress={() => onSelect(item)}
      onLongPress={onLongPress ? () => onLongPress(item) : undefined}
      delayLongPress={350}
      style={{ width: '33.33%', aspectRatio: 1, padding: 1.5 }}
      activeOpacity={0.7}
    >
      <Img
        source={{ uri: src }}
        style={{ width: '100%', height: '100%', borderRadius: 6, backgroundColor: colors.background }}
        resizeMode="cover"
        {...(ExpoImage ? { cachePolicy: 'memory-disk', recyclingKey: `gif-${item.id}` } : {})}
      />
      {fav ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: 6, right: 6, width: 16, height: 16, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' }}>
          <IconStarFilled size={9} color="#fff" />
        </View>
      ) : null}
    </TouchableOpacity>
  );
});

export default function GifPickerPanel({ onSelect, onClose, colors, t, bottomInset = 0 }) {
  // [2026-10-10] Painel no lugar do teclado: reserva o home indicator embaixo.
  const _bi = Math.max(0, Number(bottomInset) || 0);
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeCategory, setActiveCategory] = useState(null);
  // [2026-10-21 gif-empty] falha de rede sem cache deixava o painel em branco
  // para sempre (sem aviso nem como tentar de novo); busca sem resultado idem.
  const [loadError, setLoadError] = useState(false);
  const lastQRef = useRef('');
  const searchTimeout = useRef(null);
  const inputRef = useRef(null);
  const aliveRef = useIsMounted();
  const reqIdRef = useRef(0);
  // [2026-10-19 sticker-cache] Recentes + favoritos (enviados antes) no topo da
  // aba inicial — abrem na hora (prévia já está no disco).
  const [pinned, setPinned] = useState(() => { try { return stkCache.getGifPinnedList(); } catch { return []; } });
  const [favIds, setFavIds] = useState(() => { try { return new Set(stkCache.getGifFavorites().map(g => String(g.id || g.medium || g.preview))); } catch { return new Set(); } });

  useEffect(() => {
    loadGifs('');
    // Cleanup the debounced search timer on unmount so a delayed
    // loadGifs call can't fire setState after the picker closed
    // (intermittent crash on rapid open/close).
    return () => {
      if (searchTimeout.current) {
        try { clearTimeout(searchTimeout.current); } catch {}
        searchTimeout.current = null;
      }
    };
  }, []);

  const loadGifs = useCallback(async (q) => {
    const myId = ++reqIdRef.current;
    lastQRef.current = q || '';
    setLoadError(false);
    // Check cache first
    const cacheKey = q || '__trending__';
    if (gifCache.has(cacheKey)) {
      setGifs(gifCache.get(cacheKey));
      setLoading(false);
      return;
    }
    // [2026-10-19 sticker-cache] JSON salvo por conta: mostra na hora; vencido
    // (tendências 6 h / buscas 24 h) → revalida em 2º plano sem spinner.
    let _stale = null;
    try { _stale = stkCache.getGifQueryCache(q); } catch {}
    if (_stale && Array.isArray(_stale.gifs) && _stale.gifs.length) {
      setGifs(_stale.gifs);
      gifCache.set(cacheKey, _stale.gifs);
      setLoading(false);
      if (_stale.fresh) return;
    } else {
      setLoading(true);
    }
    try {
      const r = await api.chatSearchGifs(q);
      // Race + unmount guards — descarta resposta velha ou após unmount.
      if (!aliveRef.current || myId !== reqIdRef.current) return;
      if (r.success) {
        // [2026-05-19] Filter out GIFs > 8MB upfront so user never sees them.
        // handleSendGif already blocks oversized sends — this just prevents
        // confusion of "I tapped but it didn't send".
        const MAX_GIF_BYTES = 8 * 1024 * 1024;
        const all = r.data?.gifs || [];
        const results = all.filter(g => {
          const bytes = Number(g?.size || g?.bytes || g?.media_size || 0);
          return bytes === 0 || bytes <= MAX_GIF_BYTES;
        });
        setGifs(results);
        gifCache.set(cacheKey, results);
        try { stkCache.setGifQueryCache(q, results); } catch {}
        // Limit cache size
        if (gifCache.size > 50) {
          const first = gifCache.keys().next().value;
          gifCache.delete(first);
        }
        schedulePersist();
        // Download previews to the app's filesystem via mediaCache. Persists
        // across app restarts. After the batch settles, re-set `gifs` to
        // trigger a re-render so GifItem reads the freshly-indexed local URIs.
        if (Platform.OS !== 'web' && stkCache.stickerCacheOn()) {
          // Prévias da 1ª tela p/ o disco do stickerCache (LRU próprio). Sem
          // re-render no fim: trocar remoto→file:// no meio pisca; vale na próxima.
          try { stkCache.prefetchGifPreviews(results.slice(0, 24)); } catch {}
        } else if (Platform.OS !== 'web') {
          try {
            const urls = results.slice(0, 24).map(g => g.preview).filter(Boolean);
            preCacheUrls(urls).then(() => {
              // Force re-render so local URIs take effect — guard contra unmount.
              if (!aliveRef.current) return;
              setGifs([...results]);
            }).catch(() => {});
            if (ExpoImage?.prefetch) {
              ExpoImage.prefetch(urls, 'memory-disk').catch(() => {});
            }
          } catch {}
        }
      } else if (!(_stale && _stale.gifs && _stale.gifs.length)) {
        setGifs([]);
        setLoadError(true);
      }
    } catch {
      if (aliveRef.current && myId === reqIdRef.current && !(_stale && _stale.gifs && _stale.gifs.length)) {
        setGifs([]);
        setLoadError(true);
      }
    }
    if (aliveRef.current && myId === reqIdRef.current) setLoading(false);
  }, []);

  const handleSearch = useCallback((text) => {
    setQuery(text);
    setActiveCategory(null);
    clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => loadGifs(text), 300);
  }, [loadGifs]);

  const handleCategory = useCallback((cat) => {
    setActiveCategory(cat.q);
    setQuery('');
    loadGifs(cat.q);
  }, [loadGifs]);

  const handleSelect = useCallback((item) => {
    // [2026-10-19 sticker-cache] Recente (por conta) + prévia e o arquivo ENVIADO
    // (medium — é o que a bolha mostra) no disco. Antes baixava o ORIGINAL
    // gigante (item.url), que a conversa nem usa.
    try { stkCache.pushGifRecent(item); } catch {}
    let diskOn = false;
    try { diskOn = stkCache.stickerCacheOn(); } catch {}
    if (!diskOn && Platform.OS !== 'web') {
      const sent = item?.medium || item?.tiny || item?.url;
      if (sent) { try { cacheMedia(sent).catch(() => {}); } catch {} }
    }
    try { setPinned(stkCache.getGifPinnedList()); } catch {}
    onSelect(item);
  }, [onSelect]);
  const handleLongPress = useCallback((item) => {
    try {
      stkCache.toggleGifFavorite(item);
      try { haptic.medium(); } catch {}
      setFavIds(new Set(stkCache.getGifFavorites().map(g => String(g.id || g.medium || g.preview))));
      setPinned(stkCache.getGifPinnedList());
    } catch {}
  }, []);
  // Aba inicial (sem busca/categoria): favoritos + recentes primeiro, depois tendências.
  const showPinned = !query && !activeCategory && pinned.length > 0;
  const gridData = React.useMemo(() => {
    if (!showPinned) return gifs;
    const seen = new Set();
    const out = [];
    for (const g of [...pinned, ...gifs]) {
      const id = String(g?.id || g?.medium || g?.preview || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(g);
    }
    return out;
  }, [showPinned, pinned, gifs]);

  return (
    <View style={{
      height: 320 + _bi, paddingBottom: _bi, backgroundColor: colors.surface,
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
      // [2026-10-12 overlays] mesmo container do StickerPicker (tokens únicos)
      ...(Platform.OS === 'web' ? { borderTopLeftRadius: Overlay.cardRadius, borderTopRightRadius: Overlay.cardRadius, overflow: 'hidden' } : {}),
    }}>
      {/* Search bar */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingTop: 8, paddingBottom: 4, gap: 8 }}>
        <View style={{
          flex: 1, flexDirection: 'row', alignItems: 'center',
          backgroundColor: colors.background, borderRadius: 20, paddingHorizontal: 12,
        }}>
          <IconSearch size={16} color={colors.textTertiary} />
          <TextInput
            ref={inputRef}
            // [2026-10-13 P2-9] Desktop web: digitar com o painel aberto busca GIF.
            autoFocus={_GIF_DESKTOP_WEB}
            placeholder={t('chat.searchGifs') || 'Search GIFs'}
            placeholderTextColor={colors.textTertiary}
            value={query}
            onChangeText={handleSearch}
            style={{ flex: 1, paddingVertical: 8, paddingHorizontal: 8, color: colors.text, fontSize: 14 }}
            autoCorrect={false}
          />
          {query ? (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={a11yLabel('common.clear', 'Limpar')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => { setQuery(''); loadGifs(''); setActiveCategory(null); }}>
              <IconX size={14} color={colors.textTertiary} />
            </TouchableOpacity>
          ) : null}
        </View>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={a11yLabel('common.close', 'Fechar')} onPress={onClose} style={{ padding: 6 }}>
          <IconX size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* Category chips */}
      {/* [2026-10-21] rolagem horizontal: 10 chips não cabiam em tela de 360 pt (os últimos sumiam). */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ flexGrow: 0 }} contentContainerStyle={{ flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 4, gap: 4 }}>
        {CATEGORIES.map((cat) => (
          <TouchableOpacity
            key={cat.q}
            onPress={() => handleCategory(cat)}
            accessibilityRole="button"
            accessibilityState={{ selected: activeCategory === cat.q }}
            accessibilityLabel={cat.q}
            style={{
              paddingHorizontal: 8, paddingVertical: 4, borderRadius: 16,
              backgroundColor: activeCategory === cat.q ? colors.primary + '20' : 'transparent',
              borderWidth: activeCategory === cat.q ? 1 : 0,
              borderColor: colors.primary,
            }}
          >
            <Text style={{ fontSize: 18 }}>{cat.emoji}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* GIF grid */}
      {loading && gridData.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : gridData.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, gap: 10 }}>
          <Text style={{ color: colors.textSecondary, fontSize: 14, textAlign: 'center' }}>
            {loadError
              ? (t?.('chat.gifLoadFailed', 'Não foi possível carregar os GIFs') || 'Não foi possível carregar os GIFs')
              : (t?.('chat.gifNoResults', 'Nenhum GIF encontrado') || 'Nenhum GIF encontrado')}
          </Text>
          {loadError ? (
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => loadGifs(lastQRef.current)}
              style={{ paddingHorizontal: 16, paddingVertical: 8, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}
            >
              <Text style={{ color: colors.primary, fontSize: 14, fontWeight: '600' }}>{t?.('common.retry', 'Tentar de novo') || 'Tentar de novo'}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : (
        <FlatList
          data={gridData}
          numColumns={3}
          keyExtractor={(g, i) => String(g.id || i)}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={true}
          maxToRenderPerBatch={18}
          windowSize={5}
          initialNumToRender={18}
          renderItem={({ item }) => (
            <GifItem item={item} onSelect={handleSelect} onLongPress={handleLongPress} fav={favIds.has(String(item.id || item.medium || item.preview))} colors={colors} />
          )}
          contentContainerStyle={{ paddingHorizontal: 2 }}
        />
      )}

      <Text style={{ textAlign: 'center', fontSize: 9, color: colors.textTertiary, paddingVertical: 3, opacity: 0.6 }}>
        Powered by Tenor
      </Text>
    </View>
  );
}
