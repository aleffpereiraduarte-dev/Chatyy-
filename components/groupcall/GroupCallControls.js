// [2026-10-07 native-group-call] Bottom control bar of the native group call:
// mic · camera · flip (only while the camera is on) · speaker · raise hand ·
// leave. Pure presentational — all state lives in useLiveKitRoom / the screen.
import { memo } from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

export const GROUP_CONTROLS_HEIGHT = 78;

const S = { stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' };

function Icon({ name, color }) {
  const p = { ...S, stroke: color };
  switch (name) {
    case 'mic':
      return (<Svg width={24} height={24} viewBox="0 0 24 24"><Path {...p} d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3" /></Svg>);
    case 'micOff':
      return (<Svg width={24} height={24} viewBox="0 0 24 24"><Path {...p} d="M2 2l20 20M18.89 13.23A7 7 0 0 0 19 12v-2M5 10v2a7 7 0 0 0 12 5M15 9.34V5a3 3 0 0 0-5.68-1.33M9 9v3a3 3 0 0 0 5.12 2.12M12 19v3" /></Svg>);
    case 'cam':
      return (<Svg width={24} height={24} viewBox="0 0 24 24"><Path {...p} d="M22 8.5L16 12l6 3.5v-7z" /><Rect {...p} x={2} y={6} width={14} height={12} rx={2} /></Svg>);
    case 'camOff':
      return (<Svg width={24} height={24} viewBox="0 0 24 24"><Path {...p} d="M2 2l20 20M22 8.5L16 12l6 3.5v-7zM16 12V8a2 2 0 0 0-2-2H6M2 8v8a2 2 0 0 0 2 2h10" /></Svg>);
    case 'flip':
      return (<Svg width={24} height={24} viewBox="0 0 24 24"><Path {...p} d="M20 7h-3l-2-3H9L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zM9 13a3 3 0 0 1 5.2-2M15 13a3 3 0 0 1-5.2 2M14 9.5l.4 1.6-1.6.3M10 16.5l-.4-1.6 1.6-.3" /></Svg>);
    case 'speaker':
      return (<Svg width={24} height={24} viewBox="0 0 24 24"><Path {...p} d="M11 5L6 9H2v6h4l5 4V5zM15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" /></Svg>);
    case 'earpiece':
      return (<Svg width={24} height={24} viewBox="0 0 24 24"><Path {...p} d="M11 5L6 9H2v6h4l5 4V5z" /></Svg>);
    case 'hand':
      return (<Svg width={24} height={24} viewBox="0 0 24 24"><Path {...p} d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6.5-2.9L1 15a2.83 2.83 0 0 1 4-4l3 3" /></Svg>);
    case 'leave':
      return (<Svg width={26} height={26} viewBox="0 0 24 24"><Path {...p} d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.75 2 2 0 0 1 1.7 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91M22 2L2 22" /></Svg>);
    default:
      return null;
  }
}

function Btn({ icon, active, inverted, danger, onPress, label, disabled }) {
  const color = inverted ? '#0a0a14' : '#fff';
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active, disabled: !!disabled }}
      style={[styles.btn, inverted && styles.btnInverted, active && styles.btnActive, danger && styles.btnDanger, disabled && { opacity: 0.4 }]}
    >
      <Icon name={icon} color={color} />
    </TouchableOpacity>
  );
}

function GroupCallControls({
  bottomInset = 0,
  micOn,
  camOn,
  speakerOn,
  handRaised,
  disabled,
  onToggleMic,
  onToggleCam,
  onFlip,
  onToggleSpeaker,
  onToggleHand,
  onLeave,
  t,
}) {
  const tr = (k, fb) => { try { const v = t ? t(k) : null; return v && v !== k ? v : fb; } catch { return fb; } };
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { paddingBottom: bottomInset + 12 }]}>
      <View style={styles.row}>
        <Btn icon={micOn ? 'mic' : 'micOff'} inverted={!micOn} onPress={onToggleMic} disabled={disabled} label={micOn ? tr('call.mute', 'Silenciar') : tr('call.unmute', 'Ativar microfone')} />
        <Btn icon={camOn ? 'cam' : 'camOff'} inverted={!camOn} onPress={onToggleCam} disabled={disabled} label={camOn ? tr('call.cameraOff', 'Desligar câmera') : tr('call.cameraOn', 'Ligar câmera')} />
        {camOn ? (
          <Btn icon="flip" onPress={onFlip} disabled={disabled} label={tr('call.flipCamera', 'Virar câmera')} />
        ) : null}
        <Btn icon={speakerOn ? 'speaker' : 'earpiece'} active={speakerOn} onPress={onToggleSpeaker} disabled={disabled} label={tr('call.speaker', 'Alto-falante')} />
        <Btn icon="hand" active={handRaised} onPress={onToggleHand} disabled={disabled} label={handRaised ? tr('call.group.lowerHand', 'Baixar a mão') : tr('call.group.raiseHand', 'Levantar a mão')} />
        <Btn icon="leave" danger onPress={onLeave} label={tr('call.leave', 'Sair')} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 12,
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    zIndex: 50,
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 12 },
  btn: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnInverted: { backgroundColor: '#fff' },
  btnActive: { backgroundColor: 'rgba(96,165,250,0.45)' },
  btnDanger: { backgroundColor: '#DC2626', width: 54, height: 54, borderRadius: 27 },
});

export default memo(GroupCallControls);
