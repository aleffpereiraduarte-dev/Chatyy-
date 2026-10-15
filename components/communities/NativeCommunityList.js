// components/communities/NativeCommunityList.js — [2026-10-15 native-social]
//
// Aba COMUNIDADES em NATIVO (view `ChatyyCommunityList` do módulo
// modules/expo-chat-conversation-list — iOS UICollectionView + diffable,
// Android RecyclerView + DiffUtil). O CommunitiesTab continua dono dos dados,
// dos modais e das ações; aqui só monta as linhas (communityRows.js) e traduz
// os eventos. Erro → onFailure() e a aba volta para o FlatList JS.
// Desligar por OTA: globalThis.__chatyy_native_communities = false.

import React, { useMemo, useRef } from 'react';
import { getNativeCommunityListView } from '../../modules/expo-chat-conversation-list';
import { NativeCommunityRows, buildCommunityListRows, communityListPalette } from './communityRows';

export default function NativeCommunityList(props) {
  const {
    communities, expandedId, expandedData, loadingInfo, t, colors, isDark,
    refreshing, footer, bottomInset = 80,
  } = props;
  const Native = getNativeCommunityListView();

  const built = useMemo(
    () => buildCommunityListRows({ communities, expandedId, expandedData, loadingInfo, t }),
    [communities, expandedId, expandedData, loadingInfo, t]
  );
  const mapRef = useRef(built.map);
  mapRef.current = built.map;
  const palette = useMemo(() => communityListPalette(colors, isDark), [colors, isDark]);

  const propsRef = useRef(props);
  propsRef.current = props;

  const handlers = useMemo(() => ({
    onRowPress: (id) => {
      const e = mapRef.current.get(id);
      if (!e) return;
      const p = propsRef.current;
      if (e.type === 'card') p.onToggle?.(e.item.id);
      else if (e.type === 'group') p.onOpenGroup?.(e.group, e.item);
    },
    onRowAction: (id, action) => {
      const e = mapRef.current.get(id);
      if (!e) return;
      const p = propsRef.current;
      if (action === 'remove' && e.type === 'group') p.onRemoveGroup?.(e.group, e.item);
      else if (action === 'addGroup') p.onAddGroup?.(e.item);
      else if (action === 'announce') p.onAnnounce?.(e.item);
    },
    onRefresh: () => { try { propsRef.current.onRefresh?.(); } catch {} },
    onFailure: (msg) => { try { propsRef.current.onFailure?.(msg); } catch {} },
  }), []);

  if (!Native) return null;
  return (
    <NativeCommunityRows
      Native={Native}
      rows={built.rows}
      header={null}
      footer={footer}
      isDark={isDark}
      palette={palette}
      refreshing={refreshing}
      bottomInset={bottomInset}
      {...handlers}
    />
  );
}
