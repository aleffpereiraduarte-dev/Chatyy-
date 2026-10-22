// [anon-comment 2026-10-14] Fila de moderação de comentários (só conta de moderação).
// O servidor decide quem é admin (feed_anon_admin_*: 403 p/ qualquer outro).
// A fila NÃO traz o autor real; "Ver autor real" pede motivo e fica na auditoria (chat_feed_anon_audit).
import { useState, useEffect, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, TextInput, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import SheetKeyboardAvoider from '../components/chat/SheetKeyboardAvoider'; // [2026-10-22 kb-uniforme] Android: teclado não cobre campos (edge-to-edge)
import { useRouter, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import { IconArrowLeft, IconEyeOff, IconFlag, IconShield } from '../components/Icons';
import AnonAvatar from '../components/AnonAvatar';

function Item({ it, colors, isDark, t, onDecide, onReveal, busy }) {
  const [revealOpen, setRevealOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [revealed, setRevealed] = useState(null);
  const line = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const reasons = it.reasons && typeof it.reasons === 'object' ? Object.entries(it.reasons) : [];
  const doReveal = async () => {
    const r = await onReveal(it.comment_id, reason.trim());
    if (r) { setRevealed(r); setRevealOpen(false); }
  };
  return (
    <View style={[styles.card, { borderColor: line }]}>
      <View style={styles.row}>
        {it.is_anon ? <AnonAvatar size={28} isDark={isDark} /> : <View style={[styles.dot, { backgroundColor: colors.text }]} />}
        <Text style={[styles.label, { color: colors.text }]} numberOfLines={1}>{it.label || ('#' + it.comment_id)}</Text>
        <View style={[styles.pill, { borderColor: line }]}>
          {it.source === 'auto_filter' ? <IconShield size={11} color={colors.textSecondary} /> : <IconFlag size={11} color={colors.textSecondary} />}
          <Text style={[styles.pillText, { color: colors.textSecondary }]}>
            {it.source === 'auto_filter' ? (t('feed.cmod.adm.auto') || 'Filtro automático') : (t('feed.cmod.adm.reports') || '{n} denúncias').replace('{n}', String(it.report_count || 0))}
          </Text>
        </View>
      </View>
      <Text style={[styles.content, { color: colors.text }]}>{it.content || it.media_url || ''}</Text>
      {reasons.length ? (
        <Text style={[styles.meta, { color: colors.textTertiary }]}>
          {reasons.map(([k, n]) => `${t('feed.cmod.reason.' + k) || k} (${n})`).join(' · ')}
        </Text>
      ) : null}
      <Text style={[styles.meta, { color: colors.textTertiary }]}>post {it.post_id} · {String(it.comment_created_at || '').slice(0, 16)}{it.hidden_at ? ' · ' + (t('feed.cmod.hidden') || 'Comentário ocultado') : ''}</Text>
      {revealed ? (
        <View style={[styles.reveal, { borderColor: line }]}>
          <Text style={[styles.revealText, { color: colors.text }]} selectable>{revealed.author_email}{revealed.author_name ? ' — ' + revealed.author_name : ''}</Text>
          {(revealed.access_log || []).slice(0, 3).map((l, i) => (
            <Text key={i} style={[styles.meta, { color: colors.textTertiary }]} selectable>{String(l.created_at).slice(0, 19)} · {l.ip}{l.port ? ':' + l.port : ''} · {l.host}</Text>
          ))}
        </View>
      ) : null}
      {revealOpen ? (
        <View style={{ marginTop: 8 }}>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder={t('feed.cmod.adm.revealReason') || 'Motivo (fica registrado na auditoria)'}
            placeholderTextColor={colors.textTertiary}
            style={[styles.input, { color: colors.text, borderColor: line }]}
            maxLength={300}
          />
          <TouchableOpacity disabled={busy || reason.trim().length < 10} onPress={doReveal} style={[styles.btn, styles.btnInk, { opacity: reason.trim().length < 10 ? 0.4 : 1, backgroundColor: colors.text }]}>
            <Text style={[styles.btnText, { color: colors.background }]}>{t('feed.cmod.adm.revealConfirm') || 'Revelar'}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {it.status === 'pending' ? (
        <View style={styles.actions}>
          <TouchableOpacity disabled={busy} onPress={() => onDecide(it.comment_id, 'keep')} style={[styles.btn, { borderColor: line }]}>
            <Text style={[styles.btnText, { color: colors.text }]}>{t('feed.cmod.adm.keep') || 'Manter'}</Text>
          </TouchableOpacity>
          <TouchableOpacity disabled={busy} onPress={() => onDecide(it.comment_id, 'remove')} style={[styles.btn, styles.btnInk, { backgroundColor: colors.text }]}>
            <Text style={[styles.btnText, { color: colors.background }]}>{t('feed.cmod.adm.remove') || 'Remover'}</Text>
          </TouchableOpacity>
          {it.is_anon && !revealed ? (
            <TouchableOpacity disabled={busy} onPress={() => setRevealOpen(v => !v)} style={[styles.btn, { borderColor: line }]}>
              <IconEyeOff size={14} color={colors.text} />
              <Text style={[styles.btnText, { color: colors.text }]}>{t('feed.cmod.adm.reveal') || 'Ver autor real'}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export default function ModeracaoComentarios() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [status, setStatus] = useState('pending');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.feedAnonAdminQueue(status);
      if (r?.success) { setItems(r.data?.items || []); setForbidden(false); }
      else if (r?.data?.error === 'forbidden') setForbidden(true);
    } catch {} finally { setLoading(false); }
  }, [status]);
  useEffect(() => { load(); }, [load]);

  const onDecide = useCallback(async (id, decision) => {
    setBusy(true);
    try {
      const r = await api.feedAnonAdminReview(id, decision);
      if (r?.success) setItems(prev => prev.filter(x => x.comment_id !== id));
    } catch {} finally { setBusy(false); }
  }, []);
  const onReveal = useCallback(async (id, reason) => {
    setBusy(true);
    try {
      const r = await api.feedAnonAdminReveal(id, reason);
      return r?.success ? r.data : null;
    } catch { return null; } finally { setBusy(false); }
  }, []);

  const line = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  return (
    <SheetKeyboardAvoider style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.header, { borderBottomColor: line }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn} accessibilityLabel={t('common.back') || 'Voltar'}>
          <IconArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('feed.cmod.adm.title') || 'Moderação de comentários'}</Text>
        <View style={styles.headerBtn} />
      </View>
      <View style={styles.tabs}>
        {['pending', 'approved', 'removed'].map((s) => (
          <TouchableOpacity key={s} onPress={() => setStatus(s)} style={[styles.tab, { borderColor: line }, status === s && { backgroundColor: colors.text }]}>
            <Text style={[styles.tabText, { color: status === s ? colors.background : colors.text }]}>
              {s === 'pending' ? (t('feed.cmod.adm.pending') || 'Pendentes') : s === 'approved' ? (t('feed.cmod.adm.keep') || 'Manter') : (t('feed.cmod.adm.remove') || 'Remover')}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.text} />
      ) : forbidden ? (
        <Text style={[styles.empty, { color: colors.textSecondary }]}>{t('feed.cmod.adm.forbidden') || 'Acesso restrito à moderação'}</Text>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it) => String(it.comment_id)}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 + insets.bottom, ...(Platform.OS === 'web' ? { maxWidth: 720, width: '100%', alignSelf: 'center' } : {}) }}
          renderItem={({ item }) => <Item it={item} colors={colors} isDark={isDark} t={t} onDecide={onDecide} onReveal={onReveal} busy={busy} />}
          ListEmptyComponent={<Text style={[styles.empty, { color: colors.textSecondary }]}>{t('feed.cmod.adm.empty') || 'Nada pendente'}</Text>}
          onRefresh={load}
          refreshing={false}
        />
      )}
    </SheetKeyboardAvoider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', height: 52, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700' },
  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  tab: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7 },
  tabText: { fontSize: 13, fontWeight: '600' },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 14, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 8, height: 8, borderRadius: 4, marginHorizontal: 10 },
  label: { flex: 1, fontSize: 14, fontWeight: '700' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  pillText: { fontSize: 11, fontWeight: '600' },
  content: { fontSize: 15, lineHeight: 21, marginTop: 10 },
  meta: { fontSize: 12, marginTop: 6 },
  reveal: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, marginTop: 10 },
  revealText: { fontSize: 14, fontWeight: '600' },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: Platform.OS === 'ios' ? 10 : 6, fontSize: 14 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9, marginTop: 8 },
  btnInk: { borderWidth: 0 },
  btnText: { fontSize: 14, fontWeight: '600' },
  empty: { textAlign: 'center', marginTop: 48, fontSize: 14 },
});
