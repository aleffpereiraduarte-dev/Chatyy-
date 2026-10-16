// [2026-10-16 two-step] "Verificação em duas etapas" nível WhatsApp
// ("Confirmação em duas etapas"). Uma tela só, P&B, com passos internos:
//   desligada → explicação + Ativar (PIN 6 dígitos + confirmação + e-mail opcional)
//   ligada    → Alterar PIN (atual + novo), Adicionar/Alterar e-mail, Lembrete,
//               Desativar (pede o PIN atual), Esqueci meu PIN.
// O PIN é o MESMO registration_lock que o login por telefone exige após o OTP
// (anti-SIM-swap). Servidor: enable_2fa / disable_2fa / get_2fa_status.
// [wave13e 2026-10-16] Esqueci meu PIN → com e-mail de recuperação: código de
// 6 dígitos por e-mail (reset_2fa_request) → digitar → desliga (reset_2fa_confirm).
// PINs só vivem no estado enquanto a folha está aberta (limpos ao fechar).
import { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, Pressable, Modal, ScrollView, ActivityIndicator,
  Platform, KeyboardAvoidingView, StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import { IconChevronLeft, IconX, IconShield, IconCheck } from '../Icons';
import { SettingsGroup, SettingsRow, SettingsSwitchRow, useGroupedColors } from './SettingsKit';
import {
  getCachedTwoStep, loadTwoStep, fetchTwoStep, applyServerStatus, saveTwoStep, subscribeTwoStep,
  twoStepEnable, twoStepDisable, twoStepError, twoStepResetRequest, twoStepResetConfirm,
} from './twoStepState';

const PIN_LEN = 6;

// Fora dos componentes: o React Compiler não compila try/catch com
// condicional/optional chaining nem try/finally dentro do componente.
function focusRef(ref) { try { const el = ref.current; if (el && el.focus) el.focus(); } catch {} }
export async function safeCall(fn) {
  try { return await fn(); } catch { return null; }
}
const webNoOutline = Platform.OS === 'web' ? { outlineStyle: 'none' } : null;

// ── Campo de PIN: 6 casas + um TextInput invisível por cima (funciona igual
// no iOS/Android/web, cola/backspace nativos, sem foco pulando de casa). ──
export function PinField({ value, onChange, onComplete, error, autoFocus = true, testID, reveal = false }) {
  const g = useGroupedColors();
  const ref = useRef(null);
  useEffect(() => {
    if (!autoFocus) return undefined;
    const tm = setTimeout(() => { focusRef(ref); }, 320);
    return () => clearTimeout(tm);
  }, [autoFocus]);
  const v = String(value || '');
  return (
    <Pressable onPress={() => { focusRef(ref); }} style={s.pinWrap} accessible={false}>
      <View style={s.pinRow}>
        {Array.from({ length: PIN_LEN }, (_, i) => {
          const filled = i < v.length;
          const active = i === Math.min(v.length, PIN_LEN - 1) && !filled;
          return (
            <View
              key={i}
              style={[s.pinCell, {
                backgroundColor: g.cardBg,
                borderColor: error ? g.destructive : (filled || active) ? g.ink : g.tertiary,
                borderWidth: active ? 2 : 1.5,
              }]}
            >
              {filled ? (reveal
                ? <Text style={[s.pinDigit, { color: g.ink }]}>{v.charAt(i)}</Text>
                : <View style={[s.pinDot, { backgroundColor: g.ink }]} />) : null}
            </View>
          );
        })}
      </View>
      <TextInput
        ref={ref}
        testID={testID}
        value={v}
        onChangeText={(t) => {
          const d = String(t || '').replace(/\D/g, '').slice(0, PIN_LEN);
          onChange?.(d);
          if (d.length === PIN_LEN) onComplete?.(d);
        }}
        keyboardType="number-pad"
        inputMode="numeric"
        maxLength={PIN_LEN}
        autoComplete="off"
        autoCorrect={false}
        importantForAutofill="no"
        textContentType="none"
        caretHidden
        contextMenuHidden
        style={[s.pinInput, webNoOutline]}
        accessibilityLabel={reveal ? 'Code' : 'PIN'}
      />
    </Pressable>
  );
}

export function PrimaryButton({ label, onPress, disabled, busy, testID, destructive }) {
  const g = useGroupedColors();
  const bg = destructive ? g.destructive : g.ink;
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      style={({ pressed }) => [s.primary, { backgroundColor: bg, opacity: (disabled || busy) ? 0.35 : pressed ? 0.8 : 1 }]}
    >
      {busy ? <ActivityIndicator size="small" color={g.onInk} /> : <Text style={[s.primaryText, { color: destructive ? '#fff' : g.onInk }]}>{label}</Text>}
    </Pressable>
  );
}

export function TextButton({ label, onPress, testID, disabled }) {
  const g = useGroupedColors();
  return (
    <Pressable testID={testID} onPress={onPress} disabled={disabled} accessibilityRole="button" hitSlop={8}
      style={({ pressed }) => [s.textBtn, { opacity: disabled ? 0.35 : pressed ? 0.6 : 1 }]}>
      <Text style={[s.textBtnText, { color: g.ink }]}>{label}</Text>
    </Pressable>
  );
}

export function twoStepErrorText(t, kind) {
  switch (kind) {
    case 'wrong': return t('twoStep.wrongPin') || 'PIN incorreto. Tente de novo.';
    case 'rate': return t('twoStep.rateLimited') || 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
    case 'email': return t('twoStep.invalidEmail') || 'E-mail inválido.';
    case 'mismatch': return t('twoStep.mismatch') || 'Os PINs não coincidem. Tente de novo.';
    case 'short': return t('twoStep.pinShort') || 'Digite os dígitos do seu PIN.';
    case 'code': return t('twoStep.codeInvalid') || 'Código incorreto. Tente de novo.';
    case 'expired': return t('twoStep.codeExpired') || 'Código expirado. Peça um novo.';
    default: return t('twoStep.failed') || 'Não foi possível concluir. Verifique sua conexão e tente de novo.';
  }
}

// step: main | cur | new | confirm | email | forgot | reset
// flow: enable | change | email | disable
export default function TwoStepSheet({ visible, onClose, initialStep = 'main' }) {
  const g = useGroupedColors();
  const { t } = useLanguage();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const email = user?.email || '';

  const [status, setStatus] = useState(() => getCachedTwoStep(email));
  const [loadFailed, setLoadFailed] = useState(false);
  const [step, setStep] = useState(initialStep);
  const [flow, setFlow] = useState(null);
  const [curPin, setCurPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [mail, setMail] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [noEmail, setNoEmail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const noticeTm = useRef(null);

  const resetFlow = () => { setFlow(null); setCurPin(''); setNewPin(''); setPin2(''); setMail(''); setCode(''); setErr(''); };

  useEffect(() => {
    if (!visible) { resetFlow(); setNotice(''); setNoEmail(false); return undefined; }
    setStep(initialStep || 'main');
    let alive = true;
    loadTwoStep(email).then((c) => { if (alive && c) setStatus((p) => p || c); });
    setLoadFailed(false);
    fetchTwoStep(email).then((s2) => {
      if (!alive) return;
      if (s2 && s2.fetchedAt) setStatus(s2); else setLoadFailed(true);
    }).catch(() => { if (alive) setLoadFailed(true); });
    const un = subscribeTwoStep((e, s2) => { if (e === String(email).toLowerCase()) setStatus(s2); });
    return () => { alive = false; un(); };
  }, [visible, email, initialStep]);

  useEffect(() => () => { if (noticeTm.current) clearTimeout(noticeTm.current); }, []);

  const flash = (msg) => {
    setNotice(msg);
    if (noticeTm.current) clearTimeout(noticeTm.current);
    noticeTm.current = setTimeout(() => setNotice(''), 2800);
  };
  const goMain = (msg) => { resetFlow(); setStep('main'); if (msg) flash(msg); };

  const start = (f) => {
    resetFlow(); setNotice('');
    setFlow(f);
    setStep(f === 'enable' ? 'new' : 'cur');
  };

  const back = () => {
    setErr('');
    if (step === 'main') { onClose?.(); return; }
    if (step === 'reset') { setCode(''); setStep('forgot'); return; }
    if (step === 'forgot') { setStep('main'); return; }
    if (step === 'confirm') { setPin2(''); setStep('new'); return; }
    if (step === 'email') { setStep(flow === 'enable' ? 'confirm' : 'cur'); if (flow === 'enable') setPin2(''); return; }
    if (step === 'new' && flow === 'change') { setNewPin(''); setStep('cur'); return; }
    goMain();
  };

  const handleFail = (r, { pinStep } = {}) => {
    const kind = twoStepError(r);
    setErr(twoStepErrorText(t, kind));
    if (kind === 'wrong' && pinStep) { setCurPin(''); setStep(pinStep); }
  };

  const finish = async (r, msg, resetReminder) => {
    if (r?.data) await applyServerStatus(email, r.data, { resetReminder });
    goMain(msg);
  };

  const doEnable = async (recoveryEmail) => {
    setBusy(true); setErr('');
    const r = await safeCall(() => twoStepEnable({ pin: newPin, ...(recoveryEmail ? { recoveryEmail } : {}) }));
    setBusy(false);
    if (r && r.success) await finish(r, t('twoStep.enabledToast') || 'Verificação em duas etapas ativada', true);
    else handleFail(r);
  };

  const doChange = async (cur, nw) => {
    setBusy(true); setErr('');
    const r = await safeCall(() => twoStepEnable({ pin: nw, currentPin: cur }));
    setBusy(false);
    if (r && r.success) await finish(r, t('twoStep.changedToast') || 'PIN alterado', true);
    else handleFail(r, { pinStep: 'cur' });
  };

  const doEmail = async (value) => {
    const v = String(value || '').trim();
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) { setErr(twoStepErrorText(t, 'email')); return; }
    setBusy(true); setErr('');
    const r = await safeCall(() => twoStepEnable({ pin: curPin, currentPin: curPin, recoveryEmail: v }));
    setBusy(false);
    if (r && r.success) await finish(r, t('twoStep.emailToast') || 'E-mail atualizado', false);
    else handleFail(r, { pinStep: 'cur' });
  };

  // [wave13e] Esqueci meu PIN → código por e-mail → desliga.
  const doResetRequest = async () => {
    setBusy(true); setErr('');
    const r = await safeCall(() => twoStepResetRequest());
    setBusy(false);
    if (r && r.success) {
      setSentTo(String((r.data && r.data.recovery_email_masked) || status?.emailMasked || ''));
      setCode(''); setStep('reset');
      return;
    }
    const kind = r ? twoStepError(r) : 'generic';
    if (kind === 'noEmail') { setNoEmail(true); return; }
    setErr(twoStepErrorText(t, kind));
  };

  const doResetConfirm = async (val) => {
    const c = String(val ?? code);
    if (c.length !== PIN_LEN || busy) { if (c.length !== PIN_LEN) setErr(twoStepErrorText(t, 'short')); return; }
    setBusy(true); setErr('');
    const r = await safeCall(() => twoStepResetConfirm(c));
    setBusy(false);
    if (r && r.success) { await finish(r, t('twoStep.resetDone') || 'PIN desativado. Você pode criar um novo quando quiser.', false); return; }
    setCode('');
    setErr(twoStepErrorText(t, r ? twoStepError(r) : 'generic'));
  };

  const doDisable = async (cur) => {
    setBusy(true); setErr('');
    const r = await safeCall(() => twoStepDisable(cur));
    setBusy(false);
    if (r && r.success) await finish(r, t('twoStep.disabledToast') || 'Verificação em duas etapas desativada', false);
    else handleFail(r, { pinStep: 'cur' });
  };

  // Avança a partir do PIN atual (aceita 4–6 dígitos: PINs antigos tinham 4).
  const submitCur = (val) => {
    const cur = String(val ?? curPin);
    if (cur.length < 4) { setErr(twoStepErrorText(t, 'short')); return; }
    setErr('');
    if (flow === 'disable') { doDisable(cur); return; }
    if (flow === 'email') { setMail(''); setStep('email'); return; }
    if (flow === 'change') {
      // Repetição após "PIN incorreto": novo PIN já confirmado → envia direto.
      if (newPin.length === PIN_LEN && pin2 === newPin) { doChange(cur, newPin); return; }
      setStep('new');
    }
  };
  const submitNew = (val) => {
    const nw = String(val ?? newPin);
    if (nw.length !== PIN_LEN) { setErr(twoStepErrorText(t, 'short')); return; }
    setErr(''); setPin2(''); setStep('confirm');
  };
  const submitConfirm = (val) => {
    const p2 = String(val ?? pin2);
    if (p2.length !== PIN_LEN) { setErr(twoStepErrorText(t, 'short')); return; }
    if (p2 !== newPin) { setPin2(''); setErr(twoStepErrorText(t, 'mismatch')); return; }
    setErr('');
    if (flow === 'enable') { setMail(''); setStep('email'); return; }
    doChange(curPin, newPin);
  };

  const enabled = !!status?.enabled;
  const title = t('settings.twoFactor') || 'Verificação em duas etapas';

  const header = (
    <View style={[s.header, { paddingTop: (Platform.OS === 'ios' ? 12 : insets.top + 8) }]}>
      <Pressable onPress={back} hitSlop={12} accessibilityRole="button" testID="twostep-back"
        accessibilityLabel={step === 'main' ? (t('common.close') || 'Fechar') : (t('common.back') || 'Voltar')}
        style={({ pressed }) => [s.hBtn, { opacity: pressed ? 0.5 : 1 }]}>
        {step === 'main' ? <IconX size={22} color={g.ink} /> : <IconChevronLeft size={24} color={g.ink} />}
      </Pressable>
      <Text style={[s.hTitle, { color: g.text }]} numberOfLines={1}>{title}</Text>
      <View style={s.hBtn} />
    </View>
  );

  const errorLine = err ? <Text style={[s.err, { color: g.destructive }]} accessibilityLiveRegion="polite">{err}</Text> : null;

  let content = null;
  if (step === 'main') {
    if (!status && !loadFailed) {
      content = <ActivityIndicator color={g.ink} style={{ marginTop: 80 }} />;
    } else if (!status && loadFailed) {
      content = (
        <View style={{ paddingTop: 60, alignItems: 'center' }}>
          <Text style={[s.heroBody, { color: g.secondary }]}>{t('twoStep.failed') || 'Não foi possível concluir. Verifique sua conexão e tente de novo.'}</Text>
          <TextButton label={t('common.retry') || 'Tentar novamente'} onPress={() => {
            setLoadFailed(false);
            fetchTwoStep(email).then((s2) => { if (s2 && s2.fetchedAt) setStatus(s2); else setLoadFailed(true); }).catch(() => setLoadFailed(true));
          }} />
        </View>
      );
    } else if (!enabled) {
      content = (
        <View>
          <Hero body={t('twoStep.offBody') || 'Para mais segurança, ative a verificação em duas etapas. Vamos pedir um PIN de 6 dígitos sempre que alguém tentar registrar seu número de telefone no Chatyy em outro aparelho.'} />
          {!!notice && <Notice text={notice} />}
          <View style={s.pad}>
            <PrimaryButton testID="twostep-enable" label={t('twoStep.enable') || 'Ativar'} onPress={() => start('enable')} />
          </View>
        </View>
      );
    } else {
      content = (
        <View>
          <Hero body={t('twoStep.onBody') || 'A verificação em duas etapas está ativada. Será preciso digitar seu PIN ao registrar seu número de telefone no Chatyy novamente.'} />
          {!!notice && <Notice text={notice} />}
          <SettingsGroup>
            <SettingsRow testID="twostep-change-pin" title={t('twoStep.changePin') || 'Alterar PIN'} onPress={() => start('change')} />
            <SettingsRow
              testID="twostep-email"
              title={status?.hasEmail ? (t('twoStep.changeEmail') || 'Alterar e-mail') : (t('twoStep.addEmail') || 'Adicionar e-mail')}
              subtitle={status?.hasEmail ? (status?.emailMasked || undefined) : undefined}
              onPress={() => start('email')}
            />
          </SettingsGroup>
          <SettingsGroup footer={t('twoStep.reminderDesc') || 'Pedimos seu PIN de vez em quando (a cada 7 dias) para ajudar você a não esquecê-lo.'}>
            <SettingsSwitchRow
              testID="twostep-reminder"
              title={t('twoStep.reminder') || 'Lembrete do PIN'}
              value={status?.remind !== false}
              onValueChange={(on) => { saveTwoStep(email, { remind: !!on }); }}
            />
          </SettingsGroup>
          <SettingsGroup>
            <SettingsRow testID="twostep-forgot" title={t('twoStep.forgot') || 'Esqueci meu PIN'} onPress={() => { setErr(''); setStep('forgot'); }} />
            <SettingsRow testID="twostep-disable" title={t('twoStep.disable') || 'Desativar'} destructive onPress={() => start('disable')} />
          </SettingsGroup>
        </View>
      );
    }
  } else if (step === 'cur') {
    const dis = flow === 'disable';
    content = (
      <View style={s.pad}>
        <Hero
          heading={dis ? (t('twoStep.disableTitle') || 'Desativar verificação em duas etapas') : (t('twoStep.curPinTitle') || 'Digite seu PIN atual')}
          body={dis ? (t('twoStep.disableDesc') || 'Digite seu PIN atual para desativar. Sem ele, qualquer pessoa com seu chip poderá registrar seu número.') : (t('twoStep.curPinDesc') || 'Para sua segurança, confirme o PIN da verificação em duas etapas.')}
        />
        <PinField testID="twostep-pin-input" value={curPin} error={!!err} onChange={(v) => { setCurPin(v); if (err) setErr(''); }}
          onComplete={(v) => { if (!busy) submitCur(v); }} />
        {errorLine}
        <PrimaryButton testID="twostep-submit" destructive={dis} busy={busy} disabled={curPin.length < 4}
          label={dis ? (t('twoStep.disable') || 'Desativar') : (t('common.next') || 'Avançar')} onPress={() => submitCur()} />
        <TextButton testID="twostep-cur-forgot" label={t('twoStep.forgot') || 'Esqueci meu PIN'} onPress={() => { setErr(''); setStep('forgot'); }} />
      </View>
    );
  } else if (step === 'new') {
    content = (
      <View style={s.pad}>
        <Hero heading={t('twoStep.newPinTitle') || 'Crie um PIN de 6 dígitos'}
          body={t('twoStep.newPinDesc') || 'Você vai precisar dele ao registrar seu número no Chatyy em outro aparelho. Escolha um que você vá lembrar.'} />
        <PinField testID="twostep-pin-input" value={newPin} error={!!err} onChange={(v) => { setNewPin(v); if (err) setErr(''); }}
          onComplete={(v) => submitNew(v)} />
        {errorLine}
        <PrimaryButton testID="twostep-submit" disabled={newPin.length !== PIN_LEN} label={t('common.next') || 'Avançar'} onPress={() => submitNew()} />
      </View>
    );
  } else if (step === 'confirm') {
    content = (
      <View style={s.pad}>
        <Hero heading={t('twoStep.confirmTitle') || 'Confirme seu PIN'} body={t('twoStep.confirmDesc') || 'Digite o mesmo PIN mais uma vez.'} />
        <PinField testID="twostep-pin-input" value={pin2} error={!!err} onChange={(v) => { setPin2(v); if (err && v) setErr(''); }}
          onComplete={(v) => { if (!busy) submitConfirm(v); }} />
        {errorLine}
        <PrimaryButton testID="twostep-submit" busy={busy} disabled={pin2.length !== PIN_LEN} label={t('common.next') || 'Avançar'} onPress={() => submitConfirm()} />
      </View>
    );
  } else if (step === 'email') {
    const onEnable = flow === 'enable';
    content = (
      <View style={s.pad}>
        <Hero heading={t('twoStep.emailTitle') || 'E-mail de recuperação'}
          body={t('twoStep.emailDesc') || 'Opcional. Adicione um e-mail para ajudar a recuperar o acesso se você esquecer o PIN.'} />
        {!onEnable && status?.hasEmail && status?.emailMasked ? (
          <Text style={[s.hint, { color: g.secondary }]}>{(t('twoStep.forgotEmail') || 'E-mail de recuperação cadastrado: {email}').replace('{email}', status.emailMasked)}</Text>
        ) : null}
        <TextInput
          testID="twostep-email-input"
          value={mail}
          onChangeText={(v) => { setMail(v); if (err) setErr(''); }}
          placeholder={'nome@exemplo.com'}
          placeholderTextColor={g.secondary}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="emailAddress"
          autoFocus
          style={[s.input, { color: g.text, backgroundColor: g.cardBg, borderColor: err ? g.destructive : g.ring }, webNoOutline]}
          onSubmitEditing={() => { if (!busy && mail.trim()) (onEnable ? doEnable(mail.trim()) : doEmail(mail)); }}
        />
        {errorLine}
        <PrimaryButton
          testID="twostep-submit"
          busy={busy}
          disabled={!mail.trim()}
          label={t('common.save') || 'Salvar'}
          onPress={() => {
            const v = mail.trim();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) { setErr(twoStepErrorText(t, 'email')); return; }
            if (onEnable) doEnable(v); else doEmail(v);
          }}
        />
        {onEnable ? (
          <TextButton testID="twostep-skip" disabled={busy} label={t('twoStep.skip') || 'Pular'} onPress={() => doEnable('')} />
        ) : status?.hasEmail ? (
          <TextButton testID="twostep-remove-email" disabled={busy} label={t('twoStep.removeEmail') || 'Remover e-mail'} onPress={() => doEmail('')} />
        ) : null}
      </View>
    );
  } else if (step === 'forgot') {
    const canReset = enabled && !!status?.hasEmail && !noEmail;
    content = (
      <View style={s.pad}>
        <Hero heading={t('twoStep.forgotTitle') || 'Esqueceu seu PIN?'}
          body={canReset
            ? (t('twoStep.forgotEmailBody') || 'Podemos enviar um código para o seu e-mail de recuperação. Com ele, você desativa o PIN e pode criar um novo.')
            : (t('twoStep.forgotBody') || 'Neste aparelho sua conta continua funcionando normalmente — o PIN só é pedido ao registrar seu número de telefone em um novo aparelho. Para alterar ou desativar a verificação é preciso o PIN atual; se não lembrar, fale com o suporte em Configurações > Ajuda.')} />
        {status?.hasEmail && status?.emailMasked ? (
          <Text style={[s.hint, { color: g.secondary }]}>{(t('twoStep.forgotEmail') || 'E-mail de recuperação cadastrado: {email}').replace('{email}', status.emailMasked)}</Text>
        ) : null}
        {canReset ? (
          <>
            {errorLine}
            <PrimaryButton testID="twostep-reset-send" busy={busy} label={t('twoStep.resetSend') || 'Enviar código por e-mail'} onPress={doResetRequest} />
          </>
        ) : null}
        {enabled && status?.remind !== false ? (
          <PrimaryButton testID="twostep-reminder-off" label={t('twoStep.turnOffReminder') || 'Desligar lembrete'}
            onPress={() => { saveTwoStep(email, { remind: false }); goMain(); }} />
        ) : null}
        <TextButton label={t('common.back') || 'Voltar'} onPress={() => { setErr(''); if (flow) setStep('cur'); else setStep('main'); }} />
      </View>
    );
  } else if (step === 'reset') {
    content = (
      <View style={s.pad}>
        <Hero heading={t('twoStep.resetCodeTitle') || 'Digite o código'}
          body={(t('twoStep.resetCodeBody') || 'Enviamos um código de 6 dígitos para {email}. Ele vale por 1 hora.').replace('{email}', sentTo || status?.emailMasked || '')} />
        <PinField testID="twostep-reset-code" reveal value={code} error={!!err}
          onChange={(v) => { setCode(v); if (err) setErr(''); }}
          onComplete={(v) => { if (!busy) doResetConfirm(v); }} />
        {errorLine}
        <PrimaryButton testID="twostep-reset-confirm" destructive busy={busy} disabled={code.length !== PIN_LEN}
          label={t('twoStep.disable') || 'Desativar'} onPress={() => doResetConfirm()} />
        <TextButton testID="twostep-reset-resend" disabled={busy} label={t('twoStep.resendCode') || 'Reenviar código'} onPress={doResetRequest} />
      </View>
    );
  }

  return (
    <Modal
      visible={!!visible}
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
      onRequestClose={back}
    >
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: g.pageBg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {header}
        <ScrollView
          contentContainerStyle={{ paddingBottom: 32 + insets.bottom, maxWidth: 560, width: '100%', alignSelf: 'center' }}
          keyboardShouldPersistTaps="handled"
          testID="twostep-sheet"
        >
          {content}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
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

function Notice({ text }) {
  const g = useGroupedColors();
  return (
    <View style={[s.notice, { backgroundColor: g.chipBg }]} accessibilityLiveRegion="polite" testID="twostep-notice">
      <IconCheck size={16} color={g.ink} strokeWidth={2.4} />
      <Text style={[s.noticeText, { color: g.text }]}>{text}</Text>
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
  pinWrap: { alignSelf: 'center', marginTop: 4, marginBottom: 8 },
  pinRow: { flexDirection: 'row', gap: 10 },
  pinCell: { width: 44, height: 54, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  pinDot: { width: 12, height: 12, borderRadius: 6 },
  pinDigit: { fontSize: 22, fontWeight: '600', fontVariant: ['tabular-nums'] },
  pinInput: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0.015, color: 'transparent', fontSize: 1 },
  err: { fontSize: 14, textAlign: 'center', marginTop: 6, marginBottom: 4 },
  hint: { fontSize: 14, textAlign: 'center', marginBottom: 12 },
  primary: { height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', marginTop: 18 },
  primaryText: { fontSize: 16, fontWeight: '600' },
  textBtn: { alignSelf: 'center', paddingVertical: 14, paddingHorizontal: 16, marginTop: 4 },
  textBtnText: { fontSize: 15, fontWeight: '600' },
  input: { height: 50, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, fontSize: 16 },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'center', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18, marginBottom: 18 },
  noticeText: { fontSize: 14, fontWeight: '500' },
});
