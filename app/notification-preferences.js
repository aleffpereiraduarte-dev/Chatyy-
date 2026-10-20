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

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Alert,
  StyleSheet,
  Platform,
} from 'react-native';
import { IconTrash } from '../components/Icons';
import FadeSlideIn from '../components/FadeSlideIn';
import { useLanguage } from '../context/LanguageContext';
import { apiCall } from '../services/api';
import * as settingsCache from '../services/settingsCache'; // [2026-10-13 settings-instant]
import {
  SettingsScreen, SettingsGroup, SettingsRow, SettingsSwitchRow, SettingsPickerRow,
  OptionSheet, useGroupedColors, useSettingsInputStyle,
} from '../components/settings/SettingsKit';

// Same 16-name catalog used by ChatNotificationSettingsSheet so per-keyword
// and per-conversation pickers stay aligned. 'default' falls through to
// the OS default sound. See ChatNotificationSettingsSheet.SYSTEM_RINGTONES
// for the matching list — keep these two in sync.
// Proper-noun sound names (Argon, Beat, …) are brand sound labels and read
// the same in every language, so they carry a literal `label`. Only the three
// translatable names carry a `labelKey` routed through t(). `soundLabel()`
// below resolves either form.
const SYSTEM_SOUNDS = [
  { value: 'default',          label: 'Padrão', labelKey: 'notifPref.snd.default' },
  { value: 'argon',            label: 'Argon' },
  { value: 'beat',             label: 'Beat' },
  { value: 'bellbird',         label: 'Bellbird' },
  { value: 'bottle',           label: 'Bottle' },
  { value: 'cesium',           label: 'Cesium' },
  { value: 'chime',            label: 'Chime' },
  { value: 'classic',          label: 'Clássico', labelKey: 'notifPref.snd.classic' },
  { value: 'crystal',          label: 'Crystal' },
  { value: 'flutey',           label: 'Flautim', labelKey: 'notifPref.snd.flutey' },
  { value: 'hello',            label: 'Hello' },
  { value: 'kuiper',           label: 'Kuiper' },
  { value: 'machina',          label: 'Machina' },
  { value: 'over_the_horizon', label: 'Over the Horizon' },
  { value: 'pixie',            label: 'Pixie' },
  { value: 'tinkle',           label: 'Tinkle' },
];
// Resolve a sound's display label given the active t(). Falls back to the
// literal proper-noun label when there's no translation key.
function soundLabel(entry, t) {
  if (!entry) return '';
  return (entry.labelKey && t) ? (t(entry.labelKey) || entry.label) : entry.label;
}

const PREVIEW_OPTIONS = [
  { value: 'always',   labelKey: 'notifPref.previewAlways' },
  { value: 'unlocked', labelKey: 'notifPref.previewUnlocked' },
  { value: 'never',    labelKey: 'notifPref.previewNever' },
];
const VISIBILITY_OPTIONS = [
  { value: 'public',  labelKey: 'notifPref.visPublic' },
  { value: 'private', labelKey: 'notifPref.visPrivate' },
  { value: 'secret',  labelKey: 'notifPref.visSecret' },
];

export default function NotificationPreferences() {
  const { t } = useLanguage();

  // Global prefs (mention_only, dnd, preview, visibility, respect_system_dnd)
  // [2026-10-13 settings-instant] Abre com o último valor salvo no aparelho
  // (settingsCache 'notif' — o MESMO snapshot que Configurações usa) e
  // revalida em 2º plano em paralelo com as palavras-chave.
  const [prefs, setPrefs] = useState(() => {
    const base = {
      mention_only: false,
      snooze_until: null,
      dnd_enabled: false,
      dnd_start_time: '22:00',
      dnd_end_time: '07:00',
      preview_global: 'always',
      lockscreen_visibility: 'public',
      respect_system_dnd: false,
    };
    const c = settingsCache.peek('notif');
    return c && typeof c === 'object' ? { ...base, ...c } : base;
  });

  // Keywords (each row: { id, keyword, sound })
  const [keywords, setKeywords] = useState(() => { const c = settingsCache.peek('notif_keywords'); return Array.isArray(c) ? c : []; });
  const [newKeyword, setNewKeyword] = useState('');
  const [loading, setLoading] = useState(() => settingsCache.peek('notif') == null);
  // Espelha a lista de palavras-chave no cache local após cada mudança.
  const _kwHydrated = useRef(false);
  useEffect(() => {
    if (!_kwHydrated.current) { _kwHydrated.current = true; return; }
    try { settingsCache.put('notif_keywords', keywords); } catch {}
  }, [keywords]);
  const [editingSoundForId, setEditingSoundForId] = useState(null);

  // Initial load: pull prefs + keywords in parallel. chat_user_notif_prefs_get
  // is the canonical aggregate endpoint added 2026-05-17 — covers mention_only
  // and the new DND/preview/visibility/respect-system-DND fields. The legacy
  // chat_user_mention_only_get path is kept for cold rollouts where the new
  // endpoint isn't deployed yet (graceful fallback below).
  useEffect(() => {
    let alive = true;
    const u1 = settingsCache.subscribe('notif', (v) => { if (alive && v && typeof v === 'object') setPrefs(p => ({ ...p, ...v })); });
    const u2 = settingsCache.subscribe('notif_keywords', (v) => { if (alive && Array.isArray(v)) setKeywords(v); });
    (async () => {
      try {
        const [n] = await Promise.all([
          settingsCache.revalidate('notif'),
          settingsCache.revalidate('notif_keywords'),
        ]);
        // Sem o agregado (deploy antigo / falha) → fallback mention_only.
        if (!n && alive) {
          const moRes = await apiCall('chat_user_mention_only_get', {}, 'POST').catch(() => null);
          if (alive && moRes?.success && moRes.data) setPrefs(p => ({ ...p, mention_only: !!moRes.data.mention_only }));
        }
      } catch (e) {
        if (alive) console.warn('[notif-pref/load]', e?.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; u1(); u2(); };
  }, []);

  // Optimistic single-field save. On failure roll back the UI to the
  // previous value so we never silently diverge from the server.
  const savePref = useCallback(async (patch) => {
    // [2026-10-20 wa2] desfaz só as chaves deste patch (a cópia inteira apagava outras
    // mudanças feitas enquanto este salvamento estava em andamento).
    const prevVals = {};
    for (const k of Object.keys(patch || {})) prevVals[k] = prefs ? prefs[k] : undefined;
    setPrefs(p => ({ ...p, ...patch }));
    // [2026-10-13 settings-instant] commit otimista: snapshot local + fila
    // offline (sem rede não desfaz — reenvia ao reconectar).
    try {
      const res = await settingsCache.commit('notif', { patch, action: 'chat_user_notif_prefs_set', params: patch });
      if (res && res.ok === false) throw new Error(res.r?.error || 'failed');
    } catch (e) {
      setPrefs(p => ({ ...p, ...prevVals }));
      Alert.alert(t('common.error'), t('notifPref.saveFailed'));
    }
  }, [prefs, t]);

  const addKeyword = useCallback(async () => {
    const kw = newKeyword.trim();
    if (!kw) return;
    if (kw.length > 64) {
      Alert.alert(t('common.error'), t('notifPref.max64'));
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
        Alert.alert(t('notifPref.dupTitle'), t('notifPref.dupBody'));
        setNewKeyword('');
      } else {
        Alert.alert(t('common.error'), r?.error || t('notifPref.addFailed'));
      }
    } catch (e) {
      Alert.alert(t('common.error'), e?.message || t('notifPref.connFailed'));
    }
  }, [newKeyword, t]);

  const removeKeyword = useCallback(async (id) => {
    try {
      const r = await apiCall('chat_user_keywords_remove', { id }, 'POST');
      // [2026-10-20 wa2] recusa do servidor sumia a palavra só na tela.
      if (r?.success === false) { Alert.alert(t('common.error'), t('notifPref.genericFail')); return; }
      setKeywords(prev => prev.filter(k => k.id !== id));
    } catch (e) {
      Alert.alert(t('common.error'), e?.message || t('notifPref.connFailed'));
    }
  }, [t]);

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
      Alert.alert(t('common.error'), t('notifPref.soundUpdateFailed'));
    } finally {
      setEditingSoundForId(null);
    }
  }, [keywords, t]);

  // Snooze actions (gap_notifications #4 tail)
  const snoozeFor = useCallback(async (minutes) => {
    try {
      const r = await apiCall('chat_user_snooze_set', { minutes }, 'POST');
      if (r?.success) {
        setPrefs(p => ({ ...p, snooze_until: r.data?.snooze_until || null }));
        settingsCache.patch('notif', { snooze_until: r.data?.snooze_until || null });
      } else {
        Alert.alert(t('common.error'), t('notifPref.genericFail'));
      }
    } catch (e) {
      Alert.alert(t('common.error'), e?.message || t('notifPref.genericFail'));
    }
  }, [t]);
  const clearSnooze = useCallback(async () => {
    try {
      const r = await apiCall('chat_user_snooze_clear', {}, 'POST');
      if (r?.success === false) { Alert.alert(t('common.error'), t('notifPref.genericFail')); return; }
      setPrefs(p => ({ ...p, snooze_until: null }));
      settingsCache.patch('notif', { snooze_until: null });
    } catch {
      Alert.alert(t('common.error'), t('notifPref.genericFail'));
    }
  }, [t]);

  // Live label for the active snooze (e.g. "ativo até 14:30").
  const snoozeLabel = useMemo(() => {
    if (!prefs.snooze_until) return null;
    const ts = Date.parse(prefs.snooze_until);
    if (!Number.isFinite(ts) || ts <= Date.now()) return null;
    const d = new Date(ts);
    const time = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    return t('notifPref.snoozeUntil', { time });
  }, [prefs.snooze_until, t]);

  // Resolve segmented-picker option labels through t() (options tables hold
  // only labelKey at module scope since t isn't available there).
  const previewOpts = useMemo(
    () => PREVIEW_OPTIONS.map(o => ({ value: o.value, label: t(o.labelKey) })), [t]);
  const visibilityOpts = useMemo(
    () => VISIBILITY_OPTIONS.map(o => ({ value: o.value, label: t(o.labelKey) })), [t]);

  const gc = useGroupedColors();
  const inputStyle = useSettingsInputStyle();
  const editingKw = keywords.find(k => k.id === editingSoundForId);
  const soundOptions = useMemo(
    () => SYSTEM_SOUNDS.map(o => ({ value: o.value, label: soundLabel(o, t) })), [t]);

  // [2026-10-08 settings-redesign2] Listas agrupadas (SettingsKit) + header
  // nativo único (SettingsScreen). Pré-visualização / tela de bloqueio viram
  // linhas com valor → sheet com checkmark; som por palavra-chave idem.
  // Mesmas APIs: chat_user_notif_prefs_set, chat_user_snooze_*,
  // chat_user_keywords_*.
  return (
    <SettingsScreen title={t('notifPref.title')}>
      <FadeSlideIn>
        {/* ─── Conversas: só menções + soneca ─── */}
        <SettingsGroup header={t('notifPref.chatSection')}>
          <SettingsSwitchRow
            title={t('notifPref.mentionOnly')}
            subtitle={t('notifPref.mentionOnlyDesc')}
            value={prefs.mention_only}
            disabled={loading}
            onValueChange={(v) => savePref({ mention_only: v })}
          />
          <SettingsRow
            title={t('notifPref.snooze1h')}
            subtitle={snoozeLabel ? t('notifPref.snoozeActiveDesc', { label: snoozeLabel }) : t('notifPref.snoozeIdleDesc')}
            subtitleLines={3}
            right={snoozeLabel ? (
              <TouchableOpacity onPress={clearSnooze} style={[s.pill, { backgroundColor: gc.fill }]} accessibilityRole="button" accessibilityLabel={t('notifPref.turnOff')}>
                <Text style={[s.pillText, { color: gc.destructive }]}>{t('notifPref.turnOff')}</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity onPress={() => snoozeFor(60)} style={[s.pill, { backgroundColor: gc.ink }]} accessibilityRole="button" accessibilityLabel={t('notifPref.snooze1h')}>
                <Text style={[s.pillText, { color: gc.onInk }]}>1h</Text>
              </TouchableOpacity>
            )}
          />
        </SettingsGroup>

        {/* ─── Privacidade: prévia + tela de bloqueio + DND do sistema ─── */}
        <SettingsGroup header={t('notifPref.privacySection')} footer={t('notifPref.privacyDesc')}>
          <SettingsPickerRow
            title={t('notifPref.showPreview')}
            value={prefs.preview_global}
            options={previewOpts}
            cancelLabel={t('common.cancel') || 'Cancelar'}
            onChange={(v) => savePref({ preview_global: v })}
          />
          <SettingsPickerRow
            title={t('notifPref.lockscreen')}
            value={prefs.lockscreen_visibility}
            options={visibilityOpts}
            cancelLabel={t('common.cancel') || 'Cancelar'}
            onChange={(v) => savePref({ lockscreen_visibility: v })}
          />
          <SettingsSwitchRow
            title={t('notifPref.respectSystemDnd')}
            subtitle={t('notifPref.respectSystemDndDesc')}
            value={prefs.respect_system_dnd}
            onValueChange={(v) => savePref({ respect_system_dnd: v })}
          />
        </SettingsGroup>

        {/* ─── Não perturbe (horário) ─── */}
        <SettingsGroup header={t('notifPref.dndSection')}>
          <SettingsSwitchRow
            title={t('notifPref.dndEnable')}
            subtitle={t('notifPref.dndEnableDesc')}
            value={prefs.dnd_enabled}
            onValueChange={(v) => savePref({ dnd_enabled: v })}
          />
          {prefs.dnd_enabled && (
            <SettingsRow
              title={t('settings.dndStart') || 'Início'}
              right={(
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
                  placeholderTextColor={gc.secondary}
                  style={[s.timeInput, { color: gc.text, backgroundColor: gc.fill }]}
                  maxLength={5}
                  keyboardType="numbers-and-punctuation"
                  accessibilityLabel={t('settings.dndStart') || 'Início'}
                />
              )}
            />
          )}
          {prefs.dnd_enabled && (
            <SettingsRow
              title={t('settings.dndEnd') || 'Fim'}
              right={(
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
                  placeholderTextColor={gc.secondary}
                  style={[s.timeInput, { color: gc.text, backgroundColor: gc.fill }]}
                  maxLength={5}
                  keyboardType="numbers-and-punctuation"
                  accessibilityLabel={t('settings.dndEnd') || 'Fim'}
                />
              )}
            />
          )}
        </SettingsGroup>

        {/* ─── Palavras-chave (com som por palavra) ─── */}
        <SettingsGroup header={t('notifPref.keywordsSection')} footer={t('notifPref.keywordsDesc')}>
          <View style={s.inputRow}>
            <TextInput
              style={[inputStyle, { flex: 1 }]}
              value={newKeyword}
              onChangeText={setNewKeyword}
              placeholder={t('notifPref.keywordPlaceholder')}
              placeholderTextColor={gc.secondary}
              maxLength={64}
              returnKeyType="done"
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={addKeyword}
            />
            <TouchableOpacity
              style={[s.addBtn, { backgroundColor: gc.ink, opacity: newKeyword.trim() ? 1 : 0.35 }]}
              onPress={addKeyword}
              disabled={!newKeyword.trim()}
              accessibilityRole="button"
              accessibilityLabel={t('notifPref.add')}
            >
              <Text style={[s.addBtnText, { color: gc.onInk }]}>{t('notifPref.add')}</Text>
            </TouchableOpacity>
          </View>
          {keywords.length === 0 && !loading && (
            <SettingsRow title={t('notifPref.noKeywords')} titleStyle={{ color: gc.secondary, fontSize: 15 }} numberOfLines={2} />
          )}
          {keywords.map(k => {
            const sndLabel = soundLabel(SYSTEM_SOUNDS.find(x => x.value === (k.sound || 'default')) || SYSTEM_SOUNDS[0], t);
            return (
              <SettingsRow
                key={k.id}
                title={k.keyword}
                subtitle={t('notifPref.soundRow', { sound: sndLabel })}
                accessibilityLabel={`${k.keyword}, ${t('notifPref.soundRow', { sound: sndLabel })}`}
                onPress={() => setEditingSoundForId(k.id)}
                right={(
                  <TouchableOpacity
                    onPress={() => removeKeyword(k.id)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel={`${t('notifPref.remove')} ${k.keyword}`}
                  >
                    <IconTrash size={18} color={gc.destructive} />
                  </TouchableOpacity>
                )}
              />
            );
          })}
        </SettingsGroup>
      </FadeSlideIn>

      {/* Som por palavra-chave — sheet com checkmark (16 opções, rolável). */}
      {!!editingSoundForId && (
        <OptionSheet
          visible={!!editingSoundForId}
          title={t('notifPref.soundForTitle', { keyword: editingKw?.keyword || '' })}
          message={t('notifPref.soundPickerDesc')}
          options={soundOptions}
          value={editingKw?.sound || 'default'}
          cancelLabel={t('common.cancel') || 'Cancelar'}
          onSelect={(sound) => updateKeywordSound(editingSoundForId, sound)}
          onClose={() => setEditingSoundForId(null)}
        />
      )}
    </SettingsScreen>
  );
}

const s = StyleSheet.create({
  pill: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16, minWidth: 48, alignItems: 'center' },
  pillText: { fontWeight: '600', fontSize: 14 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  addBtn: { minHeight: 44, paddingHorizontal: 16, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  addBtnText: { fontWeight: '600', fontSize: 15 },
  timeInput: {
    minWidth: 76, textAlign: 'center', fontSize: 16, fontVariant: ['tabular-nums'],
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
});
