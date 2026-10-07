// [2026-10-07 native-group-call] One participant tile of the native group
// grid. Renders the LiveKit VideoView ONLY when the tile is on the visible
// page AND the participant has a live camera track; otherwise an avatar.
// Active-speaker highlight is an overlay border (never reflows the video
// surface). Long-press → participant menu (silence-for-me / pin).
import { memo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import AvatarCircle from '../AvatarCircle';
import { getLiveKitVideoView } from '../../hooks/useLiveKitRoom';

const SPEAKER_RING = '#34d399';
const PIN_RING = '#60A5FA';

function MicOffIcon() {
  return (
    <Svg width={12} height={12} viewBox="0 0 24 24" fill="none">
      <Path d="M2 2l20 20M18.89 13.23A7 7 0 0 0 19 12v-2M5 10v2a7 7 0 0 0 12 5M15 9.34V5a3 3 0 0 0-5.68-1.33M9 9v3a3 3 0 0 0 5.12 2.12M12 19v3" stroke="#f87171" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function HandIcon() {
  return (
    <Svg width={12} height={12} viewBox="0 0 24 24" fill="none">
      <Path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6.5-2.9L1 15a2.83 2.83 0 0 1 4-4l3 3" stroke="#fbbf24" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function SilencedIcon() {
  return (
    <Svg width={12} height={12} viewBox="0 0 24 24" fill="none">
      <Path d="M11 5L6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function GroupCallTile({
  vm,
  width,
  height,
  visible,
  speaking,
  pinned,
  silenced,
  handRaised,
  mirrorLocal,
  youLabel,
  onLongPress,
}) {
  const VideoView = getLiveKitVideoView();
  const showVideo = !!(visible && VideoView && vm.videoOn && vm.videoTrack);
  const avatarSize = Math.max(40, Math.min(104, Math.round(Math.min(width, height) * 0.4)));
  const label = vm.isLocal ? (youLabel || 'Você') : vm.name;
  return (
    <Pressable
      onLongPress={vm.isLocal ? undefined : () => onLongPress && onLongPress(vm)}
      delayLongPress={350}
      style={[styles.tile, { width, height }]}
      accessibilityLabel={label}
    >
      {showVideo ? (
        <VideoView
          key={vm.videoSid || vm.sid}
          videoTrack={vm.videoTrack}
          style={StyleSheet.absoluteFill}
          objectFit="cover"
          mirror={!!(vm.isLocal && mirrorLocal)}
          zOrder={vm.isLocal ? 1 : 0}
        />
      ) : (
        <View style={styles.center}>
          <AvatarCircle email={vm.email} name={vm.name} size={avatarSize} />
        </View>
      )}
      <View pointerEvents="none" style={styles.namePill}>
        {vm.muted ? <MicOffIcon /> : null}
        {handRaised ? <HandIcon /> : null}
        {silenced ? <SilencedIcon /> : null}
        <Text style={styles.nameText} numberOfLines={1}>{label}</Text>
      </View>
      {(speaking || pinned) ? (
        <View
          pointerEvents="none"
          style={[styles.ring, { borderColor: speaking ? SPEAKER_RING : PIN_RING }]}
        />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    backgroundColor: '#15151c',
    borderRadius: 14,
    overflow: 'hidden',
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  namePill: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    maxWidth: '86%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  nameText: { color: '#fff', fontSize: 12, fontWeight: '600', flexShrink: 1 },
  ring: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 14,
    borderWidth: 3,
  },
});

export default memo(GroupCallTile);
