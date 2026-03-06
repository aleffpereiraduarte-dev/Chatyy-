import { useState } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Modal, ScrollView, ActivityIndicator } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { IconX, IconShield, IconCheck, IconCheckCircle, IconKey, IconCopy } from './Icons';
import * as api from '../services/api';

export default function TwoFactorSetup({ visible, onClose }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [step, setStep] = useState(1); // 1=start, 2=verify, 3=backup, 4=disable
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [secret, setSecret] = useState('');
  const [uri, setUri] = useState('');
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState([]);
  const [password, setPassword] = useState('');
  const [showDisable, setShowDisable] = useState(false);
  const [success, setSuccess] = useState('');

  const reset = () => {
    setStep(1);
    setLoading(false);
    setError('');
    setSecret('');
    setUri('');
    setCode('');
    setBackupCodes([]);
    setPassword('');
    setShowDisable(false);
    setSuccess('');
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleEnable2FA = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await api.apiCall('totp_setup', {}, 'POST');
      if (r.success && r.data) {
        setSecret(r.data.secret);
        setUri(r.data.uri);
        setStep(2);
      } else {
        setError(r.message || t('twoFactor.setupError'));
      }
    } catch {
      setError(t('common.networkError'));
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyCode = async () => {
    if (code.length !== 6) {
      setError(t('twoFactor.enterCode'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      const r = await api.apiCall('totp_verify', { code }, 'POST');
      if (r.success && r.data) {
        setBackupCodes(r.data.backup_codes || []);
        setStep(3);
      } else {
        setError(r.message || t('twoFactor.invalidCode'));
      }
    } catch {
      setError(t('common.networkError'));
    } finally {
      setLoading(false);
    }
  };

  const handleDisable2FA = async () => {
    if (!password) {
      setError(t('twoFactor.enterPassword'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      const r = await api.apiCall('totp_disable', { password }, 'POST');
      if (r.success) {
        setSuccess(t('twoFactor.disabledSuccess'));
        setTimeout(() => handleClose(), 1500);
      } else {
        setError(r.message || t('twoFactor.disableError'));
      }
    } catch {
      setError(t('common.networkError'));
    } finally {
      setLoading(false);
    }
  };

  // Format secret in groups of 4 for readability
  const formatSecret = (s) => {
    if (!s) return '';
    return s.match(/.{1,4}/g)?.join(' ') || s;
  };

  const renderStep1 = () => (
    <View style={s.body}>
      <View style={[s.iconCircle, { backgroundColor: colors.primaryLight }]}>
        <IconShield size={32} color={colors.primary} />
      </View>
      <Text style={[s.description, { color: colors.textSecondary }]}>
        {t('twoFactor.description')}
      </Text>
      <TouchableOpacity
        style={[s.primaryBtn, { backgroundColor: colors.primary }]}
        onPress={handleEnable2FA}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <>
            <IconShield size={18} color="#fff" style={{ marginRight: 8 }} />
            <Text style={s.primaryBtnText}>{t('twoFactor.enable')}</Text>
          </>
        )}
      </TouchableOpacity>
      <TouchableOpacity
        style={[s.secondaryBtn, { borderColor: colors.border }]}
        onPress={() => setShowDisable(true)}
      >
        <Text style={[s.secondaryBtnText, { color: colors.textSecondary }]}>{t('twoFactor.disable')}</Text>
      </TouchableOpacity>
    </View>
  );

  const renderStep2 = () => (
    <ScrollView style={s.body} contentContainerStyle={s.bodyContent}>
      <Text style={[s.stepTitle, { color: colors.text }]}>{t('twoFactor.step1Title')}</Text>
      <Text style={[s.description, { color: colors.textSecondary }]}>
        {t('twoFactor.step1Desc')}
      </Text>
      <View style={[s.secretBox, { backgroundColor: colors.surfaceVariant, borderColor: colors.border }]}>
        <IconKey size={16} color={colors.primary} style={{ marginRight: Spacing.sm }} />
        <Text style={[s.secretText, { color: colors.text }]} selectable>
          {formatSecret(secret)}
        </Text>
      </View>
      {uri ? (
        <Text style={[s.uriHint, { color: colors.textTertiary }]}>
          {t('twoFactor.uriHint')}: {uri.substring(0, 40)}...
        </Text>
      ) : null}

      <Text style={[s.stepTitle, { color: colors.text, marginTop: Spacing.xl }]}>{t('twoFactor.step2Title')}</Text>
      <Text style={[s.description, { color: colors.textSecondary }]}>
        {t('twoFactor.step2Desc')}
      </Text>
      <TextInput
        style={[s.codeInput, {
          backgroundColor: colors.surfaceVariant, borderColor: error ? colors.error : colors.border,
          color: colors.text,
        }]}
        value={code}
        onChangeText={(t) => { setCode(t.replace(/[^0-9]/g, '').slice(0, 6)); setError(''); }}
        placeholder="000000"
        placeholderTextColor={colors.textTertiary}
        keyboardType="number-pad"
        maxLength={6}
        textAlign="center"
      />
      <TouchableOpacity
        style={[s.primaryBtn, { backgroundColor: colors.primary }, code.length !== 6 && { opacity: 0.5 }]}
        onPress={handleVerifyCode}
        disabled={loading || code.length !== 6}
      >
        {loading ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <>
            <IconCheck size={18} color="#fff" style={{ marginRight: 8 }} />
            <Text style={s.primaryBtnText}>{t('twoFactor.verify')}</Text>
          </>
        )}
      </TouchableOpacity>
    </ScrollView>
  );

  const renderStep3 = () => (
    <ScrollView style={s.body} contentContainerStyle={s.bodyContent}>
      <View style={[s.iconCircle, { backgroundColor: colors.successBg }]}>
        <IconCheckCircle size={32} color={colors.success} />
      </View>
      <Text style={[s.stepTitle, { color: colors.text, textAlign: 'center' }]}>
        {t('twoFactor.enabledSuccess')}
      </Text>
      <Text style={[s.description, { color: colors.textSecondary }]}>
        {t('twoFactor.backupDesc')}
      </Text>
      <View style={[s.backupBox, { backgroundColor: colors.surfaceVariant, borderColor: colors.border }]}>
        {backupCodes.map((bcode, i) => (
          <Text key={i} style={[s.backupCode, { color: colors.text }]} selectable>
            {bcode}
          </Text>
        ))}
      </View>
      <TouchableOpacity
        style={[s.primaryBtn, { backgroundColor: colors.primary }]}
        onPress={handleClose}
      >
        <Text style={s.primaryBtnText}>{t('twoFactor.done')}</Text>
      </TouchableOpacity>
    </ScrollView>
  );

  const renderDisable = () => (
    <View style={s.body}>
      <Text style={[s.stepTitle, { color: colors.text }]}>{t('twoFactor.disableTitle')}</Text>
      <Text style={[s.description, { color: colors.textSecondary }]}>
        {t('twoFactor.disableDesc')}
      </Text>
      <TextInput
        style={[s.input, {
          backgroundColor: colors.surfaceVariant, borderColor: error ? colors.error : colors.border,
          color: colors.text,
        }]}
        value={password}
        onChangeText={(t) => { setPassword(t); setError(''); }}
        placeholder={t('twoFactor.currentPassword')}
        placeholderTextColor={colors.textTertiary}
        secureTextEntry
      />
      <TouchableOpacity
        style={[s.primaryBtn, { backgroundColor: colors.error }, !password && { opacity: 0.5 }]}
        onPress={handleDisable2FA}
        disabled={loading || !password}
      >
        {loading ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Text style={s.primaryBtnText}>{t('twoFactor.disable')}</Text>
        )}
      </TouchableOpacity>
      <TouchableOpacity
        style={[s.secondaryBtn, { borderColor: colors.border }]}
        onPress={() => { setShowDisable(false); setError(''); setPassword(''); }}
      >
        <Text style={[s.secondaryBtnText, { color: colors.textSecondary }]}>{t('common.cancel')}</Text>
      </TouchableOpacity>
    </View>
  );

  const renderContent = () => {
    if (showDisable) return renderDisable();
    switch (step) {
      case 1: return renderStep1();
      case 2: return renderStep2();
      case 3: return renderStep3();
      default: return renderStep1();
    }
  };

  return (
    <Modal visible={visible} animationType="fade" transparent>
      <TouchableOpacity style={s.overlay} onPress={handleClose} activeOpacity={1}>
        <TouchableOpacity activeOpacity={1} style={[s.modal, Shadow.xl, { backgroundColor: colors.surface }]}>
          <View style={[s.header, { borderBottomColor: colors.borderLight }]}>
            <IconShield size={20} color={colors.primary} style={{ marginRight: Spacing.sm }} />
            <Text style={[s.title, { color: colors.text }]}>{t('twoFactor.title')}</Text>
            <TouchableOpacity onPress={handleClose} style={s.closeBtn}>
              <IconX size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {error ? (
            <View style={[s.errorBox, { backgroundColor: colors.errorBg }]}>
              <Text style={[s.errorText, { color: colors.error }]}>{error}</Text>
            </View>
          ) : null}

          {success ? (
            <View style={[s.successBox, { backgroundColor: colors.successBg }]}>
              <IconCheckCircle size={16} color={colors.success} style={{ marginRight: 6 }} />
              <Text style={[s.successText, { color: colors.success }]}>{success}</Text>
            </View>
          ) : null}

          {renderContent()}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.4)' },
  modal: { borderRadius: BorderRadius.xl, width: '90%', maxWidth: 440, maxHeight: '85%' },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg,
    borderBottomWidth: 1,
  },
  title: { flex: 1, fontSize: FontSize.xxl, fontWeight: '600' },
  closeBtn: { padding: Spacing.sm },
  body: { padding: Spacing.xl },
  bodyContent: { paddingBottom: Spacing.lg },
  // Icon circle
  iconCircle: {
    width: 64, height: 64, borderRadius: 32,
    justifyContent: 'center', alignItems: 'center',
    alignSelf: 'center', marginBottom: Spacing.xl,
  },
  // Text
  stepTitle: { fontSize: FontSize.xl, fontWeight: '600', marginBottom: Spacing.md },
  description: { fontSize: FontSize.base, lineHeight: 22, marginBottom: Spacing.lg },
  // Secret box
  secretBox: {
    flexDirection: 'row', alignItems: 'center',
    padding: Spacing.lg, borderRadius: BorderRadius.md, borderWidth: 1,
    marginBottom: Spacing.md,
  },
  secretText: { fontSize: FontSize.lg, fontWeight: '600', fontFamily: 'monospace', flex: 1, letterSpacing: 2 },
  uriHint: { fontSize: FontSize.xs, marginBottom: Spacing.lg },
  // Code input
  codeInput: {
    fontSize: 28, fontWeight: '700', fontFamily: 'monospace', letterSpacing: 8,
    borderWidth: 1, borderRadius: BorderRadius.md,
    paddingVertical: Spacing.lg, paddingHorizontal: Spacing.xl,
    marginBottom: Spacing.xl,
  },
  // Regular input
  input: {
    fontSize: FontSize.lg, borderWidth: 1, borderRadius: BorderRadius.md,
    paddingVertical: Spacing.md, paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.xl,
  },
  // Backup codes
  backupBox: {
    padding: Spacing.lg, borderRadius: BorderRadius.md, borderWidth: 1,
    marginBottom: Spacing.xl, flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm,
  },
  backupCode: {
    fontSize: FontSize.base, fontWeight: '600', fontFamily: 'monospace',
    width: '45%', paddingVertical: Spacing.xs,
  },
  // Buttons
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderRadius: BorderRadius.md, paddingVertical: 14,
    marginBottom: Spacing.md,
  },
  primaryBtnText: { color: '#fff', fontSize: FontSize.lg, fontWeight: '600' },
  secondaryBtn: {
    alignItems: 'center', justifyContent: 'center',
    borderRadius: BorderRadius.md, borderWidth: 1,
    paddingVertical: 12, marginBottom: Spacing.sm,
  },
  secondaryBtnText: { fontSize: FontSize.base, fontWeight: '500' },
  // Error / Success
  errorBox: {
    marginHorizontal: Spacing.xl, marginTop: Spacing.md,
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.md,
  },
  errorText: { fontSize: FontSize.sm, fontWeight: '500' },
  successBox: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: Spacing.xl, marginTop: Spacing.md,
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.md,
  },
  successText: { fontSize: FontSize.sm, fontWeight: '500' },
});
