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
// Native UIScrollView+UIImageView for iOS — pinch/zoom 60fps perfect.
// Falls back to the JS PanResponder implementation on Android/web.
let _NativeImageZoomView = null;
if (Platform.OS === 'ios') {
  try { _NativeImageZoomView = require('../modules/expo-native-toolkit').ImageZoomView; } catch {}
  // Try alternative export shape (native modules sometimes export differently)
  if (!_NativeImageZoomView) {
    try {
      const { requireNativeView } = require('expo');
      _NativeImageZoomView = requireNativeView('ExpoNativeImageZoomView');
    } catch {}
  }
}

function NativeImageViewerWithLoading({ url }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    let cancelled = false;
    const timeout = setTimeout(() => {
      if (!cancelled) {
        setLoading(false);
        setError('Timeout — a imagem demorou muito pra carregar');
      }
    }, 20000);
    Image.prefetch(url)
      .then(() => {
        if (cancelled) return;
        clearTimeout(timeout);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        clearTimeout(timeout);
        setLoading(false);
        setError('Não consegui carregar a imagem');
      });
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [url]);

  return (
    <View style={s.mediaContainer}>
      {!loading && !error && (
        <_NativeImageZoomView style={s.mediaContainer} uri={url} />
      )}
      {loading && (
        <View style={[s.mediaContainer, { alignItems: 'center', justifyContent: 'center' }]}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={{ color: 'rgba(255,255,255,0.6)', marginTop: 12, fontSize: 13 }}>
            Carregando imagem...
          </Text>
        </View>
      )}
      {error && (
        <View style={[s.mediaContainer, { alignItems: 'center', justifyContent: 'center', padding: 24 }]}>
          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600', marginBottom: 6 }}>
            Ops!
          </Text>
          <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, textAlign: 'center' }}>
            {error}
          </Text>
        </View>
      )}
    </View>
  );
}

function ImageViewer({ url }) {
  // We deliberately DO NOT use `_NativeImageZoomView` here even on iOS. The
  // native view downloads via raw URLSession which (a) lacks the loading
  // indicator the user expects and (b) silently fails for some CDN routes.
  // The JS PanResponder implementation below uses RN Image which has a
  // proper `onLoadEnd` event and honors the shared image cache (so the
  // image is already warm from the chat bubble). 60fps zoom still works
  // because scale/translate are driven via useNativeDriver where possible.

  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const [loading, setLoading] = useState(true);
  const [imageError, setImageError] = useState(null);
  // Reset state whenever the URL changes so the spinner stops spinning on
  // the previous image when the modal is opened for a new one.
  useEffect(() => {
    setLoading(true);
    setImageError(null);
  }, [url]);
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
      {loading && !imageError && <ActivityIndicator size="large" color="#fff" style={s.loader} />}
      {imageError && (
        <View style={[s.loader, { alignItems: 'center', justifyContent: 'center', padding: 24 }]} pointerEvents="none">
          <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 8 }}>Nao consegui abrir</Text>
          <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, textAlign: 'center' }} numberOfLines={3}>{imageError}</Text>
        </View>
      )}
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
          onError={(e) => {
            setLoading(false);
            const msg = e?.nativeEvent?.error || 'Erro desconhecido ao carregar a imagem';
            setImageError(String(msg));
          }}
        />
      </Animated.View>
    </View>
  );
}

// ============================================================
// NATIVE VIDEO PLAYER
// First tries the AVPlayerLayer-wrapped Expo View from
// expo-native-toolkit (instant + hardware accelerated). Falls back to
// expo-video on Android/web or if the native module isn't loaded.
// ============================================================
let _NativeVideoPlayerView = null;
if (Platform.OS === 'ios') {
  try { _NativeVideoPlayerView = require('../modules/expo-native-toolkit').VideoPlayer; } catch {}
}

function NativeVideoPlayer({ url }) {
  if (_NativeVideoPlayerView) {
    return (
      <View style={s.mediaContainer}>
        <_NativeVideoPlayerView
          style={s.fullVideo}
          uri={url}
          autoplay={true}
          loop={false}
          muted={false}
        />
      </View>
    );
  }
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

  // Fallback: WebView with video tag. Escape the URL for HTML attribute
  // context — without escaping, a sender-supplied URL containing `"`
  // would close the src attribute and let arbitrary markup/JS execute
  // inside the WebView.
  const safeUrl = String(url || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const { WebView } = require('react-native-webview');
  return (
    <View style={s.mediaContainer}>
      <WebView
        source={{ html: `<html><body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh"><video controls autoplay playsinline style="max-width:100%;max-height:100%;object-fit:contain"><source src="${safeUrl}" type="video/mp4" /><source src="${safeUrl}" type="video/quicktime" /></video></body></html>` }}
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
// PREVIEW VIEWER (PDF/DOCX)
// iOS WKWebView bug: PDFs inside <iframe> show blank. Workaround: load the
// PDF URL DIRECTLY as the WebView source — WKWebView has native PDF rendering
// when the PDF is the document root (not embedded).
// Android / web: iframe via preview.html works fine.
// Office docs (doc/xlsx): google viewer iframe works on Android + web; on iOS
// WKWebView handles the iframe OK because the inner content is HTML (not PDF).
// ============================================================
function PreviewViewer({ url, filename }) {
  const ext = getExt(filename);
  const isPdf = ext === 'pdf';
  const fullFileUrl = getFullUrl(url);
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

  // Native
  try {
    const { WebView } = require('react-native-webview');
    // iOS: load the PDF URL directly so WKWebView uses its built-in PDF reader.
    // Any other platform/ext: use preview.html wrapper (gives us the Baixar header).
    const source = isPdf && Platform.OS === 'ios'
      ? { uri: fullFileUrl }
      : { uri: getFullUrl(previewUrl) };
    return <WebViewWithErrorFallback source={source} url={url} filename={filename} />;
  } catch {
    // Fallback if WebView not available
    return (
      <GenericFileViewer url={url} filename={filename} fileSize={0} />
    );
  }
}

// Wrapper around WebView that shows a friendly "file unavailable" state when
// the HTTP response is 4xx/5xx. Before this guard, iOS would show a blank
// black screen (WKWebView's default for failed PDF loads) and the user had
// no idea whether the file was gone, their network was down, or the app
// was broken.
function WebViewWithErrorFallback({ source, url, filename }) {
  const { WebView } = require('react-native-webview');
  const [errored, setErrored] = useState(null); // { code, description } | null
  if (errored) {
    return (
      <View style={[s.mediaContainer, { justifyContent: 'center', alignItems: 'center', padding: 24 }]}>
        <View style={[s.fileIcon, { backgroundColor: '#EF4444' + '22' }]}>
          <Text style={[s.fileExtText, { color: '#EF4444' }]}>!</Text>
        </View>
        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600', marginTop: 16, textAlign: 'center' }}>
          Arquivo indisponível
        </Text>
        <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, marginTop: 6, textAlign: 'center' }}>
          {errored.code === 404
            ? 'Esse arquivo não está mais disponível no servidor.'
            : 'Não foi possível carregar. Tente novamente em alguns segundos.'}
        </Text>
        <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 12, textAlign: 'center' }} numberOfLines={2}>
          {filename}
        </Text>
      </View>
    );
  }
  return (
    <View style={s.mediaContainer}>
      <WebView
        source={source}
        style={{ flex: 1, width: '100%' }}
        javaScriptEnabled
        domStorageEnabled
        startInLoadingState
        allowsInlineMediaPlayback
        bounces={false}
        originWhitelist={['*']}
        renderLoading={() => <ActivityIndicator size="large" color="#fff" style={s.loader} />}
        onHttpError={(e) => {
          const code = e?.nativeEvent?.statusCode;
          if (code && code >= 400) setErrored({ code, description: e?.nativeEvent?.description });
        }}
        onError={(e) => {
          setErrored({ code: 0, description: e?.nativeEvent?.description || 'load error' });
        }}
      />
    </View>
  );
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
      // Stream as blob to avoid opening media.chatyy in a new tab
      try {
        setSaving(true);
        const res = await fetch(url, { credentials: 'include' });
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = fileName || 'download';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } catch {
        // Fallback (still in same tab)
        window.location.href = url;
      } finally {
        setSaving(false);
      }
    } else {
      // Save to device gallery (like WhatsApp)
      try {
        setSaving(true);
        const ML = require('expo-media-library');
        const perm = await ML.requestPermissionsAsync(true); // true = write access
        if (perm.status !== 'granted' && perm.accessPrivileges !== 'all') {
          Alert.alert('Permissão necessária', 'Vá em Ajustes > Chatyy > Fotos e selecione "Todas as fotos".');
          setSaving(false);
          return;
        }
        // SDK 55 moved the download API; the legacy shim still exposes
        // downloadAsync + copyAsync + deleteAsync which is all we need here.
        let FS;
        try { FS = require('expo-file-system/legacy'); } catch { FS = require('expo-file-system'); }

        let sourceUri = url;

        // If the URL is already a local file:// (from mediaCache), skip the
        // download step entirely — FS.downloadAsync of a file:// URL fails
        // with "unsupported scheme" on iOS.
        if (!sourceUri.startsWith('file://')) {
          // Download remote URL to a temp file so MediaLibrary can ingest it.
          const ext = (fileName || sourceUri.split('/').pop() || 'file').split('?')[0].split('.').pop() || 'jpg';
          const tempPath = FS.cacheDirectory + 'chatyy_save_' + Date.now() + '.' + ext;
          const download = await FS.downloadAsync(sourceUri, tempPath);
          if (!download?.uri || (download.status && download.status >= 400)) {
            Alert.alert('Erro', `Download falhou (status ${download?.status || '?'}).`);
            setSaving(false);
            return;
          }
          sourceUri = download.uri;
        }

        // Save to gallery — try createAssetAsync first (creates a proper
        // PHAsset with full EXIF). Fallback to saveToLibraryAsync which
        // works even in restricted-access mode.
        let ok = false;
        try {
          const asset = await ML.createAssetAsync(sourceUri);
          if (asset) ok = true;
        } catch (saveErr) {
          try {
            await ML.saveToLibraryAsync(sourceUri);
            ok = true;
          } catch (saveErr2) {
            Alert.alert('Erro ao salvar', String(saveErr2?.message || saveErr?.message || 'Verifique as permissões de Fotos em Ajustes > Chatyy'));
          }
        }
        if (ok) {
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        }
        // Cleanup temp file if we created one
        if (sourceUri !== url && sourceUri.startsWith(FS.cacheDirectory)) {
          FS.deleteAsync(sourceUri, { idempotent: true }).catch(() => {});
        }
      } catch (e) {
        Alert.alert('Erro ao salvar', String(e?.message || 'Verifique a permissão de fotos nas configurações.'));
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
