import React, { useState, useEffect, useCallback, memo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Path, Polyline } from 'react-native-svg';
import AvatarCircle from './AvatarCircle';
import { IconPhone, IconVideo, IconInfo } from './Icons';

const STORAGE_KEY = '@onemundo_call_history';
const MAX_HISTORY = 200;
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

// --- AsyncStorage helpers ---

export async function getCallHistory() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function addCallToHistory(callData) {
  try {
    const history = await getCallHistory();
    const entry = {
      id: callData.callId || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      contactEmail: callData.contactEmail || '',
      contactName: callData.contactName || callData.contactEmail || '',
      callId: callData.callId || '',
      type: callData.type || 'outgoing', // 'outgoing' | 'incoming' | 'missed'
      video: !!callData.video,
      timestamp: callData.timestamp || Date.now(),
      duration: callData.duration || 0,
    };
    history.unshift(entry);
    if (history.length > MAX_HISTORY) {
      history.length = MAX_HISTORY;
    }
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    return entry;
  } catch {
    return null;
  }
}

// --- Formatting helpers ---

function formatCallTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (diffDays === 0) {
    return timeStr;
  }
  if (diffDays === 1) {
    return `Yesterday, ${timeStr}`;
  }
  if (diffDays < 7) {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return `${days[date.getDay()]}, ${timeStr}`;
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + `, ${timeStr}`;
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
    // If t() returns the key itself (no translation), fall back to English
    if (translated && translated !== keys[type]) return translated;
  }
  switch (type) {
    case 'outgoing': return 'Outgoing';
    case 'incoming': return 'Incoming';
    case 'missed': return 'Missed';
    default: return type;
  }
}

// --- Call row component ---

const CallRow = memo(function CallRow({ item, colors, isDark, t, onPress, onInfoPress }) {
  const isMissed = item.type === 'missed';
  const isOutgoing = item.type === 'outgoing';
  const arrowColor = isMissed ? RED : GREEN;
  const nameColor = isMissed ? RED : colors.text;
  const subtextColor = colors.textSecondary || (isDark ? '#8e8e93' : '#8e8e93');
  const durationStr = formatDuration(item.duration);
  const label = getCallLabel(item.type, t);

  return (
    <TouchableOpacity
      style={[styles.row, { borderBottomColor: isDark ? '#2c2c2e' : '#e5e5ea' }]}
      activeOpacity={0.6}
      onPress={() => onPress(item)}
      accessibilityLabel={`${item.contactName}, ${label}`}
      accessibilityRole="button"
    >
      {/* Avatar */}
      <AvatarCircle
        name={item.contactName}
        email={item.contactEmail}
        size={46}
        style={styles.avatar}
      />

      {/* Middle: name + call info */}
      <View style={styles.middle}>
        <Text style={[styles.name, { color: nameColor }]} numberOfLines={1}>
          {item.contactName || item.contactEmail}
        </Text>
        <View style={styles.callInfoRow}>
          {isOutgoing ? (
            <ArrowOutgoing size={14} color={arrowColor} />
          ) : (
            <ArrowIncoming size={14} color={arrowColor} />
          )}
          <Text style={[styles.callType, { color: subtextColor }]}>
            {' '}{label}
            {durationStr ? ` (${durationStr})` : ''}
          </Text>
        </View>
      </View>

      {/* Right: time + call icon + info */}
      <View style={styles.right}>
        <Text style={[styles.time, { color: subtextColor }]}>
          {formatCallTime(item.timestamp)}
        </Text>
        <View style={styles.rightIcons}>
          {item.video ? (
            <IconVideo size={18} color={GREEN} />
          ) : (
            <IconPhone size={18} color={GREEN} />
          )}
          <TouchableOpacity
            onPress={() => onInfoPress(item)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={styles.infoBtn}
            accessibilityLabel="Call info"
            accessibilityRole="button"
          >
            <IconInfo size={20} color={colors.primary || '#007AFF'} />
          </TouchableOpacity>
        </View>
      </View>
    </TouchableOpacity>
  );
});

// --- Main component ---

function ChatCallsTab({ colors, isDark, t, user, router }) {
  const [calls, setCalls] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadCalls = useCallback(async () => {
    setLoading(true);
    const history = await getCallHistory();
    setCalls(history);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadCalls();
  }, [loadCalls]);

  // Re-load when tab gains focus (interval-based since there is no navigation event here)
  useEffect(() => {
    const interval = setInterval(() => {
      getCallHistory().then((h) => {
        setCalls((prev) => {
          if (prev.length !== h.length) return h;
          if (prev.length > 0 && h.length > 0 && prev[0].id !== h[0].id) return h;
          return prev;
        });
      });
    }, 5000);
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
    // Navigate to chat conversation with that contact (info view)
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

  const renderItem = useCallback(({ item }) => (
    <CallRow
      item={item}
      colors={colors}
      isDark={isDark}
      t={t}
      onPress={handleCallPress}
      onInfoPress={handleInfoPress}
    />
  ), [colors, isDark, t, handleCallPress, handleInfoPress]);

  const keyExtractor = useCallback((item) => item.id, []);

  const bgColor = isDark ? '#000' : '#fff';
  const subtextColor = colors.textSecondary || (isDark ? '#8e8e93' : '#8e8e93');

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: bgColor }]}>
        <View style={styles.emptyContainer}>
          <Text style={[styles.emptyText, { color: subtextColor }]}>...</Text>
        </View>
      </View>
    );
  }

  if (calls.length === 0) {
    return (
      <View style={[styles.container, { backgroundColor: bgColor }]}>
        <View style={styles.emptyContainer}>
          <IconPhone size={48} color={isDark ? '#3a3a3c' : '#c7c7cc'} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>
            {t ? t('calls.noCallsTitle') || 'No Recent Calls' : 'No Recent Calls'}
          </Text>
          <Text style={[styles.emptyText, { color: subtextColor }]}>
            {t ? t('calls.noCallsSubtitle') || 'Your call history will appear here' : 'Your call history will appear here'}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: bgColor }]}>
      <FlatList
        data={calls}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        initialNumToRender={20}
        maxToRenderPerBatch={15}
        windowSize={10}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  listContent: {
    paddingBottom: 20,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatar: {
    marginRight: 12,
  },
  middle: {
    flex: 1,
    justifyContent: 'center',
    marginRight: 8,
  },
  name: {
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 2,
  },
  callInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  callType: {
    fontSize: 13,
  },
  right: {
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  rightIcons: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    gap: 12,
  },
  time: {
    fontSize: 13,
  },
  infoBtn: {
    padding: 2,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    paddingTop: 80,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginTop: 16,
    marginBottom: 6,
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
  },
});

export default memo(ChatCallsTab);
