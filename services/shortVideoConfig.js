// shortVideoConfig.js — feature flag + tuning for in-chat short videos.
//
// Reels-style 15-30s clips embedded as a special chat bubble (subtype
// `short_video`). Aggressively compressed (480p / 800 kbps) so they stay
// lightweight vs the regular chat video (`type=video`, 720p / 2 Mbps).
//
// FEATURE FLAG — keep OFF until:
//   1. Backend whitelists `short_video` in the chat_messages type enum
//      (see api/chat.php:3806 — currently only allows text/image/file/
//      system/gif/sticker/audio/video/location/contact/video_note/lottie_sticker).
//      → Add 'short_video' to that allow-list AND to $skipScanTypes
//      (line 3855) so the body-scan regex doesn't trip on JSON meta.
//   2. ShortVideoBubble has been QAed in dual-emul (5554 ↔ 5556) with
//      autoplay-muted-loop + tap-to-expand confirmed on Android + iOS.
//   3. ShareToReelsCTA wired to existing reels_publish endpoint.
//
// Toggle for dev: `globalThis.__chatyy_short_video_in_chat = true;`
// (matches the envelope-mode pattern in api.js around line 2615).

/**
 * Master feature flag. When false, AttachmentMenuShortVideo returns null and
 * ShortVideoBubble downgrades to the regular video renderer so existing
 * `type=video` rows aren't affected.
 */
export const featureShortVideoInChat = false;

/**
 * Returns true when the runtime flag override is on OR the build-time
 * `featureShortVideoInChat` is true. Lets QA flip it at runtime via the
 * dev console without a rebuild.
 */
export function isShortVideoInChatEnabled() {
  if (featureShortVideoInChat) return true;
  try {
    if (typeof globalThis !== 'undefined' && globalThis.__chatyy_short_video_in_chat === true) {
      return true;
    }
  } catch {}
  return false;
}

// ── Recording / encoding tuning ──────────────────────────────────────────
// These are the values the in-chat recorder (services/shortVideoRecord.js)
// hands to the camera + transcoder. Tuned for "lightweight clip", NOT
// "reels feed quality" — Reels recorder uses 720p / 2.5 Mbps (see
// components/ReelsRecorder.js).
export const SHORT_VIDEO_TUNING = Object.freeze({
  // WhatsApp Reels-in-chat caps at 30s. iMessage 15s. We pick 30 so the
  // user can react with a slightly longer clip but still trim is enforced.
  MAX_DURATION_SEC: 30,
  MIN_DURATION_SEC: 1,
  // 9:16 portrait — bubble renders at this aspect, fullscreen viewer too.
  ASPECT_RATIO: 9 / 16,
  // 480 × 854 ≈ 480p portrait. Roughly 1/3 the pixel count of 720p so the
  // encode finishes in ~half the time on mid-range Android (Snap 6xx).
  TARGET_WIDTH: 480,
  TARGET_HEIGHT: 854,
  // 800 kbps video + 64 kbps audio ≈ 108 KB/s → 30s clip ≈ 3.2 MB. Fits
  // the Rust chunked upload comfortably and decodes on 3G.
  VIDEO_BITRATE_KBPS: 800,
  AUDIO_BITRATE_KBPS: 64,
  // 30 fps capped — recorder asks the camera for 30 even on devices that
  // can do 60, because doubling fps doubles bitrate need.
  TARGET_FPS: 30,
  // mp4 container — universal playback on ExoPlayer + AVPlayer + HTML5.
  CONTAINER: 'mp4',
  // Codec hint. Native side picks h264 (universal) over hevc (smaller but
  // patchy on older Android + web Safari).
  CODEC: 'h264',
});

/**
 * Message subtype constant. Reused by:
 *   - shortVideoRecord.send()         → passes as `type` to chatSend()
 *   - ShortVideoBubble                → switches rendering when bubble.type
 *                                       === SHORT_VIDEO_TYPE
 *   - chat-list preview generator     → renders the Reels-style icon
 *
 * NOTE: backend currently rejects this string (see TODO at top of file).
 * Until backend lands, chatSend with type='short_video' is downgraded to
 * type='video' by chat.php line 3812 (falls through to default 'text', then
 * gets bumped back to 'video' by the file_url ext sniffer at line 3831).
 * That means the bubble degrades gracefully — it plays as a normal video.
 */
export const SHORT_VIDEO_TYPE = 'short_video';

/**
 * Extra meta keys the bubble looks for on the message row. The recorder
 * stuffs these into the JSON `meta` column (already supported by the
 * backend — same column status_create + reels use).
 */
export const SHORT_VIDEO_META_KEYS = Object.freeze({
  DURATION_MS: 'short_duration_ms',
  WIDTH: 'short_w',
  HEIGHT: 'short_h',
  // Optional music overlay (mirrors statusPublish musicData shape).
  MUSIC_TITLE: 'music_title',
  MUSIC_ARTIST: 'music_artist',
  MUSIC_PREVIEW_URL: 'music_preview_url',
  MUSIC_COVER_URL: 'music_cover_url',
  // Server stamps this when the bubble was *also* cross-posted to Reels via
  // the "Postar nos Reels também" long-press CTA. Lets the bubble show a
  // "Posted to Reels" subtle indicator.
  REELS_POST_ID: 'reels_post_id',
});

export default {
  featureShortVideoInChat,
  isShortVideoInChatEnabled,
  SHORT_VIDEO_TUNING,
  SHORT_VIDEO_TYPE,
  SHORT_VIDEO_META_KEYS,
};
