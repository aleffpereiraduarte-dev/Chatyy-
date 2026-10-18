/**
 * GlobalSearch — Spotlight-style unified search overlay.
 * Finds chats, messages, people, emails, files and posts in one surface.
 *
 * [2026-10-15 native-search-notifs] Busca enquanto digita SEM travar:
 *   1. LOCAL primeiro (~0 ms): conversas da lista já carregada
 *      (chatStore.getConversationsSync), contatos do aparelho (contactSync) e
 *      mensagens do SQLite (FTS5, dbSearchMessages) — aparece na hora e
 *      funciona offline;
 *   2. SERVIDOR por cima (debounce 250 ms): search_global + chat_search,
 *      mesclado por id (servidor ganha no conteúdo). Cada tecla invalida a
 *      rodada anterior (reqId) e cancela os timers pendentes — resposta velha
 *      nunca pinta por cima da nova.
 * Resultados em seções numa lista NATIVA (ChatyyResultList: UICollectionView /
 * RecyclerView, destaque do termo em NSAttributedString/spans, patches por id)
 * quando o binário tem a view; senão (web / binário antigo / kill switch
 * globalThis.__chatyy_native_search = false / erro) a lista JS abaixo, com o
 * MESMO modelo de seções. Mensagem abre a conversa já NA mensagem
 * (scrollToMessageId/highlightMessageId).
 */

import { androidTopInset } from '../utils/systemInsets'; // [2026-10-07 android-native] edge-to-edge
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Modal, Pressable,
  ScrollView, ActivityIndicator, Platform, StyleSheet, Keyboard,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as api from '../services/api';
import { peekCached, putCached } from '../hooks/useCachedAction'; // [2026-10-14 offline-first]
import CachedImage from './CachedImage';
import AvatarCircle from './AvatarCircle';
import EmptyStateCard from './EmptyStateCard';
import ChatyyMascot from './mascot/ChatyyMascot'; // [2026-10-16 mascote]
import { useLanguageOptional } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import NativeResultList, { useNativeResults } from './native/NativeResultList';
import {
  contactTile, photoTile, queryTokens, matchesAll, snippetAround, highlightParts,
} from './native/resultListAdapter';
import {
  IconSearch, IconX, IconMail, IconMessageSquare, IconImage,
  IconUser, IconChevronRight, IconClock, IconFilm, IconFile,
} from './Icons';

const BRAND = '#111111';
const RECENT_KEY = '@chatyy_global_recent_searches'; // legado (sem conta) — só migração
const RECENT_CKEY = ['global_search', 'recent'];
const MAX_RECENT = 8;
// Itens por seção no filtro "Tudo". Acima disso o cabeçalho mostra "Ver tudo"
// (troca o chip para a seção).
const SECTION_PREVIEW = 3;
const MSG_PREVIEW = 5;
const SERVER_DEBOUNCE_MS = 250;
const LOCAL_DEBOUNCE_MS = 60;
const KILL = '__chatyy_native_search';

const WEB = Platform.OS === 'web';
const EMPTY_SERVER = { term: '', users: [], chats: [], emails: [], posts: [] };
const EMPTY_HITS = { term: '', list: [] };

// Compact time formatter (Spotlight-grade): "agora", "5m", "2h", "ter", "12 mai".
function parseTs(ts) {
  if (!ts) return null;
  if (typeof ts === 'number') return new Date(ts * (ts < 1e12 ? 1000 : 1));
  let v = String(ts);
  if (/^\d{4}-\d{2}-\d{2} \d/.test(v)) v = v.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(v)) v += 'Z';
  if (/[+-]\d{2}$/.test(v)) v += ':00';
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
function formatTime(ts, t, language) {
  const d = parseTs(ts);
  if (!d) return '';
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diffMin < 1) { const v = typeof t === 'function' ? t('time.justNow') : ''; return (v && v !== 'time.justNow') ? v : 'agora'; }
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  const diffD = Math.floor(diffH / 24);
  const loc = language || 'pt-BR';
  if (diffD < 7) {
    try { return d.toLocaleDateString(loc, { weekday: 'short' }).replace(/\.$/, ''); } catch {}
    return ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][d.getDay()];
  }
  try { return d.toLocaleDateString(loc, { day: '2-digit', month: 'short' }); } catch {}
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

function resolveMedia(url) {
  if (!url) return '';
  if (String(url).startsWith('http') || String(url).startsWith('data:')) return url;
  try { return api.getMediaUrl(url); } catch { return ''; }
}

const POST_KIND = (p) => {
  const ty = String(p?.type || '').toLowerCase();
  if (ty === 'video' || ty === 'reel') return 'reel';
  if (ty === 'file' || ty === 'document' || ty === 'doc' || ty === 'pdf') return 'file';
  return 'post';
};

// Chips: ids estáveis; rótulos de chaves que já existem nos 63 idiomas.
const FILTERS = [
  { id: 'all', labelKey: 'activity.tabs.all', label: 'Tudo' },
  { id: 'convs', labelKey: 'search.chats', label: 'Conversas' },
  { id: 'msg', labelKey: 'gsearch.tab', label: 'Mensagens' },
  { id: 'people', labelKey: 'search.users', label: 'Pessoas' },
  { id: 'emails', labelKey: 'search.emails', label: 'E-mails' },
  { id: 'media', labelKey: 'apps.media', label: 'Mídia' },
  { id: 'docs', labelKey: 'files.title', label: 'Arquivos' },
];
const SECTION_FOR_FILTER = { convs: 'convs', msg: 'msgs', people: 'people', emails: 'emails', media: 'reels', docs: 'files' };
const FILTER_FOR_SECTION = { convs: 'convs', msgs: 'msg', people: 'people', emails: 'emails', reels: 'media', files: 'docs', posts: 'media' };

// ── JS (fallback) ───────────────────────────────────────────────────────────

function HighlightText({ text, highlight, style, highlightColor, lines = 1 }) {
  const parts = highlight ? highlightParts(text, highlight) : [{ text: String(text || ''), hit: false }];
  return (
    <Text style={style} numberOfLines={lines}>
      {parts.map((p, i) => (p.hit
        ? <Text key={i} style={{ fontWeight: '700', color: highlightColor }}>{p.text}</Text>
        : p.text))}
    </Text>
  );
}

function Section({ title, children, colors, icon: Icon, action, onAction }) {
  return (
    <View style={{ marginTop: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
          {Icon && <Icon size={14} color={colors?.textSecondary} />}
          <Text style={{ fontSize: 11, fontWeight: '700', color: colors?.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {title}
          </Text>
        </View>
        {!!action && (
          <TouchableOpacity onPress={onAction} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }} accessibilityRole="button">
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: colors?.text || BRAND }}>{action}</Text>
              <IconChevronRight size={12} color={colors?.text || BRAND} />
            </View>
          </TouchableOpacity>
        )}
      </View>
      {children}
    </View>
  );
}

function Row({ leading, title, subtitle, time, onPress, colors, query, subLines = 1 }) {
  const titleStyle = { fontSize: 14.5, fontWeight: '500', color: colors?.text };
  const subtitleStyle = { fontSize: 12.5, color: colors?.textSecondary, marginTop: 2 };
  const highlightColor = colors?.text || BRAND;
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 }}
      accessibilityRole="button"
    >
      {leading}
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <HighlightText text={title} highlight={query} style={titleStyle} highlightColor={highlightColor} />
          </View>
          {!!time && (
            <Text style={{ fontSize: 11, color: colors?.textTertiary, fontVariant: ['tabular-nums'] }}>{time}</Text>
          )}
        </View>
        {!!subtitle && (
          <HighlightText text={subtitle} highlight={query} style={subtitleStyle} highlightColor={highlightColor} lines={subLines} />
        )}
      </View>
      <IconChevronRight size={16} color={colors?.textTertiary} />
    </TouchableOpacity>
  );
}

function FilterChip({ label, active, onPress, colors }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      accessibilityRole="tab"
      accessibilityState={{ selected: !!active }}
      style={{
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: 999,
        marginRight: 8,
        backgroundColor: active ? (colors?.primary || BRAND) : 'transparent',
        borderWidth: active ? 0 : StyleSheet.hairlineWidth,
        borderColor: colors?.border || 'rgba(0,0,0,0.15)',
      }}
    >
      <Text
        style={{ fontSize: 13, fontWeight: active ? '700' : '500', color: active ? (colors?.onPrimary || '#fff') : (colors?.text || '#000') }}
        numberOfLines={1}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const GLYPH_ICON = { message: IconMessageSquare, mail: IconMail, user: IconUser, film: IconFilm, file: IconFile, image: IconImage, clock: IconClock, search: IconSearch };

function Leading({ item, colors }) {
  if (item.tiles) {
    return <AvatarCircle email={item.email || undefined} name={item.title} uri={item.avatarUri || undefined} size={40} />;
  }
  if (item.thumb) {
    return WEB
      ? <img src={item.thumb} style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover' }} alt="" />
      : <CachedImage source={{ uri: item.thumb }} style={{ width: 40, height: 40, borderRadius: 8 }} resizeMode="cover" />;
  }
  const I = GLYPH_ICON[item.glyph] || IconSearch;
  return (
    <View style={{ width: 40, height: 40, borderRadius: item.glyphRound ? 10 : 20, backgroundColor: colors?.surfaceVariant || colors?.surface, alignItems: 'center', justifyContent: 'center' }}>
      <I size={18} color={colors?.text} />
    </View>
  );
}

// ── Componente ──────────────────────────────────────────────────────────────

export default function GlobalSearch({
  visible, onClose, colors, isDark, t, router,
}) {
  const insets = useSafeAreaInsets(); // [2026-10-18 safe-area] topo real (era 60 fixo no iOS)
  const _lang = useLanguageOptional();
  let me = '';
  try { me = String(useAuth()?.user?.email || '').toLowerCase(); } catch { me = ''; }
  const tt = useCallback((k, fb) => {
    const v = typeof t === 'function' ? t(k) : '';
    return (typeof v === 'string' && v && v !== k) ? v : fb;
  }, [t]);

  const [q, setQ] = useState('');
  const [server, setServer] = useState(EMPTY_SERVER);
  const [local, setLocal] = useState({ convs: [], people: [] });
  const [msgHits, setMsgHitsState] = useState(EMPTY_HITS);
  const msgRef = useRef(EMPTY_HITS);
  const setMsgHits = useCallback((v) => { msgRef.current = v; setMsgHitsState(v); }, []);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('all');
  // [2026-10-14 offline-first] recentes POR CONTA (antes: chave global no
  // AsyncStorage, lida async → piscava e vazava entre contas no multi-conta).
  const [recent, setRecent] = useState(() => { const c = peekCached(RECENT_CKEY); return Array.isArray(c) ? c : []; });
  const inputRef = useRef(null);
  const reqRef = useRef(0);
  const timersRef = useRef([]);
  // Cache do payload do servidor por termo (trocar chip / apagar letra = 0 rede).
  const cacheRef = useRef(new Map());
  const [nativeOn, onNativeFailure] = useNativeResults(KILL);
  const [scrollTopSeq, setScrollTopSeq] = useState(0);

  const term = q.trim();
  const active = term.length >= 2;

  // Hydrate recent searches when the modal opens (Spotlight empty-state).
  useEffect(() => {
    if (!visible) return;
    const c = peekCached(RECENT_CKEY);
    if (Array.isArray(c)) { setRecent(c); return; }
    // Migração única da chave antiga (sem conta): só adota com ≤1 conta no aparelho.
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(RECENT_KEY);
        if (!raw) return;
        let n = 0; try { n = (api.getStoredAccounts?.() || []).length; } catch {}
        if (n <= 1) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) { const v = arr.filter(x => typeof x === 'string').slice(0, MAX_RECENT); putCached(RECENT_CKEY, v); setRecent(v); }
        }
        AsyncStorage.removeItem(RECENT_KEY).catch(() => {});
      } catch {}
    })();
  }, [visible]);

  const pushRecent = useCallback((v0) => {
    const v = String(v0 || '').trim();
    if (v.length < 2) return;
    setRecent((prev) => {
      const next = [v, ...prev.filter(s => s !== v)].slice(0, MAX_RECENT);
      putCached(RECENT_CKEY, next);
      return next;
    });
  }, []);

  const removeRecent = useCallback((v) => {
    setRecent((prev) => {
      const next = prev.filter(s => s !== v);
      putCached(RECENT_CKEY, next);
      return next;
    });
  }, []);

  const clearRecent = useCallback(async () => {
    setRecent([]);
    putCached(RECENT_CKEY, []);
    try { await AsyncStorage.removeItem(RECENT_KEY); } catch {}
  }, []);

  // Autofocus when the overlay opens
  useEffect(() => {
    if (visible) {
      const h = setTimeout(() => { inputRef.current?.focus?.(); }, 140);
      return () => clearTimeout(h);
    }
    reqRef.current++;
    setQ('');
    setServer(EMPTY_SERVER);
    setLocal({ convs: [], people: [] });
    setMsgHits(EMPTY_HITS);
    setFilter('all');
    setLoading(false);
    cacheRef.current.clear();
    return undefined;
  }, [visible]);

  // Índice local de conversas (lista já carregada; síncrono, nunca outra conta).
  const convIndex = useMemo(() => {
    const m = new Map();
    if (!visible) return m;
    try {
      const list = require('../services/chatStore').getConversationsSync() || [];
      for (const c of list) if (c && c.id != null) m.set(String(c.id), c);
    } catch {}
    return m;
  }, [visible]);

  const convInfo = useCallback((c0, hint) => {
    const c = c0 || {};
    const h = hint || {};
    const type = c.type || h.conv_type || h.type || (c.is_group ? 'group' : 'direct');
    const peer = (type === 'direct' || type === 'saved')
      ? String(c.other_email || c.contact_email || c.peer_email || h.peer_email || '')
      : '';
    const saved = type === 'saved' || (!!peer && !!me && peer.toLowerCase() === me);
    let name = saved ? tt('chat.savedMessages', 'Mensagens salvas') : (c.display_name || c.name || c.title || h.conv_name || h.name || '');
    if (!name && peer) { try { name = api.emailToDisplayName(peer) || peer.split('@')[0]; } catch { name = peer.split('@')[0]; } }
    if (!name) name = tt('chat.untitled', 'Conversa');
    const avatar = c.avatar_url || c.group_avatar || c.avatar || h.avatar || '';
    return { type, peer: saved ? '' : peer, saved, name, avatar };
  }, [me, tt]);

  // ── Pipeline: local já; servidor com debounce; tecla nova cancela tudo ────
  useEffect(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    const myReq = ++reqRef.current;
    if (!visible || !active) {
      setServer(EMPTY_SERVER); setLocal({ convs: [], people: [] }); setMsgHits(EMPTY_HITS); setLoading(false);
      return undefined;
    }
    const toks = queryTokens(term);
    const stale = () => myReq !== reqRef.current;
    let online = true;
    try { online = require('../services/offlineCache').isOnline() !== false; } catch {}

    // 1) LOCAL — conversas + contatos + mensagens do aparelho
    timersRef.current.push(setTimeout(() => {
      if (stale()) return;
      const convs = [];
      for (const c of convIndex.values()) {
        const info = convInfo(c);
        if (matchesAll(toks, info.name, info.peer)) convs.push(c);
        if (convs.length >= 40) break;
      }
      setLocal((prev) => ({ ...prev, convs }));
      if (!WEB) {
        (async () => {
          const people = [];
          try {
            const cached = await require('../services/contactSync').getCachedContacts();
            if (stale()) return;
            for (const c of (cached?.chatyContacts || [])) {
              const em = String(c?.email || '').toLowerCase();
              if (!em || em === me) continue;
              if (matchesAll(toks, c.name, em)) people.push({ email: em, name: c.name || '' });
              if (people.length >= 20) break;
            }
          } catch {}
          if (!stale()) setLocal((prev) => ({ ...prev, people }));
        })();
        (async () => {
          try {
            const { dbSearchMessages } = require('../services/db');
            const rows = await dbSearchMessages(term, 30, null, { prefix: true });
            if (stale() || !Array.isArray(rows)) return;
            const out = [];
            const seen = new Set();
            for (const m0 of rows) {
              const m = m0 && m0._row ? { ...m0, id: m0.id ?? m0._row.id, conversation_id: m0.conversation_id ?? m0._row.conversation_id } : m0;
              if (!m || m.id == null || m.conversation_id == null) continue;
              const k = `${m.conversation_id}:${m.id}`;
              if (seen.has(k)) continue;
              seen.add(k);
              out.push({ id: m.id, conversation_id: m.conversation_id, content: m.content, sender_email: m.sender_email, sender_name: m.sender_name, created_at: m.created_at, type: m.type, file_name: m.file_name, _local: true });
            }
            // Servidor já respondeu este termo? Só soma o que faltou; senão pinta o local.
            const cur = msgRef.current;
            if (cur.term === term && !cur.local) {
              const seen2 = new Set(cur.list.map(h => `${h.conversation_id}:${h.id}`));
              const add = out.filter(h => !seen2.has(`${h.conversation_id}:${h.id}`));
              if (add.length) setMsgHits({ term, list: cur.list.concat(add) });
            } else if (out.length) {
              setMsgHits({ term, list: out, local: true });
            }
          } catch {}
        })();
      }
    }, LOCAL_DEBOUNCE_MS));

    // 2) SERVIDOR — cache por termo; senão debounce e mescla
    const cached = cacheRef.current.get(term);
    if (cached) {
      setServer(cached.server);
      if (cached.msgs) setMsgHits({ term, list: cached.msgs });
      setLoading(false);
      return () => { timersRef.current.forEach(clearTimeout); timersRef.current = []; };
    }
    if (!online) { setLoading(false); return () => { timersRef.current.forEach(clearTimeout); timersRef.current = []; }; }
    setLoading(true);
    timersRef.current.push(setTimeout(async () => {
      if (stale()) return;
      const [g, m] = await Promise.all([
        api.searchGlobal(term).catch(() => null),
        api.apiCall('chat_search', { query: term, limit: 30 }).catch(() => null),
      ]);
      if (stale()) return;
      const data = g?.success ? {
        term,
        users: g.data?.users || [],
        chats: g.data?.chats || [],
        emails: g.data?.emails || [],
        posts: g.data?.posts || [],
      } : null;
      const raw = m?.success ? (Array.isArray(m.data) ? m.data : (m.data?.results ?? m.data?.hits ?? [])) : null;
      if (data) setServer(data);
      let merged = null;
      if (Array.isArray(raw)) {
        const prev = msgRef.current.term === term ? msgRef.current.list : [];
        const seen = new Set();
        const out = [];
        for (const h of raw) { const k = `${h.conversation_id}:${h.id}`; if (seen.has(k)) continue; seen.add(k); out.push(h); }
        for (const h of prev) { if (!h._local) continue; const k = `${h.conversation_id}:${h.id}`; if (seen.has(k)) continue; seen.add(k); out.push(h); }
        out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
        merged = out.slice(0, 60);
        setMsgHits({ term, list: merged });
      }
      if (data) {
        cacheRef.current.set(term, { server: data, msgs: merged });
        if (cacheRef.current.size > 20) cacheRef.current.delete(cacheRef.current.keys().next().value);
      }
      setLoading(false);
    }, SERVER_DEBOUNCE_MS));
    return () => { timersRef.current.forEach(clearTimeout); timersRef.current = []; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, visible, active, convIndex]);

  // Volta ao topo quando o termo/filtro muda (lista nativa).
  useEffect(() => { setScrollTopSeq((s) => s + 1); }, [term, filter]);

  const close = useCallback(() => {
    Keyboard.dismiss?.();
    onClose?.();
  }, [onClose]);

  const go = useCallback((target) => {
    if (term.length >= 2) pushRecent(term);
    close();
    setTimeout(() => {
      // [2026-10-12 nav-dedup] conversation targets go through the shared guard.
      if (target && typeof target === 'object') {
        try { require('../services/openConversation').openConversation(target, { router, source: 'search' }); } catch {}
        return;
      }
      if (typeof target === 'string' && target.startsWith('/chat-conversation')) {
        try { require('../services/openConversation').openConversation(target, { source: 'search' }); return; } catch {}
      }
      router?.push(target);
    }, 60);
  }, [term, pushRecent, close, router]);

  // ── Modelo de seções (o MESMO para nativo e JS) ──────────────────────────
  const sections = useMemo(() => {
    if (!active) return [];
    const lang = _lang?.language;
    const out = [];
    // Enquanto a resposta do termo NOVO não chega, os resultados do termo
    // anterior são estreitados aqui (sem rede, sem piscar).
    const toks = queryTokens(term);
    const srv = server.term === term ? server : {
      users: (server.users || []).filter(u => matchesAll(toks, u.name, u.email)),
      chats: (server.chats || []).filter(h => { const c = convIndex.get(String(h.id)); const i = convInfo(c, h); return matchesAll(toks, i.name, i.peer); }),
      emails: (server.emails || []).filter(e => matchesAll(toks, e.subject, e.from)),
      posts: (server.posts || []).filter(p => matchesAll(toks, p.caption, p.filename, p.author_email)),
    };
    const hitsList = msgHits.term === term ? msgHits.list : msgHits.list.filter(m => matchesAll(toks, m.content, m.file_name));
    const want = (sec) => filter === 'all' || SECTION_FOR_FILTER[filter] === sec;
    const cap = (sec, n) => (filter === 'all' ? n : 200);

    // Conversas: locais primeiro (nome certo + avatar), servidor completa.
    if (want('convs')) {
      const seen = new Set();
      const items = [];
      const addConv = (c, h) => {
        const id = String(c?.id ?? h?.id ?? '');
        if (!id || seen.has(id)) return;
        seen.add(id);
        const info = convInfo(c, h);
        const lm = c?.last_message;
        const lmText = lm ? String(lm.content || lm.text || lm.file_name || '').replace(/\s+/g, ' ').trim() : '';
        const sub = lmText || (info.type === 'group' ? tt('chat.group', 'Grupo') : (info.saved ? '' : tt('chat.direct', 'Conversa direta')));
        const isGroup = info.type === 'group' || info.type === 'channel';
        items.push({
          key: `c:${id}`,
          title: info.name,
          sub,
          time: formatTime(c?.last_message_at || c?.updated_at || lm?.created_at, t, lang),
          tiles: isGroup ? photoTile(resolveMedia(info.avatar), info.name, id) : contactTile(info.peer, info.name),
          email: isGroup ? '' : info.peer,
          avatarUri: isGroup ? resolveMedia(info.avatar) : '',
          open: () => go({ pathname: '/chat-conversation', params: { id, type: info.type, name: info.name, ...(info.type === 'direct' && info.peer ? { email: info.peer } : {}) } }),
        });
      };
      for (const c of local.convs) addConv(c, null);
      // Conversa direta sem nome/peer no search_global: o peer sai dos hits de mensagem.
      const peerOf = new Map();
      for (const m of hitsList) {
        const se = String(m.sender_email || '').toLowerCase();
        if (se && se !== me && !peerOf.has(String(m.conversation_id))) peerOf.set(String(m.conversation_id), se);
      }
      for (const h of srv.chats || []) {
        const pe = peerOf.get(String(h.id));
        addConv(convIndex.get(String(h.id)), (pe && !h.peer_email && (h.type || 'direct') === 'direct') ? { ...h, peer_email: pe } : h);
      }
      if (items.length) out.push({ key: 'convs', title: tt('search.chats', 'Conversas'), icon: IconMessageSquare, items, cap: cap('convs', SECTION_PREVIEW) });
    }

    // Mensagens: trecho em volta do termo + abre NA mensagem.
    if (want('msgs') && hitsList.length) {
      const items = hitsList.map((m) => {
        const c = convIndex.get(String(m.conversation_id));
        const se = String(m.sender_email || '').toLowerCase();
        const info = convInfo(c, (!c && !m.peer_email && se && se !== me && (m.conv_type || 'direct') === 'direct') ? { ...m, peer_email: se } : m);
        const own = String(m.sender_email || '').toLowerCase() === me;
        const who = own ? tt('gsearch.you', 'Você') : ((info.type === 'group' || info.type === 'channel') ? (m.sender_name || String(m.sender_email || '').split('@')[0]) : '');
        const body = snippetAround(m.content || m.file_name || '', term);
        const isGroup = info.type === 'group' || info.type === 'channel';
        return {
          key: `m:${m.conversation_id}:${m.id}`,
          title: info.name,
          sub: who ? `${who}: ${body}` : body,
          subLines: 2,
          time: formatTime(m.created_at, t, lang),
          tiles: isGroup ? photoTile(resolveMedia(info.avatar), info.name, String(m.conversation_id)) : contactTile(info.peer, info.name),
          email: isGroup ? '' : info.peer,
          avatarUri: isGroup ? resolveMedia(info.avatar) : '',
          open: () => go({
            pathname: '/chat-conversation',
            params: {
              id: String(m.conversation_id), name: info.name, type: info.type,
              ...(info.type === 'direct' && info.peer ? { email: info.peer } : {}),
              scrollToMessageId: String(m.id), highlightMessageId: String(m.id),
            },
          }),
        };
      });
      out.push({ key: 'msgs', title: tt('gsearch.tab', 'Mensagens'), icon: IconMessageSquare, items, cap: cap('msgs', MSG_PREVIEW) });
    }

    // Pessoas: servidor + contatos do aparelho (sem duplicar).
    if (want('people')) {
      const seen = new Set();
      const items = [];
      const add = (u) => {
        const em = String(u?.email || '').toLowerCase();
        if (!em || seen.has(em) || em === me) return;
        seen.add(em);
        const name = u.name || (api.emailToDisplayName ? api.emailToDisplayName(em) : '') || em;
        items.push({ key: `u:${em}`, title: name, sub: em, tiles: contactTile(em, name), email: em, open: () => go(`/u/${encodeURIComponent(em)}`) });
      };
      for (const u of local.people) add(u);
      for (const u of srv.users || []) add(u);
      if (items.length) out.push({ key: 'people', title: tt('search.users', 'Pessoas'), icon: IconUser, items, cap: cap('people', SECTION_PREVIEW) });
    }

    if (want('emails') && (srv.emails || []).length) {
      const items = srv.emails.map((e, i) => ({
        key: `e:${e.folder}:${e.uid}:${i}`,
        title: e.subject || tt('reader.noSubject', '(sem assunto)'),
        sub: e.from || '',
        time: formatTime(e.date || e.received_at, t, lang),
        glyph: 'mail', glyphRound: true,
        open: () => go(`/read?uid=${e.uid}&folder=${encodeURIComponent(e.folder)}`),
      }));
      out.push({ key: 'emails', title: tt('search.emails', 'E-mails'), icon: IconMail, items, cap: cap('emails', SECTION_PREVIEW) });
    }

    const posts = srv.posts || [];
    const postItem = (p, kind) => {
      const thumb = resolveMedia(p.thumbnail || p.thumbnail_url);
      return {
        key: `p:${p.id}`,
        title: p.caption || p.filename || (kind === 'file' ? tt('search.files', 'Arquivos') : tt('feed.untitled', 'Post')),
        sub: p.author_email || '',
        time: formatTime(p.created_at, t, lang),
        thumb: kind === 'file' ? '' : thumb,
        play: kind === 'reel',
        glyph: kind === 'file' ? 'file' : (kind === 'reel' ? 'film' : 'image'),
        glyphRound: true,
        open: () => go(kind === 'file' ? `/files/${p.id}` : `/feed/${p.id}`),
      };
    };
    const reels = posts.filter(p => POST_KIND(p) === 'reel');
    const files = posts.filter(p => POST_KIND(p) === 'file');
    const others = posts.filter(p => POST_KIND(p) === 'post');
    if (want('reels') && reels.length) out.push({ key: 'reels', title: tt('search.reels', 'Reels'), icon: IconFilm, items: reels.map(p => postItem(p, 'reel')), cap: cap('reels', SECTION_PREVIEW) });
    if (want('files') && files.length) out.push({ key: 'files', title: tt('search.files', 'Arquivos'), icon: IconFile, items: files.map(p => postItem(p, 'file')), cap: cap('files', SECTION_PREVIEW) });
    if ((filter === 'all' || filter === 'media') && others.length) out.push({ key: 'posts', title: tt('feed.profilePosts', 'Publicações'), icon: IconImage, items: others.map(p => postItem(p, 'post')), cap: cap('posts', SECTION_PREVIEW) });
    return out;
  }, [active, filter, local, server, msgHits, convIndex, convInfo, me, term, t, tt, go, _lang?.language]);

  const hasAny = sections.some(s => s.items.length > 0);
  const seeAll = tt('common.seeAll', 'Ver tudo');

  // ── Linhas nativas ────────────────────────────────────────────────────────
  const openById = useRef(new Map());
  const nativeRows = useMemo(() => {
    if (!nativeOn) return [];
    const rows = [];
    const map = new Map();
    if (!active) {
      if (recent.length) {
        rows.push({ id: 's:recent', k: 's', t: tt('search.recent', 'Recentes'), ac: tt('search.clearHistory', 'Limpar') });
        for (const r of recent) {
          const id = `r:${r}`;
          rows.push({ id, k: 'r', t: r, gl: 'clock', sw: tt('common.delete', 'Apagar'), cv: 1 });
          map.set(id, { recent: r });
        }
      } else {
        rows.push({ id: 'n:hint', k: 'n', t: tt('search.hint', 'Digite pra buscar em conversas, e-mails, pessoas, reels e arquivos.'), gl: 'search', tap: 0 });
      }
      openById.current = map;
      return rows;
    }
    for (const s of sections) {
      const over = s.items.length > s.cap;
      rows.push({ id: `s:${s.key}`, k: 's', t: s.title, ...(over ? { ac: seeAll } : {}) });
      map.set(`s:${s.key}`, { section: s.key });
      for (const it of s.items.slice(0, s.cap)) {
        const row = { id: it.key, k: 'r', t: it.title, hl: 1 };
        if (it.sub) row.sb = it.sub;
        if (it.subLines > 1) row.sl = it.subLines;
        if (it.time) row.tm = it.time;
        if (it.tiles) row.tiles = it.tiles;
        else if (it.thumb) { row.th = it.thumb; if (it.play) row.pv = 1; }
        else { row.gl = it.glyph || 'search'; if (it.glyphRound) row.gs = 'r'; }
        rows.push(row);
        map.set(it.key, { open: it.open });
      }
    }
    if (loading) rows.push({ id: 'l:server', k: 'l', t: hasAny ? tt('search.searching', 'Buscando') + '…' : '' });
    else if (!hasAny) rows.push({ id: 'n:empty', k: 'n', t: tt('search.emptyTitle', 'Nenhum resultado para "{query}"').replace('{query}', term), gl: 'search', tap: 0 });
    openById.current = map;
    return rows;
  }, [nativeOn, active, recent, sections, loading, hasAny, term, seeAll, tt]);

  const onNativePress = useCallback((id) => {
    const m = openById.current.get(id);
    if (!m) return;
    if (m.recent) { setQ(m.recent); inputRef.current?.focus?.(); return; }
    m.open?.();
  }, []);

  const onNativeAction = useCallback((id, action) => {
    const m = openById.current.get(id);
    if (action === 'section') {
      if (id === 's:recent') { clearRecent(); return; }
      if (m?.section && FILTER_FOR_SECTION[m.section]) setFilter(FILTER_FOR_SECTION[m.section]);
      return;
    }
    if (action === 'delete' && m?.recent) removeRecent(m.recent);
  }, [clearRecent, removeRecent]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={close}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} onPress={close}>
        <Pressable
          style={{
            marginTop: Platform.OS === 'ios' ? insets.top + 12 : androidTopInset(30),
            marginHorizontal: 12,
            borderRadius: 16,
            backgroundColor: colors?.background || '#fff',
            // Nativa precisa de altura definida (flex:1 dentro de maxHeight colapsa).
            ...(nativeOn ? { height: '85%' } : { maxHeight: '85%' }),
            overflow: 'hidden',
            ...(Platform.OS === 'web'
              ? { boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }
              : { shadowColor: '#000', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.3, shadowRadius: 24, elevation: 10 }),
          }}
          onPress={e => e.stopPropagation?.()}
        >
          {/* Search bar — Spotlight-grade. */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingHorizontal: 16,
              paddingVertical: 14,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: colors?.border,
            }}
          >
            <View
              style={{
                width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
                backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(17, 17, 17,0.08)',
              }}
            >
              <IconSearch size={18} color={colors?.text || BRAND} />
            </View>
            <TextInput
              ref={inputRef}
              value={q}
              onChangeText={setQ}
              placeholder={t?.('search.globalPlaceholder') /* [2026-10-10 qa-sweep] search.placeholder duplicada no i18n */}
              placeholderTextColor={colors?.textTertiary}
              style={{
                flex: 1,
                fontSize: 18,
                fontWeight: '500',
                color: colors?.text,
                paddingVertical: 4,
                ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null),
              }}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={() => { if (term.length >= 2) pushRecent(term); }}
            />
            {loading && !nativeOn && <ActivityIndicator size="small" color={colors?.text || BRAND} />}
            {q.length > 0 && (!loading || nativeOn) && (
              <TouchableOpacity
                onPress={() => setQ('')}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityLabel={tt('common.clear', 'Limpar')}
                style={{
                  width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
                  backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)',
                }}
              >
                <IconX size={12} color={colors?.textSecondary} />
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={close} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel={tt('common.close', 'Fechar')}>
              <IconX size={22} color={colors?.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Filtros em chips — só com termo útil. */}
          {active && (
            <View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors?.border }}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10 }}
              >
                {FILTERS.map(f => (
                  <FilterChip
                    key={f.id}
                    label={tt(f.labelKey, f.label)}
                    active={filter === f.id}
                    onPress={() => setFilter(f.id)}
                    colors={colors}
                  />
                ))}
              </ScrollView>
            </View>
          )}

          {nativeOn ? (
            <NativeResultList
              rows={nativeRows}
              highlight={active ? term : ''}
              colors={colors}
              isDark={isDark}
              scrollToTopSeq={scrollTopSeq}
              bottomInset={12}
              onPress={onNativePress}
              onAction={onNativeAction}
              onFailure={onNativeFailure}
            />
          ) : (
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              {!active && (
                <View>
                  {recent.length > 0 ? (
                    <View style={{ marginTop: 8 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                          <IconClock size={14} color={colors?.textSecondary} />
                          <Text style={{ fontSize: 11, fontWeight: '700', color: colors?.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                            {tt('search.recent', 'Recentes')}
                          </Text>
                        </View>
                        <TouchableOpacity onPress={clearRecent} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }} accessibilityRole="button">
                          <Text style={{ fontSize: 12, fontWeight: '600', color: colors?.textTertiary }}>
                            {tt('search.clearHistory', 'Limpar')}
                          </Text>
                        </TouchableOpacity>
                      </View>
                      {recent.map((r, i) => (
                        <View key={`${r}-${i}`} style={{ flexDirection: 'row', alignItems: 'center' }}>
                          <TouchableOpacity
                            onPress={() => { setQ(r); inputRef.current?.focus?.(); }}
                            activeOpacity={0.6}
                            style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 16, paddingVertical: 10 }}
                            accessibilityRole="button"
                          >
                            <View style={{
                              width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
                              backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                            }}>
                              <IconClock size={14} color={colors?.textSecondary} />
                            </View>
                            <Text style={{ flex: 1, fontSize: 14.5, color: colors?.text }} numberOfLines={1}>{r}</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={() => removeRecent(r)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            style={{ paddingHorizontal: 16, paddingVertical: 10 }}
                            accessibilityRole="button"
                            accessibilityLabel={tt('common.delete', 'Apagar')}
                          >
                            <IconX size={14} color={colors?.textTertiary} />
                          </TouchableOpacity>
                        </View>
                      ))}
                      <View style={{ height: 16 }} />
                    </View>
                  ) : (
                    <View style={{ padding: 40, alignItems: 'center' }}>
                      <Text style={{ color: colors?.textSecondary, fontSize: 13, textAlign: 'center' }}>
                        {tt('search.hint', 'Digite pra buscar em conversas, e-mails, pessoas, reels e arquivos.')}
                      </Text>
                    </View>
                  )}
                </View>
              )}

              {active && !loading && !hasAny && (
                <EmptyStateCard
                  Icon={IconSearch}
                  illustration={<ChatyyMascot pose="search" size={120} dark={!!isDark} />}
                  tone="neutral"
                  title={tt('search.emptyTitle', 'Nenhum resultado para "{query}"').replace('{query}', term)}
                  subtitle={tt('search.emptySubtitle', 'Tente outras palavras-chave ou verifique a ortografia')}
                />
              )}

              {sections.map((s) => (
                <Section
                  key={s.key}
                  title={s.title}
                  icon={s.icon}
                  colors={colors}
                  action={s.items.length > s.cap ? seeAll : ''}
                  onAction={() => FILTER_FOR_SECTION[s.key] && setFilter(FILTER_FOR_SECTION[s.key])}
                >
                  {s.items.slice(0, s.cap).map((it) => (
                    <Row
                      key={it.key}
                      leading={<Leading item={it} colors={colors} />}
                      title={it.title}
                      subtitle={it.sub}
                      subLines={it.subLines || 1}
                      time={it.time}
                      onPress={it.open}
                      colors={colors}
                      query={term}
                    />
                  ))}
                </Section>
              ))}
              <View style={{ height: 16 }} />
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
