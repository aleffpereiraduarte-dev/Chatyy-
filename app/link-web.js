// [e2ee5 WP-12 2026-10-21] /link-web — conectar ESTE navegador (já logado, ou vindo do login) ao
// celular pelo QR do vínculo E2EE. Ao terminar, troca a sessão pelo acesso vinculado a este aparelho
// (emitido pelo celular) e volta para as conversas. Com a flag desligada, volta na hora.
import React, { useCallback, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { IconArrowLeft } from '../components/Icons';
import LinkWebPanel from '../components/e2ee/LinkWebPanel';
import { tx } from '../components/e2ee/e2eeUi';
import * as link from '../services/e2ee/link';

export default function LinkWebScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { loginWithToken } = useAuth();
  const on = Platform.OS === 'web' && link.isOn();

  useEffect(() => { if (!on) { try { router.back(); } catch { router.replace('/'); } } }, [on, router]);

  const onLinked = useCallback(async ({ bearer }) => {
    let ok = false;
    try { const r = await loginWithToken(bearer, ''); ok = !!(r && r.success); } catch {}
    try { router.replace(ok ? '/chat' : '/login'); } catch {}
  }, [loginWithToken, router]);

  if (!on) return null;
  return (
    <View style={[st.root, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={st.header}>
        <TouchableOpacity onPress={() => { try { router.back(); } catch { router.replace('/chat'); } }} style={st.back} accessibilityRole="button" accessibilityLabel={tx(t, 'common.back', 'Voltar')}>
          <IconArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[st.title, { color: colors.text }]} numberOfLines={1}>{tx(t, 'e2ee5.link.scan_title', 'Use o Chatyy no computador')}</Text>
      </View>
      <ScrollView contentContainerStyle={st.scroll}>
        <LinkWebPanel compact onLinked={onLinked} />
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10 },
  back: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: 18, fontWeight: '700', marginLeft: 6 },
  scroll: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 40, alignItems: 'center' },
});
