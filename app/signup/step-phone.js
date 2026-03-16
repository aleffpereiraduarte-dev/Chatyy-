import { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Platform, Animated } from 'react-native';
import { useRouter } from 'expo-router';
import { useSignup } from '../../context/SignupContext';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import StepCard from '../../components/signup/StepCard';
import PhoneInput, { COUNTRIES, formatPhone } from '../../components/signup/PhoneInput';
import OtpInput from '../../components/signup/OtpInput';
import { verifySend, verifyCheck } from '../../services/api';
import { IconPhone, IconSend, IconCheckCircle, IconAlertTriangle, IconArrowRight, IconShield } from '../../components/Icons';

export default function StepPhone() {
  const { data, update } = useSignup();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [step, setStep] = useState('input');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingChannel, setLoadingChannel] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [maskedPhone, setMaskedPhone] = useState('');
  const timerRef = useRef(null);
  const router = useRouter();
  const successAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (countdown > 0) {
      timerRef.current = setTimeout(() => setCountdown(countdown - 1), 1000);
    }
    return () => clearTimeout(timerRef.current);
  }, [countdown]);

  useEffect(() => {
    if (step === 'sent') {
      slideAnim.setValue(0);
      Animated.spring(slideAnim, { toValue: 1, tension: 60, friction: 10, useNativeDriver: Platform.OS !== 'web' }).start();
    }
    if (step === 'verified') {
      successAnim.setValue(0);
      Animated.spring(successAnim, { toValue: 1, tension: 50, friction: 8, useNativeDriver: Platform.OS !== 'web' }).start();
    }
  }, [step]);

  const getFullPhone = () => {
    const country = COUNTRIES.find(c => c.code === data.countryCode) || COUNTRIES[0];
    return `${country.dial}${data.phone}`;
  };

  const getFormattedDisplay = () => {
    const country = COUNTRIES.find(c => c.code === data.countryCode) || COUNTRIES[0];
    return `${country.dial} ${formatPhone(data.phone, country.mask)}`;
  };

  const sendCode = async (channel) => {
    const country = COUNTRIES.find(c => c.code === data.countryCode) || COUNTRIES[0];
    const minDigits = Math.max(7, country.maxDigits - 2);
    if (!data.phone || data.phone.length < minDigits) {
      setError(t('signup.validation.invalidPhone')); return;
    }
    setError('');
    setLoading(true);
    setLoadingChannel(channel);
    try {
      const fullPhone = getFullPhone();
      const r = await verifySend(fullPhone, channel);
      if (r.success) {
        setStep('sent');
        setCountdown(60);
        setMaskedPhone(r.masked_phone || getFormattedDisplay());
      } else {
        setError(r.message || t('signup.validation.sendError'));
      }
    } catch { setError(t('signup.validation.connectionError')); }
    finally { setLoading(false); setLoadingChannel(''); }
  };

  // Auto-detect country from browser locale
  useEffect(() => {
    if (Platform.OS === 'web' && !data.phone) {
      try {
        const lang = navigator.language || '';
        const cc = lang.split('-')[1];
        if (cc && COUNTRIES.find(c => c.code === cc)) {
          update({ countryCode: cc });
        }
      } catch {}
    }
  }, []);

  const verifyCode = async (codeToVerify) => {
    const c = codeToVerify || code;
    if (c.length < 6) { setError(t('signup.validation.codeLength')); return; }
    setError('');
    setLoading(true);
    try {
      const fullPhone = getFullPhone();
      const r = await verifyCheck(fullPhone, c);
      if (r.success) {
        update({ phoneVerified: true, verifyToken: r.token });
        setStep('verified');
      } else { setError(r.message || t('signup.validation.invalidCode')); }
    } catch { setError(t('signup.validation.connectionErrorShort')); }
    finally { setLoading(false); }
  };

  const handleCodeChange = (newCode) => {
    setCode(newCode);
    if (newCode.length === 6 && !loading) {
      setTimeout(() => verifyCode(newCode), 300);
    }
  };

  // Countdown display
  const countdownMinutes = Math.floor(countdown / 60);
  const countdownSeconds = countdown % 60;
  const countdownDisplay = countdown > 0
    ? `${countdownMinutes}:${countdownSeconds.toString().padStart(2, '0')}`
    : '';

  return (
    <StepCard step={4} title={t('signup.stepPhone.title')} subtitle={t('signup.stepPhone.subtitle')}>
      {!!error && (
        <View style={[s.errorBox, { backgroundColor: colors.errorBg, borderColor: colors.error + '18' }]}>
          <IconAlertTriangle size={15} color={colors.error} />
          <Text style={[s.errorText, { color: colors.error }]}>{error}</Text>
        </View>
      )}

      {step === 'input' && (
        <>
          <View style={[s.infoBox, { backgroundColor: colors.authChipBg, borderColor: colors.authChipBorder }]}>
            <View style={[s.infoIcon, { backgroundColor: colors.primary + '12' }]}>
              <IconShield size={20} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[s.infoTitle, { color: colors.text }]}>{t('signup.stepPhone.protectTitle')}</Text>
              <Text style={[s.infoText, { color: colors.textSecondary }]}>
                {t('signup.stepPhone.protectText')}
              </Text>
            </View>
          </View>

          <Text style={[s.label, { color: colors.authLabelColor }]}>{t('signup.stepPhone.label')}</Text>
          <PhoneInput
            value={data.phone}
            onChange={v => update({ phone: v })}
            countryCode={data.countryCode}
            onCountryChange={v => update({ countryCode: v })}
          />
          <Text style={[s.hint, { color: colors.textTertiary }]}>
            {t('signup.stepPhone.hint')}
          </Text>

          <TouchableOpacity
            style={[s.sendBtn, { backgroundColor: colors.primary }]}
            onPress={() => sendCode('sms')}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading ? <ActivityIndicator color="#fff" size="small" /> : (
              <>
                <View style={s.channelIconWrap}>
                  <IconPhone size={20} color="#fff" />
                </View>
                <View>
                  <Text style={s.channelText}>{t('signup.stepPhone.sendSms') || 'Enviar código por SMS'}</Text>
                  <Text style={s.channelSub}>{t('signup.stepPhone.sms')}</Text>
                </View>
              </>
            )}
          </TouchableOpacity>
        </>
      )}

      {step === 'sent' && (
        <Animated.View style={{
          opacity: slideAnim,
          transform: [{ translateY: slideAnim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }],
        }}>
          <View style={[s.sentBox, { backgroundColor: colors.successBg || (colors.authSuccessGreen + '0d'), borderColor: colors.authSuccessGreen + '25' }]}>
            <View style={[s.sentIconWrap, { backgroundColor: colors.authSuccessGreen + '18' }]}>
              <IconSend size={18} color={colors.authSuccessGreen} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[s.sentTitle, { color: colors.authSuccessGreen }]}>{t('signup.stepPhone.codeSent')}</Text>
              <Text style={[s.sentText, { color: colors.textSecondary }]}>{maskedPhone}</Text>
            </View>
          </View>

          <Text style={[s.label, { color: colors.authLabelColor }]}>{t('signup.stepPhone.enterCode')}</Text>
          <OtpInput value={code} onChange={handleCodeChange} />

          <TouchableOpacity
            style={[s.verifyBtn, { backgroundColor: colors.primary }, loading && { opacity: 0.65 }]}
            onPress={verifyCode}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <IconCheckCircle size={16} color="#fff" style={{ marginRight: 8 }} />
                <Text style={s.verifyText}>{t('signup.stepPhone.verifyCode')}</Text>
              </>
            )}
          </TouchableOpacity>

          {countdown > 0 ? (
            <View style={s.countdownRow}>
              <View style={[s.countdownCircle, { borderColor: colors.primary + '30' }]}>
                <Text style={[s.countdownNum, { color: colors.primary }]}>{countdownDisplay}</Text>
              </View>
              <Text style={[s.countdownLabel, { color: colors.textTertiary }]}>{t('signup.stepPhone.toResend')}</Text>
            </View>
          ) : (
            <TouchableOpacity
              style={[s.resendBtn, { borderColor: colors.authInputBorder, alignSelf: 'center' }]}
              onPress={() => sendCode('sms')}
              activeOpacity={0.6}
            >
              <IconPhone size={13} color={colors.primary} />
              <Text style={[s.resendText, { color: colors.primary }]}>{t('signup.stepPhone.resendSms') || 'Reenviar SMS'}</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity onPress={() => { setStep('input'); setCode(''); }} activeOpacity={0.6}>
            <Text style={[s.changePhone, { color: colors.textSecondary }]}>{t('signup.stepPhone.changeNumber')}</Text>
          </TouchableOpacity>
        </Animated.View>
      )}

      {step === 'verified' && (
        <Animated.View style={[s.verifiedBox, {
          opacity: successAnim,
          transform: [{ scale: successAnim.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) }],
        }]}>
          <View style={[s.verifiedCircle, { backgroundColor: colors.authSuccessGreen + '10' }]}>
            <View style={[s.verifiedInner, { backgroundColor: colors.authSuccessGreen + '18' }]}>
              <IconCheckCircle size={48} color={colors.authSuccessGreen} />
            </View>
          </View>
          <Text style={[s.verifiedTitle, { color: colors.authSuccessGreen }]}>{t('signup.stepPhone.verified')}</Text>
          <View style={[s.verifiedBadge, { backgroundColor: colors.authChipBg, borderColor: colors.authChipBorder }]}>
            <IconPhone size={13} color={colors.primary} />
            <Text style={[s.verifiedPhone, { color: colors.primary }]}>{getFormattedDisplay()}</Text>
          </View>
        </Animated.View>
      )}

      <View style={s.btnRow}>
        <TouchableOpacity style={s.backBtn} onPress={() => router.push('/signup/step-password')} activeOpacity={0.6}>
          <Text style={[s.backText, { color: colors.primary }]}>{t('signup.back')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.nextBtn, { backgroundColor: step === 'verified' ? colors.primary : colors.textTertiary }]}
          onPress={() => router.push('/signup/step-recovery')}
          disabled={step !== 'verified'}
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

  infoBox: {
    flexDirection: 'row', gap: 14, padding: 16,
    borderRadius: 14, marginTop: 4, marginBottom: 8, borderWidth: 1, alignItems: 'center',
  },
  infoIcon: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  infoTitle: { fontSize: 14, fontWeight: '700', marginBottom: 2 },
  infoText: { fontSize: 12, lineHeight: 17 },

  label: { fontSize: 12, fontWeight: '400', marginBottom: 6, marginTop: 18 },
  hint: { fontSize: 12, marginTop: 10, lineHeight: 17, opacity: 0.7 },

  sendBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 14, paddingVertical: 16, paddingHorizontal: 20, marginTop: 22,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'all 0.2s ease' }, default: {} }),
  },
  channelIconWrap: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center', justifyContent: 'center',
  },
  channelText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  channelSub: { color: 'rgba(255,255,255,0.75)', fontSize: 11, fontWeight: '500', marginTop: 1 },

  sentBox: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 16, borderRadius: 14, marginTop: 8, borderWidth: 1,
  },
  sentIconWrap: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  sentTitle: { fontSize: 14, fontWeight: '700' },
  sentText: { fontSize: 12, marginTop: 2 },

  verifyBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderRadius: 50, paddingVertical: 14, marginTop: 22,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'all 0.2s ease' }, default: {} }),
  },
  verifyText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  countdownRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, marginTop: 18,
  },
  countdownCircle: {
    width: 48, height: 48, borderRadius: 24,
    borderWidth: 2, alignItems: 'center', justifyContent: 'center',
  },
  countdownNum: { fontSize: 14, fontWeight: '700' },
  countdownLabel: { fontSize: 12, fontWeight: '500' },

  resendBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 8, paddingHorizontal: 14, borderRadius: 50, borderWidth: 1,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  resendText: { fontSize: 12, fontWeight: '600' },

  changePhone: {
    textAlign: 'center', fontSize: 12, marginTop: 12,
    textDecorationLine: 'underline',
  },

  verifiedBox: { alignItems: 'center', padding: 28 },
  verifiedCircle: {
    width: 100, height: 100, borderRadius: 50,
    alignItems: 'center', justifyContent: 'center', marginBottom: 16,
  },
  verifiedInner: {
    width: 80, height: 80, borderRadius: 40,
    alignItems: 'center', justifyContent: 'center',
  },
  verifiedTitle: { fontSize: 22, fontWeight: '800', marginBottom: 12 },
  verifiedBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 50, borderWidth: 1,
  },
  verifiedPhone: { fontSize: 14, fontWeight: '600' },

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
