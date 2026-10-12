import { useState, useEffect, useRef } from 'react';
import { TouchableOpacity, StyleSheet, Platform, Animated } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { Overlay, OverlayShadow, overlayColors } from '../constants/theme';
import Sheet from './ui/Sheet';
import ActionList from './ui/ActionList';
import {
  IconSend, IconArchive, IconTrash, IconStar, IconStarFilled,
  IconMarkRead, IconMarkUnread, IconClock, IconAlertTriangle,
  IconFolder, IconX, IconVolume2,
  IconReply, IconReplyAll, IconForward,
} from './Icons';

const SEPARATOR = { _separator: true };

export default function ContextMenu({ visible, position, email, onClose, actions, mutedUids }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const oc = overlayColors(colors, !!isDark);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.96)).current;

  useEffect(() => {
    if (visible) {
      fadeAnim.setValue(0);
      scaleAnim.setValue(0.96);
      // Spring scale + linear fade gives the menu a tiny "snap" entrance
      // (iOS context-menu pattern) instead of a flat fade.
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 140, useNativeDriver: true }),
        Animated.spring(scaleAnim, { toValue: 1, tension: 320, friction: 14, useNativeDriver: true }),
      ]).start();
    }
  }, [visible]);

  // [2026-10-12 overlays] Popover do desktop: Esc fecha (como todo menu de SO).
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible || typeof window === 'undefined') return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { try { onClose?.(); } catch {} } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, onClose]);

  if (!visible || !email) return null;

  const isStarred = email.flagged;
  const isRead = email.seen;
  const isMuted = mutedUids?.has?.(String(email.uid));

  const items = [
    { key: 'reply', label: t('contextMenu.reply'), icon: IconReply, action: () => actions.onReply?.(email) },
    { key: 'replyAll', label: t('contextMenu.replyAll'), icon: IconReplyAll, action: () => actions.onReplyAll?.(email) },
    { key: 'forward', label: t('contextMenu.forward'), icon: IconForward, action: () => actions.onForward?.(email) },
    SEPARATOR,
    { key: 'archive', label: t('contextMenu.archive'), icon: IconArchive, action: () => actions.onArchive?.(email) },
    { key: 'delete', label: t('contextMenu.delete'), icon: IconTrash, color: colors.error, action: () => actions.onDelete?.(email) },
    { key: 'moveTo', label: t('contextMenu.moveTo'), icon: IconFolder, action: () => actions.onMoveTo?.(email) },
    SEPARATOR,
    { key: 'markRead', label: isRead ? t('contextMenu.markUnread') : t('contextMenu.markRead'), icon: isRead ? IconMarkUnread : IconMarkRead, action: () => (isRead ? actions.onMarkUnread : actions.onMarkRead)?.(email) },
    { key: 'snooze', label: t('contextMenu.snooze'), icon: IconClock, action: () => actions.onSnooze?.(email) },
    { key: 'star', label: isStarred ? t('contextMenu.unstar') : t('contextMenu.star'), icon: isStarred ? IconStarFilled : IconStar, action: () => actions.onStar?.(email) },
    { key: 'mute', label: isMuted ? t('contextMenu.unmute') : t('contextMenu.mute'), icon: IconVolume2, action: () => actions.onMute?.(email) },
    SEPARATOR,
    { key: 'spam', label: t('contextMenu.spam'), icon: IconAlertTriangle, action: () => actions.onSpam?.(email) },
    { key: 'block', label: t('contextMenu.block'), icon: IconX, action: () => actions.onBlock?.(email) },
  ];

  const handleAction = (item) => {
    onClose();
    item.action();
  };

  // [2026-10-12 overlays] Design system único: ActionList (linhas 52/ícone 22
  // no sheet; 36/18 no menu de desktop) + Sheet (alça, raio 20, backdrop 0.4,
  // mola, safe-area, back do Android). Itens/ações idênticos aos de antes.
  const listItems = items.map((item, i) => (item._separator
    ? { separator: true, key: `sep-${i}` }
    : { key: item.key, label: item.label, icon: item.icon, destructive: item.color === colors.error, onPress: () => handleAction(item), keepOpen: true }));

  // Web: popover fixo no cursor
  if (Platform.OS === 'web') {
    const menuStyle = {
      position: 'fixed',
      top: position?.y || 0,
      left: position?.x || 0,
      zIndex: 1000,
    };

    // Ensure menu doesn't go off screen
    if (typeof window !== 'undefined') {
      if (position?.x > window.innerWidth - 232) menuStyle.left = Math.max(8, window.innerWidth - 232);
      if (position?.y > window.innerHeight - 490) menuStyle.top = Math.max(8, window.innerHeight - 490);
    }

    return (
      <>
        <TouchableOpacity
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999 }}
          onPress={onClose}
          activeOpacity={1}
        />
        <Animated.View
          accessibilityRole="menu"
          style={[
            s.menu, OverlayShadow,
            { backgroundColor: oc.menuBg, borderColor: oc.border, opacity: fadeAnim, transform: [{ scale: scaleAnim }], transformOrigin: 'top left' },
            menuStyle,
          ]}
        >
          <ActionList variant="menu" items={listItems} />
        </Animated.View>
      </>
    );
  }

  // Mobile: bottom sheet do design system
  return (
    <Sheet visible={visible} onClose={onClose} scroll>
      <ActionList items={listItems} />
    </Sheet>
  );
}

const s = StyleSheet.create({
  menu: {
    borderRadius: Overlay.menuRadius, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 2, minWidth: 220,
  },
});
