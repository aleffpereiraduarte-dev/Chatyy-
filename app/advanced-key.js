/**
 * /advanced-key — BYOK setup screen.
 *
 * Surfaced from Settings → Segurança → "Chave avançada".
 * Flow:
 *   1. No key yet: show "Gerar chave personalizada" button + explainer.
 *   2. After tap: generate key → show 16-word recovery phrase ONCE → user
 *      types two confirmation words (random positions) to prove they wrote it.
 *   3. Confirmed: show fingerprint + "Apagar chave" + "Verificar com servidor".
 *
 * Key NEVER leaves the device. Only the fingerprint is uploaded.
 */

import { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, TextInput,
  ActivityIndicator, Alert, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import { IconArrowLeft, IconShield, IconCopy, IconTrash, IconCheck, IconAlertTriangle } from '../components/Icons';
import * as byok from '../services/byok';

export default function AdvancedKeyScreen() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [phase, setPhase] = useState('idle');       // idle | generating | showPhrase | confirm | done
  const [mnemonic, setMnemonic] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [confirmPositions, setConfirmPositions] = useState([2, 7]); // 0-indexed
  const [confirmInputs, setConfirmInputs] = useState(['', '']);
  const [existing, setExisting] = useState(null);
  const [busy, setBusy] = useState(false);

  // On mount, check whether the user already has a master key set up. If
  // they do, we skip straight to the "done" view so they can see the
  // fingerprint and choose to rotate/clear.
  useEffect(() => {
    (async () => {
      try {
        const fp = await byok.getMasterKeyFingerprint();
        if (fp) {
          setFingerprint(fp);
          setExisting(true);
          setPhase('done');
        } else {
          setExisting(false);
        }
      } catch {
        setExisting(false);
      }
    })();
  }, []);

  async function handleGenerate() {
    if (busy) return;
    setBusy(true);
    setPhase('generating');
    try {
      const out = await byok.generateMasterKey();
      setMnemonic(out.mnemonic);
      setFingerprint(out.fingerprint);
      // Pick two random positions for the user to type. Stable for the
      // duration of the confirm step so they don't shift mid-typing.
      const all = Array.from({ length: 16 }, (_, i) => i);
      all.sort(() => Math.random() - 0.5);
      setConfirmPositions([all[0], all[1]].sort((a, b) => a - b));
      setConfirmInputs(['', '']);
      setPhase('showPhrase');
    } catch (e) {
      Alert.alert('Erro', e?.message || 'Não foi possível gerar a chave.');
      setPhase('idle');
    } finally {
      setBusy(false);
    }
  }

  function handleVerifyConfirm() {
    const words = mnemonic.split(/\s+/);
    const a = (confirmInputs[0] || '').trim().toLowerCase();
    const b = (confirmInputs[1] || '').trim().toLowerCase();
    if (a !== words[confirmPositions[0]] || b !== words[confirmPositions[1]]) {
      Alert.alert(
        t('byok.wrongWordsTitle') || 'Palavras não conferem',
        t('byok.wrongWordsBody') || 'Confira a frase e tente de novo.'
      );
      return;
    }
    setMnemonic('');           // wipe in-memory copy
    setExisting(true);
    setPhase('done');
  }

  async function handleClear() {
    Alert.alert(
      t('byok.clearTitle') || 'Apagar chave avançada?',
      t('byok.clearBody') || 'Você precisará gerar uma nova chave. As conversas criptografadas com a chave atual não serão recuperáveis sem a frase de segurança.',
      [
        { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
        {
          text: t('byok.clear') || 'Apagar',
          style: 'destructive',
          onPress: async () => {
            try {
              await byok.clearLocalMasterKey();
              try {
                const api = require('../services/api');
                await api.chatMasterKeyFingerprintClear();
              } catch {}
              setExisting(false);
              setFingerprint('');
              setPhase('idle');
            } catch (e) {
              Alert.alert('Erro', e?.message || 'Falha ao apagar.');
            }
          },
        },
      ]
    );
  }

  async function handleVerifyServer() {
    setBusy(true);
    try {
      const r = await byok.verifyAgainstServer();
      if (r.ok) {
        Alert.alert(
          t('byok.verifyOkTitle') || 'Chave confirmada',
          t('byok.verifyOkBody') || 'A chave deste dispositivo corresponde à registrada no servidor.'
        );
      } else {
        Alert.alert(
          t('byok.verifyMismatchTitle') || 'Chave divergente',
          (t('byok.verifyMismatchBody') || 'A chave deste dispositivo não corresponde à do servidor: {reason}.').replace('{reason}', r.reason || 'desconhecido')
        );
      }
    } finally { setBusy(false); }
  }

  const renderIdle = () => (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
      <IconShield size={32} color={colors.primary} />
      <Text style={[styles.h, { color: colors.text }]}>
        {t('byok.heroTitle') || 'Chave avançada (BYOK)'}
      </Text>
      <Text style={[styles.body, { color: colors.textSecondary }]}>
        {t('byok.heroBody') || 'Gere uma chave mestre que só existe no seu aparelho. Todas as conversas criptografadas passam a usar essa chave para criptografar e descriptografar. O servidor apenas armazena uma impressão digital pra verificação — nunca a chave em si.'}
      </Text>
      <TouchableOpacity
        style={[styles.cta, { backgroundColor: colors.primary }]}
        onPress={handleGenerate}
        disabled={busy}
      >
        {busy ? <ActivityIndicator color="#fff" /> :
          <Text style={styles.ctaText}>{t('byok.generate') || 'Gerar chave personalizada'}</Text>}
      </TouchableOpacity>
    </View>
  );

  const renderPhrase = () => (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <IconAlertTriangle size={20} color="#f59e0b" />
        <Text style={[styles.h, { color: colors.text, marginTop: 0 }]}>
          {t('byok.phraseTitle') || 'Anote essa frase'}
        </Text>
      </View>
      <Text style={[styles.body, { color: colors.textSecondary }]}>
        {t('byok.phraseBody') || 'Essa frase é a única forma de recuperar sua chave em outro aparelho. Anote em local seguro e off-line. Ninguém da equipe pode te ajudar a recuperá-la.'}
      </Text>
      <View style={[styles.phraseBox, { backgroundColor: colors.background, borderColor: colors.borderLight }]}>
        {mnemonic.split(/\s+/).map((w, i) => (
          <View key={i} style={[styles.wordCell, { backgroundColor: colors.surface }]}>
            <Text style={[styles.wordIdx, { color: colors.textTertiary }]}>{i + 1}</Text>
            <Text style={[styles.wordText, { color: colors.text }]}>{w}</Text>
          </View>
        ))}
      </View>
      <TouchableOpacity
        style={[styles.cta, { backgroundColor: colors.primary, marginTop: Spacing.md }]}
        onPress={() => setPhase('confirm')}
      >
        <Text style={styles.ctaText}>{t('byok.iWroteIt') || 'Anotei a frase'}</Text>
      </TouchableOpacity>
    </View>
  );

  const renderConfirm = () => (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
      <Text style={[styles.h, { color: colors.text }]}>
        {t('byok.confirmTitle') || 'Confirme duas palavras'}
      </Text>
      <Text style={[styles.body, { color: colors.textSecondary }]}>
        {t('byok.confirmBody') || 'Digite as duas palavras pedidas pra confirmar que você anotou a frase corretamente.'}
      </Text>
      {confirmPositions.map((pos, idx) => (
        <View key={pos} style={{ marginTop: Spacing.md }}>
          <Text style={[styles.label, { color: colors.text }]}>
            {(t('byok.wordN') || 'Palavra #{n}').replace('{n}', String(pos + 1))}
          </Text>
          <TextInput
            style={[styles.input, { borderColor: colors.borderLight, color: colors.text, backgroundColor: colors.background }]}
            value={confirmInputs[idx]}
            onChangeText={(v) => setConfirmInputs(prev => {
              const next = [...prev]; next[idx] = v.toLowerCase(); return next;
            })}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder=""
            placeholderTextColor={colors.textTertiary}
          />
        </View>
      ))}
      <TouchableOpacity
        style={[styles.cta, { backgroundColor: colors.primary, marginTop: Spacing.lg }]}
        onPress={handleVerifyConfirm}
      >
        <Text style={styles.ctaText}>{t('byok.confirmCta') || 'Confirmar'}</Text>
      </TouchableOpacity>
    </View>
  );

  const renderDone = () => (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <IconCheck size={20} color="#10b981" />
        <Text style={[styles.h, { color: colors.text, marginTop: 0 }]}>
          {t('byok.doneTitle') || 'Chave ativa'}
        </Text>
      </View>
      <Text style={[styles.body, { color: colors.textSecondary }]}>
        {t('byok.doneBody') || 'Sua chave avançada está em uso. Confira regularmente que a impressão digital deste aparelho bate com a do servidor.'}
      </Text>
      <View style={[styles.fpBox, { backgroundColor: colors.background, borderColor: colors.borderLight }]}>
        <Text style={[styles.fpLabel, { color: colors.textTertiary }]}>
          {t('byok.fingerprint') || 'Impressão digital'}
        </Text>
        <Text style={[styles.fpValue, { color: colors.text }]} selectable>{fingerprint}</Text>
      </View>
      <TouchableOpacity
        style={[styles.ctaSecondary, { borderColor: colors.borderLight }]}
        onPress={handleVerifyServer}
        disabled={busy}
      >
        <Text style={[styles.ctaSecondaryText, { color: colors.text }]}>
          {t('byok.verifyServer') || 'Verificar com servidor'}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.ctaSecondary, { borderColor: '#ef4444', marginTop: Spacing.sm }]}
        onPress={handleClear}
      >
        <IconTrash size={16} color="#ef4444" />
        <Text style={[styles.ctaSecondaryText, { color: '#ef4444' }]}>
          {t('byok.clear') || 'Apagar chave deste aparelho'}
        </Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: colors.borderLight }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text, marginLeft: Spacing.md }]}>
          {t('byok.title') || 'Chave avançada'}
        </Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: Spacing.md, paddingBottom: 32 }}>
        {existing === null ? <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} /> :
          phase === 'idle' ? renderIdle() :
          phase === 'showPhrase' ? renderPhrase() :
          phase === 'confirm' ? renderConfirm() :
          renderDone()}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: FontSize.lg, fontWeight: '700' },
  card: {
    padding: Spacing.lg, borderRadius: BorderRadius.lg, borderWidth: 1, gap: 4,
  },
  h: { fontSize: FontSize.lg, fontWeight: '700', marginTop: Spacing.sm },
  body: { fontSize: FontSize.md, lineHeight: 22, marginTop: Spacing.xs },
  cta: {
    marginTop: Spacing.md, paddingVertical: 14, borderRadius: BorderRadius.md,
    alignItems: 'center',
  },
  ctaText: { color: '#fff', fontWeight: '700', fontSize: FontSize.md },
  ctaSecondary: {
    marginTop: Spacing.md, paddingVertical: 12, borderRadius: BorderRadius.md,
    alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8,
    borderWidth: 1,
  },
  ctaSecondaryText: { fontWeight: '600', fontSize: FontSize.md },
  phraseBox: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 6, padding: 10,
    borderRadius: BorderRadius.md, borderWidth: 1, marginTop: Spacing.md,
  },
  wordCell: {
    flexDirection: 'row', alignItems: 'baseline', gap: 4,
    paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6, minWidth: '30%',
  },
  wordIdx: { fontSize: FontSize.sm, fontWeight: '600' },
  wordText: { fontSize: FontSize.md, fontWeight: '600' },
  label: { fontSize: FontSize.sm, fontWeight: '600' },
  input: {
    borderWidth: 1, borderRadius: BorderRadius.md, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: FontSize.md, marginTop: 6,
  },
  fpBox: {
    marginTop: Spacing.md, padding: 12, borderRadius: BorderRadius.md, borderWidth: 1,
  },
  fpLabel: { fontSize: FontSize.sm, fontWeight: '600' },
  fpValue: { fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginTop: 4 },
});
