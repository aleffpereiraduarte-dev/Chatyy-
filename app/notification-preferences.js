// app/notification-preferences.js
//
// Notifications fine-tuning screen — surfaces per-user notification
// preferences that don't fit into the dense Settings list:
//   - Receber só de menções (global mention_only)
//   - Palavras-chave (per-keyword highlight)
//
// 2026-05-17 — gap_notifications P0+P1 step 8 + 9 UI.

import { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Switch,
  Alert,
  StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { apiCall } from '../services/api';
import { Spacing, FontSize, BorderRadius } from '../constants/theme';

export default function NotificationPreferences() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useLanguage();

  const [mentionOnly, setMentionOnly] = useState(false);
  const [keywords, setKeywords] = useState([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingMention, setSavingMention] = useState(false);

  // Initial load: pull mention_only + keywords in parallel.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [moRes, kwRes] = await Promise.all([
          apiCall('chat_user_mention_only_get', {}, 'POST').catch(() => null),
          apiCall('chat_user_keywords_list', {}, 'POST').catch(() => null),
        ]);
        if (!alive) return;
        if (moRes?.success && moRes.data) setMentionOnly(!!moRes.data.mention_only);
        if (kwRes?.success && kwRes.data) setKeywords(kwRes.data.keywords || []);
      } catch (e) {
        if (alive) console.warn('[notif-pref/load]', e?.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const toggleMentionOnly = useCallback(async (val) => {
    setMentionOnly(val);
    setSavingMention(true);
    try {
      await apiCall('chat_user_mention_only_set', { mention_only: val }, 'POST');
    } catch (e) {
      Alert.alert('Erro', 'Não foi possível salvar a preferência');
      setMentionOnly(!val);
    } finally {
      setSavingMention(false);
    }
  }, []);

  const addKeyword = useCallback(async () => {
    const kw = newKeyword.trim();
    if (!kw) return;
    if (kw.length > 64) {
      Alert.alert('Erro', 'Máximo 64 caracteres');
      return;
    }
    try {
      const r = await apiCall('chat_user_keywords_add', { keyword: kw }, 'POST');
      if (r?.success && r.data?.id) {
        setKeywords(prev => [{ id: r.data.id, keyword: r.data.keyword || kw, created_at: new Date().toISOString() }, ...prev]);
        setNewKeyword('');
      } else if (r?.data?.skipped === 'duplicate') {
        Alert.alert('Já existe', 'Você já adicionou essa palavra');
        setNewKeyword('');
      } else {
        Alert.alert('Erro', r?.error || 'Não foi possível adicionar');
      }
    } catch (e) {
      Alert.alert('Erro', e?.message || 'Falha na conexão');
    }
  }, [newKeyword]);

  const removeKeyword = useCallback(async (id) => {
    try {
      await apiCall('chat_user_keywords_remove', { id }, 'POST');
      setKeywords(prev => prev.filter(k => k.id !== id));
    } catch (e) {
      Alert.alert('Erro', e?.message || 'Falha na conexão');
    }
  }, []);

  return (
    <View style={[s.container, { backgroundColor: colors.background }]}>
      <View style={[s.header, { borderBottomColor: colors.borderLight }]}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Text style={[s.backBtnText, { color: colors.primary }]}>{t('common.back') || 'Voltar'}</Text>
        </TouchableOpacity>
        <Text style={[s.headerTitle, { color: colors.text }]}>Notificações</Text>
        <View style={s.backBtn} />
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Mention-only toggle */}
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>Notificações de chat</Text>
          <View style={[s.row, { borderBottomColor: colors.borderLight }]}>
            <View style={s.rowInfo}>
              <Text style={[s.rowLabel, { color: colors.text }]}>Receber push só de menções</Text>
              <Text style={[s.rowDesc, { color: colors.textTertiary }]}>
                Você só receberá push quando alguém te mencionar (@você ou @everyone).
                Outras mensagens continuam aparecendo no app, mas sem som / vibração.
              </Text>
            </View>
            <Switch
              value={mentionOnly}
              onValueChange={toggleMentionOnly}
              disabled={savingMention || loading}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={mentionOnly ? colors.primary : '#fff'}
            />
          </View>
        </View>

        {/* Keywords */}
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>Palavras-chave</Text>
          <Text style={[s.sectionDesc, { color: colors.textTertiary }]}>
            Você receberá um push prioritário (com som distinto) quando uma das mensagens recebidas contiver uma destas palavras.
          </Text>

          <View style={[s.inputRow, { borderBottomColor: colors.borderLight }]}>
            <TextInput
              style={[s.input, { color: colors.text, borderColor: colors.divider, backgroundColor: colors.background }]}
              value={newKeyword}
              onChangeText={setNewKeyword}
              placeholder="Ex.: urgente, deadline, projeto X"
              placeholderTextColor={colors.textTertiary}
              maxLength={64}
              returnKeyType="done"
              onSubmitEditing={addKeyword}
            />
            <TouchableOpacity
              style={[s.addBtn, { backgroundColor: colors.primary, opacity: newKeyword.trim() ? 1 : 0.5 }]}
              onPress={addKeyword}
              disabled={!newKeyword.trim()}
            >
              <Text style={s.addBtnText}>Adicionar</Text>
            </TouchableOpacity>
          </View>

          {keywords.length === 0 && !loading && (
            <Text style={[s.empty, { color: colors.textTertiary }]}>Nenhuma palavra-chave configurada.</Text>
          )}
          {keywords.map(k => (
            <View key={k.id} style={[s.kwRow, { borderBottomColor: colors.borderLight }]}>
              <Text style={[s.kwText, { color: colors.text }]}>{k.keyword}</Text>
              <TouchableOpacity onPress={() => removeKeyword(k.id)}>
                <Text style={[s.kwRemove, { color: '#ef4444' }]}>Remover</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xl,
    paddingBottom: Spacing.md,
    borderBottomWidth: 1,
  },
  backBtn: { minWidth: 64, paddingVertical: Spacing.xs },
  backBtnText: { fontSize: FontSize.md },
  headerTitle: { fontSize: FontSize.lg, fontWeight: '600' },
  scroll: { flex: 1 },
  section: {
    marginHorizontal: Spacing.md,
    marginTop: Spacing.lg,
    padding: Spacing.lg,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
  },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '600', marginBottom: Spacing.sm },
  sectionDesc: { fontSize: FontSize.sm, marginBottom: Spacing.md, lineHeight: 18 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
  },
  rowInfo: { flex: 1, paddingRight: Spacing.md },
  rowLabel: { fontSize: FontSize.md, fontWeight: '500', marginBottom: 2 },
  rowDesc: { fontSize: FontSize.sm, lineHeight: 18 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    gap: Spacing.sm,
  },
  input: {
    flex: 1,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderWidth: 1,
    borderRadius: BorderRadius.md,
    fontSize: FontSize.md,
  },
  addBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
  },
  addBtnText: { color: '#fff', fontWeight: '600' },
  empty: { fontSize: FontSize.sm, paddingVertical: Spacing.md, fontStyle: 'italic' },
  kwRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
  },
  kwText: { flex: 1, fontSize: FontSize.md },
  kwRemove: { fontSize: FontSize.sm, fontWeight: '500' },
});
