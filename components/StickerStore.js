import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, ScrollView, Modal, Image,
  TextInput, ActivityIndicator, Alert, Animated, Platform, Dimensions,
  KeyboardAvoidingView, RefreshControl,
} from 'react-native';
import {
  IconX, IconSearch, IconPlus, IconTrash, IconStar, IconHeart,
  IconCheck, IconArrowLeft, IconSparkles, IconUser,
} from './Icons';
import * as api from '../services/api';
// [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag
import { PREMIUM_BADGES_VISIBLE } from '../constants/featureFlags';

// ─── Constants ────────────────────────────────────────────────────────────────

const SCREEN_W = Dimensions.get('window').width;
const PACK_CARD_W = (SCREEN_W - 48) / 2; // 2-column grid with 16px margins
const STICKER_CELL = Math.floor((SCREEN_W - 32) / 5); // 5-column sticker grid

// ─── API helpers ──────────────────────────────────────────────────────────────
// All sticker store actions route through chat.php via apiCall.

async function stickerApiCall(action, params = {}) {
  return api.apiCall(action, params, 'POST');
}

async function fetchStorePacks(search = '', category = '', offset = 0) {
  return stickerApiCall('sticker_store_list', { search, category, offset, limit: 20 });
}

async function fetchPackDetail(packId) {
  return stickerApiCall('sticker_pack_detail', { pack_id: packId });
}

async function fetchInstalledPacks() {
  return stickerApiCall('sticker_my_packs', {});
}

async function installPack(packId) {
  return stickerApiCall('sticker_install', { pack_id: packId });
}

async function uninstallPack(packId) {
  return stickerApiCall('sticker_uninstall', { pack_id: packId });
}

async function fetchFeatured() {
  return stickerApiCall('sticker_featured', {});
}

async function createCustomPack(name, coverUrl, stickerUrls) {
  return stickerApiCall('sticker_create_pack', { name, cover_url: coverUrl, sticker_urls: stickerUrls });
}

// ─── Pack Card ────────────────────────────────────────────────────────────────

function PackCard({ pack, onPress, onInstall, onUninstall, installed, installing, colors }) {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = () =>
    Animated.spring(scaleAnim, { toValue: 0.96, useNativeDriver: true, tension: 400, friction: 12 }).start();
  const handlePressOut = () =>
    Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, tension: 180, friction: 8 }).start();

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }], width: PACK_CARD_W, margin: 8 }}>
      <TouchableOpacity
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        activeOpacity={0.9}
        style={{
          backgroundColor: colors.surface,
          borderRadius: 16,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: colors.border,
          shadowColor: '#000',
          shadowOpacity: 0.06,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 2 },
          elevation: 2,
        }}
      >
        {/* Cover — 80×80 grid of 4 preview stickers (WhatsApp/Telegram-style) */}
        <View style={{
          width: '100%', aspectRatio: 1,
          backgroundColor: colors.surfaceVariant,
          alignItems: 'center', justifyContent: 'center',
          padding: 10,
        }}>
          {(() => {
            const previews = (pack.preview_stickers || pack.previews || []).slice(0, 4);
            // Pad to 4 with placeholders so the grid always renders 2×2
            while (previews.length < 4) previews.push(null);
            const cellSize = (PACK_CARD_W - 40) / 2; // 2 cols, 4px gap
            return (
              <View style={{
                width: '100%', height: '100%',
                flexDirection: 'row', flexWrap: 'wrap',
                justifyContent: 'center', alignItems: 'center',
                gap: 4,
              }}>
                {previews.map((sticker, idx) => {
                  const url = typeof sticker === 'string' && /^https?:\/\//.test(sticker)
                    ? sticker
                    : sticker?.url || null;
                  const emoji = sticker?.emoji_tag || (!url && typeof sticker === 'string' ? sticker : null);
                  return (
                    <View
                      key={`prev-${idx}`}
                      style={{
                        width: cellSize, height: cellSize,
                        borderRadius: 10,
                        backgroundColor: colors.background,
                        alignItems: 'center', justifyContent: 'center',
                        overflow: 'hidden',
                      }}
                    >
                      {url ? (
                        <Image
                          source={{ uri: url }}
                          style={{ width: '85%', height: '85%' }}
                          resizeMode="contain"
                        />
                      ) : emoji ? (
                        <Text style={{ fontSize: cellSize * 0.55 }}>{emoji}</Text>
                      ) : pack.cover_url && idx === 0 ? (
                        <Image
                          source={{ uri: pack.cover_url }}
                          style={{ width: '85%', height: '85%' }}
                          resizeMode="contain"
                        />
                      ) : (
                        <Text style={{ fontSize: cellSize * 0.5, opacity: 0.3 }}>
                          {pack.cover_emoji || '📦'}
                        </Text>
                      )}
                    </View>
                  );
                })}
              </View>
            );
          })()}
          {/* [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag —
              "PRO" badge on premium packs would advertise paid plans. */}
          {PREMIUM_BADGES_VISIBLE && pack.is_premium && (
            <View style={{
              position: 'absolute', top: 8, right: 8,
              backgroundColor: '#F59E0B',
              borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2,
            }}>
              <Text style={{ fontSize: 10, fontWeight: '800', color: '#fff' }}>PRO</Text>
            </View>
          )}
          {installed && (
            <View style={{
              position: 'absolute', top: 8, left: 8,
              backgroundColor: '#7C3AED',
              borderRadius: 10, width: 20, height: 20,
              alignItems: 'center', justifyContent: 'center',
            }}>
              <IconCheck size={12} color="#fff" />
            </View>
          )}
        </View>

        {/* Info */}
        <View style={{ padding: 10 }}>
          <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: '700', color: colors.text }}>
            {pack.name}
          </Text>
          <Text numberOfLines={1} style={{ fontSize: 11, color: colors.textTertiary, marginTop: 1 }}>
            {pack.author || 'Chatyy'} · {pack.sticker_count || 0} fig.
          </Text>

          {/* Pill: "Adicionar" primary filled OR "Instalado" outline */}
          <TouchableOpacity
            onPress={installed ? onUninstall : onInstall}
            disabled={installing}
            style={{
              marginTop: 8, borderRadius: 999, paddingVertical: 7, paddingHorizontal: 12,
              backgroundColor: installed ? 'transparent' : '#7C3AED',
              borderWidth: installed ? 1.5 : 0,
              borderColor: installed ? '#7C3AED' : 'transparent',
              alignItems: 'center', justifyContent: 'center',
              flexDirection: 'row', gap: 4,
            }}
            activeOpacity={0.75}
          >
            {installing ? (
              <ActivityIndicator size={12} color={installed ? '#7C3AED' : '#fff'} />
            ) : installed ? (
              <>
                <IconCheck size={12} color="#7C3AED" />
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#7C3AED' }}>
                  Instalado
                </Text>
              </>
            ) : (
              <>
                <IconPlus size={12} color="#fff" />
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#fff' }}>
                  Adicionar
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Pack Detail Modal ────────────────────────────────────────────────────────

function PackDetailModal({ pack, colors, onClose, onInstall, onUninstall, installedIds, t }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const slideAnim = useRef(new Animated.Value(400)).current;

  const isInstalled = installedIds.has(pack?.id);

  useEffect(() => {
    if (!pack) return;
    Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, tension: 300, friction: 30 }).start();
    fetchPackDetail(pack.id)
      .then(r => setDetail(r?.success ? r : { stickers: [] }))
      .catch(() => setDetail({ stickers: [] }))
      .finally(() => setLoading(false));
  }, [pack]);

  const handleInstall = async () => {
    if (installing) return;
    setInstalling(true);
    try {
      await onInstall(pack.id);
    } finally {
      setInstalling(false);
    }
  };

  const handleUninstall = async () => {
    if (installing) return;
    setInstalling(true);
    try {
      await onUninstall(pack.id);
    } finally {
      setInstalling(false);
    }
  };

  const stickers = detail?.stickers || pack?.preview_stickers || [];

  return (
    <Animated.View
      style={{
        flex: 1,
        backgroundColor: colors.background,
        transform: [{ translateY: slideAnim }],
      }}
    >
      {/* Header */}
      <View style={{
        flexDirection: 'row', alignItems: 'center', padding: 16,
        borderBottomWidth: 1, borderBottomColor: colors.border,
        backgroundColor: colors.surface,
      }}>
        <TouchableOpacity onPress={onClose} style={{ padding: 4, marginRight: 8 }} hitSlop={8}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={{ flex: 1, fontSize: 17, fontWeight: '700', color: colors.text }}>
          {pack?.name}
        </Text>
        <TouchableOpacity
          onPress={isInstalled ? handleUninstall : handleInstall}
          disabled={installing}
          style={{
            borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8,
            backgroundColor: isInstalled ? (colors.error + '15') : colors.primary,
            flexDirection: 'row', alignItems: 'center', gap: 6,
          }}
          activeOpacity={0.8}
        >
          {installing ? (
            <ActivityIndicator size={14} color={isInstalled ? colors.error : '#fff'} />
          ) : isInstalled ? (
            <>
              <IconTrash size={14} color={colors.error || '#dc2626'} />
              <Text style={{ fontSize: 13, fontWeight: '700', color: colors.error || '#dc2626' }}>
                Remover
              </Text>
            </>
          ) : (
            <>
              <IconPlus size={14} color="#fff" />
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>
                Adicionar
              </Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {/* Pack meta */}
      <View style={{
        padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14,
        backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border,
      }}>
        <View style={{
          width: 72, height: 72, borderRadius: 14, overflow: 'hidden',
          backgroundColor: colors.surfaceVariant, alignItems: 'center', justifyContent: 'center',
        }}>
          {pack?.cover_url ? (
            <CachedImage source={{ uri: pack.cover_url }} style={{ width: 72, height: 72 }} resizeMode="cover" />
          ) : (
            <Text style={{ fontSize: 40 }}>{pack?.cover_emoji || '📦'}</Text>
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text }}>{pack?.name}</Text>
          <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>
            por {pack?.author || 'Chatyy'}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 6 }}>
            <Text style={{ fontSize: 12, color: colors.textTertiary }}>
              {pack?.sticker_count || stickers.length} figurinhas
            </Text>
            {pack?.category && (
              <View style={{
                backgroundColor: colors.primary + '15', borderRadius: 8,
                paddingHorizontal: 8, paddingVertical: 2,
              }}>
                <Text style={{ fontSize: 11, color: colors.primary, fontWeight: '600' }}>
                  {pack.category}
                </Text>
              </View>
            )}
          </View>
        </View>
      </View>

      {/* Stickers grid */}
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : stickers.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
          <Text style={{ fontSize: 40, marginBottom: 12 }}>📦</Text>
          <Text style={{ color: colors.textTertiary, fontSize: 15, textAlign: 'center' }}>
            Nenhuma figurinha encontrada neste pacote.
          </Text>
        </View>
      ) : (
        <FlatList
          data={stickers}
          numColumns={5}
          keyExtractor={(item, i) => `sticker-${i}-${item?.url || item?.emoji_tag || i}`}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: 8 }}
          renderItem={({ item }) => {
            const isUrl = typeof item === 'string' && /^https?:\/\//.test(item);
            const url = item?.url || (isUrl ? item : null);
            const emoji = item?.emoji_tag || (!url ? item : null);
            return (
              <View style={{
                width: STICKER_CELL, height: STICKER_CELL,
                alignItems: 'center', justifyContent: 'center', padding: 4,
              }}>
                {url ? (
                  <Image
                    source={{ uri: url }}
                    style={{ width: STICKER_CELL - 12, height: STICKER_CELL - 12, borderRadius: 8 }}
                    resizeMode="contain"
                  />
                ) : (
                  <Text style={{ fontSize: 34 }}>{emoji}</Text>
                )}
              </View>
            );
          }}
        />
      )}
    </Animated.View>
  );
}

// ─── My Packs Tab ─────────────────────────────────────────────────────────────

function MyPacksTab({ colors, installedPacks, onUninstall, onPackPress, uninstallingId, t }) {
  if (installedPacks.length === 0) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 }}>
        <Text style={{ fontSize: 52, marginBottom: 14 }}>🎁</Text>
        <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text, marginBottom: 6 }}>
          Nenhum pacote instalado
        </Text>
        <Text style={{ fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 }}>
          Explore a loja e adicione seus pacotes favoritos de figurinhas!
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      data={installedPacks}
      keyExtractor={item => String(item.id)}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ padding: 16, gap: 8 }}
      renderItem={({ item }) => (
        <TouchableOpacity
          onPress={() => onPackPress(item)}
          activeOpacity={0.8}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 14,
            backgroundColor: colors.surface,
            borderRadius: 14, padding: 12,
            borderWidth: 1, borderColor: colors.border,
          }}
        >
          {/* Cover */}
          <View style={{
            width: 58, height: 58, borderRadius: 12, overflow: 'hidden',
            backgroundColor: colors.surfaceVariant, alignItems: 'center', justifyContent: 'center',
          }}>
            {item.cover_url ? (
              <CachedImage source={{ uri: item.cover_url }} style={{ width: 58, height: 58 }} resizeMode="cover" />
            ) : (
              <Text style={{ fontSize: 32 }}>{item.cover_emoji || '📦'}</Text>
            )}
          </View>

          {/* Info */}
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>{item.name}</Text>
            <Text style={{ fontSize: 12, color: colors.textTertiary, marginTop: 2 }}>
              {item.author || 'Chatyy'} · {item.sticker_count || '?'} figurinhas
            </Text>
            {item.installed_at && (
              <Text style={{ fontSize: 11, color: colors.textTertiary, marginTop: 2 }}>
                Instalado em {(_d => isNaN(_d.getTime()) ? '' : _d.toLocaleDateString())(new Date(item.installed_at))}
              </Text>
            )}
          </View>

          {/* Remove button */}
          <TouchableOpacity
            onPress={() => onUninstall(item.id)}
            disabled={uninstallingId === item.id}
            style={{
              padding: 8, borderRadius: 10,
              backgroundColor: colors.error + '15',
            }}
            hitSlop={4}
          >
            {uninstallingId === item.id ? (
              <ActivityIndicator size={16} color={colors.error || '#dc2626'} />
            ) : (
              <IconTrash size={16} color={colors.error || '#dc2626'} />
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      )}
    />
  );
}

// ─── Create Pack Modal ────────────────────────────────────────────────────────

function CreatePackModal({ colors, onClose, onCreated, t }) {
  const [step, setStep] = useState(1); // 1=name, 2=upload stickers, 3=done
  const [packName, setPackName] = useState('');
  const [coverUri, setCoverUri] = useState(null);
  const [coverUrl, setCoverUrl] = useState(null);
  const [stickers, setStickers] = useState([]); // array of { uri, url }
  const [uploading, setUploading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }).start();
  }, []);

  const pickImage = useCallback(async (purpose) => {
    try {
      if (Platform.OS === 'web') {
        const file = await new Promise((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'image/png,image/jpeg,image/webp,image/gif';
          input.onchange = (e) => {
            const f = e.target.files?.[0];
            if (!f) { resolve(null); return; }
            resolve({ uri: URL.createObjectURL(f), blob: f, name: f.name, type: f.type });
          };
          input.click();
        });
        return file;
      }
      const ImagePicker = require('expo-image-picker');
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return null;
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.85,
        allowsEditing: purpose === 'cover',
        aspect: purpose === 'cover' ? [1, 1] : undefined,
      });
      if (result.canceled || !result.assets?.[0]) return null;
      const a = result.assets[0];
      return { uri: a.uri, name: a.fileName || `img_${Date.now()}.jpg`, type: a.mimeType || 'image/jpeg' };
    } catch { return null; }
  }, []);

  const uploadFile = useCallback(async (file) => {
    const r = await api.rustUpload(file, '', 'sticker');
    if (r?.success && r.cdn_url) return r.cdn_url;
    throw new Error('Upload falhou');
  }, []);

  const handlePickCover = useCallback(async () => {
    const file = await pickImage('cover');
    if (!file) return;
    setCoverUri(file.uri);
    setUploading(true);
    try {
      const url = await uploadFile(file);
      setCoverUrl(url);
    } catch {
      Alert.alert('Erro', 'Falha ao enviar a capa.');
      setCoverUri(null);
    } finally {
      setUploading(false);
    }
  }, [pickImage, uploadFile]);

  // removeBg: after uploading, send the cdn_url to sticker_bg_remove — server
  // runs rembg (U²-Net), returns a new URL with alpha transparency. Falls
  // back to the original on failure.
  const handleAddSticker = useCallback(async (opts = {}) => {
    if (stickers.length >= 30) {
      Alert.alert('Limite atingido', 'Máximo de 30 figurinhas por pacote.');
      return;
    }
    const file = await pickImage('sticker');
    if (!file) return;
    const tempId = Date.now();
    setStickers(prev => [...prev, { id: tempId, uri: file.uri, url: null, uploading: true, removingBg: !!opts.removeBg }]);
    try {
      const url = await uploadFile(file);
      let finalUrl = url;
      if (opts.removeBg) {
        try {
          const r = await api.apiCall('sticker_bg_remove', { source_url: url }, 'POST');
          if (r?.success && r?.data?.cdn_url) finalUrl = r.data.cdn_url;
        } catch {}
      }
      setStickers(prev => prev.map(s => s.id === tempId ? { ...s, url: finalUrl, uploading: false, removingBg: false } : s));
      setUploadProgress(p => p + 1);
    } catch {
      setStickers(prev => prev.filter(s => s.id !== tempId));
      Alert.alert('Erro', 'Falha ao enviar figurinha.');
    }
  }, [stickers.length, pickImage, uploadFile]);

  // Add a video sticker — calls sticker_animated (ffmpeg mp4→webp 512x512 3s)
  const handleAddAnimatedSticker = useCallback(async () => {
    if (stickers.length >= 30) {
      Alert.alert('Limite atingido', 'Máximo de 30 figurinhas por pacote.');
      return;
    }
    let file = null;
    try {
      if (Platform.OS === 'web') {
        file = await new Promise(resolve => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'video/mp4,video/quicktime,video/webm';
          input.onchange = (e) => {
            const f = e.target.files?.[0];
            if (!f) { resolve(null); return; }
            resolve({ _raw: f, name: f.name, type: f.type, uri: URL.createObjectURL(f) });
          };
          input.click();
        });
      } else {
        const ImagePicker = require('expo-image-picker');
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) return;
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Videos,
          videoMaxDuration: 3,
          quality: 0.8,
        });
        if (result.canceled || !result.assets?.[0]) return;
        const a = result.assets[0];
        file = { uri: a.uri, name: a.fileName || `vid_${Date.now()}.mp4`, type: a.mimeType || 'video/mp4' };
      }
    } catch { return; }
    if (!file) return;

    const tempId = Date.now();
    setStickers(prev => [...prev, { id: tempId, uri: file.uri, url: null, uploading: true, animated: true }]);
    try {
      const r = await api.stickerConvertAnimated(file);
      if (!r?.success || !r?.data?.cdn_url) throw new Error(r?.message || 'convert failed');
      setStickers(prev => prev.map(s => s.id === tempId ? { ...s, url: r.data.cdn_url, uri: r.data.cdn_url, uploading: false, animated: true } : s));
      setUploadProgress(p => p + 1);
    } catch (e) {
      setStickers(prev => prev.filter(s => s.id !== tempId));
      Alert.alert('Erro', 'Falha ao criar figurinha animada. Vídeo precisa ter até 3s e 15 MB.');
    }
  }, [stickers.length]);

  const handleRemoveSticker = useCallback((id) => {
    setStickers(prev => prev.filter(s => s.id !== id));
  }, []);

  const handleCreate = useCallback(async () => {
    if (!packName.trim()) { Alert.alert('Atenção', 'Dê um nome ao seu pacote.'); return; }
    const readyStickers = stickers.filter(s => s.url);
    if (readyStickers.length < 1) { Alert.alert('Atenção', 'Adicione pelo menos 1 figurinha.'); return; }

    setCreating(true);
    try {
      const r = await createCustomPack(
        packName.trim(),
        coverUrl || readyStickers[0]?.url || '',
        readyStickers.map(s => s.url),
      );
      if (r?.success) {
        setStep(3);
        setTimeout(() => {
          onCreated(r.pack);
        }, 1400);
      } else {
        Alert.alert('Erro', r?.error || 'Falha ao criar pacote.');
      }
    } catch (e) {
      Alert.alert('Erro', e?.message || 'Falha ao criar pacote.');
    } finally {
      setCreating(false);
    }
  }, [packName, stickers, coverUrl, onCreated]);

  return (
    <Animated.View style={{ flex: 1, opacity: fadeAnim, backgroundColor: colors.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* Header */}
        <View style={{
          flexDirection: 'row', alignItems: 'center', padding: 16,
          borderBottomWidth: 1, borderBottomColor: colors.border,
          backgroundColor: colors.surface,
        }}>
          <TouchableOpacity onPress={onClose} style={{ padding: 4, marginRight: 8 }} hitSlop={8}>
            <IconX size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: '700', color: colors.text }}>
            Criar Pacote de Figurinhas
          </Text>
          {step === 2 && (
            <TouchableOpacity
              onPress={handleCreate}
              disabled={creating || stickers.filter(s => s.url).length === 0}
              style={{
                borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8,
                backgroundColor: (creating || stickers.filter(s => s.url).length === 0)
                  ? colors.textTertiary : colors.primary,
              }}
              activeOpacity={0.8}
            >
              {creating ? (
                <ActivityIndicator size={14} color="#fff" />
              ) : (
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>Criar</Text>
              )}
            </TouchableOpacity>
          )}
        </View>

        {/* Step indicator */}
        {step < 3 && (
          <View style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
            padding: 12, gap: 8,
          }}>
            {[1, 2].map(s => (
              <View key={s} style={{
                width: step >= s ? 24 : 8, height: 8, borderRadius: 4,
                backgroundColor: step >= s ? colors.primary : colors.border,
                transition: 'width 0.3s',
              }} />
            ))}
          </View>
        )}

        {/* Step 1: Name + Cover */}
        {step === 1 && (
          <ScrollView contentContainerStyle={{ padding: 20 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text, marginBottom: 8 }}>
              Nome do pacote *
            </Text>
            <TextInput
              value={packName}
              onChangeText={setPackName}
              placeholder="Ex: Meus Memes, Fofurinhas..."
              placeholderTextColor={colors.textTertiary}
              style={{
                backgroundColor: colors.surface,
                borderWidth: 1, borderColor: colors.border,
                borderRadius: 12, padding: 14,
                fontSize: 15, color: colors.text,
                marginBottom: 24,
              }}
              maxLength={40}
              autoFocus
            />

            <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text, marginBottom: 8 }}>
              Capa do pacote (opcional)
            </Text>
            <TouchableOpacity
              onPress={handlePickCover}
              disabled={uploading}
              style={{
                width: 110, height: 110, borderRadius: 18,
                backgroundColor: colors.surfaceVariant,
                borderWidth: 2, borderStyle: 'dashed', borderColor: colors.border,
                alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
              }}
              activeOpacity={0.8}
            >
              {uploading ? (
                <ActivityIndicator color={colors.primary} />
              ) : coverUri ? (
                <CachedImage source={{ uri: coverUri }} style={{ width: 110, height: 110 }} resizeMode="cover" />
              ) : (
                <>
                  <IconPlus size={28} color={colors.textTertiary} />
                  <Text style={{ fontSize: 11, color: colors.textTertiary, marginTop: 4 }}>Escolher</Text>
                </>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => {
                if (!packName.trim()) { Alert.alert('Atenção', 'Dê um nome ao pacote para continuar.'); return; }
                setStep(2);
              }}
              style={{
                marginTop: 32, borderRadius: 14, paddingVertical: 14,
                backgroundColor: packName.trim() ? colors.primary : colors.textTertiary,
                alignItems: 'center',
              }}
              disabled={!packName.trim()}
              activeOpacity={0.8}
            >
              <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>
                Próximo: Adicionar figurinhas →
              </Text>
            </TouchableOpacity>
          </ScrollView>
        )}

        {/* Step 2: Add stickers */}
        {step === 2 && (
          <View style={{ flex: 1 }}>
            <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }}>
              <Text style={{ fontSize: 13, color: colors.textSecondary }}>
                {stickers.length}/30 figurinhas · {stickers.filter(s => s.url).length} prontas
              </Text>
            </View>
            <FlatList
              data={[
                { id: '__add__' },
                ...stickers,
              ]}
              numColumns={3}
              keyExtractor={item => String(item.id)}
              contentContainerStyle={{ padding: 12, gap: 4 }}
              columnWrapperStyle={{ gap: 4 }}
              showsVerticalScrollIndicator={false}
              renderItem={({ item }) => {
                if (item.id === '__add__') {
                  return (
                    <TouchableOpacity
                      onPress={() => {
                        const buttons = [
                          { text: 'Cancelar', style: 'cancel' },
                          { text: 'Foto normal', onPress: () => handleAddSticker() },
                          { text: '✨ Remover fundo', onPress: () => handleAddSticker({ removeBg: true }) },
                          { text: '🎬 Vídeo animado (3s)', onPress: () => handleAddAnimatedSticker() },
                        ];
                        if (Platform.OS === 'web') {
                          // Web has no Alert.alert button sheet — show a prompt
                          const choice = window.prompt('Tipo de figurinha:\n1 = Foto normal\n2 = Remover fundo\n3 = Vídeo animado');
                          if (choice === '1') handleAddSticker();
                          else if (choice === '2') handleAddSticker({ removeBg: true });
                          else if (choice === '3') handleAddAnimatedSticker();
                        } else {
                          Alert.alert('Nova figurinha', 'Escolha o tipo:', buttons);
                        }
                      }}
                      style={{
                        flex: 1, aspectRatio: 1,
                        backgroundColor: colors.surfaceVariant,
                        borderRadius: 14,
                        borderWidth: 2, borderStyle: 'dashed', borderColor: colors.primary + '60',
                        alignItems: 'center', justifyContent: 'center', gap: 4,
                        minHeight: 90,
                      }}
                      activeOpacity={0.7}
                    >
                      <IconPlus size={26} color={colors.primary} />
                      <Text style={{ fontSize: 11, color: colors.primary, fontWeight: '600' }}>Adicionar</Text>
                    </TouchableOpacity>
                  );
                }
                return (
                  <View style={{
                    flex: 1, aspectRatio: 1, borderRadius: 14, overflow: 'hidden',
                    backgroundColor: colors.surfaceVariant, minHeight: 90,
                  }}>
                    {item.uri && (
                      <CachedImage source={{ uri: item.uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                    )}
                    {item.uploading && (
                      <View style={{
                        ...StyleSheet.absoluteFillObject,
                        backgroundColor: 'rgba(0,0,0,0.5)',
                        alignItems: 'center', justifyContent: 'center',
                      }}>
                        <ActivityIndicator color="#fff" />
                      </View>
                    )}
                    {!item.uploading && (
                      <TouchableOpacity
                        onPress={() => handleRemoveSticker(item.id)}
                        style={{
                          position: 'absolute', top: 4, right: 4,
                          backgroundColor: 'rgba(0,0,0,0.6)',
                          borderRadius: 10, width: 20, height: 20,
                          alignItems: 'center', justifyContent: 'center',
                        }}
                        hitSlop={4}
                      >
                        <IconX size={12} color="#fff" />
                      </TouchableOpacity>
                    )}
                    {item.url && (
                      <View style={{
                        position: 'absolute', bottom: 4, right: 4,
                        backgroundColor: '#16a34a',
                        borderRadius: 8, width: 16, height: 16,
                        alignItems: 'center', justifyContent: 'center',
                      }}>
                        <IconCheck size={10} color="#fff" />
                      </View>
                    )}
                  </View>
                );
              }}
            />
          </View>
        )}

        {/* Step 3: Success */}
        {step === 3 && (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 }}>
            <Text style={{ fontSize: 64, marginBottom: 16 }}>🎉</Text>
            <Text style={{ fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 8, textAlign: 'center' }}>
              Pacote criado!
            </Text>
            <Text style={{ fontSize: 15, color: colors.textSecondary, textAlign: 'center', lineHeight: 22 }}>
              Seu pacote "{packName}" foi criado com sucesso e já está disponível nas suas figurinhas.
            </Text>
          </View>
        )}
      </KeyboardAvoidingView>
    </Animated.View>
  );
}

// ─── Missing StyleSheet import ─────────────────────────────────────────────────
import { StyleSheet } from 'react-native';

// ─── Hero "Pack do dia" Card ──────────────────────────────────────────────────
// Top featured pack with brand gradient + 4-sticker preview row. Used as the
// first entry above the Em destaque rail.

function HeroPackCard({ pack, onPress, colors, installed }) {
  if (!pack) return null;
  const previews = (pack.preview_stickers || pack.previews || []).slice(0, 4);
  while (previews.length < 4) previews.push(null);

  // Faux-gradient using two stacked overlay layers (RN core has no gradient).
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.9}
      style={{
        marginHorizontal: 16, marginTop: 14, marginBottom: 4,
        borderRadius: 20, overflow: 'hidden',
        backgroundColor: '#7C3AED',
        shadowColor: '#7C3AED', shadowOpacity: 0.25,
        shadowRadius: 14, shadowOffset: { width: 0, height: 6 },
        elevation: 6,
      }}
    >
      {/* Gradient overlay (top-left lighter, bottom-right darker) */}
      <View style={{
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(255,255,255,0.10)',
      }} />
      <View style={{
        position: 'absolute', right: -40, bottom: -40,
        width: 160, height: 160, borderRadius: 80,
        backgroundColor: 'rgba(0,0,0,0.18)',
      }} />

      <View style={{ padding: 16 }}>
        {/* "Pack do dia" badge */}
        <View style={{
          alignSelf: 'flex-start',
          flexDirection: 'row', alignItems: 'center', gap: 4,
          backgroundColor: 'rgba(255,255,255,0.22)',
          borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4,
          marginBottom: 10,
        }}>
          <IconSparkles size={12} color="#fff" />
          <Text style={{ fontSize: 11, fontWeight: '800', color: '#fff', letterSpacing: 0.4 }}>
            PACK DO DIA
          </Text>
        </View>

        {/* Title + author */}
        <Text numberOfLines={1} style={{ fontSize: 20, fontWeight: '800', color: '#fff' }}>
          {pack.name}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)', marginTop: 2 }}>
          por {pack.author || 'Chatyy'} · {pack.sticker_count || 0} figurinhas
        </Text>

        {/* Sticker preview row */}
        <View style={{
          flexDirection: 'row', gap: 8, marginTop: 14, marginBottom: 4,
        }}>
          {previews.map((sticker, idx) => {
            const url = typeof sticker === 'string' && /^https?:\/\//.test(sticker)
              ? sticker
              : sticker?.url || null;
            const emoji = sticker?.emoji_tag || (!url && typeof sticker === 'string' ? sticker : null);
            return (
              <View
                key={`hero-prev-${idx}`}
                style={{
                  width: 56, height: 56, borderRadius: 14,
                  backgroundColor: 'rgba(255,255,255,0.95)',
                  alignItems: 'center', justifyContent: 'center',
                  overflow: 'hidden',
                }}
              >
                {url ? (
                  <Image source={{ uri: url }} style={{ width: '85%', height: '85%' }} resizeMode="contain" />
                ) : emoji ? (
                  <Text style={{ fontSize: 30 }}>{emoji}</Text>
                ) : pack.cover_url && idx === 0 ? (
                  <Image source={{ uri: pack.cover_url }} style={{ width: '85%', height: '85%' }} resizeMode="contain" />
                ) : (
                  <Text style={{ fontSize: 26, opacity: 0.3 }}>{pack.cover_emoji || '📦'}</Text>
                )}
              </View>
            );
          })}
        </View>

        {/* CTA pill */}
        <View style={{
          alignSelf: 'flex-start', marginTop: 12,
          flexDirection: 'row', alignItems: 'center', gap: 4,
          backgroundColor: '#fff',
          borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7,
        }}>
          {installed ? (
            <>
              <IconCheck size={13} color="#7C3AED" />
              <Text style={{ fontSize: 12, fontWeight: '800', color: '#7C3AED' }}>
                Instalado · ver pack
              </Text>
            </>
          ) : (
            <>
              <IconPlus size={13} color="#7C3AED" />
              <Text style={{ fontSize: 12, fontWeight: '800', color: '#7C3AED' }}>
                Ver pack
              </Text>
            </>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ─── Featured Section ─────────────────────────────────────────────────────────

function FeaturedSection({ packs, onPackPress, colors }) {
  if (!packs || packs.length === 0) return null;
  return (
    <View style={{ marginBottom: 8 }}>
      <View style={{
        flexDirection: 'row', alignItems: 'center', gap: 6,
        paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8,
      }}>
        <IconSparkles size={16} color="#F59E0B" />
        <Text style={{ fontSize: 15, fontWeight: '800', color: colors.text }}>
          Em destaque
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 12, gap: 10 }}
      >
        {packs.map(pack => (
          <TouchableOpacity
            key={pack.id}
            onPress={() => onPackPress(pack)}
            activeOpacity={0.85}
            style={{
              width: 130, borderRadius: 16, overflow: 'hidden',
              backgroundColor: colors.surface,
              borderWidth: 1, borderColor: colors.border,
              shadowColor: '#7C3AED', shadowOpacity: 0.1,
              shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
              elevation: 2,
            }}
          >
            <View style={{
              width: '100%', height: 90,
              backgroundColor: colors.surfaceVariant,
              alignItems: 'center', justifyContent: 'center',
            }}>
              {pack.cover_url ? (
                <CachedImage source={{ uri: pack.cover_url }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
              ) : (
                <Text style={{ fontSize: 44 }}>{pack.cover_emoji || '🌟'}</Text>
              )}
            </View>
            <View style={{ padding: 8 }}>
              <Text numberOfLines={1} style={{ fontSize: 12, fontWeight: '700', color: colors.text }}>
                {pack.name}
              </Text>
              <Text numberOfLines={1} style={{ fontSize: 10, color: colors.textTertiary, marginTop: 1 }}>
                {pack.sticker_count || '?'} fig.
              </Text>
            </View>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

// ─── Category Pills ───────────────────────────────────────────────────────────

const CATEGORIES = [
  { id: '', label: 'Todos', emoji: '✨' },
  { id: 'emoji', label: 'Emoji', emoji: '😀' },
  { id: 'anime', label: 'Anime', emoji: '🎌' },
  { id: 'meme', label: 'Memes', emoji: '🤣' },
  { id: 'love', label: 'Amor', emoji: '❤️' },
  { id: 'animals', label: 'Animais', emoji: '🐾' },
  { id: 'custom', label: 'Custom', emoji: '🎨' },
  { id: 'premium', label: 'Premium', emoji: '⭐' },
];

function CategoryPills({ active, onSelect, colors }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ borderBottomWidth: 1, borderBottomColor: colors.border, maxHeight: 48 }}
      contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8, gap: 6, alignItems: 'center' }}
    >
      {CATEGORIES.map(cat => (
        <TouchableOpacity
          key={cat.id}
          onPress={() => onSelect(cat.id)}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 4,
            paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20,
            backgroundColor: active === cat.id
              ? colors.primary
              : colors.surfaceVariant,
            borderWidth: active === cat.id ? 0 : 1,
            borderColor: colors.border,
          }}
          activeOpacity={0.7}
        >
          <Text style={{ fontSize: 12 }}>{cat.emoji}</Text>
          <Text style={{
            fontSize: 12, fontWeight: '600',
            color: active === cat.id ? '#fff' : colors.text,
          }}>
            {cat.label}
          </Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

// ─── Main StickerStore Component ──────────────────────────────────────────────

const TABS = [
  { id: 'my', label: 'Meus', emoji: '📦' },
  { id: 'store', label: 'Loja', emoji: '🛍️' },
  { id: 'trending', label: 'Trending', emoji: '🔥' },
];

export default function StickerStore({ visible, onClose, colors, t, userEmail }) {
  const [activeTab, setActiveTab] = useState('store');
  const [storePacks, setStorePacks] = useState([]);
  const [featuredPacks, setFeaturedPacks] = useState([]);
  const [installedPacks, setInstalledPacks] = useState([]);
  const [installedIds, setInstalledIds] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('');
  const [selectedPack, setSelectedPack] = useState(null);
  const [installingId, setInstallingId] = useState(null);
  const [uninstallingId, setUninstallingId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [offset, setOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const slideAnim = useRef(new Animated.Value(600)).current;
  const searchTimeout = useRef(null);

  // ── Animate in ──
  useEffect(() => {
    if (visible) {
      Animated.spring(slideAnim, {
        toValue: 0, useNativeDriver: true,
        tension: 280, friction: 28,
      }).start();
      loadInitial();
    } else {
      slideAnim.setValue(600);
    }
  }, [visible]);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setOffset(0);
    setHasMore(true);
    try {
      const [storeRes, featuredRes, myRes] = await Promise.allSettled([
        fetchStorePacks('', '', 0),
        fetchFeatured(),
        fetchInstalledPacks(),
      ]);
      if (storeRes.status === 'fulfilled' && storeRes.value?.packs) {
        setStorePacks(storeRes.value.packs);
        setHasMore(storeRes.value.has_more ?? storeRes.value.packs.length >= 20);
        setOffset(storeRes.value.packs.length);
      }
      if (featuredRes.status === 'fulfilled' && featuredRes.value?.packs) {
        setFeaturedPacks(featuredRes.value.packs);
      }
      if (myRes.status === 'fulfilled' && myRes.value?.packs) {
        setInstalledPacks(myRes.value.packs);
        setInstalledIds(new Set(myRes.value.packs.map(p => String(p.id))));
      }
    } catch {}
    finally { setLoading(false); }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const res = await fetchStorePacks(search, activeCategory, offset);
      if (res?.packs?.length) {
        setStorePacks(prev => [...prev, ...res.packs]);
        setOffset(prev => prev + res.packs.length);
        setHasMore(res.has_more ?? res.packs.length >= 20);
      } else {
        setHasMore(false);
      }
    } catch {}
    finally { setLoadingMore(false); }
  }, [loadingMore, hasMore, search, activeCategory, offset]);

  const handleSearch = useCallback((text) => {
    setSearch(text);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(async () => {
      setLoading(true);
      setOffset(0);
      try {
        const res = await fetchStorePacks(text, activeCategory, 0);
        setStorePacks(res?.packs || []);
        setHasMore(res?.has_more ?? false);
        setOffset(res?.packs?.length || 0);
      } catch {}
      finally { setLoading(false); }
    }, 400);
  }, [activeCategory]);

  const handleCategoryChange = useCallback(async (cat) => {
    setActiveCategory(cat);
    setLoading(true);
    setOffset(0);
    try {
      const res = await fetchStorePacks(search, cat, 0);
      setStorePacks(res?.packs || []);
      setHasMore(res?.has_more ?? false);
      setOffset(res?.packs?.length || 0);
    } catch {}
    finally { setLoading(false); }
  }, [search]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadInitial();
    setRefreshing(false);
  }, [loadInitial]);

  const handleInstall = useCallback(async (packId) => {
    setInstallingId(packId);
    try {
      const res = await installPack(packId);
      if (res?.success) {
        setInstalledIds(prev => new Set([...prev, String(packId)]));
        // Refresh my packs
        const myRes = await fetchInstalledPacks();
        if (myRes?.packs) {
          setInstalledPacks(myRes.packs);
          setInstalledIds(new Set(myRes.packs.map(p => String(p.id))));
        }
      } else {
        Alert.alert('Erro', res?.error || 'Falha ao adicionar pacote.');
      }
    } catch {
      Alert.alert('Erro', 'Falha ao adicionar pacote.');
    } finally {
      setInstallingId(null);
    }
  }, []);

  const handleUninstall = useCallback((packId) => {
    Alert.alert(
      'Remover pacote?',
      'As figurinhas deste pacote não aparecerão mais no seu teclado.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Remover', style: 'destructive',
          onPress: async () => {
            setUninstallingId(packId);
            try {
              const res = await uninstallPack(packId);
              if (res?.success || res?.removed) {
                setInstalledIds(prev => {
                  const next = new Set(prev);
                  next.delete(String(packId));
                  return next;
                });
                setInstalledPacks(prev => prev.filter(p => String(p.id) !== String(packId)));
              }
            } catch {}
            finally { setUninstallingId(null); }
          },
        },
      ]
    );
  }, []);

  const handlePackCreated = useCallback(async (pack) => {
    setShowCreate(false);
    setActiveTab('my');
    // Refresh installed
    const myRes = await fetchInstalledPacks().catch(() => null);
    if (myRes?.packs) {
      setInstalledPacks(myRes.packs);
      setInstalledIds(new Set(myRes.packs.map(p => String(p.id))));
    }
  }, []);

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      animationType="none"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <Animated.View
        style={{
          flex: 1,
          backgroundColor: colors.background,
          transform: [{ translateY: slideAnim }],
        }}
      >
        {/* ── Detail view ── */}
        {selectedPack && (
          <PackDetailModal
            pack={selectedPack}
            colors={colors}
            onClose={() => setSelectedPack(null)}
            onInstall={handleInstall}
            onUninstall={handleUninstall}
            installedIds={installedIds}
            t={t}
          />
        )}

        {/* ── Create view ── */}
        {showCreate && (
          <CreatePackModal
            colors={colors}
            onClose={() => setShowCreate(false)}
            onCreated={handlePackCreated}
            t={t}
          />
        )}

        {/* ── Main store ── */}
        {!selectedPack && !showCreate && (
          <View style={{ flex: 1 }}>
            {/* Header */}
            <View style={{
              flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16,
              paddingTop: 14, paddingBottom: 10,
              backgroundColor: colors.surface,
              borderBottomWidth: 1, borderBottomColor: colors.border,
            }}>
              <Text style={{ flex: 1, fontSize: 20, fontWeight: '800', color: colors.text }}>
                Loja de Figurinhas
              </Text>
              <TouchableOpacity onPress={onClose} style={{ padding: 6 }} hitSlop={8}>
                <IconX size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* Search bar */}
            <View style={{
              flexDirection: 'row', alignItems: 'center', gap: 8,
              paddingHorizontal: 16, paddingVertical: 10,
              backgroundColor: colors.surface,
              borderBottomWidth: 1, borderBottomColor: colors.border,
            }}>
              <View style={{
                flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8,
                backgroundColor: colors.surfaceVariant,
                borderRadius: 22, paddingHorizontal: 12, paddingVertical: 8,
              }}>
                <IconSearch size={15} color={colors.textTertiary} />
                <TextInput
                  value={search}
                  onChangeText={handleSearch}
                  placeholder="Buscar figurinhas..."
                  placeholderTextColor={colors.textTertiary}
                  style={{ flex: 1, fontSize: 14, color: colors.text, padding: 0 }}
                  autoCorrect={false}
                  returnKeyType="search"
                />
                {search.length > 0 && (
                  <TouchableOpacity onPress={() => handleSearch('')} hitSlop={6}>
                    <IconX size={14} color={colors.textTertiary} />
                  </TouchableOpacity>
                )}
              </View>
            </View>

            {/* Tabs */}
            <View style={{
              flexDirection: 'row', backgroundColor: colors.surface,
              borderBottomWidth: 1, borderBottomColor: colors.border,
            }}>
              {TABS.map(tab => (
                <TouchableOpacity
                  key={tab.id}
                  onPress={() => setActiveTab(tab.id)}
                  style={{
                    flex: 1, paddingVertical: 10, alignItems: 'center',
                    borderBottomWidth: activeTab === tab.id ? 2.5 : 0,
                    borderBottomColor: colors.primary,
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={{ fontSize: 13 }}>{tab.emoji}</Text>
                  <Text style={{
                    fontSize: 11, fontWeight: activeTab === tab.id ? '700' : '500',
                    color: activeTab === tab.id ? colors.primary : colors.textSecondary,
                    marginTop: 1,
                  }}>
                    {tab.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Store tab content */}
            {activeTab === 'store' && (
              <View style={{ flex: 1 }}>
                <CategoryPills
                  active={activeCategory}
                  onSelect={handleCategoryChange}
                  colors={colors}
                />

                {loading ? (
                  <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivityIndicator color={colors.primary} size="large" />
                    <Text style={{ color: colors.textTertiary, marginTop: 10, fontSize: 13 }}>
                      Carregando pacotes...
                    </Text>
                  </View>
                ) : (
                  <FlatList
                    data={storePacks}
                    numColumns={2}
                    keyExtractor={item => String(item.id)}
                    showsVerticalScrollIndicator={false}
                    refreshControl={
                      <RefreshControl
                        refreshing={refreshing}
                        onRefresh={handleRefresh}
                        tintColor={colors.primary}
                      />
                    }
                    ListHeaderComponent={
                      !search && activeCategory === '' && featuredPacks.length > 0 ? (
                        <View>
                          <HeroPackCard
                            pack={featuredPacks[0]}
                            onPress={() => setSelectedPack(featuredPacks[0])}
                            colors={colors}
                            installed={installedIds.has(String(featuredPacks[0]?.id))}
                          />
                          {featuredPacks.length > 1 && (
                            <FeaturedSection
                              packs={featuredPacks.slice(1)}
                              onPackPress={setSelectedPack}
                              colors={colors}
                            />
                          )}
                        </View>
                      ) : null
                    }
                    ListEmptyComponent={
                      <View style={{ alignItems: 'center', justifyContent: 'center', padding: 40 }}>
                        <Text style={{ fontSize: 44, marginBottom: 12 }}>🔍</Text>
                        <Text style={{ fontSize: 16, fontWeight: '600', color: colors.text, marginBottom: 6 }}>
                          Nenhum pacote encontrado
                        </Text>
                        <Text style={{ fontSize: 13, color: colors.textTertiary, textAlign: 'center' }}>
                          {search
                            ? `Sem resultados para "${search}"`
                            : 'Nenhum pacote nesta categoria ainda.'}
                        </Text>
                      </View>
                    }
                    ListFooterComponent={
                      loadingMore ? (
                        <View style={{ padding: 20, alignItems: 'center' }}>
                          <ActivityIndicator color={colors.primary} />
                        </View>
                      ) : hasMore && storePacks.length > 0 ? (
                        <TouchableOpacity
                          onPress={loadMore}
                          style={{
                            margin: 16, padding: 12, borderRadius: 12,
                            backgroundColor: colors.surfaceVariant, alignItems: 'center',
                          }}
                          activeOpacity={0.7}
                        >
                          <Text style={{ fontSize: 13, fontWeight: '600', color: colors.primary }}>
                            Carregar mais
                          </Text>
                        </TouchableOpacity>
                      ) : null
                    }
                    columnWrapperStyle={{ justifyContent: 'flex-start' }}
                    contentContainerStyle={{ paddingBottom: 24 }}
                    renderItem={({ item }) => (
                      <PackCard
                        pack={item}
                        onPress={() => setSelectedPack(item)}
                        onInstall={() => handleInstall(item.id)}
                        onUninstall={() => handleUninstall(item.id)}
                        installed={installedIds.has(String(item.id))}
                        installing={installingId === item.id}
                        colors={colors}
                      />
                    )}
                  />
                )}
              </View>
            )}

            {/* My packs tab */}
            {activeTab === 'my' && (
              <View style={{ flex: 1 }}>
                <MyPacksTab
                  colors={colors}
                  installedPacks={installedPacks}
                  onUninstall={handleUninstall}
                  onPackPress={setSelectedPack}
                  uninstallingId={uninstallingId}
                  t={t}
                />
                {/* "Criar pack" FAB — purple primary, bottom-right */}
                <TouchableOpacity
                  onPress={() => setShowCreate(true)}
                  activeOpacity={0.85}
                  style={{
                    position: 'absolute', bottom: 20, right: 20,
                    width: 56, height: 56, borderRadius: 28,
                    backgroundColor: '#7C3AED',
                    alignItems: 'center', justifyContent: 'center',
                    shadowColor: '#7C3AED', shadowOpacity: 0.45,
                    shadowRadius: 12, shadowOffset: { width: 0, height: 6 },
                    elevation: 8,
                  }}
                >
                  <IconPlus size={26} color="#fff" />
                </TouchableOpacity>
              </View>
            )}

            {/* Trending tab — sorts store packs by install_count desc */}
            {activeTab === 'trending' && (
              <View style={{ flex: 1 }}>
                {loading ? (
                  <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivityIndicator color={colors.primary} size="large" />
                  </View>
                ) : (
                  <FlatList
                    data={[...storePacks]
                      .sort((a, b) =>
                        (b.install_count || b.installs || 0)
                        - (a.install_count || a.installs || 0)
                      )
                      .slice(0, 30)}
                    keyExtractor={item => `trend-${item.id}`}
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={{ padding: 16, paddingBottom: 24, gap: 8 }}
                    ListHeaderComponent={
                      <View style={{
                        flexDirection: 'row', alignItems: 'center', gap: 8,
                        marginBottom: 12,
                      }}>
                        <Text style={{ fontSize: 20 }}>🔥</Text>
                        <Text style={{ fontSize: 17, fontWeight: '800', color: colors.text }}>
                          Mais baixados da semana
                        </Text>
                      </View>
                    }
                    ListEmptyComponent={
                      <View style={{ alignItems: 'center', padding: 40 }}>
                        <Text style={{ fontSize: 44, marginBottom: 12 }}>📊</Text>
                        <Text style={{ fontSize: 14, color: colors.textTertiary, textAlign: 'center' }}>
                          Sem dados de trending ainda. Volte em breve!
                        </Text>
                      </View>
                    }
                    renderItem={({ item, index }) => {
                      const installed = installedIds.has(String(item.id));
                      return (
                        <TouchableOpacity
                          onPress={() => setSelectedPack(item)}
                          activeOpacity={0.85}
                          style={{
                            flexDirection: 'row', alignItems: 'center', gap: 12,
                            backgroundColor: colors.surface,
                            borderRadius: 14, padding: 12,
                            borderWidth: 1, borderColor: colors.border,
                          }}
                        >
                          {/* Rank */}
                          <View style={{
                            width: 28, alignItems: 'center',
                          }}>
                            <Text style={{
                              fontSize: 18, fontWeight: '800',
                              color: index < 3 ? '#7C3AED' : colors.textTertiary,
                            }}>
                              {index + 1}
                            </Text>
                          </View>
                          {/* Cover */}
                          <View style={{
                            width: 52, height: 52, borderRadius: 12, overflow: 'hidden',
                            backgroundColor: colors.surfaceVariant,
                            alignItems: 'center', justifyContent: 'center',
                          }}>
                            {item.cover_url ? (
                              <Image source={{ uri: item.cover_url }} style={{ width: 52, height: 52 }} resizeMode="cover" />
                            ) : (
                              <Text style={{ fontSize: 28 }}>{item.cover_emoji || '📦'}</Text>
                            )}
                          </View>
                          {/* Info */}
                          <View style={{ flex: 1 }}>
                            <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: '700', color: colors.text }}>
                              {item.name}
                            </Text>
                            <Text numberOfLines={1} style={{ fontSize: 11, color: colors.textTertiary, marginTop: 2 }}>
                              {item.author || 'Chatyy'} · {(item.install_count || item.installs || 0).toLocaleString()} downloads
                            </Text>
                          </View>
                          {/* Pill */}
                          <TouchableOpacity
                            onPress={(e) => {
                              e.stopPropagation?.();
                              installed ? handleUninstall(item.id) : handleInstall(item.id);
                            }}
                            disabled={installingId === item.id}
                            style={{
                              borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6,
                              backgroundColor: installed ? 'transparent' : '#7C3AED',
                              borderWidth: installed ? 1.5 : 0,
                              borderColor: '#7C3AED',
                            }}
                          >
                            <Text style={{
                              fontSize: 11, fontWeight: '800',
                              color: installed ? '#7C3AED' : '#fff',
                            }}>
                              {installed ? 'Instalado' : 'Adicionar'}
                            </Text>
                          </TouchableOpacity>
                        </TouchableOpacity>
                      );
                    }}
                  />
                )}
              </View>
            )}
          </View>
        )}
      </Animated.View>
    </Modal>
  );
}
