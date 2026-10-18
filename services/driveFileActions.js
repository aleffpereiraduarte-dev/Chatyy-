/**
 * driveFileActions — [2026-10-16 drive-native] abrir / enviar cópia / salvar
 * arquivos do Cloud no APARELHO, sem URL pública e sem navegador.
 *
 *   • baixa com permissão curta do servidor (drive_dl_token → `dl`, nunca o
 *     bearer na URL) para o cache do app, com progresso real;
 *   • abrir = QuickLook (iOS) / "Abrir com…" (Android) do ExpoChatyyDocPreview,
 *     com queda para a folha de compartilhar do sistema;
 *   • enviar cópia = folha de compartilhar nativa (iOS mostra "Salvar em
 *     Arquivos", AirDrop, Mail…);
 *   • salvar = iOS "Salvar em Arquivos" (UIDocumentPicker, binário com
 *     apiVersion ≥ 2) / Android pasta Downloads/Chatyy (MediaStore). Binário
 *     antigo → folha de compartilhar.
 *
 * Os blobs do Drive continuam atrás da ACL de files.php/drive.php
 * (drive_download confere dono/compartilhamento); nada aqui monta link público.
 */
import { Platform } from 'react-native';
import * as api from './api';
import { docPreviewModule, docMime } from '../utils/openDocument';

const _inflight = new Map(); // fileId -> Promise<localUri>

function _fs() { try { return require('expo-file-system/legacy'); } catch { return null; } }

function _safeName(name, id) {
  const n = String(name || `arquivo-${id}`).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return (n || `arquivo-${id}`).slice(-120);
}

export function mimeOf(item) {
  const m = String(item?.mime_type || item?.mime || '');
  if (m && m !== 'application/octet-stream') return m;
  return docMime(item?.name, '');
}

/**
 * Baixa o arquivo para o cache do app (uma vez por id+tamanho) e devolve o
 * file:// local. onProgress(0..100).
 */
export async function downloadToDevice(item, onProgress) {
  if (Platform.OS === 'web') throw new Error('web');
  const id = item?.id;
  if (!id) throw new Error('no_id');
  const key = String(id);
  if (_inflight.has(key)) return _inflight.get(key);
  const p = (async () => {
    const FS = _fs();
    if (!FS) throw new Error('no_fs');
    const dir = `${FS.cacheDirectory}drive-dl/${key}/`;
    const dest = dir + _safeName(item.name, id);
    try {
      const info = await FS.getInfoAsync(dest);
      const want = Number(item.size) || 0;
      if (info?.exists && info.size > 0 && (!want || Math.abs(info.size - want) < 2)) return dest;
    } catch {}
    await FS.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
    // Permissão curta (dl) — nunca o bearer perpétuo numa URL entregue ao SO.
    const url = await api.fileDownloadUrlGranted(id, { allowBearerFallback: false });
    if (!url) throw new Error('no_grant');
    const task = FS.createDownloadResumable(url, dest, {}, (d) => {
      const tot = Number(d?.totalBytesExpectedToWrite) || Number(item.size) || 0;
      if (tot > 0 && onProgress) { try { onProgress(Math.min(99, Math.round((d.totalBytesWritten / tot) * 100))); } catch {} }
    });
    const r = await task.downloadAsync();
    if (!r || r.status < 200 || r.status >= 300) {
      FS.deleteAsync(dest, { idempotent: true }).catch(() => {});
      throw new Error(`http_${r?.status || 0}`);
    }
    // Resposta HTML = página de erro/SPA, não o arquivo.
    const ct = String(r.headers?.['Content-Type'] || r.headers?.['content-type'] || '');
    if (/text\/html/i.test(ct) && !/\.html?$/i.test(String(item.name || ''))) {
      FS.deleteAsync(dest, { idempotent: true }).catch(() => {});
      throw new Error('html_response');
    }
    if (onProgress) { try { onProgress(100); } catch {} }
    return dest;
  })();
  _inflight.set(key, p);
  try { return await p; } finally { _inflight.delete(key); }
}

async function _shareLocal(local, item, title) {
  const Sharing = require('expo-sharing');
  if (!(await Sharing.isAvailableAsync())) return false;
  await Sharing.shareAsync(local, { mimeType: mimeOf(item), dialogTitle: title || item?.name || '' });
  return true;
}

/** Abre no visualizador do sistema (QuickLook / Abrir com…). */
export async function openOnDevice(item, onProgress) {
  const local = await downloadToDevice(item, onProgress);
  const mod = docPreviewModule();
  if (mod) {
    try {
      const ok = Platform.OS === 'ios'
        ? await mod.preview(local, item?.name || '')
        : await mod.preview(local, mimeOf(item), item?.name || '');
      if (ok) return 'preview';
    } catch {}
  }
  return (await _shareLocal(local, item)) ? 'share' : 'none';
}

/** Folha de compartilhar do sistema com o arquivo (inclui "Salvar em Arquivos" no iOS). */
export async function sendCopy(item, onProgress, title) {
  const local = await downloadToDevice(item, onProgress);
  return _shareLocal(local, item, title);
}

/** true quando o binário tem o salvar nativo (iOS exportToFiles / Android saveToDownloads). */
export function hasNativeSave() {
  const mod = docPreviewModule();
  if (!mod) return false;
  try { if ((Number(mod.apiVersion?.()) || 1) < 2) return false; } catch { return false; }
  return Platform.OS === 'ios' ? typeof mod.exportToFiles === 'function' : typeof mod.saveToDownloads === 'function';
}

/**
 * Salva no aparelho. Retorna 'saved' | 'cancelled' | 'shared' | 'none'.
 */
export async function saveToDevice(item, onProgress) {
  const local = await downloadToDevice(item, onProgress);
  if (hasNativeSave()) {
    const mod = docPreviewModule();
    try {
      if (Platform.OS === 'ios') return (await mod.exportToFiles(local)) ? 'saved' : 'cancelled';
      if (await mod.saveToDownloads(local, item?.name || '', mimeOf(item))) return 'saved';
    } catch {}
  }
  return (await _shareLocal(local, item)) ? 'shared' : 'none';
}

/**
 * [2026-10-18 cloud-send] "Enviar para conversa": arquivo do Cloud → anexo de
 * VERDADE numa conversa do Chatyy (bolha nativa de foto/vídeo/documento), não
 * link nem permissão por e-mail. Baixa com a permissão curta (dl) para o cache
 * e entrega ao seletor /share-receive (mesmo seletor/fila durável do "Compartilhar
 * no Chatyy" do sistema: escolhe o contato, envia, abre a conversa).
 * Web: a URL com `dl` (curta, por arquivo) vira Blob no envio direto.
 */
export async function sendToChat(item, router, onProgress) {
  if (!item?.id || item.is_folder) return false;
  const mime = mimeOf(item) || 'application/octet-stream';
  const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file';
  let uri = null;
  if (Platform.OS === 'web') {
    uri = await api.fileDownloadUrlGranted(item.id, { allowBearerFallback: false });
    if (!uri) throw new Error('no_grant');
  } else {
    uri = await downloadToDevice(item, onProgress);
  }
  const name = _safeName(item.name || item.original_name, item.id);
  const files = [{ uri, mime, name, kind, w: Number(item.width) || 0, h: Number(item.height) || 0, size: Number(item.size) || 0 }];
  router.push({ pathname: '/share-receive', params: { files: JSON.stringify(files), uri, name, mime, type: kind, src: 'cloud' } });
  return true;
}
