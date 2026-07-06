/**
 * /pgp-keys — Manage OpenPGP keypair for end-to-end email encryption.
 *
 * - Generates a 4096-bit RSA keypair locally via openpgpjs.
 * - Private key is encrypted with the user's passphrase and stored
 *   exclusively in expo-secure-store. Never leaves the device.
 * - Public key armor + fingerprint go to PG via pgp_key_upload so
 *   senders can look it up by email.
 * - "Compartilhar chave" surface lets the user manually email/share
 *   the armored public block.
 *
 * Encryption from compose.js calls pgpKeyGet(recipient) → openpgp.encrypt
 * → drops the armored block into the email body. If the recipient has no
 * key on file, compose offers a passphrase fallback (symmetric encryption
 * with a generated passphrase that's SMS'd via pgpSendPassphraseSms).
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, TextInput,
  ActivityIndicator, Alert, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { Spacing, BorderRadius, FontSize } from '../constants/theme';
import { IconLock, IconKey, IconTrash, IconShare, IconCheck } from '../components/Icons';
import { pgpKeyUpload, pgpKeyDelete, pgpKeyGet } from '../services/api';
import ModalHeader from '../components/ModalHeader';
import FadeSlideIn from '../components/FadeSlideIn';
import PressableScale from '../components/PressableScale';
import * as SecureStore from 'expo-secure-store';
import * as Clipboard from 'expo-clipboard';

// openpgpjs is heavy (~600KB minified). Load lazily so the rest of the
// app doesn't pay for it.
let openpgp = null;
async function loadOpenPGP() {
  if (openpgp) return openpgp;
  // Use the browser bundle directly — the package's "main" field points to the
  // Node build which imports "module" (Node built-in unavailable in RN).
  openpgp = await import('openpgp/dist/openpgp.min.mjs');
  return openpgp;
}

const SS_KEY_PRIVATE = 'pgp_private_armor_v1';
const SS_KEY_PUBLIC = 'pgp_public_armor_v1';
const SS_KEY_FPR = 'pgp_fingerprint_v1';

async function ssGet(k) {
  try { return (await SecureStore.getItemAsync(k)) || ''; } catch { return ''; }
}
async function ssSet(k, v) {
  try { await SecureStore.setItemAsync(k, v); } catch {}
}
async function ssDel(k) {
  try { await SecureStore.deleteItemAsync(k); } catch {}
}

export default function PgpKeysScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth() || {};
  const [hasKey, setHasKey] = useState(false);
  const [fingerprint, setFingerprint] = useState('');
  const [publicArmor, setPublicArmor] = useState('');
  const [busy, setBusy] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [serverHas, setServerHas] = useState(null); // null=unknown, false/true

  const load = useCallback(async () => {
    const priv = await ssGet(SS_KEY_PRIVATE);
    const pub = await ssGet(SS_KEY_PUBLIC);
    const fpr = await ssGet(SS_KEY_FPR);
    setHasKey(!!priv && !!pub);
    setFingerprint(fpr || '');
    setPublicArmor(pub || '');
    if (user?.email) {
      try {
        const r = await pgpKeyGet(user.email);
        if (r?.success) setServerHas(!!r.data?.found);
      } catch {}
    }
  }, [user?.email]);

  useEffect(() => { load(); }, [load]);

  const generate = useCallback(async () => {
    if (!passphrase || passphrase.length < 8) {
      Alert.alert(t('pgp.error') || 'Erro', t('pgp.passphraseShort') || 'Senha precisa ter ao menos 8 caracteres.');
      return;
    }
    if (passphrase !== confirmPassphrase) {
      Alert.alert(t('pgp.error') || 'Erro', t('pgp.passphraseMismatch') || 'As senhas não conferem.');
      return;
    }
    setBusy(true);
    try {
      const pgp = await loadOpenPGP();
      const { privateKey, publicKey } = await pgp.generateKey({
        type: 'rsa',
        rsaBits: 4096,
        userIDs: [{ name: user?.email || 'Chatyy User', email: user?.email || '' }],
        passphrase,
        format: 'armored',
      });
      // Parse public for fingerprint.
      const pubObj = await pgp.readKey({ armoredKey: publicKey });
      const fpr = pubObj.getFingerprint().toUpperCase();
      await ssSet(SS_KEY_PRIVATE, privateKey);
      await ssSet(SS_KEY_PUBLIC, publicKey);
      await ssSet(SS_KEY_FPR, fpr);
      // Upload public to PG so senders can encrypt to us.
      try { await pgpKeyUpload(publicKey, fpr); } catch (e) { console.warn('pgp upload', e); }
      setHasKey(true);
      setFingerprint(fpr);
      setPublicArmor(publicKey);
      setServerHas(true);
      setPassphrase(''); setConfirmPassphrase('');
      Alert.alert(t('pgp.ok') || 'Pronto', t('pgp.generated') || 'Chave PGP gerada e publicada.');
    } catch (e) {
      Alert.alert(t('pgp.error') || 'Erro', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }, [passphrase, confirmPassphrase, user?.email, t]);

  const revoke = useCallback(() => {
    Alert.alert(
      t('pgp.revokeConfirm') || 'Apagar chave PGP?',
      t('pgp.revokeWarning') || 'Você não conseguirá ler emails criptografados antigos sem essa chave. Salve um backup antes.',
      [
        { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
        { text: t('pgp.revoke') || 'Apagar', style: 'destructive', onPress: async () => {
          await ssDel(SS_KEY_PRIVATE);
          await ssDel(SS_KEY_PUBLIC);
          await ssDel(SS_KEY_FPR);
          try { await pgpKeyDelete(); } catch {}
          setHasKey(false); setFingerprint(''); setPublicArmor(''); setServerHas(false);
        }},
      ],
    );
  }, [t]);

  const copyPublic = useCallback(async () => {
    if (!publicArmor) return;
    try {
      await Clipboard.setStringAsync(publicArmor);
      Alert.alert(t('pgp.copied') || 'Copiado', t('pgp.publicCopied') || 'Chave pública copiada — cole onde quiser compartilhar.');
    } catch {}
  }, [publicArmor, t]);

  return (
    <View style={[s.root, { backgroundColor: colors.background }]}>
      <ModalHeader title={t('pgp.title') || 'Chave PGP'} onClose={() => router.back()} />
      <FadeSlideIn>
      <ScrollView contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 80 }}>
        <Text style={[s.intro, { color: colors.textSecondary }]}>
          {t('pgp.intro') || 'Gere uma chave OpenPGP pra trocar emails criptografados ponta-a-ponta. A chave privada nunca sai do seu aparelho.'}
        </Text>

        {hasKey ? (
          <>
            <View style={[s.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
              <View style={s.cardHead}>
                <View style={[s.cardIconChip, { backgroundColor: '#10b98118' }]}>
                  <IconCheck size={18} color="#10b981" />
                </View>
                <Text style={[s.cardHeadTitle, { color: colors.text }]}>
                  {t('pgp.active') || 'Chave PGP ativa'}
                </Text>
              </View>
              <Text style={{ color: colors.textTertiary, fontSize: FontSize.xs, marginBottom: 6 }}>
                Fingerprint
              </Text>
              <Text selectable style={[s.fingerprint, { color: colors.text, backgroundColor: colors.borderLight + '44' }]}>
                {fingerprint.match(/.{1,4}/g)?.join(' ') || fingerprint}
              </Text>
              <Text style={{ color: colors.textTertiary, fontSize: FontSize.xs, marginTop: 10 }}>
                {t('pgp.serverState') || 'No servidor'}: {serverHas === null ? '—' : (serverHas ? (t('pgp.published') || 'publicada') : (t('pgp.notPublished') || 'não publicada'))}
              </Text>
            </View>

            <TouchableOpacity style={[s.actionBtn, { borderColor: colors.border, backgroundColor: colors.surface }]} onPress={copyPublic}>
              <IconShare size={18} color={colors.primary} />
              <Text style={[s.actionLabel, { color: colors.text }]}>{t('pgp.copyPublic') || 'Copiar chave pública'}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[s.actionBtn, { borderColor: colors.error + '40', backgroundColor: colors.errorBg }]} onPress={revoke}>
              <IconTrash size={18} color={colors.error} />
              <Text style={[s.actionLabel, { color: colors.error }]}>{t('pgp.revoke') || 'Apagar chave'}</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <View style={[s.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
              <View style={s.cardHead}>
                <View style={[s.cardIconChip, { backgroundColor: colors.primaryLight }]}>
                  <IconKey size={18} color={colors.primary} />
                </View>
                <Text style={[s.cardHeadTitle, { color: colors.text }]}>
                  {t('pgp.generateTitle') || 'Gerar nova chave'}
                </Text>
              </View>
              <Text style={{ color: colors.textTertiary, fontSize: FontSize.xs, marginBottom: 10 }}>
                {t('pgp.generateHint') || 'Defina uma senha que protege sua chave privada. Anota num cofre — sem essa senha você perde acesso aos emails criptografados.'}
              </Text>
              <TextInput
                style={[s.input, { color: colors.text, borderColor: colors.borderLight }]}
                placeholder={t('pgp.passphrasePlaceholder') || 'Senha (>= 8 caracteres)'}
                placeholderTextColor={colors.textTertiary}
                secureTextEntry
                value={passphrase}
                onChangeText={setPassphrase}
              />
              <TextInput
                style={[s.input, { color: colors.text, borderColor: colors.borderLight }]}
                placeholder={t('pgp.passphraseConfirm') || 'Confirme a senha'}
                placeholderTextColor={colors.textTertiary}
                secureTextEntry
                value={confirmPassphrase}
                onChangeText={setConfirmPassphrase}
              />
              <PressableScale
                disabled={busy}
                style={[s.primaryBtn, { backgroundColor: colors.primary, opacity: busy ? 0.7 : 1 }]}
                onPress={generate}
              >
                {busy ? <ActivityIndicator color="#fff" /> : (
                  <>
                    <IconLock size={18} color="#fff" />
                    <Text style={s.primaryBtnLabel}>{t('pgp.generate') || 'Gerar chave PGP'}</Text>
                  </>
                )}
              </PressableScale>
            </View>
          </>
        )}
      </ScrollView>
      </FadeSlideIn>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  intro: { fontSize: FontSize.sm, lineHeight: 20, marginBottom: Spacing.lg },
  card: { padding: Spacing.lg, borderRadius: BorderRadius.xl, borderWidth: 1, marginBottom: Spacing.md },
  cardHead: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md },
  cardIconChip: {
    width: 36, height: 36, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center', marginRight: 10,
  },
  cardHeadTitle: { fontSize: FontSize.lg, fontWeight: '800', letterSpacing: -0.2 },
  fingerprint: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', web: 'monospace' }),
    fontSize: 13, padding: 12, borderRadius: BorderRadius.md, letterSpacing: 1,
  },
  input: {
    borderWidth: 1, borderRadius: BorderRadius.md,
    paddingHorizontal: 14, paddingVertical: 12,
    fontSize: FontSize.base, marginBottom: 10,
  },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 14, borderRadius: BorderRadius.lg, marginTop: 6,
    shadowColor: '#7C3AED', shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.28, shadowRadius: 14, elevation: 6,
  },
  primaryBtnLabel: { color: '#fff', fontWeight: '800', marginLeft: 8, fontSize: FontSize.base },
  actionBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 14, paddingHorizontal: Spacing.lg,
    borderWidth: 1, borderRadius: BorderRadius.lg, marginBottom: Spacing.sm,
  },
  actionLabel: { fontWeight: '700', marginLeft: 10, fontSize: FontSize.base },
});
