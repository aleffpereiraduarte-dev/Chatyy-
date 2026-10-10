// [2026-10-10 stickers-import] Seleção de arquivos de figurinha (galeria ou
// Arquivos) e classificação do que veio de compartilhar/seletor:
//   .webp/.png/.jpg/.gif → figurinha avulsa; .wastickers/.zip → pacote.
// OTA-safe: expo-image-picker / expo-document-picker já estão no binário.
import { Platform } from 'react-native';

export function stickerKindOf(f) {
  const name = String(f?.name || f?.uri || '').toLowerCase().split('?')[0];
  const mime = String(f?.type || f?.mime || f?.mimeType || '').toLowerCase();
  if (/\.wastickers$/.test(name) || mime === 'application/x-wastickers') return 'pack';
  if (/\.zip$/.test(name) || mime === 'application/zip' || mime === 'application/x-zip-compressed') return 'pack';
  if (/\.(webp|png|jpe?g|gif)$/.test(name) || /^image\/(webp|png|jpe?g|gif)$/.test(mime)) return 'image';
  return null;
}

function _fromDocAsset(a) {
  const f = {
    uri: a.uri,
    name: a.name || String(a.uri || '').split('/').pop() || 'sticker.webp',
    type: a.mimeType || '',
    size: a.size || 0,
  };
  if (Platform.OS === 'web' && a.file) f.blob = a.file;
  return f;
}

/** source: 'gallery' | 'files' | 'pack'. Retorna [] se cancelar. */
export async function pickStickerFiles(source = 'files', { multiple = true } = {}) {
  try {
    if (source === 'gallery' && Platform.OS !== 'web') {
      const ImagePicker = require('expo-image-picker');
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm?.granted) return [];
      const r = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'], allowsMultipleSelection: multiple, selectionLimit: multiple ? 30 : 1, quality: 1,
      });
      if (r?.canceled) return [];
      return (r?.assets || []).map((a) => ({
        uri: a.uri, name: a.fileName || String(a.uri).split('/').pop() || 'sticker.png',
        type: a.mimeType || 'image/png', size: a.fileSize || 0,
      }));
    }
    const DocumentPicker = require('expo-document-picker');
    const type = source === 'pack'
      ? (Platform.OS === 'web' ? ['.wastickers', '.zip', 'application/zip'] : ['application/zip', 'application/octet-stream', '*/*'])
      : (Platform.OS === 'web' ? ['image/webp', 'image/png', 'image/jpeg', 'image/gif', '.webp'] : ['image/*']);
    const r = await DocumentPicker.getDocumentAsync({ type, multiple: source !== 'pack' && multiple, copyToCacheDirectory: true });
    if (r?.canceled) return [];
    return (r?.assets || []).map(_fromDocAsset);
  } catch {
    return [];
  }
}
