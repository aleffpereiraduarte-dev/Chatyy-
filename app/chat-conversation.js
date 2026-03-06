import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, Image,
  ActivityIndicator, TextInput, Platform, KeyboardAvoidingView,
  Alert, Modal, Pressable, Linking, Animated,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing, Shadow } from '../constants/theme';
import * as api from '../services/api';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import {
  IconArrowLeft, IconSend, IconUsers, IconMoreVert, IconVideo, IconPhone,
  IconX, IconEdit, IconTrash, IconReply, IconPaperclip, IconImage, IconFileText,
  IconCheck, IconCheckCircle, IconMic, IconPlay, IconPause, IconStop,
  IconCamera, IconMapPin, IconSmile, IconNavigation, IconUser, IconPlus,
  IconThumbsUp, IconHeart, IconLaughFace, IconSurpriseFace, IconSadFace, IconPrayHands,
} from '../components/Icons';

// ============================================================
// HELPERS
// ============================================================

function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'Z');
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateSeparator(dateStr, t) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'Z');
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.floor((today - msgDate) / 86400000);

  if (diffDays === 0) return t('date.today');
  if (diffDays === 1) return t('date.yesterday');
  const locale = t('_locale') || undefined;
  if (diffDays < 7) return d.toLocaleDateString(locale, { weekday: 'long' });
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/[\s@]+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name[0].toUpperCase();
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatLastSeen(dateStr, t) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'Z');
  const now = new Date();
  const diffMin = Math.floor((now - d) / 60000);
  if (diffMin < 1) return t('chat.justNow') || 'agora';
  if (diffMin < 60) return `${diffMin}min`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const QUICK_REACTIONS = [
  { key: 'thumbsup', Icon: IconThumbsUp },
  { key: 'heart', Icon: IconHeart },
  { key: 'laugh', Icon: IconLaughFace },
  { key: 'surprise', Icon: IconSurpriseFace },
  { key: 'sad', Icon: IconSadFace },
  { key: 'pray', Icon: IconPrayHands },
];

const REACTION_ICON_MAP = {
  thumbsup: IconThumbsUp, heart: IconHeart, laugh: IconLaughFace,
  surprise: IconSurpriseFace, sad: IconSadFace, pray: IconPrayHands,
};

// ============================================================
// AUDIO PLAYER COMPONENT
// ============================================================

function AudioPlayer({ url, duration, isOwn, colors }) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const soundRef = useRef(null);
  const intervalRef = useRef(null);

  useEffect(() => {
    return () => {
      if (soundRef.current) {
        soundRef.current.unloadAsync?.().catch(() => {});
      }
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const togglePlay = async () => {
    try {
      let Audio;
      try { Audio = require('expo-av').Audio; } catch {
        // expo-av not available, open URL instead
        if (url) Linking.openURL(url).catch(() => {});
        return;
      }
      if (playing && soundRef.current) {
        await soundRef.current.pauseAsync();
        setPlaying(false);
        if (intervalRef.current) clearInterval(intervalRef.current);
        return;
      }

      if (!loaded) {
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
        const { sound } = await Audio.Sound.createAsync(
          { uri: url },
          { shouldPlay: true },
          (status) => {
            if (status.isLoaded) {
              if (status.durationMillis > 0) {
                setProgress(status.positionMillis / status.durationMillis);
              }
              if (status.didJustFinish) {
                setPlaying(false);
                setProgress(0);
                if (intervalRef.current) clearInterval(intervalRef.current);
              }
            }
          }
        );
        soundRef.current = sound;
        setLoaded(true);
        setPlaying(true);
      } else {
        await soundRef.current.playFromPositionAsync(0);
        setPlaying(true);
      }
    } catch (e) {
      console.warn('Audio play error:', e);
    }
  };

  const tintColor = isOwn ? 'rgba(255,255,255,0.9)' : colors.primary;
  const trackBg = isOwn ? 'rgba(255,255,255,0.3)' : colors.border;

  return (
    <View style={audioStyles.container}>
      <TouchableOpacity onPress={togglePlay} style={audioStyles.playBtn}>
        {playing ? (
          <IconPause size={20} color={tintColor} />
        ) : (
          <IconPlay size={20} color={tintColor} />
        )}
      </TouchableOpacity>
      <View style={audioStyles.trackWrap}>
        <View style={[audioStyles.track, { backgroundColor: trackBg }]}>
          <View style={[audioStyles.trackFill, { backgroundColor: tintColor, width: `${progress * 100}%` }]} />
        </View>
        <Text style={[audioStyles.duration, { color: isOwn ? 'rgba(255,255,255,0.6)' : colors.textTertiary }]}>
          {duration ? formatDuration(duration) : '0:00'}
        </Text>
      </View>
      <IconMic size={14} color={tintColor} style={{ marginLeft: 4 }} />
    </View>
  );
}

const audioStyles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', minWidth: 200, paddingVertical: 4 },
  playBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  trackWrap: { flex: 1, marginLeft: 4 },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  trackFill: { height: '100%', borderRadius: 2 },
  duration: { fontSize: 10, marginTop: 2 },
});

// ============================================================
// LOCATION MESSAGE COMPONENT
// ============================================================

function LocationMessage({ content, isOwn, colors }) {
  let lat, lng, label;
  try {
    const data = JSON.parse(content);
    lat = data.latitude;
    lng = data.longitude;
    label = data.label || data.address || '';
  } catch {
    label = content;
  }

  const openMap = () => {
    if (lat && lng) {
      const url = Platform.select({
        ios: `maps:0,0?q=${lat},${lng}`,
        android: `geo:${lat},${lng}?q=${lat},${lng}`,
        default: `https://maps.google.com/?q=${lat},${lng}`,
      });
      Linking.openURL(url).catch(() => {});
    }
  };

  return (
    <TouchableOpacity onPress={openMap} style={locStyles.container}>
      {lat && lng && (
        <Image
          source={{ uri: `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=15&size=300x150&markers=${lat},${lng}&key=AIzaSyBFw0Qbyq9zTFTd-tUY6dZWTgaQzuU17R8` }}
          style={locStyles.mapImage}
          resizeMode="cover"
        />
      )}
      <View style={locStyles.labelRow}>
        <IconMapPin size={14} color={isOwn ? 'rgba(255,255,255,0.8)' : colors.primary} />
        <Text style={[locStyles.label, { color: isOwn ? '#fff' : colors.text }]} numberOfLines={2}>
          {label || 'Localizacao compartilhada'}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const locStyles = StyleSheet.create({
  container: { borderRadius: BorderRadius.md, overflow: 'hidden' },
  mapImage: { width: 220, height: 120, borderRadius: BorderRadius.md },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, paddingHorizontal: 2 },
  label: { fontSize: FontSize.sm, flex: 1 },
});

// ============================================================
// CONTACT MESSAGE COMPONENT
// ============================================================

function ContactMessage({ content, isOwn, colors }) {
  let contactData;
  try {
    contactData = JSON.parse(content);
  } catch {
    contactData = { name: content };
  }

  return (
    <View style={contactStyles.container}>
      <View style={[contactStyles.avatar, { backgroundColor: isOwn ? 'rgba(255,255,255,0.2)' : colors.primary + '20' }]}>
        <IconUser size={20} color={isOwn ? '#fff' : colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[contactStyles.name, { color: isOwn ? '#fff' : colors.text }]}>{contactData.name || 'Contato'}</Text>
        {contactData.phone && (
          <TouchableOpacity onPress={() => Linking.openURL(`tel:${contactData.phone}`)}>
            <Text style={[contactStyles.phone, { color: isOwn ? 'rgba(255,255,255,0.7)' : colors.primary }]}>
              {contactData.phone}
            </Text>
          </TouchableOpacity>
        )}
        {contactData.email && (
          <Text style={[contactStyles.phone, { color: isOwn ? 'rgba(255,255,255,0.6)' : colors.textSecondary }]}>
            {contactData.email}
          </Text>
        )}
      </View>
    </View>
  );
}

const contactStyles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4, minWidth: 180 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: FontSize.md, fontWeight: '600' },
  phone: { fontSize: FontSize.sm, marginTop: 1 },
});

// ============================================================
// ATTACHMENT MENU (+ Button)
// ============================================================

function AttachmentMenu({ visible, onClose, onPick, colors }) {
  if (!visible) return null;

  const items = [
    { key: 'camera', icon: IconCamera, label: 'Camera', color: '#ef4444' },
    { key: 'gallery', icon: IconImage, label: 'Galeria', color: '#8b5cf6' },
    { key: 'file', icon: IconFileText, label: 'Arquivo', color: '#3b82f6' },
    { key: 'audio', icon: IconMic, label: 'Audio', color: '#f97316' },
    { key: 'location', icon: IconMapPin, label: 'Localizacao', color: '#10b981' },
    { key: 'contact', icon: IconUser, label: 'Contato', color: '#06b6d4' },
  ];

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={attachStyles.overlay} onPress={onClose}>
        <View style={[attachStyles.sheet, { backgroundColor: colors.surface }, Shadow.lg]}>
          <View style={attachStyles.grid}>
            {items.map(item => (
              <TouchableOpacity
                key={item.key}
                style={attachStyles.item}
                onPress={() => { onClose(); onPick(item.key); }}
              >
                <View style={[attachStyles.iconCircle, { backgroundColor: item.color + '15' }]}>
                  <item.icon size={22} color={item.color} />
                </View>
                <Text style={[attachStyles.label, { color: colors.text }]}>{item.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}

const attachStyles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: Spacing.lg, paddingBottom: 40 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-around' },
  item: { alignItems: 'center', width: '30%', marginBottom: Spacing.lg },
  iconCircle: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  label: { fontSize: FontSize.xs, fontWeight: '500' },
});

// ============================================================
// AUDIO RECORDER
// ============================================================

function AudioRecorder({ onSend, onCancel, colors }) {
  const [recording, setRecording] = useState(null);
  const [duration, setDuration] = useState(0);
  const intervalRef = useRef(null);
  const startTimeRef = useRef(0);

  useEffect(() => {
    startRecording();
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const startRecording = async () => {
    try {
      let Audio;
      try { Audio = require('expo-av').Audio; } catch {
        Alert.alert('Audio', 'Gravacao de audio nao disponivel nesta versao.');
        onCancel();
        return;
      }
      await Audio.requestPermissionsAsync();
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      const { recording: rec } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      setRecording(rec);
      startTimeRef.current = Date.now();
      intervalRef.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);
    } catch (e) {
      console.warn('Recording error:', e);
      onCancel();
    }
  };

  const handleSend = async () => {
    if (!recording) return;
    if (intervalRef.current) clearInterval(intervalRef.current);
    try {
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      if (uri) {
        onSend({ uri, name: `audio_${Date.now()}.m4a`, type: 'audio/m4a', duration });
      }
    } catch (e) {
      console.warn('Stop recording error:', e);
    }
    setRecording(null);
  };

  const handleCancel = async () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (recording) {
      try { await recording.stopAndUnloadAsync(); } catch {}
    }
    setRecording(null);
    onCancel();
  };

  return (
    <View style={[recStyles.container, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
      <TouchableOpacity onPress={handleCancel} style={recStyles.btn}>
        <IconTrash size={20} color={colors.error} />
      </TouchableOpacity>
      <View style={recStyles.center}>
        <View style={[recStyles.dot, { backgroundColor: '#ef4444' }]} />
        <Text style={[recStyles.timer, { color: colors.text }]}>{formatDuration(duration)}</Text>
        <Text style={[recStyles.hint, { color: colors.textTertiary }]}>Gravando...</Text>
      </View>
      <TouchableOpacity onPress={handleSend} style={[recStyles.sendBtn, { backgroundColor: colors.primary }]}>
        <IconSend size={18} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const recStyles = StyleSheet.create({
  container: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  btn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  center: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  timer: { fontSize: FontSize.lg, fontWeight: '700', fontVariant: ['tabular-nums'] },
  hint: { fontSize: FontSize.xs },
  sendBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});

// ============================================================
// MAIN SCREEN
// ============================================================

export default function ChatConversationScreen() {
  const { colors } = useTheme();
  const { user } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams();
  const flatListRef = useRef(null);
  const inputRef = useRef(null);
  const pollRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => { return () => { mountedRef.current = false; }; }, []);

  const conversationId = parseInt(params.id, 10);
  const conversationName = params.name || t('chat.defaultName');
  const conversationType = params.type || 'direct';

  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [inputText, setInputText] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [editingMsg, setEditingMsg] = useState(null);
  const [selectedMsg, setSelectedMsg] = useState(null);
  const [showReactions, setShowReactions] = useState(null);
  const [readReceipts, setReadReceipts] = useState([]);

  // WhatsApp features state
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [presence, setPresence] = useState(null); // { status, last_seen }

  const currentEmail = user?.email || '';

  // ============================================================
  // PRESENCE TRACKING
  // ============================================================

  useEffect(() => {
    // Update own presence to online
    api.chatPresence('online').then(r => {
      if (r.success && r.data) {
        // Find the other user's presence (for direct chats)
        if (conversationType === 'direct') {
          const otherEmail = params.email || '';
          const found = r.data.find(p => p.email !== currentEmail);
          if (found) setPresence(found);
        }
      }
    }).catch(() => {});

    // Poll presence every 15 seconds
    const presenceInterval = setInterval(() => {
      api.chatPresence('online').then(r => {
        if (r.success && r.data && mountedRef.current) {
          const found = r.data.find(p => p.email !== currentEmail);
          if (found) setPresence(found);
        }
      }).catch(() => {});
    }, 15000);

    return () => clearInterval(presenceInterval);
  }, [conversationId, conversationType, currentEmail]);

  // ============================================================
  // MESSAGES
  // ============================================================

  const loadMessages = useCallback(async (showLoader, beforeId = null) => {
    if (showLoader) setLoading(true);
    if (beforeId) setLoadingMore(true);
    try {
      const r = await api.chatMessages(conversationId, 50, beforeId);
      if (r.success && mountedRef.current) {
        const newMsgs = r.data?.messages || [];
        if (beforeId) {
          setMessages(prev => [...newMsgs, ...prev]);
        } else {
          setMessages(newMsgs);
        }
        setHasMore(r.data?.has_more || false);
        if (r.data?.read_receipts) setReadReceipts(r.data.read_receipts);

        if (!beforeId && newMsgs.length > 0) {
          const lastMsg = newMsgs[newMsgs.length - 1];
          api.chatRead(conversationId, lastMsg.id).catch(() => {});
        }
      }
    } catch {} finally {
      if (!mountedRef.current) return;
      setLoading(false);
      setLoadingMore(false);
    }
  }, [conversationId]);

  useEffect(() => {
    loadMessages(true);
  }, [loadMessages]);

  // Poll for new messages every 3 seconds
  const pollingRef = useRef(false);
  useEffect(() => {
    pollRef.current = setInterval(async () => {
      if (pollingRef.current) return;
      pollingRef.current = true;
      try { await loadMessages(false); } finally { pollingRef.current = false; }
    }, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadMessages]);

  const handleLoadMore = useCallback(() => {
    if (!hasMore || loadingMore || messages.length === 0) return;
    const oldestId = messages[0]?.id;
    if (oldestId) loadMessages(false, oldestId);
  }, [hasMore, loadingMore, messages, loadMessages]);

  // ============================================================
  // SEND TEXT MESSAGE
  // ============================================================

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || sending) return;

    if (editingMsg) {
      setSending(true);
      try {
        const r = await api.chatEdit(editingMsg.id, text);
        if (r.success) {
          setMessages(prev => prev.map(m =>
            m.id === editingMsg.id ? { ...m, content: text, edited_at: new Date().toISOString() } : m
          ));
          setEditingMsg(null);
          setInputText('');
        }
      } catch {} finally {
        setSending(false);
      }
      return;
    }

    setSending(true);
    const replyId = replyTo?.id || null;
    setInputText('');
    setReplyTo(null);

    try {
      const r = await api.chatSend(conversationId, text, 'text', replyId);
      if (r.success && r.data?.message) {
        setMessages(prev => [...prev, r.data.message]);
        if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        requestAnimationFrame(() => {
          flatListRef.current?.scrollToEnd?.({ animated: true });
        });
      }
    } catch {} finally {
      setSending(false);
    }
  };

  // ============================================================
  // ATTACHMENT HANDLERS
  // ============================================================

  const handlePickAttachment = async (type) => {
    switch (type) {
      case 'camera': return handleCamera();
      case 'gallery': return handleGallery();
      case 'file': return handleAttachFile();
      case 'audio': setIsRecording(true); return;
      case 'location': return handleShareLocation();
      case 'contact': return handleShareContact();
    }
  };

  const handleCamera = async () => {
    try {
      const ImagePicker = require('expo-image-picker');
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permissao', 'Permita o acesso a camera nas configuracoes.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images', 'videos'],
        quality: 0.8,
        videoMaxDuration: 60,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      await uploadAndSendFile({
        uri: asset.uri,
        name: asset.fileName || `camera_${Date.now()}.${asset.type === 'video' ? 'mp4' : 'jpg'}`,
        type: asset.type === 'video' ? 'video/mp4' : 'image/jpeg',
      });
    } catch (e) {
      console.warn('Camera error:', e);
    }
  };

  const handleGallery = async () => {
    try {
      const ImagePicker = require('expo-image-picker');
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permissao', 'Permita o acesso a galeria nas configuracoes.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        quality: 0.8,
        allowsMultipleSelection: false,
        videoMaxDuration: 120,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      await uploadAndSendFile({
        uri: asset.uri,
        name: asset.fileName || `media_${Date.now()}.${asset.type === 'video' ? 'mp4' : 'jpg'}`,
        type: asset.type === 'video' ? 'video/mp4' : 'image/jpeg',
      });
    } catch (e) {
      console.warn('Gallery error:', e);
    }
  };

  const handleAttachFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      await uploadAndSendFile({
        uri: asset.uri,
        name: asset.name || 'file',
        type: asset.mimeType || 'application/octet-stream',
      });
    } catch (e) {
      console.warn('File pick error:', e);
    }
  };

  const uploadAndSendFile = async (file) => {
    setUploading(true);
    try {
      const r = await api.chatUploadFile(conversationId, file);
      if (r.success && r.data) {
        const msg = r.data.message || r.data;
        if (msg.id) {
          setMessages(prev => [...prev, msg]);
          requestAnimationFrame(() => flatListRef.current?.scrollToEnd?.({ animated: true }));
        }
      } else {
        Alert.alert('Erro', r.message || 'Erro ao enviar arquivo');
      }
    } catch {
      Alert.alert('Erro', 'Erro ao enviar arquivo');
    } finally {
      setUploading(false);
    }
  };

  const handleSendAudio = async (audioData) => {
    setIsRecording(false);
    setUploading(true);
    try {
      const r = await api.chatUploadFile(conversationId, {
        uri: audioData.uri,
        name: audioData.name,
        type: audioData.type,
      }, `Audio (${formatDuration(audioData.duration)})`);
      if (r.success && r.data) {
        const msg = r.data.message || r.data;
        if (msg.id) {
          setMessages(prev => [...prev, msg]);
          requestAnimationFrame(() => flatListRef.current?.scrollToEnd?.({ animated: true }));
        }
      }
    } catch {} finally {
      setUploading(false);
    }
  };

  const handleShareLocation = async () => {
    try {
      const Location = require('expo-location');
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permissao', 'Permita o acesso a localizacao nas configuracoes.');
        return;
      }
      setUploading(true);
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      let address = '';
      try {
        const [geo] = await Location.reverseGeocodeAsync({
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
        });
        if (geo) {
          address = [geo.street, geo.streetNumber, geo.district, geo.city].filter(Boolean).join(', ');
        }
      } catch {}

      const content = JSON.stringify({
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
        label: address || `${loc.coords.latitude.toFixed(6)}, ${loc.coords.longitude.toFixed(6)}`,
        address,
      });

      const r = await api.chatSend(conversationId, content, 'location');
      if (r.success && r.data?.message) {
        setMessages(prev => [...prev, r.data.message]);
        requestAnimationFrame(() => flatListRef.current?.scrollToEnd?.({ animated: true }));
      }
    } catch (e) {
      console.warn('Location error:', e);
      Alert.alert('Erro', 'Nao foi possivel obter a localizacao');
    } finally {
      setUploading(false);
    }
  };

  const handleShareContact = async () => {
    try {
      const Contacts = require('expo-contacts');
      const { status } = await Contacts.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permissao', 'Permita o acesso aos contatos nas configuracoes.');
        return;
      }
      const { data } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.PhoneNumbers, Contacts.Fields.Emails],
        sort: Contacts.SortTypes.FirstName,
      });
      if (!data || data.length === 0) {
        Alert.alert('Info', 'Nenhum contato encontrado');
        return;
      }

      // Show first 20 contacts in an Alert (simplified picker)
      const contactList = data.slice(0, 30).filter(c => c.name);
      if (contactList.length === 0) return;

      // Use a simple alert approach for now
      Alert.alert(
        'Selecionar Contato',
        'Toque para compartilhar:',
        [
          ...contactList.slice(0, 10).map(c => ({
            text: `${c.name}${c.phoneNumbers?.[0]?.number ? ` (${c.phoneNumbers[0].number})` : ''}`,
            onPress: () => sendContact(c),
          })),
          { text: 'Cancelar', style: 'cancel' },
        ]
      );
    } catch (e) {
      console.warn('Contacts error:', e);
    }
  };

  const sendContact = async (contact) => {
    const content = JSON.stringify({
      name: contact.name || '',
      phone: contact.phoneNumbers?.[0]?.number || '',
      email: contact.emails?.[0]?.email || '',
    });
    try {
      const r = await api.chatSend(conversationId, content, 'contact');
      if (r.success && r.data?.message) {
        setMessages(prev => [...prev, r.data.message]);
        requestAnimationFrame(() => flatListRef.current?.scrollToEnd?.({ animated: true }));
      }
    } catch {}
  };

  // ============================================================
  // MESSAGE ACTIONS
  // ============================================================

  const handleDelete = async (msgId) => {
    Alert.alert(t('chat.deleteMessage'), t('chat.deleteConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('chat.delete'), style: 'destructive',
        onPress: async () => {
          try {
            const r = await api.chatDelete(msgId);
            if (r.success) {
              setMessages(prev => prev.map(m =>
                m.id === msgId ? { ...m, deleted_at: new Date().toISOString(), content: '' } : m
              ));
            }
          } catch {}
          setSelectedMsg(null);
        },
      },
    ]);
  };

  const handleReact = async (msgId, emoji) => {
    try {
      const r = await api.chatReact(msgId, emoji);
      if (r.success) {
        setMessages(prev => prev.map(m => {
          if (m.id !== msgId) return m;
          return { ...m, reactions: r.data?.reactions || [] };
        }));
      }
    } catch {}
    setShowReactions(null);
  };

  const handleEdit = (msg) => {
    setEditingMsg(msg);
    setInputText(msg.content);
    setSelectedMsg(null);
    inputRef.current?.focus();
  };

  const handleReply = (msg) => {
    setReplyTo(msg);
    setSelectedMsg(null);
    inputRef.current?.focus();
  };

  const handleLongPress = (msg) => {
    if (msg.type === 'system' || msg.deleted_at) return;
    setSelectedMsg(msg);
  };

  // Start call from chat
  const [startingCall, setStartingCall] = useState(false);
  const startCall = async (videoEnabled) => {
    if (startingCall) return;
    setStartingCall(true);
    try {
      const label = videoEnabled ? t('chat.videoCall') : t('chat.voiceCall');
      const r = await api.meetCreate(conversationName || label, false);
      if (r.success && r.data?.room_id) {
        const joinUrl = `https://mail.onemundo.com.br/meet/${r.data.room_id}`;
        await api.chatSend(conversationId, `${label}\n${t('chat.joinAt')}: ${joinUrl}`, 'text', null);
        router.push(`/meet/${r.data.room_id}${videoEnabled ? '' : '?video=off'}`);
      }
    } catch {} finally {
      setStartingCall(false);
    }
  };
  const handleStartVideoCall = () => startCall(true);
  const handleStartAudioCall = () => startCall(false);

  // ============================================================
  // PRESENCE SUBTITLE
  // ============================================================

  const getPresenceText = () => {
    if (conversationType === 'group') return t('chatConv.group');
    if (!presence) return '';
    if (presence.status === 'online') return 'online';
    if (presence.status === 'away') return 'ausente';
    if (presence.last_seen) return `visto por ultimo ${formatLastSeen(presence.last_seen, t)}`;
    return 'offline';
  };

  const getPresenceColor = () => {
    if (!presence || conversationType === 'group') return colors.textTertiary;
    if (presence.status === 'online') return '#10b981';
    if (presence.status === 'away') return '#f59e0b';
    return colors.textTertiary;
  };

  // ============================================================
  // GROUP MESSAGES BY DATE
  // ============================================================

  const messagesWithSeparators = React.useMemo(() => {
    const result = [];
    let lastDate = '';
    for (const msg of messages) {
      const d = new Date(msg.created_at + 'Z');
      const dateKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (dateKey !== lastDate) {
        result.push({ _type: 'separator', _key: 'sep-' + dateKey, date: msg.created_at });
        lastDate = dateKey;
      }
      result.push(msg);
    }
    return result;
  }, [messages]);

  // ============================================================
  // RENDER MESSAGE
  // ============================================================

  const renderMessage = ({ item }) => {
    if (item._type === 'separator') {
      return (
        <View style={styles.dateSeparator}>
          <View style={[styles.dateLine, { backgroundColor: colors.border }]} />
          <Text style={[styles.dateText, { color: colors.textTertiary, backgroundColor: colors.background }]}>
            {formatDateSeparator(item.date, t)}
          </Text>
          <View style={[styles.dateLine, { backgroundColor: colors.border }]} />
        </View>
      );
    }

    const msg = item;
    const isOwn = msg.sender_email === currentEmail;
    const isSystem = msg.type === 'system';
    const isDeleted = !!msg.deleted_at;

    if (isSystem) {
      return (
        <View style={styles.systemMsg}>
          <Text style={[styles.systemText, { color: colors.textTertiary }]}>{msg.content}</Text>
        </View>
      );
    }

    const reactionGroups = {};
    if (msg.reactions) {
      msg.reactions.forEach(r => {
        const emoji = r.emoji || r.reaction;
        if (!emoji) return;
        const users = typeof r.users === 'string' ? r.users.split(',') : (r.users || []);
        reactionGroups[emoji] = users;
      });
    }

    // Render content based on message type
    const renderContent = () => {
      if (isDeleted) {
        return (
          <Text style={[styles.deletedText, { color: isOwn ? 'rgba(255,255,255,0.5)' : colors.textTertiary }]}>
            {t('chatConv.deletedMessage')}
          </Text>
        );
      }

      switch (msg.type) {
        case 'image':
          return (
            <TouchableOpacity onPress={() => msg.file_url && Linking.openURL(msg.file_url.startsWith('http') ? msg.file_url : `https://mail.onemundo.com.br${msg.file_url}`)} activeOpacity={0.9}>
              <Image
                source={{ uri: msg.file_url?.startsWith('http') ? msg.file_url : `https://mail.onemundo.com.br${msg.file_url}` }}
                style={styles.chatImage}
                resizeMode="cover"
              />
              {msg.content && msg.content !== msg.file_name && (
                <Text style={[styles.msgText, { color: isOwn ? '#fff' : colors.text, marginTop: 4 }]}>{msg.content}</Text>
              )}
            </TouchableOpacity>
          );

        case 'video':
          return (
            <TouchableOpacity
              onPress={() => msg.file_url && Linking.openURL(msg.file_url.startsWith('http') ? msg.file_url : `https://mail.onemundo.com.br${msg.file_url}`)}
              style={styles.videoThumb}
            >
              <View style={styles.videoOverlay}>
                <View style={[styles.videoPlayBtn, { backgroundColor: 'rgba(0,0,0,0.5)' }]}>
                  <IconPlay size={24} color="#fff" />
                </View>
              </View>
              <Text style={[styles.msgText, { color: isOwn ? '#fff' : colors.text }]} numberOfLines={1}>
                {msg.file_name || msg.content || 'Video'}
              </Text>
              {msg.file_size > 0 && (
                <Text style={{ fontSize: 11, color: isOwn ? 'rgba(255,255,255,0.5)' : colors.textTertiary }}>
                  {msg.file_size < 1048576 ? (msg.file_size / 1024).toFixed(0) + ' KB' : (msg.file_size / 1048576).toFixed(1) + ' MB'}
                </Text>
              )}
            </TouchableOpacity>
          );

        case 'audio':
          return (
            <AudioPlayer
              url={msg.file_url?.startsWith('http') ? msg.file_url : `https://mail.onemundo.com.br${msg.file_url}`}
              duration={msg.duration || 0}
              isOwn={isOwn}
              colors={colors}
            />
          );

        case 'location':
          return <LocationMessage content={msg.content} isOwn={isOwn} colors={colors} />;

        case 'contact':
          return <ContactMessage content={msg.content} isOwn={isOwn} colors={colors} />;

        case 'sticker':
          return (
            <Image
              source={{ uri: msg.content || msg.file_url }}
              style={{ width: 120, height: 120 }}
              resizeMode="contain"
            />
          );

        case 'file':
          return (
            <TouchableOpacity
              onPress={() => msg.file_url && Linking.openURL(msg.file_url.startsWith('http') ? msg.file_url : `https://mail.onemundo.com.br${msg.file_url}`)}
              style={styles.fileAttach}
            >
              <IconFileText size={20} color={isOwn ? 'rgba(255,255,255,0.8)' : colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.msgText, { color: isOwn ? '#fff' : colors.text }]} numberOfLines={1}>{msg.file_name || msg.content}</Text>
                {msg.file_size > 0 && (
                  <Text style={{ fontSize: 11, color: isOwn ? 'rgba(255,255,255,0.5)' : colors.textTertiary }}>
                    {msg.file_size < 1048576 ? (msg.file_size / 1024).toFixed(0) + ' KB' : (msg.file_size / 1048576).toFixed(1) + ' MB'}
                  </Text>
                )}
              </View>
            </TouchableOpacity>
          );

        default: // text
          return (
            <Text style={[styles.msgText, { color: isOwn ? '#fff' : colors.text }]}>
              {msg.content}
            </Text>
          );
      }
    };

    return (
      <TouchableOpacity
        activeOpacity={0.8}
        onLongPress={() => handleLongPress(msg)}
        style={[styles.msgRow, isOwn ? styles.msgRowOwn : styles.msgRowOther]}
      >
        {!isOwn && conversationType === 'group' && !isDeleted && (
          <Text style={[styles.msgSender, { color: colors.primary }]}>
            {msg.sender_name || msg.sender_email.split('@')[0]}
          </Text>
        )}

        {msg.reply_to && !isDeleted && (
          <View style={[styles.replyIndicator, {
            backgroundColor: isOwn ? 'rgba(255,255,255,0.15)' : colors.border + '60',
            borderLeftColor: colors.primary,
          }]}>
            <Text style={[styles.replyName, { color: isOwn ? 'rgba(255,255,255,0.8)' : colors.primary }]} numberOfLines={1}>
              {msg.reply_to?.sender_name || t('chat.unknown')}
            </Text>
            <Text style={[styles.replyText, { color: isOwn ? 'rgba(255,255,255,0.6)' : colors.textSecondary }]} numberOfLines={1}>
              {msg.reply_to.content || ''}
            </Text>
          </View>
        )}

        <View style={[
          styles.bubble,
          isOwn
            ? [styles.bubbleOwn, { backgroundColor: colors.primary }]
            : [styles.bubbleOther, { backgroundColor: colors.surface, borderColor: colors.border }],
          isDeleted && styles.bubbleDeleted,
          msg.type === 'sticker' && { backgroundColor: 'transparent', borderWidth: 0, paddingHorizontal: 0, elevation: 0 },
        ]}>
          {renderContent()}
          {msg.type !== 'sticker' && (
            <View style={styles.msgMeta}>
              {msg.edited_at && !isDeleted && (
                <Text style={[styles.editedLabel, { color: isOwn ? 'rgba(255,255,255,0.5)' : colors.textTertiary }]}>
                  {t('chatConv.edited')}
                </Text>
              )}
              <Text style={[styles.msgTime, { color: isOwn ? 'rgba(255,255,255,0.6)' : colors.textTertiary }]}>
                {formatTime(msg.created_at)}
              </Text>
              {isOwn && !isDeleted && (() => {
                const isRead = readReceipts.some(rr => rr.last_read_id >= msg.id);
                return isRead ? (
                  <View style={{ flexDirection: 'row', marginLeft: 2 }}>
                    <IconCheck size={12} color="#34D399" style={{ marginRight: -6 }} />
                    <IconCheck size={12} color="#34D399" />
                  </View>
                ) : (
                  <IconCheck size={12} color="rgba(255,255,255,0.6)" />
                );
              })()}
            </View>
          )}
        </View>

        {Object.keys(reactionGroups).length > 0 && !isDeleted && (
          <View style={[styles.reactionsRow, isOwn && styles.reactionsRowOwn]}>
            {Object.entries(reactionGroups).map(([emoji, users]) => (
              <TouchableOpacity
                key={emoji}
                onPress={() => handleReact(msg.id, emoji)}
                style={[styles.reactionChip, {
                  backgroundColor: users.includes(currentEmail) ? colors.primary + '20' : colors.surface,
                  borderColor: users.includes(currentEmail) ? colors.primary : colors.border,
                }]}
              >
                {(() => { const RIcon = REACTION_ICON_MAP[emoji]; return RIcon ? <RIcon size={14} color={colors.text} /> : <Text style={styles.reactionEmoji}>{emoji}</Text>; })()}
                <Text style={[styles.reactionCount, { color: colors.text }]}>{users.length}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </TouchableOpacity>
    );
  };

  // ============================================================
  // RENDER
  // ============================================================

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      {/* Header with presence */}
      <View style={[styles.header, { borderBottomColor: colors.border, paddingTop: insets.top }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerInfo}>
          <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
            {conversationName}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            {presence?.status === 'online' && conversationType === 'direct' && (
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: '#10b981' }} />
            )}
            <Text style={[styles.headerSubtitle, { color: getPresenceColor() }]}>
              {getPresenceText()}
            </Text>
          </View>
        </View>
        <TouchableOpacity onPress={handleStartAudioCall} disabled={startingCall} style={styles.headerBtn}>
          <IconPhone size={19} color={colors.primary} />
        </TouchableOpacity>
        <TouchableOpacity onPress={handleStartVideoCall} disabled={startingCall} style={styles.headerBtn}>
          {startingCall
            ? <ActivityIndicator size="small" color={colors.primary} />
            : <IconVideo size={20} color={colors.primary} />}
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => router.push(`/chat-new?group_id=${conversationId}&mode=info`)}
          style={styles.headerBtn}
        >
          <IconUsers size={20} color={colors.text} />
        </TouchableOpacity>
      </View>

      {/* Messages */}
      {loading ? (
        <View style={styles.loaderWrap}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          data={messagesWithSeparators}
          keyExtractor={(item) => item._key || String(item.id)}
          renderItem={renderMessage}
          contentContainerStyle={[styles.messageList, { paddingBottom: Spacing.sm }]}
          onContentSizeChange={() => {
            if (!loadingMore) {
              flatListRef.current?.scrollToEnd?.({ animated: false });
            }
          }}
          onLayout={() => {
            flatListRef.current?.scrollToEnd?.({ animated: false });
          }}
          ListHeaderComponent={
            hasMore ? (
              <TouchableOpacity
                onPress={handleLoadMore}
                style={[styles.loadMoreBtn, { borderColor: colors.border }]}
              >
                {loadingMore ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <Text style={[styles.loadMoreText, { color: colors.primary }]}>{t('chatConv.loadMore')}</Text>
                )}
              </TouchableOpacity>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.emptyMessages}>
              <Text style={[styles.emptyText, { color: colors.textTertiary }]}>
                {t('chatConv.empty')}
              </Text>
            </View>
          }
        />
      )}

      {/* Reply/Edit indicator */}
      {(replyTo || editingMsg) && (
        <View style={[styles.replyBar, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
          <View style={[styles.replyBarLine, { backgroundColor: colors.primary }]} />
          <View style={styles.replyBarContent}>
            <Text style={[styles.replyBarLabel, { color: colors.primary }]}>
              {editingMsg ? t('chat.editing') : t('chat.replyingTo', { name: replyTo?.sender_name || t('chat.message') })}
            </Text>
            <Text style={[styles.replyBarText, { color: colors.textSecondary }]} numberOfLines={1}>
              {editingMsg ? editingMsg.content : replyTo?.content}
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => { setReplyTo(null); setEditingMsg(null); setInputText(''); }}
            style={styles.replyBarClose}
          >
            <IconX size={18} color={colors.textTertiary} />
          </TouchableOpacity>
        </View>
      )}

      {/* Upload indicator */}
      {uploading && (
        <View style={[styles.uploadBar, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[styles.uploadText, { color: colors.textSecondary }]}>Enviando...</Text>
        </View>
      )}

      {/* Audio Recorder (replaces input bar when recording) */}
      {isRecording ? (
        <View style={{ paddingBottom: Math.max(insets.bottom, Spacing.sm) }}>
          <AudioRecorder
            onSend={handleSendAudio}
            onCancel={() => setIsRecording(false)}
            colors={colors}
          />
        </View>
      ) : (
        /* Input Bar */
        <View style={[styles.inputBar, {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          paddingBottom: Math.max(insets.bottom, Spacing.sm),
        }]}>
          {/* Attachment button (opens menu) */}
          <TouchableOpacity
            onPress={() => setShowAttachMenu(true)}
            disabled={uploading}
            style={styles.attachBtn}
          >
            {uploading ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : (
              <IconPlus size={22} color={colors.textSecondary} />
            )}
          </TouchableOpacity>

          <TextInput
            ref={inputRef}
            style={[styles.input, {
              color: colors.text,
              backgroundColor: colors.background,
              borderColor: colors.border,
            }]}
            placeholder={t('chatConv.messagePlaceholder')}
            placeholderTextColor={colors.textTertiary}
            value={inputText}
            onChangeText={setInputText}
            multiline
            maxLength={5000}
            onSubmitEditing={Platform.OS === 'web' ? handleSend : undefined}
            blurOnSubmit={Platform.OS === 'web'}
          />

          {/* Show mic button when input is empty, send button when there's text */}
          {inputText.trim() ? (
            <TouchableOpacity
              onPress={handleSend}
              disabled={sending}
              style={[styles.sendBtn, { backgroundColor: colors.primary }]}
            >
              {sending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <IconSend size={18} color="#fff" />
              )}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={() => setIsRecording(true)}
              style={[styles.sendBtn, { backgroundColor: colors.primary }]}
            >
              <IconMic size={20} color="#fff" />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Attachment Menu Modal */}
      <AttachmentMenu
        visible={showAttachMenu}
        onClose={() => setShowAttachMenu(false)}
        onPick={handlePickAttachment}
        colors={colors}
      />

      {/* Message Action Modal */}
      <Modal
        visible={!!selectedMsg}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectedMsg(null)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setSelectedMsg(null)}
        >
          <View style={[styles.actionSheet, { backgroundColor: colors.surface }, Shadow.lg]}>
            <View style={styles.quickReactions}>
              {QUICK_REACTIONS.map(r => (
                <TouchableOpacity
                  key={r.key}
                  onPress={() => { handleReact(selectedMsg?.id, r.key); setSelectedMsg(null); }}
                  style={styles.quickReactionBtn}
                >
                  <r.Icon size={28} color={colors.text} />
                </TouchableOpacity>
              ))}
            </View>

            <View style={[styles.actionDivider, { backgroundColor: colors.border }]} />

            <TouchableOpacity
              style={styles.actionItem}
              onPress={() => handleReply(selectedMsg)}
            >
              <IconReply size={18} color={colors.text} />
              <Text style={[styles.actionText, { color: colors.text }]}>{t('chatConv.reply')}</Text>
            </TouchableOpacity>

            {selectedMsg?.sender_email === currentEmail && !selectedMsg?.deleted_at && selectedMsg?.type === 'text' && (
              <TouchableOpacity
                style={styles.actionItem}
                onPress={() => handleEdit(selectedMsg)}
              >
                <IconEdit size={18} color={colors.text} />
                <Text style={[styles.actionText, { color: colors.text }]}>{t('chatConv.edit')}</Text>
              </TouchableOpacity>
            )}

            {selectedMsg?.sender_email === currentEmail && !selectedMsg?.deleted_at && (
              <TouchableOpacity
                style={styles.actionItem}
                onPress={() => handleDelete(selectedMsg?.id)}
              >
                <IconTrash size={18} color={colors.error} />
                <Text style={[styles.actionText, { color: colors.error }]}>{t('chatConv.delete')}</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={styles.actionItem}
              onPress={() => setSelectedMsg(null)}
            >
              <IconX size={18} color={colors.textSecondary} />
              <Text style={[styles.actionText, { color: colors.textSecondary }]}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

// ============================================================
// STYLES
// ============================================================

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.sm, paddingBottom: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerInfo: { flex: 1, marginHorizontal: Spacing.sm },
  headerTitle: { fontSize: FontSize.lg, fontWeight: '700' },
  headerSubtitle: { fontSize: FontSize.xs },
  loaderWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  messageList: { paddingHorizontal: Spacing.sm, paddingTop: Spacing.sm },
  dateSeparator: {
    flexDirection: 'row', alignItems: 'center',
    marginVertical: Spacing.md, paddingHorizontal: Spacing.sm,
  },
  dateLine: { flex: 1, height: StyleSheet.hairlineWidth },
  dateText: {
    fontSize: FontSize.xs, fontWeight: '600',
    paddingHorizontal: Spacing.sm,
  },
  systemMsg: { alignItems: 'center', marginVertical: Spacing.xs, paddingHorizontal: Spacing.lg },
  systemText: { fontSize: FontSize.xs, textAlign: 'center', fontStyle: 'italic' },
  msgRow: { marginBottom: Spacing.xs, maxWidth: '80%' },
  msgRowOwn: { alignSelf: 'flex-end' },
  msgRowOther: { alignSelf: 'flex-start' },
  msgSender: { fontSize: FontSize.xs, fontWeight: '600', marginBottom: 2, marginLeft: 4 },
  replyIndicator: {
    borderLeftWidth: 3, borderRadius: BorderRadius.sm,
    paddingHorizontal: Spacing.sm, paddingVertical: 4,
    marginBottom: 4,
  },
  replyName: { fontSize: FontSize.xs, fontWeight: '600' },
  replyText: { fontSize: FontSize.xs },
  bubble: {
    borderRadius: BorderRadius.lg, paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm, paddingBottom: 6,
  },
  bubbleOwn: { borderBottomRightRadius: 4 },
  bubbleOther: { borderBottomLeftRadius: 4, borderWidth: StyleSheet.hairlineWidth },
  bubbleDeleted: { opacity: 0.6 },
  msgText: { fontSize: FontSize.md, lineHeight: 22 },
  deletedText: { fontSize: FontSize.sm, fontStyle: 'italic' },
  msgMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginTop: 2 },
  editedLabel: { fontSize: 10 },
  msgTime: { fontSize: 10 },
  chatImage: { width: 220, height: 180, borderRadius: BorderRadius.md, marginBottom: 2 },
  videoThumb: { paddingVertical: 4 },
  videoOverlay: {
    width: 220, height: 120, borderRadius: BorderRadius.md,
    backgroundColor: 'rgba(0,0,0,0.3)', alignItems: 'center', justifyContent: 'center',
    marginBottom: 4,
  },
  videoPlayBtn: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  fileAttach: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  reactionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  reactionsRowOwn: { justifyContent: 'flex-end' },
  reactionChip: {
    flexDirection: 'row', alignItems: 'center', gap: 2,
    paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: BorderRadius.full || 99, borderWidth: 1,
  },
  reactionEmoji: { fontSize: 14 },
  reactionCount: { fontSize: 11, fontWeight: '600' },
  loadMoreBtn: {
    alignSelf: 'center', paddingVertical: Spacing.sm, paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.md, borderWidth: 1, marginBottom: Spacing.sm,
  },
  loadMoreText: { fontSize: FontSize.sm, fontWeight: '500' },
  emptyMessages: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 100 },
  emptyText: { fontSize: FontSize.md },
  replyBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  replyBarLine: { width: 3, height: '100%', borderRadius: 2, marginRight: Spacing.sm },
  replyBarContent: { flex: 1 },
  replyBarLabel: { fontSize: FontSize.xs, fontWeight: '600' },
  replyBarText: { fontSize: FontSize.sm },
  replyBarClose: { padding: 8 },
  uploadBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: Spacing.md, paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  uploadText: { fontSize: FontSize.sm },
  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: Spacing.sm, paddingTop: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: Spacing.sm,
  },
  input: {
    flex: 1, minHeight: 40, maxHeight: 120,
    borderRadius: BorderRadius.lg, paddingHorizontal: Spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    fontSize: FontSize.md, borderWidth: 1,
  },
  attachBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  sendBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  modalOverlay: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  actionSheet: {
    borderRadius: BorderRadius.xl, padding: Spacing.md,
    minWidth: 280, maxWidth: 340,
  },
  quickReactions: {
    flexDirection: 'row', justifyContent: 'center', gap: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  quickReactionBtn: { padding: 4 },
  actionDivider: { height: StyleSheet.hairlineWidth, marginVertical: Spacing.sm },
  actionItem: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    paddingVertical: Spacing.md, paddingHorizontal: Spacing.sm,
  },
  actionText: { fontSize: FontSize.md, fontWeight: '500' },
});
