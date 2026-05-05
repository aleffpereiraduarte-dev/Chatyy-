// ConfirmModal — WhatsApp/iMessage-grade native confirmation sheet.
// Replaces Alert.alert in destructive flows where Android 6 dialog feel
// breaks the premium aesthetic (audit 2026-05-05). Use for: delete chat,
// logout, leave group, clear history, delete message, etc.
//
// API:
//   <ConfirmModal
//     visible={...} onClose={...} onConfirm={...}
//     title="Apagar conversa?"
//     message="Esta acao nao pode ser desfeita."
//     confirmLabel="Apagar"     // optional, default "Confirmar"
//     cancelLabel="Cancelar"    // optional, default "Cancelar"
//     destructive                // optional, paints confirm red
//     icon={iconNode}            // optional SVG icon node, shown above title
//   />
//
// Imperative: import { confirmDestructive } from this file → Promise<boolean>.

import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, Pressable, Animated, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';

export default function ConfirmModal({
  visible,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive = false,
  icon = null,
}) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const scale = useRef(new Animated.Value(0.92)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, useNativeDriver: true, tension: 200, friction: 11 }),
        Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: true }),
      ]).start();
    } else {
      scale.setValue(0.92);
      opacity.setValue(0);
    }
  }, [visible, scale, opacity]);

  const ok = confirmLabel || t?.('common.confirm') || 'Confirmar';
  const no = cancelLabel || t?.('common.cancel') || 'Cancelar';

  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable
        onPress={onClose}
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.45)',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        }}
      >
        <Animated.View
          style={{
            opacity,
            transform: [{ scale }],
            width: '100%',
            maxWidth: 340,
            backgroundColor: colors.surface,
            borderRadius: 18,
            padding: 22,
            ...(Platform.OS === 'web' ? { backdropFilter: 'blur(20px)' } : {}),
            shadowColor: '#000',
            shadowOpacity: 0.25,
            shadowOffset: { width: 0, height: 8 },
            shadowRadius: 16,
            elevation: 18,
          }}
          // Stop bubbling so taps inside don't dismiss
          onStartShouldSetResponder={() => true}
        >
          {icon ? (
            <View style={{ alignItems: 'center', marginBottom: 12 }}>
              <View style={{
                width: 56, height: 56, borderRadius: 28,
                backgroundColor: destructive ? '#EF444418' : (colors.primary + '18'),
                alignItems: 'center', justifyContent: 'center',
              }}>
                {icon}
              </View>
            </View>
          ) : null}
          <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text, textAlign: 'center', marginBottom: 6 }}>
            {title}
          </Text>
          {message ? (
            <Text style={{ fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 20, marginBottom: 18 }}>
              {message}
            </Text>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Pressable
              onPress={onClose}
              style={({ pressed }) => ({
                flex: 1,
                paddingVertical: 12,
                borderRadius: 12,
                backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
                alignItems: 'center',
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>{no}</Text>
            </Pressable>
            <Pressable
              onPress={() => { onConfirm?.(); onClose?.(); }}
              style={({ pressed }) => ({
                flex: 1,
                paddingVertical: 12,
                borderRadius: 12,
                backgroundColor: destructive ? '#EF4444' : colors.primary,
                alignItems: 'center',
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>{ok}</Text>
            </Pressable>
          </View>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}
