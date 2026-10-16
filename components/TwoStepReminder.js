// [2026-10-16 two-step] Lembrete periódico do PIN da verificação em duas
// etapas (estilo WhatsApp): 7 dias depois de ativar/trocar/acertar, ao abrir o
// app, pede o PIN. "Esqueci meu PIN" leva às opções (TwoStepSheet). Opt-out em
// Conta > Verificação em duas etapas > Lembrete do PIN. Não renderiza nada na
// maioria das aberturas: lê a agenda local e só consulta o servidor 1×/24 h.
// Conferência do PIN: [wave13e] verify_2fa_pin {pin} — só confere, não regrava
// (403 current_pin_required = errado; 429 = muitas tentativas; 409 not_enabled
// = PIN já desligado em outro aparelho → atualiza o estado e fecha).
import { useEffect, useRef, useState } from 'react';
import { View, Text, Modal, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { IconShield } from './Icons';
import { useGroupedColors } from './settings/SettingsKit';
import {
  fetchTwoStepIfStale, saveTwoStep, twoStepVerify, twoStepError, applyServerStatus,
  TWO_STEP_REMIND_MS, TWO_STEP_SNOOZE_MS,
} from './settings/twoStepState';

const BOOT_DELAY_MS = 6000;

async function shouldRemind(email) {
  try {
    const st = await fetchTwoStepIfStale(email);
    return !!(st && st.enabled && st.remind !== false && st.next && Date.now() >= st.next);
  } catch { return false; }
}

export default function TwoStepReminder() {
  const auth = useAuth();
  const email = auth?.user?.email || null;
  const loading = !!auth?.loading;
  const [show, setShow] = useState(false);
  const [sheet, setSheet] = useState(false);
  const doneFor = useRef(null);

  useEffect(() => {
    if (!email || loading || doneFor.current === email) return undefined;
    let alive = true;
    const tm = setTimeout(() => {
      doneFor.current = email;
      shouldRemind(email).then((due) => { if (alive && due) setShow(true); });
    }, BOOT_DELAY_MS);
    return () => { alive = false; clearTimeout(tm); };
  }, [email, loading]);

  // Troca de conta: fecha o que estiver aberto da conta anterior.
  useEffect(() => { setShow(false); setSheet(false); }, [email]);

  if (!email || (!show && !sheet)) return null;
  const TwoStepSheet = sheet ? require('./settings/TwoStepSheet').default : null;
  return (
    <>
      {show ? (
        <ReminderCard
          email={email}
          onDone={() => setShow(false)}
          onForgot={() => { setShow(false); setSheet(true); }}
        />
      ) : null}
      {TwoStepSheet ? <TwoStepSheet visible={sheet} initialStep="forgot" onClose={() => setSheet(false)} /> : null}
    </>
  );
}

function ReminderCard({ email, onDone, onForgot }) {
  const g = useGroupedColors();
  const { t } = useLanguage();
  const { PinField, PrimaryButton, TextButton, twoStepErrorText, safeCall } = require('./settings/TwoStepSheet');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState(false);
  const closeTm = useRef(null);
  useEffect(() => () => { if (closeTm.current) clearTimeout(closeTm.current); }, []);

  const verify = async (val) => {
    const p = String(val ?? pin);
    if (busy || ok) return;
    if (p.length < 4) { setErr(twoStepErrorText(t, 'short')); return; }
    setBusy(true); setErr('');
    const r = await safeCall(() => twoStepVerify(p));
    setBusy(false);
    setPin('');
    if (r && r.success) {
      setOk(true);
      if (r.data) await applyServerStatus(email, r.data, { resetReminder: true });
      else await saveTwoStep(email, { next: Date.now() + TWO_STEP_REMIND_MS });
      closeTm.current = setTimeout(onDone, 1400);
    } else if (r && r.data && r.data.not_enabled) {
      await applyServerStatus(email, r.data);
      onDone();
    } else {
      setErr(twoStepErrorText(t, r ? twoStepError(r) : 'generic'));
    }
  };

  const notNow = () => {
    saveTwoStep(email, { next: Date.now() + TWO_STEP_SNOOZE_MS });
    onDone();
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={notNow}>
      <KeyboardAvoidingView style={[s.overlay]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[s.card, { backgroundColor: g.cardBg }]} testID="twostep-reminder-card">
          <View style={[s.icon, { backgroundColor: g.chipBg }]}><IconShield size={28} color={g.ink} /></View>
          <Text style={[s.title, { color: g.text }]}>{t('twoStep.remindTitle') || 'Digite seu PIN'}</Text>
          <Text style={[s.body, { color: g.secondary }]}>
            {ok
              ? (t('twoStep.remindOk') || 'Certo! Vamos pedir de novo daqui a 7 dias.')
              : (t('twoStep.remindBody') || 'Para ajudar você a lembrar, pedimos o PIN da verificação em duas etapas de vez em quando.')}
          </Text>
          {!ok ? (
            <>
              <PinField testID="twostep-remind-input" value={pin} error={!!err}
                onChange={(v) => { setPin(v); if (err) setErr(''); }}
                onComplete={(v) => verify(v)} />
              {err ? <Text style={[s.err, { color: g.destructive }]} accessibilityLiveRegion="polite">{err}</Text> : null}
              <PrimaryButton testID="twostep-remind-submit" busy={busy} disabled={pin.length < 4}
                label={t('common.confirm') || 'Confirmar'} onPress={() => verify()} />
              <View style={s.links}>
                <TextButton testID="twostep-remind-forgot" label={t('twoStep.forgot') || 'Esqueci meu PIN'} onPress={onForgot} />
                <TextButton testID="twostep-remind-later" label={t('common.notNow') || 'Agora não'} onPress={notNow} />
              </View>
            </>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { width: '100%', maxWidth: 400, borderRadius: 22, paddingHorizontal: 20, paddingTop: 24, paddingBottom: 10, alignItems: 'stretch' },
  icon: { width: 60, height: 60, borderRadius: 30, alignSelf: 'center', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  title: { fontSize: 20, fontWeight: '700', textAlign: 'center', marginBottom: 6 },
  body: { fontSize: 14, lineHeight: 20, textAlign: 'center', marginBottom: 18 },
  err: { fontSize: 14, textAlign: 'center', marginTop: 6 },
  links: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
});
