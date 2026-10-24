// [wave14a 2026-10-16] "Esqueci meu PIN" na tela de PIN do LOGIN (aparelho novo,
// login por telefone com verificação em duas etapas). Sem sessão: o servidor
// devolve um desafio (lock_challenge, HMAC 1 h) junto do requires_lock depois que
// o código SMS já foi validado. Aqui:
//   intro  → "Enviar código por e-mail" (login_2fa_reset_request)
//   code   → 6 dígitos do e-mail (login_2fa_reset_confirm) → PIN desligado + login
//   noEmail→ conta sem e-mail de recuperação → falar com o suporte
// Quem abre recebe o payload de login (token/email/name) em onLoggedIn.
import { useEffect, useState } from 'react';
import { View, Text, Pressable, Modal, ScrollView, Platform, StyleSheet, Linking } from 'react-native';
import KeyboardSafeView from '../ui/KeyboardSafeView'; // [2026-10-22 kb-uniforme]
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLanguage } from '../../context/LanguageContext';
import { IconX, IconShield } from '../Icons';
import { useGroupedColors } from './SettingsKit';
import { PinField, PrimaryButton, TextButton, twoStepErrorText, safeCall } from './TwoStepSheet';
import { twoStepError, loginPinResetRequest, loginPinResetConfirm } from './twoStepState';

const CODE_LEN = 6;
const SUPPORT_EMAIL = 'suporte@chatyy.app';

function openSupportMail() {
  try { Linking.openURL('mailto:' + SUPPORT_EMAIL).catch(() => {}); } catch {}
}

export default function LoginPinResetSheet({ visible, challenge, hasEmail, onClose, onLoggedIn, onChallengeExpired }) {
  const { t } = useLanguage();
  const g = useGroupedColors();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState('intro');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    if (!visible) { setCode(''); setErr(''); setBusy(false); setExpired(false); return; }
    setStep(hasEmail === false ? 'noEmail' : 'intro');
  }, [visible, hasEmail]);

  const errText = (r) => {
    const d = (r && r.data) || {};
    if (d.challenge_invalid) { setExpired(true); return t('twoStep.loginChallengeExpired') || 'A verificação expirou. Volte e digite o código SMS de novo.'; }
    return twoStepErrorText(t, r ? twoStepError(r) : 'generic');
  };

  const doRequest = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    const r = await safeCall(() => loginPinResetRequest(challenge));
    setBusy(false);
    if (r && r.success) {
      setSentTo(String((r.data && r.data.recovery_email_masked) || ''));
      setCode(''); setStep('code');
      return;
    }
    if (r && r.data && r.data.no_recovery_email) { setStep('noEmail'); return; }
    setErr(errText(r));
  };

  const doConfirm = async (val) => {
    const c = String(val ?? code);
    if (busy) return;
    if (c.length !== CODE_LEN) { setErr(twoStepErrorText(t, 'short')); return; }
    setBusy(true); setErr('');
    const r = await safeCall(() => loginPinResetConfirm(challenge, c));
    if (r && r.success && r.data && r.data.token) {
      if (onLoggedIn) await safeCall(() => onLoggedIn(r.data));
      setBusy(false);
      return;
    }
    setBusy(false);
    setCode('');
    setErr(errText(r));
  };

  const close = () => {
    if (expired && onChallengeExpired) onChallengeExpired();
    if (onClose) onClose();
  };

  const errorLine = err ? <Text style={[s.err, { color: g.destructive }]} accessibilityLiveRegion="polite">{err}</Text> : null;

  let content;
  if (step === 'noEmail') {
    content = (
      <View>
        <Hero heading={t('twoStep.forgotTitle') || 'Esqueceu seu PIN?'}
          body={(t('twoStep.loginNoEmail') || 'Esta conta não tem e-mail de recuperação. Para recuperar o acesso, fale com o suporte: {email}').replace('{email}', SUPPORT_EMAIL)} />
        <View style={s.pad}>
          <PrimaryButton testID="login-pin-support" label={SUPPORT_EMAIL} onPress={openSupportMail} />
          <TextButton label={t('common.back') || 'Voltar'} onPress={close} />
        </View>
      </View>
    );
  } else if (step === 'code') {
    content = (
      <View>
        <Hero heading={t('twoStep.resetCodeTitle') || 'Digite o código'}
          body={(t('twoStep.resetCodeBody') || 'Enviamos um código de 6 dígitos para {email}. Ele vale por 1 hora.').replace('{email}', sentTo)} />
        <PinField testID="login-pin-reset-code" reveal value={code} error={!!err}
          onChange={(v) => { setCode(v); if (err) setErr(''); }} onComplete={(v) => doConfirm(v)} />
        <View style={s.pad}>
          {errorLine}
          <PrimaryButton testID="login-pin-reset-confirm" busy={busy} disabled={code.length !== CODE_LEN || expired}
            label={t('twoStep.loginResetConfirm') || 'Desativar PIN e entrar'} onPress={() => doConfirm()} />
          <TextButton testID="login-pin-reset-resend" disabled={busy || expired} label={t('twoStep.resendCode') || 'Reenviar código'} onPress={doRequest} />
        </View>
      </View>
    );
  } else {
    content = (
      <View>
        <Hero heading={t('twoStep.forgotTitle') || 'Esqueceu seu PIN?'}
          body={t('twoStep.loginForgotBody') || 'Enviaremos um código para o e-mail de recuperação desta conta. Com ele, você desativa o PIN e entra.'} />
        <View style={s.pad}>
          {errorLine}
          <PrimaryButton testID="login-pin-reset-send" busy={busy} disabled={expired} label={t('twoStep.resetSend') || 'Enviar código por e-mail'} onPress={doRequest} />
          <TextButton label={t('common.back') || 'Voltar'} onPress={close} />
        </View>
      </View>
    );
  }

  return (
    <Modal visible={!!visible} animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'} onRequestClose={close}>
      {/* [2026-10-16 polish] Android: Modal tela-cheia edge-to-edge não redimensiona com o teclado → 'height' encolhe a área e o botão fica acima do teclado. */}
      <KeyboardSafeView style={{ flex: 1, backgroundColor: g.pageBg }}>
        <View style={[s.header, { paddingTop: (Platform.OS === 'ios' ? 12 : insets.top + 8) }]}>
          <Pressable onPress={close} hitSlop={12} accessibilityRole="button" testID="login-pin-reset-close"
            accessibilityLabel={t('common.close') || 'Fechar'} style={({ pressed }) => [s.hBtn, { opacity: pressed ? 0.5 : 1 }]}>
            <IconX size={22} color={g.ink} />
          </Pressable>
          <Text style={[s.hTitle, { color: g.text }]} numberOfLines={1}>{t('settings.twoFactor') || 'Verificação em duas etapas'}</Text>
          <View style={s.hBtn} />
        </View>
        <ScrollView contentContainerStyle={{ paddingBottom: 32 + insets.bottom, maxWidth: 560, width: '100%', alignSelf: 'center' }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} testID="login-pin-reset-sheet">
          {content}
        </ScrollView>
      </KeyboardSafeView>
    </Modal>
  );
}

// Link "Esqueci meu PIN" para colocar logo abaixo do campo de PIN do login.
export function ForgotLoginPinLink({ onPress, color, testID = 'login-pin-forgot' }) {
  const { t } = useLanguage();
  return (
    <Pressable testID={testID} onPress={onPress} accessibilityRole="button" hitSlop={8}
      style={({ pressed }) => [{ alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 12, opacity: pressed ? 0.6 : 1 }]}>
      <Text style={{ fontSize: 14, fontWeight: '600', color }}>{t('twoStep.forgot') || 'Esqueci meu PIN'}</Text>
    </Pressable>
  );
}

function Hero({ heading, body }) {
  const g = useGroupedColors();
  return (
    <View style={s.hero}>
      <View style={[s.heroIcon, { backgroundColor: g.chipBg }]}>
        <IconShield size={34} color={g.ink} />
      </View>
      {!!heading && <Text style={[s.heroTitle, { color: g.text }]}>{heading}</Text>}
      {!!body && <Text style={[s.heroBody, { color: g.secondary }]}>{body}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingBottom: 8 },
  hBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  hTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600' },
  hero: { alignItems: 'center', paddingHorizontal: 28, paddingTop: 18, paddingBottom: 22 },
  heroIcon: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  heroTitle: { fontSize: 21, fontWeight: '700', textAlign: 'center', marginBottom: 8, letterSpacing: -0.2 },
  heroBody: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
  pad: { paddingHorizontal: 20 },
  err: { fontSize: 14, textAlign: 'center', marginTop: 6, marginBottom: 4 },
});
