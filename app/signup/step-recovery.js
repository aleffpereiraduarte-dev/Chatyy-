import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useSignup } from '../../context/SignupContext';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import StepCard from '../../components/signup/StepCard';
import { IconShield, IconAlertTriangle, IconArrowRight } from '../../components/Icons';

const PROVIDER_CHIPS = [
  { label: 'Gmail', suffix: '@gmail.com' },
  { label: 'Outlook', suffix: '@outlook.com' },
  { label: 'Yahoo', suffix: '@yahoo.com' },
];

export default function StepRecovery() {
  const { data, update } = useSignup();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [error, setError] = useState('');
  const [focused, setFocused] = useState(false);
  const router = useRouter();

  const handleNext = () => {
    if (data.recoveryEmail) {
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRe.test(data.recoveryEmail)) { setError(t('signup.validation.invalidEmail')); return; }
      if (data.recoveryEmail.endsWith('@onemundo.com.br') || data.recoveryEmail.endsWith('@superbora.com.br')) {
        setError(t('signup.validation.useExternalEmail')); return;
      }
    }
    setError('');
    router.push('/signup/step-confirm');
  };

  const handleChip = (suffix) => {
    const current = data.recoveryEmail || '';
    const atIdx = current.indexOf('@');
    const localPart = atIdx > 0 ? current.slice(0, atIdx) : current;
    update({ recoveryEmail: localPart + suffix });
  };

  return (
    <StepCard step={5} title={t('signup.stepRecovery.title')} subtitle={t('signup.stepRecovery.subtitle')}>
      {!!error && (
        <View style={[s.errorBox, { backgroundColor: colors.errorBg, borderColor: colors.error + '18' }]}>
          <IconAlertTriangle size={15} color={colors.error} />
          <Text style={[s.errorText, { color: colors.error }]}>{error}</Text>
        </View>
      )}

      <View style={s.hintRow}>
        <IconShield size={16} color={colors.textTertiary} />
        <Text style={[s.hintText, { color: colors.textTertiary }]}>
          {t('signup.stepRecovery.hint')}
        </Text>
      </View>

      <Text style={[s.label, { color: colors.authLabelColor }]}>{t('signup.stepRecovery.label')}</Text>
      <View style={[
        s.inputBox,
        {
          backgroundColor: colors.authInputBg,
          borderColor: focused ? colors.authInputFocusBorder : colors.authInputBorder,
        },
        focused && {
          borderWidth: 2,
          ...Platform.select({ web: { boxShadow: `0 0 0 3px ${colors.authInputFocusGlow}` }, default: {} }),
        },
      ]}>
        <TextInput
          style={[s.textInput, { color: colors.text }]}
          value={data.recoveryEmail}
          onChangeText={v => update({ recoveryEmail: v })}
          placeholder={t('signup.stepRecovery.placeholder')}
          placeholderTextColor={colors.textTertiary}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          autoFocus
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
      </View>

      <View style={s.chipRow}>
        {PROVIDER_CHIPS.map(chip => (
          <TouchableOpacity
            key={chip.label}
            style={[s.chip, { backgroundColor: colors.authChipBg, borderColor: colors.authChipBorder }]}
            onPress={() => handleChip(chip.suffix)}
            activeOpacity={0.7}
          >
            <Text style={[s.chipText, { color: colors.primary }]}>{chip.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={s.btnRow}>
        <TouchableOpacity style={s.backBtn} onPress={() => router.push('/signup/step-phone')} activeOpacity={0.6}>
          <Text style={[s.backText, { color: colors.primary }]}>{t('signup.back')}</Text>
        </TouchableOpacity>
        <View style={s.rightBtns}>
          <TouchableOpacity
            style={s.skipBtn}
            onPress={() => { update({ recoveryEmail: '' }); router.push('/signup/step-confirm'); }}
            activeOpacity={0.7}
          >
            <Text style={[s.skipText, { color: colors.textTertiary }]}>{t('signup.stepRecovery.skip')}</Text>
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
  hintRow: {
    flexDirection: 'row', gap: 10, alignItems: 'flex-start',
    marginTop: 4, marginBottom: 8,
  },
  hintText: { fontSize: 13, lineHeight: 19, flex: 1 },
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
  chipRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  chip: {
    paddingHorizontal: 14, paddingVertical: 7, borderRadius: 50, borderWidth: 1,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'all 0.12s ease' }, default: {} }),
  },
  chipText: { fontSize: 12, fontWeight: '600' },
  btnRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 28 },
  backBtn: { paddingVertical: 10, paddingHorizontal: 16 },
  backText: { fontSize: 14, fontWeight: '600' },
  rightBtns: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  skipBtn: {
    paddingVertical: 11, paddingHorizontal: 12,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  skipText: { fontSize: 13, fontWeight: '500' },
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
