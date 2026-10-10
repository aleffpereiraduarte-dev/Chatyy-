import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, ScrollView, Platform, Image,
  Alert, ActivityIndicator, TextInput, Animated, Modal, Pressable, StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import CachedImage from './CachedImage';
import { IconX, IconPlus, IconSearch, IconHeart, IconStar, IconTrash, IconFilm, IconPackage, IconClock, IconPalette } from './Icons';
import * as api from '../services/api';
// [2026-10-08 sticker-maker] criador novo (recorte automático + contorno +
// texto/desenho/emoji + WebP 512) substitui o StickerEditor antigo aqui.
import StickerMaker, { pickStickerSourceImage } from './stickers/StickerMaker';
import Svg, { Path as SvgPath } from 'react-native-svg';

function _tr(t, key, fb) {
  try { const v = t ? t(key) : ''; return v && v !== key ? v : fb; } catch { return fb; }
}
const CREATE_TILE = '__chatyy_create_sticker__';
// figurinha é transparente: sem o fundo pastel (LQIP) do CachedImage atrás dela
const STICKER_CLEAR_PLACEHOLDER = { uri: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' };
function IconStickerPlus({ size = 26, color = '#111' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <SvgPath d="M15.5 3H6a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h7l8-8V6.5" />
      <SvgPath d="M13 21v-5a3 3 0 0 1 3-3h5" />
      <SvgPath d="M19 2v6M16 5h6" />
    </Svg>
  );
}

// Folha de opções simples (funciona igual no web — Alert do web só tem OK/Cancelar).
function ChoiceSheet({ visible, title, options, onClose, colors }) {
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}>
        <Pressable onPress={() => {}} style={{ backgroundColor: colors.surface || '#fff', borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 10, paddingBottom: 24 }}>
          {title ? <Text style={{ textAlign: 'center', fontSize: 13, fontWeight: '700', color: colors.textSecondary, paddingVertical: 8 }}>{title}</Text> : null}
          {options.map((o) => (
            <TouchableOpacity
              key={o.key}
              onPress={() => { onClose(); setTimeout(() => o.onPress && o.onPress(), 60); }}
              style={{ paddingVertical: 15, paddingHorizontal: 22, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}
              accessibilityRole="button"
            >
              <Text style={{ fontSize: 16, fontWeight: o.destructive ? '700' : '600', color: o.destructive ? (colors.error || '#EF4444') : colors.text, textAlign: 'center' }}>{o.label}</Text>
            </TouchableOpacity>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

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
// [2026-10-08] Removido: pacote fixo 'Peach & Goma' não é domínio público (copyright).
// Pacotes animados agora vêm da loja (Noto Animated Emoji CC BY 4.0, via sticker_pack_my).
const ANIMATED_PACKS = [];

// Suggestions for chat input. Trade-off tuned to be helpful, not noisy:
// 1) Min 4 chars on the last word (was 2 — "Com" matched "comida" and the
//    food strip popped while typing "Como vai", which the user reported as
//    intrusive).
// 2) Match must be a real prefix relationship AND share at least 4 chars
//    in common, so 2-char keywords ("ok", "yo") don't trigger from any
//    longer word that happens to share a leading letter.
// 3) Cap at 4 results — picker is meant as a quick hint, not a gallery.
// 4) If the message already has 3+ words, suppress (user is mid-sentence,
//    not picking a sticker keyword).
export function getStickerSuggestions(text) {
  if (!text) return [];
  const q = text.toLowerCase().trim();
  if (q.length < 4) return [];
  const words = q.split(/\s+/);
  if (words.length > 3) return [];
  const lastWord = words[words.length - 1];
  if (lastWord.length < 4) return [];
  const results = new Set();
  for (const [keyword, emojis] of Object.entries(SEARCH_INDEX)) {
    if (keyword.length < 4) continue;
    const overlap = Math.min(keyword.length, lastWord.length);
    if (overlap < 4) continue;
    if (keyword.slice(0, overlap) !== lastWord.slice(0, overlap)) continue;
    emojis.forEach(e => results.add(e));
  }
  return [...results].slice(0, 4);
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
  const router = useRouter();
  const [activePack, setActivePack] = useState('recent');
  const [recents, setRecents] = useState([]);
  const [mine, setMine] = useState([]);            // cached URL-only list for offline
  const [mineFull, setMineFull] = useState([]);    // full sticker rows from server (with id, emoji_tags)
  const [myPacks, setMyPacks] = useState([]);      // user's own packs
  const [favorites, setFavorites] = useState([]);
  const [creating, setCreating] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchBackend, setSearchBackend] = useState([]); // server-side emoji-tag results (installed)
  const [searchGlobal, setSearchGlobal] = useState([]);   // discovery results (every public pack)
  const [showSearch, setShowSearch] = useState(false);
  const [selectedMyPack, setSelectedMyPack] = useState(null); // pack_id filter inside Mine tab
  const [showPackCreate, setShowPackCreate] = useState(false);
  const [newPackName, setNewPackName] = useState('');
  // Marketplace (sticker_packs / sticker_pack_items) — Telegram Premium-style
  // store. installedMarketPacks holds pack metadata; marketPackItems caches
  // items per pack id (lazy-loaded when a pack tab is selected).
  const [installedMarketPacks, setInstalledMarketPacks] = useState([]);
  const [marketPackItems, setMarketPackItems] = useState({});
  const searchRef = useRef(null);
  // Long-press preview: shows a large rendering + "Adicionar aos favoritos"
  // affordance. Tapping the backdrop or the close button dismisses it.
  const [previewItem, setPreviewItem] = useState(null);
  const previewScale = useRef(new Animated.Value(0.85)).current;
  const openStickerPreview = useCallback((item) => {
    setPreviewItem(item);
    previewScale.setValue(0.85);
    Animated.spring(previewScale, {
      toValue: 1, useNativeDriver: true, tension: 280, friction: 18,
    }).start();
  }, [previewScale]);
  const closeStickerPreview = useCallback(() => setPreviewItem(null), []);

  useEffect(() => {
    storageGet(RECENT_KEY).then(setRecents);
    storageGet(MINE_KEY).then(setMine);
    // Local cache for offline; server is the source of truth — hydrate from
    // chat_sticker_favorites_list below to merge any favorites this user
    // saved from another device.
    // [2026-10-10] Lê o cache local ANTES de mesclar com o servidor. Antes os
    // dois corriam em paralelo e, se o storage resolvesse depois, sobrescrevia
    // a lista mesclada → favorita salva pelo chat "não aparecia".
    (async () => {
      try { const local = await storageGet(FAV_KEY); setFavorites(prev => (prev && prev.length ? prev : local)); } catch {}
      try {
        const r = await api.chatStickerFavoritesList();
        const rows = r?.items || r?.data?.items || [];
        if (Array.isArray(rows) && rows.length) {
          const serverUrls = rows.map(x => x.sticker_url || x.url).filter(Boolean);
          setFavorites(prev => {
            // Merge: server union local, dedupe, keep server order first
            // (most-recently favorited last server-side, prepended here).
            const seen = new Set();
            const merged = [];
            for (const u of [...serverUrls, ...prev]) {
              if (!seen.has(u)) { seen.add(u); merged.push(u); }
            }
            const next = merged.slice(0, 200);
            storageSet(FAV_KEY, next);
            return next;
          });
        }
      } catch {}
    })();
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
      // Hydrate marketplace packs (sticker_pack_my). These are packs the user
      // installed from /stickers/store. Each will get its own pill tab and
      // grid view. Keep silent on failure — picker still works without it.
      try {
        const mp = await api.stickerPackMy();
        if (mp?.success) {
          const arr = mp.items || mp.data?.items || [];
          if (Array.isArray(arr)) setInstalledMarketPacks(arr);
        }
      } catch {}
    })();
  }, []);

  // Lazy-load items for a marketplace pack when its tab activates.
  useEffect(() => {
    if (typeof activePack !== 'string' || !activePack.startsWith('mkt-')) return;
    const id = parseInt(activePack.slice(4), 10);
    if (!id || marketPackItems[id]) return;
    (async () => {
      try {
        const r = await api.chatStickerPackStickers(id);
        const items = r?.items || r?.data?.items || r?.stickers || [];
        setMarketPackItems(prev => ({ ...prev, [id]: Array.isArray(items) ? items : [] }));
      } catch {}
    })();
  }, [activePack, marketPackItems]);

  const handleSelect = useCallback(async (item) => {
    const next = [item, ...recents.filter(r => r !== item)].slice(0, 40);
    setRecents(next);
    storageSet(RECENT_KEY, next);
    // For server-relative URLs, hand the absolute form to the sender so the
    // recipient's client can fetch the image regardless of its own base URL.
    let toSend = item;
    // [2026-10-08 sticker-maker] /data/sticker-files só existe no US (CDN_URL);
    // BASE_URL pode ser um edge (api-br/eu) que devolve index.html → figurinha
    // quebrada pra quem recebe. getMediaUrl roteia /data/sticker-files → US.
    if (typeof item === 'string' && item.startsWith('/data/')) {
      try { toSend = api.getMediaUrl(item); } catch { toSend = 'https://chatyy.com.br' + item; }
    }
    onSelect(toSend);
  }, [recents, onSelect]);

  const toggleFavorite = useCallback(async (item) => {
    let next;
    if (favorites.includes(item)) {
      next = favorites.filter(f => f !== item);
    } else {
      next = [item, ...favorites].slice(0, 200);
    }
    setFavorites(next);
    storageSet(FAV_KEY, next);
    // Sync to server (fire-and-forget — local UI already updated).
    try { api.chatStickerFavoriteToggle(typeof item === 'string' ? item : String(item)); } catch {}
  }, [favorites]);

  // Search handler — local (emoji packs + keyword index) + backend (user's
  // custom stickers by emoji_tags). Backend runs debounced to avoid a
  // request on every keystroke.
  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults([]); setSearchBackend([]); setSearchGlobal([]); return; }
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

    // Debounced backend search for packs installed by user + global
    // discovery search across every public pack (WhatsApp parity). Both run
    // in parallel — installed results render first, global underneath in
    // the "Mais resultados" rail.
    const tid = setTimeout(async () => {
      if (q.length < 2) return;
      try {
        const r = await api.chatStickerSearch(q);
        const items = r?.items || r?.data?.items || [];
        setSearchBackend(items.map(x => x.url).filter(Boolean));
      } catch {}
      try {
        const gr = await api.chatStickerGlobalSearch(q);
        const gitems = gr?.items || gr?.data?.items || [];
        setSearchGlobal(gitems.map(x => x.url).filter(Boolean));
      } catch {}
    }, 300);
    return () => clearTimeout(tid);
  }, [searchQuery, mineFull]);

  // Pick image → open sticker editor → upload result as sticker
  const [editorUri, setEditorUri] = useState(null);

  const pickImageForEditor = useCallback(async (source) => {
    try {
      const uri = await pickStickerSourceImage(source);
      if (uri) setEditorUri(uri);
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
          mediaTypes: ['videos'],
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

  // [2026-10-08 sticker-maker] "+ Criar" → folha: Galeria / Câmera / Vídeo (animada)
  const [createSheet, setCreateSheet] = useState(false);
  const [mineSheet, setMineSheet] = useState(null); // url da figurinha (Minhas)
  const createSticker = useCallback(() => {
    if (creating) return;
    setCreateSheet(true);
  }, [creating]);

  // Called by StickerEditor when user confirms the edit. StickerEditor
  // already hit chat_sticker_create so `file.cdn_url` / `file.sticker_id` are
  // the server-assigned values. Fall back to rustUpload if somehow the
  // editor handed us a raw file (legacy path / offline).
  // [2026-10-08 sticker-maker] figurinha criada no StickerMaker (já salva no servidor)
  const handleMakerSaved = useCallback((row) => {
    if (!row?.url) return;
    const finalUrl = row.url;
    setMine(prev => {
      const next = [finalUrl, ...prev.filter(u => u !== finalUrl)].slice(0, 200);
      storageSet(MINE_KEY, next);
      return next;
    });
    if (row.id) setMineFull(prev => [{ id: row.id, pack_id: row.pack_id, url: finalUrl, emoji: row.emoji || '', emoji_tags: row.emoji_tags || '' }, ...prev.filter(x => x.id !== row.id)]);
    setActivePack('mine');
    setSelectedMyPack(null);
    (async () => {
      try {
        const p = await api.chatStickerMyPacks();
        if (p?.success) setMyPacks(p.items || p.data?.items || []);
      } catch {}
    })();
  }, []);

  // Mover figurinha para o início de "Minhas figurinhas" (ordem salva no servidor)
  const moveMineToFront = useCallback(async (url) => {
    const row = mineFull.find(s0 => s0.url === url);
    const nextFull = row ? [row, ...mineFull.filter(x => x.id !== row.id)] : mineFull;
    setMineFull(nextFull);
    const nextUrls = [url, ...mine.filter(u => u !== url)];
    setMine(nextUrls);
    storageSet(MINE_KEY, nextUrls);
    const ids = nextFull.map(x => x.id).filter(Boolean);
    if (ids.length) { try { await api.chatStickerReorder(ids); } catch {} }
  }, [mineFull, mine]);

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
    // Merge local + backend (installed) + global discovery results, dedupe
    // while preserving order. Local emoji index first so the canned answer
    // is the fastest path, then user's installed packs, then discovery from
    // the wider sticker corpus.
    const seen = new Set();
    const merged = [];
    for (const s of [...searchResults, ...searchBackend, ...searchGlobal]) {
      if (!seen.has(s)) { seen.add(s); merged.push(s); }
    }
    currentStickers = merged.slice(0, 120);
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
  else if (typeof activePack === 'string' && activePack.startsWith('mkt-')) {
    // Marketplace pack — items rendered as image URLs / R2 keys.
    const id = parseInt(activePack.slice(4), 10);
    const items = marketPackItems[id] || [];
    currentStickers = items
      .map(it => it.url || it.image_url || it.sticker_id)
      .filter(Boolean);
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
      try { return api.getMediaUrl(s); } catch { return 'https://chatyy.com.br' + s; }
    }
    return s;
  }, []);

  return (
    <View style={{ height: 340, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border }}>
      <StickerMaker
        visible={!!editorUri}
        sourceUri={editorUri}
        onClose={() => setEditorUri(null)}
        onSaved={handleMakerSaved}
        onSend={(absUrl) => { try { onSelect(absUrl); } catch {} }}
      />
      <ChoiceSheet
        visible={createSheet}
        title={_tr(t, 'stickerMaker.pickTitle', 'Criar figurinha')}
        colors={colors}
        onClose={() => setCreateSheet(false)}
        options={[
          { key: 'gallery', label: _tr(t, 'stickerMaker.fromGallery', 'Escolher foto'), onPress: () => pickImageForEditor('gallery') },
          ...(Platform.OS !== 'web' ? [{ key: 'camera', label: _tr(t, 'stickerMaker.fromCamera', 'Tirar foto'), onPress: () => pickImageForEditor('camera') }] : []),
          { key: 'video', label: _tr(t, 'stickerMaker.fromVideo', 'Vídeo ou GIF (animada)'), onPress: () => pickVideoForAnimatedSticker() },
          { key: 'cancel', label: _tr(t, 'common.cancel', 'Cancelar'), onPress: () => {} },
        ]}
      />
      <ChoiceSheet
        visible={!!mineSheet}
        colors={colors}
        onClose={() => setMineSheet(null)}
        options={[
          { key: 'send', label: _tr(t, 'stickerMaker.send', 'Enviar'), onPress: () => { const u = mineSheet; if (u) handleSelect(u); } },
          { key: 'front', label: _tr(t, 'stickerMaker.moveToFront', 'Mover para o início'), onPress: () => { const u = mineSheet; if (u) moveMineToFront(u); } },
          { key: 'fav', label: (mineSheet && favorites.includes(mineSheet)) ? _tr(t, 'stickerMaker.unfavorite', 'Remover dos favoritos') : _tr(t, 'stickerMaker.favorite', 'Adicionar aos favoritos'), onPress: () => { const u = mineSheet; if (u) toggleFavorite(u); } },
          { key: 'del', destructive: true, label: _tr(t, 'stickerMaker.deleteSticker', 'Apagar figurinha'), onPress: () => {
            const u = mineSheet;
            if (!u) return;
            const next = mine.filter(x => x !== u);
            setMine(next);
            storageSet(MINE_KEY, next);
            deleteServerSticker(u);
          } },
          { key: 'cancel', label: _tr(t, 'common.cancel', 'Cancelar'), onPress: () => {} },
        ]}
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

      {/* Recently-used preview row — pinned at the very top so the most-used
          stickers are always one tap away (Telegram parity). Renders only when
          the user has actually used something and isn't on the recent tab. */}
      {!showSearch && activePack !== 'recent' && recents.length > 0 && (
        <View style={{ borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingTop: 4 }}>
            <Text style={{ fontSize: 9, fontWeight: '800', color: colors.textTertiary, letterSpacing: 0.6 }}>
              RECENTES
            </Text>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ maxHeight: 44 }}
            contentContainerStyle={{ paddingHorizontal: 6, alignItems: 'center', gap: 4 }}
          >
            {recents.slice(0, 14).map((item, i) => (
              <TouchableOpacity
                key={`recent-strip-${i}-${typeof item === 'string' ? item.slice(0, 16) : i}`}
                onPress={() => handleSelect(item)}
                onLongPress={() => openStickerPreview(item)}
                delayLongPress={350}
                style={{ paddingHorizontal: 4, paddingVertical: 4, alignItems: 'center', justifyContent: 'center' }}
                activeOpacity={0.6}
              >
                {isImg(item) ? (
                  <CachedImage source={{ uri: resolveStickerUri(item) }} style={{ width: 30, height: 30 }} resizeMode="contain" />
                ) : (
                  <Text style={{ fontSize: 22 }}>{item}</Text>
                )}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Favoritos preview row — only shown when user has favorites and isn't
          on the favorites or recents tab. Long-press a sticker to add it to
          favorites (handled in the main grid). */}
      {!showSearch && activePack !== 'favorites' && activePack !== 'recent' && favorites.length > 0 && (
        <View style={{ borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingTop: 4, gap: 4 }}>
            <Text style={{ fontSize: 10 }}>⭐</Text>
            <Text style={{ fontSize: 9, fontWeight: '800', color: colors.primary, letterSpacing: 0.6 }}>
              FAVORITOS
            </Text>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ maxHeight: 44 }}
            contentContainerStyle={{ paddingHorizontal: 6, alignItems: 'center', gap: 4 }}
          >
            {favorites.slice(0, 14).map((item, i) => (
              <TouchableOpacity
                key={`fav-strip-${i}-${typeof item === 'string' ? item.slice(0, 16) : i}`}
                onPress={() => handleSelect(item)}
                onLongPress={() => openStickerPreview(item)}
                delayLongPress={350}
                style={{ paddingHorizontal: 4, paddingVertical: 4, alignItems: 'center', justifyContent: 'center' }}
                activeOpacity={0.6}
              >
                {isImg(item) ? (
                  <CachedImage source={{ uri: resolveStickerUri(item) }} style={{ width: 30, height: 30 }} resizeMode="contain" />
                ) : (
                  <Text style={{ fontSize: 22 }}>{item}</Text>
                )}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

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
      {currentStickers.length === 0 && !(activePack === 'mine' && !showSearch) ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 }}>
          {/* [2026-10-10 stickers-import] ícone SVG (antes emoji na UI) */}
          <View style={{ marginBottom: 10 }}>
            {(() => {
              const EmptyIcon = showSearch && searchQuery.trim() ? IconSearch : activePack === 'recent' ? IconClock : activePack === 'favorites' ? IconStar : activePack === 'mine' ? IconPalette : IconPackage;
              return <EmptyIcon size={30} color={colors.textTertiary || colors.textSecondary} />;
            })()}
          </View>
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
          data={(activePack === 'mine' && !showSearch) ? [CREATE_TILE, ...currentStickers] : currentStickers}
          numColumns={5}
          keyExtractor={(item, i) => `${activePack}-${i}-${typeof item === 'string' ? item.slice(0, 32) : i}`}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 2, paddingVertical: 2 }}
          renderItem={({ item }) => (item === CREATE_TILE ? (
            <TouchableOpacity
              onPress={createSticker}
              disabled={creating}
              style={{
                flex: 1 / 5, aspectRatio: 1, alignItems: 'center', justifyContent: 'center',
                borderRadius: 12, margin: 4, borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.textTertiary,
              }}
              accessibilityRole="button"
              accessibilityLabel={_tr(t, 'stickerMaker.pickTitle', 'Criar figurinha')}
              activeOpacity={0.6}
            >
              {creating ? <ActivityIndicator size="small" color={colors.text} /> : <IconStickerPlus size={24} color={colors.text} />}
              <Text style={{ fontSize: 10, fontWeight: '700', color: colors.text, marginTop: 3 }} numberOfLines={1}>{_tr(t, 'stickerMaker.createTile', 'Criar')}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={() => handleSelect(item)}
              onLongPress={() => {
                if (activePack === 'mine' && isImg(item)) setMineSheet(item);
                else openStickerPreview(item);
              }}
              delayLongPress={350}
              style={{
                flex: 1 / 5, aspectRatio: 1, alignItems: 'center', justifyContent: 'center',
                padding: 4, borderRadius: 10, margin: 2,
                backgroundColor: isFav(item) ? (colors.primary + '10') : 'transparent',
              }}
              activeOpacity={0.5}
            >
              {isImg(item) ? (
                <CachedImage source={{ uri: resolveStickerUri(item) }} style={{ width: '90%', height: '90%', borderRadius: 6 }} resizeMode="contain" placeholder={STICKER_CLEAR_PLACEHOLDER} />
              ) : (
                <Text style={{ fontSize: 36 }}>{item}</Text>
              )}
              {isFav(item) && (
                <View style={{ position: 'absolute', top: 2, right: 2 }}>
                  <Text style={{ fontSize: 8 }}>⭐</Text>
                </View>
              )}
            </TouchableOpacity>
          ))}
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
        {/* Installed marketplace packs (Telegram Premium-style store).
            Render each as a pill tab with the pack's cover thumb. */}
        {installedMarketPacks.length > 0 && (
          <View style={{ width: 1, height: 20, backgroundColor: colors.border, marginHorizontal: 4 }} />
        )}
        {installedMarketPacks.map((pack) => {
          const tabKey = `mkt-${pack.id}`;
          const cover = (() => {
            const u = pack.cover_url;
            if (!u) return null;
            if (/^https?:\/\//.test(u)) return u;
            if (u.startsWith('/data/')) {
              // [2026-10-08 sticker-maker] /data/* de figurinha só no US (edge devolve index.html)
              try { return api.getMediaUrl(u); } catch { return 'https://chatyy.com.br' + u; }
            }
            return `https://media.chatyy.com.br/${u.replace(/^\/+/, '')}`;
          })();
          return (
            <TouchableOpacity
              key={tabKey}
              onPress={() => setActivePack(tabKey)}
              style={{
                paddingHorizontal: 8, paddingVertical: 6,
                borderBottomWidth: activePack === tabKey ? 2.5 : 0,
                borderBottomColor: colors.primary,
                backgroundColor: activePack === tabKey ? (colors.primary + '08') : 'transparent',
                borderRadius: activePack === tabKey ? 8 : 0,
                borderBottomLeftRadius: 0,
                borderBottomRightRadius: 0,
              }}
              activeOpacity={0.6}
            >
              {cover ? (
                <CachedImage source={{ uri: cover }} style={{ width: 24, height: 24, borderRadius: 4 }} resizeMode="contain" placeholder={STICKER_CLEAR_PLACEHOLDER} showSpinner={false} />
              ) : (
                pack.animated ? <IconFilm size={20} color={colors.textSecondary} /> : <IconPackage size={20} color={colors.textSecondary} />
              )}
            </TouchableOpacity>
          );
        })}
        {/* "+" tab — opens the sticker store. Placed last so users always
            know where to discover more packs. */}
        <TouchableOpacity
          onPress={() => router.push('/stickers/store')}
          style={{
            paddingHorizontal: 10, paddingVertical: 8, marginLeft: 4,
            backgroundColor: colors.primary + '12',
            borderRadius: 14, alignItems: 'center', justifyContent: 'center',
          }}
          activeOpacity={0.6}
        >
          <IconPlus size={16} color={colors.primary} />
        </TouchableOpacity>
      </ScrollView>

      {/* "Criar sticker" floating button — bottom-right, brand purple. Opens
          the same source picker as the top-right "Criar" button so users
          have a discoverable shortcut without overlapping the header chrome
          (matches WhatsApp's bottom-anchored "+" affordance). */}
      <TouchableOpacity
        onPress={createSticker}
        activeOpacity={0.85}
        disabled={creating}
        style={{
          position: 'absolute', right: 14, bottom: 60,
          width: 48, height: 48, borderRadius: 24,
          backgroundColor: '#111111',
          alignItems: 'center', justifyContent: 'center',
          shadowColor: '#111111', shadowOpacity: 0.45,
          shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
          elevation: 6,
          opacity: creating ? 0.6 : 1,
        }}
        accessibilityLabel="Criar sticker"
      >
        {creating ? <ActivityIndicator color="#fff" /> : <IconPlus size={22} color="#fff" />}
      </TouchableOpacity>

      {/* Long-press preview modal — large render of the sticker plus an
          "Adicionar aos favoritos" affordance. Tapping the dimmed backdrop or
          the close button dismisses. */}
      <Modal
        visible={!!previewItem}
        transparent
        animationType="fade"
        onRequestClose={closeStickerPreview}
      >
        <Pressable
          onPress={closeStickerPreview}
          style={{
            flex: 1, backgroundColor: 'rgba(0,0,0,0.55)',
            alignItems: 'center', justifyContent: 'center', padding: 24,
          }}
        >
          <Animated.View
            style={{
              width: 240, padding: 20, borderRadius: 24,
              backgroundColor: colors.surface,
              alignItems: 'center', justifyContent: 'center', gap: 14,
              transform: [{ scale: previewScale }],
              shadowColor: '#000', shadowOpacity: 0.3,
              shadowRadius: 20, shadowOffset: { width: 0, height: 8 },
              elevation: 12,
            }}
          >
            {previewItem && (
              isImg(previewItem) ? (
                <CachedImage
                  source={{ uri: resolveStickerUri(previewItem) }}
                  style={{ width: 180, height: 180 }}
                  resizeMode="contain"
                />
              ) : (
                <Text style={{ fontSize: 130 }}>{previewItem}</Text>
              )
            )}
            <TouchableOpacity
              onPress={() => {
                if (previewItem != null) toggleFavorite(previewItem);
              }}
              activeOpacity={0.85}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 6,
                paddingHorizontal: 14, paddingVertical: 9,
                borderRadius: 999,
                backgroundColor: previewItem != null && isFav(previewItem)
                  ? 'transparent'
                  : '#111111',
                borderWidth: previewItem != null && isFav(previewItem) ? 1.5 : 0,
                borderColor: '#111111',
              }}
            >
              <IconHeart
                size={14}
                color={previewItem != null && isFav(previewItem) ? '#111111' : '#fff'}
              />
              <Text style={{
                fontSize: 12, fontWeight: '800',
                color: previewItem != null && isFav(previewItem) ? '#111111' : '#fff',
              }}>
                {previewItem != null && isFav(previewItem)
                  ? 'Remover dos favoritos'
                  : 'Adicionar aos favoritos'}
              </Text>
            </TouchableOpacity>
          </Animated.View>
        </Pressable>
      </Modal>

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
