import { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, Overlay, OverlayShadow, overlayColors } from '../constants/theme';
import { IconUndo, IconX } from './Icons';

export default function UndoToast({ action, onUndo, onDismiss }) {
  const { colors, isDark } = useTheme();
  // [2026-10-12 overlays] cores do toast do design system (colors.primary
  // #111 sumia sobre o fundo escuro do toast no tema claro).
  const oc = overlayColors(colors, !!isDark);
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
      s.container, OverlayShadow,
      { backgroundColor: oc.toastBg, transform: [{ translateY: slideAnim }], overflow: 'hidden' },
    ]}>
      <Text style={[s.message, { color: oc.toastText }]}>{msg}</Text>
      <TouchableOpacity onPress={onUndo} style={[s.undoBtn, { backgroundColor: oc.toastActionBg }]}>
        <IconUndo size={16} color={oc.toastAction} style={{ marginRight: 4 }} />
        <Text style={[s.undoText, { color: oc.toastAction }]}>{t('undo.button')}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onDismiss} style={s.closeBtn}>
        <IconX size={14} color={oc.toastText} />
      </TouchableOpacity>
      <Animated.View style={[s.progress, {
        backgroundColor: oc.toastText,
        width: progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
      }]} />
    </Animated.View>
  );
}

const s = StyleSheet.create({
  container: {
    position: 'absolute', bottom: 28, left: 24, right: 24,
    flexDirection: 'row', alignItems: 'center',
    borderRadius: Overlay.toastRadius, minHeight: Overlay.toastMinHeight,
    paddingVertical: 6, paddingLeft: 16, paddingRight: 6,
    maxWidth: Overlay.toastMaxWidth, alignSelf: 'center', zIndex: 200,
  },
  message: { flex: 1, fontSize: FontSize.base, fontWeight: '500' },
  undoBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, height: 36,
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
    borderBottomLeftRadius: Overlay.toastRadius,
  },
});
