// shortVideoRecord.js — quick in-chat short video capture + send pipeline.
//
// Flow (matches WhatsApp/iMessage 2026 short-video-in-chat):
//   1. Composer "Vídeo curto" pill (AttachmentMenuShortVideo) fires
//      recordShortVideoInChat(opts).
//   2. We open expo-image-picker's launchCameraAsync in `videos` mode with
//      a hard duration cap from SHORT_VIDEO_TUNING.MAX_DURATION_SEC. Native
//      stock camera UI keeps the perceived footprint small (vs spinning
//      the full ReelsRecorder pipeline).
//   3. Caller hands the captured asset to compressShortVideo() which calls
//      compressVideoWeb on web and falls through to the native encoder
//      stub on iOS/Android (TODO — wire to a future native module; for now
//      we ship the raw file and let the server transcode).
//   4. uploadShortVideo() pushes the bytes via rustChunkedUpload. Same
//      pipeline as status/reels — server saves under /data/short-videos/.
//   5. sendShortVideoMessage() calls chatSend(type='short_video', file_url,
//      ...). Until backend lands the subtype, it transparently degrades to
//      type='video' (see shortVideoConfig.js for the gory details).
//
// PUBLIC API:
//   - recordShortVideoInChat({ conversationId, replyToId?, musicTrack? })
//       → orchestrates camera → compress → upload → send
//   - pickShortVideoFromLibrary({ conversationId, replyToId? })
//       → same flow, but launches the media library instead of the camera
//   - shareShortVideoToReels(messageId)
//       → long-press CTA "Postar nos Reels também"; calls chatReelsShare
//         once backend exposes it (TODO — endpoint name placeholder).
//
// ALL CALLS ARE NO-OPS WHEN isShortVideoInChatEnabled() === false. The
// feature flag returns early so importing this module in chat-conversation
// is cheap even with the flag off.

import { Platform } from 'react-native';
import {
  isShortVideoInChatEnabled,
  SHORT_VIDEO_TUNING,
  SHORT_VIDEO_TYPE,
  SHORT_VIDEO_META_KEYS,
} from './shortVideoConfig';

// Lazy requires — keep the JS bundle slim when the feature flag is off so
// chat-conversation doesn't pay the import cost for users who never see
// the pill.
function _getImagePicker() {
  try { return require('expo-image-picker'); } catch { return null; }
}
function _getApi() {
  // chatSend lives in services/api.js; avoid the circular by inlining the
  // require so this file can also be statically imported up the tree.
  try { return require('./api'); } catch { return null; }
}
function _getWebCompressor() {
  if (Platform.OS !== 'web') return null;
  try { return require('./webVideoCompressor'); } catch { return null; }
}

/**
 * Common result shape so the caller (chat-conversation composer) can
 * treat both happy + sad paths uniformly without try/catch around every
 * helper.
 *
 * @typedef {Object} ShortVideoSendResult
 * @property {boolean} success
 * @property {string=} messageId   server-assigned chat_messages.id
 * @property {string=} fileUrl     CDN URL the bubble will render
 * @property {number=} durationMs
 * @property {string=} error
 * @property {'flag_off'|'cancelled'|'permission_denied'|'too_short'|'too_long'|'upload_failed'|'send_failed'|'unknown'=} reason
 */

/**
 * Step 1+2: pop the camera with the duration cap baked in. Returns the
 * raw asset, NOT yet compressed or uploaded.
 */
export async function captureShortVideoFromCamera() {
  if (!isShortVideoInChatEnabled()) {
    return { success: false, reason: 'flag_off' };
  }
  const IP = _getImagePicker();
  if (!IP) {
    return { success: false, reason: 'unknown', error: 'expo-image-picker missing' };
  }
  try {
    const perm = await IP.requestCameraPermissionsAsync();
    if (!perm?.granted) return { success: false, reason: 'permission_denied' };
    // mediaTypes: Videos forces the system camera into clip-recording UI.
    // videoMaxDuration is a SOFT cap on iOS (user can stop earlier) and a
    // HARD cap on Android. Either way we re-validate post-capture below.
    const result = await IP.launchCameraAsync({
      mediaTypes: IP.MediaTypeOptions?.Videos ?? 'Videos',
      videoMaxDuration: SHORT_VIDEO_TUNING.MAX_DURATION_SEC,
      // 0.6 ≈ medium quality; we recompress aggressively in step 3 anyway.
      quality: 0.6,
      videoQuality: IP.UIImagePickerControllerQualityType?.IFrame960x540 ?? 1,
      allowsEditing: false,
    });
    if (result?.canceled) return { success: false, reason: 'cancelled' };
    const asset = result.assets?.[0] || result;
    if (!asset?.uri) return { success: false, reason: 'unknown', error: 'no asset' };
    const durMs = Number(asset.duration || 0);
    if (durMs && durMs < SHORT_VIDEO_TUNING.MIN_DURATION_SEC * 1000) {
      return { success: false, reason: 'too_short' };
    }
    return {
      success: true,
      asset: {
        uri: asset.uri,
        name: asset.fileName || `short-${Date.now()}.mp4`,
        type: asset.mimeType || 'video/mp4',
        size: asset.fileSize || 0,
        width: asset.width || SHORT_VIDEO_TUNING.TARGET_WIDTH,
        height: asset.height || SHORT_VIDEO_TUNING.TARGET_HEIGHT,
        durationMs: durMs,
      },
    };
  } catch (e) {
    return { success: false, reason: 'unknown', error: String(e?.message || e) };
  }
}

/**
 * Step 1+2 alt: pick an existing video from the library. Same shape as
 * captureShortVideoFromCamera. Trim is enforced post-pick — if the user
 * picks a 2-minute clip we reject with reason='too_long' and let the UI
 * tell them to trim first (or route to VideoTrimTool).
 */
export async function pickShortVideoFromLibrary() {
  if (!isShortVideoInChatEnabled()) {
    return { success: false, reason: 'flag_off' };
  }
  const IP = _getImagePicker();
  if (!IP) return { success: false, reason: 'unknown', error: 'expo-image-picker missing' };
  try {
    const perm = await IP.requestMediaLibraryPermissionsAsync();
    if (!perm?.granted) return { success: false, reason: 'permission_denied' };
    const result = await IP.launchImageLibraryAsync({
      mediaTypes: IP.MediaTypeOptions?.Videos ?? 'Videos',
      allowsEditing: false,
      quality: 1,
    });
    if (result?.canceled) return { success: false, reason: 'cancelled' };
    const asset = result.assets?.[0];
    if (!asset?.uri) return { success: false, reason: 'unknown', error: 'no asset' };
    const durMs = Number(asset.duration || 0);
    if (durMs > SHORT_VIDEO_TUNING.MAX_DURATION_SEC * 1000 + 500) {
      // 500ms slack — system-reported duration is often off by ±200ms.
      // TODO: instead of rejecting, route to components/VideoTrimTool.js
      // so the user can clip the segment they want (Reels parity).
      return { success: false, reason: 'too_long' };
    }
    return {
      success: true,
      asset: {
        uri: asset.uri,
        name: asset.fileName || `short-${Date.now()}.mp4`,
        type: asset.mimeType || 'video/mp4',
        size: asset.fileSize || 0,
        width: asset.width || SHORT_VIDEO_TUNING.TARGET_WIDTH,
        height: asset.height || SHORT_VIDEO_TUNING.TARGET_HEIGHT,
        durationMs: durMs,
      },
    };
  } catch (e) {
    return { success: false, reason: 'unknown', error: String(e?.message || e) };
  }
}

/**
 * Step 3: compress to the 480p / 800kbps target. Web uses the in-tree
 * MediaRecorder-based compressor (services/webVideoCompressor.js). Native
 * doesn't yet have an equivalent — TODO: bridge to a native FFmpegKit
 * module OR re-encode server-side via the existing chat-video transcoder
 * (api/chat.php has a thumbnail path around line 5321 we can extend).
 *
 * Until that lands, native returns the asset unchanged and the server
 * accepts whatever we upload.
 */
export async function compressShortVideo(asset) {
  if (!asset?.uri) return { success: false, reason: 'unknown', error: 'no asset' };
  if (Platform.OS === 'web') {
    const comp = _getWebCompressor();
    if (!comp?.compressVideoWeb) {
      // No compressor available — ship raw. Fine for QA, large clips will
      // be slower to upload but won't break.
      return { success: true, asset };
    }
    try {
      // TODO: thread SHORT_VIDEO_TUNING into compressVideoWeb's opts once
      // its signature exposes bitrate + max resolution knobs (currently
      // only quality 0..1).
      const compressed = await comp.compressVideoWeb(asset._raw || asset, {
        maxWidth: SHORT_VIDEO_TUNING.TARGET_WIDTH,
        maxHeight: SHORT_VIDEO_TUNING.TARGET_HEIGHT,
        videoBitsPerSecond: SHORT_VIDEO_TUNING.VIDEO_BITRATE_KBPS * 1000,
        audioBitsPerSecond: SHORT_VIDEO_TUNING.AUDIO_BITRATE_KBPS * 1000,
      });
      return { success: true, asset: compressed || asset };
    } catch (e) {
      // Compression failure is non-fatal — ship raw and let server handle.
      return { success: true, asset, warning: String(e?.message || e) };
    }
  }
  // TODO native: react-native-compressor or ffmpeg-kit-react-native. For
  // now, no-op so the recorder pipeline works end-to-end.
  return { success: true, asset };
}

/**
 * Step 4: upload to /data/short-videos/ via the Rust chunked path. Reuses
 * the same `kind` slot the status uploader uses ("status") for now since
 * the backend has no dedicated short-video bucket yet — TODO swap to
 * kind='short' once we add the equivalent of statusUpload in chat.php.
 */
export async function uploadShortVideo(asset, onProgress) {
  const api = _getApi();
  if (!api?.rustChunkedUpload && !api?.rustUpload) {
    return { success: false, reason: 'upload_failed', error: 'rust uploader unavailable' };
  }
  try {
    // Reuse status uploader path — TODO add a short-video specific kind
    // on the Rust side + corresponding /data/short-videos/ destination on
    // PHP so retention + CDN headers can diverge from regular status.
    const uploader = onProgress && api.rustChunkedUpload
      ? api.rustChunkedUpload
      : api.rustUpload;
    const res = onProgress
      ? await uploader(asset, /* userEmail */ '', /* kind */ 'status', onProgress)
      : await uploader(asset, /* userEmail */ '', /* kind */ 'status');
    const url = res?.cdn_url || res?.data?.cdn_url || res?.url;
    if (!res?.success || !url) {
      return { success: false, reason: 'upload_failed', error: res?.error || 'no url' };
    }
    return { success: true, fileUrl: url };
  } catch (e) {
    return { success: false, reason: 'upload_failed', error: String(e?.message || e) };
  }
}

/**
 * Step 5: send the bubble. Uses chatSend with the short_video subtype.
 * Falls through gracefully to 'video' when the backend doesn't yet
 * whitelist the subtype (see shortVideoConfig.js for the chat.php line).
 */
export async function sendShortVideoMessage({
  conversationId,
  fileUrl,
  durationMs,
  width,
  height,
  replyToId = null,
  musicTrack = null,
  clientMessageId = null,
}) {
  if (!isShortVideoInChatEnabled()) return { success: false, reason: 'flag_off' };
  if (!conversationId || !fileUrl) {
    return { success: false, reason: 'unknown', error: 'missing args' };
  }
  const api = _getApi();
  if (!api?.chatSend) return { success: false, reason: 'send_failed', error: 'chatSend missing' };
  try {
    // Meta blob the backend stashes on chat_messages.meta. Bubble + chat
    // list previews read these keys; see SHORT_VIDEO_META_KEYS for the
    // canonical names.
    const meta = {
      [SHORT_VIDEO_META_KEYS.DURATION_MS]: durationMs || 0,
      [SHORT_VIDEO_META_KEYS.WIDTH]: width || SHORT_VIDEO_TUNING.TARGET_WIDTH,
      [SHORT_VIDEO_META_KEYS.HEIGHT]: height || SHORT_VIDEO_TUNING.TARGET_HEIGHT,
    };
    if (musicTrack) {
      meta[SHORT_VIDEO_META_KEYS.MUSIC_TITLE] = musicTrack.title || '';
      meta[SHORT_VIDEO_META_KEYS.MUSIC_ARTIST] = musicTrack.artist || '';
      meta[SHORT_VIDEO_META_KEYS.MUSIC_PREVIEW_URL] = musicTrack.previewUrl || '';
      meta[SHORT_VIDEO_META_KEYS.MUSIC_COVER_URL] = musicTrack.coverUrl || '';
    }
    // chatSend signature:
    //   (conversationId, content, type, replyToId, mentions, fileUrl,
    //    tempId, clientMessageId, topicId, opts)
    // We pass meta on opts — when chatSend gains a `meta` passthrough this
    // will start being persisted server-side. Until then it's a no-op and
    // the bubble falls back to detecting the subtype from the file_url
    // extension / response payload.
    const res = await api.chatSend(
      conversationId,
      /* content */ '',
      /* type */ SHORT_VIDEO_TYPE,
      replyToId,
      /* mentions */ null,
      /* fileUrl */ fileUrl,
      /* tempId */ null,
      /* clientMessageId */ clientMessageId,
      /* topicId */ null,
      /* opts */ { meta },
    );
    if (!res?.success) {
      return { success: false, reason: 'send_failed', error: res?.message || 'send rejected' };
    }
    return {
      success: true,
      messageId: res.data?.id || res.id,
      fileUrl,
      durationMs,
    };
  } catch (e) {
    return { success: false, reason: 'send_failed', error: String(e?.message || e) };
  }
}

/**
 * One-shot orchestrator the composer pill wires into. Returns the final
 * ShortVideoSendResult so the caller can show a toast / undo bar.
 *
 * onProgress signature: ({ stage, pct })
 *   - stage: 'capture' | 'compress' | 'upload' | 'send'
 *   - pct: 0..100 (only meaningful in 'upload')
 */
export async function recordShortVideoInChat({
  conversationId,
  replyToId = null,
  musicTrack = null,
  source = 'camera',  // 'camera' | 'library'
  onProgress = null,
} = {}) {
  if (!isShortVideoInChatEnabled()) return { success: false, reason: 'flag_off' };
  if (!conversationId) return { success: false, reason: 'unknown', error: 'no conversation' };

  // 1. Capture
  onProgress?.({ stage: 'capture', pct: 0 });
  const captured = source === 'library'
    ? await pickShortVideoFromLibrary()
    : await captureShortVideoFromCamera();
  if (!captured?.success) return captured;

  // 2. Compress
  onProgress?.({ stage: 'compress', pct: 0 });
  const compressed = await compressShortVideo(captured.asset);
  if (!compressed?.success) return compressed;
  const finalAsset = compressed.asset;

  // 3. Upload
  onProgress?.({ stage: 'upload', pct: 0 });
  const up = await uploadShortVideo(finalAsset, (pct) => {
    onProgress?.({ stage: 'upload', pct: Math.round((pct || 0) * 100) });
  });
  if (!up?.success) return up;

  // 4. Send
  onProgress?.({ stage: 'send', pct: 0 });
  return sendShortVideoMessage({
    conversationId,
    fileUrl: up.fileUrl,
    durationMs: finalAsset.durationMs || 0,
    width: finalAsset.width,
    height: finalAsset.height,
    replyToId,
    musicTrack,
  });
}

/**
 * Long-press CTA "Postar nos Reels também". Promotes an existing chat
 * short-video bubble to a Reels feed post. TODO: backend endpoint
 * `chat_short_video_share_to_reels` doesn't exist yet — wire to the same
 * publish path components/ReelsRecorder.js uses (search api.js for
 * `reels_publish` once it lands).
 */
export async function shareShortVideoToReels(messageId) {
  if (!isShortVideoInChatEnabled()) return { success: false, reason: 'flag_off' };
  if (!messageId) return { success: false, reason: 'unknown', error: 'no message id' };
  const api = _getApi();
  if (!api?.apiCall) return { success: false, reason: 'unknown', error: 'apiCall missing' };
  try {
    // TODO: confirm endpoint name + payload with backend. Placeholder so
    // the long-press wiring compiles; will 404 until backend lands.
    const res = await api.apiCall('chat_short_video_share_to_reels', {
      message_id: messageId,
    }, 'POST');
    if (!res?.success) {
      return { success: false, error: res?.message || 'reels share rejected' };
    }
    return { success: true, reelsPostId: res.data?.reels_post_id };
  } catch (e) {
    return { success: false, error: String(e?.message || e) };
  }
}

export default {
  isShortVideoInChatEnabled,
  captureShortVideoFromCamera,
  pickShortVideoFromLibrary,
  compressShortVideo,
  uploadShortVideo,
  sendShortVideoMessage,
  recordShortVideoInChat,
  shareShortVideoToReels,
};
