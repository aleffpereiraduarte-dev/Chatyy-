/**
 * Reel drafts — [2026-10-08 reels-publish]
 *
 * Single source of truth for the AsyncStorage `reel_drafts` list (newest first,
 * cap MAX_REEL_DRAFTS) used by the recorder (auto-draft on "Next"), the drafts
 * grid and the /reels-compose screen ("Salvar rascunho" + resume).
 *
 * A draft = { id, savedAt, clips: [{ uri, durationMs, speed?, imported? }],
 *             music, totalDurationMs, compose?: { caption, audience,
 *             allowComments, coverMs, trimStartMs, trimEndMs, tagged } }
 *
 * Native: clip files are copied into documentDirectory/reels-drafts/ so the OS
 * can't purge them from the cache dir before the user comes back. Web: blob:
 * URLs only live as long as the tab — drafts still work within the session.
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const REEL_DRAFTS_KEY = 'reel_drafts';
export const MAX_REEL_DRAFTS = 5;
const DRAFT_DIR = 'reels-drafts/';

function _FS() { if (Platform.OS === 'web') return null; try { return require('expo-file-system/legacy'); } catch { return null; } }

export async function listReelDrafts() {
  try {
    const raw = await AsyncStorage.getItem(REEL_DRAFTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

export async function getReelDraft(id) {
  if (!id) return null;
  const list = await listReelDrafts();
  return list.find(d => d && d.id === id) || null;
}

async function _writeList(list) {
  try { await AsyncStorage.setItem(REEL_DRAFTS_KEY, JSON.stringify(list.slice(0, MAX_REEL_DRAFTS))); } catch {}
}

async function _durableClips(id, clips) {
  const FS = _FS();
  // web File objects can't be serialized (JSON → {}), keep only the blob: uri.
  if (!FS || !FS.documentDirectory) return clips.map(c => { const x = { ...c }; delete x.file; return x; });
  const dir = FS.documentDirectory + DRAFT_DIR;
  try { await FS.makeDirectoryAsync(dir, { intermediates: true }); } catch {}
  const out = [];
  for (let i = 0; i < clips.length; i++) {
    const c = { ...clips[i] };
    if (c.uri && !String(c.uri).startsWith(dir) && /^file:|^\//.test(String(c.uri))) {
      const m = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(String(c.uri));
      const dest = `${dir}${id}_${i}_${Date.now().toString(36)}.${m ? m[1].toLowerCase() : 'mp4'}`;
      try { await FS.copyAsync({ from: c.uri, to: dest }); c.uri = dest; } catch {}
    }
    delete c.file; // web File objects can't be serialized
    out.push(c);
  }
  return out;
}

async function _deleteFiles(clips, keepUris = new Set()) {
  const FS = _FS();
  if (!FS || !FS.documentDirectory) return;
  const dir = FS.documentDirectory + DRAFT_DIR;
  for (const c of clips || []) {
    if (c?.uri && String(c.uri).startsWith(dir) && !keepUris.has(c.uri)) {
      try { await FS.deleteAsync(c.uri, { idempotent: true }); } catch {}
    }
  }
}

/**
 * Create (no id) or update (id) a draft. Returns the stored record or null.
 */
export async function saveReelDraft(payload, id = null) {
  try {
    const list = await listReelDrafts();
    const draftId = id || payload?.id || `draft_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const prev = list.find(d => d && d.id === draftId) || null;
    const clips = await _durableClips(draftId, payload?.clips || prev?.clips || []);
    const record = {
      id: draftId,
      savedAt: Date.now(),
      clips,
      music: payload?.music !== undefined ? payload.music : (prev?.music || null),
      totalDurationMs: payload?.totalDurationMs || clips.reduce((a, c) => a + (c.durationMs || 0), 0) || prev?.totalDurationMs || 0,
      compose: payload?.compose !== undefined ? payload.compose : (prev?.compose || null),
    };
    if (prev) await _deleteFiles(prev.clips, new Set(clips.map(c => c.uri)));
    const evicted = [record, ...list.filter(d => d && d.id !== draftId)];
    const next = evicted.slice(0, MAX_REEL_DRAFTS);
    for (const d of evicted.slice(MAX_REEL_DRAFTS)) await _deleteFiles(d.clips);
    await _writeList(next);
    return record;
  } catch {
    return null;
  }
}

export async function deleteReelDraft(id, { keepFiles = false } = {}) {
  if (!id) return [];
  const list = await listReelDrafts();
  const target = list.find(d => d && d.id === id);
  const next = list.filter(d => d && d.id !== id);
  await _writeList(next);
  if (target && !keepFiles) await _deleteFiles(target.clips);
  return next;
}

export default { listReelDrafts, getReelDraft, saveReelDraft, deleteReelDraft, REEL_DRAFTS_KEY, MAX_REEL_DRAFTS };
