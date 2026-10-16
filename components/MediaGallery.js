import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import FastImage from './FastImage'; // [2026-10-09 expo-image]
import {
  View, Text, TouchableOpacity, FlatList, Modal, Image, ActivityIndicator,
  Platform, StyleSheet, Alert,
} from 'react-native';
import { IconX, IconDownload, IconFileText, IconImage, IconFilm, IconMusic, IconPlay } from './Icons';
import * as api from '../services/api';
import { BASE_URL } from '../services/api';
import ChatMediaViewer from './ChatMediaViewer';
// [2026-10-16 native-media-grid] Fotos/Vídeos em grade NATIVA (seções por mês,
// 1º quadro + duração do vídeo, seleção) — kill __chatyy_native_media_grid.
import NativeMediaGrid, { isNativeMediaGridAvailable } from './media/NativeMediaGrid';
import { useLanguage } from '../context/LanguageContext';

const TABS = ['image', 'video', 'audio', 'file'];

// Chatyy brand purple. The whole screen reads as ONE coherent purple set —
// the active-pill, empty-state circle, list icons and accents are all the
// brand color. Per-type is still distinguishable via the icon (Image/Film/
// Music/FileText), not via clashing hues.
const BRAND = '#111111';
const BRAND_SOFT = 'rgba(17, 17, 17,0.12)';
const TAB_THEME = {
  image: { color: BRAND, soft: BRAND_SOFT, Icon: IconImage },
  video: { color: BRAND, soft: BRAND_SOFT, Icon: IconFilm },
  audio: { color: BRAND, soft: BRAND_SOFT, Icon: IconMusic },
  file:  { color: BRAND, soft: BRAND_SOFT, Icon: IconFileText },
};

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function resolveUrl(url) {
  if (!url) return url;
  const absolute = url.startsWith('http') ? url : api.getMediaUrl(url);
  // Prefer local cached file (disk) for instant render — falls back to remote
  if (Platform.OS !== 'web') {
    try {
      const { getLocalUriSyncJs } = require('../services/mediaCache');
      const local = getLocalUriSyncJs(absolute);
      if (local) return local;
    } catch {}
  }
  return absolute;
}

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

// [2026-10-16 native-media-grid] cor do tema → "#RRGGBB" p/ o nativo.
function _hex(c, fallback) {
  if (typeof c !== 'string') return fallback;
  const v = c.trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return v;
  const m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) return '#' + [m[1], m[2], m[3]].map((x) => Math.max(0, Math.min(255, Number(x))).toString(16).padStart(2, '0')).join('');
  return fallback;
}

function _ts(d) {
  if (!d) return 0;
  try {
    const dt = api.parseServerDate ? api.parseServerDate(d) : new Date(d);
    const n = dt && dt.getTime ? dt.getTime() : NaN;
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

function _nativeItems(items, type) {
  const isVideo = type === 'video';
  return (items || []).filter(it => it && it.file_url).map((it) => {
    const url = resolveUrl(it.file_url);
    return isVideo
      ? { k: String(it.id), u: '', vu: url, v: true, ad: true, tr: 'video', t: _ts(it.created_at), a: it.file_name || '' }
      : { k: String(it.id), u: url, t: _ts(it.created_at), a: it.file_name || '' };
  });
}

function EmptyState({ type, colors }) {
  const { color, soft, Icon } = TAB_THEME[type] || TAB_THEME.file;
  const emptyLabel = type === 'image' ? 'Nenhuma foto ainda'
    : type === 'video' ? 'Nenhum vídeo ainda'
    : type === 'audio' ? 'Nenhum áudio ainda'
    : 'Nenhum documento ainda';
  const emptyHint = type === 'image' ? 'As fotos enviadas nesta conversa aparecem aqui.'
    : type === 'video' ? 'Os vídeos enviados nesta conversa aparecem aqui.'
    : type === 'audio' ? 'As mensagens de voz e áudios aparecem aqui.'
    : 'Os PDFs e documentos compartilhados aparecem aqui.';
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 }}>
      <View style={{
        width: 92, height: 92, borderRadius: 46, backgroundColor: soft,
        alignItems: 'center', justifyContent: 'center', marginBottom: 18,
        borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(17, 17, 17,0.22)',
      }}>
        <Icon size={38} color={color} />
      </View>
      <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700', marginBottom: 6, letterSpacing: -0.3 }}>
        {emptyLabel}
      </Text>
      <Text style={{ color: colors.textTertiary, fontSize: 13.5, textAlign: 'center', lineHeight: 20, maxWidth: 260 }}>
        {emptyHint}
      </Text>
    </View>
  );
}

function MediaGrid({ items, type, colors, onView }) {
  if (items.length === 0) return <EmptyState type={type} colors={colors} />;

  if (type === 'image' || type === 'video') {
    return (
      <FlatList
        key={`grid-${type}`}
        data={items}
        numColumns={3}
        keyExtractor={item => String(item.id)}
        contentContainerStyle={{ padding: 3 }}
        showsVerticalScrollIndicator={false}
        renderItem={({ item }) => (
          <TouchableOpacity
            onPress={() => onView(item)}
            style={{ flex: 1 / 3, aspectRatio: 1, padding: 1.5 }}
            activeOpacity={0.8}
          >
            <View style={{ flex: 1, borderRadius: 10, overflow: 'hidden', backgroundColor: colors.surface }}>
              <FastImage
                source={{ uri: resolveUrl(item.file_url) }}
                style={{ width: '100%', height: '100%' }}
                resizeMode="cover"
                recyclingKey={item.file_url}
              />
              {type === 'video' && (
                <View style={{
                  position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                  alignItems: 'center', justifyContent: 'center',
                  backgroundColor: 'rgba(0,0,0,0.18)',
                }}>
                  <View style={{
                    width: 34, height: 34, borderRadius: 17,
                    backgroundColor: 'rgba(0,0,0,0.45)',
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    <IconPlay size={16} color="#fff" />
                  </View>
                </View>
              )}
            </View>
          </TouchableOpacity>
        )}
      />
    );
  }

  // List view for audio and files
  const { color: accent, soft: accentBg } = TAB_THEME[type] || TAB_THEME.file;
  return (
    <FlatList
      key={`list-${type}`}
      data={items}
      keyExtractor={item => String(item.id)}
      contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 28 }}
      ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
      showsVerticalScrollIndicator={false}
      renderItem={({ item, index }) => {
        const isAudio = type === 'audio';
        const ext = (item.file_name || '').split('.').pop()?.toLowerCase() || '';
        // Friendly title — strip the raw `audio_<timestamp>.m4a` filenames the
        // recorder uses and replace with a sequential "Mensagem de voz #N"
        // label. Documents keep their real filename.
        const rawName = (item.file_name || '').trim();
        const title = isAudio
          ? (/^audio_\d{10,}\.[a-z0-9]+$/i.test(rawName) || rawName === ''
              ? `Mensagem de voz ${index + 1}`
              : rawName.replace(/\.[a-z0-9]+$/i, ''))
          : (rawName || 'Documento');
        const extLabel = isAudio
          ? (ext.toUpperCase() || 'AUDIO')
          : (ext.toUpperCase() || 'FILE');
        return (
          <TouchableOpacity
            onPress={() => onView(item)}
            style={{
              flexDirection: 'row', alignItems: 'center',
              paddingVertical: 13, paddingHorizontal: 13,
              borderRadius: 16, backgroundColor: colors.surface,
              borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
            }}
            activeOpacity={0.7}
          >
            <View style={{
              width: 46, height: 46, borderRadius: 14, backgroundColor: accentBg,
              alignItems: 'center', justifyContent: 'center', marginRight: 13,
            }}>
              {isAudio ? <IconPlay size={20} color={accent} /> : <IconFileText size={20} color={accent} />}
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600', letterSpacing: -0.2 }} numberOfLines={1}>
                {title}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 5 }}>
                <View style={{
                  paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5,
                  backgroundColor: accentBg,
                }}>
                  <Text style={{ fontSize: 9.5, fontWeight: '800', color: accent, letterSpacing: 0.4 }}>
                    {extLabel}
                  </Text>
                </View>
                <Text style={{ color: colors.textTertiary, fontSize: 12, marginLeft: 8 }} numberOfLines={1}>
                  {[formatSize(item.file_size), formatDate(item.created_at)].filter(Boolean).join('  ·  ')}
                </Text>
              </View>
            </View>
            <View style={{
              width: 34, height: 34, borderRadius: 17,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: colors.background,
            }}>
              <IconDownload size={17} color={colors.textTertiary} />
            </View>
          </TouchableOpacity>
        );
      }}
    />
  );
}

export default function MediaGallery({ visible, onClose, conversationId, colors, t }) {
  const [activeTab, setActiveTab] = useState('image');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [viewerItem, setViewerItem] = useState(null);
  // Guards against a slow request for a previous tab resolving after the user
  // switched tabs (stale response would overwrite the active tab's items).
  const loadSeqRef = useRef(0);
  const { language } = useLanguage() || {};
  // [2026-10-16 native-media-grid] grade nativa p/ Fotos/Vídeos + seleção.
  const gridRef = useRef(null);
  const useNativeGrid = (activeTab === 'image' || activeTab === 'video') && isNativeMediaGridAvailable();
  const [sel, setSel] = useState({ active: false, keys: [], count: 0 });
  const [selBusy, setSelBusy] = useState(false);
  const nativeItems = useMemo(() => (useNativeGrid ? _nativeItems(items, activeTab) : []), [useNativeGrid, items, activeTab]);
  const itemsById = useMemo(() => {
    const m = new Map();
    for (const it of items || []) m.set(String(it.id), it);
    return m;
  }, [items]);
  const gridTheme = useMemo(() => ({
    bg: _hex(colors?.background, '#FFFFFF'),
    placeholder: _hex(colors?.surface, '#8E8E93'),
    sectionText: _hex(colors?.text, '#111111'),
  }), [colors?.background, colors?.surface, colors?.text]);
  useEffect(() => {
    // trocou de aba / fechou → sai da seleção
    setSel({ active: false, keys: [], count: 0 });
    try { gridRef.current?.clearSelection?.(); } catch {}
  }, [activeTab, visible]);

  const tabLabels = {
    image: t?.('chat.photos') || 'Fotos',
    video: t?.('chat.videos') || 'Vídeos',
    audio: t?.('chat.audioFiles') || 'Áudios',
    file: t?.('chat.documents') || 'Documentos',
  };

  useEffect(() => {
    if (visible && conversationId) loadMedia(activeTab);
  }, [visible, activeTab, conversationId]);

  const loadMedia = async (type) => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    try {
      const r = await api.chatMediaGallery(conversationId, type);
      if (seq !== loadSeqRef.current) return;
      setItems(r.success ? (r.data?.items || []) : []);
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      console.warn('MediaGallery loadMedia error:', e);
      setItems([]);
    }
    setLoading(false);
  };

  const handleView = (item) => {
    if (!item?.file_url) return;
    // Inline viewer with pinch/zoom/pan (avoids shoving the user into Safari).
    setViewerItem({
      fileUrl: item.file_url,
      fileName: item.file_name || 'media',
      fileSize: item.file_size || 0,
      type: item.type || activeTab,
      messageId: item.id || item.message_id || 0,
    });
  };

  const onNativePress = useCallback((e) => {
    const it = itemsById.get(String(e?.key));
    if (it) handleView(it);
  }, [itemsById, activeTab]);
  const onNativeLongPress = useCallback((e) => {
    if (e?.key == null || e?.selectionActive) return;
    try { gridRef.current?.beginSelection?.(String(e.key)); } catch {}
  }, []);
  const onNativeSelection = useCallback((e) => {
    setSel({ active: !!e?.active, keys: Array.isArray(e?.keys) ? e.keys : [], count: Number(e?.count) || 0 });
  }, []);
  const exitSelection = useCallback(() => {
    try { gridRef.current?.clearSelection?.(); } catch {}
    setSel({ active: false, keys: [], count: 0 });
  }, []);
  const selectedItems = () => sel.keys.map(k => itemsById.get(String(k))).filter(Boolean);
  const saveSelected = async () => {
    if (selBusy) return;
    const list = selectedItems();
    if (!list.length) return;
    setSelBusy(true);
    let ok = 0;
    try {
      const ML = require('expo-media-library');
      const perm = await ML.requestPermissionsAsync(false);
      if (perm?.status === 'granted') {
        const { ensureLocalFile } = require('../utils/mediaNativeActions');
        for (const it of list) {
          try {
            const f = await ensureLocalFile(resolveUrl(it.file_url), it.file_name || '');
            if (f) { await ML.saveToLibraryAsync(f); ok++; }
          } catch {}
        }
      }
    } catch {}
    setSelBusy(false);
    // (dentro de <Modal>: o ToastHost global fica atrás — Alert só na falha)
    if (ok > 0) exitSelection();
    else { try { Alert.alert(t?.('common.error') || 'Erro'); } catch {} }
  };
  const shareSelected = async () => {
    const list = selectedItems();
    if (list.length !== 1 || selBusy) return;
    setSelBusy(true);
    try {
      const { shareMediaFile } = require('../utils/mediaNativeActions');
      await shareMediaFile({ url: resolveUrl(list[0].file_url), fileName: list[0].file_name || '' });
    } catch {}
    setSelBusy(false);
  };

  if (!visible) return null;

  const activeTheme = TAB_THEME[activeTab] || TAB_THEME.image;

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {/* Header */}
        <View style={{
          flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16,
          paddingTop: Platform.OS === 'web' ? 18 : 56, paddingBottom: 14,
          backgroundColor: colors.surface,
        }}>
          <TouchableOpacity
            onPress={sel.active ? exitSelection : onClose}
            accessibilityRole="button"
            accessibilityLabel={sel.active ? (t?.('common.cancel') || 'Cancelar') : (t?.('common.close') || 'Fechar')}
            style={{
              width: 38, height: 38, borderRadius: 19,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: colors.background,
              marginRight: 14,
            }}
            activeOpacity={0.6}
          >
            <IconX size={20} color={colors.text} />
          </TouchableOpacity>
          {sel.active ? (
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ flex: 1, fontSize: 19, fontWeight: '800', color: colors.text, letterSpacing: -0.4 }} numberOfLines={1}>
                {(t?.('chat.selected') || '{count} selecionada(s)').replace('{count}', String(sel.count))}
              </Text>
              {sel.count === 1 && (
                <TouchableOpacity onPress={shareSelected} disabled={selBusy} accessibilityRole="button"
                  style={{ paddingHorizontal: 12, paddingVertical: 8, opacity: selBusy ? 0.5 : 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>{t?.('common.share') || 'Compartilhar'}</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={saveSelected} disabled={selBusy || sel.count === 0} accessibilityRole="button"
                style={{ paddingHorizontal: 12, paddingVertical: 8, opacity: (selBusy || sel.count === 0) ? 0.5 : 1 }}>
                {selBusy
                  ? <ActivityIndicator size="small" color={colors.text} />
                  : <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>{t?.('common.save') || 'Salvar'}</Text>}
              </TouchableOpacity>
            </View>
          ) : (
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: activeTheme.color, letterSpacing: 0.6, textTransform: 'uppercase' }}>
              {t?.('chat.sharedInChat') || 'Compartilhado nesta conversa'}
            </Text>
            <Text style={{ fontSize: 21, fontWeight: '800', color: colors.text, letterSpacing: -0.5, marginTop: 1 }}>
              {t?.('chat.mediaGallery') || 'Mídia e documentos'}
            </Text>
          </View>
          )}
        </View>

        {/* Tabs — segmented control on a tray */}
        <View style={{
          paddingHorizontal: 14, paddingTop: 4, paddingBottom: 12,
          backgroundColor: colors.surface,
          borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
        }}>
          <View style={{
            flexDirection: 'row',
            backgroundColor: colors.background,
            borderRadius: 14, padding: 4, gap: 2,
          }}>
            {TABS.map(tab => {
              const active = activeTab === tab;
              const th = TAB_THEME[tab];
              return (
                <TouchableOpacity
                  key={tab}
                  onPress={() => setActiveTab(tab)}
                  style={{
                    flex: 1, paddingVertical: 9, paddingHorizontal: 4,
                    borderRadius: 11,
                    alignItems: 'center',
                    backgroundColor: active ? th.color : 'transparent',
                    ...(active ? {
                      shadowColor: BRAND, shadowOpacity: 0.25,
                      shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
                      elevation: 2,
                    } : null),
                  }}
                  activeOpacity={0.75}
                >
                  <Text style={{
                    fontSize: 13, fontWeight: '700',
                    color: active ? '#fff' : colors.textSecondary,
                    letterSpacing: -0.1,
                  }} numberOfLines={1}>
                    {tabLabels[tab]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Content */}
        {loading ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator size="large" color={activeTheme.color} />
          </View>
        ) : (useNativeGrid && nativeItems.length > 0) ? (
          <NativeMediaGrid
            ref={gridRef}
            items={nativeItems}
            sections
            spacing={2}
            locale={language || ''}
            theme={gridTheme}
            contentInsetBottom={28}
            onItemPress={onNativePress}
            onItemLongPress={onNativeLongPress}
            onSelectionChange={onNativeSelection}
          />
        ) : (
          <MediaGrid items={items} type={activeTab} colors={colors} onView={handleView} />
        )}
      </View>
      <ChatMediaViewer
        visible={!!viewerItem}
        fileUrl={viewerItem?.fileUrl}
        fileName={viewerItem?.fileName}
        fileSize={viewerItem?.fileSize}
        type={viewerItem?.type}
        onClose={() => setViewerItem(null)}
        colors={colors}
        t={t}
        conversationId={conversationId}
        messageId={viewerItem?.messageId || 0}
      />
    </Modal>
  );
}
