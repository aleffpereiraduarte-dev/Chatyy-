// [recovery 2026-10-18] Host invisível (dentro do AuthProvider):
//  1) Prompt "Você está tentando recuperar sua conta?" — ao chegar o push
//     account_recovery_prompt (evento 'chatyy:recovery_prompt') ou ao voltar
//     pro app, confere recovery_device_pending e abre /recovery-approve.
//  2) Lembrete (1x a cada 30 dias) p/ contas sem nenhuma forma de recuperação.
import { useEffect, useRef, useState } from 'react';
import { AppState, DeviceEventEmitter, Modal, View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { recoveryDevicePending, recoveryOptionsGet } from '../services/api';
import { IconShield } from './Icons';

const NUDGE_KEY = 'recovery_nudge_ts_v1:';
const NUDGE_EVERY_MS = 30 * 24 * 60 * 60 * 1000;
const CHECK_MIN_MS = 15000;

export default function RecoveryPromptHost() {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const email = auth?.user?.email || '';
  const lastCheck = useRef(0);
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  const [nudge, setNudge] = useState(false);

  useEffect(() => {
    if (!email || auth?.loading) return undefined;
    let alive = true;
    const check = async (force) => {
      if (!alive) return;
      if (pathRef.current === '/recovery-approve') return;
      const now = Date.now();
      if (!force && now - lastCheck.current < CHECK_MIN_MS) return;
      lastCheck.current = now;
      try {
        const r = await recoveryDevicePending();
        if (alive && r?.success && r.data?.pending && pathRef.current !== '/recovery-approve') router.push('/recovery-approve');
      } catch {}
    };
    const sub1 = DeviceEventEmitter.addListener('chatyy:recovery_prompt', () => check(true));
    const sub2 = AppState.addEventListener?.('change', (s) => { if (s === 'active') check(false); });
    const t0 = setTimeout(() => check(true), 4000);
    return () => { alive = false; clearTimeout(t0); try { sub1.remove(); } catch {} try { sub2?.remove?.(); } catch {} };
  }, [email, auth?.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!email || auth?.loading) return undefined;
    let alive = true;
    const tm = setTimeout(async () => {
      try {
        const k = NUDGE_KEY + email.toLowerCase();
        let last = 0;
        try { last = Number(await AsyncStorage.getItem(k)) || 0; } catch {}
        if (Date.now() - last < NUDGE_EVERY_MS) return;
        const r = await recoveryOptionsGet();
        if (!alive || !r?.success || !r.data) return;
        if (r.data.has_any) return;
        try { await AsyncStorage.setItem(k, String(Date.now())); } catch {}
        setNudge(true);
      } catch {}
    }, 20000);
    return () => { alive = false; clearTimeout(tm); };
  }, [email, auth?.loading]);

  if (!nudge) return null;
  return (
    <Modal transparent animationType="fade" visible onRequestClose={() => setNudge(false)}>
      <View style={st.backdrop}>
        <View style={[st.card, { backgroundColor: colors.surface || colors.background }]}>
          <View style={[st.icon, { backgroundColor: colors.surfaceVariant }]}><IconShield size={26} color={colors.text} /></View>
          <Text style={[st.title, { color: colors.text }]}>{t('rec.nudge.title')}</Text>
          <Text style={[st.desc, { color: colors.textSecondary }]}>{t('rec.nudge.desc')}</Text>
          <TouchableOpacity
            style={[st.btn, { backgroundColor: colors.text }]}
            onPress={() => { setNudge(false); router.push('/recovery-options'); }}
            accessibilityRole="button"
          >
            <Text style={[st.btnText, { color: colors.background }]}>{t('rec.nudge.cta')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={st.later} onPress={() => setNudge(false)} accessibilityRole="button">
            <Text style={{ color: colors.textSecondary, fontWeight: '600', fontSize: 15 }}>{t('rec.nudge.later')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 400, borderRadius: 20, padding: 24, alignItems: 'center', ...Platform.select({ web: { boxShadow: '0 10px 40px rgba(0,0,0,0.25)' }, default: {} }) },
  icon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  title: { fontSize: 19, fontWeight: '800', textAlign: 'center', marginBottom: 6, letterSpacing: -0.3 },
  desc: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  btn: { alignSelf: 'stretch', minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 20 },
  btnText: { fontSize: 16, fontWeight: '700' },
  later: { minHeight: 44, justifyContent: 'center', marginTop: 4 },
});
