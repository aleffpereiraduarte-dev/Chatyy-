import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Modal, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { IconSparkles, IconX } from './Icons';

export default function AIComposeModal({ visible, onClose, onUseDraft }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [prompt, setPrompt] = useState('');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
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

  const handleClose = () => {
    setPrompt('');
    setDraft('');
    setError('');
    onClose();
  };

  const suggestions = [
    t('aiCompose.sug1'),
    t('aiCompose.sug2'),
    t('aiCompose.sug3'),
    t('aiCompose.sug4'),
  ];

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <KeyboardAvoidingView
        style={s.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <TouchableOpacity style={s.backdrop} onPress={handleClose} activeOpacity={1} />
        <View style={[s.modal, Shadow.xl, { backgroundColor: colors.surface }]}>
          {/* Header */}
          <View style={[s.header, { borderBottomColor: colors.borderLight }]}>
            <IconSparkles size={20} color={colors.primary} style={{ marginRight: Spacing.sm }} />
            <Text style={[s.headerTitle, { color: colors.text }]}>{t('aiCompose.title')}</Text>
            <TouchableOpacity onPress={handleClose} style={s.closeBtn}>
              <IconX size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView style={s.body} contentContainerStyle={s.bodyContent}>
            {/* Prompt input */}
            <Text style={[s.label, { color: colors.textSecondary }]}>
              {t('aiCompose.promptLabel')}
            </Text>
            <TextInput
              style={[
                s.promptInput,
                { color: colors.text, borderColor: colors.divider, backgroundColor: colors.surfaceVariant },
              ]}
              value={prompt}
              onChangeText={setPrompt}
              placeholder={t('aiCompose.promptPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />

            {/* Quick suggestions */}
            {!draft && !loading && (
              <View style={s.suggestions}>
                <Text style={[s.sugLabel, { color: colors.textTertiary }]}>{t('aiCompose.quickSuggestions')}</Text>
                {suggestions.map((sug, i) => (
                  <TouchableOpacity
                    key={i}
                    style={[s.sugChip, { borderColor: colors.divider }]}
                    onPress={() => setPrompt(sug)}
                  >
                    <Text style={[s.sugText, { color: colors.text }]}>{sug}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* Generate button */}
            {!draft && (
              <TouchableOpacity
                style={[s.generateBtn, { backgroundColor: colors.primary }, loading && s.btnDisabled]}
                onPress={handleGenerate}
                disabled={loading || !prompt.trim()}
              >
                {loading ? (
                  <View style={s.loadingRow}>
                    <ActivityIndicator size="small" color="#fff" />
                    <Text style={s.generateText}>{t('aiCompose.writing')}</Text>
                  </View>
                ) : (
                  <Text style={s.generateText}>{t('aiCompose.generate')}</Text>
                )}
              </TouchableOpacity>
            )}

            {!!error && (
              <Text style={[s.error, { color: colors.error }]}>{error}</Text>
            )}

            {/* Draft result */}
            {draft ? (
              <View style={s.draftSection}>
                <Text style={[s.draftLabel, { color: colors.textSecondary }]}>{t('aiCompose.draftGenerated')}</Text>
                <View style={[s.draftBox, { backgroundColor: colors.surfaceVariant, borderColor: colors.border }]}>
                  <TextInput
                    style={[s.draftText, { color: colors.text }]}
                    value={draft}
                    onChangeText={setDraft}
                    multiline
                    textAlignVertical="top"
                  />
                </View>
                <View style={s.draftActions}>
                  <TouchableOpacity
                    style={[s.useBtn, { backgroundColor: colors.primary }]}
                    onPress={handleUse}
                  >
                    <Text style={s.useBtnText}>{t('aiCompose.useDraft')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[s.retryBtn, { borderColor: colors.divider }]}
                    onPress={handleGenerate}
                  >
                    <Text style={[s.retryText, { color: colors.primary }]}>{t('aiCompose.regenerate')}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : null}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  modal: {
    borderTopLeftRadius: BorderRadius.xl, borderTopRightRadius: BorderRadius.xl,
    maxHeight: '85%',
  },
  // Header
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    borderBottomWidth: 1,
  },
  headerTitle: { flex: 1, fontSize: FontSize.xxl, fontWeight: '600' },
  closeBtn: { padding: Spacing.sm },
  // Body
  body: { flex: 1 },
  bodyContent: { padding: Spacing.xl },
  label: { fontSize: FontSize.base, marginBottom: Spacing.sm },
  promptInput: {
    borderWidth: 1, borderRadius: BorderRadius.md,
    padding: Spacing.md, fontSize: FontSize.lg, minHeight: 80,
    outlineStyle: 'none',
  },
  // Suggestions
  suggestions: { marginTop: Spacing.lg },
  sugLabel: { fontSize: FontSize.md, marginBottom: Spacing.sm },
  sugChip: {
    borderWidth: 1, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  sugText: { fontSize: FontSize.base },
  // Generate
  generateBtn: {
    borderRadius: BorderRadius.md, paddingVertical: 14, alignItems: 'center', marginTop: Spacing.lg,
  },
  btnDisabled: { opacity: 0.6 },
  generateText: { color: '#fff', fontSize: FontSize.lg, fontWeight: '600' },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  error: { fontSize: FontSize.base, marginTop: Spacing.sm },
  // Draft
  draftSection: { marginTop: Spacing.lg },
  draftLabel: { fontSize: FontSize.base, marginBottom: Spacing.sm },
  draftBox: {
    borderWidth: 1, borderRadius: BorderRadius.md, padding: Spacing.md,
  },
  draftText: { fontSize: FontSize.base, lineHeight: 22, minHeight: 120, outlineStyle: 'none' },
  draftActions: { flexDirection: 'row', gap: Spacing.md, marginTop: Spacing.lg },
  useBtn: {
    flex: 1, borderRadius: BorderRadius.md, paddingVertical: 14, alignItems: 'center',
  },
  useBtnText: { color: '#fff', fontSize: FontSize.lg, fontWeight: '600' },
  retryBtn: {
    flex: 1, borderWidth: 1, borderRadius: BorderRadius.md, paddingVertical: 14, alignItems: 'center',
  },
  retryText: { fontSize: FontSize.lg, fontWeight: '600' },
});
