// Group invite deep-link: https://chatyy.com.br/j/<token>
// Tapping a shared invite opens this route which calls the backend
// chat_group_invite_link / chat_group_join_via_link handler, joins the group,
// and forwards the user into the conversation.
import { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, TouchableOpacity, SafeAreaView } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import * as api from '../../services/api';

export default function GroupJoinScreen() {
  const router = useRouter();
  const { token } = useLocalSearchParams();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { user, loading: authLoading } = useAuth();

  const [status, setStatus] = useState('loading'); // loading | auth | error | done
  const [err, setErr] = useState('');

  useEffect(() => {
    if (authLoading) return;
    if (!user) { setStatus('auth'); return; }
    if (!token || typeof token !== 'string') { setErr(t?.('chat.inviteBadToken') || 'Invite inválido'); setStatus('error'); return; }
    (async () => {
      try {
        const r = await api.apiCall('chat_group_join_via_link', { token }, 'POST');
        // Backend returns `conversation_id` (not `id`). Older code read
        // r.data.id and silently failed — every invite link landed on the
        // error screen. Accept both shapes for forward-compat.
        const convId = r?.data?.conversation_id || r?.data?.id;
        if (r?.success && convId) {
          router.replace({ pathname: '/chat-conversation', params: { id: String(convId), name: r.data.name || 'Grupo' } });
          return;
        }
        setErr(r?.message || t?.('chat.inviteFailed') || 'Falha ao entrar no grupo');
        setStatus('error');
      } catch (e) {
        setErr(String(e?.message || e));
        setStatus('error');
      }
    })();
  }, [authLoading, user, token, router, t]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors?.background }}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        {status === 'loading' && <ActivityIndicator size="large" color={colors?.primary} />}
        {status === 'auth' && (
          <>
            <Text style={{ color: colors?.text, fontSize: 16, marginBottom: 16, textAlign: 'center' }}>
              {t?.('chat.inviteLoginFirst') || 'Faça login pra entrar no grupo'}
            </Text>
            <TouchableOpacity
              onPress={() => router.replace({ pathname: '/login', params: { redirect: `/j/${token}` } })}
              style={{ paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, backgroundColor: '#7C3AED' }}
            >
              <Text style={{ color: '#fff', fontWeight: '700' }}>{t?.('common.login') || 'Entrar'}</Text>
            </TouchableOpacity>
          </>
        )}
        {status === 'error' && (
          <>
            <Text style={{ color: '#ef4444', fontSize: 16, marginBottom: 16, textAlign: 'center' }}>{err}</Text>
            <TouchableOpacity
              onPress={() => router.replace('/chat')}
              style={{ paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, backgroundColor: colors?.primary }}
            >
              <Text style={{ color: '#fff', fontWeight: '700' }}>{t?.('common.close') || 'Fechar'}</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}
