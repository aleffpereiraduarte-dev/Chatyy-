// Share receive screen — opens when the user picks Chatyy from the OS share
// sheet (expo-share-intent → app/_layout.js ShareIntentWatcher → here).
//
// [2026-10-08 share-sheet] Rewritten WhatsApp-style, preto & branco:
//   • the conversation list is painted from the LOCAL per-account cache on the
//     first frame (services/chatStore.getConversationsSync — same source the
//     chat list uses since OTA37) and refreshed from the network on top. The
//     old screen waited for ONE network promise with no timeout and no cache;
//     after a share the app resumes from suspension and that promise could
//     join a zombie in-flight chat_list (dead socket, 25s abort timer frozen
//     while suspended) → eternal spinner. Now: cache first, 10s hard timeout,
//     skeleton → error with "Tentar novamente", never an endless spinner.
//   • compact preview (all shared items, real aspect ratio, never cropped) +
//     optional caption; multi-select with checks; fixed Send bar with names.
//   • quick actions (Status / Feed / Nova conversa) as a compact monochrome row.
//   • sending goes through the durable media queue (mediaSendQueue → SQLite
//     outbox 'upload' lane) / text outbox, exactly like the conversation
//     screen — survives app kill, retries, no new upload code here.
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Image, StyleSheet, Platform,
  ActivityIndicator, TextInput, ScrollView, KeyboardAvoidingView,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import AvatarCircle from '../components/AvatarCircle';
import {
  IconX, IconSearch, IconSend, IconImage, IconCamera, IconMessageSquare,
  IconPaperclip, IconFilm, IconCheck, IconRefresh, IconPlay, IconFileText,
  IconPlus, IconWifiOff,
} from '../components/Icons';

const NET_TIMEOUT_MS = 10000;
const MAX_SELECTED = 10;
const THUMB_H = 84;

function _rand() { return Math.random().toString(36).slice(2, 8); }

// Local per-account conversation snapshot, synchronous. chatStore returns []
// while the account scope is locked (never another account's rows).
function readLocalConversations() {
  try {
    const cs = require('../services/chatStore');
    const l = cs.getConversationsSync?.();
    if (Array.isArray(l) && l.length) return l;
  } catch {}
  try {
    const sc = require('../services/smartChatCache');
    const l = sc.getCachedConversationsSync?.();
    if (Array.isArray(l) && l.length) return l;
  } catch {}
  return [];
}

function _ts(c) {
  const v = c?.last_message_at || c?.updated_at || c?.created_at || 0;
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeConversations(list) {
  const seen = new Set();
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || c.id == null) continue;
    const k = String(c.id);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  out.sort((a, b) => _ts(b) - _ts(a));
  return out;
}

function _kindFromMime(mime, fallback) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('video')) return 'video';
  if (m.startsWith('image')) return 'image';
  if (m) return 'file';
  return fallback || 'file';
}

function _mimeFromName(name, kind) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif',
    gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4',
    pdf: 'application/pdf',
  };
  if (map[ext]) return map[ext];
  if (kind === 'video') return 'video/mp4';
  if (kind === 'image') return 'image/jpeg';
  return 'application/octet-stream';
}

// Route params → [{ uri, mime, name, kind, w, h, size }]
function parseSharedFiles(params) {
  let files = [];
  try {
    if (params.files) {
      const arr = JSON.parse(String(params.files));
      if (Array.isArray(arr)) files = arr.filter(f => f && f.uri);
    }
  } catch {}
  if (!files.length) {
    const uri = params.uri || params.file || null;
    if (uri) {
      const name = params.name || String(uri).split('/').pop() || 'arquivo';
      const mime = params.mime || _mimeFromName(name, params.type);
      files = [{ uri: String(uri), mime, name: String(name), kind: _kindFromMime(params.mime, params.type === 'text' ? 'file' : params.type), w: 0, h: 0, size: 0 }];
    }
  }
  return files.map(f => {
    const name = f.name || String(f.uri).split('/').pop() || 'arquivo';
    const mime = f.mime || _mimeFromName(name, f.kind);
    return { ...f, name, mime, kind: f.kind || _kindFromMime(mime, 'file') };
  });
}

export default function ShareReceiveScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user, loading: authLoading } = useAuth();

  // ── Shared payload ────────────────────────────────────────────────────────
  const files = useMemo(() => parseSharedFiles(params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params.files, params.uri, params.file, params.name, params.mime, params.type]);
  const sharedText = params.text ? String(params.text) : '';
  const hasMedia = files.length > 0;
  const [caption, setCaption] = useState('');
  const [text, setText] = useState(sharedText);
  useEffect(() => { setText(sharedText); }, [sharedText]);

  // Real dimensions for thumbnails whose size the share intent didn't report.
  const [dims, setDims] = useState({});
  useEffect(() => {
    let alive = true;
    files.forEach((f) => {
      if (f.kind !== 'image' || (f.w > 0 && f.h > 0)) return;
      try {
        Image.getSize(f.uri, (w, h) => {
          if (alive && w > 0 && h > 0) setDims(prev => (prev[f.uri] ? prev : { ...prev, [f.uri]: { w, h } }));
        }, () => {});
      } catch {}
    });
    return () => { alive = false; };
  }, [files]);

  // ── Conversations: local cache on frame 1, network on top ─────────────────
  const [conversations, setConversations] = useState(() => normalizeConversations(readLocalConversations()));
  const [netState, setNetState] = useState('loading'); // loading | ok | error
  const loadSeq = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const loadChats = useCallback(async () => {
    const seq = ++loadSeq.current;
    setNetState('loading');
    let timer = null;
    try {
      const r = await Promise.race([
        api.chatConversations('', false),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('share_list_timeout')), NET_TIMEOUT_MS); }),
      ]);
      if (!mountedRef.current || seq !== loadSeq.current) return;
      if (!api.apiOk(r)) throw new Error((r && r.message) || 'share_list_failed');
      // chat_list returns a bare array under `data`; the WS relay wraps it as
      // { conversations } — apiList normalizes every transport shape.
      const list = api.apiList(r, 'conversations', 'chats');
      setConversations(prev => (list.length || !prev.length) ? normalizeConversations(list) : prev);
      setNetState('ok');
    } catch {
      if (!mountedRef.current || seq !== loadSeq.current) return;
      // Keep whatever the cache painted; surface the error state.
      setConversations(prev => (prev.length ? prev : normalizeConversations(readLocalConversations())));
      setNetState('error');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }, []);

  const userEmail = user?.email || '';
  useEffect(() => {
    if (!userEmail) return undefined;
    // The local cache may still be hydrating on a cold start triggered by the
    // share → re-read it a couple of times until the network answers.
    const reread = () => {
      setConversations(prev => {
        if (prev.length) return prev;
        const l = normalizeConversations(readLocalConversations());
        return l.length ? l : prev;
      });
    };
    reread();
    const t1 = setTimeout(reread, 300);
    const t2 = setTimeout(reread, 1200);
    loadChats();
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [userEmail, loadChats]);

  // ── Search / selection ───────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState([]); // conversation objects, in tap order
  const selectedIds = useMemo(() => new Set(selected.map(c => String(c.id))), [selected]);

  // [2026-10-09 notif-native] Share-sheet suggestion (iOS INSendMessageIntent
  // row / Android Direct Share shortcut) → preselect that chat, so "Enviar" is
  // one tap like WhatsApp. Consumed once; no-op on binaries without it.
  const shareTargetRef = useRef(undefined);
  useEffect(() => {
    if (shareTargetRef.current === undefined) {
      shareTargetRef.current = null;
      try {
        if (Platform.OS === 'ios') {
          const { Intents } = require('../modules/expo-native-toolkit');
          shareTargetRef.current = Intents?.consumeShareTarget?.() || null;
        } else if (Platform.OS === 'android') {
          const { requireOptionalNativeModule } = require('expo');
          const m = requireOptionalNativeModule('ExpoAppShortcuts');
          shareTargetRef.current = (m && typeof m.consumeShareTarget === 'function') ? (m.consumeShareTarget() || null) : null;
        }
      } catch { shareTargetRef.current = null; }
    }
    const target = shareTargetRef.current;
    if (!target || selected.length || !conversations.length) return;
    const cid = String(target.conversationId || '');
    const handle = String(target.handle || '').toLowerCase();
    const match = conversations.find(c => cid && String(c.id) === cid)
      || (handle ? conversations.find(c => String(c.other_email || c.contact_email || '').toLowerCase() === handle) : null);
    if (match) {
      shareTargetRef.current = null;
      setSelected([match]);
    }
  }, [conversations, selected.length]);

  const displayNameOf = useCallback((c) => {
    if (!c) return '';
    const isGroup = c.type === 'group' || c.type === 'channel' || !!c.is_group;
    const peer = !isGroup ? (c.other_email || c.contact_email || c.email || '') : '';
    if (c.type === 'saved' || (peer && userEmail && peer.toLowerCase() === userEmail.toLowerCase())) {
      return t('chat.savedMessages');
    }
    let nick = '';
    if (peer) { try { nick = require('../services/nicknames').getNickname(peer) || ''; } catch {} }
    return nick || api.emailToDisplayName(c.display_name || c.name || peer || '') || peer || '—';
  }, [t, userEmail]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations.filter(c => !c.archived);
    return conversations.filter((c) => {
      const hay = [displayNameOf(c), c.name, c.display_name, c.other_email, c.contact_email]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [conversations, query, displayNameOf]);

  const toggle = useCallback((conv) => {
    setSelected((prev) => {
      const k = String(conv.id);
      if (prev.some(c => String(c.id) === k)) return prev.filter(c => String(c.id) !== k);
      if (prev.length >= MAX_SELECTED) return prev;
      return [...prev, conv];
    });
  }, []);

  // ── Quick actions (unchanged destinations) ────────────────────────────────
  const first = files[0] || null;
  const sharedType = first ? first.kind : 'text';
  const handleShareToFeed = useCallback(() => {
    router.replace({
      pathname: '/spotlight',
      params: {
        createPost: '1',
        _shared_uri: first?.uri || '',
        _shared_text: text || caption || '',
        _shared_type: first?.kind || 'image',
        _shared_name: first?.name || '',
      },
    });
  }, [router, first, text, caption]);

  const handleShareToStatus = useCallback(() => {
    router.replace({
      pathname: '/chat',
      params: {
        tab: 'status', new: '1',
        _shared_uri: first?.uri || '',
        _shared_type: first?.kind || 'image',
        _shared_name: first?.name || '',
      },
    });
  }, [router, first]);

  const handleShareToNewChat = useCallback(() => {
    router.replace({
      pathname: '/chat-new',
      params: {
        _shared_uri: first?.uri || '',
        _shared_text: text || '',
        _shared_type: first ? first.kind : 'text',
        _shared_name: first?.name || '',
      },
    });
  }, [router, first, text]);

  // ── Send (durable outbox / media queue) ──────────────────────────────────
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(false);

  const _echoToList = (convId, content, type, tempId, createdAt) => {
    try {
      const ws = require('../services/websocket').default;
      ws._emit?.('chat_local_outbound', {
        conversation_id: convId, id: tempId, sender_email: userEmail,
        sender_name: user?.name || userEmail, content: content || '', type, created_at: createdAt, _local: true,
      });
    } catch {}
  };

  // Native: enqueue into the durable queues. Returns true when queued.
  const _enqueueNative = async (conv, f, cap, batchId) => {
    let outbox = null;
    try { outbox = require('../services/messageOutbox'); } catch { return false; }
    if (!outbox?.OUTBOX_V2_ONLY || Platform.OS === 'web') return false;
    const convId = Number(conv.id);
    const cmi = 'msg_' + Date.now() + '_' + _rand();
    const tempId = 'tmp_' + Date.now() + '_' + _rand();
    const createdAt = new Date().toISOString();
    try {
      if (f) {
        const msq = require('../services/mediaSendQueue');
        const r = await msq.enqueueMedia({
          client_message_id: cmi,
          conversation_id: convId,
          temp_id: tempId,
          type: f.kind === 'file' ? 'file' : f.kind,
          local_uri: f.uri,
          mime_type: f.mime,
          file_name: f.name || 'file',
          file_size: f.size || 0,
          caption: cap || '',
          view_once: 0,
          hd: false,
          sender_email: userEmail,
          created_at: createdAt,
          batch_id: batchId || null,
          duration: null,
        });
        if (!r) return false;
        _echoToList(convId, cap, f.kind, tempId, createdAt);
        return true;
      }
      const r = await outbox.enqueue({
        client_message_id: cmi,
        conversation_id: convId,
        temp_id: tempId,
        content: cap,
        display_content: cap,
        type: 'text',
        reply_to_id: null,
        mentions: null,
        sender_email: userEmail,
        created_at: createdAt,
        opts: { skipRust: true },
      });
      if (!r) return false;
      try { require('../services/sendWorker').poke?.(convId); } catch {}
      _echoToList(convId, cap, 'text', tempId, createdAt);
      return true;
    } catch {
      return false;
    }
  };

  // Web / outbox unavailable: direct API (same endpoints the conversation uses).
  const _sendDirect = async (conv, f, cap) => {
    const cmi = 'msg_' + Date.now() + '_' + _rand();
    if (f) {
      const file = Platform.OS === 'web'
        ? await fetch(f.uri).then(r => r.blob()).then(b => new File([b], f.name, { type: f.mime }))
        : { uri: f.uri, name: f.name, type: f.mime };
      const r = await api.chatUploadFile(conv.id, file, cap || '', false, null, f.kind === 'file' ? 'file' : f.kind, null, false, cmi);
      return api.apiOk(r);
    }
    const r = await api.chatSend(conv.id, cap, 'text', null, null, null, null, cmi);
    return api.apiOk(r);
  };

  const handleSend = useCallback(async () => {
    if (sending || !selected.length) return;
    const textBody = (text || '').trim();
    if (!hasMedia && !textBody) return;
    setSending(true);
    setSendError(false);
    let failed = 0;
    for (const conv of selected) {
      const batchId = files.length > 1 ? `batch_${Date.now()}_${_rand()}` : null;
      const items = hasMedia ? files : [null];
      for (let i = 0; i < items.length; i++) {
        const f = items[i];
        const cap = f ? (i === 0 ? caption.trim() : '') : textBody;
        let ok = await _enqueueNative(conv, f, cap, batchId);
        if (!ok) { try { ok = await _sendDirect(conv, f, cap); } catch { ok = false; } }
        if (!ok) failed++;
      }
    }
    if (!mountedRef.current) return;
    if (failed && selected.length === 1) {
      // Last resort: open the conversation with the payload pre-loaded so the
      // user never loses the share (old behaviour).
      const conv = selected[0];
      setSending(false);
      router.replace({
        pathname: '/chat-conversation',
        params: {
          id: String(conv.id), name: displayNameOf(conv), email: conv.other_email || '',
          _shared_uri: first?.uri || '', _shared_text: hasMedia ? '' : textBody,
          _shared_type: first ? first.kind : 'text', _shared_name: first?.name || '',
        },
      });
      return;
    }
    if (failed) { setSending(false); setSendError(true); return; }
    if (selected.length === 1) {
      const conv = selected[0];
      router.replace({ pathname: '/chat-conversation', params: { id: String(conv.id), name: displayNameOf(conv), email: conv.other_email || '' } });
    } else {
      router.replace('/chat');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending, selected, files, hasMedia, caption, text, router, displayNameOf, first, userEmail]);

  // ── Auth gates ───────────────────────────────────────────────────────────
  const [authTimedOut, setAuthTimedOut] = useState(false);
  useEffect(() => {
    if (!authLoading) return undefined;
    const tm = setTimeout(() => setAuthTimedOut(true), 4000);
    return () => clearTimeout(tm);
  }, [authLoading]);

  const hair = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
  const fill = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.045)';

  if (authLoading && !authTimedOut) {
    return (
      <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top, alignItems: 'center', justifyContent: 'center' }]}>
        <ActivityIndicator size="small" color={colors.textSecondary} />
      </View>
    );
  }
  if (!user) {
    return (
      <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top, alignItems: 'center', justifyContent: 'center', padding: 24 }]}>
        <Text style={{ color: colors.text, fontSize: 16, marginBottom: 14, textAlign: 'center' }}>{t('share.loginFirst')}</Text>
        <TouchableOpacity onPress={() => router.replace('/login')} style={[s.pillSolid, { backgroundColor: colors.primary }]} accessibilityRole="button">
          <Text style={{ color: colors.onPrimary, fontWeight: '700', fontSize: 15 }}>{t('common.login')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Pieces ───────────────────────────────────────────────────────────────
  const kindLabel = (() => {
    if (!hasMedia) return t('share.kindText');
    if (files.length > 1) return t('share.kindItems', { count: files.length });
    if (first.kind === 'image') return t('share.kindImage');
    if (first.kind === 'video') return t('share.kindVideo');
    return t('share.kindFile');
  })();
  const subtitle = selected.length
    ? t('share.selectedCount', { count: selected.length })
    : kindLabel;

  const renderThumb = (f, idx) => {
    const d = (f.w > 0 && f.h > 0) ? { w: f.w, h: f.h } : dims[f.uri];
    if (f.kind === 'image') {
      const ar = d ? d.w / d.h : 1;
      const w = Math.max(48, Math.min(THUMB_H * 1.8, THUMB_H * ar));
      return (
        <View key={f.uri + idx} style={[s.thumb, { width: w, backgroundColor: fill, borderColor: hair }]}>
          <Image source={{ uri: f.uri }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
        </View>
      );
    }
    const isVideo = f.kind === 'video';
    return (
      <View key={f.uri + idx} style={[s.thumb, { width: isVideo ? THUMB_H : 120, backgroundColor: fill, borderColor: hair, padding: 8, alignItems: 'center', justifyContent: 'center' }]}>
        {isVideo ? <IconPlay size={22} color={colors.text} /> : <IconFileText size={22} color={colors.text} />}
        {!isVideo ? (
          <Text numberOfLines={2} style={{ color: colors.textSecondary, fontSize: 11, marginTop: 6, textAlign: 'center' }}>{f.name}</Text>
        ) : null}
      </View>
    );
  };

  const QuickAction = ({ icon: Icon, label, onPress }) => (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[s.quick, { borderColor: hair }]}
    >
      <Icon size={16} color={colors.text} />
      <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600', marginLeft: 6 }} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );

  const showSkeleton = netState === 'loading' && conversations.length === 0;
  const showHardError = netState === 'error' && conversations.length === 0;

  const header = (
    <View>
      {/* Preview — compact, real aspect ratio, never cropped. */}
      {hasMedia ? (
        <View style={{ paddingTop: 12 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
            {files.map(renderThumb)}
          </ScrollView>
          <View style={[s.inputRow, { backgroundColor: fill, marginHorizontal: 16, marginTop: 10 }]}>
            <TextInput
              value={caption}
              onChangeText={setCaption}
              placeholder={t('share.addCaption')}
              placeholderTextColor={colors.textTertiary}
              style={[s.input, { color: colors.text }]}
              maxLength={2000}
              multiline
            />
          </View>
        </View>
      ) : (
        <View style={[s.inputRow, { backgroundColor: fill, marginHorizontal: 16, marginTop: 12, alignItems: 'flex-start' }]}>
          <IconMessageSquare size={16} color={colors.textSecondary} style={{ marginTop: Platform.OS === 'ios' ? 2 : 10 }} />
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={t('share.addCaption')}
            placeholderTextColor={colors.textTertiary}
            style={[s.input, { color: colors.text, marginLeft: 8, maxHeight: 110 }]}
            multiline
          />
        </View>
      )}

      {/* Quick actions — one compact monochrome row. */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 14, gap: 8 }} keyboardShouldPersistTaps="handled">
        {hasMedia && first.kind !== 'file' ? <QuickAction icon={IconCamera} label={t('share.statusShort')} onPress={handleShareToStatus} /> : null}
        <QuickAction icon={IconImage} label={t('share.feedShort')} onPress={handleShareToFeed} />
        <QuickAction icon={IconPlus} label={t('share.toNewChat')} onPress={handleShareToNewChat} />
      </ScrollView>

      {/* Search */}
      <View style={[s.inputRow, { backgroundColor: fill, marginHorizontal: 16, marginTop: 14, alignItems: 'center' }]}>
        <IconSearch size={16} color={colors.textSecondary} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t('share.searchAll')}
          placeholderTextColor={colors.textTertiary}
          style={[s.input, { color: colors.text, marginLeft: 8 }]}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
        />
        {query ? (
          <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityLabel={t('common.close')}>
            <IconX size={14} color={colors.textSecondary} />
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 6 }}>
        <Text style={[s.section, { color: colors.textSecondary, flex: 1 }]}>
          {query.trim() ? t('share.results') : t('share.recentTitle')}
        </Text>
        {netState === 'loading' && conversations.length > 0 ? (
          <ActivityIndicator size="small" color={colors.textTertiary} />
        ) : null}
        {netState === 'error' && conversations.length > 0 ? (
          <TouchableOpacity onPress={loadChats} style={{ flexDirection: 'row', alignItems: 'center' }} accessibilityRole="button" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <IconWifiOff size={13} color={colors.textTertiary} />
            <Text style={{ color: colors.textTertiary, fontSize: 12, marginLeft: 5 }}>{t('share.savedList')}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );

  const emptyComponent = showSkeleton ? (
    <View style={{ paddingHorizontal: 16 }}>
      {[0, 1, 2, 3, 4, 5].map(i => (
        <View key={i} style={s.row}>
          <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: fill }} />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <View style={{ width: `${45 + ((i * 17) % 35)}%`, height: 12, borderRadius: 6, backgroundColor: fill }} />
          </View>
        </View>
      ))}
    </View>
  ) : showHardError ? (
    <View style={[s.stateBox, { borderColor: hair }]}>
      <IconWifiOff size={26} color={colors.textSecondary} />
      <Text style={{ color: colors.text, fontSize: 14, textAlign: 'center', marginTop: 10 }}>{t('share.chatsLoadFailed')}</Text>
      <TouchableOpacity onPress={loadChats} style={[s.pillOutline, { borderColor: colors.text, marginTop: 14 }]} accessibilityRole="button">
        <IconRefresh size={14} color={colors.text} />
        <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13, marginLeft: 6 }}>{t('common.retry')}</Text>
      </TouchableOpacity>
    </View>
  ) : (
    <View style={[s.stateBox, { borderColor: hair }]}>
      <IconMessageSquare size={26} color={colors.textSecondary} />
      <Text style={{ color: colors.textSecondary, fontSize: 14, textAlign: 'center', marginTop: 10 }}>
        {query.trim() ? t('share.noResults') : t('share.noChats')}
      </Text>
      <TouchableOpacity onPress={handleShareToNewChat} style={[s.pillOutline, { borderColor: colors.text, marginTop: 14 }]} accessibilityRole="button">
        <IconPlus size={14} color={colors.text} />
        <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13, marginLeft: 6 }}>{t('share.toNewChat')}</Text>
      </TouchableOpacity>
    </View>
  );

  const renderItem = ({ item }) => {
    const name = displayNameOf(item);
    const isGroup = item.type === 'group' || item.type === 'channel' || !!item.is_group;
    const on = selectedIds.has(String(item.id));
    return (
      <TouchableOpacity
        onPress={() => toggle(item)}
        activeOpacity={0.6}
        style={[s.row, { paddingHorizontal: 16 }]}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: on }}
        accessibilityLabel={name}
      >
        <View>
          <AvatarCircle
            name={name}
            email={isGroup ? undefined : (item.other_email || item.contact_email || undefined)}
            uri={isGroup ? (item.avatar_url || undefined) : undefined}
            members={isGroup ? item.members : undefined}
            size={44}
          />
        </View>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: on ? '700' : '500' }} numberOfLines={1}>{name}</Text>
          {isGroup ? (
            <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 1 }} numberOfLines={1}>{t('share.group')}</Text>
          ) : null}
        </View>
        <View style={[s.radio, on ? { backgroundColor: colors.primary, borderColor: colors.primary } : { borderColor: isDark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.22)' }]}>
          {on ? <IconCheck size={13} color={colors.onPrimary} strokeWidth={3} /> : null}
        </View>
      </TouchableOpacity>
    );
  };

  const selectedNames = selected.map(displayNameOf).join(', ');

  return (
    <KeyboardAvoidingView
      style={[s.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={{ paddingTop: insets.top, backgroundColor: colors.background }}>
        <View style={[s.header, { borderBottomColor: hair }]}>
          <TouchableOpacity onPress={() => router.replace('/chat')} style={s.headerBtn} accessibilityLabel={t('common.close')} accessibilityRole="button">
            <IconX size={22} color={colors.text} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={[s.headerTitle, { color: colors.text }]} numberOfLines={1}>{t('share.title')}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 1 }}>
              {!selected.length ? (
                sharedType === 'image' ? <IconImage size={12} color={colors.textSecondary} />
                  : sharedType === 'video' ? <IconFilm size={12} color={colors.textSecondary} />
                    : sharedType === 'text' ? <IconMessageSquare size={12} color={colors.textSecondary} />
                      : <IconPaperclip size={12} color={colors.textSecondary} />
              ) : null}
              <Text style={{ fontSize: 12, color: colors.textSecondary, marginLeft: selected.length ? 0 : 5 }} numberOfLines={1}>{subtitle}</Text>
            </View>
          </View>
          {selected.length ? (
            <View style={[s.countBadge, { backgroundColor: colors.primary }]}>
              <Text style={{ color: colors.onPrimary, fontSize: 12, fontWeight: '700' }}>{selected.length}</Text>
            </View>
          ) : null}
        </View>
      </View>

      <FlatList
        data={showSkeleton || showHardError ? [] : filtered}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderItem}
        extraData={selectedIds}
        ListHeaderComponent={header}
        ListEmptyComponent={emptyComponent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={14}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: selected.length ? 16 : 24 + insets.bottom }}
      />

      {selected.length ? (
        <View style={[s.sendBar, { backgroundColor: colors.background, borderTopColor: hair, paddingBottom: Math.max(insets.bottom, 10) }]}>
          <View style={{ flex: 1, marginRight: 12 }}>
            <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>{selectedNames}</Text>
            {sendError ? (
              <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }} numberOfLines={1}>{t('share.sendFailed')}</Text>
            ) : null}
          </View>
          <TouchableOpacity
            onPress={handleSend}
            disabled={sending || (!hasMedia && !(text || '').trim())}
            activeOpacity={0.8}
            style={[s.sendBtn, { backgroundColor: colors.primary, opacity: (!hasMedia && !(text || '').trim()) ? 0.4 : 1 }]}
            accessibilityRole="button"
            accessibilityLabel={t('common.send')}
          >
            {sending
              ? <ActivityIndicator size="small" color={colors.onPrimary} />
              : <IconSend size={20} color={colors.onPrimary} />}
          </TouchableOpacity>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 8, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', marginRight: 4 },
  headerTitle: { fontSize: 17, fontWeight: '700' },
  countBadge: { minWidth: 24, height: 24, borderRadius: 12, paddingHorizontal: 7, alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  thumb: { height: THUMB_H, borderRadius: 12, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  inputRow: { flexDirection: 'row', borderRadius: 12, paddingHorizontal: 12, paddingVertical: Platform.OS === 'ios' ? 10 : 2 },
  input: { flex: 1, fontSize: 15, padding: 0, maxHeight: 90 },
  quick: {
    flexDirection: 'row', alignItems: 'center',
    height: 34, paddingHorizontal: 12, borderRadius: 17, borderWidth: StyleSheet.hairlineWidth * 2,
  },
  section: { fontSize: 12, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, minHeight: 62 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', marginLeft: 10 },
  stateBox: {
    marginHorizontal: 16, marginTop: 8, paddingVertical: 26, paddingHorizontal: 20,
    borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center',
  },
  pillSolid: { paddingHorizontal: 22, paddingVertical: 12, borderRadius: 22 },
  pillOutline: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, height: 34, borderRadius: 17, borderWidth: 1 },
  sendBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth,
  },
  sendBtn: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
});
