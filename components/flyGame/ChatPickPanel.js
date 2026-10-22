// components/flyGame/ChatPickPanel.js — [voar 2026-10-22] "Desafiar": escolher a conversa (painel DENTRO da
// tela do jogo — nada de Modal sobre Modal no iOS). Lista pinta da cópia local e atualiza da rede.
// Só conversas diretas e grupos (o servidor recusa canal/salvas); a mesma regra do reply-pick para nomes.
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { View, Text, FlatList, Pressable, TextInput, StyleSheet, Platform, ActivityIndicator } from 'react-native';
import * as api from '../../services/api';
import AvatarCircle from '../AvatarCircle';

function _local() {
  try { const l = require('../../services/chatStore').getConversationsSync?.(); if (Array.isArray(l) && l.length) return l; } catch {}
  try { const l = require('../../services/smartChatCache').getCachedConversationsSync?.(); if (Array.isArray(l) && l.length) return l; } catch {}
  return [];
}
const _ts = (c) => { const v = c?.last_message_at || c?.updated_at || c?.created_at || 0; const n = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(n) ? n : 0; };
function _norm(list, me) {
  const seen = new Set(); const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || c.id == null || seen.has(String(c.id))) continue;
    if (c.locked || c.left || c.ex_member || c.archived) continue;
    if (c.type && c.type !== 'direct' && c.type !== 'group') continue;
    const peer = String(c.other_email || c.contact_email || '').toLowerCase();
    if (c.type === 'direct' && peer && peer === me) continue; // salvas
    seen.add(String(c.id)); out.push(c);
  }
  out.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || _ts(b) - _ts(a));
  return out;
}

export default function ChatPickPanel({ me, t, onPick, onClose, busyId, bottomInset = 0 }) {
  const tt = useCallback((k, fb) => { try { const v = t(k); return v && v !== k ? v : fb; } catch { return fb; } }, [t]);
  const meL = String(me || '').toLowerCase();
  const [convs, setConvs] = useState(() => _norm(_local(), meL));
  const [q, setQ] = useState('');
  useEffect(() => {
    let alive = true;
    (async () => {
      try { const r = await api.chatConversations(); const l = Array.isArray(r?.data) ? r.data : (r?.data?.conversations || []); if (alive && l.length) setConvs(_norm(l, meL)); } catch {}
    })();
    return () => { alive = false; };
  }, [meL]);
  const nameOf = useCallback((c) => {
    const isGroup = c.type === 'group' || !!c.is_group;
    const peer = !isGroup ? (c.other_email || c.contact_email || c.email || '') : '';
    let nick = '';
    if (peer) { try { nick = require('../../services/nicknames').getNickname(peer) || ''; } catch {} }
    return nick || api.emailToDisplayName(c.display_name || c.name || peer || '') || peer || '-';
  }, []);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return convs.slice(0, 200);
    return convs.filter((c) => [nameOf(c), c.other_email, c.contact_email].filter(Boolean).join(' ').toLowerCase().includes(s)).slice(0, 200);
  }, [convs, q, nameOf]);
  return (
    <View style={[st.panel, { paddingBottom: bottomInset + 10 }]}>
      <View style={st.handle} />
      <View style={st.head}>
        <Text style={st.title}>{tt('fly.dare.pick', 'Desafiar quem?')}</Text>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={tt('common.close', 'Fechar')} style={st.close}>
          <Text style={st.closeTxt}>{tt('common.close', 'Fechar')}</Text>
        </Pressable>
      </View>
      <View style={st.search}>
        <TextInput value={q} onChangeText={setQ} placeholder={tt('common.search', 'Buscar')} placeholderTextColor="rgba(234,242,250,0.45)"
          style={st.input} autoCorrect={false} returnKeyType="search" />
      </View>
      <FlatList
        data={list}
        keyExtractor={(c) => String(c.id)}
        keyboardShouldPersistTaps="handled"
        style={{ flexGrow: 0 }}
        ListEmptyComponent={<Text style={st.empty}>{tt('fly.dare.empty', 'Nenhuma conversa encontrada')}</Text>}
        renderItem={({ item }) => {
          const name = nameOf(item);
          const isGroup = item.type === 'group' || !!item.is_group;
          return (
            <Pressable onPress={() => onPick && onPick(item, name)} disabled={!!busyId} style={({ pressed }) => [st.row, pressed && { opacity: 0.6 }]} accessibilityRole="button" accessibilityLabel={name}>
              <AvatarCircle name={name} email={isGroup ? undefined : (item.other_email || item.contact_email || undefined)} uri={isGroup ? (item.avatar_url || undefined) : undefined} members={isGroup ? item.members : undefined} size={40} />
              <Text style={st.name} numberOfLines={1}>{name}</Text>
              {String(busyId) === String(item.id) ? <ActivityIndicator color="#8FD3FF" /> : null}
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const st = StyleSheet.create({
  panel: { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '72%', backgroundColor: 'rgba(16,21,29,0.97)', borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 16, paddingTop: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.1)' },
  handle: { alignSelf: 'center', width: 38, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.22)', marginBottom: 8 },
  head: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  title: { flex: 1, color: '#EEF3F8', fontSize: 18, fontWeight: '800' },
  close: { paddingHorizontal: 12, height: 32, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.08)', justifyContent: 'center' },
  closeTxt: { color: '#EEF3F8', fontWeight: '700', fontSize: 13 },
  search: { height: 40, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.07)', paddingHorizontal: 12, justifyContent: 'center', marginBottom: 6 },
  input: { color: '#EEF3F8', fontSize: 15, paddingVertical: Platform.OS === 'android' ? 2 : 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9 },
  name: { flex: 1, color: '#EEF3F8', fontSize: 15.5, fontWeight: '600' },
  empty: { color: 'rgba(234,242,250,0.55)', textAlign: 'center', marginVertical: 24 },
});
