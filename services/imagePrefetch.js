// imagePrefetch.js — background prefetch of chat photos + avatars.
//
// Two scopes:
//   1. prefetchTopConversationsPhotos(convs, opts) — on chat list mount, walk
//      the top N conversations (by recency) and pull the last K image
//      messages so they're on disk before the user taps in. Honors the
//      cellular gate (cacheMedia()'s internal _shouldAutoDownload check),
//      caps concurrency at 3, and aborts as soon as `cancelPrefetch()` is
//      called (the screen unmounted / user navigated away).
//
//   2. prefetchAvatars(emails) — opportunistic /get_avatar warm-up for the
//      top 20 contacts on chat list mount. Avatars change rarely, so once
//      cached they stay cached "indefinitely" — i.e. they ride the same
//      500MB LRU but never get tagged into a conversation, so they're the
//      first thing evicted under pressure (acceptable: easy to re-fetch).
//
// WhatsApp parity: small prefetch pool, no UI blocking, abort on navigate.
// This module is import-safe on web (all calls no-op) and on cold start.

import { Platform } from 'react-native';
import { cacheMedia, tagUrlConversation } from './mediaCache';

// One concurrent prefetch run at a time. If `prefetchTopConversationsPhotos`
// is called again (e.g. cache refresh triggers a re-render), the previous
// run's `abortToken` flips → its in-flight loop exits before kicking off
// new downloads. Already-started downloads on the underlying cacheMedia
// throttle continue and are deduped by syncIndex, so the abort is purely
// about NOT enqueuing more.
let _activeToken = null;

export function cancelPrefetch() {
  if (_activeToken) {
    _activeToken.cancelled = true;
    _activeToken = null;
  }
}

function _api() {
  try { return require('./api'); } catch { return null; }
}

// Pull image URLs from cached messages of a conversation. Reads SQLite /
// IndexedDB / MMKV via chatCache.getCachedMessages — does NOT hit the
// network. Last K messages, filtered to type==='image' and file_url set.
async function _imageUrlsForConv(convId, k) {
  try {
    const { getCachedMessages } = require('./chatCache');
    const msgs = await getCachedMessages(convId, Math.max(k * 3, 30));
    if (!Array.isArray(msgs) || msgs.length === 0) return [];
    const out = [];
    // Reverse — last messages first (cached order is ascending by id).
    for (let i = msgs.length - 1; i >= 0 && out.length < k; i--) {
      const m = msgs[i];
      if (!m || m.type !== 'image' || !m.file_url) continue;
      const url = m.file_url.startsWith('http') ? m.file_url : `https://chatyy.com.br${m.file_url}`;
      out.push(url);
    }
    return out;
  } catch { return []; }
}

// Background prefetch: top N conversations × last K images. Fire-and-forget.
// Returns a Promise that resolves when the run finishes or is aborted —
// callers typically don't await but it's there for tests.
//
// Defaults (WhatsApp-ish): top 5 convs × last 5 photos = 25 candidate URLs.
// The cacheMedia throttle keeps concurrency ≤ 3 across the run, so a typical
// run completes in 5-15s on Wi-Fi. Items already cached are skipped instantly
// via syncIndex inside cacheMedia.
export function prefetchTopConversationsPhotos(conversations, opts = {}) {
  if (Platform.OS === 'web') return Promise.resolve();
  if (!Array.isArray(conversations) || conversations.length === 0) return Promise.resolve();

  // Cancel any prior in-flight run (e.g. chat list re-rendered with fresh data).
  cancelPrefetch();
  const token = { cancelled: false };
  _activeToken = token;

  const topN = opts.topN || 5;
  const perConv = opts.perConv || 5;

  // Sort by recency so we prefetch what the user is most likely to scroll
  // back to. Re-uses the same comparator the chat list does.
  const sorted = [...conversations].sort((a, b) => {
    const ta = new Date(b?.last_message_at || b?.updated_at || 0).getTime();
    const tb = new Date(a?.last_message_at || a?.updated_at || 0).getTime();
    return ta - tb;
  }).slice(0, topN);

  return (async () => {
    for (const conv of sorted) {
      if (token.cancelled) return;
      if (!conv || conv.id == null) continue;
      const urls = await _imageUrlsForConv(conv.id, perConv);
      for (const url of urls) {
        if (token.cancelled) return;
        try {
          // conversationId tag → file is protected if user marks the conv
          // Keep-Always. cacheMedia returns immediately on cache hit.
          cacheMedia(url, { conversationId: conv.id }).catch(() => {});
        } catch {}
      }
    }
  })();
}

// ── Avatar prefetch ──────────────────────────────────────────────────────
// Top 20 contacts → fire-and-forget /get_avatar fetch through cacheMedia.
// Avatars are tiny (~5-30 KB) and rarely change; pre-caching them on chat
// list mount means the AvatarCircle for every visible row paints with zero
// flicker on the next cold start.
let _avatarPrefetchInflight = new Set();

export function prefetchAvatars(emails) {
  if (Platform.OS === 'web') return;
  if (!Array.isArray(emails) || emails.length === 0) return;
  const api = _api();
  if (!api || typeof api.getAvatarUrlForEmail !== 'function') return;

  const seen = new Set();
  let count = 0;
  for (const raw of emails) {
    if (count >= 20) break;
    if (!raw || typeof raw !== 'string') continue;
    const email = raw.trim().toLowerCase();
    if (!email || seen.has(email) || _avatarPrefetchInflight.has(email)) continue;
    seen.add(email);
    _avatarPrefetchInflight.add(email);
    count++;
    let url = null;
    try { url = api.getAvatarUrlForEmail(email); } catch {}
    if (!url) { _avatarPrefetchInflight.delete(email); continue; }
    // force:true — avatars are tiny enough that the cellular gate would
    // be over-conservative. Same call shape AvatarCircle uses internally.
    try {
      cacheMedia(url, { force: true })
        .catch(() => {})
        .finally(() => { _avatarPrefetchInflight.delete(email); });
    } catch { _avatarPrefetchInflight.delete(email); }
  }
}

// Convenience: derive `emails` from a list of conversation rows and call
// `prefetchAvatars`. Used by the chat list onMount hook so callers don't
// have to know how the conv struct nests the peer email.
export function prefetchAvatarsFromConversations(conversations) {
  if (!Array.isArray(conversations) || conversations.length === 0) return;
  const emails = [];
  for (const c of conversations) {
    if (!c) continue;
    // Best-effort field probing — mirror the same fallback chain ChatListTab
    // uses (other_email → peer → members[0]).
    const candidate =
      c.other_email ||
      c.peer ||
      c.peer_email ||
      (Array.isArray(c.members) && c.members[0]?.email) ||
      null;
    if (typeof candidate === 'string') emails.push(candidate);
    if (emails.length >= 20) break;
  }
  prefetchAvatars(emails);
}
