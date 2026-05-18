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

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, Modal, TouchableOpacity, StyleSheet, Platform, Animated, Pressable,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import AvatarCircle from './AvatarCircle';
import { IconMapPin, IconX } from './Icons';
import * as api from '../services/api';

// Global trigger — called from pushNotifications.js (foreground push)
// or snap-map.js (background-tap routing). `data` should match the FCM
// payload shape sent by chat.php case chat_friend_location_request.
let _showModal = null;
export function triggerLocationRequestModal(data) {
  if (_showModal) _showModal(data);
}

export default function LocationRequestModal() {
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
        await api.friendLocationAccept?.(reqData.email, action);
      }
    } catch (err) {
      // Backend errors are surfaced via the push retry / WS reconcile — we
      // still dismiss so the modal doesn't get stuck on a transient 500.
      try { console.warn('[LocationRequest] respond failed:', err?.message); } catch {}
    }
    dismiss();
  }, [reqData, busy, dismiss]);

  if (!visible || !reqData) return null;

  const title = (t?.('location.requestModalTitle') || '{name} quer ver sua localização')
    .replace('{name}', reqData.name);

  return (
    <Modal transparent visible={visible} animationType="none" statusBarTranslucent onRequestClose={dismiss}>
      <Pressable style={lrm.overlay} onPress={dismiss}>
        <Pressable onPress={(e) => e.stopPropagation?.()} style={{ width: '100%' }}>
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
                  <IconMapPin size={14} color="#7C3AED" />
                  <Text style={[lrm.badgeLabel, { color: '#7C3AED' }]}>
                    {(t?.('location.requestModalLabel') || 'Localização').toUpperCase()}
                  </Text>
                </View>
                <Text style={[lrm.title, { color: colors.text }]} numberOfLines={2}>
                  {title}
                </Text>
              </View>
              <TouchableOpacity onPress={dismiss} style={lrm.closeBtn} accessibilityLabel="Fechar">
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
              <TouchableOpacity
                onPress={() => respond(-1)}
                disabled={busy}
                style={[lrm.btnPrimary, { backgroundColor: '#7C3AED', opacity: busy ? 0.6 : 1 }]}
                accessibilityLabel={t?.('location.acceptForever') || 'Sempre'}
              >
                <Text style={lrm.btnPrimaryText}>{t?.('location.acceptForever') || 'Sempre'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => respond(3600)}
                disabled={busy}
                style={[lrm.btnSecondary, {
                  backgroundColor: isDark ? 'rgba(124,58,237,0.18)' : '#ede9fe',
                  opacity: busy ? 0.6 : 1,
                }]}
                accessibilityLabel={t?.('location.acceptOneHour') || '1 hora'}
              >
                <Text style={[lrm.btnSecondaryText, { color: '#7C3AED' }]}>
                  {t?.('location.acceptOneHour') || '1 hora'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => respond(900)}
                disabled={busy}
                style={[lrm.btnSecondary, {
                  backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#f3f4f6',
                  opacity: busy ? 0.6 : 1,
                }]}
                accessibilityLabel={t?.('location.acceptOnce') || 'Apenas esta vez'}
              >
                <Text style={[lrm.btnSecondaryText, { color: colors.text }]}>
                  {t?.('location.acceptOnce') || 'Apenas esta vez'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => respond('decline')}
                disabled={busy}
                style={[lrm.btnGhost, { opacity: busy ? 0.6 : 1 }]}
                accessibilityLabel={t?.('location.decline') || 'Recusar'}
              >
                <Text style={[lrm.btnGhostText, { color: '#ef4444' }]}>
                  {t?.('location.decline') || 'Recusar'}
                </Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        </Pressable>
      </Pressable>
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
    paddingBottom: Platform.OS === 'ios' ? 36 : 24,
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
