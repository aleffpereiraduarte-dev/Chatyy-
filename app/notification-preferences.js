// app/notification-preferences.js
//
// Notifications fine-tuning screen — surfaces per-user notification
// preferences that don't fit into the dense Settings list:
//   - Receber só de menções (global mention_only)
//   - Palavras-chave (per-keyword highlight + per-keyword sound)
//   - Não Perturbe (horário) — DND schedule
//   - Preview de mensagens — privacy: Sempre / Apenas desbloqueado / Nunca
//   - Visibilidade na tela de bloqueio — Public / Private / Secret
//   - Respeitar Não Perturbe do sistema — drops APNs interruption to passive
//   - Snooze (1h / clear)
//
// 2026-05-17 — gap_notifications P0+P1 steps 3, 4, 7, 8, 9, 10.

import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Switch,
  Alert,
  StyleSheet,
  Modal,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { IconCheck } from '../components/Icons';
import FadeSlideIn from '../components/FadeSlideIn';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { apiCall } from '../services/api';
import { Spacing, FontSize, BorderRadius } from '../constants/theme';

// Same 16-name catalog used by ChatNotificationSettingsSheet so per-keyword
// and per-conversation pickers stay aligned. 'default' falls through to
// the OS default sound. See ChatNotificationSettingsSheet.SYSTEM_RINGTONES
// for the matching list — keep these two in sync.
const SYSTEM_SOUNDS = [
  { value: 'default',          label: 'Padrão' },
  { value: 'argon',            label: 'Argon' },
  { value: 'beat',             label: 'Beat' },
  { value: 'bellbird',         label: 'Bellbird' },
  { value: 'bottle',           label: 'Bottle' },
  { value: 'cesium',           label: 'Cesium' },
  { value: 'chime',            label: 'Chime' },
  { value: 'classic',          label: 'Clássico' },
  { value: 'crystal',          label: 'Crystal' },
  { value: 'flutey',           label: 'Flautim' },
  { value: 'hello',            label: 'Hello' },
  { value: 'kuiper',           label: 'Kuiper' },
  { value: 'machina',          label: 'Machina' },
  { value: 'over_the_horizon', label: 'Over the Horizon' },
  { value: 'pixie',            label: 'Pixie' },
  { value: 'tinkle',           label: 'Tinkle' },
];

const PREVIEW_OPTIONS = [
  { value: 'always',   label: 'Sempre' },
  { value: 'unlocked', label: 'Apenas quando desbloqueado' },
  { value: 'never',    label: 'Nunca' },
];
const VISIBILITY_OPTIONS = [
  { value: 'public',  label: 'Mostrar tudo' },
  { value: 'private', label: 'Esconder conteúdo sensível' },
  { value: 'secret',  label: 'Não mostrar notificação' },
];

export default function NotificationPreferences() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useLanguage();

  // Global prefs (mention_only, dnd, preview, visibility, respect_system_dnd)
  const [prefs, setPrefs] = useState({
    mention_only: false,
    snooze_until: null,
    dnd_enabled: false,
    dnd_start_time: '22:00',
    dnd_end_time: '07:00',
    preview_global: 'always',
    lockscreen_visibility: 'public',
    respect_system_dnd: false,
  });

  // Keywords (each row: { id, keyword, sound })
  const [keywords, setKeywords] = useState([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [editingSoundForId, setEditingSoundForId] = useState(null);

  // Initial load: pull prefs + keywords in parallel. chat_user_notif_prefs_get
  // is the canonical aggregate endpoint added 2026-05-17 — covers mention_only
  // and the new DND/preview/visibility/respect-system-DND fields. The legacy
  // chat_user_mention_only_get path is kept for cold rollouts where the new
  // endpoint isn't deployed yet (graceful fallback below).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [prefRes, moRes, kwRes] = await Promise.all([
          apiCall('chat_user_notif_prefs_get', {}, 'POST').catch(() => null),
          apiCall('chat_user_mention_only_get', {}, 'POST').catch(() => null),
          apiCall('chat_user_keywords_list', {}, 'POST').catch(() => null),
        ]);
        if (!alive) return;
        // Prefer the aggregate prefs payload when present; otherwise fall
        // back to the standalone mention_only response.
        const next = { ...prefs };
        if (prefRes?.success && prefRes.data) {
          Object.assign(next, prefRes.data);
        } else if (moRes?.success && moRes.data) {
          next.mention_only = !!moRes.data.mention_only;
        }
        setPrefs(next);
        if (kwRes?.success && kwRes.data) setKeywords(kwRes.data.keywords || []);
      } catch (e) {
        if (alive) console.warn('[notif-pref/load]', e?.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Optimistic single-field save. On failure roll back the UI to the
  // previous value so we never silently diverge from the server.
  const savePref = useCallback(async (patch) => {
    const prev = prefs;
    setPrefs(p => ({ ...p, ...patch }));
    try {
      const r = await apiCall('chat_user_notif_prefs_set', patch, 'POST');
      if (r?.success === false) throw new Error(r?.error || 'failed');
    } catch (e) {
      setPrefs(prev);
      Alert.alert('Erro', 'Não foi possível salvar');
    }
  }, [prefs]);

  const addKeyword = useCallback(async () => {
    const kw = newKeyword.trim();
    if (!kw) return;
    if (kw.length > 64) {
      Alert.alert('Erro', 'Máximo 64 caracteres');
      return;
    }
    try {
      const r = await apiCall('chat_user_keywords_add', { keyword: kw, sound: 'default' }, 'POST');
      if (r?.success && r.data?.id) {
        setKeywords(prev => [{
          id: r.data.id,
          keyword: r.data.keyword || kw,
          sound: r.data.sound || 'default',
          created_at: new Date().toISOString(),
        }, ...prev]);
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

  // Per-keyword sound picker (gap_notifications #3 refinement). Optimistic
  // local update; rollback on server failure to keep the picker honest.
  const updateKeywordSound = useCallback(async (id, sound) => {
    const prev = keywords;
    setKeywords(p => p.map(k => k.id === id ? { ...k, sound } : k));
    try {
      const r = await apiCall('chat_user_keywords_update_sound', { id, sound }, 'POST');
      if (r?.success === false) throw new Error(r?.error || 'failed');
    } catch (e) {
      setKeywords(prev);
      Alert.alert('Erro', 'Não foi possível atualizar o som');
    } finally {
      setEditingSoundForId(null);
    }
  }, [keywords]);

  // Snooze actions (gap_notifications #4 tail)
  const snoozeFor = useCallback(async (minutes) => {
    try {
      const r = await apiCall('chat_user_snooze_set', { minutes }, 'POST');
      if (r?.success) {
        setPrefs(p => ({ ...p, snooze_until: r.data?.snooze_until || null }));
      }
    } catch (e) {
      Alert.alert('Erro', e?.message || 'Falha');
    }
  }, []);
  const clearSnooze = useCallback(async () => {
    try {
      await apiCall('chat_user_snooze_clear', {}, 'POST');
      setPrefs(p => ({ ...p, snooze_until: null }));
    } catch {}
  }, []);

  // Live label for the active snooze (e.g. "ativo até 14:30").
  const snoozeLabel = useMemo(() => {
    if (!prefs.snooze_until) return null;
    const ts = Date.parse(prefs.snooze_until);
    if (!Number.isFinite(ts) || ts <= Date.now()) return null;
    const d = new Date(ts);
    return `ativo até ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  }, [prefs.snooze_until]);

  return (
    <View style={[s.container, { backgroundColor: colors.background }]}>
      <View style={[s.header, { borderBottomColor: colors.borderLight }]}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Text style={[s.backBtnText, { color: colors.primary }]}>{t('common.back') || 'Voltar'}</Text>
        </TouchableOpacity>
        <Text style={[s.headerTitle, { color: colors.text }]}>Notificações</Text>
        <View style={s.backBtn} />
      </View>

      <FadeSlideIn>
      <ScrollView style={s.scroll} contentContainerStyle={{ paddingBottom: 40 }}>
        {/* ─── Mention-only ──────────────────────────────────────────── */}
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
              value={prefs.mention_only}
              onValueChange={(v) => savePref({ mention_only: v })}
              disabled={loading}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={prefs.mention_only ? colors.primary : '#fff'}
            />
          </View>

          {/* Snooze 1h shortcut */}
          <View style={[s.row, { borderBottomColor: colors.borderLight }]}>
            <View style={s.rowInfo}>
              <Text style={[s.rowLabel, { color: colors.text }]}>Soneca 1 hora</Text>
              <Text style={[s.rowDesc, { color: colors.textTertiary }]}>
                {snoozeLabel ? `Soneca ${snoozeLabel}. Apenas menções e palavras-chave irão notificar.` : 'Suspende notificações de chat por 1 hora.'}
              </Text>
            </View>
            {snoozeLabel ? (
              <TouchableOpacity onPress={clearSnooze} style={[s.pill, { backgroundColor: '#ef4444' }]}>
                <Text style={s.pillText}>Desligar</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity onPress={() => snoozeFor(60)} style={[s.pill, { backgroundColor: colors.primary }]}>
                <Text style={s.pillText}>1h</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* ─── Privacy / Preview ─────────────────────────────────────── */}
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>Privacidade</Text>
          <Text style={[s.sectionDesc, { color: colors.textTertiary }]}>
            Controle o que aparece no banner do sistema operacional.
          </Text>

          <Text style={[s.subLabel, { color: colors.textSecondary }]}>Mostrar preview de mensagens</Text>
          <SegmentedPicker
            options={PREVIEW_OPTIONS}
            value={prefs.preview_global}
            onChange={(v) => savePref({ preview_global: v })}
            colors={colors}
          />

          <Text style={[s.subLabel, { color: colors.textSecondary, marginTop: Spacing.md }]}>Tela de bloqueio</Text>
          <SegmentedPicker
            options={VISIBILITY_OPTIONS}
            value={prefs.lockscreen_visibility}
            onChange={(v) => savePref({ lockscreen_visibility: v })}
            colors={colors}
          />

          <View style={[s.row, { borderBottomColor: colors.borderLight, marginTop: Spacing.md }]}>
            <View style={s.rowInfo}>
              <Text style={[s.rowLabel, { color: colors.text }]}>Respeitar Não Perturbe do sistema</Text>
              <Text style={[s.rowDesc, { color: colors.textTertiary }]}>
                Quando o modo Foco / DND do iOS ou Android estiver ativo, suas
                notificações de chat ficam silenciosas (menções e palavras-chave
                continuam piercing).
              </Text>
            </View>
            <Switch
              value={prefs.respect_system_dnd}
              onValueChange={(v) => savePref({ respect_system_dnd: v })}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={prefs.respect_system_dnd ? colors.primary : '#fff'}
            />
          </View>
        </View>

        {/* ─── DND schedule ─────────────────────────────────────────── */}
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>Não perturbe (horário)</Text>
          <View style={[s.row, { borderBottomColor: colors.borderLight }]}>
            <View style={s.rowInfo}>
              <Text style={[s.rowLabel, { color: colors.text }]}>Ativar horário silencioso</Text>
              <Text style={[s.rowDesc, { color: colors.textTertiary }]}>
                Silencia notificações de chat dentro do horário definido.
                Menções e palavras-chave continuam piercing.
              </Text>
            </View>
            <Switch
              value={prefs.dnd_enabled}
              onValueChange={(v) => savePref({ dnd_enabled: v })}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={prefs.dnd_enabled ? colors.primary : '#fff'}
            />
          </View>
          {prefs.dnd_enabled && (
            <View style={{ flexDirection: 'row', gap: 12, paddingTop: Spacing.md }}>
              <View style={{ flex: 1 }}>
                <Text style={[s.rowDesc, { color: colors.textTertiary, marginBottom: 4 }]}>Início</Text>
                <TextInput
                  value={prefs.dnd_start_time || ''}
                  onChangeText={(v) => setPrefs(p => ({ ...p, dnd_start_time: v }))}
                  onBlur={() => {
                    const v = (prefs.dnd_start_time || '').trim();
                    if (/^([01]\d|2[0-3]):([0-5]\d)$/.test(v)) {
                      savePref({ dnd_start_time: v });
                    } else {
                      setPrefs(p => ({ ...p, dnd_start_time: '22:00' }));
                      savePref({ dnd_start_time: '22:00' });
                    }
                  }}
                  placeholder="22:00"
                  placeholderTextColor={colors.textTertiary}
                  style={[s.timeInput, { color: colors.text, borderColor: colors.divider, backgroundColor: colors.background }]}
                  maxLength={5}
                  keyboardType="numbers-and-punctuation"
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[s.rowDesc, { color: colors.textTertiary, marginBottom: 4 }]}>Fim</Text>
                <TextInput
                  value={prefs.dnd_end_time || ''}
                  onChangeText={(v) => setPrefs(p => ({ ...p, dnd_end_time: v }))}
                  onBlur={() => {
                    const v = (prefs.dnd_end_time || '').trim();
                    if (/^([01]\d|2[0-3]):([0-5]\d)$/.test(v)) {
                      savePref({ dnd_end_time: v });
                    } else {
                      setPrefs(p => ({ ...p, dnd_end_time: '07:00' }));
                      savePref({ dnd_end_time: '07:00' });
                    }
                  }}
                  placeholder="07:00"
                  placeholderTextColor={colors.textTertiary}
                  style={[s.timeInput, { color: colors.text, borderColor: colors.divider, backgroundColor: colors.background }]}
                  maxLength={5}
                  keyboardType="numbers-and-punctuation"
                />
              </View>
            </View>
          )}
        </View>

        {/* ─── Keywords (with per-keyword sound) ─────────────────────── */}
        <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
          <Text style={[s.sectionTitle, { color: colors.text }]}>Palavras-chave</Text>
          <Text style={[s.sectionDesc, { color: colors.textTertiary }]}>
            Você receberá um push prioritário (com som distinto) quando uma das
            mensagens recebidas contiver uma destas palavras. Toque na palavra
            para escolher um som personalizado.
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
          {keywords.map(k => {
            const soundLabel = (SYSTEM_SOUNDS.find(x => x.value === (k.sound || 'default')) || SYSTEM_SOUNDS[0]).label;
            return (
              <View key={k.id} style={[s.kwRow, { borderBottomColor: colors.borderLight }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[s.kwText, { color: colors.text }]}>{k.keyword}</Text>
                  <TouchableOpacity onPress={() => setEditingSoundForId(k.id)}>
                    <Text style={[s.kwSound, { color: colors.primary }]}>Som: {soundLabel} ›</Text>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity onPress={() => removeKeyword(k.id)}>
                  <Text style={[s.kwRemove, { color: '#ef4444' }]}>Remover</Text>
                </TouchableOpacity>
              </View>
            );
          })}
        </View>
      </ScrollView>
      </FadeSlideIn>

      {/* Sound picker modal — full bottom sheet so all 16 options are
          scrollable on small phones. */}
      <SoundPickerModal
        visible={!!editingSoundForId}
        keyword={keywords.find(k => k.id === editingSoundForId)?.keyword || ''}
        value={keywords.find(k => k.id === editingSoundForId)?.sound || 'default'}
        onClose={() => setEditingSoundForId(null)}
        onPick={(sound) => updateKeywordSound(editingSoundForId, sound)}
        colors={colors}
      />
    </View>
  );
}

// Horizontal segmented picker (3-button row). Used for preview privacy
// + lockscreen visibility — both 3-option enums.
function SegmentedPicker({ options, value, onChange, colors }) {
  return (
    <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
      {options.map(opt => {
        const active = opt.value === value;
        return (
          <TouchableOpacity
            key={opt.value}
            onPress={() => onChange(opt.value)}
            style={{
              flex: 1,
              paddingVertical: Spacing.sm,
              paddingHorizontal: Spacing.xs,
              borderRadius: BorderRadius.md,
              borderWidth: 1,
              borderColor: active ? colors.primary : colors.divider,
              backgroundColor: active ? (colors.primaryLight || colors.primary + '22') : 'transparent',
              alignItems: 'center',
            }}
          >
            <Text style={{
              fontSize: FontSize.sm,
              color: active ? colors.primary : colors.text,
              fontWeight: active ? '600' : '500',
              textAlign: 'center',
            }}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function SoundPickerModal({ visible, keyword, value, onClose, onPick, colors }) {
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} onPress={onClose}>
        <Pressable
          onPress={e => e.stopPropagation?.()}
          style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            backgroundColor: colors.background,
            borderTopLeftRadius: 18, borderTopRightRadius: 18,
            maxHeight: '80%',
            paddingBottom: 24,
          }}
        >
          <View style={{ alignItems: 'center', paddingTop: 10 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: colors.divider }} />
          </View>
          <View style={{ paddingHorizontal: 18, paddingVertical: 12 }}>
            <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text }}>Som para "{keyword}"</Text>
            <Text style={{ fontSize: 12, color: colors.textTertiary, marginTop: 4 }}>
              16 sons do sistema. Toque para selecionar.
            </Text>
          </View>
          <ScrollView style={{ maxHeight: 480 }}>
            {SYSTEM_SOUNDS.map((opt, idx) => {
              const active = opt.value === value;
              return (
                <TouchableOpacity
                  key={opt.value}
                  onPress={() => onPick(opt.value)}
                  style={{
                    flexDirection: 'row', alignItems: 'center',
                    paddingHorizontal: 18, paddingVertical: 14,
                    borderBottomWidth: idx === SYSTEM_SOUNDS.length - 1 ? 0 : StyleSheet.hairlineWidth,
                    borderBottomColor: colors.borderLight,
                  }}
                >
                  <Text style={{ flex: 1, fontSize: 15, color: colors.text }}>{opt.label}</Text>
                  {active && (
                    <IconCheck size={18} color={colors.primary} strokeWidth={2.5} />
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
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
  subLabel: { fontSize: FontSize.sm, fontWeight: '600', marginTop: Spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
  },
  rowInfo: { flex: 1, paddingRight: Spacing.md },
  rowLabel: { fontSize: FontSize.md, fontWeight: '500', marginBottom: 2 },
  rowDesc: { fontSize: FontSize.sm, lineHeight: 18 },
  pill: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18 },
  pillText: { color: '#fff', fontWeight: '600', fontSize: FontSize.sm },
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
  timeInput: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderWidth: 1,
    borderRadius: BorderRadius.md,
    fontSize: FontSize.md,
    fontFamily: 'monospace',
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
  kwText: { fontSize: FontSize.md, fontWeight: '500' },
  kwSound: { fontSize: FontSize.sm, marginTop: 2 },
  kwRemove: { fontSize: FontSize.sm, fontWeight: '500' },
});
