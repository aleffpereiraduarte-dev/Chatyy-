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
  if (!_PC) {
    throw new Error('cfStreamPublisher: RTCPeerConnection unavailable on this platform');
  }
  if (!stream || typeof stream.getTracks !== 'function') {
    throw new Error('cfStreamPublisher: invalid MediaStream');
  }
  if (!webrtcUrl || typeof webrtcUrl !== 'string') {
    throw new Error('cfStreamPublisher: missing webrtcUrl');
  }

  // CF Stream WHIP works with a public STUN; no TURN needed for outbound
  // publish (the publisher is always the initiator and CF lives on a
  // public IP). Using Cloudflare's own STUN keeps the trip short.
  const pc = new _PC({
    iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
  });

  // Attach all tracks from the source stream. Order doesn't matter — SDP
  // negotiation will surface both audio + video sections regardless.
  stream.getTracks().forEach((track) => {
    try { pc.addTrack(track, stream); } catch (e) {
      console.warn('[cfStreamPublisher] addTrack failed:', e?.message || e);
    }
  });

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
  let res;
  try {
    res = await fetch(webrtcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: localSdp,
    });
  } catch (e) {
    try { pc.close(); } catch {}
    throw new Error(`cfStreamPublisher: WHIP POST network failure: ${e?.message || e}`);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch {}
    try { pc.close(); } catch {}
    throw new Error(`cfStreamPublisher: WHIP failed: ${res.status} ${detail.slice(0, 200)}`);
  }

  // 4) Apply CF's answer SDP. This drives ICE+DTLS and we're "live"
  //    on CF's ingest within ~1s after this resolves.
  const answerSdp = await res.text();
  try {
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  } catch (e) {
    try { pc.close(); } catch {}
    throw new Error(`cfStreamPublisher: setRemoteDescription failed: ${e?.message || e}`);
  }

  return {
    pc,
    stop: () => {
      try { pc.close(); } catch {}
    },
  };
}
