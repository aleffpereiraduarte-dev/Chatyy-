// Telegram Premium-style sticker store hub.
//
// Layout:
//   - Featured pack auto-scroll carousel (top)
//   - Sections: Trending, New, Animated, Animated Premium
//   - Pack card: cover + name + author + install_count + Install/Installed CTA
//   - Tap pack → modal showing all stickers in the pack + Install CTA
//
// Backend actions:
//   sticker_pack_browse({filter}), sticker_pack_install/uninstall, sticker_pack_my,
//   sticker_pack_search.
//
// We re-use the existing chat-pack item endpoint (chat_sticker_pack_stickers)
// for the detail-modal sticker grid since both surfaces share the same items
// shape (sticker_pack_items lives next to chat_stickers, but the new schema's
// pack id space is distinct — we probe both).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, FlatList, Image, ActivityIndicator,
  Animated, Dimensions, Platform, Modal, TextInput, RefreshControl, Alert, Share,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import * as api from '../../services/api';
import { IconArrowLeft, IconSearch, IconX, IconCheck, IconPlus, IconStar, IconSparkles } from '../../components/Icons';
import CachedImage from '../../components/CachedImage';

const SCREEN_W = Dimensions.get('window').width;
const FEATURED_W = Math.min(SCREEN_W - 32, 360);
const FEATURED_H = Math.round(FEATURED_W * 0.55);

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
  // R2 key — assume CDN
  return `https://media.chatyy.com.br/${url.replace(/^\/+/, '')}`;
}

function PackCard({ pack, installedSet, onInstall, onUninstall, onPress, colors, t }) {
  const installed = installedSet.has(pack.id);
  const cover = resolveCoverUri(pack.cover_url);
  const scale = useRef(new Animated.Value(1)).current;

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <TouchableOpacity
        onPress={onPress}
        onPressIn={() => Animated.spring(scale, { toValue: 0.97, useNativeDriver: true, tension: 400, friction: 12 }).start()}
        onPressOut={() => Animated.spring(scale, { toValue: 1, useNativeDriver: true, tension: 200, friction: 8 }).start()}
        activeOpacity={0.9}
        style={{
          width: 156, marginRight: 10,
          backgroundColor: colors.surface, borderRadius: 16,
          borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
        }}
      >
        <View style={{
          width: '100%', height: 110, backgroundColor: colors.surfaceVariant || colors.background,
          alignItems: 'center', justifyContent: 'center',
        }}>
          {cover ? (
            <Image source={{ uri: cover }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
          ) : (
            <Text style={{ fontSize: 44 }}>{pack.animated ? '🎬' : '📦'}</Text>
          )}
          {pack.premium && (
            <View style={{
              position: 'absolute', top: 6, left: 6,
              backgroundColor: 'rgba(124,58,237,0.92)', paddingHorizontal: 6, paddingVertical: 2,
              borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 3,
            }}>
              <IconStar size={10} color="#fff" />
              <Text style={{ color: '#fff', fontSize: 9, fontWeight: '800', letterSpacing: 0.4 }}>PRO</Text>
            </View>
          )}
          {pack.animated && (
            <View style={{
              position: 'absolute', top: 6, right: 6,
              backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 6, paddingVertical: 2,
              borderRadius: 8,
            }}>
              <Text style={{ color: '#fff', fontSize: 9, fontWeight: '700' }}>GIF</Text>
            </View>
          )}
        </View>
        <View style={{ padding: 10 }}>
          <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: '700', color: colors.text }}>
            {pack.name}
          </Text>
          <Text numberOfLines={1} style={{ fontSize: 11, color: colors.textSecondary, marginTop: 2 }}>
            {pack.author_email?.split('@')?.[0] || '—'} · {pack.install_count || 0}
          </Text>
          <TouchableOpacity
            onPress={installed ? onUninstall : onInstall}
            activeOpacity={0.7}
            style={{
              marginTop: 8, paddingVertical: 7, borderRadius: 10,
              backgroundColor: installed ? (colors.surfaceVariant || colors.background) : colors.primary,
              borderWidth: installed ? 1 : 0, borderColor: colors.border,
              alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 4,
            }}
          >
            {installed
              ? <IconCheck size={12} color={colors.text} />
              : <IconPlus size={12} color="#fff" />}
            <Text style={{
              fontSize: 12, fontWeight: '700',
              color: installed ? colors.text : '#fff',
            }}>
              {installed ? (t?.('chat.installed') || 'Instalado') : (t?.('chat.install') || 'Instalar')}
            </Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

function FeaturedCarousel({ packs, colors, onPressPack, t }) {
  const scrollRef = useRef(null);
  const idxRef = useRef(0);
  const [activeIdx, setActiveIdx] = useState(0);

  // Auto-scroll every 4s. Pause when component unmounts.
  useEffect(() => {
    if (!packs?.length) return undefined;
    const id = setInterval(() => {
      idxRef.current = (idxRef.current + 1) % packs.length;
      setActiveIdx(idxRef.current);
      scrollRef.current?.scrollTo({ x: idxRef.current * (FEATURED_W + 12), animated: true });
    }, 4000);
    return () => clearInterval(id);
  }, [packs?.length]);

  if (!packs?.length) return null;

  return (
    <View style={{ marginTop: 12 }}>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={FEATURED_W + 12}
        decelerationRate="fast"
        contentContainerStyle={{ paddingHorizontal: 16 }}
        onMomentumScrollEnd={(e) => {
          const x = e.nativeEvent.contentOffset.x;
          idxRef.current = Math.round(x / (FEATURED_W + 12));
          setActiveIdx(idxRef.current);
        }}
      >
        {packs.map((pack) => {
          const cover = resolveCoverUri(pack.cover_url);
          return (
            <TouchableOpacity
              key={pack.id}
              activeOpacity={0.92}
              onPress={() => onPressPack(pack)}
              style={{
                width: FEATURED_W, height: FEATURED_H, marginRight: 12,
                borderRadius: 18, overflow: 'hidden',
                backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
              }}
            >
              {cover && (
                <Image source={{ uri: cover }} style={{ width: '100%', height: '100%', position: 'absolute' }} resizeMode="cover" />
              )}
              <View style={{
                position: 'absolute', bottom: 0, left: 0, right: 0,
                paddingHorizontal: 14, paddingVertical: 12,
                backgroundColor: 'rgba(0,0,0,0.55)',
              }}>
                <Text numberOfLines={1} style={{ color: '#fff', fontSize: 16, fontWeight: '800' }}>
                  {pack.name}
                </Text>
                <Text numberOfLines={1} style={{ color: 'rgba(255,255,255,0.85)', fontSize: 11, marginTop: 2 }}>
                  {pack.install_count || 0} {t?.('chat.installs') || 'instalados'}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      {/* Dot indicator */}
      <View style={{ flexDirection: 'row', justifyContent: 'center', marginTop: 8, gap: 5 }}>
        {packs.map((_, i) => (
          <View
            key={i}
            style={{
              width: i === activeIdx ? 16 : 6, height: 6, borderRadius: 3,
              backgroundColor: i === activeIdx ? colors.primary : colors.border,
            }}
          />
        ))}
      </View>
    </View>
  );
}

function PackDetailModal({ pack, visible, onClose, installedSet, onInstall, onUninstall, colors, t }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const installed = pack ? installedSet.has(pack.id) : false;

  useEffect(() => {
    if (!visible || !pack) return;
    setLoading(true);
    setItems([]);
    // Reuse the existing chat_sticker_pack_stickers endpoint — pack ids in the
    // new sticker_packs table won't necessarily collide with chat_sticker_packs.
    // The endpoint returns [] for unknown packs which is the desired no-op.
    api.chatStickerPackStickers(pack.id).then((r) => {
      const arr = r?.items || r?.data?.items || r?.stickers || [];
      setItems(Array.isArray(arr) ? arr : []);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [visible, pack?.id]);

  if (!visible || !pack) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20,
          maxHeight: '85%',
        }}>
          {/* Header */}
          <View style={{
            paddingHorizontal: 16, paddingVertical: 14,
            flexDirection: 'row', alignItems: 'center', gap: 12,
            borderBottomWidth: 1, borderBottomColor: colors.border,
          }}>
            <View style={{
              width: 56, height: 56, borderRadius: 12, overflow: 'hidden',
              backgroundColor: colors.surfaceVariant || colors.surface,
              alignItems: 'center', justifyContent: 'center',
            }}>
              {pack.cover_url ? (
                <Image source={{ uri: resolveCoverUri(pack.cover_url) }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
              ) : (
                <Text style={{ fontSize: 28 }}>{pack.animated ? '🎬' : '📦'}</Text>
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '800', color: colors.text }}>{pack.name}</Text>
              <Text numberOfLines={1} style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                {pack.author_email?.split('@')?.[0] || '—'} · {pack.install_count || 0} {t?.('chat.installs') || 'instalados'}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <IconX size={22} color={colors.text} />
            </TouchableOpacity>
          </View>

          {/* Description */}
          {!!pack.description && (
            <Text style={{ paddingHorizontal: 16, paddingTop: 10, fontSize: 13, color: colors.textSecondary }}>
              {pack.description}
            </Text>
          )}

          {/* Sticker grid */}
          <View style={{ flex: 1, padding: 12 }}>
            {loading ? (
              <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: 24 }} />
            ) : items.length === 0 ? (
              <View style={{ alignItems: 'center', justifyContent: 'center', paddingVertical: 40 }}>
                <Text style={{ fontSize: 36 }}>📦</Text>
                <Text style={{ marginTop: 8, fontSize: 13, color: colors.textTertiary }}>
                  {t?.('chat.emptyPack') || 'Pacote vazio'}
                </Text>
              </View>
            ) : (
              <FlatList
                data={items}
                keyExtractor={(it, i) => String(it.id ?? it.sticker_id ?? i)}
                numColumns={4}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingBottom: 20 }}
                renderItem={({ item }) => {
                  const uri = resolveCoverUri(item.url || item.image_url || item.sticker_id);
                  return (
                    <View style={{
                      flex: 1 / 4, aspectRatio: 1, padding: 4,
                      alignItems: 'center', justifyContent: 'center',
                    }}>
                      {uri ? (
                        <CachedImage source={{ uri }} style={{ width: '90%', height: '90%' }} resizeMode="contain" />
                      ) : (
                        <Text style={{ fontSize: 28 }}>{item.emoji || item.emoji_alt || '🖼️'}</Text>
                      )}
                    </View>
                  );
                }}
              />
            )}
          </View>

          {/* CTA */}
          <View style={{ padding: 16, borderTopWidth: 1, borderTopColor: colors.border, flexDirection: 'row', gap: 10 }}>
            <TouchableOpacity
              onPress={() => (installed ? onUninstall(pack) : onInstall(pack))}
              activeOpacity={0.85}
              style={{
                flex: 1,
                paddingVertical: 14, borderRadius: 14,
                backgroundColor: installed ? (colors.surfaceVariant || colors.background) : colors.primary,
                borderWidth: installed ? 1 : 0, borderColor: colors.border,
                alignItems: 'center',
              }}
            >
              <Text style={{
                fontSize: 15, fontWeight: '800',
                color: installed ? colors.text : '#fff',
              }}>
                {installed
                  ? (t?.('chat.uninstallPack') || 'Remover pacote')
                  : (t?.('chat.installPack') || 'Adicionar pacote')}
              </Text>
            </TouchableOpacity>
            {/* Share button — only meaningful if the pack has a handle, which
                is true for all newly minted packs (sticker_pack_create assigns
                one). Older / legacy packs without a handle still render the
                button but it short-circuits with a polite warning. */}
            <TouchableOpacity
              onPress={async () => {
                const handle = pack.handle;
                if (!handle) {
                  Alert.alert(t?.('chat.shareUnavailable') || 'Não dá pra compartilhar', t?.('chat.shareUnavailableBody') || 'Esse pacote não tem link público.');
                  return;
                }
                const url = `https://chatyy.com.br/stickers/store?install=${encodeURIComponent(handle)}`;
                const message = (t?.('chat.shareMsg') || 'Confira esse pacote no Chatyy:') + ' ' + url;
                try {
                  if (Platform.OS === 'web') {
                    if (navigator.share) {
                      await navigator.share({ title: pack.name, text: message, url });
                    } else if (navigator.clipboard?.writeText) {
                      await navigator.clipboard.writeText(url);
                      Alert.alert(t?.('chat.linkCopied') || 'Link copiado', url);
                    } else {
                      Alert.alert(pack.name, url);
                    }
                  } else {
                    await Share.share({ message, url, title: pack.name });
                  }
                } catch {}
              }}
              activeOpacity={0.85}
              style={{
                paddingVertical: 14, paddingHorizontal: 18, borderRadius: 14,
                backgroundColor: colors.surfaceVariant || colors.background,
                borderWidth: 1, borderColor: colors.border,
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>
                {t?.('common.share') || 'Compartilhar'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export default function StickerStoreScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [trending, setTrending] = useState([]);
  const [fresh, setFresh] = useState([]);
  const [animated, setAnimated] = useState([]);
  const [premium, setPremium] = useState([]);
  const [featured, setFeatured] = useState([]);
  const [installed, setInstalled] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedPack, setSelectedPack] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [t1, t2, t3, t4, t5, mine] = await Promise.all([
        api.stickerPackBrowse('trending'),
        api.stickerPackBrowse('new'),
        api.stickerPackBrowse('animated'),
        api.stickerPackBrowse('premium'),
        api.stickerPackBrowse('featured'),
        api.stickerPackMy(),
      ]);
      setTrending(t1?.items || t1?.data?.items || []);
      setFresh(t2?.items || t2?.data?.items || []);
      setAnimated(t3?.items || t3?.data?.items || []);
      setPremium(t4?.items || t4?.data?.items || []);
      // Featured = top 5 by install_count over 30d.
      const f = (t5?.items || t5?.data?.items || []).slice(0, 5);
      setFeatured(f);
      const installedItems = mine?.items || mine?.data?.items || [];
      setInstalled(new Set(installedItems.map((p) => p.id)));
    } catch (e) {
      // soft fail — empty sections.
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Deep-link install: if the screen is opened with `?install=<handle>` (from
  // a share link), resolve the handle → pack row → auto-open the install
  // modal. Runs once per mount; subsequent param changes (rare) re-trigger.
  const installHandleSeenRef = useRef(null);
  useEffect(() => {
    const raw = params?.install;
    const handle = typeof raw === 'string' ? raw.trim() : Array.isArray(raw) ? String(raw[0] || '').trim() : '';
    if (!handle) return;
    if (installHandleSeenRef.current === handle) return;
    installHandleSeenRef.current = handle;
    (async () => {
      try {
        const r = await api.stickerPackGetByHandle(handle);
        const pack = r?.pack || r?.data?.pack;
        if (pack && pack.id) {
          setSelectedPack(pack);
        }
      } catch {
        // Soft-fail: user just lands on the store with no modal.
      }
    })();
  }, [params?.install]);

  // Debounced search.
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) { setSearchResults([]); return undefined; }
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

  const installPack = useCallback(async (pack) => {
    // Optimistic — flip locally, then persist. On failure, revert.
    setInstalled((prev) => { const n = new Set(prev); n.add(pack.id); return n; });
    try {
      const r = await api.stickerPackInstall(pack.id);
      if (!r?.success) throw new Error(r?.error || r?.message || 'install_failed');
    } catch (e) {
      setInstalled((prev) => { const n = new Set(prev); n.delete(pack.id); return n; });
      Alert.alert(t?.('common.error') || 'Erro', e?.message || 'Falha ao instalar pacote.');
    }
  }, [t]);

  const uninstallPack = useCallback(async (pack) => {
    setInstalled((prev) => { const n = new Set(prev); n.delete(pack.id); return n; });
    try {
      const r = await api.stickerPackUninstall(pack.id);
      if (!r?.success) throw new Error(r?.error || r?.message || 'uninstall_failed');
    } catch (e) {
      setInstalled((prev) => { const n = new Set(prev); n.add(pack.id); return n; });
      Alert.alert(t?.('common.error') || 'Erro', e?.message || 'Falha ao remover pacote.');
    }
  }, [t]);

  const renderRow = (title, packs) => {
    if (!packs?.length) return null;
    return (
      <View style={{ marginTop: 18 }}>
        <Text style={{
          paddingHorizontal: 16, fontSize: 14, fontWeight: '800',
          color: colors.text, marginBottom: 10, letterSpacing: 0.3,
        }}>
          {title}
        </Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 4 }}>
          {packs.map((p) => (
            <PackCard
              key={p.id}
              pack={p}
              installedSet={installed}
              onPress={() => setSelectedPack(p)}
              onInstall={() => installPack(p)}
              onUninstall={() => uninstallPack(p)}
              colors={colors}
              t={t}
            />
          ))}
        </ScrollView>
      </View>
    );
  };

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
          {t?.('chat.stickerStore') || 'Loja de figurinhas'}
        </Text>
        <TouchableOpacity onPress={() => router.push('/stickers/my')} hitSlop={10}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <IconStar size={18} color={colors.primary} />
          <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '700' }}>
            {t?.('chat.myPacks') || 'Meus packs'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Search */}
      <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
        <View style={{
          flexDirection: 'row', alignItems: 'center',
          backgroundColor: colors.surface, borderRadius: 12, paddingHorizontal: 12,
          borderWidth: 1, borderColor: colors.border,
        }}>
          <IconSearch size={16} color={colors.textTertiary} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder={t?.('chat.searchPacks') || 'Buscar pacotes…'}
            placeholderTextColor={colors.textTertiary}
            style={{
              flex: 1, paddingVertical: 10, paddingHorizontal: 8, fontSize: 14, color: colors.text,
              ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
            }}
            autoCorrect={false}
          />
          {!!search && (
            <TouchableOpacity onPress={() => setSearch('')} hitSlop={8}>
              <IconX size={14} color={colors.textTertiary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {loading ? (
        <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: 36 }} />
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); refresh(); }} tintColor={colors.primary} />}
          contentContainerStyle={{ paddingBottom: 32 }}
        >
          {search.trim().length >= 2 ? (
            <View style={{ marginTop: 12 }}>
              <Text style={{
                paddingHorizontal: 16, fontSize: 14, fontWeight: '800',
                color: colors.text, marginBottom: 10,
              }}>
                {t?.('chat.searchResults') || 'Resultados'}
              </Text>
              {searching ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : searchResults.length === 0 ? (
                <Text style={{ paddingHorizontal: 16, fontSize: 13, color: colors.textTertiary }}>
                  {t?.('chat.noPacksFound') || 'Nenhum pacote encontrado.'}
                </Text>
              ) : (
                <ScrollView horizontal showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 4 }}>
                  {searchResults.map((p) => (
                    <PackCard
                      key={p.id}
                      pack={p}
                      installedSet={installed}
                      onPress={() => setSelectedPack(p)}
                      onInstall={() => installPack(p)}
                      onUninstall={() => uninstallPack(p)}
                      colors={colors}
                      t={t}
                    />
                  ))}
                </ScrollView>
              )}
            </View>
          ) : (
            <>
              <FeaturedCarousel packs={featured} colors={colors} onPressPack={(p) => setSelectedPack(p)} t={t} />
              {renderRow(t?.('chat.trending') || 'Em alta', trending)}
              {renderRow(t?.('chat.newPacks') || 'Novos', fresh)}
              {renderRow(t?.('chat.animatedPacks') || 'Animados', animated)}
              {renderRow(t?.('chat.animatedPremium') || 'Animados Premium', premium)}
            </>
          )}
        </ScrollView>
      )}

      <PackDetailModal
        pack={selectedPack}
        visible={!!selectedPack}
        onClose={() => setSelectedPack(null)}
        installedSet={installed}
        onInstall={installPack}
        onUninstall={uninstallPack}
        colors={colors}
        t={t}
      />
    </View>
  );
}
