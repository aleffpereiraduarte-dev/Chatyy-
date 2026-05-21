// ─── Cloudflare Stream WHIP publisher ────────────────────────────────
//
// Publishes a `MediaStream` (getUserMedia output — camera + mic) to a
// Cloudflare Stream live input via the WHIP protocol (HTTP POST of an
// SDP offer, server replies with an SDP answer). CF Stream returns the
// `webrtc_url` in the `live_start_cf` payload; pass it straight in here.
//
// Why this lives outside live-broadcast.js:
//   - Keeps the publisher reusable for any future surface that wants to
//     push into CF Stream (e.g. cohost-from-second-screen, screen-share).
//   - Easier to mock in tests / dev (no React tree needed).
//
// We rely on the already-bundled `@livekit/react-native-webrtc`
// (`window.RTCPeerConnection` on web). Same dual-path pattern that
// `app/live-broadcast.js` and `app/call.js` already use, so no new
// native dep is introduced — fully OTA-eligible.
//
// CF docs: https://developers.cloudflare.com/stream/webrtc-beta/
//   - POST {webrtc_url}
//   - Content-Type: application/sdp
//   - body: localDescription.sdp (offer)
//   - reply body: SDP answer (200 OK) or 4xx/5xx text on failure.
//
// CF does NOT currently support WHIP trickle ICE, so we wait for ICE
// gathering to complete (or 2s safety timeout) before POSTing.
//
// Returned object exposes a `stop()` that cleanly closes the peer
// connection so live-broadcast can release the publisher on `live_end_cf`.
//
// [WAVE 98 2026-05-21] ROOT CAUSE FIX: CF Stream returned 200 OK on every
// WHIP POST but NO FRAMES ever arrived — every viewer joining a session
// sat on "Conectando..." forever because the HLS playlist had no segments.
// User report 2026-05-21: "abri a live aí tento entrar na live por outro
// celular não abre fica só conectando". CF API confirmed: every recent
// chat_live_sessions row had cf_input_uid set, but
// /accounts/<acct>/stream/live_inputs/<uid>/videos returned `result:[]`
// for every session — proving RTP never reached CF Stream from the host
// device. Three issues all at once:
//   1) `pc.addTrack()` defaults the m= section to `a=sendrecv`. CF Stream
//      WHIP only accepts `a=sendonly` publishers; sendrecv gets answered
//      with `a=inactive` → media never flows. Fix: use
//      `addTransceiver(track, { direction: 'sendonly' })` explicitly.
//   2) No ICE connection state watcher — if ICE failed (NAT-blocked,
//      DTLS timeout, transport stalled), the host had no idea. PC sat in
//      `checking` forever while viewers stared at "Conectando...". Fix:
//      wire `oniceconnectionstatechange` and REJECT the publish promise
//      on `failed` or 20s timeout so the host UI can surface the real
//      error.
//   3) No diagnostics persisted — every previous failure was invisible
//      after the app reloaded. Fix: persist to `chatyy.live_diag` log
//      buffer (read by `app/live-diagnose.js`) so the user/support can
//      see exactly where the publish broke.
import { Platform } from 'react-native';

// Resolve RTCPeerConnection cross-platform — same trick used in
// live-broadcast.js, so behavior stays consistent.
let _PC = null;
if (Platform.OS === 'web') {
  _PC = typeof window !== 'undefined' ? window.RTCPeerConnection : null;
} else {
  try {
    const webrtc = require('@livekit/react-native-webrtc');
    _PC = webrtc.RTCPeerConnection;
  } catch (e) {
    // Native modules missing — caller will see the throw below.
    console.warn('[cfStreamPublisher] @livekit/react-native-webrtc unavailable:', e?.message || e);
  }
}

// ─── Diag log buffer (WAVE 98) ─────────────────────────────────────
// Persisted ring buffer so the user can open /live-diagnose after a
// failed broadcast and SEE what went wrong (instead of staring at
// "Conectando..." with zero feedback). Uses AsyncStorage so it survives
// app restart. Cap @ 100 entries, ~30KB max.
const DIAG_KEY = 'chatyy.live_diag';
const DIAG_MAX = 100;
let _AS = null;
function getAsyncStorage() {
  if (_AS) return _AS;
  try {
    _AS = require('@react-native-async-storage/async-storage').default;
  } catch (e) {
    _AS = null;
  }
  return _AS;
}

export async function liveDiagAppend(level, msg, extra) {
  // Tag everything with a wall-clock timestamp so the screen can render
  // a chronological list. `extra` is optional — typically the small set
  // of SDP/ICE-state strings we want to surface.
  try {
    const AS = getAsyncStorage();
    if (!AS) {
      // Web / dev — still log to console so devs see it during QA.
      console.log('[live-diag]', level, msg, extra || '');
      return;
    }
    const raw = await AS.getItem(DIAG_KEY);
    const list = raw ? JSON.parse(raw) : [];
    list.push({
      ts: Math.floor(Date.now() / 1000),
      level: String(level || 'info'),
      msg: String(msg || '').slice(0, 600),
      extra: extra ? JSON.parse(JSON.stringify(extra)) : undefined,
    });
    if (list.length > DIAG_MAX) list.splice(0, list.length - DIAG_MAX);
    await AS.setItem(DIAG_KEY, JSON.stringify(list));
  } catch (e) {
    // Best-effort — never throw from diag.
  }
}

export async function liveDiagRead() {
  try {
    const AS = getAsyncStorage();
    if (!AS) return [];
    const raw = await AS.getItem(DIAG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function liveDiagClear() {
  try {
    const AS = getAsyncStorage();
    if (!AS) return;
    await AS.removeItem(DIAG_KEY);
  } catch {}
}

/**
 * Publish a MediaStream to a Cloudflare Stream WHIP endpoint.
 *
 * @param {MediaStream} stream - getUserMedia()/etc. output. Must contain
 *   at least one audio + one video track for normal live use.
 * @param {string} webrtcUrl - The `webrtc_url` field from `live_start_cf`
 *   (e.g. `https://customer-xyz.cloudflarestream.com/<input-uid>/webRTC/publish`).
 * @returns {Promise<{pc: RTCPeerConnection, stop: () => void}>}
 *   On success: pc (already-negotiated peer connection) + stop() helper.
 *   On failure: throws — caller should warn the host and fall back gracefully.
 */
export async function publishToCfStream(stream, webrtcUrl) {
  await liveDiagAppend('info', 'publishToCfStream start', { url: (webrtcUrl || '').slice(0, 80) });

  if (!_PC) {
    await liveDiagAppend('error', 'RTCPeerConnection unavailable on this platform');
    throw new Error('cfStreamPublisher: RTCPeerConnection unavailable on this platform');
  }
  if (!stream || typeof stream.getTracks !== 'function') {
    await liveDiagAppend('error', 'invalid MediaStream');
    throw new Error('cfStreamPublisher: invalid MediaStream');
  }
  if (!webrtcUrl || typeof webrtcUrl !== 'string') {
    await liveDiagAppend('error', 'missing webrtcUrl');
    throw new Error('cfStreamPublisher: missing webrtcUrl');
  }

  // Inspect local tracks BEFORE building the PC so we can complain about
  // a media-less broadcast attempt with a real message instead of CF's
  // generic 400.
  const tracks = stream.getTracks();
  const audioTracks = tracks.filter(t => t.kind === 'audio');
  const videoTracks = tracks.filter(t => t.kind === 'video');
  await liveDiagAppend('info', 'local tracks captured', {
    audio: audioTracks.length,
    video: videoTracks.length,
    audioReady: audioTracks.map(t => t.readyState),
    videoReady: videoTracks.map(t => t.readyState),
    audioEnabled: audioTracks.map(t => t.enabled),
    videoEnabled: videoTracks.map(t => t.enabled),
  });
  if (videoTracks.length === 0 && audioTracks.length === 0) {
    await liveDiagAppend('error', 'no audio/video tracks in stream — getUserMedia returned empty');
    throw new Error('cfStreamPublisher: stream has no audio or video tracks');
  }

  // CF Stream WHIP works with a public STUN; no TURN needed for outbound
  // publish (the publisher is always the initiator and CF lives on a
  // public IP). Using Cloudflare's own STUN keeps the trip short. Google's
  // STUN is added as a fallback — some mobile carriers block cloudflare's
  // STUN port silently.
  const pc = new _PC({
    iceServers: [
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:stun.l.google.com:19302' },
    ],
    // [WAVE 98] CF Stream prefers a small, bundled connection. `bundlePolicy:
    // 'max-bundle'` forces one ICE+DTLS transport for both audio+video, which
    // matches the answer CF generates (multiplexed). Without this RN-WebRTC
    // sometimes builds separate transports and CF's answer doesn't match,
    // leaving DTLS pending forever.
    bundlePolicy: 'max-bundle',
  });

  // [WAVE 98 root cause #1] Use addTransceiver with `sendonly` direction.
  //
  // Pure `pc.addTrack(track, stream)` results in the m= section having
  // `a=sendrecv`. CF Stream's WHIP answer then sets the section to
  // `a=inactive` (CF only wants to RECEIVE from us — they don't send back),
  // which RN-WebRTC interprets as "stop sending this track". Net result:
  // the PC reaches `connected`, the answer is applied cleanly, but RTP
  // is never transmitted. CF's /videos endpoint stays empty forever, and
  // the HLS playlist never generates a segment for viewers to pull.
  //
  // The fix is explicit transceivers with `direction:'sendonly'` so the
  // offer SDP carries `a=sendonly` from the start and CF's answer comes
  // back with `a=recvonly` — both ends agree the stream is unidirectional
  // and RTP flows.
  try {
    if (videoTracks[0] && typeof pc.addTransceiver === 'function') {
      pc.addTransceiver(videoTracks[0], { direction: 'sendonly', streams: [stream] });
    } else if (videoTracks[0]) {
      pc.addTrack(videoTracks[0], stream);
    }
    if (audioTracks[0] && typeof pc.addTransceiver === 'function') {
      pc.addTransceiver(audioTracks[0], { direction: 'sendonly', streams: [stream] });
    } else if (audioTracks[0]) {
      pc.addTrack(audioTracks[0], stream);
    }
    await liveDiagAppend('info', 'added transceivers (sendonly)', {
      hasAddTransceiver: typeof pc.addTransceiver === 'function',
    });
  } catch (e) {
    await liveDiagAppend('warn', 'addTransceiver/addTrack failed: ' + (e?.message || e));
    // Fallback to addTrack for older RN-WebRTC builds.
    tracks.forEach((track) => {
      try { pc.addTrack(track, stream); } catch (err) {
        console.warn('[cfStreamPublisher] addTrack failed:', err?.message || err);
      }
    });
  }

  // [WAVE 98 root cause #2] Wire ICE connection state monitoring. Without
  // this, an ICE failure (NAT-blocked, TURN unavailable, transport timeout)
  // is invisible to the host — the PC sits in `checking` state forever
  // while the viewer's screen stays "Conectando...". We attach a watcher
  // that resolves the publish if ICE reaches `connected`/`completed` or
  // throws if it reaches `failed`/`disconnected` for more than 30s.
  const iceWatcher = (() => {
    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    let settled = false;
    let disconnectTimer = null;
    const onChange = () => {
      const state = pc.iceConnectionState;
      liveDiagAppend('info', 'iceConnectionState=' + state).catch(() => {});
      if (settled) return;
      if (state === 'connected' || state === 'completed') {
        settled = true;
        if (disconnectTimer) clearTimeout(disconnectTimer);
        resolveFn(state);
      } else if (state === 'failed') {
        settled = true;
        if (disconnectTimer) clearTimeout(disconnectTimer);
        rejectFn(new Error('ICE failed — NAT/TURN unreachable (publish path blocked)'));
      } else if (state === 'disconnected') {
        // Give it 30s to recover before declaring failure — transient
        // network blips are common on mobile.
        if (disconnectTimer) clearTimeout(disconnectTimer);
        disconnectTimer = setTimeout(() => {
          if (!settled) {
            settled = true;
            rejectFn(new Error('ICE stuck in disconnected for 30s'));
          }
        }, 30000);
      }
    };
    try {
      pc.addEventListener?.('iceconnectionstatechange', onChange);
    } catch {
      pc.oniceconnectionstatechange = onChange;
    }
    return { promise };
  })();

  // 1) Create offer + set local. This kicks off ICE candidate gathering.
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // 2) Wait for ICE gathering to complete (CF doesn't trickle).
  //    Safety timeout @ 2000ms — typical gather time is <500ms; if a
  //    NAT is being pathological we'd rather POST a partial offer and
  //    let CF tell us the truth than hang forever.
  await new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { pc.removeEventListener?.('icegatheringstatechange', onChange); } catch {}
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    try {
      pc.addEventListener?.('icegatheringstatechange', onChange);
    } catch {
      // Older RN-WebRTC builds: fallback to property setter.
      const prev = pc.onicegatheringstatechange;
      pc.onicegatheringstatechange = (...args) => {
        try { prev?.(...args); } catch {}
        if (pc.iceGatheringState === 'complete') finish();
      };
    }
    setTimeout(finish, 2000);
  });

  // 3) POST the offer SDP to the WHIP endpoint.
  const localSdp = pc.localDescription?.sdp || offer.sdp;
  // Quick SDP audit for the diag log — surface the m-line direction so we
  // can verify the sendonly fix actually took effect (some RN-WebRTC
  // forks munge the SDP back to sendrecv on iOS).
  try {
    const sendonlyMatches = (localSdp.match(/a=sendonly/g) || []).length;
    const sendrecvMatches = (localSdp.match(/a=sendrecv/g) || []).length;
    const candidateMatches = (localSdp.match(/a=candidate:/g) || []).length;
    await liveDiagAppend('info', 'offer SDP audit', {
      sdpLen: localSdp.length,
      sendonly: sendonlyMatches,
      sendrecv: sendrecvMatches,
      candidates: candidateMatches,
      iceGathering: pc.iceGatheringState,
    });
    if (sendrecvMatches > 0 && sendonlyMatches === 0) {
      await liveDiagAppend('warn', 'SDP has sendrecv but no sendonly — CF may answer with inactive');
    }
    if (candidateMatches === 0) {
      await liveDiagAppend('warn', 'SDP has zero ICE candidates — gathering may have failed');
    }
  } catch {}

  let res;
  try {
    res = await fetch(webrtcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: localSdp,
    });
  } catch (e) {
    try { pc.close(); } catch {}
    await liveDiagAppend('error', 'WHIP POST network failure: ' + (e?.message || e));
    throw new Error(`cfStreamPublisher: WHIP POST network failure: ${e?.message || e}`);
  }
  await liveDiagAppend('info', 'WHIP POST response', { status: res.status });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch {}
    try { pc.close(); } catch {}
    await liveDiagAppend('error', `WHIP failed: ${res.status} ${detail.slice(0, 200)}`);
    throw new Error(`cfStreamPublisher: WHIP failed: ${res.status} ${detail.slice(0, 200)}`);
  }

  // 4) Apply CF's answer SDP. This drives ICE+DTLS and we're "live"
  //    on CF's ingest within ~1s after this resolves.
  const answerSdp = await res.text();
  try {
    const ansSendonly = (answerSdp.match(/a=sendonly/g) || []).length;
    const ansRecvonly = (answerSdp.match(/a=recvonly/g) || []).length;
    const ansInactive = (answerSdp.match(/a=inactive/g) || []).length;
    await liveDiagAppend('info', 'answer SDP audit', {
      sdpLen: answerSdp.length,
      sendonly: ansSendonly,
      recvonly: ansRecvonly,
      inactive: ansInactive,
    });
    if (ansInactive > 0) {
      await liveDiagAppend('error', 'CF answered with a=inactive — sender directionality was rejected (historical root cause)');
    }
  } catch {}
  try {
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  } catch (e) {
    try { pc.close(); } catch {}
    await liveDiagAppend('error', 'setRemoteDescription failed: ' + (e?.message || e));
    throw new Error(`cfStreamPublisher: setRemoteDescription failed: ${e?.message || e}`);
  }

  // [WAVE 98] Wait for ICE to actually CONNECT (or fail) before declaring
  // the publish successful. Previously the promise resolved the moment
  // setRemoteDescription returned, which is BEFORE DTLS/SRTP completes —
  // so the host's UI flipped to "AO VIVO" even when no media was ever
  // delivered to CF. We give ICE 20s to reach connected; on timeout we
  // throw so the host sees the real failure mode (instead of having
  // every viewer stuck on "Conectando..." with zero feedback).
  try {
    await Promise.race([
      iceWatcher.promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('ICE connect timeout (20s)')), 20000)),
    ]);
    await liveDiagAppend('info', 'WHIP publish OK — ICE connected, RTP should be flowing');
  } catch (e) {
    try { pc.close(); } catch {}
    await liveDiagAppend('error', 'WHIP publish failed at ICE stage: ' + (e?.message || e));
    throw new Error(`cfStreamPublisher: ${e?.message || e}`);
  }

  return {
    pc,
    stop: () => {
      try { pc.close(); } catch {}
      liveDiagAppend('info', 'WHIP publish stopped (host ended live)').catch(() => {});
    },
  };
}
