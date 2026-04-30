import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, ScrollView, Platform, Image,
  Alert, ActivityIndicator, TextInput, Animated,
} from 'react-native';
import CachedImage from './CachedImage';
import { IconX, IconPlus, IconSearch, IconHeart, IconStar, IconTrash } from './Icons';
import * as api from '../services/api';
import StickerEditor from './StickerEditor';

// ============================================================
// STICKER PACKS — WhatsApp-style emoji packs + image packs
// ============================================================
const STICKER_PACKS = [
  {
    id: 'smileys', name: 'Smileys', thumb: '😀',
    stickers: ['😀','😂','🤣','😊','🥰','😎','😢','😭','😡','🤔','🙄','😴','🤯','🥳','🤮','😱','🥺','😏','🤗','😤','😈','🤡','💀','👻','🫠','😮‍💨','🫣','🫡','🤭','😶‍🌫️','🥹','😵‍💫','🫥'],
  },
  {
    id: 'hands', name: 'Gestos', thumb: '👍',
    stickers: ['👍','👎','👋','✌️','🤞','🤝','👏','🙏','💪','🤙','👌','🫶','🤟','🫡','🫰','👊','✊','🤜','🤛','👆','👇','👈','👉','🤚','✋','🖐️','🫱','🫲','🤌','🫳','🫴','🤏'],
  },
  {
    id: 'love', name: 'Love', thumb: '❤️',
    stickers: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','💯','🔥','⭐','💫','✨','💥','💢','💝','💘','💖','💗','💓','💞','💕','❣️','💔','🩷','🩵','🩶','♥️','💋','😘','😍','🥰'],
  },
  {
    id: 'animals', name: 'Animais', thumb: '🐶',
    stickers: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🦄','🐝','🦋','🐙','🐳','🦈','🐺','🦅','🦜','🐢','🦎','🐍','🐊','🦧','🦥','🐧'],
  },
  {
    id: 'food', name: 'Comida', thumb: '🍕',
    stickers: ['🍕','🍔','🌮','🍣','🍜','🍩','🍦','🎂','🍫','🍿','🥑','🍉','🍓','🍑','🍌','🥐','🧁','🍪','🥤','🍺','🍷','☕','🧃','🥂','🫖','🧋','🥘','🍱','🌯','🍳','🥞','🍰'],
  },
  {
    id: 'activities', name: 'Diversão', thumb: '🎉',
    stickers: ['🎉','🎊','🎈','🎁','🏆','🥇','⚽','🏀','🎮','🎯','🎲','🎭','🎬','🎵','🎶','🎸','🎤','🎧','🎺','🥁','💃','🕺','🏖️','🏔️','🌈','☀️','🎪','🎡','🛼','🏄','🎳','🧗'],
  },
  {
    id: 'objects', name: 'Objetos', thumb: '💡',
    stickers: ['💡','📱','💻','⌚','📷','🎥','🔑','💰','💎','🎒','👑','🎩','👓','🧲','🔔','📌','✏️','📝','📚','🗂️','📎','✂️','🧸','🪄','🎨','🧩','🪁','🏠','🚗','✈️','🚀','⛵'],
  },
  {
    id: 'flags', name: 'Bandeiras', thumb: '🇧🇷',
    stickers: ['🇧🇷','🇺🇸','🇦🇷','🇵🇹','🇪🇸','🇫🇷','🇬🇧','🇩🇪','🇮🇹','🇯🇵','🇰🇷','🇨🇳','🇮🇳','🇲🇽','🇨🇦','🇦🇺','🏳️‍🌈','🏴‍☠️','🇨🇴','🇨🇱','🇵🇪','🇺🇾','🇪🇨','🇻🇪','🇧🇴','🇵🇾','🇨🇺','🇨🇷','🇵🇦','🇳🇱','🇧🇪','🇨🇭'],
  },
];

// Sticker search index — maps keywords to emoji
const SEARCH_INDEX = {
  'feliz': ['😀','😂','🤣','😊','🥳','😎'], 'happy': ['😀','😂','🤣','😊','🥳','😎'],
  'triste': ['😢','😭','🥺','😞'], 'sad': ['😢','😭','🥺','😞'],
  'amor': ['❤️','💕','💗','🥰','😍','😘','💋','💝'], 'love': ['❤️','💕','💗','🥰','😍','😘','💋','💝'],
  'raiva': ['😡','😤','🤬','💢'], 'angry': ['😡','😤','🤬','💢'],
  'fogo': ['🔥','💥','⭐'], 'fire': ['🔥','💥','⭐'],
  'ok': ['👍','👌','✌️','🤙'], 'legal': ['👍','👌','✌️','🤙','😎'],
  'rindo': ['😂','🤣','😆','😹'], 'lol': ['😂','🤣','😆','😹'],
  'festa': ['🎉','🎊','🎈','🥳','💃','🕺'], 'party': ['🎉','🎊','🎈','🥳','💃','🕺'],
  'comida': ['🍕','🍔','🍣','🍩','☕','🍺'], 'food': ['🍕','🍔','🍣','🍩','☕','🍺'],
  'animal': ['🐶','🐱','🐰','🦊','🐻','🦁'], 'pet': ['🐶','🐱','🐰'],
  'musica': ['🎵','🎶','🎸','🎤','🎧','🎺'], 'music': ['🎵','🎶','🎸','🎤','🎧','🎺'],
  'dinheiro': ['💰','💎','💵','🤑'], 'money': ['💰','💎','💵','🤑'],
  'esporte': ['⚽','🏀','🏆','🥇'], 'sport': ['⚽','🏀','🏆','🥇'],
  'coração': ['❤️','💙','💚','💛','💜','🩷','🩵'], 'heart': ['❤️','💙','💚','💛','💜','🩷','🩵'],
  'medo': ['😱','😨','😰','👻','💀'], 'scared': ['😱','😨','😰','👻','💀'],
  'sono': ['😴','🥱','😪','💤'], 'sleep': ['😴','🥱','😪','💤'],
  'pensando': ['🤔','🧐','💭'], 'thinking': ['🤔','🧐','💭'],
  'brasil': ['🇧🇷','⚽','💚','💛'], 'brazil': ['🇧🇷','⚽','💚','💛'],
  'obrigado': ['🙏','🤝','💕','❤️'], 'thanks': ['🙏','🤝','💕','❤️'],
  'sim': ['👍','✅','👌'], 'yes': ['👍','✅','👌'],
  'nao': ['👎','❌','🙅'], 'no': ['👎','❌','🙅'],
};

// Animated sticker pack — WebP URLs (Telegram-compatible animated stickers)
// These render as animated images natively and on web via <img> tag.
const ANIMATED_PACKS = [
  {
    id: 'animated-faces',
    name: 'Animated',
    thumb: '🎭',
    animated: true,
    stickers: [
      // Peach & Goma (popular Telegram pack) — public domain animated WebP
      'https://media.chatyy.com.br/stickers/animated/wave.webp',
      'https://media.chatyy.com.br/stickers/animated/heart.webp',
      'https://media.chatyy.com.br/stickers/animated/laugh.webp',
      'https://media.chatyy.com.br/stickers/animated/cry.webp',
      'https://media.chatyy.com.br/stickers/animated/angry.webp',
      'https://media.chatyy.com.br/stickers/animated/party.webp',
      'https://media.chatyy.com.br/stickers/animated/sleep.webp',
      'https://media.chatyy.com.br/stickers/animated/fire.webp',
      'https://media.chatyy.com.br/stickers/animated/thumbsup.webp',
      'https://media.chatyy.com.br/stickers/animated/thinking.webp',
      'https://media.chatyy.com.br/stickers/animated/cool.webp',
      'https://media.chatyy.com.br/stickers/animated/love.webp',
    ],
  },
];

// Export for sticker suggestions in chat input (type keyword → show suggestions)
export function getStickerSuggestions(text) {
  if (!text || text.length < 2) return [];
  const q = text.toLowerCase().trim();
  // Only trigger on single-word input that looks like a keyword
  if (q.includes(' ') && q.length > 20) return [];
  const words = q.split(/\s+/);
  const lastWord = words[words.length - 1];
  if (lastWord.length < 2) return [];
  const results = new Set();
  for (const [keyword, emojis] of Object.entries(SEARCH_INDEX)) {
    if (keyword.startsWith(lastWord) || lastWord.startsWith(keyword)) {
      emojis.forEach(e => results.add(e));
    }
  }
  return [...results].slice(0, 8);
}

const RECENT_KEY = '@chatyy_recent_stickers';
const MINE_KEY = '@chatyy_my_stickers';
const FAV_KEY = '@chatyy_fav_stickers';

async function storageGet(key) {
  try {
    if (Platform.OS === 'web') {
      const v = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
      return v ? JSON.parse(v) : [];
    }
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const v = await AsyncStorage.getItem(key);
    return v ? JSON.parse(v) : [];
  } catch { return []; }
}

async function storageSet(key, value) {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(value));
      return;
    }
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export default function StickerPicker({ onSelect, onClose, colors, t, userEmail }) {
  const [activePack, setActivePack] = useState('recent');
  const [recents, setRecents] = useState([]);
  const [mine, setMine] = useState([]);            // cached URL-only list for offline
  const [mineFull, setMineFull] = useState([]);    // full sticker rows from server (with id, emoji_tags)
  const [myPacks, setMyPacks] = useState([]);      // user's own packs
  const [favorites, setFavorites] = useState([]);
  const [creating, setCreating] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchBackend, setSearchBackend] = useState([]); // server-side emoji-tag results
  const [showSearch, setShowSearch] = useState(false);
  const [selectedMyPack, setSelectedMyPack] = useState(null); // pack_id filter inside Mine tab
  const [showPackCreate, setShowPackCreate] = useState(false);
  const [newPackName, setNewPackName] = useState('');
  const searchRef = useRef(null);

  useEffect(() => {
    storageGet(RECENT_KEY).then(setRecents);
    storageGet(MINE_KEY).then(setMine);
    storageGet(FAV_KEY).then(setFavorites);
    // Hydrate from backend — user's own stickers (across all their packs)
    (async () => {
      try {
        const r = await api.chatStickerMyStickers();
        if (r?.success && Array.isArray(r.items || r.data?.items)) {
          const items = r.items || r.data?.items || [];
          setMineFull(items);
          // Keep a URL-only cache for the local favorites/recents flow.
          const urls = items.map(s => s.url).filter(Boolean);
          if (urls.length) { setMine(urls); storageSet(MINE_KEY, urls); }
        }
      } catch {}
      try {
        const p = await api.chatStickerMyPacks();
        if (p?.success && Array.isArray(p.items || p.data?.items)) {
          setMyPacks(p.items || p.data?.items || []);
        }
      } catch {}
    })();
  }, []);

  const handleSelect = useCallback(async (item) => {
    const next = [item, ...recents.filter(r => r !== item)].slice(0, 40);
    setRecents(next);
    storageSet(RECENT_KEY, next);
    // For server-relative URLs, hand the absolute form to the sender so the
    // recipient's client can fetch the image regardless of its own base URL.
    let toSend = item;
    if (typeof item === 'string' && item.startsWith('/data/')) {
      let base = '';
      try { base = (typeof api.getCurrentBaseUrl === 'function' ? api.getCurrentBaseUrl() : api.BASE_URL) || ''; } catch {}
      if (!base) base = api.BASE_URL || '';
      base = String(base).replace(/\/$/, '');
      if (base) toSend = base + item;
      else if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location) toSend = window.location.origin + item;
      else toSend = 'https://chatyy.com.br' + item;
    }
    onSelect(toSend);
  }, [recents, onSelect]);

  const toggleFavorite = useCallback(async (item) => {
    let next;
    if (favorites.includes(item)) {
      next = favorites.filter(f => f !== item);
    } else {
      next = [item, ...favorites].slice(0, 50);
    }
    setFavorites(next);
    storageSet(FAV_KEY, next);
  }, [favorites]);

  // Search handler — local (emoji packs + keyword index) + backend (user's
  // custom stickers by emoji_tags). Backend runs debounced to avoid a
  // request on every keystroke.
  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults([]); setSearchBackend([]); return; }
    const q = searchQuery.trim().toLowerCase();
    const results = new Set();
    // Search index
    for (const [keyword, emojis] of Object.entries(SEARCH_INDEX)) {
      if (keyword.includes(q)) emojis.forEach(e => results.add(e));
    }
    // Also search pack names and individual stickers
    for (const pack of STICKER_PACKS) {
      if (pack.name.toLowerCase().includes(q)) {
        pack.stickers.forEach(s => results.add(s));
      }
    }
    // Include the user's own uploaded stickers whose emoji_tags match
    for (const s of mineFull) {
      const tags = (s.emoji_tags || '').toLowerCase();
      if (tags.includes(q) || (s.emoji && s.emoji.includes(searchQuery.trim()))) {
        if (s.url) results.add(s.url);
      }
    }
    setSearchResults([...results].slice(0, 60));

    // Debounced backend search for packs installed by user
    const tid = setTimeout(async () => {
      if (q.length < 2) return;
      try {
        const r = await api.chatStickerSearch(q);
        const items = r?.items || r?.data?.items || [];
        setSearchBackend(items.map(x => x.url).filter(Boolean));
      } catch {}
    }, 300);
    return () => clearTimeout(tid);
  }, [searchQuery, mineFull]);

  // Pick image → open sticker editor → upload result as sticker
  const [editorUri, setEditorUri] = useState(null);

  const pickImageForEditor = useCallback(async (source) => {
    try {
      if (Platform.OS === 'web') {
        const f = await new Promise((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'image/png,image/jpeg,image/webp';
          input.onchange = (e) => {
            const file = e.target.files?.[0];
            resolve(file ? URL.createObjectURL(file) : null);
          };
          input.click();
        });
        if (f) setEditorUri(f);
        return;
      }
      const ImagePicker = require('expo-image-picker');
      const permFn = source === 'camera'
        ? ImagePicker.requestCameraPermissionsAsync
        : ImagePicker.requestMediaLibraryPermissionsAsync;
      const perm = await permFn();
      if (!perm.granted) return;
      const launch = source === 'camera' ? ImagePicker.launchCameraAsync : ImagePicker.launchImageLibraryAsync;
      const result = await launch({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.85,
        allowsEditing: true,
        aspect: [1, 1],
      });
      if (result.canceled || !result.assets?.[0]) return;
      setEditorUri(result.assets[0].uri);
    } catch (e) {
      Alert.alert(t?.('common.error') || 'Erro', e?.message || 'Erro');
    }
  }, [t]);

  // Pick a short video and upload as animated WebP sticker (no editor)
  const pickVideoForAnimatedSticker = useCallback(async () => {
    try {
      let file = null;
      if (Platform.OS === 'web') {
        const f = await new Promise((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'video/mp4,video/webm,video/quicktime,image/gif';
          input.onchange = (e) => resolve(e.target.files?.[0] || null);
          input.click();
        });
        if (!f) return;
        if (f.size > 20 * 1024 * 1024) {
          Alert.alert(t?.('common.error') || 'Erro', t?.('chat.stickerTooLarge') || 'Vídeo muito grande (máx 20MB)');
          return;
        }
        file = { _raw: f, name: f.name || 'sticker.mp4', type: f.type || 'video/mp4' };
      } else {
        const ImagePicker = require('expo-image-picker');
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) return;
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Videos,
          quality: 0.85,
          videoMaxDuration: 5,
          allowsEditing: false,
        });
        if (result.canceled || !result.assets?.[0]) return;
        const a = result.assets[0];
        file = { uri: a.uri, name: a.fileName || 'sticker.mp4', type: a.mimeType || 'video/mp4' };
      }
      if (!file) return;
      setCreating(true);
      const r = await api.chatStickerCreateAnimated(file);
      if (r?.success) {
        const url = r.cdn_url || r.url;
        if (url) {
          const next = [url, ...mine.filter(u => u !== url)].slice(0, 200);
          setMine(next);
          storageSet(MINE_KEY, next);
          if (r.sticker_id) {
            setMineFull(prev => [{
              id: r.sticker_id, pack_id: r.pack_id, url, emoji: '', emoji_tags: '', is_animated: true,
            }, ...prev]);
          }
          setActivePack('mine');
          try {
            const p = await api.chatStickerMyPacks();
            if (p?.success) setMyPacks(p.items || p.data?.items || []);
          } catch {}
        }
      } else {
        Alert.alert(t?.('common.error') || 'Erro', r?.error || r?.message || 'Falha ao criar figurinha animada.');
      }
    } catch (e) {
      Alert.alert(t?.('common.error') || 'Erro', e?.message || 'Falha ao criar figurinha animada.');
    } finally {
      setCreating(false);
    }
  }, [t, mine]);

  const createSticker = useCallback(async () => {
    if (creating) return;
    if (Platform.OS === 'web') {
      Alert.alert(
        t?.('chat.createSticker') || 'Criar figurinha',
        '',
        [
          { text: t?.('chat.stickerStatic') || 'Imagem (estática)', onPress: () => pickImageForEditor('gallery') },
          { text: t?.('chat.stickerAnimated') || 'Vídeo (animada)', onPress: () => pickVideoForAnimatedSticker() },
          { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
        ],
      );
      return;
    }
    Alert.alert(
      t?.('chat.createSticker') || 'Criar figurinha',
      t?.('status.pickSource') || 'De onde?',
      [
        { text: t?.('status.camera') || 'Camera', onPress: () => pickImageForEditor('camera') },
        { text: t?.('status.gallery') || 'Galeria', onPress: () => pickImageForEditor('gallery') },
        { text: t?.('chat.stickerAnimated') || 'Vídeo (animada)', onPress: () => pickVideoForAnimatedSticker() },
        { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
      ],
    );
  }, [creating, pickImageForEditor, pickVideoForAnimatedSticker, t]);

  // Called by StickerEditor when user confirms the edit. StickerEditor
  // already hit chat_sticker_create so `file.cdn_url` / `file.sticker_id` are
  // the server-assigned values. Fall back to rustUpload if somehow the
  // editor handed us a raw file (legacy path / offline).
  const handleEditorSave = useCallback(async (file) => {
    setEditorUri(null);
    if (!file) return;
    setCreating(true);
    try {
      let finalUrl = file.cdn_url || file.url || null;
      let stickerRow = null;
      if (file.sticker_id) {
        stickerRow = {
          id: file.sticker_id,
          pack_id: file.pack_id,
          url: finalUrl,
          emoji: file.emoji || '',
          emoji_tags: file.emoji_tags || '',
        };
      }
      if (!finalUrl) {
        const r = await api.rustUpload(file, userEmail || '', 'sticker');
        if (r?.success && r.cdn_url) finalUrl = r.cdn_url;
      }
      if (finalUrl) {
        const next = [finalUrl, ...mine.filter(u => u !== finalUrl)].slice(0, 200);
        setMine(next);
        storageSet(MINE_KEY, next);
        if (stickerRow) setMineFull(prev => [stickerRow, ...prev]);
        setActivePack('mine');
        // Refresh user's packs list (in case server auto-created "My Stickers")
        try {
          const p = await api.chatStickerMyPacks();
          if (p?.success) setMyPacks(p.items || p.data?.items || []);
        } catch {}
      } else {
        Alert.alert(t?.('common.error') || 'Erro', 'Falha ao criar figurinha.');
      }
    } catch (e) {
      Alert.alert(t?.('common.error') || 'Erro', e?.message || 'Falha ao criar figurinha.');
    } finally {
      setCreating(false);
    }
  }, [mine, userEmail, t]);

  // Create a new personal pack
  const handleCreatePack = useCallback(async () => {
    const name = newPackName.trim();
    if (!name) return;
    try {
      const r = await api.chatStickerPackCreate({ name });
      if (r?.success) {
        const created = r.data || r;
        setMyPacks(prev => [{
          id: created.id,
          name: created.name || name,
          description: created.description || '',
          cover_url: created.cover_url || '',
          sticker_count: 0,
          created_at: created.created_at,
        }, ...prev]);
        setNewPackName('');
        setShowPackCreate(false);
        setSelectedMyPack(created.id);
      } else {
        Alert.alert(t?.('common.error') || 'Erro', r?.error || 'Falha ao criar pack.');
      }
    } catch (e) {
      Alert.alert(t?.('common.error') || 'Erro', e?.message || 'Falha ao criar pack.');
    }
  }, [newPackName, t]);

  // Delete a user sticker (by URL — resolve against mineFull for id)
  const deleteServerSticker = useCallback(async (url) => {
    const row = mineFull.find(s => s.url === url);
    if (!row?.id) return;
    try {
      const r = await api.chatStickerDelete(row.id);
      if (r?.success) {
        setMineFull(prev => prev.filter(s => s.id !== row.id));
        const next = mine.filter(u => u !== url);
        setMine(next);
        storageSet(MINE_KEY, next);
      }
    } catch {}
  }, [mineFull, mine]);

  const removeMyStickerLong = useCallback((url) => {
    Alert.alert(
      t?.('chat.removeSticker') || 'Remover figurinha?', '',
      [
        { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
        {
          text: t?.('common.remove') || 'Remover', style: 'destructive',
          onPress: () => {
            // Local cache first for instant UI
            const next = mine.filter(u => u !== url);
            setMine(next);
            storageSet(MINE_KEY, next);
            // Then server-side delete (if the sticker exists on server)
            deleteServerSticker(url);
          },
        },
      ]
    );
  }, [mine, t, deleteServerSticker]);

  // Current pack stickers
  let currentStickers = [];
  if (showSearch && searchQuery.trim()) {
    // Merge local + backend results, dedupe while preserving order
    const seen = new Set();
    const merged = [];
    for (const s of [...searchResults, ...searchBackend]) {
      if (!seen.has(s)) { seen.add(s); merged.push(s); }
    }
    currentStickers = merged.slice(0, 80);
  }
  else if (activePack === 'recent') currentStickers = recents;
  else if (activePack === 'favorites') currentStickers = favorites;
  else if (activePack === 'mine') {
    // Pack filter inside Mine tab
    if (selectedMyPack) {
      currentStickers = mineFull.filter(s => s.pack_id === selectedMyPack).map(s => s.url).filter(Boolean);
    } else {
      // Show all user-authored stickers (server-hydrated if available, else cache)
      currentStickers = mineFull.length ? mineFull.map(s => s.url).filter(Boolean) : mine;
    }
  }
  else currentStickers = STICKER_PACKS.find(p => p.id === activePack)?.stickers
    || ANIMATED_PACKS.find(p => p.id === activePack)?.stickers
    || [];

  // Accept http(s):// URLs and server-relative paths like /data/sticker-files/...
  const isImg = (s) => typeof s === 'string' && (/^https?:\/\//.test(s) || s.startsWith('/data/'));
  const isFav = (s) => favorites.includes(s);

  // When the server returns a relative URL we need to resolve it to the
  // API origin so native `<Image>` can fetch it.
  const resolveStickerUri = useCallback((s) => {
    if (typeof s !== 'string') return s;
    if (/^https?:\/\//.test(s)) return s;
    if (s.startsWith('/data/')) {
      // Reuse the chat app's configured API base. Fallback to hostname.
      let base = '';
      try { base = (typeof api.getCurrentBaseUrl === 'function' ? api.getCurrentBaseUrl() : api.BASE_URL) || ''; } catch {}
      if (!base) base = api.BASE_URL || '';
      base = String(base).replace(/\/$/, '');
      if (base) return base + s;
      if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location) {
        return window.location.origin + s;
      }
      return 'https://chatyy.com.br' + s;
    }
    return s;
  }, []);

  return (
    <View style={{ height: 340, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border }}>
      <StickerEditor
        visible={!!editorUri}
        imageUri={editorUri}
        onCancel={() => setEditorUri(null)}
        onSave={handleEditorSave}
        t={t}
        colors={colors}
        userEmail={userEmail}
      />
      {/* Header with search */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, gap: 8 }}>
        {showSearch ? (
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.background, borderRadius: 20, paddingHorizontal: 10 }}>
            <IconSearch size={14} color={colors.textTertiary} />
            <TextInput
              ref={searchRef}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder={t?.('chat.searchStickers') || 'Buscar figurinhas...'}
              placeholderTextColor={colors.textTertiary}
              style={{ flex: 1, paddingVertical: 6, paddingHorizontal: 8, color: colors.text, fontSize: 13 }}
              autoFocus
              autoCorrect={false}
            />
            <TouchableOpacity onPress={() => { setShowSearch(false); setSearchQuery(''); }} hitSlop={8}>
              <IconX size={14} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text, flex: 1 }}>
              {t?.('chat.stickers') || 'Figurinhas'}
            </Text>
            <TouchableOpacity onPress={() => { setShowSearch(true); setTimeout(() => searchRef.current?.focus(), 100); }} style={{ padding: 4 }}>
              <IconSearch size={18} color={colors.textSecondary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={createSticker} disabled={creating}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 4, padding: 6, borderRadius: 16, backgroundColor: colors.primary + '15' }}>
              {creating ? <ActivityIndicator size={14} color={colors.primary} /> : <IconPlus size={14} color={colors.primary} />}
              <Text style={{ fontSize: 11, fontWeight: '700', color: colors.primary }}>{t?.('chat.createSticker') || 'Criar'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose} style={{ padding: 4 }}>
              <IconX size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* My-packs pill row — only visible on Mine tab. Lets the user filter
          their personal stickers by pack, create a new pack, and see sticker
          counts per pack. */}
      {activePack === 'mine' && !showSearch && (myPacks.length > 0 || true) && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ borderBottomWidth: 1, borderBottomColor: colors.border, maxHeight: 44 }}
          contentContainerStyle={{ paddingHorizontal: 8, alignItems: 'center', gap: 6 }}
        >
          <TouchableOpacity
            onPress={() => setSelectedMyPack(null)}
            style={{
              paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14,
              backgroundColor: selectedMyPack === null ? (colors.primary + '20') : (colors.background),
              borderWidth: 1, borderColor: selectedMyPack === null ? colors.primary : colors.border,
            }}
          >
            <Text style={{ fontSize: 11, fontWeight: '700', color: selectedMyPack === null ? colors.primary : colors.text }}>
              {t?.('chat.allMyStickers') || 'Todas'} · {mineFull.length}
            </Text>
          </TouchableOpacity>
          {myPacks.map(p => (
            <TouchableOpacity
              key={p.id}
              onPress={() => setSelectedMyPack(p.id)}
              style={{
                paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14,
                backgroundColor: selectedMyPack === p.id ? (colors.primary + '20') : (colors.background),
                borderWidth: 1, borderColor: selectedMyPack === p.id ? colors.primary : colors.border,
              }}
            >
              <Text style={{ fontSize: 11, fontWeight: '600', color: selectedMyPack === p.id ? colors.primary : colors.text }}>
                {p.name} · {p.sticker_count || 0}
              </Text>
            </TouchableOpacity>
          ))}
          {/* Inline new-pack affordance */}
          {showPackCreate ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.background, borderRadius: 14, paddingHorizontal: 8, borderWidth: 1, borderColor: colors.primary }}>
              <TextInput
                value={newPackName}
                onChangeText={setNewPackName}
                placeholder={t?.('chat.packName') || 'Nome do pack'}
                placeholderTextColor={colors.textTertiary}
                style={{ width: 120, paddingVertical: 4, color: colors.text, fontSize: 11, outlineStyle: 'none' }}
                autoFocus
                onSubmitEditing={handleCreatePack}
                maxLength={40}
              />
              <TouchableOpacity onPress={handleCreatePack}><Text style={{ color: colors.primary, fontWeight: '700', fontSize: 11 }}>OK</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => { setShowPackCreate(false); setNewPackName(''); }}><IconX size={12} color={colors.textTertiary} /></TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              onPress={() => setShowPackCreate(true)}
              style={{
                paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14,
                backgroundColor: colors.background,
                borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed',
                flexDirection: 'row', alignItems: 'center', gap: 4,
              }}
            >
              <IconPlus size={11} color={colors.textSecondary} />
              <Text style={{ fontSize: 11, fontWeight: '600', color: colors.textSecondary }}>
                {t?.('chat.newPack') || 'Novo pack'}
              </Text>
            </TouchableOpacity>
          )}
        </ScrollView>
      )}

      {/* Sticker grid */}
      {currentStickers.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 }}>
          <Text style={{ fontSize: 32, marginBottom: 8 }}>
            {showSearch && searchQuery.trim() ? '🔍' : activePack === 'recent' ? '🕐' : activePack === 'favorites' ? '⭐' : activePack === 'mine' ? '🎨' : '📦'}
          </Text>
          <Text style={{ fontSize: 13, color: colors.textTertiary, textAlign: 'center' }}>
            {showSearch && searchQuery.trim()
              ? (t?.('chat.noStickersFound') || 'Nenhuma figurinha encontrada')
              : activePack === 'recent'
                ? (t?.('chat.recentStickers') || 'Suas figurinhas recentes aparecerão aqui')
                : activePack === 'favorites'
                  ? (t?.('chat.noFavorites') || 'Segure em uma figurinha para favoritar')
                  : activePack === 'mine'
                    ? (t?.('chat.noMyStickers') || 'Toque em "Criar" para fazer sua figurinha')
                    : ''}
          </Text>
        </View>
      ) : (
        <FlatList
          data={currentStickers}
          numColumns={5}
          keyExtractor={(item, i) => `${activePack}-${i}-${typeof item === 'string' ? item.slice(0, 32) : i}`}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 2, paddingVertical: 2 }}
          renderItem={({ item }) => (
            <TouchableOpacity
              onPress={() => handleSelect(item)}
              onLongPress={() => {
                if (activePack === 'mine' && isImg(item)) removeMyStickerLong(item);
                else toggleFavorite(item);
              }}
              delayLongPress={400}
              style={{
                flex: 1 / 5, aspectRatio: 1, alignItems: 'center', justifyContent: 'center',
                padding: 4, borderRadius: 10, margin: 2,
                backgroundColor: isFav(item) ? (colors.primary + '10') : 'transparent',
              }}
              activeOpacity={0.5}
            >
              {isImg(item) ? (
                <CachedImage source={{ uri: resolveStickerUri(item) }} style={{ width: '90%', height: '90%', borderRadius: 6 }} resizeMode="contain" />
              ) : (
                <Text style={{ fontSize: 36 }}>{item}</Text>
              )}
              {isFav(item) && (
                <View style={{ position: 'absolute', top: 2, right: 2 }}>
                  <Text style={{ fontSize: 8 }}>⭐</Text>
                </View>
              )}
            </TouchableOpacity>
          )}
        />
      )}

      {/* Pack tabs — bottom */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ borderTopWidth: 1, borderTopColor: colors.border, maxHeight: 46 }}
        contentContainerStyle={{ paddingHorizontal: 2, alignItems: 'center' }}
      >
        {/* Recent */}
        <PackTab emoji="🕐" active={activePack === 'recent'} onPress={() => setActivePack('recent')} colors={colors} />
        {/* Favorites */}
        <PackTab emoji="⭐" active={activePack === 'favorites'} onPress={() => setActivePack('favorites')} colors={colors} badge={favorites.length || null} />
        {/* My stickers */}
        <PackTab emoji="🎨" active={activePack === 'mine'} onPress={() => setActivePack('mine')} colors={colors} badge={(mineFull.length || mine.length) || null} />
        {/* Divider */}
        <View style={{ width: 1, height: 20, backgroundColor: colors.border, marginHorizontal: 4 }} />
        {/* Emoji packs */}
        {STICKER_PACKS.map(pack => (
          <PackTab key={pack.id} emoji={pack.thumb} active={activePack === pack.id} onPress={() => setActivePack(pack.id)} colors={colors} />
        ))}
        {/* Divider */}
        <View style={{ width: 1, height: 20, backgroundColor: colors.border, marginHorizontal: 4 }} />
        {/* Animated packs */}
        {ANIMATED_PACKS.map(pack => (
          <PackTab key={pack.id} emoji={pack.thumb} active={activePack === pack.id} onPress={() => setActivePack(pack.id)} colors={colors} />
        ))}
      </ScrollView>
    </View>
  );
}

function PackTab({ emoji, active, onPress, colors, badge }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{
        paddingHorizontal: 10, paddingVertical: 8,
        borderBottomWidth: active ? 2.5 : 0,
        borderBottomColor: colors.primary,
        backgroundColor: active ? (colors.primary + '08') : 'transparent',
        borderRadius: active ? 8 : 0,
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
        position: 'relative',
      }}
      activeOpacity={0.6}
    >
      <Text style={{ fontSize: 20 }}>{emoji}</Text>
      {badge > 0 && (
        <View style={{
          position: 'absolute', top: 2, right: 2,
          minWidth: 14, height: 14, borderRadius: 7,
          backgroundColor: '#25D366',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Text style={{ fontSize: 8, color: '#fff', fontWeight: '800' }}>{badge > 9 ? '9+' : badge}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}
