import { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Overlay, OverlayShadow, overlayColors } from '../constants/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isReduceMotionEnabled } from './reducedMotion'; // [2026-10-16 motion-telegram]
import { haptics } from '../services/haptics';

export default function UndoToast({ action, onUndo, onDismiss }) {
  const { colors, isDark } = useTheme();
  // [2026-10-12 overlays] cores do toast do design system (colors.primary
  // #111 sumia sobre o fundo escuro do toast no tema claro).
  const oc = overlayColors(colors, !!isDark);
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const slideAnim = useRef(new Animated.Value(80)).current;
  const progressAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (action) {
      progressAnim.setValue(1);
      // [2026-10-16 motion-telegram] Mola do design system (Overlay.spring, a
      // mesma do Toast/Sheet) em vez de tension 80/friction 10 (balançava);
      // Reduzir Movimento = aparece seco. Haptic leve canônico ('toast').
      if (isReduceMotionEnabled()) slideAnim.setValue(0);
      else Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, ...Overlay.spring }).start();
      try { haptics.toast?.(); } catch {}
      // Auto-dismiss quando a barra chegar ao fim — antes o pai precisava
      // observar o tempo manualmente e o toast podia ficar pendurado.
      // [2026-10-16 motion-telegram] barra de progresso via scaleX no native
      // driver (antes width % no JS = 300 frames de JS por toast).
      Animated.timing(progressAnim, { toValue: 0, duration: 5000, useNativeDriver: Platform.OS !== 'web' })
        .start(({ finished }) => { if (finished) onDismiss?.(); });
    } else {
      Animated.timing(slideAnim, { toValue: 80, duration: Overlay.exitMs, useNativeDriver: true }).start();
    }
  }, [action, onDismiss]);

  if (!action) return null;

  // [2026-10-19 undo-email] Snackbar estilo Gmail: texto de e-mail (não
  // "Mensagem"), plural, "Desfazer" só em texto forte, sem X/ícone/barra, e
  // acima do botão de escrever (antes cobria o FAB e a última linha).
  const n = Array.isArray(action.uids) ? action.uids.length : 1;
  const tr = (k, fb) => { const v = t(k); return v && v !== k ? v : fb; };
  const msg = action.type === 'archived'
    ? (n > 1 ? tr('undo.emailsArchived', '{n} e-mails arquivados').replace('{n}', String(n)) : tr('undo.emailArchived', 'E-mail arquivado'))
    : (n > 1 ? tr('undo.emailsTrashed', '{n} e-mails movidos para a lixeira').replace('{n}', String(n)) : tr('undo.emailTrashed', 'E-mail movido para a lixeira'));

  return (
    <Animated.View style={[
      s.container, OverlayShadow,
      { bottom: (insets?.bottom || 0) + 84, backgroundColor: oc.toastBg, transform: [{ translateY: slideAnim }] },
    ]}>
      <Text style={[s.message, { color: oc.toastText }]} numberOfLines={2}>{msg}</Text>
      <TouchableOpacity
        onPress={() => { try { haptics.light?.(); } catch {} onUndo?.(); }}
        hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
        accessibilityRole="button"
        style={s.undoBtn}
      >
        <Text style={[s.undoText, { color: oc.toastAction }]}>{tr('undo.button', 'Desfazer')}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  container: {
    position: 'absolute', left: 16, right: 16,
    flexDirection: 'row', alignItems: 'center',
    borderRadius: 14, minHeight: 52,
    paddingVertical: 8, paddingLeft: 18, paddingRight: 8,
    maxWidth: Overlay.toastMaxWidth, alignSelf: 'center', zIndex: 200,
  },
  message: { flex: 1, fontSize: FontSize.base, fontWeight: '500', letterSpacing: -0.1 },
  undoBtn: { paddingHorizontal: 12, height: 36, justifyContent: 'center', marginLeft: 8 },
  undoText: { fontSize: FontSize.base, fontWeight: '700' },
});
