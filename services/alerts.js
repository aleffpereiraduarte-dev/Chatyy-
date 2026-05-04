// Shared alert/confirm — kills 17 duplicate `safeAlert` definitions across
// the codebase (drive.js, photos.js, backup.js, business.js, chat-new.js,
// chat-conversation.js, etc.). Same API as Alert.alert; falls back to
// window.confirm/alert on web for environments where native Alert.alert
// shim doesn't render a styled modal.
import { Alert, Platform } from 'react-native';

/**
 * Cross-platform alert. Use exactly like `Alert.alert`:
 *   safeAlert('Apagar?', 'Tem certeza?', [
 *     { text: 'Cancelar', style: 'cancel' },
 *     { text: 'Apagar', style: 'destructive', onPress: doDelete },
 *   ])
 *
 * On web: tries Alert.alert first (RN-web shows a styled dialog in this app);
 * if it throws or no buttons supplied, falls back to window.confirm/alert.
 * Buttons with `style: 'cancel'` map to the Cancel side of confirm; the
 * remaining non-cancel button's `onPress` runs on confirm OK.
 */
export function safeAlert(title, message, buttons) {
  // Native — always Alert.alert, full button set.
  if (Platform.OS !== 'web') {
    try {
      Alert.alert(title || '', message || '', buttons || [{ text: 'OK' }]);
    } catch {}
    return;
  }
  // Web — try Alert.alert (RN-web), fall back to window.confirm/alert.
  try {
    if (buttons && buttons.length) {
      Alert.alert(title || '', message || '', buttons);
      return;
    }
    Alert.alert(title || '', message || '');
    return;
  } catch {}

  if (typeof window !== 'undefined') {
    const text = (title ? title + (message ? '\n\n' + message : '') : message) || '';
    if (!buttons || buttons.length <= 1) {
      try { window.alert(text); } catch {}
      const onlyBtn = buttons && buttons[0];
      if (onlyBtn?.onPress) try { onlyBtn.onPress(); } catch {}
      return;
    }
    let ok = true;
    try { ok = window.confirm(text); } catch {}
    const cancel = buttons.find(b => b?.style === 'cancel');
    const proceed = buttons.find(b => b?.style !== 'cancel');
    const target = ok ? proceed : cancel;
    if (target?.onPress) try { target.onPress(); } catch {}
  }
}

/**
 * Convenience wrapper for destructive confirmations:
 *   confirmDestructive({
 *     title: 'Apagar 5 emails?',
 *     message: 'Você pode restaurar da Lixeira',
 *     destructiveLabel: 'Apagar',
 *     cancelLabel: 'Cancelar',
 *     onConfirm: () => api.delete(...)
 *   })
 */
export function confirmDestructive({ title, message, destructiveLabel = 'OK', cancelLabel = 'Cancel', onConfirm, onCancel }) {
  safeAlert(title, message, [
    { text: cancelLabel, style: 'cancel', onPress: onCancel },
    { text: destructiveLabel, style: 'destructive', onPress: onConfirm },
  ]);
}
