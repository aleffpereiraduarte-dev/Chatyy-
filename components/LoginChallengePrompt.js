/**
 * LoginChallengePrompt — Google-style new device login verification
 *
 * When a push notification or WebSocket event of type "login_challenge" arrives,
 * this component shows a modal on the EXISTING device asking the user to
 * approve or deny the login from the new device.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, Modal, TouchableOpacity, StyleSheet, Platform, Animated,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconShield, IconAlertTriangle } from './Icons';
import * as api from '../services/api';

// Global trigger — called from pushNotifications.js or WebSocket handler
let _showPrompt = null;
export function triggerLoginChallengePrompt(data) {
  if (_showPrompt) _showPrompt(data);
}

export default function LoginChallengePrompt() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [visible, setVisible] = useState(false);
  const [challengeData, setChallengeData] = useState(null);
  const [responding, setResponding] = useState(false);
  const [result, setResult] = useState(null); // 'approved' | 'denied'
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // Register the global trigger
  useEffect(() => {
    _showPrompt = (data) => {
      setChallengeData(data);
      setResult(null);
      setResponding(false);
      setVisible(true);
      Animated.timing(fadeAnim, {
        toValue: 1, duration: 300, useNativeDriver: true,
      }).start();
    };
    return () => { _showPrompt = null; };
  }, [fadeAnim]);

  const dismiss = useCallback(() => {
    Animated.timing(fadeAnim, {
      toValue: 0, duration: 200, useNativeDriver: true,
    }).start(() => {
      setVisible(false);
      setChallengeData(null);
      setResult(null);
    });
  }, [fadeAnim]);

  const handleResponse = useCallback(async (action) => {
    if (!challengeData?.challenge_id) return;
    setResponding(true);
    try {
      await api.verifyLoginChallenge(challengeData.challenge_id, action);
      setResult(action === 'approve' ? 'approved' : 'denied');
      setTimeout(dismiss, 2000);
    } catch (err) {
      console.warn('[LoginChallenge] Response failed:', err.message);
      setResponding(false);
    }
  }, [challengeData, dismiss]);

  if (!visible || !challengeData) return null;

  const deviceInfo = challengeData.device_info || t('login.verifyUnknownDevice');

  return (
    <Modal transparent visible={visible} animationType="none" statusBarTranslucent>
      <View style={lcs.overlay}>
        <Animated.View style={[lcs.card, { backgroundColor: colors.cardBg || colors.surface, opacity: fadeAnim }]}>
          {!result ? (
            <>
              <View style={[lcs.iconCircle, { backgroundColor: '#f59e0b15' }]}>
                <IconAlertTriangle size={40} color="#f59e0b" />
              </View>
              <Text style={[lcs.title, { color: colors.text }]}>
                {t('login.verifyPromptTitle')}
              </Text>
              <Text style={[lcs.subtitle, { color: colors.textSecondary }]}>
                {t('login.verifyPromptBody')}
              </Text>
              <View style={[lcs.infoRow, { backgroundColor: colors.background || '#f5f5f5' }]}>
                <Text style={[lcs.infoLabel, { color: colors.textSecondary }]}>
                  {t('login.verifyPromptDevice')}
                </Text>
                <Text style={[lcs.infoValue, { color: colors.text }]}>
                  {deviceInfo}
                </Text>
                {challengeData.ip ? (
                  <Text style={[lcs.infoIp, { color: colors.textSecondary }]}>
                    IP: {challengeData.ip}
                  </Text>
                ) : null}
                <Text style={[lcs.infoTime, { color: colors.textSecondary }]}>
                  {t('login.verifyPromptTime')}
                </Text>
              </View>
              <View style={lcs.btnRow}>
                <TouchableOpacity
                  onPress={() => handleResponse('deny')}
                  disabled={responding}
                  style={[lcs.denyBtn, { borderColor: '#ef4444' }]}
                >
                  <Text style={[lcs.denyBtnText, { color: '#ef4444' }]}>
                    {t('login.verifyPromptDeny')}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => handleResponse('approve')}
                  disabled={responding}
                  style={[lcs.approveBtn, { backgroundColor: '#10b981' }]}
                >
                  <Text style={lcs.approveBtnText}>
                    {t('login.verifyPromptApprove')}
                  </Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              <View style={[lcs.iconCircle, {
                backgroundColor: result === 'approved' ? '#10b98115' : '#ef444415',
              }]}>
                <Text style={{ fontSize: 40 }}>
                  {result === 'approved' ? '\u2713' : '\u2717'}
                </Text>
              </View>
              <Text style={[lcs.title, { color: colors.text }]}>
                {result === 'approved' ? t('login.verifyApproved') : t('login.verifyDenied')}
              </Text>
            </>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

const lcs = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center', justifyContent: 'center',
    padding: 24,
  },
  card: {
    borderRadius: 20, padding: 28, width: '100%', maxWidth: 380,
    alignItems: 'center',
    ...Platform.select({
      web: { boxShadow: '0 8px 40px rgba(0,0,0,0.2)' },
      default: { elevation: 10 },
    }),
  },
  iconCircle: {
    width: 80, height: 80, borderRadius: 40,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 20, fontWeight: '700', textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14, textAlign: 'center', lineHeight: 20,
    marginBottom: 20,
  },
  infoRow: {
    borderRadius: 12, padding: 16, width: '100%',
    alignItems: 'center', marginBottom: 24,
  },
  infoLabel: {
    fontSize: 11, fontWeight: '600', textTransform: 'uppercase',
    letterSpacing: 0.5, marginBottom: 4,
  },
  infoValue: {
    fontSize: 16, fontWeight: '600', marginBottom: 2,
  },
  infoIp: {
    fontSize: 12, marginBottom: 2,
  },
  infoTime: {
    fontSize: 12, marginTop: 4,
  },
  btnRow: {
    flexDirection: 'row', gap: 12, width: '100%',
  },
  denyBtn: {
    flex: 1, paddingVertical: 14, borderRadius: 10,
    borderWidth: 1.5, alignItems: 'center',
  },
  denyBtnText: {
    fontSize: 14, fontWeight: '600',
  },
  approveBtn: {
    flex: 1, paddingVertical: 14, borderRadius: 10,
    alignItems: 'center',
  },
  approveBtnText: {
    fontSize: 14, fontWeight: '600', color: '#fff',
  },
});
