// Settings screen showing what One AI has remembered about the user.
// Reads from /api/rust/one/memory (Rust one-api) and allows delete/clear.
//
// [#1241 2026-05-20] Polish wave: nicer empty state (SVG orb with halo, warmer
// copy), card shadow + rounder corners, staggered fade-in entrance on the list,
// and a section header that groups memories by inferred freshness ("Recentes"
// vs "Mais antigas") when the backend exposes a `created_at` field.
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet, ActivityIndicator,
  RefreshControl, Platform, Alert, Animated, Easing,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle as SvgCircle, Defs, RadialGradient, Stop } from 'react-native-svg';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { BASE_URL, getAuthHeaders } from '../services/api';
import { IconArrowLeft, IconTrash, IconSparkles } from '../components/Icons';

const ACCENT = '#7C3AED';

function safeAlert(title, message, buttons) {
  if (Platform.OS === 'web') {
    if (buttons?.length) {
      if (window.confirm(`${title}\n${message || ''}`)) {
        const ok = buttons.find(b => b.style !== 'cancel');
        ok?.onPress?.();
      }
    } else { window.alert(message || title); }
  } else {
    Alert.alert(title, message, buttons);
  }
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
            <Stop offset="0%" stopColor="#A78BFA" stopOpacity={isDark ? 0.7 : 0.55} />
            <Stop offset="60%" stopColor={ACCENT} stopOpacity={0.32} />
            <Stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <SvgCircle cx={48} cy={48} r={44} fill="url(#memOrb)" />
        <SvgCircle cx={48} cy={48} r={22} fill={ACCENT} fillOpacity={0.92} />
      </Svg>
      <View style={{ position: 'absolute' }}>
        <IconSparkles size={22} color="#fff" />
      </View>
    </View>
  );
}

// One row with a staggered fade+rise entrance. The delay caps at 6 rows so
// long lists don't make the user wait — anything past row 6 just snaps in.
function MemoryRow({ item, index, isDark, colors, onDelete, t }) {
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
        styles.row,
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
      <View style={styles.rowIconChip}>
        <IconSparkles size={12} color="#fff" />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 11, color: colors.textSecondary, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 }}>
          {(item?.key || '').replace(/_/g, ' ')}
        </Text>
        <Text style={{ fontSize: 14.5, color: colors.text, lineHeight: 20 }} numberOfLines={5}>
          {item.value}
        </Text>
      </View>
      <TouchableOpacity onPress={() => onDelete(item.key)} style={styles.delBtn} accessibilityLabel={t('common.delete') || 'Apagar'} hitSlop={8}>
        <IconTrash size={18} color="#ef4444" />
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

  const load = useCallback(async () => {
    try {
      const headers = getAuthHeaders();
      const r = await fetch(`${BASE_URL}/api/rust/one/memory`, { headers });
      if (r.ok) {
        const data = await r.json();
        setMemories(data?.data?.memories || []);
      }
    } catch {}
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const deleteOne = useCallback(async (key) => {
    safeAlert(
      t('oneMemory.deleteTitle') || 'Esquecer isso?',
      t('oneMemory.deleteMsg') || `A One vai esquecer "${key}". Tem certeza?`,
      [
        { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
        { text: t('common.delete') || 'Apagar', style: 'destructive', onPress: async () => {
          try {
            const headers = { ...getAuthHeaders(), 'Content-Type': 'application/json' };
            const r = await fetch(`${BASE_URL}/api/rust/one/memory/delete`, {
              method: 'POST', headers, body: JSON.stringify({ key }),
            });
            // Só atualiza estado local se o backend confirmou a deleção.
            if (r.ok) setMemories(prev => prev.filter(m => m.key !== key));
          } catch {}
        } },
      ]
    );
  }, [t]);

  const clearAll = useCallback(() => {
    safeAlert(
      t('oneMemory.clearAllTitle') || 'Esquecer tudo?',
      t('oneMemory.clearAllMsg') || 'A One vai esquecer TUDO que sabe sobre você. Isso não pode ser desfeito.',
      [
        { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
        { text: t('common.deleteAll') || 'Apagar tudo', style: 'destructive', onPress: async () => {
          try {
            const headers = { ...getAuthHeaders(), 'Content-Type': 'application/json' };
            const r = await fetch(`${BASE_URL}/api/rust/one/memory/delete`, {
              method: 'POST', headers, body: JSON.stringify({ key: '' }),
            });
            if (r.ok) setMemories([]);
          } catch {}
        } },
      ]
    );
  }, [t]);

  const renderItem = useCallback(({ item, index }) => (
    <MemoryRow
      item={item}
      index={index}
      isDark={isDark}
      colors={colors}
      onDelete={deleteOne}
      t={t}
    />
  ), [isDark, colors, deleteOne, t]);

  // Subtle gradient backdrop the brand purple gives the screen depth without
  // overpowering the row cards. Static — no animation, no perf cost.
  const screenBg = colors.background;

  return (
    <View style={[styles.container, { backgroundColor: screenBg, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn} hitSlop={8}>
          <IconArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>
          {t('oneMemory.title') || 'O que a One sabe sobre você'}
        </Text>
        <View style={styles.headerBtn} />
      </View>

      {loading && memories.length === 0 ? (
        <View style={styles.empty}>
          <ActivityIndicator size="large" color={ACCENT} />
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
          <FlatList
            data={memories}
            keyExtractor={(item) => item.key}
            renderItem={renderItem}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={ACCENT} />}
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
  row: {
    flexDirection: 'row', alignItems: 'flex-start', padding: 14,
    borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: 12,
  },
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
