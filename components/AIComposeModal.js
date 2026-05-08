import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Modal, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform,
  SafeAreaView,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { IconSparkles, IconX } from './Icons';

const BRAND = '#7C3AED';
const BRAND_PINK = '#EC4899';

const TONES = [
  { id: 'formal', label: 'Formal', emoji: '🎩' },
  { id: 'casual', label: 'Casual', emoji: '👋' },
  { id: 'curto', label: 'Curto', emoji: '✂️' },
  { id: 'engracado', label: 'Engraçado', emoji: '😄' },
  { id: 'persuasivo', label: 'Persuasivo', emoji: '🎯' },
  { id: 'amigavel', label: 'Amigável', emoji: '🤝' },
];

const LENGTHS = [
  { id: 'short', label: 'Curto', words: '~50' },
  { id: 'medium', label: 'Médio', words: '~120' },
  { id: 'long', label: 'Longo', words: '~250' },
];

export default function AIComposeModal({ visible, onClose, onUseDraft }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [prompt, setPrompt] = useState('');
  const [tone, setTone] = useState('formal');
  const [length, setLength] = useState('medium');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setLoading(true);
    setError('');
    setDraft('');
    try {
      const { aiAssist } = await import('../services/api');
      const r = await aiAssist('compose_draft', {
        instruction: prompt,
        tone,
        length,
        language: 'pt-BR',
      });
      if (r.success && r.data?.result) {
        setDraft(r.data.result);
      } else {
        setError(r.message || t('aiCompose.generateError'));
      }
    } catch {
      setError(t('common.networkError'));
    } finally {
      setLoading(false);
    }
  };

  const handleUse = () => {
    onUseDraft(draft);
    setPrompt('');
    setDraft('');
  };

  const handleCopy = async () => {
    try {
      if (Platform.OS === 'web' && navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(draft);
      } else {
        const Clipboard = await import('expo-clipboard').catch(() => null);
        if (Clipboard?.setStringAsync) await Clipboard.setStringAsync(draft);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const handleClose = () => {
    setPrompt('');
    setDraft('');
    setError('');
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
      <SafeAreaView style={[s.fullScreen, { backgroundColor: colors.background }]}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          {/* Header — full-screen with gradient accent */}
          <View style={[s.header, { borderBottomColor: colors.borderLight, backgroundColor: colors.surface }]}>
            <View style={s.headerLeft}>
              <View style={s.sparkleBadge}>
                <IconSparkles size={18} color="#fff" />
              </View>
              <View>
                <Text style={[s.headerTitle, { color: colors.text }]}>Escrever com IA</Text>
                <Text style={[s.headerSubtitle, { color: colors.textTertiary }]}>
                  Powered by Chatyy AI
                </Text>
              </View>
            </View>
            <TouchableOpacity onPress={handleClose} style={s.closeBtn} hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}>
              <IconX size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView style={s.body} contentContainerStyle={s.bodyContent} keyboardShouldPersistTaps="handled">
            {/* Tone picker */}
            <Text style={[s.sectionLabel, { color: colors.text }]}>Tom da mensagem</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={s.tonesScroll}
              style={s.tonesRow}
            >
              {TONES.map((tn) => {
                const active = tone === tn.id;
                return (
                  <TouchableOpacity
                    key={tn.id}
                    onPress={() => setTone(tn.id)}
                    activeOpacity={0.8}
                    style={[
                      s.toneChip,
                      { borderColor: active ? BRAND : colors.divider, backgroundColor: active ? BRAND + '15' : colors.surface },
                    ]}
                  >
                    <Text style={s.toneEmoji}>{tn.emoji}</Text>
                    <Text style={[s.toneText, { color: active ? BRAND : colors.text, fontWeight: active ? '700' : '500' }]}>
                      {tn.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            {/* Length slider (segmented) */}
            <Text style={[s.sectionLabel, { color: colors.text, marginTop: Spacing.lg }]}>
              Tamanho
            </Text>
            <View style={[s.segmented, { backgroundColor: colors.surfaceVariant, borderColor: colors.divider }]}>
              {LENGTHS.map((ln) => {
                const active = length === ln.id;
                return (
                  <TouchableOpacity
                    key={ln.id}
                    style={[s.segment, active && { backgroundColor: BRAND }]}
                    onPress={() => setLength(ln.id)}
                    activeOpacity={0.85}
                  >
                    <Text style={[s.segmentText, { color: active ? '#fff' : colors.text, fontWeight: active ? '700' : '500' }]}>
                      {ln.label}
                    </Text>
                    <Text style={[s.segmentSub, { color: active ? 'rgba(255,255,255,0.85)' : colors.textTertiary }]}>
                      {ln.words}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Prompt textarea (large) */}
            <Text style={[s.sectionLabel, { color: colors.text, marginTop: Spacing.lg }]}>
              O que você quer escrever?
            </Text>
            <TextInput
              style={[
                s.promptInput,
                { color: colors.text, borderColor: prompt ? BRAND + '55' : colors.divider, backgroundColor: colors.surface },
              ]}
              value={prompt}
              onChangeText={setPrompt}
              placeholder="Ex: agradecer pela reunião e propor próximos passos..."
              placeholderTextColor={colors.textTertiary}
              multiline
              numberOfLines={6}
              textAlignVertical="top"
            />

            {/* Generate button — gradient purple → pink (layered fallback for RN) */}
            {!draft && (
              <TouchableOpacity
                style={[s.generateBtn, loading && s.btnDisabled]}
                onPress={handleGenerate}
                disabled={loading || !prompt.trim()}
                activeOpacity={0.9}
              >
                <View style={[s.gradientLayer, { backgroundColor: BRAND }]} />
                <View style={[s.gradientPink, { backgroundColor: BRAND_PINK, opacity: 0.55 }]} />
                <View style={s.generateContent}>
                  {loading ? (
                    <>
                      <ActivityIndicator size="small" color="#fff" />
                      <Text style={s.generateText}>Gerando...</Text>
                    </>
                  ) : (
                    <>
                      <IconSparkles size={18} color="#fff" />
                      <Text style={s.generateText}>Gerar com IA</Text>
                    </>
                  )}
                </View>
              </TouchableOpacity>
            )}

            {!!error && (
              <View style={[s.errorBox, { backgroundColor: colors.error + '15', borderColor: colors.error + '40' }]}>
                <Text style={[s.error, { color: colors.error }]}>{error}</Text>
              </View>
            )}

            {/* Draft result card */}
            {draft ? (
              <View style={[s.resultCard, { backgroundColor: colors.surface, borderColor: BRAND + '30' }, Shadow.md]}>
                <View style={s.resultHeader}>
                  <IconSparkles size={14} color={BRAND} />
                  <Text style={[s.resultLabel, { color: BRAND }]}>Rascunho gerado</Text>
                </View>
                <TextInput
                  style={[s.draftText, { color: colors.text }]}
                  value={draft}
                  onChangeText={setDraft}
                  multiline
                  textAlignVertical="top"
                />
                <View style={[s.resultActions, { borderTopColor: colors.borderLight }]}>
                  <TouchableOpacity
                    style={[s.actionBtn, { borderColor: colors.divider }]}
                    onPress={handleGenerate}
                    activeOpacity={0.8}
                  >
                    <Text style={[s.actionText, { color: colors.text }]}>↻  Regenerar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[s.actionBtn, { borderColor: colors.divider }]}
                    onPress={handleCopy}
                    activeOpacity={0.8}
                  >
                    <Text style={[s.actionText, { color: copied ? '#10B981' : colors.text }]}>
                      {copied ? '✓  Copiado' : '⧉  Copiar'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[s.actionBtn, s.actionPrimary, { backgroundColor: BRAND }]}
                    onPress={handleUse}
                    activeOpacity={0.85}
                  >
                    <Text style={[s.actionText, { color: '#fff', fontWeight: '700' }]}>Inserir →</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const s = StyleSheet.create({
  fullScreen: { flex: 1 },
  // Header
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    borderBottomWidth: 1,
  },
  headerLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  sparkleBadge: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: BRAND, alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { fontSize: FontSize.xl, fontWeight: '700' },
  headerSubtitle: { fontSize: FontSize.xs, marginTop: 1 },
  closeBtn: { padding: Spacing.sm },
  // Body
  body: { flex: 1 },
  bodyContent: { padding: Spacing.lg, paddingBottom: Spacing.xxl },
  sectionLabel: { fontSize: FontSize.md, fontWeight: '600', marginBottom: Spacing.sm },
  // Tone chips
  tonesRow: { marginHorizontal: -Spacing.lg },
  tonesScroll: { paddingHorizontal: Spacing.lg, gap: Spacing.sm },
  toneChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderWidth: 1.5, borderRadius: BorderRadius.xxl,
    paddingHorizontal: Spacing.md, paddingVertical: 8,
  },
  toneEmoji: { fontSize: 14 },
  toneText: { fontSize: FontSize.sm },
  // Length slider
  segmented: {
    flexDirection: 'row', borderRadius: BorderRadius.md,
    borderWidth: 1, padding: 4, gap: 4,
  },
  segment: {
    flex: 1, paddingVertical: 10, alignItems: 'center',
    borderRadius: BorderRadius.sm,
  },
  segmentText: { fontSize: FontSize.sm },
  segmentSub: { fontSize: FontSize.xs, marginTop: 2 },
  // Prompt
  promptInput: {
    borderWidth: 1.5, borderRadius: BorderRadius.md,
    padding: Spacing.md, fontSize: FontSize.lg, minHeight: 120,
    outlineStyle: 'none',
  },
  // Generate button (gradient via stacked layers)
  generateBtn: {
    borderRadius: BorderRadius.md, marginTop: Spacing.lg,
    overflow: 'hidden', position: 'relative',
    minHeight: 54,
  },
  gradientLayer: { ...StyleSheet.absoluteFillObject },
  gradientPink: {
    position: 'absolute', top: 0, right: 0, bottom: 0, width: '60%',
  },
  generateContent: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: Spacing.sm, paddingVertical: 16,
  },
  generateText: { color: '#fff', fontSize: FontSize.lg, fontWeight: '700', letterSpacing: 0.3 },
  btnDisabled: { opacity: 0.5 },
  // Error
  errorBox: {
    marginTop: Spacing.md, padding: Spacing.md,
    borderRadius: BorderRadius.md, borderWidth: 1,
  },
  error: { fontSize: FontSize.base },
  // Result card
  resultCard: {
    marginTop: Spacing.lg,
    borderWidth: 1.5, borderRadius: BorderRadius.lg,
    padding: Spacing.md,
  },
  resultHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: Spacing.sm,
  },
  resultLabel: { fontSize: FontSize.xs, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  draftText: {
    fontSize: FontSize.base, lineHeight: 22, minHeight: 140,
    outlineStyle: 'none',
  },
  resultActions: {
    flexDirection: 'row', gap: Spacing.sm,
    marginTop: Spacing.md, paddingTop: Spacing.md,
    borderTopWidth: 1,
  },
  actionBtn: {
    flex: 1, borderWidth: 1, borderRadius: BorderRadius.md,
    paddingVertical: 12, alignItems: 'center',
  },
  actionPrimary: { borderWidth: 0, flex: 1.3 },
  actionText: { fontSize: FontSize.base, fontWeight: '600' },
});
