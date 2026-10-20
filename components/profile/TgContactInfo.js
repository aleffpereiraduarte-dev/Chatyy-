// components/profile/TgContactInfo.js — [mural 2026-10-20] "Dados do contato"
// no visual novo (Telegram + Mural, tela 1 do mockup preview-2026/perfil.html).
//
// Escolha: tela NOVA em JS. A ChatyyChatInfo nativa (api 5/6) não tem abas fixas
// nem mural (grade/lista de posts de texto e foto) — estender exigiria build.
// Então, com o kill switch ligado, "Dados do contato" deixa de pintar a view
// nativa e pinta isto, usando OS MESMOS descritores/handlers que a conversa já
// publica (buildContactChatInfo → services/chatInfoRoute ou o <Modal>):
//   hero.actions  call/video/search  → Áudio | Vídeo | (Perfil) | Pesquisar
//   rows notif / starred / customNotif / wallpaper / disappearing / chatLock /
//        e2e / advPriv / ... / block / report   → reorganizados (nada some)
//   tg { email, conversationId, presence, muted, onMuteFor, onUnmute, ... }
//        (extras que a conversa passa só p/ esta tela)
// Falha de render → onFailure() e quem monta volta à tela nativa de antes.
// Kill switch OTA: globalThis.__chatyy_profile_tg = false.
import React from 'react';
import TgProfileView, { isTgProfileEnabled } from './tg/TgProfileView';

export function tgContactInfoOn() {
  return isTgProfileEnabled();
}

class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e) { try { console.warn('[TgContactInfo] fail', e?.message || e); } catch {} try { this.props.onFailure?.(); } catch {} }
  render() { return this.state.failed ? null : this.props.children; }
}

const MORE_MENU_IDS = ['shareContact', 'export', 'clear'];

export default function TgContactInfo({ info, onClose, onFailure, topInset = 0, bottomInset = 0, backLabel, router }) {
  const inf = info || {};
  const tg = inf.tg || {};
  const hero = inf.hero || {};
  const rows = Array.isArray(inf.rows) ? inf.rows : [];
  const byId = (id) => rows.find((r) => r && String(r.id) === id) || null;
  const act = (k) => {
    const a = (Array.isArray(hero.actions) ? hero.actions : []).find((x) => x && String(x.key) === k);
    return a && typeof a.onPress === 'function' ? a.onPress : null;
  };
  const notif = byId('notif');
  const starred = byId('starred');
  const contact = {
    conversationId: tg.conversationId || null,
    presence: tg.presence || '',
    muted: tg.muted != null ? !!tg.muted : !!(notif && (notif.icon === 'bellOff' || notif.val)),
    onMuteFor: typeof tg.onMuteFor === 'function' ? tg.onMuteFor : null,
    onUnmute: typeof tg.onUnmute === 'function' ? tg.onUnmute : null,
    onMute: notif && typeof notif.onPress === 'function' ? notif.onPress : null,
    actions: { call: act('call'), video: act('video'), search: act('search') },
    onFavorites: starred && typeof starred.onPress === 'function' ? starred.onPress : null,
    onAvatarPress: typeof hero.onAvatarPress === 'function' ? hero.onAvatarPress : null,
    rows,
    commonGroups: Array.isArray(tg.commonGroups) ? tg.commonGroups : null,
    openGroup: typeof tg.openGroup === 'function' ? tg.openGroup : null,
    bio: tg.bio || '',
    phone: tg.phone || '',
    moreMenu: MORE_MENU_IDS.map(byId).filter(Boolean),
  };
  return (
    <Boundary onFailure={onFailure}>
      <TgProfileView
        mode="contact"
        email={tg.email || ''}
        seed={{ name: hero.title || '' }}
        contact={contact}
        onBack={onClose}
        backLabel={backLabel}
        topInset={topInset}
        bottomInset={bottomInset}
        router={router}
      />
    </Boundary>
  );
}
