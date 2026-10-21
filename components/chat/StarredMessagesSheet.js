// [2026-10-21 favoritas-folha] "Mensagens favoritas" aberta da conversa / Dados
// do contato / Info do grupo. Print do founder: linha crua "★ duarte / [image] /
// 23:58" com estrela laranja num folhão vazio. Agora nível WhatsApp/Telegram,
// tema Grafite (constants/theme.js), 100% JS (OTA):
//   • cabeçalho com contador + fechar; dica "toque p/ ir · deslize p/ remover";
//   • item = avatar + nome de exibição ("Você" nas próprias; contato/membro em
//     vez do usuário cru do e-mail) + data relativa (Hoje/Ontem/dd/mm) e hora;
//   • prévia de verdade: texto até 3 linhas; foto/vídeo/GIF com miniatura
//     (thumb/t320/poster/image_variants via lastMediaThumb); áudio c/ duração;
//     arquivo c/ nome e tamanho; figurinha desenhada; localização, contato,
//     enquete, chamada, criptografada — NUNCA "[image]";
//   • toque → fecha a folha e pula para a mensagem (dono: safeScrollToMsg /
//     load_around); segurar ou deslizar ← = desfavoritar com "Desfazer" na
//     própria folha (nada de Modal/Toast por cima da folha nativa);
//   • vazio/carregando bonitos (ícone SVG), estrela SVG grafite, sem emoji.
// A altura inicial vem de starredSheetDetents(n) (detent médio proporcional ao
// conteúdo; arrastar expande até a tela cheia).
// Textos novos: dicionário local pt/en/es (sem mexer nos pacotes i18n).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, FlatList, StyleSheet, Platform, Animated } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { grafite, cardShadow } from '../../constants/theme';
import AvatarCircle from '../AvatarCircle';
import * as api from '../../services/api';
import {
  IconStar, IconStarFilled, IconX, IconImage, IconVideo, IconMic, IconFileText, IconMapPin,
  IconUser, IconBarChart, IconSmile, IconPhone, IconLock, IconMessageSquare, IconPlay,
} from '../Icons';
import { lastMediaThumb } from '../chatlist/listVivoData';

let ExpoImage = null;
try { ExpoImage = require('expo-image').Image; } catch {}
let GH = null;
if (Platform.OS !== 'web') {
  try { GH = require('react-native-gesture-handler'); } catch { GH = null; }
}

const STR = {
  pt: {
    title: 'Mensagens favoritas', hint: 'Toque para ir à mensagem. Segure ou deslize para remover.',
    you: 'Você', today: 'Hoje', yesterday: 'Ontem', unstar: 'Desfavoritar', removed: 'Removida das favoritas',
    undo: 'Desfazer', emptyTitle: 'Nenhuma mensagem favorita',
    emptyBody: 'Toque e segure uma mensagem nesta conversa e escolha Favoritar. Ela aparece aqui para você achar depois.',
    photo: 'Foto', video: 'Vídeo', gif: 'GIF', audio: 'Áudio', voice: 'Mensagem de voz', doc: 'Documento', sticker: 'Figurinha',
    location: 'Localização', liveLocation: 'Localização ao vivo', contact: 'Contato', poll: 'Enquete',
    voiceCall: 'Chamada de voz', videoCall: 'Chamada de vídeo', encrypted: 'Mensagem criptografada',
    message: 'Mensagem', attachment: 'Anexo', viewOnce: 'Visualização única', close: 'Fechar', openHint: 'Abre a conversa nesta mensagem',
  },
  en: {
    title: 'Starred messages', hint: 'Tap to jump to the message. Hold or swipe to remove.',
    you: 'You', today: 'Today', yesterday: 'Yesterday', unstar: 'Unstar', removed: 'Removed from starred',
    undo: 'Undo', emptyTitle: 'No starred messages',
    emptyBody: 'Tap and hold a message in this chat and choose Star. It shows up here so you can find it later.',
    photo: 'Photo', video: 'Video', gif: 'GIF', audio: 'Audio', voice: 'Voice message', doc: 'Document', sticker: 'Sticker',
    location: 'Location', liveLocation: 'Live location', contact: 'Contact', poll: 'Poll',
    voiceCall: 'Voice call', videoCall: 'Video call', encrypted: 'Encrypted message',
    message: 'Message', attachment: 'Attachment', viewOnce: 'View once', close: 'Close', openHint: 'Opens the chat at this message',
  },
  es: {
    title: 'Mensajes destacados', hint: 'Toca para ir al mensaje. Mantén pulsado o desliza para quitarlo.',
    you: 'Tú', today: 'Hoy', yesterday: 'Ayer', unstar: 'Quitar destacado', removed: 'Quitado de destacados',
    undo: 'Deshacer', emptyTitle: 'No hay mensajes destacados',
    emptyBody: 'Mantén pulsado un mensaje en este chat y elige Destacar. Aparecerá aquí para que lo encuentres después.',
    photo: 'Foto', video: 'Video', gif: 'GIF', audio: 'Audio', voice: 'Mensaje de voz', doc: 'Documento', sticker: 'Sticker',
    location: 'Ubicación', liveLocation: 'Ubicación en tiempo real', contact: 'Contacto', poll: 'Encuesta',
    voiceCall: 'Llamada de voz', videoCall: 'Videollamada', encrypted: 'Mensaje cifrado',
    message: 'Mensaje', attachment: 'Adjunto', viewOnce: 'Ver una vez', close: 'Cerrar', openHint: 'Abre el chat en este mensaje',
  },
};
function _strs(language) {
  const b = String(language || 'pt').slice(0, 2).toLowerCase();
  return STR[b] || (b === 'pt' ? STR.pt : STR.en);
}

// Altura inicial proporcional ao conteúdo (fração da tela); 2º detent = tela cheia.
const HEADER_EST = 112;
const ROW_EST = 92;
export function starredSheetDetents(count, winH) {
  const H = Number(winH) > 0 ? Number(winH) : 800;
  const n = Math.max(0, Number(count) || 0);
  const est = n === 0 ? 380 : HEADER_EST + Math.min(n, 6) * ROW_EST + 24;
  const f = Math.max(0.4, Math.min(0.62, est / H));
  return [Math.round(f * 100) / 100, 1];
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }
function parseTs(v) {
  if (!v) return null;
  try {
    if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
    const d = api.parseServerDate ? api.parseServerDate(v) : new Date(v);
    return d && !isNaN(d.getTime()) ? d : null;
  } catch { return null; }
}
function fmtClock(d, language) {
  const b = String(language || '').slice(0, 2).toLowerCase();
  if (b === 'en') {
    try { return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); } catch {}
  }
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
export function formatStarredWhen(v, S, language) {
  const d = parseTs(v);
  if (!d) return '';
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const ts = d.getTime();
  const clock = fmtClock(d, language);
  let day;
  if (ts >= start) day = S.today;
  else if (ts >= start - 86400000) day = S.yesterday;
  else {
    const en = String(language || '').slice(0, 2).toLowerCase() === 'en';
    const dm = en ? `${d.getMonth() + 1}/${d.getDate()}` : `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
    day = d.getFullYear() === now.getFullYear() ? dm : `${dm}/${String(d.getFullYear()).slice(-2)}`;
  }
  return `${day} · ${clock}`;
}

function fmtDur(v) {
  let n = Number(v) || 0;
  if (n > 36000) n = n / 1000; // ms
  n = Math.round(n);
  if (!(n > 0)) return '';
  return `${Math.floor(n / 60)}:${pad2(n % 60)}`;
}
function fmtSize(b) {
  const n = Number(b) || 0;
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
const FILE_LIKE = /\.(jpe?g|png|gif|webp|heic|heif|bmp|mp4|mov|m4v|webm|avif|mp3|m4a|ogg|opus|wav|aac|caf)$/i;
function isFileNameLike(s) {
  const v = String(s || '').trim();
  if (!v) return false;
  if (/^https?:\/\//i.test(v) || /^\/data\//.test(v)) return true;
  if (FILE_LIKE.test(v)) return true;
  if (/^\[[a-z_]+\]/i.test(v)) return true; // "[image]" / "[audio] x.m4a"
  return !/\s/.test(v) && v.length > 14 && /[_\-/\d]/.test(v);
}
function absUrl(u) {
  if (!u || typeof u !== 'string') return '';
  if (/^(file|content|ph|data|blob):/i.test(u)) return u;
  try { return api.getMediaUrl(u) || u; } catch { return u; }
}

/**
 * Mensagem favorita → { kind, Icon, label, text, thumb, sticker, play, dur }
 *   kind 'text' → text (até 3 linhas); senão linha c/ ícone + label (+ legenda).
 */
export function describeStarred(m, S) {
  const type = String(m.type || m.message_type || 'text');
  const content = typeof m.content === 'string' ? m.content : '';
  const trimmed = content.trim();
  let parsed = null;
  if (trimmed.startsWith('{')) { try { parsed = JSON.parse(trimmed); } catch {} }
  const plain = parsed ? '' : trimmed;
  const caption = (typeof m.caption === 'string' && m.caption.trim())
    || (parsed && typeof parsed.caption === 'string' && parsed.caption.trim())
    || (plain && !isFileNameLike(plain) ? plain : '');

  if (parsed && parsed.e2e) {
    let pk = null;
    try { pk = require('../../services/e2eeV4').peekPlaintext(content); } catch {}
    return pk != null ? { kind: 'text', text: String(pk) } : { kind: 'row', Icon: IconLock, label: S.encrypted };
  }
  const viewOnce = !!(m.is_view_once || m.view_once || (parsed && parsed.view_once));
  if (type === 'image' || type === 'video') {
    const isVid = type === 'video';
    if (viewOnce) return { kind: 'row', Icon: isVid ? IconVideo : IconImage, label: `${isVid ? S.video : S.photo} · ${S.viewOnce}` };
    let thumb = '';
    try { thumb = lastMediaThumb(m) || ''; } catch { thumb = ''; }
    const dur = isVid ? fmtDur(m.duration || m.video_duration || (parsed && parsed.duration)) : '';
    return { kind: 'media', Icon: isVid ? IconVideo : IconImage, label: isVid ? S.video : S.photo, text: caption, thumb, play: isVid, dur };
  }
  if (type === 'gif' || /^https?:\/\/(media[0-9]*\.)?(tenor|giphy)\.com\//i.test(plain)) {
    const u = m.file_url || (parsed && (parsed.url || parsed.gif_url)) || (/^https?:/i.test(plain) ? plain : '');
    return { kind: 'media', Icon: IconImage, label: S.gif, text: type === 'gif' ? caption : '', thumb: absUrl(u) };
  }
  if (type === 'audio' || type === 'voice' || type === 'ptt') {
    const dur = fmtDur(m.duration || m.audio_duration || (parsed && parsed.duration));
    const isVoice = type === 'voice' || type === 'ptt' || !!(m.is_voice || (parsed && parsed.voice));
    return { kind: 'row', Icon: IconMic, label: isVoice ? S.voice : S.audio, meta: dur };
  }
  if (type === 'file' || type === 'document') {
    const name = m.file_name && !/^(blob|file)$/i.test(m.file_name) ? m.file_name : '';
    return { kind: 'row', Icon: IconFileText, label: name || S.doc, meta: fmtSize(m.file_size), text: caption };
  }
  if (type === 'sticker' || type === 'lottie_sticker') {
    const u = m.file_url || (parsed && (parsed.url || parsed.file_url || parsed.png || parsed.thumb)) || '';
    const isLottie = type === 'lottie_sticker' || /\.(json|lottie|tgs)(\?|$)/i.test(String(u));
    return isLottie || !u ? { kind: 'row', Icon: IconSmile, label: S.sticker } : { kind: 'sticker', label: S.sticker, sticker: absUrl(u) };
  }
  if (type === 'location' || type === 'live_location' || (parsed && typeof parsed.latitude === 'number')) {
    const live = type === 'live_location' || !!(parsed && parsed.live);
    const nm = parsed && (parsed.name || parsed.address || parsed.label);
    return { kind: 'row', Icon: IconMapPin, label: live ? S.liveLocation : S.location, text: typeof nm === 'string' ? nm : '' };
  }
  if (type === 'contact' || (parsed && parsed.type === 'contact')) {
    let lbl = '';
    try { lbl = require('./contactShare').contactPreviewLabel(parsed || {}, S._t || ((k, f) => f || '')); } catch {}
    return { kind: 'row', Icon: IconUser, label: lbl || S.contact };
  }
  if (type === 'poll' || (parsed && typeof parsed.question === 'string' && Array.isArray(parsed.options))) {
    const q = parsed && typeof parsed.question === 'string' ? parsed.question.trim() : '';
    return { kind: 'row', Icon: IconBarChart, label: S.poll, text: q };
  }
  if (type === 'call_card' || (parsed && (parsed.call_id || parsed.call_type !== undefined))) {
    const vid = !!(parsed && (parsed.video || parsed.call_type === 'video'));
    return { kind: 'row', Icon: vid ? IconVideo : IconPhone, label: vid ? S.videoCall : S.voiceCall };
  }
  if (parsed) {
    const txt = [parsed.text, parsed.body, parsed.caption, parsed.message, typeof parsed.content === 'string' ? parsed.content : '']
      .find((x) => typeof x === 'string' && x.trim() && !x.trim().startsWith('{'));
    if (txt) return { kind: 'text', text: txt.trim() };
    if (parsed.file_url || parsed.media_url || parsed.url) return { kind: 'row', Icon: IconFileText, label: S.attachment };
    return { kind: 'row', Icon: IconMessageSquare, label: S.message };
  }
  if (m.file_url && (!plain || isFileNameLike(plain))) return { kind: 'row', Icon: IconFileText, label: m.file_name || S.attachment };
  if (plain && !/^\[[a-z_]+\]$/i.test(plain)) return { kind: 'text', text: plain };
  return { kind: 'row', Icon: IconMessageSquare, label: S.message };
}

function SkeletonRow({ g }) {
  return (
    <View style={[st.row, { backgroundColor: g.surface }]}>
      <View style={[st.skAv, { backgroundColor: g.surface2 }]} />
      <View style={{ flex: 1, marginLeft: 12 }}>
        <View style={[st.skLine, { width: '42%', backgroundColor: g.surface2 }]} />
        <View style={[st.skLine, { width: '78%', marginTop: 10, backgroundColor: g.surface2 }]} />
      </View>
    </View>
  );
}

function Preview({ d, g }) {
  if (d.kind === 'text') {
    return <Text style={[st.text, { color: g.text }]} numberOfLines={3}>{d.text}</Text>;
  }
  if (d.kind === 'sticker' && d.sticker && ExpoImage) {
    return <ExpoImage source={{ uri: d.sticker }} style={st.sticker} contentFit="contain" transition={120} accessibilityLabel={d.label} />;
  }
  if (d.kind === 'media') {
    const Ic = d.Icon;
    return (
      <View style={st.mediaRow}>
        <View style={[st.thumb, { backgroundColor: g.surface2 }]}>
          {d.thumb && ExpoImage ? (
            <ExpoImage source={{ uri: d.thumb }} style={StyleSheet.absoluteFill} contentFit="cover" transition={120} />
          ) : <Ic size={22} color={g.muted} />}
          {d.play ? (
            <View style={st.playWrap}><View style={st.playDot}><IconPlay size={12} color="#FFFFFF" /></View></View>
          ) : null}
          {d.dur ? <Text style={st.durBadge}>{d.dur}</Text> : null}
        </View>
        <View style={{ flex: 1, minWidth: 0, marginLeft: 10 }}>
          <View style={st.labelRow}>
            <Ic size={14} color={g.muted} />
            <Text style={[st.label, { color: g.text2 }]} numberOfLines={1}>{d.label}</Text>
          </View>
          {d.text ? <Text style={[st.caption, { color: g.text }]} numberOfLines={2}>{d.text}</Text> : null}
        </View>
      </View>
    );
  }
  const Ic = d.Icon || IconMessageSquare;
  return (
    <View>
      <View style={st.labelRow}>
        <View style={[st.chipIcon, { backgroundColor: g.surface2 }]}><Ic size={15} color={g.text2} /></View>
        <Text style={[st.label, { color: g.text, flexShrink: 1 }]} numberOfLines={1}>{d.label}</Text>
        {d.meta ? <Text style={[st.meta, { color: g.muted }]} numberOfLines={1}>{d.meta}</Text> : null}
      </View>
      {d.text ? <Text style={[st.caption, { color: g.text, marginTop: 4 }]} numberOfLines={2}>{d.text}</Text> : null}
    </View>
  );
}

const StarredItem = React.memo(function StarredItem({ item, local, who, g, S, language, onOpen, onUnstar, first, last }) {
  const swipeRef = useRef(null);
  const m = local ? { ...item, ...local, id: item.id, conversation_id: item.conversation_id } : item;
  const d = describeStarred(m, S);
  const when = formatStarredWhen(item.created_at || m.created_at, S, language);
  const preview = d.kind === 'text' ? d.text : [d.label, d.meta, d.text].filter(Boolean).join(', ');
  const radius = { borderTopLeftRadius: first ? 18 : 0, borderTopRightRadius: first ? 18 : 0, borderBottomLeftRadius: last ? 18 : 0, borderBottomRightRadius: last ? 18 : 0 };
  const body = (
    <Pressable
      onPress={() => onOpen(item)}
      onLongPress={() => {
        try { require('../../services/haptics').HapticsCompat.selectionAsync(); } catch {}
        onUnstar(item);
      }}
      delayLongPress={380}
      accessibilityRole="button"
      accessibilityLabel={`${who.name}. ${preview}. ${when}`}
      accessibilityHint={S.openHint}
      accessibilityActions={[{ name: 'unstar', label: S.unstar }]}
      onAccessibilityAction={(e) => { if (e?.nativeEvent?.actionName === 'unstar') onUnstar(item); }}
      style={({ pressed }) => [st.row, radius, { backgroundColor: pressed ? g.surface2 : g.surface }]}
    >
      <AvatarCircle name={who.name} email={who.email || null} size={40} />
      <View style={st.body}>
        <View style={st.head}>
          <Text style={[st.name, { color: g.text }]} numberOfLines={1}>{who.name}</Text>
          <IconStarFilled size={11} color={g.muted} style={{ marginLeft: 8 }} />
          <Text style={[st.when, { color: g.muted }]} numberOfLines={1}>{when}</Text>
        </View>
        <View style={{ marginTop: 4 }}><Preview d={d} g={g} /></View>
      </View>
      {!last ? <View style={[st.sep, { backgroundColor: g.line }]} /> : null}
    </Pressable>
  );
  const Swipeable = GH && GH.Swipeable;
  if (!Swipeable) return body;
  return (
    <Swipeable
      ref={swipeRef}
      friction={1.6}
      rightThreshold={56}
      overshootRight={false}
      renderRightActions={() => (
        <Pressable
          onPress={() => { try { swipeRef.current?.close?.(); } catch {} onUnstar(item); }}
          accessibilityRole="button"
          accessibilityLabel={S.unstar}
          style={[st.swipeAct, { backgroundColor: g.ink }, last ? { borderBottomRightRadius: 18 } : null, first ? { borderTopRightRadius: 18 } : null]}
        >
          <IconStar size={20} color={g.onInk} />
          <Text style={[st.swipeTxt, { color: g.onInk }]} numberOfLines={1}>{S.unstar}</Text>
        </Pressable>
      )}
    >
      {body}
    </Swipeable>
  );
});

/**
 * props:
 *   items[]          lista do chat_starred_messages (já filtrada p/ a conversa)
 *   loading          bool
 *   localMessages[]  mensagens carregadas na conversa (completa a prévia: duração, variantes…)
 *   currentEmail, isGroup, peerName, peerEmail, members[]
 *   onOpen(item) · onUnstar(item) · onRestar(item) · onClose()
 */
export default function StarredMessagesSheet({
  items, loading, localMessages, currentEmail, isGroup, peerName, peerEmail, members,
  onOpen, onUnstar, onRestar, onClose, bottomInset = 0,
}) {
  const { isDark } = useTheme() || {};
  const { language, t } = useLanguage() || {};
  const S = useMemo(() => ({ ..._strs(language), _t: typeof t === 'function' ? t : null }), [language, t]);
  const g = grafite(!!isDark);
  const shadow = cardShadow(!!isDark);
  const list = Array.isArray(items) ? items : [];
  const me = String(currentEmail || '').toLowerCase();

  const localById = useMemo(() => {
    const map = new Map();
    if (!list.length || !Array.isArray(localMessages)) return map;
    const want = new Set(list.map((x) => String(x.id)));
    for (const lm of localMessages) {
      if (lm && lm.id != null && want.has(String(lm.id))) map.set(String(lm.id), lm);
    }
    return map;
  }, [list, localMessages]);

  const memberNames = useMemo(() => {
    const map = new Map();
    (Array.isArray(members) ? members : []).forEach((x) => {
      const e = String((x && (x.email || x)) || '').toLowerCase();
      if (!e || typeof x !== 'object') return;
      const nm = x.display_name || x.name || x.contact_name || '';
      if (nm) map.set(e, String(nm));
    });
    return map;
  }, [members]);

  const whoFor = useCallback((it) => {
    const e = String(it.sender_email || '').toLowerCase();
    if (e && e === me) return { name: S.you, email: e };
    if (!isGroup && peerName && (!peerEmail || !e || e === String(peerEmail).toLowerCase())) return { name: peerName, email: e || peerEmail || '' };
    const nm = memberNames.get(e) || '';
    let disp = nm;
    if (!disp) { try { disp = api.emailToDisplayName(it.sender_name || it.sender_email || ''); } catch { disp = it.sender_name || ''; } }
    return { name: disp || S.message, email: e };
  }, [me, S, isGroup, peerName, peerEmail, memberNames]);

  // "Desfazer" dentro da folha (Toast global fica atrás da folha nativa).
  const [undo, setUndo] = useState(null);
  const undoTimer = useRef(null);
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current); }, []);
  const doUnstar = useCallback((it) => {
    try { onUnstar && onUnstar(it); } catch {}
    setUndo(it);
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), 4500);
  }, [onUnstar, fade]);
  const doUndo = useCallback(() => {
    const it = undo;
    setUndo(null);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    if (it) { try { onRestar && onRestar(it); } catch {} }
  }, [undo, onRestar]);

  const renderItem = useCallback(({ item, index }) => (
    <StarredItem
      item={item}
      local={localById.get(String(item.id)) || null}
      who={whoFor(item)}
      g={g}
      S={S}
      language={language}
      onOpen={onOpen}
      onUnstar={doUnstar}
      first={index === 0}
      last={index === list.length - 1}
    />
  ), [localById, whoFor, g, S, language, onOpen, doUnstar, list.length]);

  const count = list.length;
  let content;
  if (loading && !count) {
    content = (
      <View style={[st.card, shadow, { backgroundColor: g.surface, marginHorizontal: 16 }]}>
        <SkeletonRow g={g} /><SkeletonRow g={g} /><SkeletonRow g={g} />
      </View>
    );
  } else if (!count) {
    content = (
      <View style={st.empty}>
        <View style={[st.emptyIcon, { backgroundColor: g.surface }, shadow]}>
          <IconStar size={34} color={g.text2} />
        </View>
        <Text style={[st.emptyTitle, { color: g.text }]}>{S.emptyTitle}</Text>
        <Text style={[st.emptyBody, { color: g.muted }]}>{S.emptyBody}</Text>
      </View>
    );
  } else {
    content = (
      <FlatList
        data={list}
        keyExtractor={(m) => String(m.id)}
        renderItem={renderItem}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: bottomInset + 24 }}
        ListHeaderComponent={<Text style={[st.hint, { color: g.muted }]}>{S.hint}</Text>}
        initialNumToRender={10}
        windowSize={9}
        removeClippedSubviews={false}
        showsVerticalScrollIndicator={false}
      />
    );
  }

  const inner = (
    <View style={[st.fill, { backgroundColor: g.bg }]}>
      <View style={st.header}>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', minWidth: 0 }}>
          <Text style={[st.title, { color: g.text }]} numberOfLines={1} accessibilityRole="header">{S.title}</Text>
          {count ? (
            <View style={[st.countPill, { backgroundColor: g.ink }]}>
              <Text style={[st.countTxt, { color: g.onInk }]}>{count > 199 ? '199+' : count}</Text>
            </View>
          ) : null}
        </View>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={S.close} style={[st.close, { backgroundColor: g.surface2 }]}>
          <IconX size={18} color={g.text} />
        </Pressable>
      </View>
      {content}
      {undo ? (
        <Animated.View style={[st.undoBar, { backgroundColor: g.ink, bottom: bottomInset + 14, opacity: fade, transform: [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }]}>
          <IconStar size={16} color={g.onInk} />
          <Text style={[st.undoTxt, { color: g.onInk }]} numberOfLines={1}>{S.removed}</Text>
          <Pressable onPress={doUndo} hitSlop={10} accessibilityRole="button" accessibilityLabel={S.undo}>
            <Text style={[st.undoBtn, { color: g.onInk }]}>{S.undo}</Text>
          </Pressable>
        </Animated.View>
      ) : null}
    </View>
  );
  // Folha nativa = outro VC: o RNGH precisa da própria raiz p/ o deslizar.
  const Root = GH && GH.GestureHandlerRootView;
  return Root ? <Root style={st.fill}>{inner}</Root> : inner;
}

const st = StyleSheet.create({
  fill: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 6 },
  title: { fontSize: 22, fontWeight: '700', letterSpacing: -0.4, flexShrink: 1 },
  countPill: { marginLeft: 10, minWidth: 24, height: 22, borderRadius: 11, paddingHorizontal: 7, alignItems: 'center', justifyContent: 'center' },
  countTxt: { fontSize: 12.5, fontWeight: '700', fontVariant: ['tabular-nums'] },
  close: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginLeft: 12 },
  hint: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4, paddingTop: 4, paddingBottom: 10 },
  card: { borderRadius: 18, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 14, paddingVertical: 12 },
  body: { flex: 1, minWidth: 0, marginLeft: 12 },
  head: { flexDirection: 'row', alignItems: 'center' },
  name: { fontSize: 15.5, fontWeight: '600', letterSpacing: -0.2, flexShrink: 1 },
  when: { fontSize: 12.5, fontVariant: ['tabular-nums'], marginLeft: 'auto', paddingLeft: 8 },
  text: { fontSize: 15, lineHeight: 20 },
  mediaRow: { flexDirection: 'row', alignItems: 'center' },
  thumb: { width: 64, height: 64, borderRadius: 10, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  playWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  playDot: { width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', paddingLeft: 2 },
  durBadge: { position: 'absolute', right: 4, bottom: 3, fontSize: 10.5, fontWeight: '600', color: '#FFFFFF', textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 3, fontVariant: ['tabular-nums'] },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  label: { fontSize: 14.5, fontWeight: '500' },
  meta: { fontSize: 13, marginLeft: 2, fontVariant: ['tabular-nums'] },
  caption: { fontSize: 14, lineHeight: 19, marginTop: 2 },
  chipIcon: { width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  sticker: { width: 84, height: 84 },
  sep: { position: 'absolute', left: 66, right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
  swipeAct: { width: 112, alignItems: 'center', justifyContent: 'center', gap: 4 },
  swipeTxt: { fontSize: 12, fontWeight: '600' },
  skAv: { width: 40, height: 40, borderRadius: 20 },
  skLine: { height: 11, borderRadius: 6 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36, paddingBottom: 40, minHeight: 260 },
  emptyIcon: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  emptyTitle: { fontSize: 19, fontWeight: '700', letterSpacing: -0.3, textAlign: 'center' },
  emptyBody: { fontSize: 14.5, lineHeight: 20, textAlign: 'center', marginTop: 8, maxWidth: 320 },
  undoBar: { position: 'absolute', left: 16, right: 16, minHeight: 48, borderRadius: 14, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 10 },
  undoTxt: { flex: 1, fontSize: 14.5, fontWeight: '500' },
  undoBtn: { fontSize: 14.5, fontWeight: '700' },
});
