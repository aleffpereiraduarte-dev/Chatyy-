import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconStar, IconMessageSquare } from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';
import * as api from '../services/api';

export default function StarredMessagesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();

  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.apiCall('chat_starred_messages');
      if (r?.success && r.data) {
        const list = Array.isArray(r.data) ? r.data : (r.data.messages || []);
        setMessages(list);
      }
    } catch (e) { console.warn('[starred] load:', e); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const openConversation = (msg) => {
    if (!msg?.conversation_id) return;
    try {
      router.push(`/chat-conversation?id=${msg.conversation_id}&name=${encodeURIComponent(msg.conversation_name || '')}&type=${msg.conversation_type || 'direct'}&email=${encodeURIComponent(msg.sender_email || '')}`);
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

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { backgroundColor: isDark ? '#1a1a2e' : '#7C3AED', paddingTop: 10 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <IconArrowLeft size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>{t('starred.title') || 'Starred messages'}</Text>
      </View>

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color="#7C3AED" size="large" />
        </View>
      ) : messages.length === 0 ? (
        <View style={styles.empty}>
          <IconStar size={56} color={isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)'} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>
            {t('starred.empty') || 'No starred messages yet'}
          </Text>
          <Text style={[styles.emptySubtitle, { color: colors.secondaryText }]}>
            {t('starred.emptyHint') || 'Tap and hold any message to star it.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={messages}
          keyExtractor={(m) => String(m.id)}
          renderItem={({ item }) => (
            <TouchableOpacity onPress={() => openConversation(item)} style={[styles.row, { borderBottomColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }]}>
              <AvatarCircle name={item.sender_name || item.sender_email} email={item.sender_email} size={44} />
              <View style={styles.rowBody}>
                <View style={styles.rowHead}>
                  <Text style={[styles.rowName, { color: colors.text }]} numberOfLines={1}>
                    {item.sender_name || item.sender_email}
                  </Text>
                  <Text style={[styles.rowTime, { color: colors.secondaryText }]}>
                    {formatDate(item.created_at)}
                  </Text>
                </View>
                {!!item.conversation_name && item.conversation_type === 'group' && (
                  <Text style={[styles.rowGroup, { color: colors.secondaryText }]} numberOfLines={1}>
                    {item.conversation_name}
                  </Text>
                )}
                <View style={styles.rowContent}>
                  <IconStar size={12} color="#FFC107" />
                  <Text style={[styles.rowPreview, { color: colors.secondaryText }]} numberOfLines={2}>
                    {item.content || ''}
                  </Text>
                </View>
              </View>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 14 },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontSize: 20, fontWeight: '700', marginLeft: 8 },
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
