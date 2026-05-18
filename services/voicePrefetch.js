/**
 * Voice Prefetch Service
 *
 * WhatsApp-grade offline voice messages — wires the WebSocket receive
 * path to the audio-saved/ permanent cache so voice notes are on disk
 * the moment they arrive, BEFORE the user navigates into the chat. By
 * the time they open the bubble the audio plays in 0ms and the real
 * waveform is already painted from the persisted peaks.
 *
 * Scope: type === 'voice' OR type === 'audio' (chat bubble audio). Other
 * media (images, videos, docs) is handled by mediaCache.prefetchIncomingMessageMedia.
 *
 * Why split from mediaCache?
 * - audio-saved/ has a different retention policy (PERMANENT, no LRU).
 * - Waveform peaks travel alongside (small JSON sidecar in MMKV).
 * - Outbox + WS-reconnect resume logic only matters for voice.
 *
 * Bypasses the cellular gate — voice notes are 30-200KB and users
 * expect them to ALWAYS arrive, even on a flaky train connection.
 */

import { Platform } from 'react-native';
import {
  cacheVoiceMessage,
  setVoiceWaveform,
  adoptOutboxVoice,
  removeOutboxVoice,
  listOutboxVoices,
  saveVoiceSessionResume,
  getVoiceSessionResume,
  clearVoiceSessionResume,
} from './audioCache';
import { queueOfflineAction, isOnline } from './offlineCache';

// ────────────────────────────────────────────────────────────────────────
// INCOMING — WS chat_message / chat_summary handler
// ────────────────────────────────────────────────────────────────────────

// In-flight set keyed by message id — prevents duplicate prefetches when
// chat_message + chat_summary both fire for the same row (the WS server
// fan-out can dup events on the recipient side for the per-user channel).
const _inFlight = new Set();

/**
 * Called fire-and-forget from the WS chat_message / chat_summary
 * handlers (services/websocket.js) whenever an inbound message lands.
 * Idempotent — bails immediately if the message is not a voice/audio
 * type or if we've already prefetched it this session.
 */
export function onIncomingVoiceMessage(message) {
  try {
    if (!message) return;
    const t = String(message.type || '').toLowerCase();
    if (t !== 'voice' && t !== 'audio') return;
    const id = message.id != null ? String(message.id) : null;
    if (id && _inFlight.has(id)) return;
    let url = message.file_url;
    if (!url || typeof url !== 'string') return;
    // Normalize relative API paths to absolute. The same logic lives in
    // mediaCache.prefetchIncomingMessageMedia so behavior stays in sync.
    if (!url.startsWith('http')) url = `https://chatyy.com.br${url}`;
    if (id) _inFlight.add(id);
    // Server-side waveform travels in `wave_peaks` (array of 0..1 floats,
    // populated by the chat_voice_session_finalize action). Persist it
    // first so the receiver's bubble can paint bars in the next render
    // pass — without waiting on the audio download to resolve.
    const peaks = Array.isArray(message.wave_peaks)
      ? message.wave_peaks
      : (Array.isArray(message.waveform) ? message.waveform : null);
    if (peaks && peaks.length > 0) {
      setVoiceWaveform(url, peaks, message.id);
    }
    // Track this message id → conversation_id so when the AudioPlayer's
    // onended emits emitAudioFinished(messageId) the voicePlaybackBus
    // can auto-fire chatVoicePlayed (WhatsApp "played" receipt). Inbound
    // messages only — outgoing voice notes hit this path with our own
    // address as sender, so the bus's isOwn=false default still tracks
    // them; the server-side chat_voice_played handler dedupes own-msg
    // acks. Best-effort.
    try {
      const { trackVoiceMessage } = require('./voicePlaybackBus');
      if (typeof trackVoiceMessage === 'function' && message.id != null) {
        trackVoiceMessage(message.id, message.conversation_id || message.conversationId, false);
      }
    } catch {}
    // Web: defer to the browser's HTTP cache + Cache API (cacheMedia
    // already populates it for audio URLs). Skip the FS download path.
    if (Platform.OS === 'web') {
      // Still hit cacheVoiceMessage so the Cache API entry lands —
      // when the user opens the chat the <audio> element pulls from
      // service-worker cache instead of the network.
      cacheVoiceMessage(url, message.id, peaks).catch(() => {}).finally(() => {
        if (id) _inFlight.delete(id);
      });
      return;
    }
    cacheVoiceMessage(url, message.id, peaks)
      .catch(() => {})
      .finally(() => { if (id) _inFlight.delete(id); });
  } catch {}
}

// Convenience: process a batch (e.g. when a chat thread loads from cache
// and we want to ensure every voice bubble has on-disk audio).
export function prefetchVoiceMessages(messages) {
  if (!Array.isArray(messages)) return;
  for (const m of messages) onIncomingVoiceMessage(m);
}

// ────────────────────────────────────────────────────────────────────────
// OUTGOING — offline send (record now, upload when online)
// ────────────────────────────────────────────────────────────────────────

/**
 * Persist a just-recorded voice file into the outbox dir and queue a
 * chat_voice_upload action. The original temporary recording URI from
 * expo-audio is copied into documentDirectory so it survives an app
 * kill / reboot — chat_voice_upload's replay (offlineCache.js) re-reads
 * the persistent URI when net comes back.
 *
 * Returns the persistent URI (or null if persisting failed — caller
 * should fall back to inline upload attempt).
 */
export async function queueOfflineVoiceMessage({
  conversationId,
  localUri,
  tempId,
  clientMessageId,
  duration,
  mime,
  waveform,
  replyToId,
}) {
  if (!conversationId || !localUri) return null;
  // Copy from expo-audio's recording temp into our persistent outbox.
  // On web there's no real FS so the localUri is a blob: URL — we keep
  // it as-is but warn: blob URLs die on tab close, so the queue replay
  // will fail with file_uri_missing (hard error → dropped). The user
  // will see the red ❗ bubble and can retry by re-recording.
  let persistentUri = localUri;
  try {
    persistentUri = await adoptOutboxVoice(localUri, tempId) || localUri;
  } catch {}
  // Pre-cache waveform so the optimistic bubble shows the real envelope
  // immediately instead of the deterministic fake.
  if (Array.isArray(waveform) && waveform.length > 0) {
    try { setVoiceWaveform(persistentUri, waveform, tempId); } catch {}
  }
  try {
    await queueOfflineAction({
      type: 'chat_voice_upload',
      conversation_id: conversationId,
      audio_uri: persistentUri,
      audio_name: 'voice.' + (mime?.includes('webm') ? 'webm' : 'm4a'),
      audio_type: mime || 'audio/mp4',
      temp_id: tempId,
      client_message_id: clientMessageId,
      duration: Math.round(duration || 0),
      waveform: Array.isArray(waveform) ? waveform.slice(0, 64) : null,
      reply_to_id: replyToId || null,
    });
  } catch {}
  return persistentUri;
}

/**
 * Called by offlineCache.replayOfflineQueue when it walks the
 * chat_voice_upload case. Returns the file payload + waveform so the
 * shared chatUploadFile call can complete. Separated out so audioCache
 * stays the single source of truth for voice-specific upload params.
 */
export function buildVoiceUploadPayload(action) {
  if (!action || !action.audio_uri) return null;
  return {
    file: {
      uri: action.audio_uri,
      name: action.audio_name || 'voice.m4a',
      type: action.audio_type || 'audio/mp4',
    },
    duration: action.duration || 0,
    waveform: Array.isArray(action.waveform) ? action.waveform : null,
    replyToId: action.reply_to_id || null,
  };
}

/**
 * Cleanup hook — call after a successful chat_voice_upload replay so
 * the outbox file is deleted and disk doesn't grow indefinitely.
 */
export async function clearOutboxVoice(audioUri) {
  if (!audioUri) return;
  await removeOutboxVoice(audioUri);
}

/**
 * Startup sweep — list orphaned outbox files (e.g. user force-killed the
 * app between recording and the queueOfflineAction landing). We can't
 * recover the conversation_id / temp_id from a bare file, so the most
 * we can do is surface them as "draft" recordings the user can re-send
 * or delete. Returns array of { uri, ts } sorted oldest-first.
 *
 * For now this is informational — the chat-conversation screen owns the
 * drafts UI and reads this list on mount to render orphan voice cards.
 */
export async function listOrphanOutboxVoices() {
  try {
    return await listOutboxVoices();
  } catch { return []; }
}

// ────────────────────────────────────────────────────────────────────────
// WS RECONNECT — resume in-flight voice session
// ────────────────────────────────────────────────────────────────────────
//
// During a streaming voice session (chat_voice_session_*), the recorder
// flushes one chunk per ~250ms. If the WS drops mid-recording or the
// HTTP POST fails for a single chunk, we persist (sessionId, lastChunkIdx)
// so when the WS reconnects we can pick up at chunk N+1. Without this
// the entire upload would have to start from chunk 0.
//
// The recorder owns the audio buffer (it knows which slices haven't been
// flushed yet). This module owns the persistence — saveVoiceSessionResume
// + getVoiceSessionResume — so the recorder is a thin client.

export {
  saveVoiceSessionResume,
  getVoiceSessionResume,
  clearVoiceSessionResume,
};

/**
 * Called when WS reconnects (services/websocket.js connection event)
 * to scan for in-flight sessions that need to resume. The recorder
 * subscribes to this and re-flushes chunks from lastChunkIdx+1.
 */
const _resumeListeners = new Set();

export function onResumeNeeded(fn) {
  _resumeListeners.add(fn);
  return () => _resumeListeners.delete(fn);
}

export function notifyWsReconnected() {
  // Fire fire-and-forget to all listeners; recorder filters by its own
  // sessionId. Idempotent — no-op if no recorder is alive.
  for (const fn of _resumeListeners) { try { fn(); } catch {} }
  // Also trigger an offline-queue replay sweep in case offline voice
  // actions are still queued. The host already calls replayOfflineQueue
  // on net change but this is a belt-and-suspenders for the WS-only
  // reconnect case (TCP up but WS just flapped).
  if (isOnline()) {
    try {
      const api = require('./api');
      const oc = require('./offlineCache');
      oc.replayOfflineQueue?.(api).catch(() => {});
    } catch {}
  }
}
