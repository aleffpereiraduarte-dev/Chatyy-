import { useState } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Modal, ActivityIndicator } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { IconX, IconLock, IconCheckCircle, IconEye, IconEyeOff } from './Icons';
import * as api from '../services/api';

export default function ChangePasswordModal({ visible, onClose }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const reset = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setShowCurrent(false);
    setShowNew(false);
    setShowConfirm(false);
    setLoading(false);
    setError('');
    setSuccess(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const validate = () => {
    if (!currentPassword) {
      setError(t('changePassword.enterCurrent'));
      return false;
    }
    if (newPassword.length < 6) {
      setError(t('changePassword.minLength'));
      return false;
    }
    if (newPassword !== confirmPassword) {
      setError(t('changePassword.mismatch'));
      return false;
    }
    if (currentPassword === newPassword) {
      setError(t('changePassword.mustDiffer'));
      return false;
    }
    return true;
  };

  const handleSubmit = async () => {
    setError('');
    if (!validate()) return;

    setLoading(true);
    try {
      const r = await api.apiCall('change_password', {
        current_password: currentPassword,
        new_password: newPassword,
      }, 'POST');
      if (r.success) {
        setSuccess(true);
        setTimeout(() => handleClose(), 2000);
      } else {
        setError(r.message || t('changePassword.error'));
      }
    } catch {
      setError(t('common.networkError'));
    } finally {
      setLoading(false);
    }
  };

  const renderPasswordField = (label, value, onChange, show, onToggleShow, placeholder, accessibilityLabel) => (
    <View style={s.field}>
      <Text style={[s.label, { color: colors.textSecondary }]}>{label}</Text>
      <View style={[s.inputRow, { backgroundColor: colors.surfaceVariant, borderColor: error && !value ? colors.error : colors.border }]}>
        <TextInput
          style={[s.input, { color: colors.text }]}
          value={value}
          onChangeText={(t) => { onChange(t); setError(''); }}
          placeholder={placeholder}
          placeholderTextColor={colors.textTertiary}
          secureTextEntry={!show}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={accessibilityLabel || label}
        />
        <TouchableOpacity onPress={onToggleShow} style={s.eyeBtn}>
          {show ? (
            <IconEyeOff size={18} color={colors.textTertiary} />
          ) : (
            <IconEye size={18} color={colors.textTertiary} />
          )}
        </TouchableOpacity>
      </View>
    </View>
  );

  // Password strength indicator
  const getStrength = () => {
    if (!newPassword) return { level: 0, label: '', color: colors.textTertiary };
    if (newPassword.length < 6) return { level: 1, label: t('signup.password.weak'), color: colors.error };
    const hasUpper = /[A-Z]/.test(newPassword);
    const hasLower = /[a-z]/.test(newPassword);
    const hasNumber = /[0-9]/.test(newPassword);
    const hasSpecial = /[^A-Za-z0-9]/.test(newPassword);
    const score = [hasUpper, hasLower, hasNumber, hasSpecial, newPassword.length >= 8].filter(Boolean).length;
    if (score <= 2) return { level: 1, label: t('signup.password.weak'), color: colors.error };
    if (score <= 3) return { level: 2, label: t('signup.password.fair'), color: colors.warning };
    return { level: 3, label: t('signup.password.strong'), color: colors.success };
  };

  const strength = getStrength();

  return (
    <Modal visible={visible} animationType="fade" transparent>
      <TouchableOpacity style={s.overlay} onPress={handleClose} activeOpacity={1}>
        <TouchableOpacity activeOpacity={1} style={[s.modal, Shadow.xl, { backgroundColor: colors.surface }]}>
          <View style={[s.header, { borderBottomColor: colors.borderLight }]}>
            <IconLock size={20} color={colors.primary} style={{ marginRight: Spacing.sm }} />
            <Text style={[s.title, { color: colors.text }]}>{t('changePassword.title')}</Text>
            <TouchableOpacity onPress={handleClose} style={s.closeBtn}>
              <IconX size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {success ? (
            <View style={s.successContainer}>
              <View style={[s.iconCircle, { backgroundColor: colors.successBg }]}>
                <IconCheckCircle size={32} color={colors.success} />
              </View>
              <Text style={[s.successTitle, { color: colors.text }]}>{t('changePassword.success')}</Text>
              <Text style={[s.successDesc, { color: colors.textSecondary }]}>
                {t('changePassword.successDesc')}
              </Text>
            </View>
          ) : (
            <View style={s.body}>
              {error ? (
                <View style={[s.errorBox, { backgroundColor: colors.errorBg }]}>
                  <Text style={[s.errorText, { color: colors.error }]}>{error}</Text>
                </View>
              ) : null}

              {renderPasswordField(
                t('changePassword.currentPassword'), currentPassword, setCurrentPassword,
                showCurrent, () => setShowCurrent(!showCurrent), t('changePassword.enterCurrentPlaceholder'),
                t('changePassword.currentPassword') || 'Senha atual'
              )}

              {renderPasswordField(
                t('changePassword.newPassword'), newPassword, setNewPassword,
                showNew, () => setShowNew(!showNew), t('changePassword.minLengthPlaceholder'),
                t('changePassword.newPassword') || 'Nova senha'
              )}

              {/* Strength indicator */}
              {newPassword.length > 0 && (
                <View style={s.strengthRow}>
                  <View style={s.strengthBars}>
                    {[1, 2, 3].map((level) => (
                      <View
                        key={level}
                        style={[
                          s.strengthBar,
                          { backgroundColor: level <= strength.level ? strength.color : colors.borderLight },
                        ]}
                      />
                    ))}
                  </View>
                  <Text style={[s.strengthLabel, { color: strength.color }]}>{strength.label}</Text>
                </View>
              )}

              {renderPasswordField(
                t('changePassword.confirmPassword'), confirmPassword, setConfirmPassword,
                showConfirm, () => setShowConfirm(!showConfirm), t('changePassword.repeatPassword'),
                t('changePassword.confirmPassword') || 'Confirmar nova senha'
              )}

              <TouchableOpacity
                style={[s.submitBtn, { backgroundColor: colors.primary },
                  (!currentPassword || !newPassword || !confirmPassword) && { opacity: 0.5 }]}
                onPress={handleSubmit}
                disabled={loading || !currentPassword || !newPassword || !confirmPassword}
              >
                {loading ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={s.submitBtnText}>{t('changePassword.submit')}</Text>
                )}
              </TouchableOpacity>
            </View>
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.4)' },
  modal: { borderRadius: BorderRadius.xl, width: '90%', maxWidth: 420 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg,
    borderBottomWidth: 1,
  },
  title: { flex: 1, fontSize: FontSize.xxl, fontWeight: '600' },
  closeBtn: { padding: Spacing.sm },
  body: { padding: Spacing.xl },
  // Field
  field: { marginBottom: Spacing.lg },
  label: { fontSize: FontSize.sm, fontWeight: '600', marginBottom: Spacing.sm, textTransform: 'uppercase', letterSpacing: 0.5 },
  inputRow: {
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderRadius: BorderRadius.md, overflow: 'hidden',
  },
  input: {
    flex: 1, fontSize: FontSize.base,
    paddingVertical: Spacing.md, paddingHorizontal: Spacing.lg,
  },
  eyeBtn: { padding: Spacing.md },
  // Strength
  strengthRow: { flexDirection: 'row', alignItems: 'center', marginTop: -Spacing.sm, marginBottom: Spacing.md },
  strengthBars: { flexDirection: 'row', gap: 4, flex: 1 },
  strengthBar: { height: 4, flex: 1, borderRadius: 2 },
  strengthLabel: { fontSize: FontSize.xs, fontWeight: '600', marginLeft: Spacing.sm },
  // Submit
  submitBtn: {
    alignItems: 'center', justifyContent: 'center',
    borderRadius: BorderRadius.md, paddingVertical: 14,
    marginTop: Spacing.sm,
  },
  submitBtnText: { color: '#fff', fontSize: FontSize.lg, fontWeight: '600' },
  // Error
  errorBox: {
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.md, marginBottom: Spacing.lg,
  },
  errorText: { fontSize: FontSize.sm, fontWeight: '500' },
  // Success
  successContainer: { padding: Spacing.xxxl, alignItems: 'center' },
  iconCircle: {
    width: 64, height: 64, borderRadius: 32,
    justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.xl,
  },
  successTitle: { fontSize: FontSize.xxl, fontWeight: '600', marginBottom: Spacing.sm },
  successDesc: { fontSize: FontSize.base, textAlign: 'center' },
});
