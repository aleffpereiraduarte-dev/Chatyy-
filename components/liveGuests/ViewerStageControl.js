// [multi-guest 2026-10-10] Controle do ESPECTADOR acima do campo de
// comentário (substitui o LiveJoinPill), com estados claros:
//   idle       → "Pedir para participar"
//   pending    → chip "Pedido enviado" + "Cancelar"
//   connecting → "Entrando no palco…"
//   live       → mic / câmera / "Sair do palco"
//   declined | full | removed → chip informativo (some sozinho)
import React, { memo } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { IconRaisedHand, IconMic, IconMicOff, IconVideo, IconVideoOff, IconCheck, IconLogOut } from '../Icons';

function ViewerStageControl({ state, t, onRequest, onCancel, onLeave, micOn, camOn, onToggleMic, onToggleCam, notice }) {
  if (state === 'live') {
    return (
      <View style={styles.row}>
        <Pressable onPress={onToggleMic} accessibilityRole="switch" accessibilityState={{ checked: !!micOn }} accessibilityLabel={t('liveGuests.mic')}
          style={({ pressed }) => [styles.circle, !micOn && styles.circleOff, pressed && { opacity: 0.7 }]}>
          {micOn ? <IconMic size={16} color="#000" /> : <IconMicOff size={16} color="#fff" />}
        </Pressable>
        <Pressable onPress={onToggleCam} accessibilityRole="switch" accessibilityState={{ checked: !!camOn }} accessibilityLabel={t('liveGuests.camera')}
          style={({ pressed }) => [styles.circle, !camOn && styles.circleOff, pressed && { opacity: 0.7 }]}>
          {camOn ? <IconVideo size={16} color="#000" /> : <IconVideoOff size={16} color="#fff" />}
        </Pressable>
        <Pressable onPress={onLeave} accessibilityRole="button" style={({ pressed }) => [styles.pill, styles.pillDark, pressed && { opacity: 0.7 }]}>
          <IconLogOut size={15} color="#fff" />
          <Text style={styles.pillTextLight}>{t('liveGuests.leave')}</Text>
        </Pressable>
      </View>
    );
  }
  if (state === 'connecting') {
    return (
      <View style={styles.row}>
        <View style={[styles.pill, styles.pillDark]}>
          <ActivityIndicator size="small" color="#fff" />
          <Text style={styles.pillTextLight}>{t('liveGuests.connecting')}</Text>
        </View>
      </View>
    );
  }
  if (state === 'pending') {
    return (
      <View style={styles.row}>
        <View style={[styles.pill, styles.pillDark]}>
          <IconCheck size={15} color="#fff" />
          <Text style={styles.pillTextLight}>{t('liveGuests.pending')}</Text>
        </View>
        <Pressable onPress={onCancel} accessibilityRole="button" accessibilityLabel={t('liveGuests.cancelRequest')}
          style={({ pressed }) => [styles.pill, styles.pillGhost, pressed && { opacity: 0.7 }]}>
          <Text style={styles.pillTextLight}>{t('liveGuests.cancel')}</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={styles.row}>
      {notice ? (
        <View style={[styles.pill, styles.pillDark]}>
          <Text style={styles.pillTextLight} numberOfLines={1}>{notice}</Text>
        </View>
      ) : (
        <Pressable onPress={onRequest} accessibilityRole="button" style={({ pressed }) => [styles.pill, styles.pillLight, pressed && { opacity: 0.8 }]}>
          <IconRaisedHand size={15} color="#000" />
          <Text style={styles.pillTextDark}>{t('liveGuests.requestToJoin')}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pill: { height: 34, paddingHorizontal: 14, borderRadius: 17, flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 300 },
  pillLight: { backgroundColor: '#fff' },
  pillDark: { backgroundColor: 'rgba(0,0,0,0.6)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.25)' },
  pillGhost: { backgroundColor: 'rgba(255,255,255,0.14)' },
  pillTextDark: { color: '#000', fontSize: 13, fontWeight: '700' },
  pillTextLight: { color: '#fff', fontSize: 13, fontWeight: '700', flexShrink: 1 },
  circle: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  circleOff: { backgroundColor: 'rgba(0,0,0,0.6)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.25)' },
});

export default memo(ViewerStageControl);
