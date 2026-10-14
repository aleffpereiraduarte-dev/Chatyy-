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
import React, { useEffect, useState } from 'react';
import { Modal, View, ActivityIndicator, Text, StyleSheet, Pressable } from 'react-native';
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
  }, [visible, toEmail, t]);

  useEffect(() => { if (!visible) { setConvId(null); setError(''); } }, [visible]);

  if (!visible) return null;
  if (convId) {
    return (
      <GiftSheet
        visible
        onClose={onClose}
        context="chat"
        targetId={convId}
        recipientName={toName || String(toEmail || '').split('@')[0]}
        onSent={(data, gift, qty) => { try { onSent?.({ gift, quantity: qty, data }); } catch {} }}
      />
    );
  }
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.box}>
          {error ? <Text style={styles.err}>{error}</Text> : <ActivityIndicator color="#fff" />}
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' },
  box: { minWidth: 120, minHeight: 80, borderRadius: 18, backgroundColor: '#0b0b0b', alignItems: 'center', justifyContent: 'center', padding: 20, maxWidth: 300 },
  err: { color: '#fff', fontSize: 14, textAlign: 'center' },
});
