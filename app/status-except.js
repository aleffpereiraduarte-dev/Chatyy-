// Status "hide from…" picker — choose contacts to exclude from your status.
// Reuses the close-friends screen layout (app/close-friends.js). Reads the
// global exclusion list from chat_privacy_get (`status_except`, array of
// lowercase emails) and persists changes via chat_privacy_set { status_except }.
import { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, Platform, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import AvatarCircle from '../components/AvatarCircle';
import { IconArrowLeft, IconSearch, IconEyeOff, IconCheck } from '../components/Icons';
import { emailToDisplayName } from '../services/api';

export default function StatusExceptScreen() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const [contacts, setContacts] = useState([]);
  const [excluded, setExcluded] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  // Last server-confirmed exclusion list + persist sequence for latest-wins.
  // Without these, a failed chatPrivacySet left the UI showing the contact as
  // hidden while the server never saved it — the user believes their status
  // is hidden from someone and it isn't.
  const savedRef = useRef(new Set());
  const seqRef = useRef(0);

  useEffect(() => {
    (async () => {
      try {
        const [pv, cs] = await Promise.all([
          api.chatPrivacyGet?.(),
          api.chatContacts?.(),
        ]);
        if (pv?.success && pv.data && Array.isArray(pv.data.status_except)) {
          const initial = new Set(pv.data.status_except.map(e => (e || '').toLowerCase()));
          savedRef.current = new Set(initial);
          setExcluded(initial);
        }
        if (cs?.success) {
          const list = Array.isArray(cs.data) ? cs.data : (cs.data?.contacts || []);
          setContacts(list);
        }
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
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: Platform.OS === 'ios' ? 50 : 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
        <TouchableOpacity onPress={() => router.back()} style={{ padding: 8 }}>
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
                <View style={{
                  width: 26, height: 26, borderRadius: 13,
                  borderWidth: 2, borderColor: isIn ? (colors.primary || '#7C3AED') : colors.border,
                  backgroundColor: isIn ? (colors.primary || '#7C3AED') : 'transparent',
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  {isIn && <IconCheck size={15} color="#fff" strokeWidth={3} />}
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
