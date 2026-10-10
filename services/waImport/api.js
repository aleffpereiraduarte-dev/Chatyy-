// [2026-10-10 wa-import] Chamadas do importador do WhatsApp (email.php?action=wa_import_*).
// Sempre direto no US (as escritas iriam para lá de qualquer jeito via edge-forward;
// evita a mídia atravessar o oceano duas vezes).
import { Platform } from 'react-native';
import { getAuthHeaders } from '../api';

const US_API = 'https://chatyy.com.br/api/email.php';

async function _post(action, body, timeoutMs = 60000) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch {} }, timeoutMs) : null;
  try {
    const r = await fetch(`${US_API}?action=${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(body || {}),
      signal: ctrl ? ctrl.signal : undefined,
    });
    let j = null;
    try { j = await r.json(); } catch {}
    if (!j) return { success: false, status: r.status, message: `http_${r.status}` };
    j.status = r.status;
    return j;
  } catch (e) {
    return { success: false, status: 0, message: e?.name === 'AbortError' ? 'timeout' : (e?.message || 'network') };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const waImportStart = (p) => _post('wa_import_start', p);
export const waImportBatch = (importId, messages) => _post('wa_import_batch', { import_id: importId, messages }, 120000);
export const waImportFinish = (importId) => _post('wa_import_finish', { import_id: importId });
export const waImportList = () => _post('wa_import_list', {}, 20000);
export const waImportDelete = (importId) => _post('wa_import_delete', { import_id: importId });

/**
 * Sobe 1 arquivo de mídia. file: nativo { uri, name, type } | web Blob/File.
 */
export async function waImportMedia(importId, name, file, mime, timeoutMs = 300000) {
  const fd = new FormData();
  fd.append('import_id', String(importId));
  fd.append('name', name);
  if (Platform.OS === 'web') fd.append('file', file, name);
  else fd.append('file', { uri: file.uri, name, type: mime || 'application/octet-stream' });
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch {} }, timeoutMs) : null;
  try {
    const r = await fetch(`${US_API}?action=wa_import_media`, {
      method: 'POST', headers: { ...getAuthHeaders() }, body: fd, signal: ctrl ? ctrl.signal : undefined,
    });
    let j = null;
    try { j = await r.json(); } catch {}
    if (!j) return { success: false, status: r.status, message: `http_${r.status}` };
    j.status = r.status;
    return j;
  } catch (e) {
    return { success: false, status: 0, message: e?.name === 'AbortError' ? 'timeout' : (e?.message || 'network') };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
