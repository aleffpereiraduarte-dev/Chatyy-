import { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, Image, ScrollView,
  ActivityIndicator, Platform, Dimensions,
} from 'react-native';
import { useSafeAreaInsets, initialWindowMetrics } from 'react-native-safe-area-context';
import { useLanguage } from '../context/LanguageContext';
import CachedImage from './CachedImage';
import { IconX, IconDownload, IconFileText, IconImage, IconFilm, IconMusic, IconPackage, IconChevronLeft, IconChevronRight, IconUpload, IconCloudOff } from './Icons';

import NativeDocPreview, { absoluteFileUrl, docPreviewSource } from './NativeDocPreview';
import ArchiveBrowser, { ARCHIVE_EXTS as _ARCHIVE_EXTS } from './ArchiveBrowser';
import { openOnDevice, sendCopy, saveToDevice, downloadToDevice } from '../services/driveFileActions';
import { openDocumentWithSystem } from '../utils/openDocument';
// [2026-10-18 photos-native-always] foto/vídeo do Drive → visualizador NATIVO (o Modal JS fica de reserva).
import { nativeMediaAlways, openNativeMediaList, setNativeActionState } from '../services/nativeMediaOpen';

import { a11yLabel } from '../utils/a11yLabel'; // [2026-10-20 a11y] rótulos dos botões só-ícone
// [2026-10-17 viewer-pb] Visualizador do Cloud: fundo PRETO opaco (antes
// rgba .95 num Modal transparente → a lista do Drive aparecia por trás),
// cartão P&B para arquivos sem prévia (ícone grande, nome, tamanho, tipo,
// Abrir com… / Compartilhar / Baixar), miniaturas sem tons pastel, arquivo
// indisponível (perdido no incidente de 02/08) com aviso claro, ZIP/TAR com
// conteúdo navegável (ArchiveBrowser) e ações que baixam com a permissão curta
// `dl` (antes Share.share entregava a URL com o bearer ao sistema).
const tt = (t, k, fb, vars) => { const v = t(k, vars); return (v && v !== k) ? v : fb; };


// expo-video (SDK 55+) — native video preview. Replaces the WebView that
// wrapped an HTML5 <video> per file (spun up a whole WKWebView). Lazy +
// cached so a build without the module degrades to the download fallback.
let _fvExpoVideo = null;
function loadFvExpoVideo() {
  if (_fvExpoVideo !== null) return _fvExpoVideo;
  try { _fvExpoVideo = require('expo-video'); } catch { _fvExpoVideo = false; }
  return _fvExpoVideo;
}

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
const ARCHIVE_EXT = _ARCHIVE_EXTS; // [abridores 2026-10-17] RAR/7z/ISO/CAB/… (lista única no ArchiveBrowser)

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
  const { t } = useLanguage();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  if (error) {
    return (
      <View style={s.previewCenter}>
        <IconImage size={48} color="#94a3b8" />
        <Text style={{ color: '#94a3b8', marginTop: 12, fontSize: 14 }}>{t('fileViewer.imageLoadError')}</Text>
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
function PdfPreview({ url, fileName, onOpenWith }) {
  const { t } = useLanguage();
  if (Platform.OS === 'web') {
    const screenH = Dimensions.get('window').height;
    // preview.html is not deployed (SPA fallback) → browsers render PDFs natively.
    return <iframe src={absoluteFileUrl(url)} style={{ width: '100%', height: screenH - 80, minHeight: 400, border: 'none', borderRadius: 8 }} title={fileName || 'PDF Preview'} />;
  }
  // [2026-10-07 app-feel-webview] native: was BASE+'/preview.html' which is
  // NOT deployed → the SPA (whole web app) rendered inside this viewer.
  return (
    <NativeDocPreview
      url={url}
      filename={fileName}
      kind="pdf"
      onOpenWith={onOpenWith}
      openLabel={tt(t, 'doc.openWith', 'Abrir com…')}
      errorLabel={tt(t, 'fileViewer.previewFailed', 'Não foi possível abrir a pré-visualização')}
      unavailableLabel={tt(t, 'fileViewer.unavailableHint', 'Este arquivo não está mais no servidor. Envie de novo a partir do aparelho onde ele está salvo.')}
      retryLabel={tt(t, 'common.retry', 'Tentar novamente')}
    />
  );
}

// --- DOCX Preview (via preview.html) ---
function DocxPreview({ url, colors, fileName }) {
  if (Platform.OS === 'web') {
    const screenH = Dimensions.get('window').height;
    const src = docPreviewSource(url, fileName, 'doc');
    if (!src) return null;
    return <iframe src={src.uri} style={{ width: '100%', height: screenH - 80, minHeight: 400, border: 'none', borderRadius: 8 }} title={fileName || 'DOCX Preview'} />;
  }
  // [2026-10-07 app-feel-webview] see PdfPreview.
  return <NativeDocPreview url={url} filename={fileName} kind="doc" />;
}

// --- Native video preview via expo-video (hooks-safe sub-component so
//     useVideoPlayer is always called at its top level). Native AVPlayer /
//     ExoPlayer controls (scrub, fullscreen, PiP) + autoplay with sound,
//     mirroring the old WebView <video controls autoplay>. ---
function NativeVideoPreview({ url, colors }) {
  const ev = loadFvExpoVideo();
  const useVideoPlayer = ev && ev.useVideoPlayer;
  const VideoView = ev && ev.VideoView;
  // Module presence is constant for the app's lifetime → stable early return
  // before the hook (Rules-of-Hooks safe). No WebView fallback — a build
  // without expo-video degrades to the download affordance.
  if (!useVideoPlayer || !VideoView) {
    return <FallbackView labelKey="fileViewer.playerUnavailable" colors={colors} url={url} />;
  }
  const player = useVideoPlayer(url, (p) => {
    try { p.loop = false; p.muted = false; const r = p.play?.(); if (r?.catch) r.catch(() => {}); } catch {}
  });
  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <VideoView
        player={player}
        style={{ flex: 1 }}
        contentFit="contain"
        nativeControls
        allowsFullscreen
        allowsPictureInPicture
      />
    </View>
  );
}

// --- Video Preview (expo-video on native, <video> on web) ---
function VideoPreview({ url, colors, fileName }) {
  if (Platform.OS === 'web') {
    return (
      <View style={s.mediaWrap}>
        <video src={url} controls style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: 12 }} />
      </View>
    );
  }
  return <NativeVideoPreview url={url} colors={colors} />;
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
  // [2026-10-07 app-feel-webview] native: was a WebView with HTML <audio>
  // (emoji icon, web controls, muted by the iOS silent switch). Now native
  // AVPlayer/ExoPlayer controls via expo-video (already in the binary).
  return <NativeAudioPreview url={url} colors={colors} fileName={fileName} />;
}

function NativeAudioPreview({ url, colors, fileName }) {
  const ev = loadFvExpoVideo();
  const useVideoPlayer = ev && ev.useVideoPlayer;
  const VideoView = ev && ev.VideoView;
  // Module presence is constant for the app's lifetime → stable early return.
  if (!useVideoPlayer || !VideoView) {
    return <FallbackView labelKey="fileViewer.playerUnavailable" colors={colors} url={url} />;
  }
  const player = useVideoPlayer(url, (p) => {
    try { p.loop = false; p.muted = false; const r = p.play?.(); if (r?.catch) r.catch(() => {}); } catch {}
  });
  return (
    <View style={[s.mediaWrap, { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 }]}>
      <View style={{ width: 96, height: 96, borderRadius: 48, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
        <IconMusic size={44} color="#cbd5e1" />
      </View>
      <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600', textAlign: 'center', marginBottom: 20 }} numberOfLines={2}>{fileName}</Text>
      <View style={{ width: '100%', maxWidth: 420, height: 110, borderRadius: 14, overflow: 'hidden', backgroundColor: '#000' }}>
        <VideoView player={player} style={{ flex: 1 }} contentFit="contain" nativeControls allowsFullscreen={false} allowsPictureInPicture={false} />
      </View>
    </View>
  );
}

// --- Text Preview ---
function TextPreview({ url, colors }) {
  const { t } = useLanguage();
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(url).then(r => r.text()).then(txt => { setContent(txt); setLoading(false); }).catch(() => setLoading(false));
  }, [url]);

  if (loading) return <ActivityIndicator size="large" color="#fff" style={{ flex: 1 }} />;
  return (
    <ScrollView style={[s.textScroll, { backgroundColor: 'rgba(255,255,255,0.06)' }]} contentContainerStyle={s.textContent}>
      <Text style={[s.textCode, { color: '#f2f2f2' }]} selectable>{content || t('fileViewer.emptyFile')}</Text>
    </ScrollView>
  );
}

// --- Fallback for unsupported types ---
function FallbackView({ label, labelKey, colors, url }) {
  const { t } = useLanguage();
  return (
    <View style={s.fallbackWrap}>
      <IconFileText size={48} color="#94a3b8" />
      <Text style={s.fallbackText}>{label || (labelKey ? t(labelKey) : t('fileViewer.unsupported'))}</Text>
    </View>
  );
}


// --- File card (arquivos sem prévia) — P&B ---
function FileCard({ file, type, compact, children }) {
  const { t } = useLanguage();
  const TypeIcon = getTypeIcon(type);
  const name = file.name || file.original_name || file.filename || '';
  const ext = getExt(name).toUpperCase();
  const meta = [file.size ? formatSize(file.size) : null, ext ? t('fileViewer.fileOfType', { ext }) : null].filter(Boolean).join(' · ');
  if (compact) {
    return (
      <View style={s.cardCompactWrap}>
        <View style={s.cardCompact}>
          <View style={s.iconTileSm}><TypeIcon size={26} color="#fff" /></View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.cardNameSm} numberOfLines={1}>{name}</Text>
            {meta ? <Text style={s.cardMeta} numberOfLines={1}>{meta}</Text> : null}
          </View>
        </View>
        {children}
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={s.cardWrap} showsVerticalScrollIndicator={false}>
      <View style={s.iconTile}>
        <TypeIcon size={52} color="#fff" />
        {ext ? <Text style={s.extBadge} numberOfLines={1}>{ext.slice(0, 5)}</Text> : null}
      </View>
      <Text style={s.cardName} numberOfLines={3}>{name}</Text>
      {meta ? <Text style={s.cardMeta}>{meta}</Text> : null}
      {children}
    </ScrollView>
  );
}

// Abrir com… (branco) + Compartilhar / Baixar (escuros). Web: só Baixar.
function FileActions({ op, onOpenWith, onShare, onDownload, compact }) {
  const { t } = useLanguage();
  const busy = !!op;
  const pct = op && op.pct > 0 && op.pct < 100 ? ` ${op.pct}%` : '';
  const native = Platform.OS !== 'web';
  return (
    <View style={[s.actions, compact && s.actionsCompact]}>
      {native && onOpenWith ? (
        <TouchableOpacity style={[s.btnPrimary, busy && { opacity: 0.7 }]} onPress={onOpenWith} disabled={busy} accessibilityRole="button">
          {op?.kind === 'open' ? <ActivityIndicator size="small" color="#000" /> : null}
          <Text style={s.btnPrimaryText}>{tt(t, 'doc.openWith', 'Abrir com…')}{op?.kind === 'open' ? pct : ''}</Text>
        </TouchableOpacity>
      ) : null}
      <View style={s.actionsRow}>
        {native && onShare ? (
          <TouchableOpacity style={[s.btnSecondary, busy && { opacity: 0.7 }]} onPress={onShare} disabled={busy} accessibilityRole="button">
            {op?.kind === 'share' ? <ActivityIndicator size="small" color="#fff" /> : <IconUpload size={18} color="#fff" />}
            <Text style={s.btnSecondaryText}>{tt(t, 'common.share', 'Compartilhar')}{op?.kind === 'share' ? pct : ''}</Text>
          </TouchableOpacity>
        ) : null}
        {onDownload ? (
          <TouchableOpacity style={[s.btnSecondary, busy && { opacity: 0.7 }]} onPress={onDownload} disabled={busy} accessibilityRole="button">
            {op?.kind === 'download' ? <ActivityIndicator size="small" color="#fff" /> : <IconDownload size={18} color="#fff" />}
            <Text style={s.btnSecondaryText}>{tt(t, 'files.download', 'Baixar')}{op?.kind === 'download' ? pct : ''}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

// Arquivo que não está mais no armazenamento (missing_at no servidor / 404).
function UnavailableCard({ file }) {
  const { t } = useLanguage();
  const name = file.name || file.original_name || file.filename || '';
  return (
    <View style={s.cardWrap}>
      <View style={s.iconTile}><IconCloudOff size={48} color="rgba(255,255,255,0.7)" /></View>
      <Text style={s.cardName} numberOfLines={3}>{name}</Text>
      <Text style={s.unavailTitle}>{tt(t, 'photos.fileUnavailable', 'Arquivo indisponível')}</Text>
      <Text style={s.unavailHint}>{tt(t, 'fileViewer.unavailableHint', 'Este arquivo não está mais no servidor. Envie de novo a partir do aparelho onde ele está salvo.')}</Text>
    </View>
  );
}

// Miniatura da tira: imagem real (thumb do servidor) ou ícone do tipo em cinza.
function ThumbTile({ f, url, active, onPress }) {
  const [failed, setFailed] = useState(false);
  const ft = getFileType(f.name || f.original_name || f.filename || '');
  const showImg = ft === 'image' && !f.unavailable && !failed && !!url;
  const IC = f.unavailable ? IconCloudOff : getTypeIcon(ft);
  return (
    <TouchableOpacity onPress={onPress} style={[s.thumb, active && s.thumbActive]} activeOpacity={0.7}>
      {showImg ? (
        <CachedImage source={{ uri: url }} style={s.thumbImg} onError={() => setFailed(true)} />
      ) : (
        <View style={s.thumbIcon}><IC size={18} color="rgba(255,255,255,0.55)" /></View>
      )}
    </TouchableOpacity>
  );
}

// Item dentro de um ZIP sem prévia: cartão + "Abrir com…".
function EntryOpenCard({ url, name, size }) {
  const { t } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const open = async () => {
    if (busy) return;
    if (Platform.OS === 'web') { try { window.open(url, '_blank', 'noopener'); } catch {} return; }
    setBusy(true); setFailed(false);
    try { const r = await openDocumentWithSystem({ url, filename: name }); if (!r) setFailed(true); }
    finally { setBusy(false); }
  };
  return (
    <FileCard file={{ name, size }} type={getFileType(name)}>
      {failed ? <Text style={s.unavailHint}>{tt(t, 'doc.openFailed', 'Não foi possível abrir o documento')}</Text> : null}
      <View style={s.actions}>
        <TouchableOpacity style={[s.btnPrimary, busy && { opacity: 0.7 }]} onPress={open} disabled={busy} accessibilityRole="button">
          {busy ? <ActivityIndicator size="small" color="#000" /> : null}
          <Text style={s.btnPrimaryText}>{Platform.OS === 'web' ? tt(t, 'files.download', 'Baixar') : tt(t, 'doc.openWith', 'Abrir com…')}</Text>
        </TouchableOpacity>
      </View>
    </FileCard>
  );
}

export function renderArchiveEntry({ url, name, size }) { // [abridores] também usado no visualizador do chat
  const ft = getFileType(name);
  switch (ft) {
    case 'image': return <ImagePreview key={url} url={url} />;
    case 'pdf': return <PdfPreview key={url} url={url} fileName={name} />;
    case 'video': return <VideoPreview key={url} url={url} fileName={name} />;
    case 'audio': return <AudioPreview key={url} url={url} fileName={name} />;
    case 'text': return <TextPreview key={url} url={url} />;
    case 'docx': if (Platform.OS !== 'web') return <DocxPreview key={url} url={url} fileName={name} />; // fallthrough
    default: return <EntryOpenCard key={url} url={url} name={name} size={size} />;
  }
}

// [2026-10-18 photos-native-always] formatos que o pager nativo abre (AVPlayer/ExoPlayer, UIImage/Glide).
const NATIVE_IMG_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp'];
const NATIVE_VID_EXT = Platform.OS === 'android' ? ['mp4', 'mov', 'm4v', 'webm', 'mkv', '3gp'] : ['mp4', 'mov', 'm4v'];
function nativeMediaKind(f) {
  if (!f || f.is_folder || f.unavailable) return null;
  const ext = getExt(f.name || f.original_name || f.filename || '');
  if (NATIVE_IMG_EXT.includes(ext)) return 'image';
  if (NATIVE_VID_EXT.includes(ext)) return 'video';
  return null;
}

export default function FileViewer({ visible, file, files, initialIndex, onClose, getUrl, onArchiveExtracted }) {
  const { t } = useLanguage();
  // [2026-10-17 viewer-top] Dentro do Modal o provider às vezes devolve 0 → header
  // ia pra baixo da Dynamic Island. Nunca menos que as margens da janela.
  const _rawInsets = useSafeAreaInsets();
  const _wm = (initialWindowMetrics && initialWindowMetrics.insets) || {};
  const insets = {
    top: Math.max(_rawInsets.top || 0, _wm.top || 0),
    bottom: Math.max(_rawInsets.bottom || 0, _wm.bottom || 0),
    left: _rawInsets.left || 0,
    right: _rawInsets.right || 0,
  };
  const [currentIndex, setCurrentIndex] = useState(initialIndex || 0);
  const [op, setOp] = useState(null); // { kind: 'open'|'share'|'download', pct }
  const [note, setNote] = useState(null);
  const opRef = useRef(false);

  // Reset index when files change
  useEffect(() => {
    setCurrentIndex(initialIndex || 0);
  }, [initialIndex, visible]);

  const fileList = files || (file ? [file] : []);
  const current = fileList[currentIndex] || file;
  useEffect(() => { setNote(null); }, [current?.id, currentIndex]);

  // [2026-10-18 photos-native-always] foto/vídeo → pager nativo com a lista inteira
  // (só mídia). Enquanto ele está aberto este componente não desenha nada; falhou
  // (binário sem o módulo, kill switch) → Modal JS de sempre.
  const [nativeFailed, setNativeFailed] = useState(false);
  const nativeOpenRef = useRef(null);
  const nvPropsRef = useRef({});
  nvPropsRef.current = { fileList, getUrl, onClose, t };
  // índice pelo id do arquivo tocado (initialIndex às vezes vem de outra lista)
  const _byId = file && file.id != null ? fileList.findIndex((f) => f && f.id === file.id) : -1;
  const startIdx = _byId >= 0 ? _byId : (initialIndex || 0);
  const startFile = file || fileList[startIdx];
  const wantNative = !!(visible && startFile && !nativeFailed && Platform.OS !== 'web'
    && nativeMediaKind(startFile) && nativeMediaAlways());
  useEffect(() => {
    if (!visible) { nativeOpenRef.current = null; setNativeFailed(false); return; }
    if (!wantNative) return;
    const key = String(startFile?.id ?? startIdx);
    if (nativeOpenRef.current === key) return;
    nativeOpenRef.current = key;
    const { fileList: fl, getUrl: gu } = nvPropsRef.current;
    const inList = fl[startIdx] && startFile && fl[startIdx].id === startFile.id;
    const list = inList ? fl : [startFile];
    const urlOf = (f) => (gu ? gu(f) : f.url) || '';
    const runAction = async (ev, f) => {
      if (!f || !f.id) return;
      const action = ev.action;
      if (action !== 'share' && action !== 'save') return;
      setNativeActionState(action, 'busy');
      let ok = false;
      try {
        if (action === 'share') {
          ok = (await sendCopy(f, () => {})) !== false;
        } else {
          // foto/vídeo → galeria (Fotos/Galeria), como o viewer do chat
          const local = await downloadToDevice(f, () => {});
          const ML = require('expo-media-library');
          const perm = await ML.requestPermissionsAsync(true);
          if (perm && perm.status === 'granted') { await ML.saveToLibraryAsync(local); ok = true; }
        }
      } catch { ok = false; }
      setNativeActionState(action, ok && action === 'save' ? 'done' : 'idle');
    };
    openNativeMediaList({
      list,
      index: inList ? startIdx : 0,
      t: nvPropsRef.current.t,
      toItem: (f) => {
        const kind = nativeMediaKind(f);
        if (!kind) return null;
        const uri = urlOf(f);
        if (!uri) return null;
        let thumb = f.thumbnail_url ? absoluteFileUrl(f.thumbnail_url) : '';
        if (kind === 'video' && thumb === uri) thumb = '';
        const ts = Date.parse(f.taken_at || f.created_at || f.uploaded_at || '') || null;
        return {
          uri, thumbUri: thumb || null, type: kind, messageId: String(f.id ?? ''),
          caption: '', createdAt: ts, width: f.width || 0, height: f.height || 0,
        };
      },
      allowShare: true,
      allowSave: true,
      onAction: (ev, _i, f) => { runAction(ev, f); },
      onClose: () => {
        nativeOpenRef.current = null;
        const c = nvPropsRef.current.onClose;
        try { c && c(); } catch {}
      },
    }).then((sid) => {
      if (!sid) { nativeOpenRef.current = null; setNativeFailed(true); }
    }).catch(() => { nativeOpenRef.current = null; setNativeFailed(true); });
  }, [visible, wantNative, startFile?.id, startIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!visible || !current) return null;
  if (wantNative) return null;

  const url = getUrl ? getUrl(current) : current.url;
  const fileName = current.name || current.original_name || current.filename || '';
  const type = getFileType(fileName);
  const canNav = fileList.length > 1;
  const unavailable = !!current.unavailable;
  const native = Platform.OS !== 'web';

  const webDownload = () => {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'file';
    a.click();
  };

  // Baixa com permissão curta (drive_dl_token) e entrega ao sistema.
  const runOp = async (kind) => {
    if (opRef.current || unavailable) return;
    if (!native) { if (kind === 'download') webDownload(); return; }
    if (!current.id) return;
    opRef.current = true;
    setNote(null);
    setOp({ kind, pct: 0 });
    try {
      const fn = kind === 'open' ? openOnDevice : kind === 'share' ? sendCopy : saveToDevice;
      const r = await fn(current, (pct) => setOp({ kind, pct }));
      if (kind === 'download' && r === 'saved' && Platform.OS === 'android') setNote(tt(t, 'drive.savedToDownloads', 'Salvo em Downloads/Chatyy'));
    } catch (e) {
      const m = String(e?.message || '');
      setNote(/http_(404|410)/.test(m)
        ? tt(t, 'fileViewer.unavailableHint', 'Este arquivo não está mais no servidor. Envie de novo a partir do aparelho onde ele está salvo.')
        : tt(t, 'drive.downloadFailed', 'Não foi possível baixar o arquivo. Tente novamente.'));
    } finally {
      opRef.current = false;
      setOp(null);
    }
  };
  const onOpenWith = current.id ? () => runOp('open') : undefined;
  const actions = (compact) => (
    <FileActions
      op={op}
      compact={compact}
      onOpenWith={onOpenWith}
      onShare={current.id ? () => runOp('share') : undefined}
      onDownload={() => runOp('download')}
    />
  );

  const goPrev = () => setCurrentIndex(i => Math.max(0, i - 1));
  const goNext = () => setCurrentIndex(i => Math.min(fileList.length - 1, i + 1));
  const showArrows = canNav && type !== 'archive';

  return (
    <Modal visible={visible} animationType="fade" transparent={false} onRequestClose={onClose} statusBarTranslucent>
      <View style={[s.container, { paddingTop: insets.top, paddingBottom: canNav ? 0 : insets.bottom }]}>
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity accessibilityLabel={a11yLabel('common.close', 'Fechar')} onPress={onClose} style={s.headerBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button">
            <IconX size={22} color="#fff" />
          </TouchableOpacity>
          <View style={s.headerInfo}>
            <Text style={s.headerTitle} numberOfLines={1}>{fileName || t('viewer.fileLabel')}</Text>
            {current.size ? <Text style={s.headerSize}>{formatSize(current.size)}</Text> : null}
          </View>
          {native && !unavailable && current.id ? (
            <TouchableOpacity onPress={() => runOp('share')} style={s.headerBtn} disabled={!!op} accessibilityRole="button" accessibilityLabel={tt(t, 'common.share', 'Compartilhar')}>
              {op?.kind === 'share' ? <ActivityIndicator size="small" color="#fff" /> : <IconUpload size={20} color="#fff" />}
            </TouchableOpacity>
          ) : null}
          {!unavailable ? (
            <TouchableOpacity
              onPress={() => runOp('download')}
              style={s.headerBtn}
              disabled={!!op}
              accessibilityLabel={t('files.download')}
              accessibilityRole="button"
            >
              {op?.kind === 'download' ? <ActivityIndicator size="small" color="#fff" /> : <IconDownload size={20} color="#fff" />}
            </TouchableOpacity>
          ) : null}
        </View>

        {/* Content */}
        <View style={s.body}>
          {unavailable ? <UnavailableCard file={current} /> : (
            <>
              {type === 'image' && <ImagePreview url={url} />}
              {type === 'pdf' && <PdfPreview url={url} fileName={fileName} onOpenWith={onOpenWith} />}
              {/* [2026-10-09 native-docs] web: no docs.google.com viewer (Drive URL carries the token) → info card + header download */}
              {type === 'docx' && (Platform.OS === 'web'
                ? <FileCard file={current} type={type}>{actions(false)}</FileCard>
                : <DocxPreview url={url} fileName={fileName} />)}
              {type === 'video' && <VideoPreview url={url} fileName={fileName} />}
              {type === 'audio' && <AudioPreview url={url} fileName={fileName} />}
              {type === 'text' && <TextPreview url={url} />}
              {type === 'archive' && (
                <ArchiveBrowser
                  key={String(current.id || fileName)}
                  file={current}
                  renderEntry={renderArchiveEntry}
                  onExtracted={onArchiveExtracted}
                  header={<FileCard file={current} type={type} compact>{actions(true)}</FileCard>}
                />
              )}
              {type === 'other' && <FileCard file={current} type={type}>{actions(false)}</FileCard>}
            </>
          )}
          {note ? <View pointerEvents="none" style={s.noteWrap}><Text style={s.noteText}>{note}</Text></View> : null}
        </View>

        {/* Navigation arrows */}
        {showArrows && (
          <>
            {currentIndex > 0 && (
              <TouchableOpacity style={[s.navArrow, s.navLeft]} onPress={goPrev} activeOpacity={0.7}>
                <IconChevronLeft size={26} color="#fff" />
              </TouchableOpacity>
            )}
            {currentIndex < fileList.length - 1 && (
              <TouchableOpacity style={[s.navArrow, s.navRight]} onPress={goNext} activeOpacity={0.7}>
                <IconChevronRight size={26} color="#fff" />
              </TouchableOpacity>
            )}
          </>
        )}

        {/* Thumbnail strip */}
        {canNav && (
          <View style={{ paddingBottom: Math.max(insets.bottom, 8) }}>
            <Text style={s.counterText}>{currentIndex + 1} / {fileList.length}</Text>
            <ScrollView horizontal style={s.thumbStrip} contentContainerStyle={s.thumbStripContent} showsHorizontalScrollIndicator={false}>
              {fileList.map((f, i) => {
                const ft = getFileType(f.name || f.original_name || f.filename || '');
                const thumbUrl = ft === 'image'
                  ? (f.thumbnail_url ? absoluteFileUrl(f.thumbnail_url) : (getUrl ? getUrl(f) : f.url))
                  : null;
                return (
                  <ThumbTile key={String(f.id ?? i)} f={f} url={thumbUrl} active={i === currentIndex} onPress={() => setCurrentIndex(i)} />
                );
              })}
            </ScrollView>
          </View>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 12,
  },
  headerBtn: { padding: 8, minWidth: 36, alignItems: 'center' },
  headerInfo: { flex: 1 },
  headerTitle: { color: '#fff', fontSize: 15, fontWeight: '600' },
  headerSize: { color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 1 },
  body: { flex: 1, backgroundColor: '#000' },
  previewCenter: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  previewImage: { width: '100%', height: '100%', maxWidth: 900 },
  mediaWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  fallbackWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 12 },
  fallbackText: { color: 'rgba(255,255,255,0.6)', fontSize: 15, textAlign: 'center' },
  cardWrap: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 28, paddingVertical: 32 },
  iconTile: {
    width: 112, height: 112, borderRadius: 28, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.16)', marginBottom: 20,
  },
  extBadge: { position: 'absolute', bottom: 12, color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  cardName: { color: '#fff', fontSize: 19, fontWeight: '700', textAlign: 'center', maxWidth: 320 },
  cardMeta: { color: 'rgba(255,255,255,0.5)', fontSize: 13, marginTop: 6, textAlign: 'center' },
  cardCompactWrap: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
  cardCompact: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  iconTileSm: {
    width: 56, height: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.16)',
  },
  cardNameSm: { color: '#fff', fontSize: 16, fontWeight: '600' },
  actions: { alignSelf: 'stretch', width: '100%', maxWidth: 420, marginTop: 28, gap: 10, alignItems: 'stretch' },
  actionsCompact: { marginTop: 16, maxWidth: undefined },
  actionsRow: { flexDirection: 'row', gap: 10 },
  btnPrimary: { height: 48, borderRadius: 14, backgroundColor: '#fff', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  btnPrimaryText: { color: '#000', fontSize: 16, fontWeight: '600' },
  btnSecondary: { flex: 1, height: 46, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.1)', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  btnSecondaryText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  unavailTitle: { color: '#fff', fontSize: 15, fontWeight: '600', marginTop: 18 },
  unavailHint: { color: 'rgba(255,255,255,0.55)', fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 8, maxWidth: 320 },
  noteWrap: { position: 'absolute', left: 16, right: 16, bottom: 16, alignItems: 'center' },
  noteText: { color: '#fff', fontSize: 13, textAlign: 'center', backgroundColor: 'rgba(40,40,40,0.95)', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 12, overflow: 'hidden' },
  textScroll: { flex: 1, margin: 16, borderRadius: 12 },
  textContent: { padding: 16 },
  textCode: { fontFamily: Platform.OS === 'web' ? 'monospace' : 'Courier', fontSize: 13, lineHeight: 20 },
  navArrow: {
    position: 'absolute', top: '45%', width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center',
  },
  navLeft: { left: 12 },
  navRight: { right: 12 },
  counterText: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '600', textAlign: 'center', marginTop: 6, marginBottom: 8, fontVariant: ['tabular-nums'] },
  thumbStrip: { maxHeight: 60, flexGrow: 0 },
  thumbStripContent: { paddingHorizontal: 16, gap: 8, alignItems: 'center' },
  thumb: {
    width: 48, height: 48, borderRadius: 8, overflow: 'hidden',
    borderWidth: 2, borderColor: 'transparent', backgroundColor: '#1c1c1e',
  },
  thumbActive: { borderColor: '#fff' },
  thumbImg: { width: '100%', height: '100%', backgroundColor: '#1c1c1e' },
  thumbIcon: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', backgroundColor: '#1c1c1e' },
});
