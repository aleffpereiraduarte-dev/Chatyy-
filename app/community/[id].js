// Community hub — Telegram-style supergroup landing page.
// Tabs: Anúncios (announcement channel preview + post box for admins),
//       Conversas (sub-groups list), Membros (with role badges + admin tools),
//       Sobre (description, rules, welcome, member count).
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, FlatList,
  Image, ActivityIndicator, RefreshControl, TextInput, Alert, Pressable, Platform,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import { BorderRadius, FontSize, Spacing, Shadow } from '../../constants/theme';
import * as api from '../../services/api';

const TABS = [
  { key: 'announcements', labelKey: 'community.tabAnnouncements', fallback: 'Anúncios' },
  { key: 'conversations', labelKey: 'community.tabConversations', fallback: 'Conversas' },
  { key: 'members',       labelKey: 'community.tabMembers',       fallback: 'Membros' },
  { key: 'about',         labelKey: 'community.tabAbout',         fallback: 'Sobre' },
];

export default function CommunityScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { id } = params; // numeric id or @handle
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();

  const [tab, setTab] = useState('announcements');
  const [community, setCommunity] = useState(null);
  const [groups, setGroups] = useState([]);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [announceText, setAnnounceText] = useState('');
  const [posting, setPosting] = useState(false);
  // Members tab — quick filter by name/email substring.
  const [memberQuery, setMemberQuery] = useState('');
  // Announcement composer — toggle between Edit and Preview.
  const [announcePreview, setAnnouncePreview] = useState(false);

  const myEmail = (user?.email || '').toLowerCase();
  const isAdmin = community && (community.my_role === 'owner' || community.my_role === 'admin');
  const isOwner = community && community.my_role === 'owner';

  // ---- Data load ----
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await api.communityInfo(id);
      if (r.success && r.data?.community) {
        setCommunity(r.data.community);
        setGroups(r.data.groups || []);
      } else if (!silent) {
        Alert.alert(t('common.error') || 'Erro', r.error || (t('community.notFound') || 'Comunidade não encontrada'));
      }
    } catch (e) {
      if (!silent) Alert.alert(t('common.error') || 'Erro', String(e?.message || e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id, t]);

  const loadMembers = useCallback(async () => {
    try {
      const r = await api.communityMembers(community?.id);
      if (r.success) setMembers(r.data?.members || []);
    } catch (_) {}
  }, [community?.id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (tab === 'members' && community?.id) loadMembers();
  }, [tab, community?.id, loadMembers]);

  const onRefresh = () => { setRefreshing(true); load(true); };

  // ---- Actions ----
  const onJoin = async () => {
    try {
      const r = await api.communityJoin(community?.id || id);
      if (r.success) {
        load(true);
        if (r.data?.welcome_message) {
          Alert.alert(community?.name || 'Bem-vindo', r.data.welcome_message);
        }
      } else {
        Alert.alert(t('common.error') || 'Erro', r.error || 'Falha ao entrar');
      }
    } catch (e) { Alert.alert(t('common.error') || 'Erro', String(e?.message || e)); }
  };

  const onLeave = () => {
    Alert.alert(
      t('community.leaveTitle') || 'Sair da comunidade',
      t('community.leaveConfirm') || 'Tem certeza que deseja sair?',
      [
        { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
        {
          text: t('community.leave') || 'Sair', style: 'destructive',
          onPress: async () => {
            const r = await api.communityLeave(community?.id);
            if (r.success) router.back();
            else Alert.alert(t('common.error') || 'Erro', r.error || 'Falha');
          },
        },
      ]
    );
  };

  const onAnnounce = async () => {
    const text = announceText.trim();
    if (!text || posting) return;
    setPosting(true);
    try {
      const r = await api.communityAnnounce(community.id, text);
      if (r.success) {
        setAnnounceText('');
        Alert.alert(t('common.success') || 'Sucesso', t('community.announceSent') || 'Anúncio enviado');
      } else {
        Alert.alert(t('common.error') || 'Erro', r.error || 'Falha');
      }
    } finally { setPosting(false); }
  };

  const onAddGroup = async () => {
    // Confirmation gate — admin tapping the dashed "+ Adicionar sub-grupo"
    // by accident has zero downside but creates an empty group + audit
    // entry. Quick OK/Cancel before we ask for a name.
    const confirmed = await new Promise(resolve => {
      const msg = (t('community.newGroupConfirm') || 'Criar um novo sub-grupo em "{n}"?').replace('{n}', community?.name || '');
      if (Platform.OS === 'web') {
        try { resolve(typeof window !== 'undefined' && window.confirm ? window.confirm(msg) : true); }
        catch { resolve(true); }
        return;
      }
      Alert.alert(
        t('community.newGroup') || 'Novo grupo',
        msg,
        [
          { text: t('common.cancel') || 'Cancelar', style: 'cancel', onPress: () => resolve(false) },
          { text: t('common.confirm') || 'Continuar', onPress: () => resolve(true) },
        ],
      );
    });
    if (!confirmed) return;
    // Alert.prompt is iOS-only — on Android/web it's a no-op or crashes.
    // Use window.prompt on web; on Android fall back to a synthesized
    // "Topic" name (best-effort) and rely on the rename flow afterwards.
    let name = null;
    if (Platform.OS === 'ios') {
      // Wrap iOS Alert.prompt in a Promise so the rest of the flow stays
      // a single async path.
      name = await new Promise(resolve => {
        Alert.prompt(
          t('community.newGroup') || 'Novo grupo',
          t('community.newGroupPrompt') || 'Nome do sub-grupo',
          [
            { text: t('common.cancel') || 'Cancelar', style: 'cancel', onPress: () => resolve(null) },
            { text: t('common.create') || 'Criar', onPress: (v) => resolve(v) },
          ],
        );
      });
    } else if (Platform.OS === 'web' && typeof window !== 'undefined' && window.prompt) {
      name = window.prompt(t('community.newGroupPrompt') || 'Nome do sub-grupo', '');
    } else {
      // Android: ship a default name; admin can rename in the group settings.
      name = (t('community.newGroupDefault') || 'Novo grupo');
    }
    if (!name || !name.trim()) return;
    const r = await api.communityAddGroup(community.id, { name: name.trim(), kind: 'topic' });
    if (r.success) load(true);
    else Alert.alert(t('common.error') || 'Erro', r.error || 'Falha');
  };

  // Cheap inline markdown for the announcement preview. Supports bold,
  // italic, and bullet lines. Anything fancier is overkill for the preview
  // surface — server still stores the raw text and renders it in chat.
  const renderMdPreview = (raw) => {
    const lines = String(raw || '').split('\n');
    return lines.map((ln, i) => {
      const isBullet = /^\s*[-*]\s+/.test(ln);
      const text = isBullet ? ln.replace(/^\s*[-*]\s+/, '') : ln;
      const out = [];
      let cursor = 0;
      const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*)/g;
      let m;
      let key = 0;
      while ((m = re.exec(text)) !== null) {
        if (m.index > cursor) out.push(<Text key={`p${key++}`}>{text.slice(cursor, m.index)}</Text>);
        if (m[2] != null) out.push(<Text key={`b${key++}`} style={{ fontWeight: '800' }}>{m[2]}</Text>);
        else if (m[3] != null) out.push(<Text key={`i${key++}`} style={{ fontStyle: 'italic' }}>{m[3]}</Text>);
        cursor = m.index + m[0].length;
      }
      if (cursor < text.length) out.push(<Text key={`p${key++}`}>{text.slice(cursor)}</Text>);
      return (
        <View key={i} style={{ flexDirection: 'row', marginBottom: 2 }}>
          {isBullet ? <Text style={{ marginRight: 6, color: colors.text }}>•</Text> : null}
          <Text style={{ flex: 1, fontSize: 14, lineHeight: 20, color: colors.text }}>{out}</Text>
        </View>
      );
    });
  };

  // Members list filtered by the search box.
  const filteredMembers = useMemo(() => {
    const q = String(memberQuery || '').trim().toLowerCase();
    if (!q) return members;
    return members.filter(m => {
      const name = String(m?.display_name || '').toLowerCase();
      const email = String(m?.email || '').toLowerCase();
      return name.includes(q) || email.includes(q);
    });
  }, [members, memberQuery]);

  const onChangeRole = (member) => {
    if (!isOwner && member.role === 'admin') return;
    const options = [
      { label: t('community.roleAdmin') || 'Admin', value: 'admin', ownerOnly: true },
      { label: t('community.roleMod')   || 'Moderador', value: 'mod' },
      { label: t('community.roleMember')|| 'Membro', value: 'member' },
    ].filter(o => !o.ownerOnly || isOwner);
    Alert.alert(
      member.email,
      t('community.changeRole') || 'Definir cargo',
      [
        ...options.map(o => ({
          text: o.label,
          onPress: async () => {
            const r = await api.communityMemberRole(community.id, member.email, o.value);
            if (r.success) loadMembers();
            else Alert.alert(t('common.error') || 'Erro', r.error || 'Falha');
          },
        })),
        { text: t('community.kick') || 'Remover', style: 'destructive', onPress: async () => {
          const r = await api.communityKick(community.id, member.email);
          if (r.success) loadMembers();
          else Alert.alert(t('common.error') || 'Erro', r.error || 'Falha');
        } },
        { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
      ]
    );
  };

  // ---- Render ----
  const sty = makeStyles(colors, isDark);

  if (loading && !community) {
    return (
      <View style={[sty.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={sty.header}>
          <TouchableOpacity onPress={() => router.back()} style={sty.headerBtn}>
            <Text style={[sty.headerBtnText, { color: colors.primary }]}>‹</Text>
          </TouchableOpacity>
        </View>
        <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: 80 }} />
      </View>
    );
  }

  if (!community) {
    return (
      <View style={[sty.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={sty.header}>
          <TouchableOpacity onPress={() => router.back()} style={sty.headerBtn}>
            <Text style={[sty.headerBtnText, { color: colors.primary }]}>‹</Text>
          </TouchableOpacity>
          <Text style={[sty.headerTitle, { color: colors.text }]}>{t('community.title') || 'Comunidade'}</Text>
          <View style={sty.headerBtn} />
        </View>
        <Text style={{ color: colors.textSecondary, textAlign: 'center', marginTop: 80 }}>
          {t('community.notFound') || 'Comunidade não encontrada'}
        </Text>
      </View>
    );
  }

  return (
    <View style={[sty.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={sty.header}>
        <TouchableOpacity onPress={() => router.back()} style={sty.headerBtn}>
          <Text style={[sty.headerBtnText, { color: colors.primary }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[sty.headerTitle, { color: colors.text }]} numberOfLines={1}>
          {community.name}
        </Text>
        <View style={sty.headerBtn} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {/* Cover / Photo */}
        <View style={sty.cover}>
          {community.cover_url ? (
            <Image source={{ uri: community.cover_url }} style={sty.coverImg} resizeMode="cover" />
          ) : (
            <View style={[sty.coverImg, { backgroundColor: colors.primary, opacity: 0.15 }]} />
          )}
          <View style={sty.photoWrap}>
            {community.photo_url ? (
              <Image source={{ uri: community.photo_url }} style={sty.photo} />
            ) : (
              <View style={[sty.photo, { backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }]}>
                <Text style={{ color: '#fff', fontSize: 32, fontWeight: '700' }}>
                  {(community.name || '?').slice(0, 1).toUpperCase()}
                </Text>
              </View>
            )}
          </View>
        </View>

        {/* Title block */}
        <View style={sty.titleBlock}>
          <Text style={[sty.commName, { color: colors.text }]}>{community.name}</Text>
          {community.handle ? (
            <Text style={[sty.handle, { color: colors.textSecondary }]}>@{community.handle}</Text>
          ) : null}
          <Text style={[sty.memberCount, { color: colors.textSecondary }]}>
            {(t('community.membersCount') || '{n} membros').replace('{n}', String(community.member_count || 0))}
            {' · '}
            {(t('community.groupsCount') || '{n} grupos').replace('{n}', String(community.group_count || 0))}
          </Text>

          {/* Join / Leave button */}
          {!community.is_member ? (
            <TouchableOpacity onPress={onJoin} style={[sty.primaryBtn, { backgroundColor: colors.primary }]}>
              <Text style={sty.primaryBtnText}>{t('community.join') || 'Entrar'}</Text>
            </TouchableOpacity>
          ) : (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
              {isAdmin && (
                <TouchableOpacity
                  onPress={() => router.push(`/community/edit?id=${community.id}`)}
                  style={[sty.secondaryBtn, { borderColor: colors.primary }]}
                >
                  <Text style={[sty.secondaryBtnText, { color: colors.primary }]}>
                    {t('community.edit') || 'Editar'}
                  </Text>
                </TouchableOpacity>
              )}
              {!isOwner && (
                <TouchableOpacity onPress={onLeave} style={[sty.secondaryBtn, { borderColor: '#e74c3c' }]}>
                  <Text style={[sty.secondaryBtnText, { color: '#e74c3c' }]}>
                    {t('community.leave') || 'Sair'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>

        {/* Tabs */}
        <View style={[sty.tabs, { borderColor: colors.border }]}>
          {TABS.map(tabDef => (
            <TouchableOpacity
              key={tabDef.key}
              onPress={() => setTab(tabDef.key)}
              style={[sty.tab, tab === tabDef.key && { borderBottomColor: colors.primary, borderBottomWidth: 2 }]}
            >
              <Text style={[sty.tabText, { color: tab === tabDef.key ? colors.primary : colors.textSecondary }]}>
                {t(tabDef.labelKey) || tabDef.fallback}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Tab content */}
        {tab === 'announcements' && (
          <View style={sty.tabContent}>
            {community.announcement_conv_id && (
              <TouchableOpacity
                onPress={() => router.push(`/chat-conversation?id=${community.announcement_conv_id}&name=${encodeURIComponent(community.name + ' — Avisos')}`)}
                style={[sty.row, { backgroundColor: isDark ? '#1c1c1e' : '#f8f8fa' }]}
              >
                <Text style={[sty.rowTitle, { color: colors.text }]}>
                  {t('community.openAnnouncements') || 'Abrir canal de avisos'}
                </Text>
                <Text style={[sty.rowSubtitle, { color: colors.textSecondary }]}>
                  {t('community.announcementsHint') || 'Apenas admins podem postar; todos leem.'}
                </Text>
              </TouchableOpacity>
            )}
            {isAdmin && (
              <View style={[sty.composer, { backgroundColor: isDark ? '#1c1c1e' : '#f8f8fa' }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={[sty.composerLabel, { color: colors.textSecondary }]}>
                    {t('community.postAnnouncement') || 'Postar anúncio'}
                  </Text>
                  {/* Edit/Preview toggle — pressing "Preview" renders a cheap
                      markdown view of the current draft (bold/italic/bullets)
                      so admins can sanity-check the layout before publishing. */}
                  <TouchableOpacity
                    onPress={() => setAnnouncePreview(p => !p)}
                    disabled={!announceText.trim()}
                    hitSlop={6}
                    style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, backgroundColor: announcePreview ? colors.primary : 'transparent', borderWidth: 1, borderColor: colors.primary }}
                  >
                    <Text style={{ color: announcePreview ? '#fff' : colors.primary, fontSize: 12, fontWeight: '700' }}>
                      {announcePreview ? (t('common.edit') || 'Editar') : (t('common.preview') || 'Preview')}
                    </Text>
                  </TouchableOpacity>
                </View>
                {announcePreview ? (
                  <View style={[sty.composerInput, { borderColor: colors.border, backgroundColor: isDark ? '#101011' : '#fff' }]}>
                    {renderMdPreview(announceText)}
                  </View>
                ) : (
                  <TextInput
                    value={announceText}
                    onChangeText={setAnnounceText}
                    multiline
                    placeholder={t('community.announcementPlaceholder') || 'Escreva um anúncio…'}
                    placeholderTextColor={colors.textSecondary}
                    style={[sty.composerInput, { color: colors.text, borderColor: colors.border }]}
                  />
                )}
                <TouchableOpacity
                  onPress={onAnnounce}
                  disabled={!announceText.trim() || posting}
                  style={[sty.primaryBtn, { backgroundColor: colors.primary, opacity: (!announceText.trim() || posting) ? 0.5 : 1 }]}
                >
                  <Text style={sty.primaryBtnText}>
                    {posting ? (t('common.sending') || 'Enviando…') : (t('community.publish') || 'Publicar')}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {tab === 'conversations' && (
          <View style={sty.tabContent}>
            {groups.map(g => (
              <TouchableOpacity
                key={g.conversation_id}
                onPress={() => router.push(`/chat-conversation?id=${g.conversation_id}&name=${encodeURIComponent(g.name || '')}`)}
                style={[sty.row, { backgroundColor: isDark ? '#1c1c1e' : '#f8f8fa' }]}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  {g.is_announcement && (
                    <View style={[sty.tag, { backgroundColor: colors.primary }]}>
                      <Text style={sty.tagText}>{t('community.announcementTag') || 'Avisos'}</Text>
                    </View>
                  )}
                  <Text style={[sty.rowTitle, { color: colors.text, flex: 1 }]}>{g.name}</Text>
                </View>
                <Text style={[sty.rowSubtitle, { color: colors.textSecondary }]}>
                  {(t('community.membersCount') || '{n} membros').replace('{n}', String(g.member_count || 0))}
                </Text>
              </TouchableOpacity>
            ))}
            {isAdmin && (
              <TouchableOpacity onPress={onAddGroup} style={[sty.row, { borderWidth: 1, borderColor: colors.primary, borderStyle: 'dashed', backgroundColor: 'transparent' }]}>
                <Text style={[sty.rowTitle, { color: colors.primary, textAlign: 'center' }]}>
                  + {t('community.addGroup') || 'Adicionar sub-grupo'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {tab === 'members' && (
          <View style={sty.tabContent}>
            {/* Quick filter — name or email substring. Saves the user from
                scrolling 200+ rows in big communities just to find one mod. */}
            <View style={{
              flexDirection: 'row', alignItems: 'center',
              backgroundColor: isDark ? '#1c1c1e' : '#f0f0f3',
              borderRadius: BorderRadius.medium,
              paddingHorizontal: 10, paddingVertical: 6,
              marginBottom: 6,
            }}>
              <TextInput
                value={memberQuery}
                onChangeText={setMemberQuery}
                placeholder={t('common.search') || 'Buscar…'}
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                style={{ flex: 1, color: colors.text, paddingVertical: 4 }}
              />
              {!!memberQuery && (
                <TouchableOpacity onPress={() => setMemberQuery('')} hitSlop={6}>
                  <Text style={{ color: colors.textSecondary, fontSize: 18 }}>×</Text>
                </TouchableOpacity>
              )}
            </View>
            {filteredMembers.map(m => (
              <Pressable
                key={m.email}
                onLongPress={() => isAdmin && m.email !== myEmail && onChangeRole(m)}
                style={[sty.row, { backgroundColor: isDark ? '#1c1c1e' : '#f8f8fa', flexDirection: 'row', alignItems: 'center' }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[sty.rowTitle, { color: colors.text }]}>{m.display_name || m.email}</Text>
                  <Text style={[sty.rowSubtitle, { color: colors.textSecondary }]}>{m.email}</Text>
                </View>
                {m.role !== 'member' && (
                  <View style={[sty.tag, { backgroundColor: roleColor(m.role) }]}>
                    <Text style={sty.tagText}>{roleLabel(m.role, t)}</Text>
                  </View>
                )}
              </Pressable>
            ))}
            {isAdmin && (
              <Text style={[sty.hint, { color: colors.textSecondary }]}>
                {t('community.longPressMember') || 'Toque e segure um membro para gerir.'}
              </Text>
            )}
          </View>
        )}

        {tab === 'about' && (
          <View style={sty.tabContent}>
            {community.description ? (
              <View style={sty.section}>
                <Text style={[sty.sectionTitle, { color: colors.textSecondary }]}>
                  {t('community.description') || 'Descrição'}
                </Text>
                <Text style={[sty.bodyText, { color: colors.text }]}>{community.description}</Text>
              </View>
            ) : null}
            {community.rules ? (
              <View style={sty.section}>
                <Text style={[sty.sectionTitle, { color: colors.textSecondary }]}>
                  {t('community.rules') || 'Regras'}
                </Text>
                <Text style={[sty.bodyText, { color: colors.text }]}>{community.rules}</Text>
              </View>
            ) : null}
            {community.welcome_message ? (
              <View style={sty.section}>
                <Text style={[sty.sectionTitle, { color: colors.textSecondary }]}>
                  {t('community.welcome') || 'Mensagem de boas-vindas'}
                </Text>
                <Text style={[sty.bodyText, { color: colors.text }]}>{community.welcome_message}</Text>
              </View>
            ) : null}
            <View style={sty.section}>
              <Text style={[sty.sectionTitle, { color: colors.textSecondary }]}>
                {t('community.stats') || 'Estatísticas'}
              </Text>
              <Text style={[sty.bodyText, { color: colors.text }]}>
                {(t('community.membersCount') || '{n} membros').replace('{n}', String(community.member_count || 0))}
              </Text>
              <Text style={[sty.bodyText, { color: colors.text }]}>
                {(t('community.groupsCount') || '{n} grupos').replace('{n}', String(community.group_count || 0))}
              </Text>
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function roleColor(role) {
  switch (role) {
    case 'owner': return '#ff9500';
    case 'admin': return '#5856d6';
    case 'mod':   return '#34c759';
    default:      return '#8e8e93';
  }
}
function roleLabel(role, t) {
  switch (role) {
    case 'owner': return t('community.roleOwner') || 'Dono';
    case 'admin': return t('community.roleAdmin') || 'Admin';
    case 'mod':   return t('community.roleMod')   || 'Mod';
    default:      return t('community.roleMember')|| 'Membro';
  }
}

const makeStyles = (colors, isDark) => StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
    borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerBtnText: { fontSize: 28, fontWeight: '300' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600' },
  cover: { height: 140, position: 'relative' },
  coverImg: { width: '100%', height: 140 },
  photoWrap: {
    position: 'absolute', bottom: -40, left: 16,
    width: 88, height: 88, borderRadius: 44,
    backgroundColor: isDark ? '#1c1c1e' : '#fff', padding: 3,
    ...Shadow.md,
  },
  photo: { width: 82, height: 82, borderRadius: 41 },
  titleBlock: { paddingTop: 48, paddingHorizontal: 16, paddingBottom: 12 },
  commName: { fontSize: 22, fontWeight: '700' },
  handle: { fontSize: 14, marginTop: 2 },
  memberCount: { fontSize: 13, marginTop: 6 },
  primaryBtn: { paddingVertical: 12, borderRadius: BorderRadius.md, alignItems: 'center', marginTop: 12 },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  secondaryBtn: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: BorderRadius.md, borderWidth: 1, alignItems: 'center', flex: 1 },
  secondaryBtnText: { fontSize: 14, fontWeight: '600' },
  tabs: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabText: { fontSize: 14, fontWeight: '600' },
  tabContent: { padding: 12, gap: 10 },
  row: { padding: 14, borderRadius: BorderRadius.md, marginBottom: 8 },
  rowTitle: { fontSize: 15, fontWeight: '600' },
  rowSubtitle: { fontSize: 13, marginTop: 2 },
  tag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  tagText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  composer: { padding: 12, borderRadius: BorderRadius.md, marginTop: 12 },
  composerLabel: { fontSize: 12, fontWeight: '600', marginBottom: 6 },
  composerInput: {
    minHeight: 80, borderWidth: 1, borderRadius: BorderRadius.md,
    paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, textAlignVertical: 'top',
  },
  section: { marginBottom: 16 },
  sectionTitle: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  bodyText: { fontSize: 14, lineHeight: 20 },
  hint: { fontSize: 12, fontStyle: 'italic', textAlign: 'center', marginTop: 8 },
});
