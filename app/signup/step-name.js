import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useSignup } from '../../context/SignupContext';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import StepCard from '../../components/signup/StepCard';
import { IconAlertTriangle, IconArrowRight } from '../../components/Icons';

export default function StepName() {
  const { data, update } = useSignup();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [error, setError] = useState('');
  const [focused, setFocused] = useState('');
  const router = useRouter();

  const handleNext = () => {
    if (!data.firstName.trim()) { setError(t('signup.validation.firstNameRequired')); return; }
    if (!data.lastName.trim()) { setError(t('signup.validation.lastNameRequired')); return; }
    // Birthday is optional — only validate if the user filled it
    if (data.birthday && data.birthday.replace(/\D/g, '').length > 0) {
      if (data.birthday.replace(/\D/g, '').length < 8) { setError(t('signup.validation.invalidDate') || 'Data inválida'); return; }
      const parts = data.birthday.split('/');
      if (parts.length !== 3 || parts[2].length !== 4) { setError(t('signup.validation.invalidDate')); return; }
      const d = parseInt(parts[0]), m = parseInt(parts[1]) - 1, y = parseInt(parts[2]);
      const date = new Date(y, m, d);
      if (isNaN(date.getTime()) || date.getDate() !== d) { setError(t('signup.validation.invalidDateShort')); return; }
      const age = (Date.now() - date.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
      if (age < 13) { setError(t('signup.validation.minAge')); return; }
    }
    setError('');
    router.push('/signup/step-username');
  };

  const [birthdayHint, setBirthdayHint] = useState('');
  const [birthdayHintError, setBirthdayHintError] = useState(false);

  const maskBirthday = (text) => {
    let digits = text.replace(/\D/g, '').slice(0, 8);
    if (digits.length > 4) digits = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
    else if (digits.length > 2) digits = `${digits.slice(0, 2)}/${digits.slice(2)}`;
    update({ birthday: digits });

    const raw = text.replace(/\D/g, '');
    if (raw.length >= 2) {
      const day = parseInt(raw.slice(0, 2));
      if (day < 1 || day > 31) { setBirthdayHint(t('signup.validation.invalidDay')); setBirthdayHintError(true); return; }
    }
    if (raw.length >= 4) {
      const month = parseInt(raw.slice(2, 4));
      if (month < 1 || month > 12) { setBirthdayHint(t('signup.validation.invalidMonth')); setBirthdayHintError(true); return; }
    }
    if (raw.length === 8) {
      const d = parseInt(raw.slice(0, 2)), m = parseInt(raw.slice(2, 4)) - 1, y = parseInt(raw.slice(4, 8));
      const date = new Date(y, m, d);
      if (y < 1920 || y > new Date().getFullYear()) { setBirthdayHint(t('signup.validation.invalidYear')); setBirthdayHintError(true); return; }
      if (isNaN(date.getTime()) || date.getDate() !== d) { setBirthdayHint(t('signup.validation.dateNotExist')); setBirthdayHintError(true); return; }
      const age = Math.floor((Date.now() - date.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
      if (age < 13) { setBirthdayHint(t('signup.validation.minAgeShort')); setBirthdayHintError(true); return; }
      setBirthdayHint(t('signup.stepName.years', { n: age }));
      setBirthdayHintError(false);
      return;
    }
    setBirthdayHint('');
    setBirthdayHintError(false);
  };

  const isDark = colors.background === '#0c1220' || colors.text === '#f1f5f9';

  const inputBoxStyle = (name) => [
    s.inputBox,
    {
      backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.6)',
      borderColor: focused === name ? colors.authInputFocusBorder : (isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'),
    },
    focused === name && {
      borderWidth: 2,
      ...Platform.select({ web: {
        boxShadow: `0 0 0 3px ${colors.authInputFocusGlow}, 0 2px 8px ${colors.primary}10`,
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }, default: {} }),
    },
  ];

  return (
    <StepCard step={1} title={t('signup.stepName.title')} subtitle={t('signup.stepName.subtitle')}>
      {!!error && (
        <View style={[s.errorBox, { backgroundColor: colors.errorBg, borderColor: colors.error + '18' }]}>
          <IconAlertTriangle size={15} color={colors.error} />
          <Text style={[s.errorText, { color: colors.error }]}>{error}</Text>
        </View>
      )}

      <View style={s.row}>
        <View style={s.half}>
          <Text style={[s.label, { color: colors.authLabelColor }]}>{t('signup.stepName.firstName')}</Text>
          <View style={inputBoxStyle('firstName')}>
            <TextInput
              style={[s.textInput, { color: colors.text }]}
              value={data.firstName}
              onChangeText={v => update({ firstName: v })}
              placeholder={t('signup.stepName.firstNamePlaceholder')}
              placeholderTextColor={colors.textTertiary}
              autoFocus
              autoComplete="given-name"
              onFocus={() => setFocused('firstName')}
              onBlur={() => setFocused('')}
            />
          </View>
        </View>
        <View style={s.half}>
          <Text style={[s.label, { color: colors.authLabelColor }]}>{t('signup.stepName.lastName')}</Text>
          <View style={inputBoxStyle('lastName')}>
            <TextInput
              style={[s.textInput, { color: colors.text }]}
              value={data.lastName}
              onChangeText={v => update({ lastName: v })}
              placeholder={t('signup.stepName.lastNamePlaceholder')}
              placeholderTextColor={colors.textTertiary}
              autoComplete="family-name"
              onFocus={() => setFocused('lastName')}
              onBlur={() => setFocused('')}
            />
          </View>
        </View>
      </View>

      <Text style={[s.label, { color: colors.authLabelColor }]}>{t('signup.stepName.birthday')}</Text>
      <View style={inputBoxStyle('birthday')}>
        <TextInput
          style={[s.textInput, { color: colors.text }]}
          value={data.birthday}
          onChangeText={maskBirthday}
          placeholder={t('signup.stepName.birthdayPlaceholder')}
          placeholderTextColor={colors.textTertiary}
          keyboardType="number-pad"
          maxLength={10}
          onFocus={() => setFocused('birthday')}
          onBlur={() => setFocused('')}
        />
      </View>
      {!!birthdayHint && (
        <Text style={[s.hint, {
          color: birthdayHintError ? colors.error : colors.authSuccessGreen
        }]}>{birthdayHint}</Text>
      )}

      <Text style={[s.label, { color: colors.authLabelColor }]}>{t('signup.stepName.gender')}</Text>
      <View style={s.genderRow}>
        {[
          { value: '', label: t('signup.stepName.genderPreferNot') },
          { value: 'male', label: t('signup.stepName.genderMale') },
          { value: 'female', label: t('signup.stepName.genderFemale') },
          { value: 'other', label: t('signup.stepName.genderOther') },
        ].map(g => (
          <TouchableOpacity
            key={g.value}
            style={[
              s.genderBtn,
              { borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)', backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.5)' },
              data.gender === g.value && {
                borderColor: colors.primary,
                backgroundColor: colors.authChipBg,
                ...Platform.select({ web: { boxShadow: `0 0 0 2px ${colors.primary}15` }, default: {} }),
              },
            ]}
            onPress={() => update({ gender: g.value })}
            activeOpacity={0.7}
          >
            <Text style={[
              s.genderText,
              { color: colors.textSecondary },
              data.gender === g.value && { color: colors.primary, fontWeight: '700' },
            ]}>
              {g.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={s.btnRow}>
        <TouchableOpacity style={s.backBtn} onPress={() => router.replace('/login')} activeOpacity={0.6}>
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
  row: { flexDirection: 'row', gap: 10, marginTop: 4 },
  half: { flex: 1 },
  label: { fontSize: 12, fontWeight: '400', marginBottom: 6, marginTop: 16 },
  inputBox: {
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderRadius: 12,
    ...Platform.select({ web: { transition: 'all 0.2s ease', minWidth: 0 }, default: {} }),
  },
  textInput: {
    flex: 1, fontSize: 15, paddingVertical: Platform.OS === 'web' ? 16 : 14,
    paddingHorizontal: 18,
    ...Platform.select({ web: { outlineStyle: 'none', minWidth: 0, width: '100%' }, default: {} }),
  },
  genderRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  genderBtn: {
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 50,
    borderWidth: 1.5,
    ...Platform.select({ web: { transition: 'all 0.15s ease', cursor: 'pointer' }, default: {} }),
  },
  genderText: { fontSize: 13, fontWeight: '500' },
  hint: { fontSize: 11, marginTop: 5, fontWeight: '600' },
  btnRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 28 },
  backBtn: {
    paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'background 0.15s ease' }, default: {} }),
  },
  backText: { fontSize: 14, fontWeight: '600' },
  nextBtn: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: 50, paddingVertical: 13, paddingHorizontal: 32,
    ...Platform.select({
      web: {
        cursor: 'pointer', transition: 'all 0.3s ease',
        boxShadow: '0 2px 8px rgba(37,99,235,0.3), 0 8px 24px rgba(37,99,235,0.2)',
      },
      default: {
        shadowColor: '#2563eb', shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.35, shadowRadius: 12, elevation: 6,
      },
    }),
  },
  nextText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
