/**
 * UnifiedComposeFab — single floating action button that expands into a
 * radial menu with the 4 compose targets: Email, Chat, Status, Post.
 *
 * Replaces the scattered "new" buttons across the inbox, chat list, feed
 * and status screens. Each action routes to its existing composer so we
 * don't duplicate any logic — this is purely the unified entry point.
 */

import React, { useCallback, useRef, useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, Modal, Pressable, Animated,
  Platform, Easing, StyleSheet,
} from 'react-native';
import {
  IconPlus, IconMail, IconMessageSquare, IconCamera, IconImage, IconX,
} from './Icons';

// Each row sits in its own absolute slot above the FAB. When closed,
// they collapse to the FAB position (via translateY = collapsedOffset)
// and shrink to scale 0 — so the four icons literally come OUT of the
// FAB instead of materialising in a vertical line that looks stacked
// for a frame. Material Design fan-out pattern.
//
// `index` is 0-based from the bottom (closest to FAB → index 0).
// `slotHeight` is the vertical space each row occupies including gap.
function ActionButton({ icon: Icon, label, color, onPress, colors, delay = 0, open, index = 0, slotHeight = 66 }) {
  const scale = useRef(new Animated.Value(open ? 1 : 0)).current;
  // Collapsed translateY = the distance from this row's natural slot
  // back to the FAB. The bottom-most row (index 0) collapses ~slotHeight
  // pixels DOWN; row 1 collapses 2× that, etc. — every row converges
  // on the FAB origin.
  const collapsed = (index + 1) * slotHeight;
  const translateY = useRef(new Animated.Value(open ? 0 : collapsed)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale, {
        toValue: open ? 1 : 0,
        tension: 160, friction: 9,
        delay: open ? delay : 0,
        useNativeDriver: true,
      }),
      Animated.spring(translateY, {
        toValue: open ? 0 : collapsed,
        tension: 140, friction: 11,
        delay: open ? delay : 0,
        useNativeDriver: true,
      }),
    ]).start();
  }, [open, delay, collapsed]);
  return (
    <Animated.View
      pointerEvents={open ? 'auto' : 'none'}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 12,
        opacity: scale, // tied to scale so closing also fades out
        transform: [{ translateY }, { scale }],
      }}
    >
      <View style={{
        backgroundColor: colors?.background || '#fff',
        paddingHorizontal: 12, paddingVertical: 7, borderRadius: 12,
        ...(Platform.OS === 'web'
          ? { boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }
          : { shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.15, shadowRadius: 6, elevation: 4 }),
      }}>
        <Text style={{ fontSize: 13, fontWeight: '600', color: colors?.text || '#111' }}>{label}</Text>
      </View>
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.8}
        style={{
          width: 52, height: 52, borderRadius: 26,
          backgroundColor: color,
          alignItems: 'center', justifyContent: 'center',
          ...(Platform.OS === 'web'
            ? { boxShadow: `0 6px 16px ${color}66` }
            : { shadowColor: color, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 10, elevation: 6 }),
        }}
      >
        <Icon size={22} color="#fff" />
      </TouchableOpacity>
    </Animated.View>
  );
}

export default function UnifiedComposeFab({ router, colors, isDark, t, userEmail, bottom = 24, right = 20 }) {
  const [open, setOpen] = useState(false);
  const rotate = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(rotate, {
      toValue: open ? 1 : 0,
      tension: 200, friction: 10,
      useNativeDriver: true,
    }).start();
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  const go = (path) => { close(); setTimeout(() => router?.push(path), 120); };

  const rotateInterp = rotate.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '45deg'] });

  return (
    <>
      {/* Backdrop when open */}
      {open && (
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={close}
        >
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.35)' }]} />
        </Pressable>
      )}

      {/* Action stack — always rendered so layout slots are stable.
          Each row's translateY collapses it onto the FAB when closed
          and slides it out when open. Index is bottom-up (closest to
          FAB → 0). slotHeight = 52 (button) + 14 (gap). */}
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          right, bottom,
          alignItems: 'flex-end', gap: 18,
        }}
      >
        <ActionButton
          open={open}
          delay={60}
          index={3}
          slotHeight={70}
          icon={IconMail}
          label={t?.('compose.email') || 'Email'}
          color="#2563eb"
          colors={colors}
          onPress={() => go('/compose')}
        />
        <ActionButton
          open={open}
          delay={40}
          index={2}
          slotHeight={70}
          icon={IconMessageSquare}
          label={t?.('compose.chat') || 'Mensagem'}
          color="#10b981"
          colors={colors}
          onPress={() => go('/chat-new')}
        />
        <ActionButton
          open={open}
          delay={20}
          index={1}
          slotHeight={70}
          icon={IconCamera}
          label={t?.('compose.status') || 'Status'}
          color="#f59e0b"
          colors={colors}
          onPress={() => go('/chat?tab=status&new=1')}
        />
        <ActionButton
          open={open}
          delay={0}
          index={0}
          slotHeight={70}
          icon={IconImage}
          label={t?.('compose.post') || 'Publicação'}
          color="#ec4899"
          colors={colors}
          onPress={() => go('/spotlight?createPost=1')}
        />

        {/* Main FAB */}
        <TouchableOpacity
          onPress={() => setOpen(o => !o)}
          activeOpacity={0.85}
          style={{
            width: 56, height: 56, borderRadius: 28,
            backgroundColor: '#7C3AED',
            alignItems: 'center', justifyContent: 'center',
            ...(Platform.OS === 'web'
              ? { boxShadow: '0 8px 24px rgba(124,58,237,0.45)' }
              : { shadowColor: '#7C3AED', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.45, shadowRadius: 14, elevation: 8 }),
          }}
          accessibilityLabel={open ? (t?.('common.close') || 'Fechar') : (t?.('compose.new') || 'Novo')}
          accessibilityRole="button"
        >
          <Animated.View style={{ transform: [{ rotate: rotateInterp }] }}>
            <IconPlus size={26} color="#fff" />
          </Animated.View>
        </TouchableOpacity>
      </View>
    </>
  );
}
