import { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Modal, Animated } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import {
  IconSend, IconArchive, IconTrash, IconStar, IconStarFilled,
  IconMarkRead, IconMarkUnread, IconClock, IconAlertTriangle,
  IconFolder, IconX,
} from './Icons';

const SEPARATOR = { _separator: true };

export default function ContextMenu({ visible, position, email, onClose, actions }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      fadeAnim.setValue(0);
      Animated.timing(fadeAnim, { toValue: 1, duration: 150, useNativeDriver: Platform.OS !== 'web' }).start();
    }
  }, [visible]);

  if (!visible || !email) return null;

  const isStarred = email.flagged;
  const isRead = email.seen;

  const items = [
    { key: 'reply', label: t('contextMenu.reply'), icon: IconSend, action: () => actions.onReply?.(email) },
    { key: 'replyAll', label: t('contextMenu.replyAll'), icon: IconSend, action: () => actions.onReplyAll?.(email) },
    { key: 'forward', label: t('contextMenu.forward'), icon: IconSend, action: () => actions.onForward?.(email) },
    SEPARATOR,
    { key: 'archive', label: t('contextMenu.archive'), icon: IconArchive, action: () => actions.onArchive?.(email) },
    { key: 'delete', label: t('contextMenu.delete'), icon: IconTrash, color: colors.error, action: () => actions.onDelete?.(email) },
    { key: 'moveTo', label: t('contextMenu.moveTo'), icon: IconFolder, action: () => actions.onMoveTo?.(email) },
    SEPARATOR,
    { key: 'markRead', label: isRead ? t('contextMenu.markUnread') : t('contextMenu.markRead'), icon: isRead ? IconMarkUnread : IconMarkRead, action: () => (isRead ? actions.onMarkUnread : actions.onMarkRead)?.(email) },
    { key: 'snooze', label: t('contextMenu.snooze'), icon: IconClock, action: () => actions.onSnooze?.(email) },
    { key: 'star', label: isStarred ? t('contextMenu.unstar') : t('contextMenu.star'), icon: isStarred ? IconStarFilled : IconStar, action: () => actions.onStar?.(email) },
    SEPARATOR,
    { key: 'spam', label: t('contextMenu.spam'), icon: IconAlertTriangle, action: () => actions.onSpam?.(email) },
    { key: 'block', label: t('contextMenu.block'), icon: IconX, action: () => actions.onBlock?.(email) },
  ];

  const handleAction = (item) => {
    onClose();
    item.action();
  };

  // Web: fixed position dropdown at cursor
  if (Platform.OS === 'web') {
    const menuStyle = {
      position: 'fixed',
      top: position?.y || 0,
      left: position?.x || 0,
      zIndex: 1000,
    };

    // Ensure menu doesn't go off screen
    if (typeof window !== 'undefined') {
      if (position?.x > window.innerWidth - 220) menuStyle.left = window.innerWidth - 220;
      if (position?.y > window.innerHeight - 400) menuStyle.top = window.innerHeight - 400;
    }

    return (
      <>
        <TouchableOpacity
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999 }}
          onPress={onClose}
          activeOpacity={1}
        />
        <Animated.View style={[
          s.menu, Shadow.lg,
          { backgroundColor: colors.surface, borderColor: colors.borderLight, opacity: fadeAnim },
          menuStyle,
          s.menuWeb,
        ]}>
          {items.map((item, i) => {
            if (item._separator) return <View key={`sep-${i}`} style={[s.separator, { borderTopColor: colors.borderLight }]} />;
            const Icon = item.icon;
            return (
              <TouchableOpacity
                key={item.key}
                style={[s.menuItem, Platform.OS === 'web' && s.menuItemWeb]}
                onPress={() => handleAction(item)}
              >
                <Icon size={16} color={item.color || colors.textSecondary} />
                <Text style={[s.menuItemText, { color: item.color || colors.text }]}>{item.label}</Text>
              </TouchableOpacity>
            );
          })}
        </Animated.View>
      </>
    );
  }

  // Mobile: bottom sheet modal
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={s.modalBackdrop} onPress={onClose} activeOpacity={1}>
        <View style={[s.bottomSheet, { backgroundColor: colors.surface }]}>
          <View style={[s.sheetHandle, { backgroundColor: colors.divider }]} />
          <View style={s.sheetContent}>
            {items.map((item, i) => {
              if (item._separator) return <View key={`sep-${i}`} style={[s.separator, { borderTopColor: colors.borderLight }]} />;
              const Icon = item.icon;
              return (
                <TouchableOpacity
                  key={item.key}
                  style={s.sheetItem}
                  onPress={() => handleAction(item)}
                >
                  <Icon size={20} color={item.color || colors.textSecondary} />
                  <Text style={[s.sheetItemText, { color: item.color || colors.text }]}>{item.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const s = StyleSheet.create({
  menu: {
    borderRadius: BorderRadius.md, borderWidth: 1, paddingVertical: 4, minWidth: 200,
  },
  menuWeb: Platform.OS === 'web' ? {
    animation: 'fadeIn 0.12s ease-out',
    boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
  } : {},
  menuItem: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 14, gap: 10,
  },
  menuItemWeb: Platform.OS === 'web' ? {
    cursor: 'pointer', transition: 'background-color 0.1s ease',
  } : {},
  menuItemText: { fontSize: FontSize.sm },
  separator: { borderTopWidth: 1, marginVertical: 4 },
  // Mobile bottom sheet
  modalBackdrop: {
    flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)',
  },
  bottomSheet: {
    borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 34,
  },
  sheetHandle: {
    width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 10, marginBottom: 10,
  },
  sheetContent: { paddingHorizontal: Spacing.md },
  sheetItem: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: Spacing.md, gap: 14,
  },
  sheetItemText: { fontSize: FontSize.lg },
});
