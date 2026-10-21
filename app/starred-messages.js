import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../components/nativeHeader'; // [2026-10-09 more-native]
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import {
  IconArrowLeft, IconStar, IconStarFilled, IconBookmark, IconArrowRight, IconImage, IconVideo, IconMic,
  IconFileText, IconMapPin, IconUser, IconBarChart, IconSmile, IconPhone, IconLock, IconCopy, IconMessageSquare,
} from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';
import FadeSlideIn from '../components/FadeSlideIn';
import PressableRow from '../components/PressableRow';
import { Sheet, ActionList, showToast, useSurface } from '../components/ui';
import * as api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { regionalLocale } from '../utils/dateFormat';

let NativeSwipeable = null;
if (Platform.OS !== 'web') {
  try { NativeSwipeable = require('react-native-gesture-handler').Swipeable; } catch {}
}
let ExpoImage = null;
try { ExpoImage = require('expo-image').Image; } catch {}

// Unified "Salvas | Favoritas" screen (E.3).
//
// These are two genuinely different concepts, so neither is destroyed:
//   - Salvas    = your Telegram-style self-chat ("Mensagens Salvas"). Lives in
//                 a real conversation; opening it routes to /saved-messages.
//   - Favoritas = individual starred messages bookmarked across any chat
//                 (chat_starred_messages).
//
// [2026-10-19 favoritas-wa] Print do founder: "Você › Fulano" com a SUA foto,
// estrela solta e prévia VAZIA em foto/áudio, datas em inglês ("Sat",
// "5/26/2026"). Agora (JS, sem build):
//   • avatar = da CONVERSA (contato no 1:1, foto do grupo) — nunca a sua;
//   • linha 1 = nome da conversa + data localizada (hoje = hora, "Ontem",
//     "sáb.", "26/05/2026"); linha 2 = "Você:"/"Ana:" + prévia com ícone
//     (Foto / Vídeo / Áudio 0:12 / Documento / Localização / Contato / Enquete /
//     Figurinha / GIF), miniatura da foto à direita;
//   • toque = abre a conversa NA mensagem (scrollToMessageId + highlight);
//   • deslizar ← "Desfavoritar"; segurar = folha (Ir para a mensagem, Copiar,
//     Desfavoritar);
//   • estados vazios de verdade nas 2 abas.

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
  s = s.replace(/([+-]\d{2})$/, '$1:00');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s += 'Z';
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function formatWhen(v, t, language) {
  const d = parseTs(v);
  if (!d) return '';
  const lang = String(language || 'pt-BR');
  const base = lang.slice(0, 2).toLowerCase();
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const ts = d.getTime();
  if (ts >= startToday) {
    if (base === 'en') { try { return d.toLocaleTimeString(regionalLocale(lang) || 'en-US', { hour: 'numeric', minute: '2-digit' }); } catch {} }
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  if (ts >= startToday - 86400000) return t('common.yesterday', 'Ontem');
  if (ts >= startToday - 6 * 86400000) {
    const arr = WEEKDAYS[base];
    if (arr) return arr[d.getDay()];
    try { return d.toLocaleDateString(regionalLocale(lang), { weekday: 'short' }); } catch { return ''; }
  }
  if (base === 'en') {
    try { return d.toLocaleDateString(regionalLocale(lang) || 'en-US', { day: 'numeric', month: 'numeric', year: 'numeric' }); } catch {}
  }
  if (base === 'pt' || base === 'es' || base === 'fr' || base === 'it') return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  try { return d.toLocaleDateString(regionalLocale(lang), { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch { return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`; }
}

function fmtDur(sec) {
  const n = Math.round(Number(sec) || 0);
  if (!(n > 0)) return '';
  return `${Math.floor(n / 60)}:${pad2(n % 60)}`;
}

const FILE_LIKE = /\.(jpe?g|png|gif|webp|heic|heif|bmp|mp4|mov|m4v|webm|avif|mp3|m4a|ogg|opus|wav|aac)$/i;
function isFileNameLike(s) {
  const v = String(s || '').trim();
  if (!v) return false;
  if (/^https?:\/\//i.test(v)) return true;
  if (FILE_LIKE.test(v)) return true;
  return !/\s/.test(v) && v.length > 14 && /[_\-/\d]/.test(v);
}

// Mensagem favorita → { Icon, text, thumb, copyText }
function describeMessage(m, t) {
  const type = String(m.type || m.message_type || 'text');
  let content = typeof m.content === 'string' ? m.content : '';
  let parsed = null;
  const trimmed = content.trim();
  if (trimmed.startsWith('{')) { try { parsed = JSON.parse(trimmed); } catch {} }
  const plain = parsed ? '' : trimmed;
  const caption = (parsed && typeof parsed.caption === 'string' && parsed.caption.trim()) || (plain && !isFileNameLike(plain) ? plain : '');
  const L = (k, fb) => { const v = t(k); return v && v !== k ? v : fb; };

  if (parsed && parsed.e2e) {
    let pk = null;
    try { pk = require('../services/e2eeV4').peekPlaintext(content); } catch {}
    try { if (pk == null) { const _e5 = require('../services/e2ee/e2ee5').peek(content); if (_e5) pk = _e5.text; } } catch {} // [e2ee5] texto já decifrado neste aparelho
    return pk != null ? { text: pk, copyText: pk } : { Icon: IconLock, text: L('e2ee.listPreview', 'Mensagem criptografada') };
  }
  if (type === 'image') {
    const url = m.file_url ? api.getMediaUrl(m.file_url) : '';
    return { Icon: IconImage, text: caption || L('chat.photo', 'Foto'), thumb: url || null, copyText: caption };
  }
  if (type === 'video') return { Icon: IconVideo, text: caption || L('chat.video', 'Vídeo'), copyText: caption };
  if (type === 'audio' || type === 'voice') {
    const dur = fmtDur(m.duration || (parsed && parsed.duration));
    return { Icon: IconMic, text: dur ? `${L('chat.audio', 'Áudio')} ${dur}` : L('chat.audio', 'Áudio') };
  }
  if (type === 'file' || type === 'document') {
    const name = m.file_name && !/^(blob|file)$/i.test(m.file_name) ? m.file_name : '';
    return { Icon: IconFileText, text: name || L('starredV2.document', 'Documento'), copyText: caption };
  }
  if (type === 'sticker' || type === 'lottie_sticker') return { Icon: IconSmile, text: L('chat.sticker', 'Figurinha') };
  if (type === 'gif') return { Icon: IconImage, text: caption || 'GIF' };
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
    const txt = [parsed.text, parsed.body, parsed.caption, parsed.message, typeof parsed.content === 'string' ? parsed.content : '']
      .find((x) => typeof x === 'string' && x.trim() && !x.trim().startsWith('{'));
    if (txt) return { text: txt.trim(), copyText: txt.trim() };
    if (parsed.file_url || parsed.media_url || parsed.url) return { Icon: IconFileText, text: L('chat.attachment', 'Anexo') };
    return { Icon: IconMessageSquare, text: L('chat.message', 'Mensagem') };
  }
  if (m.file_url && !plain) return { Icon: IconFileText, text: m.file_name || L('chat.attachment', 'Anexo') };
  if (/^https?:\/\/(media[0-9]*\.)?(tenor|giphy)\.com\//i.test(plain)) return { Icon: IconImage, text: 'GIF' };
  return { text: plain || L('chat.message', 'Mensagem'), copyText: plain };
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

const StarredRow = React.memo(function StarredRow({ item, conv, myEmail, t, language, s, onOpen, onMenu, onUnstar }) {
  const swipeRef = useRef(null);
  const isMine = String(item.sender_email || '').toLowerCase() === myEmail;
  const isGroup = item.conversation_type === 'group' || conv?.type === 'group' || conv?.type === 'channel';
  const senderName = isMine ? (t('chat.you', 'Você')) : api.emailToDisplayName(item.sender_name || item.sender_email || '');
  // Título = conversa (1:1: o contato; grupo: o nome do grupo).
  const title = isGroup
    ? (item.conversation_name || conv?.title || senderName)
    : (conv?.title || (isMine ? (item.conversation_name || '') : senderName) || senderName);
  const peerEmail = isGroup ? null : (conv?.peerEmail || (isMine ? '' : item.sender_email) || null);
  const showWho = isMine || isGroup;
  const d = describeMessage(item, t);
  const when = formatWhen(item.created_at, t, language);
  const Ic = d.Icon;

  const row = (
    <PressableRow
      onPress={() => onOpen(item)}
      onLongPress={() => onMenu(item, d)}
      delayLongPress={350}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${showWho ? senderName + ': ' : ''}${d.text}. ${when}`}
      accessibilityHint={t('starredV2.openHint', 'Abre a conversa nesta mensagem')}
      style={{ backgroundColor: s.bg }}
    >
      <View style={styles.row}>
        <AvatarCircle
          name={title}
          email={peerEmail || null}
          uri={isGroup ? (conv?.avatar || undefined) : undefined}
          size={48}
        />
        <View style={styles.rowBody}>
          <View style={styles.rowHead}>
            <Text style={[styles.rowName, { color: s.text }]} numberOfLines={1}>{title}</Text>
            <Text style={[styles.rowTime, { color: s.textSecondary }]} numberOfLines={1}>{when}</Text>
          </View>
          <View style={styles.rowContent}>
            <IconStarFilled size={12} color={s.textSecondary} />
            {showWho ? <Text style={[styles.rowWho, { color: s.text }]} numberOfLines={1}>{senderName}:</Text> : null}
            {Ic ? <Ic size={14} color={s.textSecondary} /> : null}
            <Text style={[styles.rowPreview, { color: s.textSecondary }]} numberOfLines={2}>{d.text}</Text>
          </View>
        </View>
        {d.thumb && ExpoImage ? (
          <ExpoImage source={{ uri: d.thumb }} style={[styles.thumb, { backgroundColor: s.fill }]} contentFit="cover" recyclingKey={String(item.id)} transition={120} />
        ) : null}
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

export default function StarredMessagesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const s = useSurface();
  const { t, language } = useLanguage();
  const { user } = useAuth() || {};
  const myEmail = String(user?.email || '').toLowerCase();
  // [2026-10-11 qa-sweep2] conversation_id → { title, peerEmail, type, avatar }.
  // The starred API only carries conversation_name for groups.
  const [convMap, setConvMap] = useState({});

  const [tab, setTab] = useState('starred'); // 'saved' | 'starred'
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [menu, setMenu] = useState(null); // { item, d }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, cv] = await Promise.all([
        api.chatStarredMessages(),
        api.chatConversations().catch(() => null),
      ]);
      if (r?.success && r.data) {
        const list = Array.isArray(r.data) ? r.data : (r.data.items || r.data.messages || []);
        setMessages(list);
      }
      const convs = Array.isArray(cv?.data) ? cv.data : (Array.isArray(cv?.data?.conversations) ? cv.data.conversations : []);
      if (convs.length) {
        const m = {};
        for (const c of convs) {
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
        setConvMap(m);
      }
    } catch (e) { console.warn('[starred] load:', e); }
    setLoading(false);
  }, [myEmail]);

  useEffect(() => { load(); }, [load]);

  const openSavedMessages = useCallback(() => {
    try { router.push('/saved-messages'); } catch (e) { console.warn('[starred] saved nav:', e); }
  }, [router]);

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

  const unstar = useCallback(async (msg) => {
    if (!msg || msg.id == null) return;
    setMessages((prev) => prev.filter((m) => String(m.id) !== String(msg.id)));
    try {
      const r = await api.chatStarMessage(msg.id, false);
      if (r && r.success === false) throw new Error(r.message || '');
      showToast({ message: t('starredV2.removed', 'Removida das favoritas') });
    } catch {
      setMessages((prev) => (prev.some((m) => String(m.id) === String(msg.id)) ? prev : [msg, ...prev]));
    }
  }, [t]);

  const openMenu = useCallback((item, d) => {
    try { require('../services/haptics').HapticsCompat.selectionAsync(); } catch {}
    setMenu({ item, d });
  }, []);

  const copyText = useCallback(async (text) => {
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) await navigator.clipboard.writeText(text);
      else await require('expo-clipboard').setStringAsync(text);
      showToast({ message: t('common.copied', 'Copiado') });
    } catch {}
  }, [t]);

  const sorted = useMemo(() => messages, [messages]);

  const renderItem = useCallback(({ item }) => (
    <StarredRow
      item={item}
      conv={convMap[String(item.conversation_id)]}
      myEmail={myEmail}
      t={t}
      language={language}
      s={s}
      onOpen={openConversation}
      onMenu={openMenu}
      onUnstar={unstar}
    />
  ), [convMap, myEmail, t, language, s, openConversation, openMenu, unstar]);

  // [2026-10-09 more-native] Com header nativo (fundo = superfície do tema) as
  // abas seguem a mesma superfície (texto/hairline), sem a faixa preta fixa.
  const tabAccent = colors.text;
  const tabInactive = colors.textSecondary;
  const tabBarBg = colors.headerBgSolid || colors.surface || colors.background;

  const menuItems = menu ? [
    { key: 'go', label: t('starredV2.goToMessage', 'Ir para a mensagem'), icon: IconArrowRight, onPress: () => openConversation(menu.item) },
    ...(menu.d?.copyText ? [{ key: 'copy', label: t('common.copy', 'Copiar'), icon: IconCopy, onPress: () => copyText(menu.d.copyText) }] : []),
    { key: 'unstar', label: t('chat.unstar', 'Desfavoritar'), icon: IconStar, destructive: true, onPress: () => unstar(menu.item) },
  ] : [];

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
        <View style={styles.loading}>
          <ActivityIndicator color={s.textSecondary} />
        </View>
      ) : messages.length === 0 ? (
        <EmptyState
          s={s}
          Icon={IconStar}
          title={t('starred.empty', 'Nenhuma mensagem favorita')}
          body={t('starredV2.emptyHint', 'Toque e segure uma mensagem em qualquer conversa e escolha Favoritar. Ela aparece aqui para você achar depois.')}
        />
      ) : (
        <FlatList
          data={sorted}
          keyExtractor={(m) => String(m.id)}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          initialNumToRender={14}
          windowSize={9}
          onRefresh={load}
          refreshing={false}
          ListHeaderComponent={(
            <Text style={[styles.paneExplain, { color: s.textSecondary }]}>
              {t('starredV2.explain', 'Mensagens marcadas com estrela em qualquer conversa. Deslize para a esquerda para remover.')}
            </Text>
          )}
        />
      )}
      </FadeSlideIn>

      <Sheet visible={!!menu} onClose={() => setMenu(null)} title={menu?.d?.text ? String(menu.d.text).slice(0, 80) : undefined}>
        <ActionList onDone={() => setMenu(null)} items={menuItems} />
      </Sheet>
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
  paneExplain: { fontSize: 13, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6, lineHeight: 18 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 36, paddingBottom: 60 },
  emptyIcon: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  emptyTitle: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3, textAlign: 'center' },
  emptySubtitle: { fontSize: 15, lineHeight: 21, textAlign: 'center', marginTop: 8, maxWidth: 320 },
  cta: { marginTop: 22, height: 46, borderRadius: 23, paddingHorizontal: 22, alignItems: 'center', justifyContent: 'center' },
  ctaTxt: { fontSize: 16, fontWeight: '600' },
  row: { flexDirection: 'row', paddingVertical: 11, paddingHorizontal: 16, alignItems: 'center' },
  rowBody: { flex: 1, minWidth: 0, marginLeft: 12 },
  rowHead: { flexDirection: 'row', alignItems: 'center' },
  rowName: { fontSize: 16, fontWeight: '600', flex: 1, letterSpacing: -0.2 },
  rowTime: { fontSize: 13, marginLeft: 8, fontVariant: ['tabular-nums'] },
  rowContent: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 },
  rowWho: { fontSize: 14, fontWeight: '500', flexShrink: 0, maxWidth: '40%' },
  rowPreview: { fontSize: 14, flex: 1, lineHeight: 19 },
  thumb: { width: 46, height: 46, borderRadius: 8, marginLeft: 10 },
  sep: { position: 'absolute', left: 76, right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
  swipeAct: { width: 104, alignItems: 'center', justifyContent: 'center', gap: 4 },
  swipeTxt: { fontSize: 12, fontWeight: '600' },
});
