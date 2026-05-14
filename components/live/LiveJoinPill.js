/**
 * LiveJoinPill — small purple gradient pill rendered above the comment input,
 * letting viewers tap to request to join the live (TikTok "Go LIVE Together"
 * / Instagram "Pedir pra entrar").
 *
 * Disabled state (after request sent) → ghost grey with check.
 *
 * Pure presentation — parent owns `joinRequested` state and handler.
 */

import {
  Text, TouchableOpacity, StyleSheet, Platform,
} from 'react-native';
import { IconUserPlus, IconCheck } from '../Icons';

const ACCENT = '#7C3AED';

export default function LiveJoinPill({
  joinRequested = false,
  onPress,
  label = 'Pedir pra entrar',
  sentLabel = 'Pedido enviado',
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={joinRequested}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.pill, joinRequested && styles.pillSent]}
    >
      {joinRequested
        ? <IconCheck size={14} color="#fff" />
        : <IconUserPlus size={14} color="#fff" />}
      <Text style={styles.text} numberOfLines={1}>
        {joinRequested ? sentLabel : label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: ACCENT,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    alignSelf: 'flex-start',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 4px 14px rgba(124,58,237,0.55)',
    } : {}),
  },
  pillSent: {
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderColor: 'rgba(255,255,255,0.28)',
    ...(Platform.OS === 'web' ? { boxShadow: 'none' } : {}),
  },
  text: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
});
