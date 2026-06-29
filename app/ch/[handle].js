// Channel follow deep-link: https://chatyy.com.br/ch/<handle>
// Tapping a shared channel link opens this route which calls the backend
// chat_channel_join handler (resolves @handle → channel), follows the
// channel, and forwards the user into the channel conversation view.
// Mirrors app/j/[token].js (group invite link).
import { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, TouchableOpacity, SafeAreaView } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import * as api from '../../services/api';

export default function ChannelFollowScreen() {
  const router = useRouter();
  const { handle } = useLocalSearchParams();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { user, loading: authLoading } = useAuth();

  const [status, setStatus] = useState('loading'); // loading | auth | error | done
  const [err, setErr] = useState('');

  useEffect(() => {
    if (authLoading) return;
    if (!user) { setStatus('auth'); return; }
    const bare = String(handle || '').replace(/^@/, '').trim();
    if (!bare) { setErr(t?.('chat.channelBadHandle') || 'Canal inválido'); setStatus('error'); return; }
    (async () => {
      try {
        // chatChannelJoin accepts an @handle string and POSTs { handle }.
        const r = await api.chatChannelJoin(bare);
        const convId = r?.data?.conversation_id || r?.data?.id;
        if (r?.success && convId) {
          router.replace({
            pathname: '/chat-conversation',
            params: { id: String(convId), name: r.data.name || '', type: r.data.type || 'channel' },
          });
          return;
        }
        setErr(r?.message || t?.('chat.channelJoinFailed') || 'Falha ao seguir o canal');
        setStatus('error');
      } catch (e) {
        setErr(String(e?.message || e));
        setStatus('error');
      }
    })();
  }, [authLoading, user, handle, router, t]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors?.background }}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        {status === 'loading' && <ActivityIndicator size="large" color={colors?.primary} />}
        {status === 'auth' && (
          <>
            <Text style={{ color: colors?.text, fontSize: 16, marginBottom: 16, textAlign: 'center' }}>
              {t?.('chat.channelLoginFirst') || 'Faça login pra seguir o canal'}
            </Text>
            <TouchableOpacity
              onPress={() => router.replace({ pathname: '/login', params: { redirect: `/ch/${String(handle || '').replace(/^@/, '')}` } })}
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
