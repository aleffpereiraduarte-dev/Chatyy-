// Close Friends — Instagram-style list to restrict stories/posts
import { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, Platform, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import AvatarCircle from '../components/AvatarCircle';
import { IconArrowLeft, IconSearch, IconStar } from '../components/Icons';
import { emailToDisplayName } from '../services/api';

export default function CloseFriendsScreen() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const [contacts, setContacts] = useState([]);
  const [closeFriends, setCloseFriends] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [cf, cs] = await Promise.all([
          api.closeFriendsList?.(),
          api.chatContacts?.(),
        ]);
        if (cf?.success) {
          const list = cf.data?.close_friends || cf.data?.list || [];
          setCloseFriends(new Set(list.map(f => f.friend_email || f.email || f)));
        }
        if (cs?.success) {
          const list = Array.isArray(cs.data) ? cs.data : (cs.data?.contacts || []);
          setContacts(list);
        }
      } catch {}
      setLoading(false);
    })();
  }, []);

  const toggle = useCallback(async (email) => {
    const isIn = closeFriends.has(email);
    // Optimistic
    const next = new Set(closeFriends);
    isIn ? next.delete(email) : next.add(email);
    setCloseFriends(next);
    try {
      if (isIn) await api.closeFriendsRemove(email);
      else await api.closeFriendsAdd(email);
    } catch {
      // Revert
      setCloseFriends(closeFriends);
    }
  }, [closeFriends]);

  const q = query.trim().toLowerCase();
  const filtered = contacts.filter(c => {
    const e = (c.email || c.friend_email || '').toLowerCase();
    const n = (c.name || c.display_name || '').toLowerCase();
    return !q || e.includes(q) || n.includes(q);
  });

  const countText = (t?.('closeFriends.count') || '{n} em amigos próximos').replace('{n}', closeFriends.size);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: Platform.OS === 'ios' ? 50 : 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
        <TouchableOpacity onPress={() => router.back()} style={{ padding: 8 }}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 4 }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>
            {t?.('closeFriends.title') || 'Amigos próximos'}
          </Text>
          <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>{countText}</Text>
        </View>
        <IconStar size={22} color="#22C55E" />
      </View>

      <View style={{ padding: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: isDark ? '#222' : '#f1f5f9', borderRadius: 12, paddingHorizontal: 12 }}>
          <IconSearch size={18} color={colors.textSecondary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t?.('common.search') || 'Buscar'}
            placeholderTextColor={colors.textSecondary}
            style={{ flex: 1, paddingVertical: 10, paddingHorizontal: 8, color: colors.text }}
          />
        </View>
      </View>

      {loading ? (
        <Text style={{ color: colors.textSecondary, textAlign: 'center', marginTop: 20 }}>{t?.('common.loading') || 'Carregando...'}</Text>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item, i) => (item.email || item.friend_email || '') + i}
          renderItem={({ item }) => {
            const email = item.email || item.friend_email;
            const name = item.name || item.display_name || emailToDisplayName?.(email) || email;
            const isIn = closeFriends.has(email);
            return (
              <TouchableOpacity
                onPress={() => toggle(email)}
                style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 16, gap: 12 }}
                activeOpacity={0.7}
              >
                <AvatarCircle name={name} email={email} size={48} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>{name}</Text>
                  <Text style={{ fontSize: 12, color: colors.textSecondary }}>{email}</Text>
                </View>
                <View style={{
                  width: 26, height: 26, borderRadius: 13,
                  borderWidth: 2, borderColor: isIn ? '#22C55E' : colors.border,
                  backgroundColor: isIn ? '#22C55E' : 'transparent',
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  {isIn && <Text style={{ color: '#fff', fontSize: 14, fontWeight: '900' }}>✓</Text>}
                </View>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <Text style={{ color: colors.textSecondary, textAlign: 'center', marginTop: 40 }}>
              {t?.('closeFriends.empty') || 'Nenhum contato'}
            </Text>
          }
        />
      )}
    </View>
  );
}
