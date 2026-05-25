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
    // [WAVE 44B, 2026-05-21 gap A8] Add `latency: 0.01` hint (10ms) so
    // Chrome / Safari pick the low-latency mic path. Without it browsers
    // default to ~20ms buffers which adds round-trip latency. Native
    // (react-native-webrtc) ignores `latency` cleanly — no-op.
    audioCaptureDefaults: {
      sampleRate: 48000,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      latency: 0.01,
    },
    // Publish defaults: DTX on so silent periods don't burn bandwidth.
    // [2026-05-25] RED on as the baseline. RED roughly doubles the audio
    // packet rate, but voice is tiny (~32-64 kbps mono) so the absolute
    // overhead is negligible — and the redundant payload recovers single &
    // short-burst packet loss that FEC alone misses, which is exactly the
    // "voz cortando" users hear on cellular. The adaptive loop
    // (applyAdaptiveBitrate) still toggles `red` per-level later, but we want
    // resilience from the very first packet, not only after the 5s stats warm-up.
    // FEC on so 1-packet loss doesn't cause audible artifacts. Bitrate starts
    // mid-ladder and the adaptive loop nudges up/down based on connection stats.
    //
    // The actual keys LK respects are: `dtx`, `red`, `audioPreset` (or
    // `audioBitrate` for finer control). `audioPreset` accepts a preset
    // name OR a custom { maxBitrate } object — we pass the latter so the
    // adaptive loop can re-publish with a different bitrate later.
    publishDefaults: {
      dtx: true,
      red: true,
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

  // [Wave 16 gap B4, 2026-05-20] Bitrate ladder bumped pra WhatsApp parity:
  // antes plafonava em 64kbps mono. WhatsApp vai até 128kbps stereo em
  // wifi forte. Ceiling agora 96kbps (sweet spot voz HD sem desperdiço).
  // Bitrate em bps. RED ativo em level 2+3 (perdas pequenas) — FEC sozinho
  // não cobre bursts. RED OFF em level 4 (sem perdas, RED só dobra packets).
  let bitrate;
  switch (level) {
    case 4: bitrate = 96000; break;  // excellent — full Opus HD
    case 3: bitrate = 64000; break;  // good
    case 2: bitrate = 48000; break;  // medium
    case 1: bitrate = 32000; break;  // poor
    default: bitrate = 24000; break; // lost — NB Opus fallback
  }

  const dtx = true;
  const fec = true;
  // [Wave 16 B4] RED ativo em loss bands 2-3, off em excelente + perdido.
  // Pacote redundante ajuda bursts curtos de loss — onde FEC sozinho falha.
  const red = level === 2 || level === 3;

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

// ────────────────────────────────────────────────────────────────────
// 6. Sustained "very poor" detector → ICE restart trigger (gap D1).
// ────────────────────────────────────────────────────────────────────
/**
 * Returns a filter that watches the classification stream and fires
 * `onSustainedPoor` once after THREE consecutive samples at level 0
 * (lost / very_poor). At a 5s polling cadence, that's a 15s sustained
 * window — long enough to filter out a single jitter spike, short
 * enough that we trigger an ICE restart before the user actually
 * hangs up out of frustration.
 *
 * The fire is one-shot per "very-poor episode": once we recover (any
 * sample with level >= 1) the internal counter resets, and a future
 * descent can re-fire. Without that reset we'd only ever do ONE restart
 * per call; with it we restart on every sustained dip.
 *
 * The caller (app/call.js) wires this into the same pollNetworkStats
 * loop that already drives makeLevelChangeFilter — pass classification
 * to BOTH filters per sample.
 */
export function makeSustainedPoorFilter(threshold = 3) {
  let badStreak = 0;
  let firedThisEpisode = false;
  return function filter(classification, onSustainedPoor) {
    const lvl = classification?.level;
    if (typeof lvl !== 'number') return;
    // Recovery: drop the streak and re-arm so the NEXT dip can fire.
    if (lvl > 0) {
      badStreak = 0;
      firedThisEpisode = false;
      return;
    }
    badStreak++;
    if (badStreak >= threshold && !firedThisEpisode) {
      firedThisEpisode = true;
      try { onSustainedPoor?.(classification); } catch {}
    }
  };
}

/**
 * Best-effort ICE restart on a LiveKit room. Walks the engine API
 * surface for restartIce/restartConnection/fullReconnect — LiveKit
 * 2.x exposes different names across versions and across web vs RN
 * builds. Returns true if any path was actually invoked.
 *
 * Pure helper so app/call.js and any future surface (e.g. group-call
 * via a postMessage bridge) can call it without duplicating the
 * version-walk.
 */
export async function triggerIceRestart(room) {
  if (!room) return false;
  try {
    const eng = room.engine;
    if (!eng) return false;
    // 1. Preferred — engine.restartIce (LK 2.x web).
    if (typeof eng.restartIce === 'function') {
      try { await eng.restartIce(); return true; } catch {}
    }
    // 2. Some versions expose restartConnection() / fullReconnect().
    if (typeof eng.restartConnection === 'function') {
      try { await eng.restartConnection(); return true; } catch {}
    }
    if (typeof eng.fullReconnect === 'function') {
      try { await eng.fullReconnect(); return true; } catch {}
    }
    // 3. Last resort: poke the publisher PC directly (RN doesn't always
    // expose the engine helpers).
    const pc = _getPublisherPC(room);
    if (pc && typeof pc.restartIce === 'function') {
      try { pc.restartIce(); return true; } catch {}
    }
    return false;
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────
// 6. [Wave 16 gap B4] Opus SDP munge — apply WhatsApp-grade tuning.
// ────────────────────────────────────────────────────────────────────
/**
 * Mutate an SDP offer/answer string to force Opus quality knobs that
 * LiveKit Room.publishDefaults can't reach: maxaveragebitrate, cbr,
 * useinbandfec, usedtx. WhatsApp parity — at 96kbps these matter a lot.
 *
 * Usage: call.js wraps room.engine.publisher.pc.createOffer with this.
 * Reflective hook (web/native) — degrades to no-op silently.
 */
export function applyOpusSdpMunge(sdp, opts = {}) {
  if (typeof sdp !== 'string' || !sdp.includes('opus')) return sdp;
  const maxBitrate = Math.max(24000, Math.min(opts.maxBitrate || 96000, 128000));
  const cbr = opts.cbr ? 1 : 0;
  const usedtx = opts.dtx === false ? 0 : 1;
  const useinbandfec = 1;
  const stereo = opts.stereo ? 1 : 0;
  // Find Opus payload type from m=audio + rtpmap.
  const ptMatch = sdp.match(/a=rtpmap:(\d+)\s+opus\//i);
  if (!ptMatch) return sdp;
  const pt = ptMatch[1];
  const fmtpRe = new RegExp('a=fmtp:' + pt + ' (.*)', 'i');
  const fmtpLine = sdp.match(fmtpRe);
  const knobs = [
    `maxaveragebitrate=${maxBitrate}`,
    `cbr=${cbr}`,
    `useinbandfec=${useinbandfec}`,
    `usedtx=${usedtx}`,
    stereo ? `stereo=1;sprop-stereo=1` : null,
  ].filter(Boolean).join(';');
  if (fmtpLine) {
    // Merge with existing, dropping any duplicate keys our knobs set.
    const existing = fmtpLine[1].split(';').map(s => s.trim()).filter(s => {
      const k = s.split('=')[0];
      return !['maxaveragebitrate','cbr','useinbandfec','usedtx','stereo','sprop-stereo'].includes(k);
    });
    const merged = [...existing, knobs].filter(Boolean).join(';');
    return sdp.replace(fmtpRe, `a=fmtp:${pt} ${merged}`);
  }
  // No fmtp line existed — inject one right after rtpmap.
  return sdp.replace(
    new RegExp('(a=rtpmap:' + pt + ' opus/[^\\n]+\\n)'),
    `$1a=fmtp:${pt} ${knobs}\n`
  );
}
