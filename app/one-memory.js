// Settings screen showing what One AI has remembered about the user.
// [bia-fase0 2026-10-18] Agora lê/edita/apaga o que a Bia REALMENTE usa: one_memory
// (preferências, local, trabalho, cérebro/perfil, correções) via one_memory_list /
// one_memory_update / one_memory_delete (PHP, escopo do usuário). Antes lia
// /api/rust/one/memory = tabela one_user_memory (sempre vazia). Agrupado por
// categoria; "Apagar tudo" = eliminação LGPD.
//
// [#1241 2026-05-20] Polish wave: nicer empty state (SVG orb with halo, warmer
// copy), card shadow + rounder corners, staggered fade-in entrance on the list,
// and a section header that groups memories by inferred freshness ("Recentes"
// vs "Mais antigas") when the backend exposes a `created_at` field.
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, SectionList, StyleSheet, ActivityIndicator,
  RefreshControl, Platform, Animated, Easing, TextInput,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../components/nativeHeader'; // [2026-10-09 native-sheets-headers] header NATIVO
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle as SvgCircle, Defs, RadialGradient, Stop } from 'react-native-svg';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { apiCall } from '../services/api'; // [bia-fase0 2026-10-18] one_memory_* (PHP) no lugar do /api/rust/one/memory
import { IconArrowLeft, IconTrash } from '../components/Icons';
import NativeSheetDialog from '../components/NativeSheetDialog';
import { safeAlert as _sharedSafeAlert } from '../services/alerts';
import { a11yLabel } from '../utils/a11yLabel'; // [2026-10-20 a11y] rótulos dos botões só-ícone
import BiaIcon from '../components/bia/BiaIcon'; // [2026-10-18 bia-orb-icon] Bia/IA = orb (não a estrelinha)

const ACCENT = '#111111';

// [2026-10-12 overlays] cópia local → services/alerts (web = diálogo estilizado do app).
function safeAlert(title, message, buttons) { _sharedSafeAlert(title, message, buttons); }

// [bia-fase0 2026-10-18] ordem/rótulo das categorias de one_memory
const CAT_ORDER = ['brain', 'correction', 'personal', 'preference', 'family', 'friends', 'work', 'location', 'contact_info', 'dates', 'health', 'travel', 'financial'];
const KNOWN_CATS = new Set([...CAT_ORDER, 'whatsapp']);
function humanize(s) { const x = String(s || '').replace(/[_-]+/g, ' ').trim(); return x ? x.charAt(0).toUpperCase() + x.slice(1) : ''; }
function catLabel(cat, t) {
  if (KNOWN_CATS.has(cat)) { const k = 'oneMemory.cat_' + cat; const v = t(k); if (v && v !== k) return v; }
  return humanize(cat) || (t('oneMemory.cat_other') || 'Outros');
}
function groupItems(items, t) {
  const by = {};
  items.forEach((it) => { const c = it.category || 'preference'; (by[c] = by[c] || []).push(it); });
  const cats = Object.keys(by).sort((a, b) => {
    const ia = CAT_ORDER.indexOf(a), ib = CAT_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.localeCompare(b);
  });
  return cats.map((c) => ({ key: c, title: catLabel(c, t), data: by[c] }));
}
function rowTitle(item, t) {
  if (item.category === 'brain') return t('oneMemory.brainTitle') || 'Resumo que a Bia mantém sobre você';
  if (item.category === 'correction') {
    try { const d = item.updated_at ? new Date(item.updated_at) : null; if (d && !isNaN(d)) return (t('oneMemory.correctionOn') || 'Correção de') + ' ' + d.toLocaleDateString(); } catch {}
    return t('oneMemory.cat_correction') || 'Correção';
  }
  return humanize(item.key);
}

// Soft purple orb for the empty state — keeps the same brand color but lets us
// drop the bare-icon look. The radial gradient gives it some depth without
// being heavy.
function EmptyOrb({ isDark }) {
  return (
    <View style={{ width: 96, height: 96, alignItems: 'center', justifyContent: 'center', marginBottom: 18 }}>
      <Svg width={96} height={96} viewBox="0 0 96 96">
        <Defs>
          <RadialGradient id="memOrb" cx="50%" cy="45%" r="55%">
            <Stop offset="0%" stopColor="#111111" stopOpacity={isDark ? 0.7 : 0.55} />
            <Stop offset="60%" stopColor={(isDark ? '#F5F5F7' : ACCENT)} stopOpacity={0.32} />
            <Stop offset="100%" stopColor={(isDark ? '#F5F5F7' : ACCENT)} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <SvgCircle cx={48} cy={48} r={44} fill="url(#memOrb)" />
      </Svg>
      <View style={{ position: 'absolute' }}>
        <BiaIcon size={48} />
      </View>
    </View>
  );
}

// One row with a staggered fade+rise entrance. The delay caps at 6 rows so
// long lists don't make the user wait — anything past row 6 just snaps in.
function MemoryRow({ item, index, isDark, colors, onDelete, onEdit, t }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(8)).current;
  useEffect(() => {
    const delay = Math.min(index, 6) * 45;
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 260, delay, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 320, delay, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, []);
  return (
    <Animated.View
      style={[
        styles.rowWrap,
        {
          opacity,
          transform: [{ translateY }],
          backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : '#fff',
          borderColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)',
          shadowColor: '#000',
          shadowOpacity: isDark ? 0.25 : 0.06,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 4 },
          ...(Platform.OS === 'android' ? { elevation: 1 } : {}),
        },
      ]}
    >
      <TouchableOpacity activeOpacity={0.7} onPress={() => onEdit(item)} style={styles.row} accessibilityRole="button" accessibilityHint={t('oneMemory.editHint') || 'Toque para editar'}>
      <View style={styles.rowIconChip}>
        <BiaIcon size={12} color="#fff" />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 11, color: colors.textSecondary, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 }}>
          {rowTitle(item, t)}
        </Text>
        <Text style={{ fontSize: 14.5, color: colors.text, lineHeight: 20 }} numberOfLines={item.category === 'brain' ? 8 : 5}>
          {item.value}
        </Text>
      </View>
      <TouchableOpacity onPress={() => onDelete(item)} style={styles.delBtn} accessibilityLabel={t('common.delete') || 'Apagar'} hitSlop={8}>
        <IconTrash size={18} color="#ef4444" />
      </TouchableOpacity>
      </TouchableOpacity>
    </Animated.View>
  );
}

export default function OneMemoryScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [memories, setMemories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(null); // { item, text, saving }

  const netError = useCallback(() => {
    safeAlert(t('common.error') || 'Erro', t('common.networkError') || 'Erro de rede. Tente novamente.', [{ text: 'OK' }]);
  }, [t]);

  const load = useCallback(async () => {
    try {
      const r = await apiCall('one_memory_list', {}, 'GET');
      if (r?.success) setMemories(Array.isArray(r?.data?.items) ? r.data.items : []);
    } catch {}
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const sections = useMemo(() => groupItems(memories, t), [memories, t]);

  const deleteOne = useCallback((item) => {
    safeAlert(
      t('oneMemory.deleteTitle') || 'Esquecer isso?',
      t('oneMemory.deleteMsg') || 'A Bia vai esquecer esse item. Tem certeza?',
      [
        { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
        { text: t('common.delete') || 'Apagar', style: 'destructive', onPress: async () => {
          try {
            const r = await apiCall('one_memory_delete', { id: item.id }, 'POST');
            // Só atualiza estado local se o backend confirmou a deleção.
            if (r?.success) { setMemories(prev => prev.filter(m => m.id !== item.id)); setEditing(null); }
            else netError();
          } catch { netError(); }
        } },
      ]
    );
  }, [t, netError]);

  const saveEdit = useCallback(async () => {
    const cur = editing;
    if (!cur) return;
    const text = (cur.text || '').trim();
    if (text === (cur.item.value || '').trim()) { setEditing(null); return; }
    if (!text) { deleteOne(cur.item); return; }
    setEditing({ ...cur, saving: true });
    try {
      const r = await apiCall('one_memory_update', { id: cur.item.id, value: text }, 'POST');
      if (r?.success) {
        const v = r?.data?.value ?? text;
        setMemories(prev => prev.map(m => (m.id === cur.item.id ? { ...m, value: v, updated_at: new Date().toISOString() } : m)));
        setEditing(null);
        return;
      }
    } catch {}
    setEditing(e => (e ? { ...e, saving: false } : e));
    netError();
  }, [editing, deleteOne, netError]);

  const clearAll = useCallback(() => {
    safeAlert(
      t('oneMemory.clearAllTitle') || 'Esquecer tudo?',
      t('oneMemory.clearAllMsg') || 'A Bia vai esquecer TUDO que sabe sobre você. Isso não pode ser desfeito.',
      [
        { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
        { text: t('common.deleteAll') || 'Apagar tudo', style: 'destructive', onPress: async () => {
          try {
            const r = await apiCall('one_memory_delete', { all: 1 }, 'POST');
            if (r?.success) setMemories([]);
            else netError();
          } catch { netError(); }
        } },
      ]
    );
  }, [t, netError]);

  const renderItem = useCallback(({ item, index }) => (
    <MemoryRow
      item={item}
      index={index}
      isDark={isDark}
      colors={colors}
      onDelete={deleteOne}
      onEdit={(it) => setEditing({ item: it, text: it.value || '', saving: false })}
      t={t}
    />
  ), [isDark, colors, deleteOne, t]);

  const renderSectionHeader = useCallback(({ section }) => (
    <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
      {section.title} <Text style={{ fontWeight: '500' }}>{'· ' + section.data.length}</Text>
    </Text>
  ), [colors]);

  // Subtle gradient backdrop the brand purple gives the screen depth without
  // overpowering the row cards. Static — no animation, no perf cost.
  const screenBg = colors.background;

  return (
    <View style={[styles.container, { backgroundColor: screenBg, paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }]}>
      {USE_NATIVE_HEADER && <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title: t('oneMemory.title') })} />}
      {!USE_NATIVE_HEADER && (
      <View style={[styles.header, { borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }]}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={a11yLabel('common.back', 'Voltar')} onPress={() => router.back()} style={styles.headerBtn} hitSlop={8}>
          <IconArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>
          {t('oneMemory.title') || 'O que a One sabe sobre você'}
        </Text>
        <View style={styles.headerBtn} />
      </View>
      )}

      {loading && memories.length === 0 ? (
        <View style={styles.empty}>
          <ActivityIndicator size="large" color={(colors?.primary || ACCENT)} />
        </View>
      ) : memories.length === 0 ? (
        <View style={styles.empty}>
          <EmptyOrb isDark={isDark} />
          <Text style={{ fontSize: 19, fontWeight: '700', color: colors.text, marginBottom: 10, textAlign: 'center', letterSpacing: -0.2 }}>
            {t('oneMemory.empty') || 'A One ainda não sabe nada sobre você'}
          </Text>
          <Text style={{ fontSize: 14.5, color: colors.textSecondary, textAlign: 'center', lineHeight: 22, paddingHorizontal: 24 }}>
            {t('oneMemory.emptyHint') || 'Converse com a One e diga coisas como "lembra que sou vegetariano" ou "meu aniversário é 15 de julho".'}
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.countRow}>
            <View style={[styles.countDot, { backgroundColor: ACCENT }]} />
            <Text style={{ fontSize: 13, color: colors.textSecondary, fontWeight: '600' }}>
              {memories.length} {memories.length === 1 ? (t('oneMemory.itemOne') || 'item') : (t('oneMemory.itemMany') || 'itens')}
            </Text>
          </View>
          <SectionList
            sections={sections}
            keyExtractor={(item) => String(item.id)}
            renderItem={renderItem}
            renderSectionHeader={renderSectionHeader}
            stickySectionHeadersEnabled={false}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={(colors?.primary || ACCENT)} />}
            contentContainerStyle={{ padding: 14, paddingBottom: 110 }}
            ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          />
          <TouchableOpacity onPress={clearAll} style={[styles.clearAllBtn, { bottom: insets.bottom + 16 }]}>
            <Text style={{ color: '#ef4444', fontSize: 14, fontWeight: '700' }}>
              {t('oneMemory.clearAll') || 'Apagar tudo'}
            </Text>
          </TouchableOpacity>
        </>
      )}

      {/* [bia-fase0 2026-10-18] editar um item (sheet do sistema) */}
      <NativeSheetDialog
        visible={!!editing}
        onClose={() => setEditing(null)}
        animationType="slide"
        overlayStyle={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }}
        panelStyle={[styles.sheet, { backgroundColor: isDark ? '#1C1C1E' : '#FFFFFF', paddingBottom: Math.max(16, insets.bottom + 8) }]}
      >
        <Text style={{ fontSize: 12, color: colors.textSecondary, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 }}>
          {editing ? catLabel(editing.item.category, t) : ''}
        </Text>
        <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text, marginBottom: 12, letterSpacing: -0.3 }}>
          {editing ? rowTitle(editing.item, t) : ''}
        </Text>
        <TextInput
          value={editing?.text || ''}
          onChangeText={(text) => setEditing(e => (e ? { ...e, text } : e))}
          multiline
          autoFocus={Platform.OS !== 'web'}
          maxLength={editing?.item?.category === 'brain' ? 12000 : 2000}
          style={[styles.sheetInput, { color: colors.text, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', minHeight: editing?.item?.category === 'brain' ? 180 : 90 }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]}
          accessibilityLabel={editing ? rowTitle(editing.item, t) : ''}
        />
        <View style={styles.sheetRow}>
          <TouchableOpacity onPress={() => editing && deleteOne(editing.item)} style={[styles.sheetBtn, { backgroundColor: 'rgba(239,68,68,0.10)' }]} accessibilityRole="button">
            <Text style={{ color: '#ef4444', fontSize: 15, fontWeight: '700' }}>{t('common.delete') || 'Apagar'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={saveEdit} disabled={!!editing?.saving} style={[styles.sheetBtn, { backgroundColor: isDark ? '#F5F5F7' : '#111111', opacity: editing?.saving ? 0.6 : 1 }]} accessibilityRole="button">
            <Text style={{ color: isDark ? '#111111' : '#FFFFFF', fontSize: 15, fontWeight: '700' }}>{t('common.save') || 'Salvar'}</Text>
          </TouchableOpacity>
        </View>
      </NativeSheetDialog>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  countRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 18, paddingTop: 14, paddingBottom: 6,
  },
  countDot: { width: 6, height: 6, borderRadius: 3 },
  rowWrap: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'flex-start', padding: 14, gap: 12 },
  sectionTitle: { fontSize: 12.5, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', paddingHorizontal: 4, paddingTop: 16, paddingBottom: 8 },
  sheet: { width: '100%', maxWidth: 560, alignSelf: 'center', borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 18, paddingTop: 18 },
  sheetInput: { maxHeight: 340, borderRadius: 14, paddingHorizontal: 13, paddingTop: 11, paddingBottom: 11, fontSize: 15, lineHeight: 21, textAlignVertical: 'top', marginBottom: 14 },
  sheetRow: { flexDirection: 'row', gap: 10 },
  sheetBtn: { flex: 1, paddingVertical: 13, borderRadius: 14, alignItems: 'center' },
  rowIconChip: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: ACCENT,
    alignItems: 'center', justifyContent: 'center', marginTop: 2,
  },
  delBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  clearAllBtn: {
    position: 'absolute', left: 24, right: 24,
    paddingVertical: 14, borderRadius: 14, alignItems: 'center',
    backgroundColor: 'rgba(239,68,68,0.10)',
    borderWidth: 1, borderColor: 'rgba(239,68,68,0.25)',
  },
});
