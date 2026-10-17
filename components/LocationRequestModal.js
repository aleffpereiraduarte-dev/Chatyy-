/**
 * LocationRequestModal — Global "X quer ver sua localização" sheet
 *
 * Why this file
 * -------------
 * Backend (chat.php case `chat_friend_location_request`) sends a push with
 *   data: { type: 'location_request', requester_email, requester_name, message }
 * The push registers an in-app banner inside `/snap-map`, but if the user is
 * NOT on that screen when the push lands (most cases), the request would just
 * sit silently until they navigated to the map. This modal closes that gap:
 *
 *   - Push arrives while app is foregrounded → triggerLocationRequestModal()
 *     opens this sheet on top of whatever screen the user is on, with the same
 *     four-option layout `/snap-map`'s pending banner exposes (Sempre / 1h /
 *     Apenas esta vez / Recusar).
 *
 *   - User taps the push from background → notification response handler in
 *     pushNotifications.js routes to `/snap-map?incoming_request=<email>` and
 *     snap-map auto-shows this modal on mount with the requester pre-loaded.
 *
 * Privacy contract
 * ----------------
 * - Decisions hit api.friendLocationAccept / friendLocationDecline so the
 *   backend stays authoritative — the modal is purely a presentation layer.
 * - `durationSeconds = -1` means unlimited (matches snap-map "Sempre" button).
 *
 * Lifecycle pattern is copied from LoginChallengePrompt: a module-level
 * `_showModal` ref + an `useEffect` that registers it on mount. That way the
 * push handler in `services/pushNotifications.js` can fire the modal without
 * threading any React context.
 */

import { androidBottomInset } from '../utils/systemInsets'; // [2026-10-07 android-native] edge-to-edge
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, Modal, TouchableOpacity, StyleSheet, Platform, Animated, Pressable,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import AvatarCircle from './AvatarCircle';
import { IconMapPin, IconX } from './Icons';
import * as api from '../services/api';
import useDragToDismiss, { DragSheetRoot, DragPanel, DragBackdrop } from './ui/useDragToDismiss';

// Global trigger — called from pushNotifications.js (foreground push)
// or snap-map.js (background-tap routing). `data` should match the FCM
// payload shape sent by chat.php case chat_friend_location_request.
let _showModal = null;
export function triggerLocationRequestModal(data) {
  if (_showModal) { _showModal(data); return true; }
  return false;
}

// [2026-10-12 mapa-amigos] Quem quiser saber que um pedido foi respondido aqui
// (ex.: snap-map tira o pedido da lista e recarrega os grants).
const _resolvedListeners = new Set();
export function onLocationRequestResolved(cb) {
  _resolvedListeners.add(cb);
  return () => { _resolvedListeners.delete(cb); };
}

export default function LocationRequestModal() {
  // [2026-10-17 drag-dismiss] folha desce arrastando de qualquer ponto (components/ui/useDragToDismiss).
  const _drag132 = useDragToDismiss({ onDismiss: () => { const f = dismiss; if (typeof f === 'function') f(); } });
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [visible, setVisible] = useState(false);
  const [reqData, setReqData] = useState(null);
  const [busy, setBusy] = useState(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // Register the global trigger. Multiple pushes during the same session
  // will replace the in-flight modal — last write wins, which matches the
  // way snap-map dedupes pending requests by email.
  useEffect(() => {
    _showModal = (data) => {
      if (!data?.requester_email) return;
      setReqData({
        email: data.requester_email,
        name: data.requester_name || data.requester_email,
        message: data.message || '',
      });
      setBusy(false);
      setVisible(true);
      Animated.timing(fadeAnim, {
        toValue: 1, duration: 220, useNativeDriver: true,
      }).start();
    };
    return () => { _showModal = null; };
  }, [fadeAnim]);

  const dismiss = useCallback(() => {
    Animated.timing(fadeAnim, {
      toValue: 0, duration: 180, useNativeDriver: true,
    }).start(() => {
      setVisible(false);
      setReqData(null);
      setBusy(false);
    });
  }, [fadeAnim]);

  const respond = useCallback(async (action) => {
    if (!reqData?.email || busy) return;
    setBusy(true);
    try {
      if (action === 'decline') {
        await api.friendLocationDecline?.(reqData.email);
      } else {
        // action = durationSeconds (number). -1 = unlimited.
        const r = await api.friendLocationAccept?.(reqData.email, action);
        // [2026-10-12 mapa-amigos] Liga o envio (1º/2º plano) e explica o
        // "Permitir sempre" — sem isso o amigo nunca via o pin atualizado.
        if (r?.success !== false) {
          try {
            const fms = require('../services/friendMapShare');
            setTimeout(() => { fms.onFriendShareAccepted(t).catch?.(() => {}); }, 350);
          } catch {}
        }
      }
    } catch (err) {
      // Backend errors are surfaced via the push retry / WS reconcile — we
      // still dismiss so the modal doesn't get stuck on a transient 500.
      try { console.warn('[LocationRequest] respond failed:', err?.message); } catch {}
    }
    _resolvedListeners.forEach((cb) => { try { cb({ email: reqData.email, accepted: action !== 'decline' }); } catch {} });
    dismiss();
  }, [reqData, busy, dismiss, t]);

  if (!visible || !reqData) return null;

  const title = (t?.('location.requestModalTitle') || '{name} quer ver sua localização')
    .replace('{name}', reqData.name);

  return (
    <Modal transparent visible={visible} animationType="none" statusBarTranslucent onRequestClose={dismiss}>
      <DragSheetRoot>
      <Pressable style={[lrm.overlay, { backgroundColor: 'transparent' }]} onPress={dismiss}>
        <DragBackdrop drag={_drag132} color="rgba(0,0,0,0.55)" />
        <DragPanel drag={_drag132} onStartShouldSetResponder={() => true}  style={{ width: '100%' }}>
          <Animated.View style={[
            lrm.sheet,
            {
              backgroundColor: colors.surface || (isDark ? '#1a1a1a' : '#fff'),
              opacity: fadeAnim,
              transform: [{
                translateY: fadeAnim.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }),
              }],
            },
          ]}>
            {/* Header: avatar + name + close */}
            <View style={lrm.headerRow}>
              <AvatarCircle name={reqData.name} email={reqData.email} size={56} />
              <View style={{ flex: 1, marginLeft: 14 }}>
                <View style={lrm.iconBadge}>
                  <IconMapPin size={14} color={colors.primary} />
                  <Text style={[lrm.badgeLabel, { color: colors.primary }]}>
                    {(t?.('location.requestModalLabel') || 'Localização').toUpperCase()}
                  </Text>
                </View>
                <Text style={[lrm.title, { color: colors.text }]} numberOfLines={2}>
                  {title}
                </Text>
              </View>
              <TouchableOpacity onPress={dismiss} style={lrm.closeBtn} accessibilityLabel={t?.('common.close') || 'Fechar'}>
                <IconX size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* Optional message from requester */}
            {reqData.message ? (
              <View style={[lrm.messageBox, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#f3f4f6' }]}>
                <Text style={[lrm.messageText, { color: colors.textSecondary }]} numberOfLines={4}>
                  "{reqData.message}"
                </Text>
              </View>
            ) : null}

            {/* Action buttons — match snap-map's three-tier accept + decline */}
            <View style={{ marginTop: 18, gap: 10 }}>
              <Text style={{ color: colors.textSecondary, fontSize: 12, fontWeight: '700', marginBottom: 2 }}>
                {t?.('fmap.durationTitle') || 'Por quanto tempo?'}
              </Text>
              {[
                { dur: 3600, label: t?.('fmap.dur1h') || '1 hora', primary: true },
                { dur: 8 * 3600, label: t?.('fmap.dur8h') || '8 horas' },
                { dur: -1, label: t?.('fmap.durForever') || 'Até eu desligar' },
              ].map((o) => (
                <TouchableOpacity
                  key={String(o.dur)}
                  onPress={() => respond(o.dur)}
                  disabled={busy}
                  style={[o.primary ? lrm.btnPrimary : lrm.btnSecondary, {
                    backgroundColor: o.primary
                      ? (isDark ? '#FFFFFF' : '#111111')
                      : (isDark ? 'rgba(255,255,255,0.08)' : '#F1F3F5'),
                    opacity: busy ? 0.6 : 1,
                  }]}
                  accessibilityLabel={o.label}
                >
                  <Text style={o.primary
                    ? [lrm.btnPrimaryText, { color: isDark ? '#111111' : '#FFFFFF' }]
                    : [lrm.btnSecondaryText, { color: colors.text }]}
                  >
                    {o.label}
                  </Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                onPress={() => respond('decline')}
                disabled={busy}
                style={[lrm.btnGhost, { opacity: busy ? 0.6 : 1 }]}
                accessibilityLabel={t?.('location.decline') || 'Recusar'}
              >
                <Text style={[lrm.btnGhostText, { color: colors.textSecondary }]}>
                  {t?.('location.decline') || 'Recusar'}
                </Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        </DragPanel>
      </Pressable>
      </DragSheetRoot>
    </Modal>
  );
}

const lrm = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    padding: 22,
    paddingBottom: Platform.OS === 'ios' ? 36 : androidBottomInset(24),
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  badgeLabel: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
  },
  closeBtn: {
    padding: 6,
    marginLeft: 4,
  },
  messageBox: {
    marginTop: 14,
    padding: 12,
    borderRadius: 14,
  },
  messageText: {
    fontSize: 14,
    fontStyle: 'italic',
    lineHeight: 19,
  },
  btnPrimary: {
    paddingVertical: 14,
    borderRadius: 22,
    alignItems: 'center',
  },
  btnPrimaryText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  btnSecondary: {
    paddingVertical: 14,
    borderRadius: 22,
    alignItems: 'center',
  },
  btnSecondaryText: {
    fontSize: 15,
    fontWeight: '700',
  },
  btnGhost: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  btnGhostText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
