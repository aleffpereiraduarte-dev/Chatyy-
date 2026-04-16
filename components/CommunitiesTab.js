import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl,
  ActivityIndicator, TextInput, Modal, Alert, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconPlus, IconUsers, IconX, IconMessageSquare } from './Icons';
import AvatarCircle from './AvatarCircle';
import Svg, { Path, Rect, Circle } from 'react-native-svg';
import * as api from '../services/api';

const ACCENT = '#7C3AED';

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
      if (res?.data?.success && Array.isArray(res.data.data)) {
        setCommunities(res.data.data);
      }
    } catch {} finally {
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
  const toggleExpand = useCallback(async (id) => {
    if (expandedId === id) {
      setExpandedId(null);
      setExpandedData(null);
      return;
    }
    const seq = ++expandSeqRef.current;
    setExpandedId(id);
    setLoadingInfo(true);
    try {
      const res = await api.communityInfo(id);
      // Only apply if this is still the latest expand request (race guard)
      if (seq !== expandSeqRef.current) return;
      if (res?.data?.success) {
        setExpandedData(res.data.data);
      }
    } catch {} finally {
      if (seq === expandSeqRef.current) setLoadingInfo(false);
    }
  }, [expandedId]);

  const handleCreate = useCallback(async () => {
    if (!createName.trim()) return;
    setCreating(true);
    try {
      const res = await api.communityCreate(createName.trim(), createDesc.trim());
      if (res?.data?.success) {
        setShowCreate(false);
        setCreateName('');
        setCreateDesc('');
        loadCommunities();
      } else {
        Alert.alert('Error', res?.data?.message || 'Failed to create community');
      }
    } catch {
      Alert.alert('Error', 'Failed to create community');
    } finally {
      setCreating(false);
    }
  }, [createName, createDesc, loadCommunities]);

  const handleAnnounce = useCallback(async () => {
    if (!announceText.trim() || !announceCommunity) return;
    setAnnouncing(true);
    try {
      const res = await api.communityAnnouncement(announceCommunity.id, announceText.trim());
      if (res?.data?.success) {
        const count = res.data.data?.sent_to || 0;
        Alert.alert(t('community.announcement'), (t('community.sentTo') || 'Sent to {count} groups').replace('{count}', count));
        setAnnounceCommunity(null);
        setAnnounceText('');
      } else {
        Alert.alert('Error', res?.data?.message || 'Failed');
      }
    } catch {
      Alert.alert('Error', 'Failed to send announcement');
    } finally {
      setAnnouncing(false);
    }
  }, [announceText, announceCommunity, t]);

  const handleAddGroup = useCallback(async (communityId, conversationId) => {
    try {
      const res = await api.communityAddGroup(communityId, conversationId);
      if (res?.data?.success) {
        setAddGroupCommunity(null);
        // Refresh expanded info
        if (expandedId === communityId) {
          toggleExpand(null);
          setTimeout(() => toggleExpand(communityId), 100);
        }
        loadCommunities();
      } else {
        Alert.alert('Error', res?.data?.message || 'Failed');
      }
    } catch {
      Alert.alert('Error', 'Failed to add group');
    }
  }, [expandedId, toggleExpand, loadCommunities]);

  const handleRemoveGroup = useCallback(async (communityId, conversationId) => {
    try {
      const res = await api.communityRemoveGroup(communityId, conversationId);
      if (res?.data?.success) {
        if (expandedId === communityId) {
          toggleExpand(null);
          setTimeout(() => toggleExpand(communityId), 100);
        }
        loadCommunities();
      }
    } catch {}
  }, [expandedId, toggleExpand, loadCommunities]);

  const openAddGroup = useCallback(async (community) => {
    setAddGroupCommunity(community);
    setLoadingGroups(true);
    try {
      const res = await api.chatConversations();
      if (res?.data?.success && Array.isArray(res.data.data)) {
        const groups = res.data.data.filter(c => c.type === 'group' || c.type === 'channel');
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
      <View style={[styles.communityCard, { backgroundColor: isDark ? '#1a1a2e' : '#fff', borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}>
        <TouchableOpacity onPress={() => toggleExpand(item.id)} activeOpacity={0.7} style={styles.communityRow}>
          <View style={[styles.communityIcon, { backgroundColor: ACCENT + '22' }]}>
            {item.icon_url ? (
              <AvatarCircle email="" imageUrl={item.icon_url} size={48} />
            ) : (
              <Text style={[styles.communityInitial, { color: ACCENT }]}>{initial}</Text>
            )}
          </View>
          <View style={styles.communityInfo}>
            <Text style={[styles.communityName, { color: colors.text }]} numberOfLines={1}>{item.name}</Text>
            <Text style={[styles.communityMeta, { color: isDark ? '#8b8fa3' : '#6b7280' }]}>
              {item.group_count} {t('community.groups') || 'Groups'} · {item.member_count} {t('community.members') || 'Members'}
              {isAdmin ? (' · ' + (t('community.admin') || 'Admin')) : ''}
            </Text>
          </View>
          <View style={[styles.expandArrow, isExpanded && styles.expandArrowUp]}>
            <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={isDark ? '#666' : '#999'} strokeWidth={2}>
              <Path d="M6 9l6 6 6-6" />
            </Svg>
          </View>
        </TouchableOpacity>

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
                  <TouchableOpacity
                    key={g.conversation_id}
                    style={[styles.groupRow, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)' }]}
                    onPress={() => router.push({ pathname: '/chat-conversation', params: { id: g.conversation_id, name: g.name || '' } })}
                    activeOpacity={0.7}
                  >
                    <View style={[styles.groupDot, { backgroundColor: ACCENT }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.groupName, { color: colors.text }]} numberOfLines={1}>{g.name || 'Group'}</Text>
                      <Text style={[styles.groupMembers, { color: isDark ? '#666' : '#999' }]}>{g.member_count} {t('community.members') || 'members'}</Text>
                    </View>
                    {isAdmin && (
                      <TouchableOpacity
                        onPress={() => {
                          Alert.alert(
                            t('community.removeGroup') || 'Remove group',
                            `Remove "${g.name}" from this community?`,
                            [
                              { text: 'Cancel', style: 'cancel' },
                              { text: 'Remove', style: 'destructive', onPress: () => handleRemoveGroup(item.id, g.conversation_id) },
                            ]
                          );
                        }}
                        style={styles.removeBtn}
                      >
                        <IconX size={14} color="#ef4444" />
                      </TouchableOpacity>
                    )}
                  </TouchableOpacity>
                ))}
              </View>
            ) : (
              <Text style={[styles.emptyText, { color: isDark ? '#555' : '#999' }]}>{t('community.noGroups') || 'No groups'}</Text>
            )}

            {/* Action buttons */}
            {isAdmin && (
              <View style={styles.actions}>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: ACCENT + '18' }]}
                  onPress={() => openAddGroup(item)}
                  activeOpacity={0.7}
                >
                  <IconPlus size={16} color={ACCENT} />
                  <Text style={[styles.actionText, { color: ACCENT }]}>{t('community.addGroup') || 'Add group'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: '#f59e0b18' }]}
                  onPress={() => { setAnnounceCommunity(item); setAnnounceText(''); }}
                  activeOpacity={0.7}
                >
                  <IconMegaphone size={16} color="#f59e0b" />
                  <Text style={[styles.actionText, { color: '#f59e0b' }]}>{t('community.announcement') || 'Announce'}</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}
      </View>
    );
  }, [expandedId, expandedData, loadingInfo, isDark, colors, t, router, toggleExpand, handleRemoveGroup, openAddGroup]);

  if (loading) {
    return (
      <View style={[styles.center, { flex: 1, backgroundColor: isDark ? '#0a0a0f' : '#f5f5f7' }]}>
        <ActivityIndicator size="large" color={ACCENT} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: isDark ? '#0a0a0f' : '#f5f5f7' }]}>
      <FlatList
        data={communities}
        keyExtractor={item => String(item.id)}
        renderItem={renderCommunity}
        contentContainerStyle={communities.length === 0 ? { flex: 1 } : { paddingBottom: 80 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} colors={[ACCENT]} />}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <IconCommunity size={64} color={isDark ? '#333' : '#ccc'} />
            <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('community.noCommunities') || 'No communities'}</Text>
            <Text style={[styles.emptySubtitle, { color: isDark ? '#666' : '#999' }]}>{t('community.createFirst') || 'Create a community to organize your groups'}</Text>
          </View>
        }
      />

      {/* FAB */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => { setShowCreate(true); setCreateName(''); setCreateDesc(''); }}
        activeOpacity={0.8}
      >
        <IconPlus size={24} color="#fff" />
      </TouchableOpacity>

      {/* Create Modal */}
      <Modal visible={showCreate} transparent animationType="slide" onRequestClose={() => setShowCreate(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: isDark ? '#1a1a2e' : '#fff' }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>{t('community.create') || 'Create community'}</Text>
              <TouchableOpacity onPress={() => setShowCreate(false)}><IconX size={22} color={isDark ? '#888' : '#666'} /></TouchableOpacity>
            </View>
            <TextInput
              style={[styles.input, { color: colors.text, borderColor: isDark ? '#333' : '#ddd', backgroundColor: isDark ? '#0f0f1a' : '#f9f9f9' }]}
              placeholder={t('community.name') || 'Community name'}
              placeholderTextColor={isDark ? '#555' : '#aaa'}
              value={createName}
              onChangeText={setCreateName}
              maxLength={100}
              autoFocus
            />
            <TextInput
              style={[styles.input, styles.inputMulti, { color: colors.text, borderColor: isDark ? '#333' : '#ddd', backgroundColor: isDark ? '#0f0f1a' : '#f9f9f9' }]}
              placeholder={t('community.description') || 'Description (optional)'}
              placeholderTextColor={isDark ? '#555' : '#aaa'}
              value={createDesc}
              onChangeText={setCreateDesc}
              maxLength={500}
              multiline
              numberOfLines={3}
            />
            <TouchableOpacity
              style={[styles.createBtn, !createName.trim() && styles.createBtnDisabled]}
              onPress={handleCreate}
              disabled={creating || !createName.trim()}
              activeOpacity={0.7}
            >
              {creating ? <ActivityIndicator size="small" color="#fff" /> : (
                <Text style={styles.createBtnText}>{t('community.create') || 'Create'}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Announcement Modal */}
      <Modal visible={!!announceCommunity} transparent animationType="slide" onRequestClose={() => setAnnounceCommunity(null)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: isDark ? '#1a1a2e' : '#fff' }]}>
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
              style={[styles.input, styles.inputMulti, { color: colors.text, borderColor: isDark ? '#333' : '#ddd', backgroundColor: isDark ? '#0f0f1a' : '#f9f9f9' }]}
              placeholder={t('community.announcementPlaceholder') || 'Write an announcement...'}
              placeholderTextColor={isDark ? '#555' : '#aaa'}
              value={announceText}
              onChangeText={setAnnounceText}
              maxLength={4000}
              multiline
              numberOfLines={4}
              autoFocus
            />
            <TouchableOpacity
              style={[styles.createBtn, !announceText.trim() && styles.createBtnDisabled]}
              onPress={handleAnnounce}
              disabled={announcing || !announceText.trim()}
              activeOpacity={0.7}
            >
              {announcing ? <ActivityIndicator size="small" color="#fff" /> : (
                <Text style={styles.createBtnText}>{t('community.sendAnnouncement') || 'Send'}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Add Group Modal */}
      <Modal visible={!!addGroupCommunity} transparent animationType="slide" onRequestClose={() => setAddGroupCommunity(null)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: isDark ? '#1a1a2e' : '#fff', maxHeight: '70%' }]}>
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
                  <TouchableOpacity
                    style={[styles.groupPickRow, { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}
                    onPress={() => addGroupCommunity && handleAddGroup(addGroupCommunity.id, group.id)}
                    activeOpacity={0.7}
                  >
                    <View style={[styles.groupDot, { backgroundColor: ACCENT }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.groupName, { color: colors.text }]} numberOfLines={1}>{group.name || group.display_name || 'Group'}</Text>
                      <Text style={[styles.groupMembers, { color: isDark ? '#666' : '#999' }]}>{group.member_count || 0} {t('community.members') || 'members'}</Text>
                    </View>
                    <IconPlus size={18} color={ACCENT} />
                  </TouchableOpacity>
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
      web: { boxShadow: '0 4px 12px rgba(124,58,237,0.4)' },
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
