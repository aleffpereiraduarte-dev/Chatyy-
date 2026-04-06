import { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, Image, Platform,
  Dimensions, Animated, PanResponder, ActivityIndicator, Linking, StatusBar, Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconX, IconDownload, IconPlay, IconPause } from './Icons';

// expo-video for native MOV/MP4 playback (SDK 55+)
let ExpoVideo = null;
let useVideoPlayer = null;
if (Platform.OS !== 'web') {
  try {
    const mod = require('expo-video');
    ExpoVideo = mod.VideoView;
    useVideoPlayer = mod.useVideoPlayer;
  } catch {}
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'webm', 'mkv', 'm4v', '3gp'];
const PDF_EXTS = ['pdf'];
const DOCX_EXTS = ['docx', 'doc'];
const PREVIEWABLE_EXTS = [...PDF_EXTS, ...DOCX_EXTS];

function getExt(filename) {
  return (filename || '').split('.').pop().toLowerCase();
}

function getFullUrl(url) {
  if (!url) return '';
  return url.startsWith('http') ? url : `https://chatyy.com.br${url}`;
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// ============================================================
// IMAGE VIEWER with pan/zoom
// ============================================================
function ImageViewer({ url }) {
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const [loading, setLoading] = useState(true);
  const lastScale = useRef(1);
  const lastTranslateX = useRef(0);
  const lastTranslateY = useRef(0);
  const lastTap = useRef(0);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2,
      onPanResponderGrant: () => {
        // Double-tap to zoom
        const now = Date.now();
        if (now - lastTap.current < 300) {
          const target = lastScale.current > 1 ? 1 : 2.5;
          Animated.spring(scale, { toValue: target, useNativeDriver: false, friction: 7 }).start();
          if (target === 1) {
            Animated.spring(translateX, { toValue: 0, useNativeDriver: false }).start();
            Animated.spring(translateY, { toValue: 0, useNativeDriver: false }).start();
            lastTranslateX.current = 0;
            lastTranslateY.current = 0;
          }
          lastScale.current = target;
        }
        lastTap.current = now;
      },
      onPanResponderMove: (_, g) => {
        if (lastScale.current > 1) {
          translateX.setValue(lastTranslateX.current + g.dx);
          translateY.setValue(lastTranslateY.current + g.dy);
        }
      },
      onPanResponderRelease: (_, g) => {
        lastTranslateX.current += g.dx;
        lastTranslateY.current += g.dy;
      },
    })
  ).current;

  return (
    <View style={s.mediaContainer}>
      {loading && <ActivityIndicator size="large" color="#fff" style={s.loader} />}
      <Animated.View
        {...panResponder.panHandlers}
        style={[s.mediaContainer, {
          transform: [
            { scale },
            { translateX },
            { translateY },
          ],
        }]}
      >
        <Image
          source={{ uri: url }}
          style={s.fullImage}
          resizeMode="contain"
          onLoadEnd={() => setLoading(false)}
        />
      </Animated.View>
    </View>
  );
}

// ============================================================
// NATIVE VIDEO PLAYER (expo-video — plays MOV, MP4, WebM natively)
// ============================================================
function NativeVideoPlayer({ url }) {
  if (!useVideoPlayer || !ExpoVideo) return null;
  const player = useVideoPlayer(url, p => { p.play(); });
  return (
    <View style={s.mediaContainer}>
      <ExpoVideo
        player={player}
        style={s.fullVideo}
        allowsFullscreen
        allowsPictureInPicture
        nativeControls
      />
    </View>
  );
}

// VIDEO PLAYER (web fallback + native fallback)
// ============================================================
function VideoPlayer({ url }) {
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const videoRef = useRef(null);
  const webVideoRef = useRef(null);
  const intervalRef = useRef(null);

  useEffect(() => {
    return () => {
      if (Platform.OS === 'web') {
        try { webVideoRef.current?.pause(); } catch {}
      } else {
        videoRef.current?.unloadAsync?.().catch(() => {});
      }
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  if (Platform.OS === 'web') {
    return (
      <View style={s.mediaContainer}>
        <video
          ref={webVideoRef}
          src={url}
          controls
          playsInline
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 8 }}
          onLoadedData={() => setLoading(false)}
        />
        {loading && <ActivityIndicator size="large" color="#fff" style={s.loader} />}
      </View>
    );
  }

  // Native: try expo-video first (best MOV support)
  if (useVideoPlayer && ExpoVideo) {
    return <NativeVideoPlayer url={url} />;
  }

  // Fallback: WebView with video tag
  const { WebView } = require('react-native-webview');
  return (
    <View style={s.mediaContainer}>
      <WebView
        source={{ html: `<html><body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh"><video controls autoplay playsinline style="max-width:100%;max-height:100%;object-fit:contain"><source src="${url}" type="video/mp4" /><source src="${url}" type="video/quicktime" /></video></body></html>` }}
        style={s.fullVideo}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        onLoad={() => setLoading(false)}
      />
      {loading && <ActivityIndicator size="large" color="#fff" style={s.loader} />}
    </View>
  );
}

// ============================================================
// Build preview.html URL for PDF/DOCX files
// ============================================================
function buildPreviewUrl(fileUrl, fileName) {
  const ext = getExt(fileName);
  const typeMap = { pdf: 'pdf', docx: 'docx', doc: 'docx' };
  const type = typeMap[ext] || '';
  return `/preview.html?url=${encodeURIComponent(fileUrl)}&type=${encodeURIComponent(type)}&name=${encodeURIComponent(fileName || 'file')}`;
}

// ============================================================
// PREVIEW VIEWER (PDF/DOCX via preview.html)
// ============================================================
function PreviewViewer({ url, filename }) {
  const previewUrl = buildPreviewUrl(url, filename);

  if (Platform.OS === 'web') {
    return (
      <View style={s.mediaContainer}>
        <iframe
          src={previewUrl}
          style={{ width: '100%', height: SCREEN_H - 100, minHeight: 400, border: 'none', borderRadius: 8 }}
          title={filename}
        />
      </View>
    );
  }

  // Native: use WebView if available, otherwise fallback to download
  try {
    const { WebView } = require('react-native-webview');
    const fullPreviewUrl = getFullUrl(previewUrl);
    return (
      <View style={s.mediaContainer}>
        <WebView
          source={{ uri: fullPreviewUrl }}
          style={{ flex: 1, width: '100%' }}
          javaScriptEnabled
          domStorageEnabled
          startInLoadingState
          renderLoading={() => <ActivityIndicator size="large" color="#fff" style={s.loader} />}
        />
      </View>
    );
  } catch {
    // Fallback if WebView not available
    return (
      <GenericFileViewer url={url} filename={filename} fileSize={0} />
    );
  }
}

// ============================================================
// GENERIC FILE VIEWER (download-only fallback)
// ============================================================
function GenericFileViewer({ url, filename, fileSize }) {
  const ext = getExt(filename);

  return (
    <View style={[s.mediaContainer, { justifyContent: 'center', alignItems: 'center' }]}>
      <View style={s.fileIcon}>
        <Text style={s.fileExtText}>{ext.toUpperCase()}</Text>
      </View>
      <Text style={s.fileNameText} numberOfLines={2}>{filename}</Text>
      {fileSize > 0 && <Text style={s.fileSizeText}>{formatSize(fileSize)}</Text>}
      <TouchableOpacity
        style={s.openExternalBtn}
        onPress={() => Linking.openURL(url).catch(() => {})}
        accessibilityLabel="Download"
        accessibilityRole="button"
      >
        <IconDownload size={18} color="#fff" />
        <Text style={s.openExternalText}>Abrir / Baixar</Text>
      </TouchableOpacity>
    </View>
  );
}

// ============================================================
// MAIN MODAL
// ============================================================
export default function ChatMediaViewer({ visible, onClose, fileUrl, fileName, fileSize, type, viewOnce }) {
  const insets = useSafeAreaInsets();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  if (!visible) return null;

  const url = getFullUrl(fileUrl);
  const ext = getExt(fileName);
  const isImage = type === 'image' || IMAGE_EXTS.includes(ext);
  const isVideo = type === 'video' || VIDEO_EXTS.includes(ext);
  const isPreviewable = PREVIEWABLE_EXTS.includes(ext);

  const handleDownload = async () => {
    if (viewOnce) return;
    if (Platform.OS === 'web') {
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName || 'download';
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } else {
      // Save to device gallery (like WhatsApp)
      try {
        setSaving(true);
        const ML = require('expo-media-library');
        const perm = await ML.requestPermissionsAsync(true); // true = write access
        if (perm.status !== 'granted' && perm.accessPrivileges !== 'all') {
          Alert.alert('Permissao necessaria', 'Va em Ajustes > Chatyy > Fotos e selecione "Todas as fotos".');
          setSaving(false);
          return;
        }
        const FS = require('expo-file-system');
        const ext = (fileName || 'file').split('.').pop() || 'jpg';
        const localPath = FS.cacheDirectory + 'chatyy_save_' + Date.now() + '.' + ext;

        // Check if file is already cached locally
        const cachedPath = FS.cacheDirectory + 'chat-media/' + (fileName || url.split('/').pop()?.split('?')[0] || 'file');
        const cachedInfo = await FS.getInfoAsync(cachedPath).catch(() => ({ exists: false }));

        // Download to temp file
        const download = await FS.downloadAsync(url, localPath);
        if (!download?.uri) {
          Alert.alert('Erro', 'Download falhou.');
          setSaving(false);
          return;
        }

        // Save to gallery — try createAssetAsync first (more reliable)
        try {
          const asset = await ML.createAssetAsync(download.uri);
          if (asset) {
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
          }
        } catch (saveErr) {
          // Fallback to saveToLibraryAsync
          try {
            await ML.saveToLibraryAsync(download.uri);
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
          } catch (saveErr2) {
            Alert.alert('Erro ao salvar', 'Verifique as permissoes de Fotos em Ajustes > Chatyy');
          }
        }
        // Cleanup temp file
        FS.deleteAsync(localPath, { idempotent: true }).catch(() => {});
      } catch (e) {
        Alert.alert('Erro ao salvar', e?.message || 'Verifique a permissao de fotos nas configuracoes.');
      } finally {
        setSaving(false);
      }
    }
  };

  // View-once: block context menu and screenshots on web
  const viewOnceStyle = viewOnce && Platform.OS === 'web' ? {
    WebkitUserSelect: 'none',
    userSelect: 'none',
    WebkitTouchCallout: 'none',
    pointerEvents: 'auto',
  } : {};

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View
        style={[s.backdrop, viewOnceStyle]}
        onContextMenu={viewOnce ? (e) => e.preventDefault?.() : undefined}
      >
        {/* Header */}
        <View style={[s.header, { paddingTop: Math.max(insets.top, 12) + 8 }]}>
          <View style={s.headerInfo}>
            <Text style={s.headerTitle} numberOfLines={1}>
              {viewOnce ? '🔒 ' : ''}{fileName || (isImage ? 'Imagem' : isVideo ? 'Video' : 'Arquivo')}
            </Text>
            {fileSize > 0 && !viewOnce && <Text style={s.headerSize}>{formatSize(fileSize)}</Text>}
            {viewOnce && <Text style={s.headerSize}>Visualização única</Text>}
          </View>
          {!viewOnce && (
            <TouchableOpacity onPress={handleDownload} disabled={saving} style={s.headerBtn} hitSlop={12} accessibilityLabel="Download" accessibilityRole="button">
              {saving ? <ActivityIndicator size="small" color="#fff" /> : saved ? <Text style={{ color: '#22c55e', fontSize: 16, fontWeight: '700' }}>✓</Text> : <IconDownload size={20} color="#fff" />}
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={onClose} style={s.headerBtn} hitSlop={12} accessibilityLabel="Close" accessibilityRole="button">
            <IconX size={22} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Content */}
        {isImage ? (
          <ImageViewer url={url} />
        ) : isVideo ? (
          <VideoPlayer url={url} />
        ) : isPreviewable ? (
          <PreviewViewer url={url} filename={fileName} />
        ) : (
          <GenericFileViewer url={url} filename={fileName} fileSize={fileSize} />
        )}

        {/* Bottom safe area spacer */}
        <View style={{ height: Math.max(insets.bottom, 12) }} />
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 10,
    gap: 12,
  },
  headerInfo: { flex: 1 },
  headerTitle: { color: '#fff', fontSize: 15, fontWeight: '600' },
  headerSize: { color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 1 },
  headerBtn: { padding: 8 },
  mediaContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loader: {
    position: 'absolute',
    zIndex: 10,
  },
  fullImage: {
    width: SCREEN_W,
    height: SCREEN_H * 0.75,
  },
  fullVideo: {
    width: SCREEN_W,
    height: SCREEN_H * 0.65,
  },
  fileIcon: {
    width: 80,
    height: 80,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  fileExtText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
  },
  fileNameText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '500',
    textAlign: 'center',
    paddingHorizontal: 40,
    marginBottom: 6,
  },
  fileSizeText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 13,
    marginBottom: 24,
  },
  openExternalBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#2563eb',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  openExternalText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
