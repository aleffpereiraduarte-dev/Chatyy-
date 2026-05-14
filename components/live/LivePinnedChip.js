/**
 * LivePinnedChip — sticky pin chip surfaced when the host pins a comment.
 *
 * TikTok parity. Yellow-bordered glass pill, IconPin + host name + body text.
 * Slides down from above with a soft spring entrance, tap to dismiss locally.
 *
 * Pure presentation: parent owns `pinnedMsg` state and onDismiss handler.
 */

import { useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Animated,
} from 'react-native';
import { IconPin } from '../Icons';

export default function LivePinnedChip({ pinnedMsg, onDismiss }) {
  const entrance = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (pinnedMsg) {
      entrance.setValue(0);
      Animated.spring(entrance, {
        toValue: 1,
        friction: 7,
        tension: 110,
        useNativeDriver: true,
      }).start();
    }
  }, [pinnedMsg, entrance]);

  if (!pinnedMsg) return null;

  return (
    <Animated.View
      style={{
        opacity: entrance,
        transform: [{
          translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }),
        }],
      }}
    >
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={onDismiss}
        style={styles.chip}
        accessibilityRole="button"
        accessibilityLabel="Pinned comment"
      >
        <IconPin size={13} color="#fde047" />
        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>
            {pinnedMsg.name}
          </Text>
          <Text style={styles.text} numberOfLines={2}>
            {pinnedMsg.content}
          </Text>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: 'rgba(253,224,71,0.55)',
    maxWidth: '85%',
    alignSelf: 'flex-start',
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(10px)',
      WebkitBackdropFilter: 'blur(10px)',
      boxShadow: '0 2px 10px rgba(253,224,71,0.18)',
    } : {}),
  },
  name: {
    color: '#fde047',
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  text: {
    color: '#fff',
    fontSize: 12.5,
    lineHeight: 16,
    fontWeight: '500',
  },
});
