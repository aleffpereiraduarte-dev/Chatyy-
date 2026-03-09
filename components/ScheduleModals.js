import React from 'react';
import {
  View, Text, TouchableOpacity, Modal, Pressable, TextInput,
  ScrollView, StyleSheet, Platform,
} from 'react-native';
import { Shadow } from '../constants/theme';
import { IconClock, IconX, IconTrash } from './Icons';

/**
 * Schedule Toast - shows confirmation after scheduling
 */
export function ScheduleToast({ visible, message, colors }) {
  if (!visible || !message) return null;
  return (
    <View style={{
      position: 'absolute', bottom: 80, alignSelf: 'center',
      backgroundColor: colors.surface, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10,
      flexDirection: 'row', alignItems: 'center', gap: 8,
      borderWidth: 1, borderColor: colors.border, ...Shadow.md,
    }}>
      <IconClock size={14} color={colors.primary} />
      <Text style={{ fontSize: 13, color: colors.text }}>{message}</Text>
    </View>
  );
}

/**
 * Custom Schedule Picker Modal - datetime input for custom scheduling
 */
export function CustomScheduleModal({ visible, onClose, customDate, setCustomDate, onSchedule, colors, t }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={modalStyles.overlay} onPress={onClose}>
        <View style={[modalStyles.sheet, { backgroundColor: colors.surface, padding: 20, minWidth: 300 }, Shadow.lg]}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 12 }}>
            {t('chat.scheduleCustom')}
          </Text>
          {Platform.OS === 'web' ? (
            <input
              type="datetime-local"
              value={customDate}
              onChange={(e) => setCustomDate(e.target.value)}
              style={{
                padding: 10, fontSize: 16, borderRadius: 8,
                border: `1px solid ${colors.border}`,
                backgroundColor: colors.background, color: colors.text,
                width: '100%', marginBottom: 16,
              }}
              min={new Date().toISOString().slice(0, 16)}
            />
          ) : (
            <TextInput
              value={customDate}
              onChangeText={setCustomDate}
              placeholder="YYYY-MM-DD HH:MM"
              placeholderTextColor={colors.textTertiary}
              style={{
                padding: 10, fontSize: 16, borderRadius: 8,
                borderWidth: 1, borderColor: colors.border,
                backgroundColor: colors.background, color: colors.text, marginBottom: 16,
              }}
            />
          )}
          <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end' }}>
            <TouchableOpacity onPress={onClose} style={{ paddingVertical: 10, paddingHorizontal: 20, borderRadius: 8 }}>
              <Text style={{ color: colors.textSecondary }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                if (customDate) {
                  const dt = new Date(customDate);
                  if (!isNaN(dt.getTime()) && dt > new Date()) {
                    onSchedule(dt.toISOString());
                  }
                }
              }}
              style={{ paddingVertical: 10, paddingHorizontal: 20, borderRadius: 8, backgroundColor: colors.primary }}
            >
              <Text style={{ color: '#fff', fontWeight: '600' }}>{t('chat.schedule')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}

/**
 * Scheduled Messages List Modal - view/cancel pending scheduled messages
 */
export function ScheduledMessagesModal({ visible, onClose, messages, onCancel, colors, t }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={modalStyles.overlay} onPress={onClose}>
        <View style={[modalStyles.sheet, { backgroundColor: colors.surface, maxHeight: '70%', minWidth: 320, padding: 0 }, Shadow.lg]}>
          <View style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
          }}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>
              {t('chat.scheduledMessages')}
            </Text>
            <TouchableOpacity onPress={onClose}>
              <IconX size={20} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>
          <ScrollView style={{ padding: 16 }}>
            {messages.length === 0 ? (
              <Text style={{ color: colors.textTertiary, textAlign: 'center', paddingVertical: 20 }}>
                {t('chat.noScheduledMessages')}
              </Text>
            ) : messages.map(sm => (
              <View key={sm.id} style={{
                backgroundColor: colors.background, borderRadius: 10, padding: 12, marginBottom: 10,
                borderWidth: 1, borderColor: colors.border,
              }}>
                <Text style={{ fontSize: 14, color: colors.text, marginBottom: 6 }} numberOfLines={3}>
                  {sm.content}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <IconClock size={12} color={colors.primary} />
                    <Text style={{ fontSize: 12, color: colors.primary }}>
                      {new Date(sm.scheduled_at + 'Z').toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => onCancel(sm.id)}
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: 4,
                      paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6,
                      backgroundColor: colors.error + '15',
                    }}
                  >
                    <IconTrash size={12} color={colors.error} />
                    <Text style={{ fontSize: 12, color: colors.error }}>{t('chat.scheduleCancel')}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </ScrollView>
        </View>
      </Pressable>
    </Modal>
  );
}

const modalStyles = StyleSheet.create({
  overlay: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    borderRadius: 16, overflow: 'hidden',
  },
});
