// Tela de configuração da Bia (assistente de IA) — memória/personalização.
// O usuário define tom + assinatura e pode "ensinar" a Bia o seu estilo a partir
// dos emails enviados. Chama a ação `ai_memory` do backend. (2026-09-24)
import { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, ActivityIndicator, StyleSheet } from 'react-native';
import { useLanguage } from '../context/LanguageContext';
import { IconSparkles } from '../components/Icons';
import { aiMemoryGet, aiMemorySet, aiMemoryLearnStyle } from '../services/api';
import * as settingsCache from '../services/settingsCache'; // [2026-10-13 settings-instant]
import {
  SettingsScreen, SettingsGroup, SettingsRow, SettingsSwitchRow, useGroupedColors, useSettingsInputStyle,
} from '../components/settings/SettingsKit';
import BiaOrb from '../components/bia/BiaOrb';
import BiaIcon from '../components/bia/BiaIcon'; // [2026-10-18 bia-orb-icon] Bia/IA = orb (não a estrelinha)

export default function BiaSettings() {
  const { t } = useLanguage();
  const g = useGroupedColors();
  const inputStyle = useSettingsInputStyle();

  // [2026-10-13 settings-instant] memória da Bia salva no aparelho → abre na hora.
  const [loading, setLoading] = useState(() => settingsCache.peek('bia_memory') == null);
  const [saving, setSaving] = useState(false);
  const [learning, setLearning] = useState(false);
  const [toast, setToast] = useState(null);

  const [tone, setTone] = useState('');
  const [signature, setSignature] = useState('');
  const [learnedStyle, setLearnedStyle] = useState('');
  // [bia-contexto 2026-10-18] "A Bia aprende comigo" (ai_memory bia_personalize; padrão ligado)
  const [learnOn, setLearnOn] = useState(true);
  // [bia-ferramentas-voz 2026-10-18] "Bia pode acessar meus e-mails e conversas" (ai_memory bia_data_access; padrão ligado)
  const [dataOn, setDataOn] = useState(true);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }, []);

  const hydrate = useCallback((mem) => {
    if (!mem || typeof mem !== 'object') return;
    if (mem.tone) setTone(mem.tone);
    if (mem.signature) setSignature(mem.signature);
    if (mem.writing_style) setLearnedStyle(mem.writing_style);
    if (mem.bia_personalize != null) setLearnOn(String(mem.bia_personalize) !== '0');
    if (mem.bia_data_access != null) setDataOn(String(mem.bia_data_access) !== '0');
  }, []);

  useEffect(() => {
    hydrate(settingsCache.peek('bia_memory'));
    (async () => {
      try {
        const r = await aiMemoryGet();
        if (r?.success) {
          hydrate(r.data?.memory);
          if (r.data?.memory && typeof r.data.memory === 'object') settingsCache.put('bia_memory', r.data.memory);
        }
      } catch {}
      setLoading(false);
    })();
  }, [hydrate]);

  const handleLearnToggle = useCallback(async (v) => {
    setLearnOn(v);
    try {
      const r = await aiMemorySet('bia_personalize', v ? '1' : '0');
      if (!r?.success) throw new Error('fail');
      try { settingsCache.patch('bia_memory', { bia_personalize: v ? '1' : '0' }); } catch {}
    } catch {
      setLearnOn(!v);
      showToast(t('bia.toggleError') || 'Não consegui salvar agora');
    }
  }, [showToast, t]);

  const handleDataToggle = useCallback(async (v) => {
    setDataOn(v);
    try {
      const r = await aiMemorySet('bia_data_access', v ? '1' : '0');
      if (!r?.success) throw new Error('fail');
      try { settingsCache.patch('bia_memory', { bia_data_access: v ? '1' : '0' }); } catch {}
    } catch {
      setDataOn(!v);
      showToast(t('bia.toggleError') || 'Não consegui salvar agora');
    }
  }, [showToast, t]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      if (tone.trim()) await aiMemorySet('tone', tone.trim());
      if (signature.trim()) await aiMemorySet('signature', signature.trim());
      try { settingsCache.patch('bia_memory', { ...(tone.trim() ? { tone: tone.trim() } : {}), ...(signature.trim() ? { signature: signature.trim() } : {}) }); } catch {}
      showToast(t('bia.saved') || 'Preferências salvas');
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

  // [2026-10-08 settings-redesign2] Header nativo único (SettingsScreen) +
  // listas agrupadas: cabeçalho da Bia, Tom, Assinatura, Salvar, Aprender
  // estilo. Preto&branco; mesmas APIs (ai_memory get/set/learn_style).
  return (
    <SettingsScreen
      title={t('bia.title') || 'Bia — Assistente'}
      overlay={toast ? (
        <View style={[s.toast, { backgroundColor: g.ink }]} pointerEvents="none">
          <Text style={[s.toastText, { color: g.onInk }]}>{toast}</Text>
        </View>
      ) : null}
    >
      {loading ? (
        <ActivityIndicator color={g.text} style={{ marginTop: 48 }} />
      ) : (
        <View>
          <SettingsGroup>
            <View style={s.hero}>
              <BiaOrb size={76} isDark={g.isDark} /* [2026-10-15 bia-design] mesma identidade da tela da Bia */ />
              <Text style={[s.heroText, { color: g.secondary }]}>
                {t('bia.intro') || 'A Bia usa essas preferências pra escrever emails e respostas na sua voz. Quanto mais você ensina, mais parecida com você ela fica.'}
              </Text>
            </View>
          </SettingsGroup>

          <SettingsGroup footer={t('bia.learnMeDesc') || 'A Bia lembra seu nome, preferências e o que você conta pra ela, no texto e na voz. Desligado, ela não usa nem guarda memórias.'}>
            <SettingsSwitchRow title={t('bia.learnMe') || 'A Bia aprende comigo'} value={learnOn} onValueChange={handleLearnToggle} />
          </SettingsGroup>

          <SettingsGroup footer={t('bia.dataAccessDesc') || 'Ligado, a Bia pode ler e resumir seus e-mails e conversas quando você pede, no texto e na voz. Enviar, apagar ou marcar compromissos sempre pede a sua confirmação.'}>
            <SettingsSwitchRow title={t('bia.dataAccess') || 'Bia pode acessar meus e-mails e conversas'} value={dataOn} onValueChange={handleDataToggle} />
          </SettingsGroup>

          <SettingsGroup header={t('bia.tone') || 'Tom preferido'}>
            <View style={s.inputWrap}>
              <TextInput
                value={tone}
                onChangeText={setTone}
                placeholder={t('bia.tonePlaceholder') || 'Ex: cordial e direto, ou descontraído'}
                placeholderTextColor={g.secondary}
                style={inputStyle}
                accessibilityLabel={t('bia.tone') || 'Tom preferido'}
              />
            </View>
          </SettingsGroup>

          <SettingsGroup header={t('bia.signature') || 'Assinatura'}>
            <View style={s.inputWrap}>
              <TextInput
                value={signature}
                onChangeText={setSignature}
                placeholder={t('bia.signaturePlaceholder') || 'Ex: Abraço, Aleff'}
                placeholderTextColor={g.secondary}
                multiline
                style={[inputStyle, { minHeight: 72, textAlignVertical: 'top' }]}
                accessibilityLabel={t('bia.signature') || 'Assinatura'}
              />
            </View>
          </SettingsGroup>

          <SettingsGroup>
            <SettingsRow
              title={t('bia.save') || 'Salvar preferências'}
              titleStyle={{ fontWeight: '600', color: g.ink }}
              center
              chevron={false}
              disabled={saving}
              right={saving ? <ActivityIndicator size="small" color={g.text} /> : undefined}
              onPress={handleSave}
            />
          </SettingsGroup>

          <SettingsGroup header={t('bia.learnTitle') || 'Aprender meu estilo'} footer={t('bia.learnDesc') || 'A Bia lê alguns dos seus emails enviados e aprende como você escreve. Nada sai do seu servidor.'}>
            {learnedStyle ? (
              <SettingsRow
                title={t('bia.currentStyle') || 'Estilo que aprendi:'}
                titleStyle={{ fontSize: 13, color: g.secondary }}
              >
                <Text style={[s.styleText, { color: g.text }]}>{learnedStyle}</Text>
              </SettingsRow>
            ) : null}
            <SettingsRow
              title={learnedStyle ? (t('bia.relearn') || 'Aprender de novo') : (t('bia.learnNow') || 'Aprender agora')}
              titleStyle={{ fontWeight: '600', color: g.ink }}
              chevron={false}
              disabled={learning}
              right={learning ? <ActivityIndicator size="small" color={g.text} /> : <BiaIcon size={18} color={g.text} />}
              onPress={handleLearn}
            />
          </SettingsGroup>
        </View>
      )}

    </SettingsScreen>
  );
}

const s = StyleSheet.create({
  hero: { alignItems: 'center', paddingHorizontal: 16, paddingTop: 20, paddingBottom: 18 },
  heroText: { fontSize: 14, lineHeight: 19, textAlign: 'center', marginTop: 12, maxWidth: 340 },
  inputWrap: { paddingHorizontal: 16, paddingVertical: 12 },
  styleText: { fontSize: 15, lineHeight: 20, marginTop: 4 },
  toast: { position: 'absolute', bottom: 40, left: 24, right: 24, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  toastText: { fontSize: 14, fontWeight: '600' },
});
