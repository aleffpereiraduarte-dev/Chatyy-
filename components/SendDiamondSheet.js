/**
 * SendDiamondSheet — "Enviar presente" a partir do perfil de alguém.
 *
 * [2026-10-13 diamantes-religados] A transferência P2P de diamantes
 * (wallet_send) foi DESLIGADA no servidor (lavagem/revenda de saldo). Presente
 * para uma pessoa = presente no chat 1:1 (TikTok/WhatsApp): resolve a conversa
 * direta (chat_create devolve a existente) e abre o GiftSheet com context
 * 'chat' — a bolha de presente aparece na conversa dos dois e o valor entra nos
 * ganhos de quem recebe.
 *
 * Props mantidas: visible, onClose, toEmail, toName, toAvatarUrl, onSent.
 */
import { useEffect, useState } from 'react';
import * as api from '../services/api';
import { useLanguage } from '../context/LanguageContext';
import GiftSheet from './gifts/GiftSheet';

function tr(t, k, fb) { const v = t ? t(k) : ''; return v && v !== k ? v : fb; }

export default function SendDiamondSheet({ visible, onClose, toEmail, toName, onSent }) {
  const { t } = useLanguage();
  const [convId, setConvId] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!visible || !toEmail) return undefined;
    let alive = true;
    setError('');
    (async () => {
      try {
        const r = await api.chatCreate([String(toEmail).toLowerCase()], '', 'direct');
        const id = r?.data?.conversation_id || r?.data?.id;
        if (!alive) return;
        if (r?.success && id) setConvId(id);
        else setError(tr(t, 'gifts.cantSendHere', 'Não é possível enviar presente aqui.'));
      } catch {
        if (alive) setError(tr(t, 'gifts.network', 'Sem conexão. Nada foi cobrado.'));
      }
    })();
    return () => { alive = false; };
    // [2026-10-17] sem `t` nas deps: troca de idioma/identidade de t não refaz chat_create.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, toEmail]);

  useEffect(() => { if (!visible) { setConvId(null); setError(''); } }, [visible]);

  if (!visible) return null;
  // [2026-10-17 gift-freeze] UM ÚNICO <Modal> do início ao fim. Antes: Modal de
  // carregando (fade) → ao chegar o chat_create (~100-250 ms, ainda no meio da
  // animação de apresentação) era DESMONTADO e outro Modal (GiftSheet) montado
  // no mesmo commit. No iOS, dismiss durante a apresentação é ignorado pelo
  // UIKit e o novo present falha ("already presenting") → véu transparente
  // preso por cima de tudo, sem resposta a toques = "app trava". Agora o
  // GiftSheet abre na hora; enquanto a conversa resolve o envio fica bloqueado.
  return (
    <GiftSheet
      visible
      onClose={onClose}
      context="chat"
      targetId={convId}
      targetError={error}
      recipientName={toName || String(toEmail || '').split('@')[0]}
      onSent={(data, gift, qty) => { try { onSent?.({ gift, quantity: qty, data }); } catch {} }}
    />
  );
}
