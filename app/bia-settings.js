// Tela de configuração da Bia (assistente de IA) — memória/personalização.
// O usuário define tom + assinatura e pode "ensinar" a Bia o seu estilo a partir
// dos emails enviados. Chama a ação `ai_memory` do backend. (2026-09-24)
import { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator,
  StyleSheet, Platform, KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconSparkles } from '../components/Icons';
import { aiMemoryGet, aiMemorySet, aiMemoryLearnStyle } from '../services/api';

const ACCENT = '#A582F7';

export default function BiaSettings() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [learning, setLearning] = useState(false);
  const [toast, setToast] = useState(null);

  const [tone, setTone] = useState('');
  const [signature, setSignature] = useState('');
  const [learnedStyle, setLearnedStyle] = useState('');

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }, []);

  const hydrate = useCallback((mem) => {
    if (!mem || typeof mem !== 'object') return;
    if (mem.tone) setTone(mem.tone);
    if (mem.signature) setSignature(mem.signature);
    if (mem.writing_style) setLearnedStyle(mem.writing_style);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const r = await aiMemoryGet();
        if (r?.success) hydrate(r.data?.memory);
      } catch {}
      setLoading(false);
    })();
  }, [hydrate]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      if (tone.trim()) await aiMemorySet('tone', tone.trim());
      if (signature.trim()) await aiMemorySet('signature', signature.trim());
      showToast(t('bia.saved') || 'Preferências salvas ✓');
    } catch {
      showToast(t('bia.saveError') || 'Não consegui salvar agora');
    }
    setSaving(false);
  }, [tone, signature, showToast, t]);

  const handleLearn = useCallback(async () => {
    setLearning(true);
    try {
      const r = await aiMemoryLearnStyle();
      if (r?.success) {
        hydrate(r.data?.memory);
        showToast(t('bia.learned') || 'Aprendi o seu estilo ✓');
      } else {
        showToast(r?.message || (t('bia.learnEmpty') || 'Sem emails enviados pra aprender ainda'));
      }
    } catch {
      showToast(t('bia.learnError') || 'Não consegui aprender agora');
    }
    setLearning(false);
  }, [hydrate, showToast, t]);

  const cardBg = isDark ? '#1a1424' : '#ffffff';
  const border = isDark ? '#2c2340' : '#ece7f5';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top']}>
      {/* Header */}
      <View style={[s.header, { borderBottomColor: border }]}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityLabel="Voltar">
          <IconArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={s.headerTitleRow}>
          <IconSparkles size={18} color={ACCENT} style={{ marginRight: 7 }} />
          <Text style={[s.headerTitle, { color: colors.text }]}>{t('bia.title') || 'Bia — Assistente'}</Text>
        </View>
        <View style={{ width: 40 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {loading ? (
          <View style={s.center}><ActivityIndicator color={ACCENT} /></View>
        ) : (
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
            <Text style={[s.intro, { color: colors.textSecondary }]}>
              {t('bia.intro') || 'A Bia usa essas preferências pra escrever emails e respostas na sua voz. Quanto mais você ensina, mais parecida com você ela fica.'}
            </Text>

            {/* Tom */}
            <Text style={[s.label, { color: colors.text }]}>{t('bia.tone') || 'Tom preferido'}</Text>
            <TextInput
              value={tone}
              onChangeText={setTone}
              placeholder={t('bia.tonePlaceholder') || 'Ex: cordial e direto, ou descontraído'}
              placeholderTextColor={colors.textTertiary}
              style={[s.input, { backgroundColor: cardBg, borderColor: border, color: colors.text }]}
            />

            {/* Assinatura */}
            <Text style={[s.label, { color: colors.text }]}>{t('bia.signature') || 'Assinatura'}</Text>
            <TextInput
              value={signature}
              onChangeText={setSignature}
              placeholder={t('bia.signaturePlaceholder') || 'Ex: Abraço, Aleff'}
              placeholderTextColor={colors.textTertiary}
              multiline
              style={[s.input, { backgroundColor: cardBg, borderColor: border, color: colors.text, minHeight: 64, textAlignVertical: 'top' }]}
            />

            <TouchableOpacity onPress={handleSave} disabled={saving} style={[s.saveBtn, { backgroundColor: ACCENT, opacity: saving ? 0.6 : 1 }]}>
              {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.saveBtnText}>{t('bia.save') || 'Salvar preferências'}</Text>}
            </TouchableOpacity>

            {/* Aprender estilo */}
            <View style={[s.learnCard, { backgroundColor: cardBg, borderColor: border }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                <IconSparkles size={16} color={ACCENT} style={{ marginRight: 6 }} />
                <Text style={[s.learnTitle, { color: colors.text }]}>{t('bia.learnTitle') || 'Aprender meu estilo'}</Text>
              </View>
              <Text style={[s.learnDesc, { color: colors.textSecondary }]}>
                {t('bia.learnDesc') || 'A Bia lê alguns dos seus emails enviados e aprende como você escreve. Nada sai do seu servidor.'}
              </Text>
              {learnedStyle ? (
                <View style={[s.styleBox, { backgroundColor: ACCENT + '14', borderColor: ACCENT + '33' }]}>
                  <Text style={[s.styleLabel, { color: ACCENT }]}>{t('bia.currentStyle') || 'Estilo que aprendi:'}</Text>
                  <Text style={[s.styleText, { color: colors.text }]}>{learnedStyle}</Text>
                </View>
              ) : null}
              <TouchableOpacity onPress={handleLearn} disabled={learning} style={[s.learnBtn, { borderColor: ACCENT, opacity: learning ? 0.6 : 1 }]}>
                {learning
                  ? <ActivityIndicator color={ACCENT} size="small" />
                  : <Text style={[s.learnBtnText, { color: ACCENT }]}>{learnedStyle ? (t('bia.relearn') || 'Aprender de novo') : (t('bia.learnNow') || 'Aprender agora')}</Text>}
              </TouchableOpacity>
            </View>
          </ScrollView>
        )}
      </KeyboardAvoidingView>

      {toast ? (
        <View style={s.toast}><Text style={s.toastText}>{toast}</Text></View>
      ) : null}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center' },
  headerTitle: { fontSize: 17, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  intro: { fontSize: 13.5, lineHeight: 20, marginBottom: 20 },
  label: { fontSize: 13, fontWeight: '700', marginBottom: 7, marginTop: 6 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, marginBottom: 14 },
  saveBtn: { borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 4, marginBottom: 24 },
  saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  learnCard: { borderWidth: 1, borderRadius: 16, padding: 16 },
  learnTitle: { fontSize: 15, fontWeight: '700' },
  learnDesc: { fontSize: 13, lineHeight: 19, marginBottom: 12 },
  styleBox: { borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 12 },
  styleLabel: { fontSize: 11.5, fontWeight: '700', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.4 },
  styleText: { fontSize: 13.5, lineHeight: 19 },
  learnBtn: { borderWidth: 1.5, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  learnBtnText: { fontWeight: '700', fontSize: 14 },
  toast: { position: 'absolute', bottom: 32, left: 24, right: 24, backgroundColor: 'rgba(20,16,28,0.95)', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  toastText: { color: '#fff', fontSize: 13.5, fontWeight: '600' },
});
