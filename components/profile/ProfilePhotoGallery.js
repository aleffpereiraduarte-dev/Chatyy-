// components/profile/ProfilePhotoGallery.js — [perfil-fotos 2026-10-19]
//
// Galeria de fotos de perfil em tela cheia (JS): reserva do viewer nativo
// (binário sem expo-media-viewer, web, URL que precisa de Bearer) e a versão
// do DONO (Definir como principal / Apagar). Deslizar para os lados troca a
// foto; pontos de página embaixo; contador "1 de N" em cima.
//
// Uso: monte <ProfilePhotoGalleryHost t={t} /> uma vez na tela (Profile.js,
// app/chat-info/[id].js). Ele escuta services/profilePhotos GALLERY_OPEN_EVENT.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, View, Text, FlatList, Pressable, StyleSheet, useWindowDimensions, DeviceEventEmitter, Platform, ActivityIndicator } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import Svg, { Path, Circle } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  GALLERY_OPEN_EVENT, registerGalleryHost, ppT, setMainProfilePhoto, removeProfilePhoto, galleryList,
} from '../../services/profilePhotos';
import { useCaptureProtectedSurface } from '../../services/chatPrivacy'; // [2026-10-22 print-local]

function CloseGlyph({ size = 22, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round">
      <Path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

function MoreGlyph({ size = 22, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Circle cx="5" cy="12" r="2" />
      <Circle cx="12" cy="12" r="2" />
      <Circle cx="19" cy="12" r="2" />
    </Svg>
  );
}

function _source(url) {
  const u = String(url || '');
  if (!/\/api\//.test(u)) return { uri: u };
  try {
    const ref = require('../chat/NativeProfileBridge').avatarRefForUrl(u, 'full');
    if (ref && ref.uri) return ref.headers ? { uri: ref.uri, headers: ref.headers } : { uri: ref.uri };
  } catch {}
  return { uri: u };
}

export function ProfilePhotoGallery({ visible, list, index = 0, isSelf = false, email = '', t, onClose, onChanged }) {
  const { width: W, height: H } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState(Array.isArray(list) ? list : []);
  const [page, setPage] = useState(index || 0);
  const [busy, setBusy] = useState(false);
  const listRef = useRef(null);
  // [2026-10-22 print-local] Fotos de perfil de outra pessoa: sem print.
  const _secReady = useCaptureProtectedSurface(!!visible && !isSelf, 'chatyy-profile-photo', { t, kind: 'profile_photo' });

  useEffect(() => {
    if (!visible) return;
    setItems(Array.isArray(list) ? list : []);
    setPage(Math.max(0, Number(index) || 0));
  }, [visible, list, index]);

  const onScrollEnd = useCallback((e) => {
    const x = e?.nativeEvent?.contentOffset?.x || 0;
    setPage(Math.max(0, Math.round(x / Math.max(1, W))));
  }, [W]);

  const cur = items[page] || null;

  const applyServer = useCallback((r) => {
    if (!r || !r.success) {
      try { require('../../services/alerts').safeAlert(ppT(t, 'failed'), (r && r.message) || ''); } catch {}
      return;
    }
    const next = galleryList(r.data?.photos || [], null);
    try { onChanged?.(r.data || {}); } catch {}
    if (!next.length) { onClose?.(); return; }
    setItems(next);
    const at = Math.min(page, next.length - 1);
    setPage(at);
    setTimeout(() => { try { listRef.current?.scrollToIndex({ index: at, animated: false }); } catch {} }, 0);
  }, [onChanged, onClose, page, t]);

  const openMenu = useCallback(() => {
    if (!cur || cur.id == null || busy) return;
    const opts = [];
    if (!cur.main) {
      opts.push({ text: ppT(t, 'setMain'), onPress: async () => { setBusy(true); try { applyServer(await setMainProfilePhoto(cur.id, email)); } finally { setBusy(false); } } });
    }
    opts.push({
      text: ppT(t, 'remove'),
      style: 'destructive',
      onPress: () => {
        try {
          require('../../services/alerts').safeAlert(ppT(t, 'removeTitle'), ppT(t, 'removeMsg'), [
            { text: ppT(t, 'cancel'), style: 'cancel' },
            { text: ppT(t, 'remove'), style: 'destructive', onPress: async () => { setBusy(true); try { applyServer(await removeProfilePhoto(cur.id, email)); } finally { setBusy(false); } } },
          ]);
        } catch {}
      },
    });
    opts.push({ text: ppT(t, 'cancel'), style: 'cancel' });
    try { require('../../services/alerts').safeAlert(ppT(t, 'photos'), '', opts); } catch {}
  }, [cur, busy, t, email, applyServer]);

  if (!visible || !_secReady) return null;
  const n = items.length;
  return (
    <Modal visible transparent={false} animationType="fade" onRequestClose={onClose} statusBarTranslucent supportedOrientations={['portrait', 'landscape']}>
      <View style={[st.root, { width: W, height: H }]}>
        <FlatList
          ref={listRef}
          data={items}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={Math.min(page, Math.max(0, n - 1))}
          getItemLayout={(_, i) => ({ length: W, offset: W * i, index: i })}
          keyExtractor={(it, i) => String(it.id != null ? it.id : `m${i}`)}
          onMomentumScrollEnd={onScrollEnd}
          renderItem={({ item }) => (
            <Pressable style={{ width: W, height: H, justifyContent: 'center' }} onPress={onClose} accessibilityRole="image">
              <ExpoImage
                source={_source(item.url)}
                placeholder={item.thumb && item.thumb !== item.url ? _source(item.thumb) : undefined}
                style={{ width: W, height: H }}
                contentFit="contain"
                transition={120}
                cachePolicy="memory-disk"
              />
            </Pressable>
          )}
        />
        <View style={[st.top, { paddingTop: (insets.top || (Platform.OS === 'android' ? 24 : 0)) + 8 }]} pointerEvents="box-none">
          <Pressable onPress={onClose} hitSlop={12} style={st.btn} accessibilityRole="button" accessibilityLabel={ppT(t, 'close')}>
            <CloseGlyph />
          </Pressable>
          <Text style={st.counter}>{n > 1 ? `${page + 1} ${ppT(t, 'of')} ${n}` : ''}</Text>
          {isSelf && cur && cur.id != null ? (
            <Pressable onPress={openMenu} hitSlop={12} style={st.btn} accessibilityRole="button" accessibilityLabel={ppT(t, 'more')}>
              {busy ? <ActivityIndicator color="#fff" /> : <MoreGlyph />}
            </Pressable>
          ) : <View style={st.btn} />}
        </View>
        {n > 1 ? (
          <View style={[st.dots, { bottom: (insets.bottom || 0) + 22 }]} pointerEvents="none">
            {items.slice(0, 20).map((it, i) => (
              <View key={String(it.id != null ? it.id : i)} style={[st.dot, i === page ? st.dotOn : null]} />
            ))}
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

/** Host único por tela: abre quando services/profilePhotos emite GALLERY_OPEN_EVENT. */
export function ProfilePhotoGalleryHost({ t, onChanged }) {
  const [state, setState] = useState(null);
  useEffect(() => {
    const off = registerGalleryHost();
    const sub = DeviceEventEmitter.addListener(GALLERY_OPEN_EVENT, (p) => { if (p && Array.isArray(p.list) && p.list.length) setState(p); });
    return () => { off(); try { sub.remove(); } catch {} };
  }, []);
  const close = useCallback(() => setState(null), []);
  if (!state) return null;
  return (
    <ProfilePhotoGallery
      visible
      list={state.list}
      index={state.index}
      isSelf={state.isSelf}
      email={state.email}
      t={t}
      onClose={close}
      onChanged={onChanged}
    />
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  top: { position: 'absolute', left: 0, right: 0, top: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12 },
  btn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)' },
  counter: { color: '#fff', fontSize: 15, fontWeight: '600' },
  dots: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.4)' },
  dotOn: { backgroundColor: '#fff' },
});

export default ProfilePhotoGalleryHost;
