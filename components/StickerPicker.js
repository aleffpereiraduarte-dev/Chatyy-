import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, ScrollView, Platform, Image,
  Alert, ActivityIndicator, TextInput, StyleSheet, Dimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import CachedImage from './CachedImage';
import { IconX, IconPlus, IconSearch, IconStar, IconStarFilled, IconTrash, IconFilm, IconPackage, IconClock, IconPalette, IconImage, IconCamera, IconSend, IconChevronUp, IconGrid, IconSettings, IconSmile } from './Icons';
import * as api from '../services/api';
// [2026-10-19 sticker-cache] listas por conta no KV + arquivos no disco (LRU 300 MB).
import * as stkCache from '../services/stickerCache';
// [2026-10-08 sticker-maker] criador novo (recorte automático + contorno +
// texto/desenho/emoji + WebP 512) substitui o StickerEditor antigo aqui.
import StickerMaker, { pickStickerSourceImage } from './stickers/StickerMaker';
import { pickMedia } from '../services/stickerImagePicker';
import Svg, { Path as SvgPath } from 'react-native-svg';
import Sheet from './ui/Sheet';
import ActionList from './ui/ActionList';
import { Overlay, overlayColors, DarkColors } from '../constants/theme';

import { a11yLabel } from '../utils/a11yLabel'; // [2026-10-20 a11y] rótulos dos botões só-ícone
function _tr(t, key, fb) {
  try { const v = t ? t(key) : ''; return v && v !== key ? v : fb; } catch { return fb; }
}
const CREATE_TILE = '__chatyy_create_sticker__';
// [2026-10-13 P2-9] Desktop web: busca já aberta e focada (digitar busca figurinha).
const _STK_DESKTOP_WEB = (() => {
  if (Platform.OS !== 'web') return false;
  try { return !!(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches); } catch { return false; }
})();
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
// [2026-10-12 overlays] Agora usa o Sheet + ActionList do design system
// (alça, raio 20, backdrop 0.4, mola, safe-area, back do Android). A opção
// 'cancel' vira o botão Cancelar separado no rodapé (padrão iOS/WhatsApp).
const CHOICE_ICONS = {
  gallery: IconImage, camera: IconCamera, video: IconFilm,
  send: IconSend, front: IconChevronUp, fav: IconStar, del: IconTrash,
};
function ChoiceSheet({ visible, title, options, onClose, colors }) {
  const opts = options || [];
  const cancel = opts.find((o) => o.key === 'cancel');
  const items = opts.filter((o) => o.key !== 'cancel').map((o) => ({
    key: o.key, label: o.label, icon: o.icon || CHOICE_ICONS[o.key], destructive: !!o.destructive,
    onPress: () => { setTimeout(() => o.onPress && o.onPress(), 60); },
  }));
  return (
    <Sheet visible={!!visible} onClose={onClose} subtitle={title || undefined}>
      <ActionList items={items} onDone={onClose} separators />
      {cancel ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
          <TouchableOpacity
            onPress={() => { onClose(); setTimeout(() => cancel.onPress && cancel.onPress(), 60); }}
            style={{ height: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: overlayColors(colors, colors.background === '#000000' || colors.background === DarkColors.background).neutralButton }}
            accessibilityRole="button"
            accessibilityLabel={cancel.label}
          >
            <Text style={{ fontSize: 16, fontWeight: '600', color: colors.text }}>{cancel.label}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </Sheet>
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

// [2026-10-19 sticker-cache] Recentes / favoritas / minhas agora são POR CONTA
// (KV do stickerCache). As chaves antigas eram globais (vazavam entre contas):
// migrateLegacyStickerLists() adota na 1ª abertura e apaga.
const _META_OF = { [RECENT_KEY]: 'st_recent', [MINE_KEY]: 'st_mine_urls', [FAV_KEY]: 'st_fav' };
function _metaList(key) {
  try { const v = stkCache.getStickerMeta(_META_OF[key]); return Array.isArray(v) ? v : []; } catch { return []; }
}
async function storageGet(key) {
  if (_META_OF[key]) {
    try { await stkCache.migrateLegacyStickerLists(); } catch {}
    return _metaList(key);
  }
  return _legacyStorageGet(key);
}
async function storageSet(key, value) {
  if (_META_OF[key]) {
    try {
      stkCache.setStickerMeta(_META_OF[key], Array.isArray(value) ? value : []);
      if (key === FAV_KEY) stkCache.prefetchStickers((value || []).filter(u => typeof u === 'string'));
    } catch {}
    return;
  }
  return _legacyStorageSet(key, value);
}
// Mineração rápida das listas do KV p/ o 1º frame (sem esperar servidor).
function _mineFullSync() { try { const v = stkCache.getStickerMeta('st_mine'); return Array.isArray(v) ? v : []; } catch { return []; } }
function _metaArr(name) { try { const v = stkCache.getStickerMeta(name); return Array.isArray(v) ? v : []; } catch { return []; } }
function _packItemsSync(packs) {
  const out = {};
  for (const p of packs || []) {
    const id = p && p.id;
    if (id == null) continue;
    const v = stkCache.getStickerMeta('pack_' + id);
    if (Array.isArray(v)) out[id] = v;
  }
  return out;
}

async function _legacyStorageGet(key) {
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

async function _legacyStorageSet(key, value) {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(value));
      return;
    }
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

// ============================================================
// [2026-10-23 figurinhas-organizar] Painel nível WhatsApp/Telegram:
// UMA rolagem com seções na ordem Recentes · Favoritas · Minhas figurinhas ·
// pacotes adicionados (ordem do usuário, nome + capa) · Chatyy (oficiais +
// mascote) · Emojis; barra de abas embaixo com o ícone/capa de cada seção
// (toque = pula; rolar = acende a aba). Busca por emoji ou palavra (tags das
// minhas figurinhas e dos pacotes — local/instantânea — + servidor). Segurar
// = Favoritar / Remover dos recentes / Emojis de busca / Excluir (só minhas) /
// Ver pacote. Tudo pinta do KV da conta no 1º frame (stickerCache).
// ============================================================
const COLS = 5;
const HEADER_H = 30;
const LOADING_H = 56;
const TAB_W = 44;
const QUICK_EMOJIS = ['😂', '😍', '😭', '😡', '🥳', '😎', '🤔', '😴', '👍', '🙏', '❤️', '🔥', '🎉', '😱', '🤣', '😘'];
const _isLottieS = (s) => typeof s === 'string' && /\.json(?:[?#].*)?$/i.test(s);
const _isImgS = (s) => typeof s === 'string' && (/^https?:\/\//.test(s) || s.startsWith('/data/'));
// Lottie não toca no seletor JS: mostra o PNG irmão (mesmo nome) e envia como lottie_sticker.
const _lottiePng = (u) => String(u).replace(/\.json(?=$|[?#])/i, '.png');
function _keywordEmojis(q) {
  const s = String(q || '').trim().toLowerCase();
  if (s.length < 2) return [];
  const out = new Set();
  for (const [k, emojis] of Object.entries(SEARCH_INDEX)) {
    if (k.startsWith(s) || (s.length >= 4 && s.startsWith(k))) emojis.forEach((e) => out.add(e));
  }
  return [...out];
}
function _packCover(p) {
  const u = p && (p.cover_url || p.cover || p.thumb_url || p.icon_url);
  if (!u) return null;
  if (/^https?:\/\//.test(u)) return u;
  if (u.startsWith('/data/')) {
    try { return api.getMediaUrl(u); } catch { return 'https://chatyy.com.br' + u; }
  }
  return `https://media.chatyy.com.br/${u.replace(/^\/+/, '')}`;
}
function _mascotItems() {
  try {
    const M = require('./mascot/ChatyyMascot');
    return [M.MASCOT_GREETING_URL || ((M.MASCOT_STICKER_BASE || 'https://chatyy.com.br/stickers/') + 'chatyy-aceno.json')];
  } catch { return []; }
}
function _subscribe(fn) {
  try { return stkCache.subscribeStickerLists(fn); } catch { return () => {}; }
}

export default function StickerPicker({ onSelect, onClose, colors, t, userEmail, bottomInset = 0 }) {
  // [2026-10-10] Painel substitui o teclado (WhatsApp): ocupa o lugar do home
  // indicator — a aba de pacotes fica ACIMA do inset, sem faixa vazia.
  const _bi = Math.max(0, Number(bottomInset) || 0);
  const router = useRouter();
  const [activeKey, setActiveKey] = useState('recent');
  // [2026-10-19 sticker-cache] 1º frame direto do KV da conta (offline também).
  const [recents, setRecents] = useState(() => { try { return stkCache.getStickerRecents(); } catch { return []; } });
  const [mineFull, setMineFull] = useState(_mineFullSync);
  const [mine, setMine] = useState(() => _metaList(MINE_KEY));
  const [favorites, setFavorites] = useState(() => _metaList(FAV_KEY));
  const [installedPacks, setInstalledPacks] = useState(() => _metaArr('mkt_packs'));
  const [packItems, setPackItems] = useState(() => _packItemsSync(_metaArr('mkt_packs')));
  const [creating, setCreating] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchBackend, setSearchBackend] = useState([]);
  const [searchGlobal, setSearchGlobal] = useState([]);
  const [showSearch, setShowSearch] = useState(_STK_DESKTOP_WEB);
  // 1º frame já com a largura (nativo: painel = largura da tela) → grade sem esperar o onLayout.
  const [gridW, setGridW] = useState(() => { if (Platform.OS === 'web') return 0; try { return Math.round(Dimensions.get('window').width) || 0; } catch { return 0; } });
  const searchRef = useRef(null);
  const listRef = useRef(null);
  const tabsRef = useRef(null);
  const jumpingRef = useRef(0);
  const [actionItem, setActionItem] = useState(null); // figurinha segurada
  const [tagEdit, setTagEdit] = useState(null);       // { id, url, tags[] }

  // KV → estado (qualquer tela que criar/salvar/favoritar avisa aqui)
  useEffect(() => _subscribe((name) => {
    if (name === 'st_recent') setRecents(stkCache.getStickerRecents());
    else if (name === 'st_fav') setFavorites(_metaList(FAV_KEY));
    else if (name === 'st_mine') { setMineFull(_mineFullSync()); setMine(_metaList(MINE_KEY)); }
    else if (name === 'mkt_packs') setInstalledPacks(_metaArr('mkt_packs'));
  }), []);

  useEffect(() => {
    // [2026-10-19 sticker-cache] Já pintou do KV (useState acima). Aqui: adota as
    // chaves antigas (1ª vez), revalida no servidor em 2º plano e só troca o
    // estado do que MUDOU (diff por assinatura) — sem piscar a grade.
    let alive = true;
    const pull = (name) => {
      if (!alive) return;
      if (name === 'st_fav' || name === '*') setFavorites(_metaList(FAV_KEY));
      if (name === 'st_mine' || name === '*') {
        const full = _mineFullSync();
        setMineFull(full);
        const urls = full.map(s => s.url).filter(Boolean);
        if (urls.length) { setMine(urls); storageSet(MINE_KEY, urls); }
      }
      if (name === 'mkt_packs' || name === '*') setInstalledPacks(_metaArr('mkt_packs'));
      if (name === '*' || (typeof name === 'string' && name.startsWith('pack_'))) {
        setPackItems(prev => ({ ...prev, ..._packItemsSync(_metaArr('mkt_packs')) }));
      }
    };
    (async () => {
      try {
        await stkCache.migrateLegacyStickerLists();
        if (!alive) return;
        setRecents(stkCache.getStickerRecents());
        setFavorites(prev => (prev && prev.length ? prev : _metaList(FAV_KEY)));
        setMine(prev => (prev && prev.length ? prev : _metaList(MINE_KEY)));
      } catch {}
      // Pessoais em qualquer rede; pacotes instalados só no Wi-Fi.
      try { await stkCache.syncStickerLibrary({ onChange: pull }); } catch {}
    })();
    return () => { alive = false; };
  }, []);

  const resolveStickerUri = useCallback((s) => {
    if (typeof s !== 'string') return s;
    if (_isLottieS(s)) return _lottiePng(s);
    if (_isImgS(s)) {
      try { return stkCache.stickerDisplayUri(s); } catch {}
    }
    if (s.startsWith('/data/')) {
      try { return api.getMediaUrl(s); } catch { return 'https://chatyy.com.br' + s; }
    }
    return s;
  }, []);

  const handleSelect = useCallback((item) => {
    try { stkCache.pushStickerRecent(item); } catch {}
    // For server-relative URLs, hand the absolute form to the sender so the
    // recipient's client can fetch the image regardless of its own base URL.
    // [2026-10-08 sticker-maker] /data/sticker-files só existe no US (CDN_URL);
    // getMediaUrl roteia /data/sticker-files → US.
    let toSend = item;
    if (typeof item === 'string' && item.startsWith('/data/')) {
      try { toSend = api.getMediaUrl(item); } catch { toSend = 'https://chatyy.com.br' + item; }
    }
    if (_isLottieS(toSend)) { onSelect(toSend, 'lottie_sticker'); return; }
    onSelect(toSend);
  }, [onSelect]);

  const isFav = useCallback((s) => favorites.includes(s), [favorites]);
  const toggleFavorite = useCallback((item) => {
    try { stkCache.toggleStickerFavorite(typeof item === 'string' ? item : String(item)); } catch {}
  }, []);

  // ── seções ────────────────────────────────────────────────────────────────
  const mineUrls = useMemo(() => (mineFull.length ? mineFull.map(s => s.url).filter(Boolean) : mine), [mineFull, mine]);
  const groups = useMemo(() => {
    try { return stkCache.groupStickerPacks(installedPacks); } catch { return { added: installedPacks || [], chatyy: [] }; }
  }, [installedPacks]);
  const sections = useMemo(() => {
    const out = [];
    const rec = (recents || []).filter((u) => typeof u === 'string' && u).slice(0, 30);
    if (rec.length) out.push({ key: 'recent', title: _tr(t, 'chat.npanel.recent', 'Recentes'), icon: IconClock, items: rec });
    if (favorites.length) out.push({ key: 'favorites', title: _tr(t, 'chat.npanel.favorites', 'Favoritas'), icon: IconStar, items: favorites });
    out.push({ key: 'mine', title: _tr(t, 'stickers.myStickers', 'Minhas figurinhas'), icon: IconPalette, items: mineUrls, mine: true });
    const packSec = (p) => {
      const id = p.id ?? p.pack_id;
      const raw = packItems[id];
      const items = Array.isArray(raw) ? raw.map(it => it && (it.url || it.image_url || it.sticker_id)).filter(Boolean) : [];
      return { key: 'mkt-' + id, packId: id, title: String(p.name || ''), cover: _packCover(p) || (items[0] ? resolveStickerUri(items[0]) : null), animated: !!p.animated, items, loading: !Array.isArray(raw) };
    };
    for (const p of groups.added) out.push(packSec(p));
    const mascot = _mascotItems();
    if (mascot.length) out.push({ key: 'chatyy-mascot', title: 'Chatyy', cover: _lottiePng(mascot[0]), items: mascot, chatyy: true });
    for (const p of groups.chatyy) out.push({ ...packSec(p), chatyy: true });
    out.push({ key: 'emoji', title: _tr(t, 'chat.npanel.emoji', 'Emoji'), icon: IconSmile, items: STICKER_PACKS.reduce((a, p) => a.concat(p.stickers), []) });
    // o tile "Criar figurinha" abre a 1ª seção pessoal (Recentes ou Minhas)
    const first = out.find((s) => s.key === 'recent' || s.key === 'mine');
    if (first) first.create = true;
    return out;
  }, [recents, favorites, mineUrls, groups, packItems, t, resolveStickerUri]);

  // ── busca ─────────────────────────────────────────────────────────────────
  const q = searchQuery.trim();
  const searching = showSearch && !!q;
  const localHits = useMemo(() => {
    if (!searching) return [];
    let hits = [];
    try { hits = stkCache.searchStickersLocal(q, { emojis: _keywordEmojis(q) }); } catch {}
    // recentes/favoritas sem tag mas que sejam MINHAS/de pacote já entram acima;
    // aqui só a ordem: o que a pessoa mais usa sobe.
    const rank = new Map();
    (recents || []).forEach((u, i) => rank.set(u, 100 - i));
    return hits.map(h => h.url).sort((a, b) => (rank.get(b) || 0) - (rank.get(a) || 0));
  }, [searching, q, recents, mineFull, packItems]); // eslint-disable-line react-hooks/exhaustive-deps
  const emojiHits = useMemo(() => {
    if (!searching) return [];
    const ql = q.toLowerCase();
    const res = new Set(_keywordEmojis(q));
    for (const [keyword, emojis] of Object.entries(SEARCH_INDEX)) { if (keyword.includes(ql)) emojis.forEach(e => res.add(e)); }
    for (const pack of STICKER_PACKS) {
      if (pack.name.toLowerCase().includes(ql)) pack.stickers.forEach(s0 => res.add(s0));
      if (pack.stickers.includes(q)) res.add(q);
    }
    return [...res].slice(0, 40);
  }, [searching, q]);
  useEffect(() => {
    setSearchBackend([]); setSearchGlobal([]);
    if (!searching) return undefined;
    // [2026-10-21] `stale`: resposta de uma busca antiga chegava depois da nova.
    let stale = false;
    const ql = q.toLowerCase();
    const tid = setTimeout(async () => {
      if (ql.length < 2) return;
      try {
        const r = await api.chatStickerSearch(ql);
        const items = r?.items || r?.data?.items || [];
        if (!stale) setSearchBackend(items.map(x => x.url).filter(Boolean));
      } catch {}
      try {
        const gr = await api.chatStickerGlobalSearch(ql);
        const gitems = gr?.items || gr?.data?.items || [];
        if (!stale) setSearchGlobal(gitems.map(x => x.url).filter(Boolean));
      } catch {}
    }, 300);
    return () => { stale = true; clearTimeout(tid); };
  }, [searching, q]);
  const searchSections = useMemo(() => {
    if (!searching) return [];
    const seen = new Set();
    const uniq = (list) => list.filter((u) => { if (!u || seen.has(u)) return false; seen.add(u); return true; });
    const mineAndPacks = uniq([...localHits, ...searchBackend]);
    const global = uniq(searchGlobal);
    const emo = uniq(emojiHits);
    const out = [];
    if (mineAndPacks.length) out.push({ key: 's-mine', title: _tr(t, 'stickerPicker.searchYours', 'Suas figurinhas e pacotes'), items: mineAndPacks.slice(0, 150) });
    if (global.length) out.push({ key: 's-global', title: _tr(t, 'stickerPicker.searchMore', 'Mais resultados'), items: global.slice(0, 90) });
    if (emo.length) out.push({ key: 's-emoji', title: _tr(t, 'chat.npanel.emoji', 'Emoji'), items: emo });
    return out;
  }, [searching, localHits, searchBackend, searchGlobal, emojiHits, t]);

  // ── linhas (cabeçalho + fileiras de 5) com altura fixa → pulo exato ─────────
  const cell = gridW > 0 ? Math.floor((gridW - 4) / COLS) : 64;
  const visibleSections = searching ? searchSections : sections;
  const { rows, headerIndex, offsets } = useMemo(() => {
    const rws = [];
    const hIdx = {};
    for (const sec of visibleSections) {
      hIdx[sec.key] = rws.length;
      rws.push({ type: 'h', key: 'h:' + sec.key, sec });
      const items = sec.create ? [CREATE_TILE, ...sec.items] : sec.items;
      if (sec.loading && !items.length) { rws.push({ type: 'loading', key: 'l:' + sec.key, sec }); continue; }
      if (!items.length) { rws.push({ type: 'empty', key: 'e:' + sec.key, sec }); continue; }
      for (let i = 0; i < items.length; i += COLS) rws.push({ type: 'r', key: 'r:' + sec.key + ':' + i, sec, items: items.slice(i, i + COLS) });
    }
    const offs = [];
    let y = 0;
    for (const r of rws) { offs.push(y); y += r.type === 'h' ? HEADER_H : r.type === 'r' ? cell : LOADING_H; }
    return { rows: rws, headerIndex: hIdx, offsets: offs };
  }, [visibleSections, cell]);
  const getItemLayout = useCallback((_d, index) => {
    const r = rows[index];
    const len = !r ? 0 : r.type === 'h' ? HEADER_H : r.type === 'r' ? cell : LOADING_H;
    return { length: len, offset: offsets[index] || 0, index };
  }, [rows, offsets, cell]);

  const scrollTabIntoView = useCallback((key) => {
    const i = sections.findIndex((s) => s.key === key);
    if (i < 0) return;
    try { tabsRef.current?.scrollTo?.({ x: Math.max(0, i * TAB_W - TAB_W * 2), animated: true }); } catch {}
  }, [sections]);
  const jumpTo = useCallback((key) => {
    setActiveKey(key);
    scrollTabIntoView(key);
    const idx = headerIndex[key];
    if (idx == null) return;
    jumpingRef.current = Date.now();
    try { listRef.current?.scrollToOffset?.({ offset: offsets[idx] || 0, animated: false }); } catch {}
  }, [headerIndex, offsets, scrollTabIntoView]);
  const searchingRef = useRef(false);
  searchingRef.current = searching;
  const onViewable = useRef(({ viewableItems }) => {
    if (searchingRef.current || Date.now() - jumpingRef.current < 400) return;
    const first = (viewableItems || []).find((v) => v && v.item && v.item.sec);
    const k = first && first.item.sec.key;
    if (k && _activeRef.current !== k) { _activeRef.current = k; setActiveKey(k); _scrollTabRef.current && _scrollTabRef.current(k); }
  }).current;
  const _activeRef = useRef(activeKey);
  _activeRef.current = activeKey;
  const _scrollTabRef = useRef(null);
  _scrollTabRef.current = scrollTabIntoView;
  const viewCfg = useRef({ itemVisiblePercentThreshold: 10 }).current;

  // ── criar ────────────────────────────────────────────────────────────────
  const [editorUri, setEditorUri] = useState(null);
  // [2026-10-12 sticker-picker-fix] pickStickerSourceImage espera o overlay
  // sair (iOS dispensava o PHPicker junto). `picking` = spinner + trava toque duplo.
  const pickingRef = useRef(false);
  const [picking, setPicking] = useState(false);
  const pickImageForEditor = useCallback(async (source) => {
    if (pickingRef.current && Platform.OS !== 'web') return;
    pickingRef.current = true;
    if (Platform.OS !== 'web') setPicking(true); // web: seletor de arquivo pode não avisar cancelamento
    try {
      const uri = await pickStickerSourceImage(source, { t, afterOverlay: true });
      if (uri) setEditorUri(uri);
    } catch {
      Alert.alert(
        _tr(t, 'stickerMaker.pickFailedTitle', 'Não foi possível abrir'),
        _tr(t, 'stickerMaker.pickFailed', 'Não conseguimos abrir sua galeria agora. Tente de novo.'),
      );
    } finally {
      pickingRef.current = false;
      setPicking(false);
    }
  }, [t]);

  // Vídeo curto → figurinha animada (WebP) direto no servidor
  const pickVideoForAnimatedSticker = useCallback(async () => {
    if (pickingRef.current && Platform.OS !== 'web') return;
    pickingRef.current = true;
    if (Platform.OS !== 'web') setPicking(true);
    try {
      const asset = await pickMedia({ source: 'gallery', media: 'video', t, afterOverlay: true, quality: 0.85, videoMaxDuration: 5 });
      if (!asset) return;
      if (asset.size && asset.size > 20 * 1024 * 1024) {
        Alert.alert(_tr(t, 'common.error', 'Erro'), _tr(t, 'chat.stickerTooLarge', 'Vídeo muito grande (máx 20MB)'));
        return;
      }
      const file = Platform.OS === 'web'
        ? { _raw: asset.file, name: asset.fileName || 'sticker.mp4', type: asset.mimeType || 'video/mp4' }
        : { uri: asset.uri, name: asset.fileName || 'sticker.mp4', type: asset.mimeType || 'video/mp4' };
      pickingRef.current = false;
      setPicking(false);
      setCreating(true);
      const r = await api.chatStickerCreateAnimated(file);
      const d = (r && (r.data || r)) || {};
      const url = d.cdn_url || d.url || r?.cdn_url || r?.url;
      if (r?.success && url) {
        try { stkCache.noteStickerAdded({ id: d.sticker_id || d.id || null, pack_id: d.pack_id || null, url, is_animated: true }); } catch {}
        jumpTo(sections[0] && sections[0].key === 'recent' ? 'recent' : 'mine');
      } else {
        Alert.alert(_tr(t, 'common.error', 'Erro'), _tr(t, 'stickerPicker.animatedFailed', 'Falha ao criar figurinha animada.'));
      }
    } catch (e) {
      Alert.alert(_tr(t, 'common.error', 'Erro'), _tr(t, 'stickerPicker.animatedFailed', 'Falha ao criar figurinha animada.'));
    } finally {
      pickingRef.current = false;
      setPicking(false);
      setCreating(false);
    }
  }, [t, jumpTo, sections]);

  // [2026-10-08 sticker-maker] "Criar figurinha" → folha: Galeria / Câmera / Vídeo (animada)
  const [createSheet, setCreateSheet] = useState(false);
  const createSticker = useCallback(() => {
    if (creating || (pickingRef.current && Platform.OS !== 'web')) return;
    setCreateSheet(true);
  }, [creating]);
  // StickerMaker já gravou no KV (noteStickerAdded): só leva a pessoa ao topo.
  const handleMakerSaved = useCallback(() => {
    try { listRef.current?.scrollToOffset?.({ offset: 0, animated: true }); } catch {}
    setActiveKey('recent');
  }, []);

  // ── segurar ─────────────────────────────────────────────────────────────
  const mineRowOf = useCallback((url) => {
    if (!url) return null;
    return mineFull.find((s0) => s0 && s0.url === url) || null;
  }, [mineFull]);
  const originOf = useCallback((url) => { try { return stkCache.stickerOrigin(url); } catch { return null; } }, []);
  const deleteMine = useCallback((url) => {
    const row = mineRowOf(url) || (originOf(url) || {}).row;
    if (!row || !row.id) return;
    const go = async () => {
      try {
        const r = await api.chatStickerDelete(row.id);
        if (r?.success === false) throw new Error('x');
        try { stkCache.noteStickerRemoved(url, row.id); } catch {}
      } catch {
        Alert.alert(_tr(t, 'common.error', 'Erro'), _tr(t, 'stickers.actionFailed', 'Não deu certo. Tente de novo.'));
      }
    };
    if (Platform.OS === 'web') { go(); return; }
    Alert.alert(_tr(t, 'stickerPicker.deleteTitle', 'Excluir figurinha?'), _tr(t, 'stickerPicker.deleteBody', 'Ela sai de Minhas figurinhas em todos os seus aparelhos.'), [
      { text: _tr(t, 'common.cancel', 'Cancelar'), style: 'cancel' },
      { text: _tr(t, 'common.delete', 'Excluir'), style: 'destructive', onPress: go },
    ]);
  }, [mineRowOf, originOf, t]);
  const moveMineToFront = useCallback(async (url) => {
    const row = mineRowOf(url);
    if (!row) return;
    const nextFull = [row, ...mineFull.filter(x => x.id !== row.id)];
    try { stkCache.setStickerMeta('st_mine', nextFull); stkCache.setStickerMeta('st_mine_urls', nextFull.map(x => x.url).filter(Boolean)); } catch {}
    setMineFull(nextFull);
    setMine(nextFull.map(x => x.url).filter(Boolean));
    const ids = nextFull.map(x => x.id).filter(Boolean);
    if (ids.length) { try { await api.chatStickerReorder(ids); } catch {} }
  }, [mineRowOf, mineFull]);

  const actionOptions = useMemo(() => {
    const it = actionItem;
    if (it == null) return [];
    const img = _isImgS(it);
    const mineRow = img ? (mineRowOf(it) || ((originOf(it) || {}).mine ? (originOf(it) || {}).row : null)) : null;
    const origin = img ? originOf(it) : null;
    const inRecents = (recents || []).includes(it);
    const opts = [
      { key: 'send', label: _tr(t, 'stickerMaker.send', 'Enviar'), icon: IconSend, onPress: () => handleSelect(it) },
      isFav(it)
        ? { key: 'fav', label: _tr(t, 'stickers.removeFromFavorites', 'Remover das favoritas'), icon: IconStarFilled, onPress: () => toggleFavorite(it) }
        : { key: 'fav', label: _tr(t, 'stickers.addToFavorites', 'Adicionar às favoritas'), icon: IconStar, onPress: () => toggleFavorite(it) },
    ];
    if (inRecents) opts.push({ key: 'unrecent', label: _tr(t, 'stickerPicker.removeRecent', 'Remover dos recentes'), icon: IconClock, onPress: () => { try { stkCache.removeStickerRecent(it); } catch {} } });
    if (mineRow && mineRow.id) {
      opts.push({ key: 'tags', label: _tr(t, 'stickerPicker.editTags', 'Emojis de busca'), subtitle: String(mineRow.emoji_tags || mineRow.emoji || '').split(',').filter(Boolean).join(' ') || undefined, icon: IconSmile, onPress: () => setTimeout(() => setTagEdit({ id: mineRow.id, url: it, tags: String(mineRow.emoji_tags || mineRow.emoji || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 3) }), 250) });
      opts.push({ key: 'front', label: _tr(t, 'stickerMaker.moveToFront', 'Mover para o início'), icon: IconChevronUp, onPress: () => moveMineToFront(it) });
    }
    if (origin && origin.packId && !(origin.mine && !groups.added.some(p => String(p.id) === String(origin.packId)))) {
      opts.push({ key: 'pack', label: _tr(t, 'stickers.viewPack', 'Ver pacote'), icon: IconPackage, onPress: () => { try { onClose && onClose(); } catch {} setTimeout(() => router.push({ pathname: '/stickers/pack', params: { id: String(origin.packId) } }), 60); } });
    }
    if (mineRow && mineRow.id) opts.push({ key: 'del', destructive: true, label: _tr(t, 'stickerMaker.deleteSticker', 'Excluir figurinha'), icon: IconTrash, onPress: () => deleteMine(it) });
    return opts;
  }, [actionItem, recents, isFav, mineRowOf, originOf, groups, t, handleSelect, toggleFavorite, moveMineToFront, deleteMine, onClose, router]);

  const saveTags = useCallback(async () => {
    const te = tagEdit;
    setTagEdit(null);
    if (!te || !te.id) return;
    let ok = false;
    try { ok = await stkCache.setMyStickerTags(te.id, te.tags); } catch {}
    if (!ok) { try { require('./ui/Toast').showToast({ message: _tr(t, 'stickerPicker.tagsLocal', 'Salvo neste aparelho. Sincroniza quando o servidor responder.'), kind: 'info' }); } catch {} }
  }, [tagEdit, t]);

  // ── render ──────────────────────────────────────────────────────────────
  const renderCell = (item, sec) => {
    if (item === CREATE_TILE) {
      return (
        <TouchableOpacity
          key="create"
          onPress={createSticker}
          disabled={creating || picking}
          style={{ width: cell, height: cell, padding: 4 }}
          accessibilityRole="button"
          accessibilityLabel={_tr(t, 'stickerMaker.pickTitle', 'Criar figurinha')}
          activeOpacity={0.6}
        >
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.textTertiary }}>
            {(creating || picking) ? <ActivityIndicator size="small" color={colors.text} /> : <IconStickerPlus size={22} color={colors.text} />}
            <Text style={{ fontSize: 9, fontWeight: '700', color: colors.text, marginTop: 2, textAlign: 'center' }} numberOfLines={2}>{_tr(t, 'stickerMaker.pickTitle', 'Criar figurinha')}</Text>
          </View>
        </TouchableOpacity>
      );
    }
    const img = _isImgS(item);
    return (
      <TouchableOpacity
        key={sec.key + ':' + item}
        onPress={() => handleSelect(item)}
        onLongPress={() => setActionItem(item)}
        delayLongPress={350}
        style={{ width: cell, height: cell, alignItems: 'center', justifyContent: 'center', padding: 4 }}
        activeOpacity={0.5}
        accessibilityRole="button"
        accessibilityLabel={img ? _tr(t, 'chat.sticker', 'Figurinha') : item}
        accessibilityHint={_tr(t, 'stickerPicker.holdHint', 'Segure para mais opções')}
      >
        {img ? (
          <CachedImage source={{ uri: resolveStickerUri(item) }} style={{ width: '92%', height: '92%' }} resizeMode="contain" placeholder={STICKER_CLEAR_PLACEHOLDER} showSpinner={false} />
        ) : (
          <Text style={{ fontSize: Math.round(cell * 0.52) }} allowFontScaling={false}>{item}</Text>
        )}
        {isFav(item) && sec.key !== 'favorites' ? (
          <View style={{ position: 'absolute', top: 3, right: 3 }}>
            <IconStarFilled size={9} color={colors.text} />
          </View>
        ) : null}
      </TouchableOpacity>
    );
  };
  const renderRow = ({ item: r }) => {
    if (r.type === 'h') {
      return (
        <View style={{ height: HEADER_H, flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 10, paddingBottom: 4 }}>
          <Text style={{ flex: 1, fontSize: 11, fontWeight: '700', color: colors.textSecondary, letterSpacing: 0.3, textTransform: 'uppercase' }} numberOfLines={1}>{r.sec.title}</Text>
          {r.sec.packId != null && !searching ? (
            <TouchableOpacity hitSlop={8} onPress={() => { try { onClose && onClose(); } catch {} setTimeout(() => router.push({ pathname: '/stickers/pack', params: { id: String(r.sec.packId) } }), 60); }} accessibilityRole="button" accessibilityLabel={_tr(t, 'stickers.viewPack', 'Ver pacote')}>
              <Text style={{ fontSize: 11, fontWeight: '600', color: colors.textTertiary }}>{_tr(t, 'stickers.viewPack', 'Ver pacote')}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      );
    }
    if (r.type === 'loading') return <View style={{ height: LOADING_H, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator size="small" color={colors.textTertiary} /></View>;
    if (r.type === 'empty') {
      return (
        <View style={{ height: LOADING_H, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 }}>
          <Text style={{ fontSize: 12, color: colors.textTertiary, textAlign: 'center' }} numberOfLines={2}>
            {r.sec.mine ? _tr(t, 'stickerPicker.mineEmpty', 'Toque em "Criar figurinha" para fazer a sua') : ''}
          </Text>
        </View>
      );
    }
    return <View style={{ flexDirection: 'row', height: cell, paddingHorizontal: 2 }}>{r.items.map((it) => renderCell(it, r.sec))}</View>;
  };

  return (
    <View style={{ height: 340 + _bi, paddingBottom: _bi, backgroundColor: colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, ...(Platform.OS === 'web' ? { borderTopLeftRadius: Overlay.cardRadius, borderTopRightRadius: Overlay.cardRadius, overflow: 'hidden' } : null) }}>
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
      {/* segurar figurinha */}
      <Sheet visible={actionItem != null} onClose={() => setActionItem(null)}>
        {actionItem != null ? (
          <View style={{ alignItems: 'center', paddingBottom: 6 }}>
            {_isImgS(actionItem)
              ? <CachedImage source={{ uri: resolveStickerUri(actionItem) }} style={{ width: 132, height: 132 }} resizeMode="contain" placeholder={STICKER_CLEAR_PLACEHOLDER} />
              : <Text style={{ fontSize: 88 }} allowFontScaling={false}>{actionItem}</Text>}
          </View>
        ) : null}
        <ActionList items={actionOptions} onDone={() => setActionItem(null)} separators />
      </Sheet>
      {/* emojis de busca (minhas) */}
      <Sheet visible={!!tagEdit} onClose={() => setTagEdit(null)} title={_tr(t, 'stickerPicker.editTags', 'Emojis de busca')} subtitle={_tr(t, 'stickerMaker.tagsSubShort', 'Escolha até 3')}>
        {tagEdit ? (
          <View style={{ paddingHorizontal: 16 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 10, marginBottom: 8 }}>
              {[0, 1, 2].map((i) => (
                <TouchableOpacity key={i} disabled={!tagEdit.tags[i]} onPress={() => setTagEdit((te) => (te ? { ...te, tags: te.tags.filter((x) => x !== te.tags[i]) } : te))}
                  style={{ width: 46, height: 46, borderRadius: 12, borderWidth: 1, borderStyle: tagEdit.tags[i] ? 'solid' : 'dashed', borderColor: tagEdit.tags[i] ? colors.text : colors.border, alignItems: 'center', justifyContent: 'center' }}
                  accessibilityRole="button" accessibilityLabel={tagEdit.tags[i] ? `${_tr(t, 'common.remove', 'Remover')} ${tagEdit.tags[i]}` : _tr(t, 'stickerMaker.tagsEmpty', 'Vazio')}>
                  {tagEdit.tags[i] ? <Text style={{ fontSize: 26 }} allowFontScaling={false}>{tagEdit.tags[i]}</Text> : <IconPlus size={14} color={colors.textTertiary} />}
                </TouchableOpacity>
              ))}
            </View>
            <ScrollView style={{ maxHeight: 180 }} contentContainerStyle={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' }}>
              {STICKER_PACKS[0].stickers.concat(STICKER_PACKS[1].stickers.slice(0, 12), STICKER_PACKS[2].stickers.slice(0, 12)).filter((e, i, a) => a.indexOf(e) === i).map((em) => {
                const on = tagEdit.tags.includes(em);
                return (
                  <TouchableOpacity key={em} onPress={() => setTagEdit((te) => (te ? { ...te, tags: on ? te.tags.filter((x) => x !== em) : [...te.tags, em].slice(-3) } : te))}
                    style={{ width: 42, height: 42, borderRadius: 10, alignItems: 'center', justifyContent: 'center', margin: 2, backgroundColor: on ? colors.text + '1F' : 'transparent' }}
                    accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={em}>
                    <Text style={{ fontSize: 24 }} allowFontScaling={false}>{em}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity onPress={saveTags} style={{ height: 48, borderRadius: 12, backgroundColor: colors.text, alignItems: 'center', justifyContent: 'center', marginTop: 10 }} accessibilityRole="button">
              <Text style={{ fontSize: 16, fontWeight: '700', color: colors.background }}>{_tr(t, 'common.save', 'Salvar')}</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </Sheet>

      {/* Cabeçalho: busca · configurações · fechar */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, gap: 8 }}>
        {showSearch ? (
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.background, borderRadius: 20, paddingHorizontal: 10 }}>
            <IconSearch size={14} color={colors.textTertiary} />
            <TextInput
              ref={searchRef}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder={_tr(t, 'stickerPicker.searchPh', 'Buscar por emoji ou palavra')}
              placeholderTextColor={colors.textTertiary}
              style={{ flex: 1, paddingVertical: 6, paddingHorizontal: 8, color: colors.text, fontSize: 13 }}
              autoFocus
              autoCorrect={false}
            />
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={a11yLabel('common.clear', 'Limpar')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => { setShowSearch(false); setSearchQuery(''); }}>
              <IconX size={14} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            onPress={() => { setShowSearch(true); setTimeout(() => searchRef.current?.focus(), 100); }}
            style={{ flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.background, borderRadius: 20, paddingHorizontal: 10, height: 32, gap: 8 }}
            accessibilityRole="search"
            accessibilityLabel={_tr(t, 'stickerPicker.searchPh', 'Buscar por emoji ou palavra')}
            activeOpacity={0.7}
          >
            <IconSearch size={14} color={colors.textTertiary} />
            <Text style={{ fontSize: 13, color: colors.textTertiary }} numberOfLines={1}>{_tr(t, 'stickerPicker.searchPh', 'Buscar por emoji ou palavra')}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={_tr(t, 'stickerPicker.settings', 'Organizar pacotes')} onPress={() => { try { onClose && onClose(); } catch {} setTimeout(() => router.push('/stickers/my'), 60); }} style={{ padding: 4 }} hitSlop={6}>
          <IconSettings size={19} color={colors.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={a11yLabel('common.close', 'Fechar')} onPress={onClose} style={{ padding: 4 }} hitSlop={6}>
          <IconX size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* busca vazia: atalhos de emoji (conteúdo/tag, não ícone) */}
      {showSearch && !q ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ flexGrow: 0, maxHeight: 44 }} contentContainerStyle={{ paddingHorizontal: 8, alignItems: 'center', gap: 2 }}>
          {QUICK_EMOJIS.map((em) => (
            <TouchableOpacity key={em} onPress={() => setSearchQuery(em)} style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 10 }} accessibilityRole="button" accessibilityLabel={em}>
              <Text style={{ fontSize: 24 }} allowFontScaling={false}>{em}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      ) : null}

      {/* Grade em seções */}
      <View style={{ flex: 1 }} onLayout={(e) => { const w = Math.round(e.nativeEvent.layout.width); if (w && w !== gridW) setGridW(w); }}>
        {searching && rows.length === 0 ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 }}>
            <View style={{ marginBottom: 10 }}><IconSearch size={28} color={colors.textTertiary || colors.textSecondary} /></View>
            <Text style={{ fontSize: 13, color: colors.textTertiary, textAlign: 'center' }}>{_tr(t, 'chat.noStickersFound', 'Nenhuma figurinha encontrada')}</Text>
            <Text style={{ fontSize: 12, color: colors.textTertiary, textAlign: 'center', marginTop: 4 }}>{_tr(t, 'stickerPicker.searchTip', 'Dica: segure uma figurinha sua e escolha "Emojis de busca".')}</Text>
          </View>
        ) : gridW > 0 ? (
          <FlatList
            ref={listRef}
            data={rows}
            keyExtractor={(r) => r.key}
            renderItem={renderRow}
            getItemLayout={getItemLayout}
            initialNumToRender={10}
            maxToRenderPerBatch={8}
            windowSize={7}
            removeClippedSubviews={Platform.OS === 'android'}
            onViewableItemsChanged={onViewable}
            viewabilityConfig={viewCfg}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            style={{ flex: 1 }}
          />
        ) : null}
      </View>

      {/* Abas — embaixo (WhatsApp): uma por seção, ícone SVG ou capa do pacote */}
      {!searching ? (
        <ScrollView
          ref={tabsRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          // [2026-10-10] Altura FIXA: com maxHeight a barra encolhia.
          style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, height: 46, flexGrow: 0, flexShrink: 0 }}
          contentContainerStyle={{ paddingHorizontal: 2, alignItems: 'center' }}
        >
          {sections.map((sec, i) => (
            <React.Fragment key={sec.key}>
              {(sec.packId != null || sec.chatyy || sec.key === 'emoji') && i > 0 && !(sections[i - 1].packId != null || sections[i - 1].chatyy || sections[i - 1].key === 'emoji')
                ? <View style={{ width: 1, height: 20, backgroundColor: colors.border, marginHorizontal: 3 }} /> : null}
              <PackTab sec={sec} active={activeKey === sec.key} onPress={() => jumpTo(sec.key)} colors={colors} />
            </React.Fragment>
          ))}
          {/* [2026-10-13 sticker-one-create] Loja de pacotes */}
          <TouchableOpacity
            onPress={() => router.push('/stickers/store')}
            style={{ flexDirection: 'row', gap: 5, paddingHorizontal: 10, height: 32, marginLeft: 4, marginRight: 6, backgroundColor: colors.text + '10', borderRadius: 16, alignItems: 'center', justifyContent: 'center' }}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel={_tr(t, 'stickerPicker.storeA11y', 'Adicionar pacotes de figurinhas da loja')}
            hitSlop={{ top: 6, bottom: 6 }}
          >
            <IconGrid size={15} color={colors.text} />
            <Text style={{ fontSize: 12, fontWeight: '600', color: colors.text }} numberOfLines={1}>{_tr(t, 'stickerPicker.store', 'Loja')}</Text>
          </TouchableOpacity>
        </ScrollView>
      ) : null}
    </View>
  );
}

function PackTab({ sec, active, onPress, colors }) {
  const Icon = sec.icon;
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{
        width: TAB_W, height: 40, alignItems: 'center', justifyContent: 'center',
        borderRadius: 10, backgroundColor: active ? (colors.text + '14') : 'transparent',
      }}
      activeOpacity={0.6}
      accessibilityRole="tab"
      accessibilityState={{ selected: !!active }}
      accessibilityLabel={sec.title}
    >
      {/* [2026-10-10] Abas fixas = ícone SVG, nunca emoji; pacotes = capa. */}
      {Icon
        ? <Icon size={21} color={active ? colors.text : colors.textSecondary} />
        : sec.cover
          ? <CachedImage source={{ uri: stkCache.stickerDisplayUri(sec.cover) || sec.cover }} style={{ width: 26, height: 26, borderRadius: 4, opacity: active ? 1 : 0.8 }} resizeMode="contain" placeholder={STICKER_CLEAR_PLACEHOLDER} showSpinner={false} />
          : sec.animated ? <IconFilm size={20} color={colors.textSecondary} /> : <IconPackage size={20} color={colors.textSecondary} />}
    </TouchableOpacity>
  );
}
