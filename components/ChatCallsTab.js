import React, { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Platform, Animated, Alert, ActivityIndicator, Vibration, Dimensions, Modal, FlatList, TextInput } from 'react-native';
import Svg, { Path, Polyline, Circle as SvgCircle, Line, Rect } from 'react-native-svg';
import AvatarCircle from './AvatarCircle';
import { IconPhone, IconVideo, IconInfo, IconX, IconPhoneOff, IconMic, IconMicOff, IconVolume2, IconVolumeX, IconGrid, IconUserPlus } from './Icons';
import { callHistoryList, callHistoryAdd, callHistoryDelete, callHistoryClear, voipCall, voipToken, voipSipCredentials, voipMinutesRemaining, voipUpdateDuration, searchContacts, voipVerifiedNumberRequest, voipVerifiedNumberConfirm, getProfile } from '../services/api';
import { getCached, setCache } from '../services/cache';
import { useCall } from '../context/CallContext';
// SIP call — dynamic import to prevent crash if native WebRTC module fails
let _sip = null;
try { _sip = require('../services/sipCall'); } catch {}
const startSipCall = _sip?.startSipCall || (async () => ({ success: false }));
const hangupSipCall = _sip?.hangupSipCall || (() => {});
const muteSipCall = _sip?.muteSipCall || (() => {});
const sipSendDTMF = _sip?.sendDTMF || (() => {});

const GREEN = '#34C759';
const GREEN_DARK = '#30D158';
const RED = '#FF3B30';
const BLUE = '#007AFF';
const ACCENT = '#25D366';
const SCREEN_WIDTH = Dimensions.get('window').width;
const MAX_DIALER_WIDTH = 400;

// ── DTMF Tone Generator (Web Audio API) ──
// Real phone frequencies: each key = mix of two frequencies
const DTMF_FREQS = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477],
};

let _audioCtx = null;
function playDTMFTone(digit) {
  try {
    const freqs = DTMF_FREQS[digit];
    if (!freqs) return;
    if (!_audioCtx) {
      const AudioCtx = typeof AudioContext !== 'undefined' ? AudioContext : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null);
      if (!AudioCtx) return;
      _audioCtx = new AudioCtx();
    }
    const ctx = _audioCtx;
    const duration = 0.15;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    gain.connect(ctx.destination);
    freqs.forEach(freq => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      osc.connect(gain);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + duration);
    });
  } catch (e) { /* silent */ }
}

// Native DTMF tones — works on iOS/Android/Web
function playDTMFNative(digit) {
  // Always vibrate on native
  if (Platform.OS !== 'web') {
    try { Vibration.vibrate(10); } catch {}
  }
  // Web Audio API works on all platforms (including React Native via JSC/Hermes)
  playDTMFTone(digit);
}

// ── Phone Contacts Integration ──
let _phoneContacts = null;
let _phoneContactsLoading = false;

async function loadPhoneContacts() {
  if (_phoneContacts) return _phoneContacts;
  if (_phoneContactsLoading) return [];
  if (Platform.OS === 'web') return [];
  _phoneContactsLoading = true;
  try {
    const Contacts = require('expo-contacts');
    const { status } = await Contacts.requestPermissionsAsync();
    if (status !== 'granted') { _phoneContactsLoading = false; return []; }
    const { data } = await Contacts.getContactsAsync({
      fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers, Contacts.Fields.Image, Contacts.Fields.Emails],
      sort: Contacts.SortTypes.FirstName,
    });
    _phoneContacts = (data || []).filter(c => c.phoneNumbers && c.phoneNumbers.length > 0).map(c => ({
      id: c.id,
      name: c.name || c.firstName || '',
      phone: c.phoneNumbers?.[0]?.number || '',
      phones: (c.phoneNumbers || []).map(p => ({ number: p.number, label: p.label })),
      email: c.emails?.[0]?.email || '',
      image: c.image?.uri || null,
      source: 'phone',
    }));
    _phoneContactsLoading = false;
    return _phoneContacts;
  } catch (e) {
    console.warn('[Contacts] Error:', e.message);
    _phoneContactsLoading = false;
    return [];
  }
}

// Get most called contacts from history
function getMostCalled(history, phoneContacts) {
  if (!history || history.length === 0) return [];
  const counts = {};
  history.forEach(h => {
    const key = h.to_number || h.contactEmail || '';
    if (key) counts[key] = (counts[key] || 0) + 1;
  });
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([key, count]) => {
      const contact = phoneContacts?.find(c => c.phone?.replace(/\D/g, '')?.includes(key.replace(/\D/g, '')));
      const histItem = history.find(h => (h.to_number || h.contactEmail) === key);
      return {
        key,
        name: contact?.name || histItem?.contactName || histItem?.contact_name || key,
        phone: key,
        count,
        source: contact ? 'phone' : 'chatyy',
      };
    });
}

// --- Country flags ---
const COUNTRY_FLAGS = {
  '1':   { flag: '\u{1F1FA}\u{1F1F8}', name: 'US/CA' },
  '55':  { flag: '\u{1F1E7}\u{1F1F7}', name: 'Brasil' },
  '44':  { flag: '\u{1F1EC}\u{1F1E7}', name: 'UK' },
  '351': { flag: '\u{1F1F5}\u{1F1F9}', name: 'Portugal' },
  '34':  { flag: '\u{1F1EA}\u{1F1F8}', name: 'Espa\u00F1a' },
  '33':  { flag: '\u{1F1EB}\u{1F1F7}', name: 'France' },
  '49':  { flag: '\u{1F1E9}\u{1F1EA}', name: 'Germany' },
  '39':  { flag: '\u{1F1EE}\u{1F1F9}', name: 'Italy' },
  '81':  { flag: '\u{1F1EF}\u{1F1F5}', name: 'Japan' },
  '86':  { flag: '\u{1F1E8}\u{1F1F3}', name: 'China' },
  '91':  { flag: '\u{1F1EE}\u{1F1F3}', name: 'India' },
  '52':  { flag: '\u{1F1F2}\u{1F1FD}', name: 'M\u00E9xico' },
  '57':  { flag: '\u{1F1E8}\u{1F1F4}', name: 'Colombia' },
  '54':  { flag: '\u{1F1E6}\u{1F1F7}', name: 'Argentina' },
  '56':  { flag: '\u{1F1E8}\u{1F1F1}', name: 'Chile' },
  '58':  { flag: '\u{1F1FB}\u{1F1EA}', name: 'Venezuela' },
};

function detectCountry(number) {
  if (!number || !number.startsWith('+')) return null;
  const digits = number.slice(1);
  for (const len of [3, 2, 1]) {
    const code = digits.slice(0, len);
    if (COUNTRY_FLAGS[code]) return COUNTRY_FLAGS[code];
  }
  return null;
}

function formatPhoneDisplay(number) {
  if (!number) return '';
  if (!number.startsWith('+')) return number;
  const digits = number.slice(1);

  // BR numbers: +55 (XX) XXXXX-XXXX (mobile) or +55 (XX) XXXX-XXXX (landline)
  // Mobile numbers start with 9 after the DDD area code
  if (digits.startsWith('55')) {
    const local = digits.slice(2);
    if (local.length === 0) return '+55';
    if (local.length <= 2) return `+55 (${local}`;
    const ddd = local.slice(0, 2);
    const rest = local.slice(2);
    if (rest.length === 0) return `+55 (${ddd})`;
    const isMobile = rest.charAt(0) === '9';
    const splitAt = isMobile ? 5 : 4;
    if (rest.length <= splitAt) return `+55 (${ddd}) ${rest}`;
    return `+55 (${ddd}) ${rest.slice(0, splitAt)}-${rest.slice(splitAt)}`;
  }

  // US/CA numbers: +1 (XXX) XXX-XXXX
  if (digits.startsWith('1')) {
    const local = digits.slice(1);
    if (local.length === 0) return '+1';
    if (local.length <= 3) return `+1 (${local}`;
    const area = local.slice(0, 3);
    const rest = local.slice(3);
    if (rest.length === 0) return `+1 (${area})`;
    if (rest.length <= 3) return `+1 (${area}) ${rest}`;
    return `+1 (${area}) ${rest.slice(0, 3)}-${rest.slice(3)}`;
  }

  // Other countries: +CC XXXX XXXX (groups of 4)
  const cc = digits.length > 3 ? digits.slice(0, 2) : digits;
  const rest = digits.slice(cc.length);
  if (rest.length === 0) return `+${cc}`;
  const groups = [];
  for (let i = 0; i < rest.length; i += 4) {
    groups.push(rest.slice(i, i + 4));
  }
  return `+${cc} ${groups.join(' ')}`;
}

// --- SVG Icons ---
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

function IconBackspace({ size = 24, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M21 4H8l-7 8 7 8h13a2 2 0 002-2V6a2 2 0 00-2-2z" />
      <Path d="M18 9l-6 6M12 9l6 6" />
    </Svg>
  );
}

function IconMissedCall({ size = 14, color = RED }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M22 2L16 8M16 2l6 6" />
      <Path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
    </Svg>
  );
}

function IconInfoCircle({ size = 20, color = BLUE }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <SvgCircle cx={12} cy={12} r={10} />
      <Line x1={12} y1={16} x2={12} y2={12} />
      <Line x1={12} y1={8} x2={12.01} y2={8} />
    </Svg>
  );
}

function IconCheckCircle({ size = 16, color = GREEN }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
      <Polyline points="22 4 12 14.01 9 11.01" />
    </Svg>
  );
}

// --- Signal bars icon for call quality ---
function IconSignalBars({ size = 20, color = '#fff', bars = 3 }) {
  const barCount = 4;
  const barWidth = size / (barCount * 2);
  const gap = barWidth;
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      {Array.from({ length: barCount }, (_, i) => {
        const h = ((i + 1) / barCount) * 14 + 2;
        const x = i * (barWidth + gap) + 1;
        const y = 18 - h;
        const opacity = i < bars ? 1 : 0.25;
        return <Rect key={i} x={x} y={y} width={barWidth} height={h} rx={1} fill={color} opacity={opacity} />;
      })}
    </Svg>
  );
}

// --- API helpers ---
export async function getCallHistory() {
  try {
    const r = await callHistoryList(200, 0);
    if (r?.success && Array.isArray(r?.data?.calls)) return r.data.calls;
    return [];
  } catch { return []; }
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
  } catch { return null; }
}

export async function removeCallFromHistory(callId) {
  try { await callHistoryDelete(callId); return true; } catch { return null; }
}

// --- Formatting ---
function formatCallTime(timestamp, t) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (diffDays === 0) {
    const todayLabel = t?.('calls.today') || 'Hoje';
    return `${todayLabel} ${timeStr}`;
  }
  if (diffDays === 1) {
    const yesterdayLabel = t?.('calls.yesterday') || 'Ontem';
    return `${yesterdayLabel} ${timeStr}`;
  }
  if (diffDays < 7) {
    return date.toLocaleDateString(undefined, { weekday: 'short' }) + ` ${timeStr}`;
  }
  return date.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' }) + ` ${timeStr}`;
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `0:${s < 10 ? '0' : ''}${s}`;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function formatDurationLong(seconds) {
  if (!seconds || seconds <= 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function getCallLabel(type, t) {
  if (t) {
    const keys = { outgoing: 'calls.outgoing', incoming: 'calls.incoming', missed: 'calls.missed' };
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

// --- Dial pad keys ---
const DIAL_KEYS = [
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

// --- DTMF dial pad keys (for in-call keypad) ---
const DTMF_KEYS = [
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

// ============================================================
// SEGMENT TABS (Recentes / Chatyy / Telefone)
// ============================================================
const SegmentTabs = memo(function SegmentTabs({ activeTab, onTabChange, isDark, t }) {
  const tabs = [
    { key: 'recent', label: t?.('calls.recent') || 'Recentes' },
    { key: 'chatyy', label: t?.('calls.chatyy') || 'Chatyy' },
    { key: 'phone', label: t?.('calls.phone') || 'Telefone' },
  ];

  const activeBg = isDark ? '#3a3a3c' : '#ffffff';
  const containerBg = isDark ? '#1c1c1e' : '#e9e9ea';

  return (
    <View style={[s.segmentContainer, { backgroundColor: containerBg }]}>
      {tabs.map((tab) => {
        const active = activeTab === tab.key;
        return (
          <TouchableOpacity
            key={tab.key}
            style={[
              s.segmentTab,
              active && [s.segmentTabActive, { backgroundColor: activeBg }],
            ]}
            onPress={() => onTabChange(tab.key)}
            activeOpacity={0.7}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
          >
            <Text style={[
              s.segmentLabel,
              { color: isDark ? '#ffffff' : '#000000' },
              active && { fontWeight: '600' },
              !active && { color: isDark ? '#8e8e93' : '#6c6c70' },
            ]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
});

// ============================================================
// DIAL KEY - iPhone Phone app style
// ============================================================
const DIAL_KEY_SIZE = 77;
const DialKey = memo(function DialKey({ digit, sub, onPress, onLongPress, isDark, size }) {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = useCallback(() => {
    Animated.spring(scaleAnim, {
      toValue: 0.93,
      tension: 300,
      friction: 10,
      useNativeDriver: false,
    }).start();
  }, [scaleAnim]);

  const handlePressOut = useCallback(() => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      tension: 200,
      friction: 10,
      useNativeDriver: false,
    }).start();
  }, [scaleAnim]);

  // iPhone uses a light gray circle for dial keys
  const keyBg = isDark ? '#3a3a3c' : '#d4d7dc';
  const keyColor = isDark ? '#ffffff' : '#000000';
  const subColor = isDark ? '#aeaeb2' : '#000000';

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity
        style={[s.dialKey, { backgroundColor: keyBg }, size ? { width: size, height: size, borderRadius: size / 2 } : null]}
        onPress={onPress}
        onLongPress={onLongPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        activeOpacity={0.5}
        accessibilityLabel={digit}
        accessibilityRole="button"
      >
        <Text style={[s.dialKeyDigit, { color: keyColor }, size && size < 70 ? { fontSize: 28 } : null]}>{digit}</Text>
        {sub ? (
          <Text style={[s.dialKeySub, { color: subColor }]}>{sub}</Text>
        ) : (
          <View style={{ height: digit === '1' ? 14 : 11 }} />
        )}
      </TouchableOpacity>
    </Animated.View>
  );
});

// ============================================================
// CALL HISTORY ROW - iPhone style
// ============================================================
const CallHistoryRow = memo(function CallHistoryRow({ item, isDark, t, onPress, onInfoPress }) {
  const isMissed = item.type === 'missed';
  const nameColor = isMissed ? RED : (isDark ? '#ffffff' : '#000000');
  const subColor = isDark ? '#8e8e93' : '#8e8e93';
  const label = getCallLabel(item.type, t);
  const durationStr = formatDuration(item.duration);
  const country = detectCountry(item.to_number || item.contactEmail);
  const isChatyy = item.source === 'chat';
  const displayName = item.contactName || item.contact_name || item.to_number || item.contactEmail || '?';

  return (
    <TouchableOpacity
      style={s.historyRow}
      onPress={() => onPress(item)}
      activeOpacity={0.6}
    >
      {/* Left: Avatar or flag */}
      <View style={s.historyLeft}>
        {isChatyy && (item.contactName || item.contactEmail) ? (
          <AvatarCircle
            name={item.contactName || item.contactEmail || '?'}
            email={item.contactEmail}
            size={44}
          />
        ) : (
          <View style={[s.historyAvatar, { backgroundColor: isDark ? '#2c2c2e' : '#f2f2f7' }]}>
            {country ? (
              <Text style={{ fontSize: 20 }}>{country.flag}</Text>
            ) : (
              <IconPhone size={20} color={subColor} />
            )}
          </View>
        )}
      </View>

      {/* Middle: Name + type */}
      <View style={s.historyMiddle}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={[s.historyName, { color: nameColor }]} numberOfLines={1}>
            {displayName}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
          {isMissed ? (
            <ArrowIncoming size={12} color={RED} />
          ) : item.type === 'outgoing' ? (
            <ArrowOutgoing size={12} color={isDark ? '#8e8e93' : '#6c6c70'} />
          ) : (
            <ArrowIncoming size={12} color={isDark ? '#8e8e93' : '#6c6c70'} />
          )}
          <Text style={[s.historyType, { color: subColor }]}>
            {isChatyy ? (t?.('calls.chatyyCall') || 'Chatyy') : (item.to_number ? formatPhoneDisplay(item.to_number) : label)}
          </Text>
          {item.video && (
            <IconVideo size={12} color={subColor} />
          )}
          {durationStr ? (
            <Text style={[s.historyType, { color: subColor }]}>{durationStr}</Text>
          ) : null}
        </View>
      </View>

      {/* Right: Time + info button */}
      <View style={s.historyRight}>
        <Text style={[s.historyTime, { color: subColor }]}>
          {formatCallTime(item.timestamp || item.created_at, t)}
        </Text>
        <TouchableOpacity
          style={s.infoBtn}
          onPress={() => onInfoPress(item)}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityLabel={t?.('calls.callInfo') || 'Info'}
          accessibilityRole="button"
        >
          <IconInfoCircle size={20} color={BLUE} />
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
});

// ============================================================
// LOADING SKELETON
// ============================================================
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

  const opacity = shimmer.interpolate({ inputRange: [0, 1], outputRange: [0.3, 0.7] });
  const bg = isDark ? '#2c2c2e' : '#e5e7eb';

  return (
    <View style={{ paddingTop: 8 }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <Animated.View key={i} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16, gap: 12, opacity }}>
          <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: bg }} />
          <View style={{ flex: 1, gap: 6 }}>
            <View style={{ height: 16, borderRadius: 4, backgroundColor: bg, width: '50%' }} />
            <View style={{ height: 12, borderRadius: 4, backgroundColor: bg, width: '35%' }} />
          </View>
          <View style={{ width: 60, height: 12, borderRadius: 4, backgroundColor: bg }} />
        </Animated.View>
      ))}
    </View>
  );
}

// ============================================================
// PLAN STATUS BADGE
// ============================================================
function PlanBadge({ minutesInfo, isDark, t }) {
  if (!minutesInfo) return null;
  const limit = minutesInfo.minutes_limit || 0;
  const used = minutesInfo.minutes_used || 0;
  const isPaid = limit > 0;
  const isUnlimited = limit >= 9999;

  if (isPaid) {
    const badgeText = isUnlimited
      ? (t?.('calls.unlimited') || 'Chamadas ilimitadas')
      : `${used}/${limit} min`;
    return (
      <View style={[s.planBadge, { backgroundColor: isDark ? '#0a2e0a' : '#f0fdf4' }]}>
        <IconCheckCircle size={16} color={GREEN} />
        <Text style={[s.planBadgeText, { color: isDark ? '#86efac' : '#166534' }]}>
          {badgeText}
        </Text>
      </View>
    );
  }

  return (
    <View style={[s.planBadge, { backgroundColor: isDark ? '#1c1c1e' : '#f2f2f7' }]}>
      <Text style={[s.planBadgeText, { color: isDark ? '#8e8e93' : '#6c6c70', fontSize: 12 }]}>
        {t?.('calls.needsPlan') || 'Assine o plano One para chamadas ilimitadas'}
      </Text>
    </View>
  );
}

// ============================================================
// CALL INFO MODAL
// ============================================================
function CallInfoModal({ item, visible, onClose, isDark, t, onCallAgain }) {
  if (!item) return null;

  const bgColor = isDark ? '#1c1c1e' : '#ffffff';
  const textColor = isDark ? '#ffffff' : '#000000';
  const subColor = isDark ? '#8e8e93' : '#6c6c70';
  const sepColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const isChatyy = item.source === 'chat';
  const country = detectCountry(item.to_number);
  const displayName = item.contactName || item.contact_name || item.to_number || item.contactEmail || '?';

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={true}
      onRequestClose={onClose}
    >
      <View style={s.modalOverlay}>
        <View style={[s.modalContent, { backgroundColor: bgColor }]}>
          {/* Header */}
          <View style={s.modalHeader}>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={{ color: BLUE, fontSize: 17 }}>{t?.('common.close') || 'Fechar'}</Text>
            </TouchableOpacity>
            <Text style={[s.modalTitle, { color: textColor }]}>{t?.('calls.callInfo') || 'Info'}</Text>
            <View style={{ width: 60 }} />
          </View>

          {/* Contact info */}
          <View style={s.modalContactSection}>
            {isChatyy && (item.contactName || item.contactEmail) ? (
              <AvatarCircle name={displayName} email={item.contactEmail} size={64} />
            ) : (
              <View style={[s.modalAvatar, { backgroundColor: isDark ? '#2c2c2e' : '#f2f2f7' }]}>
                {country ? (
                  <Text style={{ fontSize: 28 }}>{country.flag}</Text>
                ) : (
                  <IconPhone size={28} color={subColor} />
                )}
              </View>
            )}
            <Text style={[s.modalContactName, { color: textColor }]}>{displayName}</Text>
            {item.to_number ? (
              <Text style={[s.modalContactSub, { color: subColor }]}>{formatPhoneDisplay(item.to_number)}</Text>
            ) : item.contactEmail ? (
              <Text style={[s.modalContactSub, { color: subColor }]}>{item.contactEmail}</Text>
            ) : null}
          </View>

          {/* Details */}
          <View style={[s.modalDetails, { backgroundColor: isDark ? '#2c2c2e' : '#f9f9f9', borderColor: sepColor }]}>
            <View style={s.modalDetailRow}>
              <Text style={[s.modalDetailLabel, { color: subColor }]}>{t?.('calls.type') || 'Tipo'}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {isChatyy ? (
                  <View style={[s.chatyyBadge, { backgroundColor: isDark ? 'rgba(52,199,89,0.15)' : 'rgba(52,199,89,0.1)' }]}>
                    <Text style={{ color: GREEN, fontSize: 12, fontWeight: '600' }}>Chatyy</Text>
                  </View>
                ) : (
                  <Text style={[s.modalDetailValue, { color: textColor }]}>{t?.('calls.phoneCall') || 'Telefone'}</Text>
                )}
                {item.video ? (
                  <Text style={[s.modalDetailValue, { color: textColor }]}>{t?.('calls.video') || 'Video'}</Text>
                ) : (
                  <Text style={[s.modalDetailValue, { color: textColor }]}>{t?.('calls.audio') || 'Audio'}</Text>
                )}
              </View>
            </View>
            <View style={[s.modalDetailSep, { backgroundColor: sepColor }]} />
            <View style={s.modalDetailRow}>
              <Text style={[s.modalDetailLabel, { color: subColor }]}>{t?.('calls.date') || 'Data'}</Text>
              <Text style={[s.modalDetailValue, { color: textColor }]}>
                {new Date(item.timestamp || item.created_at).toLocaleString(undefined, {
                  day: '2-digit', month: '2-digit', year: 'numeric',
                  hour: '2-digit', minute: '2-digit'
                })}
              </Text>
            </View>
            <View style={[s.modalDetailSep, { backgroundColor: sepColor }]} />
            <View style={s.modalDetailRow}>
              <Text style={[s.modalDetailLabel, { color: subColor }]}>{getCallLabel(item.type, t)}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                {item.type === 'missed' ? (
                  <IconMissedCall size={14} color={RED} />
                ) : item.type === 'outgoing' ? (
                  <ArrowOutgoing size={14} color={GREEN} />
                ) : (
                  <ArrowIncoming size={14} color={GREEN} />
                )}
              </View>
            </View>
            <View style={[s.modalDetailSep, { backgroundColor: sepColor }]} />
            <View style={s.modalDetailRow}>
              <Text style={[s.modalDetailLabel, { color: subColor }]}>{t?.('calls.duration') || 'Duracao'}</Text>
              <Text style={[s.modalDetailValue, { color: textColor }]}>{formatDurationLong(item.duration)}</Text>
            </View>
          </View>

          {/* Call again button */}
          <TouchableOpacity
            style={s.callAgainBtn}
            onPress={() => { onClose(); onCallAgain(item); }}
            activeOpacity={0.7}
          >
            <IconPhone size={18} color="#fff" />
            <Text style={s.callAgainText}>{t?.('calls.callAgain') || 'Ligar novamente'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ============================================================
// AUDIO WAVEFORM ANIMATION - subtle bars when connected
// ============================================================
function AudioWaveform({ active }) {
  const BAR_COUNT = 5;
  const anims = useRef(Array.from({ length: BAR_COUNT }, () => new Animated.Value(0.3))).current;

  useEffect(() => {
    if (!active) {
      anims.forEach(a => a.setValue(0.3));
      return;
    }
    const animations = anims.map((anim, i) => {
      return Animated.loop(
        Animated.sequence([
          Animated.timing(anim, {
            toValue: 0.4 + Math.random() * 0.6,
            duration: 300 + i * 80,
            useNativeDriver: false,
          }),
          Animated.timing(anim, {
            toValue: 0.15 + Math.random() * 0.25,
            duration: 250 + i * 60,
            useNativeDriver: false,
          }),
        ])
      );
    });
    animations.forEach(a => a.start());
    return () => animations.forEach(a => a.stop());
  }, [active]);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 24, gap: 3, marginTop: 12 }}>
      {anims.map((anim, i) => (
        <Animated.View
          key={i}
          style={{
            width: 3,
            borderRadius: 1.5,
            backgroundColor: 'rgba(255,255,255,0.5)',
            height: anim.interpolate({
              inputRange: [0, 1],
              outputRange: [4, 24],
            }),
          }}
        />
      ))}
    </View>
  );
}

// ============================================================
// DTMF KEYPAD OVERLAY - for IVR menus during a call
// ============================================================
function DTMFKeypad({ visible, onClose, onDigit, isDark, t }) {
  if (!visible) return null;

  const DTMF_KEY_SIZE = 64;

  return (
    <View style={{
      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.85)',
      alignItems: 'center', justifyContent: 'center',
      zIndex: 100,
    }}>
      {/* Close button */}
      <TouchableOpacity
        style={{ position: 'absolute', top: Platform.OS === 'web' ? 20 : 60, right: 20, padding: 10, zIndex: 101 }}
        onPress={onClose}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <IconX size={24} color="rgba(255,255,255,0.7)" />
      </TouchableOpacity>

      <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14, fontWeight: '500', marginBottom: 20, letterSpacing: 0.5 }}>
        {t?.('calls.dtmfKeypad') || 'Teclado DTMF'}
      </Text>

      {/* 4x3 grid */}
      <View style={{ alignItems: 'center' }}>
        {[0, 1, 2, 3].map(row => (
          <View key={row} style={{ flexDirection: 'row', gap: 20, marginBottom: 12 }}>
            {DTMF_KEYS.slice(row * 3, row * 3 + 3).map((k) => (
              <TouchableOpacity
                key={k.digit}
                style={{
                  width: DTMF_KEY_SIZE, height: DTMF_KEY_SIZE,
                  borderRadius: DTMF_KEY_SIZE / 2,
                  backgroundColor: 'rgba(255,255,255,0.12)',
                  alignItems: 'center', justifyContent: 'center',
                }}
                onPress={() => {
                  if (Platform.OS !== 'web') Vibration.vibrate(10);
                  onDigit(k.digit);
                }}
                activeOpacity={0.5}
                accessibilityLabel={k.digit}
                accessibilityRole="button"
              >
                <Text style={{ color: '#fff', fontSize: 28, fontWeight: '300' }}>{k.digit}</Text>
                {k.sub ? (
                  <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 9, fontWeight: '600', letterSpacing: 1.2 }}>{k.sub}</Text>
                ) : (
                  <View style={{ height: 10 }} />
                )}
              </TouchableOpacity>
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

// ============================================================
// ACTIVE CALL SCREEN - Modern iPhone/WhatsApp style
// ============================================================
function ActiveCallScreen({
  visible, number, contactName, isDark, t, onHangup, callState, duration,
  isMuted, onToggleMute, isSpeaker, onToggleSpeaker, onSendDTMF, onMinimize,
}) {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseRingAnim = useRef(new Animated.Value(0)).current;
  const [showKeypad, setShowKeypad] = useState(false);

  // Pulsing avatar ring when ringing/connecting
  useEffect(() => {
    if (!visible || callState === 'connected' || callState === 'ended') {
      pulseRingAnim.setValue(0);
      return;
    }
    const ringPulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseRingAnim, { toValue: 1, duration: 1200, useNativeDriver: false }),
        Animated.timing(pulseRingAnim, { toValue: 0, duration: 1200, useNativeDriver: false }),
      ])
    );
    ringPulse.start();
    return () => ringPulse.stop();
  }, [visible, callState]);

  // Pulsing scale for avatar
  useEffect(() => {
    if (!visible || callState === 'connected' || callState === 'ended') {
      pulseAnim.setValue(1);
      return;
    }
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.08, duration: 900, useNativeDriver: false }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 900, useNativeDriver: false }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [visible, callState]);

  const formatTime = (s) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  const isConnected = callState === 'connected';
  const isRinging = callState === 'ringing' || callState === 'connecting' || callState === 'phone_ringing';

  const stateLabel = callState === 'connecting' ? (t?.('calls.connecting') || 'Conectando...')
    : callState === 'ringing' ? (t?.('calls.ringing') || 'Chamando...')
    : callState === 'connected' ? (t?.('calls.inCall') || 'Em chamada')
    : callState === 'ended' ? (t?.('calls.ended') || 'Chamada encerrada')
    : callState === 'phone_ringing' ? (t?.('calls.phoneRinging') || 'Atenda seu telefone...')
    : (t?.('calls.connecting') || 'Conectando...');

  // Quality indicator (simulated: good quality after 3s connected)
  const qualityBars = isConnected ? (duration < 3 ? 2 : duration < 10 ? 3 : 4) : 0;

  if (!visible) return null;

  // Pulsing ring interpolations
  const ringScale = pulseRingAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.5],
  });
  const ringOpacity = pulseRingAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.4, 0.15, 0],
  });

  // Initial of contact name for avatar
  const initial = (contactName || number || '?').charAt(0).toUpperCase();

  return (
    <Modal visible={visible} animationType="fade" transparent={false}>
      <View style={activeCallStyles.container}>
        {/* Gradient background layers */}
        <View style={activeCallStyles.gradientTop} />
        <View style={activeCallStyles.gradientBottom} />

        {/* Top bar: minimize button (left) + quality indicator (right) */}
        <View style={{
          position: 'absolute', top: Platform.OS === 'ios' ? 50 : 20, left: 0, right: 0,
          flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
          paddingHorizontal: 18, zIndex: 10,
        }}>
          {onMinimize ? (
            <TouchableOpacity
              onPress={onMinimize}
              style={{
                width: 40, height: 40, borderRadius: 20,
                backgroundColor: 'rgba(255,255,255,0.16)',
                alignItems: 'center', justifyContent: 'center',
              }}
              accessibilityLabel="Minimizar"
            >
              <Text style={{ color: '#fff', fontSize: 20, fontWeight: '700', marginTop: -2 }}>⌄</Text>
            </TouchableOpacity>
          ) : <View style={{ width: 40 }} />}
          {isConnected ? (
            <View style={{
              flexDirection: 'row', alignItems: 'center', gap: 6,
              backgroundColor: 'rgba(255,255,255,0.12)',
              paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14,
            }}>
              <IconSignalBars size={14} color="#fff" bars={qualityBars} />
              <Text style={{ color: '#fff', fontSize: 11, fontWeight: '600' }}>HD</Text>
            </View>
          ) : <View style={{ width: 40 }} />}
        </View>

        {/* Call quality indicator - top right (legacy, hidden now) */}
        {false && isConnected && (
          <View style={activeCallStyles.qualityContainer}>
            <IconSignalBars size={16} color="rgba(255,255,255,0.7)" bars={qualityBars} />
          </View>
        )}

        {/* Avatar area with pulsing ring */}
        <View style={activeCallStyles.avatarSection}>
          {/* Expanding pulse ring (visible when ringing) */}
          {isRinging && (
            <Animated.View style={[
              activeCallStyles.pulseRing,
              { transform: [{ scale: ringScale }], opacity: ringOpacity },
            ]} />
          )}
          {/* Second ring */}
          {isRinging && (
            <Animated.View style={[
              activeCallStyles.pulseRing,
              {
                transform: [{ scale: pulseRingAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.3] }) }],
                opacity: pulseRingAnim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.3, 0.1, 0] }),
              },
            ]} />
          )}

          {/* Avatar circle */}
          <Animated.View style={{ transform: [{ scale: isRinging ? pulseAnim : 1 }] }}>
            <View style={activeCallStyles.avatarOuter}>
              <View style={activeCallStyles.avatarInner}>
                <Text style={activeCallStyles.avatarInitial}>{initial}</Text>
              </View>
            </View>
          </Animated.View>
        </View>

        {/* Name / Number */}
        <Text style={activeCallStyles.contactName} numberOfLines={1}>
          {contactName || number}
        </Text>
        {contactName && number && (
          <Text style={activeCallStyles.contactNumber}>{formatPhoneDisplay(number)}</Text>
        )}

        {/* Status label */}
        <Text style={activeCallStyles.stateLabel}>{stateLabel}</Text>

        {/* Duration timer - large and prominent when connected */}
        {isConnected && (
          <Text style={activeCallStyles.durationTimer}>{formatTime(duration)}</Text>
        )}

        {/* Audio waveform when connected */}
        <AudioWaveform active={isConnected} />

        {/* Spacer */}
        <View style={{ flex: 1 }} />

        {/* Action buttons row: Mute | Keypad | Speaker */}
        <View style={activeCallStyles.actionRow}>
          {/* Mute */}
          <TouchableOpacity
            style={[activeCallStyles.actionBtn, isMuted && activeCallStyles.actionBtnActive]}
            onPress={onToggleMute}
            activeOpacity={0.7}
            accessibilityLabel={isMuted ? (t?.('calls.unmute') || 'Ativar microfone') : (t?.('calls.mute') || 'Silenciar')}
            accessibilityRole="button"
          >
            {isMuted ? (
              <IconMicOff size={24} color="#fff" />
            ) : (
              <IconMic size={24} color="#fff" />
            )}
            <Text style={activeCallStyles.actionLabel}>
              {isMuted ? (t?.('calls.muted') || 'Mudo') : (t?.('calls.mute') || 'Silenciar')}
            </Text>
          </TouchableOpacity>

          {/* Keypad */}
          <TouchableOpacity
            style={[activeCallStyles.actionBtn, showKeypad && activeCallStyles.actionBtnActive]}
            onPress={() => setShowKeypad(prev => !prev)}
            activeOpacity={0.7}
            accessibilityLabel={t?.('calls.keypad') || 'Teclado'}
            accessibilityRole="button"
          >
            <IconGrid size={24} color="#fff" />
            <Text style={activeCallStyles.actionLabel}>
              {t?.('calls.keypad') || 'Teclado'}
            </Text>
          </TouchableOpacity>

          {/* Speaker */}
          <TouchableOpacity
            style={[activeCallStyles.actionBtn, isSpeaker && activeCallStyles.actionBtnActive]}
            onPress={onToggleSpeaker}
            activeOpacity={0.7}
            accessibilityLabel={isSpeaker ? (t?.('calls.speakerOff') || 'Desligar alto-falante') : (t?.('calls.speakerOn') || 'Alto-falante')}
            accessibilityRole="button"
          >
            {isSpeaker ? (
              <IconVolume2 size={24} color="#fff" />
            ) : (
              <IconVolumeX size={24} color="#fff" />
            )}
            <Text style={activeCallStyles.actionLabel}>
              {isSpeaker ? (t?.('calls.speaker') || 'Alto-falante') : (t?.('calls.speaker') || 'Alto-falante')}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Hangup button */}
        <TouchableOpacity
          style={activeCallStyles.hangupBtn}
          onPress={onHangup}
          activeOpacity={0.8}
          accessibilityLabel={t?.('calls.tapToEnd') || 'Encerrar chamada'}
          accessibilityRole="button"
        >
          <IconPhoneOff size={32} color="#fff" />
        </TouchableOpacity>
        <Text style={activeCallStyles.hangupLabel}>
          {t?.('calls.tapToEnd') || 'Encerrar'}
        </Text>

        <View style={{ height: Platform.OS === 'web' ? 24 : 40 }} />

        {/* DTMF keypad overlay */}
        <DTMFKeypad
          visible={showKeypad}
          onClose={() => setShowKeypad(false)}
          onDigit={(digit) => { if (onSendDTMF) onSendDTMF(digit); }}
          isDark={true}
          t={t}
        />
      </View>
    </Modal>
  );
}

// ActiveCallScreen styles
const activeCallStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a1a',
    alignItems: 'center',
    paddingTop: Platform.OS === 'web' ? 60 : 80,
  },
  // Gradient layers (approximated with solid + opacity views)
  gradientTop: {
    position: 'absolute', top: 0, left: 0, right: 0,
    height: '50%',
    backgroundColor: '#1a1040',
    opacity: 0.8,
  },
  gradientBottom: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    height: '55%',
    backgroundColor: '#0d1b2a',
    opacity: 0.9,
  },
  qualityContainer: {
    position: 'absolute',
    top: Platform.OS === 'web' ? 16 : 56,
    right: 20,
    zIndex: 10,
  },
  avatarSection: {
    width: 140,
    height: 140,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  pulseRing: {
    position: 'absolute',
    width: 140,
    height: 140,
    borderRadius: 70,
    borderWidth: 2,
    borderColor: 'rgba(37,211,102,0.5)',
  },
  avatarOuter: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(37,211,102,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(37,211,102,0.3)',
  },
  avatarInner: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    color: '#fff',
    fontSize: 40,
    fontWeight: '600',
  },
  contactName: {
    color: '#fff',
    fontSize: 30,
    fontWeight: '600',
    marginTop: 20,
    paddingHorizontal: 24,
    textAlign: 'center',
    zIndex: 1,
  },
  contactNumber: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 16,
    marginTop: 4,
    zIndex: 1,
  },
  stateLabel: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 15,
    marginTop: 8,
    fontWeight: '400',
    zIndex: 1,
  },
  durationTimer: {
    color: '#fff',
    fontSize: 48,
    fontWeight: '200',
    marginTop: 8,
    letterSpacing: 4,
    fontVariant: ['tabular-nums'],
    zIndex: 1,
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 32,
    marginBottom: 40,
    zIndex: 1,
  },
  actionBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnActive: {
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  actionLabel: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 11,
    fontWeight: '500',
    marginTop: 4,
    textAlign: 'center',
    position: 'absolute',
    bottom: -20,
    width: 80,
  },
  hangupBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: RED,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
    zIndex: 1,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 4px 20px rgba(255,59,48,0.5)',
    } : Platform.OS === 'ios' ? {
      shadowColor: RED,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.5,
      shadowRadius: 16,
    } : { elevation: 8 }),
  },
  hangupLabel: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 13,
    marginTop: 10,
    fontWeight: '400',
    zIndex: 1,
  },
});

// ============================================================
// TWILIO WEBRTC CALL MANAGER (web: direct SDK, native: WebView)
// ============================================================
let _twilioDevice = null;
let _twilioCall = null;

// Native WebRTC call via hidden WebView with Twilio JS SDK
let _nativeCallWebView = null;
let _nativeCallStateCallback = null;

function NativeTwilioCall({ token, toNumber, onStateChange, onRef }) {
  const webViewRef = useRef(null);
  const readyRef = useRef(false);

  useEffect(() => {
    if (onRef) onRef(webViewRef);
  }, []);

  const html = `<!DOCTYPE html><html><head>
<script src="https://sdk.twilio.com/js/client/releases/1.14.3/twilio.min.js"></script>
</head><body><script>
var device, conn, stateInterval;
function send(msg) { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); }

try {
  Twilio.Device.setup('${token}', { edge: 'ashburn', closeProtection: false, enableRingingState: true });

  Twilio.Device.ready(function() {
    send({state:'ready'});
    conn = Twilio.Device.connect({ To: '${toNumber}' });
    conn.on('ringing', function() { send({state:'ringing'}); });
    conn.on('accept', function() {
      send({state:'connected'});
      stateInterval = setInterval(function() { send({state:'tick'}); }, 1000);
    });
    conn.on('disconnect', function() {
      clearInterval(stateInterval);
      send({state:'ended'});
    });
    conn.on('cancel', function() { send({state:'ended'}); });
    conn.on('error', function(e) { send({state:'error', msg: e.message || 'Unknown'}); });
  });

  Twilio.Device.error(function(e) {
    send({state:'error', msg: e.message || 'Device error'});
  });
} catch(e) {
  send({state:'error', msg: e.message || 'Init error'});
}

function hangup() {
  if (conn) conn.disconnect();
  Twilio.Device.disconnectAll();
  Twilio.Device.destroy();
}
</script></body></html>`;

  const WebView = require('react-native-webview').WebView;
  return (
    <WebView
      ref={webViewRef}
      source={{ html, baseUrl: 'https://chatyy.com.br' }}
      style={{ width: 1, height: 1, position: 'absolute', top: -100, left: -100, opacity: 0 }}
      mediaPlaybackRequiresUserAction={false}
      allowsInlineMediaPlayback={true}
      javaScriptEnabled={true}
      originWhitelist={['*']}
      onMessage={(event) => {
        try {
          const msg = JSON.parse(event.nativeEvent.data);
          if (msg.state === 'error') {
            console.warn('[NativeTwilio] Error:', msg.msg);
            onStateChange('error:' + (msg.msg || ''));
          } else if (msg.state === 'tick') {
            // duration tick handled by parent
            onStateChange('tick');
          } else {
            onStateChange(msg.state);
          }
        } catch {}
      }}
    />
  );
}

async function startWebRTCCall(toNumber, onStateChange) {
  try {
    onStateChange('connecting');
    // Get token
    const tokenRes = await voipToken();
    if (!tokenRes?.success || !tokenRes.data?.token) {
      throw new Error(tokenRes?.message || 'Failed to get token');
    }
    const token = tokenRes.data.token;

    if (Platform.OS === 'web') {
      // Dynamic import Twilio Voice SDK
      const { Device } = await import('@twilio/voice-sdk');
      _twilioDevice = new Device(token, { edge: 'ashburn', closeProtection: true });
      await _twilioDevice.register();

      // Make the call
      const params = { To: toNumber };
      _twilioCall = await _twilioDevice.connect({ params });

      _twilioCall.on('ringing', () => onStateChange('ringing'));
      _twilioCall.on('accept', () => onStateChange('connected'));
      _twilioCall.on('disconnect', () => {
        onStateChange('ended');
        cleanupTwilioCall();
      });
      _twilioCall.on('cancel', () => {
        onStateChange('ended');
        cleanupTwilioCall();
      });
      _twilioCall.on('error', (err) => {
        console.warn('[Twilio] Call error:', err.message);
        onStateChange('ended');
        cleanupTwilioCall();
      });
    } else {
      // Native: use WebView with Twilio JS SDK
      // Store token and number for the WebView component to use
      _nativeCallStateCallback = onStateChange;
      return { useNativeWebView: true, token, toNumber };
    }
  } catch (err) {
    console.warn('[Twilio WebRTC] Error:', err.message);
    throw err;
  }
}

function hangupTwilioCall() {
  if (_twilioCall) {
    try { _twilioCall.disconnect(); } catch {}
  }
  cleanupTwilioCall();
}

function cleanupTwilioCall() {
  _twilioCall = null;
  if (_twilioDevice) {
    try { _twilioDevice.destroy(); } catch {}
    _twilioDevice = null;
  }
}

// ============================================================
// DIALER MODAL - iPhone Phone app style (pixel-perfect)
// ============================================================
// T9 mapping: number → letters
const T9_MAP = { '2': 'abc', '3': 'def', '4': 'ghi', '5': 'jkl', '6': 'mno', '7': 'pqrs', '8': 'tuv', '9': 'wxyz' };

function t9Match(digits, name) {
  if (!digits || !name) return false;
  const lower = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Check if digits match the START of any word in the name
  const words = lower.split(/\s+/);
  for (const word of words) {
    let match = true;
    for (let i = 0; i < digits.length && i < word.length; i++) {
      const letters = T9_MAP[digits[i]];
      if (!letters || !letters.includes(word[i])) { match = false; break; }
    }
    if (match && digits.length <= word.length) return true;
  }
  // Also check if digits match consecutive first letters (e.g., 27 → Ana Paula)
  const initials = words.map(w => w[0]).join('');
  let initialsMatch = true;
  for (let i = 0; i < digits.length && i < initials.length; i++) {
    const letters = T9_MAP[digits[i]];
    if (!letters || !letters.includes(initials[i])) { initialsMatch = false; break; }
  }
  return initialsMatch && digits.length <= initials.length;
}

export function CallerIdVerifyContent({ onClose, onVerified, isDark, t }) {
  const [step, setStep] = useState('intro'); // intro | code | done
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [phone, setPhone] = useState('');

  useEffect(() => {
    setStep('intro');
    setCode('');
    setError('');
    // Pre-load phone from profile
    getProfile?.().then(r => {
      if (r?.success) {
        if (r.data?.telnyx_caller_id_verified) setStep('done');
        setPhone(r.data?.verified_phone || r.data?.phone || '');
      }
    }).catch(() => {});
  }, []);

  const bg = isDark ? '#1c1c1e' : '#fff';
  const txt = isDark ? '#fff' : '#000';
  const sub = isDark ? '#8e8e93' : '#636366';

  const handleSendSms = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await voipVerifiedNumberRequest();
      if (r?.success) {
        if (r.data?.already_verified) {
          setStep('done');
          onVerified?.();
        } else {
          setStep('code');
        }
      } else {
        setError(r?.message || 'Erro ao enviar SMS');
      }
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await voipVerifiedNumberConfirm(code);
      if (r?.success) {
        setStep('done');
        onVerified?.();
      } else {
        setError(r?.message || 'Código incorreto');
      }
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={{ backgroundColor: bg, borderRadius: 22, padding: 0, overflow: 'hidden', maxWidth: 420, alignSelf: 'center', width: '100%' }}>

          {/* Hero header */}
          <View style={{
            paddingHorizontal: 24, paddingTop: 28, paddingBottom: 22,
            backgroundColor: step === 'done' ? '#34C759' : '#007AFF',
            alignItems: 'center',
          }}>
            <View style={{
              width: 76, height: 76, borderRadius: 38,
              backgroundColor: 'rgba(255,255,255,0.18)',
              borderWidth: 2, borderColor: 'rgba(255,255,255,0.4)',
              alignItems: 'center', justifyContent: 'center', marginBottom: 14,
            }}>
              <Text style={{ fontSize: 38 }}>{step === 'done' ? '✓' : step === 'code' ? '💬' : '📞'}</Text>
            </View>
            <Text style={{ fontSize: 20, fontWeight: '800', color: '#fff', textAlign: 'center', letterSpacing: -0.3 }}>
              {step === 'done' ? 'Número verificado!' : step === 'code' ? 'Digite o código' : 'Verificar seu número'}
            </Text>
            {step !== 'done' && (
              <Text style={{ fontSize: 13, color: 'rgba(255,255,255,0.92)', textAlign: 'center', marginTop: 6, lineHeight: 18 }}>
                {step === 'code' ? 'Recebemos? Confirma aí embaixo.' : 'Mostre seu número de verdade nas ligações'}
              </Text>
            )}
          </View>

          <View style={{ padding: 22 }}>

          {step === 'done' ? (
            <>
              <Text style={{ fontSize: 15, color: txt, lineHeight: 22, textAlign: 'center', marginBottom: 8, fontWeight: '600' }}>
                {phone}
              </Text>
              <Text style={{ fontSize: 13, color: sub, lineHeight: 19, textAlign: 'center', marginBottom: 22 }}>
                Pronto! Quando você ligar pelo Chatyy, esse número vai aparecer pra quem receber a chamada — não mais um número desconhecido.
              </Text>
              <TouchableOpacity
                onPress={onClose}
                style={{ height: 50, borderRadius: 12, backgroundColor: '#34C759', alignItems: 'center', justifyContent: 'center' }}
              >
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>Entendi</Text>
              </TouchableOpacity>
            </>
          ) : step === 'intro' ? (
            <>
              {/* Why card */}
              <View style={{
                backgroundColor: isDark ? 'rgba(0,122,255,0.10)' : 'rgba(0,122,255,0.07)',
                borderRadius: 12, padding: 14, marginBottom: 14,
                borderLeftWidth: 3, borderLeftColor: '#007AFF',
              }}>
                <Text style={{ fontSize: 12, fontWeight: '800', color: '#007AFF', marginBottom: 4, letterSpacing: 0.4 }}>
                  POR QUE ISSO?
                </Text>
                <Text style={{ fontSize: 13, color: txt, lineHeight: 19 }}>
                  Por exigência regulatória (ANATEL no Brasil, FCC nos EUA), as operadoras só permitem mostrar seu número real nas ligações se você confirmar que ele é seu.
                </Text>
              </View>

              {/* How it works */}
              <View style={{ marginBottom: 14 }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 }}>
                  <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: '#007AFF', alignItems: 'center', justifyContent: 'center', marginRight: 10, marginTop: 1 }}>
                    <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>1</Text>
                  </View>
                  <Text style={{ flex: 1, fontSize: 13, color: txt, lineHeight: 19 }}>
                    Você recebe um SMS do Chatyy avisando que vamos verificar seu número.
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 }}>
                  <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: '#007AFF', alignItems: 'center', justifyContent: 'center', marginRight: 10, marginTop: 1 }}>
                    <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>2</Text>
                  </View>
                  <Text style={{ flex: 1, fontSize: 13, color: txt, lineHeight: 19 }}>
                    Em seguida chega um <Text style={{ fontWeight: '700' }}>código de 6 dígitos</Text> da nossa operadora parceira.
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                  <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: '#007AFF', alignItems: 'center', justifyContent: 'center', marginRight: 10, marginTop: 1 }}>
                    <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>3</Text>
                  </View>
                  <Text style={{ flex: 1, fontSize: 13, color: txt, lineHeight: 19 }}>
                    Você digita o código aqui no app — pronto, número verificado pra sempre.
                  </Text>
                </View>
              </View>

              {phone ? (
                <View style={{
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                  backgroundColor: isDark ? '#2c2c2e' : '#f2f2f7', borderRadius: 10,
                  paddingVertical: 11, paddingHorizontal: 14, marginBottom: 14, gap: 8,
                }}>
                  <Text style={{ fontSize: 18 }}>📲</Text>
                  <Text style={{ fontSize: 14, color: txt, fontWeight: '700' }}>{phone}</Text>
                </View>
              ) : null}

              {!!error && <Text style={{ color: '#ef4444', fontSize: 12, marginBottom: 10, textAlign: 'center' }}>{error}</Text>}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <TouchableOpacity
                  onPress={onClose}
                  style={{ flex: 1, height: 50, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: isDark ? '#2c2c2e' : '#f2f2f7' }}
                >
                  <Text style={{ color: txt, fontWeight: '600' }}>Agora não</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  disabled={loading}
                  onPress={handleSendSms}
                  style={{ flex: 1.4, height: 50, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#007AFF', opacity: loading ? 0.6 : 1 }}
                >
                  {loading ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>Enviar SMS</Text>}
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              <Text style={{ fontSize: 13, color: sub, lineHeight: 19, marginBottom: 14, textAlign: 'center' }}>
                Digite o código de <Text style={{ color: txt, fontWeight: '700' }}>6 dígitos</Text> que você recebeu por SMS.{'\n'}
                <Text style={{ fontSize: 11, color: sub }}>Pode demorar até 1 minuto pra chegar.</Text>
              </Text>
              <TextInput
                value={code}
                onChangeText={(v) => { setCode(v.replace(/[^0-9]/g, '').slice(0, 8)); setError(''); }}
                placeholder="123456"
                placeholderTextColor={sub}
                keyboardType="number-pad"
                autoFocus
                style={{
                  borderWidth: 1, borderColor: isDark ? '#3a3a3c' : '#d1d1d6', borderRadius: 10,
                  paddingHorizontal: 14, height: 54, fontSize: 22, color: txt,
                  backgroundColor: isDark ? '#2c2c2e' : '#f2f2f7', textAlign: 'center', letterSpacing: 4, fontWeight: '700',
                }}
              />
              {!!error && <Text style={{ color: '#ef4444', fontSize: 12, marginTop: 8, textAlign: 'center' }}>{error}</Text>}
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
                <TouchableOpacity
                  onPress={() => setStep('intro')}
                  style={{ flex: 1, height: 46, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: isDark ? '#2c2c2e' : '#f2f2f7' }}
                >
                  <Text style={{ color: txt, fontWeight: '600' }}>Voltar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  disabled={loading || code.length < 4}
                  onPress={handleConfirm}
                  style={{
                    flex: 1, height: 46, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
                    backgroundColor: code.length < 4 ? (isDark ? '#3a3a3c' : '#d1d1d6') : '#007AFF',
                    opacity: loading ? 0.6 : 1,
                  }}
                >
                  {loading ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '700' }}>Confirmar</Text>}
                </TouchableOpacity>
              </View>
            </>
          )}
          </View>
    </View>
  );
}

function DialerModal({ visible, onClose, isDark, t, minutesInfo, onCallPlaced, callerIdVerified: cidVerifiedProp, onVerified }) {
  const { startCall: ctxStartCall, endCall: ctxEndCall } = useCall();
  const { width: winWidth, height: winHeight } = require('react-native').useWindowDimensions();
  // Responsive key size: shrink keypad on narrow viewports
  const safeWidth = Math.min(winWidth - 32, 380);
  const computedKeySize = Math.max(56, Math.min(77, Math.floor((safeWidth - 48) / 3)));
  const dialerScale = computedKeySize / 77;
  // Embedded caller ID verify overlay (rendered inside this Modal so iOS doesn't refuse to show it)
  const [verifyOverlayVisible, setVerifyOverlayVisible] = useState(false);
  const [callerIdVerified, setCallerIdVerifiedLocal] = useState(!!cidVerifiedProp);
  useEffect(() => { setCallerIdVerifiedLocal(!!cidVerifiedProp); }, [cidVerifiedProp]);
  const onVerifyCallerId = () => setVerifyOverlayVisible(true);
  const [number, setNumber] = useState('');
  const [calling, setCalling] = useState(false);
  const [callResult, setCallResult] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [allContacts, setAllContacts] = useState([]);
  const [phoneContactsList, setPhoneContactsList] = useState([]);
  const [t9Suggestions, setT9Suggestions] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [activeCall, setActiveCall] = useState(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeaker, setIsSpeaker] = useState(false);
  const [showContacts, setShowContacts] = useState(false);
  const searchTimerRef = useRef(null);
  const durationRef = useRef(null);
  const durationCountRef = useRef(0);
  const nativeWebViewRef = useRef(null);

  // Allow calls if plan check hasn't loaded yet (assume allowed, server will reject if not)
  const isPaid = minutesInfo === null ? true : (minutesInfo?.minutes_limit || 0) > 0;

  // Load all contacts (server + phone) once
  useEffect(() => {
    if (visible && allContacts.length === 0) {
      // Server contacts
      searchContacts('').then(r => {
        if (r?.success && Array.isArray(r.data)) setAllContacts(r.data);
      }).catch(() => {});
      // Phone contacts
      loadPhoneContacts().then(pc => {
        if (pc && pc.length > 0) setPhoneContactsList(pc);
      }).catch(() => {});
      // Favorites from call history
      callHistoryList().then(r => {
        if (r?.success && Array.isArray(r.data?.calls)) {
          loadPhoneContacts().then(pc => {
            setFavorites(getMostCalled(r.data.calls, pc));
          });
        }
      }).catch(() => {});
    }
  }, [visible]);

  // Reset mute/speaker when call ends
  useEffect(() => {
    if (!activeCall) {
      setIsMuted(false);
      setIsSpeaker(false);
    }
  }, [activeCall]);

  // T9 predictive search + number search
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!number || number.length < 2) {
      setContacts([]);
      setT9Suggestions([]);
      return;
    }

    // T9: search local contacts by name (instant, no API call)
    const digits = number.replace(/[^0-9]/g, '');
    if (digits.length >= 2 && !number.startsWith('+')) {
      const matches = allContacts.filter(c =>
        t9Match(digits, c.name || c.display_name || '') ||
        (c.phone && c.phone.includes(digits)) ||
        (c.email && c.email.includes(digits))
      ).slice(0, 5);
      setT9Suggestions(matches);
    } else {
      setT9Suggestions([]);
    }

    // Also search server for phone number matches
    if (number.length >= 3) {
      searchTimerRef.current = setTimeout(() => {
        searchContacts(number).then(r => {
          if (r?.success && Array.isArray(r.data)) setContacts(r.data.slice(0, 3));
          else setContacts([]);
        }).catch(() => setContacts([]));
      }, 300);
    }
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [number, allContacts]);

  const appendDigit = useCallback((digit) => {
    playDTMFNative(digit);
    setNumber(prev => prev + digit);
    setCallResult(null);
  }, []);

  const deleteDigit = useCallback(() => {
    setNumber(prev => prev.slice(0, -1));
  }, []);

  // Toggle: internet (SIP) or callback (Telnyx calls your phone)
  const [callMode, setCallMode] = useState('internet'); // 'internet' | 'callback'

  const handleCallStateChange = useCallback((state) => {
    if (state === 'tick') {
      // Duration tick from native WebView
      durationCountRef.current += 1;
      setActiveCall(prev => prev ? { ...prev, duration: durationCountRef.current } : null);
      return;
    }
    if (state.startsWith('error:')) {
      console.warn('[Call] Error:', state);
      state = 'ended';
    }
    setActiveCall(prev => prev ? { ...prev, state } : null);
    if (state === 'connected') {
      durationCountRef.current = 0;
      if (Platform.OS === 'web') {
        durationRef.current = setInterval(() => {
          durationCountRef.current += 1;
          setActiveCall(prev => prev ? { ...prev, duration: durationCountRef.current } : null);
        }, 1000);
      }
      // Native: ticks come from WebView onMessage
    }
    if (state === 'ended') {
      if (durationRef.current) clearInterval(durationRef.current);
      setTimeout(() => {
        setActiveCall(null);
        durationCountRef.current = 0;
      }, 2000);
    }
  }, []);

  const handleHangup = useCallback(() => {
    // Always try SIP hangup first (works for both web and native via the unified sipCall service)
    try { hangupSipCall(); } catch {}
    if (Platform.OS === 'web') {
      try { hangupTwilioCall(); } catch {}
    } else if (nativeWebViewRef.current?.current) {
      try { nativeWebViewRef.current.current.injectJavaScript('hangup(); true;'); } catch {}
    }
    handleCallStateChange('ended');
    // Force-close the active call UI immediately even if signaling fails
    setActiveCall(null);
    setCallResult(null);
    try { ctxEndCall(); } catch {}
    try { const { setOngoingCall } = require('./OngoingCallBar'); setOngoingCall(null); } catch {}
  }, [handleCallStateChange, ctxEndCall]);

  // Mute toggle handler
  const handleToggleMute = useCallback(() => {
    const newMuted = !isMuted;
    setIsMuted(newMuted);
    if (Platform.OS === 'web') {
      if (_twilioCall) {
        try { _twilioCall.mute(newMuted); } catch (e) { console.warn('[Mute] Error:', e); }
      }
    } else if (nativeWebViewRef.current?.current) {
      nativeWebViewRef.current.current.injectJavaScript(`conn.mute(${newMuted}); true;`);
    }
  }, [isMuted]);

  // Speaker toggle handler (web only via audio output, native via InCallManager if available)
  const handleToggleSpeaker = useCallback(() => {
    const newSpeaker = !isSpeaker;
    setIsSpeaker(newSpeaker);
    // On web, toggle audio output selection is not directly available via Twilio SDK
    // On native, would use InCallManager or similar - for now just toggle state
    if (Platform.OS !== 'web' && nativeWebViewRef.current?.current) {
      // Attempt to toggle speaker via WebView
      nativeWebViewRef.current.current.injectJavaScript(
        `try { Twilio.Device.audio.speakerMode(${newSpeaker}); } catch(e) {} true;`
      );
    }
  }, [isSpeaker]);

  // DTMF send handler
  const handleSendDTMF = useCallback((digit) => {
    if (Platform.OS === 'web') {
      if (_twilioCall) {
        try { _twilioCall.sendDigits(digit); } catch (e) { console.warn('[DTMF] Error:', e); }
      }
    } else if (nativeWebViewRef.current?.current) {
      nativeWebViewRef.current.current.injectJavaScript(`conn.sendDigits('${digit}'); true;`);
    }
  }, []);

  const handleCall = useCallback(async () => {
    if (!number.trim() || calling || !isPaid) return;
    if (number.trim().length < 4) return;
    setCalling(true);
    setCallResult(null);

    let phoneNum = number.trim();
    if (!phoneNum.startsWith('+')) phoneNum = '+55' + phoneNum;

    try {
      if (callMode === 'internet') {
        // SIP mode: direct WebRTC via Telnyx (call via internet)
        setActiveCall({ number: phoneNum, contactName: '', state: 'connecting', duration: 0 });
        setCallResult({ success: true, message: t?.('calls.connecting') || 'Connecting...' });
        // Show green bar globally via CallContext
        ctxStartCall({ contactName: phoneNum, contactEmail: '', isVideo: false, isCaller: true, callType: 'sip' });
        const credRes = await voipSipCredentials();
        if (!credRes?.success) {
          setCallResult({ success: false, message: credRes?.message || (t?.('calls.credentialsFailed') || 'Failed to get credentials') });
          setActiveCall(null); ctxEndCall(); setCalling(false); return;
        }
        // Pass TURN credentials if available
        if (credRes.data?.turn) {
          const { setTurnCredentials } = require('../services/sipCall');
          setTurnCredentials(credRes.data.turn);
        }
        await startSipCall(credRes.data, phoneNum, (state) => {
          if (state === 'registered' || state === 'ringing') {
            setActiveCall(prev => prev ? { ...prev, state: 'ringing' } : null);
            setCallResult({ success: true, message: t?.('calls.ringing') || 'Ringing...' });
          } else if (state === 'connected') {
            setActiveCall(prev => prev ? { ...prev, state: 'connected' } : null);
            setCallResult({ success: true, message: t?.('calls.callStarted') || 'Call started!' });
          } else if (state === 'ended') {
            setActiveCall(null); setCallResult(null); ctxEndCall();
          } else if (state === 'tick') {
            setActiveCall(prev => prev ? { ...prev, duration: (prev.duration || 0) + 1 } : null);
          } else if (state?.startsWith?.('error:')) {
            setActiveCall(null); ctxEndCall();
            setCallResult({ success: false, message: state.replace('error:', '') });
          }
        });
      } else {
        // Callback mode: Telnyx calls your phone, then bridges to destination
        setActiveCall({ number: phoneNum, contactName: '', state: 'phone_ringing', duration: 0 });
        const r = await voipCall(phoneNum, '', true);
        if (r?.success) {
          setCallResult({ success: true, message: t?.('calls.answerPhone') || 'Answer your phone to connect the call' });
          setTimeout(() => { setActiveCall(null); setCallResult(null); }, 60000);
        } else {
          let msg = r?.message || (t?.('calls.callFailed') || 'Call failed');
          if (/limite|limit/i.test(msg)) msg = t?.('calls.minutesLimitReached') || 'Minutes limit reached';
          else if (/telefone.*perfil|cadastre/i.test(msg)) msg = t?.('calls.registerPhone') || 'Register your phone in profile';
          setCallResult({ success: false, message: msg });
          setActiveCall(null);
        }
      }
      if (onCallPlaced) onCallPlaced();
    } catch (err) {
      const errMsg = err?.message || String(err);
      console.warn('Call error:', errMsg);
      setCallResult({ success: false, message: `${t?.('common.error') || 'Error'}: ${errMsg}` });
      setActiveCall(null);
    } finally {
      setCalling(false);
    }
  }, [number, calling, isPaid, onCallPlaced, handleCallStateChange]);

  const country = detectCountry(number);
  const canCall = isPaid && number.trim().length >= 4 && !calling;

  const bgColor = isDark ? '#000000' : '#ffffff';
  const textColor = isDark ? '#ffffff' : '#000000';
  const subColor = isDark ? '#8e8e93' : '#8e8e93';

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      onRequestClose={onClose}
    >
      <View style={[s.dialerContainer, { backgroundColor: bgColor }]}>
        {/* Close button - top left, iOS style */}
        <View style={s.dialerHeader}>
          <TouchableOpacity onPress={onClose} style={s.dialerCloseBtn}>
            <Text style={{ color: BLUE, fontSize: 17 }}>{t?.('common.close') || 'Fechar'}</Text>
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          <TouchableOpacity
            onPress={() => onVerifyCallerId?.()}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 6,
              paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14,
              backgroundColor: callerIdVerified ? 'rgba(52,199,89,0.14)' : 'rgba(0,122,255,0.12)',
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: '700', color: callerIdVerified ? '#34C759' : BLUE }}>
              {callerIdVerified ? '✓ Verificado' : 'Verificar nº'}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={s.dialerBody}>
          {/* Number display area - large, centered, iPhone style */}
          <View style={s.dialerDisplay}>
            {/* Main number text */}
            <View style={s.dialerNumberContainer}>
              {country && number.length > 0 && (
                <Text style={s.dialerFlag}>{country.flag}</Text>
              )}
              <Text
                style={[s.dialerNumber, {
                  color: number ? textColor : (isDark ? '#636366' : '#c7c7cc'),
                  fontSize: number.length > 18 ? 22 : number.length > 14 ? 26 : number.length > 10 ? 30 : 36,
                }]}
                numberOfLines={1}
                adjustsFontSizeToFit
              >
                {number ? formatPhoneDisplay(number) : (t?.('calls.addNumber') || 'Adicionar numero')}
              </Text>
            </View>
            {/* Country name below number */}
            {country && number.length > 0 && (
              <Text style={[s.dialerCountry, { color: subColor }]}>{country.name}</Text>
            )}
          </View>

          {/* T9 suggestions + Contact matches */}
          {(t9Suggestions.length > 0 || contacts.length > 0) && (
            <View style={[s.dialerContacts, { backgroundColor: isDark ? '#1c1c1e' : '#f2f2f7' }]}>
              {/* T9 suggestions (local, instant) */}
              {t9Suggestions.map((c, idx) => (
                <TouchableOpacity
                  key={'t9_' + (c.email || idx)}
                  style={s.dialerContactRow}
                  onPress={() => {
                    const phone = c.phone || c.email;
                    if (phone) setNumber(phone);
                  }}
                  activeOpacity={0.6}
                >
                  <AvatarCircle name={c.name || c.display_name || c.email} email={c.email} size={32} />
                  <View style={{ flex: 1, marginLeft: 8 }}>
                    <Text style={[s.dialerContactName, { color: textColor }]} numberOfLines={1}>{c.name || c.display_name || c.email}</Text>
                    {c.phone && <Text style={{ fontSize: 12, color: isDark ? '#8e8e93' : '#636366' }}>{c.phone}</Text>}
                  </View>
                  <Text style={{ fontSize: 11, color: '#34C759', fontWeight: '600' }}>T9</Text>
                </TouchableOpacity>
              ))}
              {/* Server search results */}
              {contacts.filter(c => !t9Suggestions.find(t => t.email === c.email)).map((c, idx) => (
                <TouchableOpacity
                  key={c.email || idx}
                  style={s.dialerContactRow}
                  onPress={() => { const phone = c.phone || c.email; if (phone) setNumber(phone); }}
                  activeOpacity={0.6}
                >
                  <AvatarCircle name={c.name || c.email} email={c.email} size={32} />
                  <Text style={[s.dialerContactName, { color: textColor }]} numberOfLines={1}>{c.name || c.email}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* Call result toast */}
          {callResult && (
            <View style={[s.dialerResult, {
              backgroundColor: callResult.success ? 'rgba(52,199,89,0.12)' : 'rgba(255,59,48,0.12)',
            }]}>
              <Text style={{ color: callResult.success ? GREEN : RED, fontSize: 14, fontWeight: '600', textAlign: 'center' }}>
                {callResult.success ? (callResult.message || t?.('voip.callStarted') || 'Ligacao iniciada!') : callResult.message}
              </Text>
            </View>
          )}

          {/* Favorites + Contacts when no number typed */}
          {!number && favorites.length > 0 && (
            <View style={{ paddingHorizontal: 16, paddingVertical: 4 }}>
              <Text style={{ color: subColor, fontSize: 12, fontWeight: '600', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {t?.('calls.frequent') || 'Frequent'}
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 4 }}>
                {favorites.map((fav, idx) => (
                  <TouchableOpacity
                    key={fav.key + idx}
                    style={{ alignItems: 'center', marginRight: 16, width: 60 }}
                    onPress={() => setNumber(fav.phone.replace(/\D/g, ''))}
                    activeOpacity={0.6}
                  >
                    <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: isDark ? '#2c2c2e' : '#e5e7eb', alignItems: 'center', justifyContent: 'center', marginBottom: 4 }}>
                      <Text style={{ fontSize: 18, fontWeight: '600', color: isDark ? '#fff' : '#333' }}>{(fav.name || '?').charAt(0).toUpperCase()}</Text>
                    </View>
                    <Text style={{ fontSize: 10, color: textColor, textAlign: 'center' }} numberOfLines={1}>{fav.name}</Text>
                    <Text style={{ fontSize: 9, color: subColor }}>{fav.count}x</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}

          {/* Phone contacts button */}
          {!number && (
            <TouchableOpacity
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 8, gap: 6 }}
              onPress={() => setShowContacts(!showContacts)}
              activeOpacity={0.7}
            >
              <IconUserPlus size={16} color={BLUE} />
              <Text style={{ color: BLUE, fontSize: 14, fontWeight: '500' }}>
                {showContacts ? (t?.('calls.hideContacts') || 'Esconder contatos') : (t?.('calls.showContacts') || 'Contatos do celular')}
              </Text>
            </TouchableOpacity>
          )}

          {/* Phone contacts list */}
          {!number && showContacts && phoneContactsList.length > 0 && (
            <FlatList
              data={phoneContactsList.slice(0, 50)}
              keyExtractor={(item, idx) => item.id || String(idx)}
              style={{ maxHeight: 200, marginHorizontal: 16, borderRadius: 10, backgroundColor: isDark ? '#1c1c1e' : '#f2f2f7' }}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12, borderBottomWidth: 0.5, borderBottomColor: isDark ? '#2c2c2e' : '#e5e7eb' }}
                  onPress={() => { setNumber(item.phone.replace(/\D/g, '')); setShowContacts(false); }}
                  activeOpacity={0.6}
                >
                  <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: isDark ? '#3a3a3c' : '#d4d7dc', alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
                    <Text style={{ fontSize: 15, fontWeight: '600', color: isDark ? '#fff' : '#333' }}>{(item.name || '?').charAt(0).toUpperCase()}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, color: textColor, fontWeight: '500' }} numberOfLines={1}>{item.name}</Text>
                    <Text style={{ fontSize: 12, color: subColor }}>{item.phone}</Text>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 12 }}>
                    <TouchableOpacity onPress={() => { setNumber(item.phone.replace(/\D/g, '')); setShowContacts(false); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <IconPhone size={18} color={GREEN} />
                    </TouchableOpacity>
                  </View>
                </TouchableOpacity>
              )}
            />
          )}

          {/* Keypad - 4x3 grid, iPhone spacing */}
          <View style={[s.dialerKeypad, computedKeySize < 70 && { paddingHorizontal: 8 }]}>
            {[0, 1, 2].map(row => (
              <View key={row} style={[s.dialerKeypadRow, computedKeySize < 70 && { gap: 14, marginBottom: 10 }]}>
                {DIAL_KEYS.slice(row * 3, row * 3 + 3).map((k) => (
                  <DialKey
                    key={k.digit}
                    digit={k.digit}
                    sub={k.sub}
                    isDark={isDark}
                    size={computedKeySize}
                    onPress={() => {
                      if (k.digit === '0' && number === '') appendDigit('+');
                      else appendDigit(k.digit);
                    }}
                    onLongPress={k.digit === '0' ? () => appendDigit('+') : undefined}
                  />
                ))}
              </View>
            ))}
            {/* Last row: * 0 # */}
            <View style={[s.dialerKeypadRow, computedKeySize < 70 && { gap: 14, marginBottom: 10 }]}>
              {DIAL_KEYS.slice(9, 12).map((k) => (
                <DialKey
                  key={k.digit}
                  digit={k.digit}
                  sub={k.sub}
                  isDark={isDark}
                  size={computedKeySize}
                  onPress={() => {
                    if (k.digit === '0' && number === '') appendDigit('+');
                    else appendDigit(k.digit);
                  }}
                  onLongPress={k.digit === '0' ? () => appendDigit('+') : undefined}
                />
              ))}
            </View>
          </View>

          {/* Bottom row: [empty] [call button] [backspace] - iPhone layout */}
          <View style={s.dialerBottomRow}>
            {/* Left: Add to contacts (native) */}
            <View style={s.dialerBottomSide}>
              {number.length >= 4 && (
                <TouchableOpacity
                  style={s.dialerAddContact}
                  onPress={async () => {
                    const phoneNum = number.startsWith('+') ? number : '+55' + number;
                    try {
                      if (Platform.OS !== 'web') {
                        const Contacts = require('expo-contacts');
                        const { status } = await Contacts.requestPermissionsAsync();
                        if (status === 'granted') {
                          await Contacts.presentFormAsync(null, {
                            [Contacts.Fields.PhoneNumbers]: [{ number: phoneNum, label: 'mobile' }],
                          });
                          // Reload phone contacts after adding
                          _phoneContacts = null;
                          loadPhoneContacts().then(pc => setPhoneContactsList(pc || []));
                          return;
                        }
                      }
                      // Fallback: open native contacts app
                      const { Linking } = require('react-native');
                      Linking.openURL(`tel:${phoneNum}`);
                    } catch (e) {
                      console.warn('[AddContact] Error:', e.message);
                    }
                  }}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <IconUserPlus size={22} color={isDark ? '#8e8e93' : '#636366'} />
                </TouchableOpacity>
              )}
            </View>

            {/* Center: green call button */}
            <TouchableOpacity
              style={[s.dialerCallBtn, !canCall && { opacity: 0.35 }]}
              onPress={handleCall}
              disabled={!canCall}
              activeOpacity={0.7}
            >
              {calling ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <IconPhone size={33} color="#fff" />
              )}
            </TouchableOpacity>

            {/* Right: backspace button (only visible when number has digits) */}
            <View style={s.dialerBottomSide}>
              {number.length > 0 && (
                <TouchableOpacity
                  style={s.dialerBackspace}
                  onPress={deleteDigit}
                  onLongPress={() => setNumber('')}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  accessibilityLabel={t?.('calls.backspace') || 'Backspace'}
                  accessibilityRole="button"
                >
                  <IconBackspace size={28} color={isDark ? '#8e8e93' : '#636366'} />
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* Call mode toggle */}
          <TouchableOpacity
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 10, gap: 8 }}
            onPress={() => setCallMode(prev => prev === 'internet' ? 'callback' : 'internet')}
            activeOpacity={0.7}
          >
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: callMode === 'internet' ? '#34C759' : '#FF9500' }} />
            <Text style={{ fontSize: 13, color: isDark ? '#8e8e93' : '#636366' }}>
              {callMode === 'internet' ? (t?.('calls.callbackOff') || 'Call via internet (default)') : (t?.('calls.callbackOn') || 'Bad internet? Receive a free callback')}
            </Text>
          </TouchableOpacity>

          {/* Plan badge at very bottom */}
          <PlanBadge minutesInfo={minutesInfo} isDark={isDark} t={t} />
        </View>
      </View>

      {/* Native WebView for Twilio calls */}
      {Platform.OS !== 'web' && activeCall?.nativeToken && activeCall?.nativeTo && (
        <NativeTwilioCall
          token={activeCall.nativeToken}
          toNumber={activeCall.nativeTo}
          onStateChange={handleCallStateChange}
          onRef={(ref) => { nativeWebViewRef.current = ref; }}
        />
      )}

      {/* Active call overlay */}
      <ActiveCallScreen
        visible={!!activeCall && !activeCall?.minimized}
        number={activeCall?.number || ''}
        contactName={activeCall?.contactName || ''}
        isDark={isDark}
        t={t}
        onHangup={handleHangup}
        callState={activeCall?.state || 'connecting'}
        duration={activeCall?.duration || 0}
        isMuted={isMuted}
        onToggleMute={handleToggleMute}
        isSpeaker={isSpeaker}
        onToggleSpeaker={handleToggleSpeaker}
        onSendDTMF={handleSendDTMF}
        onMinimize={() => {
          // Mark call as minimized AND close the dialer modal so the global green bar can show
          // (Modals on iOS render above layout root, hiding the CallStatusBar)
          setActiveCall(prev => prev ? { ...prev, minimized: true } : prev);
          setDialerVisible(false);
          try {
            const { setOngoingCall } = require('./OngoingCallBar');
            setOngoingCall({
              number: activeCall?.number,
              contactName: activeCall?.contactName,
              duration: activeCall?.duration || 0,
              type: 'sip',
              onResume: () => {
                setDialerVisible(true);
                setActiveCall(prev => prev ? { ...prev, minimized: false } : prev);
              },
            });
          } catch {}
        }}
      />

      {/* Caller ID verify overlay — rendered inside the dialer Modal so iOS allows it */}
      {verifyOverlayVisible && (
        <View style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 20, zIndex: 9999,
        }}>
          <CallerIdVerifyContent
            isDark={isDark}
            t={t}
            onClose={() => setVerifyOverlayVisible(false)}
            onVerified={() => {
              setCallerIdVerifiedLocal(true);
              if (typeof onVerified === 'function') onVerified();
            }}
          />
        </View>
      )}
    </Modal>
  );
}

// ============================================================
// MAIN COMPONENT
// ============================================================
function ChatCallsTab({ colors, isDark, t, user, router }) {
  const [activeTab, setActiveTab] = useState('recent');
  const [minutesInfo, setMinutesInfo] = useState(null);
  const [loadingMinutes, setLoadingMinutes] = useState(true);
  const [voipHistory, setVoipHistory] = useState([]);
  const [chatCalls, setChatCalls] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [dialerVisible, setDialerVisible] = useState(false);
  const [infoItem, setInfoItem] = useState(null);
  const [showCallerIdModal, setShowCallerIdModal] = useState(false);
  const [callerIdVerified, setCallerIdVerified] = useState(false);

  // Load caller ID verification status on mount
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await import('../services/api').then(m => m.getProfile?.());
        if (alive && r?.success && r.data?.telnyx_caller_id_verified) setCallerIdVerified(true);
      } catch {}
    })();
    return () => { alive = false; };
  }, []);

  // Load data on mount.
  // Strategy: show cached data INSTANTLY (don't wait for network), then refresh in background.
  // Safety timeout: never stay in loading > 3 seconds even if both fetches hang.
  useEffect(() => {
    setLoadingMinutes(true);
    setLoadingHistory(true);

    let cacheHistoryDone = false;
    let cacheMinutesDone = false;

    // Show cached data instantly
    getCached('voip_minutes').then(cached => {
      cacheMinutesDone = true;
      if (cached) setMinutesInfo(cached);
      setLoadingMinutes(false);
    }).catch(() => { cacheMinutesDone = true; setLoadingMinutes(false); });

    getCached('call_history').then(cached => {
      cacheHistoryDone = true;
      if (Array.isArray(cached)) setChatCalls(cached);
      // Stop loading immediately so the empty state OR cached list shows right away
      setLoadingHistory(false);
    }).catch(() => { cacheHistoryDone = true; setLoadingHistory(false); });

    // Hard safety: max 2.5s in loading regardless of cache outcome
    const safety = setTimeout(() => {
      setLoadingHistory(false);
      setLoadingMinutes(false);
    }, 2500);

    // Fetch fresh in background — does NOT toggle loading (loading already false from cache step)
    voipMinutesRemaining().then(r => {
      if (r?.success && r.data) {
        setMinutesInfo(r.data);
        setCache('voip_minutes', r.data, 2592000000).catch(() => {});
        if (Array.isArray(r.data.history)) setVoipHistory(r.data.history);
      }
    }).catch(() => {});

    getCallHistory().then(h => {
      if (Array.isArray(h)) {
        setChatCalls(h);
        setCache('call_history', h, 2592000000).catch(() => {});
      }
    }).catch(() => {});

    return () => clearTimeout(safety);
  }, []);

  // Refresh on interval
  useEffect(() => {
    const interval = setInterval(() => {
      voipMinutesRemaining().then(r => {
        if (r?.success && r.data) {
          setMinutesInfo(r.data);
          if (Array.isArray(r.data.history)) setVoipHistory(r.data.history);
        }
      }).catch(() => {});
      getCallHistory().then(h => setChatCalls(prev => {
        if (prev.length !== h.length || (prev.length > 0 && h.length > 0 && prev[0].id !== h[0].id)) return h;
        return prev;
      })).catch(() => {});
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  const refreshData = useCallback(() => {
    voipMinutesRemaining().then(r => {
      if (r?.success && r.data) {
        setMinutesInfo(r.data);
        if (Array.isArray(r.data.history)) setVoipHistory(r.data.history);
      }
    }).catch(() => {});
    getCallHistory().then(h => setChatCalls(h)).catch(() => {});
  }, []);

  const handleHistoryPress = useCallback((item) => {
    if (item.to_number) {
      // Open dialer with number pre-filled? For now just open dialer
      setDialerVisible(true);
    } else if (item.contactEmail && router) {
      router.push({
        pathname: '/chat-conversation',
        params: {
          recipientEmail: item.contactEmail,
          recipientName: item.contactName || item.contact_name,
          startCall: item.video ? 'video' : 'audio',
        },
      });
    }
  }, [router]);

  const handleClearAll = useCallback(() => {
    const doIt = async () => {
      try {
        await callHistoryClear();
        setChatCalls([]);
      } catch {}
    };
    if (Platform.OS === 'web') {
      if (confirm(t?.('calls.clearConfirm') || 'Limpar todo o historico de ligacoes?')) doIt();
    } else {
      Alert.alert(
        t?.('calls.clearHistory') || 'Limpar Historico',
        t?.('calls.clearConfirm') || 'Limpar todo o historico de ligacoes?',
        [
          { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
          { text: t?.('calls.clearAll') || 'Limpar Tudo', style: 'destructive', onPress: doIt },
        ]
      );
    }
  }, [t]);

  // Merge and filter history
  const allHistory = useMemo(() => {
    const merged = [];
    for (const v of voipHistory) {
      merged.push({
        id: `voip_${v.id}`,
        type: v.status === 'completed' ? 'outgoing' : (v.status === 'failed' ? 'missed' : 'outgoing'),
        contactName: v.contact_name || '',
        contactEmail: '',
        to_number: v.to_number,
        duration: v.duration_seconds || 0,
        timestamp: v.created_at,
        video: false,
        source: 'voip',
      });
    }
    for (const c of chatCalls) {
      merged.push({
        id: `chat_${c.id}`,
        type: c.type || 'outgoing',
        contactName: c.contactName || c.contact_name || '',
        contactEmail: c.contactEmail || c.contact_email || '',
        to_number: '',
        duration: c.duration || 0,
        timestamp: c.timestamp || c.created_at,
        video: !!c.video,
        source: 'chat',
      });
    }
    merged.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return merged;
  }, [voipHistory, chatCalls]);

  const filteredHistory = useMemo(() => {
    switch (activeTab) {
      case 'chatyy': return allHistory.filter(h => h.source === 'chat');
      case 'phone': return allHistory.filter(h => h.source === 'voip');
      default: return allHistory;
    }
  }, [allHistory, activeTab]);

  // Group calls by date
  const groupedCalls = useMemo(() => {
    const groups = [];
    let currentGroup = null;
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    for (const call of filteredHistory) {
      const d = new Date(call.timestamp);
      let groupLabel;
      if (d.toDateString() === today.toDateString()) {
        groupLabel = t?.('calls.today') || 'Hoje';
      } else if (d.toDateString() === yesterday.toDateString()) {
        groupLabel = t?.('calls.yesterday') || 'Ontem';
      } else {
        const diffDays = Math.floor((today - d) / (1000 * 60 * 60 * 24));
        if (diffDays < 7) {
          groupLabel = t?.('calls.thisWeek') || 'Esta Semana';
        } else {
          groupLabel = t?.('calls.earlier') || 'Anteriores';
        }
      }

      if (!currentGroup || currentGroup.label !== groupLabel) {
        currentGroup = { label: groupLabel, data: [] };
        groups.push(currentGroup);
      }
      currentGroup.data.push(call);
    }
    return groups;
  }, [filteredHistory, t]);

  const bgColor = isDark ? '#000000' : '#f2f2f7';
  const textColor = isDark ? '#ffffff' : '#000000';
  const subColor = isDark ? '#8e8e93' : '#6c6c70';
  const cardBg = isDark ? '#1c1c1e' : '#ffffff';
  // Only block render on history loading. Minutes (Telnyx PSTN balance) loads independently
  // and shouldn't delay showing the chat call history.
  const isLoading = loadingHistory;

  return (
    <View style={[s.container, { backgroundColor: bgColor }]}>
      {/* Header with tabs */}
      <View style={[s.header, { backgroundColor: isDark ? '#000000' : '#f2f2f7' }]}>
        <View style={s.headerTop}>
          {filteredHistory.length > 0 && (
            <TouchableOpacity
              onPress={handleClearAll}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={s.editBtn}
            >
              <Text style={{ color: BLUE, fontSize: 15 }}>
                {t?.('calls.clearAll') || 'Limpar'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
        <SegmentTabs
          activeTab={activeTab}
          onTabChange={setActiveTab}
          isDark={isDark}
          t={t}
        />
      </View>

      {/* Plan status */}
      {!loadingMinutes && (
        <PlanBadge minutesInfo={minutesInfo} isDark={isDark} t={t} />
      )}

      {/* Call history */}
      <ScrollView
        style={s.scrollView}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {isLoading ? (
          <LoadingSkeleton isDark={isDark} />
        ) : filteredHistory.length === 0 ? (
          <View style={s.emptyState}>
            <View style={[s.emptyCircle, { backgroundColor: isDark ? '#1c1c1e' : '#e5e7eb' }]}>
              <IconPhone size={32} color={subColor} />
            </View>
            <Text style={[s.emptyTitle, { color: textColor }]}>
              {t?.('calls.noCallsTitle') || 'Nenhuma ligacao recente'}
            </Text>
            <Text style={[s.emptySubtitle, { color: subColor }]}>
              {t?.('calls.noCallsSubtitle') || 'Seu historico de ligacoes aparecera aqui'}
            </Text>
          </View>
        ) : (
          groupedCalls.map((group, gIdx) => (
            <View key={group.label + gIdx}>
              {/* Section header */}
              <Text style={[s.sectionHeader, { color: subColor }]}>
                {group.label}
              </Text>
              {/* Cards */}
              <View style={[s.sectionCard, { backgroundColor: cardBg }]}>
                {group.data.map((item, idx) => (
                  <React.Fragment key={item.id || idx}>
                    {idx > 0 && (
                      <View style={[s.separator, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }]} />
                    )}
                    <CallHistoryRow
                      item={item}
                      isDark={isDark}
                      t={t}
                      onPress={handleHistoryPress}
                      onInfoPress={setInfoItem}
                    />
                  </React.Fragment>
                ))}
              </View>
            </View>
          ))
        )}
        <View style={{ height: 100 }} />
      </ScrollView>

      {/* FAB - Dialer button */}
      <TouchableOpacity
        style={s.fab}
        onPress={() => setDialerVisible(true)}
        activeOpacity={0.8}
        accessibilityLabel={t?.('calls.dialer') || 'Teclado'}
        accessibilityRole="button"
      >
        <Svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <Path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
        </Svg>
      </TouchableOpacity>

      {/* Dialer modal */}
      <DialerModal
        visible={dialerVisible}
        onClose={() => setDialerVisible(false)}
        isDark={isDark}
        t={t}
        minutesInfo={minutesInfo}
        onCallPlaced={refreshData}
        callerIdVerified={callerIdVerified}
        onVerified={() => setCallerIdVerified(true)}
      />

      {/* Call info modal */}
      <CallInfoModal
        item={infoItem}
        visible={!!infoItem}
        onClose={() => setInfoItem(null)}
        isDark={isDark}
        t={t}
        onCallAgain={handleHistoryPress}
      />
    </View>
  );
}

// ============================================================
// STYLES
// ============================================================
const s = StyleSheet.create({
  container: {
    flex: 1,
  },

  // Header
  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginBottom: 8,
    minHeight: 24,
  },
  editBtn: {
    paddingVertical: 4,
  },

  // Segment tabs
  segmentContainer: {
    flexDirection: 'row',
    borderRadius: 8,
    padding: 2,
  },
  segmentTab: {
    flex: 1,
    paddingVertical: 7,
    alignItems: 'center',
    borderRadius: 6,
  },
  segmentTabActive: {
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
    } : Platform.OS === 'ios' ? {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.12,
      shadowRadius: 3,
    } : { elevation: 2 }),
  },
  segmentLabel: {
    fontSize: 13,
    fontWeight: '500',
  },

  // Plan badge
  planBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  planBadgeText: {
    fontSize: 13,
    fontWeight: '500',
  },

  // Scroll
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 20,
  },

  // Section headers
  sectionHeader: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 32,
    paddingTop: 20,
    paddingBottom: 6,
  },
  sectionCard: {
    marginHorizontal: 16,
    borderRadius: 12,
    overflow: 'hidden',
  },

  // History rows
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    minHeight: 64,
  },
  historyLeft: {
    marginRight: 12,
  },
  historyAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  historyMiddle: {
    flex: 1,
    justifyContent: 'center',
    marginRight: 8,
  },
  historyName: {
    fontSize: 16,
    fontWeight: '400',
    flex: 1,
  },
  historyType: {
    fontSize: 13,
    fontWeight: '400',
  },
  historyRight: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  historyTime: {
    fontSize: 13,
    fontWeight: '400',
  },
  infoBtn: {
    padding: 4,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 72,
  },

  // Empty state
  emptyState: {
    alignItems: 'center',
    paddingTop: 80,
    paddingHorizontal: 32,
  },
  emptyCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 6,
  },
  emptySubtitle: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 20,
  },

  // FAB
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: GREEN,
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 4px 16px rgba(52,199,89,0.4)',
    } : Platform.OS === 'ios' ? {
      shadowColor: GREEN,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.4,
      shadowRadius: 12,
    } : { elevation: 8 }),
  },

  // Dialer modal - iPhone Phone app style
  dialerContainer: {
    flex: 1,
    ...(Platform.OS === 'web' ? { paddingTop: 0 } : { paddingTop: 50 }),
  },
  dialerHeader: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  dialerCloseBtn: {
    paddingVertical: 6,
  },
  dialerBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: Platform.OS === 'web' ? 32 : 48,
    maxWidth: MAX_DIALER_WIDTH,
    alignSelf: 'center',
    width: '100%',
  },
  dialerDisplay: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    alignItems: 'center',
    minHeight: 70,
    width: '100%',
    justifyContent: 'center',
  },
  dialerNumberContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    minHeight: 44,
  },
  dialerFlag: {
    fontSize: 24,
  },
  dialerNumber: {
    fontWeight: '200',
    letterSpacing: 2,
    textAlign: 'center',
  },
  dialerCountry: {
    fontSize: 12,
    fontWeight: '500',
    marginTop: 2,
    letterSpacing: 0.5,
  },
  dialerContacts: {
    marginHorizontal: 24,
    borderRadius: 10,
    overflow: 'hidden',
    marginBottom: 8,
    width: '100%',
    paddingHorizontal: 24,
  },
  dialerContactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 10,
  },
  dialerContactName: {
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
  },
  dialerResult: {
    marginHorizontal: 24,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 8,
    width: '100%',
  },
  dialerKeypad: {
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 4,
    width: '100%',
  },
  dialerKeypadRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 24,
    marginBottom: 14,
  },
  dialerBottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    paddingHorizontal: 20,
    marginTop: 10,
    marginBottom: 12,
  },
  dialerBottomSide: {
    width: DIAL_KEY_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialerBackspace: {
    padding: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialerAddContact: {
    padding: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialerCallBtn: {
    width: DIAL_KEY_SIZE,
    height: DIAL_KEY_SIZE,
    borderRadius: DIAL_KEY_SIZE / 2,
    backgroundColor: GREEN,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 24,
  },

  // Dial key - iPhone circular buttons
  dialKey: {
    width: DIAL_KEY_SIZE,
    height: DIAL_KEY_SIZE,
    borderRadius: DIAL_KEY_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialKeyDigit: {
    fontSize: 32,
    fontWeight: '300',
    lineHeight: 38,
  },
  dialKeySub: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1.5,
    marginTop: 0,
    opacity: 0.85,
  },

  // Chatyy badge
  chatyyBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },

  // Call info modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: Platform.OS === 'web' ? 24 : 40,
    maxHeight: '80%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.1)',
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  modalContactSection: {
    alignItems: 'center',
    paddingVertical: 24,
    gap: 8,
  },
  modalAvatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalContactName: {
    fontSize: 22,
    fontWeight: '600',
  },
  modalContactSub: {
    fontSize: 15,
  },
  modalDetails: {
    marginHorizontal: 16,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  modalDetailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  modalDetailSep: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 16,
  },
  modalDetailLabel: {
    fontSize: 15,
  },
  modalDetailValue: {
    fontSize: 15,
  },
  callAgainBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 20,
    backgroundColor: GREEN,
    borderRadius: 12,
    paddingVertical: 14,
  },
  callAgainText: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '600',
  },
});

export default memo(ChatCallsTab);
