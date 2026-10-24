// components/profile/TgUserProfile.js — [mural 2026-10-20] /u/<email|@usuario>
// no perfil novo (Telegram + Mural). Substitui o perfil estilo Instagram
// (Seguir / seguidores / destaques): toda navegação para /u cai aqui.
//   • eu      → tela 4 do mockup (Publicar / Editar / Compartilhar, Quem vê,
//               "No que você está pensando?", fila durável no topo)
//   • outra   → tela 1 sem a conversa por trás: Áudio | Vídeo | Perfil |
//               Mensagem; abas da DM (profile_shared_counts.conversation_id);
//               Notificações (chat_mute da DM); Bloquear / Denunciar.
// Kill switch OTA: globalThis.__chatyy_profile_tg = false → Profile.js antigo.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Platform } from 'react-native';
import TgProfileView from './tg/TgProfileView';
import { useTgProfileData } from './tg/useTgProfileData';
import { tgT, useTgLang } from './tg/tgStrings';
import { useAuth } from '../../context/AuthContext';

function _api() { try { return require('../../services/api'); } catch { return null; } }
function _menu(o) { try { require('../../services/profilePostComposer').showActionMenu(o); } catch {} }
function _alert(t, m, b) { try { require('../../services/alerts').safeAlert(t, m, b); } catch { try { require('react-native').Alert.alert(t, m, b); } catch {} } }

function _untilFor(d) {
  if (d === '8h') return new Date(Date.now() + 8 * 3600e3).toISOString();
  if (d === '1w') return new Date(Date.now() + 7 * 86400e3).toISOString();
  if (d === '1h') return new Date(Date.now() + 3600e3).toISOString();
  return '2099-12-31T23:59:59Z';
}

export default function TgUserProfile({ identifier, router, onOpenChat, onOpenCall, onBack, topInset = 0, bottomInset = 0, initialTab }) {
  const lang = useTgLang();
  const tr = useCallback((k, v) => tgT(lang, k, v), [lang]);
  let me = '';
  try { const a = useAuth(); me = String((a && a.user && a.user.email) || '').toLowerCase(); } catch { me = ''; }
  const idf = String(identifier || '').trim();
  const isEmail = idf.includes('@');
  const guessSelf = isEmail && !!me && idf.toLowerCase() === me;
  const data = useTgProfileData({ email: isEmail ? idf : undefined, username: isEmail ? undefined : idf.replace(/^@/, ''), self: guessSelf });
  const em = data.email || (isEmail ? idf.toLowerCase() : '');
  const isSelf = guessSelf || data.isSelf || (!!em && em === me);
  const name = (data.identity && data.identity.name) || String(em).split('@')[0] || idf;

  // Notificações da DM (sem a conversa aberta): chat_user_conv_settings.
  const convId = data.conversationId;
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    if (!convId || isSelf) return undefined;
    let alive = true;
    const a = _api();
    Promise.resolve(a && a.chatGetConvSettings ? a.chatGetConvSettings(convId) : null).then((r) => {
      if (!alive || !r || !r.success) return;
      const d = r.data || {};
      const mu = d.mute_until || (d.settings && d.settings.mute_until) || null;
      setMuted(!!mu && Date.parse(mu) > Date.now());
    }).catch(() => {});
    return () => { alive = false; };
  }, [convId, isSelf]);
  const setMute = useCallback(async (until) => {
    const a = _api();
    if (!a || !convId) return;
    setMuted(!!until);
    try {
      const r = await a.chatMute(convId, until);
      if (r && r.success) { try { a.chatSetConvSettings(convId, { mute_until: until }); } catch {} }
      else setMuted(!until);
    } catch { setMuted(!until); }
  }, [convId]);

  const [blocked, setBlocked] = useState(false);
  const doBlock = useCallback(() => {
    const a = _api();
    if (!a || !em) return;
    if (blocked) { a.chatUnblockUser(em).then((r) => { if (r && r.success) setBlocked(false); }).catch(() => {}); return; }
    _alert(tr('block', { name }), tr('blockConfirm', { name }), [
      { text: tr('cancel'), style: 'cancel' },
      { text: tr('block', { name: '' }).trim(), style: 'destructive', onPress: () => { a.chatBlockUser(em).then((r) => { if (r && r.success) setBlocked(true); }).catch(() => {}); } },
    ]);
  }, [blocked, em, name, tr]);
  const doReport = useCallback(() => {
    const a = _api();
    if (!a || !em) return;
    const send = (reason) => { a.chatReportUser(em, reason, null, false).then((r) => { if (r && r.success) _alert(tr('done'), tr('reported')); }).catch(() => {}); };
    _menu({ title: tr('reportConfirm', { name }), options: [
      { label: tr('reasonSpam'), onPress: () => send('spam') },
      { label: tr('reasonAbuse'), onPress: () => send('inappropriate') },
      { label: tr('reasonHarass'), destructive: true, onPress: () => send('harassment') },
    ], cancelLabel: tr('cancel') });
  }, [em, name, tr]);

  const message = useCallback(() => { if (em && onOpenChat) onOpenChat(em); }, [em, onOpenChat]);
  const contact = useMemo(() => {
    if (isSelf) return {};
    const rows = [];
    if (em && onOpenChat) rows.push({ id: 'openChat', sid: 'more', icon: 'comment', title: tr('openChat'), onPress: message });
    rows.push({ id: blocked ? 'unblock' : 'block', sid: 'danger', dest: !blocked, icon: 'block', title: tr(blocked ? 'unblock' : 'block', { name }), onPress: doBlock });
    rows.push({ id: 'report', sid: 'danger', dest: true, icon: 'flag', title: tr('report'), onPress: doReport });
    return {
      conversationId: convId || null,
      muted,
      onMuteFor: convId ? (d) => setMute(_untilFor(d)) : null,
      onUnmute: convId ? () => setMute(null) : null,
      actions: {
        call: onOpenCall && em ? () => onOpenCall(em, false) : null,
        video: onOpenCall && em ? () => onOpenCall(em, true) : null,
        message: onOpenChat && em ? message : null,
      },
      rows,
      moreMenu: rows.filter((r) => r.id !== 'openChat'),
    };
  }, [isSelf, em, onOpenChat, onOpenCall, message, tr, blocked, name, doBlock, doReport, convId, muted, setMute]);

  const goBack = onBack || (() => { try { if (router && router.canGoBack && router.canGoBack()) router.back(); else router && router.replace && router.replace('/chat'); } catch {} });

  return (
    <View style={{ flex: 1 }}>
      <TgProfileView
        mode={isSelf ? 'self' : 'contact'}
        email={em}
        username={isEmail ? undefined : idf}
        seed={{ name }}
        data={data}
        contact={contact}
        onBack={goBack}
        topInset={topInset}
        bottomInset={bottomInset}
        router={router}
        initialTab={initialTab}
        self={isSelf ? {
          onEdit: () => { try { router.push('/edit-profile'); } catch {} },
          onShare: () => {
            const h = (data.identity && data.identity.username) || em;
            const url = require('../../utils/shortLinks').profileShareUrl(h); // [dominios-novos 2026-10-24] ctyy.me atrás de flag
            try {
              if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.share) { navigator.share({ title: name, url }); return; }
              require('react-native').Share.share(Platform.OS === 'ios' ? { url } : { message: url });
            } catch {}
          },
        } : undefined}
      />
    </View>
  );
}
