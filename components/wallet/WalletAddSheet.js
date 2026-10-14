/**
 * WalletAddSheet — "Recarregar" da Carteira. [2026-10-13 diamantes-religados]
 * Antes era no-op (return null). Agora reusa o DiamondTopUpSheet (mesma loja:
 * iOS só IAP, Android só Play Billing, web Stripe).
 */
import React from 'react';
import DiamondTopUpSheet from '../DiamondTopUpSheet';

export default function WalletAddSheet({ visible, onClose, onBalanceChange }) {
  return <DiamondTopUpSheet visible={visible} onClose={onClose} onBalanceChange={onBalanceChange} />;
}
