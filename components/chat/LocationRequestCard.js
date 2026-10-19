// components/chat/LocationRequestCard.js — [loc-pedido 2026-10-19] cartão "Pedido de localização" (render JS).
// O mesmo desenho existe na lista NATIVA (components/chat/nativeRowCards.js buildLocReq), com os
// MESMOS números do mapa (services/locationRequest.js MAP_*). P&B, SVG, sem emoji.
import React, { memo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Svg, { Rect, Path, Circle } from 'react-native-svg';
import * as L from '../../services/locationRequest';

function MapStage({ done }) {
  const W = L.MAP_W; const H = L.MAP_H;
  const street = 'rgba(255,255,255,0.09)';
  const ave = 'rgba(255,255,255,0.13)';
  const cx = W / 2; const cy = H / 2;
  // pino 44 px (viewBox 24) subido 18 px — igual ao nativo
  const ps = 44 / 24; const px = cx - 22; const py = cy - 22 - 18;
  return (
    <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <Rect x={0} y={0} width={W} height={H} rx={16} fill={L.MAP_BG} />
      {L.MAP_BLOCKS.map(([x, y, w, h], i) => <Rect key={'b' + i} x={x} y={y} width={w} height={h} rx={4} fill="rgba(255,255,255,0.05)" />)}
      {L.MAP_STREETS_H.map((y) => <Rect key={'h' + y} x={0} y={y} width={W} height={1.5} fill={street} />)}
      {L.MAP_STREETS_V.map((x) => <Rect key={'v' + x} x={x} y={0} width={1.5} height={H} fill={street} />)}
      <Rect x={0} y={L.MAP_AVE_H} width={W} height={7} fill={ave} />
      <Rect x={L.MAP_AVE_V} y={0} width={7} height={H} fill={ave} />
      <Path d={L.MAP_DIAG} stroke={ave} strokeWidth={6} fill="none" />
      <Circle cx={cx} cy={cy} r={46} stroke={done ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.14)'} strokeWidth={1} fill="none" />
      <Circle cx={cx} cy={cy} r={30} fill={done ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.10)'} />
      <Circle cx={cx} cy={cy} r={15} fill={done ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.18)'} />
      <Path d={L.PIN_OUTER} fill={done ? '#9a9a9a' : '#ffffff'} transform={`translate(${px} ${py}) scale(${ps})`} />
      <Path d={L.PIN_HOLE} fill={L.MAP_BG} transform={`translate(${px} ${py}) scale(${ps})`} />
    </Svg>
  );
}

function LocationRequestCard({ msg, isOwn, currentEmail, colors, isDark, t, peerName, onAction }) {
  const st = L.locReqState(msg, currentEmail);
  const T = L.locReqTexts(t, st, peerName, msg && msg.sender_name);
  const ink = isOwn ? '#FFFFFF' : (colors.text || '#111111');
  const sub = isOwn ? 'rgba(255,255,255,0.72)' : (colors.textSecondary || '#6b7280');
  const chipBg = isOwn ? 'rgba(255,255,255,0.14)' : 'rgba(127,127,127,0.14)';
  const actionable = L.locReqActionable(msg, st);
  const cancelable = !actionable && L.locReqCancelable(msg, st);
  const press = (a) => { try { onAction && onAction(msg, a); } catch {} };
  const primBg = isOwn || isDark ? '#FFFFFF' : '#111111';
  const primInk = isOwn || isDark ? '#111111' : '#FFFFFF';
  return (
    <View style={s.wrap} accessibilityLabel={`${T.title}. ${T.sub}. ${T.chip}`}>
      <View style={s.stage}><MapStage done={st.status !== 'pending'} /></View>
      <Text style={[s.title, { color: ink }]} numberOfLines={1}>{T.title}</Text>
      <Text style={[s.sub, { color: sub }]} numberOfLines={2}>{T.sub}</Text>
      <View style={[s.chip, { backgroundColor: chipBg }]}><Text style={[s.chipTx, { color: ink }]}>{T.chip}</Text></View>
      {actionable ? (
        <View style={s.btns}>
          <Pressable onPress={() => press('decline')} accessibilityRole="button" accessibilityLabel={T.decline}
            style={({ pressed }) => [s.btn, { borderWidth: 1.2, borderColor: ink, opacity: pressed ? 0.6 : 1 }]}>
            <Text style={[s.btnTx, { color: ink }]}>{T.decline}</Text>
          </Pressable>
          <Pressable onPress={() => press('share')} accessibilityRole="button" accessibilityLabel={T.share}
            style={({ pressed }) => [s.btn, { backgroundColor: primBg, opacity: pressed ? 0.75 : 1 }]}>
            <Text style={[s.btnTx, { color: primInk }]}>{T.share}</Text>
          </Pressable>
        </View>
      ) : null}
      {cancelable ? (
        <Pressable onPress={() => press('cancel')} accessibilityRole="button" accessibilityLabel={T.cancel}
          style={({ pressed }) => [s.btn, s.btnFull, { borderWidth: 1.2, borderColor: ink, opacity: pressed ? 0.6 : 1 }]}>
          <Text style={[s.btnTx, { color: ink }]}>{T.cancel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { width: L.MAP_W + 12, alignItems: 'center', paddingTop: 6, paddingHorizontal: 6, paddingBottom: 2 },
  stage: { borderRadius: 16, overflow: 'hidden', marginBottom: 10 },
  title: { fontSize: 16, fontWeight: '800', textAlign: 'center' },
  sub: { fontSize: 12.5, fontWeight: '600', textAlign: 'center', marginTop: 3, marginHorizontal: 6 },
  chip: { height: 22, borderRadius: 11, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  chipTx: { fontSize: 11.5, fontWeight: '700' },
  btns: { flexDirection: 'row', gap: 8, marginTop: 12, alignSelf: 'stretch' },
  btn: { flex: 1, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  btnFull: { flex: 0, alignSelf: 'stretch', marginTop: 12 },
  btnTx: { fontSize: 14, fontWeight: '700' },
});

export default memo(LocationRequestCard);
