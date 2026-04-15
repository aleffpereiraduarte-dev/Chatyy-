/**
 * WebRTC P2P Call Service
 * Direct peer-to-peer audio/video calls without meeting rooms
 * Uses WebSocket for signaling, browser WebRTC API for media
 */
import { Platform } from 'react-native';
let mailWs = null;
try { mailWs = require('./websocket').default; } catch {}

let RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, mediaDevices;

if (Platform.OS === 'web') {
  RTCPeerConnection = window.RTCPeerConnection;
  RTCSessionDescription = window.RTCSessionDescription;
  RTCIceCandidate = window.RTCIceCandidate;
  mediaDevices = navigator.mediaDevices;
} else {
  // @stream-io/react-native-webrtc (same lib used in call.js and sipCall.js)
  const RNWebRTC = require('@stream-io/react-native-webrtc');
  RTCPeerConnection = RNWebRTC.RTCPeerConnection;
  RTCSessionDescription = RNWebRTC.RTCSessionDescription;
  RTCIceCandidate = RNWebRTC.RTCIceCandidate;
  mediaDevices = RNWebRTC.mediaDevices;
}

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// TURN server (coturn on production)
// Must use mail.onemundo.com.br — resolves directly to server (69.62.103.131)
// chatyy.com.br goes through Cloudflare and won't reach coturn
const TURN_URLS = [
  'turn:mail.onemundo.com.br:3478?transport=udp',
  'turn:mail.onemundo.com.br:3478?transport=tcp',
  'turns:mail.onemundo.com.br:5349?transport=tcp',
];

class WebRTCCall {
  constructor() {
    this.pc = null;
    this.localStream = null;
    this.remoteStream = null;
    this.callId = null;
    this.targetEmail = null;
    this.isCaller = false;
    this.videoEnabled = false;
    this.audioMuted = false;
    this.speakerOn = false;
    this.listeners = new Map();
    this._wsUnsubs = [];
    this._iceCandidateQueue = [];
    this._turnCredentials = null;
    this._turnExpiresAt = 0;
    this._statsInterval = null;
    this._iceTimeout = null;
    this._iceRestarted = false;
    this._iceRestartCount = 0;
    this._turnRefreshInterval = null;
    this._lastQuality = 5;
    this._netInfoUnsub = null;
    this._reconnecting = false;
  }

  // Build ICE config with STUN servers always included.
  // If TURN credentials are available, include TURN servers too.
  // If TURN credentials fail, STUN-only P2P can still work on favorable networks.
  _getIceConfig() {
    const config = { iceServers: [...ICE_SERVERS] };
    if (this._turnCredentials) {
      config.iceServers.push({
        urls: this._turnCredentials.urls || TURN_URLS,
        username: this._turnCredentials.username,
        credential: this._turnCredentials.credential,
      });
    }
    return config;
  }

  // Get ICE config with STUN-only (no TURN) as fallback
  _getStunOnlyConfig() {
    return { iceServers: [...ICE_SERVERS] };
  }

  // Start listening for WebSocket signaling messages
  _setupSignaling() {
    this._cleanupSignaling();

    const handlers = {
      call_offer: (data) => {
        if (data?.call_id === this.callId) {
          this._handleOffer(data);
        }
      },
      call_answer: (data) => {
        if (data?.call_id === this.callId) {
          this._handleAnswer(data);
        }
      },
      call_ice: (data) => {
        if (data?.call_id === this.callId) {
          this._handleIceCandidate(data);
        }
      },
      call_end: (data) => {
        if (data?.call_id === this.callId) {
          this._emit('ended', { reason: data.reason || 'remote_hangup' });
          this.cleanup();
        }
      },
      call_accepted: (data) => {
        if (data?.call_id === this.callId || data?.conversation_id) {
          this._emit('accepted', data);
        }
      },
      call_declined: (data) => {
        if (data?.call_id === this.callId || data?.conversation_id) {
          this._emit('declined', data);
          this.cleanup();
        }
      },
      call_turn_credentials: (data) => {
        if (data?.call_id === this.callId) {
          this._turnCredentials = data.credentials;
          this._turnExpiresAt = Date.now() + 23 * 60 * 60 * 1000;
        }
      },
    };

    for (const [event, handler] of Object.entries(handlers)) {
      const unsub = mailWs.on(event, handler);
      this._wsUnsubs.push(unsub);
    }
  }

  _cleanupSignaling() {
    this._wsUnsubs.forEach(unsub => unsub());
    this._wsUnsubs = [];
  }

  // Get user media (audio + optional video)
  async _getUserMedia(video = false) {
    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: video ? {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: 'user',
      } : false,
    };

    this.localStream = await mediaDevices.getUserMedia(constraints);
    return this.localStream;
  }

  // Create RTCPeerConnection
  _createPeerConnection() {
    if (this.pc) {
      try { this.pc.close(); } catch {}
    }

    this.pc = new RTCPeerConnection(this._getIceConfig());
    this._iceRestarted = false;

    // ICE connection timeout — 45 seconds to establish connection
    if (this._iceTimeout) clearTimeout(this._iceTimeout);
    this._iceTimeout = setTimeout(() => {
      if (this.pc?.iceConnectionState !== 'connected' &&
          this.pc?.iceConnectionState !== 'completed') {
        // Try ICE restart before giving up
        if (this._iceRestartCount === 0 && this._turnCredentials && this.pc) {
          console.log('[WebRTC] ICE timeout after 45s, attempting ICE restart');
          this._iceRestartCount++;
          this._emit('reconnecting');
          try {
            this.pc.restartIce();
          } catch {}
          // Give restart another 20s
          this._iceTimeout = setTimeout(() => {
            if (this.pc?.iceConnectionState !== 'connected' &&
                this.pc?.iceConnectionState !== 'completed') {
              console.log('[WebRTC] ICE restart also timed out');
              this.onCallFailed?.('ICE connection timeout');
              this._emit('error', { message: 'ICE connection timeout' });
              this._emit('connectionFailed', { message: 'ICE connection timeout', canRetry: true });
            }
          }, 20000);
        } else {
          console.log('[WebRTC] ICE timeout after 45s, no TURN available');
          this.onCallFailed?.('ICE connection timeout');
          this._emit('error', { message: 'ICE connection timeout' });
          this._emit('connectionFailed', { message: 'ICE connection timeout', canRetry: true });
        }
      }
    }, 45000);

    // Add local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        this.pc.addTrack(track, this.localStream);
      });
    }

    // Handle remote tracks (including renegotiation / tracks without streams)
    this.pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        this.remoteStream = event.streams[0];
        this._emit('remoteStream', this.remoteStream);
      } else if (event.track) {
        // Track arrived without a stream (renegotiation scenario)
        if (Platform.OS === 'web') {
          if (!this.remoteStream) {
            this.remoteStream = new MediaStream();
          }
          this.remoteStream.addTrack(event.track);
          this._emit('remoteStream', this.remoteStream);
        }
      }
    };

    // Handle ICE candidates
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this._sendSignaling('call_ice', {
          call_id: this.callId,
          target_email: this.targetEmail,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    // Connection state — handles disconnections with reconnect attempts
    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState;
      if (state === 'connected') {
        this._reconnecting = false;
        this._iceRestartCount = 0;
        this._emit('connected');
      } else if (state === 'disconnected') {
        this._reconnecting = true;
        this._emit('reconnecting');
      } else if (state === 'failed') {
        if (this._iceRestartCount < 3 && this.pc) {
          this._iceRestartCount++;
          this._reconnecting = true;
          this._emit('reconnecting');
          console.log('[WebRTC] connectionState failed, ICE restart attempt', this._iceRestartCount);
          this._refreshTurnAndRestart();
        } else {
          this._reconnecting = false;
          this._emit('connectionFailed', { message: 'Connection failed', canRetry: true });
        }
      }
    };

    // ICE connection state — handles timeout clear, ICE restart on failure
    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc?.iceConnectionState;
      this._emit('iceState', state);
      if (state === 'connected' || state === 'completed') {
        // Clear ICE timeout on successful connection
        if (this._iceTimeout) {
          clearTimeout(this._iceTimeout);
          this._iceTimeout = null;
        }
        this._reconnecting = false;
        this._iceRestartCount = 0;
        this._emit('peerConnected');
      } else if (state === 'disconnected') {
        // Brief disconnection — wait 3s then try ICE restart
        this._reconnecting = true;
        this._emit('reconnecting');
        setTimeout(() => {
          if (this.pc?.iceConnectionState === 'disconnected' && this._iceRestartCount < 3) {
            this._iceRestartCount++;
            console.log('[WebRTC] ICE disconnected for 3s, restart attempt', this._iceRestartCount);
            this._refreshTurnAndRestart();
          }
        }, 3000);
      } else if (state === 'failed') {
        // Try ICE restart up to 3 times
        if (this._iceRestartCount < 3 && this.pc) {
          this._iceRestartCount++;
          this._reconnecting = true;
          this._emit('reconnecting');
          console.log('[WebRTC] ICE failed, restart attempt', this._iceRestartCount);
          this._refreshTurnAndRestart();
        } else {
          this._reconnecting = false;
          console.log('[WebRTC] ICE restart exhausted after 3 attempts');
          this.onCallFailed?.('Connection failed');
          this._emit('connectionFailed', { message: 'Connection failed', canRetry: true });
        }
      }
    };

    return this.pc;
  }

  // Refresh TURN credentials and perform ICE restart
  async _refreshTurnAndRestart() {
    if (!this.pc) return;
    // Refresh TURN if stale or about to expire
    if (!this._turnExpiresAt || (this._turnExpiresAt - Date.now()) < 2 * 60 * 60 * 1000) {
      try {
        if (mailWs.isConnected) {
          const creds = await new Promise((resolve) => {
            const unsub = mailWs.on('turn_credentials', (data) => {
              unsub();
              resolve(data?.credentials || data);
            });
            mailWs._send({ type: 'get_turn_credentials' });
            setTimeout(() => { unsub(); resolve(null); }, 3000);
          });
          if (creds?.urls) {
            this._turnCredentials = creds;
            this._turnExpiresAt = Date.now() + 23 * 60 * 60 * 1000;
            try {
              const config = this.pc.getConfiguration();
              config.iceServers = this._getIceConfig().iceServers;
              this.pc.setConfiguration(config);
            } catch {}
          }
        }
      } catch {}
    }
    try {
      this.pc.restartIce();
    } catch {}
  }

  // Start network change detection for ICE restart on WiFi<->cellular switch
  startNetworkMonitoring() {
    this.stopNetworkMonitoring();
    if (Platform.OS === 'web') {
      const handleOnline = () => {
        if (this.pc && this.callId) {
          console.log('[WebRTC] Browser came online — triggering ICE restart');
          this._iceRestartCount = 0;
          this._emit('reconnecting');
          this._refreshTurnAndRestart();
        }
      };
      window.addEventListener('online', handleOnline);
      this._netInfoUnsub = () => window.removeEventListener('online', handleOnline);
    } else {
      try {
        const NetInfo = require('@react-native-community/netinfo').default;
        let lastType = null;
        this._netInfoUnsub = NetInfo.addEventListener((state) => {
          const newType = state?.type || 'unknown';
          const changed = lastType && lastType !== newType;
          lastType = newType;
          if (changed && this.pc && this.callId) {
            console.log('[WebRTC] Network changed to', newType, '— triggering ICE restart');
            this._iceRestartCount = 0;
            this._emit('reconnecting');
            this._refreshTurnAndRestart();
          }
        });
      } catch {}
    }
  }

  stopNetworkMonitoring() {
    if (this._netInfoUnsub) {
      try { this._netInfoUnsub(); } catch {}
      this._netInfoUnsub = null;
    }
  }

  // Get call quality stats from RTCPeerConnection
  async getCallStats() {
    if (!this.pc) return null;
    try {
      const stats = await this.pc.getStats();
      let result = { audio: {}, video: {}, network: {} };

      stats.forEach(report => {
        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          result.audio.packetsLost = report.packetsLost;
          result.audio.jitter = report.jitter;
          result.audio.bytesReceived = report.bytesReceived;
        }
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          result.video.packetsLost = report.packetsLost;
          result.video.framesDecoded = report.framesDecoded;
          result.video.framesDropped = report.framesDropped;
          result.video.frameWidth = report.frameWidth;
          result.video.frameHeight = report.frameHeight;
        }
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          result.network.rtt = report.currentRoundTripTime * 1000; // ms
          result.network.availableBandwidth = report.availableOutgoingBitrate;
        }
      });

      // Quality score: 5=excellent, 4=good, 3=fair, 2=poor, 1=bad
      const rtt = result.network.rtt || 0;
      const loss = result.audio.packetsLost || 0;
      if (rtt < 100 && loss < 1) result.quality = 5;
      else if (rtt < 200 && loss < 3) result.quality = 4;
      else if (rtt < 400 && loss < 5) result.quality = 3;
      else if (rtt < 800) result.quality = 2;
      else result.quality = 1;

      return result;
    } catch {
      return null;
    }
  }

  // Poll stats every 2 seconds during a call
  startStatsPolling(callback) {
    this.stopStatsPolling();
    this._statsInterval = setInterval(async () => {
      const stats = await this.getCallStats();
      if (stats) {
        callback(stats);
        // Auto-adapt bitrate based on quality changes
        if (stats.quality !== this._lastQuality) {
          this._lastQuality = stats.quality;
          this.adaptBitrate(stats.quality);
        }
      }
    }, 2000);
  }

  stopStatsPolling() {
    if (this._statsInterval) {
      clearInterval(this._statsInterval);
      this._statsInterval = null;
    }
  }

  // Adaptive bitrate based on network quality score
  async adaptBitrate(quality) {
    if (!this.pc) return;
    const senders = this.pc.getSenders();

    for (const sender of senders) {
      if (sender.track?.kind === 'video') {
        try {
          const params = sender.getParameters();
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
          }

          switch (quality) {
            case 5: // Excellent
              params.encodings[0].maxBitrate = 2500000; // 2.5Mbps
              params.encodings[0].maxFramerate = 30;
              break;
            case 4: // Good
              params.encodings[0].maxBitrate = 1500000;
              params.encodings[0].maxFramerate = 24;
              break;
            case 3: // Fair
              params.encodings[0].maxBitrate = 800000;
              params.encodings[0].maxFramerate = 15;
              break;
            case 2: // Poor
              params.encodings[0].maxBitrate = 400000;
              params.encodings[0].maxFramerate = 10;
              break;
            default: // Bad
              params.encodings[0].maxBitrate = 150000;
              params.encodings[0].maxFramerate = 5;
              break;
          }

          await sender.setParameters(params);
        } catch {}
      }
    }
  }

  // Refresh TURN credentials every hour (they expire in 24h, but refresh early to avoid mid-call expiry)
  startTurnRefresh() {
    this.stopTurnRefresh();
    this._turnRefreshInterval = setInterval(async () => {
      try {
        // Skip if TURN creds are still fresh (more than 2h remaining)
        if (this._turnExpiresAt && (this._turnExpiresAt - Date.now()) > 2 * 60 * 60 * 1000) return;

        if (mailWs.isConnected) {
          const creds = await new Promise((resolve) => {
            const unsub = mailWs.on('turn_credentials', (data) => {
              unsub();
              resolve(data?.credentials || data);
            });
            mailWs._send({ type: 'get_turn_credentials' });
            setTimeout(() => { unsub(); resolve(null); }, 5000);
          });
          if (creds?.urls && this.pc) {
            this._turnCredentials = creds;
            this._turnExpiresAt = Date.now() + 23 * 60 * 60 * 1000;
            try {
              const config = this.pc.getConfiguration();
              config.iceServers = this._getIceConfig().iceServers;
              this.pc.setConfiguration(config);
            } catch {}
            console.log('[WebRTC] TURN credentials refreshed');
          }
        }
      } catch {}
    }, 60 * 60 * 1000); // Every hour
  }

  stopTurnRefresh() {
    if (this._turnRefreshInterval) {
      clearInterval(this._turnRefreshInterval);
      this._turnRefreshInterval = null;
    }
  }

  // Start a call (caller side)
  async startCall({ callId, targetEmail, video = false, conversationId }) {
    this.callId = callId;
    this.targetEmail = targetEmail;
    this.isCaller = true;
    this.videoEnabled = video;
    this._iceRestartCount = 0;

    this._setupSignaling();
    this.startNetworkMonitoring();

    try {
      await this._getUserMedia(video);
      this._createPeerConnection();

      // Create and send offer
      const offer = await this.pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: video,
      });
      // Optimize Opus: DTX (saves 40% bandwidth during silence) + FEC (packet loss recovery)
      // Parse actual Opus payload type from SDP instead of hardcoding 111
      if (offer.sdp) {
        const opusMatch = offer.sdp.match(/a=rtpmap:(\d+) opus\/48000/);
        const opusPT = opusMatch ? opusMatch[1] : '111';
        const fmtpRegex = new RegExp(`a=fmtp:${opusPT} `, 'g');
        offer.sdp = offer.sdp.replace(
          fmtpRegex,
          `a=fmtp:${opusPT} useinbandfec=1;usedtx=1;`
        );
      }
      await this.pc.setLocalDescription(offer);

      this._sendSignaling('call_offer', {
        call_id: this.callId,
        target_email: this.targetEmail,
        conversation_id: conversationId,
        sdp: offer.sdp,
        type: offer.type,
        video,
      });

      this._emit('started', { callId, targetEmail, video });
    } catch (err) {
      this._emit('error', { message: err.message });
      this.cleanup();
      throw err;
    }
  }

  // Answer a call (callee side)
  async answerCall({ callId, callerEmail, video = false }) {
    this.callId = callId;
    this.targetEmail = callerEmail;
    this.isCaller = false;
    this.videoEnabled = video;
    this._iceRestartCount = 0;

    this._setupSignaling();
    this.startNetworkMonitoring();

    try {
      await this._getUserMedia(video);
      this._createPeerConnection();

      // Process any queued ICE candidates
      for (const candidate of this._iceCandidateQueue) {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch {}
      }
      this._iceCandidateQueue = [];

      this._emit('answering', { callId, callerEmail });
    } catch (err) {
      this._emit('error', { message: err.message });
      this.cleanup();
      throw err;
    }
  }

  // Handle incoming SDP offer
  async _handleOffer(data) {
    if (!this.pc) return;

    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription({
        type: data.type || 'offer',
        sdp: data.sdp,
      }));

      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);

      this._sendSignaling('call_answer', {
        call_id: this.callId,
        target_email: this.targetEmail,
        sdp: answer.sdp,
        type: answer.type,
      });

      // Process queued ICE candidates
      for (const candidate of this._iceCandidateQueue) {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch {}
      }
      this._iceCandidateQueue = [];
    } catch (err) {
      this._emit('error', { message: 'Failed to handle offer: ' + err.message });
    }
  }

  // Handle incoming SDP answer
  async _handleAnswer(data) {
    if (!this.pc) return;

    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription({
        type: data.type || 'answer',
        sdp: data.sdp,
      }));

      // Process queued ICE candidates
      for (const candidate of this._iceCandidateQueue) {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch {}
      }
      this._iceCandidateQueue = [];
    } catch (err) {
      this._emit('error', { message: 'Failed to handle answer: ' + err.message });
    }
  }

  // Handle incoming ICE candidate
  async _handleIceCandidate(data) {
    if (!data.candidate) return;

    if (!this.pc || !this.pc.remoteDescription) {
      // Queue if remote description not set yet
      this._iceCandidateQueue.push(data.candidate);
      return;
    }

    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch {}
  }

  // Send signaling message via WebSocket
  _sendSignaling(type, data) {
    if (mailWs.isConnected) {
      mailWs._send({ type, ...data });
    }
  }

  // Toggle audio mute
  toggleAudio() {
    if (!this.localStream) return false;
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      this.audioMuted = !audioTrack.enabled;
      this._emit('audioMuted', this.audioMuted);
      return this.audioMuted;
    }
    return this.audioMuted;
  }

  // Toggle video
  async toggleVideo() {
    if (!this.localStream || !this.pc) return false;

    const videoTrack = this.localStream.getVideoTracks()[0];

    if (videoTrack) {
      // Has video track - toggle it
      videoTrack.enabled = !videoTrack.enabled;
      this.videoEnabled = videoTrack.enabled;
    } else if (!this.videoEnabled) {
      // No video track - add one
      try {
        const videoStream = await mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        });
        const newVideoTrack = videoStream.getVideoTracks()[0];
        this.localStream.addTrack(newVideoTrack);

        // Add to peer connection
        const sender = this.pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          await sender.replaceTrack(newVideoTrack);
        } else {
          this.pc.addTrack(newVideoTrack, this.localStream);
        }
        this.videoEnabled = true;
      } catch {
        return false;
      }
    }

    this._emit('videoEnabled', this.videoEnabled);
    return this.videoEnabled;
  }

  // End the call
  endCall(reason = 'hangup') {
    this._sendSignaling('call_end', {
      call_id: this.callId,
      target_email: this.targetEmail,
      reason,
    });
    this._emit('ended', { reason: 'local_hangup' });
    this.cleanup();
  }

  // Clean up all resources
  cleanup() {
    this._cleanupSignaling();
    this.stopStatsPolling();
    this.stopTurnRefresh();
    this.stopNetworkMonitoring();

    if (this._iceTimeout) {
      clearTimeout(this._iceTimeout);
      this._iceTimeout = null;
    }

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
    this.remoteStream = null;

    if (this.pc) {
      try { this.pc.close(); } catch {}
      this.pc = null;
    }

    this.callId = null;
    this.targetEmail = null;
    this._iceCandidateQueue = [];
    this._turnCredentials = null;
    this._turnExpiresAt = 0;
    this._iceRestarted = false;
    this._iceRestartCount = 0;
    this._reconnecting = false;
    this._lastQuality = 5;
    // Clear all event listeners to prevent singleton listener leaks across calls
    this.listeners = new Map();
  }

  // Event system
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    const cbs = this.listeners.get(event);
    if (cbs) cbs.delete(callback);
  }

  _emit(event, data) {
    const cbs = this.listeners.get(event);
    if (cbs) cbs.forEach(cb => { try { cb(data); } catch {} });
  }
}

// Singleton
const webrtcCall = new WebRTCCall();
export default webrtcCall;
