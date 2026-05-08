// Community creation wizard. 5 steps: name → handle → description → photo → rules.
// Each step is a single screen swap (no animation library — just state).
import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView,
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { BorderRadius, Spacing } from '../../constants/theme';
import * as api from '../../services/api';

const STEPS = ['name', 'handle', 'description', 'photo', 'rules'];

export default function CommunityCreateScreen() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();

  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [description, setDescription] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [rules, setRules] = useState('');
  const [welcome, setWelcome] = useState('');
  const [discoverable, setDiscoverable] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const sty = makeStyles(colors, isDark);

  // ---- Validation per step ----
  const canAdvance = useCallback(() => {
    switch (STEPS[step]) {
      case 'name':        return name.trim().length >= 2;
      case 'handle':      return handle === '' || /^[a-z0-9_]{3,32}$/.test(handle.toLowerCase());
      case 'description': return true; // optional
      case 'photo':       return true; // optional
      case 'rules':       return true; // optional
      default:            return true;
    }
  }, [step, name, handle]);

  const onPickPhoto = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
      const r = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true, aspect: [1, 1], quality: 0.85,
      });
      if (!r.canceled && r.assets?.[0]?.uri) {
        // Upload via existing chat_upload flow if available
        if (api.chatUpload) {
          const up = await api.chatUpload(r.assets[0].uri, 'image/jpeg');
          if (up?.success && up.data?.url) {
            setPhotoUrl(up.data.url);
            return;
          }
        }
        setPhotoUrl(r.assets[0].uri); // fallback: local URI (still saved as photo_url)
      }
    } catch (e) {
      Alert.alert(t('common.error') || 'Erro', String(e?.message || e));
    }
  };

  const onCreate = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const r = await api.communityCreate({
        name: name.trim(),
        handle: handle.trim().toLowerCase(),
        description: description.trim(),
        photo_url: photoUrl,
        rules: rules.trim(),
        welcome_message: welcome.trim(),
        discoverable: !!discoverable,
      });
      if (r.success && r.data?.community_id) {
        router.replace(`/community/${r.data.community_id}`);
      } else {
        Alert.alert(t('common.error') || 'Erro', r.error || 'Falha ao criar');
      }
    } catch (e) {
      Alert.alert(t('common.error') || 'Erro', String(e?.message || e));
    } finally {
      setSubmitting(false);
    }
  };

  const onNext = () => {
    if (!canAdvance()) return;
    if (step < STEPS.length - 1) setStep(step + 1);
    else onCreate();
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[sty.container, { backgroundColor: colors.background, paddingTop: insets.top }]}
    >
      {/* Header */}
      <View style={sty.header}>
        <TouchableOpacity onPress={() => step === 0 ? router.back() : setStep(step - 1)} style={sty.headerBtn}>
          <Text style={[sty.headerBtnText, { color: colors.primary }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[sty.headerTitle, { color: colors.text }]}>
          {t('community.createTitle') || 'Criar comunidade'}
        </Text>
        <View style={sty.headerBtn} />
      </View>

      {/* Step indicator */}
      <View style={sty.steps}>
        {STEPS.map((_, i) => (
          <View key={i} style={[sty.stepDot, { backgroundColor: i <= step ? colors.primary : colors.border }]} />
        ))}
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
        {STEPS[step] === 'name' && (
          <View>
            <Text style={[sty.q, { color: colors.text }]}>
              {t('community.qName') || 'Como sua comunidade se chama?'}
            </Text>
            <Text style={[sty.hint, { color: colors.textSecondary }]}>
              {t('community.qNameHint') || 'Você poderá mudar depois.'}
            </Text>
            <TextInput
              value={name} onChangeText={setName}
              placeholder={t('community.namePlaceholder') || 'Ex: Devs do Brasil'}
              placeholderTextColor={colors.textSecondary} maxLength={100}
              style={[sty.input, { color: colors.text, borderColor: colors.border }]}
            />
          </View>
        )}

        {STEPS[step] === 'handle' && (
          <View>
            <Text style={[sty.q, { color: colors.text }]}>
              {t('community.qHandle') || 'Escolha um @handle (opcional)'}
            </Text>
            <Text style={[sty.hint, { color: colors.textSecondary }]}>
              {t('community.qHandleHint') || '3-32 chars: letras, números e underscore. Pessoas usarão pra encontrar.'}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: BorderRadius.md, paddingHorizontal: 12 }}>
              <Text style={{ color: colors.textSecondary, fontSize: 16 }}>@</Text>
              <TextInput
                value={handle} onChangeText={(s) => setHandle(s.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                placeholder="comunidade_devs" placeholderTextColor={colors.textSecondary}
                autoCapitalize="none" maxLength={32}
                style={[sty.inputInline, { color: colors.text }]}
              />
            </View>
          </View>
        )}

        {STEPS[step] === 'description' && (
          <View>
            <Text style={[sty.q, { color: colors.text }]}>
              {t('community.qDescription') || 'Conte sobre a comunidade'}
            </Text>
            <Text style={[sty.hint, { color: colors.textSecondary }]}>
              {t('community.qDescriptionHint') || 'Visível na página da comunidade.'}
            </Text>
            <TextInput
              value={description} onChangeText={setDescription}
              placeholder={t('community.descriptionPlaceholder') || 'Sobre o que é? Para quem?'}
              placeholderTextColor={colors.textSecondary} maxLength={1000} multiline
              style={[sty.input, sty.multiline, { color: colors.text, borderColor: colors.border }]}
            />
          </View>
        )}

        {STEPS[step] === 'photo' && (
          <View>
            <Text style={[sty.q, { color: colors.text }]}>
              {t('community.qPhoto') || 'Adicione uma foto (opcional)'}
            </Text>
            <TouchableOpacity onPress={onPickPhoto} style={[sty.photoBtn, { borderColor: colors.primary }]}>
              {photoUrl ? (
                <Text style={[sty.photoBtnText, { color: colors.primary }]}>
                  {t('community.changePhoto') || 'Trocar foto'}
                </Text>
              ) : (
                <Text style={[sty.photoBtnText, { color: colors.primary }]}>
                  {t('community.choosePhoto') || 'Escolher foto'}
                </Text>
              )}
            </TouchableOpacity>
            {photoUrl ? (
              <Text style={[sty.hint, { color: colors.textSecondary, marginTop: 8 }]} numberOfLines={1}>
                {photoUrl}
              </Text>
            ) : null}
          </View>
        )}

        {STEPS[step] === 'rules' && (
          <View>
            <Text style={[sty.q, { color: colors.text }]}>
              {t('community.qRules') || 'Regras + boas-vindas (opcional)'}
            </Text>
            <Text style={[sty.hint, { color: colors.textSecondary }]}>
              {t('community.qRulesHint') || 'As regras aparecem na aba Sobre. A mensagem de boas-vindas é mostrada quando alguém entra.'}
            </Text>
            <Text style={[sty.label, { color: colors.textSecondary }]}>{t('community.rules') || 'Regras'}</Text>
            <TextInput
              value={rules} onChangeText={setRules}
              placeholder={t('community.rulesPlaceholder') || '1. Seja respeitoso…'}
              placeholderTextColor={colors.textSecondary} maxLength={4000} multiline
              style={[sty.input, sty.multiline, { color: colors.text, borderColor: colors.border }]}
            />
            <Text style={[sty.label, { color: colors.textSecondary, marginTop: 12 }]}>{t('community.welcome') || 'Boas-vindas'}</Text>
            <TextInput
              value={welcome} onChangeText={setWelcome}
              placeholder={t('community.welcomePlaceholder') || 'Bem-vindo!'}
              placeholderTextColor={colors.textSecondary} maxLength={1000} multiline
              style={[sty.input, sty.multiline, { color: colors.text, borderColor: colors.border }]}
            />
            <TouchableOpacity onPress={() => setDiscoverable(!discoverable)} style={{ flexDirection: 'row', alignItems: 'center', marginTop: 16, gap: 10 }}>
              <View style={[sty.checkbox, discoverable && { backgroundColor: colors.primary, borderColor: colors.primary }]}>
                {discoverable && <Text style={{ color: '#fff', fontWeight: '700' }}>✓</Text>}
              </View>
              <Text style={{ color: colors.text, flex: 1 }}>
                {t('community.discoverable') || 'Mostrar em Descobrir comunidades'}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      {/* Footer */}
      <View style={[sty.footer, { borderTopColor: colors.border, paddingBottom: insets.bottom + 8 }]}>
        <TouchableOpacity
          onPress={onNext}
          disabled={!canAdvance() || submitting}
          style={[sty.primaryBtn, { backgroundColor: colors.primary, opacity: (!canAdvance() || submitting) ? 0.5 : 1 }]}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={sty.primaryBtnText}>
              {step < STEPS.length - 1
                ? (t('community.next') || 'Continuar')
                : (t('community.create') || 'Criar comunidade')}
            </Text>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (colors, isDark) => StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10 },
  headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerBtnText: { fontSize: 28, fontWeight: '300' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600' },
  steps: { flexDirection: 'row', justifyContent: 'center', gap: 6, paddingVertical: 12 },
  stepDot: { width: 8, height: 8, borderRadius: 4 },
  q: { fontSize: 22, fontWeight: '700', marginBottom: 8 },
  hint: { fontSize: 13, marginBottom: 16 },
  label: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  input: { borderWidth: 1, borderRadius: BorderRadius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  inputInline: { flex: 1, paddingVertical: 12, fontSize: 16 },
  multiline: { minHeight: 100, textAlignVertical: 'top' },
  photoBtn: { borderWidth: 2, borderStyle: 'dashed', borderRadius: BorderRadius.md, padding: 24, alignItems: 'center' },
  photoBtnText: { fontSize: 15, fontWeight: '600' },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: '#888', alignItems: 'center', justifyContent: 'center' },
  footer: { padding: 16, borderTopWidth: StyleSheet.hairlineWidth },
  primaryBtn: { paddingVertical: 14, borderRadius: BorderRadius.md, alignItems: 'center' },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
