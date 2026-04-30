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
      Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, tension: 80, friction: 10 }).start();
      // Auto-dismiss quando a barra chegar ao fim — antes o pai precisava
      // observar o tempo manualmente e o toast podia ficar pendurado.
      Animated.timing(progressAnim, { toValue: 0, duration: 5000, useNativeDriver: false })
        .start(({ finished }) => { if (finished) onDismiss?.(); });
    } else {
      Animated.timing(slideAnim, { toValue: 80, duration: 200, useNativeDriver: true }).start();
    }
  }, [action, onDismiss]);

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
    position: 'absolute', bottom: 28, left: 24, right: 24,
    flexDirection: 'row', alignItems: 'center',
    borderRadius: 16, paddingVertical: Spacing.md + 2, paddingHorizontal: Spacing.xl,
    maxWidth: 480, alignSelf: 'center', zIndex: 200,
    ...Platform.select({
      web: {
        boxShadow: '0 8px 32px rgba(0,0,0,0.2), 0 0 0 1px rgba(255,255,255,0.06)',
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
      },
      default: {
        shadowColor: '#000', shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.2, shadowRadius: 24, elevation: 12,
      },
    }),
  },
  message: { flex: 1, fontSize: FontSize.base, fontWeight: '500' },
  undoBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2,
    borderRadius: 10,
  },
  undoText: { fontSize: FontSize.base, fontWeight: '700' },
  closeBtn: { padding: Spacing.xs + 2, marginLeft: Spacing.xs },
  progress: {
    height: 3,
    position: 'absolute',
    bottom: 0,
    left: 0,
    opacity: 0.5,
    borderBottomLeftRadius: 16,
  },
});
