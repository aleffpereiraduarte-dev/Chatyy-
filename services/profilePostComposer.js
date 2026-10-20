// [perfil-publicar 2026-10-19] "Publicar no perfil" nível Instagram — peças comuns.
//
// Por que existe: "Publicar no perfil" (Você / folha do avatar / perfil) e o "+" de
// Fotos abriam o PHPicker e, assim que ele devolvia, faziam router.push('/photo-new')
// (modal fullScreen). No iOS o PHPicker ainda está na animação de saída quando o push
// acontece → o UIKit recusa apresentar o modal, a tela monta e some em ~2 s
// (analytics: /photo-new → /settings em 2 s, nenhum feed_create_post) = "não faz
// nada". Agora o compositor abre PRIMEIRO e ele mesmo chama o seletor quando a
// transição terminou (photo-new?pick=library|camera). Sem modal sobre modal.
//
// Também aqui: menu de ações nativo (ActionSheetIOS no iOS, Alert no Android, sem
// <Modal>), seletor de mídia (até 10, fotos+vídeos, ordem da seleção), editar
// legenda / excluir publicação, e i18n local (pt/en/es) p/ textos novos.
import { Platform, ActionSheetIOS, Alert, DeviceEventEmitter } from 'react-native';

export const POST_MAX_ITEMS = 10;
export const POSTS_CHANGED_EVENT = 'chatyy:profilePostsChanged';

const L = {
  newPost: { pt: 'Nova publicação', en: 'New post', es: 'Nueva publicación' },
  publish: { pt: 'Publicar', en: 'Share', es: 'Publicar' },
  aspect: { pt: 'Formato', en: 'Format', es: 'Formato' },
  square: { pt: 'Quadrado', en: 'Square', es: 'Cuadrado' },
  portrait: { pt: 'Retrato', en: 'Portrait', es: 'Vertical' },
  original: { pt: 'Original', en: 'Original', es: 'Original' },
  audience: { pt: 'Quem pode ver', en: 'Who can see', es: 'Quién puede ver' },
  everyone: { pt: 'Todos', en: 'Everyone', es: 'Todos' },
  contacts: { pt: 'Meus contatos', en: 'My contacts', es: 'Mis contactos' },
  everyoneHint: { pt: 'Qualquer pessoa que abrir o seu perfil', en: 'Anyone who opens your profile', es: 'Cualquiera que abra tu perfil' },
  contactsHint: { pt: 'Só quem está na sua agenda ou conversa com você', en: 'Only people in your contacts or chats', es: 'Solo tus contactos o chats' },
  preparing: { pt: 'Preparando…', en: 'Preparing…', es: 'Preparando…' },
  sending: { pt: 'Enviando {p}%', en: 'Uploading {p}%', es: 'Enviando {p}%' },
  finishing: { pt: 'Finalizando…', en: 'Finishing…', es: 'Finalizando…' },
  failed: { pt: 'Não foi possível publicar', en: 'Could not share', es: 'No se pudo publicar' },
  retry: { pt: 'Tentar de novo', en: 'Try again', es: 'Reintentar' },
  published: { pt: 'Publicado no seu perfil', en: 'Posted to your profile', es: 'Publicado en tu perfil' },
  discardTitle: { pt: 'Descartar publicação?', en: 'Discard post?', es: '¿Descartar publicación?' },
  discardMsg: { pt: 'As fotos e a legenda não serão salvas.', en: 'Your photos and caption will not be saved.', es: 'Las fotos y el texto no se guardarán.' },
  discard: { pt: 'Descartar', en: 'Discard', es: 'Descartar' },
  keep: { pt: 'Continuar editando', en: 'Keep editing', es: 'Seguir editando' },
  cancel: { pt: 'Cancelar', en: 'Cancel', es: 'Cancelar' },
  pickTitle: { pt: 'Escolha fotos e vídeos', en: 'Choose photos and videos', es: 'Elige fotos y videos' },
  pickHint: { pt: 'Até 10 itens num carrossel', en: 'Up to 10 items in a carousel', es: 'Hasta 10 elementos en un carrusel' },
  fromLibrary: { pt: 'Escolher da galeria', en: 'Choose from library', es: 'Elegir de la galería' },
  camera: { pt: 'Câmera', en: 'Camera', es: 'Cámara' },
  permTitle: { pt: 'Permissão negada', en: 'Permission denied', es: 'Permiso denegado' },
  permMsg: { pt: 'Permita acesso às fotos para continuar.', en: 'Allow photo access to continue.', es: 'Permite el acceso a las fotos para continuar.' },
  camPermMsg: { pt: 'Permita acesso à câmera para continuar.', en: 'Allow camera access to continue.', es: 'Permite el acceso a la cámara para continuar.' },
  editCaption: { pt: 'Editar legenda', en: 'Edit caption', es: 'Editar texto' },
  deletePost: { pt: 'Excluir publicação', en: 'Delete post', es: 'Eliminar publicación' },
  deleteTitle: { pt: 'Excluir publicação?', en: 'Delete post?', es: '¿Eliminar publicación?' },
  deleteMsg: { pt: 'Ela some do seu perfil para todo mundo. Não dá para desfazer.', en: 'It will be removed from your profile for everyone. This cannot be undone.', es: 'Se quitará de tu perfil para todos. No se puede deshacer.' },
  delete: { pt: 'Excluir', en: 'Delete', es: 'Eliminar' },
  save: { pt: 'Salvar', en: 'Save', es: 'Guardar' },
  saveFailed: { pt: 'Não foi possível salvar', en: 'Could not save', es: 'No se pudo guardar' },
  deleteFailed: { pt: 'Não foi possível excluir a publicação', en: 'Could not delete the post', es: 'No se pudo eliminar la publicación' },
  more: { pt: 'Mais opções', en: 'More options', es: 'Más opciones' },
  video: { pt: 'Vídeo', en: 'Video', es: 'Video' },
  editHint: { pt: 'Toque e segure uma miniatura para trocar a ordem', en: 'Touch and hold a thumbnail to reorder', es: 'Mantén pulsada una miniatura para reordenar' },
  reorderHint: { pt: 'Toque em outra miniatura para trocar de posição', en: 'Tap another thumbnail to swap', es: 'Toca otra miniatura para cambiar de posición' },
  captionPh: { pt: 'Escreva uma legenda…', en: 'Write a caption…', es: 'Escribe un texto…' },
  empty: { pt: 'Escolha fotos ou vídeos para publicar no seu perfil', en: 'Choose photos or videos to post to your profile', es: 'Elige fotos o videos para publicar en tu perfil' },
  add: { pt: 'Adicionar', en: 'Add', es: 'Añadir' },
  maxReached: { pt: 'Máximo de 10 itens por publicação', en: 'Up to 10 items per post', es: 'Máximo 10 elementos por publicación' },
  editPhoto: { pt: 'Editar foto', en: 'Edit photo', es: 'Editar foto' },
  removeItem: { pt: 'Remover', en: 'Remove', es: 'Quitar' },
};

function _lang() {
  try {
    const h = require('./api').getAuthHeaders?.() || {};
    const l = String(h['X-User-Language'] || '').slice(0, 2).toLowerCase();
    if (l === 'en' || l === 'es') return l;
  } catch {}
  return 'pt';
}

/** Texto local (pt/en/es). `vars` substitui {chave}. */
export function pcT(name, vars) {
  const row = L[name];
  let s = row ? (row[_lang()] || row.pt) : name;
  if (vars) for (const k of Object.keys(vars)) s = s.replace(`{${k}}`, String(vars[k]));
  return s;
}

const _wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Menu de ações SEM <Modal>: ActionSheetIOS no iOS (folha nativa do sistema),
 * Alert com botões no Android/web. options = [{ label, onPress, destructive }].
 */
export function showActionMenu({ title, message, options = [], cancelLabel } = {}) {
  const opts = options.filter(Boolean);
  if (!opts.length) return;
  const cancel = cancelLabel || pcT('cancel');
  if (Platform.OS === 'ios' && ActionSheetIOS?.showActionSheetWithOptions) {
    const labels = opts.map((o) => o.label).concat([cancel]);
    const destructiveButtonIndex = opts.map((o, i) => (o.destructive ? i : -1)).filter((i) => i >= 0);
    ActionSheetIOS.showActionSheetWithOptions(
      { title, message, options: labels, cancelButtonIndex: labels.length - 1, destructiveButtonIndex: destructiveButtonIndex.length ? destructiveButtonIndex : undefined },
      (i) => { if (i >= 0 && i < opts.length) { try { opts[i].onPress?.(); } catch {} } },
    );
    return;
  }
  if (Platform.OS === 'web') {
    // web: sem folha nativa — primeira opção não destrutiva direto (fluxo principal).
    const first = opts.find((o) => !o.destructive) || opts[0];
    try { first.onPress?.(); } catch {}
    return;
  }
  const buttons = opts.slice(0, 3).map((o) => ({ text: o.label, style: o.destructive ? 'destructive' : 'default', onPress: () => { try { o.onPress?.(); } catch {} } }));
  buttons.push({ text: cancel, style: 'cancel' });
  Alert.alert(title || '', message || '', buttons, { cancelable: true });
}

function _toItem(a, idx) {
  const isVid = a.type === 'video' || String(a.mimeType || '').startsWith('video');
  const ext = isVid ? 'mp4' : 'jpg';
  let name = a.fileName || '';
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) name = `media_${Date.now()}_${idx}.${ext}`;
  return {
    id: `${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 7)}`,
    uri: a.uri,
    type: isVid ? 'video' : 'image',
    width: a.width || 0,
    height: a.height || 0,
    duration: a.duration || 0,
    fileName: name,
    mimeType: a.mimeType || (isVid ? 'video/mp4' : 'image/jpeg'),
  };
}

/**
 * Abre o seletor (galeria múltipla ou câmera) e devolve itens prontos p/ o compositor.
 * null = cancelou/negou. Chamar só com a tela estável (sem transição em andamento).
 */
export async function pickPostMedia({ mode = 'library', limit = POST_MAX_ITEMS } = {}) {
  let ImagePicker = null;
  try { ImagePicker = require('expo-image-picker'); } catch { return null; }
  if (mode === 'camera') {
    if (Platform.OS !== 'web') {
      const perm = await ImagePicker.requestCameraPermissionsAsync?.();
      if (perm && !perm.granted) { Alert.alert(pcT('permTitle'), pcT('camPermMsg')); return null; }
    }
    const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images', 'videos'], quality: 0.9, videoMaxDuration: 90 });
    if (!r || r.canceled || !r.assets?.length) return null;
    return r.assets.slice(0, 1).map(_toItem);
  }
  // PHPicker (iOS 14+) não precisa de permissão da fototeca; pedir antes só
  // atrasava/ bloqueava quem deu acesso "limitado". Android 13+ idem (Photo Picker).
  const r = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
    allowsMultipleSelection: true,
    selectionLimit: Math.max(1, Math.min(POST_MAX_ITEMS, limit)),
    orderedSelection: true,
    quality: 0.9,
  });
  if (!r || r.canceled || !r.assets?.length) return null;
  return r.assets.slice(0, Math.max(1, limit)).map(_toItem);
}

// Entrega em memória (AsyncStorage fica de reserva p/ binários/rotas antigas).
let _pending = null;
export function takePendingPostItems() { const p = _pending; _pending = null; return p; }
// [mural 2026-10-20] services/muralNav.openComposer({ items }) entrega os itens já escolhidos.
export function stashPendingPostItems(items) { if (Array.isArray(items) && items.length) _pending = items.slice(0, POST_MAX_ITEMS); }

/**
 * Abre o compositor. Sem `items` → o próprio compositor abre o seletor depois da
 * transição (pick = 'library' | 'camera'). `from` decide para onde voltar.
 */
export function openPostComposer(router, { pick = 'library', from = '', items = null } = {}) {
  try {
    if (Array.isArray(items) && items.length) _pending = items.slice(0, POST_MAX_ITEMS);
    const q = [];
    if (!_pending && pick) q.push(`pick=${encodeURIComponent(pick)}`);
    if (from) q.push(`from=${encodeURIComponent(from)}`);
    router?.push?.(`/photo-new${q.length ? `?${q.join('&')}` : ''}`);
    return true;
  } catch {
    return false;
  }
}

/** Editar legenda do próprio post (servidor: feed_edit_post). */
export async function editPostCaption(postId, caption) {
  try {
    const r = await require('./api').apiCall('feed_edit_post', { post_id: Number(postId), caption: String(caption || '') }, 'POST');
    if (r && r.success) { try { DeviceEventEmitter.emit(POSTS_CHANGED_EVENT, { id: Number(postId), caption: r.data?.post?.caption ?? caption }); } catch {} }
    return r;
  } catch (e) {
    return { success: false, message: e?.message || '' };
  }
}

/** Confirma e exclui o próprio post. Resolve true se excluiu. */
export function confirmDeletePost(postId) {
  return new Promise((resolve) => {
    const go = async () => {
      let r = null;
      try { r = await require('./api').feedDeletePost(postId); } catch { r = null; }
      const ok = !!(r && r.success !== false && r.ok !== false);
      if (ok) { try { DeviceEventEmitter.emit(POSTS_CHANGED_EVENT, { id: Number(postId), deleted: true }); } catch {} }
      else { try { Alert.alert(pcT('deleteFailed'), (r && (r.message || r.error)) || ''); } catch {} }
      resolve(ok);
    };
    if (Platform.OS === 'web') {
      const ok = typeof window !== 'undefined' && window.confirm ? window.confirm(pcT('deleteMsg')) : true;
      if (ok) go(); else resolve(false);
      return;
    }
    Alert.alert(pcT('deleteTitle'), pcT('deleteMsg'), [
      { text: pcT('cancel'), style: 'cancel', onPress: () => resolve(false) },
      { text: pcT('delete'), style: 'destructive', onPress: go },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

/** Pequena espera p/ a folha/menu terminar de sair antes de apresentar outra coisa (iOS). */
export function afterSheet(ms = 380) { return Platform.OS === 'ios' ? _wait(ms) : Promise.resolve(); }
