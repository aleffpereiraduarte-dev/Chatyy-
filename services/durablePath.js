// [2026-10-23 reels-sumiu] Caminhos duráveis no iOS.
//
// No iOS o caminho ABSOLUTO do container do app (…/Application/<UUID>/Documents/)
// MUDA quando o app é atualizado/reinstalado (TestFlight 773 → 774 etc.). Os
// arquivos são migrados, mas um rascunho que guardou "file:///…/<UUID-velho>/
// Documents/video-studio/<id>/x.mp4" passa a apontar p/ um arquivo que "não
// existe": prévia preta, editor sem vídeo, upload com tamanho 0 → não posta.
//
// rebaseDocUri(uri, marker) troca o prefixo antigo pelo documentDirectory ATUAL
// sempre que o caminho contém "/Documents/<marker>" e não começa com o
// documentDirectory de agora. Não toca URLs remotas, content:// nem blob:.
import { Platform } from 'react-native';

let _FS;
function FS() {
  if (_FS !== undefined) return _FS;
  if (Platform.OS === 'web') { _FS = null; return _FS; }
  try { _FS = require('expo-file-system/legacy'); } catch { _FS = null; }
  return _FS;
}

export function docDir() {
  const f = FS();
  return (f && f.documentDirectory) || null;
}

/** @param {string} uri  @param {string} marker ex.: 'video-studio/' | 'reels-drafts/' */
export function rebaseDocUri(uri, marker) {
  if (!uri || typeof uri !== 'string' || !marker) return uri;
  const dd = docDir();
  if (!dd || uri.startsWith(dd)) return uri;
  if (!/^file:|^\//i.test(uri)) return uri;
  const key = `/Documents/${marker}`;
  const i = uri.indexOf(key);
  if (i < 0) return uri;
  return dd + uri.slice(i + '/Documents/'.length);
}

/** true/false = existe/não existe; null = não dá p/ saber (web, remoto, erro). */
export async function fileExists(uri) {
  const f = FS();
  if (!f || !uri || !/^file:/i.test(String(uri))) return null;
  try { const i = await f.getInfoAsync(uri); return !!(i && i.exists); } catch { return null; }
}

export default { docDir, rebaseDocUri, fileExists };
