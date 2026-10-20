// [2026-10-20 tg1] "Responder em outra conversa" (Telegram): escolhe a conversa de
// destino e abre ela com a barra de resposta citando a mensagem de origem.
// A citação cruza conversas pelo mesmo caminho do "Responder em privado"
// (utils/privateReplyQuote: reply_ext_conv_id/reply_ext_msg_id → o servidor confere
// que sou membro da origem e monta a citação do banco). Lista pinta da cópia local
// (chatStore) e atualiza da rede por cima. P&B, sem emoji.
// Params: p = JSON do replyTo (mesmo formato do _replyPrivately), src = id da conversa de origem.
import { useEffect, useMemo, useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, TextInput, StyleSheet, Platform } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import AvatarCircle from '../components/AvatarCircle';
import { IconX, IconSearch } from '../components/Icons';

function _local() {
  try {
    const l = require('../services/chatStore').getConversationsSync?.();
    if (Array.isArray(l) && l.length) return l;
  } catch {}
  try {
    const l = require('../services/smartChatCache').getCachedConversationsSync?.();
    if (Array.isArray(l) && l.length) return l;
  } catch {}
  return [];
}

function _ts(c) {
  const v = c?.last_message_at || c?.updated_at || c?.created_at || 0;
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}

function _norm(list, srcId) {
  const seen = new Set();
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || c.id == null) continue;
    const k = String(c.id);
    if (seen.has(k) || k === String(srcId || '')) continue;
    if (c.locked || c.left || c.ex_member) continue;
    // canal: só quem pode postar (admin)
    if (c.type === 'channel') {
      const role = String(c.my_role || c.role || '').toLowerCase();
      if (role !== 'admin' && role !== 'owner') continue;
    }
    seen.add(k);
    out.push(c);
  }
  out.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || _ts(b) - _ts(a));
  return out;
}

export default function ReplyPickScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const userEmail = String(user?.email || '');
  const srcId = String(params?.src || '');
  const tt = useCallback((k, fb) => { const v = t(k); return v && v !== k ? v : fb; }, [t]);

  const payload = useMemo(() => {
    try { return JSON.parse(decodeURIComponent(String(params?.p || ''))); } catch { return null; }
  }, [params?.p]);

  const [convs, setConvs] = useState(() => _norm(_local(), srcId));
  const [query, setQuery] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.chatConversations();
        const l = Array.isArray(r?.data) ? r.data : (r?.data?.conversations || []);
        if (alive && l.length) setConvs(_norm(l, srcId));
      } catch {}
    })();
    return () => { alive = false; };
  }, [srcId]);

  const nameOf = useCallback((c) => {
    if (!c) return '';
    const isGroup = c.type === 'group' || c.type === 'channel' || !!c.is_group;
    const peer = !isGroup ? (c.other_email || c.contact_email || c.email || '') : '';
    if (c.type === 'saved' || (peer && userEmail && peer.toLowerCase() === userEmail.toLowerCase())) return tt('chat.savedMessages', 'Mensagens salvas');
    let nick = '';
    if (peer) { try { nick = require('../services/nicknames').getNickname(peer) || ''; } catch {} }
    return nick || api.emailToDisplayName(c.display_name || c.name || peer || '') || peer || '-';
  }, [tt, userEmail]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return convs.filter(c => !c.archived);
    return convs.filter(c => [nameOf(c), c.name, c.display_name, c.other_email, c.contact_email]
      .filter(Boolean).join(' ').toLowerCase().includes(q));
  }, [convs, query, nameOf]);

  const close = useCallback(() => { try { if (router.canGoBack?.()) router.back(); else router.replace('/chat'); } catch {} }, [router]);

  const pick = useCallback((c) => {
    if (!payload || !c) return;
    try {
      require('../services/openConversation').openConversation({
        pathname: '/chat-conversation',
        params: {
          id: String(c.id),
          name: nameOf(c),
          email: c.other_email || c.contact_email || '',
          ...(c.type ? { type: c.type } : {}),
          replyTo: encodeURIComponent(JSON.stringify(payload)),
        },
      }, { replace: true });
    } catch {}
  }, [payload, nameOf]);

  const sub = isDark ? 'rgba(235,235,245,0.6)' : 'rgba(60,60,67,0.6)';
  const hair = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)';

  return (
    <View style={[s.root, { backgroundColor: colors.background, paddingTop: Platform.OS === 'web' ? 12 : insets.top + 6 }]}>
      <View style={s.header}>
        <TouchableOpacity onPress={close} hitSlop={10} accessibilityRole="button" accessibilityLabel={tt('common.cancel', 'Cancelar')} style={s.hBtn}>
          <IconX size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[s.title, { color: colors.text }]} numberOfLines={1}>{tt('replyPick.title', 'Responder em...')}</Text>
        <View style={s.hBtn} />
      </View>
      {!!payload && (
        <View style={[s.quote, { borderLeftColor: colors.text, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]}>
          <Text style={{ color: colors.text, fontWeight: '600', fontSize: 13 }} numberOfLines={1}>{String(payload.sender_name || '')}</Text>
          <Text style={{ color: sub, fontSize: 13, marginTop: 1 }} numberOfLines={2}>{String(payload.quoteText || payload.content || '')}</Text>
        </View>
      )}
      <View style={[s.search, { backgroundColor: isDark ? 'rgba(118,118,128,0.24)' : 'rgba(118,118,128,0.12)' }]}>
        <IconSearch size={16} color={sub} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={tt('common.search', 'Buscar')}
          placeholderTextColor={sub}
          style={{ flex: 1, marginLeft: 8, color: colors.text, fontSize: 16, paddingVertical: Platform.OS === 'android' ? 4 : 8 }}
          autoCorrect={false}
          returnKeyType="search"
        />
      </View>
      <FlatList
        data={filtered}
        keyExtractor={(c) => String(c.id)}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        ItemSeparatorComponent={() => <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: hair, marginLeft: 72 }} />}
        ListEmptyComponent={<Text style={{ color: sub, textAlign: 'center', marginTop: 40 }}>{tt('replyPick.empty', 'Nenhuma conversa encontrada')}</Text>}
        renderItem={({ item }) => {
          const name = nameOf(item);
          const isGroup = item.type === 'group' || item.type === 'channel' || !!item.is_group;
          return (
            <TouchableOpacity onPress={() => pick(item)} activeOpacity={0.6} style={s.row} accessibilityRole="button" accessibilityLabel={name}>
              <AvatarCircle
                name={name}
                email={isGroup ? undefined : (item.other_email || item.contact_email || undefined)}
                uri={isGroup ? (item.avatar_url || undefined) : undefined}
                members={isGroup ? item.members : undefined}
                size={44}
              />
              <Text style={{ flex: 1, marginLeft: 12, color: colors.text, fontSize: 16, fontWeight: '500' }} numberOfLines={1}>{name}</Text>
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, height: 44 },
  hBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600' },
  quote: { marginHorizontal: 16, marginTop: 6, marginBottom: 8, paddingVertical: 6, paddingHorizontal: 10, borderLeftWidth: 3, borderRadius: 6 },
  search: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginBottom: 6, paddingHorizontal: 10, borderRadius: 10 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10 },
});
