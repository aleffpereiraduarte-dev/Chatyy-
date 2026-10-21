// Channel follow deep-link: https://chatyy.com.br/ch/<handle>
// [grupos 2026-10-21 invite-preview] Antes o link SEGUIA o canal sozinho ao
// abrir (um link forjado inscrevia a pessoa calada — o /j/ já pedia
// confirmação). Agora: prévia do canal (foto, nome, @handle, seguidores,
// descrição) via chat_group_invite_preview {handle} e "Seguir canal" só no
// toque; já segue → "Abrir canal". Prévia indisponível → confirmação simples.
import { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, ActivityIndicator, ScrollView } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { haptic } from '../../constants/theme';
import * as api from '../../services/api';
import { InvitePreviewCard, JoinButton, inviteErrorText, st } from '../../components/InvitePreview';

const HANDLE_RE = /^[a-z0-9_]{3,32}$/i;

export default function ChannelFollowScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const rawHandle = String((Array.isArray(params?.handle) ? params.handle[0] : params?.handle) || '');
  const bare = rawHandle.replace(/^@/, '').trim();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { user, loading: authLoading } = useAuth();
  const insets = useSafeAreaInsets();

  // loading | preview | confirm | joining | auth | error
  const [status, setStatus] = useState('loading');
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  const loadPreview = useCallback(async () => {
    setStatus('loading');
    setErr('');
    try {
      const r = await api.apiCall('chat_group_invite_preview', { handle: bare.toLowerCase() }, 'POST');
      if (!aliveRef.current) return;
      if (r?.success && r.data) { setPreview({ ...r.data, type: r.data.type || 'channel', handle: r.data.handle || bare }); setStatus('preview'); return; }
      if (String(r?.data?.error || '') === 'invite_invalid') {
        setErr(inviteErrorText(t, r.data, r.message, 'channel'));
        setStatus('error');
        return;
      }
      setStatus('confirm');
    } catch {
      if (aliveRef.current) setStatus('confirm');
    }
  }, [bare, t]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { setStatus('auth'); return; }
    if (!HANDLE_RE.test(bare)) { setErr(t('chat.channelBadHandle', 'Canal inválido')); setStatus('error'); return; }
    loadPreview();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user, bare]);

  const openConv = useCallback((convId, data) => {
    require('../../services/openConversation').openConversation({
      pathname: '/chat-conversation',
      params: { id: String(convId), name: data?.name || preview?.name || '', type: data?.type || 'channel' },
    }, { replace: true });
  }, [preview]);

  const follow = useCallback(async () => {
    if (!user || !HANDLE_RE.test(bare)) return;
    if (preview?.already_member && preview?.conversation_id) { openConv(preview.conversation_id, preview); return; }
    setStatus('joining');
    haptic.medium?.();
    try {
      // chatChannelJoin aceita @handle e manda { handle }.
      const r = await api.chatChannelJoin(bare);
      if (!aliveRef.current) return;
      const convId = r?.data?.conversation_id || r?.data?.id;
      if (r?.success && convId) { haptic.success?.(); openConv(convId, r.data); return; }
      haptic.error?.();
      setErr(t('chat.channelJoinFailed', 'Não foi possível seguir o canal')); // servidor responde em inglês
      setStatus('error');
    } catch {
      if (!aliveRef.current) return;
      haptic.error?.();
      setErr(t('joinLink.offline', 'Sem conexão. Verifique sua internet e tente de novo.'));
      setStatus('error');
    }
  }, [user, bare, preview, openConv, t]);

  const close = useCallback(() => { try { router.replace('/chat'); } catch {} }, [router]);

  return (
    <View style={{ flex: 1, backgroundColor: colors?.background, paddingTop: insets.top, paddingBottom: insets.bottom }}>
      <ScrollView contentContainerStyle={st.wrap} keyboardShouldPersistTaps="handled">
        {status === 'loading' && <ActivityIndicator size="large" color={colors?.textSecondary} />}

        {(status === 'preview' || status === 'joining') && preview && (
          <InvitePreviewCard preview={preview} colors={colors} t={t}>
            {preview.already_member ? (
              <Text style={[st.note, { color: colors?.textSecondary }]}>{t('joinLink.alreadyFollowing', 'Você já segue este canal.')}</Text>
            ) : null}
            <View style={st.actions}>
              <JoinButton
                label={preview.already_member ? t('joinLink.openChannel', 'Abrir canal') : t('joinLink.follow', 'Seguir canal')}
                colors={colors}
                busy={status === 'joining'}
                onPress={follow}
              />
              <JoinButton label={t('joinLink.notNow', 'Agora não')} colors={colors} secondary onPress={close} />
            </View>
          </InvitePreviewCard>
        )}

        {status === 'confirm' && (
          <InvitePreviewCard preview={{ type: 'channel', name: `@${bare}`, member_count: null }} colors={colors} t={t}>
            <View style={st.actions}>
              <JoinButton label={t('joinLink.follow', 'Seguir canal')} colors={colors} onPress={follow} />
              <JoinButton label={t('common.cancel', 'Cancelar')} colors={colors} secondary onPress={close} />
            </View>
          </InvitePreviewCard>
        )}

        {status === 'auth' && (
          <View style={[st.card, { backgroundColor: colors?.surface, borderColor: colors?.borderLight || colors?.border }]}>
            <Text style={[st.desc, { color: colors?.text, marginTop: 0 }]}>{t('chat.channelLoginFirst', 'Entre na sua conta para seguir o canal')}</Text>
            <View style={st.actions}>
              <JoinButton label={t('common.login', 'Entrar')} colors={colors} onPress={() => router.replace({ pathname: '/login', params: { redirect: `/ch/${bare}` } })} />
            </View>
          </View>
        )}

        {status === 'error' && (
          <View style={[st.card, { backgroundColor: colors?.surface, borderColor: colors?.borderLight || colors?.border }]}>
            <Text style={[st.desc, { color: colors?.text, marginTop: 0 }]} accessibilityRole="alert">{err}</Text>
            <View style={st.actions}>
              {user && HANDLE_RE.test(bare) ? <JoinButton label={t('joinLink.retry', 'Tentar de novo')} colors={colors} onPress={loadPreview} /> : null}
              <JoinButton label={t('common.close', 'Fechar')} colors={colors} secondary={!!(user && HANDLE_RE.test(bare))} onPress={close} />
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
