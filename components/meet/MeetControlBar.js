// [2026-10-15 meet-v2] Barra de controles da reunião — CABE em qualquer largura.
// 6 botões fixos: mic · câmera · (virar câmera no celular | compartilhar tela no web)
// · reações/mão · Mais · sair (vermelho). O resto vive no sheet "Mais".
// Tamanho do botão = largura disponível / 6 (44–58 px); respeita safe-area.
import { memo, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import {
  IconMic, IconMicOff, IconVideo, IconVideoOff, IconCameraFlip, IconMonitor, IconPhoneOff,
  IconMoreHorizontal, IconRaisedHand, IconSmileFace, IconThumbsUp, IconHeart, IconLaughFace,
  IconClap, IconSurpriseFace, IconFlame,
} from '../Icons';

const REACTIONS = [
  { key: 'thumbsup', Icon: IconThumbsUp },
  { key: 'heart', Icon: IconHeart },
  { key: 'laugh', Icon: IconLaughFace },
  { key: 'clap', Icon: IconClap },
  { key: 'surprise', Icon: IconSurpriseFace },
  { key: 'fire', Icon: IconFlame },
];

const H_PAD = 14;
const GAP = 10;

function CtrlButton({ size, onPress, label, active, danger, children, badge, disabled }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active, disabled: !!disabled }}
      hitSlop={4}
      style={({ pressed }) => [
        s.btn,
        { width: size, height: size, borderRadius: size / 2 },
        active && s.btnActive,
        danger && s.btnDanger,
        disabled && { opacity: 0.4 },
        pressed && { transform: [{ scale: 0.92 }], opacity: 0.9 },
      ]}
    >
      {children}
      {badge ? (
        <View style={s.badge}><Text style={s.badgeText}>{badge}</Text></View>
      ) : null}
    </Pressable>
  );
}

function MeetControlBar({
  t, bottomInset = 0, audioMuted, videoMuted, handRaised, screenSharing,
  onToggleAudio, onToggleVideo, onFlipCamera, onScreenShare, onRaiseHand, onReaction,
  onMore, onLeave, moreBadge, visible = true, onLayout,
}) {
  const { width } = useWindowDimensions();
  const [tray, setTray] = useState(false);
  const barWidth = Math.min(width, 520);
  const size = Math.max(44, Math.min(58, Math.floor((barWidth - H_PAD * 2 - GAP * 5) / 6)));
  const icon = Math.round(size * 0.42);
  const isWeb = Platform.OS === 'web';

  if (!visible) return null;

  return (
    <View style={[s.wrap, { paddingBottom: Math.max(bottomInset, 12) + 4 }]} onLayout={onLayout} pointerEvents="box-none">
      {tray ? (
        <View style={s.tray} accessibilityRole="menu">
          <Pressable
            onPress={() => { onRaiseHand?.(); setTray(false); }}
            accessibilityRole="button"
            accessibilityLabel={handRaised ? t('meetV2.lowerHand') : t('meetV2.raiseHand')}
            style={({ pressed }) => [s.handPill, handRaised && s.handPillOn, pressed && { opacity: 0.8 }]}
          >
            <IconRaisedHand size={18} color={handRaised ? '#000' : '#fff'} />
            <Text style={[s.handText, handRaised && { color: '#000' }]} numberOfLines={1}>
              {handRaised ? t('meetV2.lowerHand') : t('meetV2.raiseHand')}
            </Text>
          </Pressable>
          <View style={s.trayRow}>
            {REACTIONS.map((r) => (
              <Pressable
                key={r.key}
                onPress={() => { onReaction?.(r.key); setTray(false); }}
                accessibilityRole="button"
                accessibilityLabel={r.key}
                style={({ pressed }) => [s.reactBtn, pressed && { transform: [{ scale: 0.88 }] }]}
              >
                <r.Icon size={22} color="#fff" />
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
      <View style={[s.bar, { width: barWidth - 16, paddingHorizontal: H_PAD - 8 }]}>
        <CtrlButton size={size} onPress={onToggleAudio} active={audioMuted} label={audioMuted ? t('meet.unmute') : t('meet.mute')}>
          {audioMuted ? <IconMicOff size={icon} color="#000" /> : <IconMic size={icon} color="#fff" />}
        </CtrlButton>
        <CtrlButton size={size} onPress={onToggleVideo} active={videoMuted} label={videoMuted ? t('meet.startVideo') : t('meet.stopVideo')}>
          {videoMuted ? <IconVideoOff size={icon} color="#000" /> : <IconVideo size={icon} color="#fff" />}
        </CtrlButton>
        {isWeb ? (
          <CtrlButton size={size} onPress={onScreenShare} active={screenSharing} label={screenSharing ? t('meet.stopSharing') : t('meet.shareScreen')}>
            <IconMonitor size={icon} color={screenSharing ? '#000' : '#fff'} />
          </CtrlButton>
        ) : (
          <CtrlButton size={size} onPress={onFlipCamera} disabled={videoMuted} label={t('meetV2.flipCamera')}>
            <IconCameraFlip size={icon} color="#fff" />
          </CtrlButton>
        )}
        <CtrlButton size={size} onPress={() => setTray((v) => !v)} active={tray || handRaised} label={t('meetV2.reactions')}>
          {handRaised && !tray
            ? <IconRaisedHand size={icon} color="#000" />
            : <IconSmileFace size={icon} color={tray ? '#000' : '#fff'} />}
        </CtrlButton>
        <CtrlButton size={size} onPress={() => { setTray(false); onMore?.(); }} label={t('meetV2.more')} badge={moreBadge}>
          <IconMoreHorizontal size={icon} color="#fff" />
        </CtrlButton>
        <CtrlButton size={size} onPress={onLeave} danger label={t('meetScreen.leave')}>
          <IconPhoneOff size={icon} color="#fff" />
        </CtrlButton>
      </View>
    </View>
  );
}

export default memo(MeetControlBar);

const s = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', zIndex: 100 },
  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 10, borderRadius: 999,
    backgroundColor: 'rgba(22,22,22,0.92)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.12)',
    ...Platform.select({ web: { backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)' }, default: {} }),
  },
  btn: { backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' },
  btnActive: { backgroundColor: '#fff' },
  btnDanger: { backgroundColor: '#FF3B30' },
  badge: {
    position: 'absolute', top: -2, right: -2, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4,
    backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#161616',
  },
  badgeText: { color: '#000', fontSize: 10, fontWeight: '800' },
  tray: {
    marginBottom: 10, padding: 10, borderRadius: 22, backgroundColor: 'rgba(22,22,22,0.96)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.12)', alignItems: 'center', maxWidth: '94%',
  },
  trayRow: { flexDirection: 'row', gap: 6, marginTop: 8 },
  reactBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.10)', alignItems: 'center', justifyContent: 'center' },
  handPill: {
    flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'stretch', justifyContent: 'center',
    paddingVertical: 10, paddingHorizontal: 14, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.10)',
  },
  handPillOn: { backgroundColor: '#fff' },
  handText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
