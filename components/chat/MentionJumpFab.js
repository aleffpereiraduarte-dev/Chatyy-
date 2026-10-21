// [2026-10-14 grupo-rajada] Botão "@" de menções não lidas (WhatsApp): fica
// acima do botão "rolar até o fim" enquanto houver mensagens que mencionam o
// usuário (msg.mentions = email dele ou @everyone) ainda não vistas — chegadas
// com o usuário lendo acima, ou não lidas na abertura. Toque = pula para a
// menção mais antiga pendente (o pai remove da fila e faz safeScrollToMsg).
import React, { memo, useEffect, useRef } from 'react';
import { Animated, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { IconAtSign } from '../Icons';

function MentionJumpFab({ count, onPress, isDark, colors, t, bottom = 142 }) {
  const scale = useRef(new Animated.Value(0.85)).current;
  useEffect(() => {
    Animated.spring(scale, { toValue: 1, tension: 180, friction: 9, useNativeDriver: Platform.OS !== 'web' }).start();
  }, [scale]);
  if (!count || count <= 0) return null;
  // 1 → "Você foi mencionado" (evita "1 menções não lidas"); N → "N menções não lidas"
  const label = count === 1
    ? ((t && t('chat.youWereMentioned')) || 'Você foi mencionado')
    : ((t && t('chatConv.unreadMentionsA11y', { n: count })) || `${count} menções não lidas`);
  return (
    <Animated.View style={[styles.wrap, { bottom, transform: [{ scale }] }]}>
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.75}
        hitSlop={4}
        accessibilityRole="button"
        accessibilityLabel={label}
        testID="chat-mention-jump"
        style={[styles.fab, {
          backgroundColor: colors.surface,
          borderColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)',
        }]}
      >
        <IconAtSign size={22} color={colors?.text || (isDark ? '#ffffff' : '#111111')} />
        {count > 1 ? (
          <Animated.View style={[styles.badge, {
            // [2026-10-21 tema] aro = superfície do botão; badge = destaque ou tinta do tema (era preto/branco fixo)
            backgroundColor: colors?.accentOn ? colors.accent : (colors?.text || (isDark ? '#ffffff' : '#111111')),
            borderColor: colors?.surface || (isDark ? '#000000' : '#ffffff'),
          }]}>
            <Text style={[styles.badgeText, { color: colors?.accentOn ? (colors.onAccent || '#ffffff') : (colors?.surface || (isDark ? '#111111' : '#ffffff')) }]}>{count > 99 ? '99+' : count}</Text>
          </Animated.View>
        ) : null}
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', right: 12 },
  fab: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.12, shadowRadius: 8 },
      android: { elevation: 4 },
      default: { boxShadow: '0 3px 8px rgba(0,0,0,0.12)' },
    }),
  },
  badge: {
    position: 'absolute', top: -4, right: -4, minWidth: 20, height: 20, borderRadius: 10,
    paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center', borderWidth: 2,
  },
  badgeText: { fontSize: 11, fontWeight: '700' },
});

export default memo(MentionJumpFab);
