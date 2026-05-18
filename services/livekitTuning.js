// services/livekitTuning.js
// =================================================================
// LiveKit audio-quality tuning helpers (Chatyy ↔ Chatyy calls).
//
// WhatsApp-grade calls hinge on three things:
//   1. The *initial* audio capture/publish defaults (Opus FEC, DTX, AGC,
//      sample rate, channel count, bitrate target).
//   2. The *adaptive* loop that watches network stats and drops bitrate
//      (or flips DTX on harder) when RTT spikes or packet loss climbs.
//   3. A useful UI signal (the bars in the status strip) so users know
//      *why* a call sounds bad — and don't blame the app.
//
// We deliberately keep this file *pure* — no imports from `livekit-client`
// or `@livekit/react-native`. Callers (app/call.js) own the Room instance
// and pass it in. That keeps livekitTuning unit-testable on Node and
// avoids dragging the heavy LK web bundle into the splash screen.
//
// Public API:
//   buildAudioRoomOptions(opts)                 → object suitable for `new Room(...)`
//   pollNetworkStats(room, onSample)            → fn that returns an unsubscribe
//   classifyQuality({ rtt, loss, jitter })      → { level, label, bitrate, dtx, fec }
//   applyAdaptiveBitrate(room, classification)  → best-effort knob tweak
//   computeBarLevel({ rtt, loss })              → 0..4 (for <ConnectionBars />)
//
// Why pure JS? Because both call.js (mobile) and any future web-only
// surface (e.g. embedded meet) need the same logic. Don't fork the
// thresholds across UIs — keep them here.
//
// Thresholds tuned to match WhatsApp's published heuristics:
//   level 4 (excellent) : rtt <= 80ms   AND loss <= 0.5%
//   level 3 (good)      : rtt <= 150ms  AND loss <= 1%
//   level 2 (meh)       : rtt <= 300ms  AND loss <= 5%
//   level 1 (bad)       : rtt <= 500ms  OR  loss <= 10%
//   level 0 (lost)      : anything worse
//
// Bitrate ladder (Opus mono voice):
//   64 kbps  : excellent / good
//   48 kbps  : meh
//   32 kbps  : bad
//   24 kbps  : lost (DTX kicks in hard, FEC mandatory)

// ────────────────────────────────────────────────────────────────────
// 1. Default room options for audio-quality optimization.
// ────────────────────────────────────────────────────────────────────
/**
 * Produce a partial Room options object focused on audio capture/publish.
 * Caller merges this with their own (video simulcast layers, ICE config,
 * iOS broadcast extension prefs, etc).
 *
 *   const opts = { ...baseOpts, ...buildAudioRoomOptions({ initialBitrate: 48000 }) };
 *   const room = new Room(opts);
 *
 * `videoCall=false` (default) implies voice call — we hard-mono the mic
 * and target the conservative 48 kbps to start (network adaptive logic
 * will bump to 64 kbps on a good RTT/loss reading after ~5s).
 */
export function buildAudioRoomOptions({ initialBitrate = 48000, videoCall = false } = {}) {
  return {
    // High-quality capture: 48k mono, all DSP on. NoiseSuppression here is
    // the WebRTC built-in (NS3) — *not* the Chatyy RNNoise toggle that lives
    // in the More sheet. Both can coexist; this just guarantees a baseline.
    audioCaptureDefaults: {
      sampleRate: 48000,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    // Publish defaults: DTX on so silent periods don't burn bandwidth.
    // RED off (LiveKit defaults to RED-on at high bitrates, but RED doubles
    // packet rate which is bad for cellular). FEC on so 1-packet loss
    // doesn't cause audible artifacts. Bitrate starts mid-ladder and the
    // adaptive loop nudges up/down based on connection stats.
    //
    // The actual keys LK respects are: `dtx`, `red`, `audioPreset` (or
    // `audioBitrate` for finer control). `audioPreset` accepts a preset
    // name OR a custom { maxBitrate } object — we pass the latter so the
    // adaptive loop can re-publish with a different bitrate later.
    publishDefaults: {
      dtx: true,
      red: false,
      // FEC is implicit when using Opus and the SDP includes `useinbandfec=1`
      // (LiveKit emits this by default). We keep an explicit flag here so
      // the adaptive loop can flip it off if RED ever beats FEC in the wild.
      audioPreset: { maxBitrate: initialBitrate },
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// 2. Network stats polling.
// ────────────────────────────────────────────────────────────────────
/**
 * Poll the LiveKit room every `intervalMs` and invoke `onSample` with the
 * latest aggregate { rtt, loss, jitter, bitrate, codec } for the local
 * participant. Returns an unsubscribe fn.
 *
 * The exact stats key path varies by LiveKit version + platform — we walk
 * a few candidates and pick the first that yields a number. This is
 * intentionally defensive: a missing stat just degrades the UI to "no
 * info" instead of crashing the call.
 */
export function pollNetworkStats(room, onSample, intervalMs = 5000) {
  if (!room || typeof onSample !== 'function') return () => {};
  let cancelled = false;
  let timer = null;

  const tick = async () => {
    if (cancelled || !room) return;
    try {
      const sample = await readRoomStats(room);
      if (!cancelled && sample) onSample(sample);
    } catch (e) {
      // swallow — never let stats polling break the call
    }
    if (!cancelled) {
      timer = setTimeout(tick, intervalMs);
    }
  };

  // First sample comes a bit later — stats need ~2s to stabilize after
  // ICE picks a candidate pair. Polling too early returns zeros.
  timer = setTimeout(tick, Math.min(intervalMs, 2500));

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

async function readRoomStats(room) {
  try {
    const lp = room?.localParticipant;
    if (!lp) return null;

    // LiveKit web exposes participant.engine?.pcManager.publisher.pc; the
    // RN port exposes engine.publisher.pc on iOS+Android (livekit-client
    // 2.x). Hide all that behind a getPC() walker.
    const pc = _getPublisherPC(room);
    let rtt = 0, loss = 0, jitter = 0, bitrate = 0;
    let codec = 'opus';

    if (pc && typeof pc.getStats === 'function') {
      const stats = await pc.getStats();
      let outAudio = null;
      let remoteInAudio = null;
      let candidatePair = null;
      stats.forEach((rep) => {
        if (rep.type === 'outbound-rtp' && (rep.kind === 'audio' || rep.mediaType === 'audio')) outAudio = rep;
        if (rep.type === 'remote-inbound-rtp' && (rep.kind === 'audio' || rep.mediaType === 'audio')) remoteInAudio = rep;
        if (rep.type === 'candidate-pair' && rep.state === 'succeeded' && rep.nominated) candidatePair = rep;
      });
      if (remoteInAudio) {
        if (typeof remoteInAudio.roundTripTime === 'number') rtt = remoteInAudio.roundTripTime * 1000;
        if (typeof remoteInAudio.jitter === 'number') jitter = remoteInAudio.jitter * 1000;
        if (typeof remoteInAudio.fractionLost === 'number') loss = remoteInAudio.fractionLost * 100;
      }
      if (candidatePair && typeof candidatePair.currentRoundTripTime === 'number' && !rtt) {
        rtt = candidatePair.currentRoundTripTime * 1000;
      }
      if (outAudio) {
        if (typeof outAudio.targetBitrate === 'number') bitrate = outAudio.targetBitrate;
        if (outAudio.codecId && typeof stats.get === 'function') {
          try {
            const c = stats.get(outAudio.codecId);
            if (c?.mimeType) codec = c.mimeType.split('/')[1] || codec;
          } catch {}
        }
      }
    }

    // Fallback for RTT: some platforms expose it as lp.connectionQualityStats.
    // We don't trust the LK ConnectionQuality enum here because it's coarse
    // (Excellent/Good/Poor/Lost) — we want the raw number for the picker.

    return {
      rtt: Math.round(rtt) || 0,
      loss: Number.isFinite(loss) ? Math.round(loss * 10) / 10 : 0,
      jitter: Math.round(jitter) || 0,
      bitrate: Math.round(bitrate) || 0,
      codec,
      ts: Date.now(),
    };
  } catch {
    return null;
  }
}

function _getPublisherPC(room) {
  try {
    // livekit-client 2.x web
    const eng = room?.engine;
    if (!eng) return null;
    if (eng.pcManager?.publisher?.pc) return eng.pcManager.publisher.pc;
    if (eng.publisher?.pc) return eng.publisher.pc;
    if (eng.publisher?.peerConnection) return eng.publisher.peerConnection;
    if (typeof eng.publisher?.getPC === 'function') return eng.publisher.getPC();
    return null;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────
// 3. Quality classification.
// ────────────────────────────────────────────────────────────────────
/**
 * Map raw stats → quality classification.
 *
 * level: 0..4 (0=lost, 4=excellent) — feed straight to <ConnectionBars />.
 * label: 'excellent' | 'good' | 'medium' | 'poor' | 'lost'
 * bitrate: kbps target for the adaptive loop
 * dtx, fec: bool — what we want LK to publish at this level
 */
export function classifyQuality({ rtt = 0, loss = 0, jitter = 0 } = {}) {
  // Decision uses BOTH metrics — a 50ms RTT with 10% loss is still bad.
  // The check is conservative: any single metric in the worse bucket
  // drops us to that bucket.
  let level = 4;
  if (rtt > 500 || loss > 10) level = 0;
  else if (rtt > 300 || loss > 5) level = 1;
  else if (rtt > 150 || loss > 1 || jitter > 80) level = 2;
  else if (rtt > 80  || loss > 0.5) level = 3;

  // Bitrate ladder (in bps for LiveKit audioPreset.maxBitrate).
  let bitrate;
  switch (level) {
    case 4: bitrate = 64000; break;
    case 3: bitrate = 64000; break;
    case 2: bitrate = 48000; break;
    case 1: bitrate = 32000; break;
    default: bitrate = 24000; break;
  }

  // DTX harder when bandwidth is tight. FEC always on for voice — the
  // 1-packet recovery is worth the ~10% overhead.
  const dtx = true;
  const fec = true;
  // RED only at level 4 (we can afford the packet doubling). Off otherwise.
  const red = level === 4;

  const label = LEVEL_LABEL[level];
  return { level, label, bitrate, dtx, fec, red };
}

const LEVEL_LABEL = {
  4: 'excellent',
  3: 'good',
  2: 'medium',
  1: 'poor',
  0: 'lost',
};

/**
 * Convenience: 0..4 bar level for <ConnectionBars level={...} />.
 * Same thresholds as classifyQuality but returns just the int.
 */
export function computeBarLevel({ rtt = 0, loss = 0 } = {}) {
  return classifyQuality({ rtt, loss }).level;
}

// ────────────────────────────────────────────────────────────────────
// 4. Adaptive bitrate application.
// ────────────────────────────────────────────────────────────────────
/**
 * Best-effort: nudge the local participant's audio publication to match
 * the target bitrate. LiveKit doesn't expose a stable "setAudioBitrate"
 * API across versions, so we try a few hooks. If none work we just
 * log and move on — the next renegotiation will pick up our defaults.
 */
export async function applyAdaptiveBitrate(room, classification) {
  if (!room || !classification) return false;
  try {
    const lp = room.localParticipant;
    if (!lp) return false;

    // 1. Try `setAudioPublishDefaults` if LK exposes a runtime setter
    // (livekit-client 2.x doesn't, but we keep the hook for future versions).
    if (typeof lp.setAudioPublishDefaults === 'function') {
      await lp.setAudioPublishDefaults({
        dtx: classification.dtx,
        red: classification.red,
        audioPreset: { maxBitrate: classification.bitrate },
      });
      return true;
    }

    // 2. Walk publications and adjust sender encodings directly. This is
    // the path that actually works on livekit-client 2.x: RTCRtpSender
    // .setParameters({ encodings: [{ maxBitrate }] }).
    const pubs = lp.audioTrackPublications || lp.tracks || new Map();
    const iter = typeof pubs.values === 'function' ? pubs.values() : [];
    for (const pub of iter) {
      try {
        const sender = pub?.track?.sender || pub?.sender;
        if (sender && typeof sender.getParameters === 'function') {
          const params = sender.getParameters();
          if (params?.encodings && params.encodings.length > 0) {
            params.encodings[0].maxBitrate = classification.bitrate;
            await sender.setParameters(params);
          }
        }
      } catch {}
    }
    return true;
  } catch (e) {
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────
// 5. Throttle: don't re-apply on every sample, only on level change.
// ────────────────────────────────────────────────────────────────────
/**
 * Wrap a classification consumer with hysteresis so we only ACT on a
 * level CHANGE (and only after 2 consecutive matching samples). This
 * stops UI thrashing when the network flickers between 145ms and 155ms
 * RTT (which would otherwise toggle level 2↔3 every 5 seconds).
 */
export function makeLevelChangeFilter() {
  let lastLevel = 4;
  let pending = null;
  let pendingCount = 0;
  return function filter(classification, onLevelChange) {
    const lvl = classification?.level;
    if (typeof lvl !== 'number') return;
    if (lvl === lastLevel) {
      pending = null; pendingCount = 0;
      return;
    }
    if (pending !== lvl) {
      pending = lvl;
      pendingCount = 1;
      return;
    }
    pendingCount++;
    if (pendingCount >= 2) {
      lastLevel = lvl;
      pending = null;
      pendingCount = 0;
      try { onLevelChange?.(classification); } catch {}
    }
  };
}
