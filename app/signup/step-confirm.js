import { useState, useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Platform, Animated, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useSignup } from '../../context/SignupContext';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import StepCard from '../../components/signup/StepCard';
import { signup as apiSignup } from '../../services/api';
import { IconParty, IconCheckCircle, IconCheck, IconAlertTriangle, IconMail, IconUser, IconPhone, IconShield } from '../../components/Icons';
import { PrivacyModal, TermsModal } from '../../components/LoginModals';

export default function StepConfirm() {
  const { data, update, fullName, email } = useSignup();
  const { login } = useAuth();
  const { colors } = useTheme();
  const { t, language } = useLanguage();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [created, setCreated] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const router = useRouter();
  const successAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (created) {
      Animated.spring(successAnim, { toValue: 1, tension: 50, friction: 8, useNativeDriver: Platform.OS !== 'web' }).start();
    }
  }, [created]);

  const handleCreate = async () => {
    if (!data.agreedTerms) { setError(t('signup.stepConfirm.mustAgree')); return; }
    setError('');
    setLoading(true);
    try {
      const r = await apiSignup(
        data.username, data.password, fullName, data.domain,
        {
          first_name: data.firstName, last_name: data.lastName,
          birthday: data.birthday, gender: data.gender,
          phone: data.phone, verify_token: data.verifyToken,
          recovery_email: data.recoveryEmail, language,
        }
      );
      if (r.success) {
        await login(email, data.password);
        setCreated(true);
        setTimeout(() => router.replace('/inbox'), 2500);
      } else {
        setError(r.message || t('signup.stepConfirm.createError'));
      }
    } catch { setError(t('signup.stepConfirm.connectionError')); }
    finally { setLoading(false); }
  };

  if (created) {
    const scale = successAnim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] });
    return (
      <StepCard step={6} title="" subtitle="">
        <Animated.View style={[s.successBox, { opacity: successAnim, transform: [{ scale }] }]}>
          <View style={[s.successIcon, { backgroundColor: colors.authSuccessGreen + '12' }]}>
            <IconParty size={52} color={colors.authSuccessGreen} />
          </View>
          <Text style={[s.successTitle, { color: colors.authSuccessGreen }]}>{t('signup.stepConfirm.accountCreated')}</Text>
          <View style={[s.successBadge, { backgroundColor: colors.authChipBg, borderColor: colors.authChipBorder }]}>
            <IconMail size={14} color={colors.primary} />
            <Text style={[s.successEmail, { color: colors.primary }]}>{email}</Text>
          </View>
          <Text style={[s.successSub, { color: colors.textSecondary }]}>{t('signup.stepConfirm.redirecting')}</Text>
          <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: 18 }} />
        </Animated.View>
      </StepCard>
    );
  }

  const ReviewRow = ({ icon: Icon, label, value, badge, badgeColor }) => (
    <View style={s.reviewRow}>
      <View style={s.reviewLeft}>
        <View style={[s.reviewIcon, { backgroundColor: colors.primary + '0d' }]}>
          <Icon size={15} color={colors.primary} />
        </View>
        <Text style={[s.reviewLabel, { color: colors.textSecondary }]}>{label}</Text>
      </View>
      {badge ? (
        <View style={[s.badge, { backgroundColor: badgeColor + '12' }]}>
          <Text style={[s.badgeText, { color: badgeColor }]}>{value}</Text>
        </View>
      ) : (
        <Text style={[s.reviewValue, { color: colors.text }]} numberOfLines={1}>{value}</Text>
      )}
    </View>
  );

  return (
    <StepCard step={6} title={t('signup.stepConfirm.title')} subtitle={t('signup.stepConfirm.subtitle')}>
      {!!error && (
        <View style={[s.errorBox, { backgroundColor: colors.errorBg, borderColor: colors.error + '18' }]}>
          <IconAlertTriangle size={15} color={colors.error} />
          <Text style={[s.errorText, { color: colors.error }]}>{error}</Text>
        </View>
      )}

      <View style={[s.reviewCard, {
        backgroundColor: (colors.text === '#f1f5f9') ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.6)',
        borderColor: (colors.text === '#f1f5f9') ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
        ...Platform.select({
          web: {
            boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
          },
          default: {},
        }),
      }]}>
        <ReviewRow icon={IconUser} label={t('signup.stepConfirm.name')} value={fullName} />
        <View style={[s.divider, { backgroundColor: colors.authDividerColor }]} />
        <ReviewRow icon={IconMail} label={t('signup.stepConfirm.email')} value={email} />
        {data.birthday ? (
          <>
            <View style={[s.divider, { backgroundColor: colors.authDividerColor }]} />
            <ReviewRow icon={IconUser} label={t('signup.stepConfirm.birthday')} value={data.birthday} />
          </>
        ) : null}
        <View style={[s.divider, { backgroundColor: colors.authDividerColor }]} />
        <ReviewRow
          icon={IconPhone}
          label={t('signup.stepConfirm.phone')}
          value={data.phoneVerified ? t('signup.stepConfirm.phoneVerified') : (data.phone ? t('signup.stepConfirm.phoneNotVerified') : t('signup.stepConfirm.phoneNotProvided'))}
          badge
          badgeColor={data.phoneVerified ? colors.authSuccessGreen : colors.textTertiary}
        />
        <View style={[s.divider, { backgroundColor: colors.authDividerColor }]} />
        <ReviewRow icon={IconShield} label={t('signup.stepConfirm.recovery')} value={data.recoveryEmail || t('signup.stepConfirm.recoveryNotSet')} />
      </View>

      <View style={s.termsRow}>
        <TouchableOpacity
          onPress={() => update({ agreedTerms: !data.agreedTerms })}
          activeOpacity={0.7}
          style={{ marginTop: 1 }}
        >
          <View style={[
            s.checkbox,
            { borderColor: colors.authInputBorder },
            data.agreedTerms && {
              backgroundColor: colors.primary, borderColor: colors.primary,
              ...Platform.select({ web: { boxShadow: `0 0 0 2px ${colors.primary}20` }, default: {} }),
            },
          ]}>
            {data.agreedTerms && <IconCheck size={13} color="#fff" />}
          </View>
        </TouchableOpacity>
        <Text style={[s.termsText, { color: colors.textSecondary }]}>
          {t('signup.stepConfirm.agreeTerms')}{' '}
          <Text style={[s.termsLink, { color: colors.primary }]} onPress={() => setShowTerms(true)}>{t('signup.stepConfirm.termsOfUse')}</Text>
          {' '}{t('signup.stepConfirm.and')}{' '}
          <Text style={[s.termsLink, { color: colors.primary }]} onPress={() => setShowPrivacy(true)}>{t('signup.stepConfirm.privacyPolicy')}</Text>
        </Text>
      </View>

      <View style={s.btnCol}>
        <TouchableOpacity
          style={[s.createBtn, { backgroundColor: colors.primary }, loading && { opacity: 0.65 }]}
          onPress={handleCreate}
          disabled={loading}
          activeOpacity={0.85}
        >
          {loading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              <IconCheckCircle size={17} color="#fff" style={{ marginRight: 8 }} />
              <Text style={s.createText}>{t('signup.stepConfirm.createAccount')}</Text>
            </>
          )}
        </TouchableOpacity>
        <TouchableOpacity style={s.backBtn} onPress={() => router.push('/signup/step-recovery')} activeOpacity={0.6}>
          <Text style={[s.backText, { color: colors.primary }]}>{t('signup.back')}</Text>
        </TouchableOpacity>
      </View>

      <TermsModal visible={showTerms} onClose={() => setShowTerms(false)} />
      <PrivacyModal visible={showPrivacy} onClose={() => setShowPrivacy(false)} />
    </StepCard>
  );
}

const s = StyleSheet.create({
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 12, borderRadius: 12, marginBottom: 16, borderWidth: 1,
  },
  errorText: { fontSize: 13, flex: 1, fontWeight: '500' },

  reviewCard: {
    borderRadius: 16, padding: 6, marginTop: 6, borderWidth: 1, overflow: 'hidden',
  },
  reviewRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 11, paddingHorizontal: 14,
  },
  reviewLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  reviewIcon: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  reviewLabel: { fontSize: 12, fontWeight: '600' },
  reviewValue: { fontSize: 13, fontWeight: '600', maxWidth: '55%', textAlign: 'right' },
  divider: { height: 1, marginHorizontal: 14 },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 50 },
  badgeText: { fontSize: 11, fontWeight: '700' },

  termsRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 22, paddingHorizontal: 2 },
  checkbox: {
    width: 26, height: 26, borderWidth: 2, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center', marginTop: 1,
    ...Platform.select({ web: { transition: 'all 0.15s ease', cursor: 'pointer' }, default: {} }),
  },
  termsText: { flex: 1, fontSize: 13, lineHeight: 19 },
  termsLink: { fontWeight: '700' },

  btnCol: { marginTop: 24 },
  backBtn: { paddingVertical: 10, alignItems: 'center' },
  backText: { fontSize: 14, fontWeight: '600' },
  createBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderRadius: 50, paddingVertical: 16,
    ...Platform.select({
      web: {
        cursor: 'pointer', transition: 'all 0.2s ease',
        boxShadow: '0 2px 6px rgba(37,99,235,0.35), 0 6px 20px rgba(37,99,235,0.2)',
      },
      default: {
        shadowColor: '#2563eb', shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.35, shadowRadius: 10, elevation: 6,
      },
    }),
  },
  createText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  successBox: { alignItems: 'center', padding: 32 },
  successIcon: { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  successTitle: { fontSize: 24, fontWeight: '800', marginBottom: 16 },
  successBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 50, borderWidth: 1,
  },
  successEmail: { fontSize: 15, fontWeight: '700' },
  successSub: { fontSize: 13, marginTop: 12 },
});
