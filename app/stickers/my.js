// Installed packs management screen — re-orderable list + uninstall + create.
//
// "Criar pacote" is gated to Pro tier, since the spec ties new pack creation
// to the Premium tier alongside custom animated emoji. The CTA is rendered
// for everyone but tapping while non-Pro routes to /plans, mirroring the
// existing upsell pattern across the app.
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, ActivityIndicator, Alert, Platform,
  Image, TextInput, Modal, Animated, Share, PanResponder,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import * as api from '../../services/api';
import {
  IconArrowLeft, IconTrash, IconPlus, IconStar, IconX, IconShare,
} from '../../components/Icons';

// Resolve a stored R2 key / relative URL to something Image can fetch.
function resolveCoverUri(url) {
  if (!url || typeof url !== 'string') return null;
  if (/^https?:\/\//.test(url)) return url;
  if (url.startsWith('/data/')) {
    let base = '';
    try { base = (typeof api.getCurrentBaseUrl === 'function' ? api.getCurrentBaseUrl() : api.BASE_URL) || ''; } catch {}
    if (!base) base = api.BASE_URL || '';
    base = String(base).replace(/\/$/, '');
    return base ? base + url : 'https://chatyy.com.br' + url;
  }
  return `https://media.chatyy.com.br/${url.replace(/^\/+/, '')}`;
}

export default function StickerMyPacksScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const [packs, setPacks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [planTier, setPlanTier] = useState('free');
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);
  // Local-only pack ordering. The backend doesn't track per-user order yet,
  // but reordering on the device gives the picker a stable preference. Users
  // can drag-handle (arrow up/down) to nudge a pack up or down — same UX as
  // Telegram. Persisted in AsyncStorage so it survives app restart.
  const STORAGE_KEY = '@chatyy_my_pack_order';

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.stickerPackMy();
      let arr = r?.items || r?.data?.items || [];
      // Apply saved local order, if any.
      try {
        let saved = null;
        if (Platform.OS === 'web') {
          const v = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
          if (v) saved = JSON.parse(v);
        } else {
          const AsyncStorage = require('@react-native-async-storage/async-storage').default;
          const v = await AsyncStorage.getItem(STORAGE_KEY);
          if (v) saved = JSON.parse(v);
        }
        if (Array.isArray(saved) && saved.length) {
          const byId = new Map(arr.map((p) => [p.id, p]));
          const ordered = [];
          for (const id of saved) { if (byId.has(id)) { ordered.push(byId.get(id)); byId.delete(id); } }
          for (const remaining of byId.values()) ordered.push(remaining);
          arr = ordered;
        }
      } catch {}
      setPacks(arr);
    } catch {} finally {
      setLoading(false);
    }
    // Plan check — drives the Pro gate on "Criar pacote".
    try {
      const p = await api.planInfo?.();
      const tier = (p?.plan || p?.data?.plan || 'free').toLowerCase();
      setPlanTier(tier);
    } catch { setPlanTier('free'); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Persist order to local storage + server. The backend call is fire-and-
  // forget so an offline reorder still updates the local cache instantly.
  const persistOrder = useCallback(async (arr) => {
    const ids = arr.map((p) => p.id);
    try {
      if (Platform.OS === 'web') {
        if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
      } else {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
      }
    } catch {}
    try { api.stickerPackReorder?.(ids); } catch {}
  }, []);

  // Drag-to-reorder. We track the index currently being dragged and the
  // pixel offset from its rest position. On release we swap based on the
  // accumulated dy / ROW_HEIGHT.
  const ROW_HEIGHT = 72; // matches the renderItem row (padding 10 + 52 tile)
  const [dragIndex, setDragIndex] = useState(-1);
  const dragY = useRef(new Animated.Value(0)).current;
  const dragAccumRef = useRef(0);

  // Build the responder per-row. The renderItem passes the row's index in.
  const makePanResponder = useCallback((rowIndex) => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_e, gs) => Math.abs(gs.dy) > 4,
    onPanResponderGrant: () => {
      setDragIndex(rowIndex);
      dragAccumRef.current = 0;
      dragY.setValue(0);
    },
    onPanResponderMove: (_e, gs) => {
      dragAccumRef.current = gs.dy;
      dragY.setValue(gs.dy);
    },
    onPanResponderRelease: () => {
      const dy = dragAccumRef.current;
      const steps = Math.round(dy / ROW_HEIGHT);
      if (steps !== 0) {
        setPacks((prev) => {
          const to = Math.max(0, Math.min(prev.length - 1, rowIndex + steps));
          if (to === rowIndex) return prev;
          const next = prev.slice();
          const [moved] = next.splice(rowIndex, 1);
          next.splice(to, 0, moved);
          persistOrder(next);
          return next;
        });
      }
      Animated.timing(dragY, { toValue: 0, duration: 120, useNativeDriver: true }).start(() => {
        setDragIndex(-1);
      });
    },
    onPanResponderTerminate: () => {
      Animated.timing(dragY, { toValue: 0, duration: 120, useNativeDriver: true }).start(() => setDragIndex(-1));
    },
  }), [persistOrder, dragY]);

  // Share a pack via the system share sheet (or clipboard fallback on web).
  const sharePack = useCallback(async (pack) => {
    const handle = pack?.handle;
    if (!handle) {
      Alert.alert(
        t?.('chat.shareUnavailable') || 'Não dá pra compartilhar',
        t?.('chat.shareUnavailableBody') || 'Esse pacote não tem link público.',
      );
      return;
    }
    const url = `https://chatyy.com.br/stickers/store?install=${encodeURIComponent(handle)}`;
    const message = (t?.('chat.shareMsg') || 'Confira esse pacote no Chatyy:') + ' ' + url;
    try {
      if (Platform.OS === 'web') {
        if (typeof navigator !== 'undefined' && navigator.share) {
          await navigator.share({ title: pack.name, text: message, url });
        } else if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(url);
          Alert.alert(t?.('chat.linkCopied') || 'Link copiado', url);
        } else {
          Alert.alert(pack.name, url);
        }
      } else {
        await Share.share({ message, url, title: pack.name });
      }
    } catch {}
  }, [t]);

  const uninstall = useCallback(async (pack) => {
    Alert.alert(
      t?.('chat.removePack') || 'Remover pacote?',
      pack.name,
      [
        { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
        {
          text: t?.('common.remove') || 'Remover',
          style: 'destructive',
          onPress: async () => {
            // Optimistic update.
            setPacks((prev) => prev.filter((p) => p.id !== pack.id));
            try { await api.stickerPackUninstall(pack.id); }
            catch (e) { Alert.alert(t?.('common.error') || 'Erro', e?.message || 'Falha'); refresh(); }
          },
        },
      ],
    );
  }, [refresh, t]);

  const createPack = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    // Pro gate. Free / Plus users get nudged to /plans instead of failing
    // server-side with a 402. The server check still acts as the source of
    // truth on the upload step.
    if (!['pro', 'family'].includes(planTier)) {
      setShowCreate(false);
      router.push('/plans');
      return;
    }
    setCreating(true);
    try {
      const r = await api.stickerPackCreate({ name, description: newDesc.trim() });
      if (r?.success) {
        setShowCreate(false);
        setNewName('');
        setNewDesc('');
        await refresh();
      } else {
        Alert.alert(t?.('common.error') || 'Erro', r?.error || r?.message || 'Falha');
      }
    } catch (e) {
      Alert.alert(t?.('common.error') || 'Erro', e?.message || 'Falha');
    } finally {
      setCreating(false);
    }
  }, [newName, newDesc, planTier, router, refresh, t]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{
        flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: 12, paddingVertical: 12, gap: 10,
        borderBottomWidth: 1, borderBottomColor: colors.border,
      }}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={{ flex: 1, fontSize: 17, fontWeight: '800', color: colors.text }}>
          {t?.('chat.myPacks') || 'Meus pacotes'}
        </Text>
        <TouchableOpacity onPress={() => setShowCreate(true)} hitSlop={10}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <IconPlus size={18} color={colors.primary} />
          <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '700' }}>
            {t?.('chat.createPack') || 'Criar pacote'}
          </Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: 36 }} />
      ) : packs.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 30 }}>
          <Text style={{ fontSize: 48 }}>📦</Text>
          <Text style={{ marginTop: 12, fontSize: 15, color: colors.text, fontWeight: '700' }}>
            {t?.('chat.noPacksInstalled') || 'Você ainda não instalou pacotes'}
          </Text>
          <Text style={{ marginTop: 6, fontSize: 13, color: colors.textTertiary, textAlign: 'center' }}>
            {t?.('chat.openStoreHint') || 'Abra a loja pra descobrir pacotes incríveis.'}
          </Text>
          <TouchableOpacity
            onPress={() => router.push('/stickers/store')}
            style={{
              marginTop: 18, paddingVertical: 10, paddingHorizontal: 22,
              borderRadius: 12, backgroundColor: colors.primary,
            }}
          >
            <Text style={{ color: '#fff', fontWeight: '800', fontSize: 14 }}>
              {t?.('chat.openStore') || 'Abrir loja'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={packs}
          keyExtractor={(p) => String(p.id)}
          contentContainerStyle={{ paddingVertical: 8 }}
          // Disable scroll while a row is being dragged so the list doesn't
          // fight the pan responder.
          scrollEnabled={dragIndex === -1}
          renderItem={({ item, index }) => {
            const cover = resolveCoverUri(item.cover_url);
            const isDragging = dragIndex === index;
            // Per-row responder. Built fresh each render — cheap, and the
            // responder is only ever activated on the drag-handle, so the
            // outer FlatList scroll keeps working everywhere else.
            const responder = makePanResponder(index);
            return (
              <Animated.View style={{
                flexDirection: 'row', alignItems: 'center',
                paddingHorizontal: 14, paddingVertical: 10,
                borderBottomWidth: 1, borderBottomColor: colors.border,
                gap: 12,
                backgroundColor: isDragging ? (colors.surfaceVariant || colors.surface) : 'transparent',
                transform: isDragging ? [{ translateY: dragY }] : [],
                ...(isDragging && Platform.OS === 'web' ? { boxShadow: '0 6px 18px rgba(0,0,0,0.18)' } : {}),
                zIndex: isDragging ? 10 : 0,
              }}>
                {/* Drag-handle. PanResponder lives here so the rest of the
                    row remains tappable (uninstall, share, etc.). Arrows are
                    kept as a keyboard-friendly fallback for web users w/o
                    pointer drag (e.g. accessibility). */}
                <View {...responder.panHandlers} style={{
                  paddingHorizontal: 4, paddingVertical: 6,
                  alignItems: 'center', justifyContent: 'center',
                  ...(Platform.OS === 'web' ? { cursor: 'grab', touchAction: 'none' } : {}),
                }}>
                  {/* Three-line drag glyph, à la WhatsApp/Telegram reorder UI. */}
                  <View style={{ width: 14, height: 2, backgroundColor: colors.textSecondary, marginVertical: 2, borderRadius: 1 }} />
                  <View style={{ width: 14, height: 2, backgroundColor: colors.textSecondary, marginVertical: 2, borderRadius: 1 }} />
                  <View style={{ width: 14, height: 2, backgroundColor: colors.textSecondary, marginVertical: 2, borderRadius: 1 }} />
                </View>
                <View style={{
                  width: 52, height: 52, borderRadius: 10, overflow: 'hidden',
                  backgroundColor: colors.surfaceVariant || colors.surface,
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  {cover ? (
                    <Image source={{ uri: cover }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                  ) : (
                    <Text style={{ fontSize: 26 }}>{item.animated ? '🎬' : '📦'}</Text>
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>
                    {item.name}
                  </Text>
                  <Text numberOfLines={1} style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                    {item.author_email?.split('@')?.[0] || '—'} · {item.install_count || 0}
                  </Text>
                </View>
                {item.premium && (
                  <View style={{
                    backgroundColor: 'rgba(124,58,237,0.15)', paddingHorizontal: 6, paddingVertical: 2,
                    borderRadius: 6, flexDirection: 'row', alignItems: 'center', gap: 3,
                  }}>
                    <IconStar size={10} color="#7C3AED" />
                    <Text style={{ color: '#7C3AED', fontSize: 9, fontWeight: '800' }}>PRO</Text>
                  </View>
                )}
                <TouchableOpacity onPress={() => sharePack(item)} hitSlop={8} style={{ paddingHorizontal: 4 }}>
                  <IconShare size={18} color={colors.textSecondary} />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => uninstall(item)} hitSlop={8} style={{ paddingHorizontal: 4 }}>
                  <IconTrash size={18} color={colors.danger || '#EF4444'} />
                </TouchableOpacity>
              </Animated.View>
            );
          }}
        />
      )}

      <Modal visible={showCreate} animationType="slide" transparent onRequestClose={() => setShowCreate(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}>
          <View style={{
            backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20,
            padding: 20,
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ flex: 1, fontSize: 17, fontWeight: '800', color: colors.text }}>
                {t?.('chat.createPack') || 'Criar pacote'}
              </Text>
              <TouchableOpacity onPress={() => setShowCreate(false)} hitSlop={10}>
                <IconX size={22} color={colors.text} />
              </TouchableOpacity>
            </View>

            {!['pro', 'family'].includes(planTier) && (
              <View style={{
                marginTop: 14, padding: 12, borderRadius: 12,
                backgroundColor: 'rgba(124,58,237,0.08)',
                borderWidth: 1, borderColor: 'rgba(124,58,237,0.25)',
                flexDirection: 'row', alignItems: 'center', gap: 10,
              }}>
                <IconStar size={18} color="#7C3AED" />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, color: colors.text, fontWeight: '700' }}>
                    {t?.('chat.proRequired') || 'Recurso Pro'}
                  </Text>
                  <Text style={{ fontSize: 11, color: colors.textSecondary, marginTop: 2 }}>
                    {t?.('chat.proPackHint') || 'Crie pacotes ilimitados com o plano Pro.'}
                  </Text>
                </View>
              </View>
            )}

            <Text style={{ marginTop: 14, fontSize: 12, fontWeight: '700', color: colors.textSecondary }}>
              {t?.('chat.packName') || 'Nome do pacote'}
            </Text>
            <TextInput
              value={newName}
              onChangeText={setNewName}
              placeholder={t?.('chat.packNamePlaceholder') || 'Ex: Memes BR'}
              placeholderTextColor={colors.textTertiary}
              style={{
                marginTop: 6, paddingVertical: 10, paddingHorizontal: 12,
                borderRadius: 10, borderWidth: 1, borderColor: colors.border,
                color: colors.text, fontSize: 14, backgroundColor: colors.surface,
                ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
              }}
              maxLength={80}
            />
            <Text style={{ marginTop: 12, fontSize: 12, fontWeight: '700', color: colors.textSecondary }}>
              {t?.('chat.packDescription') || 'Descrição (opcional)'}
            </Text>
            <TextInput
              value={newDesc}
              onChangeText={setNewDesc}
              placeholder={t?.('chat.packDescPlaceholder') || 'Conte do que se trata…'}
              placeholderTextColor={colors.textTertiary}
              multiline
              style={{
                marginTop: 6, paddingVertical: 10, paddingHorizontal: 12,
                borderRadius: 10, borderWidth: 1, borderColor: colors.border,
                color: colors.text, fontSize: 14, backgroundColor: colors.surface,
                minHeight: 60, textAlignVertical: 'top',
                ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
              }}
              maxLength={240}
            />

            <TouchableOpacity
              onPress={createPack}
              disabled={creating || !newName.trim()}
              activeOpacity={0.85}
              style={{
                marginTop: 18, paddingVertical: 14, borderRadius: 12,
                backgroundColor: !newName.trim() ? colors.border : colors.primary,
                alignItems: 'center',
              }}
            >
              {creating ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={{ color: '#fff', fontSize: 14, fontWeight: '800' }}>
                  {!['pro', 'family'].includes(planTier)
                    ? (t?.('chat.upgradeToCreate') || 'Fazer upgrade')
                    : (t?.('common.create') || 'Criar')}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}
