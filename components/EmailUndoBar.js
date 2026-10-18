// [2026-10-07 email-instant-send] Global "Enviando… / Enviado · Desfazer"
// snackbar for e-mail, mounted once in app/_layout.js. The composer closes
// right after the server queues the message; this bar keeps the undo window.
import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLanguage } from '../context/LanguageContext';
import { useTheme } from '../context/ThemeContext';
import { Overlay, OverlayShadow, overlayColors } from '../constants/theme';
import { subscribeEmailUndo, getEmailUndo, undoEmailSend, dismissEmailUndo, showEmailNotice } from '../services/emailUndo';
import { initEmailOutbox, retryOutboxEmail } from '../services/emailOutbox';

export default function EmailUndoBar() {
  const [st, setSt] = useState(getEmailUndo());
  const [, setTick] = useState(0);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  // Dark mode: a #111 bar vanishes on the black app background — lift it to
  // the elevated surface with a hairline border (iOS-dark snackbar look).
  const { colors, isDark } = useTheme();
  // [2026-10-12 overlays] cores/forma do Toast do design system (mesmo snackbar do app todo).
  const oc = overlayColors(colors, !!isDark);
  const barTheme = { backgroundColor: oc.toastBg };
  const fg = { color: oc.toastText };
  const btnTheme = { backgroundColor: oc.toastActionBg };
  const btnFg = { color: oc.toastAction };

  useEffect(() => subscribeEmailUndo(setSt), []);
  // [2026-10-08 email-outbox] this bar is mounted once globally — wire the
  // outbox drain triggers (foreground / reconnect / account switch) here.
  useEffect(() => { try { initEmailOutbox(); } catch {} }, []);
  useEffect(() => {
    if (!st || st.phase !== 'pending') return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [st]);

  if (!st) return null;
  const pending = st.phase === 'pending';
  const outbox = st.phase === 'outbox' || st.phase === 'sending';
  const failed = st.phase === 'failed';
  const left = Math.max(0, Math.ceil((st.until - Date.now()) / 1000));

  const onUndo = async () => {
    const ok = await undoEmailSend();
    if (ok) {
      try { router.push({ pathname: '/compose', params: { restore_undo: '1' } }); } catch {}
    }
  };

  return (
    <View pointerEvents="box-none" style={[st_.wrap, { bottom: Math.max(insets.bottom, 12) + 64 }]}>
      <View style={[st_.bar, barTheme]} accessibilityLiveRegion="polite">
        <Text style={[st_.text, fg]} numberOfLines={1}>
          {failed ? t('emailOutbox.notSentToast')
            : st.phase === 'sending' ? t('compose.sendingUndo')
            : pending ? t('compose.sentUndoLabel')
            : outbox ? t('emailOutbox.queuedToast') : t('compose.sentToast')}
        </Text>
        {failed ? (
          <TouchableOpacity
            onPress={() => {
              const csid = st.csid;
              if (!csid) { dismissEmailUndo(); try { router.push('/email-outbox'); } catch {} return; }
              try { showEmailNotice('sending', csid); } catch {}
              retryOutboxEmail(csid).catch(() => {});
            }}
            onLongPress={() => { dismissEmailUndo(); try { router.push('/email-outbox'); } catch {} }}
            hitSlop={10} accessibilityRole="button" style={[st_.btn, btnTheme]}>
            <Text style={[st_.btnText, btnFg]}>{t('emailOutbox.retryShort')}</Text>
          </TouchableOpacity>
        ) : st.phase === 'sending' ? null : outbox ? (
          <TouchableOpacity onPress={() => { dismissEmailUndo(); try { router.push('/email-outbox'); } catch {} }} hitSlop={10} accessibilityRole="button" style={[st_.btn, btnTheme]}>
            <Text style={[st_.btnText, btnFg]}>{t('emailOutbox.view')}</Text>
          </TouchableOpacity>
        ) : pending ? (
          <TouchableOpacity onPress={onUndo} hitSlop={10} accessibilityRole="button" style={[st_.btn, btnTheme]}>
            <Text style={[st_.btnText, btnFg]}>{t('undo.button') + (left > 0 ? ` (${left})` : '')}</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={dismissEmailUndo} hitSlop={10} accessibilityRole="button" style={[st_.btn, btnTheme]}>
            <Text style={[st_.btnText, btnFg]}>{t('common.ok')}</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const st_ = StyleSheet.create({
  wrap: { position: 'absolute', left: 12, right: 12, alignItems: 'center', zIndex: 9999, elevation: 30 },
  bar: {
    width: '100%', maxWidth: Overlay.toastMaxWidth, flexDirection: 'row', alignItems: 'center',
    borderRadius: Overlay.toastRadius, paddingLeft: 16, paddingRight: 6, minHeight: Overlay.toastMinHeight,
    ...OverlayShadow,
  },
  text: { flex: 1, fontSize: 14, fontWeight: '500' },
  btn: { paddingHorizontal: 14, height: 36, borderRadius: 10, justifyContent: 'center', marginLeft: 8 },
  btnText: { fontSize: 14, fontWeight: '700' },
});
