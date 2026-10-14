/**
 * LivePaidGiftSheet — [2026-10-13 diamantes-religados] casca de compatibilidade:
 * o painel de presentes da live é o GiftSheet (components/gifts/GiftSheet.js,
 * context 'live'). Antes era no-op (return null).
 */
import React from 'react';
import GiftSheet from './gifts/GiftSheet';

export default function LivePaidGiftSheet({ visible, onClose, sessionId, hostEmail, hostName }) {
  if (!visible || !sessionId) return null;
  return (
    <GiftSheet
      visible
      onClose={onClose}
      context="live"
      targetId={sessionId}
      recipientName={hostName || (hostEmail ? String(hostEmail).split('@')[0] : '')}
      keepOpen
    />
  );
}
