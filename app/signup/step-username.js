import { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useSignup } from '../../context/SignupContext';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import StepCard from '../../components/signup/StepCard';
import UsernameChecker from '../../components/signup/UsernameChecker';
import { checkUsername } from '../../services/api';
import { IconAlertTriangle, IconSparkles, IconArrowRight } from '../../components/Icons';

function generateSmartUsername(first, last) {
  const f = (first || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
  const l = (last || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
  if (!f) return '';
  if (!l) return f;
  return `${f}.${l}`;
}

export default function StepUsername() {
  const { data, update, email } = useSignup();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [error, setError] = useState('');
  const [autoSuggested, setAutoSuggested] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (!data.username && !autoSuggested && data.firstName) {
      const suggested = generateSmartUsername(data.firstName, data.lastName);
      if (suggested && suggested.length >= 3) {
        update({ username: suggested, usernameAvailable: null });
        setAutoSuggested(true);
      }
    }
  }, []);

  const handleNext = () => {
    if (!data.username || data.username.length < 3) {
      setError(t('signup.validation.usernameMinLength')); return;
    }
    if (data.username.startsWith('.') || data.username.endsWith('.') || data.username.includes('..')) {
      setError(t('signup.validation.usernameDots')); return;
    }
    if (!/^[a-z0-9._-]{3,30}$/.test(data.username)) {
      setError(t('signup.validation.usernameChars')); return;
    }
    if (data.usernameAvailable === false) {
      setError(t('signup.validation.usernameTaken')); return;
    }
    if (data.usernameAvailable === null) {
      setError(t('signup.validation.usernameChecking')); return;
    }
    setError('');
    router.push('/signup/step-password');
  };

  const handleAvailability = (available, suggestions) => {
    update({ usernameAvailable: available, suggestions });
  };

  return (
    <StepCard step={2} title={t('signup.stepUsername.title')} subtitle={t('signup.stepUsername.subtitle')}>
      {!!error && (
        <View style={[s.errorBox, { backgroundColor: colors.errorBg, borderColor: colors.error + '18' }]}>
          <IconAlertTriangle size={15} color={colors.error} />
          <Text style={[s.errorText, { color: colors.error }]}>{error}</Text>
        </View>
      )}

      <Text style={[s.label, { color: colors.authLabelColor }]}>{t('signup.stepUsername.label')}</Text>
      {autoSuggested && data.username && (
        <View style={[s.autoHint, { backgroundColor: colors.authChipBg, borderColor: colors.authChipBorder }]}>
          <IconSparkles size={12} color={colors.primary} />
          <Text style={[s.autoHintText, { color: colors.primary }]}>{t('signup.stepUsername.suggestedHint')}</Text>
        </View>
      )}
      <UsernameChecker
        value={data.username}
        onChange={v => update({ username: v, usernameAvailable: null })}
        domain={data.domain}
        onAvailabilityChange={handleAvailability}
        checkFn={checkUsername}
        firstName={data.firstName}
        lastName={data.lastName}
      />

      {data.username && data.username.length >= 3 && (
        <View style={[s.preview, { backgroundColor: colors.authChipBg, borderColor: colors.authChipBorder }]}>
          <Text style={[s.previewLabel, { color: colors.textSecondary }]}>{t('signup.stepUsername.preview')}</Text>
          <Text style={[s.previewEmail, { color: colors.primary }]}>{email}</Text>
        </View>
      )}

      <View style={s.btnRow}>
        <TouchableOpacity style={s.backBtn} onPress={() => router.push('/signup/step-name')} activeOpacity={0.6}>
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
  autoHint: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 50, borderWidth: 1,
    alignSelf: 'flex-start', marginBottom: 8,
  },
  autoHintText: { fontSize: 11, fontWeight: '600' },
  preview: {
    marginTop: 18, padding: 16, borderRadius: 14, alignItems: 'center', borderWidth: 1,
    ...Platform.select({
      web: { boxShadow: '0 2px 8px rgba(0,0,0,0.04)' },
      default: {},
    }),
  },
  previewLabel: { fontSize: 11, marginBottom: 4, fontWeight: '500' },
  previewEmail: { fontSize: 17, fontWeight: '800', letterSpacing: -0.3 },
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
