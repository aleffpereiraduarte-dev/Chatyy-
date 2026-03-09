import { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, Image, Platform,
  Dimensions, Animated, PanResponder, ActivityIndicator, Linking, StatusBar,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconX, IconDownload, IconPlay, IconPause } from './Icons';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'webm', 'mkv', 'm4v', '3gp'];
const PDF_EXTS = ['pdf'];

function getExt(filename) {
  return (filename || '').split('.').pop().toLowerCase();
}

function getFullUrl(url) {
  if (!url) return '';
  return url.startsWith('http') ? url : `https://mail.onemundo.com.br${url}`;
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
          Animated.spring(scale, { toValue: target, useNativeDriver: true, friction: 7 }).start();
          if (target === 1) {
            Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
            Animated.spring(translateY, { toValue: 0, useNativeDriver: true }).start();
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
// VIDEO PLAYER
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

  // Native: use expo-video VideoView
  const { VideoView, useVideoPlayer } = require('expo-video');

  // Create player for native video
  const NativeVideoPlayer = () => {
    const player = useVideoPlayer({ uri: url }, (p) => {
      p.play();
    });

    return (
      <View style={s.mediaContainer}>
        <VideoView
          ref={videoRef}
          player={player}
          style={s.fullVideo}
          contentFit="contain"
          nativeControls
          onReadyForDisplay={() => setLoading(false)}
        />
        {loading && <ActivityIndicator size="large" color="#fff" style={s.loader} />}
      </View>
    );
  };

  return <NativeVideoPlayer />;
}

// ============================================================
// PDF / FILE VIEWER
// ============================================================
function FileViewer({ url, filename, fileSize }) {
  const ext = getExt(filename);
  const isPdf = PDF_EXTS.includes(ext);

  if (isPdf && Platform.OS === 'web') {
    return (
      <View style={s.mediaContainer}>
        <iframe
          src={url}
          style={{ width: '100%', height: '100%', border: 'none', borderRadius: 8 }}
          title={filename}
        />
      </View>
    );
  }

  // For native PDFs or non-previewable files, show download option
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

  if (!visible) return null;

  const url = getFullUrl(fileUrl);
  const ext = getExt(fileName);
  const isImage = type === 'image' || IMAGE_EXTS.includes(ext);
  const isVideo = type === 'video' || VIDEO_EXTS.includes(ext);

  const handleDownload = () => {
    if (viewOnce) return; // No download for view-once
    if (Platform.OS === 'web') {
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName || 'download';
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } else {
      Linking.openURL(url).catch(() => {});
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
            <TouchableOpacity onPress={handleDownload} style={s.headerBtn} hitSlop={12}>
              <IconDownload size={20} color="#fff" />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={onClose} style={s.headerBtn} hitSlop={12}>
            <IconX size={22} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Content */}
        {isImage ? (
          <ImageViewer url={url} />
        ) : isVideo ? (
          <VideoPlayer url={url} />
        ) : (
          <FileViewer url={url} filename={fileName} fileSize={fileSize} />
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
