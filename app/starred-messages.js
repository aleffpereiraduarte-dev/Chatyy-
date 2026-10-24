import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Text, SectionList, Pressable, StyleSheet, Platform, TextInput, ScrollView } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../components/nativeHeader'; // [2026-10-09 more-native]
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import {
  IconArrowLeft, IconStar, IconStarFilled, IconBookmark, IconImage, IconVideo, IconMic,
  IconFileText, IconMapPin, IconUser, IconBarChart, IconSmile, IconPhone, IconLock, IconMessageSquare,
  IconSearch, IconX, IconLink, IconCalendar, IconUsers, IconPlay,
} from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';
import FadeSlideIn from '../components/FadeSlideIn';
import PressableRow from '../components/PressableRow';
import { showToast, useSurface, Skeleton } from '../components/ui';
import UIRefreshControl from '../components/ui/RefreshControl';
import * as api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { regionalLocale } from '../utils/dateFormat';
import { detailColor } from '../constants/theme';
import {
  getCachedStarred, fetchStarred, prewarmSavedConv, openSavedFast,
} from '../services/savedStarredCache'; // [salvas-fav 2026-10-22] cache local + SWR
import {
  STARRED_FILTERS, starredKind, starredThumb, firstLink, starredPlainText, foldSearch,
} from '../components/chat/starredKinds';

let NativeSwipeable = null;
if (Platform.OS !== 'web') {
  try { NativeSwipeable = require('react-native-gesture-handler').Swipeable; } catch {}
}
let ExpoImage = null;
try { ExpoImage = require('expo-image').Image; } catch {}

// Unified "Salvas | Favoritas" screen (E.3).
//
//   - Salvas    = your Telegram-style self-chat ("Mensagens Salvas"). Lives in
//                 a real conversation; opening it routes to /saved-messages.
//   - Favoritas = individual starred messages bookmarked across any chat
//                 (chat_starred_messages).
//
// [2026-10-19 favoritas-wa] avatar da conversa, datas localizadas, prévia com
// ícone, toque abre NA mensagem, deslizar ← desfavorita, estados vazios.
//
// [2026-10-21 favoritas-pro] Nível WhatsApp/Telegram (JS, sem build):
//   • MINIATURA DAS FOTOS: o chat_starred_messages servido por email.php não
//     trazia file_url → describe() montava thumb vazio e o <Image> nem existia.
//     Servidor corrigido (file_url + image_variants t320 + blurhash) e a
//     miniatura sai de starredThumb() (t320 → disp → original; vídeo = pôster),
//     com blurhash de placeholder;
//   • busca (texto, legenda, arquivo, remetente, conversa — sem acento);
//   • filtros por tipo: Tudo / Fotos / Vídeos / Links / Arquivos / Áudio / Texto
//     (só aparecem os que têm itens; contador em cada um);
//   • agrupado POR DATA (Hoje, Ontem, dia da semana, data, mês) ou POR
//     CONVERSA (cabeçalho com avatar + contagem);
//   • prévia real: miniatura c/ play e duração, link com domínio, arquivo com
//     nome/tamanho, áudio com duração;
//   • tocar = abre a conversa na mensagem; segurar ou deslizar = remove com
//     "Desfazer" (toast); puxar p/ atualizar; skeleton no 1º carregamento.

const WEEKDAYS = {
  pt: ['dom.', 'seg.', 'ter.', 'qua.', 'qui.', 'sex.', 'sáb.'],
  es: ['dom.', 'lun.', 'mar.', 'mié.', 'jue.', 'vie.', 'sáb.'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
};

// "2026-05-26 12:00:00+00" / "2026-05-26 12:00:00" (UTC) → Date
function parseTs(v) {
  if (!v) return null;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
  let s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2} /.test(s)) s = s.replace(' ', 'T');
  s = s.replace(/(\.\d{3})\d+/, '$1');
  s = s.replace(/([+-]\d{2})$/, '$1:00');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s += 'Z';
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function clock(d, lang) {
  if (String(lang || '').slice(0, 2).toLowerCase() === 'en') {
    try { return d.toLocaleTimeString(regionalLocale(lang) || 'en-US', { hour: 'numeric', minute: '2-digit' }); } catch {}
  }
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatWhen(v, t, language) {
  const d = parseTs(v);
  if (!d) return '';
  const lang = String(language || 'pt-BR');
  const base = lang.slice(0, 2).toLowerCase();
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const ts = d.getTime();
  if (ts >= startToday) return clock(d, lang);
  if (ts >= startToday - 86400000) return t('common.yesterday', 'Ontem');
  if (ts >= startToday - 6 * 86400000) {
    const arr = WEEKDAYS[base];
    if (arr) return arr[d.getDay()];
    try { return d.toLocaleDateString(regionalLocale(lang), { weekday: 'short' }); } catch { return ''; }
  }
  if (base === 'en') {
    try { return d.toLocaleDateString(regionalLocale(lang) || 'en-US', { day: 'numeric', month: 'numeric', year: 'numeric' }); } catch {}
  }
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// Cabeçalho de seção (agrupado por data): Hoje / Ontem / Quarta-feira /
// 12 de outubro / outubro de 2025.
function sectionDay(d, t, language) {
  if (!d) return { key: 'none', label: t('starredPro.older', 'Mais antigas') };
  const lang = String(language || 'pt-BR');
  const loc = regionalLocale(lang) || lang;
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const ts = d.getTime();
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  if (ts >= startToday) return { key: 'today', label: t('starredPro.today', 'Hoje') };
  if (ts >= startToday - 86400000) return { key: 'yday', label: t('common.yesterday', 'Ontem') };
  if (ts >= startToday - 6 * 86400000) {
    let s = '';
    try { s = d.toLocaleDateString(loc, { weekday: 'long' }); } catch {}
    return { key: `wd${d.getDay()}`, label: cap(s) || formatWhen(d.getTime(), t, lang) };
  }
  if (d.getFullYear() === now.getFullYear() && now.getTime() - ts < 62 * 86400000) {
    let s = '';
    try { s = d.toLocaleDateString(loc, { day: 'numeric', month: 'long' }); } catch {}
    return { key: `d${d.getMonth()}-${d.getDate()}`, label: cap(s) || `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}` };
  }
  let s = '';
  try { s = d.toLocaleDateString(loc, { month: 'long', year: 'numeric' }); } catch {}
  return { key: `m${d.getFullYear()}-${d.getMonth()}`, label: cap(s) || `${pad2(d.getMonth() + 1)}/${d.getFullYear()}` };
}

function fmtDur(sec) {
  let n = Number(sec) || 0;
  if (n > 36000) n = n / 1000;
  n = Math.round(n);
  if (!(n > 0)) return '';
  return `${Math.floor(n / 60)}:${pad2(n % 60)}`;
}
function fmtSize(b) {
  const n = Number(b) || 0;
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1).replace('.', ',')} MB`;
}

const FILE_LIKE = /\.(jpe?g|png|gif|webp|heic|heif|bmp|mp4|mov|m4v|webm|avif|mp3|m4a|ogg|opus|wav|aac|caf)$/i;
function isFileNameLike(s) {
  const v = String(s || '').trim();
  if (!v) return false;
  if (/^https?:\/\//i.test(v) && !/\s/.test(v) && FILE_LIKE.test(v.split('?')[0])) return true;
  if (/^\/data\//.test(v)) return true;
  if (FILE_LIKE.test(v)) return true;
  if (/^\[[a-z_]+\]/i.test(v)) return true;
  return !/\s/.test(v) && v.length > 14 && /[_\-/\d]/.test(v) && !/^https?:/i.test(v);
}

// Mensagem favorita → { Icon, text, thumb, copyText, link, meta, play, dur }
function describeMessage(m, t) {
  const type = String(m.type || m.message_type || 'text');
  const content = typeof m.content === 'string' ? m.content : '';
  let parsed = null;
  const trimmed = content.trim();
  if (trimmed.startsWith('{')) { try { parsed = JSON.parse(trimmed); } catch {} }
  const plain = parsed ? '' : trimmed;
  const caption = (parsed && typeof parsed.caption === 'string' && parsed.caption.trim()) || (plain && !isFileNameLike(plain) ? plain : '');
  const L = (k, fb) => { const v = t(k); return v && v !== k ? v : fb; };
  const typeLabel = {
    image: [IconImage, L('chat.photo', 'Foto')], video: [IconVideo, L('chat.video', 'Vídeo')],
    audio: [IconMic, L('chat.audio', 'Áudio')], voice: [IconMic, L('chat.audio', 'Áudio')],
    file: [IconFileText, L('starredV2.document', 'Documento')], document: [IconFileText, L('starredV2.document', 'Documento')],
  }[type];

  if (parsed && parsed.e2e) {
    let pk = null;
    try { pk = require('../services/e2eeV4').peekPlaintext(content); } catch {}
    try { if (pk == null) { const _e5 = require('../services/e2ee/e2ee5').peek(content); if (_e5) pk = _e5.text; } } catch {} // [e2ee5] texto já decifrado neste aparelho
    // Mídia cifrada: o servidor sabe só o TIPO — mostra "Foto"/"Vídeo"… com cadeado.
    if (typeLabel) return { Icon: typeLabel[0], text: pk ? String(pk) : typeLabel[1], copyText: pk || '', locked: true };
    return pk != null && String(pk).trim()
      ? { text: String(pk), copyText: String(pk), link: firstLink(String(pk)) }
      : { Icon: IconLock, text: L('e2ee.listPreview', 'Mensagem criptografada') };
  }
  const viewOnce = m.is_view_once === true || m.is_view_once === 1 || !!(parsed && parsed.view_once);
  if (type === 'image' || type === 'video') {
    const isVid = type === 'video';
    const th = viewOnce ? null : starredThumb(m);
    const dur = isVid ? fmtDur(m.duration || (parsed && parsed.duration)) : '';
    const label = isVid ? L('chat.video', 'Vídeo') : L('chat.photo', 'Foto');
    return {
      Icon: isVid ? IconVideo : IconImage,
      text: caption || (viewOnce ? `${label} · ${L('starredPro.viewOnce', 'Visualização única')}` : label),
      thumb: th, play: isVid, dur, copyText: caption,
    };
  }
  if (type === 'gif' || /^https?:\/\/(media[0-9]*\.)?(tenor|giphy)\.com\//i.test(plain)) {
    return { Icon: IconImage, text: type === 'gif' && caption ? caption : 'GIF', thumb: starredThumb(m) };
  }
  if (type === 'audio' || type === 'voice') {
    const dur = fmtDur(m.duration || (parsed && parsed.duration));
    return { Icon: IconMic, text: L('chat.audio', 'Áudio'), meta: dur };
  }
  if (type === 'file' || type === 'document') {
    const name = m.file_name && !/^(blob|file)$/i.test(m.file_name) ? m.file_name : '';
    return { Icon: IconFileText, text: name || L('starredV2.document', 'Documento'), meta: fmtSize(m.file_size), copyText: caption, file: true };
  }
  if (type === 'sticker' || type === 'lottie_sticker') return { Icon: IconSmile, text: L('chat.sticker', 'Figurinha') };
  if (type === 'location' || (parsed && typeof parsed.latitude === 'number')) {
    return { Icon: IconMapPin, text: parsed && parsed.live ? L('chat.liveLocation', 'Localização ao vivo') : L('chat.location', 'Localização') };
  }
  if (type === 'contact' || (parsed && parsed.type === 'contact')) {
    let lbl = '';
    try { lbl = require('../components/chat/contactShare').contactPreviewLabel(parsed || {}, t); } catch {}
    return { Icon: IconUser, text: lbl || L('chat.contact', 'Contato') };
  }
  if (type === 'poll' || (parsed && typeof parsed.question === 'string' && Array.isArray(parsed.options))) {
    const q = parsed && typeof parsed.question === 'string' ? parsed.question.trim() : '';
    return { Icon: IconBarChart, text: q || L('chat.poll', 'Enquete'), copyText: q };
  }
  if (type === 'call_card' || (parsed && (parsed.call_id || parsed.call_type !== undefined))) {
    return { Icon: IconPhone, text: parsed && (parsed.video || parsed.call_type === 'video') ? L('chat.videoCall', 'Chamada de vídeo') : L('chat.voiceCall', 'Chamada de voz') };
  }
  if (parsed) {
    const txt = starredPlainText(m);
    if (txt) return { text: txt, copyText: txt, link: firstLink(txt) };
    if (parsed.file_url || parsed.media_url || parsed.url) return { Icon: IconFileText, text: L('chat.attachment', 'Anexo') };
    return { Icon: IconMessageSquare, text: L('chat.message', 'Mensagem') };
  }
  if (m.file_url && (!plain || isFileNameLike(plain))) return { Icon: IconFileText, text: m.file_name || L('chat.attachment', 'Anexo'), meta: fmtSize(m.file_size), file: true };
  return { text: plain || L('chat.message', 'Mensagem'), copyText: plain, link: firstLink(plain) };
}

function EmptyState({ Icon, title, body, s, action }) {
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: s.fill }]}>
        <Icon size={34} color={s.text} />
      </View>
      <Text style={[styles.emptyTitle, { color: s.text }]}>{title}</Text>
      <Text style={[styles.emptySubtitle, { color: s.textSecondary }]}>{body}</Text>
      {action || null}
    </View>
  );
}

function SkeletonList() {
  return (
    <View style={{ paddingTop: 8 }}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <View key={i} style={styles.skRow}>
          <Skeleton width={46} height={46} radius={23} delay={i * 40} />
          <View style={{ flex: 1, marginLeft: 12, gap: 8 }}>
            <Skeleton width="48%" height={13} radius={6} delay={i * 40 + 20} />
            <Skeleton width="78%" height={11} radius={6} delay={i * 40 + 40} />
          </View>
          {i % 2 === 0 ? <Skeleton width={52} height={52} radius={10} delay={i * 40 + 60} style={{ marginLeft: 10 }} /> : null}
        </View>
      ))}
    </View>
  );
}

function Thumb({ d, s, id }) {
  const th = d.thumb;
  return (
    <View style={[styles.thumb, { backgroundColor: s.fill }]}>
      {th && ExpoImage ? (
        <ExpoImage
          source={th.uri ? { uri: th.uri } : null}
          placeholder={th.blurhash ? { blurhash: th.blurhash } : undefined}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={String(id)}
          transition={140}
          accessibilityIgnoresInvertColors
        />
      ) : (d.Icon ? <d.Icon size={20} color={s.textSecondary} /> : null)}
      {d.play ? (
        <View style={styles.playWrap} pointerEvents="none">
          <View style={styles.playDot}><IconPlay size={11} color="#FFFFFF" /></View>
        </View>
      ) : null}
      {d.dur ? <Text style={styles.durBadge} numberOfLines={1}>{d.dur}</Text> : null}
    </View>
  );
}

const StarredRow = React.memo(function StarredRow({ item, conv, myEmail, t, language, s, accent, byChat, onOpen, onUnstar, onCopy }) {
  const swipeRef = useRef(null);
  const isMine = String(item.sender_email || '').toLowerCase() === myEmail;
  const isGroup = item.conversation_type === 'group' || item.conversation_type === 'channel' || conv?.type === 'group' || conv?.type === 'channel';
  const senderName = isMine ? (t('chat.you', 'Você')) : api.emailToDisplayName(item.sender_name || item.sender_email || '');
  // Título = conversa (1:1: o contato; grupo: o nome do grupo). Agrupado por
  // conversa o cabeçalho já diz qual é → o título vira quem mandou.
  const convTitle = isGroup
    ? (item.conversation_name || conv?.title || senderName)
    : (conv?.title || (isMine ? (item.conversation_name || '') : senderName) || senderName);
  const title = byChat ? senderName : convTitle;
  const peerEmail = byChat
    ? (item.sender_email || null)
    : (isGroup ? null : (conv?.peerEmail || (isMine ? '' : item.sender_email) || null));
  const showWho = !byChat && (isMine || isGroup);
  const d = describeMessage(item, t);
  const when = formatWhen(item.created_at, t, language);
  const Ic = d.Icon;
  const hasThumb = !!(d.thumb && (d.thumb.uri || d.thumb.blurhash));

  const a11yActions = [{ name: 'unstar', label: t('chat.unstar', 'Desfavoritar') }];
  if (d.copyText) a11yActions.push({ name: 'copy', label: t('common.copy', 'Copiar') });

  const row = (
    <PressableRow
      onPress={() => onOpen(item)}
      onLongPress={() => {
        try { require('../services/haptics').HapticsCompat.impactAsync?.('medium'); } catch {}
        onUnstar(item);
      }}
      delayLongPress={420}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${showWho ? senderName + ': ' : ''}${d.text}${d.meta ? ', ' + d.meta : ''}. ${when}`}
      accessibilityHint={t('starredPro.rowHint', 'Toque para abrir na conversa. Segure para remover das favoritas.')}
      accessibilityActions={a11yActions}
      onAccessibilityAction={(e) => {
        const n = e?.nativeEvent?.actionName;
        if (n === 'unstar') onUnstar(item);
        else if (n === 'copy' && d.copyText) onCopy(d.copyText);
      }}
      style={{ backgroundColor: s.bg }}
    >
      <View style={styles.row}>
        <AvatarCircle
          name={title}
          email={peerEmail || null}
          uri={!byChat && isGroup ? (conv?.avatar || undefined) : undefined}
          size={46}
        />
        <View style={styles.rowBody}>
          <View style={styles.rowHead}>
            <Text style={[styles.rowName, { color: s.text }]} numberOfLines={1}>{title}</Text>
            <Text style={[styles.rowTime, { color: s.textSecondary }]} numberOfLines={1}>{when}</Text>
          </View>
          <View style={styles.rowContent}>
            <IconStarFilled size={11} color={accent} />
            {showWho ? <Text style={[styles.rowWho, { color: s.text }]} numberOfLines={1}>{senderName}:</Text> : null}
            {Ic && !hasThumb ? <Ic size={14} color={s.textSecondary} /> : null}
            {d.locked ? <IconLock size={12} color={s.textSecondary} /> : null}
            <Text style={[styles.rowPreview, { color: s.textSecondary }]} numberOfLines={2}>
              {d.text}{d.meta ? `  ·  ${d.meta}` : ''}
            </Text>
          </View>
          {d.link ? (
            <View style={[styles.linkChip, { backgroundColor: s.fill }]}>
              <IconLink size={12} color={accent} />
              <Text style={[styles.linkHost, { color: s.text }]} numberOfLines={1}>{d.link.host}</Text>
            </View>
          ) : null}
        </View>
        {hasThumb ? <Thumb d={d} s={s} id={item.id} /> : null}
      </View>
      <View style={[styles.sep, { backgroundColor: s.separator }]} />
    </PressableRow>
  );

  if (!NativeSwipeable) return row;
  return (
    <NativeSwipeable
      ref={swipeRef}
      friction={1.6}
      rightThreshold={48}
      overshootRight={false}
      renderRightActions={() => (
        <Pressable
          onPress={() => { try { swipeRef.current?.close?.(); } catch {} onUnstar(item); }}
          accessibilityRole="button"
          accessibilityLabel={t('chat.unstar', 'Desfavoritar')}
          style={[styles.swipeAct, { backgroundColor: s.ink }]}
        >
          <IconStar size={20} color={s.onInk} />
          <Text style={[styles.swipeTxt, { color: s.onInk }]} numberOfLines={1}>{t('chat.unstar', 'Desfavoritar')}</Text>
        </Pressable>
      )}
    >
      {row}
    </NativeSwipeable>
  );
});

function ChatSectionHeader({ section, s }) {
  return (
    <View style={[styles.chatHead, { backgroundColor: s.bg, borderBottomColor: s.separator }]}>
      <AvatarCircle name={section.title} email={section.email || null} uri={section.avatar || undefined} size={26} />
      <Text style={[styles.chatHeadTxt, { color: s.text }]} numberOfLines={1} accessibilityRole="header">{section.title}</Text>
      <Text style={[styles.chatHeadCount, { color: s.textSecondary }]}>{section.data.length}</Text>
    </View>
  );
}

// conversation_id → { title, peerEmail, type, avatar } a partir de uma lista de conversas.
function buildConvMap(convs, myEmail) {
  const m = {};
  for (const c of (Array.isArray(convs) ? convs : [])) {
    if (!c || c.id == null) continue;
    const others = (Array.isArray(c.members) ? c.members : []).filter(x => String(x?.email || x || '').toLowerCase() !== myEmail);
    const o0 = others[0];
    const o0Email = typeof o0 === 'string' ? o0 : (o0?.email || '');
    const peerEmail = c.type === 'direct' ? (c.other_email || c.contact_email || o0Email || '') : '';
    const title = c.type === 'direct'
      ? api.emailToDisplayName(c.contact_name || c.display_name || (typeof o0 === 'object' ? o0?.display_name : '') || c.name || peerEmail)
      : (c.name || '');
    m[String(c.id)] = { title, peerEmail, type: c.type, avatar: c.avatar_url || c.avatar || '' };
  }
  return m;
}
// Espelho síncrono da lista de conversas (MMKV, ≤100) → nomes/avatares no 1º frame.
function cachedConvMap(myEmail) {
  try { return buildConvMap(require('../services/chatCache').getCachedConversationsMmkvSync(), myEmail); } catch { return {}; }
}

export default function StarredMessagesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const s = useSurface();
  const { t, language } = useLanguage();
  const { user } = useAuth() || {};
  const myEmail = String(user?.email || '').toLowerCase();
  const accent = detailColor(!!isDark) || s.textSecondary;
  // conversation_id → { title, peerEmail, type, avatar }.
  // [salvas-fav 2026-10-22] 1º frame: nomes da lista de conversas em cache + favoritas em cache.
  const [convMap, setConvMap] = useState(() => cachedConvMap(myEmail));

  const [tab, setTab] = useState('starred'); // 'saved' | 'starred'
  const [messages, setMessages] = useState(() => getCachedStarred(myEmail) || []);
  const [loading, setLoading] = useState(() => !getCachedStarred(myEmail));
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [groupBy, setGroupBy] = useState('date'); // 'date' | 'chat'
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  // [salvas-fav 2026-10-22] SWR: o cache já pintou; a rede só atualiza. A lista de
  // conversas (chat_conversations, p90 1,4 s) NÃO segura mais a pintura: só é pedida
  // se alguma favorita é de conversa fora do espelho local, e em 2º plano.
  const convMapRef = useRef(convMap);
  convMapRef.current = convMap;
  const load = useCallback(async () => {
    try {
      const list = await fetchStarred(myEmail);
      if (!aliveRef.current) return;
      if (list) {
        setMessages(list);
        const missing = list.some(m => m && m.conversation_id != null && !convMapRef.current[String(m.conversation_id)]);
        if (missing) {
          api.chatConversations().then((cv) => {
            if (!aliveRef.current) return;
            const convs = Array.isArray(cv?.data) ? cv.data : (Array.isArray(cv?.data?.conversations) ? cv.data.conversations : []);
            if (convs.length) setConvMap(prev => ({ ...prev, ...buildConvMap(convs, myEmail) }));
          }).catch(() => {});
        }
      }
    } catch (e) { console.warn('[starred] load:', e); }
    if (aliveRef.current) { setLoading(false); setRefreshing(false); }
  }, [myEmail]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { prewarmSavedConv(myEmail); }, [myEmail]); // aba Salvas abre sem esperar o servidor

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    try { require('../services/haptics').HapticsCompat.selectionAsync(); } catch {}
    load();
  }, [load]);

  const openSavedMessages = useCallback(() => {
    try {
      if (openSavedFast({ email: myEmail, name: t('chat.savedMessages', 'Mensagens Salvas'), router })) return;
      router.push('/saved-messages');
    } catch (e) { console.warn('[starred] saved nav:', e); }
  }, [router, myEmail, t]);

  const openConversation = useCallback((msg) => {
    if (!msg?.conversation_id) return;
    const cm = convMap[String(msg.conversation_id)] || {};
    const isMine = String(msg.sender_email || '').toLowerCase() === myEmail;
    const peer = cm.peerEmail || (isMine ? '' : (msg.sender_email || ''));
    const name = msg.conversation_name || cm.title || '';
    const mid = msg.id != null ? encodeURIComponent(msg.id) : '';
    try {
      require('../services/openConversation').openConversation(`/chat-conversation?id=${msg.conversation_id}&name=${encodeURIComponent(name)}&type=${msg.conversation_type || cm.type || 'direct'}${peer ? `&email=${encodeURIComponent(peer)}` : ''}${mid ? `&scrollToMessageId=${mid}&highlightMessageId=${mid}` : ''}`);
    } catch (e) { console.warn('[starred] nav:', e); }
  }, [convMap, myEmail]);

  // Desfavoritar com "Desfazer": some na hora (otimista); Desfazer devolve o
  // item NO MESMO LUGAR e refaz a estrela no servidor.
  const restar = useCallback(async (msg) => {
    setMessages((prev) => (prev.some((m) => String(m.id) === String(msg.id)) ? prev : [msg, ...prev]));
    try { await api.chatStarMessage(msg.id, true, msg.conversation_id ?? null, msg); } catch {}
  }, []);
  const unstar = useCallback(async (msg) => {
    if (!msg || msg.id == null) return;
    setMessages((prev) => prev.filter((m) => String(m.id) !== String(msg.id)));
    try {
      const r = await api.chatStarMessage(msg.id, false, msg.conversation_id ?? null, msg); // [sgu F4 P-1]
      if (r && r.success === false) throw new Error(r.message || '');
      showToast({
        message: t('starredV2.removed', 'Removida das favoritas'),
        action: { label: t('starredPro.undo', 'Desfazer'), onPress: () => restar(msg) },
        duration: 5000,
      });
    } catch {
      setMessages((prev) => (prev.some((m) => String(m.id) === String(msg.id)) ? prev : [msg, ...prev]));
      showToast({ message: t('starredPro.unstarFailed', 'Não foi possível remover. Tente de novo.'), kind: 'error' });
    }
  }, [t, restar]);

  const copyText = useCallback(async (text) => {
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) await navigator.clipboard.writeText(text);
      else await require('expo-clipboard').setStringAsync(text);
      showToast({ message: t('common.copied', 'Copiado') });
    } catch {}
  }, [t]);

  // Índice: tipo + texto de busca por mensagem (sem acento).
  const indexed = useMemo(() => messages.map((m) => {
    const cm = convMap[String(m.conversation_id)] || {};
    const sender = api.emailToDisplayName(m.sender_name || m.sender_email || '');
    const hay = foldSearch([starredPlainText(m), m.file_name || '', sender, m.sender_email || '', m.conversation_name || '', cm.title || ''].join(' \u0001 '));
    return { m, kind: starredKind(m), hay, d: parseTs(m.created_at) };
  }), [messages, convMap]);

  const counts = useMemo(() => {
    const c = { all: indexed.length };
    for (const x of indexed) c[x.kind] = (c[x.kind] || 0) + 1;
    return c;
  }, [indexed]);

  const q = foldSearch(query.trim());
  const visible = useMemo(() => indexed
    .filter((x) => (filter === 'all' || x.kind === filter) && (!q || x.hay.includes(q)))
    .sort((a, b) => (b.d ? b.d.getTime() : 0) - (a.d ? a.d.getTime() : 0)), [indexed, filter, q]);

  const sections = useMemo(() => {
    const out = [];
    const byKey = new Map();
    for (const x of visible) {
      let key; let meta;
      if (groupBy === 'chat') {
        key = 'c' + String(x.m.conversation_id);
        if (!byKey.has(key)) {
          const cm = convMap[String(x.m.conversation_id)] || {};
          const isGroup = x.m.conversation_type === 'group' || x.m.conversation_type === 'channel' || cm.type === 'group' || cm.type === 'channel';
          const isMine = String(x.m.sender_email || '').toLowerCase() === myEmail;
          const title = (isGroup ? (x.m.conversation_name || cm.title) : (cm.title || (!isMine ? api.emailToDisplayName(x.m.sender_name || x.m.sender_email || '') : x.m.conversation_name)))
            || t('starredPro.byChat', 'Conversa');
          meta = { title, email: isGroup ? null : (cm.peerEmail || (!isMine ? x.m.sender_email : null)), avatar: isGroup ? cm.avatar : '' };
        }
      } else {
        const sd = sectionDay(x.d, t, language);
        key = sd.key;
        if (!byKey.has(key)) meta = { title: sd.label };
      }
      let sec = byKey.get(key);
      if (!sec) { sec = { key, ...meta, data: [] }; byKey.set(key, sec); out.push(sec); }
      sec.data.push(x.m);
    }
    return out;
  }, [visible, groupBy, convMap, myEmail, t, language]);

  const renderItem = useCallback(({ item }) => (
    <StarredRow
      item={item}
      conv={convMap[String(item.conversation_id)]}
      myEmail={myEmail}
      t={t}
      language={language}
      s={s}
      accent={accent}
      byChat={groupBy === 'chat'}
      onOpen={openConversation}
      onUnstar={unstar}
      onCopy={copyText}
    />
  ), [convMap, myEmail, t, language, s, accent, groupBy, openConversation, unstar, copyText]);

  const renderSectionHeader = useCallback(({ section }) => (
    groupBy === 'chat'
      ? <ChatSectionHeader section={section} s={s} />
      : (
        <View style={[styles.dayHead, { backgroundColor: s.bg }]}>
          <Text style={[styles.dayHeadTxt, { color: s.textSecondary }]} accessibilityRole="header">{section.title}</Text>
        </View>
      )
  ), [groupBy, s]);

  const tabAccent = colors.text;
  const tabInactive = colors.textSecondary;
  const tabBarBg = colors.headerBgSolid || colors.surface || colors.background;

  const filterLabel = {
    all: t('starredPro.fAll', 'Tudo'), photo: t('starredPro.fPhotos', 'Fotos'), video: t('starredPro.fVideos', 'Vídeos'),
    link: t('starredPro.fLinks', 'Links'), file: t('starredPro.fFiles', 'Arquivos'), audio: t('starredPro.fAudio', 'Áudio'),
    text: t('starredPro.fText', 'Texto'),
  };
  const chips = STARRED_FILTERS.filter((k) => k === 'all' || counts[k] || k === filter);
  const filtering = !!q || filter !== 'all';

  const toolbar = messages.length ? (
    <View style={[styles.toolbar, { borderBottomColor: s.separator }]}>
      <View style={styles.searchRow}>
        <View style={[styles.search, { backgroundColor: s.fill }]}>
          <IconSearch size={16} color={s.textSecondary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('starredPro.searchPh', 'Buscar nas favoritas')}
            placeholderTextColor={s.textTertiary || s.textSecondary}
            style={[styles.searchInput, { color: s.text }]}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="never"
            accessibilityLabel={t('starredPro.searchPh', 'Buscar nas favoritas')}
          />
          {query ? (
            <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('starredPro.clearSearch', 'Limpar busca')}>
              <View style={[styles.clearDot, { backgroundColor: s.textTertiary || s.textSecondary }]}><IconX size={10} color={s.bg} /></View>
            </Pressable>
          ) : null}
        </View>
        <Pressable
          onPress={() => { try { require('../services/haptics').HapticsCompat.selectionAsync(); } catch {} setGroupBy((g) => (g === 'date' ? 'chat' : 'date')); }}
          accessibilityRole="button"
          accessibilityLabel={groupBy === 'date' ? t('starredPro.groupByChat', 'Agrupar por conversa') : t('starredPro.groupByDate', 'Agrupar por data')}
          style={({ pressed }) => [styles.groupBtn, { backgroundColor: s.fill }, pressed && { opacity: 0.7 }]}
        >
          {groupBy === 'date' ? <IconCalendar size={15} color={s.text} /> : <IconUsers size={15} color={s.text} />}
          <Text style={[styles.groupTxt, { color: s.text }]} numberOfLines={1}>
            {groupBy === 'date' ? t('starredPro.byDate', 'Data') : t('starredPro.byChat', 'Conversa')}
          </Text>
        </Pressable>
      </View>
      {chips.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} accessibilityRole="tablist" keyboardShouldPersistTaps="handled">
          {chips.map((k) => {
            const on = filter === k;
            const n = counts[k] || 0;
            return (
              <Pressable
                key={k}
                onPress={() => { try { require('../services/haptics').HapticsCompat.selectionAsync(); } catch {} setFilter(k); }}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${filterLabel[k]}, ${n}`}
                style={[styles.chip, on ? { backgroundColor: s.ink, borderColor: s.ink } : { borderColor: s.separator }]}
              >
                <Text style={[styles.chipTxt, { color: on ? s.onInk : s.text }]} numberOfLines={1}>{filterLabel[k]}</Text>
                <Text style={[styles.chipN, { color: on ? s.onInk : s.textSecondary }]}>{n}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
    </View>
  ) : null;

  return (
    <View style={[styles.container, { backgroundColor: s.bg, paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }]}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title: t('saved.unifiedTitle'), headerShadowVisible: false })} />
      ) : (
      <View style={[styles.header, { backgroundColor: tabBarBg, paddingTop: 10 }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel={t('common.back', 'Voltar')}>
          <IconArrowLeft size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>{t('saved.unifiedTitle', 'Salvas e favoritas')}</Text>
      </View>
      )}

      {/* Tab switcher — Salvas | Favoritas */}
      <View style={[styles.tabBar, { backgroundColor: tabBarBg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: s.separator }]} accessibilityRole="tablist">
        {[
          { key: 'saved', Icon: IconBookmark, label: t('saved.tabSaved', 'Salvas') },
          { key: 'starred', Icon: IconStar, label: t('saved.tabStarred', 'Favoritas'), count: messages.length },
        ].map((x) => {
          const on = tab === x.key;
          return (
            <Pressable
              key={x.key}
              style={[styles.tab, on && { borderBottomColor: tabAccent }]}
              onPress={() => setTab(x.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
            >
              <x.Icon size={16} color={on ? tabAccent : tabInactive} />
              <Text style={[styles.tabText, { color: on ? tabAccent : tabInactive }]}>{x.label}</Text>
              {x.count ? (
                <View style={[styles.tabCount, { backgroundColor: on ? s.ink : s.fill }]}>
                  <Text style={[styles.tabCountTxt, { color: on ? s.onInk : s.textSecondary }]}>{x.count > 99 ? '99+' : x.count}</Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      <FadeSlideIn style={{ flex: 1 }}>
      {tab === 'saved' ? (
        <EmptyState
          s={s}
          Icon={IconBookmark}
          title={t('chat.savedMessages', 'Mensagens Salvas')}
          body={t('saved.savedExplain', 'Suas anotações pessoais — uma conversa só sua, estilo bloco de notas.')}
          action={(
            <Pressable
              onPress={openSavedMessages}
              accessibilityRole="button"
              style={({ pressed }) => [styles.cta, { backgroundColor: s.ink }, pressed && { opacity: 0.7 }]}
            >
              <Text style={[styles.ctaTxt, { color: s.onInk }]}>{t('saved.openHint', 'Abrir sua conversa de anotações')}</Text>
            </Pressable>
          )}
        />
      ) : loading && !messages.length ? (
        <SkeletonList />
      ) : messages.length === 0 ? (
        <EmptyState
          s={s}
          Icon={IconStar}
          title={t('starred.empty', 'Nenhuma mensagem favorita')}
          body={t('starredV2.emptyHint', 'Toque e segure uma mensagem em qualquer conversa e escolha Favoritar. Ela aparece aqui para você achar depois.')}
        />
      ) : (
        <View style={{ flex: 1 }}>
          {toolbar}
          <SectionList
            sections={sections}
            keyExtractor={(m) => String(m.id)}
            renderItem={renderItem}
            renderSectionHeader={renderSectionHeader}
            stickySectionHeadersEnabled
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={{ paddingBottom: insets.bottom + 24, flexGrow: 1 }}
            initialNumToRender={14}
            windowSize={9}
            refreshControl={<UIRefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={s.textSecondary} />}
            ListEmptyComponent={filtering ? (
              <EmptyState
                s={s}
                Icon={IconSearch}
                title={t('starredPro.noResults', 'Nada encontrado')}
                body={q
                  ? t('starredPro.noResultsQuery', 'Nenhuma favorita com “{q}”.').replace('{q}', query.trim())
                  : t('starredPro.noResultsFilter', 'Nenhuma favorita deste tipo.')}
                action={(
                  <Pressable
                    onPress={() => { setQuery(''); setFilter('all'); }}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.ctaOutline, { borderColor: s.separator }, pressed && { opacity: 0.7 }]}
                  >
                    <Text style={[styles.ctaOutlineTxt, { color: s.text }]}>{t('starredPro.clearFilters', 'Limpar filtros')}</Text>
                  </Pressable>
                )}
              />
            ) : null}
            ListFooterComponent={visible.length > 6 ? (
              <Text style={[styles.footer, { color: s.textSecondary }]}>
                {t('starredPro.footerHint', 'Segure ou deslize uma mensagem para remover das favoritas.')}
              </Text>
            ) : null}
          />
        </View>
      )}
      </FadeSlideIn>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 14 },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 20, fontWeight: '700', marginLeft: 8 },
  tabBar: { flexDirection: 'row', paddingHorizontal: 12 },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabText: { fontSize: 15, fontWeight: '600' },
  tabCount: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
  tabCountTxt: { fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  toolbar: { paddingTop: 10, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, gap: 10 },
  searchRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8 },
  search: { flex: 1, height: 38, borderRadius: 19, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8 },
  searchInput: { flex: 1, fontSize: 16, paddingVertical: 0, ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }) },
  clearDot: { width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  groupBtn: { height: 38, borderRadius: 19, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6 },
  groupTxt: { fontSize: 14, fontWeight: '600' },
  chips: { paddingHorizontal: 16, gap: 8 },
  chip: { height: 32, borderRadius: 16, borderWidth: 1, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6 },
  chipTxt: { fontSize: 14, fontWeight: '600' },
  chipN: { fontSize: 12.5, fontWeight: '600', fontVariant: ['tabular-nums'] },
  dayHead: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 },
  dayHeadTxt: { fontSize: 13, fontWeight: '600', letterSpacing: 0.2 },
  chatHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  chatHeadTxt: { flex: 1, fontSize: 15, fontWeight: '700', letterSpacing: -0.2 },
  chatHeadCount: { fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  skRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 36, paddingVertical: 60 },
  emptyIcon: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  emptyTitle: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3, textAlign: 'center' },
  emptySubtitle: { fontSize: 15, lineHeight: 21, textAlign: 'center', marginTop: 8, maxWidth: 320 },
  cta: { marginTop: 22, height: 46, borderRadius: 23, paddingHorizontal: 22, alignItems: 'center', justifyContent: 'center' },
  ctaTxt: { fontSize: 16, fontWeight: '600' },
  ctaOutline: { marginTop: 20, height: 40, borderRadius: 20, paddingHorizontal: 20, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  ctaOutlineTxt: { fontSize: 15, fontWeight: '600' },
  row: { flexDirection: 'row', paddingVertical: 11, paddingHorizontal: 16, alignItems: 'center' },
  rowBody: { flex: 1, minWidth: 0, marginLeft: 12 },
  rowHead: { flexDirection: 'row', alignItems: 'center' },
  rowName: { fontSize: 16, fontWeight: '600', flex: 1, letterSpacing: -0.2 },
  rowTime: { fontSize: 13, marginLeft: 8, fontVariant: ['tabular-nums'] },
  rowContent: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 },
  rowWho: { fontSize: 14, fontWeight: '500', flexShrink: 0, maxWidth: '40%' },
  rowPreview: { fontSize: 14, flex: 1, lineHeight: 19 },
  linkChip: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6, height: 24, borderRadius: 12, paddingHorizontal: 9, maxWidth: '100%' },
  linkHost: { fontSize: 12.5, fontWeight: '600', flexShrink: 1 },
  thumb: { width: 52, height: 52, borderRadius: 10, marginLeft: 10, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  playWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  playDot: { width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', paddingLeft: 2 },
  durBadge: { position: 'absolute', right: 4, bottom: 3, fontSize: 10, fontWeight: '700', color: '#FFFFFF', textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 3, fontVariant: ['tabular-nums'] },
  sep: { position: 'absolute', left: 74, right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
  swipeAct: { width: 104, alignItems: 'center', justifyContent: 'center', gap: 4 },
  swipeTxt: { fontSize: 12, fontWeight: '600' },
  footer: { fontSize: 13, textAlign: 'center', paddingHorizontal: 32, paddingTop: 18, lineHeight: 18 },
});
