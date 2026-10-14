/**
 * LiveGiftSheet — painel de presentes da live. Casca fina sobre o GiftSheet
 * genérico (components/gifts/GiftSheet.js) com context 'live': fica aberto
 * para combos; a animação para todos vem do evento live_gift do hub (inclusive
 * para quem enviou — o próprio socket recebe o eco). sender_total do retorno
 * atualiza o ranking de top fãs na hora.
 *
 * Só monta quando LIVE_GIFTS_ENABLED (ver liveEngageConfig).
 */
import { memo, useCallback } from 'react';
import GiftSheet from '../gifts/GiftSheet';
import { useEngageSelector, selSheet } from './liveEngageStore';

function LiveGiftSheet({ engage }) {
  const sheet = useEngageSelector(engage, selSheet);
  const close = useCallback(() => engage?.closeSheet(), [engage]);
  const onSent = useCallback((data) => { try { engage?.noteSelfGift?.(data); } catch {} }, [engage]);
  const sessionId = engage?.getOpts?.().sessionId || '';
  if (sheet !== 'gift' || !sessionId) return null;
  return (
    <GiftSheet
      visible
      onClose={close}
      context="live"
      targetId={sessionId}
      keepOpen
      onSent={onSent}
    />
  );
}

export default memo(LiveGiftSheet);
