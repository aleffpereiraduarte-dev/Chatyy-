import React, { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Platform, Animated, Alert, ActivityIndicator, Vibration, Dimensions } from 'react-native';
import Svg, { Path, Polyline, Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import AvatarCircle from './AvatarCircle';
import { IconPhone, IconVideo, IconInfo, IconX, IconPhoneOff } from './Icons';
import { callHistoryList, callHistoryAdd, callHistoryDelete, callHistoryClear, voipCall, voipMinutesRemaining, voipUpdateDuration, searchContacts } from '../services/api';

const GREEN = '#25D366';
const GREEN_DARK = '#1DA851';
const RED = '#FF3B30';
const SCREEN_WIDTH = Dimensions.get('window').width;

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
  // Try 3-digit, 2-digit, 1-digit codes
  for (const len of [3, 2, 1]) {
    const code = digits.slice(0, len);
    if (COUNTRY_FLAGS[code]) return COUNTRY_FLAGS[code];
  }
  return null;
}

// Format phone number for display
function formatPhoneDisplay(number) {
  if (!number) return '';
  if (!number.startsWith('+')) return number;
  const digits = number.slice(1);
  // Brazilian format: +55 (XX) XXXXX-XXXX
  if (digits.startsWith('55') && digits.length >= 12) {
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);
    if (rest.length === 9) {
      return `+55 (${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}`;
    }
    if (rest.length === 8) {
      return `+55 (${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
    }
  }
  // US format: +1 (XXX) XXX-XXXX
  if (digits.startsWith('1') && digits.length === 11) {
    const area = digits.slice(1, 4);
    return `+1 (${area}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  // Generic: +XX XXXX XXXX
  return number;
}

// --- Inline SVG icons ---
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

// --- Server API helpers ---
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

// --- Formatting helpers ---
function formatCallTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 0) return timeStr;
  if (diffDays === 1) return `Ontem, ${timeStr}`;
  if (diffDays < 7) {
    return date.toLocaleDateString(undefined, { weekday: 'short' }) + `, ${timeStr}`;
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + `, ${timeStr}`;
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s < 10 ? '0' : ''}${s}s`;
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

function relativeTime(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

// --- Dial pad key data ---
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

// --- Animated dial key button ---
const DialKey = memo(function DialKey({ digit, sub, onPress, onLongPress, isDark }) {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = useCallback(() => {
    Animated.spring(scaleAnim, {
      toValue: 0.9,
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

  const keyBg = isDark ? '#1c1c1e' : '#e8e8ed';
  const keyColor = isDark ? '#ffffff' : '#000000';
  const subColor = isDark ? '#8e8e93' : '#6c6c70';

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity
        style={[s.dialKey, { backgroundColor: keyBg }]}
        onPress={onPress}
        onLongPress={onLongPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        activeOpacity={1}
        accessibilityLabel={digit}
        accessibilityRole="button"
      >
        <Text style={[s.dialKeyDigit, { color: keyColor }]}>{digit}</Text>
        {sub ? <Text style={[s.dialKeySub, { color: subColor }]}>{sub}</Text> : <View style={{ height: 12 }} />}
      </TouchableOpacity>
    </Animated.View>
  );
});

// --- Call history row ---
const CallHistoryRow = memo(function CallHistoryRow({ item, isDark, colors, t, onPress }) {
  const isMissed = item.type === 'missed';
  const nameColor = isMissed ? RED : (isDark ? '#ffffff' : '#000000');
  const subColor = isDark ? '#8e8e93' : '#8e8e93';
  const label = getCallLabel(item.type, t);
  const durationStr = formatDuration(item.duration);
  const country = detectCountry(item.to_number || item.contactEmail);

  return (
    <TouchableOpacity
      style={s.historyRow}
      onPress={() => onPress(item)}
      activeOpacity={0.6}
    >
      <View style={s.historyLeft}>
        {item.contactName || item.contactEmail ? (
          <AvatarCircle
            name={item.contactName || item.contactEmail || item.to_number || '?'}
            email={item.contactEmail}
            size={40}
          />
        ) : (
          <View style={[s.historyAvatar, { backgroundColor: isDark ? '#1c1c1e' : '#e8e8ed' }]}>
            {country ? (
              <Text style={{ fontSize: 18 }}>{country.flag}</Text>
            ) : (
              <IconPhone size={18} color={subColor} />
            )}
          </View>
        )}
      </View>
      <View style={s.historyMiddle}>
        <Text style={[s.historyName, { color: nameColor }]} numberOfLines={1}>
          {item.contactName || item.contact_name || item.to_number || item.contactEmail || '?'}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          {isMissed ? (
            <IconMissedCall size={11} color={RED} />
          ) : item.type === 'outgoing' ? (
            <ArrowOutgoing size={11} color={GREEN} />
          ) : (
            <ArrowIncoming size={11} color={GREEN} />
          )}
          <Text style={[s.historyType, { color: subColor }]}>
            {label}{durationStr ? ` \u00B7 ${durationStr}` : ''}
          </Text>
          {country && <Text style={{ fontSize: 11 }}>{country.flag}</Text>}
        </View>
      </View>
      <View style={s.historyRight}>
        <Text style={[s.historyTime, { color: isMissed ? RED : subColor }]}>
          {relativeTime(item.timestamp || item.created_at)}
        </Text>
        <TouchableOpacity
          style={[s.historyCallBtn, { backgroundColor: isDark ? 'rgba(37,211,102,0.1)' : 'rgba(37,211,102,0.06)' }]}
          onPress={() => onPress(item)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          {item.video ? <IconVideo size={14} color={GREEN} /> : <IconPhone size={14} color={GREEN} />}
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
});

// --- Contact match row ---
function ContactMatch({ contact, onPress, isDark }) {
  const subColor = isDark ? '#8e8e93' : '#8e8e93';
  return (
    <TouchableOpacity
      style={s.contactMatch}
      onPress={() => onPress(contact)}
      activeOpacity={0.6}
    >
      <AvatarCircle name={contact.name || contact.email} email={contact.email} size={36} />
      <View style={{ flex: 1, marginLeft: 10 }}>
        <Text style={[s.contactMatchName, { color: isDark ? '#fff' : '#000' }]} numberOfLines={1}>
          {contact.name || contact.email}
        </Text>
        {contact.email && (
          <Text style={[s.contactMatchEmail, { color: subColor }]} numberOfLines={1}>
            {contact.email}
          </Text>
        )}
      </View>
    </TouchableOpacity>
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

  const opacity = shimmer.interpolate({ inputRange: [0, 1], outputRange: [0.3, 0.7] });
  const bg = isDark ? '#1c1c1e' : '#e5e7eb';

  return (
    <View style={{ paddingTop: 20, paddingHorizontal: 16 }}>
      {[0, 1, 2].map((i) => (
        <Animated.View key={i} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 14, opacity }}>
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: bg }} />
          <View style={{ flex: 1, gap: 8 }}>
            <View style={{ height: 14, borderRadius: 7, backgroundColor: bg, width: '60%' }} />
            <View style={{ height: 10, borderRadius: 5, backgroundColor: bg, width: '40%' }} />
          </View>
        </Animated.View>
      ))}
    </View>
  );
}

// --- Minutes progress ring ---
function MinutesBadge({ minutesInfo, isDark, t }) {
  if (!minutesInfo) return null;
  const used = minutesInfo.minutes_used || 0;
  const limit = minutesInfo.minutes_limit || 0;
  const remaining = Math.max(0, limit - used);
  const pct = limit > 0 ? Math.min(1, used / limit) : 0;
  const isLow = remaining < 10 && limit > 0;

  return (
    <View style={[s.minutesBadge, { backgroundColor: isDark ? '#1c1c1e' : '#f2f2f7' }]}>
      <View style={s.minutesBarContainer}>
        <View style={[s.minutesBarBg, { backgroundColor: isDark ? '#2c2c2e' : '#e5e5ea' }]}>
          <View style={[s.minutesBarFill, {
            width: `${pct * 100}%`,
            backgroundColor: isLow ? RED : GREEN,
          }]} />
        </View>
      </View>
      <Text style={[s.minutesText, { color: isLow ? RED : (isDark ? '#8e8e93' : '#6c6c70') }]}>
        {remaining} {t?.('voip.minutesRemaining') || 'min restantes'}
      </Text>
    </View>
  );
}

// --- Main Component ---
function ChatCallsTab({ colors, isDark, t, user, router }) {
  const [number, setNumber] = useState('');
  const [calling, setCalling] = useState(false);
  const [callResult, setCallResult] = useState(null);
  const [minutesInfo, setMinutesInfo] = useState(null);
  const [loadingMinutes, setLoadingMinutes] = useState(true);
  const [contacts, setContacts] = useState([]);
  const [voipHistory, setVoipHistory] = useState([]);
  const [chatCalls, setChatCalls] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

  // Load minutes and history on mount
  useEffect(() => {
    setLoadingMinutes(true);
    setLoadingHistory(true);

    voipMinutesRemaining().then(r => {
      if (r?.success && r.data) {
        setMinutesInfo(r.data);
        if (Array.isArray(r.data.history)) {
          setVoipHistory(r.data.history);
        }
      }
    }).catch(() => {}).finally(() => setLoadingMinutes(false));

    getCallHistory().then(h => {
      setChatCalls(h);
    }).catch(() => {}).finally(() => setLoadingHistory(false));
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

  // Contact search as user types
  const searchTimerRef = useRef(null);
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (number.length < 2) {
      setContacts([]);
      return;
    }
    searchTimerRef.current = setTimeout(() => {
      searchContacts(number).then(r => {
        if (r?.success && Array.isArray(r.data)) {
          setContacts(r.data.slice(0, 5));
        } else {
          setContacts([]);
        }
      }).catch(() => setContacts([]));
    }, 300);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [number]);

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
        // Refresh minutes
        voipMinutesRemaining().then(r2 => {
          if (r2?.success && r2.data) {
            setMinutesInfo(r2.data);
            if (Array.isArray(r2.data.history)) setVoipHistory(r2.data.history);
          }
        }).catch(() => {});
        setNumber('');
      } else {
        setCallResult({ success: false, message: r?.message || t?.('voip.callFailed') || 'Falha na ligacao' });
      }
    } catch (err) {
      setCallResult({ success: false, message: err.message || 'Erro de rede' });
    } finally {
      setCalling(false);
    }
  }, [number, calling, t]);

  const handleContactCall = useCallback((contact) => {
    if (router) {
      router.push({
        pathname: '/chat-conversation',
        params: {
          recipientEmail: contact.contactEmail || contact.email,
          recipientName: contact.contactName || contact.contact_name || contact.name,
          startCall: 'audio',
        },
      });
    }
  }, [router]);

  const handleHistoryPress = useCallback((item) => {
    if (item.to_number) {
      setNumber(item.to_number);
    } else if (item.contactEmail) {
      handleContactCall(item);
    }
  }, [handleContactCall]);

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

  const country = detectCountry(number);
  const isPaid = (minutesInfo?.minutes_limit || 0) > 0;
  const canCall = isPaid && number.trim().length >= 4 && !calling;

  // Merge VoIP history and chat call history
  const allHistory = useMemo(() => {
    const merged = [];
    // VoIP calls
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
    // Chat calls
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
    // Sort by timestamp descending
    merged.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return merged.slice(0, 50);
  }, [voipHistory, chatCalls]);

  const bgColor = isDark ? '#000000' : '#ffffff';
  const cardBg = isDark ? '#1c1c1e' : '#f2f2f7';
  const textColor = isDark ? '#ffffff' : '#000000';
  const subColor = isDark ? '#8e8e93' : '#8e8e93';

  return (
    <View style={[s.container, { backgroundColor: bgColor }]}>
      <ScrollView
        style={s.scrollView}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Banner */}
        <View style={[s.banner, { backgroundColor: isDark ? '#0a1f0a' : '#ecfdf5' }]}>
          <View style={s.bannerIcon}>
            <Text style={{ fontSize: 24 }}>{'\u{1F30D}'}</Text>
          </View>
          <Text style={[s.bannerText, { color: isDark ? '#86efac' : '#166534' }]}>
            {t?.('voip.banner') || 'Seu contato ainda nao tem Chatyy? Sem problema! Faca chamadas ilimitadas para qualquer lugar do mundo.'}
          </Text>
        </View>

        {/* Number display */}
        <View style={s.displaySection}>
          <View style={s.displayRow}>
            {country && (
              <Text style={s.displayFlag}>{country.flag}</Text>
            )}
            <Text
              style={[s.displayNumber, {
                color: number ? textColor : subColor,
                fontSize: number.length > 15 ? 24 : number.length > 10 ? 28 : 34,
              }]}
              numberOfLines={1}
              adjustsFontSizeToFit
            >
              {number ? formatPhoneDisplay(number) : (t?.('voip.enterNumber') || 'Digite o numero')}
            </Text>
            {number.length > 0 && (
              <TouchableOpacity
                style={s.backspaceBtn}
                onPress={deleteDigit}
                onLongPress={() => setNumber('')}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                accessibilityLabel="Backspace"
                accessibilityRole="button"
              >
                <IconBackspace size={22} color={subColor} />
              </TouchableOpacity>
            )}
          </View>
          {country && (
            <Text style={[s.countryLabel, { color: subColor }]}>{country.name}</Text>
          )}
        </View>

        {/* Contact matches */}
        {contacts.length > 0 && (
          <View style={[s.contactsSection, { backgroundColor: cardBg }]}>
            {contacts.map((c, idx) => (
              <ContactMatch
                key={c.email || idx}
                contact={c}
                onPress={handleContactCall}
                isDark={isDark}
              />
            ))}
          </View>
        )}

        {/* Call result notification */}
        {callResult && (
          <View style={[s.resultBanner, {
            backgroundColor: callResult.success ? 'rgba(37,211,102,0.1)' : 'rgba(255,59,48,0.1)',
            borderColor: callResult.success ? 'rgba(37,211,102,0.2)' : 'rgba(255,59,48,0.2)',
          }]}>
            <Text style={{ color: callResult.success ? GREEN : RED, fontSize: 14, fontWeight: '600', textAlign: 'center' }}>
              {callResult.success ? (t?.('voip.callStarted') || 'Ligacao iniciada!') : callResult.message}
            </Text>
          </View>
        )}

        {/* Dial pad */}
        <View style={s.keypad}>
          {DIAL_KEYS.map((k) => (
            <DialKey
              key={k.digit}
              digit={k.digit}
              sub={k.sub}
              isDark={isDark}
              onPress={() => {
                if (k.digit === '0' && number === '') {
                  appendDigit('+');
                } else {
                  appendDigit(k.digit);
                }
              }}
              onLongPress={k.digit === '0' ? () => appendDigit('+') : undefined}
            />
          ))}
        </View>

        {/* Action row: call button */}
        <View style={s.actionRow}>
          <View style={{ width: 64 }} />
          <TouchableOpacity
            style={[s.callButton, !canCall && { opacity: 0.35 }]}
            onPress={handleCall}
            disabled={!canCall}
            activeOpacity={0.7}
            accessibilityLabel={t?.('voip.title') || 'Ligar'}
            accessibilityRole="button"
          >
            {calling ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <IconPhone size={30} color="#fff" />
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={s.backspaceBtnAction}
            onPress={deleteDigit}
            onLongPress={() => setNumber('')}
            disabled={!number}
            accessibilityLabel="Apagar"
            accessibilityRole="button"
          >
            {number ? <IconBackspace size={24} color={subColor} /> : <View style={{ width: 24 }} />}
          </TouchableOpacity>
        </View>

        {/* Minutes remaining badge */}
        {loadingMinutes ? (
          <View style={{ alignItems: 'center', paddingVertical: 12 }}>
            <ActivityIndicator size="small" color={GREEN} />
          </View>
        ) : (
          <MinutesBadge minutesInfo={minutesInfo} isDark={isDark} t={t} />
        )}

        {/* Call history section */}
        <View style={s.historySection}>
          <View style={s.historyHeader}>
            <Text style={[s.historyHeaderText, { color: textColor }]}>
              {t?.('calls.recent') || 'Recentes'}
            </Text>
            {allHistory.length > 0 && (
              <TouchableOpacity onPress={handleClearAll} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={{ color: RED, fontSize: 12, fontWeight: '600' }}>
                  {t?.('calls.clearAll') || 'Limpar Tudo'}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {loadingHistory ? (
            <LoadingSkeleton isDark={isDark} />
          ) : allHistory.length === 0 ? (
            <View style={s.emptyHistory}>
              <View style={[s.emptyHistoryCircle, { backgroundColor: isDark ? '#1c1c1e' : '#f2f2f7' }]}>
                <IconPhone size={28} color={subColor} />
              </View>
              <Text style={[s.emptyHistoryTitle, { color: textColor }]}>
                {t?.('calls.noCallsTitle') || 'Nenhuma ligacao recente'}
              </Text>
              <Text style={[s.emptyHistorySubtitle, { color: subColor }]}>
                {t?.('calls.noCallsSubtitle') || 'Seu historico de ligacoes aparecera aqui'}
              </Text>
            </View>
          ) : (
            <View style={[s.historyList, { backgroundColor: cardBg }]}>
              {allHistory.map((item, idx) => (
                <React.Fragment key={item.id || idx}>
                  {idx > 0 && (
                    <View style={[s.historySeparator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]} />
                  )}
                  <CallHistoryRow
                    item={item}
                    isDark={isDark}
                    colors={colors}
                    t={t}
                    onPress={handleHistoryPress}
                  />
                </React.Fragment>
              ))}
            </View>
          )}
        </View>

        {/* Bottom padding */}
        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

// --- Styles ---
const s = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 20,
  },

  // Banner
  banner: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    borderRadius: 14,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  bannerIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
    lineHeight: 18,
  },

  // Number display
  displaySection: {
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 4,
    alignItems: 'center',
    minHeight: 70,
  },
  displayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
  },
  displayFlag: {
    fontSize: 28,
  },
  displayNumber: {
    fontWeight: '300',
    letterSpacing: 1.5,
    textAlign: 'center',
    flex: 1,
  },
  backspaceBtn: {
    padding: 8,
  },
  countryLabel: {
    fontSize: 12,
    fontWeight: '500',
    marginTop: 4,
    letterSpacing: 0.5,
  },

  // Contact matches
  contactsSection: {
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 12,
    overflow: 'hidden',
  },
  contactMatch: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  contactMatchName: {
    fontSize: 14,
    fontWeight: '600',
  },
  contactMatchEmail: {
    fontSize: 12,
    marginTop: 1,
  },

  // Result
  resultBanner: {
    marginHorizontal: 20,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginTop: 8,
    borderWidth: 1,
  },

  // Keypad
  keypad: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    paddingHorizontal: 36,
    gap: 14,
    paddingTop: 16,
    paddingBottom: 8,
  },
  dialKey: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialKeyDigit: {
    fontSize: 30,
    fontWeight: '400',
    lineHeight: 34,
  },
  dialKeySub: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 2,
    marginTop: 1,
  },

  // Action row
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 32,
    marginTop: 12,
    paddingBottom: 8,
  },
  callButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: GREEN,
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 4px 20px rgba(37,211,102,0.4)',
    } : Platform.OS === 'ios' ? {
      shadowColor: GREEN,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.4,
      shadowRadius: 12,
    } : { elevation: 8 }),
  },
  backspaceBtnAction: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Minutes badge
  minutesBadge: {
    marginHorizontal: 40,
    marginTop: 8,
    borderRadius: 10,
    padding: 10,
    alignItems: 'center',
  },
  minutesBarContainer: {
    width: '100%',
    marginBottom: 6,
  },
  minutesBarBg: {
    width: '100%',
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  minutesBarFill: {
    height: '100%',
    borderRadius: 2,
  },
  minutesText: {
    fontSize: 12,
    fontWeight: '500',
  },

  // History section
  historySection: {
    marginTop: 24,
    paddingHorizontal: 16,
  },
  historyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  historyHeaderText: {
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  historyList: {
    borderRadius: 14,
    overflow: 'hidden',
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: 14,
  },
  historyLeft: {
    marginRight: 12,
  },
  historyAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  historyMiddle: {
    flex: 1,
    justifyContent: 'center',
    marginRight: 8,
  },
  historyName: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  historyType: {
    fontSize: 12,
    fontWeight: '400',
  },
  historyRight: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 4,
  },
  historyTime: {
    fontSize: 11,
    fontWeight: '400',
  },
  historyCallBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  historySeparator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 66,
  },

  // Empty history
  emptyHistory: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  emptyHistoryCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  emptyHistoryTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  emptyHistorySubtitle: {
    fontSize: 13,
    textAlign: 'center',
  },
});

export default memo(ChatCallsTab);
