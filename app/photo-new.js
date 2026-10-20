// =============================================================================
// /photo-new — compositor "Publicar no perfil" (nível Instagram)
//
// [perfil-publicar 2026-10-19] Reescrito. Antes: o seletor abria ANTES desta tela
// e o push do modal logo depois da saída do PHPicker era recusado pelo UIKit → a
// tela montava e sumia em ~2 s ("Publicar no perfil não funciona"). Agora:
//   • Entrada: /photo-new?pick=library|camera&from=profile|photos|settings
//     → a tela abre primeiro e chama o seletor quando a transição acabou.
//     Compat: itens entregues em memória (profilePostComposer.openPostComposer)
//     ou na chave antiga AsyncStorage `photoNew.pending` (nunca mais router.back
//     só porque a chave sumiu — mostra o estado vazio com "Adicionar").
//   • Carrossel até 10 (foto + vídeo misturados), formato Quadrado 1:1 /
//     Retrato 4:5 / Original (fotos recortadas no centro no envio; prévia = recorte),
//     editar foto (PhotoEditor), remover, reordenar (segurar miniatura → tocar outra).
//   • Legenda (2200) + quem pode ver: Todos / Meus contatos (servidor audience=contacts).
//   • Publicar com barra de progresso real (XHR), client_post_id (re-tentar não
//     duplica) e "Tentar de novo" sem perder nada.
//   • Fim: invalida cache do perfil, avisa (toast) e volta ao perfil — o post entra
//     na grade (/u e Dados do contato, com a regra de audiência do servidor).
// =============================================================================

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, TextInput, Image as RNImage,
  ActivityIndicator, Platform, KeyboardAvoidingView, ScrollView, InteractionManager,
  Alert, DeviceEventEmitter,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';

import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { Spacing, FontSize, BorderRadius, Shadow } from '../constants/theme';
import * as api from '../services/api';
import { setCache, getCached } from '../services/cache';
import {
  IconX, IconEdit, IconPlus, IconPlay, IconImage, IconUsers, IconGlobe, IconCheck,
} from '../components/Icons';
import PhotoEditor from '../components/PhotoEditor';
import PressableScale from '../components/PressableScale';
import {
  pcT, pickPostMedia, takePendingPostItems, showActionMenu, POST_MAX_ITEMS, POSTS_CHANGED_EVENT,
} from '../services/profilePostComposer';
// [post-perfil 2026-10-20] Publicar = fila durável (fecha na hora; upload em 2º plano).
import { enqueueProfilePost, isProfilePostQueueEnabled } from '../services/profilePostQueue';

const MAX_CAPTION = 2200;
const ASPECTS = [
  { key: '1:1', ratio: 1, label: 'square' },
  { key: '4:5', ratio: 0.8, label: 'portrait' },
  { key: 'orig', ratio: 1, label: 'original' },
];

// Vídeo da prévia (só o slide ativo monta player). expo-video ausente → pôster.
let _ExpoVideo = null;
function _loadExpoVideo() {
  if (_ExpoVideo !== null) return _ExpoVideo;
  if (Platform.OS === 'web') { _ExpoVideo = false; return false; }
  try { _ExpoVideo = require('expo-video'); } catch { _ExpoVideo = false; }
  return _ExpoVideo;
}
function VideoPreview({ uri, fit }) {
  const mod = _loadExpoVideo();
  if (!mod || !mod.useVideoPlayer || !mod.VideoView) return null;
  return <VideoPreviewInner mod={mod} uri={uri} fit={fit} />;
}
function VideoPreviewInner({ mod, uri, fit }) {
  const player = mod.useVideoPlayer(uri, (p) => { try { p.loop = true; p.muted = true; p.play(); } catch {} });
  return <mod.VideoView player={player} style={StyleSheet.absoluteFill} contentFit={fit} nativeControls={false} />;
}

function getSize(uri) {
  return new Promise((resolve) => {
    try { RNImage.getSize(uri, (w, h) => resolve({ w, h }), () => resolve(null)); } catch { resolve(null); }
  });
}

/** Recorta (centro) no formato escolhido e limita a 2160 px de largura. */
async function prepareImage(it, aspectKey) {
  let IM = null;
  try { IM = require('expo-image-manipulator'); } catch { IM = null; }
  if (!IM || typeof IM.manipulateAsync !== 'function' || Platform.OS === 'web') return it;
  const sz = await getSize(it.uri);
  const w = sz?.w || it.width || 0;
  const h = sz?.h || it.height || 0;
  if (!w || !h) return it;
  const actions = [];
  let cw = w; let ch = h;
  const asp = ASPECTS.find((a) => a.key === aspectKey);
  if (asp && aspectKey !== 'orig') {
    const target = asp.ratio; // largura / altura
    if (w / h > target) { cw = Math.round(h * target); ch = h; } else { cw = w; ch = Math.round(w / target); }
    cw = Math.min(cw, w); ch = Math.min(ch, h);
    actions.push({ crop: { originX: Math.max(0, Math.floor((w - cw) / 2)), originY: Math.max(0, Math.floor((h - ch) / 2)), width: cw, height: ch } });
  }
  if (cw > 2160) actions.push({ resize: { width: 2160 } });
  if (!actions.length && /jpe?g/i.test(it.mimeType || '')) return it;
  try {
    const out = await IM.manipulateAsync(it.uri, actions, { compress: 0.88, format: IM.SaveFormat?.JPEG || 'jpeg' });
    if (out?.uri) {
      const base = String(it.fileName || 'photo').replace(/\.[a-z0-9]{2,5}$/i, '');
      return { ...it, uri: out.uri, width: out.width, height: out.height, mimeType: 'image/jpeg', fileName: `${base}.jpg` };
    }
  } catch {}
  return it;
}

function uploadWithProgress(formData, onProgress) {
  return new Promise((resolve) => {
    const token = api.getAuthToken?.() || '';
    const base = (api.getApiUrl?.() || '').split('?')[0];
    if (!base || !token || typeof XMLHttpRequest === 'undefined') {
      api.feedCreatePost(formData).then(resolve, (e) => resolve({ success: false, message: e?.message || '' }));
      return;
    }
    const xhr = new XMLHttpRequest();
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    try {
      xhr.open('POST', `${base}?action=feed_create_post`);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      try {
        const h = api.getAuthHeaders?.() || {};
        Object.keys(h).forEach((k) => { if (/^x-/i.test(k)) { try { xhr.setRequestHeader(k, h[k]); } catch {} } });
      } catch {}
      xhr.timeout = 15 * 60 * 1000;
      if (xhr.upload) {
        xhr.upload.onprogress = (e) => {
          if (e && e.lengthComputable && e.total > 0) { try { onProgress(Math.min(1, e.loaded / e.total)); } catch {} }
        };
      }
      xhr.onload = () => {
        let j = null;
        try { j = JSON.parse(xhr.responseText || ''); } catch { j = null; }
        if (j && typeof j === 'object') { finish(j); return; }
        finish({ success: false, message: xhr.status === 413 ? 'Arquivo muito grande' : `HTTP ${xhr.status}` });
      };
      xhr.onerror = () => finish({ success: false, message: 'Sem conexão' });
      xhr.ontimeout = () => finish({ success: false, message: 'Tempo limite excedido' });
      xhr.send(formData);
    } catch (e) {
      finish({ success: false, message: e?.message || '' });
    }
  });
}

const newClientId = () => `pp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export default function PhotoNew() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const pickParam = String(params?.pick || '');
  const fromParam = String(params?.from || '');
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();

  const [items, setItems] = useState([]);
  const [hydrated, setHydrated] = useState(false);
  const [picking, setPicking] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [caption, setCaption] = useState('');
  const [aspect, setAspect] = useState('1:1');
  const [audience, setAudience] = useState('everyone');
  const [phase, setPhase] = useState('idle'); // idle | preparing | uploading | finishing | error
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [editorOpenForIdx, setEditorOpenForIdx] = useState(-1);
  const [reorderFromIdx, setReorderFromIdx] = useState(-1);
  const carouselRef = useRef(null);
  const [carouselWidth, setCarouselWidth] = useState(0);
  const clientIdRef = useRef(newClientId());
  const busy = phase === 'preparing' || phase === 'uploading' || phase === 'finishing';
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Conteúdo mudou → nova chave de idempotência (re-tentar o MESMO conteúdo reaproveita).
  useEffect(() => { clientIdRef.current = newClientId(); }, [items, aspect, audience, caption]);

  const runPicker = useCallback(async (mode, { closeIfEmpty = false } = {}) => {
    const remaining = POST_MAX_ITEMS - items.length;
    if (remaining <= 0) { Alert.alert(pcT('maxReached')); return; }
    setPicking(true);
    let got = null;
    try { got = await pickPostMedia({ mode, limit: remaining }); } catch (e) {
      got = null;
      try { Alert.alert(pcT('failed'), e?.message || ''); } catch {}
    }
    if (!mountedRef.current) return;
    setPicking(false);
    if (got && got.length) {
      setItems((prev) => prev.concat(got).slice(0, POST_MAX_ITEMS));
    } else if (closeIfEmpty) {
      router.back();
    }
  }, [items.length, router]);

  // ----- Itens iniciais / seletor automático -----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let list = takePendingPostItems();
      if (!list) {
        try {
          const raw = await AsyncStorage.getItem('photoNew.pending');
          if (raw) { const j = JSON.parse(raw); if (Array.isArray(j) && j.length) list = j; }
        } catch {}
        AsyncStorage.removeItem('photoNew.pending').catch(() => {});
      }
      if (cancelled) return;
      if (list && list.length) {
        setItems(list.slice(0, POST_MAX_ITEMS));
        setHydrated(true);
        return;
      }
      setHydrated(true);
      if (pickParam === 'library' || pickParam === 'camera') {
        // Espera a apresentação desta tela terminar: o UIKit ignora (em silêncio)
        // apresentar o PHPicker sobre um modal ainda animando.
        await new Promise((r) => { try { if (InteractionManager?.runAfterInteractions) { InteractionManager.runAfterInteractions(() => r()); return; } } catch {} r(); });
        await new Promise((r) => setTimeout(r, Platform.OS === 'ios' ? 420 : 120));
        if (cancelled || !mountedRef.current) return;
        runPicker(pickParam, { closeIfEmpty: true });
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ----- Carrossel -----
  const handleScrollEnd = useCallback((e) => {
    const w = e.nativeEvent.layoutMeasurement.width || carouselWidth || 1;
    setActiveIndex(Math.max(0, Math.round(e.nativeEvent.contentOffset.x / w)));
  }, [carouselWidth]);

  const jumpTo = useCallback((idx) => {
    if (!carouselRef.current || carouselWidth === 0) return;
    try { carouselRef.current.scrollToOffset({ offset: idx * carouselWidth, animated: true }); } catch {}
    setActiveIndex(idx);
  }, [carouselWidth]);

  const removeAt = useCallback((idx) => {
    setItems((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      setActiveIndex((curr) => Math.max(0, Math.min(curr, next.length - 1)));
      return next;
    });
  }, []);

  const onThumbPress = useCallback((idx) => {
    if (reorderFromIdx === -1) { jumpTo(idx); return; }
    if (reorderFromIdx === idx) { setReorderFromIdx(-1); return; }
    setItems((prev) => {
      const next = [...prev];
      const tmp = next[reorderFromIdx];
      next[reorderFromIdx] = next[idx];
      next[idx] = tmp;
      return next;
    });
    setReorderFromIdx(-1);
    setActiveIndex(idx);
  }, [reorderFromIdx, jumpTo]);

  const openEditor = useCallback((idx) => {
    if (items[idx]?.type === 'video') return;
    setEditorOpenForIdx(idx);
  }, [items]);

  const handleEditorSave = useCallback((newUri) => {
    const idx = editorOpenForIdx;
    setEditorOpenForIdx(-1);
    if (idx < 0 || !newUri) return;
    setItems((prev) => {
      const next = [...prev];
      if (next[idx]) next[idx] = { ...next[idx], uri: newUri, width: 0, height: 0, mimeType: 'image/jpeg' };
      return next;
    });
  }, [editorOpenForIdx]);

  const addMenu = useCallback(() => {
    if (busy) return;
    if (Platform.OS === 'web') { runPicker('library'); return; }
    showActionMenu({
      options: [
        { label: pcT('fromLibrary'), onPress: () => setTimeout(() => runPicker('library'), Platform.OS === 'ios' ? 380 : 0) },
        { label: pcT('camera'), onPress: () => setTimeout(() => runPicker('camera'), Platform.OS === 'ios' ? 380 : 0) },
      ],
    });
  }, [busy, runPicker]);

  const close = useCallback(() => {
    if (busy) return;
    if (!items.length && !caption.trim()) { router.back(); return; }
    Alert.alert(pcT('discardTitle'), pcT('discardMsg'), [
      { text: pcT('keep'), style: 'cancel' },
      { text: pcT('discard'), style: 'destructive', onPress: () => router.back() },
    ]);
  }, [busy, items.length, caption, router]);

  // ----- Publicar -----
  const enqueuedRef = useRef(false);
  const publish = useCallback(async () => {
    if (busy || items.length === 0) return;
    // [post-perfil 2026-10-20] modelo Instagram: a folha fecha JÁ e o post aparece no topo
    // do perfil com as imagens locais + progresso; preparo (2048 px / JPEG 0,8), upload
    // paralelo no edge e confirmação seguem na fila durável (services/profilePostQueue).
    // Antes: preparo + POST multipart das originais com a folha aberta, esperando o servidor.
    if (isProfilePostQueueEnabled()) {
      if (enqueuedRef.current) return;
      const me = String(user?.email || '').trim();
      try {
        enqueueProfilePost({ id: clientIdRef.current, email: me, items, caption: caption.trim(), audience, aspect });
      } catch (e) {
        setPhase('error');
        setErrorMsg(e?.message || '');
        return;
      }
      enqueuedRef.current = true;
      try { require('../services/haptics').hapticEvent?.('send'); } catch {}
      if (fromParam === 'profile' || !me) router.back();
      else router.replace(`/u/${encodeURIComponent(me)}`);
      return;
    }
    setErrorMsg('');
    setProgress(0);
    setPhase('preparing');
    try {
      const prepared = [];
      for (const it of items) {
        prepared.push(it.type === 'image' ? await prepareImage(it, aspect) : it);
      }
      if (!mountedRef.current) return;
      const formData = new FormData();
      formData.append('caption', caption.trim());
      formData.append('media_type', prepared[0]?.type === 'video' ? 'video' : 'image');
      formData.append('audience', audience);
      formData.append('client_post_id', clientIdRef.current);
      formData.append('post_aspect', aspect);
      for (const it of prepared) {
        if (Platform.OS === 'web') {
          try {
            const res = await fetch(it.uri);
            const blob = await res.blob();
            formData.append('media[]', blob, it.fileName);
          } catch {}
        } else {
          formData.append('media[]', { uri: it.uri, name: it.fileName, type: it.mimeType });
        }
      }
      setPhase('uploading');
      const r = Platform.OS === 'web'
        ? await api.feedCreatePost(formData)
        : await uploadWithProgress(formData, (p) => { if (mountedRef.current) { setProgress(p); if (p >= 0.999) setPhase('finishing'); } });
      if (!mountedRef.current) return;
      if (!r || !r.success) {
        setPhase('error');
        setErrorMsg(String((r && (r.message || r.error)) || ''));
        return;
      }
      const newPost = r?.data?.post || null;
      // Caches: perfil (memória/disco) + feed.
      try { require('../components/Profile').invalidateProfileCache?.(); } catch {}
      try {
        if (newPost) {
          const cached = (await getCached('feed_posts').catch(() => null)) || [];
          const dedup = Array.isArray(cached) ? cached.filter((p) => p?.id !== newPost.id) : [];
          await setCache('feed_posts', [{ ...newPost, created_at: new Date().toISOString() }, ...dedup].slice(0, 200), 7776000000);
        }
      } catch {}
      try { DeviceEventEmitter.emit(POSTS_CHANGED_EVENT, { created: newPost }); } catch {}
      try { require('../services/haptics').hapticEvent?.('success'); } catch {}
      try { require('../components/ui/Toast').showToast({ message: pcT('published'), kind: 'success' }); } catch {}
      setPhase('idle');
      const me = String(user?.email || '').trim();
      if (fromParam === 'profile' || !me) router.back();
      else router.replace(`/u/${encodeURIComponent(me)}`);
    } catch (e) {
      if (!mountedRef.current) return;
      setPhase('error');
      setErrorMsg(e?.message || '');
    }
  }, [busy, items, aspect, caption, audience, router, fromParam, user?.email]);

  // ----- Estilos -----
  const ratio = (ASPECTS.find((a) => a.key === aspect) || ASPECTS[0]).ratio;
  const fit = aspect === 'orig' ? 'contain' : 'cover';
  const chipBg = isDark ? 'rgba(255,255,255,0.08)' : '#F1F3F5';
  const chipOnBg = isDark ? '#FFFFFF' : '#111111';
  const chipOnFg = isDark ? '#000000' : '#FFFFFF';
  const s = useMemo(() => StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: Spacing.md, paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
    },
    headerBtn: { padding: 8, minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
    headerTitle: { fontSize: FontSize.lg, fontWeight: '700', color: colors.text },
    publishBtn: {
      paddingHorizontal: 16, height: 36, borderRadius: 18, justifyContent: 'center',
      backgroundColor: chipOnBg, minWidth: 92, alignItems: 'center',
    },
    publishBtnDisabled: { opacity: 0.4 },
    publishText: { color: chipOnFg, fontWeight: '700', fontSize: FontSize.sm },
    progressTrack: { height: 3, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' },
    progressFill: { height: 3, backgroundColor: colors.text },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: Spacing.md, paddingVertical: 8 },
    statusText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600', flex: 1 },
    errorBox: {
      flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: Spacing.md, marginTop: 10,
      padding: 12, borderRadius: 14, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#F6F6F7',
    },
    errorTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
    errorSub: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
    retryBtn: { paddingHorizontal: 14, height: 34, borderRadius: 17, backgroundColor: chipOnBg, justifyContent: 'center' },
    retryText: { color: chipOnFg, fontSize: 13, fontWeight: '700' },
    carouselWrap: { width: '100%', backgroundColor: isDark ? '#000' : '#0b0b0c', overflow: 'hidden' },
    slide: { height: '100%', justifyContent: 'center', alignItems: 'center', overflow: 'hidden' },
    perItemBtns: { position: 'absolute', top: 12, right: 12, flexDirection: 'row', gap: 10, zIndex: 50, elevation: 50 },
    iconBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', ...Shadow.sm },
    videoBadge: {
      position: 'absolute', bottom: 12, left: 12, backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 10, paddingVertical: 4,
      borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 4,
    },
    counterBadge: { position: 'absolute', top: 14, left: 12, backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 9, paddingVertical: 3, borderRadius: 11 },
    badgeText: { color: '#fff', fontSize: 12, fontWeight: '600' },
    dotsRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', paddingTop: 10, gap: 5 },
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: isDark ? '#3f3f46' : '#d4d4d8' },
    dotActive: { backgroundColor: colors.text },
    sectionLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '700', letterSpacing: 0.3, paddingHorizontal: Spacing.md, paddingTop: 14, paddingBottom: 8, textTransform: 'uppercase' },
    chipsRow: { flexDirection: 'row', gap: 8, paddingHorizontal: Spacing.md },
    chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 34, borderRadius: 17, backgroundColor: chipBg },
    chipOn: { backgroundColor: chipOnBg },
    chipText: { fontSize: 13, fontWeight: '600', color: colors.text },
    chipTextOn: { color: chipOnFg },
    hint: { color: colors.textTertiary || colors.textSecondary, fontSize: 12, paddingHorizontal: Spacing.md, paddingTop: 6 },
    thumbsStrip: { paddingHorizontal: Spacing.md, paddingVertical: 12, gap: 8 },
    thumb: { width: 58, height: 58, borderRadius: 10, backgroundColor: '#222', borderWidth: 2, borderColor: 'transparent', overflow: 'hidden' },
    thumbActive: { borderColor: colors.text },
    thumbReorder: { borderColor: isDark ? '#FFFFFF' : '#111111', borderWidth: 3, opacity: 0.7 },
    thumbImg: { width: '100%', height: '100%' },
    thumbVid: { position: 'absolute', right: 3, bottom: 3 },
    addMoreTile: {
      width: 58, height: 58, borderRadius: 10, borderWidth: 1.5, borderStyle: 'dashed',
      borderColor: isDark ? '#52525b' : '#a1a1aa', justifyContent: 'center', alignItems: 'center',
    },
    captionWrap: {
      paddingHorizontal: Spacing.md, paddingVertical: 12, marginTop: 6,
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
    },
    captionInput: { color: colors.text, fontSize: FontSize.md, minHeight: 64, maxHeight: 180, paddingTop: 0, textAlignVertical: 'top' },
    counter: { fontSize: 11, color: colors.textTertiary || colors.textSecondary, textAlign: 'right', paddingHorizontal: Spacing.md },
    reorderHint: { paddingHorizontal: Spacing.md, fontSize: 12, color: colors.textSecondary, fontWeight: '600' },
  }), [colors, isDark, chipBg, chipOnBg, chipOnFg]);

  const statusLabel = phase === 'preparing' ? pcT('preparing')
    : phase === 'uploading' ? pcT('sending', { p: Math.round(progress * 100) })
    : phase === 'finishing' ? pcT('finishing') : '';

  const renderSlide = ({ item, index }) => (
    <View style={[s.slide, { width: carouselWidth }]}>
      {item.type === 'video' ? (
        index === activeIndex ? <VideoPreview uri={item.uri} fit={fit} /> : (
          <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
            <IconPlay size={34} color="#fff" />
          </View>
        )
      ) : (
        <ExpoImage source={{ uri: item.uri }} style={StyleSheet.absoluteFill} contentFit={fit} />
      )}
      {item.type === 'video' && (
        <View style={s.videoBadge}>
          <IconPlay size={12} color="#fff" />
          <Text style={s.badgeText}>{pcT('video')}</Text>
        </View>
      )}
      {!busy && (
        <View style={s.perItemBtns}>
          {item.type !== 'video' && (
            <TouchableOpacity style={s.iconBtn} onPress={() => openEditor(index)} accessibilityLabel={pcT('editPhoto')}>
              <IconEdit size={17} color="#fff" />
            </TouchableOpacity>
          )}
          <TouchableOpacity style={s.iconBtn} onPress={() => removeAt(index)} accessibilityLabel={pcT('removeItem')}>
            <IconX size={19} color="#fff" />
          </TouchableOpacity>
        </View>
      )}
    </View>
  );

  return (
    <View style={[s.root, { paddingTop: insets.top + 4 }]}>
      <View style={s.header}>
        <TouchableOpacity onPress={close} disabled={busy} style={s.headerBtn} accessibilityLabel={pcT('cancel')} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <IconX size={26} color={busy ? colors.textTertiary || colors.textSecondary : colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>{pcT('newPost')}</Text>
        <TouchableOpacity
          onPress={publish}
          disabled={busy || items.length === 0}
          style={[s.publishBtn, (busy || items.length === 0) && s.publishBtnDisabled]}
          accessibilityLabel={pcT('publish')}
        >
          {busy ? <ActivityIndicator size="small" color={chipOnFg} /> : <Text style={s.publishText}>{pcT('publish')}</Text>}
        </TouchableOpacity>
      </View>
      {busy && (
        <>
          <View style={s.progressTrack}>
            <View style={[s.progressFill, { width: `${Math.max(4, Math.round((phase === 'uploading' ? progress : phase === 'finishing' ? 1 : 0.03) * 100))}%` }]} />
          </View>
          <View style={s.statusRow}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
            <Text style={s.statusText}>{statusLabel}</Text>
          </View>
        </>
      )}
      {phase === 'error' && (
        <View style={s.errorBox}>
          <View style={{ flex: 1 }}>
            <Text style={s.errorTitle}>{pcT('failed')}</Text>
            {!!errorMsg && <Text style={s.errorSub} numberOfLines={2}>{errorMsg}</Text>}
          </View>
          <TouchableOpacity style={s.retryBtn} onPress={publish} accessibilityRole="button">
            <Text style={s.retryText}>{pcT('retry')}</Text>
          </TouchableOpacity>
        </View>
      )}

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={insets.top + 50}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 24 + insets.bottom }} pointerEvents={busy ? 'none' : 'auto'}>
          <View
            style={[s.carouselWrap, { aspectRatio: items.length ? ratio : 1 }, !items.length && { backgroundColor: isDark ? '#0d0d0f' : '#F2F2F7' }]}
            onLayout={(e) => setCarouselWidth(e.nativeEvent.layout.width)}
          >
            {items.length === 0 && (
              hydrated && !picking ? (
                <PressableScale onPress={addMenu} haptic="light" accessibilityRole="button" accessibilityLabel={pcT('add')}
                  style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 32 }}>
                  <View style={{ width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center', backgroundColor: isDark ? '#1c1c1e' : '#FFFFFF', borderWidth: StyleSheet.hairlineWidth, borderColor: isDark ? '#2c2c2e' : '#E5E5EA' }}>
                    <IconImage size={34} color={colors.text} />
                  </View>
                  <Text style={{ color: colors.textSecondary, fontSize: 14, textAlign: 'center' }}>{pcT('empty')}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 18, height: 40, borderRadius: 20, backgroundColor: chipOnBg }}>
                    <IconPlus size={16} color={chipOnFg} />
                    <Text style={{ color: chipOnFg, fontSize: 15, fontWeight: '700' }}>{pcT('add')}</Text>
                  </View>
                </PressableScale>
              ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                  <ActivityIndicator color={colors.textSecondary} />
                </View>
              )
            )}
            {carouselWidth > 0 && items.length > 0 && (
              <FlatList
                ref={carouselRef}
                data={items}
                horizontal
                pagingEnabled
                showsHorizontalScrollIndicator={false}
                keyExtractor={(item) => item.id}
                onMomentumScrollEnd={handleScrollEnd}
                renderItem={renderSlide}
                extraData={`${activeIndex}|${fit}|${busy}`}
                getItemLayout={(_, i) => ({ length: carouselWidth, offset: carouselWidth * i, index: i })}
              />
            )}
            {items.length > 1 && (
              <View style={s.counterBadge} pointerEvents="none">
                <Text style={s.badgeText}>{`${activeIndex + 1}/${items.length}`}</Text>
              </View>
            )}
          </View>

          {items.length > 1 && (
            <View style={s.dotsRow}>
              {items.map((it, i) => <View key={it.id} style={[s.dot, i === activeIndex && s.dotActive]} />)}
            </View>
          )}

          {items.length > 0 && (
            <>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.thumbsStrip}>
                {items.map((it, i) => (
                  <TouchableOpacity
                    key={it.id}
                    style={[s.thumb, i === activeIndex && s.thumbActive, i === reorderFromIdx && s.thumbReorder]}
                    onPress={() => onThumbPress(i)}
                    onLongPress={() => setReorderFromIdx(i)}
                    accessibilityLabel={`${i + 1}`}
                  >
                    {it.type === 'video' ? (
                      <View style={[s.thumbImg, { alignItems: 'center', justifyContent: 'center', backgroundColor: '#1b1b1d' }]}>
                        <IconPlay size={18} color="#fff" />
                      </View>
                    ) : (
                      <ExpoImage source={{ uri: it.uri }} style={s.thumbImg} contentFit="cover" />
                    )}
                  </TouchableOpacity>
                ))}
                {items.length < POST_MAX_ITEMS && (
                  <TouchableOpacity style={s.addMoreTile} onPress={addMenu} accessibilityLabel={pcT('add')}>
                    <IconPlus size={22} color={colors.textSecondary} />
                  </TouchableOpacity>
                )}
              </ScrollView>
              <Text style={s.reorderHint}>{reorderFromIdx >= 0 ? pcT('reorderHint') : (items.length > 1 ? pcT('editHint') : '')}</Text>

              <Text style={s.sectionLabel}>{pcT('aspect')}</Text>
              <View style={s.chipsRow}>
                {ASPECTS.map((a) => {
                  const on = aspect === a.key;
                  return (
                    <TouchableOpacity key={a.key} style={[s.chip, on && s.chipOn]} onPress={() => setAspect(a.key)} accessibilityRole="button" accessibilityState={{ selected: on }}>
                      <View style={{ width: a.key === '4:5' ? 10 : 12, height: a.key === 'orig' ? 9 : 12, borderRadius: 2, borderWidth: 1.5, borderColor: on ? chipOnFg : colors.text }} />
                      <Text style={[s.chipText, on && s.chipTextOn]}>{pcT(a.label)}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </>
          )}

          <Text style={s.sectionLabel}>{pcT('audience')}</Text>
          <View style={s.chipsRow}>
            {[
              { key: 'everyone', Icon: IconGlobe },
              { key: 'contacts', Icon: IconUsers },
            ].map((a) => {
              const on = audience === a.key;
              return (
                <TouchableOpacity key={a.key} style={[s.chip, on && s.chipOn]} onPress={() => setAudience(a.key)} accessibilityRole="button" accessibilityState={{ selected: on }}>
                  {on ? <IconCheck size={14} color={chipOnFg} /> : <a.Icon size={14} color={colors.text} />}
                  <Text style={[s.chipText, on && s.chipTextOn]}>{pcT(a.key)}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={s.hint}>{pcT(audience === 'contacts' ? 'contactsHint' : 'everyoneHint')}</Text>

          <View style={s.captionWrap}>
            <TextInput
              value={caption}
              onChangeText={(v) => setCaption(v.slice(0, MAX_CAPTION))}
              placeholder={pcT('captionPh')}
              placeholderTextColor={colors.textTertiary || colors.textSecondary}
              multiline
              editable={!busy}
              style={s.captionInput}
            />
          </View>
          {caption.length > MAX_CAPTION - 200 && <Text style={s.counter}>{MAX_CAPTION - caption.length}</Text>}
        </ScrollView>
      </KeyboardAvoidingView>

      <PhotoEditor
        visible={editorOpenForIdx >= 0}
        imageUri={editorOpenForIdx >= 0 ? items[editorOpenForIdx]?.uri : null}
        onSave={handleEditorSave}
        onClose={() => setEditorOpenForIdx(-1)}
      />
    </View>
  );
}
