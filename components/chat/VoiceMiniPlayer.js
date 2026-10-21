// [2026-10-07 voice-native] Global voice-note mini player (WhatsApp parity).
// [2026-10-15 voice-bar] Redesigned as an INTEGRATED full-width strip
// (WhatsApp / Telegram "now playing" bar) — it never floats over a header:
//
//   • push mode (Conversas, Chamadas, Status, any other screen): the strip sits
//     right under the status bar / Dynamic Island (and under the ongoing-call
//     bar) and the whole stack is pushed down by VOICE_BAR_H
//     (services/voiceBarInset.js + CallBarInsetProvider), so large titles and
//     header buttons stay fully visible.
//   • overlay mode (inside /chat-conversation): docked right below the 56pt
//     conversation header, over the top of the message field (no push → no
//     feedback loop with the bubble's on-screen detection).
//
// Visible while a voice note is loaded in the global player
// (services/voiceNotePlayer.js) AND its bubble is not on screen.
//   [play/pause] [avatar] Name                     [1x] [X]
//                         Mensagem de voz · 0:02 / 0:05 ▮▮▮
//   ───────────── progress (bottom edge, native driver, drag = seek) ─────────
// Tap on the body → opens the conversation and scrolls to the note.
// P&B premium, SVG icons only (no emoji), Reduce Motion respected.
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { View, Text, Pressable, Animated, Easing, StyleSheet, Platform, PanResponder, ActivityIndicator } from 'react-native';
import { usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconPlay, IconPause, IconX } from '../Icons';
import { grafite, themeV2On } from '../../constants/theme';
import AvatarCircle from '../AvatarCircle';
import { useLanguage } from '../../context/LanguageContext';
import { useCallBarHeight } from '../CallStatusBar';
import { useReducedMotion } from '../reducedMotion';
import { VOICE_BAR_H, setVoiceBarPushed } from '../../services/voiceBarInset';
import {
  useVoiceMiniState, subscribeVoicePosition, getVoicePosition,
  toggleVoiceNote, stopVoiceNote, cycleVoiceRate, getVoiceConversationTitle, VOICE_TICK_MS,
  setVoiceNowPlayingSubtitle, seekVoiceNote, getVoiceConversationMeta, getActiveVoiceConversationId,
} from '../../services/voiceNotePlayer';

let _useTheme = null;
try { _useTheme = require('../../context/ThemeContext').useTheme; } catch {}

const NATIVE_DRIVER = Platform.OS !== 'web';
// /chat-conversation header = 44pt row + 6/6 padding (+ top inset).
const CONV_HEADER_H = 56;
const HIDE_ON = new Set(['/call', '/group-call']);

function fmt(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
// [2026-10-17 p2] "1,5×" in pt/es, "1.5×" in en — same label as the bubble pill.
function fmtRate(r, lang) {
  const n = Number(r) || 1;
  const s = Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
  const l = String(lang || '').toLowerCase();
  const dec = /^(en|ja|zh|ko|hi|th|he)/.test(l) ? '.' : ',';
  return s.replace('.', dec) + '\u00D7';
}

// Tiny live "wave" (4 bars) — breathes while playing, flat when paused.
function LiveWave({ playing, color, reduce }) {
  const vals = useRef([0, 1, 2, 3].map(() => new Animated.Value(0.35))).current;
  useEffect(() => {
    if (!playing || reduce) {
      vals.forEach((v, i) => { try { v.stopAnimation(); } catch {} v.setValue(playing ? [0.6, 1, 0.75, 0.5][i] : 0.35); });
      return undefined;
    }
    const loops = vals.map((v, i) => Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 1, duration: 260 + i * 70, easing: Easing.inOut(Easing.quad), useNativeDriver: NATIVE_DRIVER }),
      Animated.timing(v, { toValue: 0.3, duration: 300 + i * 50, easing: Easing.inOut(Easing.quad), useNativeDriver: NATIVE_DRIVER }),
    ])));
    // [2026-10-21 polish-conv] guarda os timeouts: pausar/tocar em <270 ms
    // deixava um loop órfão animando com o áudio parado.
    const ids = loops.map((l, i) => setTimeout(() => { try { l.start(); } catch {} }, i * 90));
    return () => { ids.forEach(clearTimeout); loops.forEach((l) => { try { l.stop(); } catch {} }); };
  }, [playing, reduce, vals]);
  return (
    <View style={s.wave} pointerEvents="none" accessible={false}>
      {vals.map((v, i) => (
        <Animated.View key={i} style={[s.waveBar, { backgroundColor: color, transform: [{ scaleY: v }] }]} />
      ))}
    </View>
  );
}

export default function VoiceMiniPlayer() {
  const st = useVoiceMiniState();
  const callBarH = useCallBarHeight();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const { t, language } = useLanguage();
  const theme = _useTheme ? _useTheme() : { isDark: false };
  const isDark = !!theme?.isDark;
  const reduce = useReducedMotion();

  const [sec, setSec] = useState(0);
  const secRef = useRef(-1);
  const [w, setW] = useState(0);
  const wRef = useRef(0);
  const prog = useRef(new Animated.Value(0)).current;
  const anim = useRef(null);
  const scrubbing = useRef(false);

  // ── Visibility / mode ──
  const visible = !!(st && !st.surfaced && st.item && !HIDE_ON.has(pathname));
  const overlay = visible && pathname === '/chat-conversation';
  const push = visible && !overlay;
  useEffect(() => { setVoiceBarPushed(push); }, [push]);
  useEffect(() => () => setVoiceBarPushed(false), []);

  // Keep the last item/state through the exit animation.
  const lastRef = useRef(null);
  if (visible) lastRef.current = { st, overlay };
  const shown = visible ? { st, overlay } : lastRef.current;
  const [mounted, setMounted] = useState(visible);
  const vis = useRef(new Animated.Value(visible ? 1 : 0)).current;
  useEffect(() => {
    try { vis.stopAnimation(); } catch {}
    if (visible) {
      setMounted(true);
      if (reduce) { vis.setValue(1); return; }
      Animated.spring(vis, { toValue: 1, useNativeDriver: NATIVE_DRIVER, damping: 24, stiffness: 300, mass: 0.9 }).start();
    } else {
      if (reduce) { vis.setValue(0); setMounted(false); return; }
      Animated.timing(vis, { toValue: 0, duration: 170, easing: Easing.in(Easing.quad), useNativeDriver: NATIVE_DRIVER })
        .start(({ finished }) => { if (finished) setMounted(false); });
    }
  }, [visible, reduce, vis]);

  // Play ↔ pause icon morph.
  const playing = !!shown?.st?.playing;
  const morph = useRef(new Animated.Value(playing ? 1 : 0)).current;
  useEffect(() => {
    if (reduce) { morph.setValue(playing ? 1 : 0); return; }
    Animated.spring(morph, { toValue: playing ? 1 : 0, useNativeDriver: NATIVE_DRIVER, damping: 18, stiffness: 340 }).start();
  }, [playing, reduce, morph]);

  // [2026-10-09 media-native] Localized subtitle for the lock-screen controls.
  const _npSubtitle = t('voiceNote.miniTitle');
  useEffect(() => {
    try { setVoiceNowPlayingSubtitle?.(_npSubtitle); } catch {}
  }, [_npSubtitle]);

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
      const s2 = Math.floor(pos / 1000);
      if (s2 !== secRef.current) { secRef.current = s2; setSec(s2); }
      if (dur <= 0 || scrubbing.current) return;
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

  const itemRef = useRef(null);
  itemRef.current = shown?.st?.item || null;
  const durMs = () => {
    const d = getVoicePosition().durationMs;
    return d > 0 ? d : (itemRef.current?.durationMs || 0);
  };

  // Drag along the bottom edge = seek.
  const seekTo = useCallback((x, commit) => {
    const ww = wRef.current;
    const it = itemRef.current;
    if (!ww || !it) return;
    const r = Math.max(0, Math.min(1, x / ww));
    prog.setValue(r);
    const d = durMs();
    if (d > 0) {
      const sNow = Math.floor((r * d) / 1000);
      if (sNow !== secRef.current) { secRef.current = sNow; setSec(sNow); }
      if (commit) seekVoiceNote(it.messageId, r * d);
    }
  }, [prog]);
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    // The strip spans the full window width from x=0 → pageX is the offset.
    onPanResponderGrant: (e) => { scrubbing.current = true; try { anim.current?.stop(); } catch {} seekTo(e.nativeEvent.pageX, false); },
    onPanResponderMove: (e, g) => { seekTo(g.moveX, false); },
    onPanResponderRelease: (e, g) => { seekTo(g.moveX || g.x0 || e.nativeEvent.pageX, true); scrubbing.current = false; },
    onPanResponderTerminate: () => { scrubbing.current = false; },
  }), [seekTo]);

  const onOpen = useCallback(() => {
    const it = itemRef.current;
    if (!it || it.conversationId == null) return;
    const convId = String(it.conversationId);
    // Already inside that chat → just scroll to the note.
    if (pathname === '/chat-conversation' && String(getActiveVoiceConversationId?.() ?? '') === convId) {
      const meta = getVoiceConversationMeta?.(convId);
      if (meta?.jumpTo) { meta.jumpTo(it.messageId); return; }
    }
    const name = getVoiceConversationTitle(it.conversationId) || it.title || '';
    try {
      require('../../services/openConversation').openConversation({
        pathname: '/chat-conversation',
        params: { id: convId, name, scrollToMessageId: String(it.messageId), highlightMessageId: String(it.messageId) },
      });
    } catch {}
  }, [pathname]);

  if (!mounted || !shown || !shown.st?.item) return null;
  const sst = shown.st;
  const it = sst.item;
  const meta = getVoiceConversationMeta?.(it.conversationId) || null;
  const label = t('voiceNote.miniTitle') || 'Mensagem de voz';
  const title = getVoiceConversationTitle(it.conversationId) || it.title || label;
  const totalSec = Math.round((it.durationMs || durMs() || 0) / 1000);
  const timeTxt = `${fmt(sec)}${totalSec > 0 ? ` / ${fmt(totalSec)}` : ''}`;

  // P&B palette (true black dark / white light).
  // [2026-10-21 polish-conv] Grafite: cinzas quentes (sem faixa branca/preta pura
  // acima do cabeçalho #F2F2EF/#0E0E10).
  const _g = themeV2On() ? grafite(isDark) : null;
  const pal = _g
    ? { top: _g.bg, strip: _g.surface, line: _g.line, text: _g.text, sub: _g.muted, btnBg: _g.ink, btnFg: _g.onInk, chip: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(24,24,27,0.06)', track: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(24,24,27,0.07)', fill: _g.ink }
    : isDark
    ? { top: '#000000', strip: '#111113', line: '#262628', text: '#FFFFFF', sub: 'rgba(255,255,255,0.62)', btnBg: '#FFFFFF', btnFg: '#000000', chip: 'rgba(255,255,255,0.12)', track: 'rgba(255,255,255,0.10)', fill: '#FFFFFF' }
    : { top: '#FFFFFF', strip: '#F6F6F7', line: 'rgba(0,0,0,0.10)', text: '#0A0A0A', sub: 'rgba(0,0,0,0.55)', btnBg: '#0A0A0A', btnFg: '#FFFFFF', chip: 'rgba(0,0,0,0.07)', track: 'rgba(0,0,0,0.07)', fill: '#0A0A0A' };

  const isOverlay = !!shown.overlay;
  const hostStyle = isOverlay
    ? { top: insets.top + callBarH + CONV_HEADER_H }
    : (callBarH ? { top: insets.top + callBarH } : { top: 0, paddingTop: insets.top, backgroundColor: pal.top });
  const slideY = vis.interpolate({ inputRange: [0, 1], outputRange: [-VOICE_BAR_H * 0.6, 0] });
  const tx = prog.interpolate({ inputRange: [0, 1], outputRange: [-(w || 1), 0] });
  const playOp = morph.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const pauseOp = morph;
  const playSc = morph.interpolate({ inputRange: [0, 1], outputRange: [1, 0.6] });
  const pauseSc = morph.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] });

  return (
    <View pointerEvents="box-none" style={[s.host, hostStyle]}>
      <Animated.View
        style={[s.clip, { opacity: vis }]}
        onLayout={(e) => { const ww = e.nativeEvent.layout.width; wRef.current = ww; if (ww !== w) setW(ww); }}
      >
        <Animated.View
          style={[s.strip, { backgroundColor: pal.strip, borderBottomColor: pal.line, transform: [{ translateY: slideY }] },
            isOverlay && s.stripOverlayShadow]}
        >
          <Pressable
            onPress={() => toggleVoiceNote(it)}
            style={({ pressed }) => [s.playBtn, { backgroundColor: pal.btnBg, opacity: pressed ? 0.75 : 1 }]}
            accessibilityRole="button"
            accessibilityLabel={sst.playing ? (t('common.pause') || 'Pausar') : (t('common.play') || 'Reproduzir')}
            hitSlop={{ top: 7, bottom: 7, left: 8, right: 4 }}
          >
            {sst.loading && !sst.playing ? (
              <ActivityIndicator size="small" color={pal.btnFg} />
            ) : (
              <>
                <Animated.View style={[s.iconLayer, { opacity: playOp, transform: [{ scale: playSc }] }]}>
                  <IconPlay size={14} color={pal.btnFg} style={{ marginLeft: 2 }} />
                </Animated.View>
                <Animated.View style={[s.iconLayer, { opacity: pauseOp, transform: [{ scale: pauseSc }] }]}>
                  <IconPause size={14} color={pal.btnFg} />
                </Animated.View>
              </>
            )}
          </Pressable>

          <Pressable
            style={({ pressed }) => [s.body, pressed && { opacity: 0.6 }]}
            onPress={onOpen}
            accessibilityRole="button"
            accessibilityLabel={`${label}, ${title}, ${timeTxt}`}
            accessibilityHint={t('voiceNote.openChat') || 'Abrir conversa'}
          >
            <AvatarCircle name={title} email={meta?.email || undefined} uri={meta?.avatar || undefined} size={28} />
            <View style={s.texts}>
              <Text style={[s.title, { color: pal.text }]} numberOfLines={1}>{title}</Text>
              <View style={s.subRow}>
                <Text style={[s.sub, { color: pal.sub }]} numberOfLines={1}>
                  {label}{' · '}<Text style={s.tab}>{timeTxt}</Text>
                  {sst.earpiece ? ` · ${t('voiceNote.earpiece') || 'Fone'}` : ''}
                </Text>
                <LiveWave playing={!!sst.playing} color={pal.sub} reduce={reduce} />
              </View>
            </View>
          </Pressable>

          <Pressable
            onPress={() => cycleVoiceRate()}
            style={({ pressed }) => [s.speed, { backgroundColor: pal.chip, opacity: pressed ? 0.6 : 1 }]}
            accessibilityRole="button"
            accessibilityLabel={`${t('chatConv.playbackSpeed') || 'Velocidade de reprodução'} ${fmtRate(sst.rate, language)}`}
            hitSlop={{ top: 10, bottom: 10, left: 6, right: 4 }}
          >
            <Text style={[s.speedTxt, { color: pal.text }]}>{fmtRate(sst.rate, language)}</Text>
          </Pressable>
          <Pressable
            onPress={() => stopVoiceNote()}
            style={({ pressed }) => [s.close, pressed && { opacity: 0.5 }]}
            accessibilityRole="button"
            accessibilityLabel={t('voiceNote.close') || 'Fechar player'}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
          >
            <IconX size={18} color={pal.sub} />
          </Pressable>

          {/* Progress along the bottom edge (drag to seek). */}
          <View pointerEvents="none" style={[s.track, { backgroundColor: pal.track }]}>
            {w > 0 ? <Animated.View style={[s.fill, { width: w, backgroundColor: pal.fill, transform: [{ translateX: tx }] }]} /> : null}
          </View>
          <View
            style={s.scrubZone}
            {...pan.panHandlers}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel={label}
            accessibilityValue={{ text: timeTxt }}
            accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
            onAccessibilityAction={(e) => {
              const d = durMs();
              if (!d) return;
              const cur = getVoicePosition().positionMs || 0;
              const step = e.nativeEvent.actionName === 'increment' ? 5000 : -5000;
              seekVoiceNote(it.messageId, Math.max(0, Math.min(d, cur + step)));
            }}
          />
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  host: { position: 'absolute', left: 0, right: 0, zIndex: 9998, elevation: 9998 },
  clip: { height: VOICE_BAR_H, overflow: 'hidden' },
  strip: {
    height: VOICE_BAR_H, flexDirection: 'row', alignItems: 'center',
    paddingLeft: 12, paddingRight: 6, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  stripOverlayShadow: Platform.select({
    ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 3 },
    android: { elevation: 2 },
    web: { boxShadow: '0 1px 3px rgba(0,0,0,0.06)' },
    default: {},
  }),
  playBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  iconLayer: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', height: '100%', paddingLeft: 10, paddingRight: 8, gap: 9 },
  texts: { flex: 1, minWidth: 0, justifyContent: 'center' },
  title: { fontSize: 13.5, fontWeight: '600', letterSpacing: -0.1 },
  subRow: { flexDirection: 'row', alignItems: 'center', marginTop: 1, gap: 6 },
  sub: { flexShrink: 1, fontSize: 12, fontWeight: '500' },
  tab: { fontVariant: ['tabular-nums'] },
  wave: { flexDirection: 'row', alignItems: 'center', height: 10, gap: 2 },
  waveBar: { width: 2, height: 10, borderRadius: 1 },
  speed: { minWidth: 38, height: 24, paddingHorizontal: 8, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginRight: 2 },
  speedTxt: { fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  close: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  track: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, overflow: 'hidden' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  scrubZone: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 9 },
});
