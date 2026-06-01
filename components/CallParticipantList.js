// CallParticipantList.js (2026-05-18)
//
// Slide-up bottom sheet that lists every participant in a group call with:
//   - Avatar + display name
//   - Live status badges (speaking / muted / video on / hand raised)
//   - Role badge (host / co-host / guest)
//   - Per-row actions when the local user is the host:
//       · Mute
//       · Remove
//       · Pin (UI hint, persisted in parent)
//       · Make co-host
//
// Designed to be controlled by /app/group-call.js — the parent feeds the
// authoritative participant list (sourced from LiveKit via WebView
// postMessage `participants` event) and host status. We never poll the
// network here; everything is reactive.
//
// Pin / unpin is a UI affordance only — the actual focus tile selection
// lives in the WebView (LiveKit /livekit-room.html). We surface the
// toggle and forward via `onPin(email, pinned)` so the parent can post a
// `pin` message into the WebView.
//
// Tap target sizing matches the WhatsApp 2025 participant list (56px
// row height, 40px avatar). Sheet height caps at 75% of screen so the
// active call surface remains visible behind.

import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  Pressable,
  Animated,
  Easing,
  ScrollView,
  StyleSheet,
  Alert,
  TextInput,
  Platform,
} from 'react-native';
import Svg, { Path as SvgPath, Circle as SvgCircle } from 'react-native-svg';
import AvatarCircle from './AvatarCircle';
import { useLanguage } from '../context/LanguageContext';

const BRAND_PURPLE = '#7C3AED';
const DANGER = '#EF4444';
const SUCCESS = '#10B981';
const MUTED_COLOR = '#9CA3AF';

// Mini SVG icons (kept inline so the sheet doesn't drag in the full Icons
// barrel — speeds up first paint when the user taps the header).
const IconMic = ({ size = 14, color = '#fff', off = false }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <SvgPath d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    <SvgPath d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    {off && <SvgPath d="M2 2l20 20" stroke={color} strokeWidth={2} strokeLinecap="round" />}
  </Svg>
);
const IconVideo = ({ size = 14, color = '#fff' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <SvgPath d="M23 7l-7 5 7 5V7zM14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);
const IconHand = ({ size = 14, color = '#fbbf24' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <SvgPath d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6.5-2.9L1 15a2.83 2.83 0 0 1 4-4l3 3" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);
const IconPin = ({ size = 14, color = '#fff', filled = false }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? color : 'none'}>
    <SvgPath d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);
const IconClose = ({ size = 20, color = '#fff' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <SvgPath d="M18 6L6 18M6 6l12 12" stroke={color} strokeWidth={2} strokeLinecap="round" />
  </Svg>
);
const IconMore = ({ size = 18, color = '#fff' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <SvgCircle cx={12} cy={5} r={1.5} fill={color} />
    <SvgCircle cx={12} cy={12} r={1.5} fill={color} />
    <SvgCircle cx={12} cy={19} r={1.5} fill={color} />
  </Svg>
);
const IconSearch = ({ size = 16, color = '#9CA3AF' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <SvgCircle cx={11} cy={11} r={8} stroke={color} strokeWidth={2} />
    <SvgPath d="M21 21l-4.35-4.35" stroke={color} strokeWidth={2} strokeLinecap="round" />
  </Svg>
);

/**
 * Roles surfaced in this sheet. Higher number = more privilege. Used both
 * for the role-badge text AND to decide whether to render per-row host
 * actions (only host/cohost can act on others, and never on themselves).
 */
const ROLE = { GUEST: 0, COHOST: 1, HOST: 2 };

function roleLabel(role, t) {
  if (role === ROLE.HOST) return t('call.group.host') || 'Host';
  if (role === ROLE.COHOST) return t('call.group.coHost') || 'Co-host';
  return t('call.group.guest') || 'Guest';
}

function roleColor(role) {
  if (role === ROLE.HOST) return BRAND_PURPLE;
  if (role === ROLE.COHOST) return '#06B6D4';
  return '#6B7280';
}

export default function CallParticipantList({
  visible,
  onClose,
  participants = [],
  myEmail = '',
  myRole = ROLE.GUEST,
  pinnedEmail = '',
  onMute,           // (email) => void
  onRemove,         // (email) => void
  onMakeCoHost,     // (email) => void
  onPin,            // (email, pinned: bool) => void
  onAddPerson,      // () => void  — opens add-participant flow
}) {
  const { t } = useLanguage();
  const [query, setQuery] = useState('');
  // Per-row action sheet — small popover anchored to the "..." button.
  const [actionFor, setActionFor] = useState(null);
  const translateY = useRef(new Animated.Value(60)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  // Slide-in animation on open; reset state on close so the sheet always
  // opens at the top of the list and without a leftover search query.
  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.spring(translateY, { toValue: 0, friction: 8, tension: 70, useNativeDriver: true }),
      ]).start();
    } else {
      translateY.setValue(60);
      opacity.setValue(0);
      setQuery('');
      setActionFor(null);
    }
  }, [visible, translateY, opacity]);

  const canHostAct = myRole >= ROLE.COHOST;

  // Filter + sort: host first, then co-hosts, then guests; within each
  // bucket the currently-speaking participant floats to the top. Cheap
  // memo since the list typically stays under ~50 entries.
  const ordered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? participants.filter(p =>
          (p.email || '').toLowerCase().includes(q) ||
          (p.name || '').toLowerCase().includes(q)
        )
      : participants;
    return [...filtered].sort((a, b) => {
      const ra = Number(b.role || 0) - Number(a.role || 0);
      if (ra !== 0) return ra;
      const sa = (b.isSpeaking ? 1 : 0) - (a.isSpeaking ? 1 : 0);
      if (sa !== 0) return sa;
      return (a.name || a.email || '').localeCompare(b.name || b.email || '');
    });
  }, [participants, query]);

  const handleRemove = useCallback((p) => {
    setActionFor(null);
    Alert.alert(
      t('call.group.confirmRemoveTitle') || 'Remove participant?',
      t('call.group.confirmRemoveBody') || 'They will be disconnected from the call.',
      [
        { text: t('common.cancel') || 'Cancel', style: 'cancel' },
        {
          text: t('call.group.removeParticipant') || 'Remove',
          style: 'destructive',
          onPress: () => onRemove?.(p.email),
        },
      ],
    );
  }, [onRemove, t]);

  const handleMute = useCallback((p) => {
    setActionFor(null);
    onMute?.(p.email);
  }, [onMute]);

  const handleMakeCoHost = useCallback((p) => {
    setActionFor(null);
    onMakeCoHost?.(p.email);
  }, [onMakeCoHost]);

  const handlePin = useCallback((p) => {
    setActionFor(null);
    const isPinned = (pinnedEmail || '').toLowerCase() === (p.email || '').toLowerCase();
    onPin?.(p.email, !isPinned);
  }, [onPin, pinnedEmail]);

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Animated.View
          style={[
            styles.sheet,
            { opacity, transform: [{ translateY }] },
          ]}
          // Stop press propagation so taps inside the sheet don't close it.
          onStartShouldSetResponder={() => true}
        >
          <Pressable onPress={(e) => e.stopPropagation?.()} style={{ flex: 1 }}>
            {/* Drag handle — visual only, swipe-to-dismiss is overlay tap */}
            <View style={styles.handle} />

            <View style={styles.header}>
              <Text style={styles.title}>
                {t('call.group.participants') || 'Participants'} · {participants.length}
              </Text>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <IconClose />
              </TouchableOpacity>
            </View>

            {/* Search + add-person CTA */}
            <View style={styles.searchRow}>
              <View style={styles.searchBox}>
                <IconSearch />
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  placeholder={t('common.search') || 'Search'}
                  placeholderTextColor="#6B7280"
                  style={styles.searchInput}
                  autoCorrect={false}
                  autoCapitalize="none"
                />
              </View>
              {onAddPerson && (
                <TouchableOpacity onPress={onAddPerson} style={styles.addPersonBtn} activeOpacity={0.8}>
                  <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
                    <SvgPath d="M19 8v6M16 11h6M9 11a4 4 0 100-8 4 4 0 000 8zM3 21a6 6 0 0112 0" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                  </Svg>
                </TouchableOpacity>
              )}
            </View>

            <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
              {ordered.map((p) => {
                const isMe = (p.email || '').toLowerCase() === (myEmail || '').toLowerCase();
                const isPinned = (pinnedEmail || '').toLowerCase() === (p.email || '').toLowerCase();
                const role = Number(p.role || 0);
                const speaking = !!p.isSpeaking;
                const muted = !!p.muted;
                const video = !!p.videoOn;
                const hand = !!p.handRaised;
                // Can act on this row IF I'm host/cohost AND it's not me AND
                // I outrank the target (a co-host can't remove the host).
                const canActOn = canHostAct && !isMe && role < myRole;
                return (
                  <View key={p.email} style={[styles.row, speaking && styles.rowSpeaking]}>
                    <View style={styles.avatarWrap}>
                      <View style={[styles.avatarHalo, speaking && styles.avatarHaloSpeaking]}>
                        <AvatarCircle email={p.email} name={p.name} size={44} />
                      </View>
                      {speaking && <View style={styles.speakingDot} />}
                      {hand && <View style={styles.handDot}><IconHand size={10} /></View>}
                    </View>

                    <View style={styles.rowMain}>
                      <View style={styles.rowNameLine}>
                        <Text style={styles.rowName} numberOfLines={1}>
                          {p.name || (p.email || '').split('@')[0]}
                          {isMe && <Text style={styles.youSuffix}> · {t('common.you') || 'You'}</Text>}
                        </Text>
                        {role > 0 && (
                          <View style={[styles.roleBadge, { backgroundColor: roleColor(role) + '22', borderColor: roleColor(role) }]}>
                            <Text style={[styles.roleBadgeText, { color: roleColor(role) }]}>{roleLabel(role, t)}</Text>
                          </View>
                        )}
                      </View>
                      <View style={styles.statusLine}>
                        {muted ? (
                          <View style={[styles.statusChip, styles.statusChipMuted]}>
                            <IconMic size={11} color={DANGER} off />
                            <Text style={[styles.statusText, { color: DANGER }]}>{t('call.group.muted') || 'Muted'}</Text>
                          </View>
                        ) : speaking ? (
                          <View style={[styles.statusChip, styles.statusChipSpeaking]}>
                            <View style={styles.speakingChipDot} />
                            <Text style={[styles.statusText, { color: SUCCESS }]}>{t('call.group.speaking') || 'Speaking'}</Text>
                          </View>
                        ) : null}
                        {video && (
                          <View style={[styles.statusChip, styles.statusChipVideo]}>
                            <IconVideo size={11} color="#60A5FA" />
                            <Text style={[styles.statusText, { color: '#60A5FA' }]}>{t('call.group.videoOn') || 'Video'}</Text>
                          </View>
                        )}
                        {isPinned && (
                          <View style={[styles.statusChip, styles.statusChipPinned]}>
                            <IconPin size={10} color={BRAND_PURPLE} filled />
                            <Text style={[styles.statusText, { color: BRAND_PURPLE }]}>{t('call.group.pin') || 'Pinned'}</Text>
                          </View>
                        )}
                      </View>
                    </View>

                    {/* Trailing action button — every row gets pin; host gets "..." menu */}
                    <View style={styles.rowActions}>
                      <TouchableOpacity
                        onPress={() => handlePin(p)}
                        style={styles.iconBtn}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        accessibilityLabel={isPinned ? (t('call.group.unpin') || 'Unpin') : (t('call.group.pin') || 'Pin')}
                      >
                        <IconPin size={16} color={isPinned ? BRAND_PURPLE : '#9CA3AF'} filled={isPinned} />
                      </TouchableOpacity>
                      {canActOn && (
                        <TouchableOpacity
                          onPress={() => setActionFor(actionFor === p.email ? null : p.email)}
                          style={styles.iconBtn}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          accessibilityLabel={t('call.group.hostControls') || 'Host controls'}
                        >
                          <IconMore />
                        </TouchableOpacity>
                      )}
                    </View>

                    {/* Per-row host action menu — anchored to the "..." */}
                    {actionFor === p.email && canActOn && (
                      <View style={styles.actionMenu}>
                        {!muted && (
                          <TouchableOpacity style={styles.actionItem} onPress={() => handleMute(p)}>
                            <IconMic size={14} color="#fff" off />
                            <Text style={styles.actionText}>{t('call.mute') || 'Mute'}</Text>
                          </TouchableOpacity>
                        )}
                        {role < ROLE.COHOST && (
                          <TouchableOpacity style={styles.actionItem} onPress={() => handleMakeCoHost(p)}>
                            <Svg width={14} height={14} viewBox="0 0 24 24" fill="none">
                              <SvgPath d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7l3-7z" stroke="#fff" strokeWidth={2} strokeLinejoin="round" />
                            </Svg>
                            <Text style={styles.actionText}>{t('call.group.makeCoHost') || 'Make co-host'}</Text>
                          </TouchableOpacity>
                        )}
                        <TouchableOpacity style={[styles.actionItem, styles.actionItemDanger]} onPress={() => handleRemove(p)}>
                          <Svg width={14} height={14} viewBox="0 0 24 24" fill="none">
                            <SvgPath d="M18 6L6 18M6 6l12 12" stroke={DANGER} strokeWidth={2} strokeLinecap="round" />
                          </Svg>
                          <Text style={[styles.actionText, { color: DANGER }]}>{t('call.group.removeParticipant') || 'Remove'}</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                );
              })}
              {ordered.length === 0 && (
                <Text style={styles.emptyText}>
                  {query ? (t('common.noResults') || 'No results') : (t('call.group.participants') || 'Participants')}
                </Text>
              )}
              <View style={{ height: 32 }} />
            </ScrollView>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

CallParticipantList.ROLE = ROLE;

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
    maxHeight: '78%',
    paddingTop: 8,
    paddingBottom: Platform.OS === 'ios' ? 28 : 16,
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
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  title: { color: '#fff', fontSize: 17, fontWeight: '700', letterSpacing: -0.2 },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  searchInput: {
    flex: 1,
    color: '#fff',
    fontSize: 14,
    padding: 0,
  },
  addPersonBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: BRAND_PURPLE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: { flex: 1, paddingHorizontal: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 16,
    marginBottom: 4,
  },
  rowSpeaking: {
    backgroundColor: 'rgba(16,185,129,0.08)',
  },
  avatarWrap: { width: 48, height: 48, marginRight: 14, position: 'relative' },
  avatarHalo: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  avatarHaloSpeaking: {
    borderWidth: 2.5,
    borderColor: SUCCESS,
  },
  // Small green "live mic" dot pinned to the avatar while speaking.
  speakingDot: {
    position: 'absolute',
    bottom: -1,
    right: -1,
    width: 13,
    height: 13,
    borderRadius: 7,
    backgroundColor: SUCCESS,
    borderWidth: 2,
    borderColor: '#111827',
  },
  handDot: {
    position: 'absolute',
    top: -2,
    right: -2,
    backgroundColor: '#1F2937',
    borderRadius: 9,
    padding: 3,
    borderWidth: 1,
    borderColor: '#111827',
  },
  rowMain: { flex: 1, justifyContent: 'center' },
  rowNameLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowName: { color: '#fff', fontSize: 15.5, fontWeight: '600', maxWidth: '70%', letterSpacing: -0.2 },
  youSuffix: { color: '#9CA3AF', fontWeight: '400' },
  roleBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 7,
    borderWidth: 1,
  },
  roleBadgeText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.4 },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 5, flexWrap: 'wrap' },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 7,
  },
  // Muted = red mic-off pill.
  statusChipMuted: { backgroundColor: 'rgba(239,68,68,0.14)' },
  // Speaking = green pill with a live dot.
  statusChipSpeaking: { backgroundColor: 'rgba(16,185,129,0.16)' },
  speakingChipDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: SUCCESS },
  // Video on = blue cam pill.
  statusChipVideo: { backgroundColor: 'rgba(96,165,250,0.14)' },
  // Pinned = brand purple pill.
  statusChipPinned: { backgroundColor: 'rgba(124,58,237,0.18)' },
  statusText: { fontSize: 11, fontWeight: '600' },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  iconBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  actionMenu: {
    position: 'absolute',
    right: 14,
    top: 50,
    backgroundColor: '#1F2937',
    borderRadius: 10,
    paddingVertical: 4,
    minWidth: 160,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 12,
    zIndex: 100,
  },
  actionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  actionItemDanger: { borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)' },
  actionText: { color: '#fff', fontSize: 14, fontWeight: '500' },
  emptyText: { color: '#6B7280', textAlign: 'center', paddingVertical: 40, fontSize: 14 },
});
