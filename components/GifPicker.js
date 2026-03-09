import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, FlatList, Image, ActivityIndicator,
} from 'react-native';
import { IconX } from './Icons';
import * as api from '../services/api';

export default function GifPickerPanel({ onSelect, onClose, colors, t }) {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState([]);
  const [loading, setLoading] = useState(false);
  const searchTimeout = useRef(null);

  useEffect(() => {
    loadGifs();
  }, []);

  const loadGifs = async (q = '') => {
    setLoading(true);
    try {
      const r = await api.chatSearchGifs(q);
      if (r.success) setGifs(r.data?.gifs || []);
    } catch {}
    setLoading(false);
  };

  const handleSearch = (text) => {
    setQuery(text);
    clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => loadGifs(text), 500);
  };

  return (
    <View style={{ height: 280, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: 8, gap: 8 }}>
        <TextInput
          placeholder={t('chat.searchGifs')}
          placeholderTextColor={colors.textTertiary}
          value={query}
          onChangeText={handleSearch}
          style={{
            flex: 1, backgroundColor: colors.background, borderRadius: 20,
            paddingHorizontal: 16, paddingVertical: 8, color: colors.text, fontSize: 14,
          }}
        />
        <TouchableOpacity onPress={onClose} style={{ padding: 4 }}>
          <IconX size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
      {!query && (
        <Text style={{ paddingHorizontal: 12, paddingBottom: 4, fontSize: 12, fontWeight: '600', color: colors.textSecondary }}>
          {t('chat.trendingGifs')}
        </Text>
      )}
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={gifs}
          numColumns={3}
          keyExtractor={(g) => g.id}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <TouchableOpacity
              onPress={() => onSelect(item)}
              style={{ flex: 1 / 3, aspectRatio: 1, padding: 2 }}
              activeOpacity={0.7}
            >
              <Image
                source={{ uri: item.preview }}
                style={{ width: '100%', height: '100%', borderRadius: 4, backgroundColor: colors.background }}
                resizeMode="cover"
              />
            </TouchableOpacity>
          )}
        />
      )}
      <Text style={{ textAlign: 'center', fontSize: 10, color: colors.textTertiary, paddingVertical: 4 }}>
        {t('chat.poweredByTenor')}
      </Text>
    </View>
  );
}
