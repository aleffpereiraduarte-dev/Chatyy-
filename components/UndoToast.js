import { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { IconUndo, IconX } from './Icons';

export default function UndoToast({ action, onUndo, onDismiss }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const slideAnim = useRef(new Animated.Value(80)).current;
  const progressAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (action) {
      progressAnim.setValue(1);
      Animated.spring(slideAnim, { toValue: 0, useNativeDriver: Platform.OS !== 'web', tension: 80, friction: 10 }).start();
      Animated.timing(progressAnim, { toValue: 0, duration: 5000, useNativeDriver: false }).start();
    } else {
      Animated.timing(slideAnim, { toValue: 80, duration: 200, useNativeDriver: Platform.OS !== 'web' }).start();
    }
  }, [action]);

  if (!action) return null;

  const messages = {
    deleted: t('undo.deleted'),
    archived: t('undo.archived'),
  };
  const msg = messages[action.type] || t('undo.deleted');

  return (
    <Animated.View style={[
      s.container, Shadow.lg,
      { backgroundColor: colors.toastBg, transform: [{ translateY: slideAnim }], overflow: 'hidden' },
    ]}>
      <Text style={[s.message, { color: colors.toastText }]}>{msg}</Text>
      <TouchableOpacity onPress={onUndo} style={s.undoBtn}>
        <IconUndo size={16} color={colors.primary} style={{ marginRight: 4 }} />
        <Text style={[s.undoText, { color: colors.primary }]}>{t('undo.button')}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onDismiss} style={s.closeBtn}>
        <IconX size={14} color={colors.toastText} />
      </TouchableOpacity>
      <Animated.View style={[s.progress, {
        backgroundColor: colors.primary,
        width: progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
      }]} />
    </Animated.View>
  );
}

const s = StyleSheet.create({
  container: {
    position: 'absolute', bottom: 24, left: 24, right: 24,
    flexDirection: 'row', alignItems: 'center',
    borderRadius: BorderRadius.md, paddingVertical: Spacing.md, paddingHorizontal: Spacing.lg,
    maxWidth: 480, alignSelf: 'center', zIndex: 200,
  },
  message: { flex: 1, fontSize: FontSize.base },
  undoBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs,
  },
  undoText: { fontSize: FontSize.base, fontWeight: '600' },
  closeBtn: { padding: Spacing.xs, marginLeft: Spacing.xs },
  progress: {
    height: 3,
    position: 'absolute',
    bottom: 0,
    left: 0,
    opacity: 0.5,
    borderBottomLeftRadius: BorderRadius.md,
  },
});
