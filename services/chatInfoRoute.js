// services/chatInfoRoute.js — [2026-10-18 chat-info-push] "Dados do contato /
// do grupo" como ROTA EMPURRADA (app/chat-info/[id].js) em vez do <Modal slide>:
// swipe-back nativo (tela cheia), pilha de verdade (Telegram/WhatsApp iOS).
//
// A tela da conversa continua DONA de tudo: monta os descritores
// (buildContactChatInfo / buildGroupChatInfo, com os MESMOS handlers) e os
// publica aqui a cada render enquanto a info está aberta; a rota só lê e pinta
// <NativeChatInfo>. Nada é buscado de novo na rota → sem "piscar".
//
// Ciclo:
//   conversa: openInfo(key, {props, onDismiss}) + router.push('/chat-info/<key>')
//   conversa: publishInfo(key, props) a cada render
//   conversa: closeInfo(key, {after, back}) → a rota se remove (pop nativo);
//             `after` roda quando a rota sumiu (sheets/Modals da conversa só
//             apresentam com a conversa na janela — regra iOS: nunca Modal
//             sobre Modal / host sem window não apresenta);
//             back:true = remove a info E a conversa (sair/apagar grupo)
//   rota:     screenGone(key) no unmount → se não foi pedido pela conversa
//             (gesto/voltar) chama onDismiss → conversa zera showX.
//
// Gate: nativo (iOS/Android) + ChatyyChatInfo api ≥ 4 com a barra nativa
// (nativeChatInfoOwnsHeader) + kill switch OTA
// globalThis.__chatyy_chatinfo_push = false → volta o <Modal> de antes.
import { Platform } from 'react-native';

const AFTER_CAP_MS = 900; // a rota não avisou que sumiu → roda `after` mesmo assim
const AFTER_POP_IOS_MS = 380; // ≈ duração do pop nativo (a folha antiga usava 350 ms após fechar)
const AFTER_POP_ANDROID_MS = 250;

const _entries = new Map(); // key -> { props, subs:Set, onDismiss, closing, cmd, after, mounted, afterTm }

export function chatInfoPushEnabled() {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false;
  try { if (globalThis.__chatyy_chatinfo_push === false) return false; } catch {}
  try {
    if (!require('../components/chat/NativeChatInfo').nativeChatInfoOwnsHeader()) return false;
    return require('../modules/expo-chat-conversation-list').chatInfoApiVersion() >= 4;
  } catch { return false; }
}

export function chatInfoKey(kind, convId) {
  return `${kind === 'group' ? 'group' : 'contact'}:${String(convId == null ? '' : convId)}`;
}

function _notify(e) {
  for (const cb of Array.from(e.subs)) { try { cb(e); } catch {} }
}

/** Aberta (e não fechando) para esta chave? */
export function isInfoOpen(key) {
  const e = _entries.get(String(key));
  return !!(e && !e.closing);
}

export function getInfo(key) {
  return _entries.get(String(key)) || null;
}

export function openInfo(key, { props, onDismiss } = {}) {
  const k = String(key);
  const prev = _entries.get(k);
  if (prev && !prev.closing) { prev.props = props || prev.props; prev.onDismiss = onDismiss || prev.onDismiss; _notify(prev); return false; }
  _entries.set(k, { props: props || null, subs: new Set(), onDismiss: onDismiss || null, closing: false, cmd: null, after: [], mounted: false, afterTm: null });
  return true;
}

export function publishInfo(key, props) {
  const e = _entries.get(String(key));
  if (!e || e.closing || !props) return;
  e.props = props;
  _notify(e);
}

function _runAfter(e) {
  if (e.afterTm) { clearTimeout(e.afterTm); e.afterTm = null; }
  const fns = e.after.splice(0);
  for (const fn of fns) { try { fn(); } catch {} }
}

/**
 * Pede à rota que se remova. `after` roda quando ela sumir (ou no teto).
 * Devolve false se não havia rota aberta (o chamador segue o caminho de antes).
 */
export function closeInfo(key, { after, back } = {}) {
  const k = String(key);
  const e = _entries.get(k);
  if (!e) return false;
  if (typeof after === 'function') e.after.push(after);
  if (!e.closing || (back && e.cmd !== 'back')) {
    e.closing = true;
    e.cmd = back ? 'back' : 'close';
    if (!e.mounted && !back) {
      // rota ainda nem montou / já saiu: nada a remover
      _entries.delete(k);
      setTimeout(() => _runAfter(e), 0);
      return true;
    }
    _notify(e);
  }
  if (e.after.length && !e.afterTm) {
    e.afterTm = setTimeout(() => { _runAfter(e); if (_entries.get(k) === e && !e.mounted) _entries.delete(k); }, AFTER_CAP_MS);
  }
  return true;
}

export function subscribeInfo(key, cb) {
  const e = _entries.get(String(key));
  if (!e) return () => {};
  e.subs.add(cb);
  return () => { try { e.subs.delete(cb); } catch {} };
}

/** A rota montou (pode receber pedidos de fechar). */
export function screenMounted(key) {
  const e = _entries.get(String(key));
  if (!e) return false;
  e.mounted = true;
  if (e.closing) _notify(e);
  return true;
}

/** A rota desmontou (pop nativo terminou, gesto, voltar do Android…). */
export function screenGone(key) {
  const k = String(key);
  const e = _entries.get(k);
  if (!e) return;
  e.mounted = false;
  _entries.delete(k);
  if (!e.closing) { try { e.onDismiss && e.onDismiss(); } catch {} }
  // O React desmonta a rota JÁ no dispatch (o nativo segue animando o pop com a
  // view retida) → espera o pop acabar antes de apresentar sheets/Modals da
  // conversa (apresentar no meio da transição do UINavigationController falha).
  setTimeout(() => _runAfter(e), Platform.OS === 'ios' ? AFTER_POP_IOS_MS : AFTER_POP_ANDROID_MS);
}

/**
 * Android "voltar" físico: a conversa (por baixo) tem BackHandler próprio que
 * consome a tecla → ele chama isto antes; fecha a info aberta mais recente como
 * se fosse o gesto (onDismiss → conversa zera showX → closeInfo).
 */
export function dismissTopInfo() {
  let last = null;
  for (const e of _entries.values()) if (!e.closing) last = e;
  if (!last) return false;
  try { last.onDismiss && last.onDismiss(); } catch {}
  for (const [k, e] of _entries) if (e === last && !e.closing) closeInfo(k);
  return true;
}
