// components/chat/LocationRequestCard.js — [loc-pedido 2026-10-19] cartão "pediu sua localização" (render JS).
// O mesmo desenho existe na lista NATIVA (components/chat/nativeRowCards.js buildLocReq).
// Estado em msg.meta (services/locationRequest.js). P&B, ícones SVG, sem emoji.
import React, { memo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { IconMapPin, IconCheck, IconX, IconClock } from '../Icons';
import { locReqState, locReqTexts, locReqActionable } from '../../services/locationRequest';

function LocationRequestCard({ msg, isOwn, currentEmail, colors, isDark, t, peerName, onAction }) {
  const st = locReqState(msg, currentEmail);
  const T = locReqTexts(t, st, peerName, msg && msg.sender_name);
  const ink = isOwn ? '#FFFFFF' : (colors.text || '#111111');
  const sub = isOwn ? 'rgba(255,255,255,0.72)' : (colors.textSecondary || '#6b7280');
  const line = isOwn ? 'rgba(255,255,255,0.18)' : (isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)');
  const disc = isOwn ? 'rgba(255,255,255,0.14)' : (isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)');
  const actionable = locReqActionable(msg, st);
  const press = (a) => { try { onAction && onAction(msg, a); } catch {} };
  const StIcon = st.status === 'shared' ? IconCheck : st.status === 'declined' ? IconX : st.status === 'expired' ? IconClock : null;
  const primBg = isOwn || isDark ? '#FFFFFF' : '#111111';
  const primInk = isOwn || isDark ? '#111111' : '#FFFFFF';
  return (
    <View style={s.wrap} accessibilityRole="summary" accessibilityLabel={`${T.title}. ${T.sub}`}>
      <View style={s.row}>
        <View style={[s.disc, { backgroundColor: disc }]}>
          <IconMapPin size={20} color={ink} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.title, { color: ink }]} numberOfLines={3}>{T.title}</Text>
          <View style={s.subRow}>
            {StIcon ? <StIcon size={13} color={sub} /> : null}
            <Text style={[s.sub, { color: sub }]} numberOfLines={2}>{T.sub}</Text>
          </View>
        </View>
      </View>
      {actionable ? (
        <>
          <View style={[s.div, { backgroundColor: line }]} />
          <View style={s.btns}>
            <Pressable onPress={() => press('decline')} accessibilityRole="button" accessibilityLabel={T.decline}
              style={({ pressed }) => [s.btn, { borderWidth: 1, borderColor: line, opacity: pressed ? 0.6 : 1 }]}>
              <Text style={[s.btnTx, { color: ink }]}>{T.decline}</Text>
            </Pressable>
            <Pressable onPress={() => press('share')} accessibilityRole="button" accessibilityLabel={T.share}
              style={({ pressed }) => [s.btn, { backgroundColor: primBg, opacity: pressed ? 0.75 : 1 }]}>
              <Text style={[s.btnTx, { color: primInk }]}>{T.share}</Text>
            </Pressable>
          </View>
        </>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { width: 260, paddingTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  disc: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 14.5, fontWeight: '700', lineHeight: 19 },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  sub: { fontSize: 12.5, lineHeight: 16, flexShrink: 1 },
  div: { height: StyleSheet.hairlineWidth, marginTop: 10, marginBottom: 8 },
  btns: { flexDirection: 'row', gap: 8 },
  btn: { flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  btnTx: { fontSize: 13.5, fontWeight: '700' },
});

export default memo(LocationRequestCard);
