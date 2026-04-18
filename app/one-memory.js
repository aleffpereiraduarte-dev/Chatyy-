// Settings screen showing what One AI has remembered about the user.
// Reads from /api/rust/one/memory (Rust one-api) and allows delete/clear.
import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet, ActivityIndicator,
  RefreshControl, Platform, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
            await fetch(`${BASE_URL}/api/rust/one/memory/delete`, {
              method: 'POST', headers, body: JSON.stringify({ key }),
            });
            setMemories(prev => prev.filter(m => m.key !== key));
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
            await fetch(`${BASE_URL}/api/rust/one/memory/delete`, {
              method: 'POST', headers, body: JSON.stringify({ key: '' }),
            });
            setMemories([]);
          } catch {}
        } },
      ]
    );
  }, [t]);

  const renderItem = ({ item }) => (
    <View style={[styles.row, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : '#fff', borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 11, color: colors.textSecondary, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 3 }}>
          {item.key.replace(/_/g, ' ')}
        </Text>
        <Text style={{ fontSize: 14, color: colors.text, lineHeight: 19 }} numberOfLines={4}>
          {item.value}
        </Text>
      </View>
      <TouchableOpacity onPress={() => deleteOne(item.key)} style={styles.delBtn} accessibilityLabel={t('common.delete') || 'Apagar'}>
        <IconTrash size={18} color="#ef4444" />
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
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
          <IconSparkles size={40} color={ACCENT} style={{ marginBottom: 16 }} />
          <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 8, textAlign: 'center' }}>
            {t('oneMemory.empty') || 'A One ainda não sabe nada sobre você'}
          </Text>
          <Text style={{ fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 20, paddingHorizontal: 16 }}>
            {t('oneMemory.emptyHint') || 'Converse com a One e diga coisas como "lembra que sou vegetariano" ou "meu aniversário é 15 de julho".'}
          </Text>
        </View>
      ) : (
        <>
          <Text style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, fontSize: 13, color: colors.textSecondary }}>
            {memories.length} {memories.length === 1 ? (t('oneMemory.itemOne') || 'item') : (t('oneMemory.itemMany') || 'itens')}
          </Text>
          <FlatList
            data={memories}
            keyExtractor={(item) => item.key}
            renderItem={renderItem}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={ACCENT} />}
            contentContainerStyle={{ padding: 12, paddingBottom: 100 }}
            ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
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
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  row: {
    flexDirection: 'row', alignItems: 'flex-start', padding: 14,
    borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, gap: 10,
  },
  delBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  clearAllBtn: {
    position: 'absolute', left: 24, right: 24,
    paddingVertical: 14, borderRadius: 14, alignItems: 'center',
    backgroundColor: 'rgba(239,68,68,0.10)',
    borderWidth: 1, borderColor: 'rgba(239,68,68,0.25)',
  },
});
