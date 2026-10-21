// Group invite deep-link: https://chatyy.com.br/j/<token> (e /g/<token>, que
// utils/universalLinks manda para cá).
// [grupos 2026-10-21 invite-preview] Nível WhatsApp: antes de entrar mostra a
// PRÉVIA do grupo/canal (foto, nome, nº de membros, descrição, "precisa de
// aprovação") via chat_group_invite_preview; já membro → "Abrir conversa";
// pedido pendente → "Pedido enviado". Token V2 (24 hex, chat_group_invites)
// entra por chat_group_invite_join — antes caía em chat_group_join_via_link
// (só 32 hex) e todo link /g/ dava "Invalid invite token". Erros do servidor
// (em inglês) viram texto traduzido. Prévia indisponível (edge ainda sem a
// ação nova, rede) → confirmação genérica de antes, sem perder o convite.
import { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, ActivityIndicator, ScrollView } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { IconUsers } from '../../components/Icons';
import { InvitePreviewCard, JoinButton, inviteErrorText, st } from '../../components/InvitePreview';
import { haptic } from '../../constants/theme';
import * as api from '../../services/api';

const V1_RE = /^[a-f0-9]{32}$/i;
const V2_RE = /^[a-f0-9]{24}$/i;

export default function GroupJoinScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const token = String((Array.isArray(params?.token) ? params.token[0] : params?.token) || '').trim();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { user, loading: authLoading } = useAuth();
  const insets = useSafeAreaInsets();

  // loading | preview | confirm (sem prévia) | joining | auth | error | pending
  const [status, setStatus] = useState('loading');
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  const validToken = V1_RE.test(token) || V2_RE.test(token);

  const loadPreview = useCallback(async () => {
    setStatus('loading');
    setErr('');
    try {
      const r = await api.apiCall('chat_group_invite_preview', { token: token.toLowerCase() }, 'POST');
      if (!aliveRef.current) return;
      if (r?.success && r.data) {
        setPreview(r.data);
        setStatus(r.data.pending_approval ? 'pending' : 'preview');
        return;
      }
      const code = String(r?.data?.error || '');
      if (code === 'invite_invalid' || code === 'invite_revoked' || code === 'invite_expired') {
        setErr(inviteErrorText(t, r.data, r.message));
        setStatus('error');
        return;
      }
      setStatus('confirm'); // servidor sem a prévia (edge antigo) / limite → confirmação genérica
    } catch {
      if (aliveRef.current) setStatus('confirm');
    }
  }, [token, t]);

  // Segurança: abrir o link NÃO entra sozinho (um link forjado poderia
  // inscrever a pessoa calada). Só o botão chama a entrada.
  useEffect(() => {
    if (authLoading) return;
    if (!user) { setStatus('auth'); return; }
    if (!validToken) { setErr(t('joinLink.invalid', 'Este link de convite é inválido ou foi redefinido por um administrador.')); setStatus('error'); return; }
    loadPreview();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user, token]);

  const openConv = useCallback((convId, data) => {
    require('../../services/openConversation').openConversation({
      pathname: '/chat-conversation',
      params: { id: String(convId), name: data?.name || preview?.name || t('joinLink.group', 'Grupo'), type: data?.type || preview?.type || 'group' },
    }, { replace: true });
  }, [preview, t]);

  const joinNow = useCallback(async () => {
    if (!user || !validToken) return;
    if (preview?.already_member && preview?.conversation_id) { openConv(preview.conversation_id, preview); return; }
    setStatus('joining');
    haptic.medium?.();
    try {
      const isV2 = V2_RE.test(token);
      const r = isV2
        ? await api.apiCall('chat_group_invite_join', { token: token.toLowerCase() }, 'POST')
        : await api.apiCall('chat_group_join_via_link', { token: token.toLowerCase() }, 'POST');
      if (!aliveRef.current) return;
      // Grupo com aprovação: success:true + pending_approval (NÃO é membro ainda;
      // abrir a conversa daria 403 em tudo).
      if (r?.success && r?.data?.pending_approval) {
        haptic.success?.();
        setPreview((p) => ({ ...(p || {}), pending_approval: true }));
        setStatus('pending');
        return;
      }
      const convId = r?.data?.conversation_id || r?.data?.id;
      if (r?.success && convId) {
        haptic.success?.();
        openConv(convId, r.data);
        return;
      }
      haptic.error?.();
      setErr(inviteErrorText(t, r?.data, r?.message));
      setStatus('error');
    } catch {
      if (!aliveRef.current) return;
      haptic.error?.();
      setErr(t('joinLink.offline', 'Sem conexão. Verifique sua internet e tente de novo.'));
      setStatus('error');
    }
  }, [user, validToken, token, preview, openConv, t]);

  const close = useCallback(() => { try { router.replace('/chat'); } catch {} }, [router]);

  const isChannel = preview?.type === 'channel';
  const joinLabel = preview?.already_member
    ? t('joinLink.openChat', 'Abrir conversa')
    : (preview?.require_approval
      ? t('joinLink.requestJoin', 'Pedir para entrar')
      : (isChannel ? t('joinLink.follow', 'Seguir canal') : t('chat.inviteJoin', 'Entrar no grupo')));

  return (
    <View style={{ flex: 1, backgroundColor: colors?.background, paddingTop: insets.top, paddingBottom: insets.bottom }}>
      <ScrollView contentContainerStyle={st.wrap} keyboardShouldPersistTaps="handled">
        {status === 'loading' && <ActivityIndicator size="large" color={colors?.textSecondary} />}

        {(status === 'preview' || status === 'joining' || status === 'pending') && preview && (
          <InvitePreviewCard preview={preview} colors={colors} t={t}>
            {preview.already_member ? (
              <Text style={[st.note, { color: colors?.textSecondary }]}>{isChannel ? t('joinLink.alreadyFollowing', 'Você já segue este canal.') : t('joinLink.alreadyMember', 'Você já participa deste grupo.')}</Text>
            ) : status === 'pending' ? (
              <Text style={[st.note, { color: colors?.textSecondary }]}>{t('chat.invitePending', 'Pedido enviado! Um administrador precisa aprovar sua entrada no grupo.')}</Text>
            ) : preview.require_approval ? (
              <Text style={[st.note, { color: colors?.textSecondary }]}>{t('joinLink.approvalNote', 'Um administrador precisa aprovar sua entrada.')}</Text>
            ) : null}
            <View style={st.actions}>
              {status === 'pending' ? (
                <JoinButton label={t('joinLink.requestSent', 'Pedido enviado')} colors={colors} disabled onPress={() => {}} />
              ) : (
                <JoinButton label={joinLabel} colors={colors} busy={status === 'joining'} onPress={joinNow} />
              )}
              <JoinButton label={status === 'pending' ? t('common.close', 'Fechar') : t('joinLink.notNow', 'Agora não')} colors={colors} secondary onPress={close} />
            </View>
          </InvitePreviewCard>
        )}

        {status === 'confirm' && (
          <View style={[st.card, { backgroundColor: colors?.surface, borderColor: colors?.borderLight || colors?.border }]}>
            <View style={[st.glyph, { backgroundColor: colors?.surfaceVariant || colors?.surface2 }]}>
              <IconUsers size={40} color={colors?.textSecondary} />
            </View>
            <Text style={[st.name, { color: colors?.text }]} accessibilityRole="header">{t('chat.inviteConfirmTitle', 'Convite para um grupo')}</Text>
            <Text style={[st.desc, { color: colors?.textSecondary, textAlign: 'center' }]}>{t('chat.inviteConfirmBody', 'Você foi convidado para entrar em um grupo. Deseja entrar?')}</Text>
            <View style={st.actions}>
              <JoinButton label={t('chat.inviteJoin', 'Entrar no grupo')} colors={colors} onPress={joinNow} />
              <JoinButton label={t('common.cancel', 'Cancelar')} colors={colors} secondary onPress={close} />
            </View>
          </View>
        )}

        {status === 'auth' && (
          <View style={[st.card, { backgroundColor: colors?.surface, borderColor: colors?.borderLight || colors?.border }]}>
            <Text style={[st.desc, { color: colors?.text, textAlign: 'center', marginTop: 0 }]}>{t('chat.inviteLoginFirst', 'Faça login pra entrar no grupo')}</Text>
            <View style={st.actions}>
              <JoinButton label={t('common.login', 'Entrar')} colors={colors} onPress={() => router.replace({ pathname: '/login', params: { redirect: `/j/${token}` } })} />
            </View>
          </View>
        )}

        {status === 'error' && (
          <View style={[st.card, { backgroundColor: colors?.surface, borderColor: colors?.borderLight || colors?.border }]}>
            <Text style={[st.desc, { color: colors?.text, textAlign: 'center', marginTop: 0 }]} accessibilityRole="alert">{err}</Text>
            <View style={st.actions}>
              {validToken && user ? <JoinButton label={t('joinLink.retry', 'Tentar de novo')} colors={colors} onPress={loadPreview} /> : null}
              <JoinButton label={t('common.close', 'Fechar')} colors={colors} secondary={!!(validToken && user)} onPress={close} />
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
