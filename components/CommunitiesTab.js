import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl,
  ActivityIndicator, TextInput, Modal, Alert, Platform, KeyboardAvoidingView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconPlus, IconUsers, IconX, IconMessageSquare } from './Icons';
import AvatarCircle from './AvatarCircle';
import BrandFab from './BrandFab';
// [2026-10-08 apps-native] célula nativa, empty canônico, haptics
import PressableRow from './PressableRow';
import PressableScale from './PressableScale';
import ScreenEmptyState from './ScreenEmptyState';
import { haptic } from '../constants/theme';
import Svg, { Path, Rect, Circle } from 'react-native-svg';
import * as api from '../services/api';

const ACCENT = '#111111';

function IconCommunity({ size = 24, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="3" y="3" width="8" height="8" rx="2" />
      <Rect x="13" y="3" width="8" height="8" rx="2" />
      <Rect x="3" y="13" width="8" height="8" rx="2" />
      <Rect x="13" y="13" width="8" height="8" rx="2" />
      <Circle cx="7" cy="7" r="1.5" fill={color} stroke="none" />
      <Circle cx="17" cy="7" r="1.5" fill={color} stroke="none" />
      <Circle cx="7" cy="17" r="1.5" fill={color} stroke="none" />
      <Circle cx="17" cy="17" r="1.5" fill={color} stroke="none" />
    </Svg>
  );
}

function IconMegaphone({ size = 20, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <Path d="M13.73 21a2 2 0 01-3.46 0" />
    </Svg>
  );
}

export default function CommunitiesTab({ colors: propColors, isDark: propIsDark }) {
  const { colors: themeColors, isDark: themeIsDark } = useTheme();
  const colors = propColors || themeColors;
  const isDark = propIsDark !== undefined ? propIsDark : themeIsDark;
  const { t } = useLanguage();
  const router = useRouter();

  const [communities, setCommunities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false); // [2026-10-08 apps-native] erro ≠ lista vazia
  const [expandedId, setExpandedId] = useState(null);
  const [expandedData, setExpandedData] = useState(null);
  const [loadingInfo, setLoadingInfo] = useState(false);

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [creating, setCreating] = useState(false);

  // Announcement modal
  const [announceCommunity, setAnnounceCommunity] = useState(null);
  const [announceText, setAnnounceText] = useState('');
  const [announcing, setAnnouncing] = useState(false);

  // Add group modal
  const [addGroupCommunity, setAddGroupCommunity] = useState(null);
  const [userGroups, setUserGroups] = useState([]);
  const [loadingGroups, setLoadingGroups] = useState(false);

  const loadCommunities = useCallback(async () => {
    try {
      const res = await api.communityList();
      if (api.apiOk(res)) {
        setCommunities(api.apiList(res, 'communities'));
        setFailed(false);
      } else {
        setFailed(true);
      }
    } catch { setFailed(true); } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { loadCommunities(); }, [loadCommunities]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadCommunities();
  }, [loadCommunities]);

  const expandSeqRef = useRef(0);
  // [2026-10-08 apps-native] Recarrega os grupos do card aberto SEM colapsar.
  // Antes add/remove grupo chamava toggleExpand(null)+setTimeout(toggleExpand(id))
  // com closure velha → buscava communityInfo(null) e depois FECHAVA o card.
  const fetchInfo = useCallback(async (id) => {
    const seq = ++expandSeqRef.current;
    setLoadingInfo(true);
    try {
      const res = await api.communityInfo(id);
      // Only apply if this is still the latest expand request (race guard)
      if (seq !== expandSeqRef.current) return;
      if (api.apiOk(res)) {
        setExpandedData(api.apiPayload(res));
      }
    } catch {} finally {
      if (seq === expandSeqRef.current) setLoadingInfo(false);
    }
  }, []);

  const toggleExpand = useCallback(async (id) => {
    haptic.select();
    if (expandedId === id) {
      expandSeqRef.current++;
      setExpandedId(null);
      setExpandedData(null);
      setLoadingInfo(false);
      return;
    }
    setExpandedId(id);
    setExpandedData(null);
    fetchInfo(id);
  }, [expandedId, fetchInfo]);

  const handleCreate = useCallback(async () => {
    if (!createName.trim()) return;
    setCreating(true);
    try {
      const res = await api.communityCreate(createName.trim(), createDesc.trim());
      if (api.apiOk(res)) {
        haptic.success();
        setShowCreate(false);
        setCreateName('');
        setCreateDesc('');
        loadCommunities();
      } else {
        Alert.alert(t('common.error') || 'Erro', api.apiMsg(res) || (t('community.createFailed') || 'Não foi possível criar a comunidade'));
      }
    } catch {
      Alert.alert(t('common.error') || 'Erro', t('community.createFailed') || 'Não foi possível criar a comunidade');
    } finally {
      setCreating(false);
    }
  }, [createName, createDesc, loadCommunities, t]);

  const handleAnnounce = useCallback(async () => {
    if (!announceText.trim() || !announceCommunity) return;
    setAnnouncing(true);
    try {
      const res = await api.communityAnnouncement(announceCommunity.id, announceText.trim());
      if (api.apiOk(res)) {
        haptic.success();
        const count = api.apiPayload(res)?.sent_to || 0;
        Alert.alert(t('community.announcement'), (t('community.sentTo') || 'Sent to {count} groups').replace('{count}', count));
        setAnnounceCommunity(null);
        setAnnounceText('');
      } else {
        Alert.alert(t('common.error') || 'Erro', api.apiMsg(res) || (t('common.failed') || 'Falhou'));
      }
    } catch {
      Alert.alert(t('common.error') || 'Erro', t('community.announceFailed') || 'Não foi possível enviar o aviso');
    } finally {
      setAnnouncing(false);
    }
  }, [announceText, announceCommunity, t]);

  const handleAddGroup = useCallback(async (communityId, conversationId) => {
    try {
      const res = await api.communityAddGroup(communityId, conversationId);
      if (api.apiOk(res)) {
        haptic.success();
        setAddGroupCommunity(null);
        // Refresh expanded info (sem colapsar o card)
        if (expandedId === communityId) fetchInfo(communityId);
        loadCommunities();
      } else {
        Alert.alert(t('common.error') || 'Erro', api.apiMsg(res) || (t('common.failed') || 'Falhou'));
      }
    } catch {
      Alert.alert(t('common.error') || 'Erro', t('community.addGroupFailed') || 'Não foi possível adicionar o grupo');
    }
  }, [expandedId, fetchInfo, loadCommunities, t]);

  const handleRemoveGroup = useCallback(async (communityId, conversationId) => {
    try {
      const res = await api.communityRemoveGroup(communityId, conversationId);
      if (api.apiOk(res)) {
        if (expandedId === communityId) fetchInfo(communityId);
        loadCommunities();
      } else {
        Alert.alert(t('common.error') || 'Erro', api.apiMsg(res) || (t('common.failed') || 'Falhou'));
      }
    } catch {
      Alert.alert(t('common.error') || 'Erro', t('common.tryAgain') || 'Tentar novamente');
    }
  }, [expandedId, fetchInfo, loadCommunities, t]);

  const openAddGroup = useCallback(async (community) => {
    setAddGroupCommunity(community);
    setLoadingGroups(true);
    try {
      const res = await api.chatConversations();
      if (api.apiOk(res)) {
        const groups = api.apiList(res, 'conversations', 'items')
          .filter(c => c.type === 'group' || c.type === 'channel');
        setUserGroups(groups);
      }
    } catch {} finally {
      setLoadingGroups(false);
    }
  }, []);

  const renderCommunity = useCallback(({ item }) => {
    const isExpanded = expandedId === item.id;
    const isAdmin = item.role === 'admin';
    const initial = (item.name || '?')[0].toUpperCase();

    return (
      <View style={[styles.communityCard, { backgroundColor: colors.surface || (isDark ? '#161616' : '#fff'), borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}>
        <PressableRow
          onPress={() => toggleExpand(item.id)}
          style={styles.communityRow}
          accessibilityRole="button"
          accessibilityState={{ expanded: isExpanded }}
          accessibilityLabel={item.name}
        >
          <View style={[styles.communityIcon, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }]}>
            {/* [2026-10-08 apps-native] AvatarCircle lê `uri` (não `imageUrl`) → o ícone nunca aparecia */}
            {(item.icon_url || item.photo_url) ? (
              <AvatarCircle name={item.name} uri={item.icon_url || item.photo_url} size={48} />
            ) : (
              <Text style={[styles.communityInitial, { color: colors.text }]}>{initial}</Text>
            )}
          </View>
          <View style={styles.communityInfo}>
            <Text style={[styles.communityName, { color: colors.text }]} numberOfLines={1}>{item.name}</Text>
            <Text style={[styles.communityMeta, { color: isDark ? '#8b8fa3' : '#6b7280' }]}>
              {item.group_count} {t('community.groups') || 'Grupos'} · {item.member_count} {t('community.members') || 'Membros'}
              {isAdmin ? (' · ' + (t('community.admin') || 'Admin')) : ''}
            </Text>
          </View>
          <View style={[styles.expandArrow, isExpanded && styles.expandArrowUp]}>
            <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={isDark ? '#666' : '#999'} strokeWidth={2}>
              <Path d="M6 9l6 6 6-6" />
            </Svg>
          </View>
        </PressableRow>

        {isExpanded && (
          <View style={[styles.expandedSection, { borderTopColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}>
            {item.description ? (
              <Text style={[styles.description, { color: isDark ? '#8b8fa3' : '#6b7280' }]}>{item.description}</Text>
            ) : null}

            {loadingInfo ? (
              <ActivityIndicator size="small" color={ACCENT} style={{ marginVertical: 12 }} />
            ) : expandedData?.groups?.length > 0 ? (
              <View style={styles.groupsList}>
                <Text style={[styles.sectionLabel, { color: isDark ? '#8b8fa3' : '#6b7280' }]}>{t('community.groups') || 'Groups'}</Text>
                {expandedData.groups.map(g => (
                  <PressableRow
                    key={g.conversation_id}
                    style={[styles.groupRow, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)' }]}
                    onPress={() => router.push({ pathname: '/chat-conversation', params: { id: g.conversation_id, name: g.name || '' } })}
                  >
                    <View style={[styles.groupDot, { backgroundColor: colors.text }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.groupName, { color: colors.text }]} numberOfLines={1}>{g.name || 'Group'}</Text>
                      <Text style={[styles.groupMembers, { color: isDark ? '#666' : '#999' }]}>{g.member_count} {t('community.members') || 'members'}</Text>
                    </View>
                    {isAdmin && (
                      <TouchableOpacity
                        onPress={() => {
                          Alert.alert(
                            t('community.removeGroup') || 'Remover grupo',
                            (t('community.removeGroupConfirm') || 'Remover "{name}" desta comunidade?').replace('{name}', g.name),
                            [
                              { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
                              { text: t('common.remove') || 'Remover', style: 'destructive', onPress: () => handleRemoveGroup(item.id, g.conversation_id) },
                            ]
                          );
                        }}
                        style={styles.removeBtn}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={t('community.removeGroup') || 'Remover grupo'}
                      >
                        <IconX size={14} color="#ef4444" />
                      </TouchableOpacity>
                    )}
                  </PressableRow>
                ))}
              </View>
            ) : (
              <Text style={[styles.emptyText, { color: isDark ? '#555' : '#999' }]}>{t('community.noGroups') || 'No groups'}</Text>
            )}

            {/* Action buttons */}
            {isAdmin && (
              <View style={styles.actions}>
                {/* [2026-10-08 apps-native] preto&branco (era âmbar #f59e0b) */}
                <PressableScale
                  style={[styles.actionBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)' }]}
                  onPress={() => openAddGroup(item)}
                  accessibilityRole="button"
                >
                  <IconPlus size={16} color={colors.text} />
                  <Text style={[styles.actionText, { color: colors.text }]}>{t('community.addGroup') || 'Adicionar grupo'}</Text>
                </PressableScale>
                <PressableScale
                  style={[styles.actionBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)' }]}
                  onPress={() => { setAnnounceCommunity(item); setAnnounceText(''); }}
                  accessibilityRole="button"
                >
                  <IconMegaphone size={16} color={colors.text} />
                  <Text style={[styles.actionText, { color: colors.text }]}>{t('community.announcement') || 'Announce'}</Text>
                </PressableScale>
              </View>
            )}
          </View>
        )}
      </View>
    );
  }, [expandedId, expandedData, loadingInfo, isDark, colors, t, router, toggleExpand, handleRemoveGroup, openAddGroup]);

  const openCreate = useCallback(() => { setShowCreate(true); setCreateName(''); setCreateDesc(''); }, []);

  if (loading) {
    return (
      <View style={[styles.center, { flex: 1, backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <FlatList
        data={communities}
        keyExtractor={item => String(item.id)}
        renderItem={renderCommunity}
        extraData={expandedId}
        initialNumToRender={10}
        windowSize={7}
        contentContainerStyle={communities.length === 0 ? { flexGrow: 1 } : { paddingBottom: 80 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text} colors={[ACCENT]} />}
        ListEmptyComponent={failed ? (
          <ScreenEmptyState
            kind="search"
            title={t('common.error') || 'Erro'}
            subtitle={t('common.tryAgain') || 'Tentar novamente'}
            cta={{ label: t('common.retry') || 'Tentar novamente', onPress: () => { setLoading(true); loadCommunities(); } }}
          />
        ) : (
          <ScreenEmptyState
            kind="contacts"
            title={t('community.noCommunities') || 'No communities'}
            subtitle={t('community.createFirst') || 'Create a community to organize your groups'}
            cta={{ label: t('community.create') || 'Create community', onPress: openCreate }}
          />
        )}
      />

      {/* FAB — Telegram-grade glass orb */}
      <BrandFab
        style={{ position: 'absolute', bottom: 20, right: 20 }}
        size={56}
        color={colors?.primary || ACCENT}
        onPress={openCreate}
        accessibilityLabel={t('community.create') || 'Create community'}
      >
        <IconPlus size={24} color={colors?.onPrimary || '#fff'} />
      </BrandFab>

      {/* Create Modal */}
      <Modal visible={showCreate} transparent animationType="slide" onRequestClose={() => setShowCreate(false)}>
        {/* [fix 2026-07-05] KeyboardAvoidingView — the card is justifyContent:flex-end
            (bottom sheet) and the name input autoFocuses, so without this the keyboard
            covered the whole card and the user saw only the dimmed overlay. */}
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.surface || (isDark ? '#161616' : '#fff') }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>{t('community.create') || 'Create community'}</Text>
              <TouchableOpacity onPress={() => setShowCreate(false)}><IconX size={22} color={isDark ? '#888' : '#666'} /></TouchableOpacity>
            </View>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: isDark ? '#333' : '#ddd', backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#f9f9f9' }]}
              placeholder={t('community.name') || 'Community name'}
              placeholderTextColor={isDark ? '#555' : '#aaa'}
              value={createName}
              onChangeText={setCreateName}
              maxLength={100}
              autoFocus
            />
            <TextInput
              style={[styles.input, styles.inputMulti, { color: colors.text, borderColor: isDark ? '#333' : '#ddd', backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#f9f9f9' }]}
              placeholder={t('community.description') || 'Description (optional)'}
              placeholderTextColor={isDark ? '#555' : '#aaa'}
              value={createDesc}
              onChangeText={setCreateDesc}
              maxLength={500}
              multiline
              numberOfLines={3}
            />
            <PressableScale
              style={[styles.createBtn, !createName.trim() && styles.createBtnDisabled]}
              onPress={handleCreate}
              disabled={creating || !createName.trim()}
              haptic="medium"
              accessibilityRole="button"
            >
              {creating ? <ActivityIndicator size="small" color="#fff" /> : (
                <Text style={styles.createBtnText}>{t('community.create') || 'Create'}</Text>
              )}
            </PressableScale>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Announcement Modal */}
      <Modal visible={!!announceCommunity} transparent animationType="slide" onRequestClose={() => setAnnounceCommunity(null)}>
        {/* [fix 2026-07-05] KeyboardAvoidingView — same bottom-sheet + autoFocus keyboard trap. */}
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.surface || (isDark ? '#161616' : '#fff') }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>{t('community.announcement') || 'Announcement'}</Text>
              <TouchableOpacity onPress={() => setAnnounceCommunity(null)}><IconX size={22} color={isDark ? '#888' : '#666'} /></TouchableOpacity>
            </View>
            {announceCommunity && (
              <Text style={[styles.announceTo, { color: isDark ? '#8b8fa3' : '#6b7280' }]}>
                {announceCommunity.name} ({announceCommunity.group_count} {t('community.groups') || 'groups'})
              </Text>
            )}
            <TextInput
              style={[styles.input, styles.inputMulti, { color: colors.text, borderColor: isDark ? '#333' : '#ddd', backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#f9f9f9' }]}
              placeholder={t('community.announcementPlaceholder') || 'Write an announcement...'}
              placeholderTextColor={isDark ? '#555' : '#aaa'}
              value={announceText}
              onChangeText={setAnnounceText}
              maxLength={4000}
              multiline
              numberOfLines={4}
              autoFocus
            />
            <PressableScale
              style={[styles.createBtn, !announceText.trim() && styles.createBtnDisabled]}
              onPress={handleAnnounce}
              disabled={announcing || !announceText.trim()}
              haptic="medium"
              accessibilityRole="button"
            >
              {announcing ? <ActivityIndicator size="small" color="#fff" /> : (
                <Text style={styles.createBtnText}>{t('community.sendAnnouncement') || 'Enviar'}</Text>
              )}
            </PressableScale>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Add Group Modal */}
      <Modal visible={!!addGroupCommunity} transparent animationType="slide" onRequestClose={() => setAddGroupCommunity(null)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.surface || (isDark ? '#161616' : '#fff'), maxHeight: '70%' }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>{t('community.selectGroups') || 'Select groups'}</Text>
              <TouchableOpacity onPress={() => setAddGroupCommunity(null)}><IconX size={22} color={isDark ? '#888' : '#666'} /></TouchableOpacity>
            </View>
            {loadingGroups ? (
              <ActivityIndicator size="large" color={ACCENT} style={{ marginVertical: 20 }} />
            ) : userGroups.length === 0 ? (
              <Text style={[styles.emptyText, { color: isDark ? '#555' : '#999', textAlign: 'center', marginVertical: 20 }]}>
                {t('community.noGroups') || 'No groups found'}
              </Text>
            ) : (
              <FlatList
                data={userGroups}
                keyExtractor={item => String(item.id)}
                style={{ maxHeight: 400 }}
                renderItem={({ item: group }) => (
                  <PressableRow
                    style={[styles.groupPickRow, { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}
                    onPress={() => addGroupCommunity && handleAddGroup(addGroupCommunity.id, group.id)}
                  >
                    <View style={[styles.groupDot, { backgroundColor: colors.text }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.groupName, { color: colors.text }]} numberOfLines={1}>{group.name || group.display_name || 'Group'}</Text>
                      <Text style={[styles.groupMembers, { color: isDark ? '#666' : '#999' }]}>{group.member_count || 0} {t('community.members') || 'members'}</Text>
                    </View>
                    <IconPlus size={18} color={colors.text} />
                  </PressableRow>
                )}
              />
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { justifyContent: 'center', alignItems: 'center' },
  communityCard: {
    marginHorizontal: 12,
    marginTop: 10,
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  communityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
  },
  communityIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  communityInitial: {
    fontSize: 20,
    fontWeight: '700',
  },
  communityInfo: { flex: 1 },
  communityName: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 2,
  },
  communityMeta: {
    fontSize: 13,
  },
  expandArrow: {
    padding: 4,
  },
  expandArrowUp: {
    transform: [{ rotate: '180deg' }],
  },
  expandedSection: {
    paddingHorizontal: 14,
    paddingBottom: 14,
    borderTopWidth: 1,
  },
  description: {
    fontSize: 13,
    marginTop: 10,
    lineHeight: 18,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    marginTop: 10,
  },
  groupsList: { marginTop: 4 },
  groupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderRadius: 10,
    marginBottom: 4,
  },
  groupDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 10,
  },
  groupName: {
    fontSize: 14,
    fontWeight: '500',
  },
  groupMembers: {
    fontSize: 12,
    marginTop: 1,
  },
  removeBtn: {
    padding: 6,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
  },
  actionText: {
    fontSize: 13,
    fontWeight: '600',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginTop: 16,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
    lineHeight: 20,
  },
  emptyText: {
    fontSize: 13,
    marginVertical: 12,
  },
  fab: {
    position: 'absolute',
    bottom: 20,
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: ACCENT,
    justifyContent: 'center',
    alignItems: 'center',
    ...Platform.select({
      web: { boxShadow: '0 4px 12px rgba(17, 17, 17,0.4)' },
      default: { elevation: 6 },
    }),
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 40,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    marginBottom: 12,
  },
  inputMulti: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  createBtn: {
    backgroundColor: ACCENT,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  createBtnDisabled: {
    opacity: 0.5,
  },
  createBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  announceTo: {
    fontSize: 13,
    marginBottom: 12,
  },
  groupPickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderBottomWidth: 1,
  },
});
