import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, Modal, Image, ActivityIndicator,
  Pressable, Linking, Platform,
} from 'react-native';
import { IconX, IconDownload, IconPlay, IconFileText, IconImage, IconFilm, IconMusic } from './Icons';
import * as api from '../services/api';
import { BASE_URL } from '../services/api';
import ChatMediaViewer from './ChatMediaViewer';

const TABS = ['image', 'video', 'audio', 'file'];

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function resolveUrl(url) {
  if (!url) return url;
  const absolute = url.startsWith('http') ? url : `${BASE_URL}${url}`;
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
  if (isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

function MediaGrid({ items, type, colors, onView }) {
  if (items.length === 0) {
    const emptyLabel = type === 'image' ? 'Nenhuma foto'
      : type === 'video' ? 'Nenhum vídeo'
      : type === 'audio' ? 'Nenhum áudio'
      : 'Nenhum documento';
    const emptyHint = type === 'image' ? 'As fotos enviadas neste chat aparecem aqui'
      : type === 'video' ? 'Os vídeos enviados neste chat aparecem aqui'
      : type === 'audio' ? 'As mensagens de voz e áudios aparecem aqui'
      : 'Os PDFs e documentos compartilhados aparecem aqui';
    const EmptyIcon = type === 'image' ? IconImage : type === 'video' ? IconFilm : type === 'audio' ? IconMusic : IconFileText;
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
        <View style={{
          width: 80, height: 80, borderRadius: 40,
          backgroundColor: 'rgba(124,58,237,0.10)',
          alignItems: 'center', justifyContent: 'center', marginBottom: 16,
        }}>
          <EmptyIcon size={36} color="#7C3AED" />
        </View>
        <Text style={{ color: colors.text, fontSize: 17, fontWeight: '600', marginBottom: 6 }}>{emptyLabel}</Text>
        <Text style={{ color: colors.textTertiary, fontSize: 13, textAlign: 'center', lineHeight: 19, maxWidth: 280 }}>
          {emptyHint}
        </Text>
      </View>
    );
  }

  if (type === 'image' || type === 'video') {
    return (
      <FlatList
        key={`grid-${type}`}
        data={items}
        numColumns={3}
        keyExtractor={item => String(item.id)}
        contentContainerStyle={{ padding: 2 }}
        renderItem={({ item }) => (
          <TouchableOpacity
            onPress={() => onView(item)}
            style={{ flex: 1 / 3, aspectRatio: 1, padding: 1 }}
            activeOpacity={0.7}
          >
            <Image
              source={{ uri: resolveUrl(item.file_url) }}
              style={{ width: '100%', height: '100%', backgroundColor: colors.background, borderRadius: 2 }}
              resizeMode="cover"
            />
            {type === 'video' && (
              <View style={{
                position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.2)',
              }}>
                <Text style={{ fontSize: 28, color: '#fff' }}>▶</Text>
              </View>
            )}
          </TouchableOpacity>
        )}
      />
    );
  }

  // List view for audio and files
  return (
    <FlatList
      key={`list-${type}`}
      data={items}
      keyExtractor={item => String(item.id)}
      contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 24 }}
      ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
      renderItem={({ item, index }) => {
        const isAudio = type === 'audio';
        const ext = (item.file_name || '').split('.').pop()?.toLowerCase() || '';
        // Friendly title — strip the raw `audio_<timestamp>.m4a` filenames the
        // recorder uses and replace with a sequential "Mensagem de voz #N"
        // label. Documents keep their real filename (truncated extension is
        // rendered separately in the meta line).
        const rawName = (item.file_name || '').trim();
        const title = isAudio
          ? (/^audio_\d{10,}\.[a-z0-9]+$/i.test(rawName) || rawName === ''
              ? `Mensagem de voz ${index + 1}`
              : rawName.replace(/\.[a-z0-9]+$/i, ''))
          : (rawName || 'Documento');
        const accent = isAudio ? '#7C3AED' : '#3B82F6';
        const accentBg = isAudio ? 'rgba(124,58,237,0.12)' : 'rgba(59,130,246,0.12)';
        const extLabel = isAudio
          ? (ext.toUpperCase() || 'AUDIO')
          : (ext.toUpperCase() || 'FILE');
        return (
          <TouchableOpacity
            onPress={() => onView(item)}
            style={{
              flexDirection: 'row', alignItems: 'center',
              paddingVertical: 12, paddingHorizontal: 12,
              borderRadius: 14, backgroundColor: colors.surface,
              borderWidth: 1, borderColor: colors.border,
            }}
            activeOpacity={0.65}
          >
            <View style={{
              width: 44, height: 44, borderRadius: 12, backgroundColor: accentBg,
              alignItems: 'center', justifyContent: 'center', marginRight: 12,
            }}>
              {isAudio ? <IconPlay size={20} color={accent} /> : <IconFileText size={20} color={accent} />}
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>
                {title}
              </Text>
              <Text style={{ color: colors.textTertiary, fontSize: 12, marginTop: 3 }} numberOfLines={1}>
                <Text style={{ fontWeight: '700', color: accent }}>{extLabel}</Text>
                {' · '}{formatSize(item.file_size)}{' · '}{formatDate(item.created_at)}
              </Text>
            </View>
            <IconDownload size={18} color={colors.textTertiary} />
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

  const tabLabels = {
    image: t?.('chat.photos') || 'Photos',
    video: t?.('chat.videos') || 'Videos',
    audio: t?.('chat.audioFiles') || 'Audio',
    file: t?.('chat.documents') || 'Docs',
  };

  useEffect(() => {
    if (visible && conversationId) loadMedia(activeTab);
  }, [visible, activeTab, conversationId]);

  const loadMedia = async (type) => {
    setLoading(true);
    try {
      const r = await api.chatMediaGallery(conversationId, type);
      if (r.success) {
        setItems(r.data?.items || []);
      } else {
        setItems([]);
      }
    } catch (e) {
      console.warn('MediaGallery loadMedia error:', e);
      setItems([]);
    }
    setLoading(false);
  };

  const handleView = (item) => {
    if (!item?.file_url) return;
    // Inline viewer with pinch/zoom/pan. Previously this fell back to
    // `Linking.openURL(url)` which shoved the user into Safari/Chrome —
    // user reported "imagem não abre grande, só fica carregando" because
    // the external browser navigation looked like a spinner.
    setViewerItem({
      fileUrl: item.file_url,
      fileName: item.file_name || 'media',
      fileSize: item.file_size || 0,
      type: item.type || activeTab,
    });
  };

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {/* Header */}
        <View style={{
          flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16,
          paddingTop: 56, paddingBottom: 16, backgroundColor: colors.surface,
          borderBottomWidth: Platform.OS === 'web' ? 1 : 0, borderBottomColor: colors.border,
        }}>
          <TouchableOpacity
            onPress={onClose}
            style={{
              width: 36, height: 36, borderRadius: 18,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: 'rgba(0,0,0,0.04)',
              marginRight: 14,
            }}
            activeOpacity={0.6}
          >
            <IconX size={20} color={colors.text} />
          </TouchableOpacity>
          <Text style={{ fontSize: 19, fontWeight: '700', color: colors.text, flex: 1, letterSpacing: -0.3 }}>
            {t?.('chat.mediaGallery') || 'Mídia e documentos'}
          </Text>
        </View>

        {/* Tabs — pill-style segmented control */}
        <View style={{
          flexDirection: 'row',
          paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10,
          backgroundColor: colors.surface,
          borderBottomWidth: 1, borderBottomColor: colors.border,
          gap: 6,
        }}>
          {TABS.map(tab => {
            const active = activeTab === tab;
            return (
              <TouchableOpacity
                key={tab}
                onPress={() => setActiveTab(tab)}
                style={{
                  flex: 1, paddingVertical: 9, paddingHorizontal: 6,
                  borderRadius: 10,
                  alignItems: 'center',
                  backgroundColor: active ? '#7C3AED' : 'transparent',
                }}
                activeOpacity={0.7}
              >
                <Text style={{
                  fontSize: 13, fontWeight: '700',
                  color: active ? '#fff' : colors.textSecondary,
                  letterSpacing: 0.2,
                }} numberOfLines={1}>
                  {tabLabels[tab]}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Content */}
        {loading ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
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
      />
    </Modal>
  );
}
