/**
 * PushLoginRequestModal — "Aprovar login no <app>" sheet.
 *
 * Sibling apps (SuperBora, BoraUm) ask Chatyy backend to dispatch a push
 * with { type: 'push_login', app_label, challenge_id, code, initiator_ip,
 * initiator_ua, expires_at }. Chatyy is the source of truth — Approve here
 * triggers /api/push/login-approve, which marks the challenge approved
 * AND fires the HMAC callback to the sibling's approve_url.
 *
 * The 6-digit code is rendered LARGE so the user can cross-check it
 * against the code the other app displayed — codes mismatch means a
 * third party initiated the login and the user should Reject.
 *
 * Lifecycle (module-level `_showModal` ref + useEffect to register) mirrors
 * LocationRequestModal — lets pushNotifications.js fire the modal without
 * threading any React context. Both foreground push (received listener) and
 * background tap (response listener) call triggerPushLoginModal() since the
 * notification payload already carries everything the sheet needs.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, Modal, TouchableOpacity, StyleSheet, Platform, Animated, Pressable,
  ActivityIndicator,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconShield, IconX } from './Icons';
import * as api from '../services/api';

// Global trigger — called by pushNotifications.js (foreground push handler).
let _showModal = null;
export function triggerPushLoginModal(data) {
  if (_showModal) _showModal(data);
}

export default function PushLoginRequestModal() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [visible, setVisible] = useState(false);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [doneAction, setDoneAction] = useState(null); // 'approved' | 'rejected'
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    _showModal = (payload) => {
      if (!payload?.challenge_id) return;
      setData({
        challengeId: String(payload.challenge_id),
        appLabel: payload.app_label || payload.app || 'app',
        app: payload.app || 'superbora',
        code: String(payload.code || ''),
        ip: payload.initiator_ip || '',
        ua: payload.initiator_ua || '',
        expiresAt: payload.expires_at || '',
      });
      setBusy(false);
      setDoneAction(null);
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
      setData(null);
      setBusy(false);
      setDoneAction(null);
    });
  }, [fadeAnim]);

  const respond = useCallback(async (action) => {
    if (!data?.challengeId || busy) return;
    setBusy(true);
    try {
      if (action === 'approve') {
        await api.pushLoginApprove(data.challengeId);
      } else {
        await api.pushLoginReject(data.challengeId);
      }
      setDoneAction(action === 'approve' ? 'approved' : 'rejected');
      // Brief flash of confirmation before sliding out — feels less abrupt
      // than the modal yanking shut the moment the network round-trips.
      setTimeout(() => dismiss(), 850);
    } catch (err) {
      // Backend errors surface here; we dismiss regardless so the modal
      // doesn't get stuck on a transient 500. The user can always retry
      // from the sibling app — it polls the approve state.
      try { console.warn('[PushLoginRequest] respond failed:', err?.message); } catch {}
      dismiss();
    }
  }, [data, busy, dismiss]);

  if (!visible || !data) return null;

  const appLabel = data.appLabel || 'app';
  const title = (t?.('pushLogin.modalTitle') || 'Confirmar login no {app}')
    .replace('{app}', appLabel);
  const subtitle = t?.('pushLogin.modalSubtitle')
    || 'Confira o código abaixo. Se não bater com o que aparece no outro app, recuse.';

  const isApproved = doneAction === 'approved';
  const isRejected = doneAction === 'rejected';

  return (
    <Modal transparent visible={visible} animationType="none" statusBarTranslucent onRequestClose={dismiss}>
      <Pressable style={pls.overlay} onPress={busy ? undefined : dismiss}>
        <Pressable onPress={(e) => e.stopPropagation?.()} style={{ width: '100%' }}>
          <Animated.View style={[
            pls.sheet,
            {
              backgroundColor: colors.surface || (isDark ? '#1a1a1a' : '#fff'),
              opacity: fadeAnim,
              transform: [{
                translateY: fadeAnim.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }),
              }],
            },
          ]}>
            <View style={pls.headerRow}>
              <View style={[pls.iconCircle, { backgroundColor: isDark ? 'rgba(34,197,94,0.18)' : '#dcfce7' }]}>
                <IconShield size={22} color="#22c55e" />
              </View>
              <View style={{ flex: 1, marginLeft: 14 }}>
                <Text style={[pls.badge, { color: '#22c55e' }]}>
                  {(t?.('pushLogin.badge') || 'LOGIN').toUpperCase()}
                </Text>
                <Text style={[pls.title, { color: colors.text }]} numberOfLines={2}>
                  {title}
                </Text>
              </View>
              {!busy && (
                <TouchableOpacity onPress={dismiss} style={pls.closeBtn} accessibilityLabel={t?.('common.close') || 'Fechar'}>
                  <IconX size={20} color={colors.textSecondary} />
                </TouchableOpacity>
              )}
            </View>

            <Text style={[pls.subtitle, { color: colors.textSecondary }]}>
              {subtitle}
            </Text>

            {/* The 6-digit code — anti-phishing crosscheck */}
            <View style={[pls.codeBox, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#f3f4f6' }]}>
              <Text style={[pls.codeLabel, { color: colors.textSecondary }]}>
                {(t?.('pushLogin.codeLabel') || 'Código de verificação').toUpperCase()}
              </Text>
              <Text style={[pls.codeText, { color: colors.text }]} selectable>
                {data.code || '------'}
              </Text>
            </View>

            {/* IP + UA detail rows — let the user spot suspicious origins */}
            <View style={pls.detailList}>
              {data.ip ? (
                <View style={pls.detailRow}>
                  <Text style={[pls.detailLabel, { color: colors.textSecondary }]}>
                    {t?.('pushLogin.ipLabel') || 'IP'}
                  </Text>
                  <Text style={[pls.detailValue, { color: colors.text }]} numberOfLines={1}>{data.ip}</Text>
                </View>
              ) : null}
              {data.ua ? (
                <View style={pls.detailRow}>
                  <Text style={[pls.detailLabel, { color: colors.textSecondary }]}>
                    {t?.('pushLogin.deviceLabel') || 'Dispositivo'}
                  </Text>
                  <Text style={[pls.detailValue, { color: colors.text }]} numberOfLines={2}>{data.ua}</Text>
                </View>
              ) : null}
            </View>

            <View style={{ marginTop: 18, gap: 10 }}>
              <TouchableOpacity
                onPress={() => respond('approve')}
                disabled={busy}
                style={[pls.btnPrimary, {
                  backgroundColor: isApproved ? '#16a34a' : '#22c55e',
                  opacity: busy && !isApproved ? 0.6 : 1,
                }]}
                accessibilityLabel={t?.('pushLogin.approve') || 'Aprovar'}
              >
                {busy && !doneAction ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={pls.btnPrimaryText}>
                    {isApproved
                      ? (t?.('pushLogin.approved') || 'Aprovado')
                      : (t?.('pushLogin.approve') || 'Aprovar')}
                  </Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => respond('reject')}
                disabled={busy}
                style={[pls.btnDanger, { opacity: busy && !isRejected ? 0.6 : 1 }]}
                accessibilityLabel={t?.('pushLogin.reject') || 'Recusar'}
              >
                <Text style={pls.btnDangerText}>
                  {isRejected
                    ? (t?.('pushLogin.rejected') || 'Recusado')
                    : (t?.('pushLogin.reject') || 'Recusar')}
                </Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const pls = StyleSheet.create({
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
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
  },
  closeBtn: {
    padding: 6,
    marginLeft: 4,
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 12,
  },
  codeBox: {
    marginTop: 16,
    paddingVertical: 18,
    paddingHorizontal: 16,
    borderRadius: 16,
    alignItems: 'center',
  },
  codeLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.7,
    marginBottom: 6,
  },
  codeText: {
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: 6,
  },
  detailList: {
    marginTop: 12,
  },
  detailRow: {
    flexDirection: 'row',
    paddingVertical: 6,
  },
  detailLabel: {
    width: 96,
    fontSize: 12,
    fontWeight: '600',
  },
  detailValue: {
    flex: 1,
    fontSize: 12,
  },
  btnPrimary: {
    paddingVertical: 14,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  btnPrimaryText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  btnDanger: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  btnDangerText: {
    color: '#ef4444',
    fontSize: 14,
    fontWeight: '600',
  },
});
