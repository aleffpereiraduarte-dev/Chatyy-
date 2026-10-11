// [2026-10-11 attach-recent] WhatsApp-style "recent photos & videos" strip at
// the top of the attach sheet (components/chat/AttachSheet.native.js).
//
//   • Horizontal row of the latest 48 photos/videos of the camera roll
//     (expo-media-library — already in the binary; required lazily, any
//     failure = strip simply not rendered → OTA-safe).
//   • Permission is NEVER requested on open: getPermissionsAsync() only. When
//     it was not granted yet a small pre-prompt card explains why and asks on
//     tap ("Permitir acesso"); permanently denied → "Abrir Ajustes".
//     iOS limited access → trailing "Mais fotos" tile (system limited picker).
//   • Tap = toggle selection (numbered, up to 30 — same cap as Galeria);
//     "Enviar (N)" resolves local file URIs (iCloud download when needed) and
//     hands the batch to onSend(files) in the SAME shape handleGallery builds
//     ({ uri, name, type, size, blob:null, width, height, duration }).
//   • Trailing "Galeria" tile opens the full system picker (onOpenGallery).
//   • P&B: neutral tiles, ring/number in text color; 44pt+ targets.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, FlatList as RNFlatList, Image as RNImage, Linking, Platform,
  StyleSheet, Text, View,
} from 'react-native';
import PressableScale from '../PressableScale';
import { IconImage, IconPlay, IconPlus, IconSend } from '../Icons';

const MAX_ASSETS = 48;
const MAX_SELECT = 30;
const TILE = 76;

let _ml; // undefined = unresolved, null = unavailable
function getML() {
  if (_ml !== undefined) return _ml;
  _ml = null;
  if (Platform.OS === 'web') return null;
  try {
    const { requireOptionalNativeModule } = require('expo');
    if (!requireOptionalNativeModule('ExpoMediaLibrary')) return null;
    // eslint-disable-next-line global-require
    const ML = require('expo-media-library');
    if (ML && typeof ML.getAssetsAsync === 'function' && typeof ML.getPermissionsAsync === 'function') _ml = ML;
  } catch { _ml = null; }
  return _ml;
}

let _ExpoImage; // expo-image renders iOS ph:// asset URIs (RN Image does not)
function getExpoImage() {
  if (_ExpoImage !== undefined) return _ExpoImage;
  _ExpoImage = null;
  try {
    // eslint-disable-next-line global-require
    const m = require('expo-image');
    _ExpoImage = (m && m.Image) || null;
  } catch { _ExpoImage = null; }
  return _ExpoImage;
}

let _haptics = null;
function tick() {
  try {
    if (!_haptics) _haptics = require('../../services/haptics');
    _haptics.selection();
  } catch {}
}

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', '3gp': 'video/3gpp', webm: 'video/webm',
};

function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

async function fileSize(uri) {
  try {
    let FS;
    try { FS = require('expo-file-system/legacy'); } catch { FS = require('expo-file-system'); }
    if (!FS || typeof FS.getInfoAsync !== 'function') return 0;
    const info = await FS.getInfoAsync(uri);
    return (info && info.exists && info.size) || 0;
  } catch { return 0; }
}

async function toFile(ML, asset, idx) {
  let uri = asset.uri || '';
  // iOS: ph:// → real file (downloads from iCloud when the original is
  // offloaded). Android: asset.uri is already file://.
  if (Platform.OS === 'ios' || !uri.startsWith('file:')) {
    try {
      const info = await ML.getAssetInfoAsync(asset, { shouldDownloadFromNetwork: true });
      uri = (info && (info.localUri || info.uri)) || uri;
    } catch {}
  }
  if (!uri || uri.startsWith('ph://')) return null;
  const isVideo = asset.mediaType === 'video';
  const fname = String(asset.filename || '');
  const m = (fname || uri).match(/\.([a-z0-9]{2,5})(?:\?|$)/i);
  const ext = m ? m[1].toLowerCase() : (isVideo ? 'mp4' : 'jpg');
  return {
    uri,
    name: fname || `media_${Date.now()}${idx ? '_' + idx : ''}.${ext}`,
    type: MIME[ext] || (isVideo ? 'video/mp4' : 'image/jpeg'),
    blob: null,
    size: await fileSize(uri),
    width: asset.width || 0,
    height: asset.height || 0,
    duration: isVideo ? (asset.duration || 0) : 0,
  };
}

/** True when this binary can show the strip at all (module present, native). */
export function recentStripSupported() {
  return !!getML();
}

export default function AttachSheetRecentStrip({
  visible, dark, colors, t, onSend, onOpenGallery, galleryLabel, ListComponent,
}) {
  const ML = getML();
  const ExpoImage = getExpoImage();
  const [perm, setPerm] = useState(null); // null | { granted, canAskAgain, limited }
  const [assets, setAssets] = useState([]);
  const [sel, setSel] = useState([]); // asset ids, in tap order
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const tx = useCallback((k, fb, params) => {
    try {
      const v = t ? t(k, params) : null;
      return v && v !== k ? v : fb;
    } catch { return fb; }
  }, [t]);

  const load = useCallback(async () => {
    if (!ML) return;
    try {
      const p = await ML.getPermissionsAsync(false, ['photo', 'video']);
      const st = {
        granted: !!p?.granted,
        canAskAgain: p?.canAskAgain !== false,
        limited: p?.accessPrivileges === 'limited',
      };
      if (!alive.current) return;
      setPerm(st);
      if (!st.granted) { setAssets([]); return; }
      const res = await ML.getAssetsAsync({
        first: MAX_ASSETS,
        sortBy: [[(ML.SortBy && ML.SortBy.creationTime) || 'creationTime', false]],
        mediaType: [(ML.MediaType && ML.MediaType.photo) || 'photo', (ML.MediaType && ML.MediaType.video) || 'video'],
      });
      if (alive.current) setAssets((res && res.assets) || []);
    } catch {
      if (alive.current) setAssets([]);
    }
  }, [ML]);

  useEffect(() => {
    if (visible) load();
    else { setSel([]); setBusy(false); }
  }, [visible, load]);

  const askPermission = useCallback(async () => {
    if (!ML) return;
    tick();
    try {
      if (perm && !perm.canAskAgain) { Linking.openSettings().catch(() => {}); return; }
      await ML.requestPermissionsAsync(false, ['photo', 'video']);
    } catch {}
    load();
  }, [ML, perm, load]);

  const manageLimited = useCallback(async () => {
    if (!ML || typeof ML.presentPermissionsPickerAsync !== 'function') return;
    try { await ML.presentPermissionsPickerAsync(['photo', 'video']); } catch {}
    load();
  }, [ML, load]);

  const toggle = useCallback((id) => {
    tick();
    setSel((s) => {
      if (s.includes(id)) return s.filter((x) => x !== id);
      if (s.length >= MAX_SELECT) return s;
      return [...s, id];
    });
  }, []);

  const send = useCallback(async () => {
    if (!ML || busy || !sel.length) return;
    setBusy(true);
    try {
      const byId = new Map(assets.map((a) => [a.id, a]));
      const picked = sel.map((id) => byId.get(id)).filter(Boolean);
      const files = (await Promise.all(picked.map((a, i) => toFile(ML, a, i)))).filter(Boolean);
      if (!alive.current) return;
      if (files.length) {
        setSel([]);
        onSend && onSend(files);
      }
    } catch {} finally {
      if (alive.current) setBusy(false);
    }
  }, [ML, busy, sel, assets, onSend]);

  const fg = colors?.text || (dark ? '#ffffff' : '#000000');
  const sub = colors?.textSecondary || fg;
  const tileBg = dark ? '#2c2c2e' : '#f2f2f4';
  const ring = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

  const data = useMemo(() => {
    const list = assets.map((a) => ({ kind: 'asset', a, key: a.id }));
    if (perm?.limited && Platform.OS === 'ios') list.push({ kind: 'manage', key: '__manage' });
    list.push({ kind: 'gallery', key: '__gallery' });
    return list;
  }, [assets, perm]);

  const renderItem = useCallback(({ item }) => {
    if (item.kind !== 'asset') {
      const isGallery = item.kind === 'gallery';
      const label = isGallery ? (galleryLabel || tx('chatConv.gallery', 'Galeria')) : tx('chat.attach.recentMore', 'Mais fotos');
      return (
        <PressableScale
          onPress={isGallery ? onOpenGallery : manageLimited}
          haptic="light"
          scaleTo={0.94}
          style={[st.tile, st.actionTile, { backgroundColor: tileBg, borderColor: ring }]}
          accessibilityRole="button"
          accessibilityLabel={label}
        >
          {isGallery ? <IconImage size={22} color={fg} /> : <IconPlus size={22} color={fg} />}
          <Text style={[st.actionLabel, { color: sub }]} numberOfLines={1}>{label}</Text>
        </PressableScale>
      );
    }
    const a = item.a;
    const n = sel.indexOf(a.id);
    const on = n >= 0;
    const isVideo = a.mediaType === 'video';
    const Img = ExpoImage || RNImage;
    const imgProps = ExpoImage
      ? { contentFit: 'cover', recyclingKey: a.id, transition: 120, cachePolicy: 'memory' }
      : { resizeMode: 'cover' };
    return (
      <PressableScale
        onPress={() => toggle(a.id)}
        haptic={false}
        scaleTo={0.94}
        style={[st.tile, { backgroundColor: tileBg }]}
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        accessibilityLabel={(isVideo ? tx('chat.attach.recentVideo', 'Vídeo') : tx('chat.attach.recentPhoto', 'Foto'))
          + (on ? ', ' + tx('chat.attach.recentSelected', 'selecionada') : '')}
      >
        <Img source={{ uri: a.uri }} style={st.img} {...imgProps} />
        {on ? <View style={[StyleSheet.absoluteFill, st.dim]} pointerEvents="none" /> : null}
        {isVideo ? (
          <View style={st.vid} pointerEvents="none">
            <IconPlay size={9} color="#fff" />
            <Text style={st.vidTxt}>{fmtDur(a.duration)}</Text>
          </View>
        ) : null}
        <View
          pointerEvents="none"
          style={[st.check, on ? { backgroundColor: '#ffffff', borderColor: '#ffffff' } : null]}
        >
          {on ? <Text style={st.checkTxt}>{n + 1}</Text> : null}
        </View>
      </PressableScale>
    );
  }, [sel, ExpoImage, tileBg, ring, fg, sub, toggle, onOpenGallery, manageLimited, galleryLabel, tx]);

  if (!ML || !perm) return null;

  // Pre-prompt (never asks on its own).
  if (!perm.granted) {
    const denied = !perm.canAskAgain;
    return (
      <View style={[st.prompt, { backgroundColor: tileBg, borderColor: ring }]}>
        <View style={[st.promptIcon, { borderColor: ring }]}>
          <IconImage size={22} color={fg} />
        </View>
        <Text style={[st.promptTxt, { color: sub }]} numberOfLines={3}>
          {tx('chat.attach.recentPrompt', 'Permita o acesso às fotos para enviar as mais recentes com um toque.')}
        </Text>
        <PressableScale
          onPress={askPermission}
          haptic={false}
          scaleTo={0.95}
          style={[st.promptBtn, { backgroundColor: fg }]}
          accessibilityRole="button"
        >
          <Text style={[st.promptBtnTxt, { color: dark ? '#000000' : '#ffffff' }]} numberOfLines={1}>
            {denied ? tx('chat.attach.recentSettings', 'Abrir Ajustes') : tx('chat.attach.recentAllow', 'Permitir acesso')}
          </Text>
        </PressableScale>
      </View>
    );
  }

  const List = ListComponent || RNFlatList;
  return (
    <View style={st.wrap}>
      <List
        horizontal
        data={data}
        keyExtractor={(it) => it.key}
        renderItem={renderItem}
        extraData={sel}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={st.row}
        initialNumToRender={6}
        maxToRenderPerBatch={8}
        windowSize={5}
        removeClippedSubviews={Platform.OS === 'android'}
        getItemLayout={(_, index) => ({ length: TILE + 6, offset: (TILE + 6) * index, index })}
      />
      {sel.length > 0 ? (
        <PressableScale
          onPress={send}
          disabled={busy}
          haptic="medium"
          scaleTo={0.97}
          style={[st.sendBtn, { backgroundColor: fg }]}
          accessibilityRole="button"
          accessibilityLabel={tx('chat.attach.recentSend', `Enviar (${sel.length})`, { count: sel.length })}
        >
          {busy ? (
            <ActivityIndicator size="small" color={dark ? '#000000' : '#ffffff'} />
          ) : (
            <>
              <IconSend size={17} color={dark ? '#000000' : '#ffffff'} />
              <Text style={[st.sendTxt, { color: dark ? '#000000' : '#ffffff' }]}>
                {tx('chat.attach.recentSend', `Enviar (${sel.length})`, { count: sel.length })}
              </Text>
            </>
          )}
        </PressableScale>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { alignSelf: 'stretch', marginBottom: 14 },
  row: { paddingHorizontal: 12 },
  tile: {
    width: TILE, height: TILE, borderRadius: 12, overflow: 'hidden', marginRight: 6,
  },
  img: { width: '100%', height: '100%' },
  dim: { backgroundColor: 'rgba(0,0,0,0.28)' },
  actionTile: {
    alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 4,
  },
  actionLabel: { fontSize: 11.5, fontWeight: '500', marginTop: 6, letterSpacing: -0.1 },
  vid: {
    position: 'absolute', left: 5, bottom: 5, flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 5, height: 17, borderRadius: 8.5, backgroundColor: 'rgba(0,0,0,0.55)',
  },
  vidTxt: { color: '#fff', fontSize: 10.5, fontWeight: '600', marginLeft: 3, fontVariant: ['tabular-nums'] },
  check: {
    position: 'absolute', top: 6, right: 6, width: 22, height: 22, borderRadius: 11,
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.95)', backgroundColor: 'rgba(0,0,0,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  checkTxt: { color: '#000', fontSize: 11.5, fontWeight: '800' },
  sendBtn: {
    marginTop: 10, marginHorizontal: 12, height: 46, borderRadius: 23,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
  },
  sendTxt: { fontSize: 15.5, fontWeight: '700', marginLeft: 8, letterSpacing: -0.2 },
  prompt: {
    alignSelf: 'stretch', marginHorizontal: 12, marginBottom: 14, padding: 12, borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center',
  },
  promptIcon: {
    width: 44, height: 44, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center', justifyContent: 'center',
  },
  promptTxt: { flex: 1, fontSize: 13, lineHeight: 17, marginHorizontal: 10 },
  promptBtn: { minHeight: 44, minWidth: 44, paddingHorizontal: 14, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  promptBtnTxt: { fontSize: 13.5, fontWeight: '700' },
});
