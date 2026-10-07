// [2026-10-07 voice-native] Global voice-note mini player (WhatsApp parity).
//
// Mounted once in app/_layout.js. Visible while a voice note is loaded in the
// global player (services/voiceNotePlayer.js) AND its bubble is not on screen —
// i.e. the user left the chat (or scrolled the note far out of a virtualised
// list). Play/pause, speed (1×/1.5×/2×, persisted), close (stops), tap → back
// to the conversation. Progress line = RN Animated transform (native driver),
// time label re-renders once per second at most. SVG icons only (no emoji).
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, Animated, Easing, StyleSheet, Platform, StatusBar } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { IconPlay, IconPause, IconX, IconMic } from '../Icons';
import { useLanguage } from '../../context/LanguageContext';
import {
  useVoiceMiniState, subscribeVoicePosition, getVoicePosition,
  toggleVoiceNote, stopVoiceNote, cycleVoiceRate, getVoiceConversationTitle, VOICE_TICK_MS,
} from '../../services/voiceNotePlayer';

const SAFE_TOP = Platform.OS === 'ios'
  ? 50
  : Math.max(24, (StatusBar.currentHeight || 24)) + 4;
// Sits just below a standard 56dp header so it never covers back/title.
const TOP = SAFE_TOP + 52;
const NATIVE_DRIVER = Platform.OS !== 'web';

function fmt(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function VoiceMiniPlayer() {
  const st = useVoiceMiniState();
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useLanguage();
  const [sec, setSec] = useState(0);
  const secRef = useRef(-1);
  const [w, setW] = useState(0);
  const prog = useRef(new Animated.Value(0)).current;
  const anim = useRef(null);
  const messageId = st?.item?.messageId;

  useEffect(() => {
    if (messageId == null) return undefined;
    const { positionMs, durationMs } = getVoicePosition();
    if (durationMs > 0) prog.setValue(Math.min(1, positionMs / durationMs));
    secRef.current = Math.floor(positionMs / 1000);
    setSec(secRef.current);
    return subscribeVoicePosition(messageId, (e) => {
      const dur = e.durationMs || 0;
      const pos = e.positionMs || 0;
      const s = Math.floor(pos / 1000);
      if (s !== secRef.current) { secRef.current = s; setSec(s); }
      if (dur <= 0) return;
      try { anim.current?.stop(); } catch {}
      if (e.playing && !e.seeked) {
        anim.current = Animated.timing(prog, {
          toValue: Math.min(1, (pos + VOICE_TICK_MS * (e.rate || 1)) / dur),
          duration: VOICE_TICK_MS, easing: Easing.linear, useNativeDriver: NATIVE_DRIVER,
        });
        anim.current.start();
      } else {
        prog.setValue(Math.min(1, pos / dur));
      }
    });
  }, [messageId, prog]);

  const onOpen = useCallback(() => {
    const it = st?.item;
    if (!it || it.conversationId == null) return;
    const name = getVoiceConversationTitle(it.conversationId) || it.title || '';
    try { router.push({ pathname: '/chat-conversation', params: { id: String(it.conversationId), name } }); } catch {}
  }, [st?.item, router]);

  if (!st || st.surfaced || !st.item || pathname === '/call') return null;
  const it = st.item;
  const title = getVoiceConversationTitle(it.conversationId) || it.title || (t('voiceNote.miniTitle') || 'Mensagem de voz');
  const totalSec = Math.round((it.durationMs || 0) / 1000);
  const tx = prog.interpolate({ inputRange: [0, 1], outputRange: [-w, 0] });

  return (
    <View pointerEvents="box-none" style={[s.host, { top: TOP }]}>
      <View style={s.pill} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
        <TouchableOpacity
          onPress={() => toggleVoiceNote(it)}
          style={s.playBtn}
          accessibilityRole="button"
          accessibilityLabel={st.playing ? (t('common.pause') || 'Pausar') : (t('common.play') || 'Reproduzir')}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          {st.playing ? <IconPause size={16} color="#fff" /> : <IconPlay size={16} color="#fff" />}
        </TouchableOpacity>
        <TouchableOpacity style={s.center} onPress={onOpen} accessibilityRole="button" accessibilityLabel={t('voiceNote.openChat') || 'Abrir conversa'}>
          <IconMic size={14} color="rgba(255,255,255,0.75)" />
          <Text style={s.title} numberOfLines={1}>{title}</Text>
          <Text style={s.time}>{fmt(sec)}{totalSec > 0 ? ` / ${fmt(totalSec)}` : ''}</Text>
        </TouchableOpacity>
        {st.earpiece ? (
          <Text style={s.ear} numberOfLines={1}>{t('voiceNote.earpiece') || 'Fone'}</Text>
        ) : null}
        <TouchableOpacity
          onPress={() => cycleVoiceRate()}
          style={s.speed}
          accessibilityRole="button"
          accessibilityLabel={`${t('chatConv.playbackSpeed') || 'Velocidade de reprodução'} ${st.rate}x`}
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
        >
          <Text style={s.speedTxt}>{st.rate}x</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => stopVoiceNote()}
          style={s.close}
          accessibilityRole="button"
          accessibilityLabel={t('voiceNote.close') || 'Fechar player'}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <IconX size={16} color="rgba(255,255,255,0.85)" />
        </TouchableOpacity>
        {w > 0 ? (
          <View pointerEvents="none" style={s.track}>
            <Animated.View style={[s.fill, { width: w, transform: [{ translateX: tx }] }]} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  host: { position: 'absolute', left: 10, right: 10, zIndex: 9998, elevation: 9998, alignItems: 'stretch' },
  pill: {
    flexDirection: 'row', alignItems: 'center', height: 44, borderRadius: 22,
    backgroundColor: 'rgba(17,17,17,0.94)', paddingLeft: 6, paddingRight: 8, overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.22, shadowRadius: 8 },
      android: { elevation: 6 },
      web: { boxShadow: '0 3px 14px rgba(0,0,0,0.25)' },
    }),
  },
  playBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.16)' },
  center: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, height: '100%' },
  title: { flexShrink: 1, color: '#fff', fontSize: 13, fontWeight: '700' },
  time: { color: 'rgba(255,255,255,0.75)', fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  ear: { color: '#53BDEB', fontSize: 11, fontWeight: '700', marginRight: 6 },
  speed: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.16)', marginRight: 4 },
  speedTxt: { color: '#fff', fontSize: 11, fontWeight: '800' },
  close: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  track: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, overflow: 'hidden' },
  fill: { height: 2, backgroundColor: '#53BDEB' },
});
