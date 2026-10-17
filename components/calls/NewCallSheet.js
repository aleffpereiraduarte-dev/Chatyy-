// [2026-10-17 sem-pstn] "Nova chamada" da aba Ligações — substitui o discador
// (teclado numérico / ligar para número comum). Founder: "só pelo Chatyy".
// Lista quem TEM Chatyy (recentes das ligações + contatos sincronizados + busca
// do servidor) com botões de voz e vídeo; quem não tem → "Convidar para o
// Chatyy". Nunca disca PSTN.
//
// <NewCallSheet visible onClose recent={[{ email, name }]} onStartCall={({ email, name, video }) => …} />
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { View, Text, Modal, TouchableOpacity, TextInput, FlatList, StyleSheet, Platform, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import AvatarCircle from '../AvatarCircle';
import { IconX, IconSearch, IconPhone, IconVideo, IconUserPlus } from '../Icons';

const _norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export default function NewCallSheet({ visible, onClose, recent, onStartCall }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const tr = (k, fb) => { try { const v = t?.(k); return v && v !== k ? v : fb; } catch { return fb; } };
  const [q, setQ] = useState('');
  const [synced, setSynced] = useState([]);
  const [server, setServer] = useState([]);
  const [invites, setInvites] = useState([]);
  const [searching, setSearching] = useState(false);
  const seqRef = useRef(0);

  // Contatos do aparelho que têm Chatyy (cache do contactSync — sem prompt).
  useEffect(() => {
    if (!visible || Platform.OS === 'web') return;
    let alive = true;
    (async () => {
      try {
        const c = await require('../../services/contactSync').getCachedContacts();
        if (alive && c && Array.isArray(c.chatyContacts)) setSynced(c.chatyContacts.filter(x => x && x.email));
      } catch {}
    })();
    return () => { alive = false; };
  }, [visible]);

  useEffect(() => { if (!visible) { setQ(''); setServer([]); setInvites([]); } }, [visible]);

  // Busca no servidor (pessoas no Chatyy + convite p/ número sem conta).
  useEffect(() => {
    const raw = q.trim();
    const seq = ++seqRef.current;
    if (raw.length < 2) { setServer([]); setInvites([]); setSearching(false); return undefined; }
    setSearching(true);
    const h = setTimeout(async () => {
      try {
        let homeDial = '';
        try { homeDial = require('../../services/contactSync').getHomeDialDigits(); } catch {}
        const r = await require('../../services/api').peopleSearch(raw, homeDial);
        if (seq !== seqRef.current) return;
        const d = r?.success ? (r.data || {}) : {};
        setServer([...(d.contacts || []), ...(d.global || [])].filter(u => u && u.email));
        setInvites(d.invite && d.invite.e164 ? [{ phone: d.invite.e164, name: d.invite.display || d.invite.e164 }] : []);
      } catch {
        if (seq === seqRef.current) { setServer([]); setInvites([]); }
      } finally {
        if (seq === seqRef.current) setSearching(false);
      }
    }, 300);
    return () => clearTimeout(h);
  }, [q]);

  const rows = useMemo(() => {
    const seen = new Set();
    const out = [];
    const qq = _norm(q.trim());
    const match = (u) => !qq || _norm(`${u.name || u.display_name || ''} ${u.email || ''} ${u.username || ''} ${u.phone || ''}`).includes(qq);
    const add = (u) => {
      const em = String(u.email || '').toLowerCase();
      if (!em || seen.has(em) || !match(u)) return;
      seen.add(em);
      out.push({ key: em, email: u.email, name: u.name || u.display_name || u.email.split('@')[0], avatar: u.avatar || u.image || null });
    };
    (Array.isArray(recent) ? recent : []).forEach(add);
    synced.forEach(add);
    server.forEach((u) => { const em = String(u.email || '').toLowerCase(); if (!seen.has(em)) { seen.add(em); out.push({ key: em, email: u.email, name: u.name || u.display_name || u.email.split('@')[0], avatar: u.avatar || u.image || null }); } });
    invites.forEach((iv) => out.push({ key: `inv_${iv.phone}`, invite: true, phone: iv.phone, name: iv.name }));
    return out;
  }, [recent, synced, server, invites, q]);

  const bg = colors?.background || (isDark ? '#000' : '#fff');
  const text = colors?.text || (isDark ? '#F5F5F7' : '#111');
  const sub = colors?.textSecondary || (isDark ? '#8E8E93' : '#6B6B70');
  const fieldBg = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(17,17,17,0.06)';
  const btnBg = isDark ? '#2c2c2e' : '#f2f2f7';

  const start = (row, video) => {
    onClose?.();
    setTimeout(() => { try { onStartCall?.({ email: row.email, name: row.name, video }); } catch {} }, Platform.OS === 'ios' ? 350 : 0);
  };
  const invite = (row) => {
    try {
      const inv = require('../../services/inviteContact');
      if (row.phone && Platform.OS !== 'web') inv.inviteBySms(t, row.phone, '');
      else inv.shareInvite(t, '');
    } catch {}
  };

  const renderItem = ({ item }) => (
    <View style={st.row}>
      {item.invite ? (
        <View style={[st.inviteAvatar, { backgroundColor: btnBg }]}><IconUserPlus size={20} color={sub} /></View>
      ) : (
        <AvatarCircle name={item.name} email={item.email} uri={item.avatar} size={44} />
      )}
      <View style={st.mid}>
        <Text style={[st.name, { color: text }]} numberOfLines={1}>{item.name}</Text>
        <Text style={[st.sub, { color: sub }]} numberOfLines={1}>
          {item.invite ? tr('calls.notOnChatyyTitle', 'Ainda não está no Chatyy') : 'Chatyy'}
        </Text>
      </View>
      {item.invite ? (
        <TouchableOpacity onPress={() => invite(item)} style={[st.invBtn, { backgroundColor: btnBg }]} accessibilityRole="button" accessibilityLabel={tr('invite.toChatyy', 'Convidar para o Chatyy')}>
          <Text style={[st.invTxt, { color: text }]}>{tr('chat.invite', 'Convidar')}</Text>
        </TouchableOpacity>
      ) : (
        <>
          <TouchableOpacity onPress={() => start(item, false)} style={[st.callBtn, { backgroundColor: btnBg }]} hitSlop={6} accessibilityRole="button" accessibilityLabel={`${tr('calls.voiceCall', 'Ligação de voz')} ${item.name}`}>
            <IconPhone size={18} color={text} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => start(item, true)} style={[st.callBtn, { backgroundColor: btnBg }]} hitSlop={6} accessibilityRole="button" accessibilityLabel={`${tr('calls.videoCall', 'Chamada de vídeo')} ${item.name}`}>
            <IconVideo size={18} color={text} />
          </TouchableOpacity>
        </>
      )}
    </View>
  );

  return (
    <Modal
      visible={!!visible}
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined} allowSwipeDismissal /* [2026-10-17 drag-dismiss] RN 0.83: sem isso o pageSheet NÃO desce interativo (modalInPresentation=YES) */
      onRequestClose={onClose}
    >
      <View style={[st.root, { backgroundColor: bg, paddingTop: Platform.OS === 'ios' ? 12 : Math.max(insets.top, 12), paddingBottom: insets.bottom }]}>
        <View style={st.header}>
          <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={tr('common.close', 'Fechar')} style={st.headerSide}>
            <IconX size={22} color={text} />
          </TouchableOpacity>
          <Text style={[st.title, { color: text }]} numberOfLines={1}>{tr('calls.newCall', 'Nova chamada')}</Text>
          <View style={st.headerSide} />
        </View>
        <Text style={[st.hint, { color: sub }]}>{tr('calls.freeViaChatyy', 'Ligações grátis pelo Chatyy, voz e vídeo')}</Text>
        <View style={[st.search, { backgroundColor: fieldBg }]}>
          <IconSearch size={16} color={sub} />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder={tr('calls.newCallSearch', 'Buscar contato no Chatyy')}
            placeholderTextColor={sub}
            style={[st.input, { color: text }]}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
          />
          {searching ? <ActivityIndicator size="small" color={sub} /> : null}
        </View>
        <FlatList
          data={rows}
          keyExtractor={(it) => it.key}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 24 }}
          ListEmptyComponent={!searching ? (
            <View style={st.empty}>
              <Text style={[st.sub, { color: sub, textAlign: 'center' }]}>
                {q.trim().length >= 2
                  ? tr('calls.newCallNoResults', 'Ninguém encontrado no Chatyy')
                  : tr('calls.newCallEmpty', 'Busque pelo nome, @usuário ou número de quem já usa o Chatyy')}
              </Text>
              <TouchableOpacity onPress={() => invite({})} style={[st.invBtn, { backgroundColor: btnBg, marginTop: 14 }]} accessibilityRole="button">
                <Text style={[st.invTxt, { color: text }]}>{tr('invite.toChatyy', 'Convidar para o Chatyy')}</Text>
              </TouchableOpacity>
            </View>
          ) : null}
        />
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, minHeight: 44 },
  headerSide: { width: 44, height: 44, justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600' },
  hint: { fontSize: 13, textAlign: 'center', paddingHorizontal: 24, marginBottom: 10 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 12, borderRadius: 12, minHeight: 40 },
  input: { flex: 1, fontSize: 16, paddingVertical: Platform.OS === 'web' ? 8 : 6 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, minHeight: 60, gap: 12 },
  inviteAvatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  mid: { flex: 1, minWidth: 0 },
  name: { fontSize: 16, fontWeight: '500' },
  sub: { fontSize: 13, marginTop: 2 },
  callBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  invBtn: { paddingHorizontal: 14, minHeight: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  invTxt: { fontSize: 14, fontWeight: '600' },
  empty: { paddingHorizontal: 32, paddingTop: 48, alignItems: 'center' },
});
