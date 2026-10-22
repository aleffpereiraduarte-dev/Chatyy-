// [apagar-ao-entregar F1 2026-10-22] Aparelho (device_id e2ee5) que vai junto no ack de ENTREGA
// (chat_delivery_ack HTTP, frame WS delivery_ack, chat_push_delivered do push). O servidor grava o ack
// POR APARELHO numa fila sombra (só mede; nada é apagado) e confere que o aparelho é desta conta.
// Sem e2ee5 ligado / sem sessão → '' (o servidor trata como ack sem aparelho, igual a cliente antigo).
// A task de push em 2º plano pode rodar sem a sessão e2ee5 aberta → usa a última cópia no AsyncStorage.
// Kill OTA: globalThis.__chatyy_dlv_device = false.

const KEY = '@chatyy_dlv_device_v1';
const DEV_RE = /^[A-Z][A-Z2-7]{12}$/;
let _mem = '';
let _saved = '';

function _off() {
  try { return globalThis.__chatyy_dlv_device === false; } catch { return false; }
}

function _AS() {
  try { return require('@react-native-async-storage/async-storage').default; } catch { return null; }
}

function _live() {
  try {
    const d = require('./e2ee/e2ee5').deviceIdSync?.() || '';
    return DEV_RE.test(d) ? d : '';
  } catch { return ''; }
}

function _remember(d) {
  if (!d || d === _saved) return;
  _saved = d;
  const AS = _AS();
  if (!AS) return;
  try { AS.setItem(KEY, d).catch(() => {}); } catch {}
}

/** device_id e2ee5 deste aparelho agora ('' se não houver). Guarda a última para a task de push. */
export function dlvDeviceIdSync() {
  if (_off()) return '';
  const d = _live();
  if (d) { _mem = d; _remember(d); return d; }
  return _mem;
}

/** Igual, mas cai na cópia do AsyncStorage (task de push em 2º plano, sessão e2ee5 fechada). */
export async function dlvDeviceIdAsync() {
  const d = dlvDeviceIdSync();
  if (d || _off()) return d;
  const AS = _AS();
  if (!AS) return '';
  try {
    const v = String((await AS.getItem(KEY)) || '');
    if (DEV_RE.test(v)) { _mem = v; _saved = v; return v; }
  } catch {}
  return '';
}
