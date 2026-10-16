/**
 * [2026-10-16 pgp-v2] Cartão no leitor de e-mail p/ mensagens OpenPGP:
 * cifrada (BEGIN PGP MESSAGE) → pede a senha da chave, decifra e mostra o texto
 * + status da assinatura; só assinada (BEGIN PGP SIGNED MESSAGE) → verifica.
 * Renderiza null quando o e-mail não tem bloco PGP (custo: 1 regex).
 */
import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { IconLock, IconUnlock, IconCheckCircle, IconAlertTriangle, IconShield, IconEye, IconEyeOff, IconKey } from '../Icons';
import { emailPlainText, PGP_MSG_RE, PGP_SIGNED_RE } from '../../services/pgp';

function senderAddress(email) {
  const f = String(email?.from_email || email?.from || '');
  const m = /<([^>]+)>/.exec(f) || /([^\s<>"]+@[^\s<>"]+)/.exec(f);
  return (m ? m[1] : f).trim().toLowerCase();
}

export default function PgpMessageCard({ email, colors }) {
  const { user } = useAuth() || {};
  const { t } = useLanguage();
  const router = useRouter();
  const me = String(user?.email || '').toLowerCase();
  const block = useMemo(() => {
    try {
      const txt = emailPlainText(email);
      const enc = PGP_MSG_RE.exec(txt);
      if (enc) return { kind: 'enc', armored: enc[0] };
      const sig = PGP_SIGNED_RE.exec(txt);
      if (sig) return { kind: 'sig', armored: sig[0] };
    } catch {}
    return null;
  }, [email?.uid, email?.body_html, email?.body_text, email?.body]);

  const [pass, setPass] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { text, signature }
  const [err, setErr] = useState('');
  const [hidden, setHidden] = useState(false);

  const run = useCallback(async (withPass) => {
    if (!block) return;
    setBusy(true); setErr('');
    try {
      const P = await import('../../services/pgp');
      const from = senderAddress(email);
      if (block.kind === 'sig') {
        setResult(await P.verifyCleartext({ me, armored: block.armored, senderEmail: from }));
      } else {
        const mine = await P.getMyKey(me);
        if (!mine) { setErr('no_key'); return; }
        setResult(await P.decryptMessage({ me, armored: block.armored, passphrase: withPass, senderEmail: from }));
        setPass('');
      }
      setHidden(false);
    } catch (e) {
      setErr(e?.code || 'decrypt_failed');
    } finally { setBusy(false); }
  }, [block, email, me]);

  if (!block) return null;
  const c = colors;
  const sigLine = (() => {
    if (!result) return null;
    const from = senderAddress(email);
    switch (result.signature) {
      case 'valid': return { Icon: IconCheckCircle, text: t('pgpMsg.sigValid', { email: from }), strong: true };
      case 'invalid': return { Icon: IconAlertTriangle, text: t('pgpMsg.sigInvalid'), danger: true };
      case 'unknown': return { Icon: IconShield, text: t('pgpMsg.sigUnknown') };
      default: return { Icon: IconShield, text: t('pgpMsg.unsigned') };
    }
  })();
  const errMsg = err === 'wrong_passphrase' ? t('pgp.wrongPassphrase')
    : err === 'no_key' ? t('pgpMsg.noKey')
    : err === 'not_for_you' ? t('pgpMsg.notForYou')
    : err ? t('pgpMsg.failed') : '';

  return (
    <View style={[st.card, { borderColor: c.border, backgroundColor: c.surface }]}>
      <View style={st.head}>
        <View style={[st.icon, { backgroundColor: c.text }]}>
          {result ? <IconUnlock size={16} color={c.background} /> : <IconLock size={16} color={c.background} />}
        </View>
        <Text style={[st.title, { color: c.text }]}>{block.kind === 'enc' ? t('pgpMsg.encrypted') : t('pgpMsg.signedOnly')}</Text>
        {result && (
          <TouchableOpacity onPress={() => setHidden(h => !h)} hitSlop={8}>
            <Text style={[st.link, { color: c.textSecondary }]}>{hidden ? t('pgpMsg.show') : t('pgpMsg.hide')}</Text>
          </TouchableOpacity>
        )}
      </View>

      {!result && block.kind === 'enc' && err !== 'no_key' && (
        <>
          <Text style={[st.hint, { color: c.textSecondary }]}>{t('pgpMsg.enterPassphrase')}</Text>
          <View style={[st.inputWrap, { borderColor: c.border, backgroundColor: c.background }]}>
            <TextInput value={pass} onChangeText={setPass} secureTextEntry={!show} autoCapitalize="none" autoCorrect={false}
              placeholder={t('pgp.passphraseEnter')} placeholderTextColor={c.textTertiary}
              onSubmitEditing={() => pass && run(pass)} style={[st.input, { color: c.text }]} />
            <TouchableOpacity onPress={() => setShow(v => !v)} hitSlop={8} style={{ paddingHorizontal: 10 }}>
              {show ? <IconEyeOff size={17} color={c.textSecondary} /> : <IconEye size={17} color={c.textSecondary} />}
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={() => run(pass)} disabled={!pass || busy} activeOpacity={0.8}
            style={[st.btn, { backgroundColor: c.text, opacity: !pass || busy ? 0.5 : 1 }]}>
            {busy ? <ActivityIndicator color={c.background} /> : <Text style={[st.btnText, { color: c.background }]}>{t('pgpMsg.decrypt')}</Text>}
          </TouchableOpacity>
        </>
      )}

      {!result && block.kind === 'sig' && (
        <TouchableOpacity onPress={() => run('')} disabled={busy} activeOpacity={0.8} style={[st.btn, { backgroundColor: c.text, opacity: busy ? 0.5 : 1 }]}>
          {busy ? <ActivityIndicator color={c.background} /> : <Text style={[st.btnText, { color: c.background }]}>{t('pgpMsg.verify')}</Text>}
        </TouchableOpacity>
      )}

      {!!errMsg && (
        <View style={st.errRow}>
          <IconAlertTriangle size={14} color={c.error || '#d11'} />
          <Text style={[st.errText, { color: c.error || '#d11' }]}>{errMsg}</Text>
        </View>
      )}
      {err === 'no_key' && (
        <TouchableOpacity onPress={() => router.push('/pgp-keys')} style={[st.btn, { borderWidth: 1, borderColor: c.border, marginTop: 10 }]}>
          <IconKey size={15} color={c.text} />
          <Text style={[st.btnText, { color: c.text, marginLeft: 6 }]}>{t('pgp.title')}</Text>
        </TouchableOpacity>
      )}

      {result && sigLine && (
        <View style={[st.sig, { borderColor: sigLine.danger ? (c.error || '#d11') : c.borderLight }]}>
          <sigLine.Icon size={15} color={sigLine.danger ? (c.error || '#d11') : c.text} />
          <Text style={[st.sigText, { color: sigLine.danger ? (c.error || '#d11') : c.text, fontWeight: sigLine.strong ? '700' : '500' }]}>{sigLine.text}</Text>
        </View>
      )}
      {result && !hidden && (
        <Text selectable style={[st.plain, { color: c.text, backgroundColor: c.background, borderColor: c.borderLight }]}>{result.text}</Text>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  card: { marginHorizontal: 16, marginVertical: 10, padding: 14, borderRadius: 14, borderWidth: 1 },
  head: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  icon: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  title: { flex: 1, fontSize: 15, fontWeight: '800' },
  link: { fontSize: 13, fontWeight: '600' },
  hint: { fontSize: 13, marginBottom: 8 },
  inputWrap: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 10 },
  input: { flex: 1, paddingHorizontal: 12, paddingVertical: Platform.OS === 'ios' ? 11 : 8, fontSize: 15 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderRadius: 10, marginTop: 10 },
  btnText: { fontWeight: '800', fontSize: 14 },
  errRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 6 },
  errText: { flex: 1, fontSize: 13 },
  sig: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 10, padding: 10, marginTop: 4, gap: 8 },
  sigText: { flex: 1, fontSize: 13 },
  plain: { marginTop: 10, padding: 12, borderRadius: 10, borderWidth: 1, fontSize: 15, lineHeight: 22 },
});
