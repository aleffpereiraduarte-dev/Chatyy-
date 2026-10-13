// [reels-v1 2026-10-13] Cold start do Reels: "O que você curte?" (3–10 chips) + gerenciar/limpar.
//
// Estilo P&B premium (sem emoji). Usado 2 jeitos:
//   • mode="onboarding" → 1º acesso ao Reels (Continuar / Agora não)
//   • mode="manage"     → botão de ajustes no topo do Reels (Salvar / limpar histórico)
// Privacidade: o texto de rodapé deixa claro que só o comportamento NO Reels é usado.
// O opt-in futuro "Personalizar com meus interesses das conversas" só aparece se o
// servidor disser available=true E a flag local estiver ligada (hoje: desligado).
import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, Modal, Pressable, ScrollView, ActivityIndicator, Platform, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as api from '../services/api';
import { haptic } from '../constants/theme';
import { REELS_CHAT_TOPICS_CLIENT_ENABLED } from '../services/reelsChatTopics';

export const REELS_CATEGORIES = ['humor', 'pets', 'sports', 'music', 'food', 'travel', 'tech', 'beauty', 'games', 'nature', 'fitness', 'art'];
const MIN = 3;
const MAX = 10;

export default function ReelsInterestPicker({ visible, mode = 'onboarding', t, onDone, onClose }) {
  const insets = useSafeAreaInsets();
  const [selected, setSelected] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [chatTopicsAvailable, setChatTopicsAvailable] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const tt = (k, fb) => (t && t(k)) || fb;

  useEffect(() => {
    if (!visible) return undefined;
    let alive = true;
    setResetDone(false);
    setLoading(true);
    (async () => {
      try {
        const r = await api.reelsInterestsGet();
        if (!alive) return;
        if (r?.success && r.data) {
          setSelected(Array.isArray(r.data.selected) ? r.data.selected.filter((c) => REELS_CATEGORIES.includes(c)) : []);
          setChatTopicsAvailable(!!r.data.personalize_from_chats_available);
        }
      } catch {}
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [visible]);

  const toggle = useCallback((id) => {
    try { haptic.select(); } catch {}
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : (prev.length >= MAX ? prev : [...prev, id])));
  }, []);

  const save = useCallback(async (skip = false) => {
    if (saving) return;
    setSaving(true);
    try { await api.reelsInterestsSet(skip ? [] : selected, { skip }); } catch {}
    setSaving(false);
    onDone && onDone(skip ? [] : selected);
  }, [saving, selected, onDone]);

  const resetHistory = useCallback(async () => {
    try { haptic.select(); } catch {}
    try { await api.reelsInterestsReset(); } catch {}
    setSelected([]);
    setResetDone(true);
  }, []);

  const canContinue = selected.length >= MIN;
  const isManage = mode === 'manage';

  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={() => (isManage ? onClose?.() : save(true))} statusBarTranslucent>
      <View style={[styles.root, { paddingTop: insets.top + 24, paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
        <Text style={styles.title} accessibilityRole="header">
          {isManage ? tt('reels.interests.manageTitle', 'Seus interesses') : tt('reels.interests.title', 'O que você curte?')}
        </Text>
        <Text style={styles.subtitle}>
          {tt('reels.interests.subtitle', 'Escolha pelo menos 3 para montar seus Reels. Você pode mudar quando quiser.')}
        </Text>
        {loading ? (
          <View style={styles.loading}><ActivityIndicator color="#fff" /></View>
        ) : (
          <ScrollView contentContainerStyle={styles.chips} showsVerticalScrollIndicator={false}>
            {REELS_CATEGORIES.map((id) => {
              const on = selected.includes(id);
              return (
                <Pressable
                  key={id}
                  onPress={() => toggle(id)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && { opacity: 0.7 }]}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{tt(`reels.cat.${id}`, id)}</Text>
                </Pressable>
              );
            })}
            {isManage && REELS_CHAT_TOPICS_CLIENT_ENABLED && chatTopicsAvailable ? (
              // Opt-in FUTURO (desligado nesta versão — ver services/reelsChatTopics.js).
              <Text style={styles.note}>{tt('reels.interests.chatTopicsConsent', '')}</Text>
            ) : null}
          </ScrollView>
        )}
        <Text style={styles.privacy}>
          {tt('reels.interests.privacy', 'Usamos só o que você assiste e curte no Reels. Suas conversas e e-mails não são usados.')}
        </Text>
        <Pressable
          onPress={() => save(false)}
          disabled={!canContinue || saving}
          accessibilityRole="button"
          style={({ pressed }) => [styles.primary, (!canContinue || saving) && styles.primaryOff, pressed && { opacity: 0.8 }]}
        >
          {saving ? <ActivityIndicator color="#000" /> : (
            <Text style={[styles.primaryText, !canContinue && { color: 'rgba(0,0,0,0.45)' }]}>
              {canContinue
                ? (isManage ? tt('common.save', 'Salvar') : tt('reels.interests.continue', 'Continuar'))
                : tt('reels.interests.pickMore', 'Escolha mais {n}').replace('{n}', String(MIN - selected.length))}
            </Text>
          )}
        </Pressable>
        {isManage ? (
          <>
            <Pressable onPress={resetHistory} accessibilityRole="button" style={styles.secondary}>
              <Text style={styles.secondaryText}>
                {resetDone ? tt('reels.interests.resetDone', 'Histórico do Reels apagado') : tt('reels.interests.reset', 'Limpar meu histórico do Reels')}
              </Text>
            </Pressable>
            <Pressable onPress={onClose} accessibilityRole="button" style={styles.secondary}>
              <Text style={styles.secondaryText}>{tt('common.close', 'Fechar')}</Text>
            </Pressable>
          </>
        ) : (
          <Pressable onPress={() => save(true)} accessibilityRole="button" style={styles.secondary}>
            <Text style={styles.secondaryText}>{tt('reels.interests.skip', 'Agora não')}</Text>
          </Pressable>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000', paddingHorizontal: 22 },
  title: { color: '#fff', fontSize: 28, fontWeight: '700', letterSpacing: -0.6 },
  subtitle: { color: 'rgba(255,255,255,0.62)', fontSize: 15, lineHeight: 21, marginTop: 8, marginBottom: 22 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingBottom: 12 },
  chip: {
    paddingHorizontal: 18, paddingVertical: 11, borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth * 2, borderColor: 'rgba(255,255,255,0.28)', backgroundColor: 'rgba(255,255,255,0.04)',
  },
  chipOn: { backgroundColor: '#fff', borderColor: '#fff' },
  chipText: { color: '#fff', fontSize: 15, fontWeight: '600', letterSpacing: -0.1 },
  chipTextOn: { color: '#000' },
  note: { width: '100%', color: 'rgba(255,255,255,0.5)', fontSize: 12.5, lineHeight: 18, marginTop: 12 },
  privacy: { color: 'rgba(255,255,255,0.45)', fontSize: 12.5, lineHeight: 18, marginTop: 8, marginBottom: 14 },
  primary: { height: 50, borderRadius: 14, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  primaryOff: { backgroundColor: 'rgba(255,255,255,0.35)' },
  primaryText: { color: '#000', fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  secondary: { height: 46, alignItems: 'center', justifyContent: 'center', marginTop: 4, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  secondaryText: { color: 'rgba(255,255,255,0.75)', fontSize: 15, fontWeight: '600' },
});
