// [2026-10-10 stickers-import] Importar figurinhas (ex.: vindas do WhatsApp).
//
// Entrada: params.files = JSON [{ uri, name, mime, size }] (compartilhar →
// share-receive, ou seletor de documentos). Sem params, a tela oferece os
// seletores. O que chega:
//   (a) .webp/.png/.jpg/.gif (uma ou várias) → "Adicionar às minhas
//       figurinhas" — destino: Minhas figurinhas, um pacote meu ou um novo;
//   (b) .wastickers/.zip de pacote → pacote pessoal novo com nome/autor/capa
//       (descompactado e validado no SERVIDOR: sticker_pack_import).
// O servidor valida/normaliza cada figurinha (WebP 512×512; estática ≤100 KB,
// animada ≤500 KB). Pacotes criados aqui são PESSOAIS (só do dono).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, ActivityIndicator, Platform, TextInput,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter, useLocalSearchParams, Stack } from 'expo-router';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../../components/nativeHeader';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import * as api from '../../services/api';
import { pickStickerFiles, stickerKindOf } from '../../services/stickerFiles';
import { IconArrowLeft, IconPackage, IconImage, IconCheck, IconPlus, IconFolder, IconAlertCircle } from '../../components/Icons';

function _d(r) { return (r && (r.data || r)) || {}; }

function parseFiles(raw) {
  try {
    const arr = JSON.parse(String(raw || '[]'));
    if (!Array.isArray(arr)) return [];
    return arr.filter(f => f && f.uri).map(f => ({
      uri: String(f.uri), name: String(f.name || String(f.uri).split('/').pop() || 'sticker'),
      type: String(f.mime || f.type || ''), size: Number(f.size) || 0,
    }));
  } catch { return []; }
}

export default function StickerImportScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const myEmail = String(user?.email || '').toLowerCase();
  const [files, setFiles] = useState(() => parseFiles(params.files));
  const images = useMemo(() => files.filter(f => stickerKindOf(f) === 'image'), [files]);
  const packs = useMemo(() => files.filter(f => stickerKindOf(f) === 'pack'), [files]);
  const unknown = files.length - images.length - packs.length;

  const [myPacks, setMyPacks] = useState([]);
  const [dest, setDest] = useState('mine'); // 'mine' | 'new' | pack id
  const [newName, setNewName] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total, fail }
  const [results, setResults] = useState([]); // [{ kind, ok, packId, name, added, skipped, reason }]

  useEffect(() => { setFiles(parseFiles(params.files)); setResults([]); setProgress(null); }, [params.files]);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.stickerPackMy();
        const items = _d(r).items || r?.items || [];
        setMyPacks(items.filter(p => p && myEmail && String(p.author_email || '').toLowerCase() === myEmail));
      } catch {}
    })();
  }, [myEmail]);

  const pick = useCallback(async (source) => {
    const got = await pickStickerFiles(source, { multiple: source !== 'pack' });
    if (got.length) { setFiles(got); setResults([]); setProgress(null); }
  }, []);

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    const out = [];
    const total = images.length + packs.length;
    let done = 0; let fail = 0;
    setProgress({ done, total, fail });
    // (b) pacotes
    for (const f of packs) {
      // eslint-disable-next-line no-await-in-loop
      const r = await api.stickerPackImport(f.blob ? { blob: f.blob, name: f.name } : f);
      const d = _d(r);
      if (r?.success && d.pack) out.push({ kind: 'pack', ok: true, packId: d.pack.id, name: d.pack.name, added: d.added || 0, skipped: (d.skipped || []).length });
      else { fail++; out.push({ kind: 'pack', ok: false, name: f.name, reason: d.reason || '' }); }
      done++; setProgress({ done, total, fail });
    }
    // (a) figurinhas avulsas
    if (images.length) {
      let packId = null;
      if (dest === 'new') {
        const nm = newName.trim() || t('stickers.importedPackName');
        const c = await api.stickerPackCreate({ name: nm });
        packId = _d(c).id || null;
        if (!packId) { fail += images.length; done += images.length; out.push({ kind: 'images', ok: false, reason: 'create_failed' }); }
      } else if (dest !== 'mine') packId = dest;
      if (dest === 'mine' || packId) {
        let added = 0; let lastPack = packId;
        for (const f of images) {
          // eslint-disable-next-line no-await-in-loop
          const r = await api.stickerUpload(f.blob ? { blob: f.blob, name: f.name } : { uri: f.uri, name: f.name, type: f.type || 'image/webp' }, { packId });
          const d = _d(r);
          if (r?.success && d.sticker) { added++; lastPack = d.sticker.pack_id || lastPack; } else fail++;
          done++; setProgress({ done, total, fail });
        }
        out.push({ kind: 'images', ok: added > 0, packId: lastPack, added, skipped: images.length - added });
      }
    }
    setResults(out);
    setRunning(false);
  }, [running, images, packs, dest, newName, t]);

  const finished = results.length > 0;
  const chip = (key, label) => {
    const on = dest === key;
    return (
      <TouchableOpacity key={String(key)} onPress={() => setDest(key)} disabled={running || finished}
        style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18, borderWidth: 1, borderColor: on ? colors.text : colors.border, backgroundColor: on ? colors.text : 'transparent', marginRight: 8, marginBottom: 8 }}
        accessibilityRole="radio" accessibilityState={{ selected: on }}>
        <Text style={{ color: on ? colors.background : colors.text, fontSize: 13, fontWeight: '600' }} numberOfLines={1}>{label}</Text>
      </TouchableOpacity>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {USE_NATIVE_HEADER && <Stack.Screen options={nativeHeaderOptions({ colors, title: t('stickers.importTitle') })} />}
      {!USE_NATIVE_HEADER && (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 12, gap: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <TouchableOpacity onPress={() => (router.canGoBack?.() ? router.back() : router.replace('/chat'))} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.back')}>
            <IconArrowLeft size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: '800', color: colors.text }}>{t('stickers.importTitle')}</Text>
        </View>
      )}
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, maxWidth: 640, width: '100%', alignSelf: 'center' }}>
        {!files.length ? (
          <View>
            <Text style={{ color: colors.text, fontSize: 15, lineHeight: 21 }}>{t('stickers.importIntro')}</Text>
            <Text style={{ color: colors.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 10 }}>{t('stickers.importHowTo')}</Text>
            <TouchableOpacity onPress={() => pick('files')} style={{ marginTop: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 13, borderRadius: 12, backgroundColor: colors.text }} accessibilityRole="button">
              <IconImage size={18} color={colors.background} />
              <Text style={{ color: colors.background, fontWeight: '700' }}>{t('stickers.chooseStickers')}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => pick('pack')} style={{ marginTop: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 13, borderRadius: 12, borderWidth: 1, borderColor: colors.text }} accessibilityRole="button">
              <IconPackage size={18} color={colors.text} />
              <Text style={{ color: colors.text, fontWeight: '700' }}>{t('stickers.choosePackFile')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View>
            {images.length ? (
              <View>
                <Text style={{ color: colors.text, fontSize: 15, fontWeight: '700' }}>{t('stickers.importImagesTitle', { count: images.length })}</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 10 }}>
                  {images.slice(0, 30).map((f, i) => (
                    <View key={i} style={{ width: 76, height: 76, margin: 4, borderRadius: 10, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' }}>
                      <ExpoImage source={{ uri: f.uri }} style={{ width: 68, height: 68 }} contentFit="contain" />
                    </View>
                  ))}
                </View>
                <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 14, marginBottom: 8, fontWeight: '700' }}>{t('stickers.destination')}</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                  {chip('mine', t('stickers.myStickers'))}
                  {myPacks.filter(p => p.name !== 'My Stickers').slice(0, 12).map(p => chip(p.id, p.name))}
                  {chip('new', t('stickers.newPack'))}
                </View>
                {dest === 'new' ? (
                  <TextInput value={newName} onChangeText={setNewName} maxLength={60} editable={!running && !finished}
                    placeholder={t('stickers.newPackPlaceholder')} placeholderTextColor={colors.textTertiary || colors.textSecondary}
                    style={{ marginTop: 4, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, color: colors.text, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) }} />
                ) : null}
              </View>
            ) : null}
            {packs.map((f, i) => (
              <View key={'p' + i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: images.length || i ? 16 : 0, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border }}>
                <IconPackage size={26} color={colors.text} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontWeight: '700' }} numberOfLines={1}>{f.name}</Text>
                  <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }}>{t('stickers.packFileHint')}</Text>
                </View>
              </View>
            ))}
            {unknown > 0 ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 }}>
                <IconAlertCircle size={16} color={colors.textSecondary} />
                <Text style={{ color: colors.textSecondary, fontSize: 12, flex: 1 }}>{t('stickers.unsupportedFiles', { count: unknown })}</Text>
              </View>
            ) : null}

            {!finished ? (
              <TouchableOpacity onPress={run} disabled={running || (!images.length && !packs.length) || (dest === 'new' && images.length > 0 && !newName.trim())}
                style={{ marginTop: 22, paddingVertical: 14, borderRadius: 12, alignItems: 'center', backgroundColor: (running || (!images.length && !packs.length)) ? colors.border : colors.text }} accessibilityRole="button">
                {running ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <ActivityIndicator color={colors.background} />
                    {progress ? <Text style={{ color: colors.background, fontWeight: '700' }}>{t('stickers.uploading', { done: progress.done, total: progress.total })}</Text> : null}
                  </View>
                ) : (
                  <Text style={{ color: colors.background, fontWeight: '800', fontSize: 15 }}>
                    {packs.length && !images.length ? t('stickers.importPack') : t('stickers.addToMyStickers')}
                  </Text>
                )}
              </TouchableOpacity>
            ) : (
              <View style={{ marginTop: 22 }}>
                {results.map((r, i) => (
                  <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderTopWidth: i ? 1 : 0, borderTopColor: colors.border }}>
                    {r.ok ? <IconCheck size={20} color={colors.text} /> : <IconAlertCircle size={20} color={colors.text} />}
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: colors.text, fontWeight: '600' }} numberOfLines={2}>
                        {r.ok ? (r.kind === 'pack' ? t('stickers.packImported', { name: r.name, count: r.added }) : t('stickers.savedCount', { count: r.added }))
                          : (r.kind === 'pack' ? t('stickers.packImportFailed', { name: r.name || '' }) : t('stickers.saveFailed'))}
                      </Text>
                      {r.ok && r.skipped ? <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }}>{t('stickers.skippedCount', { count: r.skipped })}</Text> : null}
                    </View>
                    {r.ok && r.packId ? (
                      <TouchableOpacity onPress={() => router.replace({ pathname: '/stickers/pack', params: { id: String(r.packId) } })} hitSlop={8} accessibilityRole="button">
                        <Text style={{ color: colors.text, fontWeight: '700', textDecorationLine: 'underline' }}>{t('stickers.viewPack')}</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                ))}
                <TouchableOpacity onPress={() => { setFiles([]); setResults([]); setProgress(null); }} style={{ marginTop: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border }} accessibilityRole="button">
                  <IconPlus size={16} color={colors.text} />
                  <Text style={{ color: colors.text, fontWeight: '700' }}>{t('stickers.importMore')}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => router.replace('/stickers/my')} style={{ marginTop: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12 }} accessibilityRole="button">
                  <IconFolder size={16} color={colors.textSecondary} />
                  <Text style={{ color: colors.textSecondary, fontWeight: '600' }}>{t('chat.myPacks')}</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
