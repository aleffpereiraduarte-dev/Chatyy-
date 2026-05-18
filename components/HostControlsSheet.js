// HostControlsSheet.js (2026-05-18)
//
// Compact bottom action sheet that surfaces host-only / co-host-only
// actions for a group call. Triggered from a "host controls" button in
// /app/group-call.js (top-right gear / shield icon).
//
// Actions:
//   - Mute all (everyone except host/cohost)
//   - Lock / unlock the room (no new joiners)
//   - Start / stop recording — with explicit legal-consent confirmation
//   - Share persistent room link (copies to clipboard via expo-clipboard)
//
// The sheet is "dumb" — every action just calls the corresponding handler
// passed by the parent, which is responsible for the actual API call and
// optimistic state. We DO render the confirmation dialog for recording
// here because the consent copy is host-control specific.
//
// Co-host vs host:
//   - Mute all, lock, share link → host + cohost
//   - Recording → host ONLY (legal liability sits with the host)

import React, { useRef, useEffect, useCallback, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  Animated,
  Easing,
  Alert,
  Platform,
} from 'react-native';
import Svg, { Path as SvgPath, Circle as SvgCircle } from 'react-native-svg';
import { useLanguage } from '../context/LanguageContext';

const BRAND_PURPLE = '#7C3AED';
const DANGER = '#EF4444';
const REC_RED = '#DC2626';

const ROLE = { GUEST: 0, COHOST: 1, HOST: 2 };

// Inline icons — small bag, avoids dragging the full Icons barrel into
// the host-controls path (this sheet is opened rarely).
const IconMic = ({ size = 18, color = '#fff' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <SvgPath d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    <SvgPath d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8M2 2l20 20" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);
const IconLock = ({ size = 18, color = '#fff', open = false }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <SvgPath d="M5 11h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z" stroke={color} strokeWidth={2} strokeLinejoin="round" />
    {open
      ? <SvgPath d="M7 11V7a5 5 0 0 1 9.9-1" stroke={color} strokeWidth={2} strokeLinecap="round" />
      : <SvgPath d="M7 11V7a5 5 0 0 1 10 0v4" stroke={color} strokeWidth={2} strokeLinecap="round" />
    }
  </Svg>
);
const IconRec = ({ size = 18, color = '#fff', active = false }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <SvgCircle cx={12} cy={12} r={9} stroke={color} strokeWidth={2} />
    <SvgCircle cx={12} cy={12} r={4} fill={active ? REC_RED : color} />
  </Svg>
);
const IconLink = ({ size = 18, color = '#fff' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <SvgPath d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);
const IconClose = ({ size = 20, color = '#fff' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <SvgPath d="M18 6L6 18M6 6l12 12" stroke={color} strokeWidth={2} strokeLinecap="round" />
  </Svg>
);
const IconShield = ({ size = 18, color = '#fff' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <SvgPath d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke={color} strokeWidth={2} strokeLinejoin="round" />
  </Svg>
);

function ActionRow({ icon: Icon, label, sublabel, onPress, danger, disabled, accent }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
      style={[styles.row, disabled && { opacity: 0.4 }]}
    >
      <View style={[styles.rowIcon, { backgroundColor: accent || 'rgba(255,255,255,0.08)' }]}>
        <Icon color={danger ? DANGER : '#fff'} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowLabel, danger && { color: DANGER }]}>{label}</Text>
        {sublabel ? <Text style={styles.rowSub} numberOfLines={2}>{sublabel}</Text> : null}
      </View>
    </TouchableOpacity>
  );
}

export default function HostControlsSheet({
  visible,
  onClose,
  myRole = ROLE.GUEST,
  locked = false,
  recording = false,
  onMuteAll,         // () => Promise<void>
  onToggleLock,      // (next: bool) => Promise<void>
  onToggleRecording, // (next: bool) => Promise<void>
  onShareLink,       // () => Promise<{url, copied}>
}) {
  const { t } = useLanguage();
  const translateY = useRef(new Animated.Value(80)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const [busy, setBusy] = useState(null); // 'mute' | 'lock' | 'rec' | 'link' | null

  // Slide-in / fade. Reset state when closed so the sheet always starts fresh.
  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.spring(translateY, { toValue: 0, friction: 8, tension: 70, useNativeDriver: true }),
      ]).start();
    } else {
      translateY.setValue(80);
      opacity.setValue(0);
      setBusy(null);
    }
  }, [visible, translateY, opacity]);

  const canHost = myRole >= ROLE.COHOST;
  const canRecord = myRole >= ROLE.HOST; // host-only, never co-host

  const guard = useCallback(async (key, fn) => {
    if (busy) return;
    setBusy(key);
    try { await fn(); } catch (e) { if (__DEV__) console.warn('[HostControls]', key, e?.message); }
    finally { setBusy(null); }
  }, [busy]);

  const handleMuteAll = useCallback(() => {
    Alert.alert(
      t('call.group.muteAll') || 'Mute all',
      // Surface a short rationale so a host doesn't fire it by accident
      // and only realize after everyone goes silent.
      t('call.group.muteAllConfirm') || 'Mute every participant except hosts?',
      [
        { text: t('common.cancel') || 'Cancel', style: 'cancel' },
        { text: t('call.group.muteAll') || 'Mute all', style: 'destructive', onPress: () => guard('mute', async () => { await onMuteAll?.(); onClose?.(); }) },
      ]
    );
  }, [guard, onMuteAll, onClose, t]);

  const handleToggleLock = useCallback(() => {
    guard('lock', async () => { await onToggleLock?.(!locked); });
  }, [guard, onToggleLock, locked]);

  const handleToggleRecording = useCallback(() => {
    if (recording) {
      guard('rec', async () => { await onToggleRecording?.(false); });
      return;
    }
    Alert.alert(
      t('call.group.recordConfirmTitle') || 'Start recording?',
      t('call.group.recordingConsent') || 'Everyone will be notified the call is being recorded',
      [
        { text: t('call.group.recordConfirmNo') || 'Cancel', style: 'cancel' },
        {
          text: t('call.group.recordConfirmYes') || 'Notify and record',
          onPress: () => guard('rec', async () => { await onToggleRecording?.(true); onClose?.(); }),
        },
      ]
    );
  }, [recording, guard, onToggleRecording, onClose, t]);

  const handleShareLink = useCallback(() => {
    guard('link', async () => {
      try {
        const result = await onShareLink?.();
        if (result?.copied) {
          Alert.alert(
            t('call.group.shareLink') || 'Share link',
            t('call.group.shareLinkCopied') || 'Link copied to clipboard',
          );
        }
      } catch {}
    });
  }, [guard, onShareLink, t]);

  if (!visible) return null;
  if (!canHost) return null;

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Animated.View style={[styles.sheet, { opacity, transform: [{ translateY }] }]}>
          <Pressable onPress={(e) => e.stopPropagation?.()}>
            <View style={styles.handle} />
            <View style={styles.header}>
              <View style={styles.headerLeft}>
                <View style={styles.headerIcon}>
                  <IconShield />
                </View>
                <Text style={styles.title}>{t('call.group.hostControls') || 'Host controls'}</Text>
              </View>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <IconClose />
              </TouchableOpacity>
            </View>

            <ActionRow
              icon={IconMic}
              label={t('call.group.muteAll') || 'Mute all'}
              sublabel={t('call.group.muteAllHint') || 'Silences every guest, hosts stay live'}
              onPress={handleMuteAll}
              disabled={busy === 'mute'}
            />
            <ActionRow
              icon={(p) => <IconLock {...p} open={locked} />}
              label={locked ? (t('call.group.unlockRoom') || 'Unlock room') : (t('call.group.lockRoom') || 'Lock room')}
              sublabel={locked ? (t('call.group.lockOn') || 'Room is locked') : (t('call.group.lockOffHint') || 'Prevent new joiners')}
              accent={locked ? 'rgba(124,58,237,0.18)' : undefined}
              onPress={handleToggleLock}
              disabled={busy === 'lock'}
            />
            {canRecord && (
              <ActionRow
                icon={(p) => <IconRec {...p} active={recording} />}
                label={recording ? (t('call.group.recordStop') || 'Stop recording') : (t('call.group.recordStart') || 'Record call')}
                sublabel={recording ? (t('call.group.recordingBadge') || 'Recording') : (t('call.group.recordingConsent') || 'Everyone will be notified')}
                accent={recording ? 'rgba(220,38,38,0.18)' : undefined}
                danger={recording}
                onPress={handleToggleRecording}
                disabled={busy === 'rec'}
              />
            )}
            <ActionRow
              icon={IconLink}
              label={t('call.group.shareLink') || 'Share link'}
              sublabel={t('call.group.shareLinkHint') || 'Anyone with the link can join'}
              onPress={handleShareLink}
              disabled={busy === 'link'}
            />

            {!canRecord && (
              <Text style={styles.coHostFootnote}>
                {t('call.group.coHostFootnote') || 'Recording is host-only'}
              </Text>
            )}
            <View style={{ height: 8 }} />
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

HostControlsSheet.ROLE = ROLE;

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#111827',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingTop: 8,
    paddingHorizontal: 12,
    paddingBottom: Platform.OS === 'ios' ? 30 : 18,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    alignSelf: 'center',
    marginBottom: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingTop: 4,
    paddingBottom: 14,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(124,58,237,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { color: '#fff', fontSize: 17, fontWeight: '700', letterSpacing: -0.2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 12,
  },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowLabel: { color: '#fff', fontSize: 15, fontWeight: '600' },
  rowSub: { color: '#9CA3AF', fontSize: 12, marginTop: 2 },
  coHostFootnote: {
    color: '#6B7280',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 8,
    fontStyle: 'italic',
  },
});
