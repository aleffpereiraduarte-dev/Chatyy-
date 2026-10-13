// [2026-10-12 sticker-picker-fix] Escolher a foto/vídeo de origem de uma
// figurinha — robusto no iOS.
//
// Por que existe (bug "dá erro na hora de criar figurinha, não abre a galeria",
// iPhone iOS 26, build 673):
//   1. A folha "Criar figurinha" (components/ui/Sheet = <Modal> RN) chamava o
//      picker ~60 ms depois do toque, mas o Modal só sai da tela ~180 ms depois
//      (animação de saída) e aí é DESMONTADO. O expo-image-picker apresenta o
//      PHPicker a partir do view controller do topo (= o do Modal que está
//      saindo); quando o Modal é desmontado, o iOS leva o picker junto (ou
//      recusa a apresentação) e a promessa nunca resolve → "não abre a galeria".
//      Mesma coisa com o Alert.alert de 3 botões da loja (UIAlertController
//      ainda em dismiss). → esperamos o overlay terminar de sair antes.
//   2. A galeria era bloqueada por requestMediaLibraryPermissionsAsync: quem
//      negou "Fotos" (ou tocou "Não permitir") nunca via o picker e nada
//      acontecia. O PHPicker do iOS 14+ e o Photo Picker do Android NÃO
//      precisam de permissão (roda fora do processo) → não pedimos mais p/ a
//      galeria. Câmera continua pedindo; negada → alerta que leva aos Ajustes.
//   3. Erros viravam Alert com a mensagem crua em inglês do módulo nativo ou
//      eram engolidos por catch {} → agora alerta traduzido.
//
// Também normaliza a foto escolhida (EXIF aplicado, HEIC → JPEG, lado maior
// ≤ 2048 px; PNG/WebP com transparência continuam PNG) para o editor e o
// recorte não carregarem 48 MP na memória, e oferece toStickerFile() para
// quem sobe a imagem direto (loja): 512 px, PNG com alfa (o servidor converte
// p/ WebP). Só usa libs JS/nativas já no binário (expo-image-picker,
// expo-image-manipulator) — OTA-safe.
import { Alert, Linking, Platform } from 'react-native';

function tr(t, key, fb) {
  try { const v = t ? t(key) : ''; return v && v !== key ? v : fb; } catch { return fb; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Espera um Modal/Sheet/Alert que acabou de ser fechado sair de vez da tela
 * antes de apresentar um view controller nativo (picker, câmera).
 */
export async function waitForOverlayDismiss(ms = Platform.OS === 'ios' ? 420 : 160) {
  if (Platform.OS === 'web') return;
  // 2 frames p/ o commit do fechamento chegar ao nativo + a animação de saída
  // (Sheet ~180 ms; Modal 'slide'/Alert ~300 ms). InteractionManager está
  // depreciado no RN 0.83 — não usamos.
  await new Promise((resolve) => {
    try { requestAnimationFrame(() => requestAnimationFrame(resolve)); } catch { resolve(); }
    setTimeout(resolve, 100);
  });
  await sleep(ms);
}

/**
 * iOS: o picker resolve a promessa ANTES de terminar a animação de saída
 * (picker.dismiss(animated: true) roda depois). Apresentar o editor (<Modal>)
 * nesse meio-tempo pode falhar em silêncio → devolve uma promessa que só
 * resolve depois que o picker saiu; rode em paralelo com o processamento.
 */
export function pickerDismissSettled() {
  return Platform.OS === 'ios' ? sleep(450) : Promise.resolve();
}

function openSettingsAlert(t, kind) {
  return new Promise((resolve) => {
    Alert.alert(
      kind === 'camera'
        ? tr(t, 'stickerMaker.cameraPermTitle', 'Acesso à câmera')
        : tr(t, 'stickerMaker.photosPermTitle', 'Acesso às fotos'),
      kind === 'camera'
        ? tr(t, 'stickerMaker.cameraPermBody', 'Para tirar a foto da figurinha, permita o acesso à câmera nos Ajustes do aparelho.')
        : tr(t, 'stickerMaker.photosPermBody', 'Para escolher a foto da figurinha, permita o acesso às fotos nos Ajustes do aparelho.'),
      [
        { text: tr(t, 'common.cancel', 'Cancelar'), style: 'cancel', onPress: () => resolve(false) },
        { text: tr(t, 'common.openSettings', 'Abrir Ajustes'), onPress: () => { try { Linking.openSettings(); } catch {} resolve(false); } },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

function showPickError(t, isVideo) {
  try {
    Alert.alert(
      tr(t, 'stickerMaker.pickFailedTitle', 'Não foi possível abrir'),
      isVideo
        ? tr(t, 'stickerMaker.pickVideoFailed', 'Não conseguimos abrir seus vídeos agora. Tente de novo.')
        : tr(t, 'stickerMaker.pickFailed', 'Não conseguimos abrir sua galeria agora. Tente de novo.'),
    );
  } catch {}
}

function isPermissionError(e) {
  const s = String((e && (e.code || '')) + ' ' + (e && e.message ? e.message : e)).toLowerCase();
  return /permission|not authorized|denied|E_NO_PERMISSIONS/i.test(s);
}

function webPick(accept) {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = (e) => {
      const f = e.target.files && e.target.files[0];
      resolve(f || null);
    };
    // navegadores atuais disparam 'cancel' ao fechar o seletor sem escolher
    try { input.addEventListener('cancel', () => resolve(null)); } catch {}
    input.click();
  });
}

/**
 * Abre galeria/câmera e devolve o asset escolhido, ou null (cancelado / sem
 * permissão / erro — o usuário já foi avisado com um alerta traduzido).
 *
 * opts: { source: 'gallery'|'camera', media: 'image'|'video', t,
 *         afterOverlay: bool (esperar Modal/Alert sair), allowsEditing, aspect,
 *         quality, videoMaxDuration }
 * Retorno: { uri, width, height, mimeType, fileName, duration, file? (web) }
 */
export async function pickMedia(opts = {}) {
  const {
    source = 'gallery', media = 'image', t, afterOverlay = false,
    allowsEditing = false, aspect, quality = 0.9, videoMaxDuration,
  } = opts;
  const isVideo = media === 'video';

  if (Platform.OS === 'web') {
    const f = await webPick(isVideo ? 'video/mp4,video/webm,video/quicktime,image/gif' : 'image/png,image/jpeg,image/webp,image/gif');
    if (!f) return null;
    return { uri: URL.createObjectURL(f), mimeType: f.type, fileName: f.name, file: f, size: f.size };
  }

  if (afterOverlay) await waitForOverlayDismiss();

  let ImagePicker;
  try {
    // eslint-disable-next-line global-require
    ImagePicker = require('expo-image-picker');
  } catch {
    showPickError(t, isVideo);
    return null;
  }

  if (source === 'camera') {
    try {
      let perm = await ImagePicker.getCameraPermissionsAsync();
      if (!perm || !perm.granted) {
        if (!perm || perm.canAskAgain !== false) perm = await ImagePicker.requestCameraPermissionsAsync();
      }
      if (!perm || !perm.granted) { await openSettingsAlert(t, 'camera'); return null; }
    } catch {
      await openSettingsAlert(t, 'camera');
      return null;
    }
  }

  const options = {
    mediaTypes: isVideo ? ['videos'] : ['images'], // SDK 55: MediaTypeOptions está depreciado
    quality,
    allowsEditing: !!allowsEditing,
    exif: false,
  };
  if (allowsEditing && aspect) options.aspect = aspect;
  if (isVideo && videoMaxDuration) options.videoMaxDuration = videoMaxDuration;

  const launch = source === 'camera' ? ImagePicker.launchCameraAsync : ImagePicker.launchImageLibraryAsync;
  let res;
  try {
    res = await launch(options);
  } catch (e) {
    if (isPermissionError(e)) {
      await openSettingsAlert(t, source === 'camera' ? 'camera' : 'photos');
      return null;
    }
    // Uma segunda tentativa depois de assentar a UI cobre o caso "outro view
    // controller ainda estava saindo" (MissingCurrentViewController etc).
    try {
      await waitForOverlayDismiss(300);
      res = await launch(options);
    } catch (e2) {
      if (isPermissionError(e2)) { await openSettingsAlert(t, source === 'camera' ? 'camera' : 'photos'); return null; }
      showPickError(t, isVideo);
      return null;
    }
  }
  if (!res || res.canceled || !res.assets || !res.assets[0]) return null;
  const a = res.assets[0];
  return {
    uri: a.uri,
    width: a.width || 0,
    height: a.height || 0,
    mimeType: a.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg'),
    fileName: a.fileName || (isVideo ? `sticker_${Date.now()}.mp4` : `sticker_${Date.now()}.jpg`),
    duration: a.duration || null,
    size: a.fileSize || null,
  };
}

function hasAlpha(asset) {
  const m = String((asset && (asset.mimeType || asset.fileName || asset.uri)) || '').toLowerCase();
  return /png|webp|gif/.test(m);
}

/**
 * Normaliza a foto para o editor: aplica EXIF, HEIC → JPEG, lado maior ≤ max.
 * PNG/WebP (podem ter transparência) continuam PNG. Falha → uri original.
 */
export async function normalizeStickerSource(asset, max = 2048) {
  if (!asset || !asset.uri || Platform.OS === 'web') return asset ? asset.uri : null;
  try {
    // eslint-disable-next-line global-require
    const IM = require('expo-image-manipulator');
    if (!IM || typeof IM.manipulateAsync !== 'function') return asset.uri;
    const keepAlpha = hasAlpha(asset);
    const big = Math.max(asset.width || 0, asset.height || 0);
    const actions = [];
    if (big > max) actions.push({ resize: (asset.width >= asset.height) ? { width: max } : { height: max } });
    // HEIC/JPEG grandes: re-encodar também aplica a orientação EXIF.
    const r = await IM.manipulateAsync(asset.uri, actions, keepAlpha
      ? { format: IM.SaveFormat.PNG }
      : { compress: 0.9, format: IM.SaveFormat.JPEG });
    return (r && r.uri) || asset.uri;
  } catch {
    return asset.uri;
  }
}

/**
 * Arquivo pronto p/ upload como figurinha (loja / pacote): lado maior = 512,
 * PNG com transparência preservada. Falha → arquivo original.
 */
export async function toStickerFile(asset, size = 512) {
  if (!asset || !asset.uri) return null;
  const fallback = { uri: asset.uri, name: asset.fileName || `sticker_${Date.now()}.jpg`, type: asset.mimeType || 'image/jpeg' };
  if (Platform.OS === 'web') {
    return asset.file ? { uri: asset.uri, blob: asset.file, name: asset.fileName, type: asset.mimeType } : fallback;
  }
  try {
    // eslint-disable-next-line global-require
    const IM = require('expo-image-manipulator');
    if (!IM || typeof IM.manipulateAsync !== 'function') return fallback;
    const w = asset.width || 0;
    const h = asset.height || 0;
    const resize = w && h ? ((w >= h) ? { width: size } : { height: size }) : { width: size };
    const r = await IM.manipulateAsync(asset.uri, [{ resize }], { format: IM.SaveFormat.PNG });
    if (!r || !r.uri) return fallback;
    return { uri: r.uri, name: `sticker_${Date.now()}.png`, type: 'image/png' };
  } catch {
    return fallback;
  }
}
