// Group invite deep-link: https://chatyy.com.br/j/<token>
// Tapping a shared invite opens this route which calls the backend
// chat_group_invite_link / chat_group_join_via_link handler, joins the group,
// and forwards the user into the conversation.
import { useEffect, useState, useCallback } from 'react';
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

  const [status, setStatus] = useState('confirm'); // confirm | loading | auth | error | pending | done
  const [err, setErr] = useState('');

  // Security: opening an invite link must NOT join by itself (a crafted link
  // could silently enrol the user). Show a confirmation; only the Join
  // button below calls chat_group_join_via_link.
  useEffect(() => {
    if (authLoading) return;
    if (!user) { setStatus('auth'); return; }
    if (!token || typeof token !== 'string') { setErr(t?.('chat.inviteBadToken') || 'Invite inválido'); setStatus('error'); return; }
    setStatus((cur) => (cur === 'loading' ? 'confirm' : cur));
  }, [authLoading, user, token, t]);

  const joinNow = useCallback(() => {
    if (!user || !token || typeof token !== 'string') return;
    setStatus('loading');
    (async () => {
      try {
        const r = await api.apiCall('chat_group_join_via_link', { token }, 'POST');
        // Backend returns `conversation_id` (not `id`). Older code read
        // r.data.id and silently failed — every invite link landed on the
        // error screen. Accept both shapes for forward-compat.
        const convId = r?.data?.conversation_id || r?.data?.id;
        // When the group requires admin approval the backend answers
        // success:true WITH a conversation_id but only queues the request
        // (pending_approval). Navigating there dropped the user into a
        // conversation they are not a member of — every read 403s and sends
        // fail — so the request has to be surfaced instead.
        if (r?.success && r?.data?.pending_approval) {
          setStatus('pending');
          return;
        }
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
  }, [user, token, router, t]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors?.background }}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        {status === 'loading' && <ActivityIndicator size="large" color={colors?.primary} />}
        {status === 'confirm' && (
          <>
            <Text style={{ color: colors?.text, fontSize: 17, fontWeight: '700', marginBottom: 8, textAlign: 'center' }}>
              {t?.('chat.inviteConfirmTitle') || 'Convite para um grupo'}
            </Text>
            <Text style={{ color: colors?.textSecondary || colors?.text, fontSize: 14, marginBottom: 20, textAlign: 'center' }}>
              {t?.('chat.inviteConfirmBody') || 'Você foi convidado para entrar em um grupo. Deseja entrar?'}
            </Text>
            <TouchableOpacity
              onPress={joinNow}
              style={{ paddingHorizontal: 28, paddingVertical: 12, borderRadius: 12, backgroundColor: colors?.primary || '#111111', marginBottom: 10 }}
            >
              <Text style={{ color: '#fff', fontWeight: '700' }}>{t?.('chat.inviteJoin') || 'Entrar no grupo'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.replace('/chat')} style={{ paddingHorizontal: 24, paddingVertical: 10 }}>
              <Text style={{ color: colors?.textSecondary || colors?.text, fontWeight: '600' }}>{t?.('common.cancel') || 'Cancelar'}</Text>
            </TouchableOpacity>
          </>
        )}
        {status === 'auth' && (
          <>
            <Text style={{ color: colors?.text, fontSize: 16, marginBottom: 16, textAlign: 'center' }}>
              {t?.('chat.inviteLoginFirst') || 'Faça login pra entrar no grupo'}
            </Text>
            <TouchableOpacity
              onPress={() => router.replace({ pathname: '/login', params: { redirect: `/j/${token}` } })}
              style={{ paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, backgroundColor: '#111111' }}
            >
              <Text style={{ color: '#fff', fontWeight: '700' }}>{t?.('common.login') || 'Entrar'}</Text>
            </TouchableOpacity>
          </>
        )}
        {status === 'pending' && (
          <>
            <Text style={{ color: colors?.text, fontSize: 16, marginBottom: 16, textAlign: 'center' }}>
              {t?.('chat.invitePending') || 'Pedido enviado! Um administrador precisa aprovar sua entrada no grupo.'}
            </Text>
            <TouchableOpacity
              onPress={() => router.replace('/chat')}
              style={{ paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, backgroundColor: colors?.primary }}
            >
              <Text style={{ color: '#fff', fontWeight: '700' }}>{t?.('common.close') || 'Fechar'}</Text>
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
