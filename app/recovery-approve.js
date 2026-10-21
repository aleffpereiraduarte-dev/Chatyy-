// [recovery 2026-10-18] "Você está tentando recuperar sua conta?" — prompt no
// aparelho já conectado (estilo Gmail): mostra 3 números; o dono toca no que
// aparece na tela de quem está recuperando. Número errado ou "Não fui eu" nega.
// Aberto pelo push account_recovery_prompt ou pelo RecoveryPromptHost.
import { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { recoveryDevicePending, recoveryDeviceRespond } from '../services/api';
import { IconX, IconShield, IconCheckCircle, IconAlertTriangle } from '../components/Icons';
import { success as hSuccess, warning as hWarning, selection as hSelection } from '../services/haptics';

export default function RecoveryApprove() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [req, setReq] = useState(null);
  const [result, setResult] = useState(''); // '' | approved | denied | wrong | expired | none
  const [, setTick] = useState(0);
  const [netErr, setNetErr] = useState(false); // [2026-10-21] falha de rede ≠ "expirou

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await recoveryDevicePending();
      if (r?.success && r.data?.pending) { setReq({ ...r.data, until: Date.now() + 1000 * Number(r.data.expires_in || 0) }); setResult(''); }
      else { setReq(null); setResult((p) => p || 'none'); }
    } catch { setReq(null); setResult((p) => p || 'none'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!req) return undefined;
    const id = setInterval(() => {
      setTick(x => x + 1);
      if (Date.now() > req.until) { setReq(null); setResult('expired'); }
    }, 1000);
    return () => clearInterval(id);
  }, [req]);

  const close = () => {
    hSelection();
    try { if (router.canGoBack?.()) { router.back(); return; } } catch {}
    router.replace('/');
  };

  const respond = async (approve, number) => {
    if (!req || busy) return;
    setBusy(true);
    setNetErr(false);
    try {
      const r = await recoveryDeviceRespond(req.challenge_id, approve, number);
      if (r?.success) {
        if (r.data?.status === 'approved') { hSuccess(); setResult('approved'); }
        else { try { hWarning?.(); } catch {} setResult(r.data?.wrong_number ? 'wrong' : 'denied'); }
      } else {
        setResult('expired');
      }
      setReq(null);
    } catch {
      // Rede caiu: mantém o pedido na tela p/ tentar de novo (antes dizia "expirou").
      try { hWarning?.(); } catch {}
      setNetErr(true);
    }
    finally { setBusy(false); }
  };

  const fmtWhen = (sec) => {
    try {
      const d = new Date(Number(sec) * 1000);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch { return ''; }
  };

  const renderBody = () => {
    if (loading) return <ActivityIndicator style={{ marginTop: 60 }} color={colors.text} />;
    if (req) {
      const left = Math.max(0, Math.ceil((req.until - Date.now()) / 1000));
      return (
        <>
          <View style={[s.icon, { backgroundColor: colors.surfaceVariant }]}>
            <IconShield size={30} color={colors.text} />
          </View>
          <Text style={[s.title, { color: colors.text }]} accessibilityRole="header">{t('rec.approve.title')}</Text>
          <Text style={[s.sub, { color: colors.textSecondary }]}>
            {t('rec.approve.sub', { device: req.device_label || t('rec.approve.unknownDevice'), time: fmtWhen(req.created_at) })}
          </Text>
          <Text style={[s.account, { color: colors.text }]}>{req.account}</Text>
          <Text style={[s.prompt, { color: colors.text }]}>{t('rec.approve.tapNumber')}</Text>
          <View style={s.choices}>
            {(req.choices || []).map((n) => (
              <TouchableOpacity
                key={n}
                style={[s.choice, { borderColor: colors.text }]}
                onPress={() => respond(true, n)}
                disabled={busy}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={t('rec.device.numberA11y', { n })}
              >
                <Text style={[s.choiceText, { color: colors.text }]}>{n}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity
            style={[s.denyBtn, { backgroundColor: colors.text }]}
            onPress={() => respond(false, 0)}
            disabled={busy}
            activeOpacity={0.85}
            accessibilityRole="button"
          >
            {busy ? <ActivityIndicator color={colors.background} /> : <Text style={[s.denyText, { color: colors.background }]}>{t('rec.approve.deny')}</Text>}
          </TouchableOpacity>
          {netErr ? <Text style={[s.warn, { color: colors.error }]} accessibilityLiveRegion="polite">{t('rec.err.network')}</Text> : null}
          <Text style={[s.warn, { color: colors.textTertiary }]}>{t('rec.approve.warn')}</Text>
          <Text style={[s.timer, { color: colors.textTertiary }]}>{t('rec.approve.expiresIn', { s: left })}</Text>
        </>
      );
    }
    const ok = result === 'approved';
    const map = {
      approved: [t('rec.approve.okTitle'), t('rec.approve.okDesc')],
      denied: [t('rec.approve.deniedTitle'), t('rec.approve.deniedDesc')],
      wrong: [t('rec.approve.wrongTitle'), t('rec.approve.deniedDesc')],
      expired: [t('rec.approve.expiredTitle'), t('rec.approve.expiredDesc')],
      none: [t('rec.approve.noneTitle'), t('rec.approve.noneDesc')],
    };
    const [ti, de] = map[result] || map.none;
    return (
      <>
        <View style={[s.icon, { backgroundColor: colors.surfaceVariant }]}>
          {ok ? <IconCheckCircle size={30} color={colors.text} /> : <IconAlertTriangle size={28} color={colors.text} />}
        </View>
        <Text style={[s.title, { color: colors.text }]} accessibilityRole="header">{ti}</Text>
        <Text style={[s.sub, { color: colors.textSecondary }]}>{de}</Text>
        {(result === 'denied' || result === 'wrong') && (
          <TouchableOpacity style={[s.secondaryBtn, { borderColor: colors.border || colors.textTertiary }]} onPress={() => router.replace('/linked-devices')} activeOpacity={0.7}>
            <Text style={[s.secondaryText, { color: colors.text }]}>{t('rec.approve.reviewDevices')}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={[s.denyBtn, { backgroundColor: colors.text, marginTop: 16 }]} onPress={close} activeOpacity={0.85}>
          <Text style={[s.denyText, { color: colors.background }]}>{t('common.close') || 'Fechar'}</Text>
        </TouchableOpacity>
      </>
    );
  };

  return (
    <View style={[s.root, { backgroundColor: colors.background, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 16 }]}>
      <View style={s.topBar}>
        <TouchableOpacity onPress={close} style={s.closeBtn} accessibilityRole="button" accessibilityLabel={t('common.close') || 'Fechar'}>
          <IconX size={22} color={colors.text} />
        </TouchableOpacity>
      </View>
      <View style={s.body}>{renderBody()}</View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  topBar: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 12 },
  closeBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, alignItems: 'center', paddingHorizontal: 24, paddingTop: 16, maxWidth: 440, width: '100%', alignSelf: 'center' },
  icon: { width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  title: { fontSize: 24, fontWeight: '800', textAlign: 'center', letterSpacing: -0.5, marginBottom: 8 },
  sub: { fontSize: 15, textAlign: 'center', lineHeight: 21 },
  account: { fontSize: 15, fontWeight: '700', marginTop: 10 },
  prompt: { fontSize: 15, fontWeight: '600', marginTop: 28, textAlign: 'center' },
  choices: { flexDirection: 'row', gap: 16, marginTop: 16 },
  choice: { width: 76, height: 76, borderRadius: 38, borderWidth: 2, alignItems: 'center', justifyContent: 'center', ...Platform.select({ web: { cursor: 'pointer' }, default: {} }) },
  choiceText: { fontSize: 28, fontWeight: '800' },
  denyBtn: { marginTop: 32, alignSelf: 'stretch', minHeight: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  denyText: { fontSize: 16, fontWeight: '700' },
  secondaryBtn: { marginTop: 22, alignSelf: 'stretch', minHeight: 48, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { fontSize: 15, fontWeight: '600' },
  warn: { fontSize: 12.5, textAlign: 'center', marginTop: 14, lineHeight: 18 },
  timer: { fontSize: 12, marginTop: 8 },
});
