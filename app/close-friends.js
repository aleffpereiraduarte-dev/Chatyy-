// Close Friends — Instagram-style list to restrict stories/posts
import { androidTopInset } from '../utils/systemInsets'; // [2026-10-07 android-native] edge-to-edge
import { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, Platform, StyleSheet } from 'react-native';
import { useRouter, Stack } from 'expo-router';
// [2026-10-09 more-native] Header + busca NATIVOS (UINavigationBar/UISearchController no iOS,
// Toolbar/SearchView Material no Android). Web mantém o header custom.
import { USE_NATIVE_HEADER, nativeHeaderOptions, nativeScrollInsetProps, NativeInsetView } from '../components/nativeHeader';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import AvatarCircle from '../components/AvatarCircle';
import FadeSlideIn from '../components/FadeSlideIn';
import { IconArrowLeft, IconSearch, IconStar, IconCheck } from '../components/Icons';
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
    if (!email) return;
    let isIn = false;
    // Optimistic update via setter — evita stale closure em toques rápidos
    // e perda de alterações concorrentes.
    setCloseFriends(prev => {
      isIn = prev.has(email);
      const n = new Set(prev);
      isIn ? n.delete(email) : n.add(email);
      return n;
    });
    try {
      if (isIn) await api.closeFriendsRemove(email);
      else await api.closeFriendsAdd(email);
    } catch {
      // Revert exata da operação que tentamos aplicar
      setCloseFriends(prev => {
        const n = new Set(prev);
        isIn ? n.add(email) : n.delete(email);
        return n;
      });
    }
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = contacts.filter(c => {
    const e = (c.email || c.friend_email || '').toLowerCase();
    const n = (c.name || c.display_name || '').toLowerCase();
    return !q || e.includes(q) || n.includes(q);
  });

  const countText = (t?.('closeFriends.count') || '{n} em amigos próximos').replace('{n}', closeFriends.size);
  // Subtitle line — surfaces the purpose of the screen. When the user has
  // 0 close friends saved, swap to the empty-state CTA so they know what
  // to do next. Both strings live in i18n so translations stay in sync.
  const subtitleText = closeFriends.size === 0
    ? (t?.('closeFriends.subtitle') || 'Compartilhe com um grupo selecionado')
    : countText;

  // [2026-10-09 more-native] P&B: marcador de seleção na cor do texto (era verde).
  const markOn = colors.text;
  const markFg = colors.background;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({
          colors,
          isDark,
          title: t('closeFriends.title'),
          search: {
            placeholder: t('common.search'),
            onChangeText: (e) => setQuery(e?.nativeEvent?.text || ''),
            onCancelButtonPress: () => setQuery(''),
          },
          headerRight: () => <IconStar size={20} color={colors.text} />,
        })} />
      ) : (
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: Platform.OS === 'ios' ? 50 : androidTopInset(16), paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
        <TouchableOpacity onPress={() => router.back()} style={{ padding: 8 }}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 4 }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>
            {t?.('closeFriends.title') || 'Melhores amigos'}
          </Text>
          <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>{subtitleText}</Text>
        </View>
        <IconStar size={22} color={colors.text} />
      </View>
      )}

      <FadeSlideIn>
      {!USE_NATIVE_HEADER && (
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
      )}

      {loading ? (
        <NativeInsetView>
          <Text style={{ color: colors.textSecondary, textAlign: 'center', marginTop: 20 }}>{t('common.loading')}</Text>
        </NativeInsetView>
      ) : (
        <FlatList
          {...nativeScrollInsetProps()}
          keyboardDismissMode="on-drag"
          ListHeaderComponent={USE_NATIVE_HEADER ? (
            <Text style={{ fontSize: 13, color: colors.textSecondary, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4 }}>{subtitleText}</Text>
          ) : null}
          data={filtered}
          extraData={closeFriends}
          keyExtractor={(item, i) => (item.email || item.friend_email || '') + i}
          renderItem={({ item }) => {
            const email = item.email || item.friend_email;
            const name = item.name || item.display_name || emailToDisplayName?.(email) || email;
            const isIn = closeFriends.has(email);
            return (
              <TouchableOpacity
                onPress={() => email && toggle(email)}
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
                  borderWidth: 2, borderColor: isIn ? markOn : colors.border,
                  backgroundColor: isIn ? markOn : 'transparent',
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  {isIn && <IconCheck size={15} color={markFg} strokeWidth={3} />}
                </View>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <Text style={{ color: colors.textSecondary, textAlign: 'center', marginTop: 40 }}>
              {t?.('closeFriends.empty') || 'Adicione amigos proximos'}
            </Text>
          }
        />
      )}
      </FadeSlideIn>
    </View>
  );
}
