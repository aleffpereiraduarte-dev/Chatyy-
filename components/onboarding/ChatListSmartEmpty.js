// [2026-10-07 welcome] Smart empty state for the chat list (no conversations).
//
//  • friends already on Chatyy (from the LOCAL contact-sync cache — never
//    prompts for permission here; without a cache it links to /chat-new,
//    which owns the consent + sync UX)
//  • "Nova conversa" + "Convidar" (share https://chatyy.com.br/baixar)
//  • Saved Messages tip
//
// With a filter/search active it falls back to the generic ScreenEmptyState
// (the list isn't really empty then, just filtered).
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform, ActivityIndicator, DeviceEventEmitter } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '../../context/ThemeContext';
import AvatarCircle from '../AvatarCircle';
import ScreenEmptyState from '../ScreenEmptyState';
import { IconBookmark, IconUserPlus, IconPlus, IconShare, IconUsersSmall, IconMegaphone } from '../Icons';
import { useReducedMotion } from '../reducedMotion';
import FadeSlideIn from '../FadeSlideIn';
import { useOnbCopy } from './copy';
import ChatyyMascot from '../mascot/ChatyyMascot'; // [2026-10-16 mascote]
import { shareInvite } from './invite';

// [2026-10-16 wave12-c] app/chat.js escuta e troca de aba (Comunidades/Canais).
export const OPEN_HOME_TAB_EVENT = 'chatyy:openHomeTab';

function Chevron({ color }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <Path d="M9 6l6 6-6 6" />
    </Svg>
  );
}

export default function ChatListSmartEmpty({ router, t, filtered, currentEmail, filter, query, onClearFilter, onNewGroup }) {
  const { isDark } = useTheme();
  const c = useOnbCopy();
  const reduceMotion = useReducedMotion();
  const [suggest, setSuggest] = useState(null); // null = loading/unknown, [] = none
  const [opening, setOpening] = useState('');
  const me = String(currentEmail || '').toLowerCase();

  useEffect(() => {
    if (filtered) return undefined;
    let cancelled = false;
    (async () => {
      if (Platform.OS === 'web') { if (!cancelled) setSuggest([]); return; }
      try {
        const { getCachedContacts } = require('../../services/contactSync');
        const cached = await getCachedContacts();
        const list = (cached?.chatyContacts || []).filter((x) => x?.email && String(x.email).toLowerCase() !== me);
        if (!cancelled) setSuggest(cached ? list : 'nocache');
      } catch { if (!cancelled) setSuggest([]); }
    })();
    return () => { cancelled = true; };
  }, [filtered, me]);

  const openChat = useCallback(async (f) => {
    const em = String(f?.email || '').trim().toLowerCase();
    if (!em || opening) return;
    setOpening(em);
    try {
      const api = require('../../services/api');
      const r = await api.chatCreate([em], '', 'direct');
      const convId = r?.data?.conversation_id || r?.data?.id;
      if (r?.success && convId) {
        const nm = r.data?.name || f.name || em;
        require('../../services/openConversation').openConversation(`/chat-conversation?id=${convId}&name=${encodeURIComponent(nm)}&type=direct&email=${encodeURIComponent(em)}`);
      } else {
        router.push('/chat-new');
      }
    } catch {
      router.push('/chat-new');
    } finally { setOpening(''); }
  }, [opening, router]);

  const openSaved = useCallback(async () => {
    try {
      const api = require('../../services/api');
      const rs = await api.chatSaved();
      const sid = rs?.data?.id || rs?.data?.conversation_id;
      if (rs?.success && sid) {
        require('../../services/openConversation').openConversation({ pathname: '/chat-conversation', params: { id: String(sid), name: t?.('chat.savedMessages') || c('empty.savedTitle') } });
      }
    } catch {}
  }, [router, t, c]);

  if (filtered) {
    // [2026-10-10 qa-sweep] Vazio POR FILTRO/BUSCA: antes todo filtro vazio
    // (Não lidas, Favoritas, Grupos, Arquivadas, busca sem resultado) dizia
    // "Nenhuma conversa — Inicie uma nova conversa", como se a conta estivesse
    // vazia. Agora a mensagem explica o filtro e oferece voltar p/ "Todas".
    const q = String(query || '').trim();
    const back = typeof onClearFilter === 'function'
      ? { label: t('chat.emptyFilterShowAll'), onPress: onClearFilter }
      : undefined;
    if (q) {
      return (
        <ScreenEmptyState
          kind="search"
          mascot="search"
          title={t('chat.emptySearchTitle')}
          subtitle={t('chat.emptySearchDesc', { query: q.length > 40 ? `${q.slice(0, 40)}…` : q })}
        />
      );
    }
    if (filter === 'unread') {
      return <ScreenEmptyState kind="chat" mascot="celebrate" title={t('chat.emptyUnreadTitle')} subtitle={t('chat.emptyUnreadDesc')} secondary={back} />;
    }
    if (filter === 'favorites') {
      return <ScreenEmptyState kind="chat" title={t('chat.emptyFavoritesTitle')} subtitle={t('chat.emptyFavoritesDesc')} secondary={back} />;
    }
    if (filter === 'groups') {
      return (
        <ScreenEmptyState
          kind="chat"
          title={t('chat.emptyGroupsTitle')}
          subtitle={t('chat.emptyGroupsDesc')}
          cta={typeof onNewGroup === 'function' ? { label: t('chat.newGroup'), icon: 'plus', onPress: onNewGroup } : undefined}
          secondary={back}
        />
      );
    }
    if (filter === 'archived') {
      return <ScreenEmptyState kind="chat" title={t('chat.emptyArchivedTitle')} subtitle={t('chat.emptyArchivedDesc')} secondary={back} />;
    }
    if (filter && filter !== 'all') {
      return <ScreenEmptyState kind="chat" title={t('chat.emptyFilterTitle')} subtitle={t('chat.emptyFilterDesc')} secondary={back} />;
    }
    return (
      <ScreenEmptyState
        kind="chat"
        title={t('chat.empty') || 'Comece uma conversa'}
        subtitle={t('chat.emptyDesc')}
        cta={{ label: t('chat.newConversation') || 'Iniciar conversa', icon: 'plus', onPress: () => router.push('/chat-new') }}
      />
    );
  }

  const fg = isDark ? '#ffffff' : '#111111';
  const bg = isDark ? '#000000' : '#ffffff';
  const sub = isDark ? 'rgba(255,255,255,0.6)' : 'rgba(17,17,17,0.58)';
  const muted = isDark ? '#1c1c1e' : '#F1F2F4';
  const hair = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(17,17,17,0.1)';
  const list = Array.isArray(suggest) ? suggest.slice(0, 6) : [];

  return (
    <FadeSlideIn distance={reduceMotion ? 0 : 10} duration={reduceMotion ? 0 : 320}>
      <View style={st.wrap}>
        <View style={st.hero}>
          <ChatyyMascot pose="wave" size={140} dark={isDark} />{/* [2026-10-16 mascote] era ChatArt estático */}
          <Text style={[st.title, { color: fg }]} accessibilityRole="header">{c('empty.title')}</Text>
          <Text style={[st.sub, { color: sub }]}>{c('empty.sub')}</Text>
        </View>

        <View style={st.ctaRow}>
          <Pressable
            onPress={() => router.push('/chat-new')}
            style={({ pressed }) => [st.cta, { backgroundColor: fg, opacity: pressed ? 0.85 : 1 }]}
            accessibilityRole="button"
          >
            <IconPlus size={18} color={bg} />
            <Text style={[st.ctaText, { color: bg }]}>{c('empty.newChat')}</Text>
          </Pressable>
          <Pressable
            onPress={() => shareInvite(c)}
            style={({ pressed }) => [st.cta, { borderWidth: 1.5, borderColor: fg, opacity: pressed ? 0.7 : 1 }]}
            accessibilityRole="button"
          >
            <IconShare size={18} color={fg} />
            <Text style={[st.ctaText, { color: fg }]}>{c('empty.invite')}</Text>
          </Pressable>
        </View>

        {suggest === 'nocache' ? (
          <Pressable
            onPress={() => router.push('/chat-new')}
            style={({ pressed }) => [st.card, { borderColor: hair, opacity: pressed ? 0.7 : 1 }]}
            accessibilityRole="button"
          >
            <View style={[st.cardIcon, { backgroundColor: muted }]}><IconUserPlus size={20} color={fg} /></View>
            <View style={{ flex: 1 }}>
              <Text style={[st.cardTitle, { color: fg }]}>{c('empty.findFriends')}</Text>
              <Text style={[st.cardSub, { color: sub }]}>{c('empty.findFriendsSub')}</Text>
            </View>
            <Chevron color={sub} />
          </Pressable>
        ) : null}

        {list.length > 0 ? (
          <View style={{ marginTop: 22 }}>
            <Text style={[st.section, { color: sub }]}>{c('empty.onChatyy')}</Text>
            {list.map((f) => (
              <Pressable
                key={f.email}
                onPress={() => openChat(f)}
                style={({ pressed }) => [st.row, { opacity: pressed ? 0.7 : 1 }]}
                accessibilityRole="button"
                accessibilityLabel={`${c('empty.message')} ${f.name || f.email}`}
              >
                <AvatarCircle name={f.name} email={f.email} uri={f.avatar || undefined} size={44} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[st.rowName, { color: fg }]} numberOfLines={1}>{f.name || f.email}</Text>
                  {f.phone ? <Text style={[st.rowSub, { color: sub }]} numberOfLines={1}>{f.phone}</Text> : null}
                </View>
                <View style={[st.pill, { backgroundColor: muted }]}>
                  {opening === String(f.email).toLowerCase()
                    ? <ActivityIndicator size="small" color={fg} />
                    : <Text style={[st.pillText, { color: fg }]}>{c('empty.message')}</Text>}
                </View>
              </Pressable>
            ))}
          </View>
        ) : null}

        {/* [2026-10-16 wave12-c] Descobrir Comunidades/Canais — antes só na gaveta Apps. */}
        <View style={{ marginTop: 22 }}>
          <Text style={[st.section, { color: sub }]}>{t('discoverHome.section') || 'Descobrir'}</Text>
          {[
            { k: 'communities', title: t('community.title') || 'Comunidades', subT: t('discoverHome.communitiesSub'), Icon: IconUsersSmall },
            { k: 'channels', title: t('channel.title') || 'Canais', subT: t('discoverHome.channelsSub'), Icon: IconMegaphone },
          ].map(({ k, title, subT, Icon }) => (
            <Pressable
              key={k}
              onPress={() => { try { DeviceEventEmitter.emit(OPEN_HOME_TAB_EVENT, k); } catch {} }}
              style={({ pressed }) => [st.card, { borderColor: hair, marginTop: 8, opacity: pressed ? 0.7 : 1 }]}
              accessibilityRole="button"
              accessibilityLabel={title}
            >
              <View style={[st.cardIcon, { backgroundColor: muted }]}><Icon size={20} color={fg} /></View>
              <View style={{ flex: 1 }}>
                <Text style={[st.cardTitle, { color: fg }]}>{title}</Text>
                {subT ? <Text style={[st.cardSub, { color: sub }]}>{subT}</Text> : null}
              </View>
              <Chevron color={sub} />
            </Pressable>
          ))}
        </View>

        <Pressable
          onPress={openSaved}
          style={({ pressed }) => [st.card, { borderColor: hair, marginTop: 22, opacity: pressed ? 0.7 : 1 }]}
          accessibilityRole="button"
        >
          <View style={[st.cardIcon, { backgroundColor: muted }]}><IconBookmark size={20} color={fg} /></View>
          <View style={{ flex: 1 }}>
            <Text style={[st.cardTitle, { color: fg }]}>{c('empty.savedTitle')}</Text>
            <Text style={[st.cardSub, { color: sub }]}>{c('empty.savedSub')}</Text>
          </View>
          <Chevron color={sub} />
        </Pressable>
      </View>
    </FadeSlideIn>
  );
}

const st = StyleSheet.create({
  wrap: { paddingHorizontal: 20, paddingTop: 28, paddingBottom: 40, width: '100%', maxWidth: 560, alignSelf: 'center' },
  hero: { alignItems: 'center' },
  title: { fontSize: 22, fontWeight: '800', letterSpacing: -0.4, marginTop: 14, textAlign: 'center' },
  sub: { fontSize: 15, lineHeight: 21, marginTop: 6, textAlign: 'center' },
  ctaRow: { flexDirection: 'row', gap: 10, marginTop: 22 },
  cta: { flex: 1, minHeight: 48, borderRadius: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  ctaText: { fontSize: 15.5, fontWeight: '700' },
  section: { fontSize: 13, fontWeight: '700', letterSpacing: 0.3, textTransform: 'uppercase', marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9 },
  rowName: { fontSize: 16, fontWeight: '600' },
  rowSub: { fontSize: 13, marginTop: 1 },
  pill: { minWidth: 92, minHeight: 34, paddingHorizontal: 14, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  pillText: { fontSize: 14, fontWeight: '700' },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 16, borderWidth: 1, marginTop: 18 },
  cardIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 15, fontWeight: '700' },
  cardSub: { fontSize: 13, marginTop: 2, lineHeight: 18 },
});
