import { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Modal, Image } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import { IconX, IconChevronLeft, IconChevronRight, IconDownload } from './Icons';

// SVG não é renderizado de forma confiável por <Image> remoto em iOS/Android,
// então não inclui aqui — caímos em "outro arquivo" que abre via download.
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
const PDF_EXTS = ['pdf'];

function getExt(filename) {
  return (filename || '').split('.').pop().toLowerCase();
}

export default function AttachmentPreviewModal({ visible, attachments, initialIndex, onClose, getUrl }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [index, setIndex] = useState(initialIndex || 0);

  // Reset/clamp index quando os attachments ou initialIndex mudarem (evita
  // ficar fora do range ao abrir modal com lista diferente).
  useEffect(() => {
    const max = Math.max((attachments?.length ?? 1) - 1, 0);
    setIndex(Math.min(Math.max(0, initialIndex ?? 0), max));
  }, [visible, initialIndex, attachments?.length]);

  if (!visible || !attachments?.length) return null;

  const current = attachments[index];
  const ext = getExt(current?.filename);
  const url = current ? getUrl?.(current, index) : undefined;
  const isImage = IMAGE_EXTS.includes(ext);
  const isPdf = PDF_EXTS.includes(ext);
  const total = attachments.length;

  const prev = () => setIndex(i => Math.max(0, i - 1));
  const next = () => setIndex(i => Math.min(total - 1, i + 1));

  const handleDownload = () => {
    if (Platform.OS === 'web' && url) {
      const link = document.createElement('a');
      link.href = url;
      link.download = current.filename || 'attachment';
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[s.backdrop, { backgroundColor: 'rgba(0,0,0,0.85)' }]}>
        {/* Header */}
        <View style={s.header}>
          <Text style={s.filename} numberOfLines={1}>{current?.filename || t('attachment.file')}</Text>
          <Text style={s.counter}>
            {index + 1} {t('attachment.of')} {total}
          </Text>
          <View style={s.headerActions}>
            <TouchableOpacity onPress={handleDownload} style={s.headerBtn}>
              <IconDownload size={20} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose} style={s.headerBtn}>
              <IconX size={22} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>

        {/* Content */}
        <View style={s.content}>
          {isImage && url ? (
            <Image
              source={{ uri: url }}
              style={s.image}
              resizeMode="contain"
            />
          ) : isPdf && Platform.OS === 'web' && url ? (
            <iframe
              src={url}
              style={{ width: '100%', height: '100%', border: 'none', borderRadius: 8 }}
              title={current?.filename}
            />
          ) : (
            <View style={s.noPreview}>
              <Text style={s.noPreviewText}>{t('attachment.cannotPreview')}</Text>
              <TouchableOpacity onPress={handleDownload} style={[s.downloadBtn, { backgroundColor: colors.primary }]}>
                <IconDownload size={16} color="#fff" />
                <Text style={s.downloadBtnText}>{t('attachment.download')}</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Navigation arrows */}
        {total > 1 && (
          <>
            {index > 0 && (
              <TouchableOpacity style={[s.navBtn, s.navLeft]} onPress={prev}>
                <IconChevronLeft size={32} color="#fff" />
              </TouchableOpacity>
            )}
            {index < total - 1 && (
              <TouchableOpacity style={[s.navBtn, s.navRight]} onPress={next}>
                <IconChevronRight size={32} color="#fff" />
              </TouchableOpacity>
            )}
          </>
        )}

        {/* Thumbnail strip */}
        {total > 1 && (
          <View style={s.thumbStrip}>
            {attachments.map((a, i) => {
              const aExt = getExt(a?.filename);
              const aUrl = getUrl?.(a, i);
              const aIsImage = IMAGE_EXTS.includes(aExt);
              return (
                <TouchableOpacity
                  key={i}
                  onPress={() => setIndex(i)}
                  style={[s.thumb, i === index && s.thumbActive]}
                >
                  {aIsImage && aUrl ? (
                    <Image source={{ uri: aUrl }} style={s.thumbImg} resizeMode="cover" />
                  ) : (
                    <View style={s.thumbPlaceholder}>
                      <Text style={s.thumbExt}>{aExt.toUpperCase()}</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 14, paddingTop: 50,
  },
  filename: { flex: 1, color: '#fff', fontSize: 16, fontWeight: '500' },
  counter: { color: 'rgba(255,255,255,0.6)', fontSize: 14, marginRight: 16 },
  headerActions: { flexDirection: 'row', gap: 12 },
  headerBtn: { padding: 8 },
  content: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  image: { width: '100%', height: '100%', maxWidth: 900 },
  noPreview: { alignItems: 'center' },
  noPreviewText: { color: 'rgba(255,255,255,0.6)', fontSize: 16, marginBottom: 20 },
  downloadBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 20, paddingVertical: 12, borderRadius: 8,
  },
  downloadBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  navBtn: {
    position: 'absolute', top: '50%', padding: 12, borderRadius: 30,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  navLeft: { left: 16 },
  navRight: { right: 16 },
  thumbStrip: {
    flexDirection: 'row', justifyContent: 'center', gap: 8,
    paddingVertical: 16, paddingHorizontal: 20,
  },
  thumb: {
    width: 56, height: 56, borderRadius: 8, overflow: 'hidden',
    borderWidth: 2, borderColor: 'transparent',
  },
  thumbActive: { borderColor: '#fff' },
  thumbImg: { width: '100%', height: '100%' },
  thumbPlaceholder: {
    width: '100%', height: '100%', backgroundColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center', alignItems: 'center',
  },
  thumbExt: { color: '#fff', fontSize: 10, fontWeight: '700' },
});
