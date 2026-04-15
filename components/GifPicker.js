import React, { useState, useEffect, useRef, useCallback, memo } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, FlatList, Platform, ActivityIndicator,
} from 'react-native';
import { IconX, IconSearch } from './Icons';
import * as api from '../services/api';

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

// Cache GIF results in memory
const gifCache = new Map();

const GifItem = memo(({ item, onSelect, colors }) => (
  <TouchableOpacity
    onPress={() => onSelect(item)}
    style={{ width: '33.33%', aspectRatio: 1, padding: 1.5 }}
    activeOpacity={0.7}
  >
    <Img
      source={{ uri: item.preview }}
      style={{ width: '100%', height: '100%', borderRadius: 6, backgroundColor: colors.background }}
      resizeMode="cover"
      {...(ExpoImage ? { cachePolicy: 'memory-disk', recyclingKey: `gif-${item.id}` } : {})}
    />
  </TouchableOpacity>
));

export default function GifPickerPanel({ onSelect, onClose, colors, t }) {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeCategory, setActiveCategory] = useState(null);
  const searchTimeout = useRef(null);
  const inputRef = useRef(null);

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
      if (r.success) {
        const results = r.data?.gifs || [];
        setGifs(results);
        gifCache.set(cacheKey, results);
        // Limit cache size
        if (gifCache.size > 50) {
          const first = gifCache.keys().next().value;
          gifCache.delete(first);
        }
      }
    } catch {}
    setLoading(false);
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
          maxToRenderPerBatch={12}
          windowSize={5}
          initialNumToRender={9}
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
