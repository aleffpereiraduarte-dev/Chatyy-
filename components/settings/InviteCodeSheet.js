// [bia-convite 2026-10-19] "Tenho um código de convite" — folha pequena que chama
// apply_referral (services/pendingReferral.applyReferralCode) e mostra uma
// mensagem amigável: registrado / já registrado / inválido / próprio código /
// conta antiga demais. Servidor sem o kit = "ainda não disponível".
import { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, Platform, StyleSheet } from 'react-native';
import NativeSheetDialog from '../NativeSheetDialog';
import { useGroupedColors } from './SettingsKit';
import { HapticsCompat as Haptics } from '../../services/haptics';
import { applyReferralCode, clearPendingRef, getPendingRef, normalizeRefCode } from '../../services/pendingReferral';

function messageFor(res, t) {
  const n = res.maxDays || 7;
  switch (res.reason) {
    case 'applied': return { ok: true, text: t('invite.code.applied', 'Pronto! Convite registrado. Obrigado por entrar pelo convite.') };
    case 'already_applied': return { ok: true, text: t('invite.code.alreadyApplied', 'Esse convite já está registrado na sua conta.') };
    case 'already_referred': return { ok: false, text: t('invite.code.alreadyReferred', 'Sua conta já tem um convite registrado.') };
    case 'invalid_code':
    case 'missing_code': return { ok: false, text: t('invite.code.invalid', 'Código não encontrado. Confira e tente de novo.') };
    case 'self_referral': return { ok: false, text: t('invite.code.self', 'Esse é o seu próprio código. Use o código de quem te convidou.') };
    case 'account_too_old':
    case 'account_age_unknown': return { ok: false, text: t('invite.code.tooOld', 'O código de convite só pode ser usado nos primeiros {n} dias da conta.').split('{n}').join(String(n)) };
    case 'cycle': return { ok: false, text: t('invite.code.cycle', 'Esse convite não pode ser usado nesta conta.') };
    case 'rate_limited': return { ok: false, text: t('invite.code.rateLimited', 'Muitas tentativas. Tente de novo mais tarde.') };
    case 'unsupported': return { ok: false, text: t('invite.code.unsupported', 'Ainda não dá para usar códigos de convite aqui. Tente de novo mais tarde.') };
    default: return { ok: false, text: t('invite.code.error', 'Não consegui registrar agora. Verifique a conexão e tente de novo.') };
  }
}

export default function InviteCodeSheet({ visible, onClose, t }) {
  const g = useGroupedColors();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { ok, text }

  useEffect(() => {
    if (!visible) return undefined;
    let alive = true;
    setResult(null); setBusy(false);
    getPendingRef().then((c) => { if (alive && c) setCode((cur) => cur || c); }).catch(() => {});
    return () => { alive = false; };
  }, [visible]);

  const valid = !!normalizeRefCode(code);
  const submit = useCallback(async () => {
    if (busy) return;
    const c = normalizeRefCode(code);
    if (!c) { setResult({ ok: false, text: t('invite.code.invalid', 'Código não encontrado. Confira e tente de novo.') }); return; }
    setBusy(true); setResult(null);
    const res = await applyReferralCode(c);
    if (res.definitive) await clearPendingRef();
    const m = messageFor(res, t);
    try { Haptics.notificationAsync?.(m.ok ? 'success' : 'error'); } catch {}
    setResult(m);
    setBusy(false);
  }, [busy, code, t]);

  const done = !!result?.ok;
  return (
    <NativeSheetDialog
      visible={!!visible}
      onClose={onClose}
      animationType="slide"
      overlayStyle={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }}
      panelStyle={[s.panel, { backgroundColor: g.cardBg }]}
    >
      <Text style={[s.title, { color: g.text }]} accessibilityRole="header">{t('invite.code.title', 'Tenho um código de convite')}</Text>
      <Text style={[s.hint, { color: g.secondary }]}>{t('invite.code.hint', 'Digite o código de quem te convidou. Vale nos primeiros dias da conta.')}</Text>
      <TextInput
        value={code}
        onChangeText={(v) => { setCode(String(v || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 32)); if (result) setResult(null); }}
        onSubmitEditing={submit}
        editable={!busy && !done}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        returnKeyType="done"
        maxLength={32}
        placeholder={t('invite.code.placeholder', 'Ex: A1B2C3D4')}
        placeholderTextColor={g.secondary}
        style={[s.input, { color: g.text, backgroundColor: g.fill }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]}
        accessibilityLabel={t('invite.code.title', 'Tenho um código de convite')}
      />
      {!!result && (
        <Text style={[s.result, { color: result.ok ? g.text : g.secondary }]} accessibilityLiveRegion="polite">{result.text}</Text>
      )}
      <View style={s.row}>
        <Pressable onPress={onClose} style={[s.btn, { backgroundColor: g.fill }]} accessibilityRole="button">
          <Text style={[s.btnText, { color: g.text }]}>{done ? t('common.close', 'Fechar') : t('common.cancel', 'Cancelar')}</Text>
        </Pressable>
        {!done && (
          <Pressable
            onPress={submit}
            disabled={busy || !valid}
            style={[s.btn, { backgroundColor: g.ink, opacity: busy || !valid ? 0.5 : 1 }]}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy || !valid }}
          >
            {busy ? <ActivityIndicator size="small" color={g.onInk} /> : <Text style={[s.btnText, { color: g.onInk }]}>{t('invite.code.apply', 'Usar código')}</Text>}
          </Pressable>
        )}
      </View>
    </NativeSheetDialog>
  );
}

const s = StyleSheet.create({
  panel: { width: '100%', maxWidth: 520, alignSelf: 'center', borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 18, paddingTop: 18, paddingBottom: 18 },
  title: { fontSize: 17, fontWeight: '600', letterSpacing: -0.3, marginBottom: 4 },
  hint: { fontSize: 13.5, lineHeight: 19, marginBottom: 14 },
  input: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 17, fontWeight: '600', letterSpacing: 1.5 },
  result: { fontSize: 14, lineHeight: 20, marginTop: 12 },
  row: { flexDirection: 'row', marginTop: 16 },
  btn: { flex: 1, minHeight: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginHorizontal: 4 },
  btnText: { fontSize: 15, fontWeight: '600' },
});
