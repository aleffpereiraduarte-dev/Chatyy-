import React, { useState, useEffect, useRef, useCallback, memo } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, FlatList, Platform, ActivityIndicator,
} from 'react-native';
import { IconX, IconSearch } from './Icons';
import * as api from '../services/api';
import { cacheMedia, getLocalUriSyncJs, preCacheUrls } from '../services/mediaCache';
import useIsMounted from '../hooks/useIsMounted';

let ExpoImage = null;
try { ExpoImage = require('expo-image').Image; } catch {}
const Img = ExpoImage || require('react-native').Image;

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

const GifItem = memo(({ item, onSelect, colors }) => {
  // Prefer local file:// URI when mediaCache has downloaded this GIF to disk.
  // Guarantees offline availability + avoids re-downloading across picker opens.
  const localUri = Platform.OS !== 'web' ? (getLocalUriSyncJs?.(item.preview) || null) : null;
  const src = localUri || item.preview;
  return (
    <TouchableOpacity
      onPress={() => onSelect(item)}
      style={{ width: '33.33%', aspectRatio: 1, padding: 1.5 }}
      activeOpacity={0.7}
    >
      <Img
        source={{ uri: src }}
        style={{ width: '100%', height: '100%', borderRadius: 6, backgroundColor: colors.background }}
        resizeMode="cover"
        {...(ExpoImage ? { cachePolicy: 'memory-disk', recyclingKey: `gif-${item.id}` } : {})}
      />
    </TouchableOpacity>
  );
});

export default function GifPickerPanel({ onSelect, onClose, colors, t }) {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeCategory, setActiveCategory] = useState(null);
  const searchTimeout = useRef(null);
  const inputRef = useRef(null);
  const aliveRef = useIsMounted();
  const reqIdRef = useRef(0);

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
    // Check cache first
    const cacheKey = q || '__trending__';
    if (gifCache.has(cacheKey)) {
      setGifs(gifCache.get(cacheKey));
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const r = await api.chatSearchGifs(q);
      // Race + unmount guards — descarta resposta velha ou após unmount.
      if (!aliveRef.current || myId !== reqIdRef.current) return;
      if (r.success) {
        const results = r.data?.gifs || [];
        setGifs(results);
        gifCache.set(cacheKey, results);
        // Limit cache size
        if (gifCache.size > 50) {
          const first = gifCache.keys().next().value;
          gifCache.delete(first);
        }
        schedulePersist();
        // Download previews to the app's filesystem via mediaCache. Persists
        // across app restarts. After the batch settles, re-set `gifs` to
        // trigger a re-render so GifItem reads the freshly-indexed local URIs.
        if (Platform.OS !== 'web') {
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
      }
    } catch {}
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
    // Kick off download of the full-size GIF to local FS so when the chat
    // bubble renders, it reads from file:// instead of re-downloading.
    if (Platform.OS !== 'web' && item?.url) {
      try { cacheMedia(item.url).catch(() => {}); } catch {}
    }
    onSelect(item);
  }, [onSelect]);

  return (
    <View style={{
      height: 320, backgroundColor: colors.surface,
      borderTopWidth: 1, borderTopColor: colors.border,
      ...(Platform.OS === 'web' ? { borderTopLeftRadius: 16, borderTopRightRadius: 16 } : {}),
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
            placeholder={t('chat.searchGifs') || 'Search GIFs'}
            placeholderTextColor={colors.textTertiary}
            value={query}
            onChangeText={handleSearch}
            style={{ flex: 1, paddingVertical: 8, paddingHorizontal: 8, color: colors.text, fontSize: 14 }}
            autoCorrect={false}
          />
          {query ? (
            <TouchableOpacity onPress={() => { setQuery(''); loadGifs(''); setActiveCategory(null); }} hitSlop={8}>
              <IconX size={14} color={colors.textTertiary} />
            </TouchableOpacity>
          ) : null}
        </View>
        <TouchableOpacity onPress={onClose} style={{ padding: 6 }}>
          <IconX size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* Category chips */}
      <View style={{ flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 4, gap: 4 }}>
        {CATEGORIES.map((cat) => (
          <TouchableOpacity
            key={cat.q}
            onPress={() => handleCategory(cat)}
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
      </View>

      {/* GIF grid */}
      {loading && gifs.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={gifs}
          numColumns={3}
          keyExtractor={(g) => g.id}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={true}
          maxToRenderPerBatch={18}
          windowSize={5}
          initialNumToRender={18}
          renderItem={({ item }) => (
            <GifItem item={item} onSelect={handleSelect} colors={colors} />
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
