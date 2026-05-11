import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { Colors, FontSize } from '../constants/theme';
import { IconMic, IconMicOff, IconVideo, IconVideoOff, IconMonitor, IconPhoneOff, IconMessageCircle, IconUsers, IconMoreVert, IconThumbsUp, IconHeart, IconLaughFace, IconClap, IconSurpriseFace, IconFlame, IconThinkingFace, IconHundred, IconRaisedHand, IconSmileFace, IconUserPlus } from './Icons';

const REACTIONS = [
  { key: 'thumbsup', Icon: IconThumbsUp },
  { key: 'heart', Icon: IconHeart },
  { key: 'laugh', Icon: IconLaughFace },
  { key: 'clap', Icon: IconClap },
  { key: 'surprise', Icon: IconSurpriseFace },
  { key: 'fire', Icon: IconFlame },
  { key: 'thinking', Icon: IconThinkingFace },
  { key: 'hundred', Icon: IconHundred },
];

export default function MeetControls({
  audioMuted, videoMuted, screenSharing, handRaised,
  onToggleAudio, onToggleVideo, onScreenShare, onStopScreenShare, onEndCall, onToggleChat,
  onToggleParticipants, onRaiseHand, onReaction, onToggleMore, onAddPeople,
  participantCount, unreadChat, lobbyCount,
  screenShareDisabled, screenShareDisabledLabel,
}) {
  const [showReactions, setShowReactions] = useState(false);

  return (
    <View style={s.container}>
      {/* Reactions picker */}
      {showReactions && (
        <View style={s.reactionPicker}>
          {REACTIONS.map(r => (
            <TouchableOpacity
              key={r.key}
              style={s.reactionBtn}
              onPress={() => { onReaction?.(r.key); setShowReactions(false); }}
              activeOpacity={0.7}
            >
              <r.Icon size={22} color={Colors.meetText} />
            </TouchableOpacity>
          ))}
        </View>
      )}

      <View style={[s.bar, Platform.OS === 'web' && s.barGlass]}>
        {/* Mic */}
        <TouchableOpacity style={[s.btn, audioMuted && s.btnActive]} onPress={onToggleAudio} activeOpacity={0.7}>
          {audioMuted ? <IconMicOff size={22} color={Colors.meetText} /> : <IconMic size={22} color={Colors.meetText} />}
        </TouchableOpacity>

        {/* Video */}
        <TouchableOpacity style={[s.btn, videoMuted && s.btnActive]} onPress={onToggleVideo} activeOpacity={0.7}>
          {videoMuted ? <IconVideoOff size={22} color={Colors.meetText} /> : <IconVideo size={22} color={Colors.meetText} />}
        </TouchableOpacity>

        {/* Screen Share — hidden on native where it's unsupported */}
        {!screenShareDisabled && (
          <TouchableOpacity
            style={[s.btn, screenSharing && s.btnScreenActive]}
            onPress={() => (screenSharing ? onStopScreenShare : onScreenShare)?.()}
            activeOpacity={0.7}
          >
            <IconMonitor size={22} color={screenSharing ? '#fff' : Colors.meetText} />
          </TouchableOpacity>
        )}

        {/* Add People (WhatsApp-style) */}
        <TouchableOpacity style={s.btn} onPress={onAddPeople} activeOpacity={0.7}>
          <IconUserPlus size={20} color={Colors.meetText} />
        </TouchableOpacity>

        {/* Raise Hand */}
        <TouchableOpacity style={[s.btn, handRaised && s.btnHandActive]} onPress={onRaiseHand} activeOpacity={0.7}>
          <IconRaisedHand size={20} color={Colors.meetText} />
        </TouchableOpacity>

        {/* Reactions */}
        <TouchableOpacity style={s.btn} onPress={() => setShowReactions(prev => !prev)} activeOpacity={0.7}>
          <IconSmileFace size={20} color={Colors.meetText} />
        </TouchableOpacity>

        {/* Chat */}
        <TouchableOpacity style={s.btn} onPress={onToggleChat} activeOpacity={0.7}>
          <IconMessageCircle size={22} color={Colors.meetText} />
          {unreadChat > 0 && (
            <View style={s.badge}>
              <Text style={s.badgeText}>{unreadChat > 9 ? '9+' : unreadChat}</Text>
            </View>
          )}
        </TouchableOpacity>

        {/* Participants */}
        <TouchableOpacity style={s.btn} onPress={onToggleParticipants} activeOpacity={0.7}>
          <IconUsers size={22} color={Colors.meetText} />
          {(lobbyCount > 0) && (
            <View style={[s.badge, { backgroundColor: Colors.meetHandRaised }]}>
              <Text style={s.badgeText}>{lobbyCount}</Text>
            </View>
          )}
          <Text style={s.participantText}>{participantCount || ''}</Text>
        </TouchableOpacity>

        {/* More menu */}
        <TouchableOpacity style={s.btn} onPress={onToggleMore} activeOpacity={0.7}>
          <IconMoreVert size={22} color={Colors.meetText} />
        </TouchableOpacity>

        {/* End Call */}
        <TouchableOpacity style={s.endBtn} onPress={onEndCall} activeOpacity={0.7}>
          <IconPhoneOff size={22} color={Colors.meetText} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    position: 'absolute', bottom: 20, left: 0, right: 0,
    alignItems: 'center', zIndex: 100,
  },
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: Colors.meetSurface,
    borderRadius: 28,
  },
  barGlass: Platform.OS === 'web' ? {
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  } : {},
  btn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: Colors.meetBtnBg,
    alignItems: 'center', justifyContent: 'center',
  },
  btnActive: { backgroundColor: Colors.meetBtnActive },
  btnScreenActive: { backgroundColor: Colors.meetScreenShare },
  btnHandActive: { backgroundColor: Colors.meetHandRaised },
  endBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: Colors.meetEndCall,
    alignItems: 'center', justifyContent: 'center',
    marginLeft: 4,
  },
  badge: {
    position: 'absolute', top: -4, right: -4,
    backgroundColor: Colors.primary, borderRadius: 10,
    minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: { color: Colors.meetText, fontSize: 10, fontWeight: '700' },
  participantText: {
    color: Colors.meetTextSecondary, fontSize: 10, fontWeight: '600',
    position: 'absolute', bottom: 2,
  },
  reactionPicker: {
    flexDirection: 'row', gap: 8,
    backgroundColor: Colors.meetSurfaceSolid,
    borderRadius: 20, paddingHorizontal: 12, paddingVertical: 8,
    marginBottom: 8,
  },
  reactionBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: Colors.meetBtnBg,
    alignItems: 'center', justifyContent: 'center',
  },
});
