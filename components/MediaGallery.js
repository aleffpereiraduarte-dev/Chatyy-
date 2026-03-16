import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, Modal, Image, ActivityIndicator,
  Pressable, Linking, Platform,
} from 'react-native';
import { IconX, IconDownload, IconPlay, IconFile } from './Icons';
import * as api from '../services/api';

const TABS = ['image', 'video', 'audio', 'file'];

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

function MediaGrid({ items, type, colors, onView }) {
  if (items.length === 0) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 }}>
        <Text style={{ fontSize: 40, marginBottom: 12 }}>
          {type === 'image' ? '🖼️' : type === 'video' ? '🎬' : type === 'audio' ? '🎵' : '📄'}
        </Text>
        <Text style={{ color: colors.textTertiary, fontSize: 14 }}>No media</Text>
      </View>
    );
  }

  if (type === 'image' || type === 'video') {
    return (
      <FlatList
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
              source={{ uri: item.file_url }}
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
      data={items}
      keyExtractor={item => String(item.id)}
      contentContainerStyle={{ padding: 8 }}
      renderItem={({ item }) => (
        <TouchableOpacity
          onPress={() => onView(item)}
          style={{
            flexDirection: 'row', alignItems: 'center', padding: 12,
            borderBottomWidth: 1, borderBottomColor: colors.border,
          }}
          activeOpacity={0.7}
        >
          <View style={{
            width: 44, height: 44, borderRadius: 8, backgroundColor: colors.background,
            alignItems: 'center', justifyContent: 'center', marginRight: 12,
          }}>
            <Text style={{ fontSize: 22 }}>{type === 'audio' ? '🎵' : '📄'}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.text, fontSize: 14, fontWeight: '500' }} numberOfLines={1}>
              {item.file_name || 'File'}
            </Text>
            <Text style={{ color: colors.textTertiary, fontSize: 12, marginTop: 2 }}>
              {formatSize(item.file_size)} · {formatDate(item.created_at)}
            </Text>
          </View>
        </TouchableOpacity>
      )}
    />
  );
}

export default function MediaGallery({ visible, onClose, conversationId, colors, t }) {
  const [activeTab, setActiveTab] = useState('image');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);

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
      if (r.success) setItems(r.data?.items || []);
    } catch {}
    setLoading(false);
  };

  const handleView = (item) => {
    if (Platform.OS === 'web' && item.file_url) {
      window.open(item.file_url, '_blank');
    } else if (item.file_url) {
      Linking.openURL(item.file_url).catch(() => {});
    }
  };

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {/* Header */}
        <View style={{
          flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16,
          paddingTop: 48, paddingBottom: 12, backgroundColor: colors.surface,
          borderBottomWidth: 1, borderBottomColor: colors.border,
        }}>
          <TouchableOpacity onPress={onClose} style={{ marginRight: 16 }}>
            <IconX size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={{ fontSize: 18, fontWeight: '600', color: colors.text, flex: 1 }}>
            {t?.('chat.mediaGallery') || 'Media & Docs'}
          </Text>
        </View>

        {/* Tabs */}
        <View style={{
          flexDirection: 'row', backgroundColor: colors.surface,
          borderBottomWidth: 1, borderBottomColor: colors.border,
        }}>
          {TABS.map(tab => (
            <TouchableOpacity
              key={tab}
              onPress={() => setActiveTab(tab)}
              style={{
                flex: 1, paddingVertical: 12, alignItems: 'center',
                borderBottomWidth: 2,
                borderBottomColor: activeTab === tab ? colors.primary : 'transparent',
              }}
            >
              <Text style={{
                fontSize: 13, fontWeight: '600',
                color: activeTab === tab ? colors.primary : colors.textSecondary,
              }}>
                {tabLabels[tab]}
              </Text>
            </TouchableOpacity>
          ))}
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
    </Modal>
  );
}
