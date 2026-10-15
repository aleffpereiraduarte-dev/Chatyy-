// components/communities/NativeCommunityDetail.js — [2026-10-15 native-social]
//
// Tela da comunidade (app/community/[id].js) em NATIVO (view
// `ChatyyCommunityDetail`): o conteúdo da aba ativa (Anúncios / Conversas /
// Membros / Sobre) vira linhas nativas; capa, título, botões, abas e busca
// de membros = header RN (1º filho, rola junto); compositor de aviso e dica
// de membros = rodapé RN (2º filho). Erro → onFailure() e a tela volta para
// o ScrollView JS. Desligar por OTA: globalThis.__chatyy_native_communities = false.

import React, { useMemo, useRef } from 'react';
import { getNativeCommunityDetailView } from '../../modules/expo-chat-conversation-list';
import { NativeCommunityRows, buildCommunityDetailRows, communityDetailPalette } from './communityRows';

export default function NativeCommunityDetail(props) {
  const {
    tab, community, groups, members, isAdmin, myEmail, t, colors, isDark,
    refreshing, header, footer, bottomInset = 24,
  } = props;
  const Native = getNativeCommunityDetailView();

  const built = useMemo(
    () => buildCommunityDetailRows({ tab, community, groups, members, isAdmin, myEmail, t, colors, isDark }),
    [tab, community, groups, members, isAdmin, myEmail, t, colors, isDark]
  );
  const mapRef = useRef(built.map);
  mapRef.current = built.map;
  const palette = useMemo(() => communityDetailPalette(colors, isDark), [colors, isDark]);

  const propsRef = useRef(props);
  propsRef.current = props;

  const handlers = useMemo(() => ({
    onRowPress: (id) => {
      const e = mapRef.current.get(id);
      if (!e) return;
      const p = propsRef.current;
      if (e.type === 'announcements') p.onOpenAnnouncements?.();
      else if (e.type === 'group') p.onOpenGroup?.(e.group);
      else if (e.type === 'add') p.onAddGroup?.();
    },
    onLongPress: (id) => {
      const e = mapRef.current.get(id);
      if (e && e.type === 'member') { try { propsRef.current.onMemberLongPress?.(e.member); } catch {} }
    },
    onRefresh: () => { try { propsRef.current.onRefresh?.(); } catch {} },
    onFailure: (msg) => { try { propsRef.current.onFailure?.(msg); } catch {} },
  }), []);

  if (!Native) return null;
  return (
    <NativeCommunityRows
      Native={Native}
      rows={built.rows}
      header={header}
      footer={footer}
      isDark={isDark}
      palette={palette}
      refreshing={refreshing}
      bottomInset={bottomInset}
      {...handlers}
    />
  );
}
