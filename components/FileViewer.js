import { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, Image, ScrollView,
  ActivityIndicator, Platform, Animated, Share, Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { BorderRadius, FontSize, Spacing } from '../constants/theme';
import CachedImage from './CachedImage';
import { IconX, IconDownload, IconFileText, IconImage, IconFilm, IconMusic, IconPackage, IconChevronLeft, IconChevronRight, IconUpload } from './Icons';

let WebView = null;
try { WebView = require('react-native-webview').default; } catch {}

let FileSystemModule = null;
try { FileSystemModule = require('expo-file-system/legacy'); } catch { try { FileSystemModule = require('expo-file-system'); } catch {} }

let SharingModule = null;
try { SharingModule = require('expo-sharing'); } catch {}

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'];
const VIDEO_EXT = ['mp4', 'mov', 'webm', 'avi', 'mkv'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'ogg', 'aac', 'flac'];
const TEXT_EXT = ['txt', 'json', 'xml', 'csv', 'html', 'css', 'js', 'ts', 'md', 'log', 'yml', 'yaml', 'ini', 'conf', 'sh', 'py', 'php', 'rb', 'java', 'c', 'cpp', 'h', 'swift', 'kt'];
const PDF_EXT = ['pdf'];
// All Office formats render through the same docx/preview.html pipe (Google
// Docs Viewer fallback inside preview.html). Extending the set so .xlsx /
// .pptx / .xls / .ppt also get inline preview instead of the "no preview"
// download fallback.
const DOCX_EXT = ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp'];
const ARCHIVE_EXT = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'];

function getExt(name = '') {
  return (name.split('.').pop() || '').toLowerCase();
}

function getFileType(name) {
  const ext = getExt(name);
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (TEXT_EXT.includes(ext)) return 'text';
  if (PDF_EXT.includes(ext)) return 'pdf';
  if (DOCX_EXT.includes(ext)) return 'docx';
  if (ARCHIVE_EXT.includes(ext)) return 'archive';
  return 'other';
}

function getTypeIcon(type) {
  switch (type) {
    case 'image': return IconImage;
    case 'video': return IconFilm;
    case 'audio': return IconMusic;
    case 'archive': return IconPackage;
    default: return IconFileText;
  }
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// --- Image Preview (works natively) ---
function ImagePreview({ url }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  if (error) {
    return (
      <View style={s.previewCenter}>
        <IconImage size={48} color="#94a3b8" />
        <Text style={{ color: '#94a3b8', marginTop: 12, fontSize: 14 }}>Erro ao carregar imagem</Text>
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={s.previewCenter}
      maximumZoomScale={4}
      minimumZoomScale={1}
      showsVerticalScrollIndicator={false}
      bouncesZoom
    >
      {loading && <ActivityIndicator size="large" color="#fff" style={{ position: 'absolute' }} />}
      <Image
        source={{ uri: url }}
        style={s.previewImage}
        resizeMode="contain"
        onLoadEnd={() => setLoading(false)}
        onError={() => { setLoading(false); setError(true); }}
      />
    </ScrollView>
  );
}

// --- Build preview.html URL ---
function buildPreviewUrl(fileUrl, fileName, type) {
  return `/preview.html?url=${encodeURIComponent(fileUrl)}&type=${encodeURIComponent(type)}&name=${encodeURIComponent(fileName || 'file')}`;
}

// --- PDF Preview (via preview.html) ---
function PdfPreview({ url, colors, fileName }) {
  const previewUrl = buildPreviewUrl(url, fileName, 'pdf');
  if (Platform.OS === 'web') {
    const screenH = Dimensions.get('window').height;
    return <iframe src={previewUrl} style={{ width: '100%', height: screenH - 80, minHeight: 400, border: 'none', borderRadius: 8 }} title={fileName || 'PDF Preview'} />;
  }
  if (!WebView) {
    return <FallbackView label="PDF não disponível" colors={colors} url={url} />;
  }
  const BASE = 'https://chatyy.com.br';
  return (
    <View style={{ flex: 1 }}>
      <WebView
        source={{ uri: BASE + previewUrl }}
        style={{ flex: 1, backgroundColor: 'transparent' }}
        startInLoadingState
        renderLoading={() => <ActivityIndicator size="large" color="#fff" style={{ flex: 1 }} />}
        javaScriptEnabled
        domStorageEnabled
        scalesPageToFit
      />
    </View>
  );
}

// --- DOCX Preview (via preview.html) ---
function DocxPreview({ url, colors, fileName }) {
  const previewUrl = buildPreviewUrl(url, fileName, 'docx');
  if (Platform.OS === 'web') {
    const screenH = Dimensions.get('window').height;
    return <iframe src={previewUrl} style={{ width: '100%', height: screenH - 80, minHeight: 400, border: 'none', borderRadius: 8 }} title={fileName || 'DOCX Preview'} />;
  }
  if (!WebView) {
    return <FallbackView label="Visualização não disponível" colors={colors} url={url} />;
  }
  const BASE = 'https://chatyy.com.br';
  return (
    <View style={{ flex: 1 }}>
      <WebView
        source={{ uri: BASE + previewUrl }}
        style={{ flex: 1, backgroundColor: 'transparent' }}
        startInLoadingState
        renderLoading={() => <ActivityIndicator size="large" color="#fff" style={{ flex: 1 }} />}
        javaScriptEnabled
        domStorageEnabled
      />
    </View>
  );
}

// --- Video Preview (WebView on native, <video> on web) ---
function VideoPreview({ url, colors, fileName }) {
  if (Platform.OS === 'web') {
    return (
      <View style={s.mediaWrap}>
        <video src={url} controls style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: 12 }} />
      </View>
    );
  }
  if (!WebView) {
    return <FallbackView label="Reprodutor não disponível" colors={colors} url={url} />;
  }
  const html = `
    <!DOCTYPE html>
    <html><head>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body { margin:0; background:#000; display:flex; align-items:center; justify-content:center; min-height:100vh; }
      video { max-width:100%; max-height:100vh; border-radius:8px; }
    </style>
    </head><body>
    <video src="${url}" controls playsinline autoplay style="width:100%"></video>
    </body></html>
  `;
  return (
    <WebView
      source={{ html }}
      style={{ flex: 1, backgroundColor: '#000' }}
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      javaScriptEnabled
    />
  );
}

// --- Audio Preview (WebView on native, <audio> on web) ---
function AudioPreview({ url, colors, fileName }) {
  if (Platform.OS === 'web') {
    return (
      <View style={s.mediaWrap}>
        <View style={{ alignItems: 'center', gap: 16 }}>
          <IconMusic size={48} color="#94a3b8" />
          <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>{fileName}</Text>
          <audio src={url} controls style={{ width: '100%', maxWidth: 400 }} />
        </View>
      </View>
    );
  }
  if (!WebView) {
    return <FallbackView label="Reprodutor não disponível" colors={colors} url={url} />;
  }
  const html = `
    <!DOCTYPE html>
    <html><head>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body { margin:0; background:#111; display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100vh; font-family:system-ui; color:#fff; }
      .icon { font-size:48px; margin-bottom:16px; }
      .name { font-size:16px; font-weight:600; margin-bottom:24px; text-align:center; padding:0 20px; }
      audio { width:90%; max-width:400px; }
    </style>
    </head><body>
    <div class="icon">&#127925;</div>
    <div class="name">${(fileName || '').replace(/[<>"']/g, '')}</div>
    <audio src="${url}" controls autoplay></audio>
    </body></html>
  `;
  return (
    <WebView
      source={{ html }}
      style={{ flex: 1, backgroundColor: '#111' }}
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      javaScriptEnabled
    />
  );
}

// --- Text Preview ---
function TextPreview({ url, colors }) {
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(url).then(r => r.text()).then(t => { setContent(t); setLoading(false); }).catch(() => setLoading(false));
  }, [url]);

  if (loading) return <ActivityIndicator size="large" color={colors.primary} style={{ flex: 1 }} />;
  return (
    <ScrollView style={[s.textScroll, { backgroundColor: colors.surfaceVariant || '#1e293b' }]} contentContainerStyle={s.textContent}>
      <Text style={[s.textCode, { color: colors.text }]} selectable>{content || '(arquivo vazio)'}</Text>
    </ScrollView>
  );
}

// --- Fallback for unsupported types ---
function FallbackView({ label, colors, url }) {
  return (
    <View style={s.fallbackWrap}>
      <IconFileText size={48} color="#94a3b8" />
      <Text style={s.fallbackText}>{label || 'Formato não suportado para visualização'}</Text>
    </View>
  );
}

// --- File Info Card ---
function FileInfoCard({ file, colors, type }) {
  const TypeIcon = getTypeIcon(type);
  return (
    <View style={s.fallbackWrap}>
      <View style={[s.infoIconWrap, { backgroundColor: (colors.primaryLight || colors.primary) + '40' }]}>
        <TypeIcon size={48} color={colors.primary} />
      </View>
      <Text style={[s.infoName, { color: colors.text || '#fff' }]} numberOfLines={2}>{file.name || file.original_name}</Text>
      {file.size ? <Text style={[s.infoSize, { color: colors.textSecondary || '#94a3b8' }]}>{formatSize(file.size)}</Text> : null}
      <Text style={[s.infoType, { color: colors.textTertiary || '#64748b' }]}>Arquivo {getExt(file.name || file.original_name || '').toUpperCase()}</Text>
    </View>
  );
}

export default function FileViewer({ visible, file, files, initialIndex, onClose, getUrl }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [currentIndex, setCurrentIndex] = useState(initialIndex || 0);
  const [downloading, setDownloading] = useState(false);

  // Reset index when files change
  useEffect(() => {
    setCurrentIndex(initialIndex || 0);
  }, [initialIndex, visible]);

  const fileList = files || (file ? [file] : []);
  const current = fileList[currentIndex] || file;
  if (!visible || !current) return null;

  const url = getUrl ? getUrl(current) : current.url;
  const fileName = current.name || current.original_name || current.filename || '';
  const type = getFileType(fileName);
  const canNav = fileList.length > 1;

  const handleDownload = async () => {
    if (Platform.OS === 'web') {
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName || 'file';
      a.click();
      return;
    }

    // Native: download to cache and share
    if (!FileSystemModule || !SharingModule) return;

    setDownloading(true);
    try {
      const ext = getExt(fileName);
      const localUri = FileSystemModule.cacheDirectory + (fileName || `download.${ext}`);
      const result = await FileSystemModule.downloadAsync(url, localUri);
      if (result.status === 200) {
        const canShare = await SharingModule.isAvailableAsync();
        if (canShare) {
          await SharingModule.shareAsync(result.uri, {
            mimeType: current.mime_type || 'application/octet-stream',
            dialogTitle: fileName,
          });
        }
      }
    } catch (err) {
      console.warn('Download error:', err);
    } finally {
      setDownloading(false);
    }
  };

  const handleShare = async () => {
    try {
      await Share.share({ url, title: fileName, message: fileName });
    } catch {}
  };

  const goPrev = () => setCurrentIndex(i => Math.max(0, i - 1));
  const goNext = () => setCurrentIndex(i => Math.min(fileList.length - 1, i + 1));

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={[s.container, { backgroundColor: 'rgba(0,0,0,0.95)', paddingTop: insets.top }]}>
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity onPress={onClose} style={s.headerBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <IconX size={22} color="#fff" />
          </TouchableOpacity>
          <View style={s.headerInfo}>
            <Text style={s.headerTitle} numberOfLines={1}>{fileName || 'Arquivo'}</Text>
            {current.size ? <Text style={s.headerSize}>{formatSize(current.size)}</Text> : null}
          </View>
          {Platform.OS !== 'web' && (
            <TouchableOpacity onPress={handleShare} style={s.headerBtn}>
              <IconUpload size={20} color="#fff" />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={handleDownload}
            style={s.headerBtn}
            disabled={downloading}
            accessibilityLabel="Baixar"
            accessibilityRole="button"
          >
            {downloading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <IconDownload size={20} color="#fff" />
            )}
          </TouchableOpacity>
        </View>

        {/* Content */}
        <View style={s.body}>
          {type === 'image' && <ImagePreview url={url} />}
          {type === 'pdf' && <PdfPreview url={url} colors={colors} fileName={fileName} />}
          {type === 'docx' && <DocxPreview url={url} colors={colors} fileName={fileName} />}
          {type === 'video' && <VideoPreview url={url} colors={colors} fileName={fileName} />}
          {type === 'audio' && <AudioPreview url={url} colors={colors} fileName={fileName} />}
          {type === 'text' && <TextPreview url={url} colors={colors} />}
          {(type === 'archive' || type === 'other') && <FileInfoCard file={current} colors={colors} type={type} />}
        </View>

        {/* Navigation arrows */}
        {canNav && (
          <>
            {currentIndex > 0 && (
              <TouchableOpacity style={[s.navArrow, s.navLeft]} onPress={goPrev} activeOpacity={0.7}>
                <IconChevronLeft size={28} color="#fff" />
              </TouchableOpacity>
            )}
            {currentIndex < fileList.length - 1 && (
              <TouchableOpacity style={[s.navArrow, s.navRight]} onPress={goNext} activeOpacity={0.7}>
                <IconChevronRight size={28} color="#fff" />
              </TouchableOpacity>
            )}
            <View style={s.counter}>
              <Text style={s.counterText}>{currentIndex + 1} / {fileList.length}</Text>
            </View>
          </>
        )}

        {/* Thumbnail strip */}
        {canNav && (
          <ScrollView horizontal style={s.thumbStrip} contentContainerStyle={s.thumbStripContent} showsHorizontalScrollIndicator={false}>
            {fileList.map((f, i) => {
              const ft = getFileType(f.name || f.original_name || f.filename || '');
              const isImg = ft === 'image';
              const isActive = i === currentIndex;
              const thumbUrl = getUrl ? getUrl(f) : f.url;
              return (
                <TouchableOpacity key={i} onPress={() => setCurrentIndex(i)} style={[s.thumb, isActive && s.thumbActive]}>
                  {isImg ? (
                    <CachedImage source={{ uri: thumbUrl }} style={s.thumbImg} />
                  ) : (
                    <View style={[s.thumbIcon, { backgroundColor: 'rgba(255,255,255,0.1)' }]}>
                      {(() => { const IC = getTypeIcon(ft); return <IC size={16} color="#fff" />; })()}
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 12,
  },
  headerBtn: { padding: 8 },
  headerInfo: { flex: 1 },
  headerTitle: { color: '#fff', fontSize: 15, fontWeight: '600' },
  headerSize: { color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 1 },
  body: { flex: 1 },
  previewCenter: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  previewImage: { width: '100%', height: '100%', maxWidth: 900 },
  mediaWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  fallbackWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 12 },
  fallbackText: { color: 'rgba(255,255,255,0.6)', fontSize: 15, textAlign: 'center' },
  infoIconWrap: { width: 96, height: 96, borderRadius: 24, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  infoName: { fontSize: 18, fontWeight: '700', textAlign: 'center', maxWidth: 280 },
  infoSize: { fontSize: 14, marginTop: 4 },
  infoType: { fontSize: 12, marginTop: 2 },
  textScroll: { flex: 1, margin: 16, borderRadius: 12 },
  textContent: { padding: 16 },
  textCode: { fontFamily: Platform.OS === 'web' ? 'monospace' : 'Courier', fontSize: 13, lineHeight: 20 },
  navArrow: {
    position: 'absolute', top: '45%', width: 48, height: 48, borderRadius: 24,
    backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center',
  },
  navLeft: { left: 12 },
  navRight: { right: 12 },
  counter: {
    position: 'absolute', bottom: 100, alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 4,
  },
  counterText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  thumbStrip: { maxHeight: 72, paddingBottom: 16 },
  thumbStripContent: { paddingHorizontal: 16, gap: 8, alignItems: 'center' },
  thumb: {
    width: 52, height: 52, borderRadius: 8, overflow: 'hidden',
    borderWidth: 2, borderColor: 'transparent',
  },
  thumbActive: { borderColor: '#fff' },
  thumbImg: { width: '100%', height: '100%' },
  thumbIcon: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
});
