// components/groupCreate/pickGroupPhoto.js — [2026-10-15 native-group-create]
//
// Foto do grupo: câmera NATIVA do chat (expo-chat-attach) ou galeria do
// sistema (PHPicker / Photo Picker via expo-image-picker) → editor NATIVO
// (expo-media-editor) com RECORTE CIRCULAR (cropShape 'circle', apiVersion ≥ 2).
// Sem editor circular no binário → recorte 1:1 do próprio seletor (como antes).
// Resolve { uri, name, type } (JPEG) ou null (cancelado / sem permissão).
import { Platform } from 'react-native';

function circleEditorAvailable() {
  try {
    if (globalThis.__chatyy_native_editor === false) return false;
    const ME = require('../../modules/expo-media-editor');
    return !!ME.isAvailable() && ME.apiVersion() >= 2;
  } catch { return false; }
}

async function cropCircle(uri, t) {
  try {
    const ME = require('../../modules/expo-media-editor');
    let labels = {};
    try { labels = require('../media/nativeMediaEditor').buildLabels(t); } catch {}
    const r = await ME.open({
      uri, type: 'image', mode: 'edit', cropShape: 'circle', maxDim: 1024, quality: 0.9, labels,
      tools: { crop: true, draw: false, text: false, stickers: false, filters: true, trim: false, mute: false, cover: false },
    });
    if (r?.action === 'cancel') return { cancelled: true };
    if (r?.action === 'done' && r.uri) return { uri: r.uri };
    return { uri }; // erro do editor → foto sem recorte (o app mostra redonda)
  } catch { return { uri }; }
}

/** source: 'camera' | 'library' */
export async function pickGroupPhoto(source, t) {
  if (Platform.OS === 'web') return null;
  const circle = circleEditorAvailable();
  let uri = null;
  if (source === 'camera') {
    // Câmera nativa do chat (quente, mesma do anexo). Indisponível → câmera do sistema.
    try {
      const { openNativeCamera } = require('../chat/NativeAttachSheet');
      const r = await openNativeCamera(t, { withAudio: false, maxVideoSec: 1 });
      if (r) {
        if (r.action === 'cancel') return null;
        if (r.action === 'gallery') return pickGroupPhoto('library', t);
        const f = (r.files || []).find(x => String(x?.type || '').startsWith('image') || /\.(jpe?g|png|heic|heif|webp)$/i.test(String(x?.uri || '')));
        if (!f) return null;
        uri = f.uri;
      }
    } catch {}
  }
  if (!uri) {
    const ImagePicker = require('expo-image-picker');
    if (source === 'camera') {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm?.granted) return { denied: true };
    } else {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm?.granted) return { denied: true };
    }
    const opts = { mediaTypes: ['images'], allowsEditing: !circle, aspect: [1, 1], quality: 0.9 };
    const r = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (!r || r.canceled || !r.assets?.[0]?.uri) return null;
    uri = r.assets[0].uri;
  }
  if (circle) {
    const c = await cropCircle(uri, t);
    if (c.cancelled) return null;
    uri = c.uri;
  }
  // JPEG sempre (mesma guarda HEIC do avatar de perfil).
  return { uri, name: 'group.jpg', type: 'image/jpeg' };
}
