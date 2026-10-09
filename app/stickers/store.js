// Loja de figurinhas (estilo WhatsApp) — [2026-10-08 sticker-store]
//
// Layout:
//   - Header (voltar, título, Meus pacotes) + busca
//   - Abas: Todos | Animados | Créditos
//   - Lista vertical de pacotes: capa, nome, autor · N figurinhas, faixa de
//     prévia (5 figurinhas) e botão Adicionar / Remover
//   - Toque no pacote → folha com a grade completa + Adicionar/Remover + Compartilhar
//   - Créditos: atribuição/licença de cada fonte de arte (CC BY 4.0 / MIT)
//
// Backend (email.php): sticker_pack_browse / _search / _get_by_handle /
// _install / _uninstall / _my — schema chat_sticker_packs + chat_stickers,
// o mesmo que o picker (chat_sticker_pack_stickers) lê. Instalar aqui faz o
// pacote aparecer como aba no picker do chat.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, FlatList, ActivityIndicator,
  Platform, Modal, TextInput, RefreshControl, Alert, Share, Linking,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import * as api from '../../services/api';
import {
  IconArrowLeft, IconSearch, IconX, IconCheck, IconPlus, IconStar, IconPackage, IconFilm,
  IconImage, IconShare, IconLink, IconInfo,
} from '../../components/Icons';
import CachedImage from '../../components/CachedImage';

// Figurinha é transparente: sem o fundo pastel (LQIP) do CachedImage atrás dela.
const CLEAR_PLACEHOLDER = { uri: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' };
const LICENSES_URL = 'https://media.chatyy.com.br/stickers/packs/LICENSE.txt';

// Resolve a stored R2 key / relative URL to something Image can fetch.
function resolveCoverUri(url) {
  if (!url || typeof url !== 'string') return null;
  if (/^https?:\/\//.test(url)) return url;
  if (url.startsWith('/data/')) {
    // [2026-10-08 sticker-maker] /data/* de figurinha só no US (edge devolve index.html)
    try { return api.getMediaUrl(url); } catch { return 'https://chatyy.com.br' + url; }
  }
  // R2 key — assume CDN
  return `https://media.chatyy.com.br/${url.replace(/^\/+/, '')}`;
}

function packAuthor(pack) {
  return pack?.author || pack?.author_email?.split('@')?.[0] || '';
}

function Sticker({ uri, size, colors }) {
  const u = resolveCoverUri(uri);
  if (!u) {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <IconImage size={Math.round(size * 0.45)} color={colors.textTertiary || colors.textSecondary} />
      </View>
    );
  }
  return (
    <CachedImage
      source={{ uri: u }}
      style={{ width: size, height: size }}
      resizeMode="contain"
      placeholder={CLEAR_PLACEHOLDER}
      showSpinner={false}
    />
  );
}

function InstallButton({ installed, onPress, colors, t, big }) {
  const pad = big ? { paddingVertical: 14, flex: 1 } : { paddingVertical: 7, paddingHorizontal: 12 };
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      style={{
        ...pad,
        borderRadius: big ? 14 : 999,
        backgroundColor: installed ? 'transparent' : colors.text,
        borderWidth: 1, borderColor: installed ? colors.border : colors.text,
        alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6,
      }}
    >
      {installed
        ? <IconCheck size={big ? 16 : 13} color={colors.text} />
        : <IconPlus size={big ? 16 : 13} color={colors.background} />}
      <Text style={{ fontSize: big ? 15 : 13, fontWeight: '700', color: installed ? colors.text : colors.background }}>
        {installed ? t('stickerStore.remove') : t('stickerStore.add')}
      </Text>
    </TouchableOpacity>
  );
}

function PackRow({ pack, installed, onToggle, onPress, colors, t }) {
  const preview = Array.isArray(pack.preview) ? pack.preview.slice(0, 5) : [];
  const count = pack.sticker_count || 0;
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={{
        marginHorizontal: 16, marginBottom: 12, padding: 14,
        backgroundColor: colors.surface, borderRadius: 18,
        borderWidth: 1, borderColor: colors.border,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 52, height: 52, alignItems: 'center', justifyContent: 'center' }}>
          {pack.cover_url
            ? <Sticker uri={pack.cover_url} size={52} colors={colors} />
            : (pack.animated ? <IconFilm size={30} color={colors.textSecondary} /> : <IconPackage size={30} color={colors.textSecondary} />)}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '800', color: colors.text }}>
            {pack.name}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
            {pack.animated && (
              <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1 }}>
                <Text style={{ fontSize: 9, fontWeight: '800', color: colors.textSecondary, letterSpacing: 0.3 }}>
                  {t('stickerStore.animatedBadge')}
                </Text>
              </View>
            )}
            <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 12, color: colors.textSecondary }}>
              {t('stickerStore.count', { n: count })}
            </Text>
          </View>
        </View>
        <InstallButton installed={installed} onPress={onToggle} colors={colors} t={t} />
      </View>
      {preview.length > 0 && (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 }}>
          {preview.map((u, i) => (
            <View key={u + i} style={{ width: '19%', aspectRatio: 1, alignItems: 'center', justifyContent: 'center' }}>
              <Sticker uri={u} size={52} colors={colors} />
            </View>
          ))}
        </View>
      )}
    </TouchableOpacity>
  );
}

function PackDetailModal({ pack, visible, onClose, installed, onToggle, colors, t }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible || !pack) return;
    let alive = true;
    setLoading(true);
    setItems([]);
    api.chatStickerPackStickers(pack.id).then((r) => {
      const arr = r?.items || r?.data?.items || r?.stickers || [];
      if (alive) setItems(Array.isArray(arr) ? arr : []);
    }).catch(() => {}).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [visible, pack?.id]);

  const share = useCallback(async () => {
    const handle = pack?.handle;
    if (!handle) {
      Alert.alert(t('stickerStore.shareUnavailable'), t('stickerStore.shareUnavailableBody'));
      return;
    }
    const url = `https://chatyy.com.br/stickers/store?install=${encodeURIComponent(handle)}`;
    const message = t('stickerStore.shareMsg') + ' ' + url;
    try {
      if (Platform.OS === 'web') {
        if (typeof navigator !== 'undefined' && navigator.share) {
          await navigator.share({ title: pack.name, text: message, url });
        } else if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(url);
          Alert.alert(t('stickerStore.linkCopied'), url);
        } else {
          Alert.alert(pack.name, url);
        }
      } else {
        await Share.share({ message, url, title: pack.name });
      }
    } catch {}
  }, [pack, t]);

  if (!visible || !pack) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}>
        <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={onClose} />
        <View style={{
          backgroundColor: colors.background, borderTopLeftRadius: 22, borderTopRightRadius: 22,
          maxHeight: '88%', minHeight: '55%',
        }}>
          <View style={{ alignItems: 'center', paddingTop: 8 }}>
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border }} />
          </View>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Sticker uri={pack.cover_url} size={52} colors={colors} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ fontSize: 17, fontWeight: '800', color: colors.text }}>{pack.name}</Text>
              <Text numberOfLines={1} style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                {[packAuthor(pack), t('stickerStore.count', { n: pack.sticker_count || items.length || 0 })].filter(Boolean).join(' · ')}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityLabel="close-pack">
              <IconX size={22} color={colors.text} />
            </TouchableOpacity>
          </View>
          {!!pack.description && (
            <Text style={{ paddingHorizontal: 16, fontSize: 13, color: colors.textSecondary }}>
              {pack.description}
            </Text>
          )}
          {!!pack.license && (
            <Text style={{ paddingHorizontal: 16, paddingTop: 4, fontSize: 11, color: colors.textTertiary || colors.textSecondary }}>
              {t('stickerStore.licenseLine', { license: pack.license })}
            </Text>
          )}

          <View style={{ flex: 1, paddingHorizontal: 10, paddingTop: 8 }}>
            {loading ? (
              <ActivityIndicator size="small" color={colors.text} style={{ marginTop: 24 }} />
            ) : items.length === 0 ? (
              <View style={{ alignItems: 'center', justifyContent: 'center', paddingVertical: 40 }}>
                <IconPackage size={36} color={colors.textSecondary} />
                <Text style={{ marginTop: 8, fontSize: 13, color: colors.textSecondary }}>
                  {t('stickerStore.emptyPack')}
                </Text>
              </View>
            ) : (
              <FlatList
                data={items}
                keyExtractor={(it, i) => String(it.id ?? i)}
                numColumns={4}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingBottom: 16 }}
                renderItem={({ item }) => (
                  <View style={{ flex: 1 / 4, aspectRatio: 1, padding: 6, alignItems: 'center', justifyContent: 'center' }}>
                    <Sticker uri={item.url || item.image_url} size={72} colors={colors} />
                  </View>
                )}
              />
            )}
          </View>

          <View style={{ padding: 16, borderTopWidth: 1, borderTopColor: colors.border, flexDirection: 'row', gap: 10 }}>
            <InstallButton big installed={installed} onPress={() => onToggle(pack)} colors={colors} t={t} />
            <TouchableOpacity
              onPress={share}
              activeOpacity={0.8}
              accessibilityLabel={t('stickerStore.share')}
              style={{
                paddingVertical: 14, paddingHorizontal: 16, borderRadius: 14,
                borderWidth: 1, borderColor: colors.border,
                alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6,
              }}
            >
              <IconShare size={16} color={colors.text} />
              <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>{t('stickerStore.share')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function CreditsView({ packs, colors, t }) {
  // Agrupa os pacotes por fonte de arte (attribution + licença + link).
  const groups = useMemo(() => {
    const m = new Map();
    for (const p of packs) {
      if (!p.license && !p.attribution) continue;
      const k = `${p.author}|${p.license}|${p.source_url}`;
      if (!m.has(k)) m.set(k, { author: p.author, license: p.license, attribution: p.attribution, source: p.source_url, packs: [] });
      m.get(k).packs.push(p.name);
    }
    return Array.from(m.values());
  }, [packs]);

  const open = (u) => { if (u) Linking.openURL(u).catch(() => {}); };

  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 4 }}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginBottom: 14 }}>
        <IconInfo size={18} color={colors.textSecondary} />
        <Text style={{ flex: 1, fontSize: 13, lineHeight: 19, color: colors.textSecondary }}>
          {t('stickerStore.creditsIntro')}
        </Text>
      </View>
      {groups.map((g) => (
        <View key={g.author + g.license} style={{
          padding: 14, marginBottom: 12, borderRadius: 16,
          borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
        }}>
          <Text style={{ fontSize: 15, fontWeight: '800', color: colors.text }}>{g.author}</Text>
          <Text style={{ fontSize: 12, fontWeight: '700', color: colors.text, marginTop: 4 }}>
            {t('stickerStore.licenseLine', { license: g.license })}
          </Text>
          {!!g.attribution && (
            <Text style={{ fontSize: 12, lineHeight: 18, color: colors.textSecondary, marginTop: 6 }}>{g.attribution}</Text>
          )}
          <Text style={{ fontSize: 12, lineHeight: 18, color: colors.textSecondary, marginTop: 6 }}>
            {t('stickerStore.creditsPacks', { packs: g.packs.join(', ') })}
          </Text>
          {!!g.source && (
            <TouchableOpacity onPress={() => open(g.source)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 }}>
              <IconLink size={14} color={colors.text} />
              <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text, textDecorationLine: 'underline' }}>
                {t('stickerStore.creditsSource')}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      ))}
      <TouchableOpacity onPress={() => open(LICENSES_URL)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8 }}>
        <IconLink size={14} color={colors.text} />
        <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text, textDecorationLine: 'underline' }}>
          {t('stickerStore.creditsFullText')}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const TABS = ['all', 'animated', 'credits'];

export default function StickerStoreScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [packs, setPacks] = useState([]);
  const [installed, setInstalled] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState('all');
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedPack, setSelectedPack] = useState(null);
  const busyRef = useRef(new Set());

  const refresh = useCallback(async () => {
    try {
      const [all, mine] = await Promise.all([
        api.stickerPackBrowse('featured'),
        api.stickerPackMy(),
      ]);
      const list = all?.items || all?.data?.items;
      if (!Array.isArray(list)) throw new Error('browse_failed');
      setPacks(list);
      setLoadError(false);
      const installedItems = mine?.items || mine?.data?.items || [];
      setInstalled(new Set(installedItems.map((p) => p.id)));
    } catch (e) {
      setLoadError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Deep link `?install=<handle>` (link compartilhado) → abre a folha do pacote.
  const installHandleSeenRef = useRef(null);
  useEffect(() => {
    const raw = params?.install;
    const handle = typeof raw === 'string' ? raw.trim() : Array.isArray(raw) ? String(raw[0] || '').trim() : '';
    if (!handle || installHandleSeenRef.current === handle) return;
    installHandleSeenRef.current = handle;
    (async () => {
      try {
        const r = await api.stickerPackGetByHandle(handle);
        const pack = r?.pack || r?.data?.pack;
        if (pack && pack.id) setSelectedPack(pack);
      } catch {}
    })();
  }, [params?.install]);

  // Busca com debounce.
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) { setSearchResults([]); setSearching(false); return undefined; }
    setSearching(true);
    const tid = setTimeout(async () => {
      try {
        const r = await api.stickerPackSearch(q);
        setSearchResults(r?.items || r?.data?.items || []);
      } catch {} finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(tid);
  }, [search]);

  const togglePack = useCallback(async (pack) => {
    if (!pack?.id || busyRef.current.has(pack.id)) return;
    busyRef.current.add(pack.id);
    const wasInstalled = installed.has(pack.id);
    // Otimista — vira na hora; reverte se o servidor falhar.
    setInstalled((prev) => { const n = new Set(prev); if (wasInstalled) n.delete(pack.id); else n.add(pack.id); return n; });
    try {
      const r = wasInstalled ? await api.stickerPackUninstall(pack.id) : await api.stickerPackInstall(pack.id);
      if (!r?.success) throw new Error('toggle_failed');
    } catch (e) {
      setInstalled((prev) => { const n = new Set(prev); if (wasInstalled) n.add(pack.id); else n.delete(pack.id); return n; });
      Alert.alert(t('stickerStore.errorTitle'), wasInstalled ? t('stickerStore.uninstallFailed') : t('stickerStore.installFailed'));
    } finally {
      busyRef.current.delete(pack.id);
    }
  }, [installed, t]);

  const searchingMode = search.trim().length >= 2;
  const visiblePacks = searchingMode
    ? searchResults
    : tab === 'animated' ? packs.filter((p) => p.animated) : packs;

  const renderPack = (p) => (
    <PackRow
      key={p.id}
      pack={p}
      installed={installed.has(p.id)}
      onPress={() => setSelectedPack(p)}
      onToggle={() => togglePack(p)}
      colors={colors}
      t={t}
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* Header */}
      <View style={{
        flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: 12, paddingVertical: 12,
        borderBottomWidth: 1, borderBottomColor: colors.border, gap: 10,
      }}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={{ flex: 1, fontSize: 17, fontWeight: '800', color: colors.text }}>
          {t('stickerStore.title')}
        </Text>
        <TouchableOpacity onPress={() => router.push('/stickers/my')} hitSlop={10}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <IconStar size={17} color={colors.text} />
          <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }}>
            {t('stickerStore.myPacks')}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Busca */}
      <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
        <View style={{
          flexDirection: 'row', alignItems: 'center',
          backgroundColor: colors.surface, borderRadius: 12, paddingHorizontal: 12,
          borderWidth: 1, borderColor: colors.border,
        }}>
          <IconSearch size={16} color={colors.textSecondary} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder={t('stickerStore.searchPlaceholder')}
            placeholderTextColor={colors.textTertiary || colors.textSecondary}
            style={{
              flex: 1, paddingVertical: 10, paddingHorizontal: 8, fontSize: 14, color: colors.text,
              ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
            }}
            autoCorrect={false}
          />
          {!!search && (
            <TouchableOpacity onPress={() => setSearch('')} hitSlop={8}>
              <IconX size={14} color={colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Abas */}
      {!searchingMode && (
        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }}>
          {TABS.map((k) => {
            const active = tab === k;
            return (
              <TouchableOpacity
                key={k}
                onPress={() => setTab(k)}
                activeOpacity={0.8}
                style={{
                  paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999,
                  backgroundColor: active ? colors.text : 'transparent',
                  borderWidth: 1, borderColor: active ? colors.text : colors.border,
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: '700', color: active ? colors.background : colors.text }}>
                  {t(k === 'all' ? 'stickerStore.tabAll' : k === 'animated' ? 'stickerStore.tabAnimated' : 'stickerStore.tabCredits')}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {loading ? (
        <ActivityIndicator size="large" color={colors.text} style={{ marginTop: 36 }} />
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); refresh(); }} tintColor={colors.text} />}
          contentContainerStyle={{ paddingTop: 10, paddingBottom: 32 }}
        >
          {searchingMode ? (
            searching ? (
              <ActivityIndicator size="small" color={colors.text} style={{ marginTop: 16 }} />
            ) : visiblePacks.length === 0 ? (
              <Text style={{ paddingHorizontal: 16, fontSize: 13, color: colors.textSecondary }}>
                {t('stickerStore.noResults')}
              </Text>
            ) : visiblePacks.map(renderPack)
          ) : tab === 'credits' ? (
            <CreditsView packs={packs} colors={colors} t={t} />
          ) : loadError && packs.length === 0 ? (
            <View style={{ alignItems: 'center', paddingTop: 40, paddingHorizontal: 24 }}>
              <Text style={{ fontSize: 14, color: colors.textSecondary, textAlign: 'center' }}>
                {t('stickerStore.loadError')}
              </Text>
              <TouchableOpacity
                onPress={() => { setLoading(true); refresh(); }}
                style={{ marginTop: 14, paddingHorizontal: 18, paddingVertical: 9, borderRadius: 999, borderWidth: 1, borderColor: colors.text }}
              >
                <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text }}>{t('stickerStore.retry')}</Text>
              </TouchableOpacity>
            </View>
          ) : visiblePacks.length === 0 ? (
            <Text style={{ paddingHorizontal: 16, paddingTop: 20, fontSize: 13, color: colors.textSecondary, textAlign: 'center' }}>
              {t('stickerStore.empty')}
            </Text>
          ) : visiblePacks.map(renderPack)}
        </ScrollView>
      )}

      <PackDetailModal
        pack={selectedPack}
        visible={!!selectedPack}
        onClose={() => setSelectedPack(null)}
        installed={selectedPack ? installed.has(selectedPack.id) : false}
        onToggle={togglePack}
        colors={colors}
        t={t}
      />
    </View>
  );
}
