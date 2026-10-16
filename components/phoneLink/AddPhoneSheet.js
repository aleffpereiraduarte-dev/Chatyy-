// [phone-obrigatorio 2026-10-15] "Adicione seu número" — folha P&B premium p/ conta antiga sem telefone.
//   número (país + campo, igual ao onboarding nativo) → código (OtpCells) → pronto.
// Endpoints: phone_link_precheck (número já tem dono? avisa ANTES de gastar SMS) → verify_send →
// verify_check (verify_token) → phone_link. Mesmas regras do cadastro (60 s entre envios, 5/h,
// 5 erros = trava). "Agora não" adia PHONE_LINK_SNOOZE_DAYS; required = sem "Agora não".
// Overlay absoluto (não <Modal>) como o aviso de Termos; o seletor de país é Modal próprio.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet, Platform, ActivityIndicator, Keyboard,
  KeyboardAvoidingView, BackHandler, ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Localization from 'expo-localization';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import * as api from '../../services/api';
import { snoozePhoneLink, markPhoneLinked, PHONE_LINK_SNOOZE_DAYS } from '../../services/phoneLink';
import { COUNTRIES, formatPhone, toE164, E164_RE, countryDisplayName } from '../../constants/countries';
import { parsePhoneInput, friendlyServerError } from '../signup/signupSmarts';
import { selection as hSelection, success as hSuccess, error as hError } from '../../services/haptics';
import { IconX, IconCheck, IconChevronDown, IconSmartphone, IconArrowLeft } from '../Icons';
import CountryPicker from '../nativeOnboarding/CountryPicker';
import FlagIcon from '../nativeOnboarding/FlagIcon';
import OtpCells from '../nativeOnboarding/OtpCells';
import { fitPhoneFontSize, textEm } from '../nativeOnboarding/phoneFit';

function _deviceRegion() {
  try { return Localization.getLocales?.()[0]?.regionCode || Localization.region || 'BR'; } catch { return 'BR'; }
}

export default function AddPhoneSheet({ email, required = false, snoozeDays = PHONE_LINK_SNOOZE_DAYS, onDone }) {
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();
  const insets = useSafeAreaInsets();
  const fg = colors.text;
  const sub = colors.textSecondary;
  const bg = colors.surface || colors.background;

  const [step, setStep] = useState('phone'); // phone | otp | done
  const [countryCode, setCountryCode] = useState(() => {
    const r = String(_deviceRegion() || 'BR').toUpperCase();
    return COUNTRIES.some((c) => c.code === r) ? r : 'BR';
  });
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [showCountry, setShowCountry] = useState(false);
  const [errTick, setErrTick] = useState(0);
  const [rowW, setRowW] = useState(0); // [2026-10-16 onb-phone-fit]
  const otpRef = useRef(null);
  const aliveRef = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const country = useMemo(() => COUNTRIES.find((c) => c.code === countryCode) || COUNTRIES[0], [countryCode]);
  const digits = phone.replace(/\D/g, '');
  const fullPhone = useMemo(() => toE164(country.dial, phone), [country, phone]);
  const minDigits = Math.max(8, (country.maxDigits || 11) - 1);
  const phoneValid = digits.length >= minDigits && E164_RE.test(fullPhone);
  // [2026-10-16 onb-phone-fit] fonte que sempre cabe (prefixo + máscara na mesma linha de base).
  const phoneShown = formatPhone(digits, country.mask);
  const phoneFs = fitPhoneFontSize(rowW ? rowW - 58 : 0, [country.dial + (country.mask || '').replace(/#/g, '0'), country.dial + phoneShown], { max: 22, min: 16 });
  const dialW = Math.ceil(phoneFs * textEm(country.dial) * 1.08) + 2;
  const phoneLh = Math.round(phoneFs * 1.25);
  const pretty = `${country.dial} ${formatPhone(digits, country.mask)}`.trim();

  useEffect(() => {
    if (countdown <= 0) return undefined;
    const id = setTimeout(() => setCountdown((x) => Math.max(0, x - 1)), 1000);
    return () => clearTimeout(id);
  }, [countdown]);

  const close = useCallback(async (snooze) => {
    try { Keyboard.dismiss(); } catch {}
    if (snooze) { try { await snoozePhoneLink(email, snoozeDays); } catch {} }
    onDone && onDone();
  }, [email, snoozeDays, onDone]);

  // Voltar do Android: no código volta p/ o número; no número = "Agora não" (se permitido).
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const s = BackHandler.addEventListener('hardwareBackPress', () => {
      if (step === 'otp') { setStep('phone'); setCode(''); setError(''); return true; }
      if (!required && step === 'phone') { close(true); return true; }
      return true;
    });
    return () => s.remove();
  }, [step, required, close]);

  const reasonText = useCallback((r, fallbackKey) => {
    const reason = r?.data?.reason;
    if (reason === 'phone_taken') return t('phoneLink.taken');
    if (reason === 'already_has_phone') return t('phoneLink.alreadyHas');
    if (reason === 'expired') return t('phoneLink.expired');
    const f = friendlyServerError(r, fallbackKey);
    if (f.kind === 'rate' && f.seconds) { setCountdown(f.seconds); return t('otp.waitSeconds', { s: f.seconds }); }
    return f.text || t(f.key);
  }, [t]);

  const sendCode = useCallback(async () => {
    if (!phoneValid || busy) return;
    setError(''); setBusy(true);
    try {
      const pre = await api.phoneLinkPrecheck(fullPhone);
      if (!aliveRef.current) return;
      if (!pre?.success) { setError(reasonText(pre, 'phoneLink.error')); try { hError(); } catch {} return; }
      const r = await api.verifySend(fullPhone, 'sms');
      if (!aliveRef.current) return;
      if (r?.success) {
        setCountdown(60); setCode(''); setStep('otp');
        try { hSelection(); } catch {}
      } else {
        setError(reasonText(r, 'signupPhone.sendError'));
      }
    } catch {
      if (aliveRef.current) setError(t('login.errorConnection'));
    } finally { if (aliveRef.current) setBusy(false); }
  }, [phoneValid, busy, fullPhone, reasonText, t]);

  const checkCode = useCallback(async (cd) => {
    const c6 = typeof cd === 'string' ? cd : code;
    if (c6.length !== 6 || inFlight.current) return;
    inFlight.current = true; setError(''); setBusy(true);
    const bad = (msg) => {
      setError(msg); setCode(''); setErrTick((x) => x + 1);
      try { hError(); } catch {}
      setTimeout(() => { try { otpRef.current?.focus(); } catch {} }, 260);
    };
    try {
      const v = await api.verifyCheck(fullPhone, c6);
      if (!aliveRef.current) return;
      const tok = v?.success ? (v?.data?.token || '') : '';
      if (!tok) {
        const f = friendlyServerError(v, 'signupPhone.otpInvalid');
        if (f.kind === 'network') setError(t('login.errorConnection'));
        else if (f.kind === 'otp_expired' || f.kind === 'otp_locked') { bad(t(f.key)); setCountdown(0); }
        else bad(t('signupPhone.otpInvalid'));
        return;
      }
      const l = await api.phoneLink(tok);
      if (!aliveRef.current) return;
      if (l?.success) {
        try { hSuccess(); } catch {}
        try { await markPhoneLinked(email); } catch {}
        setStep('done');
        setTimeout(() => { if (aliveRef.current) close(false); }, 1400);
      } else {
        const reason = l?.data?.reason;
        if (reason === 'phone_taken' || reason === 'already_has_phone') { setStep('phone'); setCode(''); }
        bad(reasonText(l, 'phoneLink.error'));
      }
    } catch {
      if (aliveRef.current) setError(t('login.errorConnection'));
    } finally {
      inFlight.current = false;
      if (aliveRef.current) setBusy(false);
    }
  }, [code, fullPhone, email, close, reasonText, t]);

  const primary = (label, onPress, disabled, testID) => (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [st.cta, { backgroundColor: fg, opacity: disabled ? 0.3 : (pressed ? 0.85 : 1) }]}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled, busy }}
      testID={testID}
    >
      {busy ? <ActivityIndicator color={colors.background} />
        : <Text style={[st.ctaText, { color: colors.background }]} maxFontSizeMultiplier={1.3}>{label}</Text>}
    </Pressable>
  );

  let body;
  if (step === 'done') {
    body = (
      <View style={st.doneWrap} accessibilityLiveRegion="polite">
        <View style={[st.icon, st.iconLg, { backgroundColor: fg }]}>
          <IconCheck size={30} color={colors.background} strokeWidth={2.8} />
        </View>
        <Text style={[st.title, st.center, { color: fg }]} accessibilityRole="header">{t('phoneLink.done')}</Text>
        <Text style={[st.body, st.center, { color: sub }]}>{pretty}</Text>
      </View>
    );
  } else if (step === 'otp') {
    body = (
      <>
        <Pressable onPress={() => { setStep('phone'); setCode(''); setError(''); }} hitSlop={10} style={st.back} accessibilityRole="button" accessibilityLabel={t('phoneLink.changeNumber')}>
          <IconArrowLeft size={22} color={fg} />
        </Pressable>
        <Text style={[st.title, { color: fg }]} accessibilityRole="header">{t('phoneLink.codeTitle')}</Text>
        <Text style={[st.body, { color: sub }]}>{t('phoneLink.codeSent', { phone: pretty })}</Text>
        <OtpCells
          ref={otpRef}
          value={code}
          onChange={(d) => { setCode(d); if (error) setError(''); }}
          onComplete={(d) => checkCode(d)}
          colors={colors}
          errorTick={errTick}
          disabled={busy}
          accessibilityLabel={t('phoneLink.codeTitle')}
          testID="addphone-otp"
        />
        {error ? <Text style={[st.err, { color: fg }]} accessibilityLiveRegion="assertive">{error}</Text> : null}
        {busy ? <ActivityIndicator color={fg} style={{ marginTop: 12 }} /> : null}
        <Pressable
          onPress={countdown > 0 || busy ? undefined : sendCode}
          disabled={countdown > 0 || busy}
          style={st.link}
          accessibilityRole="button"
          testID="addphone-resend"
        >
          <Text style={[st.linkText, { color: countdown > 0 ? (colors.textTertiary || sub) : fg }]}>
            {countdown > 0 ? t('phoneLink.resendIn', { s: countdown }) : t('phoneLink.resend')}
          </Text>
        </Pressable>
      </>
    );
  } else {
    body = (
      <>
        <View style={[st.icon, { backgroundColor: fg + '14' }]}>
          <IconSmartphone size={24} color={fg} />
        </View>
        <Text style={[st.title, { color: fg }]} accessibilityRole="header">{t('phoneLink.title')}</Text>
        <Text style={[st.body, { color: sub }]}>{required ? t('phoneLink.bodyRequired') : t('phoneLink.body')}</Text>
        <Pressable
          onPress={() => { Keyboard.dismiss(); setShowCountry(true); }}
          style={({ pressed }) => [st.countryRow, { borderBottomColor: colors.border, opacity: pressed ? 0.7 : 1 }]}
          accessibilityRole="button"
          accessibilityLabel={`${countryDisplayName(country, language, t)} ${country.dial}`}
          testID="addphone-country"
        >
          <FlagIcon code={country.code} width={28} borderColor={colors.border} textColor={fg} />
          <Text style={[st.countryName, { color: fg }]} numberOfLines={1}>{countryDisplayName(country, language, t)}</Text>
          <IconChevronDown size={18} color={sub} />
        </Pressable>
        <View
          style={[st.phoneRow, { borderBottomColor: phoneValid ? fg : colors.border }]}
          onLayout={(e) => { const w = Math.round(e.nativeEvent.layout.width); if (w && w !== rowW) setRowW(w); }}
        >
          <Text style={[st.dial, { color: fg, fontSize: phoneFs, lineHeight: phoneLh, width: dialW }]} numberOfLines={1} maxFontSizeMultiplier={1} importantForAccessibility="no">{country.dial}</Text>
          <View style={[st.vline, { backgroundColor: colors.border }]} />
          <TextInput
            value={phoneShown}
            onChangeText={(text) => {
              const p = parsePhoneInput(text, countryCode, COUNTRIES);
              if (p.countryCode !== countryCode) setCountryCode(p.countryCode);
              setPhone(p.digits);
              if (error) setError('');
            }}
            placeholder={(country.mask || '').replace(/#/g, '0')}
            placeholderTextColor={colors.textTertiary}
            keyboardType="phone-pad"
            inputMode="tel"
            textContentType="telephoneNumber"
            autoComplete="tel"
            // [2026-10-16] sem returnKeyType (iOS 26 desenhava "Go" flutuante no phone-pad).
            onSubmitEditing={Platform.OS === 'web' ? sendCode : undefined}
            editable={!busy}
            style={[st.phoneInput, { color: fg, fontSize: phoneFs, height: phoneLh + 16 }, Platform.OS === 'web' ? { outlineStyle: 'none', lineHeight: phoneLh } : null]}
            accessibilityLabel={`${t('phoneLink.title')} ${country.dial}`}
            maxFontSizeMultiplier={1}
            testID="addphone-phone"
          />
          <View style={st.phoneCheck}>{phoneValid ? <IconCheck size={20} color={fg} strokeWidth={2.6} /> : null}</View>
        </View>
        <Text style={[st.hint, { color: sub }]}>{t('phoneLink.hint')}</Text>
        {error ? <Text style={[st.err, { color: fg }]} accessibilityLiveRegion="assertive" testID="addphone-error">{error}</Text> : null}
        {primary(t('phoneLink.send'), sendCode, !phoneValid || busy, 'addphone-send')}
        {!required ? (
          <Pressable onPress={() => close(true)} style={st.link} accessibilityRole="button" testID="addphone-notnow">
            <Text style={[st.linkText, { color: sub }]}>{t('phoneLink.notNow')}</Text>
          </Pressable>
        ) : null}
      </>
    );
  }

  return (
    <View style={[StyleSheet.absoluteFill, st.backdrop]} accessibilityViewIsModal testID="addphone-sheet">
      <Pressable style={StyleSheet.absoluteFill} onPress={() => { if (!required && step === 'phone' && !busy) close(true); }} accessible={false} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={st.kav} pointerEvents="box-none">
        <View style={[st.card, {
          backgroundColor: bg,
          marginBottom: Math.max(insets.bottom, 16),
          marginTop: insets.top + 24,
          borderColor: isDark ? 'rgba(255,255,255,0.10)' : 'transparent',
        }]}>
          {!required && step === 'phone' ? (
            <Pressable onPress={() => close(true)} style={st.close} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('phoneLink.notNow')}>
              <IconX size={20} color={sub} />
            </Pressable>
          ) : null}
          <ScrollView contentContainerStyle={st.content} bounces={false} keyboardShouldPersistTaps="handled">
            {body}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
      <CountryPicker
        visible={showCountry}
        onClose={() => setShowCountry(false)}
        onSelect={(c) => { setCountryCode(c); setShowCountry(false); setError(''); }}
        selected={countryCode}
        suggested={[_deviceRegion(), 'BR', 'US', 'PT']}
        colors={colors}
        t={t}
        language={language}
      />
    </View>
  );
}

const st = StyleSheet.create({
  backdrop: { zIndex: 9100, elevation: 31, backgroundColor: 'rgba(0,0,0,0.5)' },
  kav: { flex: 1, justifyContent: 'flex-end', alignItems: 'center', paddingHorizontal: 12 },
  card: { width: '100%', maxWidth: 480, maxHeight: '90%', borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  content: { padding: 22, paddingTop: 24 },
  close: { position: 'absolute', top: 12, right: 12, zIndex: 2, padding: 4 },
  back: { alignSelf: 'flex-start', padding: 2, marginBottom: 8 },
  icon: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  iconLg: { width: 64, height: 64, borderRadius: 32, alignSelf: 'center', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: '700', lineHeight: 28, paddingRight: 24, letterSpacing: -0.2 },
  center: { textAlign: 'center', paddingRight: 0 },
  body: { fontSize: 15, lineHeight: 21, marginTop: 8, marginBottom: 14 },
  countryRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, borderBottomWidth: 1 },
  countryName: { flex: 1, fontSize: 16, fontWeight: '500' },
  phoneRow: { flexDirection: 'row', alignItems: 'center', minHeight: 58, borderBottomWidth: 1.5 },
  dial: { fontSize: 20, fontWeight: '600', fontVariant: ['tabular-nums'], includeFontPadding: false },
  vline: { width: 1, height: 26, marginHorizontal: 12 },
  phoneInput: { flex: 1, minWidth: 0, fontSize: 20, fontWeight: '600', letterSpacing: 0, paddingVertical: 0, paddingHorizontal: 0, fontVariant: ['tabular-nums'], includeFontPadding: false, textAlignVertical: 'center' },
  phoneCheck: { width: 26, alignItems: 'flex-end', justifyContent: 'center' },
  hint: { fontSize: 13, lineHeight: 18, marginTop: 10 },
  err: { fontSize: 14, lineHeight: 19, marginTop: 12, fontWeight: '600' },
  cta: { marginTop: 18, borderRadius: 14, minHeight: 52, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  ctaText: { fontSize: 16, fontWeight: '700' },
  link: { alignSelf: 'center', paddingVertical: 14, paddingHorizontal: 12, marginTop: 4 },
  linkText: { fontSize: 15, fontWeight: '600' },
  doneWrap: { alignItems: 'center', paddingVertical: 12 },
});
