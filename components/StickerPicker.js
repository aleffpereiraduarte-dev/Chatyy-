import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, ScrollView, Platform,
} from 'react-native';
import { IconX } from './Icons';

const STICKER_PACKS = [
  {
    id: 'smileys', name: 'Smileys', thumb: '😀',
    stickers: ['😀','😂','🤣','😊','🥰','😎','😢','😭','😡','🤔','🙄','😴','🤯','🥳','🤮','😱','🥺','😏','🤗','😤','😈','🤡','💀','👻','🫠','😮‍💨'],
  },
  {
    id: 'hands', name: 'Gestures', thumb: '👍',
    stickers: ['👍','👎','👋','✌️','🤞','🤝','👏','🙏','💪','🤙','👌','🫶','🤟','🫡','🫰','👊','✊','🤜','🤛','👆','👇','👈','👉','🖕','🤚','✋'],
  },
  {
    id: 'animals', name: 'Animals', thumb: '🐶',
    stickers: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🦄','🐝','🦋','🐙','🐳','🦈','🐺','🦅','🦜','🐢'],
  },
  {
    id: 'food', name: 'Food', thumb: '🍕',
    stickers: ['🍕','🍔','🌮','🍣','🍜','🍩','🍦','🎂','🍫','🍿','🥑','🍉','🍓','🍑','🍌','🥐','🧁','🍪','🥤','🍺','🍷','☕','🧃','🥂','🫖','🧋'],
  },
  {
    id: 'hearts', name: 'Hearts', thumb: '❤️',
    stickers: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','💯','🔥','⭐','💫','✨','💥','💢','💝','💘','💖','💗','💓','💞','💕','❣️','💔','🩷','🩵'],
  },
  {
    id: 'activities', name: 'Fun', thumb: '🎉',
    stickers: ['🎉','🎊','🎈','🎁','🏆','🥇','⚽','🏀','🎮','🎯','🎲','🎭','🎬','🎵','🎶','🎸','🎤','🎧','🎺','🥁','💃','🕺','🏖️','🏔️','🌈','☀️'],
  },
];

const RECENT_KEY = '@chatyy_recent_stickers';

function getRecents() {
  if (Platform.OS === 'web') {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
  }
  return [];
}

function saveRecent(emoji) {
  if (Platform.OS === 'web') {
    try {
      const arr = getRecents().filter(e => e !== emoji);
      arr.unshift(emoji);
      localStorage.setItem(RECENT_KEY, JSON.stringify(arr.slice(0, 30)));
    } catch {}
  }
}

export default function StickerPicker({ onSelect, onClose, colors, t }) {
  const [activePack, setActivePack] = useState('recent');
  const [recents, setRecents] = useState([]);

  useEffect(() => { setRecents(getRecents()); }, []);

  const handleSelect = useCallback((emoji) => {
    saveRecent(emoji);
    setRecents(prev => {
      const arr = prev.filter(e => e !== emoji);
      arr.unshift(emoji);
      return arr.slice(0, 30);
    });
    onSelect(emoji);
  }, [onSelect]);

  const currentStickers = activePack === 'recent'
    ? recents
    : STICKER_PACKS.find(p => p.id === activePack)?.stickers || [];

  return (
    <View style={{ height: 280, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border }}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 6 }}>
        <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>
          {t?.('chat.stickers') || 'Stickers'}
        </Text>
        <TouchableOpacity onPress={onClose} style={{ padding: 4 }}>
          <IconX size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* Sticker grid */}
      {currentStickers.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 13, color: colors.textTertiary }}>
            {activePack === 'recent' ? (t?.('chat.recentStickers') || 'No recent stickers') : ''}
          </Text>
        </View>
      ) : (
        <FlatList
          data={currentStickers}
          numColumns={6}
          keyExtractor={(item, i) => `${activePack}-${item}-${i}`}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 4 }}
          renderItem={({ item }) => (
            <TouchableOpacity
              onPress={() => handleSelect(item)}
              style={{
                flex: 1 / 6, aspectRatio: 1, alignItems: 'center', justifyContent: 'center',
                padding: 2, borderRadius: 8,
              }}
              activeOpacity={0.6}
            >
              <Text style={{ fontSize: 32 }}>{item}</Text>
            </TouchableOpacity>
          )}
        />
      )}

      {/* Pack tabs */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ borderTopWidth: 1, borderTopColor: colors.border, maxHeight: 44 }}
        contentContainerStyle={{ paddingHorizontal: 4, alignItems: 'center' }}
      >
        <TouchableOpacity
          onPress={() => setActivePack('recent')}
          style={{
            paddingHorizontal: 12, paddingVertical: 8,
            borderBottomWidth: activePack === 'recent' ? 2 : 0,
            borderBottomColor: colors.primary,
          }}
        >
          <Text style={{ fontSize: 18 }}>🕐</Text>
        </TouchableOpacity>
        {STICKER_PACKS.map(pack => (
          <TouchableOpacity
            key={pack.id}
            onPress={() => setActivePack(pack.id)}
            style={{
              paddingHorizontal: 12, paddingVertical: 8,
              borderBottomWidth: activePack === pack.id ? 2 : 0,
              borderBottomColor: colors.primary,
            }}
          >
            <Text style={{ fontSize: 18 }}>{pack.thumb}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}
