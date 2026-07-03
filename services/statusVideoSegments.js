// services/statusVideoSegments.js
//
// Long-video status segmentation (WhatsApp parity). A status video longer than
// one 30s segment is posted as multiple back-to-back status clips. The heavy
// lifting (sample-copy remux, NO re-encode) is in the native expo-native-video
// module (Android MediaExtractor+MediaMuxer / iOS AVAssetExportSession
// passthrough time-ranges). This helper turns a single video file object into
// an ordered array of file objects to upload + publish in sequence.
//
// Fully fail-safe: on web, with a missing/older native module, or on ANY error,
// it returns the original single file so the user's post is NEVER lost (falls
// back to today's single-clip behavior).

import { Platform } from 'react-native';

export const STATUS_SEGMENT_MS = 30000;

export async function segmentVideoForStatus(file, segmentMs = STATUS_SEGMENT_MS) {
  if (Platform.OS === 'web' || !file?.uri) return [file];
  try {
    const nv = require('../modules/expo-native-video');
    if (!nv?.isAvailable?.() || typeof nv.segmentVideo !== 'function') return [file];
    const res = await nv.segmentVideo(file.uri, segmentMs);
    if (!res?.segmented || !Array.isArray(res.segments) || res.segments.length <= 1) return [file];
    const baseName = (file.name || 'status.mp4').replace(/\.(mp4|mov|m4v|webm)$/i, '');
    return res.segments
      .filter(s => s && s.uri)
      .map((s, i) => ({ uri: s.uri, name: `${baseName}_part${i + 1}.mp4`, type: 'video/mp4' }));
  } catch (e) {
    console.warn('[status] segment failed, posting single video:', e?.message);
    return [file];
  }
}
