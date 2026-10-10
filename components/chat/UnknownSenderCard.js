// [2026-10-09 wa-real #12] Cartão de contexto de remetente desconhecido
// (WhatsApp: "não está nos seus contatos · nenhum grupo em comum · país").
//
// Mostrado no topo de uma conversa 1:1 quando o outro NÃO está na agenda
// sincronizada e o usuário ainda não respondeu. Dados do servidor
// (email.php?action=chat_sender_context — só o código do país, nunca o
// número). "Bloquear" usa o fluxo de bloqueio da própria tela; "OK" fecha e
// lembra por conversa. Preto & branco, ícones SVG.
import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { IconShield, IconUsers, IconGlobe, IconAlertTriangle } from '../Icons';
import * as api from '../../services/api';

const DISMISS_PREFIX = 'unknown_card_dismissed_v1:';
const CACHE_PREFIX = 'sender_ctx_v1:';
const CACHE_TTL_MS = 60 * 60 * 1000;

function _mmkv() {
  try { return require('../../services/mmkv'); } catch { return null; }
}

function _countryName(code, language) {
  if (!code) return '';
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function') {
      const dn = new Intl.DisplayNames([language || 'pt-BR', 'en'], { type: 'region' });
      const n = dn.of(code);
      if (n && n !== code) return n;
    }
  } catch {}
  return code;
}

export default function UnknownSenderCard({ conversationId, conversationType, myEmail, hasMine, blocked, colors, isDark, t, language, onBlock }) {
  const cid = Number(conversationId) || 0;
  const scope = String(myEmail || '').toLowerCase();
  const [ctx, setCtx] = useState(null);
  const [dismissed, setDismissed] = useState(() => {
    try { return !!_mmkv()?.getJSON(DISMISS_PREFIX + scope + ':' + cid); } catch { return false; }
  });

  useEffect(() => {
    if (!cid || conversationType !== 'direct' || dismissed || hasMine) return undefined;
    let alive = true;
    const key = CACHE_PREFIX + scope + ':' + cid;
    try {
      const c = _mmkv()?.getJSON(key);
      if (c && c.at && Date.now() - c.at < CACHE_TTL_MS && c.data) { setCtx(c.data); return undefined; }
    } catch {}
    (async () => {
      try {
        const r = await api.apiCall('chat_sender_context', { conversation_id: cid }, 'POST');
        if (!alive || !r?.success || !r.data) return;
        setCtx(r.data);
        try { _mmkv()?.setJSON(key, { at: Date.now(), data: r.data }); } catch {}
      } catch {}
    })();
    return () => { alive = false; };
  }, [cid, conversationType, dismissed, hasMine, scope]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try { _mmkv()?.setJSON(DISMISS_PREFIX + scope + ':' + cid, 1); } catch {}
  }, [cid, scope]);

  if (!cid || conversationType !== 'direct' || dismissed || hasMine || blocked) return null;
  if (!ctx || !ctx.applicable || ctx.in_contacts || ctx.i_replied) return null;

  const tx = (k, fb) => { const v = t?.(k); return v && v !== k ? v : fb; };
  const fg = colors?.text || (isDark ? '#fff' : '#111');
  const sub = colors?.textSecondary || (isDark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.6)');
  const groupsCount = Number(ctx.common_groups_count) || 0;
  const groupNames = (Array.isArray(ctx.common_groups) ? ctx.common_groups : []).map(g => g?.name).filter(Boolean);
  let groupsLine;
  if (groupsCount === 0) {
    groupsLine = tx('chatConv.unknownCard.noCommonGroups', 'Nenhum grupo em comum');
  } else {
    const extra = groupsCount > groupNames.length ? ` +${groupsCount - groupNames.length}` : '';
    groupsLine = tx('chatConv.unknownCard.commonGroups', 'Grupos em comum: {names}').replace('{names}', (groupNames.join(', ') || String(groupsCount)) + extra);
  }
  const country = _countryName(ctx.country, language);
  const isNew = ctx.account_age_days !== null && ctx.account_age_days !== undefined && Number(ctx.account_age_days) < 7;

  const Row = ({ Icon, text, strong }) => (
    <View style={s.row}>
      <Icon size={14} color={strong ? fg : sub} />
      <Text style={[s.rowText, { color: strong ? fg : sub, fontWeight: strong ? '600' : '400' }]} numberOfLines={2}>{text}</Text>
    </View>
  );

  return (
    <View
      style={[s.card, {
        backgroundColor: isDark ? '#0b0b0b' : '#ffffff',
        borderColor: isDark ? '#262628' : 'rgba(0,0,0,0.12)',
      }]}
      accessible
      accessibilityRole="summary"
      accessibilityLabel={[tx('chatConv.unknownCard.title', 'Não está nos seus contatos'), groupsLine, country ? tx('chatConv.unknownCard.country', 'Número de {country}').replace('{country}', country) : '', isNew ? tx('chatConv.unknownCard.newAccount', 'Conta criada recentemente') : ''].filter(Boolean).join('. ')}
    >
      <Row Icon={IconShield} text={tx('chatConv.unknownCard.title', 'Não está nos seus contatos')} strong />
      <Row Icon={IconUsers} text={groupsLine} />
      {country ? <Row Icon={IconGlobe} text={tx('chatConv.unknownCard.country', 'Número de {country}').replace('{country}', country)} /> : null}
      {isNew ? <Row Icon={IconAlertTriangle} text={tx('chatConv.unknownCard.newAccount', 'Conta criada recentemente')} /> : null}
      <Text style={[s.hint, { color: sub }]}>
        {tx('chatConv.unknownCard.hint', 'Cuidado com pedidos de dinheiro, códigos ou links. Se não conhece, bloqueie.')}
      </Text>
      <View style={s.actions}>
        <TouchableOpacity
          onPress={() => { try { onBlock?.(); } catch {} }}
          style={[s.btn, { borderColor: isDark ? '#3a3a3c' : 'rgba(0,0,0,0.18)' }]}
          accessibilityRole="button"
          accessibilityLabel={tx('chatConv.unknownCard.block', 'Bloquear')}
          hitSlop={6}
        >
          <Text style={[s.btnText, { color: fg }]}>{tx('chatConv.unknownCard.block', 'Bloquear')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={dismiss}
          style={[s.btn, { backgroundColor: fg, borderColor: fg }]}
          accessibilityRole="button"
          accessibilityLabel={tx('chatConv.unknownCard.ok', 'OK')}
          hitSlop={6}
        >
          <Text style={[s.btnText, { color: isDark ? '#000' : '#fff' }]}>{tx('chatConv.unknownCard.ok', 'OK')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 4,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 6,
    ...(Platform.OS === 'web' ? { maxWidth: 520, alignSelf: 'center', width: '100%' } : {}),
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowText: { flex: 1, fontSize: 13.5, lineHeight: 18 },
  hint: { fontSize: 12, lineHeight: 16, marginTop: 2 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 6 },
  btn: { flex: 1, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontSize: 14, fontWeight: '600' },
});
