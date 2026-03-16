/**
 * WebRTC P2P Call Service
 * Direct peer-to-peer audio/video calls without meeting rooms
 * Uses WebSocket for signaling, browser WebRTC API for media
 */
import { Platform } from 'react-native';
import mailWs from './websocket';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// TURN server (coturn on production)
const TURN_URLS = [
  'turn:chatyy.com.br:3478',
  'turns:chatyy.com.br:5349',
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
  }

  // Generate TURN credentials (time-limited HMAC-SHA1)
  // This is a fallback - ideally the server sends them
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
    if (Platform.OS !== 'web') {
      // Native: WebRTC not available without react-native-webrtc
      throw new Error('WebRTC requires web browser');
    }

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

    this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    return this.localStream;
  }

  // Create RTCPeerConnection
  _createPeerConnection() {
    if (this.pc) {
      try { this.pc.close(); } catch {}
    }

    this.pc = new RTCPeerConnection(this._getIceConfig());

    // Add local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        this.pc.addTrack(track, this.localStream);
      });
    }

    // Handle remote tracks
    this.pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        this.remoteStream = event.streams[0];
        this._emit('remoteStream', this.remoteStream);
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

    // Connection state changes
    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState;
      this._emit('connectionState', state);
      if (state === 'connected') {
        this._emit('connected');
      } else if (state === 'disconnected' || state === 'failed') {
        this._emit('disconnected', { state });
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc?.iceConnectionState;
      this._emit('iceState', state);
      if (state === 'connected' || state === 'completed') {
        this._emit('peerConnected');
      }
    };

    return this.pc;
  }

  // Start a call (caller side)
  async startCall({ callId, targetEmail, video = false, conversationId }) {
    this.callId = callId;
    this.targetEmail = targetEmail;
    this.isCaller = true;
    this.videoEnabled = video;

    this._setupSignaling();

    try {
      await this._getUserMedia(video);
      this._createPeerConnection();

      // Create and send offer
      const offer = await this.pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: video,
      });
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

    this._setupSignaling();

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
        const videoStream = await navigator.mediaDevices.getUserMedia({
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
