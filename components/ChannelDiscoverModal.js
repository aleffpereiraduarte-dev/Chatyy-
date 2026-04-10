import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput,
  FlatList, ActivityIndicator, Alert, Platform, Modal,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import { IconArrowLeft, IconSearch, IconX } from './Icons';
import AvatarCircle from './AvatarCircle';
import Svg, { Path, Rect } from 'react-native-svg';

const ACCENT = '#7C3AED';
const isWeb = Platform.OS === 'web';

function IconMegaphone({ size = 24, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M3 11l18-5v12L3 13v-2z" />
      <Path d="M11.6 16.8a3 3 0 11-5.8-1.6" />
    </Svg>
  );
}

function IconHashtag({ size = 20, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M4 9h16" />
      <Path d="M4 15h16" />
      <Path d="M10 3L8 21" />
      <Path d="M16 3l-2 18" />
    </Svg>
  );
}

function safeAlert(title, message) {
  if (Platform.OS === 'web') {
    try { window.alert(message || title); } catch {}
  } else {
    Alert.alert(title, message);
  }
}

export default function ChannelDiscoverModal({ visible, onClose, onJoined }) {
  const { colors, isDark } = useTheme();
  const { user } = useAuth();
  const { t } = useLanguage();

  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchText, setSearchText] = useState('');
  const [joiningId, setJoiningId] = useState(null);
  const searchTimer = useRef(null);

  const loadChannels = useCallback(async (search = '') => {
    setLoading(true);
    try {
      const r = await api.chatDiscoverChannels(search, 50, 0);
      if (r.success) {
        setChannels(r.data?.channels || []);
      }
    } catch {} finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) loadChannels();
  }, [visible, loadChannels]);

  const handleSearch = useCallback((text) => {
    setSearchText(text);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      loadChannels(text.trim());
    }, 400);
  }, [loadChannels]);

  const handleJoin = useCallback(async (channelId) => {
    setJoiningId(channelId);
    try {
      const r = await api.chatJoinChannel(channelId);
      if (r.success) {
        // Update local state
        setChannels(prev => prev.map(ch =>
          ch.id === channelId
            ? { ...ch, is_member: true, subscriber_count: (parseInt(ch.subscriber_count) || 0) + 1 }
            : ch
        ));
        onJoined?.(channelId);
      } else {
        safeAlert(t('common.error'), r.message || 'Error');
      }
    } catch {
      safeAlert(t('common.error'), t('common.networkError'));
    } finally {
      setJoiningId(null);
    }
  }, [t, onJoined]);

  const renderChannel = ({ item }) => {
    const subCount = parseInt(item.subscriber_count) || 0;
    const isMember = item.is_member;
    const isJoining = joiningId === item.id;

    return (
      <View style={[sty.channelRow, { borderBottomColor: isDark ? '#222' : '#f0f0f0' }]}>
        <View style={[sty.channelIcon, {
          backgroundColor: isDark ? 'rgba(124,58,237,0.15)' : 'rgba(124,58,237,0.1)',
        }]}>
          <IconHashtag size={22} color={ACCENT} />
        </View>
        <View style={sty.channelInfo}>
          <Text style={[sty.channelName, { color: colors.text }]} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={[sty.channelDesc, { color: colors.textTertiary }]} numberOfLines={2}>
            {item.description || t('channel.publicDesc')}
          </Text>
          <Text style={[sty.channelSubs, { color: colors.textTertiary }]}>
            {subCount} {t('channel.subscribers')}
          </Text>
        </View>
        {isMember ? (
          <View style={[sty.joinedBadge, { backgroundColor: ACCENT + '18' }]}>
            <Text style={[sty.joinedText, { color: ACCENT }]}>{t('channel.joined')}</Text>
          </View>
        ) : (
          <TouchableOpacity
            style={[sty.joinBtn, { backgroundColor: ACCENT }]}
            onPress={() => handleJoin(item.id)}
            disabled={isJoining}
            activeOpacity={0.7}
          >
            {isJoining ? (
              <ActivityIndicator size={14} color="#fff" />
            ) : (
              <Text style={sty.joinBtnText}>{t('channel.join')}</Text>
            )}
          </TouchableOpacity>
        )}
      </View>
    );
  };

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent={false}>
      <View style={[sty.container, { backgroundColor: colors.background }]}>
        {/* Header */}
        <View style={[sty.header, { backgroundColor: isDark ? '#1F2C33' : '#6D28D9' }]}>
          <TouchableOpacity onPress={onClose} style={sty.headerBtn}>
            <IconArrowLeft size={22} color="#fff" />
          </TouchableOpacity>
          <View style={sty.headerCenter}>
            <Text style={sty.headerTitle}>{t('channel.discover')}</Text>
            <Text style={sty.headerSubtitle}>{t('channel.discoverDesc')}</Text>
          </View>
        </View>

        {/* Search */}
        <View style={[sty.searchWrap, { backgroundColor: isDark ? '#1a1a1a' : '#f2f2f7' }]}>
          <IconSearch size={18} color={colors.textTertiary} />
          <TextInput
            style={[sty.searchInput, { color: colors.text }]}
            placeholder={t('channel.searchPlaceholder')}
            placeholderTextColor={colors.textTertiary}
            value={searchText}
            onChangeText={handleSearch}
            autoCapitalize="none"
          />
          {searchText ? (
            <TouchableOpacity onPress={() => { setSearchText(''); loadChannels(''); }}>
              <IconX size={16} color={colors.textTertiary} />
            </TouchableOpacity>
          ) : null}
        </View>

        {/* Channel list */}
        {loading ? (
          <View style={sty.loader}>
            <ActivityIndicator size="large" color={ACCENT} />
          </View>
        ) : (
          <FlatList
            data={channels}
            keyExtractor={(item) => String(item.id)}
            renderItem={renderChannel}
            contentContainerStyle={channels.length === 0 ? { flexGrow: 1 } : { paddingBottom: 20 }}
            ListEmptyComponent={
              <View style={sty.empty}>
                <IconMegaphone size={48} color={isDark ? '#555' : '#ccc'} />
                <Text style={[sty.emptyTitle, { color: colors.text }]}>
                  {t('channel.noChannels')}
                </Text>
                <Text style={[sty.emptyDesc, { color: colors.textTertiary }]}>
                  {t('channel.discoverDesc')}
                </Text>
              </View>
            }
          />
        )}
      </View>
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
  channelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 0.5,
    gap: 12,
  },
  channelIcon: {
    width: 48, height: 48, borderRadius: 24,
    alignItems: 'center', justifyContent: 'center',
  },
  channelInfo: { flex: 1 },
  channelName: { fontSize: 16, fontWeight: '600' },
  channelDesc: { fontSize: 13, marginTop: 2, lineHeight: 18 },
  channelSubs: { fontSize: 12, marginTop: 4 },
  joinBtn: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 20,
    minWidth: 70,
    alignItems: 'center',
  },
  joinBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  joinedBadge: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
  },
  joinedText: { fontSize: 13, fontWeight: '600' },
  loader: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
    gap: 12,
  },
  emptyTitle: { fontSize: 18, fontWeight: '700', marginTop: 8 },
  emptyDesc: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
});
