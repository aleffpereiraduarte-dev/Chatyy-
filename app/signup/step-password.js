import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useSignup } from '../../context/SignupContext';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import StepCard from '../../components/signup/StepCard';
import PasswordStrength, { calcStrength } from '../../components/signup/PasswordStrength';
import { IconEye, IconEyeOff, IconAlertTriangle, IconCheckCircle, IconArrowRight } from '../../components/Icons';

export default function StepPassword() {
  const { data, update } = useSignup();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [confirm, setConfirm] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState('');
  const [focused, setFocused] = useState('');
  const router = useRouter();

  const handleNext = () => {
    if (!data.password) { setError(t('signup.validation.passwordRequired')); return; }
    if (data.password.length < 8) { setError(t('signup.validation.passwordMinLength')); return; }
    if (!confirm) { setError(t('signup.validation.confirmRequired')); return; }
    if (data.password !== confirm) { setError(t('signup.validation.passwordsMismatch')); return; }
    const { score } = calcStrength(data.password);
    update({ passwordStrength: score });
    setError('');
    router.push('/signup/step-phone');
  };

  const inputBoxStyle = (name) => [
    s.inputBox,
    {
      backgroundColor: colors.authInputBg,
      borderColor: focused === name ? colors.authInputFocusBorder : colors.authInputBorder,
    },
    focused === name && {
      borderWidth: 2,
      ...Platform.select({ web: { boxShadow: `0 0 0 3px ${colors.authInputFocusGlow}` }, default: {} }),
    },
  ];

  return (
    <StepCard step={3} title={t('signup.stepPassword.title')} subtitle={t('signup.stepPassword.subtitle')}>
      {!!error && (
        <View style={[s.errorBox, { backgroundColor: colors.errorBg, borderColor: colors.error + '18' }]}>
          <IconAlertTriangle size={15} color={colors.error} />
          <Text style={[s.errorText, { color: colors.error }]}>{error}</Text>
        </View>
      )}

      <Text style={[s.label, { color: colors.authLabelColor }]}>{t('signup.stepPassword.label')}</Text>
      <View style={inputBoxStyle('password')}>
        <TextInput
          style={[s.textInput, { color: colors.text }]}
          value={data.password}
          onChangeText={v => update({ password: v })}
          placeholder={t('signup.stepPassword.placeholder')}
          placeholderTextColor={colors.textTertiary}
          secureTextEntry={!showPwd}
          autoFocus
          onFocus={() => setFocused('password')}
          onBlur={() => setFocused('')}
        />
        <TouchableOpacity style={s.eyeBtn} onPress={() => setShowPwd(!showPwd)} activeOpacity={0.6}>
          {showPwd ? <IconEyeOff size={18} color={colors.textSecondary} /> : <IconEye size={18} color={colors.textSecondary} />}
        </TouchableOpacity>
      </View>

      <PasswordStrength password={data.password} />

      <Text style={[s.label, { color: colors.authLabelColor }]}>{t('signup.stepPassword.confirmLabel')}</Text>
      <View style={inputBoxStyle('confirm')}>
        <TextInput
          style={[s.textInput, { color: colors.text }]}
          value={confirm}
          onChangeText={setConfirm}
          placeholder={t('signup.stepPassword.confirmPlaceholder')}
          placeholderTextColor={colors.textTertiary}
          secureTextEntry={!showConfirm}
          onFocus={() => setFocused('confirm')}
          onBlur={() => setFocused('')}
        />
        <TouchableOpacity style={s.eyeBtn} onPress={() => setShowConfirm(!showConfirm)} activeOpacity={0.6}>
          {showConfirm ? <IconEyeOff size={18} color={colors.textSecondary} /> : <IconEye size={18} color={colors.textSecondary} />}
        </TouchableOpacity>
      </View>

      {confirm && data.password !== confirm && (
        <View style={s.matchRow}>
          <IconAlertTriangle size={13} color={colors.error} />
          <Text style={[s.mismatch, { color: colors.error }]}>{t('signup.stepPassword.mismatch')}</Text>
        </View>
      )}
      {confirm && data.password === confirm && confirm.length >= 8 && (
        <View style={s.matchRow}>
          <IconCheckCircle size={13} color={colors.authSuccessGreen} />
          <Text style={[s.match, { color: colors.authSuccessGreen }]}>{t('signup.stepPassword.match')}</Text>
        </View>
      )}

      <View style={s.btnRow}>
        <TouchableOpacity style={s.backBtn} onPress={() => router.push('/signup/step-username')} activeOpacity={0.6}>
          <Text style={[s.backText, { color: colors.primary }]}>{t('signup.back')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.nextBtn, { backgroundColor: colors.primary }]}
          onPress={handleNext}
          activeOpacity={0.85}
        >
          <Text style={s.nextText}>{t('signup.next')}</Text>
          <IconArrowRight size={15} color="#fff" style={{ marginLeft: 6 }} />
        </TouchableOpacity>
      </View>
    </StepCard>
  );
}

const s = StyleSheet.create({
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 12, borderRadius: 12, marginBottom: 16, borderWidth: 1,
  },
  errorText: { fontSize: 13, flex: 1, fontWeight: '500' },
  label: { fontSize: 12, fontWeight: '400', marginBottom: 6, marginTop: 16 },
  inputBox: {
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderRadius: 12,
    ...Platform.select({ web: { transition: 'all 0.2s ease' }, default: {} }),
  },
  textInput: {
    flex: 1, fontSize: 15, paddingVertical: Platform.OS === 'web' ? 16 : 14,
    paddingHorizontal: 18,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  eyeBtn: { padding: 8, marginRight: 4 },
  matchRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6 },
  mismatch: { fontSize: 12, fontWeight: '500' },
  match: { fontSize: 12, fontWeight: '700' },
  btnRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 28 },
  backBtn: {
    paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'background 0.15s ease' }, default: {} }),
  },
  backText: { fontSize: 14, fontWeight: '600' },
  nextBtn: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: 50, paddingVertical: 13, paddingHorizontal: 28,
    ...Platform.select({
      web: {
        cursor: 'pointer', transition: 'all 0.2s ease',
        boxShadow: '0 1px 3px rgba(37,99,235,0.3), 0 4px 12px rgba(37,99,235,0.2)',
      },
      default: {
        shadowColor: '#2563eb', shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.3, shadowRadius: 8, elevation: 4,
      },
    }),
  },
  nextText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
