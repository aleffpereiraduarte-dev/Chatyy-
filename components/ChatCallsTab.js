import React, { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, SectionList, Platform, Animated, Alert, Modal, ActivityIndicator, Vibration } from 'react-native';
import Svg, { Path, Polyline, Rect, Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import AvatarCircle from './AvatarCircle';
import { IconPhone, IconVideo, IconInfo, IconX, IconPhoneOff } from './Icons';
import { callHistoryList, callHistoryAdd, callHistoryDelete, callHistoryClear, voipCall, voipMinutesRemaining } from '../services/api';
const GREEN = '#25D366';
const RED = '#FF3B30';

// --- Inline arrow icons for call direction ---

function ArrowOutgoing({ size = 14, color = GREEN }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M7 17L17 7" />
      <Polyline points="7 7 17 7 17 17" />
    </Svg>
  );
}

function ArrowIncoming({ size = 14, color = GREEN }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M17 7L7 17" />
      <Polyline points="17 17 7 17 7 7" />
    </Svg>
  );
}

// Group call icon
function IconGroupCall({ size = 16, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <Circle cx="9" cy="7" r="4" />
      <Path d="M23 21v-2a4 4 0 00-3-3.87" />
      <Path d="M16 3.13a4 4 0 010 7.75" />
    </Svg>
  );
}

// --- Empty state SVG illustration (modernized) ---

function EmptyCallsIllustration({ isDark }) {
  const primaryColor = GREEN;
  const bgColor = isDark ? '#1a2e1a' : '#ecfdf5';
  const lineColor = isDark ? '#374151' : '#d1d5db';
  return (
    <View style={[stylesEmpty.circle, { backgroundColor: bgColor }]}>
      <Svg width={64} height={64} viewBox="0 0 24 24" fill="none">
        <Path
          d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"
          stroke={primaryColor}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.7}
        />
        {/* Signal waves */}
        <Path d="M14.5 2C15.7 3.2 16.5 4.8 16.5 6.5" stroke={primaryColor} strokeWidth={1.2} strokeLinecap="round" opacity={0.5} />
        <Path d="M17 0.5C18.8 2.3 20 4.8 20 7.5" stroke={primaryColor} strokeWidth={1.2} strokeLinecap="round" opacity={0.3} />
      </Svg>
    </View>
  );
}

const stylesEmpty = StyleSheet.create({
  circle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

// --- Server API helpers ---

export async function getCallHistory() {
  try {
    const r = await callHistoryList(200, 0);
    if (r?.success && Array.isArray(r?.data?.calls)) {
      return r.data.calls;
    }
    return [];
  } catch {
    return [];
  }
}

export async function addCallToHistory(callData) {
  try {
    const r = await callHistoryAdd(callData);
    if (r?.success) {
      return {
        id: r.data?.id,
        contactEmail: callData.contactEmail || '',
        contactName: callData.contactName || callData.contactEmail || '',
        callId: callData.callId || '',
        type: callData.type || 'outgoing',
        video: !!callData.video,
        timestamp: callData.timestamp || Date.now(),
        duration: callData.duration || 0,
        isGroup: !!callData.isGroup,
        participants: callData.participants || [],
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function removeCallFromHistory(callId) {
  try {
    await callHistoryDelete(callId);
    return true;
  } catch {
    return null;
  }
}

// --- Formatting helpers ---

function formatCallTime(timestamp, t) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (diffDays === 0) {
    return timeStr;
  }
  if (diffDays === 1) {
    return `${t ? t('date.yesterday') : date.toLocaleDateString(undefined, { weekday: 'long' })}, ${timeStr}`;
  }
  if (diffDays < 7) {
    const dayName = date.toLocaleDateString(undefined, { weekday: 'long' });
    return `${dayName}, ${timeStr}`;
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + `, ${timeStr}`;
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function getCallLabel(type, t) {
  if (t) {
    const keys = {
      outgoing: 'calls.outgoing',
      incoming: 'calls.incoming',
      missed: 'calls.missed',
    };
    const translated = t(keys[type]);
    if (translated && translated !== keys[type]) return translated;
  }
  switch (type) {
    case 'outgoing': return 'Outgoing';
    case 'incoming': return 'Incoming';
    case 'missed': return 'Missed';
    default: return type;
  }
}

// --- Date grouping helpers ---

function getDateGroup(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);

  if (date >= today) return 'today';
  if (date >= yesterday) return 'yesterday';
  if (date >= weekAgo) return 'thisWeek';
  return 'earlier';
}

function getGroupTitle(key, t) {
  const titles = {
    today: t ? (t('calls.today') || 'Today') : 'Today',
    yesterday: t ? (t('calls.yesterday') || 'Yesterday') : 'Yesterday',
    thisWeek: t ? (t('calls.thisWeek') || 'This Week') : 'This Week',
    earlier: t ? (t('calls.earlier') || 'Earlier') : 'Earlier',
  };
  const val = titles[key];
  if (val && val.startsWith('calls.')) {
    const fallbacks = { today: 'Today', yesterday: 'Yesterday', thisWeek: 'This Week', earlier: 'Earlier' };
    return fallbacks[key];
  }
  return val;
}

function groupCallsByDate(calls, t) {
  const groups = {};
  const order = ['today', 'yesterday', 'thisWeek', 'earlier'];

  for (const call of calls) {
    const key = getDateGroup(call.timestamp);
    if (!groups[key]) {
      groups[key] = { title: getGroupTitle(key, t), data: [] };
    }
    groups[key].data.push(call);
  }

  return order.filter((k) => groups[k]).map((k) => groups[k]);
}

// --- Call row component ---

const CallRow = memo(function CallRow({ item, colors, isDark, t, onPress, onInfoPress, onDelete }) {
  const isMissed = item.type === 'missed';
  const isOutgoing = item.type === 'outgoing';
  const arrowColor = isMissed ? RED : GREEN;
  const nameColor = isMissed ? RED : colors.text;
  const subtextColor = colors.textSecondary || (isDark ? '#8e8e93' : '#8e8e93');
  const durationStr = formatDuration(item.duration);
  const label = getCallLabel(item.type, t);
  const isGroup = item.isGroup;

  const slideAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(1)).current;

  const handleDelete = useCallback(() => {
    Animated.parallel([
      Animated.timing(slideAnim, { toValue: -400, duration: 250, useNativeDriver: false }),
      Animated.timing(fadeAnim, { toValue: 0, duration: 200, useNativeDriver: false }),
    ]).start(() => {
      if (onDelete) onDelete(item.id);
    });
  }, [item.id, onDelete, slideAnim, fadeAnim]);

  const rowBg = isMissed
    ? (isDark ? 'rgba(255, 59, 48, 0.04)' : 'rgba(255, 59, 48, 0.02)')
    : 'transparent';

  const arrowBgColor = isMissed
    ? (isDark ? 'rgba(255, 59, 48, 0.12)' : 'rgba(255, 59, 48, 0.07)')
    : (isDark ? 'rgba(37, 211, 102, 0.10)' : 'rgba(37, 211, 102, 0.06)');

  const callBtnBg = isDark ? 'rgba(37, 211, 102, 0.10)' : 'rgba(37, 211, 102, 0.06)';

  return (
    <Animated.View style={{
      transform: [{ translateX: slideAnim }],
      opacity: fadeAnim,
    }}>
      <TouchableOpacity
        style={[styles.row, { backgroundColor: rowBg }]}
        activeOpacity={0.6}
        onPress={() => onPress(item)}
        onLongPress={handleDelete}
        accessibilityLabel={`${item.contactName}, ${label}`}
        accessibilityRole="button"
      >
        {/* Avatar with group overlay */}
        <View style={styles.avatarWrap}>
          <AvatarCircle
            name={item.contactName}
            email={item.contactEmail}
            size={48}
          />
          {isGroup && (
            <View style={[styles.groupBadge, {
              backgroundColor: isDark ? '#1a2e1a' : '#ecfdf5',
              borderColor: isDark ? '#0d1117' : '#ffffff',
            }]}>
              <IconGroupCall size={10} color={GREEN} />
            </View>
          )}
        </View>

        {/* Middle: name + call info */}
        <View style={styles.middle}>
          <Text style={[styles.name, { color: nameColor }]} numberOfLines={1}>
            {item.contactName || item.contactEmail}
          </Text>
          <View style={styles.callInfoRow}>
            <View style={[styles.arrowCircle, { backgroundColor: arrowBgColor }]}>
              {isOutgoing ? (
                <ArrowOutgoing size={11} color={arrowColor} />
              ) : (
                <ArrowIncoming size={11} color={arrowColor} />
              )}
            </View>
            <View style={styles.callLabelRow}>
              {item.video ? (
                <IconVideo size={12} color={subtextColor} />
              ) : (
                <IconPhone size={12} color={subtextColor} />
              )}
              <Text style={[styles.callType, { color: subtextColor }]}>
                {' '}{label}
                {durationStr ? ` \u00B7 ${durationStr}` : ''}
              </Text>
            </View>
          </View>
        </View>

        {/* Right: time + call button */}
        <View style={styles.right}>
          <Text style={[styles.time, { color: isMissed ? RED : subtextColor }]}>
            {formatCallTime(item.timestamp, t)}
          </Text>
          <TouchableOpacity
            style={[styles.callActionBtn, { backgroundColor: callBtnBg }]}
            onPress={() => onPress(item)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel={item.video ? 'Video call' : 'Voice call'}
            accessibilityRole="button"
          >
            {item.video ? (
              <IconVideo size={16} color={GREEN} />
            ) : (
              <IconPhone size={16} color={GREEN} />
            )}
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
});

// --- Section header ---

function SectionHeader({ title, isDark }) {
  return (
    <View style={[styles.sectionHeader, {
      backgroundColor: isDark ? 'rgba(0,0,0,0.9)' : 'rgba(248,249,250,0.95)',
    }]}>
      <View style={[styles.sectionHeaderLine, { backgroundColor: GREEN }]} />
      <Text style={[styles.sectionHeaderText, { color: isDark ? '#9ca3af' : '#6b7280' }]}>
        {title}
      </Text>
    </View>
  );
}

// --- Floating new call button ---
function FloatingCallButton({ onPress, isDark }) {
  const scaleAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      tension: 100,
      friction: 12,
      useNativeDriver: false,
    }).start();
  }, [scaleAnim]);

  return (
    <Animated.View style={[styles.fab, {
      transform: [{ scale: scaleAnim }],
      ...(Platform.OS === 'web' ? {
        boxShadow: '0 4px 16px rgba(37,211,102,0.4)',
      } : Platform.OS === 'ios' ? {
        shadowColor: GREEN,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.4,
        shadowRadius: 10,
      } : { elevation: 6 }),
    }]}>
      <TouchableOpacity
        style={styles.fabInner}
        onPress={onPress}
        activeOpacity={0.8}
      >
        <IconPhone size={22} color="#fff" />
      </TouchableOpacity>
    </Animated.View>
  );
}

// --- Loading skeleton ---
function LoadingSkeleton({ isDark }) {
  const shimmer = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, { toValue: 1, duration: 800, useNativeDriver: false }),
        Animated.timing(shimmer, { toValue: 0, duration: 800, useNativeDriver: false }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [shimmer]);

  const opacity = shimmer.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 0.7],
  });

  const bg = isDark ? '#1c1c1e' : '#e5e7eb';

  return (
    <View style={styles.skeletonContainer}>
      {[0, 1, 2, 3, 4].map((i) => (
        <Animated.View key={i} style={[styles.skeletonRow, { opacity }]}>
          <View style={[styles.skeletonCircle, { backgroundColor: bg }]} />
          <View style={{ flex: 1, gap: 8 }}>
            <View style={[styles.skeletonLine, { backgroundColor: bg, width: '60%' }]} />
            <View style={[styles.skeletonLine, { backgroundColor: bg, width: '40%', height: 10 }]} />
          </View>
          <View style={[styles.skeletonLine, { backgroundColor: bg, width: 50, height: 10 }]} />
        </Animated.View>
      ))}
    </View>
  );
}

// --- Dialer Keypad Icon ---
function IconDialpad({ size = 24, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Circle cx="5" cy="4" r="2" />
      <Circle cx="12" cy="4" r="2" />
      <Circle cx="19" cy="4" r="2" />
      <Circle cx="5" cy="11" r="2" />
      <Circle cx="12" cy="11" r="2" />
      <Circle cx="19" cy="11" r="2" />
      <Circle cx="5" cy="18" r="2" />
      <Circle cx="12" cy="18" r="2" />
      <Circle cx="19" cy="18" r="2" />
    </Svg>
  );
}

function IconBackspace({ size = 24, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M21 4H8l-7 8 7 8h13a2 2 0 002-2V6a2 2 0 00-2-2z" />
      <Path d="M18 9l-6 6M12 9l6 6" />
    </Svg>
  );
}

// --- VoIP Dialer Modal ---
function VoIPDialer({ visible, onClose, isDark, colors, t, user }) {
  const [number, setNumber] = useState('');
  const [calling, setCalling] = useState(false);
  const [callResult, setCallResult] = useState(null);
  const [minutesInfo, setMinutesInfo] = useState(null);
  const [loadingMinutes, setLoadingMinutes] = useState(true);

  useEffect(() => {
    if (visible) {
      setLoadingMinutes(true);
      voipMinutesRemaining().then(r => {
        if (r?.success && r.data) setMinutesInfo(r.data);
      }).catch(() => {}).finally(() => setLoadingMinutes(false));
    }
  }, [visible]);

  const appendDigit = useCallback((digit) => {
    if (Platform.OS !== 'web') Vibration.vibrate(10);
    setNumber(prev => prev + digit);
    setCallResult(null);
  }, []);

  const deleteDigit = useCallback(() => {
    setNumber(prev => prev.slice(0, -1));
  }, []);

  const handleCall = useCallback(async () => {
    if (!number.trim() || calling) return;
    setCalling(true);
    setCallResult(null);
    try {
      const r = await voipCall(number.trim());
      if (r?.success) {
        setCallResult({ success: true, data: r.data });
        setNumber('');
      } else {
        setCallResult({ success: false, message: r?.message || 'Call failed' });
      }
    } catch (err) {
      setCallResult({ success: false, message: err.message || 'Network error' });
    } finally {
      setCalling(false);
    }
  }, [number, calling]);

  const bgColor = isDark ? '#0d1117' : '#f8f9fa';
  const cardBg = isDark ? '#161b22' : '#fff';
  const keyBg = isDark ? '#21262d' : '#f0f0f0';
  const keyColor = isDark ? '#fff' : '#111';
  const subColor = isDark ? '#8b949e' : '#6b7280';

  const dialKeys = [
    { digit: '1', sub: '' },
    { digit: '2', sub: 'ABC' },
    { digit: '3', sub: 'DEF' },
    { digit: '4', sub: 'GHI' },
    { digit: '5', sub: 'JKL' },
    { digit: '6', sub: 'MNO' },
    { digit: '7', sub: 'PQRS' },
    { digit: '8', sub: 'TUV' },
    { digit: '9', sub: 'WXYZ' },
    { digit: '*', sub: '' },
    { digit: '0', sub: '+' },
    { digit: '#', sub: '' },
  ];

  const minutesUsed = minutesInfo?.minutes_used || 0;
  const minutesLimit = minutesInfo?.minutes_limit || 0;
  const planName = minutesInfo?.plan || 'free';
  const isPaid = minutesLimit > 0;

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
      <View style={[dialerStyles.container, { backgroundColor: bgColor }]}>
        {/* Header */}
        <View style={dialerStyles.header}>
          <TouchableOpacity onPress={onClose} style={dialerStyles.closeBtn}>
            <IconX size={24} color={isDark ? '#fff' : '#111'} />
          </TouchableOpacity>
          <Text style={[dialerStyles.title, { color: isDark ? '#fff' : '#111' }]}>
            {t?.('voip.title') || 'Discador'}
          </Text>
          <View style={{ width: 40 }} />
        </View>

        {/* Minutes indicator */}
        <View style={[dialerStyles.minutesBanner, { backgroundColor: cardBg }]}>
          {loadingMinutes ? (
            <ActivityIndicator size="small" color={GREEN} />
          ) : !isPaid ? (
            <Text style={[dialerStyles.minutesText, { color: subColor }]}>
              {t?.('voip.needsPlan') || 'Ligacoes VoIP requerem plano pago'}
            </Text>
          ) : (
            <View style={dialerStyles.minutesRow}>
              <View style={dialerStyles.minutesBarBg}>
                <View style={[dialerStyles.minutesBarFill, { width: `${Math.min(100, (minutesUsed / minutesLimit) * 100)}%` }]} />
              </View>
              <Text style={[dialerStyles.minutesLabel, { color: subColor }]}>
                {minutesUsed}/{minutesLimit} min ({t?.('voip.plan') || 'Plano'}: {planName})
              </Text>
            </View>
          )}
        </View>

        {/* Number display */}
        <View style={dialerStyles.display}>
          <Text style={[dialerStyles.displayText, { color: isDark ? '#fff' : '#111' }]} numberOfLines={1}>
            {number || (t?.('voip.enterNumber') || 'Digite o numero')}
          </Text>
        </View>

        {/* Call result */}
        {callResult && (
          <View style={[dialerStyles.resultBanner, { backgroundColor: callResult.success ? 'rgba(37,211,102,0.1)' : 'rgba(255,59,48,0.1)' }]}>
            <Text style={{ color: callResult.success ? GREEN : RED, fontSize: 13, fontWeight: '600', textAlign: 'center' }}>
              {callResult.success ? (t?.('voip.callStarted') || 'Ligacao iniciada!') : callResult.message}
            </Text>
          </View>
        )}

        {/* Keypad */}
        <View style={dialerStyles.keypad}>
          {dialKeys.map((k) => (
            <TouchableOpacity
              key={k.digit}
              style={[dialerStyles.key, { backgroundColor: keyBg }]}
              onPress={() => {
                if (k.digit === '0' && number === '') {
                  appendDigit('+');
                } else {
                  appendDigit(k.digit);
                }
              }}
              onLongPress={k.digit === '0' ? () => appendDigit('+') : undefined}
              activeOpacity={0.6}
            >
              <Text style={[dialerStyles.keyDigit, { color: keyColor }]}>{k.digit}</Text>
              {k.sub ? <Text style={[dialerStyles.keySub, { color: subColor }]}>{k.sub}</Text> : null}
            </TouchableOpacity>
          ))}
        </View>

        {/* Action row: backspace, call, empty */}
        <View style={dialerStyles.actionRow}>
          <View style={{ width: 64 }} />
          <TouchableOpacity
            style={[dialerStyles.callBtn, (!isPaid || calling || !number.trim()) && { opacity: 0.4 }]}
            onPress={handleCall}
            disabled={!isPaid || calling || !number.trim()}
            activeOpacity={0.7}
          >
            {calling ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <IconPhone size={28} color="#fff" />
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={dialerStyles.backspaceBtn}
            onPress={deleteDigit}
            onLongPress={() => setNumber('')}
            disabled={!number}
          >
            {number ? <IconBackspace size={24} color={subColor} /> : <View style={{ width: 24 }} />}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const dialerStyles = StyleSheet.create({
  container: { flex: 1, paddingTop: Platform.OS === 'ios' ? 60 : 40 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, marginBottom: 8,
  },
  closeBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 20, fontWeight: '700' },
  minutesBanner: {
    marginHorizontal: 20, borderRadius: 12, padding: 12, marginBottom: 12,
    alignItems: 'center',
  },
  minutesRow: { width: '100%', alignItems: 'center' },
  minutesBarBg: {
    width: '100%', height: 6, borderRadius: 3, backgroundColor: 'rgba(150,150,150,0.2)',
    marginBottom: 6, overflow: 'hidden',
  },
  minutesBarFill: { height: '100%', borderRadius: 3, backgroundColor: GREEN },
  minutesLabel: { fontSize: 12, fontWeight: '500' },
  minutesText: { fontSize: 13 },
  display: {
    paddingHorizontal: 30, paddingVertical: 16, alignItems: 'center', minHeight: 60,
    justifyContent: 'center',
  },
  displayText: { fontSize: 32, fontWeight: '300', letterSpacing: 2 },
  resultBanner: {
    marginHorizontal: 20, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12,
    marginBottom: 8,
  },
  keypad: {
    flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center',
    paddingHorizontal: 30, gap: 12,
  },
  key: {
    width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center',
  },
  keyDigit: { fontSize: 28, fontWeight: '400' },
  keySub: { fontSize: 9, fontWeight: '600', letterSpacing: 1.5, marginTop: 1 },
  actionRow: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    gap: 32, marginTop: 20, paddingBottom: 40,
  },
  callBtn: {
    width: 64, height: 64, borderRadius: 32, backgroundColor: GREEN,
    alignItems: 'center', justifyContent: 'center',
  },
  backspaceBtn: {
    width: 64, height: 64, alignItems: 'center', justifyContent: 'center',
  },
});

// --- Main component ---

function ChatCallsTab({ colors, isDark, t, user, router }) {
  const [calls, setCalls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialerVisible, setDialerVisible] = useState(false);

  const loadCalls = useCallback(async () => {
    setLoading(true);
    const history = await getCallHistory();
    setCalls(history);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadCalls();
  }, [loadCalls]);

  // Poll server for updates (e.g. call added from another device)
  useEffect(() => {
    const interval = setInterval(() => {
      getCallHistory().then((h) => {
        setCalls((prev) => {
          if (prev.length !== h.length) return h;
          if (prev.length > 0 && h.length > 0 && prev[0].id !== h[0].id) return h;
          return prev;
        });
      });
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  const handleCallPress = useCallback((item) => {
    if (router) {
      router.push({
        pathname: '/chat-conversation',
        params: {
          recipientEmail: item.contactEmail,
          recipientName: item.contactName,
          startCall: item.video ? 'video' : 'audio',
        },
      });
    }
  }, [router]);

  const handleInfoPress = useCallback((item) => {
    if (router) {
      router.push({
        pathname: '/chat-conversation',
        params: {
          recipientEmail: item.contactEmail,
          recipientName: item.contactName,
        },
      });
    }
  }, [router]);

  const handleDelete = useCallback(async (callId) => {
    const ok = await removeCallFromHistory(callId);
    if (ok) {
      setCalls(prev => prev.filter(c => c.id !== callId));
    }
  }, []);

  const handleClearAll = useCallback(() => {
    const doIt = async () => {
      try {
        await callHistoryClear();
        setCalls([]);
      } catch {}
    };
    if (Platform.OS === 'web') {
      if (confirm(t ? t('calls.clearConfirm') || 'Clear all call history?' : 'Clear all call history?')) {
        doIt();
      }
    } else {
      Alert.alert(
        t ? t('calls.clearHistory') || 'Clear History' : 'Clear History',
        t ? t('calls.clearConfirm') || 'Clear all call history?' : 'Clear all call history?',
        [
          { text: t ? t('common.cancel') || 'Cancel' : 'Cancel', style: 'cancel' },
          { text: t ? t('calls.clearAll') || 'Clear All' : 'Clear All', style: 'destructive', onPress: doIt },
        ]
      );
    }
  }, [t]);

  const handleNewCall = useCallback(() => {
    if (router) router.push('/chat-new');
  }, [router]);

  const sections = useMemo(() => groupCallsByDate(calls, t), [calls, t]);

  const renderItem = useCallback(({ item }) => (
    <CallRow
      item={item}
      colors={colors}
      isDark={isDark}
      t={t}
      onPress={handleCallPress}
      onInfoPress={handleInfoPress}
      onDelete={handleDelete}
    />
  ), [colors, isDark, t, handleCallPress, handleInfoPress, handleDelete]);

  const renderSectionHeader = useCallback(({ section }) => (
    <SectionHeader title={section.title} isDark={isDark} />
  ), [isDark]);

  const renderSeparator = useCallback(() => (
    <View style={[styles.separator, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)' }]} />
  ), [isDark]);

  const keyExtractor = useCallback((item) => item.id, []);

  const bgColor = isDark ? '#000000' : '#f8f9fa';
  const subtextColor = colors.textSecondary || (isDark ? '#8e8e93' : '#8e8e93');

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: bgColor }]}>
        <LoadingSkeleton isDark={isDark} />
      </View>
    );
  }

  if (calls.length === 0) {
    return (
      <View style={[styles.container, { backgroundColor: bgColor }]}>
        <View style={styles.emptyContainer}>
          <EmptyCallsIllustration isDark={isDark} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>
            {t ? t('calls.noCallsTitle') || 'No Recent Calls' : 'No Recent Calls'}
          </Text>
          <Text style={[styles.emptySubtitle, { color: subtextColor }]}>
            {t ? t('calls.noCallsSubtitle') || 'Your call history will appear here' : 'Your call history will appear here'}
          </Text>

          <TouchableOpacity
            style={[styles.startCallBtn, Platform.OS === 'web' ? {
              boxShadow: '0 4px 14px rgba(37,211,102,0.3)',
            } : Platform.OS === 'ios' ? {
              shadowColor: GREEN,
              shadowOffset: { width: 0, height: 3 },
              shadowOpacity: 0.3,
              shadowRadius: 8,
            } : { elevation: 4 }]}
            onPress={handleNewCall}
            activeOpacity={0.8}
          >
            <IconPhone size={18} color="#fff" />
            <Text style={styles.startCallText}>
              {t ? t('calls.startCall') || 'Start a call' : 'Start a call'}
            </Text>
          </TouchableOpacity>

          <Text style={[styles.emptyHint, { color: isDark ? '#4b5563' : '#9ca3af' }]}>
            {t ? t('calls.startCallHint') || 'Start a call from any conversation' : 'Start a call from any conversation'}
          </Text>

          {/* Dialer button in empty state */}
          <TouchableOpacity
            style={[styles.startCallBtn, { backgroundColor: isDark ? '#21262d' : '#e0e0e0', marginTop: 0 }]}
            onPress={() => setDialerVisible(true)}
            activeOpacity={0.8}
          >
            <IconDialpad size={18} color={GREEN} />
            <Text style={[styles.startCallText, { color: GREEN }]}>
              {t?.('voip.title') || 'Discador'}
            </Text>
          </TouchableOpacity>
        </View>

        <VoIPDialer
          visible={dialerVisible}
          onClose={() => setDialerVisible(false)}
          isDark={isDark}
          colors={colors}
          t={t}
          user={user}
        />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: bgColor }]}>
      {/* "Recent" header label */}
      <View style={[styles.recentHeader, {
        borderBottomColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
      }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={[styles.recentHeaderText, { color: GREEN }]}>
            {t ? t('calls.recent') || 'Recent' : 'Recent'}
          </Text>
          <Text style={[styles.callCount, { color: isDark ? '#4b5563' : '#9ca3af' }]}>
            {calls.length}
          </Text>
        </View>
        <TouchableOpacity onPress={handleClearAll} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={{ color: RED, fontSize: 12, fontWeight: '600' }}>
            {t ? t('calls.clearAll') || 'Clear All' : 'Clear All'}
          </Text>
        </TouchableOpacity>
      </View>
      <SectionList
        sections={sections}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        ItemSeparatorComponent={renderSeparator}
        keyExtractor={keyExtractor}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        stickySectionHeadersEnabled={true}
        initialNumToRender={20}
        maxToRenderPerBatch={15}
        windowSize={10}
      />
      <FloatingCallButton onPress={handleNewCall} isDark={isDark} />

      {/* Dialer FAB (secondary) */}
      <TouchableOpacity
        style={[styles.dialerFab, {
          backgroundColor: isDark ? '#21262d' : '#fff',
          ...(Platform.OS === 'web' ? {
            boxShadow: '0 3px 12px rgba(0,0,0,0.15)',
          } : Platform.OS === 'ios' ? {
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 3 },
            shadowOpacity: 0.15,
            shadowRadius: 8,
          } : { elevation: 4 }),
        }]}
        onPress={() => setDialerVisible(true)}
        activeOpacity={0.8}
      >
        <IconDialpad size={22} color={GREEN} />
      </TouchableOpacity>

      {/* VoIP Dialer Modal */}
      <VoIPDialer
        visible={dialerVisible}
        onClose={() => setDialerVisible(false)}
        isDark={isDark}
        colors={colors}
        t={t}
        user={user}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  recentHeader: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  recentHeaderText: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  callCount: {
    fontSize: 12,
    fontWeight: '600',
  },
  listContent: {
    paddingBottom: 80,
  },
  sectionHeader: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
    } : {}),
  },
  sectionHeaderLine: {
    width: 3,
    height: 14,
    borderRadius: 1.5,
  },
  sectionHeaderText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  avatarWrap: {
    position: 'relative',
    marginRight: 14,
  },
  groupBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  middle: {
    flex: 1,
    justifyContent: 'center',
    marginRight: 10,
  },
  name: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 3,
    letterSpacing: 0.1,
  },
  callInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  arrowCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
  },
  callLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  callType: {
    fontSize: 13,
    fontWeight: '400',
  },
  right: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 6,
  },
  time: {
    fontSize: 11.5,
    fontWeight: '400',
  },
  callActionBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 78,
  },

  // Empty state
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
    paddingBottom: 60,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: '700',
    marginTop: 24,
    marginBottom: 8,
    letterSpacing: -0.3,
  },
  emptySubtitle: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 28,
  },
  startCallBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: GREEN,
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 28,
    marginBottom: 20,
  },
  startCallText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  emptyHint: {
    fontSize: 12,
    textAlign: 'center',
  },

  // Floating action button
  fab: {
    position: 'absolute',
    bottom: 20,
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: GREEN,
  },
  fabInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialerFab: {
    position: 'absolute',
    bottom: 88,
    right: 22,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Loading skeleton
  skeletonContainer: {
    paddingTop: 20,
    paddingHorizontal: 16,
  },
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 14,
  },
  skeletonCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
  },
  skeletonLine: {
    height: 14,
    borderRadius: 7,
  },
});

export default memo(ChatCallsTab);
