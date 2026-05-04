// Standard modal/bottom-sheet header — kills 8+ inline duplicates of the
// "close X + title + spacer" pattern across modals (ProfileEditSheet,
// ChatProfileTab, ChannelDiscoverModal, BroadcastModal, CreateGroupFlow,
// CompleteProfileModal, ChangePasswordModal, etc.)
//
// Usage:
//   <ModalHeader title={t('chat.newGroup')} onClose={onClose} />
//
// Optional props:
//   - onBack: if set, renders ← (chevron-left) on left instead of × on right
//   - rightActionLabel + onRightAction: text-link button on the right
//     (e.g. "Salvar" — useful for forms where Done sits in the header)
//   - rightActionDisabled: dim the right action when conditions unmet
//   - hairline: bool — render a bottom border (default true)
//   - dragHandle: bool — render a 36×4 grey drag pill above the row
//                       (true for bottom sheets, false for centered modals)
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { IconX, IconArrowLeft } from './Icons';
import { useTheme } from '../context/ThemeContext';

export default function ModalHeader({
  title,
  onClose,
  onBack,
  rightActionLabel,
  onRightAction,
  rightActionDisabled = false,
  hairline = true,
  dragHandle = false,
  testID,
}) {
  const { colors } = useTheme();
  return (
    <View>
      {dragHandle && (
        <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 4 }}>
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderLight || colors.border || '#cbd5e1' }} />
        </View>
      )}
      <View
        style={[
          styles.row,
          hairline && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight || colors.border },
        ]}
        testID={testID}
      >
        <View style={styles.side}>
          {onBack ? (
            <TouchableOpacity onPress={onBack} hitSlop={hitSlop} accessibilityRole="button" accessibilityLabel="Voltar">
              <IconArrowLeft size={22} color={colors.text} />
            </TouchableOpacity>
          ) : null}
        </View>

        <Text
          style={[styles.title, { color: colors.text }]}
          numberOfLines={1}
          accessibilityRole="header"
        >
          {title}
        </Text>

        <View style={[styles.side, { alignItems: 'flex-end' }]}>
          {rightActionLabel && onRightAction ? (
            <TouchableOpacity
              onPress={onRightAction}
              disabled={rightActionDisabled}
              hitSlop={hitSlop}
              accessibilityRole="button"
              accessibilityLabel={rightActionLabel}
              style={{ opacity: rightActionDisabled ? 0.4 : 1 }}
            >
              <Text style={{ fontSize: 15, fontWeight: '600', color: colors.primary }}>{rightActionLabel}</Text>
            </TouchableOpacity>
          ) : onClose ? (
            <TouchableOpacity onPress={onClose} hitSlop={hitSlop} accessibilityRole="button" accessibilityLabel="Fechar">
              <IconX size={22} color={colors.text} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const hitSlop = { top: 10, bottom: 10, left: 10, right: 10 };
const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 48,
  },
  side: {
    width: 60,
    flexDirection: 'row',
    alignItems: 'center',
  },
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
});
