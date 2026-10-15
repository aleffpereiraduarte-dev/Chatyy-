// components/channels/NativeChannelFeed.js — [2026-10-15 native-social]
//
// Posts de um canal em NATIVO (view `ChatyyChannelFeed`): bolha com mídia,
// texto, hora/visualizações, chips de reação (minha reação destacada) e barra
// rápida. Linhas montadas pelo ChannelView (components/ChannelsTab.js).
// Eventos: onRowAction(id, 'react'|'media'|'longpress', {emoji}).
// Mesmo boundary/kill switch da lista (NativeChannelList.js).

import React from 'react';
import { NativeChannelSurface } from './NativeChannelList';

/** Reações → string plana "emoji\x1Fcontagem\x1E…" (o patcher compara só o 1º nível). */
export function encodeReactions(list) {
  if (!Array.isArray(list) || !list.length) return '';
  return list
    .filter(r => r && r.emoji && r.cnt > 0)
    .map(r => `${String(r.emoji).replace(/[\x1E\x1F]/g, '')}\x1F${r.cnt}`)
    .join('\x1E');
}

export default function NativeChannelFeed(props) {
  return <NativeChannelSurface {...props} kind="feed" />;
}
