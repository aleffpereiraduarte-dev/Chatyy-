// Status "hide from…" picker — choose contacts to exclude from your status.
// Reuses the close-friends screen layout (app/close-friends.js). Reads the
// global exclusion list from chat_privacy_get (`status_except`, array of
// lowercase emails) and persists changes via chat_privacy_set { status_except }.
import { androidTopInset } from '../utils/systemInsets'; // [2026-10-07 android-native] edge-to-edge
import { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, Platform, StyleSheet } from 'react-native';
import { useRouter, Stack } from 'expo-router';
// [2026-10-09 more-native] Header + busca NATIVOS (UINavigationBar/UISearchController no iOS,
// Toolbar/SearchView Material no Android). Web mantém o header custom.
import { USE_NATIVE_HEADER, nativeHeaderOptions, nativeScrollInsetProps, NativeInsetView } from '../components/nativeHeader';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import * as settingsCache from '../services/settingsCache'; // [2026-10-13 settings-instant]
import AvatarCircle from '../components/AvatarCircle';
import { IconArrowLeft, IconSearch, IconEyeOff, IconCheck } from '../components/Icons';
import SelectionCheck from '../components/ui/SelectionCheck'; // [2026-10-18 elegance]
import { emailToDisplayName } from '../services/api';

import { a11yLabel } from '../utils/a11yLabel'; // [2026-10-20 a11y] rótulos dos botões só-ícone
export default function StatusExceptScreen() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  // [2026-10-13 settings-instant] snapshot local (privacidade + contatos enxutos).
  const [_pvSnap] = useState(() => {
    const pv = settingsCache.peek('privacy');
    return pv && Array.isArray(pv.status_except) ? pv.status_except.map(e => (e || '').toLowerCase()) : null;
  });
  const [contacts, setContacts] = useState(() => { const c = settingsCache.peek('contacts_lite'); return Array.isArray(c) ? c : []; });
  const [excluded, setExcluded] = useState(() => new Set(_pvSnap || []));
  const [loading, setLoading] = useState(() => settingsCache.peek('contacts_lite') == null);
  const [query, setQuery] = useState('');
  // Last server-confirmed exclusion list + persist sequence for latest-wins.
  // Without these, a failed chatPrivacySet left the UI showing the contact as
  // hidden while the server never saved it — the user believes their status
  // is hidden from someone and it isn't.
  const savedRef = useRef(new Set(_pvSnap || []));
  const seqRef = useRef(0);

  // Revalida privacidade + contatos em paralelo (não sobrescreve se a
  // pessoa já começou a marcar — seqRef > 0).
  useEffect(() => {
    (async () => {
      try {
        const [pv, cs] = await Promise.all([
          settingsCache.revalidate('privacy', { force: true }),
          settingsCache.revalidate('contacts_lite', { force: true }),
        ]);
        if (pv && Array.isArray(pv.status_except) && seqRef.current === 0) {
          const initial = new Set(pv.status_except.map(e => (e || '').toLowerCase()));
          savedRef.current = new Set(initial);
          setExcluded(initial);
        }
        if (Array.isArray(cs)) setContacts(cs);
      } catch {}
      setLoading(false);
    })();
  }, []);

  // Persist the full list on every toggle. Backend caps at 200 server-side
  // and lowercases; we mirror the lowercase + '@' guard here to match.
  // Latest-wins: rapid toggles each send the FULL list, so only the newest
  // in-flight request matters. On failure of the newest, revert the UI to the
  // last server-confirmed set (apiCall resolves even on network failure, so
  // the success flag is the only reliable signal).
  const persist = useCallback(async (nextSet) => {
    const arr = Array.from(nextSet).filter(e => e && e.includes('@')).slice(0, 200);
    const seq = ++seqRef.current;
    let ok = false;
    try {
      const r = await api.chatPrivacySet?.({ status_except: arr });
      ok = !!r?.success;
    } catch {}
    if (seq !== seqRef.current) return; // a newer persist superseded this one
    if (ok) {
      savedRef.current = new Set(arr);
      try { settingsCache.patch('privacy', { status_except: arr }); } catch {}
    } else {
      setExcluded(new Set(savedRef.current));
    }
  }, []);

  const toggle = useCallback((rawEmail) => {
    const email = (rawEmail || '').toLowerCase();
    if (!email || !email.includes('@')) return;
    setExcluded(prev => {
      const n = new Set(prev);
      n.has(email) ? n.delete(email) : n.add(email);
      persist(n);
      return n;
    });
  }, [persist]);

  const q = query.trim().toLowerCase();
  const filtered = contacts.filter(c => {
    const e = (c.email || c.friend_email || '').toLowerCase();
    const n = (c.name || c.display_name || '').toLowerCase();
    return !q || e.includes(q) || n.includes(q);
  });

  const countText = (t?.('settings.privacyStatusExceptCount') || '{n} ocultos').replace('{n}', excluded.size);
  const subtitleText = excluded.size === 0
    ? (t?.('settings.privacyStatusExceptDesc') || 'Esconda seu status de pessoas específicas')
    : countText;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({
          colors,
          isDark,
          title: t('settings.privacyStatusExcept'),
          search: {
            placeholder: t('common.search'),
            onChangeText: (e) => setQuery(e?.nativeEvent?.text || ''),
            onCancelButtonPress: () => setQuery(''),
          },
          headerRight: () => <IconEyeOff size={20} color={colors.text} />,
        })} />
      ) : (
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: Platform.OS === 'ios' ? 50 : androidTopInset(16), paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={a11yLabel('common.back', 'Voltar')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => router.back()} style={{ padding: 8 }}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 4 }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>
            {t?.('settings.privacyStatusExcept') || 'Ocultar status de…'}
          </Text>
          <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>{subtitleText}</Text>
        </View>
        <IconEyeOff size={22} color={colors.textSecondary} />
      </View>
      )}

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
          extraData={excluded}
          keyExtractor={(item, i) => (item.email || item.friend_email || '') + i}
          renderItem={({ item }) => {
            const email = (item.email || item.friend_email || '').toLowerCase();
            const name = item.name || item.display_name || emailToDisplayName?.(email) || email;
            const isIn = excluded.has(email);
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
                {/* [2026-10-18 elegance] círculo de seleção animado */}
                <SelectionCheck on={!!isIn} size={26} borderWidth={2} onColor={colors.primary || '#111111'} offColor={colors.border} checkColor={colors.onPrimary || '#fff'} checkSize={15} strokeWidth={3} />
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
