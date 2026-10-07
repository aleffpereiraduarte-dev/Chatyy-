// [2026-10-07 compose-attach-preview] Gmail-style "tap the attachment to check
// it before sending". Previews the LOCAL file the user just picked in the
// email composer (file:// / content:// on native, File/Blob on web, or a Drive
// reference URL): images, videos, PDFs and plain text inline; anything else
// gets a "Abrir com…" system sheet (iOS share sheet shows a Quick Look preview).
import { useEffect, useMemo, useState } from 'react';
import { View, Text, Modal, Image, TouchableOpacity, StyleSheet, Platform, ScrollView, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLanguage } from '../context/LanguageContext';
import { IconX, IconTrash, IconShare, IconFileText } from './Icons';
import { formatBytes } from '../services/format';
import NativeDocPreview from './NativeDocPreview';

function kindOf(file) {
  const type = String(file?.type || '').toLowerCase();
  const ext = String(file?.name || '').split('.').pop().toLowerCase();
  if (type.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp'].includes(ext)) return 'image';
  if (type.startsWith('video/') || ['mp4', 'mov', 'm4v', 'webm', '3gp'].includes(ext)) return 'video';
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (type.startsWith('text/') || ['txt', 'csv', 'md', 'json', 'log', 'xml', 'html', 'ics', 'vcf'].includes(ext)) return 'text';
  return 'other';
}

// Resolve a URI we can hand to viewers. Web: object URL from the File.
function useFileUri(file, visible) {
  const [uri, setUri] = useState('');
  useEffect(() => {
    if (!visible || !file) { setUri(''); return undefined; }
    if (Platform.OS === 'web' && file._raw && typeof URL !== 'undefined') {
      let u = '';
      try { u = URL.createObjectURL(file._raw); } catch {}
      setUri(u);
      return () => { try { if (u) URL.revokeObjectURL(u); } catch {} };
    }
    setUri(file.uri || file.drive_url || '');
    return undefined;
  }, [file, visible]);
  return uri;
}

function VideoBody({ uri }) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line react/no-unknown-property
    return <video src={uri} controls autoPlay style={{ width: '100%', height: '100%', backgroundColor: '#000' }} />;
  }
  let ev = null;
  try { ev = require('expo-video'); } catch {}
  if (!ev || !ev.useVideoPlayer || !ev.VideoView) return <Unsupported />;
  return <NativeVideo ev={ev} uri={uri} />;
}

function NativeVideo({ ev, uri }) {
  const player = ev.useVideoPlayer(uri, (p) => { try { p.loop = false; p.play(); } catch {} });
  return <ev.VideoView player={player} style={{ flex: 1 }} contentFit="contain" nativeControls allowsFullscreen />;
}

function TextBody({ file, uri }) {
  const [text, setText] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        let s = '';
        if (Platform.OS === 'web' && file?._raw?.text) s = await file._raw.text();
        else {
          let FS; try { FS = require('expo-file-system/legacy'); } catch { FS = require('expo-file-system'); }
          s = await FS.readAsStringAsync(uri);
        }
        if (alive) setText(s.length > 200000 ? s.slice(0, 200000) + '\n…' : s);
      } catch { if (alive) setText(''); }
    })();
    return () => { alive = false; };
  }, [file, uri]);
  if (text == null) return <View style={st.center}><ActivityIndicator color="#fff" /></View>;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#fff' }} contentContainerStyle={{ padding: 16 }}>
      <Text selectable style={{ color: '#111', fontSize: 14, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>{text}</Text>
    </ScrollView>
  );
}

function Unsupported({ label }) {
  return (
    <View style={st.center}>
      <IconFileText size={56} color="rgba(255,255,255,0.7)" />
      <Text style={st.note}>{label || 'Pré-visualização indisponível para este tipo de arquivo'}</Text>
    </View>
  );
}

export default function LocalAttachmentPreview({ visible, file, onClose, onRemove }) {
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const uri = useFileUri(file, visible);
  const kind = useMemo(() => kindOf(file), [file]);
  const isLocal = /^(file|content|blob):/i.test(uri);

  // Native old binaries can't render a local PDF on Android (Google viewer
  // needs a public URL) — NativeDocPreview's native PdfView handles file://
  // on new binaries; otherwise fall back to the system "open with" sheet.
  const openWithSystem = async () => {
    if (!uri) return;
    if (Platform.OS === 'web') { try { window.open(uri, '_blank'); } catch {} return; }
    try {
      const Sharing = require('expo-sharing');
      await Sharing.shareAsync(uri, { mimeType: file?.type || undefined, dialogTitle: file?.name, UTI: kind === 'pdf' ? 'com.adobe.pdf' : undefined });
    } catch {}
  };

  let body = null;
  if (!uri) body = <View style={st.center}><ActivityIndicator color="#fff" /></View>;
  else if (kind === 'image') body = <Image source={{ uri }} style={{ flex: 1 }} resizeMode="contain" />;
  else if (kind === 'video') body = <VideoBody uri={uri} />;
  else if (kind === 'pdf') {
    if (Platform.OS === 'web') {
      body = <iframe title={file?.name || 'pdf'} src={uri} style={{ flex: 1, width: '100%', height: '100%', border: 0, backgroundColor: '#fff' }} />;
    } else if (isLocal && !hasNativePdf()) {
      body = <Unsupported label={t('attachment.previewOpenWith') || 'Toque em "Abrir com" para ver o PDF'} />;
    } else {
      body = <NativeDocPreview url={uri} filename={file?.name} kind="pdf" openLabel={t('attachment.download') || 'Abrir'} errorLabel={t('attachment.cannotPreview') || 'Não foi possível abrir a pré-visualização'} />;
    }
  } else if (kind === 'text' && (isLocal || Platform.OS === 'web')) body = <TextBody file={file} uri={uri} />;
  else body = <Unsupported />;

  return (
    <Modal visible={!!visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose} statusBarTranslucent>
      <View style={[st.root, { paddingTop: insets.top }]}>
        <View style={st.header}>
          <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.close') || 'Fechar'} style={st.hBtn}>
            <IconX size={22} color="#fff" />
          </TouchableOpacity>
          <View style={{ flex: 1, marginHorizontal: 8 }}>
            <Text style={st.title} numberOfLines={1}>{file?.name || ''}</Text>
            {!!file?.size && <Text style={st.sub}>{formatBytes(file.size)}</Text>}
          </View>
          {kind !== 'image' && kind !== 'video' && Platform.OS !== 'web' && !!uri && (
            <TouchableOpacity onPress={openWithSystem} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('attachment.openWith') || 'Abrir com'} style={st.hBtn}>
              <IconShare size={20} color="#fff" />
            </TouchableOpacity>
          )}
          {!!onRemove && (
            <TouchableOpacity onPress={onRemove} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('attachment.remove') || 'Remover anexo'} style={st.hBtn}>
              <IconTrash size={20} color="#ff6b6b" />
            </TouchableOpacity>
          )}
        </View>
        <View style={{ flex: 1, paddingBottom: insets.bottom }}>{body}</View>
      </View>
    </Modal>
  );
}

function hasNativePdf() {
  try {
    const { nativeViewHas } = require('../modules/expo-native-toolkit/src/viewCaps');
    return !!nativeViewHas('ExpoNativePdfView', { props: ['uri'], events: ['onLoad', 'onError'] });
  } catch { return false; }
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 8 },
  hBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontSize: 16, fontWeight: '600' },
  sub: { color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  note: { color: 'rgba(255,255,255,0.75)', fontSize: 14, textAlign: 'center', marginTop: 14 },
});
