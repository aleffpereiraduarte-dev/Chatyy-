// [2026-10-13 video-studio] Cliente das ações do servidor do Video Studio.
//
//   reels_music_list   {q, category, cursor}  → [{id,title,artist,duration,url_preview,url,cover,license}]
//   reels_media_upload (multipart 'file')     → {url}
//   reels_render_submit {edl, publish, client_job_id} → {job_id}
//   reels_render_status {job_id}              → {state, progress, post_id, url, error}
//   reels_captions     {media_url|job_id, lang} → [{start,end,text}]
//
// Ações novas podem ainda não existir no servidor: cada função devolve
// { ok:false, missing:true } quando a resposta é "Unknown action"/404, para o
// chamador mostrar um erro claro (ou cair no caminho antigo).
import { Platform } from 'react-native';
import * as api from '../api';

function isMissing(r) {
  const msg = String((r && (r.error || r.message)) || '');
  return /unknown action|not found|invalid action|a[cç][aã]o desconhecida|404/i.test(msg) || r?.status === 404;
}
function payload(r) { return (r && (r.data !== undefined ? r.data : r)) || {}; }

async function call(action, params) {
  try {
    const r = await api.apiCall(action, params, 'POST');
    if (!r || r.success === false) return { ok: false, missing: isMissing(r), error: (r && (r.error || r.message)) || 'error', raw: r };
    return { ok: true, data: payload(r) };
  } catch (e) {
    return { ok: false, missing: false, error: e?.message || 'network', network: true };
  }
}

// ─── Músicas ────────────────────────────────────────────────────────────────
function normTrack(t) {
  if (!t) return null;
  const url = t.url || t.audio_url || t.preview_url || t.url_preview || '';
  return {
    id: String(t.id || t.sound_id || url),
    title: t.title || t.name || '',
    artist: t.artist || t.author || '',
    duration: Number(t.duration || t.duration_sec || 0) || 0,
    url_preview: t.url_preview || t.preview_url || url,
    url,
    cover: t.cover || t.image_url || t.artwork || '',
    license: t.license || '',
  };
}

/** → { ok, tracks, cursor, missing? } */
export async function musicList({ q = '', category = '', cursor = null } = {}) {
  const r = await call('reels_music_list', { q, category, cursor: cursor || '' });
  if (r.ok) {
    const d = r.data;
    const arr = Array.isArray(d) ? d : (d.tracks || d.items || d.music || []);
    return { ok: true, tracks: arr.map(normTrack).filter((x) => x && x.url), cursor: d.next_cursor || d.cursor || null };
  }
  if (!r.missing) return { ok: false, tracks: [], error: r.error };
  // Fallback: catálogo antigo (Pixabay) — sem categorias, paginado por página.
  const page = Number(cursor) > 0 ? Number(cursor) : 1;
  const query = [q, category].filter(Boolean).join(' ').trim();
  const r2 = query
    ? await call('reels_music_search', { q: query, page, per_page: 24 })
    : await call('reels_music_catalog', { page, per_page: 24 });
  if (!r2.ok) return { ok: false, tracks: [], error: r2.error, missing: r2.missing };
  const tracks = (r2.data.tracks || []).map(normTrack).filter((x) => x && x.url);
  return { ok: true, tracks, cursor: r2.data.has_more ? String(page + 1) : null, legacy: true };
}

// ─── Upload ─────────────────────────────────────────────────────────────────
function guessType(uri, kind) {
  const ext = (/\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(String(uri || '')) || [])[1]?.toLowerCase();
  if (kind === 'audio') return { ext: ext || 'm4a', type: ext === 'mp3' ? 'audio/mpeg' : ext === 'wav' ? 'audio/wav' : ext === 'aac' ? 'audio/aac' : 'audio/mp4' };
  if (kind === 'image') return { ext: ext || 'jpg', type: ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg' };
  return { ext: ext || 'mp4', type: ext === 'mov' ? 'video/quicktime' : ext === 'webm' ? 'video/webm' : 'video/mp4' };
}

export function fileDescriptor(asset, idx = 0) {
  const { ext, type } = guessType(asset.uri, asset.kind);
  return { uri: asset.uri, name: `studio_${idx}_${Date.now().toString(36)}.${ext}`, type, size: asset.size || 0 };
}

/** POST multipart reels_media_upload com progresso (XHR). → { ok, url } */
export function mediaUploadMultipart(file, { onProgress, signal } = {}) {
  return new Promise((resolve) => {
    try {
      const base = (api.getBaseUrl && api.getBaseUrl()) || 'https://chatyy.com.br';
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${base}/api/email.php?action=reels_media_upload`);
      const h = (api.getAuthHeaders && api.getAuthHeaders()) || {};
      Object.keys(h).forEach((k) => { try { xhr.setRequestHeader(k, h[k]); } catch {} });
      xhr.withCredentials = true;
      xhr.timeout = 15 * 60 * 1000;
      if (xhr.upload && onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let j = null;
        try { j = JSON.parse(xhr.responseText); } catch {}
        const d = payload(j);
        const url = d.url || d.cdn_url || d.media_url || null;
        if (xhr.status >= 200 && xhr.status < 300 && j && j.success !== false && url) resolve({ ok: true, url });
        else resolve({ ok: false, missing: xhr.status === 404 || isMissing(j), error: (j && (j.error || j.message)) || `http_${xhr.status}` });
      };
      xhr.onerror = () => resolve({ ok: false, error: 'network', network: true });
      xhr.ontimeout = () => resolve({ ok: false, error: 'timeout', network: true });
      if (signal) {
        if (signal.aborted) { resolve({ ok: false, error: 'aborted', aborted: true }); return; }
        signal.addEventListener?.('abort', () => { try { xhr.abort(); } catch {} resolve({ ok: false, error: 'aborted', aborted: true }); });
      }
      const fd = new FormData();
      fd.append('action', 'reels_media_upload');
      if (Platform.OS === 'web' && file._raw) fd.append('file', file._raw, file.name);
      else fd.append('file', { uri: file.uri, name: file.name, type: file.type });
      xhr.send(fd);
    } catch (e) {
      resolve({ ok: false, error: e?.message || 'upload_error' });
    }
  });
}

/**
 * Sobe 1 arquivo: Rust em blocos (retomável, progresso) → fallback multipart reels_media_upload.
 * resume = { uploadId, onUploadId } (só nativo).  → { ok, url, error? }
 */
export async function uploadAsset(file, email, { onProgress, signal, resume } = {}) {
  let r = null;
  if (typeof api.rustChunkedUpload === 'function') {
    try { r = await api.rustChunkedUpload(file, email, 'feed', onProgress, signal || null, resume || null); } catch (e) { r = { success: false, error: e?.message || 'upload_error' }; }
    const url = r?.cdn_url || r?.data?.cdn_url || r?.url || null;
    if (r?.success && url) return { ok: true, url };
    if (r?.aborted || signal?.aborted) return { ok: false, error: 'aborted', aborted: true };
  }
  const m = await mediaUploadMultipart(file, { onProgress, signal });
  if (m.ok) return m;
  return { ok: false, error: m.missing ? (r?.error || 'upload_unavailable') : m.error, hard: /too large|413|415|dangerous/i.test(String(m.error || r?.error || '')) };
}

// ─── Render ─────────────────────────────────────────────────────────────────
export async function renderSubmit(edl, publish, clientJobId) {
  const r = await call('reels_render_submit', { edl, publish, client_job_id: clientJobId });
  if (!r.ok) return r;
  const id = r.data.job_id || r.data.id;
  return id ? { ok: true, jobId: String(id) } : { ok: false, error: 'no_job_id' };
}

export async function renderStatus(jobId) {
  const r = await call('reels_render_status', { job_id: jobId });
  if (!r.ok) return r;
  const d = r.data;
  return {
    ok: true,
    state: d.state || 'queued',
    progress: Math.max(0, Math.min(1, Number(d.progress) > 1 ? Number(d.progress) / 100 : Number(d.progress) || 0)),
    postId: d.post_id != null ? String(d.post_id) : null,
    url: d.url || d.media_url || null,
    cover: d.cover_url || d.thumbnail_url || null,
    error: d.error || null,
  };
}

/** → { ok, segments:[{start,end,text}] } */
export async function captions({ mediaUrl, jobId, lang = 'pt' }) {
  const p = { lang };
  if (mediaUrl) p.media_url = mediaUrl;
  if (jobId) p.job = jobId;
  const r = await call('reels_captions', p);
  if (!r.ok) return r;
  const d = r.data;
  const arr = Array.isArray(d) ? d : (d.segments || d.captions || []);
  return {
    ok: true,
    segments: arr
      .map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').trim() }))
      .filter((s) => s.end > s.start && s.text),
  };
}

// ─── [2026-10-24 reels-marcar] Marcar pessoas ───────────────────────────────
export const TAG_MAX = 20;
function normPerson(u) {
  if (!u) return null;
  const email = String(u.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) return null;
  const username = String(u.username || u.handle || '').replace(/^@/, '');
  return { email, name: String(u.name || '').trim() || email.split('@')[0], username: username || null, avatar_url: u.avatar_url || '', rel: u.rel || (u.is_contact ? 'contact' : '') };
}
/**
 * Busca p/ "Marcar pessoas" → { ok, users:[{email,name,username,avatar_url,rel}], suggested }.
 * q vazio = sugestões (seguidos/seguidores/conversas). Servidor sem o kit → cai no people_search
 * (mesmo motor; já respeita bloqueios e "não me encontrar").
 */
export async function tagSearch(q = '') {
  const qq = String(q || '').trim().slice(0, 80);
  const r = await call('reels_tag_search', { q: qq, limit: 20 });
  if (r.ok) {
    const arr = Array.isArray(r.data?.users) ? r.data.users : [];
    return { ok: true, users: arr.map(normPerson).filter(Boolean), suggested: !!r.data?.suggested };
  }
  if (!r.missing) return { ok: false, users: [], error: r.error };
  if (qq.replace(/^@/, '').length < 2) return { ok: true, users: [], suggested: true, fallback: true };
  try {
    const r2 = await api.peopleSearch(qq);
    const d = payload(r2);
    const arr = Array.isArray(d?.users) ? d.users : [...(d?.contacts || []), ...(d?.global || [])];
    return { ok: true, users: arr.map(normPerson).filter(Boolean).slice(0, 20), fallback: true };
  } catch (e) { return { ok: false, users: [], error: e?.message || 'network' }; }
}
/** A pessoa marcada se tira do post → { ok, removed, tagged_users, tagged }. */
export async function tagRemove(postId) {
  const r = await call('reels_tag_remove', { post_id: Number(postId) || 0 });
  if (!r.ok) return r;
  return { ok: true, removed: !!r.data?.removed, tagged_users: Array.isArray(r.data?.tagged_users) ? r.data.tagged_users : [], tagged: Array.isArray(r.data?.tagged) ? r.data.tagged : [] };
}
/** Lista "com @fulano" de um post: tagged (objetos, feed de reels) ou tagged_users (e-mails, feed antigo). */
export function taggedPeople(post) {
  if (!post) return [];
  const objs = Array.isArray(post.tagged) ? post.tagged : null;
  const list = objs || (Array.isArray(post.tagged_users) ? post.tagged_users.map((e) => ({ email: e })) : []);
  const out = [];
  const seen = new Set();
  for (const it of list) {
    const p = typeof it === 'string' ? { email: it } : it;
    const email = String(p?.email || '').toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const handle = String(p.username || '').replace(/^@/, '') || email.split('@')[0];
    out.push({ email, name: p.name || handle, handle });
  }
  return out;
}

export default { musicList, uploadAsset, mediaUploadMultipart, renderSubmit, renderStatus, captions, fileDescriptor, tagSearch, tagRemove, taggedPeople, TAG_MAX };
