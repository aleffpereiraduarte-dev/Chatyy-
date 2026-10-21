// [recovery 2026-10-18] Ajustes > Conta > Opções de recuperação (estilo Gmail).
// Telefone verificado, e-mail de recuperação (confirmado por código de 6 dígitos),
// aparelhos conectados (prompt "É você?") e chaves de acesso. Mostra aviso quando
// a conta não tem nenhuma forma de recuperação.
import { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, Platform, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { SettingsScreen, SettingsGroup, SettingsRow, useGroupedColors } from '../components/settings/SettingsKit';
import { useLanguage } from '../context/LanguageContext';
import { useConfirm } from '../components/ConfirmModal';
import { PASSKEYS_ENABLED } from '../constants/featureFlags';
import { recoveryOptionsGet, recoveryEmailStart, recoveryEmailConfirm, recoveryEmailRemove } from '../services/api';
import { IconMail, IconSmartphone, IconKey, IconMessageSquare, IconAlertTriangle } from '../components/Icons';
import { success as hSuccess, error as hError } from '../services/haptics';

export default function RecoveryOptions() {
  const { t } = useLanguage();
  const router = useRouter();
  const g = useGroupedColors();
  const confirm = useConfirm();
  const [opts, setOpts] = useState(null);
  const [loadErr, setLoadErr] = useState(false);
  // form: null | 'email' | 'code'
  const [form, setForm] = useState(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [maskedTo, setMaskedTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const reload = useCallback(async () => {
    setLoadErr(false);
    try {
      const r = await recoveryOptionsGet();
      if (r?.success) setOpts(r.data || {});
      else setLoadErr(true);
    } catch { setLoadErr(true); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const sendCode = async () => {
    const e = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { setErr(t('rec.opts.invalidEmail')); hError(); return; }
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await recoveryEmailStart(e);
      if (r?.success) { setMaskedTo(r.data?.masked || e); setCode(''); setForm('code'); }
      else { setErr(r?.data?.reason === 'same_email' ? t('rec.opts.sameEmail') : (r?.data?.reason === 'rate_limited' ? t('rec.err.rateLimited') : (r?.message || t('rec.err.network')))); hError(); }
    } catch { setErr(t('forgot.validation.connectionError')); }
    finally { setBusy(false); }
  };

  const confirmCode = async () => {
    const c = String(code || '').replace(/\D/g, '');
    if (c.length !== 6) { setErr(t('forgot.validation.codeLength')); hError(); return; }
    setBusy(true); setErr('');
    try {
      const r = await recoveryEmailConfirm(c);
      if (r?.success) { hSuccess(); setForm(null); setEmail(''); setCode(''); setMsg(t('rec.opts.emailSaved')); reload(); }
      else {
        const d = r?.data || {};
        setErr(d.reason === 'wrong_code' ? t('rec.err.wrongCodeLeft', { n: d.attempts_left ?? 0 })
          : d.reason === 'expired' ? t('rec.err.codeExpired')
          : d.reason === 'too_many_attempts' ? t('rec.err.tooManyAttempts') : (r?.message || t('rec.err.network')));
        hError();
      }
    } catch { setErr(t('forgot.validation.connectionError')); }
    finally { setBusy(false); }
  };

  const removeEmail = async () => {
    const ok = await confirm({ title: t('rec.opts.removeTitle'), message: t('rec.opts.removeMsg'), confirmLabel: t('rec.opts.remove'), destructive: true });
    if (!ok) return;
    setBusy(true);
    try { const r = await recoveryEmailRemove(); if (r?.success) { setMsg(''); reload(); } } catch {}
    finally { setBusy(false); }
  };

  const o = opts || {};
  const hasEmail = !!o.recovery_email;

  const inputStyle = [st.input, { color: g.text, borderColor: g.separator, backgroundColor: g.cardBg }];

  return (
    <SettingsScreen title={t('rec.opts.title')}>
      <Text style={[st.intro, { color: g.secondary }]}>{t('rec.opts.intro')}</Text>

      {opts && !o.has_any && (
        <View style={[st.nudge, { backgroundColor: g.cardBg, borderColor: g.separator }]}>
          <IconAlertTriangle size={20} color={g.text} />
          <View style={{ flex: 1 }}>
            <Text style={[st.nudgeTitle, { color: g.text }]}>{t('rec.nudge.title')}</Text>
            <Text style={[st.nudgeText, { color: g.secondary }]}>{t('rec.nudge.desc')}</Text>
          </View>
        </View>
      )}

      {!opts && !loadErr && <ActivityIndicator style={{ marginTop: 32 }} color={g.secondary} />}
      {loadErr && (
        <TouchableOpacity onPress={reload} style={{ padding: 24, alignItems: 'center' }}>
          <Text style={{ color: g.text, fontWeight: '600' }}>{t('rec.opts.retry')}</Text>
        </TouchableOpacity>
      )}

      {opts && (
        <>
          <SettingsGroup header={t('rec.opts.phoneHeader')} footer={t('rec.opts.phoneFooter')}>
            {o.phone_verified ? (
              <SettingsRow
                icon={IconMessageSquare}
                title={o.phone_masked || ''}
                subtitle={t('rec.opts.verified')}
                onPress={Platform.OS !== 'web' ? () => router.push('/change-phone') : undefined}
              />
            ) : (
              <SettingsRow icon={IconMessageSquare} title={t('rec.opts.addPhone')} subtitle={t('rec.opts.addPhoneSub')} onPress={() => router.push({ pathname: '/verify-phone-required', params: { from: 'settings' } })} />
            )}
          </SettingsGroup>

          <SettingsGroup header={t('rec.opts.emailHeader')} footer={t('rec.opts.emailFooter')}>
            {hasEmail ? (
              <>
                <SettingsRow
                  icon={IconMail}
                  title={o.recovery_email}
                  subtitle={o.recovery_email_verified ? t('rec.opts.verified') : t('rec.opts.unverified')}
                  onPress={() => { setEmail(o.recovery_email); setErr(''); setForm('email'); }}
                />
                <SettingsRow title={t('rec.opts.remove')} destructive onPress={removeEmail} disabled={busy} />
              </>
            ) : (
              <SettingsRow icon={IconMail} title={t('rec.opts.addEmail')} subtitle={t('rec.opts.addEmailSub')} onPress={() => { setEmail(''); setErr(''); setForm('email'); }} />
            )}
          </SettingsGroup>

          {!!form && (
            <View style={[st.formCard, { backgroundColor: g.cardBg, borderColor: g.separator }]}>
              {form === 'email' ? (
                <>
                  <Text style={[st.formLabel, { color: g.secondary }]}>{t('rec.opts.emailLabel')}</Text>
                  <TextInput
                    style={inputStyle}
                    value={email}
                    onChangeText={(v) => { setEmail(String(v || '').replace(/\s+/g, '')); if (err) setErr(''); }}
                    placeholder="nome@exemplo.com"
                    placeholderTextColor={g.tertiary}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="email"
                    textContentType="emailAddress"
                    autoFocus
                    returnKeyType="send"
                    onSubmitEditing={() => { if (!busy) sendCode(); }}
                    accessibilityLabel={t('rec.opts.emailLabel')}
                  />
                  <Text style={[st.formHint, { color: g.secondary }]}>{t('rec.opts.emailHint')}</Text>
                </>
              ) : (
                <>
                  <Text style={[st.formLabel, { color: g.secondary }]}>{t('rec.opts.codeLabel', { email: maskedTo })}</Text>
                  <TextInput
                    style={[inputStyle, { letterSpacing: 6, fontSize: 20, textAlign: 'center' }]}
                    value={code}
                    onChangeText={(v) => { setCode(String(v || '').replace(/\D/g, '').slice(0, 6)); if (err) setErr(''); }}
                    keyboardType="number-pad"
                    maxLength={6}
                    autoFocus
                    textContentType="oneTimeCode"
                    autoComplete={Platform.OS === 'android' ? 'sms-otp' : 'one-time-code'}
                    returnKeyType="done"
                    onSubmitEditing={() => { if (!busy) confirmCode(); }}
                    accessibilityLabel={t('forgot.enterCode')}
                  />
                </>
              )}
              {!!err && <Text style={[st.err, { color: g.destructive }]}>{err}</Text>}
              <View style={st.formBtns}>
                <TouchableOpacity onPress={() => { setForm(null); setErr(''); }} style={st.ghostBtn} accessibilityRole="button">
                  <Text style={{ color: g.secondary, fontWeight: '600', fontSize: 15 }}>{t('common.cancel') || 'Cancelar'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={form === 'email' ? sendCode : confirmCode}
                  disabled={busy}
                  style={[st.solidBtn, { backgroundColor: g.text }, busy && { opacity: 0.6 }]}
                  accessibilityRole="button"
                >
                  {busy ? <ActivityIndicator color={g.onInk} size="small" />
                    : <Text style={{ color: g.onInk, fontWeight: '700', fontSize: 15 }}>{form === 'email' ? t('rec.opts.sendCode') : t('rec.opts.confirm')}</Text>}
                </TouchableOpacity>
              </View>
              {form === 'code' && (
                <TouchableOpacity onPress={sendCode} disabled={busy} style={{ alignItems: 'center', paddingVertical: 10 }}>
                  <Text style={{ color: g.text, fontWeight: '600', fontSize: 14 }}>{t('forgot.resendCode')}</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
          {!!msg && <Text style={[st.ok, { color: g.text }]}>{msg}</Text>}

          <SettingsGroup header={t('rec.opts.otherHeader')} footer={t('rec.opts.devicesFooter')}>
            <SettingsRow
              icon={IconSmartphone}
              title={t('rec.opts.devices')}
              value={o.devices ? String(o.devices) : undefined}
              subtitle={t('rec.opts.devicesSub')}
              onPress={() => router.push('/linked-devices')}
            />
            {PASSKEYS_ENABLED && (
              <SettingsRow icon={IconKey} title={t('settings.passkeys.title')} value={o.passkeys ? String(o.passkeys) : undefined} onPress={() => router.push('/passkeys')} />
            )}
          </SettingsGroup>
        </>
      )}
    </SettingsScreen>
  );
}

const st = StyleSheet.create({
  intro: { fontSize: 14, lineHeight: 20, paddingHorizontal: 4, marginBottom: 16 },
  nudge: { flexDirection: 'row', gap: 12, padding: 14, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, marginBottom: 18, alignItems: 'flex-start' },
  nudgeTitle: { fontSize: 15, fontWeight: '700', marginBottom: 2 },
  nudgeText: { fontSize: 13, lineHeight: 18 },
  formCard: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 16, marginTop: -8, marginBottom: 18 },
  formLabel: { fontSize: 13, marginBottom: 8, fontWeight: '600' },
  formHint: { fontSize: 12.5, marginTop: 8, lineHeight: 17 },
  input: {
    borderWidth: 1, borderRadius: 12, minHeight: 48, paddingHorizontal: 12, fontSize: 16,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  err: { fontSize: 13, marginTop: 10, fontWeight: '600' },
  ok: { fontSize: 13, marginBottom: 14, paddingHorizontal: 4, fontWeight: '600' },
  formBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 14 },
  ghostBtn: { minHeight: 44, paddingHorizontal: 14, justifyContent: 'center' },
  solidBtn: { minHeight: 44, paddingHorizontal: 18, borderRadius: 12, alignItems: 'center', justifyContent: 'center', minWidth: 120 },
});
