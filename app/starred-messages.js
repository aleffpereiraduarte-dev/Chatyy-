import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../components/nativeHeader'; // [2026-10-09 more-native]
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconStar, IconMessageSquare, IconBookmark, IconArrowRight } from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';
import FadeSlideIn from '../components/FadeSlideIn';
import * as api from '../services/api';
import { useAuth } from '../context/AuthContext';

// Unified "Salvas | Favoritas" screen (E.3).
//
// These are two genuinely different concepts, so neither is destroyed:
//   - Salvas    = your Telegram-style self-chat ("Mensagens Salvas"). Lives in
//                 a real conversation; opening it routes to /saved-messages.
//   - Favoritas = individual starred messages bookmarked across any chat
//                 (chat_starred_messages).
// A top tab switcher puts both under one entry with a short explanation per tab
// so the user understands the difference instead of seeing two mystery screens.
export default function StarredMessagesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth() || {};
  const myEmail = String(user?.email || '').toLowerCase();
  // [2026-10-11 qa-sweep2] conversation_id → { title, peerEmail, type }. The
  // starred API only carries conversation_name for groups, so direct rows
  // showed the raw handle ("apitest") of your OWN message with no hint of the
  // chat, and tapping one of your own messages opened the thread with YOUR
  // e-mail as the peer. WhatsApp: "Você ▸ Qa2".
  const [convMap, setConvMap] = useState({});

  const [tab, setTab] = useState('starred'); // 'saved' | 'starred'
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);

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
          const others = (Array.isArray(c.members) ? c.members : []).filter(x => String(x?.email || '').toLowerCase() !== myEmail);
          const peerEmail = c.type === 'direct' ? (c.other_email || c.contact_email || others[0]?.email || '') : '';
          const title = c.type === 'direct'
            ? api.emailToDisplayName(c.contact_name || c.display_name || others[0]?.display_name || c.name || peerEmail)
            : (c.name || '');
          m[String(c.id)] = { title, peerEmail, type: c.type };
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

  const openConversation = (msg) => {
    if (!msg?.conversation_id) return;
    const cm = convMap[String(msg.conversation_id)] || {};
    const isMine = String(msg.sender_email || '').toLowerCase() === myEmail;
    const peer = cm.peerEmail || (isMine ? '' : (msg.sender_email || ''));
    const name = msg.conversation_name || cm.title || '';
    try {
      require('../services/openConversation').openConversation(`/chat-conversation?id=${msg.conversation_id}&name=${encodeURIComponent(name)}&type=${msg.conversation_type || cm.type || 'direct'}${peer ? `&email=${encodeURIComponent(peer)}` : ''}${msg.id ? `&scrollToMessageId=${encodeURIComponent(msg.id)}` : ''}`);
    } catch (e) { console.warn('[starred] nav:', e); }
  };

  const formatDate = (iso) => {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      const now = new Date();
      const dayMs = 24 * 60 * 60 * 1000;
      const diffDays = Math.floor((now - d) / dayMs);
      if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (diffDays === 1) return t('common.yesterday') || 'Yesterday';
      if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
      return d.toLocaleDateString();
    } catch { return ''; }
  };

  // [2026-10-09 more-native] Com header nativo (fundo = superfície do tema) as
  // abas seguem a mesma superfície (texto/hairline), sem a faixa preta fixa.
  // [2026-10-11 polish-secondary] Web também segue a superfície do tema (era
  // faixa preta fixa no claro + aba ativa #111 invisível no escuro).
  const tabAccent = colors.text;
  const tabInactive = colors.textSecondary;
  const tabBarBg = colors.headerBgSolid || colors.surface || colors.background;

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }]}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title: t('saved.unifiedTitle'), headerShadowVisible: false })} />
      ) : (
      <View style={[styles.header, { backgroundColor: tabBarBg, paddingTop: 10 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel={t('common.back') || 'Voltar'}>
          <IconArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text }]}>{t('saved.unifiedTitle') || 'Salvas e favoritas'}</Text>
      </View>
      )}

      {/* Tab switcher — Salvas | Favoritas */}
      <View style={[styles.tabBar, { backgroundColor: tabBarBg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}>
        <TouchableOpacity
          style={[styles.tab, tab === 'saved' && { borderBottomColor: tabAccent }]}
          onPress={() => setTab('saved')}
          activeOpacity={0.8}
        >
          <IconBookmark size={16} color={tab === 'saved' ? tabAccent : tabInactive} />
          <Text style={[styles.tabText, { color: tab === 'saved' ? tabAccent : tabInactive }]}>
            {t('saved.tabSaved') || 'Salvas'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, tab === 'starred' && { borderBottomColor: tabAccent }]}
          onPress={() => setTab('starred')}
          activeOpacity={0.8}
        >
          <IconStar size={16} color={tab === 'starred' ? tabAccent : tabInactive} />
          <Text style={[styles.tabText, { color: tab === 'starred' ? tabAccent : tabInactive }]}>
            {t('saved.tabStarred') || 'Favoritas'}
          </Text>
        </TouchableOpacity>
      </View>

      <FadeSlideIn>
      {tab === 'saved' ? (
        <View style={styles.savedPane}>
          <Text style={[styles.paneExplain, { color: colors.textSecondary }]}>
            {t('saved.savedExplain') || 'Suas anotações pessoais — uma conversa só sua, estilo bloco de notas.'}
          </Text>
          <TouchableOpacity
            onPress={openSavedMessages}
            activeOpacity={0.85}
            style={[styles.savedCard, { backgroundColor: isDark ? 'rgba(17, 17, 17,0.12)' : 'rgba(17, 17, 17,0.06)', borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(17, 17, 17,0.18)' }]}
          >
            <View style={[styles.savedIcon, { backgroundColor: '#111111' }]}>
              <IconBookmark size={22} color="#fff" />
            </View>
            <View style={styles.savedCardBody}>
              <Text style={[styles.savedCardTitle, { color: colors.text }]}>
                {t('chat.savedMessages') || 'Mensagens Salvas'}
              </Text>
              <Text style={[styles.savedCardSub, { color: colors.textSecondary }]}>
                {t('saved.openHint') || 'Abrir sua conversa de anotações'}
              </Text>
            </View>
            <IconArrowRight size={20} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      ) : loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : messages.length === 0 ? (
        <View style={styles.empty}>
          <IconStar size={56} color={isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)'} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>
            {t('starred.empty') || 'No starred messages yet'}
          </Text>
          <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
            {t('starred.emptyHint') || 'Tap and hold any message to star it.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={messages}
          keyExtractor={(m) => String(m.id)}
          ListHeaderComponent={(
            <Text style={[styles.paneExplain, { color: colors.textSecondary, paddingTop: 14 }]}>
              {t('saved.starredExplain') || 'Mensagens marcadas com estrela em qualquer conversa.'}
            </Text>
          )}
          renderItem={({ item }) => (
            <TouchableOpacity onPress={() => openConversation(item)} style={[styles.row, { borderBottomColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }]}>
              <AvatarCircle name={item.sender_name || item.sender_email} email={item.sender_email} size={44} />
              <View style={styles.rowBody}>
                <View style={styles.rowHead}>
                  <Text style={[styles.rowName, { color: colors.text }]} numberOfLines={1}>
                    {(() => {
                      const isMine = String(item.sender_email || '').toLowerCase() === myEmail;
                      const who = isMine ? (t('chat.you') || 'Você') : api.emailToDisplayName(item.sender_name || item.sender_email || '');
                      const cm = convMap[String(item.conversation_id)];
                      // Direct: the peer's own messages already name the chat;
                      // mine get "Você › Qa2" (WhatsApp). Groups show the group
                      // name on the line below.
                      const where = item.conversation_type === 'group' ? '' : (cm?.title || '');
                      return isMine && where ? `${who}  ›  ${where}` : who;
                    })()}
                  </Text>
                  <Text style={[styles.rowTime, { color: colors.textSecondary }]}>
                    {formatDate(item.created_at)}
                  </Text>
                </View>
                {!!item.conversation_name && item.conversation_type === 'group' && (
                  <Text style={[styles.rowGroup, { color: colors.textSecondary }]} numberOfLines={1}>
                    {item.conversation_name}
                  </Text>
                )}
                <View style={styles.rowContent}>
                  <IconStar size={12} color={colors.textSecondary} />
                  <Text style={[styles.rowPreview, { color: colors.textSecondary }]} numberOfLines={2}>
                    {item.content || ''}
                  </Text>
                </View>
              </View>
            </TouchableOpacity>
          )}
        />
      )}
      </FadeSlideIn>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 14 },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontSize: 20, fontWeight: '700', marginLeft: 8 },
  tabBar: { flexDirection: 'row', paddingHorizontal: 12 },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabText: { fontSize: 14, fontWeight: '700' },
  savedPane: { padding: 16 },
  paneExplain: { fontSize: 13, paddingHorizontal: 16, marginBottom: 12, lineHeight: 18 },
  savedCard: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  savedIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  savedCardBody: { flex: 1 },
  savedCardTitle: { fontSize: 16, fontWeight: '700' },
  savedCardSub: { fontSize: 13, marginTop: 2 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 12 },
  emptyTitle: { fontSize: 17, fontWeight: '600' },
  emptySubtitle: { fontSize: 14, textAlign: 'center' },
  row: { flexDirection: 'row', paddingVertical: 12, paddingHorizontal: 14, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, alignItems: 'center' },
  rowBody: { flex: 1 },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowName: { fontSize: 15, fontWeight: '600', flex: 1 },
  rowTime: { fontSize: 12 },
  rowGroup: { fontSize: 12, marginTop: 2 },
  rowContent: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  rowPreview: { fontSize: 14, flex: 1 },
});
