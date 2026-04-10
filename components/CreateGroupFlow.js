import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput,
  FlatList, ActivityIndicator, Alert, Platform, ScrollView,
  KeyboardAvoidingView, Modal,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import { IconArrowLeft, IconSearch, IconX, IconUsers, IconCheck, IconPlus } from './Icons';
import AvatarCircle from './AvatarCircle';
import Svg, { Path, Circle as SvgCircle } from 'react-native-svg';

const ACCENT = '#7C3AED';
const isWeb = Platform.OS === 'web';

function IconCamera({ size = 24, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
      <SvgCircle cx="12" cy="13" r="4" />
    </Svg>
  );
}

function safeAlert(title, message, buttons) {
  if (Platform.OS === 'web') {
    if (buttons?.length) {
      const ok = buttons.find(b => b.style !== 'cancel');
      if (ok?.onPress && window.confirm(`${title}\n${message || ''}`)) ok.onPress();
    } else { try { window.alert(message || title); } catch {} }
  } else { Alert.alert(title, message, buttons); }
}

export default function CreateGroupFlow({ visible, onClose, onCreated, mode = 'group' }) {
  const { colors, isDark } = useTheme();
  const { user } = useAuth();
  const { t } = useLanguage();

  const [step, setStep] = useState(1);
  const [selectedMembers, setSelectedMembers] = useState([]);
  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  // Step 2 fields
  const [groupName, setGroupName] = useState('');
  const [groupDescription, setGroupDescription] = useState('');
  const [isPublic, setIsPublic] = useState(true);

  const searchTimer = useRef(null);
  const isChannel = mode === 'channel';

  useEffect(() => {
    if (!visible) {
      setStep(1);
      setSelectedMembers([]);
      setSearchText('');
      setGroupName('');
      setGroupDescription('');
      setIsPublic(true);
      setSearchResults([]);
      return;
    }
    // If channel mode, skip step 1 (no member selection needed)
    if (isChannel) setStep(2);

    setLoading(true);
    api.chatyyUsers('', 200).then(r => {
      if (r.success) {
        const users = (r.data?.users || []).filter(u => u.email !== user?.email);
        setAllUsers(users);
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, [visible, user?.email, isChannel]);

  const handleSearch = useCallback((text) => {
    setSearchText(text);
    if (!text.trim()) {
      setSearchResults([]);
      return;
    }
    const q = text.toLowerCase();
    const results = allUsers.filter(u => {
      const name = (u.name || '').toLowerCase();
      const email = (u.email || '').toLowerCase();
      return name.includes(q) || email.includes(q);
    });
    setSearchResults(results);
  }, [allUsers]);

  const toggleMember = useCallback((contact) => {
    setSelectedMembers(prev => {
      const exists = prev.find(m => m.email === contact.email);
      if (exists) return prev.filter(m => m.email !== contact.email);
      return [...prev, { email: contact.email, name: contact.name || contact.email }];
    });
  }, []);

  const isSelected = useCallback((email) => {
    return selectedMembers.some(m => m.email === email);
  }, [selectedMembers]);

  const handleNext = () => {
    if (step === 1) {
      if (selectedMembers.length === 0) {
        safeAlert('', t('group.minMembers'));
        return;
      }
      setStep(2);
    }
  };

  const handleBack = () => {
    if (step === 2 && !isChannel) {
      setStep(1);
    } else {
      onClose();
    }
  };

  const handleCreate = async () => {
    if (creating) return;
    const name = groupName.trim();
    if (!name) {
      safeAlert('', isChannel ? t('channel.name') : t('group.name'));
      return;
    }

    setCreating(true);
    try {
      let result;
      if (isChannel) {
        result = await api.chatCreateChannel(name, groupDescription.trim(), isPublic);
      } else {
        const members = selectedMembers.map(m => m.email);
        result = await api.chatCreate(members, name, 'group');
      }
      if (result.success) {
        const convId = result.data?.conversation_id || result.data?.id;
        const convName = result.data?.name || name;
        onCreated?.({
          id: convId,
          name: convName,
          type: isChannel ? 'channel' : 'group',
        });
      } else {
        safeAlert(t('common.error'), result?.message || 'Error');
      }
    } catch {
      safeAlert(t('common.error'), t('common.networkError'));
    } finally {
      setCreating(false);
    }
  };

  const displayList = searchText.trim() ? searchResults : allUsers;

  const renderContactItem = ({ item }) => {
    const selected = isSelected(item.email);
    return (
      <TouchableOpacity
        style={[sty.contactRow, { borderBottomColor: isDark ? '#222' : '#f0f0f0' }]}
        onPress={() => toggleMember(item)}
        activeOpacity={0.7}
      >
        <AvatarCircle email={item.email} name={item.name || item.email} size={44} />
        <View style={sty.contactInfo}>
          <Text style={[sty.contactName, { color: colors.text }]} numberOfLines={1}>
            {item.name || item.email?.split('@')[0]}
          </Text>
          <Text style={[sty.contactEmail, { color: colors.textTertiary }]} numberOfLines={1}>
            {item.email}
          </Text>
        </View>
        <View style={[sty.checkbox, {
          backgroundColor: selected ? ACCENT : 'transparent',
          borderColor: selected ? ACCENT : (isDark ? '#555' : '#ccc'),
        }]}>
          {selected && <IconCheck size={14} color="#fff" />}
        </View>
      </TouchableOpacity>
    );
  };

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleBack} transparent={false}>
      <KeyboardAvoidingView
        style={[sty.container, { backgroundColor: colors.background }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Header */}
        <View style={[sty.header, { backgroundColor: isDark ? '#1F2C33' : '#6D28D9' }]}>
          <TouchableOpacity onPress={handleBack} style={sty.headerBtn}>
            <IconArrowLeft size={22} color="#fff" />
          </TouchableOpacity>
          <View style={sty.headerCenter}>
            <Text style={sty.headerTitle}>
              {isChannel ? t('channel.create') : t('group.create')}
            </Text>
            {step === 1 && (
              <Text style={sty.headerSubtitle}>
                {t('group.step1')} - {t('group.membersSelected').replace('{count}', String(selectedMembers.length))}
              </Text>
            )}
            {step === 2 && !isChannel && (
              <Text style={sty.headerSubtitle}>{t('group.step2')}</Text>
            )}
          </View>
          {step === 1 && (
            <TouchableOpacity
              onPress={handleNext}
              style={[sty.nextBtn, { opacity: selectedMembers.length > 0 ? 1 : 0.5 }]}
              disabled={selectedMembers.length === 0}
            >
              <Text style={sty.nextBtnText}>{t('group.next')}</Text>
            </TouchableOpacity>
          )}
          {step === 2 && (
            <TouchableOpacity
              onPress={handleCreate}
              style={[sty.nextBtn, { opacity: groupName.trim() ? 1 : 0.5 }]}
              disabled={!groupName.trim() || creating}
            >
              {creating ? (
                <ActivityIndicator size={16} color="#fff" />
              ) : (
                <Text style={sty.nextBtnText}>{t('group.done')}</Text>
              )}
            </TouchableOpacity>
          )}
        </View>

        {/* Step indicators */}
        {!isChannel && (
          <View style={[sty.stepIndicator, { backgroundColor: isDark ? '#111' : '#f5f5f5' }]}>
            <View style={[sty.stepDot, step >= 1 && sty.stepDotActive]} />
            <View style={[sty.stepLine, step >= 2 && sty.stepLineActive]} />
            <View style={[sty.stepDot, step >= 2 && sty.stepDotActive]} />
          </View>
        )}

        {/* STEP 1: Member selection */}
        {step === 1 && (
          <View style={{ flex: 1 }}>
            {/* Selected members chips */}
            {selectedMembers.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={[sty.chipsRow, { borderBottomColor: isDark ? '#222' : '#eee' }]}
                contentContainerStyle={sty.chipsContent}
              >
                {selectedMembers.map(m => (
                  <TouchableOpacity
                    key={m.email}
                    style={[sty.chip, { backgroundColor: ACCENT + '18', borderColor: ACCENT + '40' }]}
                    onPress={() => toggleMember(m)}
                  >
                    <AvatarCircle email={m.email} name={m.name} size={24} />
                    <Text style={[sty.chipText, { color: ACCENT }]} numberOfLines={1}>
                      {(m.name || m.email).split('@')[0].split(' ')[0]}
                    </Text>
                    <IconX size={14} color={ACCENT} />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}

            {/* Search */}
            <View style={[sty.searchWrap, { backgroundColor: isDark ? '#1a1a1a' : '#f2f2f7' }]}>
              <IconSearch size={18} color={colors.textTertiary} />
              <TextInput
                style={[sty.searchInput, { color: colors.text }]}
                placeholder={t('group.searchMembers')}
                placeholderTextColor={colors.textTertiary}
                value={searchText}
                onChangeText={handleSearch}
                autoCapitalize="none"
              />
              {searchText ? (
                <TouchableOpacity onPress={() => { setSearchText(''); setSearchResults([]); }}>
                  <IconX size={16} color={colors.textTertiary} />
                </TouchableOpacity>
              ) : null}
            </View>

            {/* Contacts list */}
            {loading ? (
              <View style={sty.loader}>
                <ActivityIndicator size="large" color={ACCENT} />
              </View>
            ) : (
              <FlatList
                data={displayList}
                keyExtractor={(item) => item.email}
                renderItem={renderContactItem}
                contentContainerStyle={{ paddingBottom: 20 }}
                ListEmptyComponent={
                  <View style={sty.empty}>
                    <Text style={[sty.emptyText, { color: colors.textTertiary }]}>
                      {searchText ? t('chat.noContactsFound') : ''}
                    </Text>
                  </View>
                }
              />
            )}
          </View>
        )}

        {/* STEP 2: Group/Channel details */}
        {step === 2 && (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={sty.step2Content}>
            {/* Photo circle placeholder */}
            <TouchableOpacity style={[sty.photoCircle, { backgroundColor: isDark ? '#222' : '#e8e8e8' }]}>
              <IconCamera size={32} color={isDark ? '#888' : '#999'} />
              <Text style={[sty.photoLabel, { color: isDark ? '#888' : '#999' }]}>
                {isChannel ? t('channel.name') : t('group.photo')}
              </Text>
            </TouchableOpacity>

            {/* Name input */}
            <View style={sty.inputGroup}>
              <Text style={[sty.inputLabel, { color: colors.textSecondary }]}>
                {isChannel ? t('channel.name') : t('group.name')}
              </Text>
              <TextInput
                style={[sty.textInput, {
                  color: colors.text,
                  backgroundColor: isDark ? '#1a1a1a' : '#f5f5f7',
                  borderColor: isDark ? '#333' : '#e0e0e0',
                }]}
                placeholder={isChannel ? t('channel.name') : t('group.namePlaceholder')}
                placeholderTextColor={colors.textTertiary}
                value={groupName}
                onChangeText={setGroupName}
                maxLength={100}
                autoFocus
              />
            </View>

            {/* Description input */}
            <View style={sty.inputGroup}>
              <Text style={[sty.inputLabel, { color: colors.textSecondary }]}>
                {isChannel ? t('channel.description') : t('group.description')}
              </Text>
              <TextInput
                style={[sty.textInput, sty.textArea, {
                  color: colors.text,
                  backgroundColor: isDark ? '#1a1a1a' : '#f5f5f7',
                  borderColor: isDark ? '#333' : '#e0e0e0',
                }]}
                placeholder={t('group.descriptionPlaceholder')}
                placeholderTextColor={colors.textTertiary}
                value={groupDescription}
                onChangeText={setGroupDescription}
                multiline
                numberOfLines={3}
                maxLength={1000}
              />
            </View>

            {/* Channel: Public/Private toggle */}
            {isChannel && (
              <View style={sty.inputGroup}>
                <Text style={[sty.inputLabel, { color: colors.textSecondary }]}>
                  {t('channel.public')} / {t('channel.private')}
                </Text>
                <View style={sty.toggleRow}>
                  <TouchableOpacity
                    style={[sty.toggleOption, isPublic && { backgroundColor: ACCENT }]}
                    onPress={() => setIsPublic(true)}
                  >
                    <Text style={[sty.toggleOptionText, isPublic && { color: '#fff' }]}>
                      {t('channel.public')}
                    </Text>
                    <Text style={[sty.toggleOptionDesc, isPublic && { color: 'rgba(255,255,255,0.7)' }, { color: colors.textTertiary }]} numberOfLines={1}>
                      {t('channel.publicDesc')}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[sty.toggleOption, !isPublic && { backgroundColor: ACCENT }]}
                    onPress={() => setIsPublic(false)}
                  >
                    <Text style={[sty.toggleOptionText, !isPublic && { color: '#fff' }]}>
                      {t('channel.private')}
                    </Text>
                    <Text style={[sty.toggleOptionDesc, !isPublic && { color: 'rgba(255,255,255,0.7)' }, { color: colors.textTertiary }]} numberOfLines={1}>
                      {t('channel.privateDesc')}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Selected members summary (group only) */}
            {!isChannel && selectedMembers.length > 0 && (
              <View style={sty.inputGroup}>
                <Text style={[sty.inputLabel, { color: colors.textSecondary }]}>
                  {t('group.addMembers')} ({selectedMembers.length})
                </Text>
                <View style={sty.membersList}>
                  {selectedMembers.map(m => (
                    <View key={m.email} style={[sty.memberRow, { borderBottomColor: isDark ? '#222' : '#f0f0f0' }]}>
                      <AvatarCircle email={m.email} name={m.name} size={36} />
                      <Text style={[sty.memberName, { color: colors.text }]} numberOfLines={1}>
                        {m.name || m.email.split('@')[0]}
                      </Text>
                      <TouchableOpacity onPress={() => toggleMember(m)}>
                        <IconX size={18} color={colors.textTertiary} />
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              </View>
            )}
          </ScrollView>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const sty = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    paddingTop: Platform.OS === 'ios' ? 54 : 12,
    gap: 8,
  },
  headerBtn: { padding: 8, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.1)' },
  headerCenter: { flex: 1 },
  headerTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  headerSubtitle: { color: 'rgba(255,255,255,0.7)', fontSize: 13, marginTop: 2 },
  nextBtn: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 20,
  },
  nextBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  stepIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    gap: 0,
  },
  stepDot: {
    width: 10, height: 10, borderRadius: 5,
    backgroundColor: '#ccc',
  },
  stepDotActive: { backgroundColor: ACCENT },
  stepLine: {
    width: 40, height: 2,
    backgroundColor: '#ccc',
  },
  stepLineActive: { backgroundColor: ACCENT },
  chipsRow: {
    maxHeight: 56,
    borderBottomWidth: 1,
  },
  chipsContent: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
    flexDirection: 'row',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
    paddingRight: 10,
    paddingLeft: 4,
    paddingVertical: 4,
    gap: 6,
    borderWidth: 1,
  },
  chipText: { fontSize: 13, fontWeight: '600', maxWidth: 80 },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginVertical: 10,
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 40,
    gap: 8,
  },
  searchInput: {
    flex: 1, fontSize: 15, padding: 0,
    ...(isWeb ? { outlineStyle: 'none' } : {}),
  },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 0.5,
    gap: 12,
  },
  contactInfo: { flex: 1 },
  contactName: { fontSize: 16, fontWeight: '500' },
  contactEmail: { fontSize: 13, marginTop: 1 },
  checkbox: {
    width: 24, height: 24, borderRadius: 12,
    borderWidth: 2, alignItems: 'center', justifyContent: 'center',
  },
  loader: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 40 },
  emptyText: { fontSize: 15 },
  step2Content: { padding: 20, paddingBottom: 40 },
  photoCircle: {
    width: 100, height: 100, borderRadius: 50,
    alignSelf: 'center',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 24,
  },
  photoLabel: { fontSize: 11, marginTop: 4, fontWeight: '600' },
  inputGroup: { marginBottom: 20 },
  inputLabel: { fontSize: 13, fontWeight: '600', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  textInput: {
    borderWidth: 1, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 16,
    ...(isWeb ? { outlineStyle: 'none' } : {}),
  },
  textArea: { height: 80, textAlignVertical: 'top' },
  toggleRow: { flexDirection: 'row', gap: 10 },
  toggleOption: {
    flex: 1, borderRadius: 12, padding: 14,
    backgroundColor: 'rgba(0,0,0,0.04)',
    borderWidth: 1, borderColor: 'transparent',
  },
  toggleOptionText: { fontSize: 15, fontWeight: '700' },
  toggleOptionDesc: { fontSize: 12, marginTop: 4 },
  membersList: { marginTop: 8 },
  memberRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 8, borderBottomWidth: 0.5, gap: 10,
  },
  memberName: { flex: 1, fontSize: 15 },
});
