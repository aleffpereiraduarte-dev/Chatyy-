// [2026-10-10 stickers-import] Detalhe de um pacote de figurinhas.
//
// Dono (pacote pessoal/publicado): ver figurinhas, adicionar da galeria ou de
// Arquivos (.webp/.png/.jpg/.gif — o servidor valida e normaliza para WebP
// 512×512; animada ≤500 KB), remover, mover para o início, usar como capa,
// renomear, publicar por link (não entra na vitrine da loja) e excluir.
// Outros: só pacotes públicos/oficiais (pessoal alheio = 404 no servidor) com
// "Adicionar pacote" / "Remover pacote".
// Params: id (pack id) | handle.
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, ActivityIndicator, Alert, Platform, Share,
  TextInput, Modal, useWindowDimensions,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter, useLocalSearchParams, Stack } from 'expo-router';
import { USE_NATIVE_HEADER, nativeHeaderOptions, HeaderIconButton } from '../../components/nativeHeader';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import * as api from '../../services/api';
import NativeSwitch from '../../components/NativeSwitch';
import StickerActionSheet, { stickerAbsUrl } from '../../components/stickers/StickerActionSheet';
import { pickStickerFiles } from '../../services/stickerFiles';
import {
  IconArrowLeft, IconPlus, IconTrash, IconShare, IconPackage, IconEdit, IconX, IconImage, IconFolder,
} from '../../components/Icons';

function _d(r) { return (r && (r.data || r)) || {}; }

export default function StickerPackScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { width } = useWindowDimensions();
  const packId = Number(params.id) || null;
  const handle = params.handle ? String(params.handle) : '';
  const [pack, setPack] = useState(null);
  const [stickers, setStickers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(null); // { done, total, fail }
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const [sheet, setSheet] = useState(null); // { url }

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await api.stickerPackGet({ packId, handle });
      if (r?.success === false) { setError(t('stickers.packNotFound')); setPack(null); return; }
      const d = _d(r);
      setPack(d.pack || null);
      setStickers(Array.isArray(d.stickers) ? d.stickers : []);
    } catch { setError(t('stickers.loadFailed')); }
    finally { setLoading(false); }
  }, [packId, handle, t]);

  useEffect(() => { load(); }, [load]);

  const isOwner = !!pack?.is_owner;
  const cols = Math.max(3, Math.min(6, Math.floor(Math.min(width, 720) / 96)));
  const cell = Math.floor((Math.min(width, 720) - 24) / cols);

  const addFrom = useCallback(async (source) => {
    if (!pack) return;
    const files = await pickStickerFiles(source, { multiple: true });
    if (!files.length) return;
    setProgress({ done: 0, total: files.length, fail: 0 });
    let fail = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      // eslint-disable-next-line no-await-in-loop
      const r = await api.stickerUpload(f.blob ? { blob: f.blob, name: f.name } : f, { packId: pack.id });
      if (!(r?.success && _d(r).sticker)) fail++;
      setProgress({ done: i + 1, total: files.length, fail });
    }
    await load();
    setTimeout(() => setProgress(null), fail ? 4000 : 1200);
  }, [pack, load]);

  const chooseSource = useCallback(() => {
    if (Platform.OS === 'web') { addFrom('files'); return; }
    Alert.alert(t('stickers.addStickers'), t('stickers.addStickersHint'), [
      { text: t('stickers.fromGallery'), onPress: () => addFrom('gallery') },
      { text: t('stickers.fromFiles'), onPress: () => addFrom('files') },
      { text: t('common.cancel'), style: 'cancel' },
    ]);
  }, [addFrom, t]);

  const stickerMenu = useCallback((s, index) => {
    if (!isOwner) { setSheet({ url: s.url }); return; }
    Alert.alert(t('chat.sticker'), '', [
      { text: t('stickers.useAsCover'), onPress: async () => { await api.stickerPackUpdate(pack.id, { coverStickerId: s.id }); load(); } },
      ...(index > 0 ? [{ text: t('stickers.moveToStart'), onPress: async () => {
        const ids = [s.id, ...stickers.filter(x => x.id !== s.id).map(x => x.id)];
        setStickers((prev) => [s, ...prev.filter(x => x.id !== s.id)]);
        await api.stickerPackReorderStickers(pack.id, ids);
      } }] : []),
      { text: t('stickers.removeFromPack'), style: 'destructive', onPress: async () => {
        setStickers((prev) => prev.filter(x => x.id !== s.id));
        await api.stickerPackRemoveItem(pack.id, s.id);
        load();
      } },
      { text: t('common.cancel'), style: 'cancel' },
    ]);
  }, [isOwner, pack, stickers, load, t]);

  const togglePublic = useCallback(async (v) => {
    if (!pack) return;
    if (v && !stickers.length) { Alert.alert(t('stickers.publishTitle'), t('stickers.publishEmpty')); return; }
    const doIt = async () => {
      setBusy('pub');
      try {
        const r = await api.stickerPackPublish(pack.id, v);
        if (r?.success === false) throw new Error('x');
        setPack(_d(r).pack || { ...pack, is_public: v });
      } catch { Alert.alert(t('common.error'), t('stickers.actionFailed')); }
      finally { setBusy(''); }
    };
    if (!v) { doIt(); return; }
    Alert.alert(t('stickers.publishTitle'), t('stickers.publishBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('stickers.publishConfirm'), onPress: doIt },
    ]);
  }, [pack, stickers.length, t]);

  const share = useCallback(async () => {
    const url = pack?.share_url;
    if (!url) return;
    const message = t('stickers.shareMsg', { name: pack.name }) + ' ' + url;
    try {
      if (Platform.OS === 'web') {
        if (typeof navigator !== 'undefined' && navigator.share) await navigator.share({ title: pack.name, text: message, url });
        else if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) { await navigator.clipboard.writeText(url); Alert.alert(t('chat.linkCopied'), url); }
      } else await Share.share({ message, url, title: pack.name });
    } catch {}
  }, [pack, t]);

  const installToggle = useCallback(async () => {
    if (!pack) return;
    setBusy('inst');
    try {
      const r = pack.installed ? await api.stickerPackUninstall(pack.id) : await api.stickerPackInstall(pack.id);
      if (r?.success === false) throw new Error('x');
      setPack({ ...pack, installed: !pack.installed });
    } catch { Alert.alert(t('common.error'), t('stickers.actionFailed')); }
    finally { setBusy(''); }
  }, [pack, t]);

  const deletePack = useCallback(() => {
    if (!pack) return;
    Alert.alert(t('stickers.deletePackTitle'), pack.name, [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('common.delete'), style: 'destructive', onPress: async () => {
        const r = await api.chatStickerPackDelete(pack.id);
        if (r?.success === false) { Alert.alert(t('common.error'), t('stickers.actionFailed')); return; }
        router.back();
      } },
    ]);
  }, [pack, router, t]);

  const saveName = useCallback(async () => {
    const n = newName.trim();
    if (!n || !pack) return;
    setRenaming(false);
    const r = await api.stickerPackUpdate(pack.id, { name: n });
    if (r?.success !== false) setPack(_d(r).pack || { ...pack, name: n });
  }, [newName, pack]);

  const displayName = pack ? (pack.name === 'My Stickers' && isOwner ? t('stickers.myStickers') : pack.name) : '';

  const header = pack ? (
    <View style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View style={{ width: 72, height: 72, borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' }}>
          {pack.cover_url ? <ExpoImage source={{ uri: stickerAbsUrl(pack.cover_url) }} style={{ width: 68, height: 68 }} contentFit="contain" />
            : <IconPackage size={30} color={colors.textSecondary} />}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text }} numberOfLines={2}>{displayName}</Text>
          <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 3 }} numberOfLines={1}>
            {t('stickers.stickerCount', { count: stickers.length })}{pack.author ? ` · ${pack.author}` : ''}
          </Text>
          <Text style={{ fontSize: 12, color: colors.textTertiary || colors.textSecondary, marginTop: 2 }}>
            {pack.is_official ? t('stickers.officialPack') : pack.is_public ? t('stickers.publicByLink') : t('stickers.privatePack')}
          </Text>
        </View>
        {isOwner ? (
          <TouchableOpacity onPress={() => { setNewName(pack.name); setRenaming(true); }} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('stickers.rename')}>
            <IconEdit size={20} color={colors.text} />
          </TouchableOpacity>
        ) : null}
      </View>

      {isOwner ? (
        <>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
            <TouchableOpacity onPress={chooseSource} disabled={!!progress} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 11, borderRadius: 12, backgroundColor: colors.text }} accessibilityRole="button">
              <IconPlus size={16} color={colors.background} />
              <Text style={{ color: colors.background, fontWeight: '700', fontSize: 14 }}>{t('stickers.addStickers')}</Text>
            </TouchableOpacity>
            {pack.is_public && pack.share_url ? (
              <TouchableOpacity onPress={share} style={{ paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: colors.border }} accessibilityRole="button" accessibilityLabel={t('common.share')}>
                <IconShare size={18} color={colors.text} />
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity onPress={deletePack} style={{ paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: colors.border }} accessibilityRole="button" accessibilityLabel={t('stickers.deletePackTitle')}>
              <IconTrash size={18} color={colors.text} />
            </TouchableOpacity>
          </View>
          {progress ? (
            <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 10 }}>
              {progress.done < progress.total ? t('stickers.uploading', { done: progress.done, total: progress.total })
                : progress.fail ? t('stickers.someFailed', { ok: progress.total - progress.fail, fail: progress.fail }) : t('stickers.savedCount', { count: progress.total })}
            </Text>
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 14 }}>
            <View style={{ flex: 1, paddingRight: 10 }}>
              <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}>{t('stickers.publicToggle')}</Text>
              <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }}>{t('stickers.publicToggleHint')}</Text>
            </View>
            {busy === 'pub' ? <ActivityIndicator color={colors.text} /> : <NativeSwitch value={!!pack.is_public} onValueChange={togglePublic} />}
          </View>
        </>
      ) : (
        <TouchableOpacity onPress={installToggle} disabled={busy === 'inst'} style={{ marginTop: 14, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: pack.installed ? 'transparent' : colors.text, borderWidth: 1, borderColor: colors.text }} accessibilityRole="button">
          {busy === 'inst' ? <ActivityIndicator color={pack.installed ? colors.text : colors.background} />
            : <Text style={{ color: pack.installed ? colors.text : colors.background, fontWeight: '700' }}>{pack.installed ? t('stickers.removePack') : t('stickers.addPack')}</Text>}
        </TouchableOpacity>
      )}
    </View>
  ) : null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {USE_NATIVE_HEADER && <Stack.Screen options={nativeHeaderOptions({
        colors, title: displayName || t('stickers.pack'),
        headerRight: isOwner ? () => (
          <HeaderIconButton onPress={chooseSource} accessibilityLabel={t('stickers.addStickers')}>
            <IconPlus size={22} color={colors.text} />
          </HeaderIconButton>
        ) : undefined,
      })} />}
      {!USE_NATIVE_HEADER && (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 12, gap: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.back')}>
            <IconArrowLeft size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: '800', color: colors.text }} numberOfLines={1}>{displayName || t('stickers.pack')}</Text>
        </View>
      )}
      {loading ? (
        <ActivityIndicator size="large" color={colors.textSecondary} style={{ marginTop: 40 }} />
      ) : error ? (
        <View style={{ padding: 30, alignItems: 'center' }}>
          <IconPackage size={40} color={colors.textSecondary} />
          <Text style={{ color: colors.text, marginTop: 10, textAlign: 'center' }}>{error}</Text>
        </View>
      ) : (
        <FlatList
          data={stickers}
          key={`c${cols}`}
          numColumns={cols}
          keyExtractor={(s) => String(s.id)}
          ListHeaderComponent={header}
          contentContainerStyle={{ paddingBottom: 40, maxWidth: 720, width: '100%', alignSelf: 'center' }}
          ListEmptyComponent={
            <View style={{ padding: 30, alignItems: 'center' }}>
              <IconImage size={34} color={colors.textSecondary} />
              <Text style={{ color: colors.textSecondary, marginTop: 10, textAlign: 'center' }}>{isOwner ? t('stickers.emptyOwnPack') : t('stickers.emptyPack')}</Text>
              {isOwner && Platform.OS !== 'web' ? (
                <TouchableOpacity onPress={() => addFrom('files')} style={{ marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 6 }} accessibilityRole="button">
                  <IconFolder size={16} color={colors.text} />
                  <Text style={{ color: colors.text, fontWeight: '600' }}>{t('stickers.fromFiles')}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          }
          renderItem={({ item, index }) => (
            <TouchableOpacity
              onPress={() => stickerMenu(item, index)}
              onLongPress={() => stickerMenu(item, index)}
              style={{ width: cell, height: cell, padding: 8, marginLeft: index % cols === 0 ? 12 : 0 }}
              accessibilityRole="imagebutton"
              accessibilityLabel={t('chat.sticker')}
            >
              <ExpoImage source={{ uri: stickerAbsUrl(item.url) }} style={{ flex: 1 }} contentFit="contain" recyclingKey={`pk-${item.id}`} />
            </TouchableOpacity>
          )}
        />
      )}

      <Modal visible={renaming} transparent animationType="fade" onRequestClose={() => setRenaming(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 24 }}>
          <View style={{ backgroundColor: colors.background, borderRadius: 16, padding: 18, maxWidth: 420, width: '100%', alignSelf: 'center' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ flex: 1, fontSize: 16, fontWeight: '800', color: colors.text }}>{t('stickers.rename')}</Text>
              <TouchableOpacity onPress={() => setRenaming(false)} hitSlop={10} accessibilityLabel={t('common.close')}><IconX size={20} color={colors.text} /></TouchableOpacity>
            </View>
            <TextInput
              value={newName} onChangeText={setNewName} maxLength={60} autoFocus
              style={{ marginTop: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, color: colors.text, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) }}
              onSubmitEditing={saveName}
            />
            <TouchableOpacity onPress={saveName} disabled={!newName.trim()} style={{ marginTop: 14, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: newName.trim() ? colors.text : colors.border }} accessibilityRole="button">
              <Text style={{ color: colors.background, fontWeight: '700' }}>{t('common.save')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <StickerActionSheet visible={!!sheet} url={sheet?.url || ''} onClose={() => setSheet(null)} />
    </View>
  );
}
